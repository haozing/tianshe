import { createLogger } from '../logger';
import type { GlobalPool } from './global-pool';
import type { AcquireRequest, LockInfo, ReadyBrowser, SessionConfig } from './types';
import { isReadyBrowser } from './types';

const logger = createLogger('PoolReuseStrategy');

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

export class PoolReuseStrategy {
  constructor(private readonly globalPool: GlobalPool) {}

  async acquire(request: AcquireRequest, session: SessionConfig): Promise<ReadyBrowser | undefined> {
    let pooledBrowser: ReadyBrowser | undefined;
    const engine = request.options.engine ?? session.engine ?? 'electron';

    if (request.options.strategy === 'specific' && request.options.browserId) {
      pooledBrowser = await this.globalPool.acquireSpecific(request.options.browserId);
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
      pooledBrowser = await this.globalPool.acquireIdle(
        session.id,
        engine,
        request.options.strategy
      );
    }

    if (!pooledBrowser) {
      return undefined;
    }

    const lockInfo: LockInfo = {
      requestId: request.requestId,
      pluginId: request.pluginId,
      source: request.source,
      timeoutMs: request.options.lockTimeout ?? session.lockTimeoutMs,
    };

    const locked = await this.globalPool.lockBrowser(pooledBrowser.id, lockInfo);
    if (!locked) {
      return undefined;
    }

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
