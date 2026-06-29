import { type IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import type { DuckDBService } from '../../duckdb/service';
import { createDatasetRouteErrorResult } from './dataset-route-errors';
import { logDatasetRouteError, logDatasetRouteWarning } from './dataset-route-logger';

export function registerDatasetRecordRoutes(duckdb: DuckDBService): void {
  registerInsertRecord(duckdb);
  registerBatchInsertRecords(duckdb);
  registerUpdateRecord(duckdb);
  registerBatchUpdateRecords(duckdb);
  registerGetRecordEvidence(duckdb);
  registerHardDeleteRows(duckdb);
  registerDeleteRowsByAhoCorasickFilter(duckdb);
}

function registerInsertRecord(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:insert-record',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      datasetId: string,
      record: Record<string, any>
    ) => {
      try {
        await duckdb.insertRecord(datasetId, record);
        return { success: true };
      } catch (error: unknown) {
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}

function registerBatchInsertRecords(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:batch-insert-records',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      datasetId: string,
      records: Record<string, any>[]
    ) => {
      try {
        await duckdb.batchInsertRecords(datasetId, records);
        return { success: true };
      } catch (error: unknown) {
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}

function registerUpdateRecord(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:update-record',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      datasetId: string,
      rowId: number,
      updates: Record<string, any>
    ) => {
      try {
        await duckdb.updateRecord(datasetId, rowId, updates);
        return { success: true };
      } catch (error: unknown) {
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}

function registerBatchUpdateRecords(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:batch-update-records',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      datasetId: string,
      updates: Array<{ rowId: number; updates: Record<string, any> }>
    ) => {
      try {
        await duckdb.batchUpdateRecords(datasetId, updates);
        return { success: true };
      } catch (error: unknown) {
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}

function registerGetRecordEvidence(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:get-record-evidence',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      datasetId: string,
      rowId: number,
      limit?: number
    ) => {
      try {
        const evidence = await duckdb.getDatasetRecordEvidence(datasetId, rowId, limit);
        return { success: true, evidence };
      } catch (error: unknown) {
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}

function registerHardDeleteRows(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:hard-delete-rows',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      params: {
        datasetId: string;
        rowIds: number[];
      }
    ): Promise<{ success: boolean; deletedCount?: number; error?: string; code?: string }> => {
      try {
        logDatasetRouteWarning('Permanently deleting dataset rows', {
          datasetId: params.datasetId,
          rowCount: params.rowIds.length,
        });

        const deletedCount = await duckdb.hardDeleteRows(params.datasetId, params.rowIds);

        return {
          success: true,
          deletedCount,
        };
      } catch (error) {
        logDatasetRouteError('Failed to hard delete rows', error, {
          datasetId: params.datasetId,
          rowCount: params.rowIds.length,
        });
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}

function registerDeleteRowsByAhoCorasickFilter(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:ac-filter-delete-rows',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event,
      params: {
        datasetId: string;
        targetField: string;
        dictDatasetId: string;
        dictField: string;
        filterType: 'contains_multi' | 'excludes_multi';
      }
    ): Promise<{ success: boolean; deletedCount?: number; error?: string; code?: string }> => {
      try {
        const deletedCount = await duckdb.deleteRowsByAhoCorasickFilter(params);
        return { success: true, deletedCount };
      } catch (error) {
        return createDatasetRouteErrorResult(error);
      }
    },
  });
}
