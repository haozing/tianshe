import { describe, expect, it } from 'vitest';
import {
  assertDatasetColumnNamePolicy,
  DATASET_COLUMN_NAME_MESSAGES,
  validateDatasetColumnNamePolicy,
} from './dataset-column-name-policy';

describe('dataset column name policy', () => {
  it('accepts normalized user-facing column names', () => {
    expect(validateDatasetColumnNamePolicy(' 客户_1 ').normalizedName).toBe('客户_1');
    expect(assertDatasetColumnNamePolicy('status_2026')).toBe('status_2026');
  });

  it('rejects empty, long, unsafe, and system column names', () => {
    expect(validateDatasetColumnNamePolicy('')).toMatchObject({
      valid: false,
      message: DATASET_COLUMN_NAME_MESSAGES.empty,
    });
    expect(validateDatasetColumnNamePolicy('a'.repeat(51))).toMatchObject({
      valid: false,
      message: DATASET_COLUMN_NAME_MESSAGES.tooLong,
    });
    expect(validateDatasetColumnNamePolicy('bad-name')).toMatchObject({
      valid: false,
      message: DATASET_COLUMN_NAME_MESSAGES.invalidCharacters,
    });
    expect(validateDatasetColumnNamePolicy('_row_id')).toMatchObject({
      valid: false,
      message: DATASET_COLUMN_NAME_MESSAGES.systemField,
    });
  });

  it('throws the policy message from the assertion helper', () => {
    expect(() => assertDatasetColumnNamePolicy('bad name')).toThrow(
      DATASET_COLUMN_NAME_MESSAGES.invalidCharacters
    );
  });
});
