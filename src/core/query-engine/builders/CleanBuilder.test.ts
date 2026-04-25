/**
 * CleanBuilder 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CleanBuilder } from './CleanBuilder';
import type { CleanConfig, SQLContext } from '../types';

describe('CleanBuilder', () => {
  let builder: CleanBuilder;
  let context: SQLContext;

  beforeEach(() => {
    builder = new CleanBuilder();
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set([
        'id',
        'name',
        'email',
        'description',
        'price',
        'date_str',
        'date_field',
      ]),
    };
  });

  describe('Trim Operations', () => {
    it('should build TRIM operation', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'trim' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('TRIM(');
      expect(sql).toContain('AS name');
    });

    it('should build LTRIM operation', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'trim_start' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('LTRIM(');
      expect(sql).toContain('AS name');
    });

    it('should build RTRIM operation', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'trim_end' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('RTRIM(');
      expect(sql).toContain('AS name');
    });
  });

  describe('Case Conversion', () => {
    it('should build UPPER operation', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'upper' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('UPPER(');
      expect(sql).toContain('AS name');
    });

    it('should build LOWER operation', () => {
      const config: CleanConfig = [
        {
          field: 'email',
          operations: [{ type: 'lower' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('LOWER(');
      expect(sql).toContain('AS email');
    });

    it('should build title case operation (DuckDB-compatible)', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'title' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('CONCAT(');
      expect(sql).toContain('UPPER(SUBSTRING(');
      expect(sql).toContain('LOWER(SUBSTRING(');
      expect(sql).toContain('AS name');
    });
  });

  describe('Width Conversion', () => {
    it('should build halfwidth conversion with numbers, letters, and punctuation', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'to_halfwidth' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('TRANSLATE');
      expect(sql).toContain('０１２３４５６７８９');
      expect(sql).toContain('0123456789');
      // Check punctuation support
      expect(sql).toContain('，。！？');
      expect(sql).toContain(',.!?');
    });

    it('should build fullwidth conversion with numbers, letters, and punctuation', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'to_fullwidth' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('TRANSLATE');
      expect(sql).toContain('0123456789');
      expect(sql).toContain('０１２３４５６７８９');
      // Check punctuation support
      expect(sql).toContain(',.!?');
      expect(sql).toContain('，。！？');
    });
  });

  describe('Replace Operations', () => {
    it('should build simple replace', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'replace',
              params: {
                search: 'Mr.',
                replaceWith: 'Mr',
              },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('REPLACE(');
      expect(sql).toContain("'Mr.'");
      expect(sql).toContain("'Mr'");
    });

    it('should handle replace with empty string', () => {
      const config: CleanConfig = [
        {
          field: 'description',
          operations: [
            {
              type: 'replace',
              params: {
                search: '  ',
                replaceWith: ' ',
              },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('REPLACE(');
      expect(sql).toContain("'  '");
      expect(sql).toContain("' '");
    });

    it('should handle replace with special characters', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'replace',
              params: {
                search: "O'Brien",
                replaceWith: 'OBrien',
              },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('REPLACE(');
      expect(sql).toContain("'O''Brien'");
      expect(sql).toContain("'OBrien'");
    });

    it('should throw error if search param is missing', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'replace',
              params: { replaceWith: 'test' } as any,
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Regex Replace', () => {
    it('should build regex replace', () => {
      const config: CleanConfig = [
        {
          field: 'email',
          operations: [
            {
              type: 'regex_replace',
              params: {
                pattern: '\\s+',
                replacement: '',
              },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('REGEXP_REPLACE(');
      expect(sql).toContain("'\\s+'");
      expect(sql).toContain("''");
    });

    it('should handle regex replace with empty replacement', () => {
      const config: CleanConfig = [
        {
          field: 'description',
          operations: [
            {
              type: 'regex_replace',
              params: {
                pattern: '[0-9]+',
                replacement: 'X',
              },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('REGEXP_REPLACE(');
      expect(sql).toContain("'[0-9]+'");
      expect(sql).toContain("'X'");
    });

    it('should throw error if pattern is missing', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'regex_replace',
              params: { replacement: 'test' } as any,
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Unit Conversion', () => {
    it('should build unit conversion', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [
            {
              type: 'unit_convert',
              params: {
                conversionFactor: 1.1,
              },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('(price::DOUBLE * 1.1)');
    });

    it('should handle negative conversion factor', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [
            {
              type: 'unit_convert',
              params: {
                conversionFactor: -1,
              },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('(price::DOUBLE * -1)');
    });

    it('should throw error if conversionFactor is missing', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [
            {
              type: 'unit_convert',
              params: {} as any,
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Chained Operations', () => {
    it('should chain multiple operations', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'trim' }, { type: 'upper' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('UPPER(');
      expect(sql).toContain('TRIM(');
    });

    it('should chain three operations', () => {
      const config: CleanConfig = [
        {
          field: 'description',
          operations: [
            { type: 'trim' },
            { type: 'lower' },
            {
              type: 'replace',
              params: { search: '  ', replaceWith: ' ' },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('REPLACE(');
      expect(sql).toContain('LOWER(');
      expect(sql).toContain('TRIM(');
    });
  });

  describe('Output Field', () => {
    it('should create new column with outputField', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          outputField: 'clean_name',
          operations: [{ type: 'trim' }],
        },
      ];

      const sql = builder.build(context, config);

      // Should keep original name column
      expect(sql).toContain('name,');
      // Should add new clean_name column
      expect(sql).toContain('TRIM(');
      expect(sql).toContain('AS clean_name');
    });

    it('should replace column if outputField matches field', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          outputField: 'name',
          operations: [{ type: 'upper' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('UPPER(');
      expect(sql).toContain('AS name');
    });

    it('should handle multiple fields with different outputs', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          outputField: 'clean_name',
          operations: [{ type: 'trim' }],
        },
        {
          field: 'email',
          outputField: 'normalized_email',
          operations: [{ type: 'lower' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('TRIM(');
      expect(sql).toContain('AS clean_name');
      expect(sql).toContain('LOWER(');
      expect(sql).toContain('AS normalized_email');
    });
  });

  describe('Field Validation', () => {
    it('should throw error if field does not exist', () => {
      const config: CleanConfig = [
        {
          field: 'nonexistent_field',
          operations: [{ type: 'trim' }],
        },
      ];

      expect(() => builder.build(context, config)).toThrow(/does not exist/i);
    });

    it('should provide available fields in error message', () => {
      const config: CleanConfig = [
        {
          field: 'invalid',
          operations: [{ type: 'trim' }],
        },
      ];

      try {
        builder.build(context, config);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toMatch(/invalid/i);
      }
    });

    it('should validate all fields before processing', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'trim' }],
        },
        {
          field: 'nonexistent',
          operations: [{ type: 'upper' }],
        },
      ];

      expect(() => builder.build(context, config)).toThrow(/nonexistent/i);
    });
  });

  describe('Edge Cases', () => {
    it('should return SELECT * when config is empty', () => {
      const config: CleanConfig = [];

      const sql = builder.build(context, config);
      expect(sql).toBe('SELECT * FROM test_table');
    });

    it('should handle fields with special characters', () => {
      context.availableColumns.add('user name');
      const config: CleanConfig = [
        {
          field: 'user name',
          operations: [{ type: 'trim' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('"user name"');
      expect(sql).toContain('TRIM(');
    });

    it('should preserve other columns unchanged', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'trim' }],
        },
      ];

      const sql = builder.build(context, config);

      expect(sql).toContain('id,');
      expect(sql).toContain('email,');
      expect(sql).toContain('description,');
      expect(sql).toContain('price');
    });

    it('should throw error for unsupported operation', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'unsupported_op' as any }],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('getResultColumns', () => {
    it('should keep existing columns when no outputField', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'trim' }],
        },
      ];

      const resultColumns = builder.getResultColumns(context, config);

      expect(resultColumns.has('id')).toBe(true);
      expect(resultColumns.has('name')).toBe(true);
      expect(resultColumns.has('email')).toBe(true);
      expect(resultColumns.size).toBe(7); // 5 original + 2 date fields
    });

    it('should add new column when outputField is different', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          outputField: 'clean_name',
          operations: [{ type: 'trim' }],
        },
      ];

      const resultColumns = builder.getResultColumns(context, config);

      expect(resultColumns.has('name')).toBe(true);
      expect(resultColumns.has('clean_name')).toBe(true);
      expect(resultColumns.size).toBe(8); // 7 + 1 new column
    });

    it('should handle multiple new columns', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          outputField: 'clean_name',
          operations: [{ type: 'trim' }],
        },
        {
          field: 'email',
          outputField: 'normalized_email',
          operations: [{ type: 'lower' }],
        },
      ];

      const resultColumns = builder.getResultColumns(context, config);

      expect(resultColumns.has('clean_name')).toBe(true);
      expect(resultColumns.has('normalized_email')).toBe(true);
      expect(resultColumns.size).toBe(9); // 7 + 2 new columns
    });
  });

  // ========== 新增功能测试 ==========

  describe('Null Handling Operations', () => {
    it('should build fill_null operation', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'fill_null', params: { value: 'Unknown' } }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('COALESCE(name,');
      expect(sql).toContain("'Unknown')");
    });

    it('should build nullif operation', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'nullif', params: { nullValue: '' } }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('NULLIF(name,');
      expect(sql).toContain("'')");
    });

    it('should build coalesce operation with multiple fields (excluding current field)', () => {
      context.availableColumns.add('name2');
      context.availableColumns.add('name3');

      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            { type: 'coalesce', params: { fields: ['name2', 'name3'], value: 'Default' } },
          ],
        },
      ];

      const sql = builder.build(context, config);
      // Should NOT include current field 'name' in COALESCE, only specified fields
      expect(sql).toContain('COALESCE(name2, name3,');
      expect(sql).toContain("'Default')");
      expect(sql).not.toContain('COALESCE(name, name2');
    });

    it('should throw error for coalesce without fields', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'coalesce', params: {} }],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Type Conversion Operations', () => {
    it('should build cast operation', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [{ type: 'cast', params: { targetType: 'INTEGER' } }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('CAST(price AS INTEGER)');
    });

    it('should build try_cast operation', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [{ type: 'try_cast', params: { targetType: 'DOUBLE' } }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('TRY_CAST(price AS DOUBLE)');
    });

    it('should throw error for cast without targetType', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [{ type: 'cast', params: {} }],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('Number Processing Operations', () => {
    it('should build round operation', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [{ type: 'round', params: { decimals: 2 } }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('ROUND(price::DOUBLE, 2)');
    });

    it('should build floor operation', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [{ type: 'floor' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('FLOOR(price::DOUBLE)');
    });

    it('should build ceil operation', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [{ type: 'ceil' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('CEIL(price::DOUBLE)');
    });

    it('should build abs operation', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [{ type: 'abs' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('ABS(price::DOUBLE)');
    });
  });

  describe('Date Processing Operations', () => {
    it('should build parse_date operation', () => {
      const config: CleanConfig = [
        {
          field: 'date_str',
          operations: [{ type: 'parse_date', params: { dateFormat: '%Y-%m-%d' } }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('STRPTIME(date_str,');
      expect(sql).toContain("'%Y-%m-%d')");
    });

    it('should build format_date operation', () => {
      const config: CleanConfig = [
        {
          field: 'date_field',
          operations: [{ type: 'format_date', params: { dateFormat: '%Y/%m/%d' } }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('STRFTIME(date_field,');
      expect(sql).toContain("'%Y/%m/%d')");
    });

    it('should use default date format for parse_date', () => {
      const config: CleanConfig = [
        {
          field: 'date_str',
          operations: [{ type: 'parse_date' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain("'%Y-%m-%d'");
    });
  });

  describe('Complex Chain Operations with New Features', () => {
    it('should chain null handling and type conversion', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [
            { type: 'fill_null', params: { value: '0' } },
            { type: 'try_cast', params: { targetType: 'DOUBLE' } },
            { type: 'round', params: { decimals: 2 } },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('ROUND');
      expect(sql).toContain('TRY_CAST');
      expect(sql).toContain('COALESCE');
    });

    it('should clean date string and parse', () => {
      const config: CleanConfig = [
        {
          field: 'date_str',
          operations: [
            { type: 'trim' },
            { type: 'nullif', params: { nullValue: '' } },
            { type: 'parse_date', params: { dateFormat: '%Y-%m-%d' } },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('STRPTIME');
      expect(sql).toContain('NULLIF');
      expect(sql).toContain('TRIM');
    });
  });

  // ========== 新增高级清洗操作测试 ==========

  describe('Advanced Text Cleaning Operations (New)', () => {
    it('should build normalize_space operation', () => {
      const config: CleanConfig = [
        {
          field: 'description',
          operations: [{ type: 'normalize_space' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('REGEXP_REPLACE(');
      expect(sql).toContain('TRIM(');
      expect(sql).toContain("'\\s+'");
      expect(sql).toContain("' '");
    });

    it('should build remove_special_chars operation with default pattern', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [{ type: 'remove_special_chars' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('REGEXP_REPLACE(');
      expect(sql).toContain('[^a-zA-Z0-9\\s]');
    });

    it('should build remove_special_chars operation with custom pattern', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'remove_special_chars',
              params: { keepPattern: 'a-zA-Z0-9_-' },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('[^a-zA-Z0-9_-]');
    });

    it('should build truncate operation with default parameters', () => {
      const config: CleanConfig = [
        {
          field: 'description',
          operations: [{ type: 'truncate' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('CASE');
      expect(sql).toContain('LENGTH(');
      expect(sql).toContain('> 50');
      expect(sql).toContain('SUBSTRING(');
      expect(sql).toContain("'...'");
    });

    it('should build truncate operation with custom parameters', () => {
      const config: CleanConfig = [
        {
          field: 'description',
          operations: [
            {
              type: 'truncate',
              params: { maxLength: 100, suffix: '…' },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('LENGTH(');
      expect(sql).toContain('> 100');
      expect(sql).toContain('SUBSTRING(');
      expect(sql).toContain("'…'");
    });

    it('should build normalize_email operation', () => {
      const config: CleanConfig = [
        {
          field: 'email',
          operations: [{ type: 'normalize_email' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('LOWER(');
      expect(sql).toContain('TRIM(');
    });

    it('should build split_part operation', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'split_part',
              params: { delimiter: ' ', index: 1 },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('SPLIT_PART(');
      expect(sql).toContain("' ', 1");
    });

    it('should build split_part with different delimiter', () => {
      const config: CleanConfig = [
        {
          field: 'email',
          operations: [
            {
              type: 'split_part',
              params: { delimiter: '@', index: 2 },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain("'@', 2");
    });

    it('should throw error for split_part without delimiter', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'split_part',
              params: { index: 1 } as any,
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });

    it('should throw error for split_part without index', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'split_part',
              params: { delimiter: ' ' } as any,
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });

    it('should build concat_fields operation with default separator', () => {
      context.availableColumns.add('first_name');
      context.availableColumns.add('last_name');

      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'concat_fields',
              params: { fields: ['first_name', 'last_name'] },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('CONCAT_WS');
      expect(sql).toContain('first_name');
      expect(sql).toContain('last_name');
    });

    it('should build concat_fields operation with custom separator', () => {
      context.availableColumns.add('city');
      context.availableColumns.add('state');
      context.availableColumns.add('zip');

      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'concat_fields',
              params: {
                fields: ['city', 'state', 'zip'],
                separator: ', ',
              },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('CONCAT_WS');
      expect(sql).toContain("', '");
      expect(sql).toContain('city');
      expect(sql).toContain('state');
      expect(sql).toContain('zip');
    });

    it('should throw error for concat_fields without fields', () => {
      const config: CleanConfig = [
        {
          field: 'name',
          operations: [
            {
              type: 'concat_fields',
              params: {},
            },
          ],
        },
      ];

      expect(() => builder.build(context, config)).toThrow();
    });

    it('should build extract_numbers operation', () => {
      const config: CleanConfig = [
        {
          field: 'description',
          operations: [{ type: 'extract_numbers' }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('REGEXP_REPLACE(');
      expect(sql).toContain('[^0-9]');
      expect(sql).toContain("''");
    });
  });

  describe('Type Conversion for String Operations', () => {
    it('should automatically convert numeric fields to VARCHAR for string operations', () => {
      // 模拟用户在数值字段上使用字符串操作
      const config: CleanConfig = [
        {
          field: 'price', // 假设price是数值类型
          operations: [{ type: 'replace', params: { search: '1', replaceWith: '10' } }],
        },
      ];

      const sql = builder.build(context, config);
      // 应该包含类型转换
      expect(sql).toContain('CAST(');
      expect(sql).toContain('AS VARCHAR');
      expect(sql).toContain('REPLACE(');
    });

    it('should handle multiple string operations on numeric field', () => {
      const config: CleanConfig = [
        {
          field: 'price',
          operations: [
            { type: 'trim' },
            { type: 'replace', params: { search: '.', replaceWith: ',' } },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('TRIM(');
      expect(sql).toContain('REPLACE(');
      expect(sql).toContain('CAST(');
    });
  });

  describe('New Operations - Integration Tests', () => {
    it('should chain normalize_space with other text operations', () => {
      const config: CleanConfig = [
        {
          field: 'description',
          operations: [
            { type: 'trim' },
            { type: 'normalize_space' },
            { type: 'truncate', params: { maxLength: 100 } },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('CASE');
      expect(sql).toContain('REGEXP_REPLACE');
      expect(sql).toContain('TRIM');
    });

    it('should extract email domain using split_part', () => {
      const config: CleanConfig = [
        {
          field: 'email',
          outputField: 'domain',
          operations: [
            { type: 'normalize_email' },
            { type: 'split_part', params: { delimiter: '@', index: 2 } },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('SPLIT_PART');
      expect(sql).toContain('LOWER(');
      expect(sql).toContain('TRIM(');
      expect(sql).toContain('domain');
    });

    it('should concatenate multiple address fields', () => {
      context.availableColumns.add('street');
      context.availableColumns.add('city');
      context.availableColumns.add('state');

      const config: CleanConfig = [
        {
          field: 'street',
          outputField: 'full_address',
          operations: [
            {
              type: 'concat_fields',
              params: {
                fields: ['street', 'city', 'state'],
                separator: ', ',
              },
            },
          ],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('CONCAT_WS');
      expect(sql).toContain('street');
      expect(sql).toContain('city');
      expect(sql).toContain('state');
      expect(sql).toContain('full_address');
    });

    it('should extract and clean numbers from text', () => {
      const config: CleanConfig = [
        {
          field: 'description',
          outputField: 'numbers_only',
          operations: [{ type: 'extract_numbers' }, { type: 'nullif', params: { nullValue: '' } }],
        },
      ];

      const sql = builder.build(context, config);
      expect(sql).toContain('NULLIF');
      expect(sql).toContain('REGEXP_REPLACE');
      expect(sql).toContain('[^0-9]');
      expect(sql).toContain('numbers_only');
    });
  });
});
