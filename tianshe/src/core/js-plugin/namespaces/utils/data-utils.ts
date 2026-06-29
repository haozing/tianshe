/**
 * 数据处理工具模块
 *
 * 提供常用的数据处理函数
 */

import { ValidationError } from '../../errors';
import { generateId as coreGenerateId } from '../../../../utils/id-generator';
import { clone as coreClone } from '../../../../utils/serialization';

/**
 * 数据处理工具类
 */
export class DataUtils {
  /**
   * 休眠指定毫秒数
   *
   * @param ms - 毫秒数
   *
   * @example
   * // 等待 1 秒
   * await dataUtils.sleep(1000);
   */
  async sleep(ms: number): Promise<void> {
    if (typeof ms !== 'number' || ms < 0) {
      throw new ValidationError('Sleep duration must be a non-negative number', {
        parameter: 'ms',
        expectedType: 'number (>= 0)',
        actualValue: ms,
      });
    }

    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 格式化日期为 ISO 字符串
   *
   * @param date - 日期对象或时间戳
   * @returns ISO 格式的日期字符串
   *
   * @example
   * const now = dataUtils.formatDate(new Date());
   * const timestamp = dataUtils.formatDate(Date.now());
   */
  formatDate(date: Date | number): string {
    if (date instanceof Date) {
      return date.toISOString();
    } else if (typeof date === 'number') {
      return new Date(date).toISOString();
    } else {
      throw new ValidationError('Date must be a Date object or timestamp', {
        parameter: 'date',
        expectedType: 'Date | number',
        actualValue: date,
      });
    }
  }

  /**
   * 深度克隆对象
   *
   * 支持处理循环引用、Date、RegExp 等特殊类型
   *
   * @param obj - 要克隆的对象
   * @returns 克隆后的对象
   *
   * @example
   * const cloned = dataUtils.clone(originalObject);
   */
  clone<T>(obj: T): T {
    try {
      return coreClone(obj);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError('Failed to clone object', {
        parameter: 'obj',
        originalError: message,
      });
    }
  }

  /**
   * 将对象数组转换为 Map
   *
   * @param array - 对象数组
   * @param keyField - 作为键的字段名
   * @returns Map 对象
   *
   * @example
   * const products = [
   *   { id: '1', name: 'Product A' },
   *   { id: '2', name: 'Product B' }
   * ];
   * const productMap = dataUtils.arrayToMap(products, 'id');
   * console.log(productMap.get('1').name); // 'Product A'
   */
  arrayToMap<T>(array: T[], keyField: keyof T): Map<any, T> {
    if (!Array.isArray(array)) {
      throw new ValidationError('First argument must be an array', {
        parameter: 'array',
        expectedType: 'array',
        actualValue: array,
      });
    }

    const map = new Map<any, T>();
    for (const item of array) {
      if (item && typeof item === 'object' && keyField in item) {
        map.set(item[keyField], item);
      }
    }

    return map;
  }

  /**
   * 将数组按指定字段分组
   *
   * @param array - 对象数组
   * @param keyField - 作为分组键的字段名
   * @returns 分组后的 Map
   *
   * @example
   * const products = [
   *   { category: 'A', name: 'Product 1' },
   *   { category: 'B', name: 'Product 2' },
   *   { category: 'A', name: 'Product 3' }
   * ];
   * const grouped = dataUtils.groupBy(products, 'category');
   * console.log(grouped.get('A').length); // 2
   */
  groupBy<T>(array: T[], keyField: keyof T): Map<any, T[]> {
    if (!Array.isArray(array)) {
      throw new ValidationError('First argument must be an array', {
        parameter: 'array',
        expectedType: 'array',
        actualValue: array,
      });
    }

    const groups = new Map<any, T[]>();
    for (const item of array) {
      if (item && typeof item === 'object' && keyField in item) {
        const key = item[keyField];
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(item);
      }
    }

    return groups;
  }

  /**
   * 将数组分批处理
   *
   * @param array - 原始数组
   * @param batchSize - 每批的大小
   * @returns 分批后的二维数组
   *
   * @example
   * const items = [1, 2, 3, 4, 5, 6, 7, 8, 9];
   * const batches = dataUtils.chunk(items, 3);
   * // [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
   */
  chunk<T>(array: T[], batchSize: number): T[][] {
    if (!Array.isArray(array)) {
      throw new ValidationError('First argument must be an array', {
        parameter: 'array',
        expectedType: 'array',
        actualValue: array,
      });
    }

    if (typeof batchSize !== 'number' || batchSize <= 0) {
      throw new ValidationError('Batch size must be a positive number', {
        parameter: 'batchSize',
        expectedType: 'number (> 0)',
        actualValue: batchSize,
      });
    }

    const batches: T[][] = [];
    for (let i = 0; i < array.length; i += batchSize) {
      batches.push(array.slice(i, i + batchSize));
    }

    return batches;
  }

  /**
   * 生成唯一 ID
   *
   * @param prefix - ID 前缀（默认 'plugin'）
   * @returns 唯一的字符串 ID
   *
   * @example
   * const id = dataUtils.generateId();
   * console.log(id); // 'plugin_1704067200000_a1b2c3d4'
   *
   * const taskId = dataUtils.generateId('task');
   * console.log(taskId); // 'task_1704067200000_b2c3d4e5'
   */
  generateId(prefix: string = 'plugin'): string {
    return coreGenerateId(prefix);
  }

  /**
   * 生成指定长度的随机字符串
   *
   * @param length - 字符串长度
   * @param charset - 字符集（默认为数字和字母）
   * @returns 随机字符串
   *
   * @example
   * const code = dataUtils.randomString(8);
   * const numericCode = dataUtils.randomString(6, '0123456789');
   */
  randomString(length: number, charset?: string): string {
    if (typeof length !== 'number' || length <= 0) {
      throw new ValidationError('Length must be a positive number', {
        parameter: 'length',
        expectedType: 'number (> 0)',
        actualValue: length,
      });
    }

    const defaultCharset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const chars = charset || defaultCharset;

    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return result;
  }
}
