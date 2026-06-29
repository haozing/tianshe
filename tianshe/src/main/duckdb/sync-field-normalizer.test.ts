import { describe, expect, it } from 'vitest';
import {
  normalizeSyncString,
  normalizeSyncInteger,
  normalizeSyncBoolean,
  normalizeSyncTimestamp,
  normalizeSyncScope,
  normalizeSyncOwnership,
} from './sync-field-normalizer';

describe('SyncFieldNormalizer', () => {
  describe('normalizeSyncString', () => {
    it('trims and returns non-empty strings', () => {
      expect(normalizeSyncString('hello')).toBe('hello');
      expect(normalizeSyncString('  hello  ')).toBe('hello');
    });

    it('returns null for empty, whitespace-only, null or undefined', () => {
      expect(normalizeSyncString('')).toBeNull();
      expect(normalizeSyncString('   ')).toBeNull();
      expect(normalizeSyncString(null)).toBeNull();
      expect(normalizeSyncString(undefined)).toBeNull();
    });

    it('coerces non-string values', () => {
      expect(normalizeSyncString(123)).toBe('123');
      expect(normalizeSyncString(false)).toBe('false');
    });
  });

  describe('normalizeSyncInteger', () => {
    it('truncates and returns finite numbers', () => {
      expect(normalizeSyncInteger(42)).toBe(42);
      expect(normalizeSyncInteger(42.9)).toBe(42);
      expect(normalizeSyncInteger(-3)).toBe(-3);
    });

    it('returns null for non-finite values', () => {
      expect(normalizeSyncInteger(NaN)).toBeNull();
      expect(normalizeSyncInteger(Infinity)).toBeNull();
      expect(normalizeSyncInteger('abc')).toBeNull();
      expect(normalizeSyncInteger(null)).toBeNull();
    });

    it('respects optional min constraint', () => {
      expect(normalizeSyncInteger(5, { min: 1 })).toBe(5);
      expect(normalizeSyncInteger(0, { min: 1 })).toBeNull();
      expect(normalizeSyncInteger(-1, { min: 1 })).toBeNull();
    });
  });

  describe('normalizeSyncBoolean', () => {
    it('returns booleans as-is', () => {
      expect(normalizeSyncBoolean(true)).toBe(true);
      expect(normalizeSyncBoolean(false)).toBe(false);
    });

    it('converts numbers', () => {
      expect(normalizeSyncBoolean(1)).toBe(true);
      expect(normalizeSyncBoolean(0)).toBe(false);
      expect(normalizeSyncBoolean(-1)).toBe(true);
    });

    it('converts string representations', () => {
      expect(normalizeSyncBoolean('true')).toBe(true);
      expect(normalizeSyncBoolean('TRUE')).toBe(true);
      expect(normalizeSyncBoolean('1')).toBe(true);
      expect(normalizeSyncBoolean('false')).toBe(false);
      expect(normalizeSyncBoolean('0')).toBe(false);
      expect(normalizeSyncBoolean('')).toBe(false);
    });
  });

  describe('normalizeSyncTimestamp', () => {
    it('returns ISO string for Date', () => {
      const d = new Date('2024-01-15T08:30:00.000Z');
      expect(normalizeSyncTimestamp(d)).toBe(d.toISOString());
    });

    it('returns null for null/undefined/invalid Date', () => {
      expect(normalizeSyncTimestamp(null)).toBeNull();
      expect(normalizeSyncTimestamp(undefined)).toBeNull();
      expect(normalizeSyncTimestamp(new Date('invalid'))).toBeNull();
    });

    it('coerces non-Date values to trimmed string or null', () => {
      expect(normalizeSyncTimestamp('2024-01-15')).toBe('2024-01-15');
      expect(normalizeSyncTimestamp('')).toBeNull();
    });
  });

  describe('normalizeSyncScope', () => {
    it('returns normalized scopeType and scopeId', () => {
      expect(normalizeSyncScope('team', 42)).toEqual({
        scopeType: 'team',
        scopeId: 42,
      });
    });

    it('returns nulls for invalid inputs', () => {
      expect(normalizeSyncScope('', NaN)).toEqual({
        scopeType: null,
        scopeId: null,
      });
    });
  });

  describe('normalizeSyncOwnership', () => {
    it('returns normalized ownerUserId and ownerUserName', () => {
      expect(normalizeSyncOwnership(7, 'alice')).toEqual({
        ownerUserId: 7,
        ownerUserName: 'alice',
      });
    });

    it('returns nulls for invalid inputs', () => {
      expect(normalizeSyncOwnership('bad', '')).toEqual({
        ownerUserId: null,
        ownerUserName: null,
      });
    });
  });
});
