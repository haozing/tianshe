import { createHash } from 'node:crypto';
import path from 'path';
import type { QueryEngine } from '../../core/query-engine';
import {
  createChildTraceContext,
  getCurrentTraceContext,
  withTraceContext,
} from '../../core/observability/observation-context';
import { createLogger } from '../../core/logger';
import { attachErrorContextArtifact } from '../../core/observability/error-context-artifact';
import { observationService } from '../../core/observability/observation-service';
import type { Dataset, DatasetPlacementOptions, ImportProgress, QueryResult } from './types';
import type { DatasetService } from './dataset-service';
import type { QueryTemplateService } from './query-template-service';
import { quoteQualifiedName } from './utils';

const logger = createLogger('DuckDBServiceDatasetFacade');

export interface DuckDBServiceDatasetFacade {
  importDatasetFile(
    filePath: string,
    datasetName: string,
    options?: DatasetPlacementOptions,
    onProgress?: (progress: ImportProgress) => void
  ): Promise<string>;
  listDatasets(): Promise<Dataset[]>;
  getDatasetInfo(datasetId: string): Promise<Dataset | null>;
  getDatasetTableName(datasetId: string): Promise<string>;
  datasetExists(datasetId: string): Promise<boolean>;
  queryDataset(datasetId: string, sql?: string, offset?: number, limit?: number): Promise<QueryResult>;
  deleteDataset(datasetId: string): Promise<void>;
  hardDeleteRows(datasetId: string, rowIds: number[]): Promise<number>;
  deleteRowsByAhoCorasickFilter(params: {
    datasetId: string;
    targetField: string;
    dictDatasetId: string;
    dictField: string;
    filterType: 'contains_multi' | 'excludes_multi';
  }): Promise<number>;
  renameDataset(datasetId: string, newName: string): Promise<void>;
  createEmptyDataset(datasetName: string, options?: DatasetPlacementOptions): Promise<string>;
  listGroupTabs(datasetId: string): Promise<
    Array<{
      datasetId: string;
      tabGroupId: string;
      name: string;
      rowCount: number;
      columnCount: number;
      tabOrder: number;
      isGroupDefault: boolean;
    }>
  >;
  createGroupTabCopy(
    sourceDatasetId: string,
    newName?: string
  ): Promise<{ datasetId: string; tabGroupId: string }>;
  reorderGroupTabs(tabGroupId: string, datasetIds: string[]): Promise<void>;
  renameGroupTab(datasetId: string, newName: string): Promise<void>;
  insertRecord(datasetId: string, record: Record<string, any>): Promise<void>;
  batchInsertRecords(datasetId: string, records: Record<string, any>[]): Promise<void>;
  importRecordsFromFile(
    targetDatasetId: string,
    filePath: string,
    onProgress?: (progress: ImportProgress) => void
  ): Promise<{ recordsInserted: number }>;
  updateRecord(datasetId: string, rowId: number, updates: Record<string, any>): Promise<void>;
  batchUpdateRecords(
    datasetId: string,
    updates: Array<{ rowId: number; updates: Record<string, any> }>
  ): Promise<void>;
  cancelImport(datasetId: string): Promise<void>;
  insertRow(datasetId: string, data: any): Promise<void>;
  updateColumnMetadata(datasetId: string, columnName: string, metadata: any): Promise<void>;
  updateColumnDisplayConfig(datasetId: string, columnName: string, displayConfig: any): Promise<void>;
  addColumn(params: {
    datasetId: string;
    columnName: string;
    fieldType: string;
    nullable: boolean;
    metadata?: any;
    storageMode?: 'physical' | 'computed';
    computeConfig?: any;
  }): Promise<void>;
  updateColumn(params: {
    datasetId: string;
    columnName: string;
    newName?: string;
    fieldType?: string;
    nullable?: boolean;
    metadata?: any;
    computeConfig?: any;
  }): Promise<void>;
  updateDatasetSchema(datasetId: string, schema: any[]): Promise<void>;
  applyDatasetSchemaMetadata(datasetId: string, schema: any[]): Promise<void>;
  reorderColumns(datasetId: string, columnNames: string[]): Promise<void>;
  deleteColumn(datasetId: string, columnName: string, force?: boolean): Promise<void>;
  analyzeDatasetTypes(datasetId: string): Promise<{ schema: any[]; sampleData: any[] }>;
}

type DuckDBServiceDatasetFacadeThis = DuckDBServiceDatasetFacade & {
  datasetService: DatasetService | null;
  queryTemplateService: QueryTemplateService | null;
  queryEngine: QueryEngine | null;
};

function hashSqlForObservation(sql?: string): string | undefined {
  const normalized = String(sql || '').trim();
  if (!normalized) {
    return undefined;
  }

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function getQueryKind(sql?: string): 'custom_sql' | 'default_dataset_query' {
  return String(sql || '').trim() ? 'custom_sql' : 'default_dataset_query';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const duckDBServiceDatasetFacadeMethods: DuckDBServiceDatasetFacade &
  ThisType<DuckDBServiceDatasetFacadeThis> = {
async importDatasetFile(
  filePath: string,
  datasetName: string,
  options?: DatasetPlacementOptions,
  onProgress?: (progress: ImportProgress) => void
): Promise<string> {
  if (!this.datasetService) throw new Error('Dataset service not initialized');
  const datasetService = this.datasetService;
  const currentTraceContext = getCurrentTraceContext();
  const traceContext = createChildTraceContext({
    source: currentTraceContext?.source ?? 'duckdb',
    attributes: {
      datasetName,
      filePath: path.basename(String(filePath || '')),
    },
  });

  return await withTraceContext(traceContext, async () => {
    const span = await observationService.startSpan({
      context: traceContext,
      component: 'duckdb',
      event: 'dataset.lifecycle.import_file',
      attrs: {
        datasetName,
        filePath: path.basename(String(filePath || '')),
        folderId:
          typeof options?.folderId === 'string' && options.folderId.trim()
            ? options.folderId.trim()
            : null,
      },
    });

    // 包装 onProgress 回调，在导入完成后补齐分组与默认视图
    const wrappedProgress = async (progress: ImportProgress) => {
      // 先调用原始回调
      if (onProgress) {
        onProgress(progress);
      }

      if (progress.status === 'completed' && this.datasetService) {
        try {
          // 新模型：确保导入数据集被归入一个内容区 Tab 组
          await this.datasetService.listGroupTabsByDataset(progress.datasetId);
        } catch (error) {
          logger.warn('Failed to ensure dataset tab group after import', {
            datasetId: progress.datasetId,
            errorMessage: getErrorMessage(error),
          });
        }
      }

      // 导入完成后确保默认查询模板存在
      if (progress.status === 'completed' && this.queryTemplateService && this.datasetService) {
        try {
          logger.info('Auto-creating default query template for imported dataset', {
            datasetId: progress.datasetId,
          });
          await this.datasetService.withDatasetAttached(progress.datasetId, async () => {
            await this.queryTemplateService!.getOrCreateDefaultQueryTemplate(progress.datasetId);
          });
          logger.info('Default query template created for imported dataset', {
            datasetId: progress.datasetId,
          });
        } catch (error) {
          logger.warn('Failed to create default query template for imported dataset', {
            datasetId: progress.datasetId,
            errorMessage: getErrorMessage(error),
          });
          // 不要阻止导入流程，只记录错误
        }
      }
    };

    try {
      const datasetId = await datasetService.importDatasetFile(
        filePath,
        datasetName,
        options,
        wrappedProgress
      );
      await span.succeed({
        attrs: {
          datasetId,
          datasetName,
          filePath: path.basename(String(filePath || '')),
          folderId:
            typeof options?.folderId === 'string' && options.folderId.trim()
              ? options.folderId.trim()
              : null,
        },
      });
      return datasetId;
    } catch (error) {
      const artifact = await attachErrorContextArtifact({
        span,
        component: 'duckdb',
        label: 'dataset import failure context',
        data: {
          datasetName,
          filePath: path.basename(String(filePath || '')),
          folderId:
            typeof options?.folderId === 'string' && options.folderId.trim()
              ? options.folderId.trim()
              : null,
        },
      });
      await span.fail(error, {
        artifactRefs: [artifact.artifactId],
        attrs: {
          datasetName,
          filePath: path.basename(String(filePath || '')),
          folderId:
            typeof options?.folderId === 'string' && options.folderId.trim()
              ? options.folderId.trim()
              : null,
        },
      });
      throw error;
    }
  });
},

async listDatasets(): Promise<Dataset[]> {
  if (!this.datasetService) return [];
  return await this.datasetService.listDatasets();
},

async getDatasetInfo(datasetId: string): Promise<Dataset | null> {
  if (!this.datasetService) {
    logger.error('Dataset service is not initialized when getting dataset info', { datasetId });
    return null;
  }
  return await this.datasetService.getDatasetInfo(datasetId);
},

async getDatasetTableName(datasetId: string): Promise<string> {
  // 验证数据集是否存在
  const dataset = await this.getDatasetInfo(datasetId);
  if (!dataset) {
    throw new Error(`Dataset not found: ${datasetId}`);
  }
  // 返回DuckDB中的表名
  return quoteQualifiedName(`ds_${datasetId}`, 'data');
},

async datasetExists(datasetId: string): Promise<boolean> {
  const dataset = await this.getDatasetInfo(datasetId);
  return dataset !== null;
},

async queryDataset(
  datasetId: string,
  sql?: string,
  offset?: number,
  limit?: number
): Promise<QueryResult> {
  if (!this.datasetService) throw new Error('Dataset service not initialized');
  const currentTraceContext = getCurrentTraceContext();
  const queryKind = getQueryKind(sql);
  const sqlHash = hashSqlForObservation(sql);
  const traceContext = createChildTraceContext({
    datasetId,
    source: currentTraceContext?.source ?? 'duckdb',
    attributes: {
      queryKind,
      ...(sqlHash ? { sqlHash } : {}),
    },
  });

  return await withTraceContext(traceContext, async () => {
    const span = await observationService.startSpan({
      context: traceContext,
      component: 'duckdb',
      event: 'db.query',
      attrs: {
        datasetId,
        queryKind,
        ...(sqlHash ? { sqlHash } : {}),
        ...(typeof offset === 'number' ? { offset } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
      },
    });

    try {
      const result = await this.datasetService!.queryDataset(datasetId, sql, offset, limit);
      await span.succeed({
        attrs: {
          datasetId,
          queryKind,
          ...(sqlHash ? { sqlHash } : {}),
          rowCount: result.rowCount,
          filteredTotalCount: result.filteredTotalCount ?? null,
        },
      });
      return result;
    } catch (error) {
      const artifact = await attachErrorContextArtifact({
        span,
        component: 'duckdb',
        label: 'db query failure context',
        data: {
          datasetId,
          queryKind,
          ...(sqlHash ? { sqlHash } : {}),
          sqlPreview:
            String(sql || '')
              .trim()
              .slice(0, 400) || null,
          ...(typeof offset === 'number' ? { offset } : {}),
          ...(typeof limit === 'number' ? { limit } : {}),
        },
      });
      await span.fail(error, {
        artifactRefs: [artifact.artifactId],
        attrs: {
          datasetId,
          queryKind,
          ...(sqlHash ? { sqlHash } : {}),
        },
      });
      throw error;
    }
  });
},

async deleteDataset(datasetId: string): Promise<void> {
  if (!this.datasetService) return;
  const currentTraceContext = getCurrentTraceContext();
  const traceContext = createChildTraceContext({
    datasetId,
    source: currentTraceContext?.source ?? 'duckdb',
  });

  await withTraceContext(traceContext, async () => {
    const span = await observationService.startSpan({
      context: traceContext,
      component: 'duckdb',
      event: 'dataset.lifecycle.delete',
      attrs: {
        datasetId,
      },
    });

    try {
      await this.datasetService!.deleteDataset(datasetId);
      await span.succeed({
        attrs: {
          datasetId,
        },
      });
    } catch (error) {
      const artifact = await attachErrorContextArtifact({
        span,
        component: 'duckdb',
        label: 'dataset delete failure context',
        data: {
          datasetId,
        },
      });
      await span.fail(error, {
        artifactRefs: [artifact.artifactId],
        attrs: {
          datasetId,
        },
      });
      throw error;
    }
  });
},

async hardDeleteRows(datasetId: string, rowIds: number[]): Promise<number> {
  if (!this.datasetService) throw new Error('Dataset service not initialized');
  return await this.datasetService.hardDeleteRows(datasetId, rowIds);
},

async deleteRowsByAhoCorasickFilter(params: {
  datasetId: string;
  targetField: string;
  dictDatasetId: string;
  dictField: string;
  filterType: 'contains_multi' | 'excludes_multi';
}): Promise<number> {
  if (!this.datasetService) throw new Error('Dataset service not initialized');

  const { datasetId, targetField, dictDatasetId, dictField, filterType } = params;

  // filterWithAhoCorasick 返回“保留的 row_id”列表：
  // - isBlacklist=false => 返回匹配到词库的行（白名单：包含任一词）
  // - isBlacklist=true  => 返回未匹配到词库的行（黑名单：排除任一词）
  //
  // 删除语义需要“待删除 row_id”列表：
  // - contains_multi：删除未匹配到词库的行 => isBlacklist=true
  // - excludes_multi：删除匹配到词库的行   => isBlacklist=false
  const isBlacklist = filterType === 'contains_multi';
  const rowIdsToDelete = await this.datasetService.filterWithAhoCorasick(
    datasetId,
    targetField,
    dictDatasetId,
    dictField,
    isBlacklist
  );

  if (!rowIdsToDelete || rowIdsToDelete.length === 0) return 0;

  return await this.datasetService.hardDeleteRows(datasetId, rowIdsToDelete);
},

async renameDataset(datasetId: string, newName: string): Promise<void> {
  if (!this.datasetService) return;
  const currentTraceContext = getCurrentTraceContext();
  const traceContext = createChildTraceContext({
    datasetId,
    source: currentTraceContext?.source ?? 'duckdb',
  });

  await withTraceContext(traceContext, async () => {
    const span = await observationService.startSpan({
      context: traceContext,
      component: 'duckdb',
      event: 'dataset.lifecycle.rename',
      attrs: {
        datasetId,
        newName,
      },
    });

    try {
      await this.datasetService!.renameDataset(datasetId, newName);
      await span.succeed({
        attrs: {
          datasetId,
          newName,
        },
      });
    } catch (error) {
      const artifact = await attachErrorContextArtifact({
        span,
        component: 'duckdb',
        label: 'dataset rename failure context',
        data: {
          datasetId,
          newName,
        },
      });
      await span.fail(error, {
        artifactRefs: [artifact.artifactId],
        attrs: {
          datasetId,
          newName,
        },
      });
      throw error;
    }
  });
},

async createEmptyDataset(
  datasetName: string,
  options?: DatasetPlacementOptions
): Promise<string> {
  if (!this.datasetService) throw new Error('Dataset service not initialized');
  const currentTraceContext = getCurrentTraceContext();
  const traceContext = createChildTraceContext({
    source: currentTraceContext?.source ?? 'duckdb',
  });

  return await withTraceContext(traceContext, async () => {
    const span = await observationService.startSpan({
      context: traceContext,
      component: 'duckdb',
      event: 'dataset.lifecycle.create_empty',
      attrs: {
        datasetName,
        folderId:
          typeof options?.folderId === 'string' && options.folderId.trim()
            ? options.folderId.trim()
            : null,
      },
    });

    try {
      const datasetId = await this.datasetService!.createEmptyDataset(datasetName, options);
      await span.succeed({
        attrs: {
          datasetId,
          datasetName,
          folderId:
            typeof options?.folderId === 'string' && options.folderId.trim()
              ? options.folderId.trim()
              : null,
        },
      });
      return datasetId;
    } catch (error) {
      const artifact = await attachErrorContextArtifact({
        span,
        component: 'duckdb',
        label: 'dataset create failure context',
        data: {
          datasetName,
          folderId:
            typeof options?.folderId === 'string' && options.folderId.trim()
              ? options.folderId.trim()
              : null,
        },
      });
      await span.fail(error, {
        artifactRefs: [artifact.artifactId],
        attrs: {
          datasetName,
          folderId:
            typeof options?.folderId === 'string' && options.folderId.trim()
              ? options.folderId.trim()
              : null,
        },
      });
      throw error;
    }
  });
},

async listGroupTabs(datasetId: string): Promise<
  Array<{
    datasetId: string;
    tabGroupId: string;
    name: string;
    rowCount: number;
    columnCount: number;
    tabOrder: number;
    isGroupDefault: boolean;
  }>
> {
  if (!this.datasetService) throw new Error('Dataset service not initialized');
  return await this.datasetService.listGroupTabsByDataset(datasetId);
},

async createGroupTabCopy(
  sourceDatasetId: string,
  newName?: string
): Promise<{ datasetId: string; tabGroupId: string }> {
  if (!this.datasetService) throw new Error('Dataset service not initialized');
  return await this.datasetService.cloneDatasetToGroupTab(sourceDatasetId, newName);
},

async reorderGroupTabs(tabGroupId: string, datasetIds: string[]): Promise<void> {
  if (!this.datasetService) throw new Error('Dataset service not initialized');
  await this.datasetService.reorderGroupTabs(tabGroupId, datasetIds);
},

async renameGroupTab(datasetId: string, newName: string): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.renameGroupTab(datasetId, newName);
},

async insertRecord(datasetId: string, record: Record<string, any>): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.insertRecord(datasetId, record);
},

async batchInsertRecords(datasetId: string, records: Record<string, any>[]): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.batchInsertRecords(datasetId, records);
},

async importRecordsFromFile(
  targetDatasetId: string,
  filePath: string,
  onProgress?: (progress: ImportProgress) => void
): Promise<{ recordsInserted: number }> {
  if (!this.datasetService) throw new Error('Dataset service not initialized');
  return await this.datasetService.importRecordsFromFile(targetDatasetId, filePath, onProgress);
},

async updateRecord(
  datasetId: string,
  rowId: number,
  updates: Record<string, any>
): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.updateRecord(datasetId, rowId, updates);
},

async batchUpdateRecords(
  datasetId: string,
  updates: Array<{ rowId: number; updates: Record<string, any> }>
): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.batchUpdateRecords(datasetId, updates);
},

async cancelImport(datasetId: string): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.cancelImport(datasetId);
},

async insertRow(datasetId: string, data: any): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.insertRecord(datasetId, data);
},

async updateColumnMetadata(datasetId: string, columnName: string, metadata: any): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.updateColumnMetadata(datasetId, columnName, metadata);
},

async updateColumnDisplayConfig(
  datasetId: string,
  columnName: string,
  displayConfig: any
): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.updateColumnDisplayConfig(datasetId, columnName, displayConfig);
},

async addColumn(params: {
  datasetId: string;
  columnName: string;
  fieldType: string;
  nullable: boolean;
  metadata?: any;
  storageMode?: 'physical' | 'computed';
  computeConfig?: any;
}): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.addColumn(params);
  this.queryEngine?.clearColumnCache(params.datasetId);
},

async updateColumn(params: {
  datasetId: string;
  columnName: string;
  newName?: string;
  fieldType?: string;
  nullable?: boolean;
  metadata?: any;
  computeConfig?: any;
}): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.updateColumn(params);
  this.queryEngine?.clearColumnCache(params.datasetId);
},

async updateDatasetSchema(datasetId: string, schema: any[]): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.updateDatasetSchema(datasetId, schema);
  this.queryEngine?.clearColumnCache(datasetId);
},

async applyDatasetSchemaMetadata(datasetId: string, schema: any[]): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.applyDatasetSchemaMetadata(datasetId, schema);
  this.queryEngine?.clearColumnCache(datasetId);
},

async reorderColumns(datasetId: string, columnNames: string[]): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.reorderColumns(datasetId, columnNames);
  this.queryEngine?.clearColumnCache(datasetId);
},

async deleteColumn(datasetId: string, columnName: string, force: boolean = false): Promise<void> {
  if (!this.datasetService) return;
  await this.datasetService.deleteColumn(datasetId, columnName, force);
  this.queryEngine?.clearColumnCache(datasetId);
},

async analyzeDatasetTypes(datasetId: string): Promise<{ schema: any[]; sampleData: any[] }> {
  if (!this.datasetService) throw new Error('Dataset service not initialized');

  logger.info('Delegating type analysis to DatasetService', { datasetId });

  // ?? 使用 DatasetService 的方法，避免文件锁定冲突
  // DatasetService 使用主连接和已 attached 的数据库，而不是连接池
  return await this.datasetService.analyzeDatasetTypes(datasetId);
}
};

export function installDuckDBServiceDatasetFacade(prototype: object): void {
  Object.assign(prototype, duckDBServiceDatasetFacadeMethods);
}
