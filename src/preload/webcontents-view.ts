import { contextBridge, ipcRenderer } from 'electron';

const pluginBridge = Object.freeze({
  callPluginAPI: (
    pluginId: string,
    apiName: string,
    ...args: any[]
  ): Promise<{ success: boolean; result?: any; error?: string }> => {
    return ipcRenderer.invoke('js-plugin:call-api', pluginId, apiName, args);
  },
});

contextBridge.exposeInMainWorld(
  'electronAPI',
  Object.freeze({
    jsPlugin: pluginBridge,
  })
);
