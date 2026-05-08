import { describe, it, expect } from 'vitest';
import { getUnknownErrorMessage, handleIPCError, createIPCErrorResult } from './ipc-utils';

describe('ipc-utils', () => {
  describe('getUnknownErrorMessage', () => {
    it('extracts message from Error', () => {
      expect(getUnknownErrorMessage(new Error('foo'))).toBe('foo');
    });

    it('returns string as-is', () => {
      expect(getUnknownErrorMessage('plain string')).toBe('plain string');
    });

    it('extracts message from object with message property', () => {
      expect(getUnknownErrorMessage({ message: 'obj msg' })).toBe('obj msg');
    });

    it('returns fallback for null', () => {
      expect(getUnknownErrorMessage(null)).toBe('Unknown error occurred');
    });

    it('returns fallback for undefined', () => {
      expect(getUnknownErrorMessage(undefined)).toBe('Unknown error occurred');
    });

    it('returns fallback for number', () => {
      expect(getUnknownErrorMessage(42)).toBe('Unknown error occurred');
    });

    it('uses custom fallback', () => {
      expect(getUnknownErrorMessage(null, 'custom')).toBe('custom');
    });
  });

  describe('handleIPCError', () => {
    it('returns success false with error message', () => {
      const result = handleIPCError(new Error('something failed'));
      expect(result).toEqual({ success: false, error: 'something failed' });
    });

    it('redacts sensitive tokens from error message', () => {
      const result = handleIPCError(new Error('token=secret123 failed'));
      expect(result.error).toBe('token=[REDACTED] failed');
    });

    it('redacts filesystem paths and SQL from error message', () => {
      const result = handleIPCError(
        new Error('Failed at C:\\Users\\alice\\data.duckdb: SELECT * FROM accounts')
      );
      expect(result.error).toBe('Failed at [REDACTED_PATH]: [REDACTED_SQL]');
    });
  });

  describe('createIPCErrorResult', () => {
    it('returns userError and logContext for Error', () => {
      const error = new Error('password=12345');
      const result = createIPCErrorResult(error);

      expect(result.success).toBe(false);
      expect(result.userError).toBe('password=[REDACTED]');
      expect(result.logContext).toMatchObject({
        name: 'Error',
        message: 'password=12345',
      });
      expect(result.logContext.stack).toContain('Error: password=12345');
    });

    it('returns logContext for non-Error values', () => {
      const result = createIPCErrorResult('plain error');
      expect(result.userError).toBe('plain error');
      expect(result.logContext).toEqual({ raw: 'plain error' });
    });
  });
});
