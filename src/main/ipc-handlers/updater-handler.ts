/**
 * 更新相关 IPC 处理器
 */

import { app } from 'electron';
import type { UpdateManager } from '../updater';
import { handleIPCError } from '../ipc-utils';
import type { IpcRouteDefinition } from '../ipc-route-registry';
import { createLogger } from '../../core/logger';

const logger = createLogger('UpdaterIPCHandler');

export function createUpdaterRoutes(updateManager: UpdateManager): IpcRouteDefinition[] {
  return [
    {
      channel: 'updater:check-for-updates',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async () => {
        try {
          await updateManager.checkForUpdates();
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'updater:download-update',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async () => {
        try {
          await updateManager.downloadUpdate();
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'updater:quit-and-install',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: () => {
        updateManager.quitAndInstall();
        return { success: true };
      },
    },
    {
      channel: 'updater:get-version',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: () => {
        return { version: app.getVersion() };
      },
    },
  ];
}

import { ipcRouteRegistry } from '../ipc-route-registry';

/** @deprecated 使用 createUpdaterRoutes + ipcRouteRegistry.registerAll */
export function registerUpdaterHandlers(updateManager: UpdateManager): void {
  ipcRouteRegistry.registerAll(createUpdaterRoutes(updateManager));
  logger.info('Updater IPC handlers registered');
}
