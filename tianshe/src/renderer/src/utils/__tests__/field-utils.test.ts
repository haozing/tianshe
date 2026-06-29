import { describe, expect, it } from 'vitest';
import {
  filterSystemFields,
  filterSystemFieldsFromArray,
  filterSystemFieldsFromSchema,
  filterWritableFieldsFromSchema,
  formatUserFriendlyError,
  isDateType,
  isNumericType,
  isSystemField,
  isWritableColumn,
  normalizeRecordValues,
  validateRecord,
  validateRecords,
} from '../field-utils';

describe('isSystemField', () => {
  it('recognizes system fields', () => {
    expect(isSystemField('_row_id')).toBe(true);
    expect(isSystemField('deleted_at')).toBe(true);
    expect(isSystemField('created_at')).toBe(true);
    expect(isSystemField('updated_at')).toBe(true);
  });

  it('does not treat normal fields as system fields', () => {
    expect(isSystemField('name')).toBe(false);
    expect(isSystemField('price')).toBe(false);
    expect(isSystemField('row_id')).toBe(false);
  });
});

describe('filterSystemFields', () => {
  it('removes all system fields from a record', () => {
    const record = {
      _row_id: 1,
      deleted_at: null,
      name: 'Product A',
      price: 100,
    };

    expect(filterSystemFields(record)).toEqual({ name: 'Product A', price: 100 });
  });

  it('handles empty records', () => {
    expect(filterSystemFields({})).toEqual({});
  });

  it('returns an empty object when a record only contains system fields', () => {
    expect(filterSystemFields({ _row_id: 1, deleted_at: null })).toEqual({});
  });
});

describe('filterSystemFieldsFromArray', () => {
  it('removes system fields from each record', () => {
    expect(
      filterSystemFieldsFromArray([
        { _row_id: 1, name: 'A', price: 100 },
        { _row_id: 2, name: 'B', price: 200 },
      ])
    ).toEqual([
      { name: 'A', price: 100 },
      { name: 'B', price: 200 },
    ]);
  });

  it('handles an empty array', () => {
    expect(filterSystemFieldsFromArray([])).toEqual([]);
  });
});

describe('schema column filters', () => {
  it('removes system fields from schema', () => {
    const schema = [
      { name: '_row_id', type: 'INTEGER' },
      { name: 'deleted_at', type: 'TIMESTAMP' },
      { name: 'product_name', type: 'VARCHAR' },
      { name: 'price', type: 'DOUBLE' },
    ];

    expect(filterSystemFieldsFromSchema(schema)).toEqual([
      { name: 'product_name', type: 'VARCHAR' },
      { name: 'price', type: 'DOUBLE' },
    ]);
  });

  it('keeps only writable physical columns', () => {
    const schema = [
      { name: '_row_id', fieldType: 'number', storageMode: 'physical' as const },
      { name: 'name', fieldType: 'text', storageMode: 'physical' as const },
      { name: 'files', fieldType: 'attachment', storageMode: 'physical' as const },
      { name: 'action', fieldType: 'button', storageMode: 'physical' as const },
      { name: 'total', fieldType: 'number', storageMode: 'computed' as const },
      { name: 'locked_name', fieldType: 'text', storageMode: 'physical' as const, locked: true },
    ];

    expect(filterWritableFieldsFromSchema(schema)).toEqual([
      { name: 'name', fieldType: 'text', storageMode: 'physical' },
    ]);
  });
});

describe('isWritableColumn', () => {
  it('identifies writable and non-writable columns correctly', () => {
    expect(
      isWritableColumn({ name: 'name', fieldType: 'text', storageMode: 'physical' })
    ).toBe(true);
    expect(
      isWritableColumn({ name: 'total', fieldType: 'number', storageMode: 'computed' })
    ).toBe(false);
    expect(
      isWritableColumn({ name: 'action', fieldType: 'button', storageMode: 'physical' })
    ).toBe(false);
    expect(
      isWritableColumn({ name: 'files', fieldType: 'attachment', storageMode: 'physical' })
    ).toBe(false);
    expect(
      isWritableColumn({ name: 'created_at', fieldType: 'date', storageMode: 'physical' })
    ).toBe(false);
    expect(
      isWritableColumn({
        name: 'locked_name',
        fieldType: 'text',
        storageMode: 'physical',
        locked: true,
      })
    ).toBe(false);
  });
});

describe('isNumericType', () => {
  it('recognizes numeric types', () => {
    expect(isNumericType('INTEGER')).toBe(true);
    expect(isNumericType('BIGINT')).toBe(true);
    expect(isNumericType('DOUBLE')).toBe(true);
    expect(isNumericType('DECIMAL(10,2)')).toBe(true);
    expect(isNumericType('FLOAT')).toBe(true);
  });

  it('does not treat non-numeric types as numeric', () => {
    expect(isNumericType('VARCHAR')).toBe(false);
    expect(isNumericType('TEXT')).toBe(false);
    expect(isNumericType('DATE')).toBe(false);
    expect(isNumericType('TIMESTAMP')).toBe(false);
  });
});

describe('isDateType', () => {
  it('recognizes date-like types', () => {
    expect(isDateType('DATE')).toBe(true);
    expect(isDateType('TIMESTAMP')).toBe(true);
    expect(isDateType('DATETIME')).toBe(true);
    expect(isDateType('TIME')).toBe(true);
  });

  it('does not treat non-date types as date-like', () => {
    expect(isDateType('VARCHAR')).toBe(false);
    expect(isDateType('INTEGER')).toBe(false);
    expect(isDateType('DOUBLE')).toBe(false);
  });
});

describe('normalizeRecordValues', () => {
  const schema = [
    { name: '产品名称', fieldType: 'text', duckdbType: 'VARCHAR' },
    { name: '价格', fieldType: 'number', duckdbType: 'DOUBLE' },
    { name: '发布日期', fieldType: 'date', duckdbType: 'DATE' },
  ];

  it('converts empty strings to null for non-text fields', () => {
    expect(normalizeRecordValues({ 产品名称: '', 价格: '', 发布日期: '' }, schema)).toEqual({
      产品名称: '',
      价格: null,
      发布日期: null,
    });
  });

  it('keeps non-empty values unchanged', () => {
    expect(
      normalizeRecordValues({ 产品名称: 'A', 价格: '100', 发布日期: '2024-01-01' }, schema)
    ).toEqual({
      产品名称: 'A',
      价格: '100',
      发布日期: '2024-01-01',
    });
  });
});

describe('validateRecord', () => {
  const schema = [
    { name: '产品名称', fieldType: 'text', duckdbType: 'VARCHAR' },
    { name: '价格', fieldType: 'number', duckdbType: 'DOUBLE' },
    { name: '发布日期', fieldType: 'date', duckdbType: 'DATE' },
  ];

  it('accepts valid data', () => {
    const result = validateRecord(
      { 产品名称: 'A', 价格: '100', 发布日期: '2024-01-01' },
      schema
    );
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts empty values before normalization', () => {
    const result = validateRecord({ 产品名称: '', 价格: '', 发布日期: '' }, schema);
    expect(result.isValid).toBe(true);
  });

  it('rejects invalid numeric values', () => {
    const result = validateRecord(
      { 产品名称: 'A', 价格: 'abc', 发布日期: '2024-01-01' },
      schema
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain('价格');
  });

  it('rejects invalid date values', () => {
    const result = validateRecord(
      { 产品名称: 'A', 价格: '100', 发布日期: 'invalid-date' },
      schema
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain('发布日期');
  });

  it('accepts several date formats', () => {
    for (const date of [
      '2024-01-01',
      '2024/01/01',
      '2024-1-1',
      '2024-01-01 10:30',
      '2024-01-01 10:30:45',
    ]) {
      expect(
        validateRecord({ 产品名称: 'A', 价格: '100', 发布日期: date }, schema).isValid
      ).toBe(true);
    }
  });

  it('accepts numeric values already typed as numbers', () => {
    expect(
      validateRecord({ 产品名称: 'A', 价格: 100, 发布日期: '2024-01-01' }, schema).isValid
    ).toBe(true);
  });

  it('collects multiple errors', () => {
    const result = validateRecord({ 产品名称: 'A', 价格: 'abc', 发布日期: 'invalid' }, schema);
    expect(result.isValid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

describe('validateRecords', () => {
  const schema = [
    { name: '名称', fieldType: 'text', duckdbType: 'VARCHAR' },
    { name: '价格', fieldType: 'number', duckdbType: 'DOUBLE' },
  ];

  it('accepts valid record arrays', () => {
    expect(
      validateRecords(
        [
          { 名称: 'A', 价格: '100' },
          { 名称: 'B', 价格: '200' },
        ],
        schema
      ).isValid
    ).toBe(true);
  });

  it('reports row-scoped validation errors', () => {
    const result = validateRecords(
      [
        { 名称: 'A', 价格: '100' },
        { 名称: 'B', 价格: 'invalid' },
        { 名称: 'C', 价格: 'also-invalid' },
      ],
      schema
    );

    expect(result.isValid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('2');
    expect(result.errors[1]).toContain('3');
  });
});

describe('formatUserFriendlyError', () => {
  it('formats NOT NULL constraint errors', () => {
    expect(formatUserFriendlyError('NOT NULL constraint failed: ds_xxx.data.产品名称')).toBe(
      '字段"产品名称"不能为空'
    );
  });

  it('formats generic NOT NULL constraint errors', () => {
    expect(formatUserFriendlyError('NOT NULL constraint failed')).toBe('存在必填字段未填写');
  });

  it('formats UNIQUE constraint errors', () => {
    expect(formatUserFriendlyError('UNIQUE constraint failed: ds_xxx.data.email')).toBe(
      '字段"email"的值已存在，不能重复'
    );
  });

  it('formats type conversion errors', () => {
    expect(formatUserFriendlyError('Could not convert string to number')).toBe(
      '数据类型不匹配，请检查输入值的格式'
    );
  });

  it('formats database lock errors', () => {
    expect(formatUserFriendlyError('database is locked')).toBe('数据库正忙，请稍后重试');
  });

  it('formats non-writable column errors', () => {
    expect(formatUserFriendlyError('Columns are not writable: total, action')).toContain(
      'total, action'
    );
  });

  it('formats unknown column errors', () => {
    expect(formatUserFriendlyError('Unknown columns: ghost_field')).toContain('ghost_field');
  });

  it('returns unknown errors unchanged', () => {
    expect(formatUserFriendlyError('Unknown error occurred')).toBe('Unknown error occurred');
  });
});
