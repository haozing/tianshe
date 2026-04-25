/**
 * 透视服务 (Pivot/Unpivot)
 * 支持行转列、列转行操作
 */

import type { DuckDBService } from '../../../main/duckdb/service';
import { SQLUtils } from '../utils/sql-utils';
import { validateColumnsExist } from '../validators/common-validators';

/**
 * Pivot 配置
 */
export interface PivotConfig {
  /** 索引列（作为行标识） */
  indexColumns: string[];

  /** 透视列（将其值作为新列名） */
  pivotColumn: string;

  /** 值列（要聚合的值） */
  valueColumns: string[];

  /** 聚合函数 */
  aggregateFunction?: 'SUM' | 'AVG' | 'MAX' | 'MIN' | 'COUNT' | 'FIRST';

  /** 临时视图名称（可选，自动生成） */
  viewName?: string;
}

/**
 * Unpivot 配置
 */
export interface UnpivotConfig {
  /** 保留的列（不参与 unpivot） */
  keepColumns: string[];

  /** 要 unpivot 的列 */
  unpivotColumns: string[];

  /** 新的列名列（存储原列名） */
  variableColumnName?: string;

  /** 新的值列（存储原值） */
  valueColumnName?: string;

  /** 临时视图名称（可选，自动生成） */
  viewName?: string;
}

/**
 * Pivot 结果
 */
export interface PivotResult {
  success: boolean;
  /** 虚拟数据集ID（可用于 QueryEngine） */
  datasetId?: string;
  /** 透视后的列列表 */
  columns?: string[];
  /** 执行时间（毫秒） */
  executionTime?: number;
  error?: string;
}

/**
 * Unpivot 结果
 */
export interface UnpivotResult {
  success: boolean;
  /** 虚拟数据集ID（可用于 QueryEngine） */
  datasetId?: string;
  /** Unpivot 后的列列表 */
  columns?: string[];
  /** 执行时间（毫秒） */
  executionTime?: number;
  error?: string;
}

/**
 * 透视服务
 *
 * 功能：
 * - Pivot: 行转列（将行数据转换为列）
 * - Unpivot: 列转行（将多列数据转换为行）
 * - 支持动态列生成
 * - 创建临时视图供 QueryEngine 使用
 *
 * @example
 * ```typescript
 * const pivotService = new PivotService(duckdbService);
 *
 * // Pivot: 将产品销售数据按月份展开
 * const pivotResult = await pivotService.pivot('sales_data', {
 *   indexColumns: ['product_id', 'product_name'],
 *   pivotColumn: 'month',
 *   valueColumns: ['revenue'],
 *   aggregateFunction: 'SUM'
 * });
 *
 * // Unpivot: 将宽表转换为长表
 * const unpivotResult = await pivotService.unpivot('quarterly_sales', {
 *   keepColumns: ['product_id'],
 *   unpivotColumns: ['Q1_sales', 'Q2_sales', 'Q3_sales', 'Q4_sales'],
 *   variableColumnName: 'quarter',
 *   valueColumnName: 'sales'
 * });
 * ```
 */
export class PivotService {
  constructor(private duckdbService: DuckDBService) {}

  /**
   * 执行 Pivot 操作（行转列）
   */
  async pivot(datasetId: string, config: PivotConfig): Promise<PivotResult> {
    const startTime = Date.now();

    try {
      // 1. 验证配置
      this.validatePivotConfig(config);

      // 2. 验证数据集存在
      const dataset = await this.duckdbService.getDatasetInfo(datasetId);
      if (!dataset || !dataset.schema) {
        throw new Error(`Dataset not found or has no schema: ${datasetId}`);
      }

      // 3. 验证列存在性
      this.validateSchemaColumns(dataset.schema, [
        ...config.indexColumns,
        config.pivotColumn,
        ...config.valueColumns,
      ]);

      // 4. 获取透视列的所有唯一值（用于生成列名）
      const pivotValues = await this.getPivotValues(datasetId, config.pivotColumn);
      console.log(`[PivotService] Found ${pivotValues.length} unique pivot values`);

      // 5. 构建 PIVOT SQL
      const pivotSQL = this.buildPivotSQL(datasetId, config, pivotValues);

      // 6. 创建临时视图
      const viewName =
        config.viewName ?? `pivot_view_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await this.runExecute(`
        CREATE OR REPLACE TEMPORARY VIEW ${SQLUtils.escapeIdentifier(viewName)} AS
        ${pivotSQL}
      `);

      console.log(`[PivotService] Created temporary view: ${viewName}`);

      // 7. 获取结果列列表
      const resultColumns = this.getPivotResultColumns(config, pivotValues);

      const executionTime = Date.now() - startTime;

      return {
        success: true,
        datasetId: viewName,
        columns: resultColumns,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`[PivotService] Pivot error:`, error);

      return {
        success: false,
        error: (error as Error).message,
        executionTime,
      };
    }
  }

  /**
   * 执行 Unpivot 操作（列转行）
   */
  async unpivot(datasetId: string, config: UnpivotConfig): Promise<UnpivotResult> {
    const startTime = Date.now();

    try {
      // 1. 验证配置
      this.validateUnpivotConfig(config);

      // 2. 验证数据集存在
      const dataset = await this.duckdbService.getDatasetInfo(datasetId);
      if (!dataset || !dataset.schema) {
        throw new Error(`Dataset not found or has no schema: ${datasetId}`);
      }

      // 3. 验证列存在性
      this.validateSchemaColumns(dataset.schema, [...config.keepColumns, ...config.unpivotColumns]);

      // 4. 构建 UNPIVOT SQL
      const unpivotSQL = this.buildUnpivotSQL(datasetId, config);

      // 5. 创建临时视图
      const viewName =
        config.viewName ?? `unpivot_view_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await this.runExecute(`
        CREATE OR REPLACE TEMPORARY VIEW ${SQLUtils.escapeIdentifier(viewName)} AS
        ${unpivotSQL}
      `);

      console.log(`[PivotService] Created temporary view: ${viewName}`);

      // 6. 获取结果列列表
      const resultColumns = this.getUnpivotResultColumns(config);

      const executionTime = Date.now() - startTime;

      return {
        success: true,
        datasetId: viewName,
        columns: resultColumns,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`[PivotService] Unpivot error:`, error);

      return {
        success: false,
        error: (error as Error).message,
        executionTime,
      };
    }
  }

  /**
   * 删除临时视图
   */
  async dropView(viewName: string): Promise<void> {
    try {
      await this.runExecute(`DROP VIEW IF EXISTS ${SQLUtils.escapeIdentifier(viewName)}`);
      console.log(`[PivotService] Dropped view: ${viewName}`);
    } catch (error) {
      console.error(`[PivotService] Error dropping view:`, error);
      throw error;
    }
  }

  /**
   * 获取透视列的所有唯一值
   */
  private async getPivotValues(datasetId: string, pivotColumn: string): Promise<string[]> {
    const tableName =
      SQLUtils.escapeIdentifier('ds_' + datasetId) + '.' + SQLUtils.escapeIdentifier('data');
    const sql = `
      SELECT DISTINCT ${SQLUtils.escapeIdentifier(pivotColumn)}
      FROM ${tableName}
      WHERE ${SQLUtils.escapeIdentifier(pivotColumn)} IS NOT NULL
      ORDER BY ${SQLUtils.escapeIdentifier(pivotColumn)}
    `;

    const result = await this.runQuery(sql);
    return result.map((row: any) => String(row[pivotColumn]));
  }

  /**
   * 构建 PIVOT SQL
   */
  private buildPivotSQL(datasetId: string, config: PivotConfig, pivotValues: string[]): string {
    const { indexColumns, pivotColumn, valueColumns, aggregateFunction = 'FIRST' } = config;

    const indexCols = indexColumns.map((c) => SQLUtils.escapeIdentifier(c)).join(', ');
    const selectItems: string[] = [];
    const tableName =
      SQLUtils.escapeIdentifier('ds_' + datasetId) + '.' + SQLUtils.escapeIdentifier('data');

    // 1. 添加索引列
    indexColumns.forEach((col) => {
      selectItems.push(SQLUtils.escapeIdentifier(col));
    });

    // 2. 为每个值列 × 每个透视值生成聚合列
    valueColumns.forEach((valueCol) => {
      pivotValues.forEach((pivotVal) => {
        // 列名：valueCol_pivotVal
        const newColName = `${valueCol}_${this.sanitizeColumnName(pivotVal)}`;

        // 聚合表达式：AGG_FUNC(CASE WHEN pivot_col = pivotVal THEN value_col END)
        const caseExpr = `
          ${aggregateFunction}(
            CASE WHEN ${SQLUtils.escapeIdentifier(pivotColumn)} = ${SQLUtils.quoteValue(pivotVal)}
                 THEN ${SQLUtils.escapeIdentifier(valueCol)}
            END
          ) AS ${SQLUtils.escapeIdentifier(newColName)}
        `.trim();

        selectItems.push(caseExpr);
      });
    });

    return `
      SELECT ${selectItems.join(',\n       ')}
      FROM ${tableName}
      GROUP BY ${indexCols}
    `.trim();
  }

  /**
   * 构建 UNPIVOT SQL
   */
  private buildUnpivotSQL(datasetId: string, config: UnpivotConfig): string {
    const {
      keepColumns,
      unpivotColumns,
      variableColumnName = 'variable',
      valueColumnName = 'value',
    } = config;

    const _keepCols = keepColumns.map((c) => SQLUtils.escapeIdentifier(c)).join(', ');

    // 使用 UNION ALL 实现 UNPIVOT
    const unionParts = unpivotColumns.map((col) => {
      const selectItems: string[] = [];

      // 保留列
      keepColumns.forEach((keepCol) => {
        selectItems.push(SQLUtils.escapeIdentifier(keepCol));
      });

      // 变量列（列名）
      selectItems.push(
        `${SQLUtils.quoteValue(col)} AS ${SQLUtils.escapeIdentifier(variableColumnName)}`
      );

      // 值列（列值）
      selectItems.push(
        `${SQLUtils.escapeIdentifier(col)} AS ${SQLUtils.escapeIdentifier(valueColumnName)}`
      );

      return `SELECT ${selectItems.join(', ')} FROM ${SQLUtils.escapeIdentifier('ds_' + datasetId)}.${SQLUtils.escapeIdentifier('data')}`;
    });

    return unionParts.join('\nUNION ALL\n');
  }

  /**
   * 获取 Pivot 结果列列表
   */
  private getPivotResultColumns(config: PivotConfig, pivotValues: string[]): string[] {
    const columns: string[] = [...config.indexColumns];

    config.valueColumns.forEach((valueCol) => {
      pivotValues.forEach((pivotVal) => {
        columns.push(`${valueCol}_${this.sanitizeColumnName(pivotVal)}`);
      });
    });

    return columns;
  }

  /**
   * 获取 Unpivot 结果列列表
   */
  private getUnpivotResultColumns(config: UnpivotConfig): string[] {
    const variableColName = config.variableColumnName ?? 'variable';
    const valueColName = config.valueColumnName ?? 'value';

    return [...config.keepColumns, variableColName, valueColName];
  }

  /**
   * 验证 Pivot 配置
   */
  private validatePivotConfig(config: PivotConfig): void {
    if (!config.indexColumns || config.indexColumns.length === 0) {
      throw new Error('Pivot requires at least one index column');
    }
    if (!config.pivotColumn) {
      throw new Error('Pivot requires pivot column');
    }
    if (!config.valueColumns || config.valueColumns.length === 0) {
      throw new Error('Pivot requires at least one value column');
    }

    const allColumns = [...config.indexColumns, config.pivotColumn, ...config.valueColumns].filter(
      Boolean
    );
    const duplicates = this.findDuplicates(allColumns);
    if (duplicates.length > 0) {
      throw new Error('Pivot columns must be unique');
    }
  }

  /**
   * 验证 Unpivot 配置
   */
  private validateUnpivotConfig(config: UnpivotConfig): void {
    if (!config.keepColumns || config.keepColumns.length === 0) {
      throw new Error('Unpivot requires at least one keep column');
    }
    if (!config.unpivotColumns || config.unpivotColumns.length === 0) {
      throw new Error('Unpivot requires at least one unpivot column');
    }

    const allColumns = [...config.keepColumns, ...config.unpivotColumns];
    const duplicates = this.findDuplicates(allColumns);
    if (duplicates.length > 0) {
      throw new Error('Unpivot columns must be unique');
    }
  }

  /**
   * 验证列是否存在于 schema 中
   */
  private validateSchemaColumns(schema: any[], columns: string[]): void {
    const errors = validateColumnsExist(schema, columns, 'Pivot');
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
  }

  /**
   * 清理列名（移除特殊字符，用于生成新列名）
   */
  private sanitizeColumnName(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9_]/g, '_') // 替换特殊字符为下划线
      .replace(/^_+|_+$/g, '') // 移除首尾下划线
      .replace(/_+/g, '_') // 合并连续下划线
      .toLowerCase();
  }

  /**
   * ִ�� SQL ������������ executeWithParams ִֻ�� execute
   */
  private async runExecute(sql: string): Promise<void> {
    const executor =
      (this.duckdbService as any).execute ?? (this.duckdbService as any).executeWithParams;

    if (!executor) {
      throw new Error('DuckDBService execute method is not available');
    }

    if (executor.length >= 2) {
      await executor.call(this.duckdbService, sql, []);
    } else {
      await executor.call(this.duckdbService, sql);
    }
  }

  /**
   * ִ�� SQL ��ѯ�������� executeSQLWithParams ִֻ�� query
   */
  private async runQuery(sql: string): Promise<any[]> {
    const queryFn =
      (this.duckdbService as any).query ?? (this.duckdbService as any).executeSQLWithParams;

    if (!queryFn) {
      throw new Error('DuckDBService query method is not available');
    }

    if (queryFn.length >= 2) {
      return await queryFn.call(this.duckdbService, sql, []);
    }
    return await queryFn.call(this.duckdbService, sql);
  }

  /**
   * �ҵ��ظ�����
   */
  private findDuplicates(columns: string[]): string[] {
    return columns.filter((col, idx) => columns.indexOf(col) !== idx);
  }
}
