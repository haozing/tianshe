import { createLogger } from '../logger';
import type { GlobalPool } from './global-pool';
import type { PoolReuseStrategy } from './pool-reuse-strategy';
import type { BrowserCreationStrategy } from './browser-creation-strategy';
import type { WaitQueueCoordinator } from './wait-queue-coordinator';
import type { AcquireRequest, AcquireResult, SessionConfig } from './types';

const logger = createLogger('BrowserAcquireCoordinator');

export class BrowserAcquireCoordinator {
  constructor(
    private readonly globalPool: GlobalPool,
    private readonly reuseStrategy: PoolReuseStrategy,
    private readonly creationStrategy: BrowserCreationStrategy,
    private readonly waitQueueCoordinator: WaitQueueCoordinator
  ) {}

  async acquire(request: AcquireRequest, session: SessionConfig): Promise<AcquireResult> {
    const startTime = Date.now();

    const stats = this.globalPool.getStats();
    const poolConfig = this.globalPool.getConfig();
    logger.info(
      `[doAcquire] 开始获取浏览器: session=${session.id}, plugin=${request.pluginId}, ` +
        `池状态: 总数=${stats.total}/${poolConfig.maxTotalBrowsers}, 空闲=${stats.idle}, 锁定=${stats.locked}`
    );

    let pooledBrowser = await this.reuseStrategy.acquire(request, session);
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

    logger.info('[doAcquire] 无空闲浏览器，尝试创建新浏览器...');
    pooledBrowser = await this.creationStrategy.create(request, session);
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

    const queueStats = this.waitQueueCoordinatorStats();
    logger.warn(
      `[doAcquire] ⚠️ 无法创建浏览器，进入等待队列: request=${request.requestId.slice(0, 8)}, ` +
        `当前等待=${queueStats.totalWaiting}, timeout=${request.options.timeout}ms`
    );

    const browsers = this.globalPool.listBrowsers();
    logger.warn(
      `[doAcquire] 📋 当前浏览器: ` +
        browsers
          .map(
            (browser) =>
              `${browser.id.slice(0, 8)}(${browser.status},session=${browser.sessionId},` +
              `locked=${browser.lockedAt ? Math.round((Date.now() - browser.lockedAt) / 1000) + 's' : 'N/A'})`
          )
          .join(', ')
    );

    return this.waitQueueCoordinator.waitForBrowser(request, session, startTime);
  }

  async processWaitQueue(sessionId: string): Promise<void> {
    await this.waitQueueCoordinator.process(sessionId);
  }

  private waitQueueCoordinatorStats(): { totalWaiting: number } {
    return this.waitQueueCoordinator.getStats();
  }
}
