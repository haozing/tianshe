/**
 * SavedSiteService - 常用网站管理服务
 *
 * 负责管理全局的常用登录网站列表
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';
import { v4 as uuidv4 } from 'uuid';
import type { SavedSite, CreateSavedSiteParams, UpdateSavedSiteParams } from '../../types/profile';

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

    await this.conn.run(`ALTER TABLE saved_sites ADD COLUMN IF NOT EXISTS sync_source_id VARCHAR`);
    await this.conn.run(
      `ALTER TABLE saved_sites ADD COLUMN IF NOT EXISTS sync_canonical_name VARCHAR`
    );
    await this.conn.run(
      `ALTER TABLE saved_sites ADD COLUMN IF NOT EXISTS sync_owner_user_id BIGINT`
    );
    await this.conn.run(
      `ALTER TABLE saved_sites ADD COLUMN IF NOT EXISTS sync_owner_user_name VARCHAR`
    );
    await this.conn.run(`ALTER TABLE saved_sites ADD COLUMN IF NOT EXISTS sync_scope_type VARCHAR`);
    await this.conn.run(`ALTER TABLE saved_sites ADD COLUMN IF NOT EXISTS sync_scope_id BIGINT`);
    await this.conn.run(
      `ALTER TABLE saved_sites ADD COLUMN IF NOT EXISTS sync_managed BOOLEAN DEFAULT FALSE`
    );
    await this.conn.run(
      `ALTER TABLE saved_sites ADD COLUMN IF NOT EXISTS sync_updated_at TIMESTAMP`
    );

    await this.conn.run(`
      UPDATE saved_sites
      SET usage_count = 0
      WHERE usage_count IS NULL
    `);
    await this.conn.run(`
      UPDATE saved_sites
      SET sync_managed = FALSE
      WHERE sync_managed IS NULL
    `);
    await this.conn.run(`
      UPDATE saved_sites
      SET sync_source_id = NULL
      WHERE sync_source_id IS NOT NULL
        AND TRIM(CAST(sync_source_id AS VARCHAR)) = ''
    `);
    await this.conn.run(`
      UPDATE saved_sites
      SET sync_canonical_name = NULL
      WHERE sync_canonical_name IS NOT NULL
        AND TRIM(CAST(sync_canonical_name AS VARCHAR)) = ''
    `);

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
    const presetStmt = await this.conn.prepare(`
      INSERT INTO saved_sites (
        id, name, url, icon, usage_count, created_at, sync_managed
      )
      VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, FALSE)
      ON CONFLICT (id) DO NOTHING
    `);
    for (const site of presetSites) {
      presetStmt.bind([site.id, site.name, site.url, site.icon]);
      await presetStmt.run();
    }
    presetStmt.destroySync();
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

  private normalizeSyncSourceId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized : null;
  }

  private normalizeSyncCanonicalName(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized : null;
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
    const stmt = await this.conn.prepare(sql);
    stmt.bind(hasExcludeId ? [name, excludeId] : [name]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length > 0) {
      throw new Error(`平台「${name}」已存在`);
    }
  }

  private async countAccountReferences(id: string): Promise<number> {
    const stmt = await this.conn.prepare(`
      SELECT COUNT(*) AS reference_count
      FROM accounts
      WHERE platform_id = ?
    `);
    stmt.bind([id]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

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
    const syncSourceId = this.normalizeSyncSourceId(params.syncSourceId);
    const syncCanonicalName =
      this.normalizeSyncCanonicalName(params.syncCanonicalName) ??
      (syncSourceId ? normalizedName : null);
    const syncOwnerUserId = this.normalizeSyncOwnerUserId(params.syncOwnerUserId);
    const syncOwnerUserName = this.normalizeSyncOwnerUserName(params.syncOwnerUserName);
    const syncScopeType = this.normalizeSyncScopeType(params.syncScopeType);
    const syncScopeId = this.normalizeSyncScopeId(params.syncScopeId);
    const syncManaged = this.normalizeSyncManaged(params.syncManaged);
    const syncUpdatedAt = this.toTimestampValue(params.syncUpdatedAt);

    const stmt = await this.conn.prepare(`
      INSERT INTO saved_sites (
        id, name, url, icon, usage_count, created_at,
        sync_source_id, sync_canonical_name, sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      ) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.bind([
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

    await stmt.run();
    stmt.destroySync();

    console.log(`[SavedSiteService] Created saved site: ${normalizedName} (${id})`);

    return this.get(id) as Promise<SavedSite>;
  }

  /**
   * 获取单个常用网站
   */
  async get(id: string): Promise<SavedSite | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        id, name, url, icon, usage_count, created_at,
        sync_source_id, sync_canonical_name, sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM saved_sites
      WHERE id = ?
    `);

    stmt.bind([id]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToSavedSite(rows[0]);
  }

  /**
   * 通过名称查找平台
   */
  async getByName(name: string): Promise<SavedSite | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        id, name, url, icon, usage_count, created_at,
        sync_source_id, sync_canonical_name, sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM saved_sites
      WHERE name = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `);

    stmt.bind([name]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToSavedSite(rows[0]);
  }

  /**
   * 通过 URL 查找常用网站
   */
  async getByUrl(url: string): Promise<SavedSite | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        id, name, url, icon, usage_count, created_at,
        sync_source_id, sync_canonical_name, sync_owner_user_id, sync_owner_user_name,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
      FROM saved_sites
      WHERE url = ?
    `);

    stmt.bind([url]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

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
    const fields: string[] = [];
    const values: any[] = [];

    if (params.name !== undefined) {
      const normalizedName = this.normalizeName(params.name);
      await this.ensureNameUnique(normalizedName, id);
      fields.push('name = ?');
      values.push(normalizedName);
    }

    if (params.url !== undefined) {
      const normalizedUrl = this.normalizeUrl(params.url);
      fields.push('url = ?');
      values.push(normalizedUrl);
    }

    if (params.icon !== undefined) {
      fields.push('icon = ?');
      values.push(params.icon);
    }

    if (params.syncSourceId !== undefined) {
      fields.push('sync_source_id = ?');
      values.push(this.normalizeSyncSourceId(params.syncSourceId));
    }

    if (params.syncCanonicalName !== undefined) {
      fields.push('sync_canonical_name = ?');
      values.push(this.normalizeSyncCanonicalName(params.syncCanonicalName));
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
      const site = await this.get(id);
      if (!site) throw new Error(`SavedSite not found: ${id}`);
      return site;
    }

    values.push(id);

    const stmt = await this.conn.prepare(
      `UPDATE saved_sites SET ${fields.join(', ')} WHERE id = ?`
    );
    stmt.bind(values);
    await stmt.run();
    stmt.destroySync();

    console.log(`[SavedSiteService] Updated saved site: ${id}`);

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

    const stmt = await this.conn.prepare(`DELETE FROM saved_sites WHERE id = ?`);
    stmt.bind([id]);
    await stmt.run();
    stmt.destroySync();

    console.log(`[SavedSiteService] Deleted saved site: ${id}`);
  }

  /**
   * 增加使用次数
   */
  async incrementUsage(id: string): Promise<void> {
    const stmt = await this.conn.prepare(`
      UPDATE saved_sites
      SET usage_count = usage_count + 1
      WHERE id = ?
    `);

    stmt.bind([id]);
    await stmt.run();
    stmt.destroySync();
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
      syncSourceId: this.normalizeSyncSourceId(row.sync_source_id) ?? undefined,
      syncCanonicalName: this.normalizeSyncCanonicalName(row.sync_canonical_name) ?? undefined,
      syncOwnerUserId: this.normalizeSyncOwnerUserId(row.sync_owner_user_id) ?? undefined,
      syncOwnerUserName: this.normalizeSyncOwnerUserName(row.sync_owner_user_name) ?? undefined,
      syncScopeType: this.normalizeSyncScopeType(row.sync_scope_type) ?? undefined,
      syncScopeId: this.normalizeSyncScopeId(row.sync_scope_id) ?? undefined,
      syncManaged: this.normalizeSyncManaged(row.sync_managed),
      syncUpdatedAt: row.sync_updated_at ? new Date(row.sync_updated_at) : undefined,
    };
  }
}
