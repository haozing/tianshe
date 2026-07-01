/**
 * AccountService - 账号管理服务
 *
 * 负责管理绑定到 Profile 的登录账号
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows, runInDuckDbTransaction } from './utils';
import { allPrepared, runPrepared } from './statement-executor';
import { SqlUpdateBuilder } from './sql-update-builder';
import { SchemaMigrationEngine } from './migration-engine';
import {
  ACCOUNT_SCHEMA_BACKFILLS,
  ACCOUNT_SCHEMA_MIGRATIONS,
  runSchemaBackfills,
} from './schema-migrations';
import {
  normalizeSyncString,
  normalizeSyncInteger,
  normalizeSyncBoolean,
  normalizeSyncTimestamp,
} from './sync-field-normalizer';
import { v4 as uuidv4 } from 'uuid';
import { safeStorage } from 'electron';
import { UNBOUND_PROFILE_ID } from '../../types/profile';
import { createLogger } from '../../core/logger';
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
const logger = createLogger('AccountService');

interface AccountMutationOptions {
  allowSharedMutation?: boolean;
}

const ACCOUNT_LOGIN_STATE_INVALIDATION_FIELDS = new Set<keyof UpdateAccountParams>([
  'profileId',
  'platformId',
  'shopId',
  'shopName',
  'password',
  'loginUrl',
]);

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

    await new SchemaMigrationEngine(this.conn).migrate(ACCOUNT_SCHEMA_MIGRATIONS);
    await runSchemaBackfills(this.conn, ACCOUNT_SCHEMA_BACKFILLS);

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
    return runInDuckDbTransaction(this.conn, work);
  }

  private shouldInvalidateLoginState(params: UpdateAccountParams): boolean {
    return Object.keys(params).some((key) =>
      ACCOUNT_LOGIN_STATE_INVALIDATION_FIELDS.has(key as keyof UpdateAccountParams)
    );
  }

  private async deleteLoginStatesByAccount(accountId: string): Promise<void> {
    try {
      await runPrepared(this.conn, `DELETE FROM profile_login_states WHERE account_id = ?`, [
        accountId,
      ]);
    } catch (error) {
      if (!String((error as { message?: unknown })?.message || error).includes('profile_login_states')) {
        throw error;
      }
    }
  }

  private async deleteLoginStatesByProfile(profileId: string): Promise<void> {
    try {
      await runPrepared(this.conn, `DELETE FROM profile_login_states WHERE profile_id = ?`, [
        profileId,
      ]);
    } catch (error) {
      if (!String((error as { message?: unknown })?.message || error).includes('profile_login_states')) {
        throw error;
      }
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
      logger.warn('Failed to encrypt password', error);
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
      logger.warn('Failed to decrypt password', error);
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
    return normalizeSyncBoolean(row.sync_managed) ? 'shared/view_use' : 'mine/edit';
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
      syncSourceId: normalizeSyncString(row.sync_source_id) ?? undefined,
      syncOwnerUserId: normalizeSyncInteger(row.sync_owner_user_id) ?? undefined,
      syncOwnerUserName: normalizeSyncString(row.sync_owner_user_name) ?? undefined,
      syncPermission:
        this.normalizeSyncPermission(row.sync_permission) ?? this.parseSyncPermission(row),
      syncScopeType: normalizeSyncString(row.sync_scope_type) ?? undefined,
      syncScopeId: normalizeSyncInteger(row.sync_scope_id) ?? undefined,
      syncManaged: normalizeSyncBoolean(row.sync_managed),
      syncUpdatedAt: row.sync_updated_at ? new Date(row.sync_updated_at) : undefined,
    };
  }


  private async recordExists(
    tableName: 'browser_profiles' | 'saved_sites',
    id: string
  ): Promise<boolean> {
    const result = await allPrepared(this.conn, `
      SELECT id
      FROM ${tableName}
      WHERE id = ?
      LIMIT 1
    `, [id]);
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

    const result = await allPrepared(this.conn, `
      SELECT id
      FROM accounts
      WHERE ${conditions.join(' AND ')}
      LIMIT 1
    `, values);
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
    await runPrepared(this.conn, `
      UPDATE accounts
      SET tags = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [JSON.stringify(tags), id]);
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
    const syncScopeType = normalizeSyncString(params.syncScopeType);
    const syncScopeId = normalizeSyncInteger(params.syncScopeId);
    const syncManaged = normalizeSyncBoolean(params.syncManaged);
    const syncUpdatedAt = normalizeSyncTimestamp(params.syncUpdatedAt);
    const syncSourceId = normalizeSyncString(params.syncSourceId);
    const syncOwnerUserId = normalizeSyncInteger(params.syncOwnerUserId);
    const syncOwnerUserName = normalizeSyncString(params.syncOwnerUserName);
    const syncPermission =
      this.normalizeSyncPermission(params.syncPermission) ??
      (syncManaged ? 'shared/view_use' : 'mine/edit');

    await runPrepared(this.conn, `
      INSERT INTO accounts (
        id, profile_id, platform_id, display_name, name, shop_id, shop_name, password, login_url, tags, notes,
        sync_source_id, sync_owner_user_id, sync_owner_user_name, sync_permission,
        sync_scope_type, sync_scope_id, sync_managed, sync_updated_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
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

    logger.info('Created account', { accountId: id, accountName: normalizedName });

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
    const result = await allPrepared(this.conn, `
      SELECT
        ${this.selectAccountColumns}
      FROM accounts
      WHERE id = ?
    `, [id]);

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToAccount(rows[0]);
  }

  async getWithSecret(id: string): Promise<AccountWithSecret | null> {
    const result = await allPrepared(this.conn, `
      SELECT
        ${this.selectAccountColumns}
      FROM accounts
      WHERE id = ?
    `, [id]);

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    return this.mapRowToAccountWithSecret(rows[0]);
  }

  /**
   * 列出某个 Profile 的所有账号
   */
  async listByProfile(profileId: string): Promise<Account[]> {
    const result = await allPrepared(this.conn, `
      SELECT
        ${this.selectAccountColumns}
      FROM accounts
      WHERE profile_id = ?
      ORDER BY created_at DESC
    `, [profileId]);

    const rows = parseRows(result);
    return rows.map((row) => this.mapRowToAccount(row));
  }

  /**
   * 按平台列出账号
   */
  async listByPlatform(platformId: string): Promise<Account[]> {
    const normalizedPlatformId = String(platformId || '').trim();
    if (!normalizedPlatformId) return [];

    const result = await allPrepared(this.conn, `
      SELECT
        ${this.selectAccountColumns}
      FROM accounts
      WHERE platform_id = ?
      ORDER BY created_at DESC
    `, [normalizedPlatformId]);

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
    const builder = new SqlUpdateBuilder()
      .set('name', params.name, (v) => this.normalizeRequiredAccountText(v as string, '名称'))
      .set('display_name', params.displayName, (v) => this.normalizeOptionalAccountText(v as string))
      .set('profile_id', params.profileId, () => nextProfileId)
      .set('platform_id', params.platformId, () => nextPlatformId)
      .set('shop_id', params.shopId, () => nextShopBinding.shopId)
      .set('shop_name', params.shopName, () => nextShopBinding.shopName)
      .set('password', params.password, (v) => this.encryptPassword(v as string))
      .set('login_url', params.loginUrl, (v) => this.normalizeRequiredAccountText(v as string, '登录地址'))
      .set('tags', params.tags, (v) => JSON.stringify(this.normalizeAccountTags(v as string[])))
      .set('notes', params.notes, (v) => this.normalizeOptionalAccountText(v as string))
      .set('sync_source_id', params.syncSourceId, normalizeSyncString)
      .set('sync_owner_user_id', params.syncOwnerUserId, normalizeSyncInteger)
      .set('sync_owner_user_name', params.syncOwnerUserName, normalizeSyncString)
      .set('sync_permission', params.syncPermission, (v) => this.normalizeSyncPermission(v))
      .set('sync_scope_type', params.syncScopeType, normalizeSyncString)
      .set('sync_scope_id', params.syncScopeId, normalizeSyncInteger)
      .set('sync_managed', params.syncManaged, normalizeSyncBoolean)
      .set('sync_updated_at', params.syncUpdatedAt, normalizeSyncTimestamp);

    if (builder.isEmpty) {
      return currentAccount;
    }

    builder.setRaw('updated_at', 'CURRENT_TIMESTAMP');

    const { sql, values } = builder.build('accounts', 'id', id)!;

    await runPrepared(this.conn, sql, values);
    if (this.shouldInvalidateLoginState(params)) {
      await this.deleteLoginStatesByAccount(id);
    }

    logger.info('Updated account', { accountId: id });

    return this.get(id) as Promise<Account>;
  }

  /**
   * 删除账号
   */
  async delete(id: string, options?: AccountMutationOptions): Promise<void> {
    await this.assertMutableAccount(id, options);
    await this.runInTransaction(async () => {
      await this.deleteLoginStatesByAccount(id);
      await runPrepared(this.conn, `DELETE FROM accounts WHERE id = ?`, [id]);
    });

    logger.info('Deleted account', { accountId: id });
  }

  /**
   * 删除某个 Profile 的所有账号
   */
  async deleteByProfile(profileId: string): Promise<void> {
    await this.runInTransaction(async () => {
      await this.deleteLoginStatesByProfile(profileId);
      await runPrepared(this.conn, `DELETE FROM accounts WHERE profile_id = ?`, [profileId]);
    });

    logger.info('Deleted all accounts for profile', { profileId });
  }

  /**
   * 更新最后登录时间
   */
  async updateLastLogin(id: string): Promise<void> {
    await runPrepared(this.conn, `
      UPDATE accounts
      SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);
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
