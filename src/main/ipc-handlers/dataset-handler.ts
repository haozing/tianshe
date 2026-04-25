/**
 * DatasetIPCHandler - 数据集管理处理器
 * 负责：数据集导入、查询、CRUD操作
 */

import { ipcMain, IpcMainInvokeEvent, dialog, BrowserWindow } from 'electron';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DuckDBService } from '../duckdb/service';
import { handleIPCError } from '../ipc-utils';
import type { ExportOptions, ExportPathParams, ExportProgress } from '../../types/dataset-export';

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

  private registerSelectImportFile(): void {
    ipcMain.handle('duckdb:select-import-file', async () => {
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
    });
  }

  private registerImportDatasetFile(): void {
    ipcMain.handle(
      'duckdb:import-dataset-file',
      async (
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
      }
    );
  }

  private registerCancelImport(): void {
    ipcMain.handle('duckdb:cancel-import', async (event: IpcMainInvokeEvent, datasetId: string) => {
      try {
        await this.duckdb.cancelImport(datasetId);
        return { success: true };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerListDatasets(): void {
    ipcMain.handle('duckdb:list-datasets', async () => {
      try {
        const datasets = await this.duckdb.listDatasets();
        return { success: true, datasets };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerGetDatasetInfo(): void {
    ipcMain.handle(
      'duckdb:get-dataset-info',
      async (event: IpcMainInvokeEvent, datasetId: string) => {
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
      }
    );
  }

  private registerQueryDataset(): void {
    ipcMain.handle(
      'duckdb:query-dataset',
      async (
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
      }
    );
  }

  private registerDeleteDataset(): void {
    ipcMain.handle(
      'duckdb:delete-dataset',
      async (event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          await this.duckdb.deleteDataset(datasetId);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerRenameDataset(): void {
    ipcMain.handle(
      'duckdb:rename-dataset',
      async (event: IpcMainInvokeEvent, datasetId: string, newName: string) => {
        try {
          await this.duckdb.renameDataset(datasetId, newName);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerCreateEmptyDataset(): void {
    ipcMain.handle(
      'duckdb:create-empty-dataset',
      async (
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
      }
    );
  }

  private registerListGroupTabs(): void {
    ipcMain.handle(
      'duckdb:list-group-tabs',
      async (_event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          const tabs = await this.duckdb.listGroupTabs(datasetId);
          return { success: true, tabs };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerCreateGroupTabCopy(): void {
    ipcMain.handle(
      'duckdb:create-group-tab-copy',
      async (_event: IpcMainInvokeEvent, sourceDatasetId: string, newName?: string) => {
        try {
          const result = await this.duckdb.createGroupTabCopy(sourceDatasetId, newName);
          return { success: true, ...result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerReorderGroupTabs(): void {
    ipcMain.handle(
      'duckdb:reorder-group-tabs',
      async (_event: IpcMainInvokeEvent, params: { groupId: string; datasetIds: string[] }) => {
        try {
          await this.duckdb.reorderGroupTabs(params.groupId, params.datasetIds);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerRenameGroupTab(): void {
    ipcMain.handle(
      'duckdb:rename-group-tab',
      async (_event: IpcMainInvokeEvent, datasetId: string, newName: string) => {
        try {
          await this.duckdb.renameGroupTab(datasetId, newName);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerInsertRecord(): void {
    ipcMain.handle(
      'duckdb:insert-record',
      async (event: IpcMainInvokeEvent, datasetId: string, record: Record<string, any>) => {
        try {
          await this.duckdb.insertRecord(datasetId, record);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerBatchInsertRecords(): void {
    ipcMain.handle(
      'duckdb:batch-insert-records',
      async (event: IpcMainInvokeEvent, datasetId: string, records: Record<string, any>[]) => {
        try {
          await this.duckdb.batchInsertRecords(datasetId, records);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerUpdateRecord(): void {
    ipcMain.handle(
      'duckdb:update-record',
      async (
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
      }
    );
  }

  private registerBatchUpdateRecords(): void {
    ipcMain.handle(
      'duckdb:batch-update-records',
      async (
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
      }
    );
  }

  private registerExecuteQuery(): void {
    ipcMain.handle(
      'duckdb:execute-query',
      async (event: IpcMainInvokeEvent, datasetId: string, config: any) => {
        try {
          const result = await this.duckdb.queryWithEngine(datasetId, config);
          return { success: true, result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * ✨ 新增：只生成 SQL 而不执行查询（用于保存查询模板）
   */
  private registerPreviewQuerySQL(): void {
    ipcMain.handle(
      'duckdb:preview-query-sql',
      async (event: IpcMainInvokeEvent, datasetId: string, config: any) => {
        try {
          const result = await this.duckdb.previewQuerySQL(datasetId, config);
          return result;
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerPreviewClean(): void {
    ipcMain.handle(
      'duckdb:preview-clean',
      async (event: IpcMainInvokeEvent, datasetId: string, config: any, options?: any) => {
        try {
          const result = await this.duckdb.previewClean(datasetId, config, options);
          return { success: true, result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * ✨ 新增：注册去重预览处理器
   */
  private registerMaterializeCleanToNewColumns(): void {
    ipcMain.handle(
      'duckdb:materialize-clean-to-new-columns',
      async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          cleanConfig: any;
        }
      ) => {
        try {
          const result = await this.duckdb.materializeCleanToNewColumns(
            params.datasetId,
            params.cleanConfig
          );

          // 通知前端刷新数据集信息（schema 已更新）
          event.sender.send('dataset:schema-updated', params.datasetId);

          return { success: true, result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerPreviewDedupe(): void {
    ipcMain.handle(
      'duckdb:preview-dedupe',
      async (event: IpcMainInvokeEvent, datasetId: string, config: any, options?: any) => {
        try {
          const result = await this.duckdb.previewDedupe(datasetId, config, options);
          return { success: true, result };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerUpdateColumnMetadata(): void {
    ipcMain.handle(
      'duckdb:update-column-metadata',
      async (event: IpcMainInvokeEvent, datasetId: string, columnName: string, metadata: any) => {
        try {
          await this.duckdb.updateColumnMetadata(datasetId, columnName, metadata);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * ✨ 新增：注册更新列显示配置
   */
  private registerUpdateColumnDisplayConfig(): void {
    ipcMain.handle(
      'duckdb:update-column-display-config',
      async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          columnName: string;
          displayConfig: any;
        }
      ) => {
        try {
          const { datasetId, columnName, displayConfig } = params;
          await this.duckdb.updateColumnDisplayConfig(datasetId, columnName, displayConfig);

          // 通知前端刷新数据集信息
          event.sender.send('dataset:schema-updated', datasetId);

          return { success: true };
        } catch (error: unknown) {
          console.error('[Dataset] Error updating column display config:', error);
          return handleIPCError(error);
        }
      }
    );
  }

  private registerAddColumn(): void {
    ipcMain.handle(
      'duckdb:add-column',
      async (
        event: IpcMainInvokeEvent,
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
        try {
          await this.duckdb.addColumn(params);

          // 通知前端刷新数据集信息
          event.sender.send('dataset:schema-updated', params.datasetId);

          return { success: true };
        } catch (error: unknown) {
          console.error('添加列失败:', error);
          return handleIPCError(error);
        }
      }
    );
  }

  private registerUpdateColumn(): void {
    ipcMain.handle(
      'duckdb:update-column',
      async (
        event: IpcMainInvokeEvent,
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
        try {
          await this.duckdb.updateColumn(params);

          // 通知前端刷新数据集信息
          event.sender.send('dataset:schema-updated', params.datasetId);

          return { success: true };
        } catch (error: unknown) {
          console.error('更新列失败:', error);
          return handleIPCError(error);
        }
      }
    );
  }

  private registerValidateColumnName(): void {
    ipcMain.handle(
      'duckdb:validate-column-name',
      async (event: IpcMainInvokeEvent, datasetId: string, columnName: string) => {
        try {
          const dataset = await this.duckdb.getDatasetInfo(datasetId);
          if (!dataset) {
            return { success: false, error: '数据集不存在' };
          }

          const exists = dataset.schema?.some((col) => col.name === columnName) || false;

          return {
            success: true,
            valid: !exists,
            message: exists ? '列名已存在' : '列名可用',
          };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 异步分析数据集字段类型（深度分析）
   */
  private registerAnalyzeTypes(): void {
    ipcMain.handle('duckdb:analyze-types', async (event: IpcMainInvokeEvent, datasetId: string) => {
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
    });
  }

  /**
   * 应用用户确认的 schema
   */
  private registerApplySchema(): void {
    ipcMain.handle(
      'duckdb:apply-schema',
      async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          schema: any[];
        }
      ) => {
        try {
          const { datasetId, schema } = params;
          await this.duckdb.updateDatasetSchema(datasetId, schema);

          // 通知前端刷新数据集信息
          event.sender.send('dataset:schema-updated', datasetId);

          return { success: true };
        } catch (error: unknown) {
          console.error('[Dataset] Error applying schema:', error);
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * ✨ 新增：删除列
   */
  private registerDeleteColumn(): void {
    ipcMain.handle(
      'duckdb:delete-column',
      async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          columnName: string;
          force?: boolean;
        }
      ) => {
        try {
          const { datasetId, columnName, force = false } = params;
          await this.duckdb.deleteColumn(datasetId, columnName, force);

          // 通知前端刷新数据集信息
          event.sender.send('dataset:schema-updated', datasetId);

          return { success: true };
        } catch (error: unknown) {
          console.error('[Dataset] Error deleting column:', error);
          return handleIPCError(error);
        }
      }
    );
  }

  /**
   * 🗑️ 注册物理删除数据行处理器
   */
  private registerHardDeleteRows(): void {
    ipcMain.handle(
      'duckdb:hard-delete-rows',
      async (
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
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    );
  }

  /**
   * ✨ 新增：重新排序列
   */

  /**
   * 🆕 去重面板：Aho-Corasick 词库过滤后删除（物理删除，不可恢复）
   */
  private registerDeleteRowsByAhoCorasickFilter(): void {
    ipcMain.handle(
      'duckdb:ac-filter-delete-rows',
      async (
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
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    );
  }

  private registerReorderColumns(): void {
    ipcMain.handle(
      'duckdb:reorder-columns',
      async (
        event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          columnNames: string[];
        }
      ) => {
        try {
          const { datasetId, columnNames } = params;
          await this.duckdb.reorderColumns(datasetId, columnNames);

          // 通知前端刷新数据集信息
          event.sender.send('dataset:schema-updated', datasetId);

          return { success: true };
        } catch (error: unknown) {
          console.error('[Dataset] Error reordering columns:', error);
          return handleIPCError(error);
        }
      }
    );
  }

  // ========== 🆕 操作预览 API ==========

  /**
   * 预览筛选结果（仅返回计数）
   */
  private registerPreviewFilterCount(): void {
    ipcMain.handle(
      'duckdb:preview-filter-count',
      async (
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
      }
    );
  }

  /**
   * 预览聚合结果
   */
  private registerPreviewAggregate(): void {
    ipcMain.handle(
      'duckdb:preview-aggregate',
      async (
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
      }
    );
  }

  /**
   * 预览采样结果
   */
  private registerPreviewSample(): void {
    ipcMain.handle(
      'duckdb:preview-sample',
      async (
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
      }
    );
  }

  /**
   * 预览关联结果
   */
  private registerPreviewLookup(): void {
    ipcMain.handle(
      'duckdb:preview-lookup',
      async (
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
      }
    );
  }

  /**
   * 验证计算列表达式
   */
  private registerValidateComputeExpression(): void {
    ipcMain.handle(
      'duckdb:validate-compute-expression',
      async (
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
      }
    );
  }

  /**
   * 预览分组结果
   */
  private registerPreviewGroup(): void {
    ipcMain.handle(
      'duckdb:preview-group',
      async (
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
      }
    );
  }

  /**
   * 选择导出路径（文件保存对话框）
   */
  private registerSelectExportPath(): void {
    ipcMain.handle(
      'duckdb:select-export-path',
      async (
        event: IpcMainInvokeEvent,
        params: ExportPathParams
      ) => {
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
      }
    );
  }

  /**
   * 导出数据集
   */
  private registerExportDataset(): void {
    ipcMain.handle(
      'duckdb:export-dataset',
      async (event: IpcMainInvokeEvent, options: ExportOptions) => {
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
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    );
  }

  /**
   * 从文件导入记录到现有数据集
   */

  private registerImportRecordsFromBase64(): void {
    ipcMain.handle(
      'duckdb:import-records-from-base64',
      async (event: IpcMainInvokeEvent, datasetId: string, base64: string, filename?: string) => {
        let tempFilePath = '';
        try {
          if (!base64 || typeof base64 !== 'string') {
            throw new Error('Base64 content is required');
          }

          const normalized = base64.replace(/^data:.*;base64,/, '');
          const tempDir = path.join(os.tmpdir(), 'airpa', 'tmp');
          await fs.ensureDir(tempDir);

          const resolvedName =
            filename && typeof filename === 'string' ? filename : `${datasetId}.csv`;
          const ext = path.extname(resolvedName) || '.csv';
          const baseName = path.basename(resolvedName, ext) || 'import';
          const safeBaseName = baseName.replace(/[^\w.-]/g, '_') || 'import';
          const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
          const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
          tempFilePath = path.join(tempDir, `${safeBaseName}_${suffix}${normalizedExt}`);

          await fs.writeFile(tempFilePath, Buffer.from(normalized, 'base64'));

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
      }
    );
  }

  private registerImportRecordsFromFile(): void {
    ipcMain.handle(
      'duckdb:import-records-from-file',
      async (event: IpcMainInvokeEvent, datasetId: string, filePath: string) => {
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
      }
    );
  }
}
