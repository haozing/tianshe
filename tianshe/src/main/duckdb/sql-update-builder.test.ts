import { describe, it, expect } from 'vitest';
import { SqlUpdateBuilder } from './sql-update-builder';

describe('SqlUpdateBuilder', () => {
  describe('set', () => {
    it('adds a field when value is defined', () => {
      const builder = new SqlUpdateBuilder().set('name', 'foo');
      expect(builder.isEmpty).toBe(false);
      expect(builder.changeCount).toBe(1);
    });

    it('skips undefined values', () => {
      const builder = new SqlUpdateBuilder().set('name', undefined);
      expect(builder.isEmpty).toBe(true);
      expect(builder.changeCount).toBe(0);
    });

    it('includes null values (null !== undefined)', () => {
      const builder = new SqlUpdateBuilder().set('name', null);
      expect(builder.isEmpty).toBe(false);
      expect(builder.changeCount).toBe(1);
    });

    it('includes false values (false !== undefined)', () => {
      const builder = new SqlUpdateBuilder().set('active', false);
      expect(builder.isEmpty).toBe(false);
      expect(builder.changeCount).toBe(1);
    });

    it('includes zero values (0 !== undefined)', () => {
      const builder = new SqlUpdateBuilder().set('count', 0);
      expect(builder.isEmpty).toBe(false);
      expect(builder.changeCount).toBe(1);
    });

    it('includes empty string values ("" !== undefined)', () => {
      const builder = new SqlUpdateBuilder().set('name', '');
      expect(builder.isEmpty).toBe(false);
      expect(builder.changeCount).toBe(1);
    });

    it('applies normalize function when provided', () => {
      const builder = new SqlUpdateBuilder().set('name', '  foo  ', (v) =>
        String(v).trim()
      );
      const result = builder.build('users', 'id', 1);
      expect(result!.values[0]).toBe('foo');
    });

    it('chains multiple sets fluently', () => {
      const builder = new SqlUpdateBuilder()
        .set('a', 1)
        .set('b', 2)
        .set('c', undefined);
      expect(builder.changeCount).toBe(2);
    });
  });

  describe('build', () => {
    it('returns null when no fields are set', () => {
      const builder = new SqlUpdateBuilder();
      expect(builder.build('users', 'id', 1)).toBeNull();
    });

    it('builds correct SQL for a single field', () => {
      const builder = new SqlUpdateBuilder().set('name', 'foo');
      const result = builder.build('users', 'id', 1);
      expect(result).toEqual({
        sql: 'UPDATE users SET name = ? WHERE id = ?',
        values: ['foo', 1],
      });
    });

    it('builds correct SQL for multiple fields', () => {
      const builder = new SqlUpdateBuilder()
        .set('name', 'foo')
        .set('age', 30)
        .set('active', true);
      const result = builder.build('users', 'id', 42);
      expect(result).toEqual({
        sql: 'UPDATE users SET name = ?, age = ?, active = ? WHERE id = ?',
        values: ['foo', 30, true, 42],
      });
    });

    it('places whereValue at the end of values array', () => {
      const builder = new SqlUpdateBuilder()
        .set('a', 1)
        .set('b', 2);
      const result = builder.build('t', 'pk', 'key');
      expect(result!.values).toEqual([1, 2, 'key']);
    });

    it('includes raw expressions without adding to values', () => {
      const builder = new SqlUpdateBuilder()
        .set('name', 'foo')
        .setRaw('updated_at', 'CURRENT_TIMESTAMP');
      const result = builder.build('users', 'id', 1);
      expect(result!.sql).toBe(
        'UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      );
      expect(result!.values).toEqual(['foo', 1]);
    });

    it('counts raw expressions in changeCount', () => {
      const builder = new SqlUpdateBuilder()
        .set('a', 1)
        .setRaw('b', 'NOW()');
      expect(builder.changeCount).toBe(2);
    });
  });
});
