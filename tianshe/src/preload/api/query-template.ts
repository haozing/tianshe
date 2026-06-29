import type { IpcRenderer } from 'electron';

export function createQueryTemplateAPI(ipcRenderer: IpcRenderer) {
  return {
    create: (params: {
      datasetId: string;
      name: string;
      description?: string;
      icon?: string;
      queryConfig: any;
      generatedSQL: string;
    }): Promise<{ success: boolean; templateId?: string; error?: string }> => {
      return ipcRenderer.invoke('query-template:create', params);
    },
    list: (datasetId: string): Promise<{ success: boolean; templates?: any[]; error?: string }> => {
      return ipcRenderer.invoke('query-template:list', datasetId);
    },
    get: (
      templateId: string
    ): Promise<{
      success: boolean;
      template?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('query-template:get', templateId);
    },
    update: (params: {
      templateId: string;
      name?: string;
      description?: string;
      icon?: string;
      queryConfig?: any;
      generatedSQL?: string;
    }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('query-template:update', params);
    },
    refresh: (
      templateId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('query-template:refresh', { templateId });
    },
    delete: (
      templateId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('query-template:delete', templateId);
    },
    reorder: (
      datasetId: string,
      templateIds: string[]
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke('query-template:reorder', { datasetId, templateIds });
    },
    query: (
      templateId: string,
      offset?: number,
      limit?: number
    ): Promise<{
      success: boolean;
      result?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('query-template:query', { templateId, offset, limit });
    },
    getOrCreateDefault: (
      datasetId: string
    ): Promise<{
      success: boolean;
      template?: any;
      error?: string;
    }> => {
      return ipcRenderer.invoke('query-template:get-or-create-default', datasetId);
    },
  };
}
