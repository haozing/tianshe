/**
 * TagService - 标签管理服务
 *
 * 负责管理独立的标签列表
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';
import { v4 as uuidv4 } from 'uuid';
import type { Tag, CreateTagParams, UpdateTagParams } from '../../types/profile';

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

    await this.conn.run(`ALTER TABLE tags ADD COLUMN IF NOT EXISTS sync_owner_user_id BIGINT`);
    await this.conn.run(`ALTER TABLE tags ADD COLUMN IF NOT EXISTS sync_owner_user_name VARCHAR`);
    await this.conn.run(`ALTER TABLE tags ADD COLUMN IF NOT EXISTS sync_scope_type VARCHAR`);
    await this.conn.run(`ALTER TABLE tags ADD COLUMN IF NOT EXISTS sync_scope_id BIGINT`);
    await this.conn.run(
      `ALTER TABLE tags ADD COLUMN IF NOT EXISTS sync_managed BOOLEAN DEFAULT FALSE`
    );
    await this.conn.run(`ALTER TABLE tags ADD COLUMN IF NOT EXISTS sync_updated_at TIMESTAMP`);

    await this.conn.run(`
      UPDATE tags
      SET sync_managed = FALSE
      WHERE sync_managed IS NULL
    `);

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

  private normalizeSyncScopeType(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized : null;
  }

  private normalizeSyncScopeId(value: unknown): number | null {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.trunc(numeric);
  }

  private normalizeSyncManaged(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();
    return normalized === 'true' || normalized === '1';
  }

  private normalizeSyncOwnerUserId(value: unknown): number | null {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const normalized = Math.trunc(numeric);
    return normalized > 0 ? normalized : null;
  }

  private normalizeSyncOwnerUserName(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized : null;
  }

  private toTimestampValue(value?: Date | null): string | null {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString();
  }

  /**
   * 创建标签
   */
  async create(params: CreateTagParams): Promise<Tag> {
    const id = uuidv4();
    const syncOwnerUserId = this.normalizeSyncOwnerUserId(params.syncOwnerUserId);
    const syncOwnerUserName = this.normalizeSyncOwnerUserName(params.syncOwnerUserName);
    const syncScopeType = this.normalizeSyncScopeType(params.syncScopeType);
    const syncScopeId = this.normalizeSyncScopeId(params.syncScopeId);
    const syncManaged = this.normalizeSyncManaged(params.syncManaged);
    const syncUpdatedAt = this.toTimestampValue(params.syncUpdatedAt);

    const stmt = await this.conn.prepare(`
      INSERT INTO tags (
        id, name, color, created_at,
        sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      )
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)
    `);

    stmt.bind([
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

    await stmt.run();
    stmt.destroySync();

    console.log(`[TagService] Created tag: ${params.name} (${id})`);

    return this.get(id) as Promise<Tag>;
  }

  /**
   * 获取单个标签
   */
  async get(id: string): Promise<Tag | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        id, name, color, created_at,
        sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM tags
      WHERE id = ?
    `);

    stmt.bind([id]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToTag(rows[0]);
  }

  /**
   * 通过名称获取标签
   */
  async getByName(name: string): Promise<Tag | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        id, name, color, created_at,
        sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM tags
      WHERE name = ?
    `);

    stmt.bind([name]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

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
    const fields: string[] = [];
    const values: any[] = [];

    if (params.name !== undefined) {
      fields.push('name = ?');
      values.push(params.name);
    }

    if (params.color !== undefined) {
      fields.push('color = ?');
      values.push(params.color);
    }

    if (params.syncOwnerUserId !== undefined) {
      fields.push('sync_owner_user_id = ?');
      values.push(this.normalizeSyncOwnerUserId(params.syncOwnerUserId));
    }

    if (params.syncOwnerUserName !== undefined) {
      fields.push('sync_owner_user_name = ?');
      values.push(this.normalizeSyncOwnerUserName(params.syncOwnerUserName));
    }

    if (params.syncScopeType !== undefined) {
      fields.push('sync_scope_type = ?');
      values.push(this.normalizeSyncScopeType(params.syncScopeType));
    }

    if (params.syncScopeId !== undefined) {
      fields.push('sync_scope_id = ?');
      values.push(this.normalizeSyncScopeId(params.syncScopeId));
    }

    if (params.syncManaged !== undefined) {
      fields.push('sync_managed = ?');
      values.push(this.normalizeSyncManaged(params.syncManaged));
    }

    if (params.syncUpdatedAt !== undefined) {
      fields.push('sync_updated_at = ?');
      values.push(this.toTimestampValue(params.syncUpdatedAt));
    }

    if (fields.length === 0) {
      const tag = await this.get(id);
      if (!tag) throw new Error(`Tag not found: ${id}`);
      return tag;
    }

    values.push(id);

    const stmt = await this.conn.prepare(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`);
    stmt.bind(values);
    await stmt.run();
    stmt.destroySync();

    console.log(`[TagService] Updated tag: ${id}`);

    return this.get(id) as Promise<Tag>;
  }

  /**
   * 删除标签
   */
  async delete(id: string): Promise<void> {
    const stmt = await this.conn.prepare(`DELETE FROM tags WHERE id = ?`);
    stmt.bind([id]);
    await stmt.run();
    stmt.destroySync();

    console.log(`[TagService] Deleted tag: ${id}`);
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
      syncOwnerUserId: this.normalizeSyncOwnerUserId(row.sync_owner_user_id) ?? undefined,
      syncOwnerUserName: this.normalizeSyncOwnerUserName(row.sync_owner_user_name) ?? undefined,
      syncScopeType: this.normalizeSyncScopeType(row.sync_scope_type) ?? undefined,
      syncScopeId: this.normalizeSyncScopeId(row.sync_scope_id) ?? undefined,
      syncManaged: this.normalizeSyncManaged(row.sync_managed),
      syncUpdatedAt: row.sync_updated_at ? new Date(row.sync_updated_at) : undefined,
    };
  }
}
