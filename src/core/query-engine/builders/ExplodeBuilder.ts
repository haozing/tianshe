/**
 * 拆列/展开 Builder
 * 支持拆列（一列拆多列）和展开（一行变多行）
 */

import { SyncQueryBuilder } from '../interfaces/IQueryBuilder';
import type { SQLContext, ExplodeConfig } from '../types';
import { SQLUtils } from '../utils/sql-utils';

export class ExplodeBuilder extends SyncQueryBuilder<ExplodeConfig[]> {
  /**
   * 构建拆列/展开 SQL
   */
  protected buildSync(context: SQLContext, config: ExplodeConfig[]): string {
    if (!config || config.length === 0) {
      return `SELECT * FROM ${context.currentTable}`;
    }

    // 验证配置
    this.validateConfig(config);

    // 检查是否有展开操作（unnest）
    const unnestConfigs = config.filter(
      (c) => c.type === 'unnest_array' || c.type === 'unnest_json'
    );

    // 如果有展开操作，只能有一个（DuckDB 限制）
    if (unnestConfigs.length > 1) {
      throw new Error('Only one unnest operation is allowed per query');
    }

    // 如果有展开操作，生成展开 SQL
    if (unnestConfigs.length === 1) {
      return this.buildUnnest(context, unnestConfigs[0]);
    }

    // 否则，只有拆列操作
    return this.buildSplitColumns(context, config);
  }

  /**
   * 构建拆列 SQL（一列拆多列）
   */
  private buildSplitColumns(context: SQLContext, configs: ExplodeConfig[]): string {
    const baseColumns = Array.from(context.availableColumns)
      .map((c) => SQLUtils.escapeIdentifier(c))
      .join(', ');

    const additionalColumns: string[] = [];

    for (const config of configs) {
      if (config.type !== 'split_columns') {
        continue;
      }

      const { field, params } = config;
      const delimiter = params?.delimiter ?? ',';
      const columnNames = params?.columnNames ?? [];
      const maxSplits = params?.maxSplits ?? columnNames.length;

      // 为每个新列生成 split_part() 表达式
      for (let i = 0; i < Math.min(maxSplits, columnNames.length); i++) {
        const colName = columnNames[i];
        const expression = `split_part(${SQLUtils.escapeIdentifier(field)}, '${delimiter}', ${i + 1}) AS ${SQLUtils.escapeIdentifier(colName)}`;
        additionalColumns.push(expression);
      }
    }

    if (additionalColumns.length === 0) {
      return `SELECT * FROM ${context.currentTable}`;
    }

    return `SELECT ${baseColumns}, ${additionalColumns.join(', ')} FROM ${context.currentTable}`;
  }

  /**
   * 构建展开 SQL（一行变多行）
   */
  private buildUnnest(context: SQLContext, config: ExplodeConfig): string {
    const { field, type, params } = config;

    // 获取基础列（排除被展开的字段）
    const baseColumns = Array.from(context.availableColumns)
      .filter((c) => c !== field)
      .map((c) => SQLUtils.escapeIdentifier(c))
      .join(', ');

    const outputCol = params?.outputColumn ?? `${field}_item`;
    const outputColEscaped = SQLUtils.escapeIdentifier(outputCol);

    if (type === 'unnest_array') {
      const delimiter = params?.delimiter ?? ',';
      return `
        SELECT ${baseColumns}, unnest(string_split(${SQLUtils.escapeIdentifier(field)}, '${delimiter}')) AS ${outputColEscaped}
        FROM ${context.currentTable}
      `.trim();
    }

    if (type === 'unnest_json') {
      const jsonPath = params?.jsonPath ?? '$[*]';
      return `
        SELECT ${baseColumns}, unnest(json_extract(${SQLUtils.escapeIdentifier(field)}, '${jsonPath}')) AS ${outputColEscaped}
        FROM ${context.currentTable}
      `.trim();
    }

    throw new Error(`Unsupported explode type: ${type}`);
  }

  /**
   * 获取结果列集合
   */
  protected getResultColumnsSync(context: SQLContext, config: ExplodeConfig[]): Set<string> {
    const resultCols = new Set(context.availableColumns);

    for (const explodeConfig of config) {
      const { field, type, params } = explodeConfig;

      if (type === 'split_columns') {
        // 添加拆分后的新列
        params?.columnNames?.forEach((col) => resultCols.add(col));
      } else if (type === 'unnest_array' || type === 'unnest_json') {
        // 移除原字段，添加展开字段
        resultCols.delete(field);
        const outputCol = params?.outputColumn ?? `${field}_item`;
        resultCols.add(outputCol);
      }
    }

    return resultCols;
  }

  /**
   * 验证配置
   */
  private validateConfig(configs: ExplodeConfig[]): void {
    // 1. 检查是否有多个 unnest 操作
    const unnestCount = configs.filter(
      (c) => c.type === 'unnest_array' || c.type === 'unnest_json'
    ).length;

    if (unnestCount > 1) {
      throw new Error('Only one unnest operation is allowed per query');
    }

    // 2. 验证每个配置
    for (const config of configs) {
      if (!config.field) {
        throw new Error('Explode requires a field');
      }

      if (config.type === 'split_columns') {
        if (!config.params?.columnNames || config.params.columnNames.length === 0) {
          throw new Error(
            `Explode field '${config.field}' with type 'split_columns' requires columnNames`
          );
        }
      }

      if (config.type === 'unnest_array' || config.type === 'unnest_json') {
        if (!config.params?.outputColumn) {
          throw new Error(
            `Explode field '${config.field}' with type '${config.type}' requires outputColumn`
          );
        }
      }
    }
  }
}
