import type { ElectronAPI } from '../../../../types/electron';

type JsPluginAPI = ElectronAPI['jsPlugin'];

function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron API is not available. Make sure the preload script is loaded.');
  }
  return window.electronAPI;
}

function getJsPluginApi(): JsPluginAPI {
  return getElectronAPI().jsPlugin;
}

export const pluginFacade = {
  listPlugins: () => getJsPluginApi().list(),
  getPlugin: (pluginId: string) => getJsPluginApi().get(pluginId),
  getCustomPages: (pluginId: string, datasetId?: string) =>
    getJsPluginApi().getCustomPages(pluginId, datasetId),
  getToolbarButtons: (datasetId: string) => getJsPluginApi().getToolbarButtons(datasetId),
  executeActionColumn: (
    pluginId: string,
    commandId: string,
    rowid: number,
    datasetId: string
  ) => getJsPluginApi().executeActionColumn(pluginId, commandId, rowid, datasetId),
  executeToolbarButton: (
    pluginId: string,
    commandId: string,
    selectedRows: Parameters<JsPluginAPI['executeToolbarButton']>[2]
  ) => getJsPluginApi().executeToolbarButton(pluginId, commandId, selectedRows),
  renderCustomPage: (
    pluginId: string,
    pageId: string,
    datasetId?: string
  ) => getJsPluginApi().renderCustomPage(pluginId, pageId, datasetId),
  sendPageMessage: (message: Parameters<JsPluginAPI['sendPageMessage']>[0]) =>
    getJsPluginApi().sendPageMessage(message),
};
