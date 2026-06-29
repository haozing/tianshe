/**
 * 验证构建器
 * 负责数据验证：数值/日期校验、正则校验、枚举校验、跨字段比较等
 */

import type { ValidationConfig, ValidationFieldConfig, ValidationRule, SQLContext } from '../types';
import { SQLUtils } from '../utils/sql-utils';
import { QueryErrorFactory } from '../errors';

export class ValidationBuilder {
  /**
   * 构建验证SQL
   */
  build(context: SQLContext, config: ValidationConfig): string {
    if (!config || config.length === 0) {
      return `SELECT * FROM ${context.currentTable}`;
    }

    // 分离过滤规则和标记规则
    const filterRules: ValidationFieldConfig[] = [];
    const markRules: ValidationFieldConfig[] = [];

    for (const fieldConfig of config) {
      for (const rule of fieldConfig.rules) {
        if (rule.action === 'filter') {
          filterRules.push({ field: fieldConfig.field, rules: [rule] });
        } else if (rule.action === 'mark') {
          markRules.push({ field: fieldConfig.field, rules: [rule] });
        }
      }
    }

    let sql = `SELECT * FROM ${context.currentTable}`;

    // 先应用标记规则（添加标记列）
    if (markRules.length > 0) {
      sql = this.buildMarkRules(context.currentTable, markRules);
    }

    // 再应用过滤规则
    if (filterRules.length > 0) {
      const tempTable = markRules.length > 0 ? '_marked' : context.currentTable;
      sql = this.buildFilterRules(tempTable, filterRules);
    }

    return sql;
  }

  /**
   * 构建标记规则SQL
   */
  private buildMarkRules(currentTable: string, markRules: ValidationFieldConfig[]): string {
    const markColumns: string[] = [];

    for (const fieldConfig of markRules) {
      for (const rule of fieldConfig.rules) {
        const markColumn = rule.markColumn || `${fieldConfig.field}_valid`;
        const markColumnEscaped = SQLUtils.escapeIdentifier(markColumn);
        const validationExpression = this.buildValidationExpression(fieldConfig.field, rule);

        markColumns.push(`${validationExpression} AS ${markColumnEscaped}`);
      }
    }

    return `
      SELECT *,
        ${markColumns.join(',\n        ')}
      FROM ${currentTable}
    `.trim();
  }

  /**
   * 构建过滤规则SQL
   */
  private buildFilterRules(currentTable: string, filterRules: ValidationFieldConfig[]): string {
    const filterConditions: string[] = [];

    for (const fieldConfig of filterRules) {
      for (const rule of fieldConfig.rules) {
        const validationExpression = this.buildValidationExpression(fieldConfig.field, rule);
        filterConditions.push(validationExpression);
      }
    }

    const whereClause = filterConditions.join(' AND ');

    return `SELECT * FROM ${currentTable} WHERE ${whereClause}`;
  }

  /**
   * 构建验证表达式
   */
  private buildValidationExpression(field: string, rule: ValidationRule): string {
    const fieldEscaped = SQLUtils.escapeIdentifier(field);

    switch (rule.type) {
      case 'is_numeric':
        // 检查是否可以转为数值
        return `TRY_CAST(${fieldEscaped} AS DOUBLE) IS NOT NULL`;

      case 'is_date':
        // 检查是否可以转为日期
        return `TRY_CAST(${fieldEscaped} AS DATE) IS NOT NULL`;

      case 'is_email': {
        // 简单的邮箱验证正则
        const emailPattern = SQLUtils.quoteValue(
          '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}$'
        );
        return `regexp_matches(${fieldEscaped}, ${emailPattern})`;
      }

      case 'regex': {
        if (!rule.params?.pattern) {
          throw QueryErrorFactory.missingParam('pattern', 'regex validation');
        }
        const pattern = SQLUtils.quoteValue(rule.params.pattern);
        return `regexp_matches(${fieldEscaped}, ${pattern})`;
      }

      case 'enum': {
        if (!rule.params?.allowedValues || rule.params.allowedValues.length === 0) {
          throw QueryErrorFactory.missingParam('allowedValues', 'enum validation');
        }
        const inList = rule.params.allowedValues.map((v) => SQLUtils.quoteValue(v)).join(', ');
        return `${fieldEscaped} IN (${inList})`;
      }

      case 'range': {
        const conditions: string[] = [];
        if (rule.params?.min !== undefined) {
          conditions.push(`${fieldEscaped}::DOUBLE >= ${rule.params.min}`);
        }
        if (rule.params?.max !== undefined) {
          conditions.push(`${fieldEscaped}::DOUBLE <= ${rule.params.max}`);
        }
        if (conditions.length === 0) {
          throw QueryErrorFactory.missingParam('min or max', 'range validation');
        }
        return conditions.join(' AND ');
      }

      case 'length': {
        const lengthConditions: string[] = [];
        if (rule.params?.minLength !== undefined) {
          lengthConditions.push(`LENGTH(${fieldEscaped}) >= ${rule.params.minLength}`);
        }
        if (rule.params?.maxLength !== undefined) {
          lengthConditions.push(`LENGTH(${fieldEscaped}) <= ${rule.params.maxLength}`);
        }
        if (lengthConditions.length === 0) {
          throw QueryErrorFactory.missingParam('minLength or maxLength', 'length validation');
        }
        return lengthConditions.join(' AND ');
      }

      case 'cross_field': {
        if (!rule.params?.compareField || !rule.params?.operator) {
          throw QueryErrorFactory.missingParam(
            'compareField and operator',
            'cross_field validation'
          );
        }
        const compareField = SQLUtils.escapeIdentifier(rule.params.compareField);
        const operator = rule.params.operator;
        return `${fieldEscaped} ${operator} ${compareField}`;
      }

      default:
        throw QueryErrorFactory.unsupportedOperation((rule as any).type, 'validation');
    }
  }

  /**
   * 获取验证后的列名列表（用于更新 context）
   */
  getResultColumns(context: SQLContext, config: ValidationConfig): Set<string> {
    const resultColumns = new Set(context.availableColumns);

    // 添加所有标记列
    for (const fieldConfig of config) {
      for (const rule of fieldConfig.rules) {
        if (rule.action === 'mark') {
          const markColumn = rule.markColumn || `${fieldConfig.field}_valid`;
          resultColumns.add(markColumn);
        }
      }
    }

    return resultColumns;
  }
}
