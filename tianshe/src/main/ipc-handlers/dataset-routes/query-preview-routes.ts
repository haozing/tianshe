import { type IpcMainInvokeEvent } from 'electron';
import { ipcRouteRegistry } from '../../ipc-route-registry';
import type { DuckDBService } from '../../duckdb/service';
import { handleIPCError } from '../../ipc-utils';
import { logDatasetRouteError } from './dataset-route-logger';

export function registerDatasetQueryPreviewRoutes(duckdb: DuckDBService): void {
  registerExecuteQuery(duckdb);
  registerPreviewQuerySQL(duckdb);
  registerPreviewClean(duckdb);
  registerPreviewDedupe(duckdb);
  registerPreviewFilterCount(duckdb);
  registerPreviewAggregate(duckdb);
  registerPreviewSample(duckdb);
  registerPreviewLookup(duckdb);
  registerPreviewGroup(duckdb);
}

function registerExecuteQuery(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:execute-query',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string, config: any) => {
      try {
        const result = await duckdb.queryWithEngine(datasetId, config);
        return { success: true, result };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerPreviewQuerySQL(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:preview-query-sql',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string, config: any) => {
      try {
        return await duckdb.previewQuerySQL(datasetId, config);
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerPreviewClean(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:preview-clean',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string, config: any, options?: any) => {
      try {
        const result = await duckdb.previewClean(datasetId, config, options);
        return { success: true, result };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerPreviewDedupe(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:preview-dedupe',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string, config: any, options?: any) => {
      try {
        const result = await duckdb.previewDedupe(datasetId, config, options);
        return { success: true, result };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    },
  });
}

function registerPreviewFilterCount(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:preview-filter-count',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      params: {
        datasetId: string;
        filterConfig: any;
      }
    ) => {
      try {
        const { datasetId, filterConfig } = params;
        const result = await duckdb.previewFilterCount(datasetId, filterConfig);
        return { success: true, result };
      } catch (error: unknown) {
        logDatasetRouteError('Error previewing filter', error, { datasetId: params.datasetId });
        return handleIPCError(error);
      }
    },
  });
}

function registerPreviewAggregate(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:preview-aggregate',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      params: {
        datasetId: string;
        aggregateConfig: any;
        options?: any;
      }
    ) => {
      try {
        const { datasetId, aggregateConfig, options } = params;
        const result = await duckdb.previewAggregate(datasetId, aggregateConfig, options);
        return { success: true, result };
      } catch (error: unknown) {
        logDatasetRouteError('Error previewing aggregate', error, {
          datasetId: params.datasetId,
        });
        return handleIPCError(error);
      }
    },
  });
}

function registerPreviewSample(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:preview-sample',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      params: {
        datasetId: string;
        sampleConfig: any;
        queryConfig?: any;
      }
    ) => {
      try {
        const { datasetId, sampleConfig, queryConfig } = params;
        const result = await duckdb.previewSample(datasetId, sampleConfig, queryConfig);
        return { success: true, result };
      } catch (error: unknown) {
        logDatasetRouteError('Error previewing sample', error, { datasetId: params.datasetId });
        return handleIPCError(error);
      }
    },
  });
}

function registerPreviewLookup(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:preview-lookup',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      params: {
        datasetId: string;
        lookupConfig: any;
        options?: any;
      }
    ) => {
      try {
        const { datasetId, lookupConfig, options } = params;
        const result = await duckdb.previewLookup(datasetId, lookupConfig, options);
        return { success: true, result };
      } catch (error: unknown) {
        logDatasetRouteError('Error previewing lookup', error, { datasetId: params.datasetId });
        return handleIPCError(error);
      }
    },
  });
}

function registerPreviewGroup(duckdb: DuckDBService): void {
  ipcRouteRegistry.register({
    channel: 'duckdb:preview-group',
    kind: 'handle',
    permission: 'trusted-renderer',
    handler: async (
      _event: IpcMainInvokeEvent,
      params: {
        datasetId: string;
        groupConfig: any;
        options?: any;
      }
    ) => {
      try {
        const { datasetId, groupConfig, options } = params;
        const result = await duckdb.previewGroup(datasetId, groupConfig, options);
        return { success: true, result };
      } catch (error: unknown) {
        logDatasetRouteError('Error previewing group', error, { datasetId: params.datasetId });
        return handleIPCError(error);
      }
    },
  });
}
