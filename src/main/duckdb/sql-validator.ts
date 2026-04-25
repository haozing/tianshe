/**
 * SQL表达式验证器
 * 用于验证用户输入的SQL表达式的语法和安全性
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import { parseRows, quoteQualifiedName } from './utils';

export interface ValidationResult {
  valid: boolean;
  inferredType?: string;
  error?: string;
  referencedColumns?: string[];
  warnings?: string[];
}

export class SQLValidator {
  private conn: DuckDBConnection;

  constructor(conn: DuckDBConnection) {
    this.conn = conn;
  }

  /**
   * 验证SQL表达式的语法和类型安全
   */
  async validateExpression(params: {
    datasetId: string;
    expression: string;
    expectedType?: string;
    tableName?: string;
    tableSchema?: string;
    baseTableName?: string;
  }): Promise<ValidationResult> {
    const { datasetId, expression, expectedType } = params;
    const tableName = params.tableName || this.sanitizeIdentifier(datasetId);

    try {
      const resolved = this.resolveSchemaAndTable({
        datasetId,
        tableName,
        tableSchema: params.tableSchema,
        baseTableName: params.baseTableName,
      });
      const sqlTableRef = quoteQualifiedName(resolved.schema, resolved.table);

      // 1. 基本安全检查：防止危险操作
      const securityCheck = this.checkSecurity(expression);
      if (!securityCheck.safe) {
        return {
          valid: false,
          error: securityCheck.reason || 'SQL表达式包含不安全的操作',
        };
      }

      // 2. 使用DuckDB的EXPLAIN分析表达式语法
      // 注意：这里使用 LIMIT 0 避免实际执行数据查询
      const explainQuery = `
        EXPLAIN SELECT ${expression} as test_expr
        FROM ${sqlTableRef}
        LIMIT 0
      `;

      await this.conn.run(explainQuery);

      // 3. 推断表达式的返回类型
      const inferredType = await this.inferExpressionType(sqlTableRef, expression);

      // 4. 检查类型兼容性
      if (expectedType && !this.areTypesCompatible(inferredType, expectedType)) {
        return {
          valid: false,
          error: `类型不匹配: 期望 ${expectedType}, 但表达式返回 ${inferredType}`,
          inferredType,
        };
      }

      // 5. 提取引用的列
      const referencedColumns = await this.extractReferencedColumns({
        datasetId,
        expression,
        tableName: `${resolved.schema}.${resolved.table}`,
        tableSchema: params.tableSchema,
        baseTableName: params.baseTableName,
      });

      // 6. 生成警告（如果有）
      const warnings = this.generateWarnings(expression, referencedColumns);

      return {
        valid: true,
        inferredType,
        referencedColumns,
        warnings,
      };
    } catch (error: any) {
      // 解析DuckDB错误信息，提供友好提示
      const friendlyError = this.parseDuckDBError(error.message);
      return {
        valid: false,
        error: friendlyError,
      };
    }
  }

  /**
   * 安全检查：防止危险的SQL操作
   */
  private checkSecurity(expression: string): { safe: boolean; reason?: string } {
    // 计算列表达式只允许“单条表达式片段”，不允许多语句/分号终止
    if (expression.includes(';')) {
      return { safe: false, reason: '不允许使用分号（仅允许单条表达式）' };
    }

    // 禁止的操作列表
    const dangerousPatterns = [
      {
        pattern: /\b(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE)\b/i,
        reason: '不允许使用DDL或DML语句',
      },
      { pattern: /\b(ATTACH|DETACH)\b/i, reason: '不允许操作数据库附加' },
      { pattern: /\b(PRAGMA)\b/i, reason: '不允许使用PRAGMA命令' },
      { pattern: /\b(LOAD|INSTALL)\b/i, reason: '不允许加载扩展' },
      { pattern: /\b(COPY)\b/i, reason: '不允许使用COPY命令' },
      { pattern: /--/i, reason: '不允许使用SQL注释进行注入' },
      { pattern: /\/\*/i, reason: '不允许使用块注释' },
      { pattern: /\bUNION\b/i, reason: '不允许使用UNION查询' },
      { pattern: /\bINTO\s+(OUTFILE|DUMPFILE)/i, reason: '不允许导出文件' },
    ];

    for (const { pattern, reason } of dangerousPatterns) {
      if (pattern.test(expression)) {
        return { safe: false, reason };
      }
    }

    // 检查是否包含子查询（有限支持）
    if (/\bSELECT\b/i.test(expression)) {
      return { safe: false, reason: '计算列表达式中不允许使用SELECT子查询' };
    }

    return { safe: true };
  }

  /**
   * 推断表达式的返回类型
   */
  private async inferExpressionType(tableName: string, expression: string): Promise<string> {
    try {
      const query = `
        SELECT typeof(${expression}) as expr_type
        FROM ${tableName}
        LIMIT 1
      `;

      const result = await this.conn.runAndReadAll(query);
      const rows = parseRows(result);

      if (rows.length > 0) {
        return String(rows[0].expr_type || 'UNKNOWN');
      }

      return 'UNKNOWN';
    } catch (error) {
      // 如果表为空或其他错误，返回UNKNOWN
      console.warn('[SQLValidator] Failed to infer expression type:', error);
      return 'UNKNOWN';
    }
  }

  /**
   * 提取表达式中引用的列名
   */
  private async extractReferencedColumns(params: {
    datasetId: string;
    expression: string;
    tableName: string;
    tableSchema?: string;
    baseTableName?: string;
  }): Promise<string[]> {
    const { expression } = params;

    try {
      const resolved = this.resolveSchemaAndTable(params);

      // 获取表的所有列
      const schemaQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = '${this.escapeSqlString(resolved.schema)}'
          AND table_name = '${this.escapeSqlString(resolved.table)}'
      `;

      const result = await this.conn.runAndReadAll(schemaQuery);
      const columns = parseRows(result).map((row: any) => row.column_name);

      // 简化方法：检查表达式中是否包含这些列名
      // 使用词边界匹配，避免部分匹配
      const referencedColumns: string[] = [];
      for (const col of columns) {
        // 匹配带引号或不带引号的列名
        const patterns = [
          new RegExp(`\\b${this.escapeRegex(col)}\\b`, 'i'),
          new RegExp(`"${this.escapeRegex(col)}"`, 'i'),
        ];

        if (patterns.some((pattern) => pattern.test(expression))) {
          referencedColumns.push(col);
        }
      }

      return referencedColumns;
    } catch (error) {
      console.warn('Failed to extract referenced columns:', error);
      return [];
    }
  }

  private resolveSchemaAndTable(params: {
    datasetId: string;
    tableName: string;
    tableSchema?: string;
    baseTableName?: string;
  }): { schema: string; table: string } {
    if (params.tableSchema && params.baseTableName) {
      return {
        schema: this.sanitizeIdentifier(params.tableSchema),
        table: this.sanitizeIdentifier(params.baseTableName),
      };
    }

    // Expecting "schema.table" form for attached datasets: ds_<id>.data
    if (params.tableName.includes('.')) {
      const [schema, table] = params.tableName.split('.', 2);
      return {
        schema: this.sanitizeIdentifier(schema),
        table: this.sanitizeIdentifier(table),
      };
    }

    // Fallback: treat datasetId as a table name in the default schema (legacy).
    return {
      schema: 'main',
      table: this.sanitizeIdentifier(params.datasetId),
    };
  }

  /**
   * 生成警告信息
   */
  private generateWarnings(expression: string, referencedColumns: string[]): string[] {
    const warnings: string[] = [];

    // 警告1：未引用任何列（可能是常量表达式）
    if (referencedColumns.length === 0) {
      warnings.push('表达式未引用任何列，将为所有行返回相同的值');
    }

    // 警告2：使用了可能导致NULL的操作
    if (/\bCOALESCE\b/i.test(expression)) {
      warnings.push('使用了COALESCE函数，请确保处理了NULL值');
    }

    // 警告3：除法操作（可能除以0）
    if (/\//.test(expression)) {
      warnings.push('包含除法操作，请确保分母不为0');
    }

    // 警告4：字符串拼接可能产生NULL
    if (/\|\|/.test(expression) || /CONCAT/i.test(expression)) {
      warnings.push('字符串拼接操作，如果任一操作数为NULL，结果可能为NULL');
    }

    return warnings;
  }

  /**
   * 解析DuckDB错误为友好消息
   */
  private parseDuckDBError(errorMsg: string): string {
    if (!errorMsg) return '未知错误';

    if (errorMsg.includes('Catalog Error') || errorMsg.includes('does not exist')) {
      return '引用的列不存在，请检查列名是否正确';
    }
    if (errorMsg.includes('Syntax Error') || errorMsg.includes('Parser Error')) {
      return 'SQL语法错误，请检查表达式格式';
    }
    if (errorMsg.includes('Binder Error')) {
      return '列名绑定错误，请检查列名是否存在';
    }
    if (errorMsg.includes('Type Error') || errorMsg.includes('Conversion Error')) {
      return '类型错误，请检查数据类型是否兼容';
    }

    // 返回原始错误（简化版本）
    const firstLine = errorMsg.split('\n')[0];
    return firstLine.length > 100 ? firstLine.substring(0, 100) + '...' : firstLine;
  }

  /**
   * 检查两个类型是否兼容
   */
  private areTypesCompatible(type1: string, type2: string): boolean {
    const normalizeType = (t: string) => t.toUpperCase().split('(')[0].trim();
    const t1 = normalizeType(type1);
    const t2 = normalizeType(type2);

    if (t1 === t2) return true;

    // 数字类型兼容
    const numericTypes = [
      'INTEGER',
      'BIGINT',
      'SMALLINT',
      'TINYINT',
      'DOUBLE',
      'FLOAT',
      'DECIMAL',
      'NUMERIC',
      'REAL',
      'HUGEINT',
    ];
    if (numericTypes.includes(t1) && numericTypes.includes(t2)) return true;

    // 字符串类型兼容
    const stringTypes = ['VARCHAR', 'TEXT', 'CHAR', 'STRING'];
    if (stringTypes.includes(t1) && stringTypes.includes(t2)) return true;

    // 日期时间类型兼容
    const dateTypes = ['DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIME', 'TIMETZ'];
    if (dateTypes.includes(t1) && dateTypes.includes(t2)) return true;

    return false;
  }

  /**
   * 清理标识符（防止SQL注入）
   */
  private sanitizeIdentifier(identifier: string): string {
    // 只允许字母、数字、下划线、连字符
    if (!/^[a-zA-Z0-9_-]+$/.test(identifier)) {
      throw new Error(`Invalid identifier: ${identifier}`);
    }
    return identifier;
  }

  private escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * 转义正则表达式特殊字符
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 快速验证：只检查语法，不推断类型
   */
  async quickValidate(expression: string): Promise<{ valid: boolean; error?: string }> {
    const securityCheck = this.checkSecurity(expression);
    if (!securityCheck.safe) {
      return {
        valid: false,
        error: securityCheck.reason,
      };
    }

    return { valid: true };
  }
}
