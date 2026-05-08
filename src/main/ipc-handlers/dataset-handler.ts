/**
 * DatasetIPCHandler - 数据集管理处理器
 * 负责：数据集导入、查询、CRUD操作
 */

import { IpcMainInvokeEvent, dialog, BrowserWindow } from 'electron';
import { ipcRouteRegistry } from '../ipc-route-registry';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DuckDBService } from '../duckdb/service';
import { handleIPCError } from '../ipc-utils';
import type { ExportOptions, ExportPathParams, ExportProgress } from '../../types/dataset-export';
import { validateDatasetColumnNamePolicy } from '../../utils/dataset-column-name-policy';

export const MAX_IMPORT_RECORDS_BASE64_BYTES = 500 * 1024 * 1024;

const IMPORT_RECORDS_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const IMPORT_RECORDS_BASE64_DATA_URL_PATTERN = /^data:([^;,]*)(?:;[^,;]+=[^,;]*)*;base64,/i;
const SUPPORTED_IMPORT_RECORDS_BASE64_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.txt',
  '.json',
  '.xlsx',
  '.xls',
]);
const SUPPORTED_IMPORT_RECORDS_BASE64_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'text/tab-separated-values',
  'application/json',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);
const DATASET_SCHEMA_UPDATED_CHANNEL = 'dataset:schema-updated';

export type ImportRecordsBase64Payload = {
  payload: string;
  decodedBytes: number;
  extension: string;
  resolvedName: string;
};

type DatasetRouteHandler = (
  event: IpcMainInvokeEvent,
  ...args: any[]
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function notifyDatasetSchemaUpdated(event: IpcMainInvokeEvent, datasetId: string): void {
  event.sender.send(DATASET_SCHEMA_UPDATED_CHANNEL, datasetId);
}

function getBase64DecodedByteLength(payload: string): number {
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

export function normalizeImportRecordsBase64Payload(
  base64: string,
  options: { filename?: string; maxBytes?: number } = {}
): ImportRecordsBase64Payload {
  if (!base64 || typeof base64 !== 'string') {
    throw new Error('Base64 content is required');
  }

  const maxBytes = options.maxBytes ?? MAX_IMPORT_RECORDS_BASE64_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error('Invalid Base64 size limit');
  }

  const trimmed = base64.trim();
  const dataUrlMatch = IMPORT_RECORDS_BASE64_DATA_URL_PATTERN.exec(trimmed);
  const mimeType = dataUrlMatch?.[1]?.toLowerCase() || '';
  if (mimeType && !SUPPORTED_IMPORT_RECORDS_BASE64_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported import content type: ${mimeType}`);
  }

  const payloadStart = dataUrlMatch ? dataUrlMatch[0].length : 0;
  const payload = trimmed.slice(payloadStart).replace(/\s+/g, '');
  if (
    payload.length === 0 ||
    payload.length % 4 === 1 ||
    payload.startsWith('=') ||
    !IMPORT_RECORDS_BASE64_PATTERN.test(payload)
  ) {
    throw new Error('Base64 content is invalid');
  }

  const decodedBytes = getBase64DecodedByteLength(payload);
  if (decodedBytes <= 0) {
    throw new Error('Base64 content is invalid');
  }
  if (decodedBytes > maxBytes) {
    throw new Error(`Base64 content is too large: ${decodedBytes} bytes (max ${maxBytes} bytes)`);
  }

  const resolvedName =
    options.filename && typeof options.filename === 'string' ? options.filename : 'import.csv';
  const extension = (path.extname(resolvedName) || '.csv').toLowerCase();
  if (!SUPPORTED_IMPORT_RECORDS_BASE64_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported import file extension: ${extension}`);
  }

  return { payload, decodedBytes, extension, resolvedName };
}

export class DatasetIPCHandler {
  constructor(private duckdb: DuckDBService) {}

  /**
   * 注册所有数据集相关的 IPC 处理器
   */
  register(): void {
    this.registerSelectImportFile();
    this.registerImportDatasetFile();
    this.registerCancelImport();
    this.registerListDatasets();
    this.registerGetDatasetInfo();
    this.registerQueryDataset();
    this.registerDeleteDataset();
    this.registerRenameDataset();
    this.registerCreateEmptyDataset();
    this.registerListGroupTabs(); // 🆕 组内 Tab 列表
    this.registerCreateGroupTabCopy(); // 🆕 复制为组内新 Tab
    this.registerReorderGroupTabs(); // 🆕 组内 Tab 排序
    this.registerRenameGroupTab(); // 🆕 组内 Tab 重命名
    this.registerInsertRecord();
    this.registerBatchInsertRecords(); // 🆕 注册批量插入
    this.registerUpdateRecord();
    this.registerBatchUpdateRecords(); // 🆕 注册批量更新
    this.registerExecuteQuery();
    this.registerPreviewQuerySQL(); // ✨ 新增：只生成SQL不执行查询
    this.registerPreviewClean();
    this.registerMaterializeCleanToNewColumns();
    this.registerPreviewDedupe(); // ✨ 新增：去重预览
    this.registerUpdateColumnMetadata();
    this.registerUpdateColumnDisplayConfig(); // ✨ 新增：更新列显示配置
    this.registerAddColumn();
    this.registerUpdateColumn();
    this.registerDeleteColumn(); // ✨ 新增：删除列
    this.registerReorderColumns(); // ✨ 新增：重排序列
    this.registerHardDeleteRows(); // 🆕 行物理删除
    this.registerDeleteRowsByAhoCorasickFilter(); // 🆕 去重面板：词库 AC 物理删除
    this.registerValidateColumnName();
    this.registerAnalyzeTypes();
    this.registerApplySchema();

    // 🆕 新增：操作预览 API
    this.registerPreviewFilterCount();
    this.registerPreviewAggregate();
    this.registerPreviewSample();
    this.registerPreviewLookup();
    this.registerValidateComputeExpression();
    this.registerPreviewGroup();

    // 🆕 新增：导出功能
    this.registerSelectExportPath();
    this.registerExportDataset();

    // 🆕 新增：从文件导入记录到现有数据集
    this.registerImportRecordsFromBase64();
    this.registerImportRecordsFromFile();
  }

  private registerDatasetRoute(options: {
    channel: string;
    handler: DatasetRouteHandler;
    logError?: string;
  }): void {
    ipcRouteRegistry.register({
      channel: options.channel,
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, ...args: any[]) => {
        try {
          return await options.handler(event, ...args);
        } catch (error: unknown) {
          if (options.logError) {
            console.error(options.logError, error);
          }
          return handleIPCError(error);
        }
      },
    });
  }

  private registerSchemaMutationRoute(options: {
    channel: string;
    getDatasetId: (...args: any[]) => string;
    handler: DatasetRouteHandler;
    logError?: string;
  }): void {
    this.registerDatasetRoute({
      channel: options.channel,
      logError: options.logError,
      handler: async (event, ...args) => {
        const result = await options.handler(event, ...args);
        notifyDatasetSchemaUpdated(event, options.getDatasetId(...args));
        return result;
      },
    });
  }

  private registerSelectImportFile(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:select-import-file',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async () => {
        try {
          const result = await dialog.showOpenDialog(
            BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0],
            {
              properties: ['openFile'],
              filters: [
                { name: 'Data Files', extensions: ['csv', 'xlsx', 'xls', 'json'] },
                { name: 'CSV Files', extensions: ['csv'] },
                { name: 'Excel Files', extensions: ['xlsx', 'xls'] },
                { name: 'JSON Files', extensions: ['json'] },
                { name: 'All Files', extensions: ['*'] },
              ],
            }
          );

          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true, error: 'No file selected' };
          }

          return { success: true, canceled: false, filePath: result.filePaths[0] };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerImportDatasetFile(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:import-dataset-file',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        filePath: string,
        name: string,
        options?: { folderId?: string | null }
      ) => {
        try {
          const datasetId = await this.duckdb.importDatasetFile(
            filePath,
            name,
            options,
            (progress) => {
              // 发送进度更新到渲染进程
              event.sender.send('duckdb:import-progress', progress);
            }
          );

          return { success: true, datasetId };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerCancelImport(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:cancel-import',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          await this.duckdb.cancelImport(datasetId);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerListDatasets(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:list-datasets',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async () => {
        try {
          const datasets = await this.duckdb.listDatasets();
          return { success: true, datasets };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerGetDatasetInfo(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:get-dataset-info',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          const dataset = await this.duckdb.getDatasetInfo(datasetId);

          if (!dataset) {
            return { success: false, error: `Dataset not found: ${datasetId}` };
          }

          if (dataset.schema && Array.isArray(dataset.schema)) {
            // 统计有多少列缺少 fieldType
            const missingFieldType = dataset.schema.filter((col) => !col.fieldType);
            if (missingFieldType.length > 0) {
              console.warn(
                `[IPC] ⚠️  ${missingFieldType.length} columns missing fieldType:`,
                missingFieldType.map((col) => col.name)
              );
            }
          } else {
            console.warn(`[IPC] ⚠️  Dataset has no valid schema!`);
          }

          return { success: true, dataset };
        } catch (error: unknown) {
          console.error(`[IPC] ❌ Error in getDatasetInfo:`, error);
          return handleIPCError(error);
        }
      },
    });
  }

  private registerQueryDataset(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:query-dataset',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        datasetId: string,
        sql?: string,
        offset?: number,
        limit?: number
      ) => {
        try {
          const result = await this.duckdb.queryDataset(datasetId, sql, offset, limit);
          return { success: true, result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerDeleteDataset(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:delete-dataset',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          await this.duckdb.deleteDataset(datasetId);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerRenameDataset(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:rename-dataset',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, datasetId: string, newName: string) => {
        try {
          await this.duckdb.renameDataset(datasetId, newName);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerCreateEmptyDataset(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:create-empty-dataset',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        datasetName: string,
        options?: { folderId?: string | null }
      ) => {
        try {
          const datasetId = await this.duckdb.createEmptyDataset(datasetName, options);
          return { success: true, datasetId };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerListGroupTabs(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:list-group-tabs',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          const tabs = await this.duckdb.listGroupTabs(datasetId);
          return { success: true, tabs };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerCreateGroupTabCopy(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:create-group-tab-copy',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, sourceDatasetId: string, newName?: string) => {
        try {
          const result = await this.duckdb.createGroupTabCopy(sourceDatasetId, newName);
          return { success: true, ...result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerReorderGroupTabs(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:reorder-group-tabs',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        _event: IpcMainInvokeEvent,
        params: { groupId: string; datasetIds: string[] }
      ) => {
        try {
          await this.duckdb.reorderGroupTabs(params.groupId, params.datasetIds);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerRenameGroupTab(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:rename-group-tab',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, datasetId: string, newName: string) => {
        try {
          await this.duckdb.renameGroupTab(datasetId, newName);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerInsertRecord(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:insert-record',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        datasetId: string,
        record: Record<string, any>
      ) => {
        try {
          await this.duckdb.insertRecord(datasetId, record);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerBatchInsertRecords(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:batch-insert-records',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        datasetId: string,
        records: Record<string, any>[]
      ) => {
        try {
          await this.duckdb.batchInsertRecords(datasetId, records);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerUpdateRecord(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:update-record',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        datasetId: string,
        rowId: number,
        updates: Record<string, any>
      ) => {
        try {
          await this.duckdb.updateRecord(datasetId, rowId, updates);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerBatchUpdateRecords(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:batch-update-records',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        datasetId: string,
        updates: Array<{ rowId: number; updates: Record<string, any> }>
      ) => {
        try {
          await this.duckdb.batchUpdateRecords(datasetId, updates);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerExecuteQuery(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:execute-query',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, datasetId: string, config: any) => {
        try {
          const result = await this.duckdb.queryWithEngine(datasetId, config);
          return { success: true, result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * ✨ 新增：只生成 SQL 而不执行查询（用于保存查询模板）
   */
  private registerPreviewQuerySQL(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:preview-query-sql',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, datasetId: string, config: any) => {
        try {
          const result = await this.duckdb.previewQuerySQL(datasetId, config);
          return result;
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerPreviewClean(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:preview-clean',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, datasetId: string, config: any, options?: any) => {
        try {
          const result = await this.duckdb.previewClean(datasetId, config, options);
          return { success: true, result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * ✨ 新增：注册去重预览处理器
   */
  private registerMaterializeCleanToNewColumns(): void {
    this.registerSchemaMutationRoute({
      channel: 'duckdb:materialize-clean-to-new-columns',
      getDatasetId: (params: { datasetId: string }) => params.datasetId,
      handler: async (
        _event,
        params: {
          datasetId: string;
          cleanConfig: any;
        }
      ) => {
        const result = await this.duckdb.materializeCleanToNewColumns(
          params.datasetId,
          params.cleanConfig
        );

        return { success: true, result };
      },
    });
  }

  private registerPreviewDedupe(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:preview-dedupe',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, datasetId: string, config: any, options?: any) => {
        try {
          const result = await this.duckdb.previewDedupe(datasetId, config, options);
          return { success: true, result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerUpdateColumnMetadata(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:update-column-metadata',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        datasetId: string,
        columnName: string,
        metadata: any
      ) => {
        try {
          await this.duckdb.updateColumnMetadata(datasetId, columnName, metadata);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * ✨ 新增：注册更新列显示配置
   */
  private registerUpdateColumnDisplayConfig(): void {
    this.registerSchemaMutationRoute({
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
        await this.duckdb.updateColumnDisplayConfig(datasetId, columnName, displayConfig);

        return { success: true };
      },
    });
  }

  private registerAddColumn(): void {
    this.registerSchemaMutationRoute({
      channel: 'duckdb:add-column',
      getDatasetId: (params: { datasetId: string }) => params.datasetId,
      logError: '添加列失败:',
      handler: async (
        _event,
        params: {
          datasetId: string;
          columnName: string;
          fieldType: string;
          nullable: boolean;
          metadata?: any;
          storageMode?: 'physical' | 'computed'; // 🆕 存储模式
          computeConfig?: any; // 🆕 计算列配置
          validationRules?: any[]; // 🆕 验证规则
        }
      ) => {
        await this.duckdb.addColumn(params);

        return { success: true };
      },
    });
  }

  private registerUpdateColumn(): void {
    this.registerSchemaMutationRoute({
      channel: 'duckdb:update-column',
      getDatasetId: (params: { datasetId: string }) => params.datasetId,
      logError: '更新列失败:',
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
        await this.duckdb.updateColumn(params);

        return { success: true };
      },
    });
  }

  private registerValidateColumnName(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:validate-column-name',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, datasetId: string, columnName: string) => {
        try {
          const dataset = await this.duckdb.getDatasetInfo(datasetId);
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
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * 异步分析数据集字段类型（深度分析）
   */
  private registerAnalyzeTypes(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:analyze-types',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          const startTime = Date.now();
          const result = await this.duckdb.analyzeDatasetTypes(datasetId);

          const duration = Date.now() - startTime;

          return {
            success: true,
            schema: result.schema,
            sampleData: result.sampleData,
            duration,
          };
        } catch (error: unknown) {
          console.error('[TypeAnalyzer] Error:', error);
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * 应用用户确认的 schema
   */
  private registerApplySchema(): void {
    this.registerSchemaMutationRoute({
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
        await this.duckdb.updateDatasetSchema(datasetId, schema);

        return { success: true };
      },
    });
  }

  /**
   * ✨ 新增：删除列
   */
  private registerDeleteColumn(): void {
    this.registerSchemaMutationRoute({
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
        await this.duckdb.deleteColumn(datasetId, columnName, force);

        return { success: true };
      },
    });
  }

  /**
   * 🗑️ 注册物理删除数据行处理器
   */
  private registerHardDeleteRows(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:hard-delete-rows',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        _event,
        params: {
          datasetId: string;
          rowIds: number[];
        }
      ): Promise<{ success: boolean; deletedCount?: number; error?: string }> => {
        try {
          console.warn(
            `[IPC] PERMANENTLY deleting ${params.rowIds.length} rows from dataset ${params.datasetId}`
          );

          const deletedCount = await this.duckdb.hardDeleteRows(params.datasetId, params.rowIds);

          return {
            success: true,
            deletedCount,
          };
        } catch (error) {
          console.error('[IPC] Failed to hard delete rows:', error);
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * ✨ 新增：重新排序列
   */

  /**
   * 🆕 去重面板：Aho-Corasick 词库过滤后删除（物理删除，不可恢复）
   */
  private registerDeleteRowsByAhoCorasickFilter(): void {
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
      ): Promise<{ success: boolean; deletedCount?: number; error?: string }> => {
        try {
          const deletedCount = await this.duckdb.deleteRowsByAhoCorasickFilter(params);
          return { success: true, deletedCount };
        } catch (error) {
          return handleIPCError(error);
        }
      },
    });
  }

  private registerReorderColumns(): void {
    this.registerSchemaMutationRoute({
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
        await this.duckdb.reorderColumns(datasetId, columnNames);

        return { success: true };
      },
    });
  }

  // ========== 🆕 操作预览 API ==========

  /**
   * 预览筛选结果（仅返回计数）
   */
  private registerPreviewFilterCount(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:preview-filter-count',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          filterConfig: any;
        }
      ) => {
        try {
          const { datasetId, filterConfig } = params;
          const result = await this.duckdb.previewFilterCount(datasetId, filterConfig);
          return { success: true, result };
        } catch (error: unknown) {
          console.error('[Dataset] Error previewing filter:', error);
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * 预览聚合结果
   */
  private registerPreviewAggregate(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:preview-aggregate',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          aggregateConfig: any;
          options?: any;
        }
      ) => {
        try {
          const { datasetId, aggregateConfig, options } = params;
          const result = await this.duckdb.previewAggregate(datasetId, aggregateConfig, options);
          return { success: true, result };
        } catch (error: unknown) {
          console.error('[Dataset] Error previewing aggregate:', error);
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * 预览采样结果
   */
  private registerPreviewSample(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:preview-sample',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          sampleConfig: any;
          queryConfig?: any;
        }
      ) => {
        try {
          const { datasetId, sampleConfig, queryConfig } = params;
          const result = await this.duckdb.previewSample(datasetId, sampleConfig, queryConfig);
          return { success: true, result };
        } catch (error: unknown) {
          console.error('[Dataset] Error previewing sample:', error);
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * 预览关联结果
   */
  private registerPreviewLookup(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:preview-lookup',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          lookupConfig: any;
          options?: any;
        }
      ) => {
        try {
          const { datasetId, lookupConfig, options } = params;
          const result = await this.duckdb.previewLookup(datasetId, lookupConfig, options);
          return { success: true, result };
        } catch (error: unknown) {
          console.error('[Dataset] Error previewing lookup:', error);
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * 验证计算列表达式
   */
  private registerValidateComputeExpression(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:validate-compute-expression',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          expression: string;
          options?: any;
        }
      ) => {
        try {
          const { datasetId, expression, options } = params;
          const result = await this.duckdb.validateComputeExpression(
            datasetId,
            expression,
            options
          );
          return { success: true, result };
        } catch (error: unknown) {
          console.error('[Dataset] Error validating compute expression:', error);
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * 预览分组结果
   */
  private registerPreviewGroup(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:preview-group',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          groupConfig: any;
          options?: any;
        }
      ) => {
        try {
          const { datasetId, groupConfig, options } = params;
          const result = await this.duckdb.previewGroup(datasetId, groupConfig, options);
          return { success: true, result };
        } catch (error: unknown) {
          console.error('[Dataset] Error previewing group:', error);
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * 选择导出路径（文件保存对话框）
   */
  private registerSelectExportPath(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:select-export-path',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, params: ExportPathParams) => {
        try {
          const { defaultFileName, format } = params;

          // 根据格式设置文件过滤器
          const filters: { name: string; extensions: string[] }[] = [];
          switch (format) {
            case 'csv':
              filters.push({ name: 'CSV Files', extensions: ['csv'] });
              break;
            case 'xlsx':
              filters.push({ name: 'Excel Files', extensions: ['xlsx'] });
              break;
            case 'txt':
              filters.push({ name: 'Text Files', extensions: ['txt'] });
              break;
            case 'parquet':
              filters.push({ name: 'Parquet Files', extensions: ['parquet'] });
              break;
            case 'json':
              filters.push({ name: 'JSON Files', extensions: ['json'] });
              break;
            default:
              filters.push({ name: 'All Files', extensions: ['*'] });
          }
          filters.push({ name: 'All Files', extensions: ['*'] });

          const result = await dialog.showSaveDialog(
            BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0],
            {
              title: '导出数据',
              defaultPath: defaultFileName,
              filters,
            }
          );

          if (result.canceled || !result.filePath) {
            return { success: true, canceled: true };
          }

          return { success: true, filePath: result.filePath };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    });
  }

  /**
   * 导出数据集
   */
  private registerExportDataset(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:export-dataset',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (event: IpcMainInvokeEvent, options: ExportOptions) => {
        try {
          // 使用进度回调发送进度更新到渲染进程
          const result = await this.duckdb.exportDataset(options, (progress: ExportProgress) => {
            event.sender.send('duckdb:export-progress', progress);
          });

          return result;
        } catch (error: unknown) {
          console.error('[Dataset] Error exporting dataset:', error);
          return {
            success: false,
            files: [],
            totalRows: 0,
            filesCount: 0,
            executionTime: 0,
            error: handleIPCError(error).error,
          };
        }
      },
    });
  }

  /**
   * 从文件导入记录到现有数据集
   */

  private registerImportRecordsFromBase64(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:import-records-from-base64',
      kind: 'handle',
      permission: 'privileged',
      schema: {
        description:
          'Import records into an existing dataset from a Base64 payload after size, MIME, and extension validation.',
        args: [
          { name: 'datasetId', type: 'string', required: true },
          { name: 'base64', type: 'string', required: true },
          { name: 'filename', type: 'string', required: false },
        ],
        result: {
          success: 'boolean',
          recordsInserted: 'number?',
          error: 'string?',
        },
      },
      handler: async (
        event: IpcMainInvokeEvent,
        datasetId: string,
        base64: string,
        filename?: string
      ) => {
        let tempFilePath = '';
        try {
          const {
            payload: normalized,
            decodedBytes,
            extension,
            resolvedName,
          } = normalizeImportRecordsBase64Payload(base64, { filename });
          const tempDir = path.join(os.tmpdir(), 'airpa', 'tmp');
          await fs.ensureDir(tempDir);

          const baseName = path.basename(resolvedName, path.extname(resolvedName)) || 'import';
          const safeBaseName = baseName.replace(/[^\w.-]/g, '_') || 'import';
          const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
          tempFilePath = path.join(tempDir, `${safeBaseName}_${suffix}${extension}`);

          const buffer = Buffer.from(normalized, 'base64');
          if (buffer.byteLength !== decodedBytes) {
            throw new Error('Base64 content is invalid');
          }
          await fs.writeFile(tempFilePath, buffer);

          const result = await this.duckdb.importRecordsFromFile(
            datasetId,
            tempFilePath,
            (progress) => {
              event.sender.send('duckdb:import-records-progress', progress);
            }
          );

          return {
            success: true,
            recordsInserted: result.recordsInserted,
          };
        } catch (error: unknown) {
          return handleIPCError(error);
        } finally {
          if (tempFilePath) {
            try {
              await fs.remove(tempFilePath);
            } catch {
              // ignore cleanup errors
            }
          }
        }
      },
    });
  }

  private registerImportRecordsFromFile(): void {
    ipcRouteRegistry.register({
      channel: 'duckdb:import-records-from-file',
      kind: 'handle',
      permission: 'privileged',
      schema: {
        description:
          'Import records into an existing dataset from a local file path selected by the trusted renderer.',
        args: [
          { name: 'datasetId', type: 'string', required: true },
          { name: 'filePath', type: 'string', required: true },
        ],
        result: {
          success: 'boolean',
          recordsInserted: 'number?',
          error: 'string?',
        },
      },
      handler: async (event: IpcMainInvokeEvent, datasetId: string, filePath: string) => {
        try {
          // 使用进度回调发送进度更新到渲染进程
          const result = await this.duckdb.importRecordsFromFile(
            datasetId,
            filePath,
            (progress) => {
              // 发送进度到渲染进程
              event.sender.send('duckdb:import-records-progress', progress);
            }
          );

          return {
            success: true,
            recordsInserted: result.recordsInserted,
          };
        } catch (error: unknown) {
          console.error('[Dataset] Error importing records from file:', error);
          return handleIPCError(error);
        }
      },
    });
  }
}
