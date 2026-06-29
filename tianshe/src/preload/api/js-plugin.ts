import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type { PluginNotificationPayload } from '../../core/js-plugin/events';

export function createPluginAPI(ipcRenderer: IpcRenderer) {
  return {
  // ========== JS 插件系统 ==========

  jsPlugin: {
    /**
     * 导入插件
     * @param sourcePath - 插件源路径（可选，不提供则打开文件对话框）
     * @param options - 导入选项（开发模式等）
     */
    import: (
      sourcePath?: string,
      options?: { devMode?: boolean }
    ): Promise<{
      success: boolean;
      pluginId?: string;
      error?: string;
      warnings?: string[];
      operation?: 'installed' | 'updated';
    }> => {
      return ipcRenderer.invoke('js-plugin:import', sourcePath, options);
    },

    /**
     * 列出所有已安装的插件
     */
    list: (): Promise<{ success: boolean; plugins?: any[]; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:list');
    },

    /**
     * 获取所有插件运行态
     */
    listRuntimeStatuses: (): Promise<{ success: boolean; statuses?: any[]; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:list-runtime-statuses');
    },

    /**
     * 获取插件详情
     */
    get: (pluginId: string): Promise<{ success: boolean; plugin?: any; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:get', pluginId);
    },

    /**
     * 获取单个插件运行态
     */
    getRuntimeStatus: (
      pluginId: string
    ): Promise<{ success: boolean; status?: any; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:get-runtime-status', pluginId);
    },

    /**
     * 卸载插件
     * @param pluginId - 插件ID
     * @param deleteTables - 是否同时删除插件创建的数据表（默认：false）
     */
    uninstall: (
      pluginId: string,
      deleteTables?: boolean
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:uninstall', pluginId, deleteTables ?? false);
    },

    /**
     * 取消插件的所有运行中/排队任务
     */
    cancelPluginTasks: (
      pluginId: string
    ): Promise<{ success: boolean; cancelled?: number; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:cancel-plugin-tasks', pluginId);
    },

    /**
     * 🆕 获取插件创建的数据表列表
     * @param pluginId - 插件ID
     */
    getTables: (
      pluginId: string
    ): Promise<{
      success: boolean;
      tables?: Array<{
        id: string;
        name: string;
        rowCount: number;
        columnCount: number;
        sizeBytes: number;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('js-plugin:get-tables', pluginId);
    },

    /**
     * 执行插件
     */
    execute: (
      pluginId: string,
      config: any
    ): Promise<{ success: boolean; result?: any; error?: string; duration?: number }> => {
      return ipcRenderer.invoke('js-plugin:execute', pluginId, config);
    },

    /**
     * 从按钮执行插件
     */
    executeFromButton: (
      pluginId: string,
      config: any,
      rowData: any
    ): Promise<{ success: boolean; result?: any; error?: string; duration?: number }> => {
      return ipcRenderer.invoke('js-plugin:execute-from-button', pluginId, config, rowData);
    },

    /**
     * 重新加载插件
     */
    reload: (pluginId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:reload', pluginId);
    },

    /**
     * 🆕 修复插件（重新创建符号链接）
     */
    repairPlugin: (
      pluginId: string
    ): Promise<{ success: boolean; result: { success: boolean; message: string } }> => {
      return ipcRenderer.invoke('js-plugin:repair', pluginId);
    },

    /**
     * 获取插件配置
     */
    getConfig: (pluginId: string, key: string): Promise<any> => {
      return ipcRenderer.invoke('js-plugin:get-config', pluginId, key);
    },

    /**
     * 设置插件配置
     */
    setConfig: (
      pluginId: string,
      key: string,
      value: any
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:set-config', pluginId, key, value);
    },

    /**
     * 🆕 启用插件
     */
    enable: (pluginId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:enable', pluginId);
    },

    /**
     * 🆕 禁用插件
     */
    disable: (pluginId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:disable', pluginId);
    },

    // ========== 🆕 UI 扩展相关 ==========

    /**
     * 执行命令
     */
    executeCommand: (
      pluginId: string,
      commandId: string,
      params: any
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:execute-command', pluginId, commandId, params);
    },

    /**
     * 获取数据集的工具栏按钮
     */
    getToolbarButtons: (
      datasetId: string
    ): Promise<{ success: boolean; toolbarButtons?: any[]; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:get-toolbar-buttons', datasetId);
    },

    /**
     * 执行按钮字段命令（从数据表的 button 字段触发）
     */
    executeActionColumn: (
      pluginId: string,
      commandId: string,
      rowid: number,
      datasetId: string
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      return ipcRenderer.invoke(
        'js-plugin:execute-action-column',
        pluginId,
        commandId,
        rowid,
        datasetId
      );
    },

    /**
     * 执行工具栏按钮命令
     */
    executeToolbarButton: (
      pluginId: string,
      commandId: string,
      selectedRows: any[]
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      return ipcRenderer.invoke(
        'js-plugin:execute-toolbar-button',
        pluginId,
        commandId,
        selectedRows
      );
    },

    /**
     * 🆕 监听插件状态变化
     */
    onPluginStateChanged: (
      callback: (data: {
        pluginId: string;
        state: 'installed' | 'uninstalled' | 'repaired' | 'enabled' | 'disabled';
      }) => void
    ) => {
      const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on('js-plugin:state-changed', subscription);

      // 返回取消订阅函数
      return () => {
        ipcRenderer.removeListener('js-plugin:state-changed', subscription);
      };
    },

    // ========== 🆕 自定义页面相关 ==========

    /**
     * 🆕 获取插件的自定义页面列表
     */
    getCustomPages: (
      pluginId: string,
      datasetId?: string
    ): Promise<{ success: boolean; pages?: any[]; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:get-custom-pages', pluginId, datasetId);
    },

    /**
     * 🆕 渲染自定义页面内容
     */
    renderCustomPage: (
      pluginId: string,
      pageId: string,
      datasetId?: string
    ): Promise<{ success: boolean; html?: string; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:render-custom-page', pluginId, pageId, datasetId);
    },

    /**
     * 🆕 发送页面消息到插件
     */
    sendPageMessage: (
      message: any
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:page-message', message);
    },

    // ========== ✅ Activity Bar 视图和 API 调用 ==========

    /**
     * ✅ 调用插件暴露的 API
     */
    callPluginAPI: (
      pluginId: string,
      apiName: string,
      ...args: any[]
    ): Promise<{ success: boolean; result?: any; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:call-api', pluginId, apiName, args);
    },

    /**
     * ✅ 显示插件视图
     */
    showPluginView: (
      pluginId: string,
      bounds?: { x: number; y: number; width: number; height: number }
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:show-view', pluginId, bounds);
    },

    /**
     * ✅ 隐藏插件视图
     */
    hidePluginView: (pluginId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:hide-view', pluginId);
    },

    /**
     * ✅ 获取插件视图信息
     */
    getPluginViewInfo: (
      pluginId: string
    ): Promise<{
      success: boolean;
      viewInfo?: {
        hasPageView: boolean;
        pageViewId: string | null;
        tempViewCount: number;
        tempViewIds: string[];
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('js-plugin:get-view-info', pluginId);
    },

    /**
     * ✨ 设置插件视图边界（动态调整位置和大小）
     */
    setViewBounds: (
      pluginId: string,
      bounds: { x?: number; y?: number; width?: number; height?: number }
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:set-view-bounds', pluginId, bounds);
    },

    /**
     * ✨ 获取布局信息（Activity Bar 宽度、可用空间等）
     */
    getLayoutInfo: (
      pluginId: string
    ): Promise<{
      success: boolean;
      layoutInfo?: {
        activityBarWidth: number;
        availableWidth: number;
        availableHeight: number;
        windowWidth: number;
        windowHeight: number;
        contentTopInset: number;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('js-plugin:get-layout-info', pluginId);
    },

    // ========== 🆕 热重载相关 ==========

    /**
     * 启用插件的热重载（文件监听）
     */
    enableHotReload: (
      pluginId: string
    ): Promise<{ success: boolean; message?: string; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:enable-hot-reload', pluginId);
    },

    /**
     * 禁用插件的热重载（文件监听）
     */
    disableHotReload: (
      pluginId: string
    ): Promise<{ success: boolean; message?: string; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:disable-hot-reload', pluginId);
    },

    /**
     * 获取插件的热重载状态
     */
    getHotReloadStatus: (
      pluginId: string
    ): Promise<{ success: boolean; enabled?: boolean; error?: string }> => {
      return ipcRenderer.invoke('js-plugin:get-hot-reload-status', pluginId);
    },

    /**
     * 监听插件热重载完成事件
     */
    onPluginReloaded: (
      callback: (data: { pluginId: string; success: boolean; error?: string }) => void
    ) => {
      const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on('js-plugin:reloaded', subscription);
      return () => {
        ipcRenderer.removeListener('js-plugin:reloaded', subscription);
      };
    },

    /**
     * 监听插件运行态变化事件
     */
    onPluginRuntimeStatusChanged: (
      callback: (data: { pluginId: string; status: any | null; removed?: boolean }) => void
    ) => {
      const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
      ipcRenderer.on('js-plugin:runtime-status-changed', subscription);
      return () => {
        ipcRenderer.removeListener('js-plugin:runtime-status-changed', subscription);
      };
    },

    /**
     * 监听插件通知事件
     */
    onPluginNotification: (callback: (data: PluginNotificationPayload) => void) => {
      const subscription = (_event: IpcRendererEvent, data: PluginNotificationPayload) =>
        callback(data);
      ipcRenderer.on('js-plugin:notification', subscription);
      return () => {
        ipcRenderer.removeListener('js-plugin:notification', subscription);
      };
    },
  },

  // ========== 执行控制相关 ==========

  execution: {
    /**
     * 停止持久化执行
     */
    stop: (executionId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('execution:stop', executionId);
    },

    /**
     * 获取所有活跃执行
     */
    getActive: (): Promise<{
      success: boolean;
      executions?: Array<{
        id: string;
        workflow: string;
        workflowId: string;
        concurrency: number;
        status: string;
        startedAt: number;
        stats: any;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('execution:get-active');
    },

    /**
     * 恢复暂停的任务
     */
    resume: (taskId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('execution:resume', taskId);
    },

    /**
     * 获取所有暂停的任务
     */
    getPausedTasks: (): Promise<{
      success: boolean;
      tasks?: Array<{
        taskId: string;
        reason: string;
        pausedAt: number;
        timeout?: number;
      }>;
      error?: string;
    }> => {
      return ipcRenderer.invoke('execution:get-paused-tasks');
    },
  },

  // ========== 插件 View 相关 ==========

  /**
   * 监听插件创建的 View
   */
  onPluginViewCreated: (
    callback: (view: {
      id: string;
      partition: string;
      metadata?: {
        label?: string;
        icon?: string;
        order?: number;
        color?: string;
      };
    }) => void
  ) => {
    const subscription = (_event: IpcRendererEvent, view: any) => callback(view);
    ipcRenderer.on('plugin:view-created', subscription);
    return () => ipcRenderer.removeListener('plugin:view-created', subscription);
  },

  /**
   * 监听插件 View 关闭
   */
  onPluginViewClosed: (callback: (data: { viewId: string }) => void) => {
    const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('plugin:view-closed', subscription);
    return () => ipcRenderer.removeListener('plugin:view-closed', subscription);
  },

  /**
   * 通知 View 按钮点击
   */
  notifyViewButtonClick: (viewId: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('view:button-click', viewId);
  },

  };
}
