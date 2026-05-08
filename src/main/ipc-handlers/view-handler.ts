/**
 * ViewIPCHandler - 视图管理处理器
 * 负责：WebContentsView 的生命周期管理和操作
 */

import { IpcMainInvokeEvent } from 'electron';
import {
  CLOUD_AUTH_COOKIE_NAME,
  CLOUD_WORKBENCH_URL,
  CLOUD_WORKBENCH_VIEW_ID,
} from '../../constants/cloud';
import {
  getPersistedCloudAuthSession,
  invalidateCloudAuthSession,
  isCloudAuthSessionExpired,
} from '../cloud-auth/service';
import {
  WebContentsViewManager,
  type ViewDisplayMode,
  type ViewSource,
} from '../webcontentsview-manager';
import { WindowManager } from '../window-manager';
import { handleIPCError } from '../ipc-utils';
import type { IpcRouteDefinition } from '../ipc-route-registry';
import { ipcRouteRegistry } from '../ipc-route-registry';

function getConfiguredWorkbenchUrl(): string {
  return String(CLOUD_WORKBENCH_URL || '').trim();
}

function shouldUseConfiguredWorkbenchUrl(viewId: string): boolean {
  return viewId === CLOUD_WORKBENCH_VIEW_ID && Boolean(getConfiguredWorkbenchUrl());
}

export class ViewIPCHandler {
  constructor(
    private viewManager: WebContentsViewManager,
    private windowManager: WindowManager
  ) {}

  private createRoutes(): IpcRouteDefinition[] {
    return [
      {
        channel: 'view:create',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (
          _event: IpcMainInvokeEvent,
          options: {
            viewId: string;
            partition: string;
            url?: string;
            metadata?: {
              label?: string;
              displayMode?: ViewDisplayMode;
              source?: ViewSource;
              security?: {
                webSecurity?: boolean;
                allowRunningInsecureContent?: boolean;
                disableCSP?: boolean;
                allowedPermissions?: string[];
              };
            };
          }
        ) => {
          try {
            this.viewManager.registerView({
              id: options.viewId,
              partition: options.partition,
              url: shouldUseConfiguredWorkbenchUrl(options.viewId)
                ? getConfiguredWorkbenchUrl()
                : options.url,
              metadata: options.metadata,
            });

            return {
              success: true,
              viewId: options.viewId,
            };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:activate',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, viewId: string) => {
          try {
            const viewInfo = await this.viewManager.activateView(viewId);

            return {
              success: true,
              viewId: viewInfo.id,
            };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:attach',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (
          _event: IpcMainInvokeEvent,
          options: { viewId: string; windowId?: string; bounds: any }
        ) => {
          try {
            const windowId = options.windowId || 'main';

            this.viewManager.attachView(options.viewId, windowId, options.bounds);

            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:update-bounds',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (
          _event: IpcMainInvokeEvent,
          options: {
            viewId: string;
            bounds: { x: number; y: number; width: number; height: number };
          }
        ) => {
          try {
            this.viewManager.updateBounds(options.viewId, options.bounds);
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:navigate',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, options: { viewId: string; url: string }) => {
          try {
            const targetUrl = shouldUseConfiguredWorkbenchUrl(options.viewId)
              ? getConfiguredWorkbenchUrl()
              : options.url;
            await this.viewManager.navigateView(options.viewId, targetUrl);
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:sync-cloud-auth',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (
          _event: IpcMainInvokeEvent,
          options: { viewId: string; url: string; cookieName?: string }
        ) => {
          try {
            const viewInfo = this.viewManager.getView(options.viewId);
            if (!viewInfo) {
              throw new Error(`View not found: ${options.viewId}`);
            }

            const configuredWorkbenchUrl = getConfiguredWorkbenchUrl();
            if (!configuredWorkbenchUrl) {
              return {
                success: false,
                reason: 'workbench-url-not-configured',
              };
            }

            const expectedUrl = new URL(configuredWorkbenchUrl);
            const targetUrl =
              options.viewId === CLOUD_WORKBENCH_VIEW_ID ? expectedUrl : new URL(options.url);
            const cookieUrl = `${targetUrl.origin}/`;
            const cookieName =
              String(options.cookieName || CLOUD_AUTH_COOKIE_NAME).trim() || CLOUD_AUTH_COOKIE_NAME;
            const clearCookie = async () => {
              try {
                await viewInfo.view.webContents.session.cookies.remove(cookieUrl, cookieName);
              } catch {
                // ignore missing cookie / remove failures
              }
            };

            const persisted = getPersistedCloudAuthSession();
            const token = String(persisted?.token || '').trim();
            const expectedOrigin = expectedUrl.origin;

            if (targetUrl.origin !== expectedOrigin) {
              await clearCookie();
              return {
                success: false,
                reason: 'invalid-workbench-origin',
                cookieName,
                targetOrigin: targetUrl.origin,
                expectedOrigin,
              };
            }

            if (!persisted?.token || !persisted?.user) {
              await clearCookie();
              return {
                success: false,
                reason: 'cloud-auth-not-ready',
                targetOrigin: targetUrl.origin,
              };
            }

            if (isCloudAuthSessionExpired(persisted)) {
              await clearCookie();
              await invalidateCloudAuthSession('expired');
              return {
                success: false,
                reason: 'cloud-auth-expired',
                targetOrigin: targetUrl.origin,
              };
            }

            const cookieDetails: Parameters<
              typeof viewInfo.view.webContents.session.cookies.set
            >[0] = {
              url: cookieUrl,
              name: cookieName,
              value: token,
              path: '/',
              secure: targetUrl.protocol === 'https:',
            };

            const expireAt = Date.parse(String(persisted?.expire || '').trim());
            if (Number.isFinite(expireAt) && expireAt > Date.now()) {
              cookieDetails.expirationDate = Math.floor(expireAt / 1000);
            }

            try {
              await viewInfo.view.webContents.session.cookies.set(cookieDetails);
            } catch (error) {
              await clearCookie();
              await invalidateCloudAuthSession('workbench_sync_failed');
              return {
                success: false,
                reason: 'cookie-write-failed',
                error: handleIPCError(error).error,
                targetOrigin: targetUrl.origin,
              };
            }

            return {
              success: true,
              cookieName: cookieDetails.name,
              targetOrigin: targetUrl.origin,
            };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:switch',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (
          _event: IpcMainInvokeEvent,
          options: { viewId: string; windowId?: string; bounds: any }
        ) => {
          try {
            const windowId = options.windowId || 'main';

            this.viewManager.switchView(options.viewId, windowId, options.bounds);

            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:detach',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, viewId: string) => {
          try {
            this.viewManager.detachView(viewId);
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:detach-all',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (
          _event: IpcMainInvokeEvent,
          options?: { windowId?: string; preserveDockedRight?: boolean }
        ) => {
          try {
            const windowId = options?.windowId;
            const preserveDockedRight = options?.preserveDockedRight === true;

            this.viewManager.detachAllViews(windowId, { preserveDockedRight });
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:detach-scoped',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (
          _event: IpcMainInvokeEvent,
          options?: {
            windowId?: string;
            scope?: 'all' | 'automation' | 'plugin';
            preserveDockedRight?: boolean;
          }
        ) => {
          try {
            const windowId = options?.windowId;
            const scope = options?.scope ?? 'automation';
            const preserveDockedRight = options?.preserveDockedRight === true;

            this.viewManager.detachScopedViews({ windowId, scope, preserveDockedRight });
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:close',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, viewId: string) => {
          try {
            await this.viewManager.closeView(viewId);
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:list',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async () => {
          try {
            const views = this.viewManager.listRegisteredViews();
            return { success: true, views };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:pool-status',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async () => {
          try {
            const status = this.viewManager.getPoolStatus();
            return { success: true, status };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:set-activity-bar-collapsed',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, isCollapsed: boolean) => {
          try {
            this.viewManager.setActivityBarCollapsed(Boolean(isCollapsed));
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:set-activity-bar-width',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, widthPx: number) => {
          try {
            this.viewManager.setActivityBarWidth(Number(widthPx));
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:resource-stats',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async () => {
          try {
            const stats = this.viewManager.getResourceStats();
            return { success: true, stats };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:force-gc',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async () => {
          try {
            await this.viewManager.forceGarbageCollection();
            return { success: true };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:close-multiple',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, viewIds: string[]) => {
          try {
            const result = await this.viewManager.closeMultipleViews(viewIds);
            return { success: true, result };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:close-oldest',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (_event: IpcMainInvokeEvent, count: number) => {
          try {
            const closed = await this.viewManager.closeOldestViews(count);
            return { success: true, closed };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:memory-usage',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async () => {
          try {
            const usage = this.viewManager.getMemoryUsage();
            return { success: true, usage };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'view:detailed-pool-status',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async () => {
          try {
            const status = this.viewManager.getDetailedPoolStatus();
            return { success: true, status };
          } catch (error: unknown) {
            return handleIPCError(error);
          }
        },
      },
    ];
  }

  register(): void {
    ipcRouteRegistry.registerAll(this.createRoutes());
  }
}
