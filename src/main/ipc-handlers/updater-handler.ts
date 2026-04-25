/**
 * 更新相关 IPC 处理器
 */

import { ipcMain, app } from 'electron';
import type { UpdateManager } from '../updater';
import { handleIPCError } from '../ipc-utils';

export function registerUpdaterHandlers(updateManager: UpdateManager): void {
  // 手动检查更新
  ipcMain.handle('updater:check-for-updates', async () => {
    try {
      await updateManager.checkForUpdates();
      return { success: true };
    } catch (error: unknown) {
      return handleIPCError(error);
    }
  });

  // 手动下载更新（通常自动下载已启用，此方法用于重试）
  ipcMain.handle('updater:download-update', async () => {
    try {
      await updateManager.downloadUpdate();
      return { success: true };
    } catch (error: unknown) {
      return handleIPCError(error);
    }
  });

  // 安装更新并重启
  ipcMain.handle('updater:quit-and-install', () => {
    updateManager.quitAndInstall();
    return { success: true };
  });

  // 获取当前版本
  ipcMain.handle('updater:get-version', () => {
    return { version: app.getVersion() };
  });

  console.log('✅ Updater IPC handlers registered');
}
