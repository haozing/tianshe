/**
 * 验证工具模块
 *
 * 提供 JSON Schema 验证功能
 */

import Ajv from 'ajv';
import { ValidationError } from '../../errors';

/**
 * 验证工具类
 */
export class ValidationUtils {
  /** JSON Schema 验证器 */
  private ajv = new Ajv({ allErrors: true, strict: false });

  /**
   * 验证参数是否符合 JSON Schema
   *
   * @param data - 要验证的数据
   * @param schema - JSON Schema 定义
   * @returns 验证结果
   *
   * @example
   * const result = validation.validate(
   *   { price: 99.9, status: 'active' },
   *   {
   *     type: 'object',
   *     properties: {
   *       price: { type: 'number', minimum: 0 },
   *       status: { type: 'string', enum: ['active', 'inactive'] }
   *     },
   *     required: ['price']
   *   }
   * );
   *
   * if (!result.valid) {
   *   console.error('Validation errors:', result.errors);
   * }
   */
  validate(data: any, schema: any): { valid: boolean; errors?: any[] } {
    try {
      const validate = this.ajv.compile(schema);
      const valid = validate(data);

      if (!valid) {
        return {
          valid: false,
          errors: validate.errors || [],
        };
      }

      return { valid: true };
    } catch (error: any) {
      throw new ValidationError(`Failed to validate parameters: ${error.message}`, {
        schema,
        data,
        originalError: error.message,
      });
    }
  }

  /**
   * 验证参数并抛出错误（如果验证失败）
   *
   * @param data - 要验证的数据
   * @param schema - JSON Schema 定义
   * @throws {ValidationError} 如果验证失败
   *
   * @example
   * validation.validateOrThrow(params, {
   *   type: 'object',
   *   properties: {
   *     productId: { type: 'string' },
   *     price: { type: 'number', minimum: 0 }
   *   },
   *   required: ['productId', 'price']
   * });
   */
  validateOrThrow(data: any, schema: any): void {
    const result = this.validate(data, schema);
    if (!result.valid) {
      throw new ValidationError('Parameter validation failed', {
        validationErrors: result.errors,
        data,
        schema,
      });
    }
  }
}
