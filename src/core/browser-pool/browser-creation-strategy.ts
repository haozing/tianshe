import { createLogger } from '../logger';
import { AcquireFailedError } from '../errors/BrowserPoolError';
import { isNonRetryableEngineCreateError } from './browser-engine-create-policy';
import type { GlobalPool } from './global-pool';
import type { AcquireRequest, LockInfo, ReadyBrowser, SessionConfig } from './types';

const logger = createLogger('BrowserCreationStrategy');

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class BrowserCreationStrategy {
  constructor(
    private readonly globalPool: GlobalPool,
    private readonly getPoolConfig: () => { maxTotalBrowsers: number }
  ) {}

  async create(request: AcquireRequest, session: SessionConfig): Promise<ReadyBrowser | undefined> {
    const engine = request.options.engine ?? session.engine ?? 'electron';
    session.engine = engine;

    if (this.globalPool.isGlobalFull()) {
      const stats = this.globalPool.getStats();
      const poolConfig = this.getPoolConfig();
      logger.warn(
        `[tryCreateBrowser] ❌ 全局池已满: ${stats.total}/${poolConfig.maxTotalBrowsers}, ` +
          `空闲=${stats.idle}, 锁定=${stats.locked}`
      );
      return undefined;
    }

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
      const pooledBrowser = await this.globalPool.createBrowser(session);
      const lockInfo: LockInfo = {
        requestId: request.requestId,
        pluginId: request.pluginId,
        source: request.source,
        timeoutMs: request.options.lockTimeout ?? session.lockTimeoutMs,
      };

      const locked = await this.globalPool.lockBrowser(pooledBrowser.id, lockInfo);
      if (!locked) {
        logger.warn(
          `[tryCreateBrowser] Created browser but failed to lock due to race: ${pooledBrowser.id}`
        );
        return undefined;
      }

      return pooledBrowser;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      if (isNonRetryableEngineCreateError(engine, error)) {
        logger.error(`[tryCreateBrowser] Non-retryable ${engine} create failure: ${message}`);
        throw new AcquireFailedError(message);
      }

      logger.warn(`Cannot create browser: ${message}`);
      return undefined;
    }
  }
}
