/**
 * 去重构建器（增强版）
 * 负责 ROW_NUMBER 去重（删除重复记录）
 * ✨ 新增：支持独立排序方向、确定性排序
 */

import type { DedupeConfig, SQLContext } from '../types';
import { SQLUtils } from '../utils/sql-utils';

export class DedupeBuilder {
  /**
   * 构建去重SQL
   */
  build(context: SQLContext, config: DedupeConfig): string {
    const type = (config as any).type;
    if (type !== 'row_number') {
      throw new Error(`Unsupported dedupe type: ${type}`);
    }

    return this.buildRowNumberDedupe(context, config);
  }

  /**
   * 使用 ROW_NUMBER 进行去重
   * 只保留每组的第一条或最后一条记录
   * ✨ 改进：支持独立排序方向和确定性排序
   */
  private buildRowNumberDedupe(context: SQLContext, config: DedupeConfig): string {
    const partitionByFields = config.partitionBy
      .map((f) => SQLUtils.escapeIdentifier(f))
      .join(', ');

    // ✨ 构建排序子句（支持新旧两种格式）
    const orderByClause = this.buildOrderByClause(context, config);

    // ✅ 显式列出列名，排除 _rn 技术列
    const columns = Array.from(context.availableColumns)
      .map((col) => SQLUtils.escapeIdentifier(col))
      .join(', ');

    // ✨ 使用 QUALIFY 优化（DuckDB 支持）
    // 这比子查询更高效
    return `
      SELECT ${columns} FROM (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY ${partitionByFields} ${orderByClause}) AS _rn
        FROM ${context.currentTable}
      ) AS _deduped
      WHERE _rn = 1
    `.trim();
  }

  /**
   * 构建排序子句
   * 使用共享的 SQLUtils.buildDedupeOrderByClause 确保预览和执行逻辑一致
   */
  private buildOrderByClause(_context: SQLContext, config: DedupeConfig): string {
    // 如果既没有业务排序，也没有 tieBreaker，打印警告
    if ((!config.orderBy || config.orderBy.length === 0) && !config.tieBreaker) {
      console.warn(
        '[DedupeBuilder] No orderBy specified. Deduplication results may be non-deterministic.'
      );
    }

    return SQLUtils.buildDedupeOrderByClause({
      orderBy: config.orderBy,
      tieBreaker: config.tieBreaker,
      keepStrategy: config.keepStrategy,
    });
  }

  /**
   * 获取去重后的列名列表（用于更新 context）
   */
  getResultColumns(context: SQLContext, config: DedupeConfig): Set<string> {
    void config;
    return new Set(context.availableColumns);
  }
}
