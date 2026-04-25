/**
 * FilterBuilder 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FilterBuilder } from './FilterBuilder';
import type { FilterConfig, SQLContext } from '../types';
describe('FilterBuilder', () => {
  let builder: FilterBuilder;
  let context: SQLContext;

  beforeEach(() => {
    builder = new FilterBuilder();
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set([
        'id',
        'name',
        'email',
        'age',
        'price',
        'created_at',
        'deleted_at',
      ]),
    };
  });

  describe('Equal Filter', () => {
    it('should build simple equal filter', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'equal', field: 'name', value: 'Alice' }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain("name = 'Alice'");
      expect(sql).toContain('WHERE');
    });

    it('should handle null value', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'equal', field: 'name', value: null }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('name = NULL');
    });

    it('should escape single quotes in value', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'equal', field: 'name', value: "O'Brien" }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain("name = 'O''Brien'");
    });
  });

  describe('Comparison Filters', () => {
    it('should build greater than filter', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'greater_than', field: 'age', value: 18 }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('age > 18');
    });

    it('should build less than or equal filter', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'less_equal', field: 'price', value: 100.5 }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('price <= 100.5');
    });
  });

  describe('BETWEEN Filter', () => {
    it('should build valid BETWEEN clause', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'between', field: 'age', values: [18, 65] }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('age BETWEEN 18 AND 65');
    });

    it('should throw error if values length is not 2', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'between', field: 'age', values: [18] }],
      };

      expect(() => builder.build(context, config)).toThrow();
    });
  });

  describe('LIKE Filters', () => {
    it('should build case-insensitive contains filter', () => {
      const config: FilterConfig = {
        conditions: [
          {
            type: 'contains',
            field: 'email',
            value: 'example.com',
          },
        ],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('LOWER(email)');
      expect(sql).toContain('LIKE');
      expect(sql).toContain('%example.com%');
    });

    it('should build case-sensitive contains filter', () => {
      const config: FilterConfig = {
        conditions: [
          {
            type: 'contains',
            field: 'email',
            value: 'Example',
            options: { caseSensitive: true },
          },
        ],
      };

      const sql = builder.build(context, config);
      expect(sql).not.toContain('LOWER(');
      expect(sql).toContain('email LIKE');
    });

    it('should build starts_with filter', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'starts_with', field: 'name', value: 'Al' }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('LIKE');
      expect(sql).toContain('%');
    });

    it('should build ends_with filter', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'ends_with', field: 'email', value: '@gmail.com' }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('LIKE');
      expect(sql).toContain('%');
    });
  });

  describe('IN Filter', () => {
    it('should build IN clause', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'in', field: 'name', values: ['Alice', 'Bob', 'Charlie'] }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('name IN');
      expect(sql).toContain("'Alice'");
      expect(sql).toContain("'Bob'");
      expect(sql).toContain("'Charlie'");
    });

    it('should throw error if values is empty', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'in', field: 'name', values: [] }],
      };

      expect(() => builder.build(context, config)).toThrow();
    });

    it('should build NOT IN clause', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'not_in', field: 'status', values: ['deleted', 'archived'] }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('NOT IN');
    });
  });

  describe('NULL Filters', () => {
    it('should build IS NULL filter', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'null', field: 'deleted_at' }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('deleted_at IS NULL');
    });

    it('should build IS NOT NULL filter', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'not_null', field: 'email' }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('email IS NOT NULL');
    });
  });

  describe('Regex Filter', () => {
    it('should build regex filter with length limit', () => {
      const config: FilterConfig = {
        conditions: [
          {
            type: 'regex',
            field: 'email',
            value: '^[a-z]+@example\\.com$',
            options: { regexMaxLength: 100 },
          },
        ],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('LENGTH(email) > 100');
      expect(sql).toContain('regexp_matches');
      expect(sql).toContain('CASE');
    });
  });

  describe('Soft Delete Filter', () => {
    it('should filter active records only', () => {
      const config: FilterConfig = {
        conditions: [
          {
            type: 'soft_delete',
            field: 'deleted_at',
            options: { softDeleteStates: ['active'] },
          },
        ],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('deleted_at IS NULL');
      expect(sql).toContain('OR deleted_at = 0');
    });

    it('should filter deleted records only', () => {
      const config: FilterConfig = {
        conditions: [
          {
            type: 'soft_delete',
            field: 'deleted_at',
            options: { softDeleteStates: ['deleted'] },
          },
        ],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('deleted_at = 1');
      expect(sql).toContain('OR deleted_at = TRUE');
    });

    it('should return all records when state is "all"', () => {
      const config: FilterConfig = {
        conditions: [
          {
            type: 'soft_delete',
            field: 'deleted_at',
            options: { softDeleteStates: ['all'] },
          },
        ],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('TRUE');
    });
  });

  describe('Relative Time Filter', () => {
    it('should build past time filter', () => {
      const config: FilterConfig = {
        conditions: [
          {
            type: 'relative_time',
            field: 'created_at',
            options: {
              relativeTimeUnit: 'day',
              relativeTimeValue: 7,
              relativeTimeDirection: 'past',
            },
          },
        ],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('created_at >= CURRENT_TIMESTAMP');
      expect(sql).toContain("INTERVAL '7 day'");
    });

    it('should build future time filter', () => {
      const config: FilterConfig = {
        conditions: [
          {
            type: 'relative_time',
            field: 'created_at',
            options: {
              relativeTimeUnit: 'month',
              relativeTimeValue: 1,
              relativeTimeDirection: 'future',
            },
          },
        ],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('created_at <= CURRENT_TIMESTAMP');
      expect(sql).toContain("INTERVAL '1 month'");
    });
  });

  describe('Multiple Conditions', () => {
    it('should combine conditions with AND (default)', () => {
      const config: FilterConfig = {
        conditions: [
          { type: 'equal', field: 'name', value: 'Alice' },
          { type: 'greater_than', field: 'age', value: 25 },
        ],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain("name = 'Alice'");
      expect(sql).toContain('age > 25');
      expect(sql).toContain(' AND ');
    });

    it('should combine conditions with OR', () => {
      const config: FilterConfig = {
        combinator: 'OR',
        conditions: [
          { type: 'equal', field: 'name', value: 'Alice' },
          { type: 'equal', field: 'name', value: 'Bob' },
        ],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain(' OR ');
    });
  });

  describe('Edge Cases', () => {
    it('should return SELECT * when no conditions', () => {
      const config: FilterConfig = {
        conditions: [],
      };

      const sql = builder.build(context, config);
      expect(sql).toBe('SELECT * FROM test_table');
      expect(sql).not.toContain('WHERE');
    });

    it('should handle special characters in field names', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'equal', field: 'user name', value: 'test' }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('"user name"');
    });

    it('should handle boolean values', () => {
      const config: FilterConfig = {
        conditions: [{ type: 'equal', field: 'is_active', value: true }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('is_active = TRUE');
    });

    it('should handle Date objects', () => {
      const date = new Date('2024-01-01');
      const config: FilterConfig = {
        conditions: [{ type: 'greater_than', field: 'created_at', value: date }],
      };

      const sql = builder.build(context, config);
      expect(sql).toContain('created_at >');
      expect(sql).toContain('2024-01-01');
    });
  });
});
