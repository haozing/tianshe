/**
 * 筛选条件构建器
 * 负责将 FilterConfig 转换为 SQL WHERE 子句
 */

import type { FilterConfig, FilterCondition, SQLContext } from '../types';
import { SQLUtils } from '../utils/sql-utils';
import { QueryErrorFactory } from '../errors';

export class FilterBuilder {
  /**
   * 构建纯条件表达式（用于 WHERE 或 HAVING 子句）
   * 不包含 SELECT 语句，只返回条件表达式
   *
   * @param config 筛选配置
   * @returns 条件表达式字符串，如果没有条件则返回空字符串
   *
   * @example
   * buildConditionsOnly({ conditions: [{ type: 'equal', field: 'status', value: 'active' }] })
   * // 返回: "status = 'active'"
   *
   * buildConditionsOnly({
   *   conditions: [
   *     { type: 'greater_than', field: 'count', value: 10 },
   *     { type: 'equal', field: 'status', value: 'active' }
   *   ],
   *   combinator: 'AND'
   * })
   * // 返回: "count > 10 AND status = 'active'"
   */
  buildConditionsOnly(config: FilterConfig): string {
    if (!config.conditions || config.conditions.length === 0) {
      return '';
    }

    // 构建所有条件表达式
    const whereClauses = config.conditions
      .map((condition) => this.buildCondition(condition))
      .filter((clause) => clause.length > 0);

    if (whereClauses.length === 0) {
      return '';
    }

    const combinator = config.combinator || 'AND';
    return whereClauses.join(` ${combinator} `);
  }

  /**
   * 构建筛选SQL（完整的 SELECT 语句）
   */
  build(context: SQLContext, config: FilterConfig): string {
    if (!config.conditions || config.conditions.length === 0) {
      return `SELECT * FROM ${context.currentTable}`;
    }

    // 构建 WHERE 子句
    const whereClauses = config.conditions
      .map((condition) => this.buildCondition(condition))
      .filter((clause) => clause.length > 0);

    if (whereClauses.length === 0) {
      return `SELECT * FROM ${context.currentTable}`;
    }

    const combinator = config.combinator || 'AND';
    const whereClause = whereClauses.join(` ${combinator} `);

    return `SELECT * FROM ${context.currentTable} WHERE ${whereClause}`;
  }

  /**
   * 构建单个条件
   */
  private buildCondition(condition: FilterCondition): string {
    const field = SQLUtils.escapeIdentifier(condition.field);

    switch (condition.type) {
      case 'equal':
        return `${field} = ${SQLUtils.quoteValue(condition.value)}`;

      case 'not_equal':
        return `${field} != ${SQLUtils.quoteValue(condition.value)}`;

      case 'greater_than':
        return `${field} > ${SQLUtils.quoteValue(condition.value)}`;

      case 'less_than':
        return `${field} < ${SQLUtils.quoteValue(condition.value)}`;

      case 'greater_equal':
        return `${field} >= ${SQLUtils.quoteValue(condition.value)}`;

      case 'less_equal':
        return `${field} <= ${SQLUtils.quoteValue(condition.value)}`;

      case 'between':
        if (!condition.values || condition.values.length !== 2) {
          throw QueryErrorFactory.invalidParam(
            'values',
            condition.values,
            'BETWEEN requires exactly 2 values'
          );
        }
        return SQLUtils.buildBetweenClause(
          condition.field,
          condition.values[0],
          condition.values[1]
        );

      case 'contains': {
        const containsPattern = `%${condition.value}%`;
        return SQLUtils.buildLikeClause(
          condition.field,
          containsPattern,
          condition.options?.caseSensitive || false
        );
      }

      case 'not_contains': {
        const notContainsPattern = `%${condition.value}%`;
        return SQLUtils.buildNotLikeClause(
          condition.field,
          notContainsPattern,
          condition.options?.caseSensitive || false
        );
      }

      case 'starts_with': {
        const startsPattern = `${condition.value}%`;
        return SQLUtils.buildLikeClause(
          condition.field,
          startsPattern,
          condition.options?.caseSensitive || false
        );
      }

      case 'ends_with': {
        const endsPattern = `%${condition.value}`;
        return SQLUtils.buildLikeClause(
          condition.field,
          endsPattern,
          condition.options?.caseSensitive || false
        );
      }

      case 'regex':
        return this.buildRegexCondition(field, condition);

      case 'in':
        if (!condition.values || condition.values.length === 0) {
          throw QueryErrorFactory.invalidParam(
            'values',
            condition.values,
            'IN requires at least one value'
          );
        }
        return SQLUtils.buildInClause(condition.field, condition.values);

      case 'not_in': {
        if (!condition.values || condition.values.length === 0) {
          throw QueryErrorFactory.invalidParam(
            'values',
            condition.values,
            'NOT IN requires at least one value'
          );
        }
        return SQLUtils.buildNotInClause(condition.field, condition.values);
      }

      case 'null':
        return `${field} IS NULL`;

      case 'not_null':
        return `${field} IS NOT NULL`;

      case 'relative_time':
        return this.buildRelativeTimeCondition(field, condition);

      case 'soft_delete':
        return this.buildSoftDeleteCondition(field, condition);

      default:
        throw QueryErrorFactory.unsupportedOperation((condition as any).type, 'filter');
    }
  }

  /**
   * 构建正则条件（带安全验证和长度限制）
   */
  private buildRegexCondition(field: string, condition: FilterCondition): string {
    // 🆕 验证正则表达式安全性（防止 ReDoS 攻击）
    try {
      SQLUtils.validateRegexPattern(condition.value);
    } catch (error: any) {
      throw QueryErrorFactory.invalidParam(
        'regex pattern',
        condition.value,
        `不安全的正则表达式: ${error.message}`
      );
    }

    const pattern = SQLUtils.quoteValue(condition.value);
    const maxLength = condition.options?.regexMaxLength || 1000;

    // DuckDB 的 regexp_matches 函数
    // 添加长度限制以防止性能问题
    return `
      CASE
        WHEN LENGTH(${field}) > ${maxLength} THEN FALSE
        ELSE regexp_matches(${field}, ${pattern})
      END
    `.trim();

    // 注意：DuckDB 当前版本不直接支持正则超时
    // 我们通过：
    // 1. 正则复杂度验证（validateRegexPattern）
    // 2. 输入长度限制（maxLength）
    // 来防止性能问题
  }

  /**
   * 构建相对时间条件
   */
  private buildRelativeTimeCondition(field: string, condition: FilterCondition): string {
    const unit = condition.options?.relativeTimeUnit || 'day';
    const value = condition.options?.relativeTimeValue || 0;
    const direction = condition.options?.relativeTimeDirection || 'past';

    // 构建 INTERVAL 表达式
    const interval = `INTERVAL '${Math.abs(value)} ${unit}'`;

    if (direction === 'past') {
      // 过去N天/月/年
      return `${field} >= CURRENT_TIMESTAMP - ${interval}`;
    } else {
      // 未来N天/月/年
      return `${field} <= CURRENT_TIMESTAMP + ${interval}`;
    }
  }

  /**
   * 构建软删除条件
   * 支持 'active'（未删除）、'deleted'（已删除）、'all'（全部）三种状态
   */
  private buildSoftDeleteCondition(field: string, condition: FilterCondition): string {
    const states = condition.options?.softDeleteStates || ['active'];
    const state = states[0];

    switch (state) {
      case 'active':
        // 未删除的记录：deleted_at 为 NULL 或为 0（假值）
        return `(${field} IS NULL OR ${field} = 0)`;

      case 'deleted':
        // 已删除的记录：deleted_at 为 1 或 TRUE（真值）
        return `(${field} = 1 OR ${field} = TRUE)`;

      case 'all':
        // 所有记录
        return 'TRUE';

      default:
        return `(${field} IS NULL OR ${field} = 0)`;
    }
  }
}
