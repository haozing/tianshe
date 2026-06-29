import { type IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import type { DuckDBService } from '../../duckdb/service';
import { handleIPCError } from '../../ipc-utils';

export function registerDatasetGroupTabRoutes(duckdb: DuckDBService): void {
  registerListGroupTabs(duckdb);
  registerCreateGroupTabCopy(duckdb);
  registerReorderGroupTabs(duckdb);
  registerRenameGroupTab(duckdb);
}

function registerListGroupTabs(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:list-group-tabs',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
      try {
        const tabs = await duckdb.listGroupTabs(datasetId);
        return { success: true, tabs };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerCreateGroupTabCopy(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:create-group-tab-copy',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, sourceDatasetId: string, newName?: string) => {
      try {
        const result = await duckdb.createGroupTabCopy(sourceDatasetId, newName);
        return { success: true, ...result };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerReorderGroupTabs(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:reorder-group-tabs',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      params: { groupId: string; datasetIds: string[] }
    ) => {
      try {
        await duckdb.reorderGroupTabs(params.groupId, params.datasetIds);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerRenameGroupTab(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:rename-group-tab',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string, newName: string) => {
      try {
        await duckdb.renameGroupTab(datasetId, newName);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}
