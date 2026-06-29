import type { IpcRenderer } from 'electron';

export function createFolderAPI(ipcRenderer: IpcRenderer) {
  return {
    create: (
      name: string,
      parentId?: string,
      pluginId?: string,
      options?: { icon?: string; description?: string }
    ): Promise<{
      success: boolean;
      folderId?: string;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:create', name, parentId, pluginId, options);
    },

    getTree: (): Promise<{
      success: boolean;
      tree?: any[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:get-tree');
    },

    moveDataset: (
      datasetId: string,
      folderId: string | null
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:move-dataset', datasetId, folderId);
    },

    delete: (
      folderId: string,
      deleteContents: boolean
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:delete', folderId, deleteContents);
    },

    update: (
      folderId: string,
      updates: { name?: string; description?: string; icon?: string }
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:update', folderId, updates);
    },

    reorderTables: (
      folderId: string,
      tableIds: string[]
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:reorder-tables', folderId, tableIds);
    },

    reorderFolders: (
      folderIds: string[]
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:reorder-folders', folderIds);
    },

    createForExistingPlugins: (): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('folder:create-for-existing-plugins');
    },
  };
}
