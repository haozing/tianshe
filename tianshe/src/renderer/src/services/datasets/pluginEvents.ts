import type { ElectronAPI } from '../../../../types/electron';

type JsPluginAPI = ElectronAPI['jsPlugin'];
type ListenerPayload<T> = T extends (callback: (payload: infer P) => void) => unknown ? P : never;

export type PluginReloadedEvent = ListenerPayload<JsPluginAPI['onPluginReloaded']>;
export type PluginStateChangedEvent = ListenerPayload<JsPluginAPI['onPluginStateChanged']>;

function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron API is not available. Make sure the preload script is loaded.');
  }
  return window.electronAPI;
}

function getJsPluginApi(): JsPluginAPI {
  return getElectronAPI().jsPlugin;
}

export const pluginEvents = {
  subscribeToPluginStateChanged: (callback: (event: PluginStateChangedEvent) => void) =>
    getJsPluginApi().onPluginStateChanged(callback),
  subscribeToPluginReloaded: (callback: (event: PluginReloadedEvent) => void) =>
    getJsPluginApi().onPluginReloaded(callback),
};
