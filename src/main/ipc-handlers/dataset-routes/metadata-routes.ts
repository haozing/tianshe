import { type IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import type { DuckDBService } from '../../duckdb/service';
import { handleIPCError } from '../../ipc-utils';

export function registerDatasetMetadataRoutes(duckdb: DuckDBService): void {
  registerListDatasets(duckdb);
  registerGetDatasetInfo(duckdb);
  registerQueryDataset(duckdb);
  registerDeleteDataset(duckdb);
  registerRenameDataset(duckdb);
  registerCreateEmptyDataset(duckdb);
}

function registerListDatasets(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:list-datasets',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async () => {
      try {
        const datasets = await duckdb.listDatasets();
        return { success: true, datasets };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerGetDatasetInfo(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:get-dataset-info',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
      try {
        const dataset = await duckdb.getDatasetInfo(datasetId);

        if (!dataset) {
          return { success: false, error: `Dataset not found: ${datasetId}` };
        }

        if (dataset.schema && Array.isArray(dataset.schema)) {
          const missingFieldType = dataset.schema.filter((col) => !col.fieldType);
          if (missingFieldType.length > 0) {
            console.warn(
              `[IPC] WARNING ${missingFieldType.length} columns missing fieldType:`,
              missingFieldType.map((col) => col.name)
            );
          }
        } else {
          console.warn(`[IPC] WARNING Dataset has no valid schema!`);
        }

        return { success: true, dataset };
      } catch (error: unknown) {
        console.error(`[IPC] Error in getDatasetInfo:`, error);
        return handleIPCError(error);
      }
    },
  });
}

function registerQueryDataset(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:query-dataset',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      datasetId: string,
      sql?: string,
      offset?: number,
      limit?: number
    ) => {
      try {
        const result = await duckdb.queryDataset(datasetId, sql, offset, limit);
        return { success: true, result };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerDeleteDataset(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:delete-dataset',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
      try {
        await duckdb.deleteDataset(datasetId);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerRenameDataset(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:rename-dataset',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string, newName: string) => {
      try {
        await duckdb.renameDataset(datasetId, newName);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerCreateEmptyDataset(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:create-empty-dataset',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      datasetName: string,
      options?: { folderId?: string | null }
    ) => {
      try {
        const datasetId = await duckdb.createEmptyDataset(datasetName, options);
        return { success: true, datasetId };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}
