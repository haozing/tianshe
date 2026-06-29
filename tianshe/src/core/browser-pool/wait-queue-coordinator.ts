import { createLogger } from '../logger';
import type { IProfileService } from '../../types/service-interfaces';
import { BROWSER_RUNTIME_IDS } from '../../types/browser-runtime';
import { getAbortMessage, profileToSessionConfig } from './acquire-session-resolver';
import type { PoolReuseStrategy } from './pool-reuse-strategy';
import type { BrowserCreationStrategy } from './browser-creation-strategy';
import type { GlobalPool } from './global-pool';
import type { WaitQueue } from './wait-queue';
import { resetBrowserState } from './utils';
import { isReadyBrowser } from './types';
import type {
  AcquireRequest,
  AcquireResult,
  LockInfo,
  ReleaseOptions,
  SessionConfig,
  WaitingRequest,
} from './types';

const logger = createLogger('WaitQueueCoordinator');

export class WaitQueueCoordinator {
  constructor(
    private readonly globalPool: GlobalPool,
    private readonly waitQueue: WaitQueue,
    private readonly getProfileService: () => IProfileService,
    private readonly reuseStrategy: PoolReuseStrategy,
    private readonly creationStrategy: BrowserCreationStrategy
  ) {}

  async waitForBrowser(
    request: AcquireRequest,
    _session: SessionConfig,
    startTime: number
  ): Promise<AcquireResult> {
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

  getStats(): { totalWaiting: number } {
    return this.waitQueue.getStats();
  }

  async transferBrowserToWaiter(
    browserId: string,
    waiter: WaitingRequest,
    options?: ReleaseOptions
  ): Promise<void> {
    const profile = await this.getProfileService().get(waiter.request.sessionId);
    const session = profile ? profileToSessionConfig(profile) : undefined;
    if (!session) {
      await this.globalPool.releaseBrowser(browserId, options);
      waiter.resolve({
        success: false,
        error: 'Profile not found',
        waitedMs: Date.now() - waiter.enqueuedAt,
      });
      return;
    }

    const browser = this.globalPool.getBrowser(browserId);
    if (browser && isReadyBrowser(browser)) {
      const resetSucceeded = await resetBrowserState(
        browser.browser,
        options,
        '[BrowserPoolManager]'
      );

      if (!resetSucceeded) {
        logger.warn('Browser reset failed before waiter handoff; destroying browser: ' + browserId);
        await this.globalPool.destroyBrowser(browserId);
        const replacement = await this.creationStrategy.create(waiter.request, session);
        if (replacement) {
          waiter.resolve({
            success: true,
            browser: replacement.browser,
            browserId: replacement.id,
            sessionId: session.id,
            waitedMs: Date.now() - waiter.enqueuedAt,
          });
          return;
        }

        waiter.resolve({
          success: false,
          error: 'Browser reset failed before handoff',
          waitedMs: Date.now() - waiter.enqueuedAt,
        });
        return;
      }
    }

    const lockInfo: LockInfo = {
      requestId: waiter.request.requestId,
      pluginId: waiter.request.pluginId,
      source: waiter.request.source,
      timeoutMs: waiter.request.options.lockTimeout ?? session.lockTimeoutMs,
    };

    const locked = await this.globalPool.handoffLock(browserId, lockInfo);
    const lockedBrowser = this.globalPool.getBrowser(browserId);
    if (locked && lockedBrowser && isReadyBrowser(lockedBrowser)) {
      waiter.resolve({
        success: true,
        browser: lockedBrowser.browser,
        browserId,
        sessionId: session.id,
        waitedMs: Date.now() - waiter.enqueuedAt,
      });
      logger.info('Browser transferred to waiter: ' + browserId + ' -> ' + waiter.request.requestId);
      return;
    }

    await this.globalPool.releaseBrowser(browserId, options);
    waiter.resolve({
      success: false,
      error: 'Failed to lock browser for waiter',
      waitedMs: Date.now() - waiter.enqueuedAt,
    });
  }

  async process(sessionId: string): Promise<void> {
    const maxIterations = 100;
    let iterations = 0;

    while (iterations < maxIterations) {
      const waitingRequestCandidates = await Promise.all(
        BROWSER_RUNTIME_IDS.map(
          async (runtimeId) => await this.waitQueue.peek(sessionId, runtimeId)
        )
      );
      const waitingRequest = waitingRequestCandidates
        .filter((value): value is NonNullable<(typeof waitingRequestCandidates)[number]> =>
          Boolean(value)
        )
        .sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt)[0];

      if (!waitingRequest) break;

      const profile = await this.getProfileService().get(sessionId);
      if (!profile) {
        this.waitQueue.cancelBySession(sessionId, 'Profile not found');
        break;
      }
      const session = profileToSessionConfig(profile);

      const pooledBrowser = await this.reuseStrategy.acquire(waitingRequest.request, session);
      if (pooledBrowser) {
        const runtimeId = waitingRequest.request.options.runtimeId ?? session.runtimeId;
        const dequeued = await this.waitQueue.dequeue(sessionId, runtimeId);
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
        const newBrowser = await this.creationStrategy.create(waitingRequest.request, session);

        if (newBrowser) {
          const runtimeId = waitingRequest.request.options.runtimeId ?? session.runtimeId;
          const dequeued = await this.waitQueue.dequeue(sessionId, runtimeId);
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
}
