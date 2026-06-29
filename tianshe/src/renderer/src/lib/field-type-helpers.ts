/**
 * 字段类型工具函数
 * 统一的DuckDB字段类型判断逻辑
 */

/**
 * DuckDB数值类型列表
 */
const NUMERIC_TYPES = [
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'DOUBLE',
  'DECIMAL',
  'FLOAT',
  'NUMERIC',
  'REAL',
  'HUGEINT',
] as const;

/**
 * DuckDB日期时间类型列表
 */
const DATE_TIME_TYPES = ['DATE', 'TIMESTAMP', 'TIME', 'DATETIME', 'TIMESTAMPTZ'] as const;

/**
 * DuckDB字符串类型列表
 */
const STRING_TYPES = ['VARCHAR', 'TEXT', 'STRING', 'CHAR', 'BPCHAR'] as const;

/**
 * DuckDB布尔类型列表
 */
const BOOLEAN_TYPES = ['BOOLEAN', 'BOOL'] as const;

/**
 * 字段类型分类
 */
export type FieldTypeCategory = 'numeric' | 'date' | 'string' | 'boolean' | 'other';

/**
 * 判断是否为数值类型
 *
 * @param duckdbType - DuckDB类型字符串（如 "INTEGER", "DOUBLE"）
 * @returns 是否为数值类型
 *
 * @example
 * ```ts
 * isNumericType('INTEGER')  // true
 * isNumericType('VARCHAR')  // false
 * isNumericType('DECIMAL(10,2)')  // true
 * ```
 */
export function isNumericType(duckdbType: string): boolean {
  if (!duckdbType) return false;
  const upperType = duckdbType.toUpperCase();
  return NUMERIC_TYPES.some((t) => upperType.includes(t));
}

/**
 * 判断是否为日期时间类型
 *
 * @param duckdbType - DuckDB类型字符串
 * @returns 是否为日期时间类型
 *
 * @example
 * ```ts
 * isDateType('DATE')  // true
 * isDateType('TIMESTAMP')  // true
 * isDateType('VARCHAR')  // false
 * ```
 */
export function isDateType(duckdbType: string): boolean {
  if (!duckdbType) return false;
  const upperType = duckdbType.toUpperCase();
  return DATE_TIME_TYPES.some((t) => upperType.includes(t));
}

/**
 * 判断是否为字符串类型
 *
 * @param duckdbType - DuckDB类型字符串
 * @returns 是否为字符串类型
 *
 * @example
 * ```ts
 * isStringType('VARCHAR')  // true
 * isStringType('TEXT')  // true
 * isStringType('INTEGER')  // false
 * ```
 */
export function isStringType(duckdbType: string): boolean {
  if (!duckdbType) return false;
  const upperType = duckdbType.toUpperCase();
  return STRING_TYPES.some((t) => upperType.includes(t));
}

/**
 * 判断是否为布尔类型
 *
 * @param duckdbType - DuckDB类型字符串
 * @returns 是否为布尔类型
 *
 * @example
 * ```ts
 * isBooleanType('BOOLEAN')  // true
 * isBooleanType('BOOL')  // true
 * isBooleanType('INTEGER')  // false
 * ```
 */
export function isBooleanType(duckdbType: string): boolean {
  if (!duckdbType) return false;
  const upperType = duckdbType.toUpperCase();
  return BOOLEAN_TYPES.some((t) => upperType.includes(t));
}

/**
 * 获取字段类型分类
 *
 * @param duckdbType - DuckDB类型字符串
 * @returns 字段类型分类
 *
 * @example
 * ```ts
 * getFieldTypeCategory('INTEGER')  // 'numeric'
 * getFieldTypeCategory('VARCHAR')  // 'string'
 * getFieldTypeCategory('DATE')  // 'date'
 * getFieldTypeCategory('BOOLEAN')  // 'boolean'
 * getFieldTypeCategory('JSON')  // 'other'
 * ```
 */
export function getFieldTypeCategory(duckdbType: string): FieldTypeCategory {
  if (isNumericType(duckdbType)) return 'numeric';
  if (isDateType(duckdbType)) return 'date';
  if (isStringType(duckdbType)) return 'string';
  if (isBooleanType(duckdbType)) return 'boolean';
  return 'other';
}

/**
 * 判断类型是否支持聚合运算（SUM, AVG等）
 *
 * @param duckdbType - DuckDB类型字符串
 * @returns 是否支持聚合运算
 */
export function supportsAggregation(duckdbType: string): boolean {
  return isNumericType(duckdbType);
}

/**
 * 判断类型是否支持排序
 *
 * @param duckdbType - DuckDB类型字符串
 * @returns 是否支持排序
 */
export function supportsSorting(duckdbType: string): boolean {
  // 大多数类型都支持排序
  return isNumericType(duckdbType) || isDateType(duckdbType) || isStringType(duckdbType);
}

/**
 * 获取类型的默认排序方式建议
 *
 * @param duckdbType - DuckDB类型字符串
 * @returns 推荐的排序标签（用于UI显示）
 */
export function getDefaultSortLabels(duckdbType: string): { asc: string; desc: string } {
  if (isNumericType(duckdbType)) {
    return { asc: '0 → 9', desc: '9 → 0' };
  }
  if (isDateType(duckdbType)) {
    return { asc: '旧 → 新', desc: '新 → 旧' };
  }
  return { asc: 'A → Z', desc: 'Z → A' };
}
