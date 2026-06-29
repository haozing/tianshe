/**
 * 排序构建器
 * 负责多列排序、TopK、分页
 */

import type { SortConfig, SQLContext } from '../types';
import { SQLUtils } from '../utils/sql-utils';
import { QueryErrorFactory } from '../errors';

export class SortBuilder {
  /**
   * 构建排序SQL（只添加 ORDER BY 子句，不包含 SELECT）
   */
  buildOrderBy(config?: SortConfig): string {
    if (!config || !config.columns || config.columns.length === 0) {
      return '';
    }

    const orderByClauses = config.columns.map((col) => {
      const field = SQLUtils.escapeIdentifier(col.field);
      const direction = col.direction || 'ASC';
      const nullsPos = col.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';

      return `${field} ${direction} ${nullsPos}`;
    });

    return `ORDER BY ${orderByClauses.join(', ')}`;
  }

  /**
   * 构建 LIMIT 子句（带边界检查）
   */
  buildLimit(config?: SortConfig): string {
    if (!config) {
      return '';
    }

    // TopK 优先级高于分页
    if (config.topK !== undefined) {
      // ✅ 边界检查：topK必须为正数
      if (config.topK <= 0) {
        throw QueryErrorFactory.invalidParam('topK', config.topK, 'must be positive');
      }

      // ✅ 边界检查：topK不能超过100000（防止内存溢出）
      const MAX_TOPK = 100000;
      if (config.topK > MAX_TOPK) {
        throw QueryErrorFactory.limitExceeded('topK', config.topK, MAX_TOPK);
      }

      return `LIMIT ${config.topK}`;
    }

    // 分页
    if (config.pagination) {
      const { page, pageSize } = config.pagination;

      // ✅ 边界检查：page必须>=1
      if (page < 1) {
        throw QueryErrorFactory.invalidParam('page', page, 'must be >= 1');
      }

      // ✅ 边界检查：page不能太大（防止巨大offset）
      const MAX_PAGE = 10000;
      if (page > MAX_PAGE) {
        throw QueryErrorFactory.limitExceeded('page', page, MAX_PAGE);
      }

      // pageSize在ConfigValidator中已经检查了（1-10000），这里不需要重复检查

      const offset = (page - 1) * pageSize;
      return `LIMIT ${pageSize} OFFSET ${offset}`;
    }

    return '';
  }

  /**
   * 构建完整的排序和限制SQL
   */
  build(context: SQLContext, config?: SortConfig): string {
    const orderBy = this.buildOrderBy(config);
    const limit = this.buildLimit(config);

    const clauses = [`SELECT * FROM ${context.currentTable}`, orderBy, limit].filter(Boolean);

    return clauses.join('\n');
  }
}
