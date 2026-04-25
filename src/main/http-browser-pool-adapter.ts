import type { BrowserHandle, BrowserPoolManager } from '../core/browser-pool';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
  takeoverProfileLiveSessionLease,
} from '../core/browser-pool/profile-live-session-lease';
import { DEFAULT_BROWSER_PROFILE } from '../constants/browser-pool';
import { ResourceAcquireTimeoutError } from '../core/resource-coordinator';
import type { AutomationEngine, PooledBrowser } from '../core/browser-pool/types';
import type { RuntimeMetricsSnapshot } from './http-session-manager';

interface LoggerLike {
  debug(message: string, ...args: unknown[]): void;
}

interface AcquireBrowserFromPoolOptions {
  getBrowserPoolManager?: () => BrowserPoolManager;
  runtimeMetrics: RuntimeMetricsSnapshot;
  logger: LoggerLike;
  profileId?: string;
  engine?: AutomationEngine;
  source?: 'mcp' | 'http';
  timeoutMs?: number;
}

type TakeoverCapablePoolManager = BrowserPoolManager & {
  takeoverLockedBrowser?: (
    profileId: string | undefined,
    options?: {
      strategy?: 'any' | 'reuse' | 'fresh' | 'specific';
      timeout?: number;
      priority?: 'high' | 'normal' | 'low';
      engine?: AutomationEngine;
      browserId?: string;
      requireViewId?: boolean;
    },
    source?: 'mcp' | 'http'
  ) => Promise<BrowserHandle | null>;
};

export interface BrowserAcquireReadinessBrowserInfo {
  browserId: string;
  status: string;
  engine: AutomationEngine | null;
  source: string | null;
  pluginId: string | null;
  requestId: string | null;
  viewId: string | null;
}

export interface BrowserAcquireReadiness {
  profileId: string;
  browserCount: number;
  lockedBrowserCount: number;
  creatingBrowserCount: number;
  idleBrowserCount: number;
  destroyingBrowserCount: number;
  busy: boolean;
  browsers: BrowserAcquireReadinessBrowserInfo[];
}

export class BrowserAcquireTimeoutDiagnosticsError extends Error {
  readonly stage: 'profile_lease' | 'pool_acquire';
  readonly diagnostics: BrowserAcquireReadiness;

  constructor(
    message: string,
    options: {
      stage: 'profile_lease' | 'pool_acquire';
      diagnostics: BrowserAcquireReadiness;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = 'BrowserAcquireTimeoutDiagnosticsError';
    this.stage = options.stage;
    this.diagnostics = options.diagnostics;
    if ('cause' in Error.prototype) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30000;

const asText = (value: unknown): string => String(value == null ? '' : value).trim();

const isTimeoutLikeError = (error: unknown): boolean => {
  if (error instanceof ResourceAcquireTimeoutError) return true;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('timeout') || normalized.includes('timed out');
};

const summarizeReadiness = (readiness: BrowserAcquireReadiness): string => {
  if (readiness.browserCount <= 0) {
    return 'no pooled browsers were visible for this profile';
  }
  return `${readiness.browserCount} pooled browser(s): ${readiness.lockedBrowserCount} locked, ${readiness.creatingBrowserCount} creating, ${readiness.idleBrowserCount} idle, ${readiness.destroyingBrowserCount} destroying`;
};

const inspectProfileBrowsers = (
  poolManager: BrowserPoolManager,
  profileId: string
): BrowserAcquireReadiness => {
  const listBrowsers =
    typeof (poolManager as { listBrowsers?: () => PooledBrowser[] }).listBrowsers === 'function'
      ? (poolManager as { listBrowsers: () => PooledBrowser[] }).listBrowsers.bind(poolManager)
      : null;
  const pooledBrowsers = listBrowsers ? listBrowsers() : [];
  const profileBrowsers = pooledBrowsers.filter(
    (browser) => asText((browser as { sessionId?: unknown }).sessionId) === profileId
  );

  const browsers: BrowserAcquireReadinessBrowserInfo[] = profileBrowsers.map((browser) => {
    const lockedBy =
      browser && typeof browser === 'object' && 'lockedBy' in browser
        ? (browser as { lockedBy?: Record<string, unknown> }).lockedBy || null
        : null;
    return {
      browserId: asText((browser as { id?: unknown }).id),
      status: asText((browser as { status?: unknown }).status),
      engine: (asText((browser as { engine?: unknown }).engine) as AutomationEngine) || null,
      source: lockedBy ? asText(lockedBy.source) || null : null,
      pluginId: lockedBy ? asText(lockedBy.pluginId) || null : null,
      requestId: lockedBy ? asText(lockedBy.requestId) || null : null,
      viewId: asText((browser as { viewId?: unknown }).viewId) || null,
    };
  });

  const lockedBrowserCount = browsers.filter((browser) => browser.status === 'locked').length;
  const creatingBrowserCount = browsers.filter((browser) => browser.status === 'creating').length;
  const idleBrowserCount = browsers.filter((browser) => browser.status === 'idle').length;
  const destroyingBrowserCount = browsers.filter((browser) => browser.status === 'destroying').length;

  return {
    profileId,
    browserCount: browsers.length,
    lockedBrowserCount,
    creatingBrowserCount,
    idleBrowserCount,
    destroyingBrowserCount,
    busy: lockedBrowserCount > 0 || creatingBrowserCount > 0,
    browsers,
  };
};

export const getProfileAcquireReadiness = (
  poolManager: BrowserPoolManager | undefined,
  profileId: string
): BrowserAcquireReadiness | null => {
  const normalizedProfileId = asText(profileId);
  if (!poolManager || !normalizedProfileId) return null;
  try {
    return inspectProfileBrowsers(poolManager, normalizedProfileId);
  } catch {
    return null;
  }
};

const wrapAcquireError = (
  poolManager: BrowserPoolManager,
  profileId: string,
  stage: 'profile_lease' | 'pool_acquire',
  error: unknown
): Error => {
  if (!isTimeoutLikeError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const diagnostics =
    getProfileAcquireReadiness(poolManager, profileId) ||
    ({
      profileId,
      browserCount: 0,
      lockedBrowserCount: 0,
      creatingBrowserCount: 0,
      idleBrowserCount: 0,
      destroyingBrowserCount: 0,
      busy: false,
      browsers: [],
    } satisfies BrowserAcquireReadiness);
  const stageLabel =
    stage === 'profile_lease' ? 'profile live-session lease' : 'browser pool acquire';
  return new BrowserAcquireTimeoutDiagnosticsError(
    `${stageLabel} timed out for profile ${profileId}: ${summarizeReadiness(diagnostics)}`,
    {
      stage,
      diagnostics,
      cause: error,
    }
  );
};

const recordAcquireFailureMetrics = (
  runtimeMetrics: RuntimeMetricsSnapshot,
  error: unknown
): void => {
  runtimeMetrics.browserAcquireFailureCount += 1;
  if (isTimeoutLikeError(error)) {
    runtimeMetrics.browserAcquireTimeoutCount += 1;
  }
};

const tryTakeoverLockedBrowser = async ({
  poolManager,
  profileId,
  requestedProfileId,
  engine,
  source,
  timeoutMs,
  logger,
}: {
  poolManager: BrowserPoolManager;
  profileId: string;
  requestedProfileId?: string;
  engine?: AutomationEngine;
  source: 'mcp' | 'http';
  timeoutMs: number;
  logger: LoggerLike;
}): Promise<BrowserHandle | null> => {
  if (source !== 'mcp') {
    return null;
  }

  const readiness = getProfileAcquireReadiness(poolManager, profileId);
  if (!readiness || readiness.lockedBrowserCount <= 0) {
    return null;
  }

  const takeoverLockedBrowser = (poolManager as TakeoverCapablePoolManager).takeoverLockedBrowser;
  if (typeof takeoverLockedBrowser !== 'function') {
    return null;
  }

  const takenOver = await takeoverLockedBrowser.call(
    poolManager,
    requestedProfileId || undefined,
    { strategy: 'any', timeout: timeoutMs, priority: 'normal', engine },
    source
  );
  if (!takenOver) {
    return null;
  }

  const profileLease = await takeoverProfileLiveSessionLease(profileId);
  const attached = attachProfileLiveSessionLease(takenOver, profileLease);
  logger.debug(`Browser taken over from existing holder: ${attached.browserId}`);
  return attached;
};

const tryTakeoverProfileLeaseAndAcquire = async ({
  poolManager,
  profileId,
  requestedProfileId,
  engine,
  source,
  timeoutMs,
  logger,
}: {
  poolManager: BrowserPoolManager;
  profileId: string;
  requestedProfileId?: string;
  engine?: AutomationEngine;
  source: 'mcp' | 'http';
  timeoutMs: number;
  logger: LoggerLike;
}): Promise<BrowserHandle | null> => {
  if (source !== 'mcp') {
    return null;
  }

  const profileLease = await takeoverProfileLiveSessionLease(profileId);
  if (!profileLease) {
    return null;
  }

  try {
    const handle = attachProfileLiveSessionLease(
      await poolManager.acquire(
        requestedProfileId || undefined,
        { strategy: 'any', timeout: timeoutMs, priority: 'normal', engine },
        source
      ),
      profileLease
    );
    logger.debug(`Browser acquired after taking over profile lease: ${handle.browserId}`);
    return handle;
  } catch (error) {
    await profileLease.release().catch(() => undefined);
    throw error;
  }
};

/**
 * 基于 BrowserPoolManager 统一获取浏览器句柄，并记录运行时失败指标。
 */
export const acquireBrowserFromPool = async ({
  getBrowserPoolManager,
  runtimeMetrics,
  logger,
  profileId,
  engine,
  source = 'mcp',
  timeoutMs,
}: AcquireBrowserFromPoolOptions): Promise<BrowserHandle> => {
  if (!getBrowserPoolManager) {
    throw new Error('BrowserPoolManager not available. MCP requires browser pool.');
  }

  const poolManager = getBrowserPoolManager();
  const resolvedProfileId = String(profileId || '').trim() || DEFAULT_BROWSER_PROFILE.id;
  const effectiveTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_ACQUIRE_TIMEOUT_MS);

  const takenOverImmediately = await tryTakeoverLockedBrowser({
    poolManager,
    profileId: resolvedProfileId,
    requestedProfileId: profileId,
    engine,
    source,
    timeoutMs: effectiveTimeoutMs,
    logger,
  });
  if (takenOverImmediately) {
    return takenOverImmediately;
  }

  let profileLease = null;
  try {
    profileLease = await acquireProfileLiveSessionLease(resolvedProfileId, {
      timeoutMs: effectiveTimeoutMs,
    });
  } catch (error) {
    const takenOverAfterLeaseContention = await tryTakeoverLockedBrowser({
      poolManager,
      profileId: resolvedProfileId,
      requestedProfileId: profileId,
      engine,
      source,
      timeoutMs: effectiveTimeoutMs,
      logger,
    });
    if (takenOverAfterLeaseContention) {
      return takenOverAfterLeaseContention;
    }
    const readinessAfterLeaseContention = getProfileAcquireReadiness(poolManager, resolvedProfileId);
    if ((readinessAfterLeaseContention?.lockedBrowserCount ?? 0) <= 0) {
      try {
        const acquiredAfterLeaseTakeover = await tryTakeoverProfileLeaseAndAcquire({
          poolManager,
          profileId: resolvedProfileId,
          requestedProfileId: profileId,
          engine,
          source,
          timeoutMs: effectiveTimeoutMs,
          logger,
        });
        if (acquiredAfterLeaseTakeover) {
          return acquiredAfterLeaseTakeover;
        }
      } catch (takeoverAcquireError) {
        const wrapped = wrapAcquireError(
          poolManager,
          resolvedProfileId,
          'pool_acquire',
          takeoverAcquireError
        );
        recordAcquireFailureMetrics(runtimeMetrics, wrapped);
        throw wrapped;
      }
    }
    const wrapped = wrapAcquireError(poolManager, resolvedProfileId, 'profile_lease', error);
    recordAcquireFailureMetrics(runtimeMetrics, wrapped);
    throw wrapped;
  }

  try {
    const handle = attachProfileLiveSessionLease(
      await poolManager.acquire(
        profileId || undefined,
        { strategy: 'any', timeout: effectiveTimeoutMs, priority: 'normal', engine },
        source
      ),
      profileLease
    );
    logger.debug(`Browser acquired from pool: ${handle.browserId}`);
    return handle;
  } catch (error) {
    await profileLease?.release().catch(() => undefined);
    const wrapped = wrapAcquireError(poolManager, resolvedProfileId, 'pool_acquire', error);
    recordAcquireFailureMetrics(runtimeMetrics, wrapped);
    throw wrapped;
  }
};
