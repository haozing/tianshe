/**
 * TagService - 标签管理服务
 *
 * 负责管理独立的标签列表
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';
import { allPrepared, runPrepared } from './statement-executor';
import { v4 as uuidv4 } from 'uuid';
import type { Tag, CreateTagParams, UpdateTagParams } from '../../types/profile';
import {
  normalizeSyncString,
  normalizeSyncInteger,
  normalizeSyncBoolean,
  normalizeSyncTimestamp,
} from './sync-field-normalizer';
import { SqlUpdateBuilder } from './sql-update-builder';
import { SchemaMigrationEngine } from './migration-engine';
import {
  runSchemaBackfills,
  TAG_SCHEMA_BACKFILLS,
  TAG_SCHEMA_MIGRATIONS,
} from './schema-migrations';
import { createLogger } from '../../core/logger';

const logger = createLogger('TagService');

/**
 * 标签服务
 */
export class TagService {
  constructor(private conn: DuckDBConnection) {}

  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS tags (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL UNIQUE,
        color VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sync_owner_user_id BIGINT,
        sync_owner_user_name VARCHAR,
        sync_scope_type VARCHAR,
        sync_scope_id BIGINT,
        sync_managed BOOLEAN DEFAULT FALSE,
        sync_updated_at TIMESTAMP
      )
    `);

    await new SchemaMigrationEngine(this.conn).migrate(TAG_SCHEMA_MIGRATIONS);
    await runSchemaBackfills(this.conn, TAG_SCHEMA_BACKFILLS);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_tags_name
      ON tags(name)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_tags_sync_owner_user_id
      ON tags(sync_owner_user_id)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_tags_sync_scope
      ON tags(sync_scope_type, sync_scope_id)
    `);
  }

  /**
   * 创建标签
   */
  async create(params: CreateTagParams): Promise<Tag> {
    const id = uuidv4();
    const syncOwnerUserId = normalizeSyncInteger(params.syncOwnerUserId, { min: 1 });
    const syncOwnerUserName = normalizeSyncString(params.syncOwnerUserName);
    const syncScopeType = normalizeSyncString(params.syncScopeType);
    const syncScopeId = normalizeSyncInteger(params.syncScopeId);
    const syncManaged = normalizeSyncBoolean(params.syncManaged);
    const syncUpdatedAt = normalizeSyncTimestamp(params.syncUpdatedAt);

    await runPrepared(this.conn, `
      INSERT INTO tags (
        id, name, color, created_at,
        sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      )
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      params.name,
      params.color || null,
      syncOwnerUserId,
      syncOwnerUserName,
      syncScopeType,
      syncScopeId,
      syncManaged,
      syncUpdatedAt,
    ]);

    logger.info('Created tag', { tagId: id, tagName: params.name });

    return this.get(id) as Promise<Tag>;
  }

  /**
   * 获取单个标签
   */
  async get(id: string): Promise<Tag | null> {
    const result = await allPrepared(this.conn, `
      SELECT
        id, name, color, created_at,
        sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM tags
      WHERE id = ?
    `, [id]);

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToTag(rows[0]);
  }

  /**
   * 通过名称获取标签
   */
  async getByName(name: string): Promise<Tag | null> {
    const result = await allPrepared(this.conn, `
      SELECT
        id, name, color, created_at,
        sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM tags
      WHERE name = ?
    `, [name]);

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToTag(rows[0]);
  }

  /**
   * 列出所有标签
   */
  async listAll(): Promise<Tag[]> {
    const result = await this.conn.runAndReadAll(`
      SELECT
        id, name, color, created_at,
        sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM tags
      ORDER BY created_at ASC
    `);

    const rows = parseRows(result);
    return rows.map((row) => this.mapRowToTag(row));
  }

  /**
   * 更新标签
   */
  async update(id: string, params: UpdateTagParams): Promise<Tag> {
    const builder = new SqlUpdateBuilder()
      .set('name', params.name)
      .set('color', params.color)
      .set('sync_owner_user_id', params.syncOwnerUserId, (v) => normalizeSyncInteger(v, { min: 1 }))
      .set('sync_owner_user_name', params.syncOwnerUserName, normalizeSyncString)
      .set('sync_scope_type', params.syncScopeType, normalizeSyncString)
      .set('sync_scope_id', params.syncScopeId, normalizeSyncInteger)
      .set('sync_managed', params.syncManaged, normalizeSyncBoolean)
      .set('sync_updated_at', params.syncUpdatedAt, normalizeSyncTimestamp);

    if (builder.isEmpty) {
      const tag = await this.get(id);
      if (!tag) throw new Error(`Tag not found: ${id}`);
      return tag;
    }

    const { sql, values } = builder.build('tags', 'id', id)!;

    await runPrepared(this.conn, sql, values);

    logger.info('Updated tag', { tagId: id });

    return this.get(id) as Promise<Tag>;
  }

  /**
   * 删除标签
   */
  async delete(id: string): Promise<void> {
    await runPrepared(this.conn, `DELETE FROM tags WHERE id = ?`, [id]);

    logger.info('Deleted tag', { tagId: id });
  }

  /**
   * 检查标签名是否存在
   */
  async exists(name: string): Promise<boolean> {
    const tag = await this.getByName(name);
    return tag !== null;
  }

  /**
   * 将数据库行映射为 Tag
   */
  private mapRowToTag(row: any): Tag {
    return {
      id: String(row.id),
      name: String(row.name),
      color: row.color ? String(row.color) : undefined,
      createdAt: new Date(row.created_at),
      syncOwnerUserId: normalizeSyncInteger(row.sync_owner_user_id) ?? undefined,
      syncOwnerUserName: normalizeSyncString(row.sync_owner_user_name) ?? undefined,
      syncScopeType: normalizeSyncString(row.sync_scope_type) ?? undefined,
      syncScopeId: normalizeSyncInteger(row.sync_scope_id) ?? undefined,
      syncManaged: normalizeSyncBoolean(row.sync_managed),
      syncUpdatedAt: row.sync_updated_at ? new Date(row.sync_updated_at) : undefined,
    };
  }
}
