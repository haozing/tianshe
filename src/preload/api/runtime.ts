import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type { InternalBrowserDevToolsConfig } from '../../types/internal-browser';

export function createRuntimeAPI(ipcRenderer: IpcRenderer) {
  return {
    shell: {
      /**
       * 在文件管理器中打开指定路径
       * @param path 要打开的文件或目录路径
       * @returns 空字符串表示成功，否则返回错误信息
       */
      openPath: (path: string): Promise<string> => {
        return ipcRenderer.invoke('shell:openPath', path);
      },
    },

    internalBrowser: {
      getDevToolsConfig: (): Promise<{
        success: boolean;
        config?: InternalBrowserDevToolsConfig;
        error?: string;
      }> => {
        return ipcRenderer.invoke('internal-browser:get-devtools-config');
      },

      setDevToolsConfig: (
        config: InternalBrowserDevToolsConfig
      ): Promise<{
        success: boolean;
        config?: InternalBrowserDevToolsConfig;
        error?: string;
      }> => {
        return ipcRenderer.invoke('internal-browser:set-devtools-config', config);
      },
    },

    updater: {
      checkForUpdates: () => ipcRenderer.invoke('updater:check-for-updates'),

      downloadUpdate: () => ipcRenderer.invoke('updater:download-update'),

      quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),

      getVersion: () => ipcRenderer.invoke('updater:get-version'),

      onChecking: (callback: () => void) => {
        const subscription = () => callback();
        ipcRenderer.on('updater:checking', subscription);
        return () => ipcRenderer.removeListener('updater:checking', subscription);
      },

      onUpdateAvailable: (
        callback: (info: {
          version: string;
          releaseDate: string;
          releaseNotes: string;
          isForceUpdate: boolean;
        }) => void
      ) => {
        const subscription = (_: IpcRendererEvent, info: any) => callback(info);
        ipcRenderer.on('updater:available', subscription);
        return () => ipcRenderer.removeListener('updater:available', subscription);
      },

      onUpdateNotAvailable: (callback: (info: { version: string }) => void) => {
        const subscription = (_: IpcRendererEvent, info: any) => callback(info);
        ipcRenderer.on('updater:not-available', subscription);
        return () => ipcRenderer.removeListener('updater:not-available', subscription);
      },

      onDownloadProgress: (
        callback: (progress: {
          percent: number;
          transferred: number;
          total: number;
          bytesPerSecond: number;
        }) => void
      ) => {
        const subscription = (_: IpcRendererEvent, progress: any) => callback(progress);
        ipcRenderer.on('updater:download-progress', subscription);
        return () => ipcRenderer.removeListener('updater:download-progress', subscription);
      },

      onUpdateDownloaded: (
        callback: (info: { version: string; isForceUpdate: boolean }) => void
      ) => {
        const subscription = (_: IpcRendererEvent, info: any) => callback(info);
        ipcRenderer.on('updater:downloaded', subscription);
        return () => ipcRenderer.removeListener('updater:downloaded', subscription);
      },

      onError: (callback: (error: { message: string; isForceUpdate: boolean }) => void) => {
        const subscription = (_: IpcRendererEvent, error: any) => callback(error);
        ipcRenderer.on('updater:error', subscription);
        return () => ipcRenderer.removeListener('updater:error', subscription);
      },
    },

    httpApi: {
      getConfig: (): Promise<{
        success: boolean;
        storedConfig?: any;
        effectiveConfig?: any;
        runtimeOverrides?: {
          enabled: boolean;
          enableMcp: boolean;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('http-api:get-config');
      },

      setConfig: (
        config: any
      ): Promise<{
        success: boolean;
        error?: string;
      }> => {
        return ipcRenderer.invoke('http-api:set-config', config);
      },

      getRuntimeStatus: (): Promise<{
        success: boolean;
        running?: boolean;
        reachable?: boolean;
        port?: number;
        health?: any;
        metrics?: any;
        runtimeAlerts?: Array<{
          code: string;
          severity: 'warning' | 'critical';
          value: number;
          threshold: number;
          message: string;
        }>;
        diagnosis?: {
          code:
            | 'healthy_self'
            | 'healthy_other_airpa'
            | 'no_listener'
            | 'unresponsive_listener'
            | 'unexpected_health_response';
          severity: 'info' | 'warning' | 'critical';
          owner: 'self' | 'other_airpa' | 'unknown';
          summary: string;
          detail?: string;
          suggestedAction?: string;
          httpStatus?: number;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('http-api:get-runtime-status');
      },

      repairRuntime: (): Promise<{
        success: boolean;
        repaired?: boolean;
        action?: 'started_self' | 'restarted_self' | 'blocked' | 'noop' | 'failed';
        message?: string;
        running?: boolean;
        reachable?: boolean;
        port?: number;
        health?: any;
        metrics?: any;
        runtimeAlerts?: Array<{
          code: string;
          severity: 'warning' | 'critical';
          value: number;
          threshold: number;
          message: string;
        }>;
        diagnosis?: {
          code:
            | 'healthy_self'
            | 'healthy_other_airpa'
            | 'no_listener'
            | 'unresponsive_listener'
            | 'unexpected_health_response';
          severity: 'info' | 'warning' | 'critical';
          owner: 'self' | 'other_airpa' | 'unknown';
          summary: string;
          detail?: string;
          suggestedAction?: string;
          httpStatus?: number;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('http-api:repair-runtime');
      },
    },

    ocrPool: {
      getConfig: (): Promise<{
        success: boolean;
        config?: any;
        error?: string;
      }> => {
        return ipcRenderer.invoke('ocr-pool:get-config');
      },

      setConfig: (
        config: any
      ): Promise<{
        success: boolean;
        config?: any;
        error?: string;
      }> => {
        return ipcRenderer.invoke('ocr-pool:set-config', config);
      },
    },

    scheduler: {
      getAllTasks: (): Promise<{
        success: boolean;
        tasks?: any[];
        total?: number;
        error?: string;
      }> => {
        return ipcRenderer.invoke('scheduler:get-all-tasks');
      },

      getTasksByPlugin: (
        pluginId: string
      ): Promise<{
        success: boolean;
        tasks?: any[];
        error?: string;
      }> => {
        return ipcRenderer.invoke('scheduler:get-tasks-by-plugin', pluginId);
      },

      getTask: (
        taskId: string
      ): Promise<{
        success: boolean;
        task?: any;
        error?: string;
      }> => {
        return ipcRenderer.invoke('scheduler:get-task', taskId);
      },

      getTaskHistory: (
        taskId: string,
        limit?: number
      ): Promise<{
        success: boolean;
        executions?: any[];
        error?: string;
      }> => {
        return ipcRenderer.invoke('scheduler:get-task-history', taskId, limit);
      },

      pauseTask: (
        taskId: string
      ): Promise<{
        success: boolean;
        error?: string;
      }> => {
        return ipcRenderer.invoke('scheduler:pause-task', taskId);
      },

      resumeTask: (
        taskId: string
      ): Promise<{
        success: boolean;
        error?: string;
      }> => {
        return ipcRenderer.invoke('scheduler:resume-task', taskId);
      },

      triggerTask: (
        taskId: string
      ): Promise<{
        success: boolean;
        execution?: any;
        error?: string;
      }> => {
        return ipcRenderer.invoke('scheduler:trigger-task', taskId);
      },

      cancelTask: (
        taskId: string
      ): Promise<{
        success: boolean;
        error?: string;
      }> => {
        return ipcRenderer.invoke('scheduler:cancel-task', taskId);
      },

      getStats: (): Promise<{
        success: boolean;
        stats?: {
          total: number;
          active: number;
          paused: number;
          disabled: number;
          todayExecutions: number;
          todayFailed: number;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('scheduler:get-stats');
      },

      getRecentExecutions: (
        limit?: number
      ): Promise<{
        success: boolean;
        executions?: any[];
        error?: string;
      }> => {
        return ipcRenderer.invoke('scheduler:get-recent-executions', limit);
      },
    },
  };
}
