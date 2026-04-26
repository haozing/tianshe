/**
 * ViewIPCHandler - 视图管理处理器
 * 负责：WebContentsView 的生命周期管理和操作
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
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

  /**
   * 注册所有视图相关的 IPC 处理器
   */
  register(): void {
    this.registerCreate();
    this.registerActivate();
    this.registerAttach();
    this.registerUpdateBounds();
    this.registerNavigate();
    this.registerSyncCloudAuth();
    this.registerSwitch();
    this.registerDetach();
    this.registerDetachAll();
    this.registerDetachScoped();
    this.registerClose();
    this.registerList();
    this.registerPoolStatus();
    this.registerSetActivityBarCollapsed();
    this.registerSetActivityBarWidth();
    // this.registerButtonClick(); // 已移除 - JSON Plugin 功能
    // 🆕 资源监控相关
    this.registerResourceStats();
    this.registerForceGC();
    // 🆕 增强功能
    this.registerCloseMultiple();
    this.registerCloseOldest();
    this.registerMemoryUsage();
    this.registerDetailedPoolStatus();
  }

  private registerCreate(): void {
    ipcMain.handle(
      'view:create',
      async (
        _event: IpcMainInvokeEvent,
        options: {
          viewId: string;
          partition: string;
          url?: string;
          metadata?: {
            label?: string;
            displayMode?: ViewDisplayMode;
            source?: ViewSource;
          };
        }
      ) => {
        try {
          // 只注册，不创建实际的 View
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
      }
    );
  }

  private registerActivate(): void {
    ipcMain.handle('view:activate', async (_event: IpcMainInvokeEvent, viewId: string) => {
      try {
        const viewInfo = await this.viewManager.activateView(viewId);

        return {
          success: true,
          viewId: viewInfo.id,
        };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerAttach(): void {
    ipcMain.handle(
      'view:attach',
      async (
        _event: IpcMainInvokeEvent,
        options: { viewId: string; windowId?: string; bounds: any }
      ) => {
        try {
          // 默认使用主窗口
          const windowId = options.windowId || 'main';

          this.viewManager.attachView(options.viewId, windowId, options.bounds);

          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerUpdateBounds(): void {
    ipcMain.handle(
      'view:update-bounds',
      async (
        _event: IpcMainInvokeEvent,
        options: { viewId: string; bounds: { x: number; y: number; width: number; height: number } }
      ) => {
        try {
          this.viewManager.updateBounds(options.viewId, options.bounds);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerNavigate(): void {
    ipcMain.handle(
      'view:navigate',
      async (_event: IpcMainInvokeEvent, options: { viewId: string; url: string }) => {
        try {
          const targetUrl = shouldUseConfiguredWorkbenchUrl(options.viewId)
            ? getConfiguredWorkbenchUrl()
            : options.url;
          await this.viewManager.navigateView(options.viewId, targetUrl);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerSyncCloudAuth(): void {
    ipcMain.handle(
      'view:sync-cloud-auth',
      async (
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
              error: error instanceof Error ? error.message : '写入工作台登录 cookie 失败',
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
      }
    );
  }

  private registerSwitch(): void {
    ipcMain.handle(
      'view:switch',
      async (
        _event: IpcMainInvokeEvent,
        options: { viewId: string; windowId?: string; bounds: any }
      ) => {
        try {
          // 默认使用主窗口
          const windowId = options.windowId || 'main';

          this.viewManager.switchView(options.viewId, windowId, options.bounds);

          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerDetach(): void {
    ipcMain.handle('view:detach', async (_event: IpcMainInvokeEvent, viewId: string) => {
      try {
        this.viewManager.detachView(viewId);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerDetachAll(): void {
    ipcMain.handle(
      'view:detach-all',
      async (
        _event: IpcMainInvokeEvent,
        options?: { windowId?: string; preserveDockedRight?: boolean }
      ) => {
        try {
          // 可选的窗口 ID，默认分离所有窗口的 View
          const windowId = options?.windowId;
          const preserveDockedRight = options?.preserveDockedRight === true;

          this.viewManager.detachAllViews(windowId, { preserveDockedRight });
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerDetachScoped(): void {
    ipcMain.handle(
      'view:detach-scoped',
      async (
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
      }
    );
  }

  private registerClose(): void {
    ipcMain.handle('view:close', async (_event: IpcMainInvokeEvent, viewId: string) => {
      try {
        await this.viewManager.closeView(viewId);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerList(): void {
    ipcMain.handle('view:list', async () => {
      try {
        const views = this.viewManager.listRegisteredViews();
        return { success: true, views };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerPoolStatus(): void {
    ipcMain.handle('view:pool-status', async () => {
      try {
        const status = this.viewManager.getPoolStatus();
        return { success: true, status };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 🆕 同步 Activity Bar 折叠状态（用于正确计算 WebContentsView 的布局边界）
   */
  private registerSetActivityBarCollapsed(): void {
    ipcMain.handle(
      'view:set-activity-bar-collapsed',
      async (_event: IpcMainInvokeEvent, isCollapsed: boolean) => {
        try {
          this.viewManager.setActivityBarCollapsed(Boolean(isCollapsed));
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 🆕 同步 Activity Bar 实际宽度（px）
   *
   * 用于 renderer 通过 ResizeObserver 上报侧边栏宽度，主进程据此更新所有 WebContentsView 布局。
   */
  private registerSetActivityBarWidth(): void {
    ipcMain.handle(
      'view:set-activity-bar-width',
      async (_event: IpcMainInvokeEvent, widthPx: number) => {
        try {
          this.viewManager.setActivityBarWidth(Number(widthPx));
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 🆕 获取资源统计（用于内存泄漏检测）
   */
  private registerResourceStats(): void {
    ipcMain.handle('view:resource-stats', async () => {
      try {
        const stats = this.viewManager.getResourceStats();
        return { success: true, stats };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 🆕 强制垃圾回收（仅调试用）
   */
  private registerForceGC(): void {
    ipcMain.handle('view:force-gc', async () => {
      try {
        await this.viewManager.forceGarbageCollection();
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 🆕 批量关闭多个 View
   */
  private registerCloseMultiple(): void {
    ipcMain.handle('view:close-multiple', async (_event: IpcMainInvokeEvent, viewIds: string[]) => {
      try {
        const result = await this.viewManager.closeMultipleViews(viewIds);
        return { success: true, result };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 🆕 关闭最旧的 N 个 View
   */
  private registerCloseOldest(): void {
    ipcMain.handle('view:close-oldest', async (_event: IpcMainInvokeEvent, count: number) => {
      try {
        const closed = await this.viewManager.closeOldestViews(count);
        return { success: true, closed };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 🆕 获取内存使用估算
   */
  private registerMemoryUsage(): void {
    ipcMain.handle('view:memory-usage', async () => {
      try {
        const usage = this.viewManager.getMemoryUsage();
        return { success: true, usage };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  /**
   * 🆕 获取池的详细状态
   */
  private registerDetailedPoolStatus(): void {
    ipcMain.handle('view:detailed-pool-status', async () => {
      try {
        const status = this.viewManager.getDetailedPoolStatus();
        return { success: true, status };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }
}
