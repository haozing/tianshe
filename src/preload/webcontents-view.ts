import { contextBridge, ipcRenderer } from 'electron';

const pluginBridge = Object.freeze({
  callPluginAPI: (
    apiName: string,
    ...args: any[]
  ): Promise<{ success: boolean; result?: any; error?: string }> => {
    return ipcRenderer.invoke('js-plugin:call-api-bound', apiName, args);
  },
});

contextBridge.exposeInMainWorld(
  'electronAPI',
  Object.freeze({
    jsPlugin: pluginBridge,
  })
);
