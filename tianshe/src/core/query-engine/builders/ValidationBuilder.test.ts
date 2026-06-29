/**
 * ValidationBuilder 单元测试
 * 测试重点：数据验证规则、标记/过滤、边界情况
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ValidationBuilder } from './ValidationBuilder';
import type { ValidationConfig, SQLContext } from '../types';

describe('ValidationBuilder', () => {
  let builder: ValidationBuilder;
  let context: SQLContext;

  beforeEach(() => {
    builder = new ValidationBuilder();
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set(['id', 'email', 'age', 'name', 'price', 'created_at']),
    };
  });

  describe('Numeric Validation', () => {
    it('should validate numeric fields with filter action', async () => {
      const config: ValidationConfig = [
        {
          field: 'age',
          rules: [
            {
              type: 'is_numeric',
              action: 'filter',
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('TRY_CAST(age AS DOUBLE) IS NOT NULL');
      expect(sql).toContain('WHERE');
    });

    it('should mark invalid numeric fields', async () => {
      const config: ValidationConfig = [
        {
          field: 'age',
          rules: [
            {
              type: 'is_numeric',
              action: 'mark',
              markColumn: 'age_is_valid',
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('TRY_CAST(age AS DOUBLE) IS NOT NULL AS age_is_valid');
      expect(sql).not.toContain('WHERE');
    });
  });

  describe('Date Validation', () => {
    it('should validate date fields', async () => {
      const config: ValidationConfig = [
        {
          field: 'created_at',
          rules: [
            {
              type: 'is_date',
              action: 'filter',
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('TRY_CAST(created_at AS DATE) IS NOT NULL');
    });
  });

  describe('Email Validation', () => {
    it('should validate email format', async () => {
      const config: ValidationConfig = [
        {
          field: 'email',
          rules: [
            {
              type: 'is_email',
              action: 'filter',
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('regexp_matches(email,');
      expect(sql).toContain('@');
    });
  });

  describe('Regex Validation', () => {
    it('should validate with custom regex pattern', async () => {
      const config: ValidationConfig = [
        {
          field: 'name',
          rules: [
            {
              type: 'regex',
              action: 'filter',
              params: {
                pattern: '^[A-Z][a-z]+',
              },
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('regexp_matches(name,');
      expect(sql).toContain('^[A-Z][a-z]+');
    });

    it('should throw error if pattern is missing', async () => {
      const config: ValidationConfig = [
        {
          field: 'name',
          rules: [
            {
              type: 'regex',
              action: 'filter',
              params: {},
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Enum Validation', () => {
    it('should validate enum values', async () => {
      const config: ValidationConfig = [
        {
          field: 'name',
          rules: [
            {
              type: 'enum',
              action: 'filter',
              params: {
                allowedValues: ['Alice', 'Bob', 'Charlie'],
              },
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('name IN');
      expect(sql).toContain("'Alice'");
      expect(sql).toContain("'Bob'");
      expect(sql).toContain("'Charlie'");
    });

    it('should throw error if allowedValues is empty', async () => {
      const config: ValidationConfig = [
        {
          field: 'name',
          rules: [
            {
              type: 'enum',
              action: 'filter',
              params: {
                allowedValues: [],
              },
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Range Validation', () => {
    it('should validate range with min and max', async () => {
      const config: ValidationConfig = [
        {
          field: 'age',
          rules: [
            {
              type: 'range',
              action: 'filter',
              params: {
                min: 18,
                max: 65,
              },
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('age::DOUBLE >= 18');
      expect(sql).toContain('age::DOUBLE <= 65');
      expect(sql).toContain(' AND ');
    });

    it('should validate range with only min', async () => {
      const config: ValidationConfig = [
        {
          field: 'price',
          rules: [
            {
              type: 'range',
              action: 'filter',
              params: {
                min: 0,
              },
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('price::DOUBLE >= 0');
      expect(sql).not.toContain('<=');
    });

    it('should throw error if both min and max are missing', async () => {
      const config: ValidationConfig = [
        {
          field: 'age',
          rules: [
            {
              type: 'range',
              action: 'filter',
              params: {},
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Length Validation', () => {
    it('should validate string length', async () => {
      const config: ValidationConfig = [
        {
          field: 'name',
          rules: [
            {
              type: 'length',
              action: 'filter',
              params: {
                minLength: 2,
                maxLength: 50,
              },
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('LENGTH(name) >= 2');
      expect(sql).toContain('LENGTH(name) <= 50');
    });

    it('should throw error if both minLength and maxLength are missing', async () => {
      const config: ValidationConfig = [
        {
          field: 'name',
          rules: [
            {
              type: 'length',
              action: 'filter',
              params: {},
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Cross-Field Validation', () => {
    it('should validate cross-field comparison', async () => {
      const config: ValidationConfig = [
        {
          field: 'price',
          rules: [
            {
              type: 'cross_field',
              action: 'filter',
              params: {
                compareField: 'age',
                operator: '>',
              },
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('price > age');
    });

    it('should throw error if compareField is missing', async () => {
      const config: ValidationConfig = [
        {
          field: 'price',
          rules: [
            {
              type: 'cross_field',
              action: 'filter',
              params: {
                operator: '>',
              },
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Multiple Rules', () => {
    it('should combine multiple filter rules with AND', async () => {
      const config: ValidationConfig = [
        {
          field: 'age',
          rules: [
            {
              type: 'is_numeric',
              action: 'filter',
            },
            {
              type: 'range',
              action: 'filter',
              params: { min: 18, max: 65 },
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('TRY_CAST(age AS DOUBLE) IS NOT NULL');
      expect(sql).toContain('age::DOUBLE >= 18');
      expect(sql).toContain(' AND ');
    });

    it.skip('should separate mark and filter rules', async () => {
      const config: ValidationConfig = [
        {
          field: 'email',
          rules: [
            {
              type: 'is_email',
              action: 'mark',
              markColumn: 'email_valid',
            },
            {
              type: 'is_email',
              action: 'filter',
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('AS email_valid');
      expect(sql).toContain('WHERE');
    });
  });

  describe('getResultColumns', () => {
    it('should add mark columns to result', async () => {
      const config: ValidationConfig = [
        {
          field: 'email',
          rules: [
            {
              type: 'is_email',
              action: 'mark',
              markColumn: 'email_valid',
            },
          ],
        },
        {
          field: 'age',
          rules: [
            {
              type: 'is_numeric',
              action: 'mark',
              markColumn: 'age_valid',
            },
          ],
        },
      ];

      const resultColumns = await builder.getResultColumns(context, config);

      expect(resultColumns.has('email_valid')).toBe(true);
      expect(resultColumns.has('age_valid')).toBe(true);
      expect(resultColumns.has('id')).toBe(true);
      expect(resultColumns.size).toBe(8); // 6 original + 2 mark columns
    });

    it('should use default mark column name', async () => {
      const config: ValidationConfig = [
        {
          field: 'email',
          rules: [
            {
              type: 'is_email',
              action: 'mark',
            },
          ],
        },
      ];

      const resultColumns = await builder.getResultColumns(context, config);

      expect(resultColumns.has('email_valid')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should return SELECT * for empty config', async () => {
      const config: ValidationConfig = [];

      const sql = await builder.build(context, config);

      expect(sql).toBe('SELECT * FROM test_table');
    });

    it('should handle undefined config', async () => {
      const sql = await builder.build(context, undefined as any);

      expect(sql).toBe('SELECT * FROM test_table');
    });

    it('should handle fields with special characters', async () => {
      context.availableColumns.add('user name');
      const config: ValidationConfig = [
        {
          field: 'user name',
          rules: [
            {
              type: 'is_numeric',
              action: 'filter',
            },
          ],
        },
      ];

      const sql = await builder.build(context, config);

      expect(sql).toContain('"user name"');
    });
  });
});
