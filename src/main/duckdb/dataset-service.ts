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
import { DatasetStorageService, sanitizeDatasetId } from './dataset-storage-service';
import { DatasetMetadataService } from './dataset-metadata-service';
import { DatasetSchemaService } from './dataset-schema-service';
import { DatasetImportService } from './dataset-import-service';
import { DatasetExportService, type ExportQuerySQLBuilder } from './dataset-export-service';
import { DatasetQueryService } from './dataset-query-service';
import { DatasetTabGroupService, type GroupTabDataset } from './dataset-tab-group-service';
import { SQLValidator } from './sql-validator';
import { DependencyManager } from './dependency-manager';
import { ValidationEngine } from './validation-engine';
import fs from 'fs-extra';
import { CleanBuilder } from '../../core/query-engine';
import type { CleanConfig, SQLContext } from '../../core/query-engine/types';
import {
  escapeSqlStringLiteral,
  getDatasetPath,
  getFileSize,
  parseRows,
  quoteIdentifier,
  quoteQualifiedName,
} from './utils';
import { generateId } from '../../utils/id-generator';
import {
  isSystemField,
  partitionRecordFieldsBySchema,
  stripSystemFields,
} from '../../utils/dataset-column-capabilities';
import { buildMaterializedCleanColumnSpecs } from '../../utils/clean-materialization';
import type {
  Dataset,
  DatasetPlacementOptions,
  ImportProgress,
  DataRecord,
  EnhancedColumnSchema,
} from './types';
import type { ExportOptions, ExportProgress } from '../../types/electron';

/**
 * 验证列名是否安全（防止SQL注入）
 */
function validateColumnName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error(`Invalid column name: ${name}`);
  }

  // 检查危险字符和SQL关键字
  // 注意：这里仅阻止明显的注入分隔符，以及“纯关键字列名”（避免误杀如 user_name 之类的合法列名）
  const dangerousSequences = [';', '--', '/*', '*/'];
  const dangerousKeywords = ['DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'EXEC'];
  const upperName = name.toUpperCase();

  for (const seq of dangerousSequences) {
    if (name.includes(seq)) {
      throw new Error(`Column name contains dangerous characters: ${name}`);
    }
  }

  if (dangerousKeywords.includes(upperName)) {
    throw new Error(`Column name is a reserved SQL keyword: ${name}`);
  }
}

/**
 * 安全引用列名（转义双引号并验证）
 */
function safeQuoteColumn(name: string): string {
  validateColumnName(name);
  // 转义双引号
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 系统字段列表
 * 这些字段由数据库自动生成和管理，插入时应该被过滤掉
 */

type BaseDatasetColumnDefinition = Pick<
  EnhancedColumnSchema,
  'name' | 'duckdbType' | 'fieldType' | 'nullable' | 'metadata'
>;

/**
 * 判断是否为系统字段
 */

/**
 * 过滤掉系统字段（防御性编程：后端再次过滤）
 */
function filterSystemFields(record: DataRecord): DataRecord {
  return stripSystemFields(record as Record<string, unknown>) as DataRecord;
}

function getWritableRecordForDataset(dataset: Dataset, record: DataRecord): DataRecord {
  const cleanedRecord = filterSystemFields(record);
  const schema = Array.isArray(dataset.schema) ? dataset.schema : [];
  const { accepted, unknownColumns, nonWritableColumns } = partitionRecordFieldsBySchema(
    cleanedRecord as Record<string, unknown>,
    schema
  );

  if (unknownColumns.length > 0) {
    throw new Error(`Unknown columns: ${unknownColumns.join(', ')}`);
  }

  if (nonWritableColumns.length > 0) {
    throw new Error(`Columns are not writable: ${nonWritableColumns.join(', ')}`);
  }

  return accepted as DataRecord;
}

export class DatasetService {
  // 子服务实例
  private storageService: DatasetStorageService;
  private metadataService: DatasetMetadataService;
  private schemaService: DatasetSchemaService;
  private importService: DatasetImportService;
  private exportService: DatasetExportService;
  private queryService: DatasetQueryService;
  private tabGroupService: DatasetTabGroupService;

  // 辅助服务
  private sqlValidator: SQLValidator;
  private dependencyManager: DependencyManager;
  private validationEngine: ValidationEngine;

  // 🆕 HookBus（用于 Webhook 回调）
  private hookBus?: import('../../core/hookbus').HookBus;

  constructor(
    private conn: DuckDBConnection,
    hookBus?: import('../../core/hookbus').HookBus // 🆕 可选参数
  ) {
    this.hookBus = hookBus;
    // ========== 依赖注入 - 按拓扑顺序初始化 ==========

    // 🔹 底层：存储和队列
    this.storageService = new DatasetStorageService(conn);

    // 🔹 数据层：元数据管理
    this.metadataService = new DatasetMetadataService(conn, this.storageService);
    this.tabGroupService = new DatasetTabGroupService(conn);

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
    this.importService = new DatasetImportService(conn, this.metadataService);
    this.exportService = new DatasetExportService(conn, this.metadataService, this.storageService);
    this.queryService = new DatasetQueryService(
      conn,
      this.metadataService,
      this.schemaService,
      this.storageService
    );

    console.log('✅ DatasetService initialized with modular architecture');
  }

  /**
   * 设置 QueryEngine（延迟注入，避免循环依赖）
   */
  setQueryEngine(queryEngine: import('../../core/query-engine/QueryEngine').QueryEngine): void {
    this.queryService.setQueryEngine(queryEngine);
  }

  /**
   * 设置导出 SQL 构造器（延迟注入，避免直接耦合导出服务和完整 DuckDBService）。
   */
  setExportQuerySQLBuilder(exportQuerySQLBuilder: ExportQuerySQLBuilder): void {
    this.exportService.setExportQuerySQLBuilder(exportQuerySQLBuilder);
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

  private getDescribeColumnName(row: Record<string, any>): string {
    const columnName = row.column_name ?? row.column ?? row.name ?? Object.values(row)[0];
    return String(columnName ?? '').trim();
  }

  private getDescribeColumnType(row: Record<string, any>): string {
    const columnType = row.column_type ?? row.type ?? Object.values(row)[1];
    return String(columnType ?? '').trim();
  }

  private getDescribeNullable(row: Record<string, any>): boolean {
    const nullableValue = row.null ?? row.nullable ?? Object.values(row)[2];
    return String(nullableValue ?? 'YES').trim().toUpperCase() !== 'NO';
  }

  private async createCloneTargetTable(
    targetAttachKey: string,
    sourceTableName: string
  ): Promise<string[]> {
    const describeResult = await this.conn.runAndReadAll(`DESCRIBE ${sourceTableName}`);
    const describeRows = parseRows(describeResult);
    if (describeRows.length === 0) {
      throw new Error('Source dataset table has no physical columns');
    }

    const targetTableName = quoteQualifiedName(targetAttachKey, 'data');
    const targetColumnDefinitions = describeRows.map((row: any) => {
      const columnName = this.getDescribeColumnName(row);
      const columnType = this.getDescribeColumnType(row);
      const nullable = this.getDescribeNullable(row);

      if (!columnName || !columnType) {
        throw new Error('Failed to inspect source dataset table schema');
      }

      if (columnName === '_row_id') {
        return `${quoteIdentifier(columnName)} BIGINT PRIMARY KEY`;
      }
      if (columnName === 'created_at' || columnName === 'updated_at') {
        return `${quoteIdentifier(columnName)} ${columnType} DEFAULT (now())`;
      }
      if (columnName === 'deleted_at') {
        return `${quoteIdentifier(columnName)} ${columnType} DEFAULT NULL`;
      }

      return `${quoteIdentifier(columnName)} ${columnType}${nullable ? '' : ' NOT NULL'}`;
    });

    await this.conn.run(`CREATE TABLE ${targetTableName} (${targetColumnDefinitions.join(', ')})`);
    await this.configureRowIdSequence(targetAttachKey, targetTableName, 1);

    return describeRows.map((row: any) => this.getDescribeColumnName(row));
  }

  private async copyRowsToCloneTable(
    sourceTableName: string,
    targetTableName: string,
    columnNames: string[]
  ): Promise<void> {
    const quotedColumns = columnNames.map((name) => quoteIdentifier(name)).join(', ');
    const hasRowIdColumn = columnNames.includes('_row_id');
    const selectedColumns = columnNames
      .map((name) =>
        name === '_row_id'
          ? `${quoteIdentifier('__normalized_row_id')} AS ${quoteIdentifier(name)}`
          : quoteIdentifier(name)
      )
      .join(', ');

    if (hasRowIdColumn) {
      await this.conn.run(`
        INSERT INTO ${targetTableName} (${quotedColumns})
        WITH source_rows AS (
          SELECT
            *,
            CASE
              WHEN ${quoteIdentifier('_row_id')} IS NOT NULL THEN ${quoteIdentifier('_row_id')}
              ELSE COALESCE(MAX(${quoteIdentifier('_row_id')}) OVER (), 0)
                + ROW_NUMBER() OVER (ORDER BY rowid)
            END AS ${quoteIdentifier('__normalized_row_id')}
          FROM ${sourceTableName}
        )
        SELECT ${selectedColumns}
        FROM source_rows
      `);
      return;
    }

    await this.conn.run(`
      INSERT INTO ${targetTableName} (${quotedColumns})
      SELECT ${quotedColumns}
      FROM ${sourceTableName}
    `);
  }

  // ==================== 元数据 API（代理） ====================

  initTable = () => this.metadataService.initTable();
  listDatasets = () => this.metadataService.listDatasets();
  getDatasetInfo = (id: string) => this.metadataService.getDatasetInfo(id);
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
    const sanitizedId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(sanitizedId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(sanitizedId);
      if (!dataset) throw new Error(`Dataset not found: ${sanitizedId}`);

      const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
      await this.storageService.smartAttach(sanitizedId, escapedPath);

      return await this.queryService['queryEngine'].preview.validateComputeExpression(
        sanitizedId,
        expression,
        options
      );
    });
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
  async hardDeleteRows(datasetId: string, rowIds: number[]): Promise<number> {
    if (!rowIds || rowIds.length === 0) {
      throw new Error('No row IDs provided for deletion');
    }

    const safeDatasetId = sanitizeDatasetId(datasetId);

    // 安全验证：rowIds 必须为非负整数
    const validRowIds = rowIds.filter((id) => Number.isInteger(id) && id >= 0);
    if (validRowIds.length !== rowIds.length) {
      throw new Error('All row IDs must be non-negative integers');
    }

    const uniqueRowIds = Array.from(new Set(validRowIds));
    if (uniqueRowIds.length === 0) return 0;

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);

      console.warn(
        `[DatasetService] PERMANENTLY deleting ${uniqueRowIds.length} rows from ${tableName}`
      );

      const BATCH_SIZE = 1000;
      let deletedCount = 0;

      await this.conn.run('BEGIN TRANSACTION');
      try {
        for (let i = 0; i < uniqueRowIds.length; i += BATCH_SIZE) {
          const batch = uniqueRowIds.slice(i, i + BATCH_SIZE);
          const placeholders = batch.map(() => '?').join(', ');
          const countSql = `SELECT COUNT(*) AS cnt FROM ${tableName} WHERE _row_id IN (${placeholders})`;
          const countStmt = await this.conn.prepare(countSql);
          countStmt.bind(batch);
          const countResult = await countStmt.runAndReadAll();
          countStmt.destroySync();

          const batchDeletedCount = Number(parseRows(countResult)[0]?.cnt ?? 0);
          if (!Number.isFinite(batchDeletedCount) || batchDeletedCount <= 0) {
            continue;
          }

          const deleteSql = `DELETE FROM ${tableName} WHERE _row_id IN (${placeholders})`;
          const deleteStmt = await this.conn.prepare(deleteSql);
          deleteStmt.bind(batch);
          await deleteStmt.run();
          deleteStmt.destroySync();

          deletedCount += batchDeletedCount;
        }

        await this.conn.run('COMMIT');
      } catch (error) {
        await this.conn.run('ROLLBACK');
        throw error;
      }

      if (deletedCount > 0) {
        try {
          await this.metadataService.incrementRowCount(safeDatasetId, -deletedCount);
        } catch (countError) {
          console.warn(
            `[DatasetService] Failed to decrement row_count for ${safeDatasetId}:`,
            countError
          );
        }
      }

      console.warn(`[DatasetService] PERMANENTLY deleted ${deletedCount} rows`);
      return deletedCount;
    });
  }

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

  // ==================== 本地 CRUD 方法 ====================

  /**
   * ✏️ 更新单条记录
   * ✅ 统一的逻辑：插件表和普通表都使用相同的 ATTACH 机制
   */
  async updateRecord(datasetId: string, rowId: number, updates: DataRecord): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      const writableUpdates = getWritableRecordForDataset(dataset, updates);
      const columns = Object.keys(writableUpdates);
      const values = Object.values(writableUpdates);

      if (columns.length === 0) {
        throw new Error('Updates must have at least one column');
      }

      // ✅ 统一的逻辑：ATTACH + getTableName
      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);

      // 直接使用 _row_id 更新，不需要查询
      const setClause = columns.map((col) => `${safeQuoteColumn(col)} = ?`).join(', ');
      const sql = `UPDATE ${tableName} SET ${setClause} WHERE _row_id = ?`;

      console.log(`🔍 Updating record with _row_id: ${rowId}`);

      await this.conn.run('BEGIN TRANSACTION');
      try {
        const stmt = await this.conn.prepare(sql);
        stmt.bind([...values, rowId]);
        await stmt.run();
        stmt.destroySync();
        await this.conn.run('COMMIT');
        console.log(`✅ Record updated: ${safeDatasetId}, _row_id ${rowId}`);

        // 触发 Webhook 回调事件（不阻塞数据库操作）
        this.hookBus?.emit('webhook:record.updated', {
          datasetId: safeDatasetId,
          rowId,
          updates: writableUpdates,
        });
      } catch (error) {
        await this.conn.run('ROLLBACK');
        throw error;
      }
    });
  }

  /**
   * ✏️ 批量更新记录
   */
  async batchUpdateRecords(
    datasetId: string,
    updates: Array<{ rowId: number; updates: DataRecord }>
  ): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      if (updates.length === 0) return;

      // ✅ 使用辅助方法（只需执行一次）
      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);

      await this.conn.run('BEGIN TRANSACTION');
      try {
        for (const update of updates) {
          const { rowId, updates: data } = update;
          const writableUpdates = getWritableRecordForDataset(dataset, data);
          const columns = Object.keys(writableUpdates);
          const values = Object.values(writableUpdates);

          if (columns.length === 0) continue;

          // 直接使用 _row_id，不需要查询
          const setClause = columns.map((col) => `${safeQuoteColumn(col)} = ?`).join(', ');
          const sql = `UPDATE ${tableName} SET ${setClause} WHERE _row_id = ?`;
          const stmt = await this.conn.prepare(sql);
          stmt.bind([...values, rowId]);
          await stmt.run();
          stmt.destroySync();
        }

        await this.conn.run('COMMIT');
        console.log(`✅ Batch updated ${updates.length} records`);
      } catch (error) {
        await this.conn.run('ROLLBACK');
        throw error;
      }
    });
  }

  /**
   * 将清洗配置“物化”到数据表：把清洗结果写入 outputField 指定的新列。
   *
   * 说明：
   * - 仅处理带 outputField 的清洗字段（用于保留原始列）
   * - 若 outputField 不存在则自动创建为物理列
   * - 会对全表执行一次 UPDATE（可能耗时）
   */
  async materializeCleanToNewColumns(
    datasetId: string,
    cleanConfig: CleanConfig
  ): Promise<{
    createdColumns: string[];
    updatedColumns: string[];
  }> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
    if (!dataset) throw new Error(`Dataset not found: ${safeDatasetId}`);
    if (!dataset.schema) throw new Error(`Dataset has no schema: ${safeDatasetId}`);

    const materializeTargets = (cleanConfig || [])
      .map((c) => ({
        ...c,
        outputField: c.outputField?.trim(),
      }))
      .filter((c) => !!c.outputField);

    if (materializeTargets.length === 0) {
      throw new Error('请为至少一个清洗字段设置“输出列名”，用于写入新列');
    }

    // outputField 必须唯一，且不能是系统字段，且不能与源字段同名（避免“新增列”语义混淆）
    const outputFields = materializeTargets.map((c) => c.outputField!) as string[];
    const outputFieldSet = new Set<string>();
    for (const fieldConfig of materializeTargets) {
      const outputField = fieldConfig.outputField!;
      if (outputFieldSet.has(outputField)) {
        throw new Error(`输出列名重复：${outputField}`);
      }
      outputFieldSet.add(outputField);

      if (isSystemField(outputField)) {
        throw new Error(`输出列名不能为系统字段：${outputField}`);
      }

      if (outputField === fieldConfig.field) {
        throw new Error(
          `输出列名不能与源字段同名：${outputField}。如需覆盖原字段，请使用“应用清洗”（视图）或在列面板中操作。`
        );
      }
    }

    const existingColumns = new Set(dataset.schema.map((col) => col.name));
    const inferredColumns = buildMaterializedCleanColumnSpecs(materializeTargets, dataset.schema);
    const inferredColumnsByName = new Map(inferredColumns.map((column) => [column.name, column]));
    const createdColumns: string[] = [];

    // 1) 创建物理列（不存在才创建）
    // 注意：schemaService.addColumn 内部自带队列，避免在同一队列中嵌套调用导致死锁
    for (const outputField of outputFields) {
      if (existingColumns.has(outputField)) continue;

      const inferredColumn = inferredColumnsByName.get(outputField);
      if (!inferredColumn) {
        throw new Error(`无法推断清洗输出列类型：${outputField}`);
      }

      await this.schemaService.addColumn({
        datasetId: safeDatasetId,
        columnName: outputField,
        fieldType: inferredColumn.fieldType,
        duckdbTypeOverride: inferredColumn.duckdbType,
        nullable: inferredColumn.nullable,
        metadata: {
          description: '清洗生成列（物化）',
        },
        storageMode: 'physical',
      });

      createdColumns.push(outputField);
      existingColumns.add(outputField);
    }

    // 2) 执行写入（全表 UPDATE）
    // 注意：避免与 addColumn 的队列嵌套，单独在队列中执行数据写入
    await this.storageService.executeInQueue(safeDatasetId, async () => {
      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);

      // 只需要 _row_id 和源字段即可让 CleanBuilder 生成可写入的表达式
      const requiredColumns = new Set<string>(['_row_id']);
      for (const fieldConfig of materializeTargets) {
        requiredColumns.add(fieldConfig.field);
      }

      const context: SQLContext = {
        datasetId: safeDatasetId,
        currentTable: tableName,
        ctes: [],
        availableColumns: requiredColumns,
      };

      const cleanBuilder = new CleanBuilder();
      const cleanSQL = cleanBuilder.build(context, materializeTargets);

      const setClause = outputFields
        .map((col) => `${safeQuoteColumn(col)} = cleaned.${safeQuoteColumn(col)}`)
        .join(', ');

      const updateSQL = `
WITH cleaned AS (
  ${cleanSQL}
)
UPDATE ${tableName} AS t
SET ${setClause}
FROM cleaned
WHERE t._row_id = cleaned._row_id
      `.trim();

      await this.conn.run(updateSQL);
    });

    return { createdColumns, updatedColumns: outputFields };
  }

  /**
   * ➕ 插入记录
   */
  async insertRecord(datasetId: string, record: DataRecord): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      // ✅ 过滤掉系统字段（防御性编程：后端再次过滤）
      const cleanedRecord = getWritableRecordForDataset(dataset, record);
      const columns = Object.keys(cleanedRecord);
      const values = Object.values(cleanedRecord);

      if (columns.length === 0) {
        throw new Error('Record must have at least one column');
      }

      // ✅ 使用安全的列名引用
      const columnNames = columns.map((c) => safeQuoteColumn(c)).join(', ');
      const placeholders = values.map(() => '?').join(', ');

      // ✅ 使用辅助方法
      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);

      const sql = `INSERT INTO ${tableName} (${columnNames}) VALUES (${placeholders})`;
      const stmt = await this.conn.prepare(sql);
      stmt.bind(values);
      await stmt.run();
      stmt.destroySync();

      try {
        await this.metadataService.incrementRowCount(safeDatasetId, 1);
      } catch (countError) {
        console.warn(
          `[DatasetService] Failed to increment row_count for ${safeDatasetId}:`,
          countError
        );
      }

      console.log(`✅ Record inserted into ${safeDatasetId}`);

      // 触发 Webhook 回调事件（不阻塞数据库操作）
      this.hookBus?.emit('webhook:record.created', {
        datasetId: safeDatasetId,
        record: cleanedRecord,
      });
    });
  }

  /**
   * ➕ 批量插入记录（优化版本）
   * 使用事务和批量INSERT VALUES语法提升性能
   *
   * @param datasetId 数据集ID
   * @param records 记录数组
   */
  async batchInsertRecords(datasetId: string, records: DataRecord[]): Promise<void> {
    if (records.length === 0) return;

    const safeDatasetId = sanitizeDatasetId(datasetId);

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) throw new Error('Dataset not found');

      // 单条记录，使用现有方法
      if (records.length === 1) {
        // 避免嵌套队列导致死锁：batchInsertRecords 已在 executeInQueue 内部
        const cleanedRecord = getWritableRecordForDataset(dataset, records[0]);
        const columns = Object.keys(cleanedRecord);
        const values = Object.values(cleanedRecord);

        if (columns.length === 0) {
          throw new Error('Record must have at least one column');
        }

        const columnNames = columns.map((c) => safeQuoteColumn(c)).join(', ');
        const placeholders = values.map(() => '?').join(', ');

        await this.ensureAttached(dataset);
        const tableName = this.getTableName(safeDatasetId);

        const sql = `INSERT INTO ${tableName} (${columnNames}) VALUES (${placeholders})`;
        const stmt = await this.conn.prepare(sql);
        stmt.bind(values);
        await stmt.run();
        stmt.destroySync();

        try {
          await this.metadataService.incrementRowCount(safeDatasetId, 1);
        } catch (countError) {
          console.warn(
            `[DatasetService] Failed to increment row_count for ${safeDatasetId}:`,
            countError
          );
        }

        this.hookBus?.emit('webhook:record.created', {
          datasetId: safeDatasetId,
          record: cleanedRecord,
        });

        return;
      }

      // ✅ 过滤掉所有记录中的系统字段（防御性编程）
      const cleanedRecords = records.map((record) => getWritableRecordForDataset(dataset, record));

      // 验证所有记录有相同的列
      const firstColumns = Object.keys(cleanedRecords[0]).sort();
      for (const record of cleanedRecords) {
        const cols = Object.keys(record).sort();
        if (JSON.stringify(cols) !== JSON.stringify(firstColumns)) {
          throw new Error('所有记录必须有相同的列');
        }
      }

      const columns = Object.keys(cleanedRecords[0]);
      // ✅ 使用安全的列名引用
      const columnNames = columns.map((c) => safeQuoteColumn(c)).join(', ');

      // ✅ 使用辅助方法（只需执行一次）
      await this.ensureAttached(dataset);
      const tableName = this.getTableName(safeDatasetId);

      // 分批插入（每批100条，避免SQL过长）
      const BATCH_SIZE = 100;
      await this.conn.run('BEGIN TRANSACTION');

      try {
        for (let i = 0; i < cleanedRecords.length; i += BATCH_SIZE) {
          const batch = cleanedRecords.slice(i, i + BATCH_SIZE);

          // 构建批量INSERT
          const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');

          // 展平所有值
          const values: any[] = [];
          for (const record of batch) {
            for (const col of columns) {
              values.push(record[col]);
            }
          }

          // 执行插入
          const sql = `INSERT INTO ${tableName} (${columnNames}) VALUES ${placeholders}`;
          const stmt = await this.conn.prepare(sql);
          stmt.bind(values);
          await stmt.run();
          stmt.destroySync();
        }

        await this.conn.run('COMMIT');

        try {
          await this.metadataService.incrementRowCount(safeDatasetId, cleanedRecords.length);
        } catch (countError) {
          console.warn(
            `[DatasetService] Failed to increment row_count for ${safeDatasetId}:`,
            countError
          );
        }

        console.log(`✅ Batch inserted ${cleanedRecords.length} records into ${safeDatasetId}`);
      } catch (error) {
        await this.conn.run('ROLLBACK');
        throw error;
      }
    });
  }

  async listGroupTabsByDataset(datasetId: string): Promise<GroupTabDataset[]> {
    const safeDatasetId = sanitizeDatasetId(datasetId);
    return this.storageService.executeInQueue(safeDatasetId, async () => {
      return this.tabGroupService.listTabsByDataset(safeDatasetId);
    });
  }

  async reorderGroupTabs(tabGroupId: string, datasetIds: string[]): Promise<void> {
    await this.tabGroupService.reorderTabs(tabGroupId, datasetIds);
  }

  async renameGroupTab(datasetId: string, newName: string): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);
    const normalizedName = newName.trim();
    if (!normalizedName) {
      throw new Error('Tab name cannot be empty');
    }

    return this.storageService.executeInQueue(safeDatasetId, async () => {
      const dataset = await this.metadataService.getDatasetInfo(safeDatasetId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${safeDatasetId}`);
      }

      await this.metadataService.renameDataset(safeDatasetId, normalizedName);
    });
  }

  async cloneDatasetToGroupTab(
    sourceDatasetId: string,
    requestedName?: string
  ): Promise<{ datasetId: string; tabGroupId: string }> {
    const safeSourceId = sanitizeDatasetId(sourceDatasetId);

    return this.storageService.executeInQueue(safeSourceId, async () => {
      const sourceDataset = await this.metadataService.getDatasetInfo(safeSourceId);
      if (!sourceDataset) {
        throw new Error(`Dataset not found: ${safeSourceId}`);
      }

      const tabGroupId = await this.tabGroupService.ensureGroupForDataset(safeSourceId);

      const newDatasetId = generateId('dataset');
      const outputPath = getDatasetPath(newDatasetId);
      const targetAttachKey = `ds_${newDatasetId}`;
      const sourceAttachKey = `ds_${safeSourceId}`;
      const targetTableName = quoteQualifiedName(targetAttachKey, 'data');
      const sourceTableName = quoteQualifiedName(sourceAttachKey, 'data');
      const escapedTargetPath = outputPath.replace(/\\/g, '\\\\').replace(/'/g, "''");

      await this.ensureAttached(sourceDataset);
      await this.conn.run(`ATTACH '${escapedTargetPath}' AS ${quoteIdentifier(targetAttachKey)}`);

      try {
        const physicalColumnNames = await this.createCloneTargetTable(targetAttachKey, sourceTableName);
        await this.copyRowsToCloneTable(sourceTableName, targetTableName, physicalColumnNames);

        // Re-seed future inserts after copying the existing rows.
        if (physicalColumnNames.includes('_row_id')) {
          const finalMaxRowIdResult = await this.conn.runAndReadAll(
            `SELECT COALESCE(MAX(_row_id), 0) AS max_id FROM ${targetTableName}`
          );

          // 修复脏数据：给 NULL _row_id 补号，避免后续更新/删除无法定位记录
          const finalMaxRowId = Number(parseRows(finalMaxRowIdResult)[0]?.max_id ?? 0);
          const safeFinalMax = Number.isFinite(finalMaxRowId) ? finalMaxRowId : 0;
          const nextRowId = safeFinalMax + 1;

          await this.configureRowIdSequence(targetAttachKey, targetTableName, nextRowId);
        }

        const countResult = await this.conn.runAndReadAll(
          `SELECT COUNT(*) AS cnt FROM ${targetTableName}`
        );
        const describeResult = await this.conn.runAndReadAll(`DESCRIBE ${targetTableName}`);
        const rowCount = Number(parseRows(countResult)[0]?.cnt ?? 0);
        const columnCount = parseRows(describeResult).length;

        const nextOrder = await this.tabGroupService.getNextTabOrder(tabGroupId);
        const newName =
          requestedName && requestedName.trim().length > 0
            ? requestedName.trim()
            : `${sourceDataset.name} 副本`;

        await this.metadataService.saveMetadata({
          id: newDatasetId,
          name: newName,
          filePath: outputPath,
          rowCount,
          columnCount,
          sizeBytes: await getFileSize(outputPath),
          createdAt: Date.now(),
          schema: sourceDataset.schema
            ? (JSON.parse(JSON.stringify(sourceDataset.schema)) as any[])
            : undefined,
          folderId: sourceDataset.folderId ?? null,
          tableOrder: sourceDataset.tableOrder ?? 0,
          tabGroupId,
          tabOrder: nextOrder,
          isGroupDefault: false,
          createdByPlugin: sourceDataset.createdByPlugin ?? null,
        });

        console.log(
          `[DatasetService] Cloned dataset ${safeSourceId} -> ${newDatasetId} (group=${tabGroupId})`
        );

        return { datasetId: newDatasetId, tabGroupId };
      } catch (error) {
        try {
          await this.conn.run(`DETACH ${quoteIdentifier(targetAttachKey)}`);
        } catch {
          // ignore detach errors in cleanup path
        }
        await fs.remove(outputPath).catch(() => undefined);
        throw error;
      } finally {
        // 正常路径下释放目标数据库句柄
        try {
          const attached = await this.conn.runAndReadAll(
            `SELECT database_name FROM duckdb_databases() WHERE database_name = ?`,
            [targetAttachKey]
          );
          if (parseRows(attached).length > 0) {
            await this.conn.run(`DETACH ${quoteIdentifier(targetAttachKey)}`);
          }
        } catch {
          // non-critical
        }
      }
    });
  }

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

      // ATTACH 数据库文件
      await this.conn.run(`ATTACH '${escapedPath}' AS ${quoteIdentifier(attachKey)}`);

      try {
        const schema = await this.createBaseDatasetTable(attachKey);

        const tabGroupId = await this.tabGroupService.createGroupForDataset(datasetId, datasetName);

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
          tabGroupId,
          tabOrder: 0,
          isGroupDefault: true,
        });

        console.log(`✅ Created empty dataset: ${datasetId}`);

        // 触发 Webhook 回调事件（不阻塞数据库操作）
        this.hookBus?.emit('webhook:dataset.created', {
          datasetId,
          name: datasetName,
        });

        return datasetId;
      } finally {
        // DETACH 数据库
        await this.conn.run(`DETACH ${quoteIdentifier(attachKey)}`);
      }
    });
  }

  /**
   * 🧹 清理所有服务
   */
  async cleanup(): Promise<void> {
    await this.importService.cleanup();
    console.log('✅ All services cleaned up');
  }
}
