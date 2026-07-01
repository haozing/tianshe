import type { IpcRenderer } from 'electron';
import type {
  FailureBundle,
  RecentFailureSummary,
  RuntimeArtifact,
  TraceSummary,
  TraceTimeline,
} from '../../core/observability/types';
import type { DownloadInfo } from '../../main/download';
import type { LogEntry } from '../../main/log-storage-service';
import type { AppShellConfig } from '../../shared/app-shell-config';

export function createSystemAPI(ipcRenderer: IpcRenderer) {
  return {
    /**
     * 获取任务日志
     */
    getTaskLogs: (taskId: string, level?: string): Promise<LogEntry[]> => {
      return ipcRenderer.invoke('get-task-logs', taskId, level);
    },

    /**
     * 获取最近日志
     */
    getRecentLogs: (limit?: number, level?: string): Promise<LogEntry[]> => {
      return ipcRenderer.invoke('get-recent-logs', limit, level);
    },

    /**
     * 获取日志统计
     */
    getLogStats: (
      taskId?: string
    ): Promise<{ total: number; byLevel: { [key: string]: number } }> => {
      return ipcRenderer.invoke('get-log-stats', taskId);
    },

    /**
     * 清理日志
     */
    cleanupLogs: (daysToKeep?: number): Promise<{ deleted: number }> => {
      return ipcRenderer.invoke('cleanup-logs', daysToKeep);
    },

    observation: {
      getTraceSummary: (
        traceId: string
      ): Promise<{
        success: boolean;
        data?: TraceSummary;
        error?: string;
      }> => {
        return ipcRenderer.invoke('observation:get-trace-summary', traceId);
      },

      getFailureBundle: (
        traceId: string
      ): Promise<{
        success: boolean;
        data?: FailureBundle;
        error?: string;
      }> => {
        return ipcRenderer.invoke('observation:get-failure-bundle', traceId);
      },

      getTraceTimeline: (
        traceId: string,
        limit?: number
      ): Promise<{
        success: boolean;
        data?: TraceTimeline;
        error?: string;
      }> => {
        return ipcRenderer.invoke('observation:get-trace-timeline', { traceId, limit });
      },

      searchRecentFailures: (
        limit?: number
      ): Promise<{
        success: boolean;
        data?: RecentFailureSummary[];
        error?: string;
      }> => {
        return ipcRenderer.invoke('observation:search-recent-failures', limit);
      },

      getArtifact: (
        artifactId: string
      ): Promise<{
        success: boolean;
        data?: RuntimeArtifact | null;
        error?: string;
      }> => {
        return ipcRenderer.invoke('observation:get-artifact', artifactId);
      },

      openArtifactFile: (
        artifactId: string
      ): Promise<{
        success: boolean;
        data?: { success: true };
        error?: string;
      }> => {
        return ipcRenderer.invoke('observation:open-artifact-file', artifactId);
      },

      revealArtifactFile: (
        artifactId: string
      ): Promise<{
        success: boolean;
        data?: { success: true };
        error?: string;
      }> => {
        return ipcRenderer.invoke('observation:reveal-artifact-file', artifactId);
      },

      saveArtifactFileAs: (
        artifactId: string
      ): Promise<{
        success: boolean;
        data?: {
          success: true;
          canceled: boolean;
          bytesWritten?: number;
          sha256?: string;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('observation:save-artifact-file-as', artifactId);
      },

      deleteArtifactFile: (
        artifactId: string
      ): Promise<{
        success: boolean;
        data?: { success: true; deleted: boolean };
        error?: string;
      }> => {
        return ipcRenderer.invoke('observation:delete-artifact-file', artifactId);
      },
    },

    /**
     * 下载图片并转换为 Base64
     * 使用 Node.js 环境，绕过浏览器的 CORS 限制
     */
    downloadImage: (
      url: string
    ): Promise<{
      success: boolean;
      data?: string;
      size?: number;
      mimeType?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('download-image', url);
    },

    /**
     * 获取下载信息
     */
    getDownload: (id: string): Promise<DownloadInfo | undefined> => {
      return ipcRenderer.invoke('get-download', id);
    },

    /**
     * 获取 Partition 的下载
     */
    getPartitionDownloads: (partition: string): Promise<DownloadInfo[]> => {
      return ipcRenderer.invoke('get-partition-downloads', partition);
    },

    /**
     * 获取所有下载
     */
    getAllDownloads: (): Promise<DownloadInfo[]> => {
      return ipcRenderer.invoke('get-all-downloads');
    },

    /**
     * 删除下载文件
     */
    deleteDownloadFile: (id: string): Promise<{ success: boolean }> => {
      return ipcRenderer.invoke('delete-download-file', id);
    },

    /**
     * 获取下载统计
     */
    getDownloadStats: (
      partition?: string
    ): Promise<{
      total: number;
      completed: number;
      progressing: number;
      cancelled: number;
      interrupted: number;
    }> => {
      return ipcRenderer.invoke('get-download-stats', partition);
    },

    /**
     * 获取应用信息
     */
    getAppInfo: (): Promise<{
      success: boolean;
      info?: {
        version: string;
        platform: string;
        arch: string;
        nodeVersion: string;
        isPackaged?: boolean;
        isDevelopment?: boolean;
        isFromAsar?: boolean;
        shouldShowDevOptions?: boolean;
        appShell?: AppShellConfig;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('get-app-info');
    },

    /**
     * 获取设备指纹
     */
    getDeviceFingerprint: (): Promise<{
      success: boolean;
      fingerprint?: string;
      error?: string;
      source?: 'native' | 'fallback';
      warning?: string;
    }> => {
      return ipcRenderer.invoke('get-device-fingerprint');
    },
  };
}
