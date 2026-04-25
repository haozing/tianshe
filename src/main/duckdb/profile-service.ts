/**
 * ProfileService - 浏览器配置管理服务
 *
 * v2 架构核心服务，负责 BrowserProfile 的 CRUD 操作
 *
 * 设计原则：
 * - 平台提供能力，插件决定如何使用
 * - 不强制绑定关系，由插件自己管理
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import { app, session } from 'electron';
import type {
  BrowserProfile,
  ProfileListParams,
  CreateProfileParams,
  UpdateProfileParams,
  ProxyConfig,
  FingerprintConfig,
  FingerprintCoreConfig,
  FingerprintSourceConfig,
  ProfileStatus,
  AutomationEngine,
  DeepPartial,
} from '../../types/profile';
import {
  UNBOUND_PROFILE_ID,
  isAutomationEngine,
  normalizeProfileBrowserQuota,
  normalizeAutomationEngine,
} from '../../types/profile';
import { getDefaultFingerprint } from '../profile/presets';
import {
  DEFAULT_BROWSER_PROFILE,
  DEFAULT_BROWSER_POOL_CONFIG,
  BROWSER_POOL_LIMITS,
} from '../../constants/browser-pool';
import {
  extractFingerprintCoreConfig,
  mergeFingerprintConfig,
  mergeFingerprintCoreConfig,
  materializeFingerprintConfigFromCore,
  materializeFingerprintConfigForEngine,
} from '../../constants/fingerprint-defaults';
import { validateFingerprintConfig } from '../../core/fingerprint/fingerprint-validation';
import { resolveUserDataDir } from '../../constants/runtime-config';
import { observationService } from '../../core/observability/observation-service';
import { attachErrorContextArtifact } from '../../core/observability/error-context-artifact';
import {
  createChildTraceContext,
  getCurrentTraceContext,
  withTraceContext,
} from '../../core/observability/observation-context';

const ALLOWED_PROXY_TYPES: Array<Exclude<ProxyConfig['type'], 'none'>> = [
  'http',
  'https',
  'socks4',
  'socks5',
];
const DEFERRED_PARTITION_CLEANUP_FILE = 'profile-partition-cleanup.json';
const PARTITION_DELETE_RETRY_DELAYS_MS = [200, 350, 550, 800, 1200, 1600];

function isCanonicalFingerprintConfig(value: unknown): value is FingerprintConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const fingerprint = value as Partial<FingerprintConfig>;
  return (
    typeof fingerprint.identity === 'object' &&
    fingerprint.identity !== null &&
    typeof fingerprint.source === 'object' &&
    fingerprint.source !== null &&
    typeof fingerprint.identity.region?.timezone === 'string' &&
    typeof fingerprint.identity.hardware?.userAgent === 'string' &&
    typeof fingerprint.source.mode === 'string' &&
    fingerprint.source.fileFormat === 'txt'
  );
}

/**
 * Profile 服务
 */
export class ProfileService {
  constructor(private conn: DuckDBConnection) {}

  private getUserDataDir(): string {
    return resolveUserDataDir(app.getPath('userData'));
  }

  private getDeferredPartitionCleanupPath(): string {
    return path.join(this.getUserDataDir(), DEFERRED_PARTITION_CLEANUP_FILE);
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetryablePartitionCleanupError(error: unknown): boolean {
    const code =
      typeof error === 'object' && error !== null ? String((error as any).code || '') : '';
    return code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM';
  }

  private async readDeferredPartitionCleanupEntries(): Promise<string[]> {
    try {
      const filePath = this.getDeferredPartitionCleanupPath();
      if (!fs.existsSync(filePath)) {
        return [];
      }

      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }

  private async writeDeferredPartitionCleanupEntries(entries: string[]): Promise<void> {
    const filePath = this.getDeferredPartitionCleanupPath();
    const normalized = Array.from(
      new Set(entries.map((entry) => String(entry || '').trim()).filter(Boolean))
    );

    if (normalized.length === 0) {
      await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      return;
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8');
  }

  private async enqueueDeferredPartitionCleanup(storagePath: string): Promise<void> {
    const entries = await this.readDeferredPartitionCleanupEntries();
    entries.push(storagePath);
    await this.writeDeferredPartitionCleanupEntries(entries);
  }

  private async removePartitionStoragePath(
    storagePath: string
  ): Promise<'removed' | 'missing' | 'deferred'> {
    if (!storagePath || !fs.existsSync(storagePath)) {
      return 'missing';
    }

    for (let attempt = 0; attempt < PARTITION_DELETE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        await fs.promises.rm(storagePath, { recursive: true, force: true });
        return 'removed';
      } catch (error) {
        if (!this.isRetryablePartitionCleanupError(error)) {
          throw error;
        }

        if (attempt === PARTITION_DELETE_RETRY_DELAYS_MS.length - 1) {
          return 'deferred';
        }

        await this.wait(PARTITION_DELETE_RETRY_DELAYS_MS[attempt]);
      }
    }

    return 'deferred';
  }

  async sweepDeferredPartitionCleanup(): Promise<void> {
    const entries = await this.readDeferredPartitionCleanupEntries();
    if (entries.length === 0) {
      return;
    }

    const remaining: string[] = [];
    for (const storagePath of entries) {
      try {
        const result = await this.removePartitionStoragePath(storagePath);
        if (result === 'deferred') {
          remaining.push(storagePath);
        }
      } catch (error) {
        console.warn(
          `[ProfileService] Failed to sweep deferred partition cleanup: ${storagePath}`,
          error
        );
        remaining.push(storagePath);
      }
    }

    await this.writeDeferredPartitionCleanupEntries(remaining);
  }

  private async purgePartitionData(partition: string): Promise<void> {
    try {
      const ses = session.fromPartition(partition);

      // 尽量先清理 session 内部存储，避免文件句柄占用导致删除失败
      try {
        await ses.clearStorageData();
      } catch {
        // ignore
      }
      try {
        await ses.clearCache();
      } catch {
        // ignore
      }
      try {
        ses.flushStorageData();
      } catch {
        // ignore
      }
      try {
        await ses.cookies.flushStore();
      } catch {
        // ignore
      }

      const storagePath = ses.storagePath;
      if (storagePath && fs.existsSync(storagePath)) {
        const result = await this.removePartitionStoragePath(storagePath);
        if (result === 'deferred') {
          await this.enqueueDeferredPartitionCleanup(storagePath);
          console.log(
            `[ProfileService] Deferred partition cleanup until next launch: ${partition} (${storagePath})`
          );
        }
      }
    } catch (error) {
      console.warn(`[ProfileService] Failed to purge partition data: ${partition}`, error);
    }
  }

  private async purgeExtensionProfileData(profileId: string): Promise<void> {
    const userDataDir = this.getUserDataDir();
    const targets = [
      path.join(userDataDir, 'extension', 'chrome', 'profiles', profileId),
      path.join(userDataDir, 'extension', 'chrome', 'control-runtime', profileId),
    ];

    for (const target of targets) {
      try {
        if (fs.existsSync(target)) {
          await fs.promises.rm(target, { recursive: true, force: true });
        }
      } catch (error) {
        console.warn(`[ProfileService] Failed to purge extension profile data: ${target}`, error);
      }
    }
  }

  private normalizeProxyConfig(proxy: ProxyConfig | null | undefined): ProxyConfig | null {
    if (!proxy || proxy.type === 'none') return null;

    if (!ALLOWED_PROXY_TYPES.includes(proxy.type as Exclude<ProxyConfig['type'], 'none'>)) {
      throw new Error(`Unsupported proxy type: ${String(proxy.type)}`);
    }

    const host = String(proxy.host || '').trim();
    if (!host) {
      throw new Error('Proxy host is required when proxy is enabled');
    }

    const port = Number.parseInt(String(proxy.port ?? ''), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Proxy port must be an integer between 1 and 65535');
    }

    const username = typeof proxy.username === 'string' ? proxy.username.trim() : '';
    const password = typeof proxy.password === 'string' ? proxy.password.trim() : '';
    const bypassList = typeof proxy.bypassList === 'string' ? proxy.bypassList.trim() : '';

    return {
      type: proxy.type as Exclude<ProxyConfig['type'], 'none'>,
      host,
      port,
      username: username || undefined,
      password: password || undefined,
      bypassList: bypassList || undefined,
    };
  }

  private normalizeQuotaValue(rawValue: number | undefined): number {
    const parsed =
      typeof rawValue === 'number' && Number.isFinite(rawValue)
        ? Math.trunc(rawValue)
        : DEFAULT_BROWSER_PROFILE.quota;
    return Math.min(BROWSER_POOL_LIMITS.maxTotalBrowsers.max, Math.max(1, parsed));
  }

  private normalizeIdleTimeoutMs(rawValue: number | undefined): number {
    const parsed =
      typeof rawValue === 'number' && Number.isFinite(rawValue)
        ? Math.trunc(rawValue)
        : DEFAULT_BROWSER_POOL_CONFIG.defaultIdleTimeoutMs;
    return Math.min(
      BROWSER_POOL_LIMITS.defaultIdleTimeoutMs.max,
      Math.max(BROWSER_POOL_LIMITS.defaultIdleTimeoutMs.min, parsed)
    );
  }

  private normalizeLockTimeoutMs(rawValue: number | undefined): number {
    const parsed =
      typeof rawValue === 'number' && Number.isFinite(rawValue)
        ? Math.trunc(rawValue)
        : DEFAULT_BROWSER_POOL_CONFIG.defaultLockTimeoutMs;
    return Math.min(
      BROWSER_POOL_LIMITS.defaultLockTimeoutMs.max,
      Math.max(BROWSER_POOL_LIMITS.defaultLockTimeoutMs.min, parsed)
    );
  }

  private getChromiumMajorVersion(): number {
    const chrome = (process.versions && (process.versions as any).chrome) || '';
    const major = Number.parseInt(String(chrome).split('.')[0] || '', 10);
    return Number.isFinite(major) && major > 0 ? major : 120;
  }

  private buildSystemDefaultFingerprint(): FingerprintConfig {
    const major = this.getChromiumMajorVersion();
    const fullVersion = `${major}.0.0.0`;

    if (process.platform === 'win32') {
      return mergeFingerprintConfig(getDefaultFingerprint('electron'), {
        identity: {
          hardware: {
            browserFamily: 'electron',
            browserVersion: fullVersion,
            userAgent:
              `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
              `Chrome/${fullVersion} Safari/537.36 Edg/${fullVersion}`,
          },
        },
      });
    }

    return mergeFingerprintConfig(getDefaultFingerprint('electron'), {
      identity: {
        hardware: {
          browserFamily: 'electron',
          browserVersion: fullVersion,
        },
      },
      });
  }

  private mergeFingerprintSourceConfig(
    _base: FingerprintSourceConfig,
    _overrides: Partial<FingerprintSourceConfig> | undefined
  ): FingerprintSourceConfig {
    return {
      mode: 'generated',
      fileFormat: 'txt',
    };
  }

  private buildFingerprintForPersistence(
    engine: AutomationEngine,
    options: {
      fingerprintCore?: DeepPartial<FingerprintCoreConfig>;
      fingerprintSource?: Partial<FingerprintSourceConfig>;
      baseFingerprint?: FingerprintConfig;
      fallbackSharedFingerprint?: FingerprintConfig;
      overrides?: DeepPartial<FingerprintConfig>;
    } = {}
  ): FingerprintConfig {
    if (options.fingerprintCore || options.fingerprintSource) {
      const baseFingerprint =
        options.baseFingerprint ??
        options.fallbackSharedFingerprint ??
        getDefaultFingerprint(engine);
      const mergedCore = mergeFingerprintCoreConfig(
        extractFingerprintCoreConfig(baseFingerprint),
        options.fingerprintCore ?? {}
      );
      const mergedSource = this.mergeFingerprintSourceConfig(
        baseFingerprint.source,
        options.fingerprintSource
      );
      return materializeFingerprintConfigFromCore(mergedCore, mergedSource, engine);
    }

    const seed =
      options.baseFingerprint ??
      (options.fallbackSharedFingerprint
        ? mergeFingerprintConfig(
            getDefaultFingerprint(engine),
            {
              identity: {
                region: {
                  timezone: options.fallbackSharedFingerprint.identity.region.timezone,
                  languages: [...options.fallbackSharedFingerprint.identity.region.languages],
                },
                hardware: {
                  osFamily: options.fallbackSharedFingerprint.identity.hardware.osFamily,
                  hardwareConcurrency:
                    options.fallbackSharedFingerprint.identity.hardware.hardwareConcurrency,
                  deviceMemory: options.fallbackSharedFingerprint.identity.hardware.deviceMemory,
                },
                display: {
                  width: options.fallbackSharedFingerprint.identity.display.width,
                  height: options.fallbackSharedFingerprint.identity.display.height,
                },
                graphics: {
                  webgl: {
                    maskedVendor:
                      options.fallbackSharedFingerprint.identity.graphics?.webgl?.maskedVendor,
                    maskedRenderer:
                      options.fallbackSharedFingerprint.identity.graphics?.webgl?.maskedRenderer,
                  },
                },
              },
              source: {
                mode: 'generated',
                fileFormat: 'txt',
              },
            }
          )
        : getDefaultFingerprint(engine));

    const merged = options.overrides ? mergeFingerprintConfig(seed, options.overrides) : seed;
    return materializeFingerprintConfigForEngine(merged, engine);
  }

  private assertValidFingerprintConfig(
    fingerprint: FingerprintConfig,
    engine: AutomationEngine,
    label: string
  ): void {
    const validation = validateFingerprintConfig(fingerprint, engine);
    if (!validation.valid) {
      throw new Error(
        `${label} fingerprint is invalid: ${validation.warnings.join(', ')}`
      );
    }
  }

  private async tableExists(tableName: string): Promise<boolean> {
    try {
      const escapedTableName = tableName.replace(/'/g, "''");
      const result = await this.conn.runAndReadAll(`PRAGMA table_info('${escapedTableName}')`);
      return parseRows(result).length > 0;
    } catch {
      return false;
    }
  }

  private async cleanupInvalidStoredProfiles(): Promise<void> {
    const result = await this.conn.runAndReadAll(`
      SELECT id, partition, engine, fingerprint
      FROM browser_profiles
      ORDER BY id ASC
    `);
    const rows = parseRows(result);
    const invalidProfiles: Array<{
      id: string;
      partition: string;
      reason: string;
    }> = [];

    for (const row of rows) {
      const id = String(row.id || '').trim();
      if (!id) {
        continue;
      }

      const rawEngine = String(row.engine || '').trim();
      if (!isAutomationEngine(rawEngine)) {
        invalidProfiles.push({
          id,
          partition: String(row.partition || '').trim(),
          reason: `unsupported engine: ${rawEngine || '(empty)'}`,
        });
        continue;
      }

      const fingerprint = this.parseJSON<unknown>(row.fingerprint);
      if (!isCanonicalFingerprintConfig(fingerprint)) {
        invalidProfiles.push({
          id,
          partition: String(row.partition || '').trim(),
          reason: 'non-canonical fingerprint payload',
        });
        continue;
      }

      const validation = validateFingerprintConfig(fingerprint, rawEngine);
      if (!validation.valid) {
        invalidProfiles.push({
          id,
          partition: String(row.partition || '').trim(),
          reason: validation.warnings.join(', '),
        });
      }
    }

    if (invalidProfiles.length === 0) {
      return;
    }

    const profileIds = invalidProfiles.map((profile) => profile.id);
    const placeholders = profileIds.map(() => '?').join(', ');
    const hasAccountsTable = await this.tableExists('accounts');
    const hasProfileExtensionsTable = await this.tableExists('profile_extensions');

    try {
      await this.conn.run('BEGIN TRANSACTION');

      if (hasAccountsTable) {
        const stmtMarkAccountsUnbound = await this.conn.prepare(`
          UPDATE accounts
          SET profile_id = ?
          WHERE profile_id IN (${placeholders})
        `);
        stmtMarkAccountsUnbound.bind([UNBOUND_PROFILE_ID, ...profileIds]);
        await stmtMarkAccountsUnbound.run();
        stmtMarkAccountsUnbound.destroySync();
      }

      if (hasProfileExtensionsTable) {
        const stmtDeleteBindings = await this.conn.prepare(`
          DELETE FROM profile_extensions
          WHERE profile_id IN (${placeholders})
        `);
        stmtDeleteBindings.bind(profileIds);
        await stmtDeleteBindings.run();
        stmtDeleteBindings.destroySync();
      }

      const stmtDeleteProfiles = await this.conn.prepare(`
        DELETE FROM browser_profiles
        WHERE id IN (${placeholders})
      `);
      stmtDeleteProfiles.bind(profileIds);
      await stmtDeleteProfiles.run();
      stmtDeleteProfiles.destroySync();

      await this.conn.run('COMMIT');
    } catch (error) {
      await this.conn.run('ROLLBACK');
      throw error;
    }

    for (const profile of invalidProfiles) {
      if (profile.partition) {
        await this.purgePartitionData(profile.partition);
      }
      await this.purgeExtensionProfileData(profile.id);
    }

    console.warn(
      `[ProfileService] Removed ${invalidProfiles.length} invalid profile(s): ${invalidProfiles
        .map((profile) => `${profile.id} [${profile.reason}]`)
        .join('; ')}`
    );
  }

  private async ensureBrowserProfilesLatestSchema(): Promise<void> {
    await this.conn.run(`
      ALTER TABLE browser_profiles ADD COLUMN IF NOT EXISTS engine VARCHAR DEFAULT 'electron'
    `);
    await this.conn.run(`
      ALTER TABLE browser_profiles ADD COLUMN IF NOT EXISTS quota INTEGER DEFAULT 1
    `);
    await this.conn.run(`
      ALTER TABLE browser_profiles ADD COLUMN IF NOT EXISTS idle_timeout_ms INTEGER DEFAULT 300000
    `);
    await this.conn.run(`
      ALTER TABLE browser_profiles ADD COLUMN IF NOT EXISTS lock_timeout_ms INTEGER DEFAULT 300000
    `);
    await this.conn.run(`
      ALTER TABLE browser_profiles ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT FALSE
    `);
    await this.conn.run(`
      ALTER TABLE browser_profiles ADD COLUMN IF NOT EXISTS fingerprint_core JSON
    `);
    await this.conn.run(`
      ALTER TABLE browser_profiles ADD COLUMN IF NOT EXISTS fingerprint_source JSON
    `);

    await this.conn.run(`
      UPDATE browser_profiles
      SET engine = 'electron'
      WHERE COALESCE(TRIM(engine), '') = ''
    `);
    await this.conn.run(`
      UPDATE browser_profiles
      SET quota = 1
      WHERE quota IS NULL OR quota <> 1
    `);
    await this.conn.run(`
      UPDATE browser_profiles
      SET idle_timeout_ms = ${DEFAULT_BROWSER_POOL_CONFIG.defaultIdleTimeoutMs}
      WHERE idle_timeout_ms IS NULL OR idle_timeout_ms < ${BROWSER_POOL_LIMITS.defaultIdleTimeoutMs.min}
    `);
    await this.conn.run(`
      UPDATE browser_profiles
      SET lock_timeout_ms = ${DEFAULT_BROWSER_POOL_CONFIG.defaultLockTimeoutMs}
      WHERE lock_timeout_ms IS NULL OR lock_timeout_ms < ${BROWSER_POOL_LIMITS.defaultLockTimeoutMs.min}
    `);
    await this.conn.run(`
      UPDATE browser_profiles
      SET is_system = FALSE
      WHERE is_system IS NULL
    `);
  }

  private async ensureDefaultProfileExists(): Promise<void> {
    const systemDefaultFingerprint = this.buildSystemDefaultFingerprint();
    const fingerprintJson = JSON.stringify(systemDefaultFingerprint);
    const fingerprintCoreJson = JSON.stringify(extractFingerprintCoreConfig(systemDefaultFingerprint));
    const fingerprintSourceJson = JSON.stringify(systemDefaultFingerprint.source);
    const stmt = await this.conn.prepare(`
      SELECT fingerprint, fingerprint_core, fingerprint_source
      FROM browser_profiles
      WHERE id = ?
      LIMIT 1
    `);
    stmt.bind([DEFAULT_BROWSER_PROFILE.id]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length === 0) {
      const insertStmt = await this.conn.prepare(`
        INSERT INTO browser_profiles (
          id, name, engine, group_id, partition, proxy_config, fingerprint, fingerprint_core, fingerprint_source,
          notes, tags, color, status, quota, idle_timeout_ms, lock_timeout_ms, is_system,
          created_at, updated_at
        ) VALUES (?, ?, 'electron', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `);
      insertStmt.bind([
        DEFAULT_BROWSER_PROFILE.id,
        DEFAULT_BROWSER_PROFILE.name,
        null,
        DEFAULT_BROWSER_PROFILE.partition,
        null,
        fingerprintJson,
        fingerprintCoreJson,
        fingerprintSourceJson,
        DEFAULT_BROWSER_PROFILE.notes,
        JSON.stringify(DEFAULT_BROWSER_PROFILE.tags),
        DEFAULT_BROWSER_PROFILE.color,
        DEFAULT_BROWSER_PROFILE.quota,
        DEFAULT_BROWSER_PROFILE.idleTimeoutMs,
        DEFAULT_BROWSER_PROFILE.lockTimeoutMs,
      ]);
      await insertStmt.run();
      insertStmt.destroySync();
      return;
    }

    let currentFingerprint: any = null;
    try {
      currentFingerprint =
        typeof rows[0]?.fingerprint === 'string'
          ? JSON.parse(rows[0].fingerprint)
          : (rows[0]?.fingerprint ?? null);
    } catch {
      currentFingerprint = null;
    }

    const needsFingerprintRefresh =
      !isCanonicalFingerprintConfig(currentFingerprint) ||
      (process.platform === 'win32' &&
        (!String(currentFingerprint.identity.hardware.userAgent || '').includes('Edg/') ||
          currentFingerprint.identity.hardware.browserFamily !==
            systemDefaultFingerprint.identity.hardware.browserFamily));
    let currentFingerprintCore: any = null;
    try {
      currentFingerprintCore =
        typeof rows[0]?.fingerprint_core === 'string'
          ? JSON.parse(rows[0].fingerprint_core)
          : (rows[0]?.fingerprint_core ?? null);
    } catch {
      currentFingerprintCore = null;
    }
    let currentFingerprintSource: any = null;
    try {
      currentFingerprintSource =
        typeof rows[0]?.fingerprint_source === 'string'
          ? JSON.parse(rows[0].fingerprint_source)
          : (rows[0]?.fingerprint_source ?? null);
    } catch {
      currentFingerprintSource = null;
    }

    const updateFields = [
      `name = ?`,
      `engine = 'electron'`,
      `partition = ?`,
      `notes = ?`,
      `tags = ?`,
      `color = ?`,
      `status = COALESCE(NULLIF(status, ''), 'idle')`,
      `quota = ?`,
      `idle_timeout_ms = ?`,
      `lock_timeout_ms = ?`,
      `is_system = TRUE`,
      `updated_at = CURRENT_TIMESTAMP`,
    ];
    const updateValues: any[] = [
      DEFAULT_BROWSER_PROFILE.name,
      DEFAULT_BROWSER_PROFILE.partition,
      DEFAULT_BROWSER_PROFILE.notes,
      JSON.stringify(DEFAULT_BROWSER_PROFILE.tags),
      DEFAULT_BROWSER_PROFILE.color,
      DEFAULT_BROWSER_PROFILE.quota,
      DEFAULT_BROWSER_PROFILE.idleTimeoutMs,
      DEFAULT_BROWSER_PROFILE.lockTimeoutMs,
    ];
    const needsFingerprintCoreRefresh = !currentFingerprintCore || needsFingerprintRefresh;
    const needsFingerprintSourceRefresh = !currentFingerprintSource || needsFingerprintRefresh;
    if (needsFingerprintCoreRefresh) {
      updateFields.push(`fingerprint_core = ?`);
      updateValues.push(fingerprintCoreJson);
    }
    if (needsFingerprintSourceRefresh) {
      updateFields.push(`fingerprint_source = ?`);
      updateValues.push(fingerprintSourceJson);
    }
    if (needsFingerprintRefresh) {
      updateFields.push(`fingerprint = ?`);
      updateValues.push(fingerprintJson);
    }
    updateValues.push(DEFAULT_BROWSER_PROFILE.id);

    const updateStmt = await this.conn.prepare(`
      UPDATE browser_profiles
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `);
    updateStmt.bind(updateValues);
    await updateStmt.run();
    updateStmt.destroySync();
  }

  /**
   * 初始化表结构
   *
   * 开发阶段以当前 schema 为准，启动时直接收敛到最新表结构
   */
  async initTable(): Promise<void> {
    // 创建分组表
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS profile_groups (
        id              VARCHAR PRIMARY KEY,
        name            VARCHAR NOT NULL,
        parent_id       VARCHAR,
        color           VARCHAR,
        icon            VARCHAR,
        description     TEXT,
        sort_order      INTEGER DEFAULT 0,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建 Profile 表（包含 v2 新字段）
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS browser_profiles (
        id              VARCHAR PRIMARY KEY,
        name            VARCHAR NOT NULL,
        engine          VARCHAR DEFAULT 'electron',
        group_id        VARCHAR,
        partition       VARCHAR NOT NULL UNIQUE,
        proxy_config    JSON,
        fingerprint     JSON NOT NULL,
        fingerprint_core JSON,
        fingerprint_source JSON,
        notes           TEXT,
        tags            JSON DEFAULT '[]',
        color           VARCHAR,
        status          VARCHAR DEFAULT 'idle',
        last_error      TEXT,
        last_active_at  TIMESTAMP,
        total_uses      INTEGER DEFAULT 0,
        quota           INTEGER DEFAULT 1,
        idle_timeout_ms INTEGER DEFAULT 300000,
        lock_timeout_ms INTEGER DEFAULT 300000,
        is_system       BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.ensureBrowserProfilesLatestSchema();
    await this.cleanupInvalidStoredProfiles();

    // 创建索引
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_profile_groups_parent_id
      ON profile_groups(parent_id)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_browser_profiles_group_id
      ON browser_profiles(group_id)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_browser_profiles_status
      ON browser_profiles(status)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_browser_profiles_is_system
      ON browser_profiles(is_system)
    `);

    await this.ensureDefaultProfileExists();

    console.log('[ProfileService] Tables initialized');
  }

  // =====================================================
  // Profile CRUD
  // =====================================================

  /**
   * 创建 Profile
   */
  async create(params: CreateProfileParams): Promise<BrowserProfile> {
    const id = uuidv4();
    const partition = `persist:profile-${id}`;
    const engine = normalizeAutomationEngine(params.engine);
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      profileId: id,
      source: currentTraceContext?.source ?? 'profile-service',
    });

    return await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'profile-service',
        event: 'profile.lifecycle.create',
        attrs: {
          profileId: id,
          name: params.name,
          engine,
          groupId: params.groupId ?? null,
        },
      });

      try {
        // 合并默认指纹配置
        const fingerprint = this.buildFingerprintForPersistence(engine, {
          fingerprintCore: params.fingerprintCore,
          fingerprintSource: params.fingerprintSource,
          overrides: params.fingerprint || {},
        });
        const fingerprintCore = extractFingerprintCoreConfig(fingerprint);
        const fingerprintSource = fingerprint.source;

        this.assertValidFingerprintConfig(fingerprint, engine, `Profile "${params.name}"`);

        const normalizedProxy = this.normalizeProxyConfig(params.proxy);

        const requestedQuota = this.normalizeQuotaValue(params.quota);
        const quotaResolution = normalizeProfileBrowserQuota(requestedQuota);
        const quota = quotaResolution.quota;
        if (quotaResolution.forced) {
          console.warn(
            `[ProfileService] quota for profile "${params.name}" is forced to 1 (received ${requestedQuota})`
          );
        }
        const idleTimeoutMs = this.normalizeIdleTimeoutMs(params.idleTimeoutMs);
        const lockTimeoutMs = this.normalizeLockTimeoutMs(params.lockTimeoutMs);
        const stmt = await this.conn.prepare(`
          INSERT INTO browser_profiles (
            id, name, engine, group_id, partition, proxy_config, fingerprint, fingerprint_core, fingerprint_source,
            notes, tags, color, status, quota, idle_timeout_ms, lock_timeout_ms, is_system,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `);

        stmt.bind([
          id,
          params.name,
          engine,
          params.groupId || null,
          partition,
          normalizedProxy ? JSON.stringify(normalizedProxy) : null,
          JSON.stringify(fingerprint),
          JSON.stringify(fingerprintCore),
          JSON.stringify(fingerprintSource),
          params.notes || null,
          JSON.stringify(params.tags || []),
          params.color || null,
          quota,
          idleTimeoutMs,
          lockTimeoutMs,
        ]);

        await stmt.run();
        stmt.destroySync();

        console.log(`[ProfileService] Created profile: ${params.name} (${id})`);
        const created = await this.get(id);
        await span.succeed({
          attrs: {
            profileId: id,
            engine,
            groupId: params.groupId ?? null,
          },
        });

        return created as BrowserProfile;
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'profile-service',
          label: 'profile create failure context',
          data: {
            profileId: id,
            name: params.name,
            engine,
            groupId: params.groupId ?? null,
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            profileId: id,
            name: params.name,
            engine,
          },
        });
        throw error;
      }
    });
  }

  /**
   * 获取单个 Profile
   */
  async get(id: string): Promise<BrowserProfile | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        id, name, engine, group_id, partition, proxy_config, fingerprint, fingerprint_core, fingerprint_source,
        notes, tags, color, status, last_error, last_active_at,
        total_uses, quota, idle_timeout_ms, lock_timeout_ms, is_system,
        created_at, updated_at
      FROM browser_profiles
      WHERE id = ?
    `);

    try {
      stmt.bind([id]);
      const result = await stmt.runAndReadAll();
      const rows = parseRows(result);
      if (rows.length === 0) return null;
      return this.mapRowToProfile(rows[0]);
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * 获取默认浏览器 Profile
   */
  async getDefault(): Promise<BrowserProfile | null> {
    return this.get(DEFAULT_BROWSER_PROFILE.id);
  }

  /**
   * 列出 Profile
   */
  async list(params?: ProfileListParams): Promise<BrowserProfile[]> {
    let sql = `
      SELECT
        id, name, engine, group_id, partition, proxy_config, fingerprint, fingerprint_core, fingerprint_source,
        notes, tags, color, status, last_error, last_active_at,
        total_uses, quota, idle_timeout_ms, lock_timeout_ms, is_system,
        created_at, updated_at
      FROM browser_profiles
      WHERE 1=1
    `;

    const bindValues: any[] = [];

    // 过滤条件
    if (params?.filter) {
      const { groupId, groupIds, status, tags, keyword } = params.filter;

      if (groupIds && groupIds.length > 0) {
        const placeholders = groupIds.map(() => '?').join(', ');
        sql += ` AND group_id IN (${placeholders})`;
        bindValues.push(...groupIds);
      } else if (groupId !== undefined) {
        if (groupId === null) {
          sql += ` AND group_id IS NULL`;
        } else {
          sql += ` AND group_id = ?`;
          bindValues.push(groupId);
        }
      }

      if (status) {
        sql += ` AND status = ?`;
        bindValues.push(status);
      }

      if (keyword) {
        sql += ` AND (name LIKE ? OR notes LIKE ?)`;
        bindValues.push(`%${keyword}%`, `%${keyword}%`);
      }

      // tags 过滤需要特殊处理（JSON 数组）
      if (tags && tags.length > 0) {
        // DuckDB JSON 查询
        const tagConditions = tags.map(() => `list_contains(tags::VARCHAR[], ?)`).join(' OR ');
        sql += ` AND (${tagConditions})`;
        bindValues.push(...tags);
      }
    }

    // 排序
    const sortField = params?.sortBy || 'createdAt';
    const sortOrder = params?.sortOrder || 'desc';
    const fieldMap: Record<string, string> = {
      name: 'name',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      lastActiveAt: 'last_active_at',
      totalUses: 'total_uses',
    };
    sql += ` ORDER BY ${fieldMap[sortField] || 'created_at'} ${sortOrder.toUpperCase()}`;

    // 分页
    if (params?.limit) {
      sql += ` LIMIT ?`;
      bindValues.push(params.limit);
    }

    if (params?.offset) {
      sql += ` OFFSET ?`;
      bindValues.push(params.offset);
    }

    // 如果没有占位符，直接执行（避免无意义的 prepare，且可规避部分并发场景下的 prepared statement 执行异常）
    if (bindValues.length === 0) {
      const result = await this.conn.runAndReadAll(sql);
      const rows = parseRows(result);
      return rows.map((row) => this.mapRowToProfile(row));
    }

    const stmt = await this.conn.prepare(sql);
    try {
      stmt.bind(bindValues);
      const result = await stmt.runAndReadAll();
      const rows = parseRows(result);
      return rows.map((row) => this.mapRowToProfile(row));
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * 更新 Profile
   */
  async update(id: string, params: UpdateProfileParams): Promise<BrowserProfile> {
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      profileId: id,
      source: currentTraceContext?.source ?? 'profile-service',
    });
    const changedFields = Object.keys(params).filter(
      (key) => (params as Record<string, unknown>)[key] !== undefined
    );
    const runtimeResetExpected =
      params.fingerprint !== undefined ||
      params.fingerprintCore !== undefined ||
      params.fingerprintSource !== undefined ||
      params.engine !== undefined ||
      params.proxy !== undefined ||
      params.quota !== undefined ||
      params.idleTimeoutMs !== undefined ||
      params.lockTimeoutMs !== undefined;

    return await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'profile-service',
        event: 'profile.lifecycle.update',
        attrs: {
          profileId: id,
          changedFields,
          runtimeResetExpected,
        },
      });

      try {
        const existingProfile = await this.get(id);
        if (!existingProfile) {
          throw new Error(`Profile not found: ${id}`);
        }

        const targetEngine: AutomationEngine =
          params.engine !== undefined
            ? normalizeAutomationEngine(params.engine)
            : existingProfile.engine;
        const shouldClearExtensionBindings = targetEngine !== 'extension';

        const fields: string[] = [];
        const values: any[] = [];

        if (params.name !== undefined) {
          fields.push('name = ?');
          values.push(params.name);
        }

        if (params.engine !== undefined) {
          fields.push('engine = ?');
          values.push(targetEngine);
        }

        if (params.groupId !== undefined) {
          fields.push('group_id = ?');
          values.push(params.groupId);
        }

        if (params.proxy !== undefined) {
          const normalizedProxy = this.normalizeProxyConfig(params.proxy);
          fields.push('proxy_config = ?');
          values.push(normalizedProxy ? JSON.stringify(normalizedProxy) : null);
        }

        const shouldRecomputeFingerprint =
          params.fingerprint !== undefined ||
          params.fingerprintCore !== undefined ||
          params.fingerprintSource !== undefined ||
          params.engine !== undefined;
        const nextFingerprint = shouldRecomputeFingerprint
          ? this.buildFingerprintForPersistence(targetEngine, {
              fingerprintCore: params.fingerprintCore,
              fingerprintSource: params.fingerprintSource,
              baseFingerprint:
                targetEngine === existingProfile.engine ? existingProfile.fingerprint : undefined,
              fallbackSharedFingerprint:
                targetEngine === existingProfile.engine ? undefined : existingProfile.fingerprint,
              overrides: params.fingerprint,
            })
          : existingProfile.fingerprint;
        const nextFingerprintCore = extractFingerprintCoreConfig(nextFingerprint);
        const nextFingerprintSource = nextFingerprint.source;

        if (shouldRecomputeFingerprint) {
          this.assertValidFingerprintConfig(nextFingerprint, targetEngine, `Profile "${id}"`);
        }

        if (shouldRecomputeFingerprint) {
          fields.push('fingerprint = ?');
          values.push(JSON.stringify(nextFingerprint));
          fields.push('fingerprint_core = ?');
          values.push(JSON.stringify(nextFingerprintCore));
          fields.push('fingerprint_source = ?');
          values.push(JSON.stringify(nextFingerprintSource));
        }

        if (params.notes !== undefined) {
          fields.push('notes = ?');
          values.push(params.notes);
        }

        if (params.tags !== undefined) {
          fields.push('tags = ?');
          values.push(JSON.stringify(params.tags));
        }

        if (params.color !== undefined) {
          fields.push('color = ?');
          values.push(params.color);
        }

        const normalizedQuota = this.normalizeQuotaValue(params.quota);
        const quotaResolution = normalizeProfileBrowserQuota(normalizedQuota);
        const currentQuotaResolution = normalizeProfileBrowserQuota(existingProfile.quota);
        const shouldPersistNormalizedQuota =
          params.quota !== undefined || quotaResolution.quota !== currentQuotaResolution.quota;
        if (shouldPersistNormalizedQuota) {
          if (params.quota !== undefined && quotaResolution.forced) {
            console.warn(
              `[ProfileService] quota for profile ${id} is forced to 1 (received ${params.quota})`
            );
          }
          fields.push('quota = ?');
          values.push(quotaResolution.quota);
        }

        if (params.idleTimeoutMs !== undefined) {
          fields.push('idle_timeout_ms = ?');
          values.push(this.normalizeIdleTimeoutMs(params.idleTimeoutMs));
        }

        if (params.lockTimeoutMs !== undefined) {
          fields.push('lock_timeout_ms = ?');
          values.push(this.normalizeLockTimeoutMs(params.lockTimeoutMs));
        }

        if (fields.length === 0) {
          await span.succeed({
            attrs: {
              profileId: id,
              changedFields,
              runtimeResetExpected,
              skippedWrite: true,
            },
          });
          return existingProfile;
        }

        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);

        const stmt = await this.conn.prepare(
          `UPDATE browser_profiles SET ${fields.join(', ')} WHERE id = ?`
        );
        stmt.bind(values);
        await stmt.run();
        stmt.destroySync();

        if (shouldClearExtensionBindings) {
          const clearBindingsStmt = await this.conn.prepare(`
            DELETE FROM profile_extensions
            WHERE profile_id = ?
          `);
          clearBindingsStmt.bind([id]);
          await clearBindingsStmt.run();
          clearBindingsStmt.destroySync();
        }

        console.log(`[ProfileService] Updated profile: ${id}`);
        const updated = await this.get(id);
        await span.succeed({
          attrs: {
            profileId: id,
            changedFields,
            runtimeResetExpected,
          },
        });

        return updated as BrowserProfile;
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'profile-service',
          label: 'profile update failure context',
          data: {
            profileId: id,
            changedFields,
            runtimeResetExpected,
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            profileId: id,
            changedFields,
            runtimeResetExpected,
          },
        });
        throw error;
      }
    });
  }

  /**
   * 删除 Profile
   */
  async delete(id: string): Promise<void> {
    // 检查是否存在
    const profile = await this.get(id);
    if (!profile) {
      throw new Error(`Profile not found: ${id}`);
    }

    // 系统内置 Profile 不可删除
    if (profile.isSystem) {
      throw new Error('系统内置的浏览器配置不可删除');
    }

    if (profile.status === 'active') {
      throw new Error('无法删除正在使用的浏览器配置');
    }

    // 删除 Profile
    const stmtDeleteBindings = await this.conn.prepare(`
      DELETE FROM profile_extensions WHERE profile_id = ?
    `);
    stmtDeleteBindings.bind([id]);
    await stmtDeleteBindings.run();
    stmtDeleteBindings.destroySync();

    const stmtDeleteProfile = await this.conn.prepare(`DELETE FROM browser_profiles WHERE id = ?`);
    stmtDeleteProfile.bind([id]);
    await stmtDeleteProfile.run();
    stmtDeleteProfile.destroySync();

    // 删除 Profile 通常意味着用户希望同时删除本地会话数据
    await this.purgePartitionData(profile.partition);
    await this.purgeExtensionProfileData(id);

    console.log(`[ProfileService] Deleted profile: ${id}`);
  }

  /**
   * 事务性删除 Profile（保留账号数据并解除账号环境绑定）
   *
   * v2 架构：使用数据库事务确保原子性
   * - 如果任何步骤失败，所有更改都会回滚
   * - 先验证再操作，避免事务中的异常
   */
  async deleteWithCascade(id: string): Promise<void> {
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      profileId: id,
      source: currentTraceContext?.source ?? 'profile-service',
    });

    await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'profile-service',
        event: 'profile.lifecycle.delete',
        attrs: {
          profileId: id,
        },
      });

      try {
        // 1. 验证（在事务外执行，失败时不需要回滚）
        const profile = await this.get(id);
        if (!profile) {
          throw new Error(`Profile not found: ${id}`);
        }

        if (profile.isSystem) {
          throw new Error('系统内置的浏览器配置不可删除');
        }

        if (profile.status === 'active') {
          throw new Error('无法删除正在使用的浏览器配置');
        }

        // 2. 事务性删除
        try {
          await this.conn.run('BEGIN TRANSACTION');

          // 删除环境前，先把关联账号统一标记为未绑定
          const stmtMarkAccountsUnbound = await this.conn.prepare(`
            UPDATE accounts
            SET profile_id = ?
            WHERE profile_id = ?
          `);
          stmtMarkAccountsUnbound.bind([UNBOUND_PROFILE_ID, id]);
          await stmtMarkAccountsUnbound.run();
          stmtMarkAccountsUnbound.destroySync();

          // 再删除 profile 本身
          const stmtDeleteBindings = await this.conn.prepare(`
            DELETE FROM profile_extensions WHERE profile_id = ?
          `);
          stmtDeleteBindings.bind([id]);
          await stmtDeleteBindings.run();
          stmtDeleteBindings.destroySync();

          const stmtProfile = await this.conn.prepare(`DELETE FROM browser_profiles WHERE id = ?`);
          stmtProfile.bind([id]);
          await stmtProfile.run();
          stmtProfile.destroySync();

          await this.conn.run('COMMIT');
          console.log(
            `[ProfileService] Deleted profile and marked linked accounts as unbound: ${id}`
          );
        } catch (error) {
          await this.conn.run('ROLLBACK');
          console.error(`[ProfileService] Failed to delete profile ${id}, rolled back:`, error);
          throw error;
        }

        // 事务提交后再清理 partition 数据，避免因为清理失败导致数据库回滚
        await this.purgePartitionData(profile.partition);
        await this.purgeExtensionProfileData(id);

        await span.succeed({
          attrs: {
            profileId: id,
          },
        });
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'profile-service',
          label: 'profile delete failure context',
          data: {
            profileId: id,
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            profileId: id,
          },
        });
        throw error;
      }
    });
  }

  // =====================================================
  // 状态管理
  // =====================================================

  /**
   * 更新状态
   */
  async updateStatus(id: string, status: ProfileStatus, error?: string): Promise<void> {
    const stmt = await this.conn.prepare(`
      UPDATE browser_profiles
      SET status = ?, last_error = ?, last_active_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    try {
      stmt.bind([status, error || null, id]);
      await stmt.run();
    } finally {
      stmt.destroySync();
    }

    console.log(`[ProfileService] Updated status: ${id} -> ${status}`);
  }

  /**
   * 增加使用次数
   */
  async incrementUsage(id: string): Promise<void> {
    const stmt = await this.conn.prepare(`
      UPDATE browser_profiles
      SET total_uses = total_uses + 1, last_active_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    try {
      stmt.bind([id]);
      await stmt.run();
    } finally {
      stmt.destroySync();
    }
  }

  /**
   * 检查是否可用
   */
  async isAvailable(id: string): Promise<boolean> {
    const profile = await this.get(id);
    return profile !== null && profile.status === 'idle';
  }

  /**
   * 重置所有 active 状态为 idle
   *
   * 用于应用启动时同步状态，解决以下问题：
   * - 应用崩溃后 Profile 状态可能仍为 active
   * - 内存中没有对应的浏览器实例
   *
   * @returns 重置的数量
   */
  async resetAllActiveStatus(): Promise<number> {
    const result = await this.conn.runAndReadAll(`
      UPDATE browser_profiles
      SET status = 'idle', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'active'
      RETURNING id
    `);

    const rows = parseRows(result);
    const count = rows.length;

    if (count > 0) {
      console.log(`[ProfileService] Reset ${count} profile(s) from 'active' to 'idle' on startup`);
    }

    return count;
  }

  // =====================================================
  // 统计
  // =====================================================

  /**
   * 获取统计信息
   */
  async getStats(): Promise<{
    total: number;
    idle: number;
    active: number;
    error: number;
  }> {
    const result = await this.conn.runAndReadAll(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'idle' THEN 1 ELSE 0 END) as idle,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
      FROM browser_profiles
    `);

    const rows = parseRows(result);
    if (rows.length === 0) {
      return { total: 0, idle: 0, active: 0, error: 0 };
    }

    const row = rows[0] as any;
    return {
      total: Number(row.total) || 0,
      idle: Number(row.idle) || 0,
      active: Number(row.active) || 0,
      error: Number(row.error) || 0,
    };
  }

  // =====================================================
  // 辅助方法
  // =====================================================

  /**
   * 将数据库行映射为 BrowserProfile
   */
  private mapRowToProfile(row: any): BrowserProfile {
    const engine = normalizeAutomationEngine(row.engine);
    const fingerprint = materializeFingerprintConfigForEngine(
      this.parseJSON<FingerprintConfig>(row.fingerprint),
      engine
    );
    const fingerprintCore =
      this.parseJSON<FingerprintCoreConfig | null>(row.fingerprint_core) ||
      extractFingerprintCoreConfig(fingerprint);
    const fingerprintSource =
      this.parseJSON<FingerprintSourceConfig | null>(row.fingerprint_source) || fingerprint.source;

    return {
      id: String(row.id),
      name: String(row.name),
      engine,
      groupId: row.group_id ? String(row.group_id) : null,
      partition: String(row.partition),
      proxy: row.proxy_config ? this.parseJSON<ProxyConfig>(row.proxy_config) : null,
      fingerprint,
      fingerprintCore,
      fingerprintSource,
      notes: row.notes ? String(row.notes) : null,
      tags: this.parseJSON<string[]>(row.tags) || [],
      color: row.color ? String(row.color) : null,
      status: (row.status as ProfileStatus) || 'idle',
      lastError: row.last_error ? String(row.last_error) : null,
      lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
      totalUses: Number(row.total_uses) || 0,
      quota: Number(row.quota) || 1,
      idleTimeoutMs:
        Number(row.idle_timeout_ms) || DEFAULT_BROWSER_POOL_CONFIG.defaultIdleTimeoutMs,
      lockTimeoutMs:
        Number(row.lock_timeout_ms) || DEFAULT_BROWSER_POOL_CONFIG.defaultLockTimeoutMs,
      isSystem: row.is_system === true || row.is_system === 1,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * 安全解析 JSON
   */
  private parseJSON<T>(value: any): T {
    if (!value) return value;
    if (typeof value === 'object') return value as T;
    try {
      return JSON.parse(String(value));
    } catch {
      return value as T;
    }
  }
}
