/**
 * 浏览器池管理器
 *
 * 协调 ProfileAdapter、GlobalPool、WaitQueue
 * 提供统一的浏览器获取/释放接口
 *
 * v2 架构：Profile = Session
 * - Profile 是唯一的 Session 来源
 * - 所有浏览器都必须关联 Profile
 * - 支持默认浏览器 Profile
 *
 * 核心流程：
 * 1. acquire() 请求浏览器
 *    → 检查 Profile 是否存在
 *    → 尝试获取空闲浏览器
 *    → 如果没有，检查当前 Profile 是否允许创建单实例运行时
 *    → 如果不允许，进入等待队列
 *    → 返回 BrowserHandle
 *
 * 2. release() 释放浏览器
 *    → 重置浏览器状态
 *    → 检查等待队列
 *    → 如果有等待者，直接分配
 *    → 否则放回池中
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger';
import { GlobalPool, type BrowserFactory, type BrowserDestroyer } from './global-pool';
import {
  PoolStoppedError,
  ProfileNotFoundError,
  AcquireFailedError,
  PoolNotInitializedError,
} from '../errors/BrowserPoolError';

const logger = createLogger('BrowserPoolManager');
import {
  DEFAULT_BROWSER_PROFILE,
  WAIT_QUEUE_CONFIG,
  type BrowserPoolConfig,
} from '../../constants/browser-pool';
import { WaitQueue } from './wait-queue';
import { resetBrowserState } from './utils';
import { createBrowserPoolEventEmitter, type BrowserPoolEventEmitter } from './events';
import { isNonRetryableEngineCreateError } from './browser-engine-create-policy';
import type {
  SessionConfig,
  AcquireRequest,
  AcquireResult,
  AcquireOptions,
  BrowserInterface,
  ReleaseOptions,
  ReleaseResult,
  BrowserHandle,
  PoolStats,
  SessionStats,
  LockInfo,
  AcquireSource,
  WaitingRequest,
  ReadyBrowser,
} from './types';
import { isReadyBrowser } from './types';
import type { ProfileService } from '../../main/duckdb/profile-service';
import { AUTOMATION_ENGINES, normalizeProfileBrowserQuota } from '../../types/profile';
import type { BrowserProfile } from '../../types/profile';

/** 默认获取选项 */
const DEFAULT_ACQUIRE_OPTIONS: AcquireOptions = {
  strategy: 'any',
  timeout: WAIT_QUEUE_CONFIG.defaultAcquireTimeoutMs,
  priority: 'normal',
};

interface AdoptLockedBrowserOptions extends Partial<AcquireOptions> {
  requireViewId?: boolean;
}

interface TakeoverLockedBrowserOptions extends Partial<AcquireOptions> {
  requireViewId?: boolean;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getAbortMessage(signal: AbortSignal | undefined, fallback: string): string {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return fallback;
}

function isBrowserControllerClosed(browser: unknown): boolean {
  if (!browser || typeof (browser as { isClosed?: unknown }).isClosed !== 'function') {
    return false;
  }

  try {
    return Boolean((browser as { isClosed: () => boolean }).isClosed());
  } catch {
    return false;
  }
}

/**
 * 浏览器池管理器
 */
export class BrowserPoolManager {
  /** 全局浏览器池 */
  private globalPool: GlobalPool;

  /** 等待队列 */
  private waitQueue: WaitQueue;

  /** 事件发射器（生命周期随 Manager 管理） */
  private eventEmitter: BrowserPoolEventEmitter;

  /** 是否已初始化 */
  private initialized = false;

  /** 是否已停止 */
  private stopped = false;

  /** 获取 ProfileService 的函数 */
  private getProfileService: () => ProfileService;

  constructor(getProfileService: () => ProfileService) {
    this.getProfileService = getProfileService;
    this.globalPool = new GlobalPool();
    this.waitQueue = new WaitQueue();
    this.eventEmitter = createBrowserPoolEventEmitter();
  }

  /**
   * 获取事件发射器
   *
   * 用于外部订阅浏览器池事件
   */
  getEventEmitter(): BrowserPoolEventEmitter {
    return this.eventEmitter;
  }

  // ============================================
  // Profile → Session 转换（内联原 ProfileAdapter 逻辑）
  // ============================================

  /**
   * 获取 ProfileService 实例
   */
  private get profileService(): ProfileService {
    return this.getProfileService();
  }

  /**
   * 将 Profile 转换为 SessionConfig
   * 类型已统一，直接使用 fingerprint 无需转换
   */
  private toSessionConfig(profile: BrowserProfile): SessionConfig {
    const engine = profile.engine ?? 'electron';
    const quota = normalizeProfileBrowserQuota(profile.quota).quota;

    return {
      id: profile.id,
      partition: profile.partition,
      engine,
      fingerprint: profile.fingerprint ? structuredClone(profile.fingerprint) : undefined,
      proxy: profile.proxy ? structuredClone(profile.proxy) : null,
      // 浏览器运行时统一为单 Profile 单实例。
      quota,
      idleTimeoutMs: profile.idleTimeoutMs,
      lockTimeoutMs: profile.lockTimeoutMs,
      createdAt: profile.createdAt.getTime(),
      lastAccessedAt: profile.lastActiveAt?.getTime() || Date.now(),
    };
  }

  /**
   * 初始化池管理器
   *
   * @param browserFactory 浏览器创建工厂
   * @param browserDestroyer 浏览器销毁函数
   * @param config 可选的池配置
   */
  async initialize(
    browserFactory: BrowserFactory,
    browserDestroyer: BrowserDestroyer,
    config?: Partial<BrowserPoolConfig>
  ): Promise<void> {
    if (this.initialized) return;

    // 设置工厂函数
    this.globalPool.setBrowserFactory(browserFactory);
    this.globalPool.setBrowserDestroyer(browserDestroyer);
    this.globalPool.setSessionBrowsersChangedCallback((sessionId) =>
      this.syncProfileIdleIfNoBrowsers(sessionId)
    );

    // 设置配置
    if (config) {
      this.globalPool.setConfig(config);
    }

    // 启动健康检查
    this.globalPool.startHealthCheck();

    this.initialized = true;
    logger.info('Initialized');
  }

  /**
   * 更新池配置
   */
  setConfig(config: Partial<BrowserPoolConfig>): void {
    this.globalPool.setConfig(config);
  }

  /**
   * 获取当前配置
   */
  getConfig(): BrowserPoolConfig {
    return this.globalPool.getConfig();
  }

  /**
   * 获取默认浏览器会话
   *
   * @returns 默认浏览器会话配置
   */
  async getDefaultSession(): Promise<SessionConfig | undefined> {
    const profile = await this.profileService.get(DEFAULT_BROWSER_PROFILE.id);
    return profile ? this.toSessionConfig(profile) : undefined;
  }

  /**
   * 获取会话（通过 Profile ID）
   *
   * @param profileId Profile ID
   */
  async getSession(profileId: string): Promise<SessionConfig | undefined> {
    const profile = await this.profileService.get(profileId);
    return profile ? this.toSessionConfig(profile) : undefined;
  }

  private buildBrowserHandle(request: AcquireRequest, browserId: string, sessionId: string): BrowserHandle {
    const pooledBrowser = this.globalPool.getBrowser(browserId);
    if (!pooledBrowser || !isReadyBrowser(pooledBrowser)) {
      throw new AcquireFailedError(`Browser not ready for handle creation: ${browserId}`);
    }

    return {
      browser: pooledBrowser.browser,
      browserId,
      sessionId,
      engine: pooledBrowser.engine,
      viewId: pooledBrowser.viewId,
      release: async (releaseOptions?: ReleaseOptions) =>
        this.release(browserId, releaseOptions, request.requestId),
      renew: async (extensionMs?: number) => this.renewLock(browserId, extensionMs, request.requestId),
    };
  }

  private emitBrowserAcquired(
    request: AcquireRequest,
    browserId: string,
    sessionId: string,
    waitedMs: number
  ): void {
    this.eventEmitter.emit('browser:acquired', {
      browserId,
      sessionId,
      pluginId: request.pluginId,
      source: request.source,
      waitedMs,
    });
  }

  private async markProfileActive(sessionId: string, browserId: string): Promise<void> {
    try {
      await this.profileService.updateStatus(sessionId, 'active');
    } catch (err) {
      logger.warn('[BrowserPoolManager] Failed to update profile status to active', {
        sessionId,
        browserId,
        err,
      });
    }
  }

  private async syncProfileIdleIfNoBrowsers(sessionId: string): Promise<void> {
    const stats = this.globalPool.getSessionBrowserCount(sessionId);
    if (stats.total > 0) {
      return;
    }

    try {
      await this.profileService.updateStatus(sessionId, 'idle');
    } catch (err) {
      logger.warn('[BrowserPoolManager] Failed to sync profile status to idle', {
        sessionId,
        err,
      });
    }
  }

  /**
   * 销毁 Profile 的所有浏览器
   *
   * 注意：不删除 Profile 本身，只销毁浏览器实例
   *
   * @param profileId Profile ID
   */
  async destroyProfileBrowsers(profileId: string): Promise<number> {
    // 取消该会话的所有等待请求
    this.waitQueue.cancelBySession(profileId, 'Profile browsers destroyed');

    // 销毁该 Profile 的所有浏览器
    const browsers = this.globalPool.listBrowsers().filter((b) => b.sessionId === profileId);
    for (const browser of browsers) {
      await this.globalPool.destroyBrowser(browser.id);
    }

    try {
      await this.profileService.updateStatus(profileId, 'idle');
    } catch (err) {
      logger.warn('[BrowserPoolManager] Failed to update profile status to idle after destroy', {
        profileId,
        err,
      });
    }

    return browsers.length;
  }

  /**
   * 获取浏览器
   *
   * @param profileId Profile ID（如果为空，使用默认浏览器）
   * @param options 获取选项
   * @param source 调用来源
   * @param pluginId 插件ID（可选）
   * @returns BrowserHandle 或抛出错误
   */
  async acquire(
    profileId: string | undefined,
    options?: Partial<AcquireOptions>,
    source: AcquireSource = 'internal',
    pluginId?: string
  ): Promise<BrowserHandle> {
    if (this.stopped) {
      throw new PoolStoppedError();
    }

    // 获取 Session（如果没有指定 profileId，使用默认浏览器）
    const targetProfileId = profileId || DEFAULT_BROWSER_PROFILE.id;
    const profile = await this.profileService.get(targetProfileId);
    const session = profile ? this.toSessionConfig(profile) : undefined;

    if (!session) {
      throw new ProfileNotFoundError(profileId || 'default');
    }

    // 合并选项
    const acquireOptions: AcquireOptions = {
      ...DEFAULT_ACQUIRE_OPTIONS,
      ...options,
    };
    const sessionEngine = session.engine ?? 'electron';
    if (acquireOptions.engine && acquireOptions.engine !== sessionEngine) {
      throw new AcquireFailedError(
        `Engine mismatch for profile ${session.id}: profile is bound to "${sessionEngine}", requested "${acquireOptions.engine}"`
      );
    }
    if (acquireOptions.signal?.aborted) {
      throw new AcquireFailedError(getAbortMessage(acquireOptions.signal, 'Acquire cancelled'));
    }
    acquireOptions.engine = sessionEngine;
    session.engine = sessionEngine;

    // 创建请求
    const request: AcquireRequest = {
      sessionId: session.id,
      requestId: uuidv4(),
      pluginId,
      source,
      options: acquireOptions,
    };

    // 执行获取
    const result = await this.doAcquire(request, session);

    // 利用判别联合类型收窄：检查 success 后，TypeScript 自动推断成功分支的类型
    if (!result.success) {
      throw new AcquireFailedError(result.error || 'Unknown error');
    }

    // 此处 result 的类型已收窄为 AcquireResultSuccess
    const { browser, browserId, sessionId } = result;

    // 获取 viewId（从池中的浏览器信息）
    const pooledBrowser = this.globalPool.getBrowser(browserId);
    const viewId =
      pooledBrowser && isReadyBrowser(pooledBrowser) ? pooledBrowser.viewId : undefined;

    // 创建 BrowserHandle
    const handle: BrowserHandle = {
      browser,
      browserId,
      sessionId,
      engine: acquireOptions.engine,
      viewId,
      release: async (releaseOptions?: ReleaseOptions) => {
        // 绑定 requestId，用于校验锁定所有权，避免 stale handle 误释放/误交接
        return this.release(browserId, releaseOptions, request.requestId);
      },
      renew: async (extensionMs?: number) => {
        // 绑定 requestId，用于校验锁定所有权，避免 stale handle 误续期
        return this.renewLock(browserId, extensionMs, request.requestId);
      },
    };

    // 发射 browser:acquired 事件
    this.eventEmitter.emit('browser:acquired', {
      browserId,
      sessionId,
      pluginId: request.pluginId,
      source: request.source,
      waitedMs: result.waitedMs,
    });

    // 🆕 统一同步 Profile 状态：只要成功 acquire，就认为该 Profile 正在运行
    try {
      await this.profileService.updateStatus(sessionId, 'active');
    } catch (err) {
      logger.warn('[BrowserPoolManager] Failed to update profile status to active', {
        sessionId,
        browserId,
        err,
      });
    }

    return handle;
  }

  async adoptSamePluginLockedBrowser(
    profileId: string | undefined,
    options?: AdoptLockedBrowserOptions,
    source: AcquireSource = 'internal',
    pluginId?: string
  ): Promise<BrowserHandle | null> {
    const normalizedPluginId = String(pluginId || '').trim();
    if (!normalizedPluginId) {
      return null;
    }

    const targetProfileId = profileId || DEFAULT_BROWSER_PROFILE.id;
    const profile = await this.profileService.get(targetProfileId);
    const session = profile ? this.toSessionConfig(profile) : undefined;
    if (!session) {
      throw new ProfileNotFoundError(profileId || 'default');
    }

    const acquireOptions: AcquireOptions = {
      ...DEFAULT_ACQUIRE_OPTIONS,
      ...options,
    };
    const sessionEngine = session.engine ?? 'electron';
    if (acquireOptions.engine && acquireOptions.engine !== sessionEngine) {
      throw new AcquireFailedError(
        `Engine mismatch for profile ${session.id}: profile is bound to "${sessionEngine}", requested "${acquireOptions.engine}"`
      );
    }
    if (acquireOptions.signal?.aborted) {
      throw new AcquireFailedError(getAbortMessage(acquireOptions.signal, 'Acquire cancelled'));
    }
    acquireOptions.engine = sessionEngine;
    session.engine = sessionEngine;

    const candidate = this.globalPool
      .listBrowsers()
      .filter((browser) => {
        if (!isReadyBrowser(browser)) return false;
        if (browser.sessionId !== session.id) return false;
        if (browser.status !== 'locked') return false;
        if (browser.lockedBy?.pluginId !== normalizedPluginId) return false;
        if (options?.requireViewId === true && !browser.viewId) return false;
        if (acquireOptions.browserId && browser.id !== acquireOptions.browserId) return false;
        if (acquireOptions.engine && browser.engine !== acquireOptions.engine) return false;
        return true;
      })
      .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)[0];

    if (!candidate) {
      return null;
    }

    const request: AcquireRequest = {
      sessionId: session.id,
      requestId: uuidv4(),
      pluginId: normalizedPluginId,
      source,
      options: acquireOptions,
    };

    const handedOff = await this.globalPool.handoffLock(candidate.id, {
      requestId: request.requestId,
      pluginId: normalizedPluginId,
      source,
      timeoutMs: acquireOptions.lockTimeout ?? session.lockTimeoutMs,
    });
    if (!handedOff) {
      return null;
    }

    const handle = this.buildBrowserHandle(request, candidate.id, session.id);
    this.emitBrowserAcquired(request, candidate.id, session.id, 0);
    await this.markProfileActive(session.id, candidate.id);
    logger.info('Adopted locked browser for same plugin', {
      profileId: session.id,
      browserId: candidate.id,
      pluginId: normalizedPluginId,
      source,
    });
    return handle;
  }

  async takeoverLockedBrowser(
    profileId: string | undefined,
    options?: TakeoverLockedBrowserOptions,
    source: AcquireSource = 'mcp',
    pluginId?: string
  ): Promise<BrowserHandle | null> {
    if (this.stopped) {
      throw new PoolStoppedError();
    }

    const targetProfileId = profileId || DEFAULT_BROWSER_PROFILE.id;
    const profile = await this.profileService.get(targetProfileId);
    const session = profile ? this.toSessionConfig(profile) : undefined;
    if (!session) {
      throw new ProfileNotFoundError(profileId || 'default');
    }

    const acquireOptions: AcquireOptions = {
      ...DEFAULT_ACQUIRE_OPTIONS,
      ...options,
    };
    const sessionEngine = session.engine ?? 'electron';
    if (acquireOptions.engine && acquireOptions.engine !== sessionEngine) {
      throw new AcquireFailedError(
        `Engine mismatch for profile ${session.id}: profile is bound to "${sessionEngine}", requested "${acquireOptions.engine}"`
      );
    }
    if (acquireOptions.signal?.aborted) {
      throw new AcquireFailedError(getAbortMessage(acquireOptions.signal, 'Acquire cancelled'));
    }
    acquireOptions.engine = sessionEngine;
    session.engine = sessionEngine;

    const normalizedPluginId = String(pluginId || '').trim() || undefined;
    const candidate = this.globalPool
      .listBrowsers()
      .filter((browser) => {
        if (!isReadyBrowser(browser)) return false;
        if (browser.sessionId !== session.id) return false;
        if (browser.status !== 'locked') return false;
        if (!browser.lockedBy) return false;
        if (options?.requireViewId === true && !browser.viewId) return false;
        if (acquireOptions.browserId && browser.id !== acquireOptions.browserId) return false;
        if (acquireOptions.engine && browser.engine !== acquireOptions.engine) return false;
        return true;
      })
      .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)[0];

    if (!candidate) {
      return null;
    }

    const previousLock = candidate.lockedBy;
    const request: AcquireRequest = {
      sessionId: session.id,
      requestId: uuidv4(),
      pluginId: normalizedPluginId,
      source,
      options: acquireOptions,
    };

    const handedOff = await this.globalPool.handoffLock(candidate.id, {
      requestId: request.requestId,
      pluginId: normalizedPluginId,
      source,
      timeoutMs: acquireOptions.lockTimeout ?? session.lockTimeoutMs,
    });
    if (!handedOff) {
      return null;
    }

    const handle = this.buildBrowserHandle(request, candidate.id, session.id);
    this.emitBrowserAcquired(request, candidate.id, session.id, 0);
    await this.markProfileActive(session.id, candidate.id);
    logger.warn('Took over locked browser', {
      profileId: session.id,
      browserId: candidate.id,
      source,
      pluginId: normalizedPluginId,
      previousSource: previousLock?.source,
      previousPluginId: previousLock?.pluginId,
      previousRequestId: previousLock?.requestId,
    });
    return handle;
  }

  /**
   * 释放浏览器
   *
   * 优化：如果有等待者，直接将浏览器转移给等待者，避免竞态问题
   *
   * @param browserId 浏览器ID
   * @param options 释放选项
   * @returns ReleaseResult 包含释放后的状态信息，避免调用者需要额外查询导致竞态
   */
  async release(
    browserId: string,
    options?: ReleaseOptions,
    expectedRequestId?: string
  ): Promise<ReleaseResult> {
    const browser = this.globalPool.getBrowser(browserId);
    if (!browser) {
      logger.warn('Browser not found for release: ' + browserId);
      return { sessionId: null, remainingBrowserCount: 0, destroyed: false };
    }

    const sessionId = browser.sessionId;
    const pluginId = browser.lockedBy?.pluginId;

    // 安全：如果提供 expectedRequestId，则仅允许当前锁的持有者释放/交接
    // 避免浏览器锁超时后被其他请求重新获取，旧 handle 再次 release 导致误释放/误交接
    if (
      expectedRequestId &&
      (browser.status !== 'locked' || browser.lockedBy?.requestId !== expectedRequestId)
    ) {
      logger.warn('Ignored release due to requestId mismatch (stale handle?)', {
        browserId,
        sessionId,
        status: browser.status,
        expectedRequestId,
        actualRequestId: browser.lockedBy?.requestId,
      });
      const stats = this.globalPool.getSessionBrowserCount(sessionId);
      return { sessionId, remainingBrowserCount: stats.total, destroyed: false };
    }

    // 发射 browser:released 事件
    this.eventEmitter.emit('browser:released', {
      browserId,
      sessionId,
      pluginId,
      destroy: options?.destroy ?? false,
    });

    // 如果请求销毁
    if (options?.destroy) {
      await this.globalPool.destroyBrowser(browserId);
      // 销毁后检查是否可以为等待者创建新浏览器
      await this.processWaitQueueIterative(sessionId);
      // 返回释放结果（在同一事务中获取统计，避免竞态）
      const stats = this.globalPool.getSessionBrowserCount(sessionId);

      // 🆕 统一同步 Profile 状态：当该 Profile 没有任何浏览器实例时，置为 idle
      if (stats.total === 0) {
        try {
          await this.profileService.updateStatus(sessionId, 'idle');
        } catch (err) {
          logger.warn('[BrowserPoolManager] Failed to update profile status to idle', {
            sessionId,
            browserId,
            err,
          });
        }
      }

      return { sessionId, remainingBrowserCount: stats.total, destroyed: true };
    }

    // 检查是否有等待者需要这个浏览器
    const waitingRequest = await this.waitQueue.dequeue(sessionId, browser.engine);
    if (waitingRequest) {
      // 有等待者，直接转移浏览器（不经过 idle 状态，避免竞态）
      await this.transferBrowserToWaiter(browserId, waitingRequest, options);
    } else {
      // 没有等待者，正常释放到池中
      await this.globalPool.releaseBrowser(browserId, options);
      // reset 期间新进入队列的请求需要在这里补一次分配。
      await this.processWaitQueueIterative(sessionId);
    }

    // 返回释放结果（在同一事务中获取统计，避免竞态）
    const stats = this.globalPool.getSessionBrowserCount(sessionId);

    // 🆕 统一同步 Profile 状态：当该 Profile 没有任何浏览器实例时，置为 idle
    // 注意：release 到池中（destroy=false）通常仍会保留浏览器实例，因此 stats.total 大多不为 0
    if (stats.total === 0) {
      try {
        await this.profileService.updateStatus(sessionId, 'idle');
      } catch (err) {
        logger.warn('[BrowserPoolManager] Failed to update profile status to idle', {
          sessionId,
          browserId,
          err,
        });
      }
    }

    return { sessionId, remainingBrowserCount: stats.total, destroyed: false };
  }

  /**
   * 将浏览器直接转移给等待者
   *
   * @param browserId 浏览器ID
   * @param waiter 等待请求
   * @param options 释放选项（用于重置浏览器状态）
   */
  private async transferBrowserToWaiter(
    browserId: string,
    waiter: WaitingRequest,
    options?: ReleaseOptions
  ): Promise<void> {
    const profile = await this.profileService.get(waiter.request.sessionId);
    const session = profile ? this.toSessionConfig(profile) : undefined;
    if (!session) {
      // Profile 不存在，释放浏览器并告知等待者失败
      await this.globalPool.releaseBrowser(browserId, options);
      waiter.resolve({
        success: false,
        error: 'Profile not found',
        waitedMs: Date.now() - waiter.enqueuedAt,
      });
      return;
    }

    // 重置浏览器状态（如果需要）
    const browser = this.globalPool.getBrowser(browserId);
    if (browser && isReadyBrowser(browser)) {
      await resetBrowserState(browser.browser, options, '[BrowserPoolManager]');
    }

    // 更新锁定信息为新的等待者
    const lockInfo: LockInfo = {
      requestId: waiter.request.requestId,
      pluginId: waiter.request.pluginId,
      source: waiter.request.source,
      timeoutMs: waiter.request.options.lockTimeout ?? session.lockTimeoutMs,
    };

    // 直接交接锁定信息（不经过 idle 状态），避免竞态
    const locked = await this.globalPool.handoffLock(browserId, lockInfo);

    // 重新获取浏览器（handoffLock 可能更新了状态）
    const lockedBrowser = this.globalPool.getBrowser(browserId);
    if (locked && lockedBrowser && isReadyBrowser(lockedBrowser)) {
      waiter.resolve({
        success: true,
        browser: lockedBrowser.browser,
        browserId: browserId,
        sessionId: session.id,
        waitedMs: Date.now() - waiter.enqueuedAt,
      });
      logger.info('Browser transferred to waiter: ' + browserId + ' → ' + waiter.request.requestId);
    } else {
      // 锁定失败（不应该发生），释放浏览器并告知等待者失败
      await this.globalPool.releaseBrowser(browserId, options);
      waiter.resolve({
        success: false,
        error: 'Failed to lock browser for waiter',
        waitedMs: Date.now() - waiter.enqueuedAt,
      });
    }
  }

  /**
   * 续期浏览器锁定
   *
   * 延长锁定时间，防止长时间操作被超时释放
   * 建议在执行长时间操作时定期调用此方法
   *
   * @param browserId 浏览器ID
   * @param extensionMs 延长时间（ms），如果不指定则使用原始 lockTimeoutMs
   * @returns 是否续期成功
   *
   * @example
   * ```ts
   * const handle = await poolManager.acquire(profileId);
   *
   * // 执行长时间操作时，定期续期
   * const renewInterval = setInterval(() => {
   *   handle.renew();
   * }, 60000); // 每分钟续期一次
   *
   * try {
   *   await longRunningOperation();
   * } finally {
   *   clearInterval(renewInterval);
   *   await handle.release();
   * }
   * ```
   */
  async renewLock(
    browserId: string,
    extensionMs?: number,
    expectedRequestId?: string
  ): Promise<boolean> {
    const browser = this.globalPool.getBrowser(browserId);
    if (
      expectedRequestId &&
      browser &&
      (browser.status !== 'locked' || browser.lockedBy?.requestId !== expectedRequestId)
    ) {
      logger.warn('Ignored renewLock due to requestId mismatch (stale handle?)', {
        browserId,
        sessionId: browser.sessionId,
        status: browser.status,
        expectedRequestId,
        actualRequestId: browser.lockedBy?.requestId,
      });
      return false;
    }
    const success = await this.globalPool.renewLock(browserId, extensionMs);

    if (success) {
      // 发射事件（可选，用于监控）
      this.eventEmitter.emit('browser:lock-renewed', {
        browserId,
        sessionId: browser?.sessionId,
        extensionMs,
      });
    }

    return success;
  }

  /**
   * 强制释放浏览器（用于超时或异常情况）
   *
   * @param browserId 浏览器ID
   */
  async forceRelease(browserId: string): Promise<void> {
    const browser = this.globalPool.getBrowser(browserId);
    const sessionId = browser?.sessionId;

    await this.globalPool.releaseBrowser(browserId, {
      navigateTo: 'about:blank',
      clearStorage: true,
    });

    if (sessionId) {
      await this.processWaitQueueIterative(sessionId);
    }
  }

  /**
   * 释放插件持有的所有资源
   *
   * @param pluginId 插件ID
   */
  async releaseByPlugin(pluginId: string): Promise<{ browsers: number; requests: number }> {
    // 释放浏览器
    const browsers = await this.globalPool.releaseByPlugin(pluginId);

    // 取消等待请求
    const requests = this.waitQueue.cancelByPlugin(pluginId, 'Plugin stopped');

    logger.info(
      'Released plugin resources: ' +
        pluginId +
        ' (browsers: ' +
        browsers +
        ', requests: ' +
        requests +
        ')'
    );

    return { browsers, requests };
  }

  /**
   * 获取池统计信息
   */
  async getStats(): Promise<PoolStats> {
    const poolStats = this.globalPool.getStats();
    const queueStats = this.waitQueue.getStats();
    const profileStats = await this.profileService.getStats();

    return {
      totalBrowsers: poolStats.total,
      idleBrowsers: poolStats.idle,
      lockedBrowsers: poolStats.locked,
      sessionsCount: profileStats.total,
      waitingRequests: queueStats.totalWaiting,
      browsersBySession: poolStats.bySession,
    };
  }

  /**
   * 获取 Profile 的浏览器统计信息
   *
   * @param profileId Profile ID
   */
  async getProfileStats(profileId: string): Promise<SessionStats | null> {
    const profile = await this.profileService.get(profileId);
    if (!profile) return null;
    const session = this.toSessionConfig(profile);

    const browserStats = this.globalPool.getSessionBrowserCount(profileId);
    const waitingCount = this.waitQueue.getWaitingCount(profileId);

    return {
      sessionId: profileId,
      quota: session.quota,
      browserCount: browserStats.total,
      idleCount: browserStats.idle,
      lockedCount: browserStats.locked,
      waitingCount,
    };
  }

  /**
   * 列出所有 Profile 的会话配置
   */
  async listSessions(): Promise<SessionConfig[]> {
    const profiles = await this.profileService.list();
    return profiles.map((p) => this.toSessionConfig(p));
  }

  /**
   * 停止池管理器
   */
  async stop(): Promise<void> {
    if (this.stopped) return;

    this.stopped = true;
    logger.info('Stopping...');

    // 清空等待队列
    this.waitQueue.clear('Pool shutting down');

    // 停止全局池
    await this.globalPool.stop();

    // 清理事件监听器
    this.eventEmitter.removeAllListeners();

    logger.info('Stopped');
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 执行获取浏览器
   */
  private async doAcquire(request: AcquireRequest, session: SessionConfig): Promise<AcquireResult> {
    const startTime = Date.now();

    // 🔍 诊断日志
    const stats = this.globalPool.getStats();
    const poolConfig = this.getConfig();
    logger.info(
      `[doAcquire] 开始获取浏览器: session=${session.id}, plugin=${request.pluginId}, ` +
        `池状态: 总数=${stats.total}/${poolConfig.maxTotalBrowsers}, 空闲=${stats.idle}, 锁定=${stats.locked}`
    );

    // 1. 尝试获取空闲浏览器
    let pooledBrowser = await this.tryAcquireFromPool(request, session);

    if (pooledBrowser) {
      logger.info(`[doAcquire] ✅ 从池中获取空闲浏览器: ${pooledBrowser.id.slice(0, 8)}`);
      return {
        success: true,
        browser: pooledBrowser.browser,
        browserId: pooledBrowser.id,
        sessionId: session.id,
        waitedMs: Date.now() - startTime,
      };
    }

    logger.info(`[doAcquire] 无空闲浏览器，尝试创建新浏览器...`);

    // 2. 尝试创建新浏览器
    pooledBrowser = await this.tryCreateBrowser(request, session);

    if (pooledBrowser) {
      logger.info(`[doAcquire] ✅ 创建新浏览器成功: ${pooledBrowser.id.slice(0, 8)}`);
      return {
        success: true,
        browser: pooledBrowser.browser,
        browserId: pooledBrowser.id,
        sessionId: session.id,
        waitedMs: Date.now() - startTime,
      };
    }

    // 3. 进入等待队列
    const queueStats = this.waitQueue.getStats();
    logger.warn(
      `[doAcquire] ⚠️ 无法创建浏览器，进入等待队列: request=${request.requestId.slice(0, 8)}, ` +
        `当前等待=${queueStats.totalWaiting}, timeout=${request.options.timeout}ms`
    );

    // 列出所有浏览器的状态
    const browsers = this.globalPool.listBrowsers();
    logger.warn(
      `[doAcquire] 📋 当前浏览器: ` +
        browsers
          .map(
            (b) =>
              `${b.id.slice(0, 8)}(${b.status},session=${b.sessionId},` +
              `locked=${b.lockedAt ? Math.round((Date.now() - b.lockedAt) / 1000) + 's' : 'N/A'})`
          )
          .join(', ')
    );

    if (request.options.signal?.aborted) {
      return {
        success: false,
        error: getAbortMessage(request.options.signal, 'Acquire cancelled'),
        waitedMs: Date.now() - startTime,
      };
    }

    let abortListener: (() => void) | null = null;
    try {
      const waitPromise = this.waitQueue.enqueue(request);
      if (request.options.signal) {
        abortListener = () => {
          this.waitQueue.cancelRequest(
            request.requestId,
            getAbortMessage(request.options.signal, 'Acquire cancelled')
          );
        };
        request.options.signal.addEventListener('abort', abortListener, { once: true });
      }
      return await waitPromise;
    } finally {
      if (abortListener && request.options.signal) {
        request.options.signal.removeEventListener('abort', abortListener);
      }
    }
  }

  /**
   * 尝试从池中获取浏览器
   *
   * 注意：GlobalPool 内部有锁保护，这里不需要额外加锁
   * 即使 acquireIdle 和 lockBrowser 之间有竞态，lockBrowser 会检查状态并返回 false
   */
  private async tryAcquireFromPool(
    request: AcquireRequest,
    session: SessionConfig
  ): Promise<ReturnType<typeof this.globalPool.acquireIdle>> {
    let pooledBrowser;
    const engine = request.options.engine ?? session.engine ?? 'electron';

    if (request.options.strategy === 'specific' && request.options.browserId) {
      // 指定浏览器
      pooledBrowser = await this.globalPool.acquireSpecific(request.options.browserId);
      // 防御性校验：specific 必须仍然属于当前 session + engine，避免跨会话/跨引擎误用
      if (
        pooledBrowser &&
        (pooledBrowser.sessionId !== session.id || pooledBrowser.engine !== engine)
      ) {
        logger.warn(
          `[tryAcquireFromPool] specific browserId does not match session/engine, ignoring: ` +
            `browserId=${pooledBrowser.id}, browserSession=${pooledBrowser.sessionId}, requestSession=${session.id}, ` +
            `browserEngine=${pooledBrowser.engine}, requestEngine=${engine}`
        );
        pooledBrowser = undefined;
      }
    } else {
      // 按策略选择
      pooledBrowser = await this.globalPool.acquireIdle(
        session.id,
        engine,
        request.options.strategy
      );
    }

    if (pooledBrowser) {
      // 锁定浏览器
      const lockInfo: LockInfo = {
        requestId: request.requestId,
        pluginId: request.pluginId,
        source: request.source,
        timeoutMs: request.options.lockTimeout ?? session.lockTimeoutMs,
      };

      const locked = await this.globalPool.lockBrowser(pooledBrowser.id, lockInfo);
      if (locked) {
        const lockedBrowser = this.globalPool.getBrowser(pooledBrowser.id);
        if (lockedBrowser && isReadyBrowser(lockedBrowser)) {
          if (isBrowserControllerClosed(lockedBrowser.browser)) {
            logger.warn(
              `[tryAcquireFromPool] Discarding closed pooled browser: ${pooledBrowser.id} (session=${session.id}, engine=${engine})`
            );
            await this.globalPool.destroyBrowser(pooledBrowser.id);
            return undefined;
          }
        }
        return pooledBrowser;
      }
    }

    return undefined;
  }

  /**
   * 尝试创建新浏览器
   *
   * 配额检查逻辑：
   * 1. 先在 PoolManager 层检查 Session 配额（快速失败）
   * 2. GlobalPool.createBrowser 内部会在锁内双重检查全局限制（解决 TOCTOU）
   */
  private async tryCreateBrowser(
    request: AcquireRequest,
    session: SessionConfig
  ): Promise<ReturnType<typeof this.globalPool.createBrowser> | undefined> {
    const engine = request.options.engine ?? session.engine ?? 'electron';
    session.engine = engine;
    // 快速检查：全局是否已满（非原子，仅用于快速失败）
    if (this.globalPool.isGlobalFull()) {
      const stats = this.globalPool.getStats();
      const poolConfig = this.getConfig();
      logger.warn(
        `[tryCreateBrowser] ❌ 全局池已满: ${stats.total}/${poolConfig.maxTotalBrowsers}, ` +
          `空闲=${stats.idle}, 锁定=${stats.locked}`
      );
      return undefined;
    }

    // 单实例模型：同一 profile 只允许保留一个 live browser instance。
    const sessionBrowsers = this.globalPool.getSessionBrowserCount(session.id);
    if (sessionBrowsers.total > 0) {
      logger.warn(
        `[tryCreateBrowser] ❌ Profile ${session.id} already has a live browser instance: ` +
          `当前=${sessionBrowsers.total}/1, ` +
          `空闲=${sessionBrowsers.idle}, 锁定=${sessionBrowsers.locked}`
      );
      return undefined;
    }

    try {
      // 创建新浏览器（GlobalPool 内部有双重检查保证原子性）
      const pooledBrowser = await this.globalPool.createBrowser(session);

      // 锁定浏览器
      const lockInfo: LockInfo = {
        requestId: request.requestId,
        pluginId: request.pluginId,
        source: request.source,
        timeoutMs: request.options.lockTimeout ?? session.lockTimeoutMs,
      };

      const locked = await this.globalPool.lockBrowser(pooledBrowser.id, lockInfo);
      if (!locked) {
        // 极端竞态：创建完成到锁定之间被其他请求抢占
        logger.warn(
          `[tryCreateBrowser] Created browser but failed to lock due to race: ${pooledBrowser.id}`
        );
        return undefined;
      }

      return pooledBrowser;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      if (isNonRetryableEngineCreateError(engine, error)) {
        logger.error(
          `[tryCreateBrowser] Non-retryable ${engine} create failure: ${message}`
        );
        throw new AcquireFailedError(message);
      }

      // 可能是全局限制达到（并发创建时的正常情况）
      logger.warn(`Cannot create browser: ${message}`);
      return undefined;
    }
  }

  /**
   * 迭代处理等待队列（避免递归导致的栈溢出）
   *
   * 当浏览器被销毁后调用，尝试为等待者创建新浏览器
   */
  private async processWaitQueueIterative(sessionId: string): Promise<void> {
    // 使用迭代而非递归，避免深度递归导致的栈溢出
    const maxIterations = 100; // 安全限制
    let iterations = 0;

    while (iterations < maxIterations) {
      const waitingRequestCandidates = await Promise.all(
        AUTOMATION_ENGINES.map(async (engine) => await this.waitQueue.peek(sessionId, engine))
      );
      const waitingRequest = waitingRequestCandidates
        .filter((value): value is NonNullable<(typeof waitingRequestCandidates)[number]> =>
          Boolean(value)
        )
        .sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt)[0];

      if (!waitingRequest) break;

      const profile = await this.profileService.get(sessionId);
      if (!profile) {
        // Profile 不存在，取消所有该 session 的等待请求
        this.waitQueue.cancelBySession(sessionId, 'Profile not found');
        break;
      }
      const session = this.toSessionConfig(profile);

      // 尝试为等待者获取或创建浏览器
      const pooledBrowser = await this.tryAcquireFromPool(waitingRequest.request, session);

      if (pooledBrowser) {
        // 成功获取，从队列中移除并通知等待者
        const engine = waitingRequest.request.options.engine ?? 'electron';
        const dequeued = await this.waitQueue.dequeue(sessionId, engine);
        if (dequeued) {
          dequeued.resolve({
            success: true,
            browser: pooledBrowser.browser,
            browserId: pooledBrowser.id,
            sessionId: session.id,
            waitedMs: Date.now() - dequeued.enqueuedAt,
          });
        }
      } else {
        // 尝试创建新浏览器
        const newBrowser = await this.tryCreateBrowser(waitingRequest.request, session);

        if (newBrowser) {
          const engine = waitingRequest.request.options.engine ?? 'electron';
          const dequeued = await this.waitQueue.dequeue(sessionId, engine);
          if (dequeued) {
            dequeued.resolve({
              success: true,
              browser: newBrowser.browser,
              browserId: newBrowser.id,
              sessionId: session.id,
              waitedMs: Date.now() - dequeued.enqueuedAt,
            });
          }
        } else {
          // 无法获取也无法创建，继续尝试下一个等待者（锁失败重试）
          // 而不是 break，这样可以处理锁失败的情况
          iterations++;
          continue;
        }
      }

      iterations++;
    }

    if (iterations >= maxIterations) {
      logger.warn('processWaitQueueIterative reached max iterations for session: ' + sessionId);
    }
  }

  // ============================================
  // 浏览器查询与销毁（统一接口）
  // ============================================

  /**
   * 按 ID 获取浏览器实例
   *
   * 统一的浏览器查询接口，推荐使用此方法替代直接访问 GlobalPool。
   *
   * @param browserId 浏览器 ID
   * @returns 浏览器实例，如果未找到或状态不可用则返回 null
   *
   * @example
   * ```typescript
   * const browser = poolManager.getBrowserById(browserId);
   * if (browser) {
   *   await browser.goto('https://example.com');
   * }
   * ```
   */
  getBrowserById(browserId: string): BrowserInterface | null {
    const pooledBrowser = this.globalPool.getBrowser(browserId);
    if (!pooledBrowser || !isReadyBrowser(pooledBrowser)) {
      return null;
    }
    return pooledBrowser.browser;
  }

  /**
   * 按 Profile ID 获取所有浏览器实例
   *
   * @param profileId Profile ID
   * @returns 浏览器实例数组
   *
   * @example
   * ```typescript
   * const browsers = poolManager.getBrowsersByProfile('my-profile');
   * for (const browser of browsers) {
   *   await browser.goto('about:blank');
   * }
   * ```
   */
  getBrowsersByProfile(profileId: string): BrowserInterface[] {
    return this.globalPool
      .listBrowsers()
      .filter((b): b is ReadyBrowser => b.sessionId === profileId && isReadyBrowser(b))
      .map((b) => b.browser);
  }

  /**
   * 销毁指定浏览器
   *
   * 统一的浏览器销毁接口。与 release({ destroy: true }) 不同，
   * 此方法不要求浏览器处于锁定状态。
   *
   * @param browserId 浏览器 ID
   *
   * @example
   * ```typescript
   * // 强制销毁浏览器（不管状态）
   * await poolManager.destroyBrowser(browserId);
   * ```
   */
  async destroyBrowser(browserId: string): Promise<void> {
    const browser = this.globalPool.getBrowser(browserId);
    if (!browser) {
      logger.warn('Browser not found for destroy: ' + browserId);
      return;
    }

    const sessionId = browser.sessionId;

    // 发射事件
    this.eventEmitter.emit('browser:released', {
      browserId,
      sessionId,
      pluginId: browser.lockedBy?.pluginId,
      destroy: true,
    });

    // 销毁浏览器
    await this.globalPool.destroyBrowser(browserId);

    // 处理等待队列
    await this.processWaitQueueIterative(sessionId);

    const stats = this.globalPool.getSessionBrowserCount(sessionId);
    if (stats.total === 0) {
      try {
        await this.profileService.updateStatus(sessionId, 'idle');
      } catch (err) {
        logger.warn('[BrowserPoolManager] Failed to update profile status to idle after destroy', {
          sessionId,
          browserId,
          err,
        });
      }
    }

    logger.info('Browser destroyed: ' + browserId);
  }

  // ============================================
  // 调试方法
  // ============================================

  /**
   * 获取等待队列统计
   */
  getWaitQueueStats() {
    return this.waitQueue.getStats();
  }

  /**
   * 获取全局池统计
   */
  getGlobalPoolStats() {
    return this.globalPool.getStats();
  }

  /**
   * 列出所有浏览器（调试用）
   */
  listBrowsers() {
    return this.globalPool.listBrowsers();
  }
}

// ============================================
// 单例导出
// ============================================

let instance: BrowserPoolManager | null = null;

/**
 * 初始化浏览器池管理器单例
 *
 * 必须在应用启动时调用，传入获取 ProfileService 的函数
 *
 * @param getProfileService 获取 ProfileService 的函数
 */
export function initBrowserPoolManager(
  getProfileService: () => ProfileService
): BrowserPoolManager {
  if (instance) {
    logger.warn('Already initialized');
    return instance;
  }

  instance = new BrowserPoolManager(getProfileService);
  return instance;
}

/**
 * 获取浏览器池管理器单例
 *
 * 必须先调用 initBrowserPoolManager()
 */
export function getBrowserPoolManager(): BrowserPoolManager {
  if (!instance) {
    throw new PoolNotInitializedError();
  }
  return instance;
}

/**
 * 重置单例（仅用于测试）
 */
export function resetBrowserPoolManager(): void {
  if (instance) {
    instance.stop().catch((err) => logger.error('Failed to stop pool manager', err));
    instance = null;
  }
}
