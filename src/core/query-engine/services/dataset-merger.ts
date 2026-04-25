/**
 * 数据集合并服务 (Union/Append)
 * 支持合并多个数据集，自动对齐列结构
 */

import type { DuckDBService } from '../../../main/duckdb/service';
import { SQLUtils } from '../utils/sql-utils';

/**
 * Union 配置
 */
export interface UnionConfig {
  /** 要合并的数据集列表 */
  datasets: Array<{
    datasetId: string;
    alias?: string; // 数据源别名（用于日志）
  }>;

  /** 合并模式 */
  mode: 'union' | 'union_all'; // union: 去重, union_all: 保留重复

  /** 列映射（字段名对齐） */
  columnMapping?: Record<string, Record<string, string>>;
  /**
   * 示例：
   * {
   *   'dataset1': { 'user_name': 'name', 'user_email': 'email' },
   *   'dataset2': { 'customer_name': 'name', 'contact_email': 'email' }
   * }
   */

  /** 缺失字段的默认值 */
  fillDefaults?: Record<string, any>;

  /** 临时视图名称（可选，自动生成） */
  viewName?: string;
}

/**
 * Union 结果
 */
export interface UnionResult {
  success: boolean;
  /** 虚拟数据集ID（可用于 QueryEngine） */
  datasetId?: string;
  /** 合并后的列列表 */
  columns?: string[];
  /** 源数据集数量 */
  sourceCount?: number;
  /** 执行时间（毫秒） */
  executionTime?: number;
  error?: string;
}

/**
 * 数据集合并服务
 *
 * 功能：
 * - 合并多个数据集（纵向拼接）
 * - 自动对齐列结构
 * - 支持列名映射
 * - 支持缺失列填充默认值
 * - 创建临时视图供 QueryEngine 使用
 *
 * @example
 * ```typescript
 * const merger = new DatasetMerger(duckdbService);
 *
 * const result = await merger.mergeDatasets({
 *   datasets: [
 *     { datasetId: 'sales_2023' },
 *     { datasetId: 'sales_2024' }
 *   ],
 *   mode: 'union_all',
 *   columnMapping: {
 *     'sales_2023': { 'amount_usd': 'amount' },
 *     'sales_2024': { 'revenue': 'amount' }
 *   },
 *   fillDefaults: { 'region': 'Unknown' }
 * });
 *
 * // 使用合并后的数据集
 * const queryResult = await queryEngine.execute(result.datasetId!, {
 *   aggregate: {
 *     groupBy: ['region'],
 *     measures: [{ name: 'total', function: 'SUM', field: 'amount' }]
 *   }
 * });
 * ```
 */
export class DatasetMerger {
  constructor(private duckdbService: DuckDBService) {}

  /**
   * 合并多个数据集
   * 返回临时视图ID，可用于 QueryEngine
   */
  async mergeDatasets(config: UnionConfig): Promise<UnionResult> {
    const startTime = Date.now();

    try {
      // 1. 验证配置
      this.validateConfig(config);

      // 2. 获取所有数据集的 schema
      const datasets = await Promise.all(
        config.datasets.map((d) => this.duckdbService.getDatasetInfo(d.datasetId))
      );

      // 验证数据集是否存在
      datasets.forEach((dataset, i) => {
        if (!dataset || !dataset.schema) {
          throw new Error(`Dataset not found or has no schema: ${config.datasets[i].datasetId}`);
        }
      });

      // 3. 分析列结构，找出所有唯一列
      const allColumns = this.extractAllColumns(datasets, config);
      console.log(`[DatasetMerger] Merged columns:`, Array.from(allColumns));

      // 4. 为每个数据集生成 SELECT 语句（字段对齐）
      const selectQueries = config.datasets.map((datasetConfig, index) => {
        return this.buildAlignedSelect(
          datasetConfig.datasetId,
          datasets[index],
          allColumns,
          config.columnMapping?.[datasetConfig.datasetId],
          config.fillDefaults
        );
      });

      // 5. 组合 UNION [ALL]
      const unionOperator = config.mode === 'union' ? 'UNION' : 'UNION ALL';
      const unionSQL = selectQueries.join(`\n${unionOperator}\n`);

      // 6. 创建临时视图
      const viewName =
        config.viewName ?? `union_view_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await this.runExecute(`
        CREATE OR REPLACE TEMPORARY VIEW ${SQLUtils.escapeIdentifier(viewName)} AS
        ${unionSQL}
      `);

      console.log(`[DatasetMerger] Created temporary view: ${viewName}`);

      const executionTime = Date.now() - startTime;

      return {
        success: true,
        datasetId: viewName,
        columns: Array.from(allColumns),
        sourceCount: config.datasets.length,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`[DatasetMerger] Error:`, error);

      return {
        success: false,
        error: (error as Error).message,
        executionTime,
      };
    }
  }

  /**
   * ɾ����ʱ��ͼ
   */
  async dropView(viewName: string): Promise<void> {
    try {
      await this.runExecute(`DROP VIEW IF EXISTS ${SQLUtils.escapeIdentifier(viewName)}`);
      console.log(`[DatasetMerger] Dropped view: ${viewName}`);
    } catch (error) {
      console.error(`[DatasetMerger] Error dropping view:`, error);
      throw error;
    }
  }

  /**
   * 提取所有唯一列名
   */
  private extractAllColumns(datasets: any[], config: UnionConfig): Set<string> {
    const allCols = new Set<string>();

    datasets.forEach((dataset, i) => {
      const datasetId = config.datasets[i].datasetId;
      const mapping = config.columnMapping?.[datasetId];

      dataset.schema.forEach((col: any) => {
        // 应用列映射（如果有）
        const mappedName = mapping?.[col.name] ?? col.name;
        allCols.add(mappedName);
      });
    });

    return allCols;
  }

  /**
   * 构建对齐的 SELECT 语句
   * 确保所有数据集返回相同的列（顺序和名称）
   */
  private buildAlignedSelect(
    datasetId: string,
    dataset: any,
    targetColumns: Set<string>,
    columnMapping?: Record<string, string>,
    fillDefaults?: Record<string, any>
  ): string {
    const selectItems: string[] = [];

    // 为每个目标列生成对应的选择表达式
    targetColumns.forEach((targetCol) => {
      // 找到源列名
      const sourceCol = this.findSourceColumn(targetCol, dataset.schema, columnMapping);

      if (sourceCol) {
        // 列存在，直接选择或重命名
        if (columnMapping && columnMapping[sourceCol] === targetCol) {
          // 需要重命名
          selectItems.push(
            `${SQLUtils.escapeIdentifier(sourceCol)} AS ${SQLUtils.escapeIdentifier(targetCol)}`
          );
        } else {
          // 不需要重命名
          selectItems.push(SQLUtils.escapeIdentifier(targetCol));
        }
      } else {
        // 列不存在，填充默认值
        const defaultValue = fillDefaults?.[targetCol];
        if (defaultValue !== undefined) {
          selectItems.push(
            `${SQLUtils.quoteValue(defaultValue)} AS ${SQLUtils.escapeIdentifier(targetCol)}`
          );
        } else {
          // 没有提供默认值，使用 NULL
          selectItems.push(`NULL AS ${SQLUtils.escapeIdentifier(targetCol)}`);
        }
      }
    });

    const tableName =
      SQLUtils.escapeIdentifier('ds_' + datasetId) + '.' + SQLUtils.escapeIdentifier('data');
    return `SELECT ${selectItems.join(', ')} FROM ${tableName}`;
  }

  /**
   * 查找源列名
   * 考虑列映射关系
   */
  private findSourceColumn(
    targetCol: string,
    schema: any[],
    columnMapping?: Record<string, string>
  ): string | null {
    // 1. 检查是否有反向映射（源列 -> 目标列）
    if (columnMapping) {
      for (const [sourceCol, mappedCol] of Object.entries(columnMapping)) {
        if (mappedCol === targetCol) {
          // 找到了映射关系，返回源列名
          return sourceCol;
        }
      }
    }

    // 2. 检查是否直接存在（目标列名 = 源列名）
    const found = schema.find((col) => col.name === targetCol);
    return found ? targetCol : null;
  }

  /**
   * 验证配置
   */
  private validateConfig(config: UnionConfig): void {
    if (!config.datasets || config.datasets.length === 0) {
      throw new Error('Union requires at least one dataset');
    }

    if (!config.mode || (config.mode !== 'union' && config.mode !== 'union_all')) {
      throw new Error('Invalid union mode');
    }

    // 警告：只有一个数据集
    if (config.datasets.length === 1) {
      console.warn('[DatasetMerger] Only one dataset provided, union operation is unnecessary');
    }

    // 验证每个数据集的 ID
    config.datasets.forEach((dataset) => {
      if (!dataset.datasetId) {
        throw new Error('datasetId is required');
      }
    });

    // 验证列映射引用的数据集是否存在
    if (config.columnMapping) {
      Object.keys(config.columnMapping).forEach((datasetId) => {
        const datasetExists = config.datasets.some((d) => d.datasetId === datasetId);
        if (!datasetExists) {
          console.warn(`[DatasetMerger] Column mapping for unknown dataset: ${datasetId}`);
        }
      });
    }
  }

  /**
   * run SQL using available execute method
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
}
