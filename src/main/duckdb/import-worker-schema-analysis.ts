import type { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';
import { createLogger } from '../../core/logger';
import { getUnknownErrorMessage } from '../ipc-utils';

const logger = createLogger('ImportWorkerSchemaAnalysis');

/**
 * 获取基础 schema（只包含列名和 DuckDB 物理类型）
 */
export async function getBasicSchema(conn: DuckDBConnection, tableName: string) {
  const result = await conn.runAndReadAll(`DESCRIBE ${tableName}`);
  const rows = parseRows(result);

  return rows.map((row: any) => ({
    name: row.column_name,
    duckdbType: row.column_type,
    fieldType: mapDuckDBTypeToFieldType(row.column_type),
    nullable: true,
    metadata: {},
    storageMode: 'physical',
  }));
}

/**
 * DuckDB 类型到业务字段类型的简单映射
 */
function mapDuckDBTypeToFieldType(duckdbType: string): string {
  const upperType = duckdbType.toUpperCase();

  if (
    upperType.includes('INT') ||
    upperType.includes('DOUBLE') ||
    upperType.includes('FLOAT') ||
    upperType.includes('DECIMAL') ||
    upperType.includes('NUMERIC')
  ) {
    return 'number';
  }

  if (upperType.includes('DATE') || upperType.includes('TIMESTAMP') || upperType.includes('TIME')) {
    return 'date';
  }

  if (upperType === 'BOOLEAN') {
    return 'boolean';
  }

  return 'text';
}

/**
 * 智能分析列类型并生成转换方案
 */
export async function analyzeColumnTypes(
  conn: DuckDBConnection,
  tableName: string,
  basicSchema: any[],
  rowCount: number
): Promise<{
  finalSchema: any[];
  conversions: Array<{
    columnName: string;
    fromType: string;
    toType: string;
    reason: string;
  }>;
}> {
  const finalSchema = [];
  const conversions = [];

  for (const column of basicSchema) {
    const columnName = column.name;
    const duckdbType = column.duckdbType;

    // 采样数据进行分析（最多1000行）
    const sampleSize = Math.min(rowCount, 1000);
    const escapedColumnName = `"${columnName.replace(/"/g, '""')}"`;

    try {
      const sampleResult = await conn.runAndReadAll(
        `SELECT ${escapedColumnName} FROM ${tableName}
         WHERE ${escapedColumnName} IS NOT NULL
         LIMIT ${sampleSize}`
      );
      const rows = parseRows(sampleResult);
      const values = rows.map((row) => row[columnName]);

      // 智能推断字段类型
      const analysis = inferFieldType(columnName, duckdbType, values);

      // 检查是否需要类型转换
      if (analysis.suggestedDuckDBType && analysis.suggestedDuckDBType !== duckdbType) {
        conversions.push({
          columnName: columnName,
          fromType: duckdbType,
          toType: analysis.suggestedDuckDBType,
          reason: analysis.metadata.inferredReason || '智能类型优化',
        });

        finalSchema.push({
          name: columnName,
          duckdbType: analysis.suggestedDuckDBType,
          fieldType: analysis.fieldType,
          nullable: column.nullable,
          metadata: analysis.metadata,
          storageMode: 'physical',
        });
      } else {
        finalSchema.push({
          ...column,
          fieldType: analysis.fieldType,
          metadata: {
            ...column.metadata,
            ...analysis.metadata,
          },
        });
      }
    } catch (error) {
      // 如果采样失败，保持原类型
      logger.warn('Failed to analyze imported column, keeping original type', {
        columnName,
        errorMessage: getUnknownErrorMessage(error),
      });
      finalSchema.push(column);
    }
  }

  return { finalSchema, conversions };
}

/**
 * 使用CREATE TABLE AS SELECT优化表结构
 * 一次性转换所有需要修改的列
 */
export async function optimizeTableStructure(
  conn: DuckDBConnection,
  tableName: string,
  conversions: Array<{ columnName: string; fromType: string; toType: string; reason: string }>,
  allColumns: any[]
): Promise<void> {
  try {
    // 保持原始列顺序（用户列在前，系统字段在后）
    const selectColumns = allColumns
      .map((col) => {
        const conversion = conversions.find((c) => c.columnName === col.name);
        const escapedName = `"${col.name.replace(/"/g, '""')}"`;

        if (conversion) {
          // 需要转换的列：使用CAST语法，并添加错误处理
          return `TRY_CAST(${escapedName} AS ${conversion.toType}) AS ${escapedName}`;
        } else {
          // 不需要转换的列：直接保留
          return escapedName;
        }
      })
      .join(',\n  ');

    // 创建优化后的新表
    await conn.run(`
      CREATE TABLE data_optimized AS
      SELECT
        ${selectColumns}
      FROM ${tableName}
    `);

    // 删除原表
    await conn.run(`DROP TABLE ${tableName}`);

    // 重命名新表
    await conn.run(`ALTER TABLE data_optimized RENAME TO ${tableName}`);
  } catch (error) {
    logger.error('Failed to optimize imported table structure', {
      tableName,
      conversionCount: conversions.length,
      errorMessage: getUnknownErrorMessage(error),
    });

    // 清理可能创建的临时表
    try {
      await conn.run('DROP TABLE IF EXISTS data_optimized');
    } catch {
      /* intentionally empty */
    }

    // 抛出错误，让调用者处理
    throw new Error(`类型优化失败: ${(error as Error).message}`);
  }
}

/**
 * 智能推断字段类型（包含DuckDB物理类型转换建议）
 */
function inferFieldType(
  columnName: string,
  duckdbType: string,
  values: any[]
): {
  fieldType: string;
  metadata: any;
  suggestedDuckDBType?: string;
} {
  if (values.length === 0) {
    return {
      fieldType: mapDuckDBTypeToFieldType(duckdbType),
      metadata: {},
    };
  }

  const upperType = duckdbType.toUpperCase();
  const lowerColumnName = columnName.toLowerCase();

  // 1. 如果DuckDB已经识别为数值类型，检查是否应该是文本
  if (upperType.includes('INT') || upperType.includes('BIGINT')) {
    // 检查是否是ID类型（前导0、特定命名）
    if (looksLikeId(lowerColumnName, values)) {
      return {
        fieldType: 'text',
        suggestedDuckDBType: 'VARCHAR',
        metadata: {
          inferredReason: 'ID字段（有前导0或特定命名模式）',
          originalDuckDBType: duckdbType,
        },
      };
    }

    // 检查是否是电话号码
    if (looksLikePhoneNumber(lowerColumnName, values)) {
      return {
        fieldType: 'text',
        suggestedDuckDBType: 'VARCHAR',
        metadata: {
          inferredReason: '电话号码',
          originalDuckDBType: duckdbType,
        },
      };
    }
  }

  // 2. 如果DuckDB识别为VARCHAR，检查是否应该是数值
  if (upperType.includes('VARCHAR') || upperType.includes('TEXT')) {
    // 检查是否所有值都是数字字符串
    const numericCheck = analyzeNumericStrings(values);

    // 放宽条件：只要95%以上是数字就转换（允许少量异常值）
    if (numericCheck.percentage > 0.95) {
      if (numericCheck.hasDecimals) {
        return {
          fieldType: 'number',
          suggestedDuckDBType: 'DOUBLE',
          metadata: {
            inferredReason: `${(numericCheck.percentage * 100).toFixed(1)}%的值是数字（含小数）`,
            originalDuckDBType: duckdbType,
          },
        };
      } else {
        return {
          fieldType: 'number',
          suggestedDuckDBType: 'BIGINT',
          metadata: {
            inferredReason: `${(numericCheck.percentage * 100).toFixed(1)}%的值是整数`,
            originalDuckDBType: duckdbType,
          },
        };
      }
    }

    // 检查是否是日期字符串
    if (looksLikeDate(values)) {
      return {
        fieldType: 'date',
        suggestedDuckDBType: 'TIMESTAMP',
        metadata: {
          inferredReason: '日期格式字符串',
          originalDuckDBType: duckdbType,
        },
      };
    }

    // URL和Email保持为VARCHAR（不需要转换）
    if (looksLikeUrl(lowerColumnName, values)) {
      return {
        fieldType: 'url',
        metadata: {
          inferredReason: 'URL链接',
          originalDuckDBType: duckdbType,
        },
      };
    }

    if (looksLikeEmail(lowerColumnName, values)) {
      return {
        fieldType: 'email',
        metadata: {
          inferredReason: '邮箱地址',
          originalDuckDBType: duckdbType,
        },
      };
    }
  }

  // 3. 默认使用DuckDB的类型映射（不转换）
  return {
    fieldType: mapDuckDBTypeToFieldType(duckdbType),
    metadata: {},
  };
}

/**
 * 检查是否看起来像ID字段
 */
function looksLikeId(columnName: string, values: any[]): boolean {
  // 列名包含id
  const hasIdInName = /\bid\b|编号|序号|code|num/.test(columnName);

  // 检查是否有前导0
  const hasLeadingZeros = values.some((v) => {
    const str = String(v);
    return str.length > 1 && str.startsWith('0');
  });

  return hasIdInName || hasLeadingZeros;
}

/**
 * 检查是否看起来像电话号码
 */
function looksLikePhoneNumber(columnName: string, values: any[]): boolean {
  // 列名包含电话相关关键字
  const hasPhoneInName = /phone|tel|手机|电话|mobile/.test(columnName);

  // 检查数值长度（中国手机号11位，固话7-8位）
  const lengthPattern = values.every((v) => {
    const str = String(v);
    return str.length >= 7 && str.length <= 15;
  });

  return hasPhoneInName && lengthPattern;
}

/**
 * 分析是否都是数字字符串
 */
function analyzeNumericStrings(values: any[]): {
  isNumeric: boolean;
  percentage: number;
  hasDecimals: boolean;
} {
  let numericCount = 0;
  let decimalCount = 0;

  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;

    const str = String(value).trim();

    // 检查是否是数字（包括负数和小数）
    if (/^-?\d+(\.\d+)?$/.test(str)) {
      numericCount++;
      if (str.includes('.')) {
        decimalCount++;
      }
    }
  }

  const total = values.filter((v) => v !== null && v !== undefined && v !== '').length;
  const percentage = total > 0 ? numericCount / total : 0;

  return {
    isNumeric: numericCount === total,
    percentage,
    hasDecimals: decimalCount > 0,
  };
}

/**
 * 检查是否看起来像日期
 */
function looksLikeDate(values: any[]): boolean {
  if (values.length === 0) return false;

  // 常见日期格式正则
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}$/, // 2024-01-01
    /^\d{4}\/\d{2}\/\d{2}$/, // 2024/01/01
    /^\d{2}\/\d{2}\/\d{4}$/, // 01/01/2024
    /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/, // 2024-01-01 12:00:00
  ];

  let matchCount = 0;
  for (const value of values.slice(0, 100)) {
    // 只检查前100个
    if (value === null || value === undefined) continue;
    const str = String(value).trim();

    if (datePatterns.some((pattern) => pattern.test(str))) {
      matchCount++;
    }
  }

  const sampleSize = Math.min(values.length, 100);
  return matchCount / sampleSize > 0.8; // 80%以上匹配
}

/**
 * 检查是否看起来像URL
 */
function looksLikeUrl(columnName: string, values: any[]): boolean {
  const hasUrlInName = /url|link|链接|网址/.test(columnName);

  const urlPattern = /^https?:\/\//i;
  const matchCount = values.filter((v) => {
    if (v === null || v === undefined) return false;
    return urlPattern.test(String(v));
  }).length;

  return hasUrlInName && matchCount / values.length > 0.8;
}

/**
 * 检查是否看起来像邮箱
 */
function looksLikeEmail(columnName: string, values: any[]): boolean {
  const hasEmailInName = /email|mail|邮箱/.test(columnName);

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const matchCount = values.filter((v) => {
    if (v === null || v === undefined) return false;
    return emailPattern.test(String(v));
  }).length;

  return hasEmailInName && matchCount / values.length > 0.8;
}
