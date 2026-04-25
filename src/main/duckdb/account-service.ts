/**
 * AccountService - 账号管理服务
 *
 * 负责管理绑定到 Profile 的登录账号
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';
import { v4 as uuidv4 } from 'uuid';
import { safeStorage } from 'electron';
import { UNBOUND_PROFILE_ID } from '../../types/profile';
import type {
  Account,
  AccountSyncPermission,
  AccountWithSecret,
  BrowserProfile,
  CreateAccountParams,
  CreateAccountWithAutoProfileParams,
  UpdateAccountParams,
} from '../../types/profile';
import type { ProfileService } from './profile-service';

const PASSWORD_ENCRYPTION_PREFIX = 'enc:v1:';

interface AccountMutationOptions {
  allowSharedMutation?: boolean;
}

/**
 * 账号服务
 */
export class AccountService {
  constructor(private conn: DuckDBConnection) {}

  private readonly selectAccountColumns = `
    id, profile_id, platform_id, display_name, name, shop_id, shop_name, password, login_url, tags, notes,
    sync_source_id, sync_owner_user_id, sync_owner_user_name, sync_permission,
    last_login_at, created_at, updated_at,
    sync_scope_type, sync_scope_id, sync_managed, sync_updated_at
  `;

  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR PRIMARY KEY,
        profile_id VARCHAR NOT NULL,
        platform_id VARCHAR,
        display_name VARCHAR,
        name VARCHAR NOT NULL,
        shop_id VARCHAR,
        shop_name VARCHAR,
        password TEXT,
        login_url VARCHAR NOT NULL,
        tags VARCHAR DEFAULT '[]',
        notes TEXT,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sync_source_id VARCHAR,
        sync_owner_user_id BIGINT,
        sync_owner_user_name VARCHAR,
        sync_permission VARCHAR DEFAULT 'mine/edit',
        sync_scope_type VARCHAR,
        sync_scope_id BIGINT,
        sync_managed BOOLEAN DEFAULT FALSE,
        sync_updated_at TIMESTAMP
      )
    `);

    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS platform_id VARCHAR`);
    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS display_name VARCHAR`);
    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shop_id VARCHAR`);
    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shop_name VARCHAR`);
    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password TEXT`);
    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tags VARCHAR DEFAULT '[]'`);
    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_source_id VARCHAR`);
    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_owner_user_id BIGINT`);
    await this.conn.run(
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_owner_user_name VARCHAR`
    );
    await this.conn.run(
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_permission VARCHAR DEFAULT 'mine/edit'`
    );
    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_scope_type VARCHAR`);
    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_scope_id BIGINT`);
    await this.conn.run(
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_managed BOOLEAN DEFAULT FALSE`
    );
    await this.conn.run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_updated_at TIMESTAMP`);

    await this.conn.run(`
      UPDATE accounts
      SET profile_id = '${UNBOUND_PROFILE_ID}'
      WHERE profile_id IS NULL OR TRIM(CAST(profile_id AS VARCHAR)) = ''
    `);
    await this.conn.run(`
      UPDATE accounts
      SET tags = '[]'
      WHERE tags IS NULL OR TRIM(CAST(tags AS VARCHAR)) = ''
    `);
    await this.conn.run(`
      UPDATE accounts
      SET sync_managed = FALSE
      WHERE sync_managed IS NULL
    `);
    await this.conn.run(`
      UPDATE accounts
      SET sync_permission = CASE
        WHEN sync_managed = TRUE THEN 'shared/view_use'
        ELSE 'mine/edit'
      END
      WHERE sync_permission IS NULL OR TRIM(CAST(sync_permission AS VARCHAR)) = ''
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_accounts_profile_id
      ON accounts(profile_id)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_accounts_created_at
      ON accounts(created_at)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_accounts_platform_id
      ON accounts(platform_id)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_accounts_shop_id
      ON accounts(shop_id)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_accounts_sync_scope
      ON accounts(sync_scope_type, sync_scope_id)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_accounts_sync_source_owner
      ON accounts(sync_source_id, sync_owner_user_id)
    `);
  }

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    await this.conn.run('BEGIN TRANSACTION');
    try {
      const result = await work();
      await this.conn.run('COMMIT');
      return result;
    } catch (error) {
      await this.conn.run('ROLLBACK');
      throw error;
    }
  }

  private encryptPassword(password?: string | null): string | null {
    const normalized = typeof password === 'string' ? password : '';
    if (!normalized) return null;

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统安全存储不可用，无法保存账号密码，请留空后重试');
    }

    try {
      const encrypted = safeStorage.encryptString(normalized);
      return `${PASSWORD_ENCRYPTION_PREFIX}${encrypted.toString('base64')}`;
    } catch (error) {
      console.warn('[AccountService] Failed to encrypt password:', error);
      throw new Error('账号密码加密失败，请稍后重试');
    }
  }

  private decryptPassword(password?: string | null): string | undefined {
    if (!password) return undefined;
    const normalized = String(password);
    if (!normalized.startsWith(PASSWORD_ENCRYPTION_PREFIX)) {
      return normalized;
    }

    const payload = normalized.slice(PASSWORD_ENCRYPTION_PREFIX.length);
    if (!payload) return undefined;

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统安全存储不可用，无法读取账号密码，请稍后重试');
    }

    try {
      return safeStorage.decryptString(Buffer.from(payload, 'base64'));
    } catch (error) {
      console.warn('[AccountService] Failed to decrypt password:', error);
      throw new Error('账号密码解密失败，请稍后重试');
    }
  }

  private hasStoredPassword(password?: string | null): boolean {
    return typeof password === 'string' && password.length > 0;
  }

  private normalizeOptionalAccountText(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized : null;
  }

  private normalizeRequiredAccountText(value: unknown, fieldName: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      throw new Error(`账号${fieldName}不能为空`);
    }
    return normalized;
  }

  private normalizeAccountTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) {
      return [];
    }

    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const item of tags) {
      const tag = String(item ?? '').trim();
      if (!tag || seen.has(tag)) {
        continue;
      }
      seen.add(tag);
      normalized.push(tag);
    }
    return normalized;
  }

  private resolveShopBinding(
    shopId: unknown,
    shopName: unknown,
    fieldPrefix: '创建' | '更新'
  ): { shopId: string | null; shopName: string | null } {
    const normalizedShopId = this.normalizeOptionalAccountText(shopId);
    const normalizedShopName = this.normalizeOptionalAccountText(shopName);
    if ((normalizedShopId === null) !== (normalizedShopName === null)) {
      throw new Error(`${fieldPrefix}账号时店铺ID和店铺名称必须同时提供或同时为空`);
    }
    return {
      shopId: normalizedShopId,
      shopName: normalizedShopName,
    };
  }

  private normalizeSyncSourceId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized : null;
  }

  private normalizeSyncOwnerUserId(value: unknown): number | null {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.trunc(numeric);
  }

  private normalizeSyncOwnerUserName(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized : null;
  }

  private normalizeSyncPermission(value: unknown): AccountSyncPermission | null {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();
    if (normalized === 'mine/edit' || normalized === 'shared/view_use') {
      return normalized as AccountSyncPermission;
    }
    return null;
  }

  private parseSyncPermission(row: { sync_managed?: unknown }): AccountSyncPermission {
    return this.normalizeSyncManaged(row.sync_managed) ? 'shared/view_use' : 'mine/edit';
  }

  private buildAccountBase(row: any): Omit<Account, 'hasPassword'> & { hasPassword: boolean } {
    let tags: string[] = [];
    if (row.tags) {
      try {
        tags = this.normalizeAccountTags(JSON.parse(row.tags));
      } catch {
        tags = [];
      }
    }

    const syncOwnerUserId = Number(row.sync_owner_user_id);
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      platformId: this.normalizeOptionalAccountText(row.platform_id) ?? undefined,
      displayName: this.normalizeOptionalAccountText(row.display_name) ?? undefined,
      name: this.normalizeRequiredAccountText(row.name, '名称'),
      shopId: this.normalizeOptionalAccountText(row.shop_id) ?? undefined,
      shopName: this.normalizeOptionalAccountText(row.shop_name) ?? undefined,
      hasPassword: this.hasStoredPassword(row.password ? String(row.password) : null),
      loginUrl: this.normalizeRequiredAccountText(row.login_url, '登录地址'),
      tags,
      notes: this.normalizeOptionalAccountText(row.notes) ?? undefined,
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      syncSourceId: this.normalizeSyncSourceId(row.sync_source_id) ?? undefined,
      syncOwnerUserId: Number.isFinite(syncOwnerUserId) ? Math.trunc(syncOwnerUserId) : undefined,
      syncOwnerUserName: this.normalizeSyncOwnerUserName(row.sync_owner_user_name) ?? undefined,
      syncPermission:
        this.normalizeSyncPermission(row.sync_permission) ?? this.parseSyncPermission(row),
      syncScopeType: this.normalizeSyncScopeType(row.sync_scope_type) ?? undefined,
      syncScopeId: this.normalizeSyncScopeId(row.sync_scope_id) ?? undefined,
      syncManaged: this.normalizeSyncManaged(row.sync_managed),
      syncUpdatedAt: row.sync_updated_at ? new Date(row.sync_updated_at) : undefined,
    };
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

  private toTimestampValue(value?: Date | null): string | null {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString();
  }

  private async recordExists(
    tableName: 'browser_profiles' | 'saved_sites',
    id: string
  ): Promise<boolean> {
    const stmt = await this.conn.prepare(`
      SELECT id
      FROM ${tableName}
      WHERE id = ?
      LIMIT 1
    `);
    stmt.bind([id]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();
    return parseRows(result).length > 0;
  }

  private async assertProfileBindingExists(profileId: string): Promise<void> {
    const normalizedProfileId = String(profileId || '').trim();
    if (!normalizedProfileId || normalizedProfileId === UNBOUND_PROFILE_ID) {
      return;
    }
    if (await this.recordExists('browser_profiles', normalizedProfileId)) {
      return;
    }
    throw new Error(`绑定的浏览器环境不存在: ${normalizedProfileId}`);
  }

  private async assertPlatformBindingExists(platformId: string | null): Promise<void> {
    const normalizedPlatformId = String(platformId || '').trim();
    if (!normalizedPlatformId) {
      return;
    }
    if (await this.recordExists('saved_sites', normalizedPlatformId)) {
      return;
    }
    throw new Error(`绑定的平台不存在: ${normalizedPlatformId}`);
  }

  private async hasPlatformAccountInProfile(
    profileId: string,
    platformId: string | null,
    options?: { excludeAccountId?: string | null }
  ): Promise<boolean> {
    const normalizedProfileId = String(profileId || '').trim();
    const normalizedPlatformId = String(platformId || '').trim();
    const excludedAccountId = String(options?.excludeAccountId || '').trim();

    if (
      !normalizedProfileId ||
      normalizedProfileId === UNBOUND_PROFILE_ID ||
      !normalizedPlatformId
    ) {
      return false;
    }

    const conditions = ['profile_id = ?', 'platform_id = ?'];
    const values: Array<string | null> = [normalizedProfileId, normalizedPlatformId];
    if (excludedAccountId) {
      conditions.push('id <> ?');
      values.push(excludedAccountId);
    }

    const stmt = await this.conn.prepare(`
      SELECT id
      FROM accounts
      WHERE ${conditions.join(' AND ')}
      LIMIT 1
    `);
    stmt.bind(values);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();
    return parseRows(result).length > 0;
  }

  private async assertProfilePlatformBindingAvailable(
    profileId: string,
    platformId: string | null,
    options?: { excludeAccountId?: string | null }
  ): Promise<void> {
    if (
      !(await this.hasPlatformAccountInProfile(profileId, platformId, {
        excludeAccountId: options?.excludeAccountId,
      }))
    ) {
      return;
    }

    throw new Error('所选浏览器环境已绑定该平台账号，请更换其他环境或自动创建新环境');
  }

  private parseStoredTags(rawTags: unknown): string[] {
    if (typeof rawTags !== 'string' || !rawTags.trim()) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawTags);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map((tag) => String(tag ?? '').trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async listAccountsForTagMutation(): Promise<Array<{ id: string; tags: string[] }>> {
    const result = await this.conn.runAndReadAll(`
      SELECT id, tags
      FROM accounts
      WHERE tags IS NOT NULL
        AND tags <> ''
        AND tags <> '[]'
      ORDER BY created_at ASC, id ASC
    `);

    return parseRows(result).map((row) => ({
      id: String(row.id),
      tags: this.parseStoredTags(row.tags),
    }));
  }

  private async updateAccountTags(id: string, tags: string[]): Promise<void> {
    const stmt = await this.conn.prepare(`
      UPDATE accounts
      SET tags = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.bind([JSON.stringify(tags), id]);
    await stmt.run();
    stmt.destroySync();
  }

  private async mutateAccountTags(
    mutate: (tags: string[]) => string[] | null,
    options?: { withinTransaction?: boolean }
  ): Promise<number> {
    const execute = async (): Promise<number> => {
      const accounts = await this.listAccountsForTagMutation();
      let affectedCount = 0;

      for (const account of accounts) {
        const nextTags = mutate(account.tags);
        if (!nextTags) {
          continue;
        }
        await this.updateAccountTags(account.id, nextTags);
        affectedCount += 1;
      }

      return affectedCount;
    };

    if (options?.withinTransaction) {
      return execute();
    }

    return this.runInTransaction(execute);
  }

  /**
   * 创建账号
   */
  async create(params: CreateAccountParams): Promise<Account> {
    const id = uuidv4();
    const tags = JSON.stringify(this.normalizeAccountTags(params.tags || []));
    const normalizedProfileId =
      typeof params.profileId === 'string' && params.profileId.trim().length > 0
        ? params.profileId.trim()
        : UNBOUND_PROFILE_ID;
    const normalizedPlatformId = this.normalizeOptionalAccountText(params.platformId);
    await this.assertProfileBindingExists(normalizedProfileId);
    await this.assertPlatformBindingExists(normalizedPlatformId);
    await this.assertProfilePlatformBindingAvailable(normalizedProfileId, normalizedPlatformId);
    const normalizedDisplayName = this.normalizeOptionalAccountText(params.displayName);
    const normalizedName = this.normalizeRequiredAccountText(params.name, '名称');
    const { shopId, shopName } = this.resolveShopBinding(params.shopId, params.shopName, '创建');
    const normalizedLoginUrl = this.normalizeRequiredAccountText(params.loginUrl, '登录地址');
    const normalizedNotes = this.normalizeOptionalAccountText(params.notes);
    const syncScopeType = this.normalizeSyncScopeType(params.syncScopeType);
    const syncScopeId = this.normalizeSyncScopeId(params.syncScopeId);
    const syncManaged = this.normalizeSyncManaged(params.syncManaged);
    const syncUpdatedAt = this.toTimestampValue(params.syncUpdatedAt);
    const syncSourceId = this.normalizeSyncSourceId(params.syncSourceId);
    const syncOwnerUserId = this.normalizeSyncOwnerUserId(params.syncOwnerUserId);
    const syncOwnerUserName = this.normalizeSyncOwnerUserName(params.syncOwnerUserName);
    const syncPermission =
      this.normalizeSyncPermission(params.syncPermission) ??
      (syncManaged ? 'shared/view_use' : 'mine/edit');

    const stmt = await this.conn.prepare(`
      INSERT INTO accounts (
        id, profile_id, platform_id, display_name, name, shop_id, shop_name, password, login_url, tags, notes,
        sync_source_id, sync_owner_user_id, sync_owner_user_name, sync_permission,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    stmt.bind([
      id,
      normalizedProfileId,
      normalizedPlatformId,
      normalizedDisplayName,
      normalizedName,
      shopId,
      shopName,
      this.encryptPassword(params.password),
      normalizedLoginUrl,
      tags,
      normalizedNotes,
      syncSourceId,
      syncOwnerUserId,
      syncOwnerUserName,
      syncPermission,
      syncScopeType,
      syncScopeId,
      syncManaged,
      syncUpdatedAt,
    ]);

    await stmt.run();
    stmt.destroySync();

    console.log(`[AccountService] Created account: ${normalizedName} (${id})`);

    return this.get(id) as Promise<Account>;
  }

  async createWithAutoProfile(
    profileService: ProfileService,
    params: CreateAccountWithAutoProfileParams
  ): Promise<{ profile: BrowserProfile; account: Account }> {
    return this.runInTransaction(async () => {
      const profile = await profileService.create(params.profile);
      const account = await this.create({
        ...params.account,
        profileId: profile.id,
      });
      return { profile, account };
    });
  }

  async renameTagAcrossAccounts(
    oldName: string,
    newName: string,
    options?: { withinTransaction?: boolean }
  ): Promise<number> {
    const normalizedOldName = String(oldName ?? '').trim();
    const normalizedNewName = String(newName ?? '').trim();
    if (!normalizedOldName || !normalizedNewName || normalizedOldName === normalizedNewName) {
      return 0;
    }

    return this.mutateAccountTags((tags) => {
      if (!tags.includes(normalizedOldName)) {
        return null;
      }

      const nextTags: string[] = [];
      const seen = new Set<string>();
      let changed = false;

      for (const tag of tags) {
        const normalizedTag = String(tag ?? '').trim();
        if (!normalizedTag) {
          changed = true;
          continue;
        }

        const resolvedTag = normalizedTag === normalizedOldName ? normalizedNewName : normalizedTag;
        if (resolvedTag !== normalizedTag) {
          changed = true;
        }
        if (seen.has(resolvedTag)) {
          changed = true;
          continue;
        }
        seen.add(resolvedTag);
        nextTags.push(resolvedTag);
      }

      return changed ? nextTags : null;
    }, options);
  }

  async removeTagFromAccounts(
    tagName: string,
    options?: { withinTransaction?: boolean }
  ): Promise<number> {
    const normalizedTagName = String(tagName ?? '').trim();
    if (!normalizedTagName) {
      return 0;
    }

    return this.mutateAccountTags((tags) => {
      if (!tags.includes(normalizedTagName)) {
        return null;
      }

      const nextTags: string[] = [];
      let changed = false;

      for (const tag of tags) {
        const normalizedTag = String(tag ?? '').trim();
        if (!normalizedTag) {
          changed = true;
          continue;
        }
        if (normalizedTag === normalizedTagName) {
          changed = true;
          continue;
        }
        nextTags.push(normalizedTag);
      }

      return changed ? nextTags : null;
    }, options);
  }

  /**
   * 获取单个账号
   */
  async get(id: string): Promise<Account | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        ${this.selectAccountColumns}
      FROM accounts
      WHERE id = ?
    `);

    stmt.bind([id]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToAccount(rows[0]);
  }

  async getWithSecret(id: string): Promise<AccountWithSecret | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        ${this.selectAccountColumns}
      FROM accounts
      WHERE id = ?
    `);

    stmt.bind([id]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToAccountWithSecret(rows[0]);
  }

  /**
   * 列出某个 Profile 的所有账号
   */
  async listByProfile(profileId: string): Promise<Account[]> {
    const stmt = await this.conn.prepare(`
      SELECT
        ${this.selectAccountColumns}
      FROM accounts
      WHERE profile_id = ?
      ORDER BY created_at DESC
    `);

    stmt.bind([profileId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    return rows.map((row) => this.mapRowToAccount(row));
  }

  /**
   * 按平台列出账号
   */
  async listByPlatform(platformId: string): Promise<Account[]> {
    const normalizedPlatformId = String(platformId || '').trim();
    if (!normalizedPlatformId) return [];

    const stmt = await this.conn.prepare(`
      SELECT
        ${this.selectAccountColumns}
      FROM accounts
      WHERE platform_id = ?
      ORDER BY created_at DESC
    `);

    stmt.bind([normalizedPlatformId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    return rows.map((row) => this.mapRowToAccount(row));
  }

  /**
   * 列出所有账号
   */
  async listAll(): Promise<Account[]> {
    const result = await this.conn.runAndReadAll(`
      SELECT
        ${this.selectAccountColumns}
      FROM accounts
      ORDER BY created_at DESC
    `);

    const rows = parseRows(result);
    return rows.map((row) => this.mapRowToAccount(row));
  }

  async listAllWithSecrets(): Promise<AccountWithSecret[]> {
    const result = await this.conn.runAndReadAll(`
      SELECT
        ${this.selectAccountColumns}
      FROM accounts
      ORDER BY created_at DESC
    `);

    const rows = parseRows(result);
    return rows.map((row) => this.mapRowToAccountWithSecret(row));
  }

  private async assertMutableAccount(
    id: string,
    options?: AccountMutationOptions
  ): Promise<Account> {
    const account = await this.get(id);
    if (!account) {
      throw new Error(`Account not found: ${id}`);
    }
    if (!options?.allowSharedMutation && account.syncPermission === 'shared/view_use') {
      throw new Error('共享账号为只读镜像，不允许编辑或删除');
    }
    return account;
  }

  async revealSecret(id: string): Promise<string | null> {
    const account = await this.getWithSecret(id);
    if (!account) {
      throw new Error(`Account not found: ${id}`);
    }
    if (account.syncPermission === 'shared/view_use') {
      throw new Error('共享账号不允许查看密码');
    }
    return account.password ?? null;
  }

  /**
   * 更新账号
   */
  async update(
    id: string,
    params: UpdateAccountParams,
    options?: AccountMutationOptions
  ): Promise<Account> {
    const currentAccount = await this.assertMutableAccount(id, options);
    const currentPlatformId = this.normalizeOptionalAccountText(currentAccount.platformId);
    const nextProfileId =
      params.profileId !== undefined
        ? typeof params.profileId === 'string' && params.profileId.trim().length > 0
          ? params.profileId.trim()
          : UNBOUND_PROFILE_ID
        : currentAccount.profileId;
    const nextPlatformId =
      params.platformId !== undefined
        ? this.normalizeOptionalAccountText(params.platformId)
        : currentPlatformId;

    if (params.profileId !== undefined) {
      await this.assertProfileBindingExists(nextProfileId);
    }
    if (params.platformId !== undefined) {
      await this.assertPlatformBindingExists(nextPlatformId);
    }
    if (nextProfileId !== currentAccount.profileId || nextPlatformId !== currentPlatformId) {
      await this.assertProfilePlatformBindingAvailable(nextProfileId, nextPlatformId, {
        excludeAccountId: id,
      });
    }

    const nextShopBinding = this.resolveShopBinding(
      params.shopId !== undefined ? params.shopId : currentAccount.shopId,
      params.shopName !== undefined ? params.shopName : currentAccount.shopName,
      '更新'
    );
    const fields: string[] = [];
    const values: any[] = [];

    if (params.name !== undefined) {
      fields.push('name = ?');
      values.push(this.normalizeRequiredAccountText(params.name, '名称'));
    }

    if (params.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(this.normalizeOptionalAccountText(params.displayName));
    }

    if (params.profileId !== undefined) {
      fields.push('profile_id = ?');
      values.push(nextProfileId);
    }

    if (params.platformId !== undefined) {
      fields.push('platform_id = ?');
      values.push(nextPlatformId);
    }

    if (params.shopId !== undefined) {
      fields.push('shop_id = ?');
      values.push(nextShopBinding.shopId);
    }

    if (params.shopName !== undefined) {
      fields.push('shop_name = ?');
      values.push(nextShopBinding.shopName);
    }

    if (params.password !== undefined) {
      fields.push('password = ?');
      values.push(this.encryptPassword(params.password));
    }

    if (params.loginUrl !== undefined) {
      fields.push('login_url = ?');
      values.push(this.normalizeRequiredAccountText(params.loginUrl, '登录地址'));
    }

    if (params.tags !== undefined) {
      fields.push('tags = ?');
      values.push(JSON.stringify(this.normalizeAccountTags(params.tags)));
    }

    if (params.notes !== undefined) {
      fields.push('notes = ?');
      values.push(this.normalizeOptionalAccountText(params.notes));
    }

    if (params.syncSourceId !== undefined) {
      fields.push('sync_source_id = ?');
      values.push(this.normalizeSyncSourceId(params.syncSourceId));
    }

    if (params.syncOwnerUserId !== undefined) {
      fields.push('sync_owner_user_id = ?');
      values.push(this.normalizeSyncOwnerUserId(params.syncOwnerUserId));
    }

    if (params.syncOwnerUserName !== undefined) {
      fields.push('sync_owner_user_name = ?');
      values.push(this.normalizeSyncOwnerUserName(params.syncOwnerUserName));
    }

    if (params.syncPermission !== undefined) {
      fields.push('sync_permission = ?');
      values.push(this.normalizeSyncPermission(params.syncPermission));
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
      return currentAccount;
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = await this.conn.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`);
    stmt.bind(values);
    await stmt.run();
    stmt.destroySync();

    console.log(`[AccountService] Updated account: ${id}`);

    return this.get(id) as Promise<Account>;
  }

  /**
   * 删除账号
   */
  async delete(id: string, options?: AccountMutationOptions): Promise<void> {
    await this.assertMutableAccount(id, options);
    const stmt = await this.conn.prepare(`DELETE FROM accounts WHERE id = ?`);
    stmt.bind([id]);
    await stmt.run();
    stmt.destroySync();

    console.log(`[AccountService] Deleted account: ${id}`);
  }

  /**
   * 删除某个 Profile 的所有账号
   */
  async deleteByProfile(profileId: string): Promise<void> {
    const stmt = await this.conn.prepare(`DELETE FROM accounts WHERE profile_id = ?`);
    stmt.bind([profileId]);
    await stmt.run();
    stmt.destroySync();

    console.log(`[AccountService] Deleted all accounts for profile: ${profileId}`);
  }

  /**
   * 更新最后登录时间
   */
  async updateLastLogin(id: string): Promise<void> {
    const stmt = await this.conn.prepare(`
      UPDATE accounts
      SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.bind([id]);
    await stmt.run();
    stmt.destroySync();
  }

  /**
   * 将数据库行映射为 Account
   */
  private mapRowToAccount(row: any): Account {
    return this.buildAccountBase(row);
  }

  private mapRowToAccountWithSecret(row: any): AccountWithSecret {
    return {
      ...this.buildAccountBase(row),
      password: this.decryptPassword(row.password ? String(row.password) : null),
    };
  }
}
