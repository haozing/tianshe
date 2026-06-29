import type { ElectronAPI } from '../../../../types/electron';

type FolderAPI = ElectronAPI['folder'];
type JsPluginAPI = ElectronAPI['jsPlugin'];

function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron API is not available. Make sure the preload script is loaded.');
  }
  return window.electronAPI;
}

function getFolderApi(): FolderAPI {
  return getElectronAPI().folder;
}

function getJsPluginApi(): JsPluginAPI {
  return getElectronAPI().jsPlugin;
}

export const workspaceFacade = {
  getFolderTree: () => getFolderApi().getTree(),
  moveDataset: (datasetId: string, folderId: string) => getFolderApi().moveDataset(datasetId, folderId),
  createFolder: (
    name: string,
    parentId?: string,
    pluginId?: string,
    options?: Parameters<FolderAPI['create']>[3]
  ) => getFolderApi().create(name, parentId, pluginId, options),
  deleteFolder: (folderId: string, deleteContents = false) =>
    getFolderApi().delete(folderId, deleteContents),
  getCustomPages: (pluginId: string, datasetId?: string) =>
    getJsPluginApi().getCustomPages(pluginId, datasetId),
};
