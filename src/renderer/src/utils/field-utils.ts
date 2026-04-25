/**
 * 字段工具函数
 * 处理系统字段过滤等通用逻辑
 */

/**
 * 系统字段列表
 * 这些字段由数据库自动生成和管理，不应该在用户界面中展示或手动填写
 */
import {
  SYSTEM_FIELDS,
  filterSystemColumnsFromSchema,
  filterWritableColumnsFromSchema,
  isSystemField,
  isVirtualColumnFieldType,
  isWritableColumn,
  stripSystemFields,
  type DatasetColumnLike,
} from '../../../utils/dataset-column-capabilities';

export { SYSTEM_FIELDS, isSystemField, isVirtualColumnFieldType, isWritableColumn };

/**
 * 判断是否为系统字段
 */

/**
 * 过滤掉系统字段
 * @param record 原始记录对象
 * @returns 过滤后的记录对象（不含系统字段）
 *
 * @example
 * const record = { _row_id: 1, name: 'Product A', price: 100 };
 * const filtered = filterSystemFields(record);
 * // => { name: 'Product A', price: 100 }
 */
export function filterSystemFields<T extends Record<string, any>>(record: T): Partial<T> {
  return stripSystemFields(record as Record<string, unknown>) as Partial<T>;
}

/**
 * 批量过滤系统字段
 * @param records 记录数组
 * @returns 过滤后的记录数组
 *
 * @example
 * const records = [
 *   { _row_id: 1, name: 'A', price: 100 },
 *   { _row_id: 2, name: 'B', price: 200 }
 * ];
 * const filtered = filterSystemFieldsFromArray(records);
 * // => [{ name: 'A', price: 100 }, { name: 'B', price: 200 }]
 */
export function filterSystemFieldsFromArray<T extends Record<string, any>>(
  records: T[]
): Partial<T>[] {
  return records.map((record) => filterSystemFields(record));
}

/**
 * 从 Schema 数组中过滤系统字段
 * @param schema 字段 Schema 数组
 * @returns 过滤后的 Schema 数组
 *
 * @example
 * const schema = [
 *   { name: '_row_id', type: 'INTEGER' },
 *   { name: 'product_name', type: 'VARCHAR' }
 * ];
 * const filtered = filterSystemFieldsFromSchema(schema);
 * // => [{ name: 'product_name', type: 'VARCHAR' }]
 */
export function filterSystemFieldsFromSchema<T extends { name: string }>(schema: T[]): T[] {
  return filterSystemColumnsFromSchema(schema as Array<T & DatasetColumnLike>) as T[];
}

/**
 * 过滤出真正可写的字段 Schema
 * 会排除系统列、计算列、按钮列、附件列和显式锁定列
 */
export function filterWritableFieldsFromSchema<T extends DatasetColumnLike>(schema: T[]): T[] {
  return filterWritableColumnsFromSchema(schema);
}

/**
 * 判断 DuckDB 类型是否为数值类型
 */
export function isNumericType(duckdbType: string): boolean {
  const numericTypes = [
    'INTEGER',
    'BIGINT',
    'DOUBLE',
    'DECIMAL',
    'FLOAT',
    'NUMERIC',
    'REAL',
    'SMALLINT',
    'TINYINT',
    'HUGEINT',
  ];
  return numericTypes.some((type) => duckdbType.toUpperCase().includes(type));
}

/**
 * 判断 DuckDB 类型是否为日期/时间类型
 */
export function isDateType(duckdbType: string): boolean {
  const dateTypes = ['DATE', 'TIMESTAMP', 'DATETIME', 'TIME'];
  return dateTypes.some((type) => duckdbType.toUpperCase().includes(type));
}

/**
 * 根据字段类型判断空字符串是否应该转换为 NULL
 * @param fieldType 字段类型（fieldType 或 duckdbType）
 * @returns true 表示应该转换为 NULL，false 表示保留空字符串
 */
function shouldConvertEmptyToNull(fieldType: string): boolean {
  const upperType = fieldType.toUpperCase();

  // 文本类型：保留空字符串（'' 和 NULL 语义不同）
  if (
    upperType.includes('VARCHAR') ||
    upperType.includes('TEXT') ||
    upperType.includes('STRING') ||
    upperType.includes('CHAR')
  ) {
    return false;
  }

  // 超链接字段：保留空字符串
  if (fieldType === 'hyperlink' || fieldType === 'text') {
    return false;
  }

  // 其他类型（数字、日期、选择等）：转换为 NULL
  return true;
}

/**
 * 规范化单条记录的值
 * - 文本字段：保留空字符串
 * - 数字/日期/选择字段：空字符串转换为 NULL
 *
 * @param record 原始记录对象
 * @param schema Schema 定义（包含 name, fieldType, duckdbType）
 * @returns 规范化后的记录对象
 *
 * @example
 * const record = { 产品名称: '', 价格: '', 发布日期: '' };
 * const schema = [
 *   { name: '产品名称', fieldType: 'text', duckdbType: 'VARCHAR' },
 *   { name: '价格', fieldType: 'number', duckdbType: 'DOUBLE' },
 *   { name: '发布日期', fieldType: 'date', duckdbType: 'DATE' }
 * ];
 * const normalized = normalizeRecordValues(record, schema);
 * // => { 产品名称: '', 价格: null, 发布日期: null }
 */
export function normalizeRecordValues<T extends Record<string, any>>(
  record: T,
  schema: Array<{ name: string; fieldType?: string; duckdbType?: string }>
): T {
  const normalized = { ...record } as Record<string, any>;

  schema.forEach((col) => {
    const fieldName = col.name;
    const value = normalized[fieldName];

    // 只处理空字符串的情况
    if (value !== '' && value !== null && value !== undefined) {
      return;
    }

    if (value === '') {
      // 根据字段类型决定是否转换为 NULL
      const fieldType = col.fieldType || col.duckdbType || '';

      if (shouldConvertEmptyToNull(fieldType)) {
        normalized[fieldName] = null;
      }
      // 否则保留空字符串
    }
  });

  return normalized as T;
}

/**
 * 批量规范化记录数组
 * @param records 记录数组
 * @param schema Schema 定义
 * @returns 规范化后的记录数组
 *
 * @example
 * const records = [
 *   { 产品名称: 'A', 价格: '', 发布日期: '' },
 *   { 产品名称: '', 价格: '100', 发布日期: '2024-01-01' }
 * ];
 * const normalized = normalizeRecordsArray(records, schema);
 * // => [
 * //   { 产品名称: 'A', 价格: null, 发布日期: null },
 * //   { 产品名称: '', 价格: '100', 发布日期: '2024-01-01' }
 * // ]
 */
export function normalizeRecordsArray<T extends Record<string, any>>(
  records: T[],
  schema: Array<{ name: string; fieldType?: string; duckdbType?: string }>
): T[] {
  return records.map((record) => normalizeRecordValues(record, schema));
}

/**
 * 验证结果接口
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * 验证单条记录的数据类型
 * @param record 记录对象
 * @param schema Schema 定义
 * @returns 验证结果
 *
 * @example
 * const record = { 产品名称: 'A', 价格: 'abc', 发布日期: 'invalid' };
 * const result = validateRecord(record, schema);
 * // => { isValid: false, errors: ['字段"价格"应为数字', '字段"发布日期"日期格式无效'] }
 */
export function validateRecord(
  record: Record<string, any>,
  schema: Array<{ name: string; fieldType?: string; duckdbType?: string }>
): ValidationResult {
  const errors: string[] = [];

  schema.forEach((col) => {
    const fieldName = col.name;
    const value = record[fieldName];

    // 跳过空值（空值由 normalizeRecordValues 处理）
    if (value === null || value === undefined || value === '') {
      return;
    }

    const duckdbType = col.duckdbType || '';
    const fieldType = col.fieldType || '';

    // 验证数字类型
    if (isNumericType(duckdbType) || fieldType === 'number') {
      if (typeof value === 'string' && value.trim() !== '') {
        const num = Number(value);
        if (isNaN(num)) {
          errors.push(`字段"${fieldName}"应为数字，当前值："${value}"`);
        }
      } else if (typeof value !== 'number') {
        errors.push(`字段"${fieldName}"应为数字`);
      }
    }

    // 验证日期类型
    if (isDateType(duckdbType) || fieldType === 'date') {
      if (typeof value === 'string') {
        // 支持的日期格式：YYYY-MM-DD, YYYY/MM/DD, YYYY-MM-DD HH:mm:ss
        const datePattern = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(\s+\d{1,2}:\d{1,2}(:\d{1,2})?)?$/;
        if (!datePattern.test(value.trim())) {
          errors.push(`字段"${fieldName}"日期格式无效，当前值："${value}"（支持格式：YYYY-MM-DD）`);
        }
      }
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * 批量验证记录数组
 * @param records 记录数组
 * @param schema Schema 定义
 * @returns 验证结果（汇总所有错误）
 */
export function validateRecords(
  records: Record<string, any>[],
  schema: Array<{ name: string; fieldType?: string; duckdbType?: string }>
): ValidationResult {
  const allErrors: string[] = [];

  records.forEach((record, index) => {
    const result = validateRecord(record, schema);
    if (!result.isValid) {
      result.errors.forEach((error) => {
        allErrors.push(`第 ${index + 1} 行：${error}`);
      });
    }
  });

  return {
    isValid: allErrors.length === 0,
    errors: allErrors,
  };
}

/**
 * 将技术性错误消息转换为用户友好的提示
 * @param error 原始错误消息
 * @returns 用户友好的错误消息
 */
export function formatUserFriendlyError(error: string): string {
  if (error.startsWith('Columns are not writable:')) {
    const columns = error.replace('Columns are not writable:', '').trim();
    return `浠ヤ笅瀛楁涓嶆敮鎸佺洿鎺ュ啓鍏ワ細${columns}`;
  }

  if (error.startsWith('Unknown columns:')) {
    const columns = error.replace('Unknown columns:', '').trim();
    return `瀛楁涓嶅瓨鍦ㄦ垨宸蹭笉鍙敤锛細${columns}`;
  }
  // NOT NULL 约束错误
  if (error.includes('NOT NULL constraint failed')) {
    // 匹配格式：schema.table.column，支持中文字段名
    const match = error.match(/NOT NULL constraint failed: [^.]+\.[^.]+\.(.+)$/);
    if (match) {
      return `字段"${match[1]}"不能为空`;
    }
    return '存在必填字段未填写';
  }

  // UNIQUE 约束错误
  if (error.includes('UNIQUE constraint failed')) {
    // 匹配格式：schema.table.column，支持中文字段名
    const match = error.match(/UNIQUE constraint failed: [^.]+\.[^.]+\.(.+)$/);
    if (match) {
      return `字段"${match[1]}"的值已存在，不能重复`;
    }
    return '存在重复的数据';
  }

  // 类型转换错误
  if (error.includes('Could not convert') || error.includes('Invalid input')) {
    return '数据类型不匹配，请检查输入值的格式';
  }

  // 数据库连接错误
  if (error.includes('database') && error.includes('locked')) {
    return '数据库正忙，请稍后重试';
  }

  // 默认返回原始错误
  return error;
}
