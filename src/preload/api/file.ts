import type { IpcRenderer } from 'electron';

export function createFileAPI(ipcRenderer: IpcRenderer) {
  return {
    upload: (
      datasetId: string,
      fileData: { buffer: number[]; filename: string }
    ): Promise<{
      success: boolean;
      metadata?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:upload', datasetId, fileData);
    },

    uploadFromPath: (
      datasetId: string,
      fileData: { filePath: string; filename?: string }
    ): Promise<{
      success: boolean;
      metadata?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:upload-from-path', datasetId, fileData);
    },

    delete: (
      relativePath: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:delete', relativePath);
    },

    open: (
      relativePath: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:open', relativePath);
    },

    getUrl: (
      relativePath: string
    ): Promise<{
      success: boolean;
      url?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:getUrl', relativePath);
    },

    getImageData: (
      relativePath: string
    ): Promise<{
      success: boolean;
      data?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:getImageData', relativePath);
    },

    deleteDatasetFiles: (
      datasetId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('file:deleteDatasetFiles', datasetId);
    },
  };
}
