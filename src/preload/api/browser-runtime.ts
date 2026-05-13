import type { IpcRenderer } from 'electron';
import type { BrowserRuntimeStatus } from '../../core/browser-runtime';
import type { BrowserRuntimeId, BrowserRuntimeSource } from '../../types/browser-runtime';

export function createBrowserRuntimeAPI(ipcRenderer: IpcRenderer) {
  return {
    listStatuses: (): Promise<{
      success: boolean;
      data?: BrowserRuntimeStatus[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-runtime:list-statuses');
    },

    getStatus: (
      runtimeId: BrowserRuntimeId
    ): Promise<{
      success: boolean;
      data?: BrowserRuntimeStatus;
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-runtime:get-status', runtimeId);
    },

    selectExecutable: (
      runtimeId: BrowserRuntimeId
    ): Promise<{
      success: boolean;
      data?: {
        canceled: boolean;
        path?: string;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-runtime:select-executable', runtimeId);
    },

    setCustomPath: (
      runtimeId: BrowserRuntimeId,
      executablePath: string
    ): Promise<{
      success: boolean;
      data?: BrowserRuntimeStatus;
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-runtime:set-custom-path', runtimeId, executablePath);
    },

    setDefaultSource: (
      runtimeId: BrowserRuntimeId
    ): Promise<{
      success: boolean;
      data?: BrowserRuntimeStatus;
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-runtime:set-default-source', runtimeId);
    },

    installManaged: (
      runtimeId: BrowserRuntimeId
    ): Promise<{
      success: boolean;
      data?: BrowserRuntimeStatus;
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-runtime:install-managed', runtimeId);
    },

    openDownloadPage: (
      runtimeId: BrowserRuntimeId
    ): Promise<{
      success: boolean;
      data?: { url: string };
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-runtime:open-download-page', runtimeId);
    },

    getDefaultSource: (
      runtimeId: BrowserRuntimeId
    ): Promise<{
      success: boolean;
      data?: BrowserRuntimeSource;
      error?: string;
    }> => {
      return ipcRenderer.invoke('browser-runtime:get-default-source', runtimeId);
    },
  };
}
