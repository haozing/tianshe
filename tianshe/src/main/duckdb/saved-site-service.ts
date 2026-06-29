/**
 * SavedSiteService - 常用网站管理服务
 *
 * 负责管理全局的常用登录网站列表
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';
import { allPrepared, runPrepared } from './statement-executor';
import { v4 as uuidv4 } from 'uuid';
import type { SavedSite, CreateSavedSiteParams, UpdateSavedSiteParams } from '../../types/profile';
import { SqlUpdateBuilder } from './sql-update-builder';
import { SchemaMigrationEngine } from './migration-engine';
import {
  runSchemaBackfills,
  SAVED_SITE_SCHEMA_BACKFILLS,
  SAVED_SITE_SCHEMA_MIGRATIONS,
} from './schema-migrations';
import {
  normalizeSyncString,
  normalizeSyncInteger,
  normalizeSyncBoolean,
  normalizeSyncTimestamp,
} from './sync-field-normalizer';
import { createLogger } from '../../core/logger';

const logger = createLogger('SavedSiteService');

/**
 * 常用网站服务
 */
export class SavedSiteService {
  constructor(private conn: DuckDBConnection) {}

  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS saved_sites (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        url VARCHAR NOT NULL,
        icon VARCHAR,
        usage_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sync_source_id VARCHAR,
        sync_canonical_name VARCHAR,
        sync_owner_user_id BIGINT,
        sync_owner_user_name VARCHAR,
        sync_scope_type VARCHAR,
        sync_scope_id BIGINT,
        sync_managed BOOLEAN DEFAULT FALSE,
        sync_updated_at TIMESTAMP
      )
    `);

    await new SchemaMigrationEngine(this.conn).migrate(SAVED_SITE_SCHEMA_MIGRATIONS);
    await runSchemaBackfills(this.conn, SAVED_SITE_SCHEMA_BACKFILLS);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_saved_sites_usage_count
      ON saved_sites(usage_count DESC)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_saved_sites_sync_source_id
      ON saved_sites(sync_source_id)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_saved_sites_sync_owner_user_id
      ON saved_sites(sync_owner_user_id)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_saved_sites_sync_scope
      ON saved_sites(sync_scope_type, sync_scope_id)
    `);

    const presetSites = [
      { id: 'preset-wechat', name: '微信', url: 'https://wx.qq.com', icon: '💬' },
      { id: 'preset-gmail', name: 'Gmail', url: 'https://mail.google.com', icon: '📧' },
      { id: 'preset-taobao', name: '淘宝', url: 'https://login.taobao.com', icon: '📦' },
      { id: 'preset-jd', name: '京东', url: 'https://passport.jd.com/login', icon: '🛍️' },
      { id: 'preset-weibo', name: '微博', url: 'https://weibo.com/login', icon: '📰' },
      { id: 'preset-douyin', name: '抖音', url: 'https://www.douyin.com', icon: '🎵' },
      {
        id: 'preset-bilibili',
        name: 'B站',
        url: 'https://passport.bilibili.com/login',
        icon: '📺',
      },
      { id: 'preset-zhihu', name: '知乎', url: 'https://www.zhihu.com/signin', icon: '❓' },
    ];
    for (const site of presetSites) {
      await runPrepared(
        this.conn,
        `
          INSERT INTO saved_sites (
            id, name, url, icon, usage_count, created_at, sync_managed
          )
          VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, FALSE)
          ON CONFLICT (id) DO NOTHING
        `,
        [site.id, site.name, site.url, site.icon]
      );
    }
  }

  private normalizeName(name: string): string {
    const normalized = String(name ?? '').trim();
    if (!normalized) {
      throw new Error('平台名称不能为空');
    }
    return normalized;
  }

  private normalizeUrl(url: string): string {
    const normalized = String(url ?? '').trim();
    if (!normalized) {
      throw new Error('平台 URL 不能为空');
    }
    return normalized;
  }

  private async ensureNameUnique(name: string, excludeId?: string): Promise<void> {
    const hasExcludeId = typeof excludeId === 'string' && excludeId.trim().length > 0;
    const sql = hasExcludeId
      ? `
      SELECT id
      FROM saved_sites
      WHERE name = ?
        AND id <> ?
      LIMIT 1
    `
      : `
      SELECT id
      FROM saved_sites
      WHERE name = ?
      LIMIT 1
    `;
    const result = await allPrepared(this.conn, sql, hasExcludeId ? [name, excludeId] : [name]);

    const rows = parseRows(result);
    if (rows.length > 0) {
      throw new Error(`平台「${name}」已存在`);
    }
  }

  private async countAccountReferences(id: string): Promise<number> {
    const result = await allPrepared(this.conn, `
      SELECT COUNT(*) AS reference_count
      FROM accounts
      WHERE platform_id = ?
    `, [id]);

    const rows = parseRows(result);
    return Number(rows[0]?.reference_count) || 0;
  }

  /**
   * 创建常用网站
   */
  async create(params: CreateSavedSiteParams): Promise<SavedSite> {
    const normalizedName = this.normalizeName(params.name);
    const normalizedUrl = this.normalizeUrl(params.url);
    await this.ensureNameUnique(normalizedName);

    const id = uuidv4();
    const syncSourceId = normalizeSyncString(params.syncSourceId);
    const syncCanonicalName =
      normalizeSyncString(params.syncCanonicalName) ??
      (syncSourceId ? normalizedName : null);
    const syncOwnerUserId = normalizeSyncInteger(params.syncOwnerUserId, { min: 1 });
    const syncOwnerUserName = normalizeSyncString(params.syncOwnerUserName);
    const syncScopeType = normalizeSyncString(params.syncScopeType);
    const syncScopeId = normalizeSyncInteger(params.syncScopeId);
    const syncManaged = normalizeSyncBoolean(params.syncManaged);
    const syncUpdatedAt = normalizeSyncTimestamp(params.syncUpdatedAt);

    await runPrepared(this.conn, `
      INSERT INTO saved_sites (
        id, name, url, icon, usage_count, created_at,
        sync_source_id, sync_canonical_name, sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      ) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      normalizedName,
      normalizedUrl,
      params.icon || null,
      syncSourceId,
      syncCanonicalName,
      syncOwnerUserId,
      syncOwnerUserName,
      syncScopeType,
      syncScopeId,
      syncManaged,
      syncUpdatedAt,
    ]);

    logger.info('Created saved site', { siteId: id, siteName: normalizedName });

    return this.get(id) as Promise<SavedSite>;
  }

  /**
   * 获取单个常用网站
   */
  async get(id: string): Promise<SavedSite | null> {
    const result = await allPrepared(this.conn, `
      SELECT
        id, name, url, icon, usage_count, created_at,
        sync_source_id, sync_canonical_name, sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM saved_sites
      WHERE id = ?
    `, [id]);

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToSavedSite(rows[0]);
  }

  /**
   * 通过名称查找平台
   */
  async getByName(name: string): Promise<SavedSite | null> {
    const result = await allPrepared(this.conn, `
      SELECT
        id, name, url, icon, usage_count, created_at,
        sync_source_id, sync_canonical_name, sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM saved_sites
      WHERE name = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `, [name]);

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToSavedSite(rows[0]);
  }

  /**
   * 通过 URL 查找常用网站
   */
  async getByUrl(url: string): Promise<SavedSite | null> {
    const result = await allPrepared(this.conn, `
      SELECT
        id, name, url, icon, usage_count, created_at,
        sync_source_id, sync_canonical_name, sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM saved_sites
      WHERE url = ?
    `, [url]);

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToSavedSite(rows[0]);
  }

  /**
   * 列出所有常用网站（按使用次数排序）
   */
  async listAll(): Promise<SavedSite[]> {
    const result = await this.conn.runAndReadAll(`
      SELECT
        id, name, url, icon, usage_count, created_at,
        sync_source_id, sync_canonical_name, sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM saved_sites
      ORDER BY usage_count DESC, created_at ASC
    `);

    const rows = parseRows(result);
    return rows.map((row) => this.mapRowToSavedSite(row));
  }

  /**
   * 更新常用网站
   */
  async update(id: string, params: UpdateSavedSiteParams): Promise<SavedSite> {
    const builder = new SqlUpdateBuilder();

    if (params.name !== undefined) {
      const normalizedName = this.normalizeName(params.name);
      await this.ensureNameUnique(normalizedName, id);
      builder.set('name', normalizedName);
    }

    builder
      .set('url', params.url, (v) => this.normalizeUrl(v as string))
      .set('icon', params.icon)
      .set('sync_source_id', params.syncSourceId, normalizeSyncString)
      .set('sync_canonical_name', params.syncCanonicalName, normalizeSyncString)
      .set('sync_owner_user_id', params.syncOwnerUserId, (v) => normalizeSyncInteger(v, { min: 1 }))
      .set('sync_owner_user_name', params.syncOwnerUserName, normalizeSyncString)
      .set('sync_scope_type', params.syncScopeType, normalizeSyncString)
      .set('sync_scope_id', params.syncScopeId, normalizeSyncInteger)
      .set('sync_managed', params.syncManaged, normalizeSyncBoolean)
      .set('sync_updated_at', params.syncUpdatedAt, normalizeSyncTimestamp);

    if (builder.isEmpty) {
      const site = await this.get(id);
      if (!site) throw new Error(`SavedSite not found: ${id}`);
      return site;
    }

    const { sql, values } = builder.build('saved_sites', 'id', id)!;

    await runPrepared(this.conn, sql, values);

    logger.info('Updated saved site', { siteId: id });

    return this.get(id) as Promise<SavedSite>;
  }

  /**
   * 删除常用网站
   */
  async delete(id: string): Promise<void> {
    const referenceCount = await this.countAccountReferences(id);
    if (referenceCount > 0) {
      throw new Error(`平台仍被 ${referenceCount} 个账号引用，请先处理相关账号`);
    }

    await runPrepared(this.conn, `DELETE FROM saved_sites WHERE id = ?`, [id]);

    logger.info('Deleted saved site', { siteId: id });
  }

  /**
   * 增加使用次数
   */
  async incrementUsage(id: string): Promise<void> {
    await runPrepared(this.conn, `
      UPDATE saved_sites
      SET usage_count = usage_count + 1
      WHERE id = ?
    `, [id]);
  }

  /**
   * 将数据库行映射为 SavedSite
   */
  private mapRowToSavedSite(row: any): SavedSite {
    return {
      id: String(row.id),
      name: String(row.name),
      url: String(row.url),
      icon: row.icon ? String(row.icon) : undefined,
      usageCount: Number(row.usage_count) || 0,
      createdAt: new Date(row.created_at),
      syncSourceId: normalizeSyncString(row.sync_source_id) ?? undefined,
      syncCanonicalName: normalizeSyncString(row.sync_canonical_name) ?? undefined,
      syncOwnerUserId: normalizeSyncInteger(row.sync_owner_user_id, { min: 1 }) ?? undefined,
      syncOwnerUserName: normalizeSyncString(row.sync_owner_user_name) ?? undefined,
      syncScopeType: normalizeSyncString(row.sync_scope_type) ?? undefined,
      syncScopeId: normalizeSyncInteger(row.sync_scope_id) ?? undefined,
      syncManaged: normalizeSyncBoolean(row.sync_managed),
      syncUpdatedAt: row.sync_updated_at ? new Date(row.sync_updated_at) : undefined,
    };
  }
}
