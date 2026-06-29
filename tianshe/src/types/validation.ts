/**
 * 字段验证规则系统
 * 支持多种验证类型：必填、范围、正则、自定义等
 */

export type ValidationType =
  | 'required' // 必填
  | 'min' // 最小值（数字）
  | 'max' // 最大值（数字）
  | 'minLength' // 最小长度（字符串）
  | 'maxLength' // 最大长度（字符串）
  | 'pattern' // 正则表达式
  | 'email' // 邮箱格式
  | 'url' // URL格式
  | 'custom' // 自定义验证函数
  | 'unique' // 唯一性验证
  | 'dateRange'; // 日期范围

export interface ValidationRule {
  type: ValidationType;
  message?: string; // 自定义错误消息
  value?: any; // 验证参数（如最小值、正则表达式等）
  customValidator?: (value: any, row?: any) => boolean | Promise<boolean>; // 自定义验证函数
}

export interface FieldValidationConfig {
  fieldName: string;
  rules: ValidationRule[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 验证引擎
 */
export class ValidationEngine {
  /**
   * 验证单个字段
   */
  static async validateField(
    value: any,
    rules: ValidationRule[],
    row?: any
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    for (const rule of rules) {
      const result = await this.validateRule(value, rule, row);
      if (!result.valid) {
        errors.push(result.message);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 验证单条规则
   */
  private static async validateRule(
    value: any,
    rule: ValidationRule,
    row?: any
  ): Promise<{ valid: boolean; message: string }> {
    const defaultMessage = this.getDefaultMessage(rule.type);
    const message = rule.message || defaultMessage;

    switch (rule.type) {
      case 'required':
        return {
          valid: value !== null && value !== undefined && value !== '',
          message,
        };

      case 'min':
        return {
          valid: typeof value === 'number' && value >= (rule.value as number),
          message: message.replace('{min}', String(rule.value)),
        };

      case 'max':
        return {
          valid: typeof value === 'number' && value <= (rule.value as number),
          message: message.replace('{max}', String(rule.value)),
        };

      case 'minLength':
        return {
          valid: typeof value === 'string' && value.length >= (rule.value as number),
          message: message.replace('{minLength}', String(rule.value)),
        };

      case 'maxLength':
        return {
          valid: typeof value === 'string' && value.length <= (rule.value as number),
          message: message.replace('{maxLength}', String(rule.value)),
        };

      case 'pattern': {
        const regex = new RegExp(rule.value as string);
        return {
          valid: typeof value === 'string' && regex.test(value),
          message,
        };
      }

      case 'email': {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return {
          valid: typeof value === 'string' && emailRegex.test(value),
          message,
        };
      }

      case 'url':
        try {
          new URL(value);
          return { valid: true, message };
        } catch {
          return { valid: false, message };
        }

      case 'custom':
        if (rule.customValidator) {
          const valid = await rule.customValidator(value, row);
          return { valid, message };
        }
        return { valid: true, message };

      case 'unique':
        // 唯一性验证需要后端支持，这里先返回true
        // 实际实现需要查询数据库
        return { valid: true, message };

      case 'dateRange': {
        // 日期范围验证
        const { min: minDate, max: maxDate } = rule.value as { min?: Date; max?: Date };
        const date = new Date(value);
        let valid = !isNaN(date.getTime());

        if (valid && minDate) {
          valid = date >= minDate;
        }
        if (valid && maxDate) {
          valid = date <= maxDate;
        }

        return { valid, message };
      }

      default:
        return { valid: true, message: '' };
    }
  }

  /**
   * 获取默认错误消息
   */
  private static getDefaultMessage(type: ValidationType): string {
    const messages: Record<ValidationType, string> = {
      required: '此字段为必填项',
      min: '值不能小于 {min}',
      max: '值不能大于 {max}',
      minLength: '长度不能少于 {minLength} 个字符',
      maxLength: '长度不能超过 {maxLength} 个字符',
      pattern: '格式不正确',
      email: '请输入有效的邮箱地址',
      url: '请输入有效的URL',
      custom: '验证失败',
      unique: '该值已存在',
      dateRange: '日期不在有效范围内',
    };

    return messages[type];
  }
}

/**
 * 预定义的常用验证规则
 */
export const commonValidationRules = {
  required: (): ValidationRule => ({
    type: 'required',
    message: '此字段为必填项',
  }),

  email: (): ValidationRule => ({
    type: 'email',
    message: '请输入有效的邮箱地址',
  }),

  url: (): ValidationRule => ({
    type: 'url',
    message: '请输入有效的URL',
  }),

  minLength: (length: number): ValidationRule => ({
    type: 'minLength',
    value: length,
    message: `长度不能少于 ${length} 个字符`,
  }),

  maxLength: (length: number): ValidationRule => ({
    type: 'maxLength',
    value: length,
    message: `长度不能超过 ${length} 个字符`,
  }),

  min: (value: number): ValidationRule => ({
    type: 'min',
    value,
    message: `值不能小于 ${value}`,
  }),

  max: (value: number): ValidationRule => ({
    type: 'max',
    value,
    message: `值不能大于 ${value}`,
  }),

  pattern: (regex: string, message?: string): ValidationRule => ({
    type: 'pattern',
    value: regex,
    message: message || '格式不正确',
  }),

  phone: (): ValidationRule => ({
    type: 'pattern',
    value: '^1[3-9]\\d{9}$',
    message: '请输入有效的手机号码',
  }),

  idCard: (): ValidationRule => ({
    type: 'pattern',
    value: '^(\\d{15}|\\d{18}|\\d{17}X)$',
    message: '请输入有效的身份证号码',
  }),
};
