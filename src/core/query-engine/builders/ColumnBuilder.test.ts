/**
 * ColumnBuilder 单元测试
 * 测试重点：列选择、重命名、隐藏
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ColumnBuilder } from './ColumnBuilder';
import type { ColumnConfig, SQLContext } from '../types';

describe('ColumnBuilder', () => {
  let builder: ColumnBuilder;
  let context: SQLContext;

  beforeEach(() => {
    builder = new ColumnBuilder();
    context = {
      datasetId: 'test',
      currentTable: 'test_table',
      ctes: [],
      availableColumns: new Set(['id', 'name', 'email', 'age', 'created_at']),
    };
  });

  describe('Select All Columns', () => {
    it('should select all columns when no config', async () => {
      const sql = await builder.build(context);

      expect(sql).toBe('SELECT * FROM test_table');
    });

    it('should select all columns when config is empty', async () => {
      const config: ColumnConfig = {};

      const sql = await builder.build(context, config);

      expect(sql).toBe('SELECT * FROM test_table');
    });

    it('should ignore show-only config for SQL selection', async () => {
      const config: ColumnConfig = {
        show: ['email'],
      };

      const sql = await builder.build(context, config);

      expect(sql).toBe('SELECT * FROM test_table');
    });
  });

  describe('Select Specific Columns', () => {
    it('should select only specified columns', async () => {
      const config: ColumnConfig = {
        select: ['id', 'name', 'email'],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('SELECT id, name, email FROM test_table');
      expect(sql).not.toContain('age');
      expect(sql).not.toContain('created_at');
    });

    it('should select single column', async () => {
      const config: ColumnConfig = {
        select: ['name'],
      };

      const sql = await builder.build(context, config);

      expect(sql).toBe('SELECT name FROM test_table');
    });

    it('should handle column order', async () => {
      const config: ColumnConfig = {
        select: ['email', 'id', 'name'],
      };

      const sql = await builder.build(context, config);

      expect(sql).toBe('SELECT email, id, name FROM test_table');
    });
  });

  describe('Hide Columns', () => {
    it('should hide specified columns', async () => {
      const config: ColumnConfig = {
        hide: ['age', 'created_at'],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('id');
      expect(sql).toContain('name');
      expect(sql).toContain('email');
      expect(sql).not.toContain('age');
      expect(sql).not.toContain('created_at');
    });

    it('should hide single column', async () => {
      const config: ColumnConfig = {
        hide: ['email'],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('id, name, age, created_at');
      expect(sql).not.toContain('email');
    });
  });

  describe('Rename Columns', () => {
    it('should rename single column', async () => {
      const config: ColumnConfig = {
        rename: {
          name: 'full_name',
        },
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('name AS full_name');
      expect(sql).toContain('id');
      expect(sql).toContain('email');
    });

    it('should rename multiple columns', async () => {
      const config: ColumnConfig = {
        rename: {
          name: 'full_name',
          email: 'email_address',
          created_at: 'timestamp',
        },
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('name AS full_name');
      expect(sql).toContain('email AS email_address');
      expect(sql).toContain('created_at AS timestamp');
      expect(sql).toContain('id, '); // id should remain unchanged
    });

    it('should handle renamed columns with special characters', async () => {
      const config: ColumnConfig = {
        rename: {
          name: 'user name',
        },
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('name AS "user name"');
    });
  });

  describe('Combined Operations', () => {
    it('should select and rename columns', async () => {
      const config: ColumnConfig = {
        select: ['id', 'name', 'email'],
        rename: {
          name: 'full_name',
          email: 'email_address',
        },
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('id');
      expect(sql).toContain('name AS full_name');
      expect(sql).toContain('email AS email_address');
      expect(sql).not.toContain('age');
    });

    it('should hide and rename columns', async () => {
      const config: ColumnConfig = {
        hide: ['age', 'created_at'],
        rename: {
          name: 'full_name',
        },
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('id');
      expect(sql).toContain('name AS full_name');
      expect(sql).toContain('email');
      expect(sql).not.toContain('age');
      expect(sql).not.toContain('created_at');
    });

    it('should select, hide, and rename columns', async () => {
      const config: ColumnConfig = {
        select: ['id', 'name', 'email', 'age'],
        hide: ['age'],
        rename: {
          name: 'full_name',
        },
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('id');
      expect(sql).toContain('name AS full_name');
      expect(sql).toContain('email');
      expect(sql).not.toContain('age');
      expect(sql).not.toContain('created_at'); // Not in select list
    });
  });

  describe('getResultColumns', () => {
    it('should return all columns when no config', async () => {
      const resultColumns = await builder.getResultColumns(context);

      expect(resultColumns.size).toBe(5);
      expect(resultColumns.has('id')).toBe(true);
      expect(resultColumns.has('name')).toBe(true);
      expect(resultColumns.has('email')).toBe(true);
      expect(resultColumns.has('age')).toBe(true);
      expect(resultColumns.has('created_at')).toBe(true);
    });

    it('should return selected columns', async () => {
      const config: ColumnConfig = {
        select: ['id', 'name'],
      };

      const resultColumns = await builder.getResultColumns(context, config);

      expect(resultColumns.size).toBe(2);
      expect(resultColumns.has('id')).toBe(true);
      expect(resultColumns.has('name')).toBe(true);
      expect(resultColumns.has('email')).toBe(false);
    });

    it('should exclude hidden columns', async () => {
      const config: ColumnConfig = {
        hide: ['age', 'created_at'],
      };

      const resultColumns = await builder.getResultColumns(context, config);

      expect(resultColumns.size).toBe(3);
      expect(resultColumns.has('id')).toBe(true);
      expect(resultColumns.has('name')).toBe(true);
      expect(resultColumns.has('email')).toBe(true);
      expect(resultColumns.has('age')).toBe(false);
      expect(resultColumns.has('created_at')).toBe(false);
    });

    it('should return renamed column names', async () => {
      const config: ColumnConfig = {
        rename: {
          name: 'full_name',
          email: 'email_address',
        },
      };

      const resultColumns = await builder.getResultColumns(context, config);

      expect(resultColumns.has('full_name')).toBe(true);
      expect(resultColumns.has('email_address')).toBe(true);
      expect(resultColumns.has('name')).toBe(false);
      expect(resultColumns.has('email')).toBe(false);
      expect(resultColumns.has('id')).toBe(true); // Unchanged
    });

    it('should handle combined select, hide, and rename', async () => {
      const config: ColumnConfig = {
        select: ['id', 'name', 'email'],
        hide: ['email'],
        rename: {
          name: 'full_name',
        },
      };

      const resultColumns = await builder.getResultColumns(context, config);

      expect(resultColumns.size).toBe(2);
      expect(resultColumns.has('id')).toBe(true);
      expect(resultColumns.has('full_name')).toBe(true);
      expect(resultColumns.has('name')).toBe(false);
      expect(resultColumns.has('email')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should return placeholder when all columns are hidden', async () => {
      const config: ColumnConfig = {
        hide: ['id', 'name', 'email', 'age', 'created_at'],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('1 AS _placeholder');
    });

    it.skip('should handle empty select array', async () => {
      const config: ColumnConfig = {
        select: [],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('1 AS _placeholder');
    });

    it('should handle columns with special characters', async () => {
      context.availableColumns.add('user name');
      const config: ColumnConfig = {
        select: ['user name'],
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('"user name"');
    });

    it.skip('should handle renaming column to SQL keyword', async () => {
      const config: ColumnConfig = {
        rename: {
          name: 'select',
        },
      };

      const sql = await builder.build(context, config);

      expect(sql).toContain('name AS "select"');
    });

    it('should handle hiding non-existent column gracefully', async () => {
      const config: ColumnConfig = {
        hide: ['non_existent_column'],
      };

      const sql = await builder.build(context, config);

      // Should still select all available columns
      expect(sql).toContain('id, name, email, age, created_at');
    });

    it('should handle renaming non-selected column', async () => {
      const config: ColumnConfig = {
        select: ['id', 'name'],
        rename: {
          email: 'email_address', // email not in select list
        },
      };

      const sql = await builder.build(context, config);

      expect(sql).toBe('SELECT id, name FROM test_table');
      expect(sql).not.toContain('email');
    });
  });

  describe('buildSelectList', () => {
    it('should build select list with asterisk for no config', async () => {
      const selectList = builder.buildSelectList(context);

      expect(selectList).toBe('*');
    });

    it('should build select list with specific columns', async () => {
      const config: ColumnConfig = {
        select: ['id', 'name'],
      };

      const selectList = builder.buildSelectList(context, config);

      expect(selectList).toBe('id, name');
    });

    it('should build select list with renames', async () => {
      const config: ColumnConfig = {
        select: ['id', 'name'],
        rename: {
          name: 'full_name',
        },
      };

      const selectList = builder.buildSelectList(context, config);

      expect(selectList).toBe('id, name AS full_name');
    });
  });
});
