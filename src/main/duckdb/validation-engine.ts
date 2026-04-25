/**
 * 数据验证引擎
 * 将验证规则转换为DuckDB约束，并提供数据验证功能
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import { parseRows, quoteIdentifier, quoteQualifiedName } from './utils';

export interface ValidationRule {
  type: 'required' | 'unique' | 'regex' | 'range' | 'length' | 'check' | 'enum';
  params?: any;
  errorMessage?: string;
}

export interface ValidationViolation {
  rowId: string;
  columnName: string;
  value: any;
  rule: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  violations?: ValidationViolation[];
  totalViolations?: number;
}

export class ValidationEngine {
  private conn: DuckDBConnection;

  constructor(conn: DuckDBConnection) {
    this.conn = conn;
  }

  private buildConstraintName(prefix: string, columnName: string): string {
    const safeCol = String(columnName || 'col')
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .slice(0, 32);
    return `${prefix}_${safeCol}_${Date.now()}`;
  }

  /**
   * 将验证规则转换为DuckDB约束
   *
   * ✅ 错误处理策略：
   * - 任何规则应用失败都会立即抛出错误
   * - 调用者负责处理失败情况（例如：回滚已创建的列）
   * - DuckDB 约束是原子性的，单个约束失败不会影响其他约束
   */
  async applyValidationRules(params: {
    datasetId: string;
    filePath: string;
    columnName: string;
    rules: ValidationRule[];
  }): Promise<void> {
    const { datasetId, columnName, rules } = params;
    const safeDatasetId = this.sanitizeIdentifier(datasetId);

    console.log(`Applying ${rules.length} validation rules to ${columnName}...`);

    for (const rule of rules) {
      try {
        switch (rule.type) {
          case 'required':
            // NOT NULL约束通常在创建列时已处理
            // 这里只是验证
            console.log(`  ✓ Required constraint (handled during column creation)`);
            break;

          case 'unique':
            await this.addUniqueConstraint(safeDatasetId, columnName);
            break;

          case 'check':
            await this.addCheckConstraint(safeDatasetId, columnName, rule.params.expression);
            break;

          case 'regex': {
            // 转换为CHECK约束
            const regexCheck = `regexp_matches(${quoteIdentifier(columnName)}, '${this.escapeRegex(
              rule.params.pattern
            )}')`;
            await this.addCheckConstraint(safeDatasetId, columnName, regexCheck);
            break;
          }

          case 'range': {
            const rangeCheck = this.buildRangeCheck(columnName, rule.params.min, rule.params.max);
            await this.addCheckConstraint(safeDatasetId, columnName, rangeCheck);
            break;
          }

          case 'length': {
            const lengthCheck = this.buildLengthCheck(
              columnName,
              rule.params.minLength,
              rule.params.maxLength
            );
            await this.addCheckConstraint(safeDatasetId, columnName, lengthCheck);
            break;
          }

          case 'enum': {
            const enumCheck = this.buildEnumCheck(columnName, rule.params.values);
            await this.addCheckConstraint(safeDatasetId, columnName, enumCheck);
            break;
          }

          default:
            console.warn(`  ⚠ Unknown validation rule type: ${rule.type}`);
        }
      } catch (error: any) {
        console.error(`  ✗ Failed to apply ${rule.type} validation:`, error.message);
        throw new Error(`验证规则应用失败 (${rule.type}): ${error.message}`);
      }
    }

    console.log(`✅ All validation rules applied to ${columnName}`);
  }

  /**
   * 添加唯一性约束
   */
  private async addUniqueConstraint(datasetId: string, columnName: string): Promise<void> {
    const tableName = quoteQualifiedName(`ds_${datasetId}`, 'data');
    const constraintName = this.buildConstraintName('unique', columnName);

    const sql = `
      ALTER TABLE ${tableName}
      ADD CONSTRAINT ${quoteIdentifier(constraintName)}
      UNIQUE (${quoteIdentifier(columnName)})
    `;

    await this.conn.run(sql);
    console.log(`  ✓ Added UNIQUE constraint: ${constraintName}`);
  }

  /**
   * 添加CHECK约束
   */
  private async addCheckConstraint(
    datasetId: string,
    columnName: string,
    checkExpression: string
  ): Promise<void> {
    const tableName = quoteQualifiedName(`ds_${datasetId}`, 'data');
    const constraintName = this.buildConstraintName('check', columnName);

    const sql = `
      ALTER TABLE ${tableName}
      ADD CONSTRAINT ${quoteIdentifier(constraintName)}
      CHECK (${checkExpression})
    `;

    await this.conn.run(sql);
    console.log(`  ✓ Added CHECK constraint: ${constraintName}`);
  }

  /**
   * 验证现有数据是否符合新规则
   */
  async validateExistingData(params: {
    datasetId: string;
    columnName: string;
    rules: ValidationRule[];
    limit?: number;
  }): Promise<ValidationResult> {
    const { datasetId, columnName, rules, limit = 100 } = params;
    const safeDatasetId = this.sanitizeIdentifier(datasetId);

    const allViolations: ValidationViolation[] = [];

    for (const rule of rules) {
      try {
        const checkExpression = this.ruleToExpression(columnName, rule);

        // 查询违反规则的行
        const sql = `
          SELECT _row_id, ${quoteIdentifier(columnName)} as value
          FROM ${quoteQualifiedName(`ds_${safeDatasetId}`, 'data')}
          WHERE NOT (${checkExpression})
          LIMIT ${limit}
        `;

        const result = await this.conn.runAndReadAll(sql);
        const rows = parseRows(result);

        if (rows.length > 0) {
          for (const row of rows) {
            allViolations.push({
              rowId: row._row_id?.toString() || 'unknown',
              columnName,
              value: row.value,
              rule: rule.type,
              message: rule.errorMessage || `违反 ${rule.type} 规则`,
            });
          }
        }
      } catch (error: any) {
        console.error(`Error validating rule ${rule.type}:`, error);
      }
    }

    return {
      valid: allViolations.length === 0,
      violations: allViolations,
      totalViolations: allViolations.length,
    };
  }

  /**
   * 将验证规则转换为SQL表达式
   */
  private ruleToExpression(columnName: string, rule: ValidationRule): string {
    switch (rule.type) {
      case 'required':
        return `${quoteIdentifier(columnName)} IS NOT NULL`;

      case 'unique':
        // 唯一性验证需要特殊处理（GROUP BY + HAVING）
        return 'TRUE'; // 跳过，因为UNIQUE约束会自动检查

      case 'regex':
        return `regexp_matches(${quoteIdentifier(columnName)}, '${this.escapeRegex(rule.params.pattern)}')`;

      case 'range':
        return this.buildRangeCheck(columnName, rule.params.min, rule.params.max);

      case 'length':
        return this.buildLengthCheck(columnName, rule.params.minLength, rule.params.maxLength);

      case 'check':
        return rule.params.expression;

      case 'enum':
        return this.buildEnumCheck(columnName, rule.params.values);

      default:
        return 'TRUE';
    }
  }

  /**
   * 构建数值范围检查表达式
   */
  private buildRangeCheck(columnName: string, min?: number, max?: number): string {
    const conditions: string[] = [];
    const col = quoteIdentifier(columnName);

    if (min !== undefined && min !== null) {
      conditions.push(`${col} >= ${min}`);
    }
    if (max !== undefined && max !== null) {
      conditions.push(`${col} <= ${max}`);
    }

    if (conditions.length === 0) {
      return 'TRUE';
    }

    return conditions.join(' AND ');
  }

  /**
   * 构建文本长度检查表达式
   */
  private buildLengthCheck(columnName: string, minLength?: number, maxLength?: number): string {
    const conditions: string[] = [];
    const col = quoteIdentifier(columnName);

    if (minLength !== undefined && minLength !== null) {
      conditions.push(`length(${col}) >= ${minLength}`);
    }
    if (maxLength !== undefined && maxLength !== null) {
      conditions.push(`length(${col}) <= ${maxLength}`);
    }

    if (conditions.length === 0) {
      return 'TRUE';
    }

    return conditions.join(' AND ');
  }

  /**
   * 构建枚举检查表达式
   */
  private buildEnumCheck(columnName: string, values: string[]): string {
    if (!values || values.length === 0) {
      return 'TRUE';
    }

    const quotedValues = values.map((v) => `'${this.escapeSqlString(v)}'`).join(', ');
    return `${quoteIdentifier(columnName)} IN (${quotedValues})`;
  }

  /**
   * 获取预定义的验证规则模板
   */
  static getCommonRules(): Record<string, ValidationRule> {
    return {
      email: {
        type: 'regex',
        params: {
          pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
        },
        errorMessage: '请输入有效的Email地址',
      },
      phone: {
        type: 'regex',
        params: {
          pattern: '^1[3-9]\\d{9}$',
        },
        errorMessage: '请输入有效的11位手机号',
      },
      url: {
        type: 'regex',
        params: {
          pattern: '^https?://.*',
        },
        errorMessage: '请输入有效的URL（以http://或https://开头）',
      },
      positiveNumber: {
        type: 'range',
        params: {
          min: 0,
        },
        errorMessage: '必须是正数',
      },
      age: {
        type: 'range',
        params: {
          min: 0,
          max: 150,
        },
        errorMessage: '年龄必须在0-150之间',
      },
      percentage: {
        type: 'range',
        params: {
          min: 0,
          max: 100,
        },
        errorMessage: '百分比必须在0-100之间',
      },
    };
  }

  /**
   * 清理标识符（防止SQL注入）
   */
  private sanitizeIdentifier(identifier: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(identifier)) {
      throw new Error(`Invalid identifier: ${identifier}`);
    }
    return identifier;
  }

  /**
   * 转义正则表达式特殊字符（用于SQL REGEXP）
   */
  private escapeRegex(pattern: string): string {
    // DuckDB的正则表达式使用单引号，需要转义单引号
    return pattern.replace(/'/g, "''");
  }

  /**
   * 转义SQL字符串
   */
  private escapeSqlString(str: string): string {
    return str.replace(/'/g, "''");
  }
}
