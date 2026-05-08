import type { IpcRenderer } from 'electron';
import type { CreateSavedSiteParams, SavedSite, UpdateSavedSiteParams } from '../../types/profile';

export function createSavedSiteAPI(ipcRenderer: IpcRenderer) {
  return {
    create: (
      params: CreateSavedSiteParams
    ): Promise<{
      success: boolean;
      data?: SavedSite;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:create', params);
    },

    get: (
      id: string
    ): Promise<{
      success: boolean;
      data?: SavedSite | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:get', id);
    },

    getByName: (
      name: string
    ): Promise<{
      success: boolean;
      data?: SavedSite | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:get-by-name', name);
    },

    list: (): Promise<{
      success: boolean;
      data?: SavedSite[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:list');
    },

    update: (
      id: string,
      params: UpdateSavedSiteParams
    ): Promise<{
      success: boolean;
      data?: SavedSite;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:update', id, params);
    },

    delete: (
      id: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:delete', id);
    },

    incrementUsage: (
      id: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('saved-site:increment-usage', id);
    },
  };
}
