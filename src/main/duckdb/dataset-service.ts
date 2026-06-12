/**
 * DatasetService - 数据集服务（主协调层）
 *
 * 职责：
 * - 统一对外 API
 * - 服务编排和依赖注入
 * - CRUD 操作协调
 * - 记录级别操作（updateRecord, insertRecord等）
 *
 * 🎭 协调层模式：委托给专业服务，本身不实现复杂业务逻辑
 */

import { DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs-extra';
import { DatasetStorageService, sanitizeDatasetId } from './dataset-storage-service';
import { DatasetMetadataService } from './dataset-metadata-service';
import { DatasetSchemaService } from './dataset-schema-service';
import { DatasetImportService } from './dataset-import-service';
import { DatasetExportService, type ExportQuerySQLBuilder } from './dataset-export-service';
import { DatasetQueryService } from './dataset-query-service';
import { DatasetTabGroupService, type GroupTabDataset } from './dataset-tab-group-service';
import { DatasetRecordMutationService } from './dataset-record-mutation-service';
import { DatasetMaterializationService } from './dataset-materialization-service';
import { DatasetGroupTabWorkflowService } from './dataset-group-tab-workflow-service';
import { SQLValidator } from './sql-validator';
import { DependencyManager } from './dependency-manager';
import { ValidationEngine } from './validation-engine';
import type { QueryEngine } from '../../core/query-engine/QueryEngine';
import type { CleanConfig } from '../../core/query-engine/types';
import { createLogger } from '../../core/logger';
import {
  escapeSqlStringLiteral,
  getDatasetPath,
  getFileSize,
  quoteIdentifier,
  quoteQualifiedName,
  runInDuckDbTransaction,
} from './utils';
import { generateId } from '../../utils/id-generator';
import type {
  Dataset,
  DatasetPlacementOptions,
  ImportProgress,
  DataRecord,
  EnhancedColumnSchema,
} from './types';
import type { ExportOptions, ExportProgress } from '../../types/electron';

const logger = createLogger('DatasetService');

type BaseDatasetColumnDefinition = Pick<
  EnhancedColumnSchema,
  'name' | 'duckdbType' | 'fieldType' | 'nullable' | 'metadata'
>;

export class DatasetService {
  // 子服务实例
  private storageService: DatasetStorageService;
  private metadataService: DatasetMetadataService;
  private schemaService: DatasetSchemaService;
  private importService: DatasetImportService;
  private exportService: DatasetExportService;
  private queryService: DatasetQueryService;
  private tabGroupService: DatasetTabGroupService;
  private recordMutationService: DatasetRecordMutationService;
  private materializationService: DatasetMaterializationService;
  private groupTabWorkflowService: DatasetGroupTabWorkflowService;

  // 辅助服务
  private sqlValidator: SQLValidator;
  private dependencyManager: DependencyManager;
  private validationEngine: ValidationEngine;

  // 🆕 HookBus（用于 Webhook 回调）
  private hookBus?: import('../../core/hookbus').HookBus;

  constructor(
    private conn: DuckDBConnection,
    options: {
      hookBus?: import('../../core/hookbus').HookBus;
      queryEngine?: QueryEngine;
      exportQuerySQLBuilder?: ExportQuerySQLBuilder;
    } = {}
  ) {
    this.hookBus = options.hookBus;
    // ========== 依赖注入 - 按拓扑顺序初始化 ==========

    // 🔹 底层：存储和队列
    this.storageService = new DatasetStorageService(conn);

    // 🔹 数据层：元数据管理
    this.metadataService = new DatasetMetadataService(conn, this.storageService);
    this.tabGroupService = new DatasetTabGroupService(conn);
    this.recordMutationService = new DatasetRecordMutationService({
      conn,
      storageService: this.storageService,
      metadataService: this.metadataService,
      getTableName: (safeDatasetId) => this.getTableName(safeDatasetId),
      ensureAttached: (dataset) => this.ensureAttached(dataset),
      hookBus: this.hookBus,
    });

    // 🔹 辅助服务：验证和依赖
    this.sqlValidator = new SQLValidator(conn);
    this.dependencyManager = new DependencyManager();
    this.validationEngine = new ValidationEngine(conn);

    // 🔹 业务层：Schema 管理
    this.schemaService = new DatasetSchemaService(
      conn,
      this.metadataService,
      this.storageService,
      this.sqlValidator,
      this.dependencyManager,
      this.validationEngine
    );

    // 🔹 功能层：导入、导出、查询
    this.importService = new DatasetImportService(
      conn,
      this.metadataService,
      this.storageService
    );
    this.exportService = new DatasetExportService(
      conn,
      this.metadataService,
      this.storageService,
      options.exportQuerySQLBuilder
    );
    this.queryService = new DatasetQueryService(
      conn,
      this.metadataService,
      this.schemaService,
      this.storageService,
      options.queryEngine
    );
    this.materializationService = new DatasetMaterializationService({
      conn,
      metadataService: this.metadataService,
      queryService: this.queryService,
      schemaService: this.schemaService,
      storageService: this.storageService,
      getTableName: (safeDatasetId) => this.getTableName(safeDatasetId),
      ensureAttached: (dataset) => this.ensureAttached(dataset),
    });
    this.groupTabWorkflowService = new DatasetGroupTabWorkflowService({
      conn,
      metadataService: this.metadataService,
      storageService: this.storageService,
      tabGroupService: this.tabGroupService,
      ensureAttached: (dataset) => this.ensureAttached(dataset),
      configureRowIdSequence: (attachKey, tableName, startValue) =>
        this.configureRowIdSequence(attachKey, tableName, startValue),
    });

    logger.info('DatasetService initialized with modular architecture');
  }


  // ==================== 私有辅助方法 ====================

  /**
   * 获取表名（统一格式）
   * ✅ 简化：移除未使用的 isPluginTable 参数，所有表都使用统一格式
   * @private
   */
  private getTableName(datasetId: string): string {
    const safeId = sanitizeDatasetId(datasetId);
    return quoteQualifiedName(`ds_${safeId}`, 'data');
  }

  /**
   * 确保数据库已附加
   * @private
   */
  private async ensureAttached(dataset: Dataset): Promise<void> {
    // ✅ 修复：所有表（包括插件表）都需要 ATTACH
    const safeId = sanitizeDatasetId(dataset.id);
    const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    await this.storageService.smartAttach(safeId, escapedPath);
  }

  private buildBaseDatasetSchema(
    userColumns: BaseDatasetColumnDefinition[] = []
  ): BaseDatasetColumnDefinition[] {
    return [
      ...userColumns,
      {
        name: '_row_id',
        duckdbType: 'BIGINT',
        fieldType: 'auto_increment',
        nullable: false,
        metadata: { isSystemColumn: true, hidden: true },
      },
      {
        name: 'created_at',
        duckdbType: 'TIMESTAMP',
        fieldType: 'date',
        nullable: false,
        metadata: { isSystemColumn: true, hidden: true },
      },
      {
        name: 'updated_at',
        duckdbType: 'TIMESTAMP',
        fieldType: 'date',
        nullable: false,
        metadata: { isSystemColumn: true, hidden: true },
      },
      {
        name: 'deleted_at',
        duckdbType: 'TIMESTAMP',
        fieldType: 'date',
        nullable: true,
        metadata: { isSystemColumn: true, hidden: true },
      },
    ];
  }

  private async configureRowIdSequence(
    attachKey: string,
    tableName: string,
    startValue: number
  ): Promise<void> {
    const qualifiedSequenceName = quoteQualifiedName(attachKey, 'row_id_seq');
    const sequenceLiteral = escapeSqlStringLiteral(`${attachKey}.row_id_seq`);
    const safeStartValue =
      Number.isFinite(startValue) && startValue > 0 ? Math.floor(startValue) : 1;

    await this.conn.run(`DROP SEQUENCE IF EXISTS ${qualifiedSequenceName}`);
    await this.conn.run(
      `CREATE SEQUENCE ${qualifiedSequenceName} START ${safeStartValue} INCREMENT 1`
    );
    await this.conn.run(
      `ALTER TABLE ${tableName} ALTER COLUMN ${quoteIdentifier('_row_id')} SET DEFAULT nextval('${sequenceLiteral}')`
    );
  }

  private async createBaseDatasetTable(
    attachKey: string,
    userColumns: BaseDatasetColumnDefinition[] = []
  ): Promise<BaseDatasetColumnDefinition[]> {
    const tableName = quoteQualifiedName(attachKey, 'data');
    const schema = this.buildBaseDatasetSchema(userColumns);

    const columnDefinitions = schema
      .map((column) => {
        if (column.name === '_row_id') {
          return `${quoteIdentifier(column.name)} ${column.duckdbType} PRIMARY KEY`;
        }
        if (column.name === 'created_at' || column.name === 'updated_at') {
          return `${quoteIdentifier(column.name)} ${column.duckdbType} DEFAULT (now())`;
        }
        if (column.name === 'deleted_at') {
          return `${quoteIdentifier(column.name)} ${column.duckdbType} DEFAULT NULL`;
        }

        const nullableClause = column.nullable ? '' : ' NOT NULL';
        return `${quoteIdentifier(column.name)} ${column.duckdbType}${nullableClause}`;
      })
      .join(', ');

    await this.conn.run(`CREATE TABLE ${tableName} (${columnDefinitions})`);
    await this.configureRowIdSequence(attachKey, tableName, 1);

    return schema;
  }

  // ==================== 元数据 API（代理） ====================

  initTable = () => this.metadataService.initTable();
  listDatasets = () => this.metadataService.listDatasets();
  getDatasetInfo = (id: string) => this.metadataService.getDatasetInfo(id);
  reconcileDatasetRowCount = (id: string) => this.metadataService.reconcileRowCount(id);
  renameDataset = (id: string, name: string) => this.metadataService.renameDataset(id, name);
  analyzeDatasetTypes = (id: string) => this.metadataService.analyzeDatasetTypes(id);

  // ==================== 导入导出 API（代理） ====================

  importDatasetFile = (
    filePath: string,
    name: string,
    options?: DatasetPlacementOptions,
    onProgress?: (progress: ImportProgress) => void
  ) => this.importService.importDatasetFile(filePath, name, options, onProgress);

  cancelImport = (id: string) => this.importService.cancelImport(id);

  importRecordsFromFile = (
    targetDatasetId: string,
    filePath: string,
    onProgress?: (progress: ImportProgress) => void
  ) => this.importService.importRecordsFromFile(targetDatasetId, filePath, onProgress);

  exportDataset = (options: ExportOptions, onProgress?: (progress: ExportProgress) => void) =>
    this.exportService.exportDataset(options, onProgress);

  // ==================== 查询 API（代理） ====================

  queryDataset = (id: string, sql?: string, offset?: number, limit?: number) =>
    this.queryService.queryDataset(id, sql, offset, limit);

  previewFilterCount = (id: string, config: any) =>
    this.queryService.previewFilterCount(id, config);

  previewAggregate = (id: string, config: any, options?: any) =>
    this.queryService.previewAggregate(id, config, options);

  previewSample = (id: string, config: any, queryConfig?: any) =>
    this.queryService.previewSample(id, config, queryConfig);

  previewLookup = (id: string, config: any, options?: any) =>
    this.queryService.previewLookup(id, config, options);

  previewGroup = (id: string, config: any, options?: any) =>
    this.queryService.previewGroup(id, config, options);

  filterWithAhoCorasick = (
    datasetId: string,
    targetField: string,
    dictDatasetId: string,
    dictField: string,
    isBlacklist: boolean
  ) =>
    this.queryService.filterWithAhoCorasick(
      datasetId,
      targetField,
      dictDatasetId,
      dictField,
      isBlacklist
    );

  createTempRowIdTable = (datasetId: string, tableName: string, rowIds: number[]) =>
    this.queryService.createTempRowIdTable(datasetId, tableName, rowIds);

  dropTempRowIdTable = (datasetId: string, tableName: string) =>
    this.queryService.dropTempRowIdTable(datasetId, tableName);

  /**
   * 🔍 验证计算列表达式
   * 委托给 QueryEngine 执行表达式校验
   */
  async validateComputeExpression(
    datasetId: string,
    expression: string,
    options?: any
  ): Promise<any> {
    return await this.materializationService.validateComputeExpression(
      datasetId,
      expression,
      options
    );
  }

  // ==================== Schema API（代理） ====================

  addColumn = (params: any) => this.schemaService.addColumn(params);
  deleteColumn = (id: string, name: string, force?: boolean) =>
    this.schemaService.deleteColumn(id, name, force);
  updateColumn = (params: any) => this.schemaService.updateColumn(params);
  checkColumnDependencies = (dataset: Dataset, columnName: string) =>
    this.schemaService.checkColumnDependencies(dataset, columnName);

  reorderColumns = (id: string, names: string[]) => this.metadataService.reorderColumns(id, names);
  updateColumnMetadata = (id: string, name: string, metadata: any) =>
    this.metadataService.updateColumnMetadata(id, name, metadata);
  updateColumnDisplayConfig = (id: string, name: string, config: any) =>
    this.metadataService.updateColumnDisplayConfig(id, name, config);
  updateDatasetSchema = (id: string, schema: any[]) =>
    this.metadataService.updateDatasetSchema(id, schema);
  applyDatasetSchemaMetadata = (id: string, schema: any[]) =>
    this.schemaService.applyDatasetSchemaMetadata(id, schema);

  // ==================== 存储 API（代理） ====================

  deleteDataset = async (
    datasetId: string,
    onProgress?: (message: string, percentage: number) => void
  ) => {
    const dataset = await this.metadataService.getDatasetInfo(datasetId);
    if (!dataset) throw new Error(`Dataset not found: ${datasetId}`);

    const result = await this.storageService.deleteDataset(
      dataset,
      onProgress,
      async () => await this.metadataService.deleteMetadata(datasetId)
    );

    // 触发 Webhook 回调事件（不阻塞数据库操作）
    this.hookBus?.emit('webhook:dataset.deleted', {
      datasetId,
    });

    return result;
  };

  /**
   * 🗑️ 物理删除数据行（不可恢复）
   *
   * 注意：该操作会直接从数据表中删除记录。
   */
  hardDeleteRows = (datasetId: string, rowIds: number[]) =>
    this.recordMutationService.hardDeleteRows(datasetId, rowIds);

  updateRecord = (datasetId: string, rowId: number, updates: DataRecord) =>
    this.recordMutationService.updateRecord(datasetId, rowId, updates);

  batchUpdateRecords = (
    datasetId: string,
    updates: Array<{ rowId: number; updates: DataRecord }>
  ) => this.recordMutationService.batchUpdateRecords(datasetId, updates);

  insertRecord = (datasetId: string, record: DataRecord) =>
    this.recordMutationService.insertRecord(datasetId, record);

  batchInsertRecords = (datasetId: string, records: DataRecord[]) =>
    this.recordMutationService.batchInsertRecords(datasetId, records);

  executeInQueue = <T>(id: string, operation: () => Promise<T>) =>
    this.storageService.executeInQueue(id, operation);

  /**
   * 📎 在队列中执行带 ATTACH 的操作
   * 提供给 service facade 的统一入口
   */
  async withDatasetAttached<T>(datasetId: string, operation: () => Promise<T>): Promise<T> {
    const dataset = await this.metadataService.getDatasetInfo(datasetId);
    if (!dataset) throw new Error(`Dataset not found: ${datasetId}`);

    return this.storageService.withDatasetAttached(datasetId, dataset.filePath, operation);
  }

  materializeCleanToNewColumns = (datasetId: string, cleanConfig: CleanConfig) =>
    this.materializationService.materializeCleanToNewColumns(datasetId, cleanConfig);

  listGroupTabsByDataset = (datasetId: string): Promise<GroupTabDataset[]> =>
    this.groupTabWorkflowService.listGroupTabsByDataset(datasetId);

  reorderGroupTabs = (tabGroupId: string, datasetIds: string[]): Promise<void> =>
    this.groupTabWorkflowService.reorderGroupTabs(tabGroupId, datasetIds);

  renameGroupTab = (datasetId: string, newName: string): Promise<void> =>
    this.groupTabWorkflowService.renameGroupTab(datasetId, newName);

  cloneDatasetToGroupTab = (
    sourceDatasetId: string,
    requestedName?: string
  ): Promise<{ datasetId: string; tabGroupId: string }> =>
    this.groupTabWorkflowService.cloneDatasetToGroupTab(sourceDatasetId, requestedName);

  /**
   * 🆕 创建空数据集
   */
  async createEmptyDataset(
    datasetName: string,
    options?: DatasetPlacementOptions
  ): Promise<string> {
    const datasetId = generateId('dataset');
    const outputPath = getDatasetPath(datasetId);

    // 使用队列机制创建空数据集
    return this.storageService.executeInQueue(datasetId, async () => {
      const escapedPath = outputPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
      const attachKey = `ds_${datasetId}`;
      let created = false;

      // ATTACH 数据库文件
      await this.conn.run(`ATTACH '${escapedPath}' AS ${quoteIdentifier(attachKey)}`);

      let createError: unknown = null;
      let detachErrorToThrow: unknown = null;
      let createdDatasetId: string | null = null;
      try {
        const schema = await this.createBaseDatasetTable(attachKey);

        const tabGroupId = await runInDuckDbTransaction(this.conn, async () => {
          const createdTabGroupId = await this.tabGroupService.createGroupForDataset(
            datasetId,
            datasetName
          );

          // 保存元数据
          await this.metadataService.saveMetadata({
            id: datasetId,
            name: datasetName,
            filePath: outputPath,
            rowCount: 0,
            columnCount: schema.length,
            sizeBytes: await getFileSize(outputPath),
            createdAt: Date.now(),
            schema,
            folderId: options?.folderId ?? null,
            tabGroupId: createdTabGroupId,
            tabOrder: 0,
            isGroupDefault: true,
          });

          return createdTabGroupId;
        });
        created = true;

        logger.info('Created empty dataset', {
          datasetId,
          datasetName,
          folderId: options?.folderId ?? null,
          tabGroupId,
        });

        // 触发 Webhook 回调事件（不阻塞数据库操作）
        this.hookBus?.emit('webhook:dataset.created', {
          datasetId,
          name: datasetName,
        });

        createdDatasetId = datasetId;
      } catch (error) {
        createError = error;
      } finally {
        // DETACH 数据库
        try {
          await this.conn.run(`DETACH ${quoteIdentifier(attachKey)}`);
        } catch (detachError) {
          if (createError) {
            logger.warn('Failed to detach empty dataset after create failure', {
              datasetId,
              error: detachError,
            });
          } else {
            detachErrorToThrow = detachError;
          }
        }

        if (createError && !created) {
          await this.cleanupFailedEmptyDatasetFiles(datasetId, outputPath);
        }
      }

      if (createError) {
        throw createError;
      }
      if (detachErrorToThrow) {
        throw detachErrorToThrow;
      }
      if (!createdDatasetId) {
        throw new Error(`Empty dataset creation did not produce an id: ${datasetId}`);
      }
      return createdDatasetId;
    });
  }

  private async cleanupFailedEmptyDatasetFiles(
    datasetId: string,
    outputPath: string
  ): Promise<void> {
    const files = [outputPath, `${outputPath}.wal`];

    for (const filePath of files) {
      try {
        if (await fs.pathExists(filePath)) {
          await fs.remove(filePath);
        }
      } catch (cleanupError) {
        logger.warn('Failed to cleanup empty dataset file after create failure', {
          datasetId,
          filePath,
          error: cleanupError,
        });
      }
    }
  }

  /**
   * 🧹 清理所有服务
   */
  async cleanup(): Promise<void> {
    await this.importService.cleanup();
    logger.info('DatasetService cleanup completed');
  }
}
