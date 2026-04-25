/**
 * Dataset Folder IPC Handler
 * 处理前端文件夹相关的 IPC 请求
 */

import { ipcMain } from 'electron';
import type { DuckDBService } from '../duckdb/service';

export function registerDatasetFolderHandlers(duckDBService: DuckDBService) {
  // ✅ 使用统一的服务层
  const folderService = duckDBService.getFolderService();

  // 创建文件夹
  ipcMain.handle(
    'folder:create',
    async (_, name: string, parentId?: string, pluginId?: string, options?: any) => {
      try {
        const folderId = await folderService.createFolder(
          name,
          parentId || null,
          pluginId || null,
          options
        );
        return { success: true, folderId };
      } catch (error) {
        console.error('[IPC] folder:create error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : '创建文件夹失败',
        };
      }
    }
  );

  // 获取文件夹树
  ipcMain.handle('folder:get-tree', async () => {
    try {
      const tree = await folderService.getFolderTree();
      return { success: true, tree };
    } catch (error) {
      console.error('[IPC] folder:get-tree error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取文件夹树失败',
      };
    }
  });

  // 移动数据集到文件夹
  ipcMain.handle('folder:move-dataset', async (_, datasetId: string, folderId: string | null) => {
    try {
      await folderService.moveDatasetToFolder(datasetId, folderId);
      return { success: true };
    } catch (error) {
      console.error('[IPC] folder:move-dataset error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '移动失败',
      };
    }
  });

  // 删除文件夹
  ipcMain.handle('folder:delete', async (_, folderId: string, deleteContents: boolean) => {
    try {
      await folderService.deleteFolder(folderId, deleteContents);
      return { success: true };
    } catch (error) {
      console.error('[IPC] folder:delete error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '删除文件夹失败',
      };
    }
  });

  // 更新文件夹信息
  ipcMain.handle('folder:update', async (_, folderId: string, updates: any) => {
    try {
      await folderService.updateFolder(folderId, updates);
      return { success: true };
    } catch (error) {
      console.error('[IPC] folder:update error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '更新文件夹失败',
      };
    }
  });

  // 调整表顺序
  ipcMain.handle('folder:reorder-tables', async (_, folderId: string, tableIds: string[]) => {
    try {
      await folderService.reorderTables(folderId, tableIds);
      return { success: true };
    } catch (error) {
      console.error('[IPC] folder:reorder-tables error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '调整顺序失败',
      };
    }
  });

  // 调整文件夹顺序
  ipcMain.handle('folder:reorder-folders', async (_, folderIds: string[]) => {
    try {
      await folderService.reorderFolders(folderIds);
      return { success: true };
    } catch (error) {
      console.error('[IPC] folder:reorder-folders error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '调整顺序失败',
      };
    }
  });

  // 为现有插件补充创建文件夹
  ipcMain.handle('folder:create-for-existing-plugins', async () => {
    try {
      await folderService.createFoldersForExistingPlugins();
      return { success: true };
    } catch (error) {
      console.error('[IPC] folder:create-for-existing-plugins error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '创建文件夹失败',
      };
    }
  });

  console.log('✅ Dataset folder IPC handlers registered');
}
