/**
 * 通用验证工具函数
 *
 * 提供可复用的验证逻辑，消除各 service 中的重复验证代码
 */

/**
 * 验证结果类型
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 创建验证结果
 */
export function createValidationResult(errors: string[] = []): ValidationResult {
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 验证必填字段
 *
 * @param value 要验证的值
 * @param fieldName 字段名称（用于错误消息）
 * @param context 上下文名称（如 'WritebackConfig'）
 * @returns 错误消息或 null
 *
 * @example
 * validateRequired(config.sourceDatasetId, 'sourceDatasetId', 'Writeback')
 * // 返回: 'Writeback requires sourceDatasetId' 或 null
 */
export function validateRequired(
  value: unknown,
  fieldName: string,
  context?: string
): string | null {
  if (value === undefined || value === null || value === '') {
    const prefix = context ? `${context} requires` : 'Required field:';
    return `${prefix} ${fieldName}`;
  }
  return null;
}

/**
 * 验证数组非空
 *
 * @param value 要验证的数组
 * @param fieldName 字段名称
 * @param context 上下文名称
 * @param minLength 最小长度（默认 1）
 * @returns 错误消息或 null
 */
export function validateArrayNotEmpty(
  value: unknown[],
  fieldName: string,
  context?: string,
  minLength: number = 1
): string | null {
  if (!value || !Array.isArray(value) || value.length < minLength) {
    const prefix = context ? `${context} requires` : 'Required:';
    return `${prefix} at least ${minLength} ${fieldName}`;
  }
  return null;
}

/**
 * 验证枚举值
 *
 * @param value 要验证的值
 * @param allowedValues 允许的值列表
 * @param fieldName 字段名称
 * @param context 上下文名称
 * @returns 错误消息或 null
 */
export function validateEnum<T>(
  value: T,
  allowedValues: T[],
  fieldName: string,
  context?: string
): string | null {
  if (!allowedValues.includes(value)) {
    const prefix = context ? `Invalid ${context}` : 'Invalid';
    return `${prefix} ${fieldName}: ${value}. Must be one of: ${allowedValues.join(', ')}`;
  }
  return null;
}

/**
 * 验证正数
 *
 * @param value 要验证的值
 * @param fieldName 字段名称
 * @param context 上下文名称
 * @returns 错误消息或 null
 */
export function validatePositiveNumber(
  value: number | undefined,
  fieldName: string,
  context?: string
): string | null {
  if (value !== undefined && (typeof value !== 'number' || value <= 0)) {
    const prefix = context ? `${context}:` : '';
    return `${prefix} ${fieldName} must be a positive number`;
  }
  return null;
}

/**
 * 验证列是否存在于 schema 中
 *
 * @param schema 数据集 schema
 * @param columns 要验证的列名列表
 * @param context 上下文名称
 * @returns 错误消息列表
 */
export function validateColumnsExist(
  schema: Array<{ name: string; [key: string]: unknown }>,
  columns: string[],
  context?: string
): string[] {
  const schemaColumns = new Set(schema.map((col) => col.name));
  const errors: string[] = [];

  columns.forEach((col) => {
    if (!schemaColumns.has(col)) {
      const prefix = context ? `${context}:` : '';
      errors.push(`${prefix} Column not found in dataset: ${col}`);
    }
  });

  return errors;
}

/**
 * 验证列名唯一性
 *
 * @param columns 列名列表
 * @param context 上下文名称
 * @returns 错误消息或 null
 */
export function validateUniqueColumns(columns: string[], context?: string): string | null {
  const uniqueColumns = new Set(columns);
  if (uniqueColumns.size !== columns.length) {
    const duplicates = columns.filter((col, index) => columns.indexOf(col) !== index);
    const prefix = context ? `${context}:` : '';
    return `${prefix} Duplicate columns found: ${[...new Set(duplicates)].join(', ')}`;
  }
  return null;
}

/**
 * 验证条件依赖
 * 当某个字段有特定值时，另一个字段必须存在
 *
 * @param conditionField 条件字段值
 * @param conditionValue 触发依赖的值
 * @param dependentField 依赖字段值
 * @param dependentFieldName 依赖字段名称
 * @param context 上下文名称
 * @returns 错误消息或 null
 */
export function validateConditionalRequired<T>(
  conditionField: T,
  conditionValue: T,
  dependentField: unknown,
  dependentFieldName: string,
  context?: string
): string | null {
  if (conditionField === conditionValue) {
    if (dependentField === undefined || dependentField === null) {
      const prefix = context ? `${context}:` : '';
      return `${prefix} ${dependentFieldName} is required when condition is met`;
    }
    // 特殊处理数组
    if (Array.isArray(dependentField) && dependentField.length === 0) {
      const prefix = context ? `${context}:` : '';
      return `${prefix} ${dependentFieldName} cannot be empty when condition is met`;
    }
  }
  return null;
}

/**
 * 组合多个验证函数
 *
 * @param validators 验证函数数组，每个返回 string | null
 * @returns ValidationResult
 *
 * @example
 * const result = combineValidations([
 *   () => validateRequired(config.table, 'table', 'Writeback'),
 *   () => validateEnum(config.mode, ['create', 'append'], 'mode', 'Writeback'),
 *   () => validateConditionalRequired(config.mode, 'upsert', config.primaryKeys, 'primaryKeys', 'Upsert'),
 * ]);
 */
export function combineValidations(validators: Array<() => string | null>): ValidationResult {
  const errors: string[] = [];

  for (const validator of validators) {
    const error = validator();
    if (error) {
      errors.push(error);
    }
  }

  return createValidationResult(errors);
}

/**
 * 抛出验证错误（如果有）
 *
 * @param result 验证结果
 * @throws Error 如果验证失败
 */
export function throwIfInvalid(result: ValidationResult): void {
  if (!result.valid) {
    throw new Error(result.errors.join('; '));
  }
}

/**
 * 创建验证器构建器
 * 提供流式 API 进行配置验证
 *
 * @example
 * createValidator('WritebackConfig')
 *   .required(config.sourceDatasetId, 'sourceDatasetId')
 *   .required(config.targetTable, 'targetTable')
 *   .enum(config.mode, ['create', 'replace', 'append', 'upsert'], 'mode')
 *   .conditionalRequired(config.mode, 'upsert', config.primaryKeys, 'primaryKeys')
 *   .throwIfInvalid();
 */
export function createValidator(context: string) {
  const errors: string[] = [];

  const validator = {
    required(value: unknown, fieldName: string) {
      const error = validateRequired(value, fieldName, context);
      if (error) errors.push(error);
      return validator;
    },

    arrayNotEmpty(value: unknown[], fieldName: string, minLength: number = 1) {
      const error = validateArrayNotEmpty(value, fieldName, context, minLength);
      if (error) errors.push(error);
      return validator;
    },

    enum<T>(value: T, allowedValues: T[], fieldName: string) {
      const error = validateEnum(value, allowedValues, fieldName, context);
      if (error) errors.push(error);
      return validator;
    },

    positiveNumber(value: number | undefined, fieldName: string) {
      const error = validatePositiveNumber(value, fieldName, context);
      if (error) errors.push(error);
      return validator;
    },

    columnsExist(schema: Array<{ name: string }>, columns: string[]) {
      const colErrors = validateColumnsExist(schema, columns, context);
      errors.push(...colErrors);
      return validator;
    },

    uniqueColumns(columns: string[]) {
      const error = validateUniqueColumns(columns, context);
      if (error) errors.push(error);
      return validator;
    },

    conditionalRequired<T>(
      conditionField: T,
      conditionValue: T,
      dependentField: unknown,
      dependentFieldName: string
    ) {
      const error = validateConditionalRequired(
        conditionField,
        conditionValue,
        dependentField,
        dependentFieldName,
        context
      );
      if (error) errors.push(error);
      return validator;
    },

    custom(errorOrNull: string | null) {
      if (errorOrNull) errors.push(errorOrNull);
      return validator;
    },

    getResult(): ValidationResult {
      return createValidationResult(errors);
    },

    throwIfInvalid() {
      if (errors.length > 0) {
        throw new Error(errors.join('; '));
      }
    },
  };

  return validator;
}
