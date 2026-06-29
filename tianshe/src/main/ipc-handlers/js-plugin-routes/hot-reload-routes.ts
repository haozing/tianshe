import { type IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import { handleIPCError } from '../../ipc-utils';
import type { JSPluginManager } from '../../../core/js-plugin/manager';

export function registerJSPluginHotReloadRoutes(pluginManager: JSPluginManager): void {
  registerEnableHotReload(pluginManager);
  registerDisableHotReload(pluginManager);
  registerGetHotReloadStatus(pluginManager);
}

function registerEnableHotReload(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:enable-hot-reload',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const result = await pluginManager.enableHotReload(pluginId);
        return { success: result.success, message: result.message };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerDisableHotReload(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:disable-hot-reload',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const result = await pluginManager.disableHotReload(pluginId);
        return { success: result.success, message: result.message };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerGetHotReloadStatus(pluginManager: JSPluginManager): void {
  ipcRouteRegistry.register({
    channel: 'js-plugin:get-hot-reload-status',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, pluginId: string) => {
      try {
        const isEnabled = pluginManager.isHotReloadEnabled(pluginId);
        return { success: true, enabled: isEnabled };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}
