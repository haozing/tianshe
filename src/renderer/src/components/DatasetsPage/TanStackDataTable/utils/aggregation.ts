/**
 * 聚合函数工具
 * 提供各种数据聚合功能
 */

import { AggregationFn } from '@tanstack/react-table';

/**
 * 自定义聚合函数
 */
export const customAggregationFns = {
  /**
   * 数值范围 (min-max)
   */
  range: ((columnId, leafRows) => {
    const values = leafRows
      .map((row) => row.getValue<number>(columnId))
      .filter((val) => typeof val === 'number' && !isNaN(val));

    if (values.length === 0) return null;

    const min = Math.min(...values);
    const max = Math.max(...values);

    return `${min.toFixed(2)} ~ ${max.toFixed(2)}`;
  }) as AggregationFn<any>,

  /**
   * 计数（非空值）
   */
  countNonEmpty: ((columnId, leafRows) => {
    return leafRows.filter((row) => {
      const val = row.getValue(columnId);
      return val !== null && val !== undefined && val !== '';
    }).length;
  }) as AggregationFn<any>,

  /**
   * 唯一值计数
   */
  uniqueCount: ((columnId, leafRows) => {
    const uniqueValues = new Set(
      leafRows
        .map((row) => row.getValue(columnId))
        .filter((val) => val !== null && val !== undefined)
    );
    return uniqueValues.size;
  }) as AggregationFn<any>,

  /**
   * 百分比（相对于总数）
   */
  percentage: ((columnId, leafRows, _childRows) => {
    const value = leafRows.reduce((sum, row) => sum + (Number(row.getValue(columnId)) || 0), 0);
    // 这里需要总数，实际使用时可能需要从外部传入
    return value;
  }) as AggregationFn<any>,

  /**
   * 中位数
   */
  median: ((columnId, leafRows) => {
    const values = leafRows
      .map((row) => row.getValue<number>(columnId))
      .filter((val) => typeof val === 'number' && !isNaN(val))
      .sort((a, b) => a - b);

    if (values.length === 0) return null;

    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  }) as AggregationFn<any>,
};

/**
 * 根据数据类型推荐聚合函数
 */
export function getDefaultAggregationFn(
  sampleValue: any
): 'sum' | 'mean' | 'count' | 'min' | 'max' {
  if (typeof sampleValue === 'number') {
    // 数值类型默认求和
    return 'sum';
  }

  if (typeof sampleValue === 'string') {
    // 字符串类型默认计数
    return 'count';
  }

  if (sampleValue instanceof Date) {
    // 日期类型默认计数
    return 'count';
  }

  return 'count';
}

/**
 * 格式化聚合值
 */
export function formatAggregatedValue(
  value: any,
  aggregationType: string,
  options?: {
    currency?: boolean;
    decimals?: number;
  }
): string {
  if (value === null || value === undefined) {
    return '-';
  }

  if (typeof value === 'number') {
    const decimals = options?.decimals ?? (aggregationType === 'mean' ? 2 : 0);

    const formatted = value.toLocaleString('zh-CN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });

    if (options?.currency) {
      return `¥${formatted}`;
    }

    return formatted;
  }

  return String(value);
}
