import { createLogger } from '../logger';
import { DEFAULT_BROWSER_PROFILE } from '../../constants/browser-pool';
import type { IProfileService } from '../../types/service-interfaces';
import { ProfileNotFoundError } from '../errors/BrowserPoolError';
import { profileToSessionConfig } from './acquire-session-resolver';
import type { AcquireRequestFactory } from './acquire-request-factory';
import type { GlobalPool } from './global-pool';
import type {
  AcquireOptions,
  AcquireSource,
  BrowserHandle,
  LockInfo,
  SessionConfig,
} from './types';
import { isReadyBrowser } from './types';

const logger = createLogger('PluginLeaseStrategy');

export interface LockedBrowserOptions extends Partial<AcquireOptions> {
  requireViewId?: boolean;
}

export class PluginLeaseStrategy {
  constructor(
    private readonly globalPool: GlobalPool,
    private readonly getProfileService: () => IProfileService,
    private readonly requestFactory: AcquireRequestFactory,
    private readonly buildBrowserHandle: (
      request: ReturnType<AcquireRequestFactory['create']>,
      browserId: string,
      sessionId: string
    ) => BrowserHandle,
    private readonly emitBrowserAcquired: (
      request: ReturnType<AcquireRequestFactory['create']>,
      browserId: string,
      sessionId: string,
      waitedMs: number
    ) => void,
    private readonly markProfileActive: (sessionId: string, browserId: string) => Promise<void>
  ) {}

  async adoptSamePluginLockedBrowser(
    profileId: string | undefined,
    options?: LockedBrowserOptions,
    source: AcquireSource = 'internal',
    pluginId?: string
  ): Promise<BrowserHandle | null> {
    const normalizedPluginId = String(pluginId || '').trim();
    if (!normalizedPluginId) {
      return null;
    }

    const { session, acquireOptions } = await this.resolveSession(profileId, options);
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

    const request = this.requestFactory.create(session, acquireOptions, source, normalizedPluginId);
    const handedOff = await this.globalPool.handoffLock(
      candidate.id,
      this.createLockInfo(request, session)
    );
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
    options?: LockedBrowserOptions,
    source: AcquireSource = 'mcp',
    pluginId?: string
  ): Promise<BrowserHandle | null> {
    const { session, acquireOptions } = await this.resolveSession(profileId, options);
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
    const request = this.requestFactory.create(session, acquireOptions, source, normalizedPluginId);
    const handedOff = await this.globalPool.handoffLock(
      candidate.id,
      this.createLockInfo(request, session)
    );
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

  private async resolveSession(
    profileId: string | undefined,
    options?: LockedBrowserOptions
  ): Promise<{ session: SessionConfig; acquireOptions: AcquireOptions }> {
    const targetProfileId = profileId || DEFAULT_BROWSER_PROFILE.id;
    const profile = await this.getProfileService().get(targetProfileId);
    if (!profile) {
      throw new ProfileNotFoundError(profileId || 'default');
    }

    const session = profileToSessionConfig(profile);
    const acquireOptions = this.requestFactory.normalizeOptions(session, options);
    return { session, acquireOptions };
  }

  private createLockInfo(
    request: ReturnType<AcquireRequestFactory['create']>,
    session: SessionConfig
  ): LockInfo {
    return {
      requestId: request.requestId,
      pluginId: request.pluginId,
      source: request.source,
      timeoutMs: request.options.lockTimeout ?? session.lockTimeoutMs,
    };
  }
}
