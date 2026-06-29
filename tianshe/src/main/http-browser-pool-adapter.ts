import type { BrowserHandle, BrowserPoolManager } from '../core/browser-pool';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
  getProfileLiveSessionLeaseOwner,
  takeoverProfileLiveSessionLease,
} from '../core/browser-pool/profile-live-session-lease';
import { DEFAULT_BROWSER_PROFILE } from '../constants/browser-pool';
import { ResourceAcquireTimeoutError } from '../core/resource-coordinator';
import type { BrowserRuntimeId, PooledBrowser } from '../core/browser-pool/types';
import type { BrowserPoolEventEmitter } from '../core/browser-pool/events';
import type { RuntimeMetricsSnapshot } from './http-session-manager';

interface LoggerLike {
  debug(message: string, ...args: unknown[]): void;
}

interface AcquireBrowserFromPoolOptions {
  getBrowserPoolManager?: () => BrowserPoolManager;
  runtimeMetrics: RuntimeMetricsSnapshot;
  logger: LoggerLike;
  profileId?: string;
  runtimeId?: BrowserRuntimeId;
  source?: 'mcp' | 'http';
  timeoutMs?: number;
  signal?: AbortSignal;
}

type TakeoverCapablePoolManager = BrowserPoolManager & {
  getEventEmitter?: () => BrowserPoolEventEmitter;
  takeoverLockedBrowser?: (
    profileId: string | undefined,
    options?: {
      strategy?: 'any' | 'reuse' | 'fresh' | 'specific';
      timeout?: number;
      priority?: 'high' | 'normal' | 'low';
      runtimeId?: BrowserRuntimeId;
      browserId?: string;
      requireViewId?: boolean;
    },
    source?: 'mcp' | 'http'
  ) => Promise<BrowserHandle | null>;
};

export interface BrowserAcquireReadinessBrowserInfo {
  browserId: string;
  status: string;
  runtimeId: BrowserRuntimeId | null;
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

export class BrowserManualHandoffRequiredError extends Error {
  readonly diagnostics: BrowserAcquireReadiness;

  constructor(
    message: string,
    options: {
      diagnostics: BrowserAcquireReadiness;
    }
  ) {
    super(message);
    this.name = 'BrowserManualHandoffRequiredError';
    this.diagnostics = options.diagnostics;
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

const createEmptyReadiness = (profileId: string): BrowserAcquireReadiness => ({
  profileId,
  browserCount: 0,
  lockedBrowserCount: 0,
  creatingBrowserCount: 0,
  idleBrowserCount: 0,
  destroyingBrowserCount: 0,
  busy: false,
  browsers: [],
});

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
      runtimeId: (asText((browser as { runtimeId?: unknown }).runtimeId) as BrowserRuntimeId) || null,
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
    createEmptyReadiness(profileId);
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

const emitManualHandoffRequested = ({
  poolManager,
  profileId,
  source,
  holder,
  browser,
}: {
  poolManager: BrowserPoolManager;
  profileId: string;
  source: 'mcp' | 'http';
  holder: { source: 'ipc'; pluginId?: string | null; requestId?: string | null };
  browser?: BrowserAcquireReadinessBrowserInfo | null;
}): void => {
  const eventEmitter = (poolManager as TakeoverCapablePoolManager).getEventEmitter?.();
  eventEmitter?.emit('browser:handoff-requested', {
    ...(browser?.browserId ? { browserId: browser.browserId } : {}),
    sessionId: profileId,
    runtimeId: browser?.runtimeId ?? null,
    viewId: browser?.viewId ?? null,
    requestedBy: {
      source,
    },
    currentHolder: holder,
    policy: 'human_priority',
    manualRequired: true,
    requestedAt: Date.now(),
  });
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
  runtimeId,
  source,
  timeoutMs,
  logger,
}: {
  poolManager: BrowserPoolManager;
  profileId: string;
  requestedProfileId?: string;
  runtimeId?: BrowserRuntimeId;
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
  const humanLockedBrowser = readiness.browsers.find(
    (browser) => browser.status === 'locked' && browser.source === 'ipc'
  );
  if (humanLockedBrowser) {
    emitManualHandoffRequested({
      poolManager,
      profileId,
      source,
      browser: humanLockedBrowser,
      holder: {
        source: 'ipc',
        ...(humanLockedBrowser.pluginId ? { pluginId: humanLockedBrowser.pluginId } : {}),
        ...(humanLockedBrowser.requestId ? { requestId: humanLockedBrowser.requestId } : {}),
      },
    });
    throw new BrowserManualHandoffRequiredError(
      `Profile ${profileId} is currently controlled by a human window; agent takeover requires manual handoff instead of silent lock takeover.`,
      {
        diagnostics: readiness,
      }
    );
  }

  const takeoverLockedBrowser = (poolManager as TakeoverCapablePoolManager).takeoverLockedBrowser;
  if (typeof takeoverLockedBrowser !== 'function') {
    return null;
  }

  const takenOver = await takeoverLockedBrowser.call(
    poolManager,
    requestedProfileId || undefined,
    { strategy: 'any', timeout: timeoutMs, priority: 'normal', runtimeId },
    source
  );
  if (!takenOver) {
    return null;
  }

  const profileLease = await takeoverProfileLiveSessionLease(profileId, { source });
  const attached = attachProfileLiveSessionLease(takenOver, profileLease);
  logger.debug(`Browser taken over from existing holder: ${attached.browserId}`);
  return attached;
};

const tryTakeoverProfileLeaseAndAcquire = async ({
  poolManager,
  profileId,
  requestedProfileId,
  runtimeId,
  source,
  timeoutMs,
  logger,
}: {
  poolManager: BrowserPoolManager;
  profileId: string;
  requestedProfileId?: string;
  runtimeId?: BrowserRuntimeId;
  source: 'mcp' | 'http';
  timeoutMs: number;
  logger: LoggerLike;
}): Promise<BrowserHandle | null> => {
  if (source !== 'mcp') {
    return null;
  }

  const leaseOwner = await getProfileLiveSessionLeaseOwner(profileId);
  if (leaseOwner?.ownerSource === 'ipc') {
    const diagnostics = getProfileAcquireReadiness(poolManager, profileId) || createEmptyReadiness(profileId);
    emitManualHandoffRequested({
      poolManager,
      profileId,
      source,
      holder: { source: 'ipc' },
    });
    throw new BrowserManualHandoffRequiredError(
      `Profile ${profileId} is currently controlled by a human live-session lease; agent takeover requires manual handoff instead of silent lease takeover.`,
      {
        diagnostics,
      }
    );
  }

  const profileLease = await takeoverProfileLiveSessionLease(profileId, { source });
  if (!profileLease) {
    return null;
  }

  try {
    const handle = attachProfileLiveSessionLease(
      await poolManager.acquire(
        requestedProfileId || undefined,
        { strategy: 'any', timeout: timeoutMs, priority: 'normal', runtimeId },
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
 * 鍩轰簬 BrowserPoolManager 缁熶竴鑾峰彇娴忚鍣ㄥ彞鏌勶紝骞惰褰曡繍琛屾椂澶辫触鎸囨爣銆?
 */
export const acquireBrowserFromPool = async ({
  getBrowserPoolManager,
  runtimeMetrics,
  logger,
  profileId,
  runtimeId,
  source = 'mcp',
  timeoutMs,
  signal,
}: AcquireBrowserFromPoolOptions): Promise<BrowserHandle> => {
  if (!getBrowserPoolManager) {
    throw new Error('BrowserPoolManager not available. MCP requires browser pool.');
  }

  const poolManager = getBrowserPoolManager();
  const resolvedProfileId = String(profileId || '').trim() || DEFAULT_BROWSER_PROFILE.id;
  const effectiveTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_ACQUIRE_TIMEOUT_MS);

  let takenOverImmediately: BrowserHandle | null = null;
  try {
    takenOverImmediately = await tryTakeoverLockedBrowser({
      poolManager,
      profileId: resolvedProfileId,
      requestedProfileId: profileId,
      runtimeId,
      source,
      timeoutMs: effectiveTimeoutMs,
      logger,
    });
  } catch (error) {
    recordAcquireFailureMetrics(runtimeMetrics, error);
    throw error;
  }
  if (takenOverImmediately) {
    return takenOverImmediately;
  }

  let profileLease = null;
  try {
    profileLease = await acquireProfileLiveSessionLease(resolvedProfileId, {
      source,
      timeoutMs: effectiveTimeoutMs,
      signal,
    });
  } catch (error) {
    let takenOverAfterLeaseContention: BrowserHandle | null = null;
    try {
      takenOverAfterLeaseContention = await tryTakeoverLockedBrowser({
        poolManager,
        profileId: resolvedProfileId,
        requestedProfileId: profileId,
        runtimeId,
        source,
        timeoutMs: effectiveTimeoutMs,
        logger,
      });
    } catch (takeoverError) {
      recordAcquireFailureMetrics(runtimeMetrics, takeoverError);
      throw takeoverError;
    }
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
          runtimeId,
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
        { strategy: 'any', timeout: effectiveTimeoutMs, priority: 'normal', runtimeId, signal },
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

