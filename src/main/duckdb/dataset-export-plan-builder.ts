import type { ColumnConfig, QueryConfig } from '../../core/query-engine/types';
import {
  getMergedHiddenColumnNames,
  isSystemField,
  type DatasetColumnLike,
} from '../../utils/dataset-column-capabilities';
import { createLogger } from '../../core/logger';
import { quoteIdentifier, quoteQualifiedName } from './utils';

const logger = createLogger('DatasetExportPlanBuilder');

const EXPORT_SYSTEM_COLUMN_NAMES = ['_row_id', 'created_at', 'updated_at'] as const;
const EXPORT_SYSTEM_COLUMNS = new Set<string>(EXPORT_SYSTEM_COLUMN_NAMES);

export type ExportQueryTemplate = {
  id?: string;
  queryConfig?: QueryConfig;
};

export interface ExportQuerySQLBuilder {
  buildExportSQL(datasetId: string, queryConfig: QueryConfig): Promise<string>;
}

export interface ExportPlan {
  exportSQL: string;
  rowIdSQL?: string;
}

export interface BuildExportPlanParams {
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
}

export class DatasetExportPlanBuilder {
  constructor(private exportQuerySQLBuilder: ExportQuerySQLBuilder | null) {}

  private requireExportQuerySQLBuilder(): ExportQuerySQLBuilder {
    if (!this.exportQuerySQLBuilder) {
      throw new Error(
        'Export query SQL builder is required to rebuild export SQL from queryTemplate'
      );
    }
    return this.exportQuerySQLBuilder;
  }

  async buildExportPlan(params: BuildExportPlanParams): Promise<ExportPlan> {
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
        throw new Error(
          'activeQueryTemplate.queryConfig is required when exporting a query-backed view'
        );
      }
      const exportQuerySQLBuilder = this.requireExportQuerySQLBuilder();

      const sourceQueryConfig = this.buildExportQueryConfig(queryTemplate.queryConfig, {
        respectHiddenColumns,
        applyFilters,
        applySort,
        applySample,
        hiddenColumns: hiddenCols,
        requiredColumns:
          normalizedSelectedRowIds.length > 0 || shouldDeleteRows ? ['_row_id'] : undefined,
      });

      logger.info('Rebuilding query-backed export SQL without pagination', {
        datasetId,
        hasSelectedRows: normalizedSelectedRowIds.length > 0,
        shouldDeleteRows,
      });
      let sourceSQL = await exportQuerySQLBuilder.buildExportSQL(datasetId, sourceQueryConfig);
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

      logger.info('Generated query-backed export SQL', {
        datasetId,
        hasRowIdSQL: shouldDeleteRows,
      });

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
      rowIdSQL: shouldDeleteRows
        ? this.buildBaseTableRowIdSQL(tableName, normalizedSelectedRowIds)
        : undefined,
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
      queryConfig.columns ||
      (mergedHiddenColumns && mergedHiddenColumns.length > 0 ? {} : undefined);
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
        sql.slice(0, insertionIndex) + ` EXCLUDE (${excludeClause})` + sql.slice(insertionIndex)
      );
    }

    logger.warn('Unable to exclude system columns from top-level SELECT, wrapping export query');

    const orderBySplit = this.splitTopLevelOrderByTail(sql);
    const canHoistOrderBy =
      orderBySplit.orderByTail.length > 0 &&
      !this.orderByTailReferencesExcludedColumns(orderBySplit.orderByTail, systemColumns);
    const innerSql = canHoistOrderBy ? orderBySplit.baseSql : sql;
    const excludeClause = excludedSystemColumns
      .map((columnName) => quoteIdentifier(columnName))
      .join(', ');
    const wrapped = `SELECT * EXCLUDE (${excludeClause}) ` + `FROM (${innerSql}) AS __export_base`;

    if (canHoistOrderBy) {
      return `${wrapped}\n${orderBySplit.orderByTail}`;
    }

    if (orderBySplit.orderByTail.length > 0) {
      logger.warn(
        'Unable to hoist ORDER BY while excluding system columns, result order may differ'
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
}
