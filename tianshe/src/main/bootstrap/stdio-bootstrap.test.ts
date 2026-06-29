import { describe, expect, it, vi } from 'vitest';
import {
  installStdioBrokenPipeGuards,
  isIgnorableBrokenPipeError,
} from './stdio-bootstrap';

function createBrokenPipeError(): NodeJS.ErrnoException {
  const error = new Error('EPIPE: broken pipe, write') as NodeJS.ErrnoException;
  error.code = 'EPIPE';
  return error;
}

describe('stdio-bootstrap', () => {
  it('recognizes ignorable broken pipe errors', () => {
    expect(isIgnorableBrokenPipeError(createBrokenPipeError())).toBe(true);
    expect(isIgnorableBrokenPipeError(new Error('other failure'))).toBe(false);
  });

  it('wraps console methods and swallows broken pipe writes', () => {
    const consoleRef = {
      log: vi.fn(() => {
        throw createBrokenPipeError();
      }),
      warn: vi.fn(() => {
        throw new Error('real failure');
      }),
    };

    installStdioBrokenPipeGuards({
      consoleRef,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    });

    expect(() => consoleRef.log?.('hello')).not.toThrow();
    expect(() => consoleRef.warn?.('boom')).toThrow('real failure');
  });

  it('attaches stream listeners that ignore broken pipe errors', () => {
    const stdoutListeners: Array<(error: unknown) => void> = [];
    const stderrListeners: Array<(error: unknown) => void> = [];

    installStdioBrokenPipeGuards({
      consoleRef: { log: vi.fn() },
      stdout: {
        on: vi.fn((event, listener) => {
          if (event === 'error') stdoutListeners.push(listener);
        }),
      },
      stderr: {
        on: vi.fn((event, listener) => {
          if (event === 'error') stderrListeners.push(listener);
        }),
      },
    });

    expect(stdoutListeners).toHaveLength(1);
    expect(stderrListeners).toHaveLength(1);
    expect(() => stdoutListeners[0]?.(createBrokenPipeError())).not.toThrow();
    expect(() => stderrListeners[0]?.(new Error('stream failed'))).toThrow('stream failed');
  });
});
