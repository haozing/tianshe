/**
 * Database Namespace
 *
 * 提供数据库操作的命名空间接口
 * 所有数据库相关的方法都集中在这里
 */

import type { DuckDBService } from '../../../main/duckdb/service';
import type { EnhancedColumnSchema } from '../../../main/duckdb/types';
import type {
  DataTableExportOptions,
  DataTableExportOutput,
  DataTableExportResult,
  ExportOptions,
} from '../../../types/dataset-export';
import { DatabaseError, DatasetNotFoundError } from '../errors';
import { ParamValidator } from '../validators';
import { SQLUtils } from '../../query-engine/utils/sql-utils';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

type DataTableImportFormat = 'csv' | 'tsv' | 'xlsx' | 'xls';

interface DataTableImportOptions {
  datasetId: string;
  format?: DataTableImportFormat;
  csvText?: string;
  base64?: string;
  filename?: string;
  replace?: boolean;
  columnMapping?: Record<string, string>;
  requiredColumns?: string[];
  chunkSize?: number;
  encoding?: BufferEncoding;
  strict?: boolean;
}

interface DataTableImportResult {
  total: number;
  inserted: number;
  skipped: number;
  failed: number;
  cleared: boolean;
}

/**
 * 数据库命名空间
 *
 * 提供数据集的增删改查、Schema 获取、SQL 执行等功能
 *
 * @example
 * // 查询数据
 * const rows = await helpers.database.query('dataset_123');
 *
 * @example
 * // 插入记录
 * await helpers.database.insert('dataset_123', {
 *   '产品名称': '新产品',
 *   '价格': 99.9
 * });
 */
export class DatabaseNamespace {
  constructor(
    private duckdb: DuckDBService,
    private pluginId: string
  ) {}

  /**
   * 查询数据表
   *
   * @param datasetId - 数据集ID
   * @param sql - 可选的SQL查询（不提供则返回所有记录）
   * @returns 查询结果数组
   *
   * @example
   * // 查询所有记录
   * const allProducts = await helpers.database.query('dataset_123');
   *
   * @example
   * // 使用SQL筛选
   * const products = await helpers.database.query('dataset_123',
   *   "SELECT * FROM data WHERE 价格 > 100 LIMIT 10"
   * );
   */
  async query(datasetId: string, sql?: string): Promise<any[]> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateDatasetId(datasetId);

    if (sql !== undefined) {
      ParamValidator.validateString(sql, 'sql', { allowEmpty: true });
    }

    try {
      let result;
      if (sql) {
        // 自定义 SQL 查询
        result = await this.duckdb.queryDataset(datasetId, sql);
      } else {
        // 查询所有记录
        result = await this.duckdb.queryDataset(datasetId, 'SELECT * FROM data');
      }
      return result.rows;
    } catch (error: any) {
      // 区分错误类型
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        throw new DatasetNotFoundError(datasetId);
      }

      // 包装数据库错误
      throw new DatabaseError(
        `Failed to query dataset "${datasetId}"`,
        {
          datasetId,
          sql: sql || 'SELECT * FROM data',
          operation: 'query',
          originalError: error.message,
        },
        error
      );
    }
  }

  /**
   * 插入单条记录
   *
   * @param datasetId - 数据集ID
   * @param record - 记录对象（键为列名）
   *
   * @example
   * // 插入单条记录
   * await helpers.database.insert('dataset_123', {
   *   '产品名称': '测试产品',
   *   '价格': 99.9,
   *   '状态': '待发布'
   * });
   *
   * @example
   * // 批量插入请使用 batchInsert()
   * await helpers.database.batchInsert('dataset_123', [
   *   { '产品名称': '产品1', '价格': 100 },
   *   { '产品名称': '产品2', '价格': 200 }
   * ]);
   */
  async insert(datasetId: string, record: Record<string, any>): Promise<void> {
    // ✅ 使用统一的参数验证工具（减少重复代码）
    ParamValidator.validateString(datasetId, 'datasetId');
    ParamValidator.validateObject(record, 'record');

    try {
      await this.duckdb.insertRecord(datasetId, record);
    } catch (error: any) {
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        throw new DatasetNotFoundError(datasetId);
      }

      throw new DatabaseError(
        `Failed to insert record into dataset "${datasetId}"`,
        {
          datasetId,
          record,
          columns: Object.keys(record),
          operation: 'insert',
        },
        error
      );
    }
  }

  /**
   * 批量插入记录（优化版本）
   *
   * @param datasetId - 数据集ID
   * @param records - 记录数组
   *
   * @example
   * await helpers.database.batchInsert('dataset_123', [
   *   { '产品名称': '产品1', '价格': 100 },
   *   { '产品名称': '产品2', '价格': 200 },
   *   { '产品名称': '产品3', '价格': 300 }
   * ]);
   */
  async batchInsert(datasetId: string, records: Record<string, any>[]): Promise<void> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateDatasetId(datasetId);
    ParamValidator.validateArray(records, 'records', { allowEmpty: true });

    // 空数组，直接返回
    if (records.length === 0) {
      return;
    }

    try {
      // ✅ 修复：使用 DuckDB 服务的 batchInsertRecords 方法
      // 该方法会正确处理数据库 ATTACH，避免 "does not exist" 错误
      await this.duckdb.batchInsertRecords(datasetId, records);
    } catch (error: any) {
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        throw new DatasetNotFoundError(datasetId);
      }

      throw new DatabaseError(
        `Failed to batch insert ${records.length} records into dataset "${datasetId}"`,
        {
          datasetId,
          recordCount: records.length,
          operation: 'batchInsert',
        },
        error
      );
    }
  }

  /**
   * 更新记录
   *
   * @param datasetId - 数据集ID
   * @param updates - 要更新的字段和值（已参数化，安全）
   * @param where - WHERE 条件（SQL语句）
   *
   * ⚠️ **安全警告**：
   * WHERE 参数会直接拼接到 SQL 语句中，请确保不包含用户输入，避免 SQL 注入风险。
   * updates 参数会自动参数化，是安全的。
   *
   * @example
   * // ✅ 安全：WHERE 条件是硬编码的
   * await helpers.database.update('dataset_123',
   *   { '状态': '已发布', '更新时间': new Date().toISOString() },
   *   "产品名称 = '测试产品'"
   * );
   *
   * @example
   * // ❌ 不安全：WHERE 包含用户输入
   * const userId = req.query.userId; // 可能包含恶意 SQL
   * await helpers.database.update('dataset_123',
   *   { '状态': '已封禁' },
   *   `用户ID = '${userId}'`  // 危险！
   * );
   *
   * @example
   * // ✅ 建议：使用 updateRow() 方法（已参数化）
   * await helpers.database.updateRow('dataset_123', rowId, { '状态': '已发布' });
   */
  async update(datasetId: string, updates: Record<string, any>, where: string): Promise<void> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateDatasetId(datasetId);
    ParamValidator.validateObject(updates, 'updates');
    ParamValidator.validateString(where, 'where');

    try {
      const rowIds = await this.queryMatchingRowIds(datasetId, where);
      if (rowIds.length === 0) {
        return;
      }

      await this.duckdb.batchUpdateRecords(
        datasetId,
        rowIds.map((rowId) => ({ rowId, updates }))
      );
    } catch (error: any) {
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        throw new DatasetNotFoundError(datasetId);
      }

      throw new DatabaseError(
        `Failed to update records in dataset "${datasetId}"`,
        {
          datasetId,
          updates,
          where,
          operation: 'update',
        },
        error
      );
    }
  }

  /**
   * 更新单行数据（按行ID）
   *
   * ✅ 推荐使用此方法而非 update()，因为它使用参数化查询，更安全
   *
   * @param datasetId - 数据集ID
   * @param rowId - 行ID（_row_id）
   * @param updates - 要更新的字段
   *
   * @example
   * // 更新指定行
   * await helpers.database.updateById('dataset_123', 5, {
   *   '状态': '已发布',
   *   '更新时间': new Date().toISOString()
   * });
   *
   * @example
   * // 先查询再更新
   * const rows = await helpers.database.query('dataset_123', 'SELECT * FROM data WHERE 状态 = "草稿"');
   * for (const row of rows) {
   *   await helpers.database.updateById('dataset_123', row._row_id, { '状态': '已发布' });
   * }
   */
  async updateById(
    datasetId: string,
    rowId: number | string,
    updates: Record<string, any>
  ): Promise<void> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateDatasetId(datasetId);
    ParamValidator.validateNotNullOrUndefined(rowId, 'rowId', 'number | string');
    ParamValidator.validateObject(updates, 'updates');

    try {
      await this.duckdb.updateRecord(datasetId, this.normalizeRowId(rowId), updates);
    } catch (error: any) {
      throw new DatabaseError(
        `Failed to update row ${rowId} in dataset "${datasetId}"`,
        {
          datasetId,
          rowId,
          updates,
          operation: 'updateById',
        },
        error
      );
    }
  }

  /**
   * 删除记录
   *
   * @param datasetId - 数据集ID
   * @param where - WHERE 条件（SQL语句）
   *
   * ⚠️ **安全警告**：
   * WHERE 参数会直接拼接到 SQL 语句中，请确保不包含用户输入，避免 SQL 注入风险。
   * 如果需要使用用户输入，请先进行严格的验证和转义。
   *
   * @example
   * // ✅ 安全：硬编码的条件
   * await helpers.database.delete('dataset_123', "状态 = '已删除'");
   *
   * @example
   * // ❌ 不安全：包含用户输入
   * const userInput = req.query.status; // 可能包含恶意 SQL
   * await helpers.database.delete('dataset_123', `状态 = '${userInput}'`); // 危险！
   *
   * @example
   * // ✅ 建议：使用 deleteRow() 方法（已参数化）
   * await helpers.database.deleteRow('dataset_123', rowId);
   */
  async delete(datasetId: string, where: string): Promise<void> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateDatasetId(datasetId);
    ParamValidator.validateString(where, 'where');

    try {
      const rowIds = await this.queryMatchingRowIds(datasetId, where);
      if (rowIds.length === 0) {
        return;
      }

      await this.duckdb.hardDeleteRows(datasetId, rowIds);
    } catch (error: any) {
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        throw new DatasetNotFoundError(datasetId);
      }

      throw new DatabaseError(
        `Failed to delete records from dataset "${datasetId}"`,
        {
          datasetId,
          where,
          operation: 'delete',
        },
        error
      );
    }
  }

  /**
   * 根据行ID删除单行记录
   *
   * ✅ 推荐使用此方法而非 delete()，因为它使用参数化查询，更安全
   *
   * @param datasetId - 数据集ID
   * @param rowId - 行ID（_row_id）
   *
   * @example
   * // 删除指定行
   * await helpers.database.deleteById('dataset_123', 5);
   *
   * @example
   * // 查询并删除
   * const rows = await helpers.database.query('dataset_123', 'SELECT * FROM data WHERE 状态 = "已过期"');
   * for (const row of rows) {
   *   await helpers.database.deleteById('dataset_123', row._row_id);
   * }
   */
  async deleteById(datasetId: string, rowId: number | string): Promise<void> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateDatasetId(datasetId);
    ParamValidator.validateNotNullOrUndefined(rowId, 'rowId', 'number | string');

    try {
      await this.duckdb.hardDeleteRows(datasetId, [this.normalizeRowId(rowId)]);
    } catch (error: any) {
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        throw new DatasetNotFoundError(datasetId);
      }

      throw new DatabaseError(
        `Failed to delete row ${rowId} from dataset "${datasetId}"`,
        {
          datasetId,
          rowId,
          operation: 'deleteById',
        },
        error
      );
    }
  }

  /**
   * 获取数据表的 schema
   *
   * @param datasetId - 数据集ID
   * @returns 表结构（列定义数组）
   *
   * @example
   * const schema = await helpers.database.getSchema('dataset_123');
   * console.log('表有以下列：', schema.map(col => col.name));
   *
   * // 查找按钮列
   * const buttonCols = schema.filter(col => col.fieldType === 'button');
   */
  async getSchema(datasetId: string): Promise<EnhancedColumnSchema[]> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateDatasetId(datasetId);

    try {
      const dataset = await this.duckdb.getDatasetInfo(datasetId);
      if (!dataset) {
        throw new DatasetNotFoundError(datasetId);
      }
      return dataset.schema || [];
    } catch (error: any) {
      if (error instanceof DatasetNotFoundError) {
        throw error;
      }

      throw new DatabaseError(
        `Failed to get schema for dataset "${datasetId}"`,
        {
          datasetId,
          operation: 'getSchema',
        },
        error
      );
    }
  }

  /**
   * 获取数据表信息
   *
   * @param datasetId - 数据集ID
   * @returns 数据集完整信息
   *
   * @example
   * const info = await helpers.database.getDatasetInfo('dataset_123');
   * console.log(`表 "${info.name}" 有 ${info.rowCount} 行记录`);
   */
  async getDatasetInfo(datasetId: string): Promise<any> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateDatasetId(datasetId);

    try {
      const dataset = await this.duckdb.getDatasetInfo(datasetId);
      if (!dataset) {
        throw new DatasetNotFoundError(datasetId);
      }
      return dataset;
    } catch (error: any) {
      if (error instanceof DatasetNotFoundError) {
        throw error;
      }

      throw new DatabaseError(
        `Failed to get dataset info for "${datasetId}"`,
        {
          datasetId,
          operation: 'getDatasetInfo',
        },
        error
      );
    }
  }

  /**
   * 列出所有数据表
   *
   * @returns 所有数据集列表
   *
   * @example
   * const tables = await helpers.database.listDatasets();
   * console.log('可用的数据表：', tables.map(t => t.name));
   */
  async listDatasets(): Promise<any[]> {
    try {
      return await this.duckdb.listDatasets();
    } catch (error: any) {
      throw new DatabaseError(
        'Failed to list datasets',
        {
          operation: 'listDatasets',
        },
        error
      );
    }
  }

  /**
   * 执行自定义 SQL
   *
   * @param sql - SQL 语句（如果提供 datasetId，会自动替换表名 'data' 为实际表名）
   * @param options - 选项
   * @param options.params - SQL 参数（可选）
   * @param options.datasetId - 数据集ID（可选，提供后会自动处理表名）
   * @returns 查询结果
   *
   * @example
   * // 执行复杂查询（推荐：使用 datasetId 自动处理表名）
   * const result = await helpers.database.executeSQL(`
   *   SELECT 类别, COUNT(*) as 数量, AVG(价格) as 平均价格
   *   FROM data
   *   GROUP BY 类别
   * `, { datasetId: 'dataset_123' });
   *
   * @example
   * // 插入数据（使用 datasetId）
   * await helpers.database.executeSQL(`
   *   INSERT INTO data (订单ID, 客户名称, 订单金额)
   *   VALUES ('ORD-001', '测试客户', 999.99)
   * `, { datasetId: 'dataset_123' });
   *
   * @example
   * // 带参数的查询
   * const result = await helpers.database.executeSQL(
   *   'SELECT * FROM data WHERE 价格 > ? AND 状态 = ?',
   *   { params: [100, '在售'], datasetId: 'dataset_123' }
   * );
   *
   * @example
   * // 不使用 datasetId（需要手动指定完整表名）
   * const result = await helpers.database.executeSQL(
   *   'SELECT * FROM ds_dataset_123.data'
   * );
   */
  /**
   * Import records from a local file into an existing dataset.
   */
  async importRecordsFromFile(datasetId: string, filePath: string): Promise<DataTableImportResult> {
    ParamValidator.validateDatasetId(datasetId);
    ParamValidator.validateString(filePath, 'filePath');

    try {
      const result = await this.duckdb.importRecordsFromFile(datasetId, filePath);
      return {
        total: result.recordsInserted,
        inserted: result.recordsInserted,
        skipped: 0,
        failed: 0,
        cleared: false,
      };
    } catch (error: any) {
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        throw new DatasetNotFoundError(datasetId);
      }

      throw new DatabaseError(
        `Failed to import records into dataset "${datasetId}"`,
        {
          datasetId,
          filePath,
          operation: 'importRecordsFromFile',
          originalError: error.message,
        },
        error
      );
    }
  }

  /**
   * Import records from base64 data by writing a temp file and reusing DuckDB import.
   */
  async importRecordsFromBase64(options: DataTableImportOptions): Promise<DataTableImportResult> {
    ParamValidator.validateObject(options, 'options');
    ParamValidator.validateDatasetId(options.datasetId);
    ParamValidator.validateString(options.filename, 'filename');
    ParamValidator.validateString(options.base64, 'base64');

    if (options.format) {
      ParamValidator.validateEnum(options.format, 'format', ['csv', 'tsv', 'xlsx', 'xls']);
    }

    const normalizedBase64 = this.normalizeBase64(options.base64!);
    const fallbackExtension = options.format ? `.${options.format}` : '.csv';
    const tempFilePath = await this.buildTempFilePath(options.filename!, fallbackExtension);

    try {
      await fs.writeFile(tempFilePath, Buffer.from(normalizedBase64, 'base64'));
      return await this.importRecordsFromFile(options.datasetId, tempFilePath);
    } finally {
      try {
        await fs.remove(tempFilePath);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  /**
   * Export dataset records using DuckDB export service.
   */
  async exportDataset(options: DataTableExportOptions): Promise<DataTableExportResult> {
    ParamValidator.validateObject(options, 'options');
    ParamValidator.validateDatasetId(options.datasetId);

    const format = options.format ?? 'csv';
    const outputType = options.outputType ?? 'file';

    ParamValidator.validateEnum(format, 'format', ['csv', 'xlsx', 'txt', 'parquet', 'json']);
    ParamValidator.validateEnum(outputType, 'outputType', ['text', 'base64', 'file']);

    if (outputType === 'text' && !['csv', 'txt', 'json'].includes(format)) {
      throw new DatabaseError('Text output only supports csv, txt, or json formats', {
        format,
        outputType,
      });
    }

    const resolvedOutputPath =
      options.outputPath ??
      (await this.buildTempFilePath(
        options.filename || `${options.datasetId}.${format}`,
        `.${format}`
      ));

    const exportOptions: ExportOptions = {
      datasetId: options.datasetId,
      format,
      outputPath: resolvedOutputPath,
      mode: options.mode ?? 'data',
      includeHeader: options.includeHeader !== false,
      respectHiddenColumns: options.respectHiddenColumns ?? true,
      applyFilters: options.applyFilters ?? true,
      applySort: options.applySort ?? true,
      applySample: options.applySample ?? false,
      selectedRowIds: options.selectedRowIds,
      activeQueryTemplate: options.activeQueryTemplate,
      postExportAction: 'keep',
      encoding: options.encoding,
      delimiter: options.delimiter,
    };

    const shouldCleanup = outputType !== 'file' && !options.outputPath;
    let exportedFiles: string[] = [];

    try {
      const result = await this.duckdb.exportDataset(exportOptions);

      if (!result?.success) {
        throw new DatabaseError(`Failed to export dataset "${options.datasetId}"`, {
          datasetId: options.datasetId,
          format,
          outputPath: resolvedOutputPath,
          operation: 'exportDataset',
          originalError: result?.error,
        });
      }

      const files = result.files || [];
      exportedFiles = files;
      const filePath = files[0] || resolvedOutputPath;
      const filename = options.filename || path.basename(filePath);

      if (outputType === 'file') {
        return {
          outputType,
          filename,
          filePath,
          totalRows: result.totalRows,
          files,
        };
      }

      if (files.length !== 1) {
        throw new DatabaseError(
          'Export produced multiple files; use outputType "file" to retrieve paths',
          {
            datasetId: options.datasetId,
            format,
            files,
          }
        );
      }

      const fileBuffer = await fs.readFile(filePath);
      const response: DataTableExportResult = {
        outputType,
        filename,
        totalRows: result.totalRows,
      };

      if (outputType === 'text') {
        const encoding = options.encoding === 'gbk' ? 'utf8' : options.encoding || 'utf8';
        response.text = fileBuffer.toString(encoding);
      } else {
        response.base64 = fileBuffer.toString('base64');
      }

      if (options.outputPath) {
        response.filePath = filePath;
        response.files = files;
      }

      return response;
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        throw error;
      }

      throw new DatabaseError(
        `Failed to export dataset "${options.datasetId}"`,
        {
          datasetId: options.datasetId,
          format,
          outputType,
          operation: 'exportDataset',
          originalError: error.message,
        },
        error
      );
    } finally {
      if (shouldCleanup) {
        try {
          const cleanupTargets = exportedFiles.length > 0 ? exportedFiles : [resolvedOutputPath];
          for (const target of cleanupTargets) {
            if (await fs.pathExists(target)) {
              await fs.remove(target);
            }
          }
        } catch {
          /* ignore cleanup errors */
        }
      }
    }
  }

  async executeSQL(
    sql: string,
    options?: any[] | { params?: any[]; datasetId?: string }
  ): Promise<any[]> {
    // 参数验证 - 使用统一验证器
    ParamValidator.validateString(sql, 'sql');

    // 兼容旧 API：支持直接传递数组作为 params
    let params: any[] | undefined;
    let datasetId: string | undefined;

    if (Array.isArray(options)) {
      // 旧 API: executeSQL(sql, params)
      params = options;
    } else if (options && typeof options === 'object') {
      // 新 API: executeSQL(sql, { params, datasetId })
      params = options.params;
      datasetId = options.datasetId;
    }

    // 验证 params
    if (params !== undefined) {
      ParamValidator.validateArray(params, 'params', { allowEmpty: true });
    }

    // 验证 datasetId
    if (datasetId !== undefined) {
      ParamValidator.validateString(datasetId, 'datasetId');
    }

    try {
      let finalSql = sql;

      // 如果提供了 datasetId，则限定为只读查询，并通过 attach 保证表可访问
      if (datasetId) {
        if (this.isMutatingSQL(sql)) {
          throw new Error(
            'helpers.database.executeSQL only supports read-only SQL when datasetId is provided. Use insert/update/delete helpers for mutations.'
          );
        }

        finalSql = await this.replaceTableName(sql, datasetId);
        return await this.duckdb.withDatasetAttached(datasetId, async () => {
          return await this.duckdb.executeSQLWithParams(finalSql, params || []);
        });
      }

      return await this.duckdb.executeSQLWithParams(finalSql, params || []);
    } catch (error: any) {
      if (error.message?.includes('read-only SQL')) {
        throw error;
      }

      throw new DatabaseError(
        `Failed to execute SQL`,
        {
          sql,
          params,
          datasetId,
          operation: 'executeSQL',
        },
        error
      );
    }
  }

  private normalizeRowId(rowId: number | string): number {
    const normalized = typeof rowId === 'number' ? rowId : Number(String(rowId).trim());
    if (!Number.isInteger(normalized)) {
      throw new Error(`Invalid rowId: ${rowId}`);
    }
    return normalized;
  }

  private async queryMatchingRowIds(datasetId: string, where: string): Promise<number[]> {
    return await this.duckdb.withDatasetAttached(datasetId, async () => {
      const tableName = await this.getTableName(datasetId);
      const sql = `SELECT _row_id FROM ${tableName} WHERE ${where}`;
      const rows = await this.duckdb.executeSQLWithParams(sql, []);
      return rows.map((row: any) => this.normalizeRowId(row?._row_id));
    });
  }

  private isMutatingSQL(sql: string): boolean {
    const normalized = sql
      .replace(/^(?:\s|--.*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/g, '')
      .toUpperCase();

    return !/^(SELECT|WITH|EXPLAIN|DESCRIBE|SHOW)\b/.test(normalized);
  }

  /**
   * 获取数据集的表名
   *
   * @private
   * @param datasetId - 数据集ID
   * @returns 表名（统一格式：ds_{datasetId}.data）
   */
  private async getTableName(datasetId: string): Promise<string> {
    const datasetInfo = await this.duckdb.getDatasetInfo(datasetId);
    if (!datasetInfo) {
      throw new DatasetNotFoundError(datasetId);
    }

    // ✅ 修复：所有表都使用统一的表名格式
    return `${SQLUtils.escapeIdentifier(`ds_${datasetId}`)}.${SQLUtils.escapeIdentifier('data')}`;
  }

  /**
   * 替换 SQL 中的表名 'data' 为实际的表名
   * @private
   */
  private async replaceTableName(sql: string, datasetId: string): Promise<string> {
    // 获取数据集信息
    const dataset = await this.duckdb.getDatasetInfo(datasetId);
    if (!dataset) {
      throw new DatasetNotFoundError(datasetId);
    }

    // ✅ 修复：所有表都使用统一的表名格式 ds_{datasetId}.data
    const tableName = `${SQLUtils.escapeIdentifier(`ds_${datasetId}`)}.${SQLUtils.escapeIdentifier('data')}`;
    return sql.replace(/\b(FROM|INTO|UPDATE|JOIN)\s+data\b/gi, `$1 ${tableName}`);
  }

  private normalizeBase64(base64: string): string {
    const match = base64.match(/^data:.*;base64,(.*)$/);
    return match ? match[1] : base64;
  }

  private async buildTempFilePath(filename: string, fallbackExtension: string): Promise<string> {
    const tempDir = path.join(os.tmpdir(), 'airpa', 'tmp');
    await fs.ensureDir(tempDir);

    const ext = path.extname(filename);
    const resolvedExt = ext || fallbackExtension || '.tmp';
    const normalizedExt = resolvedExt.startsWith('.') ? resolvedExt : `.${resolvedExt}`;
    const baseName = path.basename(filename, ext) || 'file';
    const safeBaseName = baseName.replace(/[^\w.-]/g, '_') || 'file';
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

    return path.join(tempDir, `${safeBaseName}_${suffix}${normalizedExt}`);
  }
}
