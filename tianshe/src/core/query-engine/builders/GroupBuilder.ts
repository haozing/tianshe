/**
 * 单层分组 Builder
 * 使用 DuckDB 窗口函数实现高性能分组
 */

import { SyncQueryBuilder } from '../interfaces/IQueryBuilder';
import type { SQLContext, GroupConfig } from '../types';
import { SQLUtils } from '../utils/sql-utils';
import { QueryErrorFactory } from '../errors';

export class GroupBuilder extends SyncQueryBuilder<GroupConfig> {
  /**
   * 构建分组 SQL（使用窗口函数）
   */
  protected buildSync(context: SQLContext, config: GroupConfig): string {
    const { field, order, showStats, statsFields } = config;

    // 1. 验证字段存在
    if (!context.availableColumns.has(field)) {
      throw QueryErrorFactory.fieldNotFound(field, Array.from(context.availableColumns));
    }

    // 2. 构建 SELECT 子句
    const selectItems: string[] = ['*']; // 保留所有原始列

    // 3. 添加窗口函数统计（如果需要）
    if (showStats !== false) {
      const groupField = SQLUtils.escapeIdentifier(field);

      // 3.1 基础统计：行号和计数
      selectItems.push(
        `ROW_NUMBER() OVER (PARTITION BY ${groupField} ORDER BY rowid) AS __group_row_num`,
        `COUNT(*) OVER (PARTITION BY ${groupField}) AS __group_count`
      );

      // 3.2 数值字段统计（求和、平均值）
      if (statsFields && statsFields.length > 0) {
        statsFields.forEach((statField) => {
          if (context.availableColumns.has(statField)) {
            const escapedStatField = SQLUtils.escapeIdentifier(statField);
            selectItems.push(
              `SUM(${escapedStatField}) OVER (PARTITION BY ${groupField}) AS __group_sum_${statField}`,
              `AVG(${escapedStatField}) OVER (PARTITION BY ${groupField}) AS __group_avg_${statField}`
            );
          }
        });
      }
    }

    // 4. 构建 ORDER BY（按分组字段排序）
    const orderDirection = order === 'desc' ? 'DESC' : 'ASC';
    const orderByClause = `ORDER BY ${SQLUtils.escapeIdentifier(field)} ${orderDirection}`;

    // 5. 组装 SQL
    return SQLUtils.combineClauses([
      `SELECT ${selectItems.join(', ')}`,
      `FROM ${context.currentTable}`,
      orderByClause,
    ]);
  }

  /**
   * 获取结果列
   * 分组会添加额外的统计列
   */
  protected getResultColumnsSync(context: SQLContext, config: GroupConfig): Set<string> {
    const resultColumns = new Set(context.availableColumns);

    // 添加窗口函数生成的列
    if (config.showStats !== false) {
      resultColumns.add('__group_row_num');
      resultColumns.add('__group_count');

      if (config.statsFields && config.statsFields.length > 0) {
        config.statsFields.forEach((field) => {
          resultColumns.add(`__group_sum_${field}`);
          resultColumns.add(`__group_avg_${field}`);
        });
      }
    }

    return resultColumns;
  }
}
