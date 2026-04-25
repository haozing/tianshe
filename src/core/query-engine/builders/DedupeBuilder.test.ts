/**
 * DedupeBuilder 单元测试
 * 测试重点：ROW_NUMBER 去重、分区、排序
 *
 * 注意：build() 和 getResultColumns() 都是同步方法
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DedupeBuilder } from './DedupeBuilder';
import type { DedupeConfig, SQLContext } from '../types';

describe('DedupeBuilder', () => {
  let builder: DedupeBuilder;
  let context: SQLContext;

  beforeEach(() => {
    builder = new DedupeBuilder();
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set(['id', 'email', 'name', 'created_at', 'score']),
    };
  });

  describe('ROW_NUMBER Dedupe', () => {
    it('should dedupe by single partition column', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('PARTITION BY email');
      expect(sql).toContain('ORDER BY created_at ASC');
      expect(sql).toContain('ROW_NUMBER()');
      expect(sql).toContain('WHERE _rn = 1');
    });

    it('should dedupe by multiple partition columns', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email', 'name'],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('PARTITION BY email, name');
    });

    it('should keep first record when keepStrategy=first', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('ORDER BY created_at ASC');
    });

    it('should keep last record when keepStrategy=last (uses default DESC when no orderBy)', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        keepStrategy: 'last',
      };

      const sql = builder.build(context, config);

      // 当没有 orderBy 时，keepStrategy='last' 会使用 DESC 方向
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('DESC');
    });

    it('should handle multiple orderBy columns with independent directions', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [
          { field: 'created_at', direction: 'DESC' },
          { field: 'score', direction: 'ASC' },
        ],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('created_at DESC');
      expect(sql).toContain('score ASC');
    });

    it('should reverse orderBy directions when keepStrategy=last', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [
          { field: 'created_at', direction: 'ASC' },
          { field: 'score', direction: 'DESC' },
        ],
        keepStrategy: 'last',
        tieBreaker: 'id',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('created_at DESC');
      expect(sql).toContain('score ASC');
      expect(sql).toContain('id DESC');
    });

    it('should handle no orderBy specified', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      // Should still work with fallback ordering
      expect(sql).toContain('ROW_NUMBER()');
      expect(sql).toContain('ORDER BY');
    });

    it('should exclude _rn technical column from output', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      // Check that original columns are explicitly selected (without _rn)
      expect(sql).toContain('SELECT id, email, name, created_at, score FROM');
      expect(sql).toContain('AS _deduped');
      expect(sql).not.toMatch(/SELECT.*_rn.*FROM/);
    });

    it('should handle fields with special characters', () => {
      context.availableColumns.add('user email');
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['user email'],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      // SQLUtils.escapeIdentifier 对特殊字符会加引号
      expect(sql).toContain('"user email"');
    });

    it('should support NULLS LAST option', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [{ field: 'created_at', direction: 'ASC', nullsLast: true }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('NULLS LAST');
    });

    it('should support tieBreaker for deterministic ordering', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
        tieBreaker: 'id',
      };

      const sql = builder.build(context, config);

      // tieBreaker 字段会添加到 ORDER BY 子句中
      expect(sql).toContain('id');
      expect(sql).toContain('ORDER BY');
    });
  });

  describe('getResultColumns', () => {
    it('should preserve columns for row_number dedupe', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
      };

      const resultColumns = builder.getResultColumns(context, config);

      expect(resultColumns.size).toBe(5);
      expect(resultColumns.has('id')).toBe(true);
      expect(resultColumns.has('email')).toBe(true);
      expect(resultColumns.has('name')).toBe(true);
      expect(resultColumns.has('created_at')).toBe(true);
      expect(resultColumns.has('score')).toBe(true);
      // Should NOT include _rn
      expect(resultColumns.has('_rn')).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unknown dedupe type', () => {
      const config: any = {
        type: 'unknown_type',
        partitionBy: ['email'],
      };

      expect(() => builder.build(context, config)).toThrow(/unsupported dedupe type/i);
    });

    it('should handle empty partitionBy array gracefully', () => {
      // This should generate invalid SQL, but should not crash
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: [],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toBeTruthy();
    });
  });

  describe('Edge Cases', () => {
    it('should handle single partition column with no orderBy', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('PARTITION BY email');
      expect(sql).toContain('ROW_NUMBER()');
    });

    it('should handle partition by field that is SQL keyword', () => {
      context.availableColumns.add('order');
      context.availableColumns.add('select');
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['order', 'select'],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('PARTITION BY "order", "select"');
      expect(sql).toContain('ROW_NUMBER()');
    });

    it('should handle very long partition key', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['id', 'email', 'name', 'created_at', 'score'],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('PARTITION BY id, email, name, created_at, score');
    });

    it('should trim whitespace in generated SQL', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [{ field: 'created_at', direction: 'ASC' }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql.startsWith(' ')).toBe(false);
      expect(sql.endsWith(' ')).toBe(false);
    });

    it('should respect independent direction for each orderBy column', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [
          { field: 'score', direction: 'DESC' },
          { field: 'created_at', direction: 'ASC' },
        ],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('score DESC');
      expect(sql).toContain('created_at ASC');
    });
  });

  describe('Complex Scenarios', () => {
    it('should dedupe user records by email, keeping latest', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email'],
        orderBy: [{ field: 'created_at', direction: 'DESC' }],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('PARTITION BY email');
      expect(sql).toContain('ORDER BY created_at DESC');
      expect(sql).toContain('WHERE _rn = 1');
    });

    it('should dedupe by composite key with score tiebreaker', () => {
      const config: DedupeConfig = {
        type: 'row_number',
        partitionBy: ['email', 'name'],
        orderBy: [
          { field: 'score', direction: 'DESC' },
          { field: 'created_at', direction: 'DESC' },
        ],
        keepStrategy: 'first',
      };

      const sql = builder.build(context, config);

      expect(sql).toContain('PARTITION BY email, name');
      expect(sql).toContain('score DESC');
      expect(sql).toContain('created_at DESC');
    });
  });
});
