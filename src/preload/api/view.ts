import type { IpcRenderer } from 'electron';

export function createViewAPI(ipcRenderer: IpcRenderer) {
  return {
  // ========== WebContentsView 相关 ==========

  view: {
    /**
     * 注册 WebContentsView（不立即创建）
     */
    create: (options: {
      viewId: string;
      partition: string;
      url?: string;
      metadata?: {
        label?: string;
        displayMode?: 'fullscreen' | 'offscreen' | 'popup' | 'docked-right';
        source?: 'plugin' | 'mcp' | 'pool' | 'account';
        security?: {
          webSecurity?: boolean;
          allowRunningInsecureContent?: boolean;
          disableCSP?: boolean;
          allowedPermissions?: string[];
        };
      };
    }): Promise<{ success: boolean; viewId?: string; error?: string }> => {
      return ipcRenderer.invoke('view:create', options);
    },

    /**
     * 激活 WebContentsView（按需创建）
     */
    activate: (viewId: string): Promise<{ success: boolean; viewId?: string; error?: string }> => {
      return ipcRenderer.invoke('view:activate', viewId);
    },

    /**
     * 导航 WebContentsView 到指定 URL
     */
    navigate: (options: {
      viewId: string;
      url: string;
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:navigate', options);
    },

    /**
     * 切换 WebContentsView
     */
    switch: (options: {
      viewId: string;
      windowId?: 'main' | 'background';
      bounds: { x: number; y: number; width: number; height: number };
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:switch', options);
    },

    /**
     * 附加 WebContentsView 到窗口
     */
    attach: (options: {
      viewId: string;
      windowId?: 'main' | 'background';
      bounds: { x: number; y: number; width: number; height: number };
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:attach', options);
    },

    /**
     * 更新 WebContentsView 边界
     */
    updateBounds: (options: {
      viewId: string;
      bounds: { x: number; y: number; width: number; height: number };
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:update-bounds', options);
    },

    /**
     * 分离单个 WebContentsView
     */
    detach: (viewId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:detach', viewId);
    },

    /**
     * 将当前框架保存的 GoAdmin 登录态同步到指定视图 Cookie
     */
    syncCloudAuth: (options: {
      viewId: string;
      url: string;
      cookieName?: string;
    }): Promise<{
      success: boolean;
      reason?: string;
      cookieName?: string;
      targetOrigin?: string;
      expectedOrigin?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:sync-cloud-auth', options);
    },

    /**
     * 分离所有 WebContentsView
     * @param options.windowId 可选的窗口 ID，如 'main'。不传则分离所有窗口的 View
     */
    detachAll: (options?: {
      windowId?: string;
      preserveDockedRight?: boolean;
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:detach-all', options);
    },

    /**
     * 按作用域分离 WebContentsView
     * @param options.scope 默认 automation（仅清理自动化视图）
     */
    detachScoped: (options?: {
      windowId?: string;
      scope?: 'all' | 'automation' | 'plugin';
      preserveDockedRight?: boolean;
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:detach-scoped', options);
    },

    /**
     * 🆕 同步 Activity Bar 折叠状态（用于正确计算 WebContentsView 的布局边界）
     */
    setActivityBarCollapsed: (
      isCollapsed: boolean
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:set-activity-bar-collapsed', isCollapsed);
    },

    /**
     * 🆕 同步 Activity Bar 实际宽度（px）
     *
     * 由 renderer 侧通过 ResizeObserver 上报，主进程据此更新 WebContentsView 布局。
     */
    setActivityBarWidth: (widthPx: number): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:set-activity-bar-width', widthPx);
    },

    /**
     * 关闭 WebContentsView
     */
    close: (viewId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('view:close', viewId);
    },

    /**
     * 列出所有已注册的 WebContentsView（包括未激活的）
     */
    list: (): Promise<{
      success: boolean;
      views?: Array<{
        id: string;
        partition: string;
        metadata?: {
          label?: string;
          icon?: string;
          order?: number;
          color?: string;
        };
        isActive: boolean;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:list');
    },

    /**
     * 获取 WebContentsView 池状态
     */
    getPoolStatus: (): Promise<{
      success: boolean;
      status?: {
        size: number;
        maxSize: number;
        views: Array<{
          id: string;
          partition: string;
          createdAt: number;
          lastAccessedAt: number;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:pool-status');
    },

    /**
     * 批量关闭多个 WebContentsView
     */
    closeMultiple: (
      viewIds: string[]
    ): Promise<{
      success: boolean;
      result?: {
        closed: string[];
        failed: Array<{ id: string; error: string }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:close-multiple', viewIds);
    },

    /**
     * 关闭最旧的 N 个 WebContentsView
     */
    closeOldest: (
      count: number
    ): Promise<{
      success: boolean;
      closed?: string[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:close-oldest', count);
    },

    /**
     * 获取内存使用估算
     */
    getMemoryUsage: (): Promise<{
      success: boolean;
      usage?: {
        estimatedMB: number;
        perViewMB: number;
        activeViews: number;
        maxViews: number;
        utilizationPercent: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:memory-usage');
    },

    /**
     * 获取详细的池状态
     */
    getDetailedPoolStatus: (): Promise<{
      success: boolean;
      status?: {
        size: number;
        maxSize: number;
        available: number;
        isFull: boolean;
        utilizationPercent: number;
        views: Array<{
          id: string;
          partition: string;
          attachedTo?: string;
          createdAt: number;
          lastAccessedAt: number;
          ageSeconds: number;
        }>;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('view:detailed-pool-status');
    },
  },

  // ========== 窗口相关 ==========

  window: {
    /**
     * 获取窗口边界
     */
    getBounds: (): Promise<{ width: number; height: number; x: number; y: number }> => {
      return ipcRenderer.invoke('window:get-bounds');
    },
  },

  };
}
