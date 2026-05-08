import { type IpcMainInvokeEvent } from 'electron';
import type { DuckDBService } from '../../duckdb/service';
import { validateDatasetColumnNamePolicy } from '../../../utils/dataset-column-name-policy';
import { registerDatasetRoute, registerSchemaMutationRoute } from './route-utils';

export function registerDatasetSchemaRoutes(duckdb: DuckDBService): void {
  registerMaterializeCleanToNewColumns(duckdb);
  registerUpdateColumnMetadata(duckdb);
  registerUpdateColumnDisplayConfig(duckdb);
  registerAddColumn(duckdb);
  registerUpdateColumn(duckdb);
  registerDeleteColumn(duckdb);
  registerReorderColumns(duckdb);
  registerValidateColumnName(duckdb);
  registerAnalyzeTypes(duckdb);
  registerApplySchema(duckdb);
  registerValidateComputeExpression(duckdb);
}

function registerMaterializeCleanToNewColumns(duckdb: DuckDBService): void {
  registerSchemaMutationRoute({
    channel: 'duckdb:materialize-clean-to-new-columns',
    getDatasetId: (params: { datasetId: string }) => params.datasetId,
    handler: async (
      _event,
      params: {
        datasetId: string;
        cleanConfig: any;
      }
    ) => {
      const result = await duckdb.materializeCleanToNewColumns(
        params.datasetId,
        params.cleanConfig
      );

      return { success: true, result };
    },
  });
}

function registerUpdateColumnMetadata(duckdb: DuckDBService): void {
  registerDatasetRoute({
    channel: 'duckdb:update-column-metadata',
    handler: async (
      _event: IpcMainInvokeEvent,
      datasetId: string,
      columnName: string,
      metadata: any
    ) => {
      await duckdb.updateColumnMetadata(datasetId, columnName, metadata);
      return { success: true };
    },
  });
}

function registerUpdateColumnDisplayConfig(duckdb: DuckDBService): void {
  registerSchemaMutationRoute({
    channel: 'duckdb:update-column-display-config',
    getDatasetId: (params: { datasetId: string }) => params.datasetId,
    logError: '[Dataset] Error updating column display config:',
    handler: async (
      _event,
      params: {
        datasetId: string;
        columnName: string;
        displayConfig: any;
      }
    ) => {
      const { datasetId, columnName, displayConfig } = params;
      await duckdb.updateColumnDisplayConfig(datasetId, columnName, displayConfig);

      return { success: true };
    },
  });
}

function registerAddColumn(duckdb: DuckDBService): void {
  registerSchemaMutationRoute({
    channel: 'duckdb:add-column',
    getDatasetId: (params: { datasetId: string }) => params.datasetId,
    logError: '[Dataset] Error adding column:',
    handler: async (
      _event,
      params: {
        datasetId: string;
        columnName: string;
        fieldType: string;
        nullable: boolean;
        metadata?: any;
        storageMode?: 'physical' | 'computed';
        computeConfig?: any;
        validationRules?: any[];
      }
    ) => {
      await duckdb.addColumn(params);

      return { success: true };
    },
  });
}

function registerUpdateColumn(duckdb: DuckDBService): void {
  registerSchemaMutationRoute({
    channel: 'duckdb:update-column',
    getDatasetId: (params: { datasetId: string }) => params.datasetId,
    logError: '[Dataset] Error updating column:',
    handler: async (
      _event,
      params: {
        datasetId: string;
        columnName: string;
        newName?: string;
        fieldType?: string;
        nullable?: boolean;
        metadata?: any;
        computeConfig?: any;
      }
    ) => {
      await duckdb.updateColumn(params);

      return { success: true };
    },
  });
}

function registerDeleteColumn(duckdb: DuckDBService): void {
  registerSchemaMutationRoute({
    channel: 'duckdb:delete-column',
    getDatasetId: (params: { datasetId: string }) => params.datasetId,
    logError: '[Dataset] Error deleting column:',
    handler: async (
      _event,
      params: {
        datasetId: string;
        columnName: string;
        force?: boolean;
      }
    ) => {
      const { datasetId, columnName, force = false } = params;
      await duckdb.deleteColumn(datasetId, columnName, force);

      return { success: true };
    },
  });
}

function registerReorderColumns(duckdb: DuckDBService): void {
  registerSchemaMutationRoute({
    channel: 'duckdb:reorder-columns',
    getDatasetId: (params: { datasetId: string }) => params.datasetId,
    logError: '[Dataset] Error reordering columns:',
    handler: async (
      _event,
      params: {
        datasetId: string;
        columnNames: string[];
      }
    ) => {
      const { datasetId, columnNames } = params;
      await duckdb.reorderColumns(datasetId, columnNames);

      return { success: true };
    },
  });
}

function registerValidateColumnName(duckdb: DuckDBService): void {
  registerDatasetRoute({
    channel: 'duckdb:validate-column-name',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string, columnName: string) => {
      const dataset = await duckdb.getDatasetInfo(datasetId);
      if (!dataset) {
        return { success: false, error: '数据集不存在' };
      }

      const policyResult = validateDatasetColumnNamePolicy(columnName);
      if (!policyResult.valid) {
        return {
          success: true,
          valid: false,
          message: policyResult.message,
        };
      }

      const exists =
        dataset.schema?.some((col) => col.name === policyResult.normalizedName) || false;

      return {
        success: true,
        valid: !exists,
        message: exists ? '列名已存在' : '列名可用',
      };
    },
  });
}

function registerAnalyzeTypes(duckdb: DuckDBService): void {
  registerDatasetRoute({
    channel: 'duckdb:analyze-types',
    logError: '[TypeAnalyzer] Error:',
    handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
      const startTime = Date.now();
      const result = await duckdb.analyzeDatasetTypes(datasetId);

      const duration = Date.now() - startTime;

      return {
        success: true,
        schema: result.schema,
        sampleData: result.sampleData,
        duration,
      };
    },
  });
}

function registerApplySchema(duckdb: DuckDBService): void {
  registerSchemaMutationRoute({
    channel: 'duckdb:apply-schema',
    getDatasetId: (params: { datasetId: string }) => params.datasetId,
    logError: '[Dataset] Error applying schema:',
    handler: async (
      _event,
      params: {
        datasetId: string;
        schema: any[];
      }
    ) => {
      const { datasetId, schema } = params;
      await duckdb.updateDatasetSchema(datasetId, schema);

      return { success: true };
    },
  });
}

function registerValidateComputeExpression(duckdb: DuckDBService): void {
  registerDatasetRoute({
    channel: 'duckdb:validate-compute-expression',
    logError: '[Dataset] Error validating compute expression:',
    handler: async (
      _event: IpcMainInvokeEvent,
      params: {
        datasetId: string;
        expression: string;
        options?: any;
      }
    ) => {
      const { datasetId, expression, options } = params;
      const result = await duckdb.validateComputeExpression(datasetId, expression, options);
      return { success: true, result };
    },
  });
}
