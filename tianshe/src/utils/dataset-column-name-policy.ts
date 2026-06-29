import { isSystemField } from './dataset-column-capabilities';

export const DATASET_COLUMN_NAME_MAX_LENGTH = 50;
export const DATASET_COLUMN_NAME_ALLOWED_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_]+$/u;

export const DATASET_COLUMN_NAME_MESSAGES = {
  empty: '列名不能为空',
  tooLong: `列名不能超过${DATASET_COLUMN_NAME_MAX_LENGTH}个字符`,
  invalidCharacters: '列名只能包含中文、字母、数字和下划线',
  systemField: '列名不能为系统字段',
} as const;

export type DatasetColumnNameValidationCode =
  | 'empty'
  | 'too-long'
  | 'invalid-characters'
  | 'system-field';

export interface DatasetColumnNameValidationResult {
  valid: boolean;
  message: string;
  normalizedName: string;
  code?: DatasetColumnNameValidationCode;
}

export function validateDatasetColumnNamePolicy(
  columnName: unknown
): DatasetColumnNameValidationResult {
  const normalizedName = typeof columnName === 'string' ? columnName.trim() : '';

  if (!normalizedName) {
    return {
      valid: false,
      message: DATASET_COLUMN_NAME_MESSAGES.empty,
      normalizedName,
      code: 'empty',
    };
  }

  if (normalizedName.length > DATASET_COLUMN_NAME_MAX_LENGTH) {
    return {
      valid: false,
      message: DATASET_COLUMN_NAME_MESSAGES.tooLong,
      normalizedName,
      code: 'too-long',
    };
  }

  if (!DATASET_COLUMN_NAME_ALLOWED_PATTERN.test(normalizedName)) {
    return {
      valid: false,
      message: DATASET_COLUMN_NAME_MESSAGES.invalidCharacters,
      normalizedName,
      code: 'invalid-characters',
    };
  }

  if (isSystemField(normalizedName)) {
    return {
      valid: false,
      message: DATASET_COLUMN_NAME_MESSAGES.systemField,
      normalizedName,
      code: 'system-field',
    };
  }

  return {
    valid: true,
    message: '列名可用',
    normalizedName,
  };
}

export function assertDatasetColumnNamePolicy(columnName: unknown): string {
  const result = validateDatasetColumnNamePolicy(columnName);
  if (!result.valid) {
    throw new Error(result.message);
  }

  return result.normalizedName;
}
