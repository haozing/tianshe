/**
 * Utils Namespace
 *
 * 提供工具函数的命名空间接口
 * 包括参数验证、日期处理、字符串操作、定时任务等实用工具
 *
 * 采用门面模式，整合 validation、data-utils、interval 三个子模块
 */

import { ValidationUtils } from './validation';
import { DataUtils } from './data-utils';
import { IntervalUtils, type TaskController, type IntervalOptions } from './interval';

// 重导出类型
export type { TaskController, IntervalOptions };

/**
 * 工具命名空间
 *
 * 提供参数验证、数据处理、定时任务等实用工具函数
 *
 * @example
 * // 验证参数
 * const result = helpers.utils.validate(data, schema);
 * if (!result.valid) {
 *   console.error('Validation errors:', result.errors);
 * }
 *
 * @example
 * // 创建安全的定时任务
 * helpers.utils.createInterval(async () => {
 *   await pollData();
 * }, 60000, { immediate: true, skipIfRunning: true });
 */
export class UtilsNamespace {
  private validation: ValidationUtils;
  private data: DataUtils;
  private interval: IntervalUtils;

  constructor(
    private pluginId: string,
    private helpers?: any // PluginHelpers类型（避免循环依赖）
  ) {
    this.validation = new ValidationUtils();
    this.data = new DataUtils();
    this.interval = new IntervalUtils(pluginId, helpers);
  }

  // ========================================
  // 验证方法
  // ========================================

  /**
   * 验证参数是否符合 JSON Schema
   *
   * @param data - 要验证的数据
   * @param schema - JSON Schema 定义
   * @returns 验证结果
   */
  validate(data: any, schema: any): { valid: boolean; errors?: any[] } {
    return this.validation.validate(data, schema);
  }

  /**
   * 验证参数并抛出错误（如果验证失败）
   *
   * @param data - 要验证的数据
   * @param schema - JSON Schema 定义
   * @throws {ValidationError} 如果验证失败
   */
  validateOrThrow(data: any, schema: any): void {
    return this.validation.validateOrThrow(data, schema);
  }

  // ========================================
  // 数据处理方法
  // ========================================

  /**
   * 休眠指定毫秒数
   *
   * @param ms - 毫秒数
   */
  async sleep(ms: number): Promise<void> {
    return this.data.sleep(ms);
  }

  /**
   * 格式化日期为 ISO 字符串
   *
   * @param date - 日期对象或时间戳
   * @returns ISO 格式的日期字符串
   */
  formatDate(date: Date | number): string {
    return this.data.formatDate(date);
  }

  /**
   * 深度克隆对象
   *
   * @param obj - 要克隆的对象
   * @returns 克隆后的对象
   */
  clone<T>(obj: T): T {
    return this.data.clone(obj);
  }

  /**
   * 将对象数组转换为 Map
   *
   * @param array - 对象数组
   * @param keyField - 作为键的字段名
   * @returns Map 对象
   */
  arrayToMap<T>(array: T[], keyField: keyof T): Map<any, T> {
    return this.data.arrayToMap(array, keyField);
  }

  /**
   * 将数组按指定字段分组
   *
   * @param array - 对象数组
   * @param keyField - 作为分组键的字段名
   * @returns 分组后的 Map
   */
  groupBy<T>(array: T[], keyField: keyof T): Map<any, T[]> {
    return this.data.groupBy(array, keyField);
  }

  /**
   * 将数组分批处理
   *
   * @param array - 原始数组
   * @param batchSize - 每批的大小
   * @returns 分批后的二维数组
   */
  chunk<T>(array: T[], batchSize: number): T[][] {
    return this.data.chunk(array, batchSize);
  }

  /**
   * 生成唯一 ID
   *
   * @param prefix - ID 前缀（默认 'plugin'）
   * @returns 唯一的字符串 ID
   */
  generateId(prefix: string = 'plugin'): string {
    return this.data.generateId(prefix);
  }

  /**
   * 生成指定长度的随机字符串
   *
   * @param length - 字符串长度
   * @param charset - 字符集（默认为数字和字母）
   * @returns 随机字符串
   */
  randomString(length: number, charset?: string): string {
    return this.data.randomString(length, charset);
  }

  // ========================================
  // 定时任务方法
  // ========================================

  /**
   * 创建安全的定时任务（自动清理）
   *
   * @param handler - 任务处理函数
   * @param intervalMs - 执行间隔（毫秒）
   * @param options - 可选配置
   * @returns 任务控制器
   */
  createInterval(
    handler: () => Promise<void>,
    intervalMs: number,
    options?: IntervalOptions
  ): TaskController {
    return this.interval.createInterval(handler, intervalMs, options);
  }
}
