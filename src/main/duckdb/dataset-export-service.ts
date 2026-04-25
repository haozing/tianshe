/**
 * DatasetExportService - 数据集导出服务
 *
 * 职责：
 * - 多格式数据导出（CSV, Excel, JSON, Parquet, TXT）
 * - 导出 SQL 构建（支持查询模板筛选、隐藏列）
 * - Excel 大文件拆分（>1M 行）
 * - 导出后操作（可选物理删除）
 * - 导出进度跟踪
 *
 * 📤 支持5种主流格式，智能处理大数据集
 */

import { DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs-extra';
import path from 'path';
import { DatasetMetadataService } from './dataset-metadata-service';
import { DatasetStorageService, sanitizeDatasetId } from './dataset-storage-service';
import { escapeSqlStringLiteral, parseRows, quoteIdentifier, quoteQualifiedName } from './utils';
import type { ExportOptions, ExportProgress, ExportResult } from '../../types/electron';
import type { ColumnConfig, QueryConfig } from '../../core/query-engine/types';
import {
  getMergedHiddenColumnNames,
  isSystemField,
  type DatasetColumnLike,
} from '../../utils/dataset-column-capabilities';

const EXPORT_SYSTEM_COLUMN_NAMES = ['_row_id', 'created_at', 'updated_at'] as const;
const EXPORT_SYSTEM_COLUMNS = new Set<string>(EXPORT_SYSTEM_COLUMN_NAMES);

type ExportQueryTemplate = {
  id?: string;
  queryConfig?: QueryConfig;
};

export interface ExportQuerySQLBuilder {
  buildExportSQL(datasetId: string, queryConfig: QueryConfig): Promise<string>;
}

interface ExportPlan {
  exportSQL: string;
  rowIdSQL?: string;
}

export class DatasetExportService {
  private exportQuerySQLBuilder?: ExportQuerySQLBuilder;

  constructor(
    private conn: DuckDBConnection,
    private metadataService: DatasetMetadataService,
    private storageService: DatasetStorageService
  ) {}

  /**
   * 设置导出查询 SQL 构造器。
   */
  setExportQuerySQLBuilder(exportQuerySQLBuilder: ExportQuerySQLBuilder): void {
    this.exportQuerySQLBuilder = exportQuerySQLBuilder;
  }

  /**
   * 📤 主导出方法
   *
   * 支持多种格式：CSV, Excel, JSON, Parquet, TXT
   * 自动处理大文件拆分、查询模板筛选、隐藏列等
   *
   * @param options 导出选项
   * @param onProgress 进度回调
   * @returns 导出结果
   */
  async exportDataset(
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<ExportResult> {
    const { datasetId } = options;
    const sanitizedId = sanitizeDatasetId(datasetId);

    // 🔒 使用队列机制确保串行执行，避免并发 ATTACH 导致文件锁定
    return this.storageService.executeInQueue(sanitizedId, async () => {
      const startTime = Date.now();
      const {
        outputPath,
        format,
        mode = 'data',
        respectHiddenColumns = true,
        applyFilters = true,
        applySort = true,
        applySample = false,
        postExportAction = 'keep',
        activeQueryTemplate,
        batchSize,
      } = options;
      const normalizedPostExportAction: 'keep' | 'delete' =
        postExportAction === 'delete' ? 'delete' : 'keep';

      console.log('[ExportService] Starting export:', { datasetId, format, mode, outputPath });

      // 发送初始进度
      onProgress?.({
        current: 0,
        total: 1,
        message: '正在准备导出...',
        percentage: 0,
      });

      // 1. 验证数据集存在
      const dataset = await this.metadataService.getDatasetInfo(sanitizedId);
      if (!dataset) {
        throw new Error(`Dataset not found: ${datasetId}`);
      }

      // 2. 确保数据库已 attached
      const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
      await this.storageService.smartAttach(sanitizedId, escapedPath);

      try {
        // 3. 构建导出 SQL
        onProgress?.({
          current: 0,
          total: 1,
          message: '正在构建查询...',
          percentage: 10,
        });

        const exportPlan = await this.buildExportPlan({
          datasetId: sanitizedId,
          mode,
          respectHiddenColumns,
          applyFilters,
          applySort,
          applySample,
          shouldDeleteRows: normalizedPostExportAction === 'delete' && mode === 'data',
          columns: options.columns,
          selectedRowIds: options.selectedRowIds,
          queryTemplate: activeQueryTemplate,
          schema: dataset.schema ?? [],
        });
        const { exportSQL } = exportPlan;

        console.log('[ExportService] Export SQL:', exportSQL);

        // 4. 执行导出（根据格式）
        onProgress?.({
          current: 0,
          total: 1,
          message: '正在导出数据...',
          percentage: 20,
        });

        let files: string[];
        let totalRows: number;

        if (format === 'xlsx') {
          // Excel 可能需要拆分文件
          const result = await this.exportToExcel(
            exportSQL,
            outputPath,
            {
              maxRowsPerFile: 1_000_000,
            },
            onProgress
          );
          files = result.files;
          totalRows = result.totalRows;
        } else if (format === 'csv') {
          await this.exportToCSV(exportSQL, outputPath, options);
          files = [outputPath];
          totalRows = await this.getRowCount(exportSQL);
          onProgress?.({
            current: 1,
            total: 1,
            message: 'CSV 导出完成',
            percentage: 80,
          });
        } else if (format === 'txt') {
          await this.exportToTXT(exportSQL, outputPath, options);
          files = [outputPath];
          totalRows = await this.getRowCount(exportSQL);
          onProgress?.({
            current: 1,
            total: 1,
            message: 'TXT 导出完成',
            percentage: 80,
          });
        } else if (format === 'parquet') {
          await this.exportToParquet(exportSQL, outputPath);
          files = [outputPath];
          totalRows = await this.getRowCount(exportSQL);
          onProgress?.({
            current: 1,
            total: 1,
            message: 'Parquet 导出完成',
            percentage: 80,
          });
        } else if (format === 'json') {
          await this.exportToJSON(exportSQL, outputPath, options);
          files = [outputPath];
          totalRows = await this.getRowCount(exportSQL);
          onProgress?.({
            current: 1,
            total: 1,
            message: 'JSON 导出完成',
            percentage: 80,
          });
        } else {
          throw new Error(`Unsupported export format: ${format}`);
        }

        let deletedRows = 0;

        // 5. 执行导出后操作
        if (normalizedPostExportAction !== 'keep' && mode === 'data') {
          onProgress?.({
            current: 1,
            total: 1,
            message: '正在执行导出后操作...',
            percentage: 90,
          });

          deletedRows = await this.handlePostExportAction({
            datasetId: sanitizedId,
            rowIdSQL: exportPlan.rowIdSQL,
            action: normalizedPostExportAction,
            batchSize,
          });
        }

        // 6. 完成
        onProgress?.({
          current: 1,
          total: 1,
          message: '导出完成',
          percentage: 100,
        });

        const executionTime = Date.now() - startTime;
        console.log('[ExportService] Export completed:', { files, totalRows, executionTime });

        return {
          success: true,
          files,
          totalRows,
          deletedRows,
          filesCount: files.length,
          executionTime,
          message: `成功导出 ${totalRows.toLocaleString()} 行数据`,
        };
      } catch (error) {
        console.error('[ExportService] Export failed:', error);
        return {
          success: false,
          files: [],
          totalRows: 0,
          filesCount: 0,
          executionTime: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        // ✅ ATTACH 保持有效，供后续查询模板快照访问
        // DuckDB 会在连接关闭时自动清理
      }
    });
  }

  /**
   * 🏗️ 构建导出计划
   *
   * 根据模式、筛选条件、隐藏列等构建最终的导出 SQL，
   * 并在需要删除时额外生成一条稳定的 row-id SQL。
   */
  private async buildExportPlan(params: {
    datasetId: string;
    mode: 'structure' | 'data';
    respectHiddenColumns: boolean;
    applyFilters: boolean;
    applySort: boolean;
    applySample: boolean;
    shouldDeleteRows: boolean;
    columns?: string[];
    schema: DatasetColumnLike[];
    selectedRowIds?: number[];
    queryTemplate?: ExportQueryTemplate;
  }): Promise<ExportPlan> {
    const {
      datasetId,
      mode,
      respectHiddenColumns,
      applyFilters,
      applySort,
      applySample,
      shouldDeleteRows,
      columns,
      selectedRowIds,
      schema,
      queryTemplate,
    } = params;
    const tableName = quoteQualifiedName(`ds_${datasetId}`, 'data');
    const hiddenCols = getMergedHiddenColumnNames(
      schema,
      queryTemplate?.queryConfig?.columns?.hide,
      queryTemplate?.queryConfig?.columns?.show,
      queryTemplate?.queryConfig?.columns?.select
    ).filter((columnName) => !isSystemField(columnName));
    const hiddenColumnsSet = new Set(hiddenCols);
    const normalizedSelectedRowIds = this.normalizeSelectedRowIds(selectedRowIds);

    // 1. 仅导出表结构
    if (mode === 'structure') {
      return {
        exportSQL: `SELECT * EXCLUDE ("_row_id", "created_at", "updated_at") FROM ${tableName} LIMIT 0`,
      };
    }

    // 2. 查询模板导出：统一走 QueryEngine 视图，再在外层收敛系统列/选中行。
    if (queryTemplate) {
      if (!queryTemplate.queryConfig) {
        throw new Error('activeQueryTemplate.queryConfig is required when exporting a query-backed view');
      }
      if (!this.exportQuerySQLBuilder) {
        throw new Error('Export query SQL builder is required to rebuild export SQL from queryTemplate');
      }

      const sourceQueryConfig = this.buildExportQueryConfig(queryTemplate.queryConfig, {
        respectHiddenColumns,
        applyFilters,
        applySort,
        applySample,
        hiddenColumns: hiddenCols,
        requiredColumns:
          normalizedSelectedRowIds.length > 0 || shouldDeleteRows ? ['_row_id'] : undefined,
      });

      console.log('[ExportService] Rebuilding SQL without pagination for export');
      let sourceSQL = await this.exportQuerySQLBuilder.buildExportSQL(datasetId, sourceQueryConfig);
      if (normalizedSelectedRowIds.length > 0) {
        sourceSQL = this.filterSQLBySelectedRows(sourceSQL, normalizedSelectedRowIds);
      }

      const exportSQL = this.applyColumnProjection(
        this.excludeSystemColumnsFromExportSQL(sourceSQL, sourceQueryConfig.columns?.select),
        {
          columns,
          systemColumns: EXPORT_SYSTEM_COLUMNS,
          hiddenColumnsSet,
          respectHiddenColumns,
        }
      );

      console.log('[ExportService] Generated export SQL (query-backed)');

      return {
        exportSQL,
        rowIdSQL: shouldDeleteRows ? this.buildRowIdSQL(sourceSQL) : undefined,
      };
    }

    // 3. 简单导出主表。
    let sql =
      normalizedSelectedRowIds.length > 0
        ? `SELECT * EXCLUDE ("_row_id", "created_at", "updated_at") FROM ${tableName} WHERE _row_id IN (${normalizedSelectedRowIds.join(', ')})`
        : `SELECT * EXCLUDE ("_row_id", "created_at", "updated_at") FROM ${tableName}`;

    if (respectHiddenColumns && hiddenCols.length > 0) {
      const excludeClause = hiddenCols.map((col) => quoteIdentifier(col)).join(', ');
      sql = sql.replace(
        /EXCLUDE \("_row_id", "created_at", "updated_at"\)/,
        `EXCLUDE ("_row_id", "created_at", "updated_at", ${excludeClause})`
      );
    }

    return {
      exportSQL: this.applyColumnProjection(sql, {
        columns,
        systemColumns: EXPORT_SYSTEM_COLUMNS,
        hiddenColumnsSet,
        respectHiddenColumns,
      }),
      rowIdSQL: shouldDeleteRows ? this.buildBaseTableRowIdSQL(tableName, normalizedSelectedRowIds) : undefined,
    };
  }

  private buildExportQueryConfig(
    queryConfig: QueryConfig,
    options: {
      respectHiddenColumns: boolean;
      applyFilters: boolean;
      applySort: boolean;
      applySample: boolean;
      hiddenColumns: string[];
      requiredColumns?: string[];
    }
  ): QueryConfig {
    const {
      respectHiddenColumns,
      applyFilters,
      applySort,
      applySample,
      hiddenColumns,
      requiredColumns,
    } = options;
    if (!queryConfig) {
      return queryConfig;
    }

    const mergedHiddenColumns = respectHiddenColumns
      ? Array.from(new Set([...(queryConfig.columns?.hide ?? []), ...hiddenColumns]))
      : undefined;
    const baseColumns: ColumnConfig | undefined =
      queryConfig.columns || (mergedHiddenColumns && mergedHiddenColumns.length > 0 ? {} : undefined);
    const nextSelectedColumns =
      baseColumns?.select && baseColumns.select.length > 0
        ? Array.from(new Set([...(baseColumns.select ?? []), ...(requiredColumns ?? [])]))
        : baseColumns?.select;
    const nextColumns = baseColumns
      ? {
          ...baseColumns,
          select: nextSelectedColumns,
          hide: mergedHiddenColumns,
          show: respectHiddenColumns ? baseColumns.show : undefined,
        }
      : undefined;
    const hasColumnConfig =
      (nextColumns?.select?.length ?? 0) > 0 ||
      (nextColumns?.hide?.length ?? 0) > 0 ||
      (nextColumns?.show?.length ?? 0) > 0 ||
      Object.keys(nextColumns?.rename ?? {}).length > 0;

    return {
      ...queryConfig,
      filter: applyFilters ? queryConfig.filter : undefined,
      sort: applySort ? queryConfig.sort : undefined,
      sample: applySample ? queryConfig.sample : undefined,
      columns: hasColumnConfig ? nextColumns : undefined,
    };
  }

  private normalizeSelectedRowIds(selectedRowIds?: number[]): number[] {
    if (!selectedRowIds || selectedRowIds.length === 0) {
      return [];
    }

    const normalized = selectedRowIds.filter(
      (rowId) => typeof rowId === 'number' && Number.isFinite(rowId) && Number.isInteger(rowId)
    );
    if (normalized.length !== selectedRowIds.length) {
      throw new Error('selectedRowIds must be an array of integers');
    }

    return Array.from(new Set(normalized));
  }

  private filterSQLBySelectedRows(sql: string, selectedRowIds: number[]): string {
    if (selectedRowIds.length === 0) {
      return sql;
    }

    const rowIdList = selectedRowIds.join(', ');
    const orderBySplit = this.splitTopLevelOrderByTail(sql);
    const filtered =
      `SELECT * FROM (${orderBySplit.baseSql}) AS __export_selected ` +
      `WHERE "_row_id" IN (${rowIdList})`;
    return orderBySplit.orderByTail ? `${filtered}\n${orderBySplit.orderByTail}` : filtered;
  }

  private buildRowIdSQL(sourceSQL: string): string {
    return `SELECT "_row_id" FROM (${sourceSQL}) AS __export_row_ids`;
  }

  private buildBaseTableRowIdSQL(tableName: string, selectedRowIds: number[]): string {
    if (selectedRowIds.length > 0) {
      return `SELECT "_row_id" FROM ${tableName} WHERE _row_id IN (${selectedRowIds.join(', ')})`;
    }

    return `SELECT "_row_id" FROM ${tableName}`;
  }

  private applyColumnProjection(
    sql: string,
    params: {
      columns?: string[];
      systemColumns: Set<string>;
      hiddenColumnsSet: Set<string>;
      respectHiddenColumns: boolean;
    }
  ): string {
    const { columns, systemColumns, hiddenColumnsSet, respectHiddenColumns } = params;
    if (!columns || columns.length === 0) return sql;

    const cleaned = columns
      .filter((col) => typeof col === 'string' && col.trim().length > 0)
      .map((col) => col.trim())
      .filter((col) => !systemColumns.has(col))
      .filter((col) => (respectHiddenColumns ? !hiddenColumnsSet.has(col) : true));

    if (cleaned.length === 0) {
      throw new Error('No columns to export after applying filters');
    }

    const orderBySplit = this.splitTopLevelOrderByTail(sql);
    const canHoistOrderBy =
      orderBySplit.orderByTail.length > 0 &&
      this.findTopLevelSelectStarInsertionIndex(sql) !== null;
    const excludedColumnsForOrderBy = new Set(systemColumns);
    if (respectHiddenColumns) {
      for (const col of hiddenColumnsSet) {
        excludedColumnsForOrderBy.add(col);
      }
    }
    const shouldHoistOrderBy =
      canHoistOrderBy &&
      !this.orderByTailReferencesExcludedColumns(
        orderBySplit.orderByTail,
        excludedColumnsForOrderBy
      );

    const innerSql = shouldHoistOrderBy ? orderBySplit.baseSql : sql;
    const projection = cleaned.map((col) => quoteIdentifier(col)).join(', ');
    const projected = `SELECT ${projection} FROM (${innerSql}) AS __export`;
    return shouldHoistOrderBy ? `${projected}\n${orderBySplit.orderByTail}` : projected;
  }

  private splitTopLevelOrderByTail(sql: string): { baseSql: string; orderByTail: string } {
    const orderByIndex = this.findTopLevelOrderByIndex(sql);
    if (orderByIndex === null) {
      return { baseSql: sql, orderByTail: '' };
    }

    return {
      baseSql: sql.slice(0, orderByIndex).trimEnd(),
      orderByTail: sql.slice(orderByIndex).trim(),
    };
  }

  private findTopLevelOrderByIndex(sql: string): number | null {
    const lower = sql.toLowerCase();
    const isWordChar = (char: string) => /[a-z0-9_]/i.test(char);

    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;
    let orderByIndex: number | null = null;

    for (let index = 0; index < sql.length; index += 1) {
      const char = sql[index]!;
      const next = sql[index + 1];

      if (inLineComment) {
        if (char === '\n') inLineComment = false;
        continue;
      }

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          index += 1;
        }
        continue;
      }

      if (inSingleQuote) {
        if (char === "'") {
          if (next === "'") {
            index += 1;
          } else {
            inSingleQuote = false;
          }
        }
        continue;
      }

      if (inDoubleQuote) {
        if (char === '"') {
          if (next === '"') {
            index += 1;
          } else {
            inDoubleQuote = false;
          }
        }
        continue;
      }

      if (char === '-' && next === '-') {
        inLineComment = true;
        index += 1;
        continue;
      }

      if (char === '/' && next === '*') {
        inBlockComment = true;
        index += 1;
        continue;
      }

      if (char === "'") {
        inSingleQuote = true;
        continue;
      }

      if (char === '"') {
        inDoubleQuote = true;
        continue;
      }

      if (char === '(') {
        depth += 1;
        continue;
      }

      if (char === ')') {
        depth = Math.max(0, depth - 1);
        continue;
      }

      if (depth !== 0) continue;

      if (!lower.startsWith('order', index)) continue;

      const before = index === 0 ? ' ' : lower[index - 1]!;
      const afterOrder = lower[index + 5] ?? ' ';
      if (isWordChar(before) || isWordChar(afterOrder)) continue;

      let cursor = index + 5;
      while (cursor < sql.length && /\s/.test(lower[cursor]!)) cursor += 1;
      if (!lower.startsWith('by', cursor)) continue;

      const afterBy = lower[cursor + 2] ?? ' ';
      if (isWordChar(afterBy)) continue;

      orderByIndex = index;
    }

    return orderByIndex;
  }

  private orderByTailReferencesExcludedColumns(
    orderByTail: string,
    excludedColumns: Set<string>
  ): boolean {
    if (!orderByTail || excludedColumns.size === 0) return false;
    const lowerTail = orderByTail.toLowerCase();

    for (const col of excludedColumns) {
      const normalized = col.trim();
      if (!normalized) continue;
      const colLower = normalized.toLowerCase();

      if (lowerTail.includes(`"${colLower}"`)) return true;

      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
      if (pattern.test(orderByTail)) return true;
    }

    return false;
  }

  private excludeSystemColumnsFromExportSQL(
    sql: string,
    explicitSelectedColumns?: string[]
  ): string {
    const systemColumnNames = ['_row_id', 'created_at', 'updated_at'] as const;
    const systemColumns = new Set(systemColumnNames);
    const explicitSystemColumns =
      Array.isArray(explicitSelectedColumns) && explicitSelectedColumns.length > 0
        ? explicitSelectedColumns.filter(
            (columnName): columnName is (typeof systemColumnNames)[number] =>
              systemColumns.has(columnName as (typeof systemColumnNames)[number])
          )
        : undefined;
    const excludedSystemColumns =
      explicitSystemColumns !== undefined ? explicitSystemColumns : Array.from(systemColumns);

    if (/EXCLUDE\s*\(\s*"?_row_id"?/i.test(sql)) {
      return sql;
    }

    if (excludedSystemColumns.length === 0) {
      return sql;
    }

    const insertionIndex = this.findTopLevelSelectStarInsertionIndex(sql);
    if (insertionIndex !== null) {
      const excludeClause = excludedSystemColumns
        .map((columnName) => quoteIdentifier(columnName))
        .join(', ');
      return (
        sql.slice(0, insertionIndex) +
        ` EXCLUDE (${excludeClause})` +
        sql.slice(insertionIndex)
      );
    }

    console.warn(
      '[ExportService] Unable to exclude system columns from top-level SELECT; wrapping export query'
    );

    const orderBySplit = this.splitTopLevelOrderByTail(sql);
    const canHoistOrderBy =
      orderBySplit.orderByTail.length > 0 &&
      !this.orderByTailReferencesExcludedColumns(orderBySplit.orderByTail, systemColumns);
    const innerSql = canHoistOrderBy ? orderBySplit.baseSql : sql;
    const excludeClause = excludedSystemColumns.map((columnName) => quoteIdentifier(columnName)).join(', ');
    const wrapped =
      `SELECT * EXCLUDE (${excludeClause}) ` +
      `FROM (${innerSql}) AS __export_base`;

    if (canHoistOrderBy) {
      return `${wrapped}\n${orderBySplit.orderByTail}`;
    }

    if (orderBySplit.orderByTail.length > 0) {
      console.warn(
        '[ExportService] Unable to hoist ORDER BY while excluding system columns; result order may differ'
      );
    }

    return wrapped;
  }

  private findTopLevelSelectStarInsertionIndex(sql: string): number | null {
    const lower = sql.toLowerCase();
    const isWordChar = (char: string) => /[a-z0-9_]/i.test(char);

    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;
    let lastInsertion: number | null = null;

    for (let index = 0; index < sql.length; index += 1) {
      const char = sql[index]!;
      const next = sql[index + 1];

      if (inLineComment) {
        if (char === '\n') inLineComment = false;
        continue;
      }

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          index += 1;
        }
        continue;
      }

      if (inSingleQuote) {
        if (char === "'") {
          if (next === "'") {
            index += 1;
          } else {
            inSingleQuote = false;
          }
        }
        continue;
      }

      if (inDoubleQuote) {
        if (char === '"') {
          if (next === '"') {
            index += 1;
          } else {
            inDoubleQuote = false;
          }
        }
        continue;
      }

      if (char === '-' && next === '-') {
        inLineComment = true;
        index += 1;
        continue;
      }

      if (char === '/' && next === '*') {
        inBlockComment = true;
        index += 1;
        continue;
      }

      if (char === "'") {
        inSingleQuote = true;
        continue;
      }

      if (char === '"') {
        inDoubleQuote = true;
        continue;
      }

      if (char === '(') {
        depth += 1;
        continue;
      }

      if (char === ')') {
        depth = Math.max(0, depth - 1);
        continue;
      }

      if (depth !== 0) continue;
      if (!lower.startsWith('select', index)) continue;

      const before = index > 0 ? lower[index - 1] : '';
      const after = lower[index + 6] ?? '';
      if ((before && isWordChar(before)) || (after && isWordChar(after))) {
        continue;
      }

      let cursor = index + 6;
      while (cursor < sql.length && /\s/.test(sql[cursor]!)) cursor += 1;

      if (lower.startsWith('distinct', cursor) && !isWordChar(lower[cursor + 8] ?? '')) {
        cursor += 8;
        while (cursor < sql.length && /\s/.test(sql[cursor]!)) cursor += 1;
      } else if (lower.startsWith('all', cursor) && !isWordChar(lower[cursor + 3] ?? '')) {
        cursor += 3;
        while (cursor < sql.length && /\s/.test(sql[cursor]!)) cursor += 1;
      }

      if (sql[cursor] === '*') {
        lastInsertion = cursor + 1;
      }
    }

    return lastInsertion;
  }

  // ==================== 格式导出方法 ====================

  /**
   * 📄 导出为 CSV
   */
  private async exportToCSV(
    sql: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<void> {
    const escapedPath = escapeSqlStringLiteral(outputPath.replace(/\\/g, '/'));
    const delimiter = escapeSqlStringLiteral(options.delimiter || ',');
    const header = options.includeHeader !== false;

    const copySQL = `
      COPY (${sql})
      TO '${escapedPath}'
      (FORMAT CSV, HEADER ${header}, DELIMITER '${delimiter}');
    `;

    console.log('[ExportService] Exporting to CSV:', outputPath);
    await this.conn.run(copySQL);
    await this.rewriteTextFileEncoding(outputPath, options.encoding);
    console.log('[ExportService] CSV export completed');
  }

  /**
   * 📊 导出为 Excel（带拆分支持）
   */
  private async exportToExcel(
    sql: string,
    outputPath: string,
    options: { maxRowsPerFile: number },
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ files: string[]; totalRows: number }> {
    const { maxRowsPerFile } = options;

    // 1. 获取总行数
    const totalRows = await this.getRowCount(sql);
    console.log('[ExportService] Total rows to export:', totalRows);

    // 2. 判断是否需要拆分
    if (totalRows <= maxRowsPerFile) {
      // 无需拆分，直接导出
      console.log('[ExportService] Exporting single Excel file');
      onProgress?.({
        current: 0,
        total: 1,
        message: `正在导出 Excel 文件 (${totalRows.toLocaleString()} 行)...`,
        percentage: 30,
      });

      await this.exportSingleExcel(sql, outputPath);

      onProgress?.({
        current: 1,
        total: 1,
        message: 'Excel 导出完成',
        percentage: 80,
      });

      return { files: [outputPath], totalRows };
    }

    // 3. 需要拆分
    const filesCount = Math.ceil(totalRows / maxRowsPerFile);
    const { dir, name, ext } = path.parse(outputPath);
    const files: string[] = [];

    console.log('[ExportService] Splitting into', filesCount, 'Excel files');

    for (let i = 0; i < filesCount; i++) {
      const offset = i * maxRowsPerFile;
      const limit = maxRowsPerFile;
      const filePath = path.join(dir, `${name}_part${i + 1}${ext}`);

      // 报告进度
      const currentPercentage = 30 + Math.floor((i / filesCount) * 50); // 30-80%
      onProgress?.({
        current: i + 1,
        total: filesCount,
        message: `正在导出第 ${i + 1}/${filesCount} 个文件...`,
        percentage: currentPercentage,
      });

      // 分页查询并导出
      const pagedSQL = `${sql} LIMIT ${limit} OFFSET ${offset}`;
      await this.exportSingleExcel(pagedSQL, filePath);

      files.push(filePath);
      console.log(`[ExportService] Excel part ${i + 1}/${filesCount} completed: ${filePath}`);
    }

    // 所有文件导出完成
    onProgress?.({
      current: filesCount,
      total: filesCount,
      message: `Excel 导出完成 (${filesCount} 个文件)`,
      percentage: 80,
    });

    return { files, totalRows };
  }

  /**
   * 📊 导出单个 Excel 文件
   */
  private async exportSingleExcel(sql: string, outputPath: string): Promise<void> {
    // 动态导入 exceljs（避免不必要的依赖）
    let ExcelJS: any;
    try {
      ExcelJS = require('exceljs');
    } catch {
      throw new Error(
        'exceljs module not found. Please install it first:\n' +
          '  npm install exceljs\n\n' +
          'Excel export functionality requires the exceljs package.'
      );
    }

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: outputPath,
      useSharedStrings: false,
      useStyles: true,
    });
    const worksheet = workbook.addWorksheet('Data');

    console.log('[ExportService] Streaming data for Excel export');
    const result = await this.conn.stream(sql);
    const columns = result.columnNames();
    worksheet.columns = columns.map((col: string) => ({
      header: col,
      key: col,
      width: Math.min(Math.max(col.length + 2, 10), 50),
    }));

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };
    headerRow.commit();

    let streamedRows = 0;
    for await (const chunk of result.yieldRowObjectJs()) {
      for (const row of chunk) {
        worksheet.addRow(row).commit();
        streamedRows += 1;
      }
    }

    console.log(`[ExportService] Streamed ${streamedRows} rows into Excel`);

    console.log('[ExportService] Writing Excel file:', outputPath);
    try {
      worksheet.commit();
      await workbook.commit();
      console.log('[ExportService] Excel file written successfully');
    } catch (writeError) {
      console.error('[ExportService] Failed to write Excel file:', writeError);
      throw new Error(
        `Failed to write Excel file: ${writeError instanceof Error ? writeError.message : String(writeError)}\n` +
          `Please check if the file path is valid and you have write permissions.`
      );
    }
  }

  /**
   * 📝 导出为 TXT（仅第一列，无表头）
   */
  private async exportToTXT(
    sql: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<void> {
    const escapedPath = escapeSqlStringLiteral(outputPath.replace(/\\/g, '/'));

    // TXT 格式：无表头，无分隔符，无引号
    // 如果是多列，只导出第一列
    const copySQL = `
      COPY (${sql})
      TO '${escapedPath}'
      (FORMAT CSV, HEADER false, DELIMITER '', QUOTE '');
    `;

    console.log('[ExportService] Exporting to TXT:', outputPath);
    await this.conn.run(copySQL);
    await this.rewriteTextFileEncoding(outputPath, options.encoding);
    console.log('[ExportService] TXT export completed');
  }

  /**
   * 🗂️ 导出为 Parquet（列式存储，高压缩比）
   */
  private async exportToParquet(sql: string, outputPath: string): Promise<void> {
    const escapedPath = escapeSqlStringLiteral(outputPath.replace(/\\/g, '/'));

    const copySQL = `
      COPY (${sql})
      TO '${escapedPath}'
      (FORMAT PARQUET, COMPRESSION 'SNAPPY');
    `;

    console.log('[ExportService] Exporting to Parquet:', outputPath);
    await this.conn.run(copySQL);
    console.log('[ExportService] Parquet export completed');
  }

  /**
   * 📦 导出为 JSON（数组格式）
   */
  private async exportToJSON(
    sql: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<void> {
    const escapedPath = escapeSqlStringLiteral(outputPath.replace(/\\/g, '/'));

    const copySQL = `
      COPY (${sql})
      TO '${escapedPath}'
      (FORMAT JSON, ARRAY true);
    `;

    console.log('[ExportService] Exporting to JSON:', outputPath);
    await this.conn.run(copySQL);
    await this.rewriteTextFileEncoding(outputPath, options.encoding);
    console.log('[ExportService] JSON export completed');
  }

  // ==================== 后处理方法 ====================

  /**
   * 🧹 处理导出后操作
   *
   * 仅支持物理删除
   */
  private async handlePostExportAction(params: {
    datasetId: string;
    rowIdSQL?: string;
    action: 'delete';
    batchSize?: number;
  }): Promise<number> {
    const { datasetId, rowIdSQL, action, batchSize } = params;
    const tableName = quoteQualifiedName(`ds_${datasetId}`, 'data');

    console.log('[ExportService] Handling post-export action:', action);
    if (!rowIdSQL) {
      throw new Error('Row-id SQL is required when postExportAction is delete');
    }

    // 物理删除（危险操作）
    let deleteSQL: string;
    if (batchSize) {
      deleteSQL = `
        DELETE FROM ${tableName}
        WHERE _row_id IN (
          SELECT _row_id FROM (${rowIdSQL})
          LIMIT ${batchSize}
        );
      `;
    } else {
      deleteSQL = `
        DELETE FROM ${tableName}
        WHERE _row_id IN (
          SELECT _row_id FROM (${rowIdSQL})
        );
      `;
    }

    const result = await this.conn.run(deleteSQL);
    console.warn(`[ExportService] PERMANENTLY DELETED rows from ${tableName}`);
    return result.rowsChanged;
  }

  private async rewriteTextFileEncoding(
    outputPath: string,
    encoding?: ExportOptions['encoding']
  ): Promise<void> {
    if (!encoding || encoding === 'utf8') {
      return;
    }

    let iconv: typeof import('iconv-lite');
    try {
      iconv = require('iconv-lite');
    } catch {
      throw new Error(
        'iconv-lite module not found. Please install it first:\n' +
          '  npm install iconv-lite\n\n' +
          'Non-UTF8 export functionality requires the iconv-lite package.'
      );
    }

    const text = await fs.readFile(outputPath, 'utf8');
    await fs.writeFile(outputPath, iconv.encode(text, encoding));
  }

  // ==================== 工具方法 ====================

  /**
   * 🔢 获取查询结果行数
   */
  private async getRowCount(sql: string): Promise<number> {
    const result = await this.conn.runAndReadAll(`SELECT COUNT(*) as count FROM (${sql})`);
    const rows = parseRows<{ count: number }>(result);
    return Number(rows[0].count);
  }

  /**
   * 📋 获取查询结果列名
   */
  private async getColumns(sql: string): Promise<string[]> {
    // 检查 SQL 是否已经包含 LIMIT（避免重复添加）
    const hasLimit = /\bLIMIT\s+\d+/i.test(sql);

    // 执行 LIMIT 0 查询以获取列名
    const querySql = hasLimit ? sql : `${sql} LIMIT 0`;
    const result = await this.conn.runAndReadAll(querySql);
    const columnNames = result.columnNames();

    if (columnNames.length === 0) {
      // 如果没有结果，使用 DESCRIBE
      const descResult = await this.conn.runAndReadAll(`DESCRIBE (${sql})`);
      const rows = parseRows(descResult);
      return rows.map((row: any) => row.column_name);
    }

    return columnNames;
  }
}
