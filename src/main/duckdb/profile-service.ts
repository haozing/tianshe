/**
 * ProfileService - 婵炴潙绻楅～宥夊闯閵娾晛甯崇紓鍐惧枤椤撴悂鎮堕崱妯荤疀闁? *
 * v2 闁哄鍩栭悗顖炲冀缁嬭法濡囬柡鍫濈Т婵喖鏁嶅畝鍐槹閻?BrowserProfile 闁?CRUD 闁瑰灝绉崇紞?
 *
 * 閻犱焦宕橀鎼佸储閻斿嘲鐏熼柨? * - 妤犵偛鍟胯ぐ鎾箵閹邦亞杩旈柤瀹犳婵繘鏁嶇仦鎯х祷濞寸姾娉涢崰鍛偓瑙勮壘椤┭勬媴閺囨艾鈻忛柣? * - 濞戞挸绉村閬嶅礆閸撲胶鎷ㄩ悗瑙勮壘閸櫻呭寲娴兼瑧绀夐柣銏ｉ哺瑜板啯绂掗幆鏉挎鐎规瓕浜鎼佹偠? */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows, runInDuckDbTransaction } from './utils';
import { allPrepared, runPrepared } from './statement-executor';
import { v4 as uuidv4 } from 'uuid';
import type {
  BrowserProfile,
  ProfileListParams,
  CreateProfileParams,
  UpdateProfileParams,
  ProxyConfig,
  FingerprintConfig,
  ProfileStatus,
  AutomationEngine,
} from '../../types/profile';
import {
  UNBOUND_PROFILE_ID,
  normalizeProfileBrowserQuota,
  normalizeAutomationEngine,
} from '../../types/profile';
import {
  DEFAULT_BROWSER_PROFILE,
  DEFAULT_BROWSER_POOL_CONFIG,
  BROWSER_POOL_LIMITS,
} from '../../constants/browser-pool';
import { extractFingerprintCoreConfig } from '../../constants/fingerprint-defaults';
import { observationService } from '../../core/observability/observation-service';
import { attachErrorContextArtifact } from '../../core/observability/error-context-artifact';
import {
  createChildTraceContext,
  getCurrentTraceContext,
  withTraceContext,
} from '../../core/observability/observation-context';
import { createLogger } from '../../core/logger';
import {
  ProfileFingerprintPersistence,
  type BuildFingerprintForPersistenceOptions,
} from './profile-fingerprint-persistence';
import { ProfilePartitionCleanupService } from './profile-partition-cleanup-service';
import { ProfileSchemaBootstrap } from './profile-schema-bootstrap';
import { mapProfileRowToProfile } from './profile-row-mapper';

const ALLOWED_PROXY_TYPES: Array<Exclude<ProxyConfig['type'], 'none'>> = [
  'http',
  'https',
  'socks4',
  'socks5',
];
const logger = createLogger('ProfileService');

/**
 * Profile 闁哄牆绉存慨?
 */
export class ProfileService {
  private readonly fingerprintPersistence: ProfileFingerprintPersistence;
  private readonly partitionCleanupService: ProfilePartitionCleanupService;
  private readonly schemaBootstrap: ProfileSchemaBootstrap;

  constructor(private conn: DuckDBConnection) {
    this.fingerprintPersistence = new ProfileFingerprintPersistence();
    this.partitionCleanupService = new ProfilePartitionCleanupService();
    this.schemaBootstrap = new ProfileSchemaBootstrap(
      conn,
      this.fingerprintPersistence,
      this.partitionCleanupService
    );
  }

  async sweepDeferredPartitionCleanup(): Promise<void> {
    await this.partitionCleanupService.sweepDeferredPartitionCleanup();
  }

  private buildSystemDefaultFingerprint(): FingerprintConfig {
    return this.fingerprintPersistence.buildSystemDefaultFingerprint();
  }

  private buildFingerprintForPersistence(
    engine: AutomationEngine,
    options: BuildFingerprintForPersistenceOptions = {}
  ): FingerprintConfig {
    return this.fingerprintPersistence.buildFingerprintForPersistence(engine, options);
  }

  private assertValidFingerprintConfig(
    fingerprint: FingerprintConfig,
    engine: AutomationEngine,
    label: string
  ): void {
    this.fingerprintPersistence.assertValidFingerprintConfig(fingerprint, engine, label);
  }

  private async purgePartitionData(partition: string): Promise<void> {
    await this.partitionCleanupService.purgePartitionData(partition);
  }

  private async purgeExtensionProfileData(profileId: string): Promise<void> {
    await this.partitionCleanupService.purgeExtensionProfileData(profileId);
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

  /**
   * 闁告帗绻傞～鎰板礌閺嶎兙鈧啰绱掗幘瀵糕偓?
   *
   * 鐎殿喒鍋撻柛娆愬灴濡礁鈻撻崗闀愮鞍鐟滅増鎸告晶?schema 濞戞挸鎼崳顖炴晬鐏炶姤鍎欓柛鏂诲妽濡炲倿鎯勭€涙ê澶嶉柡鈧懜鍨異闁告帞澧楀〒鍫曞棘閹峰被鈧啰绱掗幘瀵糕偓?
   */
  async initTable(): Promise<void> {
    await this.schemaBootstrap.initTable();
  }

  // =====================================================
  // Profile CRUD
  // =====================================================

  /**
   * 闁告帗绋戠紓?Profile
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
        // 闁告艾鐗嗛懟鐔割渶濡鍚囬柟绋挎川濮规鏌婂鍥╂瀭
        const fingerprint = this.buildFingerprintForPersistence(engine, {
          fingerprintCore: params.fingerprintCore,
          fingerprintSource: params.fingerprintSource,
          overrides: params.fingerprint || {},
        });
        const fingerprintCore = extractFingerprintCoreConfig(fingerprint);
        const fingerprintSource = fingerprint.source;

        this.assertValidFingerprintConfig(
          fingerprint,
          engine,
          `Profile "${params.name}"`
        );

        const normalizedProxy = this.normalizeProxyConfig(params.proxy);

        const requestedQuota = this.normalizeQuotaValue(params.quota);
        const quotaResolution = normalizeProfileBrowserQuota(requestedQuota);
        const quota = quotaResolution.quota;
        if (quotaResolution.forced) {
          logger.warn('Profile quota forced to 1', {
            profileId: id,
            profileName: params.name,
            requestedQuota,
          });
        }
        const idleTimeoutMs = this.normalizeIdleTimeoutMs(params.idleTimeoutMs);
        const lockTimeoutMs = this.normalizeLockTimeoutMs(params.lockTimeoutMs);
        await runPrepared(
          this.conn,
          `
          INSERT INTO browser_profiles (
            id, name, engine, group_id, partition, proxy_config, fingerprint, fingerprint_core, fingerprint_source,
            notes, tags, color, status, quota, idle_timeout_ms, lock_timeout_ms, is_system,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
          [
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
          ]
        );

        logger.info('Created profile', {
          profileId: id,
          profileName: params.name,
        });
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
   * 闁兼儳鍢茶ぐ鍥础閺囨岸鍤?Profile
   */
  async get(id: string): Promise<BrowserProfile | null> {
    const result = await allPrepared(
      this.conn,
      `
      SELECT
        id, name, engine, group_id, partition, proxy_config, fingerprint, fingerprint_core, fingerprint_source,
        notes, tags, color, status, last_error, last_active_at,
        total_uses, quota, idle_timeout_ms, lock_timeout_ms, is_system,
        created_at, updated_at
      FROM browser_profiles
      WHERE id = ?
    `,
      [id]
    );

    const rows = parseRows(result);
    if (rows.length === 0) return null;
    return mapProfileRowToProfile(rows[0]);
  }

  /**
   * 闁兼儳鍢茶ぐ鍥渶濡鍚囨繛鏉戠箺椤秹宕?Profile
   */
  async getDefault(): Promise<BrowserProfile | null> {
    return this.get(DEFAULT_BROWSER_PROFILE.id);
  }

  /**
   * 闁告帗顨呴崵?Profile
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

    // 閺夆晛娲﹂幎銈夊级閳ュ弶顐?
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

      // tags filter uses DuckDB JSON array matching.
      if (tags && tags.length > 0) {
        // DuckDB JSON 闁哄被鍎撮?
        const tagConditions = tags.map(() => `list_contains(tags::VARCHAR[], ?)`).join(' OR ');
        sql += ` AND (${tagConditions})`;
        bindValues.push(...tags);
      }
    }

    // 闁圭儤甯掔花?
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

    // 闁告帒妫濋妴?
    if (params?.limit) {
      sql += ` LIMIT ?`;
      bindValues.push(params.limit);
    }

    if (params?.offset) {
      sql += ` OFFSET ?`;
      bindValues.push(params.offset);
    }

    // Avoid prepare overhead when there are no placeholders.
    if (bindValues.length === 0) {
      const result = await this.conn.runAndReadAll(sql);
      const rows = parseRows(result);
      return rows.map((row) => mapProfileRowToProfile(row));
    }

    const result = await allPrepared(this.conn, sql, bindValues);
    const rows = parseRows(result);
    return rows.map((row) => mapProfileRowToProfile(row));
  }

  /**
   * 闁哄洤鐡ㄩ弻?Profile
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
          this.assertValidFingerprintConfig(
            nextFingerprint,
            targetEngine,
            `Profile "${id}"`
          );
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
            logger.warn('Profile quota forced to 1', {
              profileId: id,
              requestedQuota: params.quota,
            });
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

        await runPrepared(
          this.conn,
          `UPDATE browser_profiles SET ${fields.join(', ')} WHERE id = ?`,
          values
        );

        if (shouldClearExtensionBindings) {
          await runPrepared(
            this.conn,
            `
            DELETE FROM profile_extensions
            WHERE profile_id = ?
          `,
            [id]
          );
        }

        logger.info('Updated profile', { profileId: id });
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
   * 闁告帞濞€濞?Profile
   */
  async delete(id: string): Promise<void> {
    const profile = await this.get(id);
    if (!profile) {
      throw new Error(`Profile not found: ${id}`);
    }

    // 缂侇垵宕电划娲礃閸涱垳鏋?Profile 濞戞挸绉磋ぐ鏌ュ礆閻樼粯鐝?
    if (profile.isSystem) {
      throw new Error('System browser profiles cannot be deleted');
    }

    if (profile.status === 'active') {
      throw new Error('Cannot delete an active browser profile');
    }

    // 闁告帞濞€濞?Profile
    await runPrepared(
      this.conn,
      `
      DELETE FROM profile_extensions WHERE profile_id = ?
    `,
      [id]
    );

    await runPrepared(this.conn, `DELETE FROM browser_profiles WHERE id = ?`, [id]);

    // 闁告帞濞€濞?Profile 闂侇偅鑹鹃悥鍫曞箛韫囨挻鍤勯柣顐熷亾闁活潿鍔嶉崺娑氭暜鐏炵偓绠块柛姘湰濡炲倿宕氶悩缁樼彑闁哄牜鍓欏﹢瀛樺濮樺磭妯堥柡浣哄瀹?
    await this.purgePartitionData(profile.partition);
    await this.purgeExtensionProfileData(id);

    logger.info('Deleted profile', { profileId: id });
  }

  /**
   * 濞存粌顑呮慨鐔煎箑瑜嶉崹褰掓⒔?Profile闁挎稑鐗呯换姘舵偩濞嗘帒顦╅柛娆撴敱閺嗙喖骞戦鑹板珯閻熸瑱缍佸▍搴ｆ嫻閿曗偓瑜板潡鎮抽姘兼殧缂備焦鍨甸悾楣冩晬?   *
   * v2 闁哄鍩栭悗顖炴晬濮橆偄鈻忛柣顫妽閺嗙喖骞戦鑲╂皑濞存粌顑呮慨鐔烘兜椤旇崵绠介柛妯煎枎閻℃瑩骞€?   * - 濠碘€冲€归悘澶嬬鐠佸磭绉挎慨婵勫劦椤庡啯寰勬潏顐バ曢柨娑樻湰婢у秹寮垫径瀣函闁衡偓瑜版帒鍘村ù鍏艰壘濞叉牕顭?   * - 闁稿繐鐗撻悰娆戞嫚娴ｇ鏅欓柟鍨С缂嶆棃鏁嶅畝鍕級闁稿繐绉崇花銊╁礉閳ヨ尪鍘柣銊ュ缁辨挾鏁?   */
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
        // 1. 濡ょ姴鐭侀惁澶愭晬閸繃韬ù婊冾儏婵喐寰勯弽銊モ挃閻炴稑鐭夌槐婵囧緞鏉堫偉袝闁哄啯婀圭粭澶愭閳ь剛鎲版担鍛婄婵犲﹥鐔槐?
    const profile = await this.get(id);
        if (!profile) {
          throw new Error(`Profile not found: ${id}`);
        }

        if (profile.isSystem) {
          throw new Error('System browser profiles cannot be deleted');
        }

        if (profile.status === 'active') {
          throw new Error('Cannot delete an active browser profile');
        }

        try {
          await runInDuckDbTransaction(this.conn, async () => {
            // 闁告帞濞€濞呭酣鎮抽姘兼殧闁告挸绋勭槐婵嬪礂閸喎惟闁稿繐鐤囨禒鍫㈡嫻閿曗偓瑜拌法绱掗悢鍓侇伇闁哄秴娲╅鍥ㄧ▔閻戞ɑ寮撶紓浣瑰灥閻?
            await runPrepared(
              this.conn,
              `
            UPDATE accounts
            SET profile_id = ?
            WHERE profile_id = ?
          `,
              [UNBOUND_PROFILE_ID, id]
            );

            // 闁告劕绉撮崹褰掓⒔?profile 闁哄牜鍓濋棅?
            await runPrepared(
              this.conn,
              `
            DELETE FROM profile_extensions WHERE profile_id = ?
          `,
              [id]
            );

            await runPrepared(this.conn, `DELETE FROM browser_profiles WHERE id = ?`, [id]);
          });
          logger.info('Deleted profile and marked linked accounts as unbound', {
            profileId: id,
          });
        } catch (error) {
          logger.error(`Failed to delete profile ${id}, rolled back`, error);
          throw error;
        }

        // 濞存粌顑呮慨鐔煎箵閹邦亝鍞夐柛姘閸熲偓婵炴挸鎳愰幃?partition 闁轰胶澧楀畵渚€鏁嶅畝鍕級闁稿繐绉村ú婊勭▔閻戞顏搁柣鐐叉閵囨垹鎷归妷銉殼闁煎嘲鐡ㄩ弳鐔煎箲椤旇偐姘ㄩ柛銉у仦缁?
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
  // 闁绘鍩栭埀顑胯兌椤撴悂鎮?  // =====================================================

  /**
   * 闁哄洤鐡ㄩ弻濠囨偐閼哥鍋?   */
  async updateStatus(id: string, status: ProfileStatus, error?: string): Promise<void> {
    await runPrepared(
      this.conn,
      `
      UPDATE browser_profiles
      SET status = ?, last_error = ?, last_active_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [status, error || null, id]
    );

    logger.info('Updated profile status', {
      profileId: id,
      status,
    });
  }

  /**
   * 濠⒀呭仜婵偞鎷呯捄銊︽殢婵炲棌鍓濋弳?
   */
  async incrementUsage(id: string): Promise<void> {
    await runPrepared(
      this.conn,
      `
      UPDATE browser_profiles
      SET total_uses = total_uses + 1, last_active_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [id]
    );
  }

  /**
   * 婵☆偀鍋撻柡灞诲劜濡叉悂宕ラ敃鈧ぐ鏌ユ偨?   */
  async isAvailable(id: string): Promise<boolean> {
    const profile = await this.get(id);
    return profile !== null && profile.status === 'idle';
  }

  /**
   * 闂佹彃绉堕悿鍡涘箥閳ь剟寮?active 闁绘鍩栭埀顑挎鐠?idle
   *
   * 闁活潿鍔嬬花顒佹償閺冨倹鏆忛柛姘煎灠婵晠寮捄鐑樺€辨慨婵勫劤婵悂骞€娓氬﹦绀夐悷娆欑到閸犲懏绂掗妷銈囩憮闂傚偆鍣ｉ。浠嬫晬?   * - 閹煎瓨姊婚弫銈呯暦閳哄倻鐨鹃柛?Profile 闁绘鍩栭埀顑跨瑜版煡鎳楅幋鎺旂煗濞?active
   * - 闁告劕鎳庨悺銊︾▔椤撶喓姊鹃柡鍫濐槸椤曨喗鎯旈弮鍌涚暠婵炴潙绻楅～宥夊闯閵娿儳鏉藉〒?   *
   * @returns 闂佹彃绉堕悿鍡涙儍閸曨剚娈堕梺?   */
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
      logger.info('Reset active profiles to idle on startup', { count });
    }

    return count;
  }

  // =====================================================
  // 缂備胶鍠曢?
  // =====================================================

  /**
   * 闁兼儳鍢茶ぐ鍥╃磼閻旀椿鍚€濞ｅ洠鍓濇导?
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

}
