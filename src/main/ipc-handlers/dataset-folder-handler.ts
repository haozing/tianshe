/**
 * Dataset Folder IPC Handler
 * 处理前端文件夹相关的 IPC 请求
 */

import type { DuckDBService } from '../duckdb/service';
import type { IpcRouteDefinition } from '../ipc-route-registry';
import { handleIPCError } from '../ipc-utils';
import { ipcRouteRegistry } from '../ipc-route-registry';

export function createDatasetFolderRoutes(duckDBService: DuckDBService): IpcRouteDefinition[] {
  const folderService = duckDBService.getFolderService();

  return [
    {
      channel: 'folder:create',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_, name: string, parentId?: string, pluginId?: string, options?: any) => {
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
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'folder:get-tree',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async () => {
        try {
          const tree = await folderService.getFolderTree();
          return { success: true, tree };
        } catch (error) {
          console.error('[IPC] folder:get-tree error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'folder:move-dataset',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_, datasetId: string, folderId: string | null) => {
        try {
          await folderService.moveDatasetToFolder(datasetId, folderId);
          return { success: true };
        } catch (error) {
          console.error('[IPC] folder:move-dataset error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'folder:delete',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_, folderId: string, deleteContents: boolean) => {
        try {
          await folderService.deleteFolder(folderId, deleteContents);
          return { success: true };
        } catch (error) {
          console.error('[IPC] folder:delete error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'folder:update',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_, folderId: string, updates: any) => {
        try {
          await folderService.updateFolder(folderId, updates);
          return { success: true };
        } catch (error) {
          console.error('[IPC] folder:update error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'folder:reorder-tables',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_, folderId: string, tableIds: string[]) => {
        try {
          await folderService.reorderTables(folderId, tableIds);
          return { success: true };
        } catch (error) {
          console.error('[IPC] folder:reorder-tables error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'folder:reorder-folders',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_, folderIds: string[]) => {
        try {
          await folderService.reorderFolders(folderIds);
          return { success: true };
        } catch (error) {
          console.error('[IPC] folder:reorder-folders error:', error);
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'folder:create-for-existing-plugins',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async () => {
        try {
          await folderService.createFoldersForExistingPlugins();
          return { success: true };
        } catch (error) {
          console.error('[IPC] folder:create-for-existing-plugins error:', error);
          return handleIPCError(error);
        }
      },
    },
  ];
}

/** @deprecated 使用 createDatasetFolderRoutes + ipcRouteRegistry.registerAll */
export function registerDatasetFolderHandlers(duckDBService: DuckDBService): void {
  ipcRouteRegistry.registerAll(createDatasetFolderRoutes(duckDBService));
  console.log('✅ Dataset folder IPC handlers registered');
}
