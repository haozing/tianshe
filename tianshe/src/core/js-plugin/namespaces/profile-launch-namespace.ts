import type {
  IWebContentsViewManager,
  IWindowManager,
} from '../../browser-pool/ports';
import type { IProfileService } from '../../../types/service-interfaces';
import type { BrowserHandle, ReleaseOptions } from '../../browser-pool/types';
import type { InternalDevToolsOpener } from './window';
import type {
  LaunchOptions,
  LaunchPopupOptions,
  PopupBrowserHandle,
  WithLeaseOptions,
  WithLeaseRunContext,
} from './profile';
import {
  getBrowserPoolManager,
  showBrowserView,
  hideBrowserView,
  showBrowserViewInPopup,
  closeBrowserPopup,
} from '../../browser-pool';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
} from '../../browser-pool/profile-live-session-lease';
import {
  buildProfileResourceKey,
  resourceCoordinator,
} from '../../resource-coordinator';
import { createLogger } from '../../logger';
import { createPluginBrowserFacade } from './profile-browser-facade';

const DEFAULT_RESOURCE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const logger = createLogger('ProfileLaunchNamespace');

interface ManagedProfileLease {
  handle: BrowserHandle;
  refCount: number;
  renewTimer: NodeJS.Timeout | null;
  released: boolean;
  release: (options?: ReleaseOptions) => Promise<void>;
  renew: (extensionMs?: number) => Promise<void>;
}

export interface ProfileLaunchNamespaceDeps {
  pluginId: string;
  profileService: IProfileService;
  viewManager: IWebContentsViewManager;
  windowManager: IWindowManager;
  getPluginConfig?: (key: string) => Promise<unknown>;
  devToolsOpener?: InternalDevToolsOpener;
}

export class ProfileLaunchNamespace {
  private readonly pluginConfigKeys = {
    visibleLayout: ['profile.launch.visibleLayout', 'profileLaunchVisibleLayout'] as const,
    rightDockSize: ['profile.launch.rightDockSize', 'profileLaunchRightDockSize'] as const,
  };

  constructor(private readonly deps: ProfileLaunchNamespaceDeps) {}

  async withLease<T>(
    profileId: string,
    options: WithLeaseOptions | undefined,
    handler: (ctx: WithLeaseRunContext) => Promise<T>
  ): Promise<T> {
    const normalizedProfileId = String(profileId || '').trim();
    if (!normalizedProfileId) {
      throw new Error('profileId is required');
    }

    const resourceKey = buildProfileResourceKey(normalizedProfileId);
    const resourceWaitTimeoutMs =
      typeof options?.resourceWaitTimeoutMs === 'number' && options.resourceWaitTimeoutMs > 0
        ? options.resourceWaitTimeoutMs
        : DEFAULT_RESOURCE_WAIT_TIMEOUT_MS;
    const releaseOptions: ReleaseOptions = {
      navigateTo: 'about:blank',
      ...(options?.release || {}),
    };

    const runWithLease = async (): Promise<T> => {
      const context = resourceCoordinator.getCurrentContext();
      const existingLease = context?.profileLeases.get(normalizedProfileId) as
        | ManagedProfileLease
        | undefined;

      if (existingLease) {
        existingLease.refCount += 1;
        try {
          return await handler({
            browser: existingLease.handle.browser,
            browserId: existingLease.handle.browserId,
            sessionId: existingLease.handle.sessionId,
            runtimeId: existingLease.handle.runtimeId,
            viewId: existingLease.handle.viewId,
            release: existingLease.release,
            renew: existingLease.renew,
          });
        } finally {
          existingLease.refCount -= 1;
        }
      }

      const profile = await this.deps.profileService.get(normalizedProfileId);
      const lockTimeoutMs =
        typeof profile?.lockTimeoutMs === 'number' && profile.lockTimeoutMs > 0
          ? profile.lockTimeoutMs
          : 120000;
      const renewIntervalMs =
        typeof options?.renewIntervalMs === 'number' && options.renewIntervalMs > 0
          ? options.renewIntervalMs
          : Math.max(10000, Math.min(60000, Math.floor(lockTimeoutMs / 2)));

      const handle = await this.launch(normalizedProfileId, {
        ...options,
        timeout: options?.timeout ?? resourceWaitTimeoutMs,
        signal: options?.signal,
      });

      const releaseHandle = async (overrideReleaseOptions?: ReleaseOptions) => {
        if (lease.released) return;
        lease.released = true;
        if (lease.renewTimer) {
          clearInterval(lease.renewTimer);
          lease.renewTimer = null;
        }
        context?.profileLeases.delete(normalizedProfileId);
        await handle.release({
          ...releaseOptions,
          ...(overrideReleaseOptions || {}),
        });
      };

      const lease: ManagedProfileLease = {
        handle,
        refCount: 1,
        renewTimer: null,
        released: false,
        release: releaseHandle,
        renew: async (extensionMs?: number) => {
          if (lease.released) return;
          await handle.renew(extensionMs);
        },
      };
      context?.profileLeases.set(normalizedProfileId, lease);

      if (options?.autoRenew !== false) {
        lease.renewTimer = setInterval(() => {
          void handle.renew(options?.renewExtensionMs).catch(() => undefined);
        }, renewIntervalMs);
        lease.renewTimer.unref?.();
      }

      try {
        return await handler({
          browser: handle.browser,
          browserId: handle.browserId,
          sessionId: handle.sessionId,
          runtimeId: handle.runtimeId,
          viewId: handle.viewId,
          release: lease.release,
          renew: lease.renew,
        });
      } finally {
        lease.refCount -= 1;
        if (lease.refCount <= 0 && !lease.released) {
          await lease.release();
        }
      }
    };

    const currentContext = resourceCoordinator.getCurrentContext();
    if (currentContext?.heldKeys.has(resourceKey)) {
      return await runWithLease();
    }

    return await resourceCoordinator.runExclusive(
      [resourceKey],
      {
        ownerToken: currentContext?.ownerToken,
        ownerSource: currentContext?.ownerSource || 'plugin',
        timeoutMs: resourceWaitTimeoutMs,
        signal: options?.signal,
      },
      runWithLease
    );
  }

  async launch(profileId: string, options?: LaunchOptions): Promise<BrowserHandle> {
    const poolManager = getBrowserPoolManager();
    const profileLease = await acquireProfileLiveSessionLease(profileId, {
      source: 'plugin',
      timeoutMs: options?.timeout || 30000,
      signal: options?.signal,
    });

    const preStats = await poolManager.getStats();
    const queueStats = poolManager.getWaitQueueStats();
    logger.info('Acquiring browser for profile launch', {
      pluginId: this.deps.pluginId,
      profileId,
      timeoutMs: options?.timeout || 30000,
      totalBrowsers: preStats.totalBrowsers,
      idleBrowsers: preStats.idleBrowsers,
      lockedBrowsers: preStats.lockedBrowsers,
      totalWaiting: queueStats.totalWaiting,
    });

    const acquireStartTime = Date.now();
    let handle: BrowserHandle;
    try {
      handle = await poolManager.acquire(
        profileId,
        {
          strategy: options?.strategy || 'any',
          browserId: options?.browserId,
          timeout: options?.timeout || 30000,
          signal: options?.signal,
          runtimeId: options?.runtimeId,
        },
        'internal',
        this.deps.pluginId
      );
    } catch (error) {
      await profileLease?.release().catch(() => undefined);
      const failStats = await poolManager.getStats();
      const failQueueStats = poolManager.getWaitQueueStats();
      const browsers = poolManager.listBrowsers();
      logger.error('Failed to acquire browser for profile launch', {
        error,
        durationMs: Date.now() - acquireStartTime,
        totalBrowsers: failStats.totalBrowsers,
        idleBrowsers: failStats.idleBrowsers,
        lockedBrowsers: failStats.lockedBrowsers,
        totalWaiting: failQueueStats.totalWaiting,
        browsers: browsers.map((b) => `${b.id.slice(0, 8)}(${b.status},profile=${b.sessionId})`),
      });
      throw error;
    }

    logger.info('Acquired browser for profile launch', {
      pluginId: this.deps.pluginId,
      profileId,
      browserId: handle.browserId,
      durationMs: Date.now() - acquireStartTime,
    });

    try {
      if (options?.url) {
        await handle.browser.goto(options.url);
      }

      const visibilityState = {
        visibleLayout: await this.resolveVisibleLayout(options),
        rightDockSize: await this.resolveRightDockSize(options),
      };
      await this.applyHandleVisibility(handle, options?.visible === true, visibilityState);
      handle = this.attachVisibilityControlsToHandle(handle, visibilityState);
      handle = attachProfileLiveSessionLease(handle, profileLease);

      logger.info('Browser launched for plugin profile helper', {
        pluginId: this.deps.pluginId,
        profileId,
        browserId: handle.browserId,
      });

      return this.wrapBrowserHandle(handle);
    } catch (error) {
      await handle.release({ destroy: true }).catch(() => undefined);
      await profileLease?.release().catch(() => undefined);
      throw error;
    }
  }

  async getUsage(profileId: string): Promise<{
    quota: number;
    browserCount: number;
    idleCount: number;
    lockedCount: number;
    waitingCount: number;
  } | null> {
    try {
      const poolManager = getBrowserPoolManager();
      return poolManager.getProfileStats(profileId);
    } catch {
      return null;
    }
  }

  async launchPopup(
    profileId: string,
    options?: LaunchPopupOptions
  ): Promise<PopupBrowserHandle> {
    const poolManager = getBrowserPoolManager();
    const acquireOptions = {
      strategy: options?.strategy || 'any',
      browserId: options?.browserId,
      timeout: options?.timeout || 30000,
      signal: options?.signal,
      runtimeId: options?.runtimeId,
    };
    const tryAdoptExistingHandle = async () =>
      await poolManager.adoptSamePluginLockedBrowser(
        profileId,
        {
          ...acquireOptions,
          requireViewId: false,
        },
        'internal',
        this.deps.pluginId
      );

    let reusedLease: Awaited<ReturnType<typeof acquireProfileLiveSessionLease>> | null = null;
    let reusedHandle: BrowserHandle | null = null;
    try {
      reusedLease = await acquireProfileLiveSessionLease(profileId, {
        source: 'plugin',
        timeoutMs: options?.timeout || 30000,
        signal: options?.signal,
      });
    } catch (error) {
      reusedHandle = await tryAdoptExistingHandle();
      if (!reusedHandle) {
        throw error;
      }
    }

    if (!reusedHandle) {
      try {
        reusedHandle = await poolManager.acquire(
          profileId,
          acquireOptions,
          'internal',
          this.deps.pluginId
        );
      } catch (error) {
        await reusedLease?.release().catch(() => undefined);
        reusedHandle = await tryAdoptExistingHandle();
        if (!reusedHandle) {
          throw error;
        }
      }
    }

    try {
      const initialUrl = options?.url || '';
      if (initialUrl) {
        await reusedHandle.browser.goto(initialUrl);
      }

      const viewId = reusedHandle.viewId;
      if (!viewId) {
        const showBrowser = reusedHandle.browser.show;
        if (typeof showBrowser === 'function') {
          let externalClosed = false;
          await showBrowser.call(reusedHandle.browser);
          return this.wrapPopupBrowserHandle(
            attachProfileLiveSessionLease(
              {
                ...reusedHandle,
                popupId: `external:${reusedHandle.browserId}`,
                closePopup: () => {
                  if (externalClosed) return;
                  externalClosed = true;

                  void (async () => {
                    if (typeof reusedHandle.browser.hide === 'function') {
                      await reusedHandle.browser.hide().catch(() => undefined);
                    }

                    if (options?.onClose) {
                      try {
                        options.onClose();
                      } catch (error) {
                        logger.error('Error in external popup onClose callback', error);
                      }
                    }
                  })();
                },
              },
              reusedLease
            )
          );
        }
        throw new Error(`Browser ${reusedHandle.browserId} has no associated viewId`);
      }

      let defaultTitle = 'Browser';
      if (initialUrl) {
        try {
          defaultTitle = new URL(initialUrl).hostname;
        } catch {
          // ignore URL parse failure
        }
      }

      const popupId = showBrowserViewInPopup(
        viewId,
        this.deps.viewManager,
        this.deps.windowManager,
        {
          title: options?.title || defaultTitle,
          width: options?.width || 1200,
          height: options?.height || 800,
          openDevTools: options?.openDevTools,
          onViewReady: (view) => {
            this.deps.devToolsOpener?.(view.webContents, {
              override: options?.openDevTools,
              mode: 'detach',
            });
          },
          onClose: options?.onClose,
        }
      );

      if (!popupId) {
        throw new Error(`Failed to create popup for browser ${reusedHandle.browserId}`);
      }

      logger.info('Browser launched in popup for plugin profile helper', {
        pluginId: this.deps.pluginId,
        profileId,
        browserId: reusedHandle.browserId,
        popupId,
      });

      return this.wrapPopupBrowserHandle(
        attachProfileLiveSessionLease(
          {
            ...reusedHandle,
            popupId,
            closePopup: () => {
              closeBrowserPopup(popupId, this.deps.windowManager);
            },
          },
          reusedLease
        )
      );
    } catch (error) {
      await reusedHandle?.release({ destroy: true }).catch(() => undefined);
      await reusedLease?.release().catch(() => undefined);
      throw error;
    }
  }

  private normalizeVisibleLayout(value: unknown): 'right-docked' | 'fullscreen' | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'right-docked' ||
      normalized === 'right_docked' ||
      normalized === 'docked-right'
    ) {
      return 'right-docked';
    }
    if (normalized === 'fullscreen' || normalized === 'full') {
      return 'fullscreen';
    }
    return undefined;
  }

  private normalizeRightDockSize(value: unknown): number | string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    return undefined;
  }

  private async readPluginConfigValue<T>(
    keys: readonly string[],
    parser: (value: unknown) => T | undefined
  ): Promise<T | undefined> {
    if (!this.deps.getPluginConfig) return undefined;

    for (const key of keys) {
      try {
        const raw = await this.deps.getPluginConfig(key);
        const parsed = parser(raw);
        if (parsed !== undefined) {
          return parsed;
        }
      } catch (error) {
        logger.warn('Failed to read plugin launch config', {
          pluginId: this.deps.pluginId,
          key,
          error,
        });
      }
    }

    return undefined;
  }

  private async resolveVisibleLayout(
    options?: LaunchOptions
  ): Promise<'right-docked' | 'fullscreen'> {
    return (
      options?.visibleLayout ??
      (await this.readPluginConfigValue(
        this.pluginConfigKeys.visibleLayout,
        this.normalizeVisibleLayout.bind(this)
      )) ??
      'right-docked'
    );
  }

  private async resolveRightDockSize(
    options?: LaunchOptions
  ): Promise<number | string | undefined> {
    return (
      options?.rightDockSize ??
      (await this.readPluginConfigValue(
        this.pluginConfigKeys.rightDockSize,
        this.normalizeRightDockSize.bind(this)
      ))
    );
  }

  private async applyHandleVisibility(
    handle: BrowserHandle,
    visible: boolean,
    state: {
      visibleLayout: 'right-docked' | 'fullscreen';
      rightDockSize?: number | string;
    }
  ): Promise<void> {
    if (handle.viewId) {
      if (visible) {
        const shown = showBrowserView(handle.viewId, this.deps.viewManager, this.deps.windowManager, {
          windowId: 'main',
          source: 'pool',
          layout: state.visibleLayout === 'fullscreen' ? 'fullscreen' : 'docked-right',
          rightDockSize: state.rightDockSize,
          pluginId: this.deps.pluginId,
        });
        if (!shown) {
          throw new Error(
            `[Profile.launch] Failed to show browser view ${handle.viewId} (layout=${state.visibleLayout})`
          );
        }
      } else {
        hideBrowserView(handle.viewId, this.deps.viewManager);
      }
      return;
    }

    if (visible && typeof handle.browser.show === 'function') {
      await handle.browser.show();
    } else if (!visible && typeof handle.browser.hide === 'function') {
      await handle.browser.hide();
    }
  }

  private attachVisibilityControlsToHandle(
    handle: BrowserHandle,
    state: {
      visibleLayout: 'right-docked' | 'fullscreen';
      rightDockSize?: number | string;
    }
  ): BrowserHandle {
    const originalShow =
      typeof handle.browser.show === 'function'
        ? handle.browser.show.bind(handle.browser)
        : undefined;
    const originalHide =
      typeof handle.browser.hide === 'function'
        ? handle.browser.hide.bind(handle.browser)
        : undefined;
    const originalRelease = handle.release.bind(handle);

    handle.browser.show = async () => {
      if (!handle.viewId) {
        if (originalShow) {
          await originalShow();
        }
        return;
      }

      await this.applyHandleVisibility(handle, true, state);
      if (originalShow) {
        await originalShow().catch(() => undefined);
      }
    };

    handle.browser.hide = async () => {
      if (!handle.viewId) {
        if (originalHide) {
          await originalHide();
        }
        return;
      }

      await this.applyHandleVisibility(handle, false, state);
      if (originalHide) {
        await originalHide().catch(() => undefined);
      }
    };

    handle.release = async (releaseOptions?: ReleaseOptions) => {
      if (handle.viewId) {
        await this.applyHandleVisibility(handle, false, state).catch(() => undefined);
      } else if (originalHide) {
        await originalHide().catch(() => undefined);
      }
      return originalRelease(releaseOptions);
    };

    return handle;
  }

  private wrapBrowserHandle(handle: BrowserHandle): BrowserHandle {
    return {
      ...handle,
      browser: createPluginBrowserFacade(handle.browser),
      release: handle.release.bind(handle),
      renew: handle.renew.bind(handle),
    };
  }

  private wrapPopupBrowserHandle(handle: PopupBrowserHandle): PopupBrowserHandle {
    return {
      ...this.wrapBrowserHandle(handle),
      popupId: handle.popupId,
      closePopup: handle.closePopup.bind(handle),
    };
  }
}
