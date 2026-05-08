import type { IpcRenderer } from 'electron';
import type { CreateTagParams, Tag, UpdateTagParams } from '../../types/profile';

export function createTagAPI(ipcRenderer: IpcRenderer) {
  return {
    create: (
      params: CreateTagParams
    ): Promise<{
      success: boolean;
      data?: Tag;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:create', params);
    },

    get: (
      id: string
    ): Promise<{
      success: boolean;
      data?: Tag | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:get', id);
    },

    getByName: (
      name: string
    ): Promise<{
      success: boolean;
      data?: Tag | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:get-by-name', name);
    },

    list: (): Promise<{
      success: boolean;
      data?: Tag[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:list');
    },

    update: (
      id: string,
      params: UpdateTagParams
    ): Promise<{
      success: boolean;
      data?: Tag;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:update', id, params);
    },

    delete: (
      id: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:delete', id);
    },

    exists: (
      name: string
    ): Promise<{
      success: boolean;
      data?: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('tag:exists', name);
    },
  };
}
