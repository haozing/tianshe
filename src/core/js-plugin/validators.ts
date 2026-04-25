/**
 * 参数验证工具类
 *
 * 提供统一的参数验证方法，避免代码重复
 */

import { ValidationError } from './errors';

export class ParamValidator {
  /**
   * 验证字符串参数
   *
   * @param value - 要验证的值
   * @param paramName - 参数名称
   * @param options - 验证选项
   *
   * @example
   * ParamValidator.validateString(datasetId, 'datasetId');
   *
   * @example
   * ParamValidator.validateString(sql, 'sql', { allowEmpty: true });
   */
  static validateString(value: any, paramName: string, options?: { allowEmpty?: boolean }): void {
    if (value === null || value === undefined || typeof value !== 'string') {
      throw new ValidationError(`${paramName} must be a non-empty string`, {
        parameter: paramName,
        expectedType: 'string',
        actualValue: value,
      });
    }

    if (!options?.allowEmpty && value.trim() === '') {
      throw new ValidationError(`${paramName} cannot be empty`, {
        parameter: paramName,
        expectedType: 'non-empty string',
        actualValue: value,
      });
    }
  }

  /**
   * 验证数字参数
   *
   * @param value - 要验证的值
   * @param paramName - 参数名称
   * @param options - 验证选项
   *
   * @example
   * ParamValidator.validateNumber(timeout, 'timeout', { min: 0 });
   *
   * @example
   * ParamValidator.validateNumber(port, 'port', { min: 1, max: 65535 });
   */
  static validateNumber(
    value: any,
    paramName: string,
    options?: { min?: number; max?: number; allowNaN?: boolean }
  ): void {
    if (typeof value !== 'number') {
      throw new ValidationError(`${paramName} must be a number`, {
        parameter: paramName,
        expectedType: 'number',
        actualValue: value,
      });
    }

    if (!options?.allowNaN && isNaN(value)) {
      throw new ValidationError(`${paramName} cannot be NaN`, {
        parameter: paramName,
        expectedType: 'valid number',
        actualValue: value,
      });
    }

    if (options?.min !== undefined && value < options.min) {
      throw new ValidationError(`${paramName} must be >= ${options.min}`, {
        parameter: paramName,
        expectedType: `number >= ${options.min}`,
        actualValue: value,
      });
    }

    if (options?.max !== undefined && value > options.max) {
      throw new ValidationError(`${paramName} must be <= ${options.max}`, {
        parameter: paramName,
        expectedType: `number <= ${options.max}`,
        actualValue: value,
      });
    }
  }

  /**
   * 验证数组参数
   *
   * @param value - 要验证的值
   * @param paramName - 参数名称
   * @param options - 验证选项
   *
   * @example
   * ParamValidator.validateArray(records, 'records');
   *
   * @example
   * ParamValidator.validateArray(records, 'records', { minLength: 1 });
   */
  static validateArray(
    value: any,
    paramName: string,
    options?: { minLength?: number; maxLength?: number; allowEmpty?: boolean }
  ): void {
    if (!Array.isArray(value)) {
      throw new ValidationError(`${paramName} must be an array`, {
        parameter: paramName,
        expectedType: 'array',
        actualValue: value,
      });
    }

    if (!options?.allowEmpty && value.length === 0) {
      throw new ValidationError(`${paramName} cannot be empty`, {
        parameter: paramName,
        expectedType: 'non-empty array',
        actualValue: value,
      });
    }

    if (options?.minLength !== undefined && value.length < options.minLength) {
      throw new ValidationError(`${paramName} must have at least ${options.minLength} element(s)`, {
        parameter: paramName,
        expectedType: `array with >= ${options.minLength} elements`,
        actualValue: value,
      });
    }

    if (options?.maxLength !== undefined && value.length > options.maxLength) {
      throw new ValidationError(`${paramName} must have at most ${options.maxLength} element(s)`, {
        parameter: paramName,
        expectedType: `array with <= ${options.maxLength} elements`,
        actualValue: value,
      });
    }
  }

  /**
   * 验证对象参数
   *
   * @param value - 要验证的值
   * @param paramName - 参数名称
   * @param options - 验证选项
   *
   * @example
   * ParamValidator.validateObject(updates, 'updates');
   *
   * @example
   * ParamValidator.validateObject(config, 'config', { allowEmpty: true });
   */
  static validateObject(value: any, paramName: string, options?: { allowEmpty?: boolean }): void {
    if (
      value === null ||
      value === undefined ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      throw new ValidationError(`${paramName} must be an object`, {
        parameter: paramName,
        expectedType: 'object',
        actualValue: value,
      });
    }

    if (!options?.allowEmpty && Object.keys(value).length === 0) {
      throw new ValidationError(`${paramName} cannot be empty`, {
        parameter: paramName,
        expectedType: 'non-empty object',
        actualValue: value,
      });
    }
  }

  /**
   * 验证非空值（排除 null 和 undefined）
   *
   * @param value - 要验证的值
   * @param paramName - 参数名称
   * @param expectedType - 期望的类型描述
   *
   * @example
   * ParamValidator.validateNotNullOrUndefined(rowId, 'rowId', 'number | string');
   */
  static validateNotNullOrUndefined(
    value: any,
    paramName: string,
    expectedType: string = 'any'
  ): void {
    if (value === null || value === undefined) {
      throw new ValidationError(`${paramName} cannot be null or undefined`, {
        parameter: paramName,
        expectedType,
        actualValue: value,
      });
    }
  }

  /**
   * 验证布尔值参数
   *
   * @param value - 要验证的值
   * @param paramName - 参数名称
   *
   * @example
   * ParamValidator.validateBoolean(isActive, 'isActive');
   */
  static validateBoolean(value: any, paramName: string): void {
    if (typeof value !== 'boolean') {
      throw new ValidationError(`${paramName} must be a boolean`, {
        parameter: paramName,
        expectedType: 'boolean',
        actualValue: value,
      });
    }
  }

  /**
   * 验证枚举值
   *
   * @param value - 要验证的值
   * @param paramName - 参数名称
   * @param allowedValues - 允许的值列表
   *
   * @example
   * ParamValidator.validateEnum(type, 'type', ['info', 'success', 'warning', 'error']);
   */
  static validateEnum<T>(value: any, paramName: string, allowedValues: T[]): void {
    if (!allowedValues.includes(value as T)) {
      throw new ValidationError(`${paramName} must be one of: ${allowedValues.join(', ')}`, {
        parameter: paramName,
        expectedType: `enum (${allowedValues.join(' | ')})`,
        actualValue: value,
        allowedValues,
      });
    }
  }

  // ========== 特定领域的便捷验证方法 ==========

  /**
   * 验证数据集ID
   *
   * @param datasetId - 数据集ID
   * @param paramName - 参数名称（默认：'datasetId'）
   *
   * @example
   * ParamValidator.validateDatasetId(datasetId);
   */
  static validateDatasetId(datasetId: any, paramName: string = 'datasetId'): void {
    this.validateString(datasetId, paramName);
  }

  /**
   * 验证配置键
   *
   * @param key - 配置键
   * @param paramName - 参数名称（默认：'key'）
   *
   * @example
   * ParamValidator.validateConfigKey(key);
   */
  static validateConfigKey(key: any, paramName: string = 'key'): void {
    this.validateString(key, paramName);
  }

  /**
   * 验证URL
   *
   * @param url - URL字符串
   * @param paramName - 参数名称（默认：'url'）
   *
   * @example
   * ParamValidator.validateURL(webhookUrl);
   */
  static validateURL(url: any, paramName: string = 'url'): void {
    this.validateString(url, paramName);

    // 验证URL格式
    try {
      new URL(url);
    } catch {
      throw new ValidationError(`${paramName} must be a valid URL`, {
        parameter: paramName,
        expectedType: 'valid URL',
        actualValue: url,
      });
    }
  }
}
