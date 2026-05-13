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

import { createLogger } from '../logger';
import { GlobalPool, type BrowserFactory, type BrowserDestroyer } from './global-pool';
import {
  PoolStoppedError,
  AcquireFailedError,
  PoolNotInitializedError,
} from '../errors/BrowserPoolError';

const logger = createLogger('BrowserPoolManager');
import { DEFAULT_BROWSER_PROFILE, type BrowserPoolConfig } from '../../constants/browser-pool';
import { WaitQueue } from './wait-queue';
import { createBrowserPoolEventEmitter, type BrowserPoolEventEmitter } from './events';
import { AcquireSessionResolver, profileToSessionConfig } from './acquire-session-resolver';
import { AcquireRequestFactory } from './acquire-request-factory';
import { PoolReuseStrategy } from './pool-reuse-strategy';
import { BrowserCreationStrategy } from './browser-creation-strategy';
import { WaitQueueCoordinator } from './wait-queue-coordinator';
import { BrowserAcquireCoordinator } from './browser-acquire-coordinator';
import { PluginLeaseStrategy, type LockedBrowserOptions } from './plugin-lease-strategy';
import type {
  SessionConfig,
  AcquireRequest,
  AcquireOptions,
  BrowserInterface,
  ReleaseOptions,
  ReleaseResult,
  BrowserHandle,
  PoolStats,
  SessionStats,
  AcquireSource,
  ReadyBrowser,
} from './types';
import { isReadyBrowser } from './types';
import type { IProfileService } from '../../types/service-interfaces';

/** 默认获取选项 */

/**
 * 浏览器池管理器
 */
export class BrowserPoolManager {
  /** 全局浏览器池 */
  private globalPool: GlobalPool;

  /** 等待队列 */
  private waitQueue: WaitQueue;

  private requestFactory: AcquireRequestFactory;

  private sessionResolver: AcquireSessionResolver;

  private reuseStrategy: PoolReuseStrategy;

  private creationStrategy: BrowserCreationStrategy;

  private waitQueueCoordinator: WaitQueueCoordinator;

  private acquireCoordinator: BrowserAcquireCoordinator;

  private pluginLeaseStrategy: PluginLeaseStrategy;

  /** 事件发射器（生命周期随 Manager 管理） */
  private eventEmitter: BrowserPoolEventEmitter;

  /** 是否已初始化 */
  private initialized = false;

  /** 是否已停止 */
  private stopped = false;

  /** 获取 ProfileService 的函数 */
  private getProfileService: () => IProfileService;

  constructor(getProfileService: () => IProfileService) {
    this.getProfileService = getProfileService;
    this.globalPool = new GlobalPool();
    this.waitQueue = new WaitQueue();
    this.eventEmitter = createBrowserPoolEventEmitter();
    this.requestFactory = new AcquireRequestFactory();
    this.sessionResolver = new AcquireSessionResolver(getProfileService, (session, options) =>
      this.requestFactory.normalizeOptions(session, options)
    );
    this.reuseStrategy = new PoolReuseStrategy(this.globalPool);
    this.creationStrategy = new BrowserCreationStrategy(this.globalPool, () => this.getConfig());
    this.waitQueueCoordinator = new WaitQueueCoordinator(
      this.globalPool,
      this.waitQueue,
      getProfileService,
      this.reuseStrategy,
      this.creationStrategy
    );
    this.acquireCoordinator = new BrowserAcquireCoordinator(
      this.globalPool,
      this.reuseStrategy,
      this.creationStrategy,
      this.waitQueueCoordinator
    );
    this.pluginLeaseStrategy = new PluginLeaseStrategy(
      this.globalPool,
      getProfileService,
      this.requestFactory,
      (request, browserId, sessionId) => this.buildBrowserHandle(request, browserId, sessionId),
      (request, browserId, sessionId, waitedMs) =>
        this.emitBrowserAcquired(request, browserId, sessionId, waitedMs),
      (sessionId, browserId) => this.markProfileActive(sessionId, browserId)
    );
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
  private get profileService(): IProfileService {
    return this.getProfileService();
  }

  /**
   * 将 Profile 转换为 SessionConfig
   * 类型已统一，直接使用 fingerprint 无需转换
   */
      // 浏览器运行时统一为单 Profile 单实例。
  private toSessionConfig = profileToSessionConfig;

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
      runtimeId: pooledBrowser.runtimeId,
      runtimeDescriptor: pooledBrowser.runtimeDescriptor,
      resolvedRuntime: pooledBrowser.resolvedRuntime,
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
    const { session, options: acquireOptions } = await this.sessionResolver.resolve(
      profileId,
      options
    );

    // 合并选项
    // 创建请求
    const request = this.requestFactory.create(session, acquireOptions, source, pluginId);

    // 执行获取
    const result = await this.acquireCoordinator.acquire(request, session);

    // 利用判别联合类型收窄：检查 success 后，TypeScript 自动推断成功分支的类型
    if (!result.success) {
      throw new AcquireFailedError(result.error || 'Unknown error');
    }

    // 此处 result 的类型已收窄为 AcquireResultSuccess
    const handle = this.buildBrowserHandle(request, result.browserId, result.sessionId);
    this.emitBrowserAcquired(request, result.browserId, result.sessionId, result.waitedMs);
    await this.markProfileActive(result.sessionId, result.browserId);

    // 获取 viewId（从池中的浏览器信息）
    // 创建 BrowserHandle
        // 绑定 requestId，用于校验锁定所有权，避免 stale handle 误释放/误交接
        // 绑定 requestId，用于校验锁定所有权，避免 stale handle 误续期

    // 发射 browser:acquired 事件
    // 🆕 统一同步 Profile 状态：只要成功 acquire，就认为该 Profile 正在运行
    return handle;
  }

  async adoptSamePluginLockedBrowser(
    profileId: string | undefined,
    options?: LockedBrowserOptions,
    source: AcquireSource = 'internal',
    pluginId?: string
  ): Promise<BrowserHandle | null> {
    return this.pluginLeaseStrategy.adoptSamePluginLockedBrowser(
      profileId,
      options,
      source,
      pluginId
    );
  }

  async takeoverLockedBrowser(
    profileId: string | undefined,
    options?: LockedBrowserOptions,
    source: AcquireSource = 'mcp',
    pluginId?: string
  ): Promise<BrowserHandle | null> {
    if (this.stopped) {
      throw new PoolStoppedError();
    }

    return this.pluginLeaseStrategy.takeoverLockedBrowser(
      profileId,
      options,
      source,
      pluginId
    );
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
      await this.acquireCoordinator.processWaitQueue(sessionId);
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
    const waitingRequest = await this.waitQueue.dequeue(sessionId, browser.runtimeId);
    if (waitingRequest) {
      // 有等待者，直接转移浏览器（不经过 idle 状态，避免竞态）
      await this.waitQueueCoordinator.transferBrowserToWaiter(browserId, waitingRequest, options);
    } else {
      // 没有等待者，正常释放到池中
      await this.globalPool.releaseBrowser(browserId, options);
      // reset 期间新进入队列的请求需要在这里补一次分配。
      await this.acquireCoordinator.processWaitQueue(sessionId);
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
      await this.acquireCoordinator.processWaitQueue(sessionId);
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
    await this.acquireCoordinator.processWaitQueue(sessionId);

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

export function createBrowserPoolManager(
  getProfileService: () => IProfileService
): BrowserPoolManager {
  return new BrowserPoolManager(getProfileService);
}

/**
 * 初始化浏览器池管理器单例
 *
 * 必须在应用启动时调用，传入获取 ProfileService 的函数
 *
 * @param getProfileService 获取 ProfileService 的函数
 */
export function initBrowserPoolManager(
  getProfileService: () => IProfileService
): BrowserPoolManager {
  if (instance) {
    logger.warn('Already initialized');
    return instance;
  }

  instance = createBrowserPoolManager(getProfileService);
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
export async function resetBrowserPoolManager(): Promise<void> {
  const manager = instance;
  instance = null;

  if (manager) {
    await manager.stop();
  }
}
