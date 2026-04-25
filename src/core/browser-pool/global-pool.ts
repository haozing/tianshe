/**
 * 全局浏览器池
 *
 * 管理所有浏览器实例，提供：
 * - 浏览器创建/销毁
 * - 锁定/释放
 * - 空闲超时驱逐
 * - 锁定超时自动释放
 * - 健康检查
 * - 插件资源清理
 *
 * 设计原则：
 * - 全局单例：所有浏览器共享一个池
 * - 单实例约束：每个 Profile 同时只保留一个 live browser instance
 * - 并发控制：限制同时创建的浏览器数量
 */

import { v4 as uuidv4 } from 'uuid';
import { Mutex, Semaphore } from 'async-mutex';
import { createLogger } from '../logger';
import type {
  PooledBrowser,
  CreatingBrowser,
  ReadyBrowser,
  DestroyingBrowser,
  LockInfo,
  AcquireStrategy,
  ReleaseOptions,
  SessionConfig,
  AutomationEngine,
  PooledBrowserController,
} from './types';
import { isReadyBrowser, hasBrowserInstance } from './types';
import {
  DEFAULT_BROWSER_POOL_CONFIG,
  type BrowserPoolConfig,
  BROWSER_FACTORY_TIMEOUT_MS,
} from '../../constants/browser-pool';
import { resetBrowserState } from './utils';
import {
  FactoryNotSetError,
  SessionLimitExceededError,
  BrowserFactoryTimeoutError,
} from '../errors/BrowserPoolError';

/**
 * 浏览器创建工厂函数类型
 *
 * 返回 PooledBrowserController，提供完整的浏览器功能与统一销毁能力
 */
export type BrowserFactory = (session: SessionConfig) => Promise<{
  browser: PooledBrowserController;
  engine: AutomationEngine;
  viewId?: string;
}>;

/**
 * 浏览器销毁函数类型
 *
 * 接收 PooledBrowserController，调用其 closeInternal 进行清理
 */
export type BrowserDestroyer = (browser: PooledBrowserController, viewId?: string) => Promise<void>;
export type SessionBrowsersChangedCallback = (sessionId: string) => Promise<void> | void;

const logger = createLogger('GlobalPool');

/**
 * 全局浏览器池
 */
export class GlobalPool {
  /** 所有浏览器实例 */
  private browsers: Map<string, PooledBrowser> = new Map();

  /** 操作互斥锁 */
  private mutex = new Mutex();

  /** 创建限流信号量（初始化时会根据配置重新设置） */
  private creationSemaphore: Semaphore;

  /** 创建中的工厂 Promise（用于超时/取消后的资源回收） */
  private pendingFactoryPromises: Map<string, Promise<Awaited<ReturnType<BrowserFactory>>>> =
    new Map();

  /** 标记“创建中已被 destroy() 取消”的 browserId（用于避免重复回收） */
  private cancelledCreatingBrowsers: Set<string> = new Set();

  /** Profile 正在销毁中的计数（避免销毁完成前被并发重建） */
  private sessionDestroying: Map<string, number> = new Map();

  /** 浏览器创建工厂 */
  private browserFactory?: BrowserFactory;

  /** 浏览器销毁函数 */
  private browserDestroyer?: BrowserDestroyer;

  /** 健康检查定时器 */
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  /** Session 浏览器集合变化回调 */
  private sessionBrowsersChangedCallback?: SessionBrowsersChangedCallback;

  /** 是否已停止 */
  private stopped = false;

  /** 配置（可动态更新） */
  private config: BrowserPoolConfig = { ...DEFAULT_BROWSER_POOL_CONFIG };

  constructor() {
    this.creationSemaphore = new Semaphore(this.config.maxConcurrentCreation);
  }

  private markSessionDestroying(sessionId: string): void {
    const current = this.sessionDestroying.get(sessionId) ?? 0;
    this.sessionDestroying.set(sessionId, current + 1);
  }

  private unmarkSessionDestroying(sessionId: string): void {
    const current = this.sessionDestroying.get(sessionId) ?? 0;
    if (current <= 1) {
      this.sessionDestroying.delete(sessionId);
    } else {
      this.sessionDestroying.set(sessionId, current - 1);
    }
  }

  private isSessionDestroying(sessionId: string): boolean {
    return (this.sessionDestroying.get(sessionId) ?? 0) > 0;
  }

  /**
   * 更新配置
   *
   * 注意：如果 maxConcurrentCreation 改变，会重新创建信号量。
   * 正在等待的请求会继续使用旧信号量直到完成。
   */
  setConfig(config: Partial<BrowserPoolConfig>): void {
    const oldMaxConcurrent = this.config.maxConcurrentCreation;
    this.config = { ...this.config, ...config };

    // 只有当 maxConcurrentCreation 真正改变时才重新创建信号量
    if (
      config.maxConcurrentCreation !== undefined &&
      config.maxConcurrentCreation !== oldMaxConcurrent
    ) {
      // 保留旧信号量的引用，让正在等待的请求完成
      // 新请求将使用新的信号量
      this.creationSemaphore = new Semaphore(this.config.maxConcurrentCreation);
    }

    logger.info('Config updated', {
      maxTotalBrowsers: this.config.maxTotalBrowsers,
      maxConcurrentCreation: this.config.maxConcurrentCreation,
    });
  }

  /**
   * 获取当前配置
   */
  getConfig(): BrowserPoolConfig {
    return { ...this.config };
  }

  /**
   * 设置浏览器工厂
   */
  setBrowserFactory(factory: BrowserFactory): void {
    this.browserFactory = factory;
  }

  /**
   * 设置浏览器销毁函数
   */
  setBrowserDestroyer(destroyer: BrowserDestroyer): void {
    this.browserDestroyer = destroyer;
  }

  /**
   * 设置 Session 浏览器集合变化回调
   *
   * 用于上层同步 Profile 运行状态。
   */
  setSessionBrowsersChangedCallback(callback?: SessionBrowsersChangedCallback): void {
    this.sessionBrowsersChangedCallback = callback;
  }

  private async notifySessionBrowsersChanged(sessionId?: string): Promise<void> {
    if (!sessionId || !this.sessionBrowsersChangedCallback) {
      return;
    }

    try {
      await this.sessionBrowsersChangedCallback(sessionId);
    } catch (error) {
      logger.warn(`Session browsers changed callback failed: ${sessionId}`, error);
    }
  }

  /**
   * 启动健康检查
   */
  startHealthCheck(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      this.runHealthCheck().catch((err) => {
        logger.error('Health check failed', err);
      });
    }, this.config.healthCheckIntervalMs);

    logger.info('Health check started');
  }

  /**
   * 停止健康检查
   */
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
      logger.info('Health check stopped');
    }
  }

  /**
   * 获取空闲浏览器
   *
   * @param sessionId 目标会话ID
   * @param strategy 选择策略
   * @returns 空闲浏览器（ReadyBrowser）或 undefined
   */
  async acquireIdle(
    sessionId: string,
    engine: AutomationEngine,
    strategy: AcquireStrategy = 'any'
  ): Promise<ReadyBrowser | undefined> {
    return this.mutex.runExclusive(() => {
      // 只筛选 idle 状态的 ReadyBrowser
      const candidates = Array.from(this.browsers.values()).filter(
        (b): b is ReadyBrowser =>
          b.sessionId === sessionId && b.engine === engine && b.status === 'idle'
      );

      if (candidates.length === 0) {
        return undefined;
      }

      switch (strategy) {
        case 'fresh':
          // 优先选择使用次数少的
          return candidates.sort((a, b) => a.useCount - b.useCount)[0];

        case 'reuse':
          // 优先选择使用次数多的（可能有缓存）
          return candidates.sort((a, b) => b.useCount - a.useCount)[0];

        case 'any':
        default:
          // 随机选择，避免热点
          return candidates[Math.floor(Math.random() * candidates.length)];
      }
    });
  }

  /**
   * 获取指定浏览器
   *
   * @param browserId 浏览器ID
   * @returns 空闲浏览器（ReadyBrowser）或 undefined
   */
  async acquireSpecific(browserId: string): Promise<ReadyBrowser | undefined> {
    return this.mutex.runExclusive(() => {
      const browser = this.browsers.get(browserId);
      // 使用类型守卫确保返回 ReadyBrowser
      return browser && browser.status === 'idle' ? (browser as ReadyBrowser) : undefined;
    });
  }

  /**
   * 创建新浏览器
   *
   * @param session 会话配置
   * @returns 新创建的浏览器（ReadyBrowser 类型，状态为 idle）
   */
  async createBrowser(session: SessionConfig): Promise<ReadyBrowser> {
    if (!this.browserFactory) {
      throw new FactoryNotSetError();
    }

    if (this.stopped) {
      throw new Error('GlobalPool is stopped');
    }

    const engine: AutomationEngine = session.engine ?? 'electron';

    // 获取创建许可（限流）
    const [, releasePermit] = await this.creationSemaphore.acquire();

    // 提前生成 browserId，以便在 catch 块中访问
    const browserId = uuidv4();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let factoryPromise: Promise<Awaited<ReturnType<BrowserFactory>>> | undefined;

    try {
      // 在锁内进行双重检查（解决 TOCTOU 问题）
      const release = await this.mutex.acquire();

      // 再次检查全局限制（获取 semaphore 期间可能有变化）
      if (this.browsers.size >= this.config.maxTotalBrowsers) {
        release();
        throw new SessionLimitExceededError('global', this.config.maxTotalBrowsers);
      }

      const hasExistingSessionBrowser = Array.from(this.browsers.values()).some(
        (browser) => browser.sessionId === session.id
      );
      if (hasExistingSessionBrowser || this.isSessionDestroying(session.id)) {
        release();
        throw new SessionLimitExceededError(session.id, 1);
      }

      // 先占位（status = creating，类型安全的占位）
      const placeholder: CreatingBrowser = {
        id: browserId,
        sessionId: session.id,
        engine,
        idleTimeoutMs: session.idleTimeoutMs,
        status: 'creating',
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        useCount: 0,
      };

      this.browsers.set(browserId, placeholder);
      release();

      logger.info(`Creating browser: ${browserId}`, { sessionId: session.id });

      // 实际创建（带超时保护，防止工厂永久挂起导致信号量泄漏）
      factoryPromise = this.browserFactory(session);
      this.pendingFactoryPromises.set(browserId, factoryPromise);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new BrowserFactoryTimeoutError(BROWSER_FACTORY_TIMEOUT_MS, session.id));
        }, BROWSER_FACTORY_TIMEOUT_MS);
      });

      const {
        browser,
        viewId,
        engine: createdEngine,
      } = await Promise.race([factoryPromise, timeoutPromise]);

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      // 创建完成后，确认仍需要将浏览器加入池（避免 stop/destroy 期间“复活”浏览器）
      let readyBrowser: ReadyBrowser | null = null;
      let shouldDestroyCreated = false;

      const release2 = await this.mutex.acquire();
      try {
        const current = this.browsers.get(browserId);
        if (!this.stopped && current && current.status === 'creating') {
          // 更新为就绪状态（ReadyBrowser 类型）
          readyBrowser = {
            id: browserId,
            sessionId: session.id,
            engine: createdEngine,
            idleTimeoutMs: session.idleTimeoutMs,
            browser,
            viewId,
            status: 'idle',
            createdAt: placeholder.createdAt,
            lastAccessedAt: Date.now(),
            useCount: 0,
          };
          this.browsers.set(browserId, readyBrowser);
        } else {
          // 创建期间已被 stop/destroy 取消：不要把创建出来的实例放回池
          shouldDestroyCreated = true;
          this.browsers.delete(browserId);
        }
      } finally {
        release2();
      }

      if (shouldDestroyCreated) {
        if (!this.cancelledCreatingBrowsers.has(browserId)) {
          await this.destroyCreatedBrowser(browser, viewId, 'creation-cancelled');
        }
        throw new Error('Browser creation cancelled');
      }

      logger.info(`Browser created: ${browserId}`);
      if (!readyBrowser) {
        throw new Error('Invariant violation: readyBrowser is null after successful creation');
      }
      return readyBrowser;
    } catch (error: any) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      // 创建失败，移除占位
      const release = await this.mutex.acquire();
      this.browsers.delete(browserId);
      release();

      if (error instanceof BrowserFactoryTimeoutError && factoryPromise) {
        // 超时后工厂仍可能在后台完成：必须回收已创建的资源，避免泄漏
        factoryPromise
          .then(async ({ browser, viewId }) => {
            await this.destroyCreatedBrowser(browser, viewId, 'factory-timeout');
          })
          .catch((innerError) => {
            logger.warn(`Browser factory promise rejected after timeout: ${browserId}`, innerError);
          });
      }

      logger.error(`Failed to create browser: ${error.message}`, error);
      throw error;
    } finally {
      this.pendingFactoryPromises.delete(browserId);
      releasePermit();
    }
  }

  private async destroyCreatedBrowser(
    browser: PooledBrowserController,
    viewId?: string,
    reason: string = 'unknown'
  ): Promise<void> {
    try {
      if (this.browserDestroyer) {
        await this.browserDestroyer(browser, viewId);
      } else {
        await browser.closeInternal();
      }
      logger.info(`Cleaned up created browser (${reason})`, { viewId });
    } catch (error: unknown) {
      logger.error(`Failed to cleanup created browser (${reason})`, error);
    }
  }

  /**
   * 锁定浏览器
   *
   * @param browserId 浏览器ID
   * @param lockInfo 锁定信息
   * @returns 是否锁定成功
   */
  async lockBrowser(browserId: string, lockInfo: LockInfo): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const browser = this.browsers.get(browserId);
      if (!browser || browser.status !== 'idle') {
        return false;
      }

      // 类型断言：status === 'idle' 确保是 ReadyBrowser
      const readyBrowser = browser as ReadyBrowser;

      // 创建锁定状态的浏览器（不可变更新）
      const lockedBrowser: ReadyBrowser = {
        id: readyBrowser.id,
        sessionId: readyBrowser.sessionId,
        engine: readyBrowser.engine,
        idleTimeoutMs: readyBrowser.idleTimeoutMs,
        browser: readyBrowser.browser,
        viewId: readyBrowser.viewId,
        status: 'locked',
        lockedBy: lockInfo,
        lockedAt: Date.now(),
        createdAt: readyBrowser.createdAt,
        lastAccessedAt: Date.now(),
        useCount: readyBrowser.useCount + 1,
      };
      this.browsers.set(browserId, lockedBrowser);

      logger.info(`Browser locked: ${browserId}`, {
        requestId: lockInfo.requestId,
        pluginId: lockInfo.pluginId || 'unknown',
      });

      return true;
    });
  }

  /**
   * 交接（handoff）浏览器锁定
   *
   * 用于“释放时直接转交给等待者”的场景：
   * - 允许 locked -> locked：替换 lockedBy/lockedAt（保持 locked 状态，不经过 idle）
   * - 允许 idle -> locked：等价于 lockBrowser（方便复用）
   *
   * @param browserId 浏览器ID
   * @param lockInfo 新的锁定信息
   * @returns 是否交接成功
   */
  async handoffLock(browserId: string, lockInfo: LockInfo): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const browser = this.browsers.get(browserId);
      if (!browser || browser.status === 'creating') {
        return false;
      }

      if (browser.status === 'idle') {
        const readyBrowser = browser as ReadyBrowser;
        const lockedBrowser: ReadyBrowser = {
          ...readyBrowser,
          status: 'locked',
          lockedBy: lockInfo,
          lockedAt: Date.now(),
          lastAccessedAt: Date.now(),
          useCount: readyBrowser.useCount + 1,
        };
        this.browsers.set(browserId, lockedBrowser);
        return true;
      }

      if (browser.status === 'locked') {
        const lockedBrowser = browser as ReadyBrowser;
        const handedOff: ReadyBrowser = {
          ...lockedBrowser,
          lockedBy: lockInfo,
          lockedAt: Date.now(),
          lastAccessedAt: Date.now(),
          useCount: lockedBrowser.useCount + 1,
        };
        this.browsers.set(browserId, handedOff);
        return true;
      }

      // destroying 状态不应再交接
      return false;
    });
  }

  /**
   * 续期浏览器锁定
   *
   * 延长锁定时间，防止长时间操作被超时释放
   *
   * @param browserId 浏览器ID
   * @param extensionMs 延长时间（ms），如果不指定则使用原始 timeoutMs
   * @returns 是否续期成功
   */
  async renewLock(browserId: string, extensionMs?: number): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const browser = this.browsers.get(browserId);
      if (!browser) {
        logger.warn(`Cannot renew lock: browser not found: ${browserId}`);
        return false;
      }

      if (browser.status !== 'locked' || !browser.lockedAt || !browser.lockedBy) {
        logger.warn(`Cannot renew lock: browser not locked: ${browserId}`);
        return false;
      }

      // 类型断言：已验证 status === 'locked'
      const lockedBrowser = browser as ReadyBrowser;

      // 创建续期后的浏览器（不可变更新）
      const renewedBrowser: ReadyBrowser = {
        ...lockedBrowser,
        lockedAt: Date.now(),
        lockedBy:
          extensionMs !== undefined
            ? { ...lockedBrowser.lockedBy!, timeoutMs: extensionMs }
            : lockedBrowser.lockedBy,
      };
      this.browsers.set(browserId, renewedBrowser);

      logger.info(`Lock renewed: ${browserId}`, { timeoutMs: renewedBrowser.lockedBy?.timeoutMs });

      return true;
    });
  }

  /**
   * 释放浏览器
   *
   * @param browserId 浏览器ID
   * @param options 释放选项
   */
  async releaseBrowser(browserId: string, options?: ReleaseOptions): Promise<void> {
    const release = await this.mutex.acquire();

    let browserForReset: PooledBrowserController | undefined;
    let shouldMarkIdleAfterReset = false;
    let shouldDestroy = false;

    try {
      const browser = this.browsers.get(browserId);
      if (!browser) {
        logger.warn(`Browser not found: ${browserId}`);
        return; // finally 会释放锁
      }

      // 如果请求销毁，标记后在锁外执行
      if (options?.destroy) {
        shouldDestroy = true;
        // 不要 return，让 finally 执行后继续执行销毁逻辑
      } else if (isReadyBrowser(browser)) {
        // 在重置完成前保持非 idle，避免其他请求抢到尚未 reset 的实例。
        const resettingBrowser: ReadyBrowser = {
          id: browser.id,
          sessionId: browser.sessionId,
          engine: browser.engine,
          idleTimeoutMs: browser.idleTimeoutMs,
          browser: browser.browser,
          viewId: browser.viewId,
          status: 'locked',
          createdAt: browser.createdAt,
          lastAccessedAt: Date.now(),
          useCount: browser.useCount,
          lockedBy: undefined,
          lockedAt: undefined,
        };
        this.browsers.set(browserId, resettingBrowser);
        browserForReset = browser.browser;
        shouldMarkIdleAfterReset = true;
      }
    } finally {
      release();
    }

    // 锁外执行销毁
    if (shouldDestroy) {
      await this.destroyBrowser(browserId);
      return;
    }

    // 锁外执行重置（如果浏览器支持）
    if (browserForReset) {
      await resetBrowserState(browserForReset, options, '[GlobalPool]');
    }

    if (!shouldMarkIdleAfterReset) {
      return;
    }

    const finalizeRelease = await this.mutex.acquire();
    try {
      const current = this.browsers.get(browserId);
      if (
        current &&
        current.status === 'locked' &&
        hasBrowserInstance(current) &&
        current.browser === browserForReset &&
        !current.lockedBy
      ) {
        const releasedBrowser: ReadyBrowser = {
          ...current,
          status: 'idle',
          lastAccessedAt: Date.now(),
          lockedBy: undefined,
          lockedAt: undefined,
        };
        this.browsers.set(browserId, releasedBrowser);
        logger.info(`Browser released: ${browserId}`);
      }
    } finally {
      finalizeRelease();
    }
  }

  /**
   * 销毁浏览器
   *
   * @param browserId 浏览器ID
   */
  async destroyBrowser(browserId: string): Promise<void> {
    const release = await this.mutex.acquire();

    let browserToDestroy: { browser: PooledBrowserController; viewId?: string } | undefined;
    let destroyingSessionId: string | undefined;
    const pendingFactoryPromise = this.pendingFactoryPromises.get(browserId);

    try {
      const pooledBrowser = this.browsers.get(browserId);
      if (!pooledBrowser) {
        return;
      }

      destroyingSessionId = pooledBrowser.sessionId;
      this.markSessionDestroying(destroyingSessionId);

      // 只有有 browser 实例的才需要调用 destroyer
      if (hasBrowserInstance(pooledBrowser)) {
        browserToDestroy = {
          browser: pooledBrowser.browser,
          viewId: pooledBrowser.viewId,
        };
        const destroyingBrowser: DestroyingBrowser = {
          ...pooledBrowser,
          status: 'destroying',
          lockedBy: undefined,
          lockedAt: undefined,
        };
        this.browsers.set(browserId, destroyingBrowser);
      } else {
        // creating 占位直接移除，实际资源在 pendingFactoryPromise 完成后回收
        this.browsers.delete(browserId);
      }

      logger.info(`Destroying browser: ${browserId}`);
    } finally {
      release();
    }

    if (!browserToDestroy && pendingFactoryPromise) {
      // 正在创建中的浏览器：等待工厂完成后再回收资源，避免“孤儿”进程/视图泄漏
      this.cancelledCreatingBrowsers.add(browserId);
      pendingFactoryPromise
        .then(async ({ browser, viewId }) => {
          await this.destroyCreatedBrowser(browser, viewId, 'destroy-while-creating');
        })
        .catch((innerError) => {
          logger.warn(`Pending browser factory rejected: ${browserId}`, innerError);
        })
        .finally(() => {
          this.cancelledCreatingBrowsers.delete(browserId);
          if (destroyingSessionId) {
            this.unmarkSessionDestroying(destroyingSessionId);
          }
        });
      await this.notifySessionBrowsersChanged(destroyingSessionId);
      return;
    }

    // 在锁外执行销毁（可能耗时）
    if (browserToDestroy) {
      try {
        if (this.browserDestroyer) {
          await this.browserDestroyer(browserToDestroy.browser, browserToDestroy.viewId);
        } else {
          await browserToDestroy.browser.closeInternal();
        }
        logger.info(`Browser destroyed: ${browserId}`);
      } catch (err: unknown) {
        logger.error(`Failed to destroy browser: ${browserId}`, err);
      } finally {
        const releaseAfterDestroy = await this.mutex.acquire();
        try {
          const current = this.browsers.get(browserId);
          if (current?.status === 'destroying') {
            this.browsers.delete(browserId);
          }
        } finally {
          releaseAfterDestroy();
        }

        if (destroyingSessionId) {
          this.unmarkSessionDestroying(destroyingSessionId);
        }
      }
      await this.notifySessionBrowsersChanged(destroyingSessionId);
      return;
    }

    if (destroyingSessionId) {
      this.unmarkSessionDestroying(destroyingSessionId);
    }
    await this.notifySessionBrowsersChanged(destroyingSessionId);
  }

  /**
   * 空闲超时驱逐
   *
   * @param sessionId 目标会话ID（可选，不传则检查所有）
   * @param idleTimeoutMs 超时时间
   * @returns 驱逐的数量
   */
  async evictIdleTimeout(sessionId?: string, idleTimeoutMs?: number): Promise<number> {
    const release = await this.mutex.acquire();

    const toEvict: string[] = [];
    const now = Date.now();

    try {
      for (const browser of this.browsers.values()) {
        if (sessionId && browser.sessionId !== sessionId) continue;
        if (browser.status !== 'idle') continue;

        const timeout = idleTimeoutMs ?? browser.idleTimeoutMs ?? this.config.defaultIdleTimeoutMs;
        const idleTime = now - browser.lastAccessedAt;

        if (idleTime > timeout) {
          toEvict.push(browser.id);
        }
      }
    } finally {
      release();
    }

    // 在锁外执行销毁
    for (const browserId of toEvict) {
      await this.destroyBrowser(browserId);
      logger.info(`Evicted idle timeout browser: ${browserId}`);
    }

    return toEvict.length;
  }

  /**
   * 检查锁定超时
   *
   * 自动释放超时的锁定
   *
   * @returns 释放的数量
   */
  async checkLockTimeout(): Promise<number> {
    const release = await this.mutex.acquire();

    const toRelease: string[] = [];
    const now = Date.now();

    try {
      for (const browser of this.browsers.values()) {
        if (browser.status !== 'locked' || !browser.lockedAt || !browser.lockedBy) continue;

        const lockDuration = now - browser.lockedAt;
        const timeout = browser.lockedBy.timeoutMs || this.config.defaultLockTimeoutMs;

        if (lockDuration > timeout) {
          toRelease.push(browser.id);
          logger.warn(`Lock timeout detected: ${browser.id}`, {
            lockedForSeconds: Math.round(lockDuration / 1000),
          });
        }
      }
    } finally {
      release();
    }

    // 在锁外执行释放
    for (const browserId of toRelease) {
      await this.releaseBrowser(browserId, { navigateTo: 'about:blank' });
    }

    return toRelease.length;
  }

  /**
   * 释放插件持有的所有浏览器
   *
   * 在插件停止时调用，防止资源泄漏
   *
   * @param pluginId 插件ID
   * @returns 释放的数量
   */
  async releaseByPlugin(pluginId: string): Promise<number> {
    const release = await this.mutex.acquire();

    const toRelease: string[] = [];

    try {
      for (const browser of this.browsers.values()) {
        if (browser.status === 'locked' && browser.lockedBy?.pluginId === pluginId) {
          toRelease.push(browser.id);
        }
      }
    } finally {
      release();
    }

    // 在锁外执行释放
    for (const browserId of toRelease) {
      await this.releaseBrowser(browserId, { navigateTo: 'about:blank' });
      logger.info(`Released browser from stopped plugin: ${browserId}`);
    }

    return toRelease.length;
  }

  /**
   * 健康检查
   *
   * 检测并清理不健康的浏览器实例
   */
  async checkHealth(): Promise<number> {
    const toDestroy: string[] = [];
    const changedSessions = new Set<string>();
    let removedWithoutDestroyer = 0;

    await this.mutex.runExclusive(() => {
      for (const browser of this.browsers.values()) {
        // 跳过正在创建的（没有 browser 实例是正常的）
        if (browser.status === 'creating') continue;

        // 只检查有 browser 实例的浏览器（ReadyBrowser 或 DestroyingBrowser）
        if (!hasBrowserInstance(browser)) {
          // 理论上不会到达这里，但为了类型安全
          continue;
        }

        // 额外检查 browser.browser 是否为 null（测试场景可能设置为 null）
        // 使用 as any 绕过类型检查，因为测试可能手动设置为 null
        if ((browser.browser as any) === null) {
          this.browsers.delete(browser.id);
          changedSessions.add(browser.sessionId);
          removedWithoutDestroyer++;
          logger.warn(`Unhealthy browser (null instance): ${browser.id}`);
          continue;
        }

        // 检查是否已关闭（如果 SimpleBrowser 有 isClosed 方法）
        if (typeof (browser.browser as any).isClosed === 'function') {
          const isClosed = (browser.browser as any).isClosed();
          if (isClosed) {
            toDestroy.push(browser.id);
            logger.warn(`Unhealthy browser (closed): ${browser.id}`);
          }
        }
      }
    });

    // 锁外执行销毁（确保 view 等资源也能被清理）
    for (const browserId of toDestroy) {
      await this.destroyBrowser(browserId);
    }

    for (const sessionId of changedSessions) {
      await this.notifySessionBrowsersChanged(sessionId);
    }

    return toDestroy.length + removedWithoutDestroyer;
  }

  /**
   * 执行健康检查（定时任务）
   */
  private async runHealthCheck(): Promise<void> {
    if (this.stopped) return;

    // 1. 检查锁定超时
    const lockTimeoutCount = await this.checkLockTimeout();
    if (lockTimeoutCount > 0) {
      logger.info(`Released ${lockTimeoutCount} lock-timeout browser(s)`);
    }

    // 2. 检查空闲超时
    const idleTimeoutCount = await this.evictIdleTimeout();
    if (idleTimeoutCount > 0) {
      logger.info(`Evicted ${idleTimeoutCount} idle-timeout browser(s)`);
    }

    // 3. 健康检查
    const unhealthyCount = await this.checkHealth();
    if (unhealthyCount > 0) {
      logger.info(`Removed ${unhealthyCount} unhealthy browser(s)`);
    }
  }

  /**
   * 获取指定会话的浏览器数量
   *
   * 使用快照读取保证数据一致性（遍历的是某一时刻的完整副本）
   */
  getSessionBrowserCount(
    sessionId: string,
    engine?: AutomationEngine
  ): { total: number; idle: number; locked: number } {
    // 创建快照，确保遍历期间数据一致
    const snapshot = Array.from(this.browsers.values());

    let total = 0;
    let idle = 0;
    let locked = 0;

    for (const browser of snapshot) {
      if (browser.sessionId !== sessionId) continue;
      if (engine && browser.engine !== engine) continue;
      if (browser.status === 'destroying' || browser.status === 'creating') continue;

      total++;
      if (browser.status === 'idle') idle++;
      if (browser.status === 'locked') locked++;
    }

    return { total, idle, locked };
  }

  /**
   * 获取所有浏览器统计
   *
   * 使用快照读取保证数据一致性
   */
  getStats(): {
    total: number;
    idle: number;
    locked: number;
    creating: number;
    bySession: Record<string, { total: number; idle: number; locked: number }>;
  } {
    // 创建快照，确保遍历期间数据一致
    const snapshot = Array.from(this.browsers.values());

    const stats = { total: 0, idle: 0, locked: 0, creating: 0 };
    const bySession: Record<string, { total: number; idle: number; locked: number }> = {};

    for (const browser of snapshot) {
      if (browser.status === 'destroying') continue;

      // 全局统计
      stats.total++;
      if (browser.status === 'idle') stats.idle++;
      else if (browser.status === 'locked') stats.locked++;
      else if (browser.status === 'creating') stats.creating++;

      // 按 Session 统计（不包含 creating）
      if (browser.status !== 'creating') {
        const sessionStats = (bySession[browser.sessionId] ??= { total: 0, idle: 0, locked: 0 });
        sessionStats.total++;
        if (browser.status === 'idle') sessionStats.idle++;
        else if (browser.status === 'locked') sessionStats.locked++;
      }
    }

    return { ...stats, bySession };
  }

  /**
   * 获取全局限制
   */
  getGlobalLimit(): number {
    return this.config.maxTotalBrowsers;
  }

  /**
   * 检查全局是否已满
   */
  isGlobalFull(): boolean {
    return this.browsers.size >= this.config.maxTotalBrowsers;
  }

  /**
   * 停止池
   */
  async stop(): Promise<void> {
    if (this.stopped) return;

    this.stopped = true;

    logger.info('Stopping...');

    // 停止健康检查
    this.stopHealthCheck();

    // 销毁所有浏览器
    const browserIds = Array.from(this.browsers.keys());
    for (const browserId of browserIds) {
      await this.destroyBrowser(browserId);
    }

    logger.info('Stopped');
  }

  /**
   * 获取浏览器实例（用于调试）
   */
  getBrowser(browserId: string): PooledBrowser | undefined {
    return this.browsers.get(browserId);
  }

  /**
   * 列出所有浏览器（用于调试）
   */
  listBrowsers(): PooledBrowser[] {
    return Array.from(this.browsers.values());
  }
}
