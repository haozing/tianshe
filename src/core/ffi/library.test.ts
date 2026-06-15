import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Library } from './library';
import type { FFIIsolatedCallRequest, FFIIsolatedCallRunner } from './types';

vi.mock('koffi', () => ({
  address: vi.fn((func) => func),
}));

class RecordingRunner implements FFIIsolatedCallRunner {
  calls: Array<{ request: FFIIsolatedCallRequest; timeoutMs: number }> = [];
  result: unknown = 123;

  async run(request: FFIIsolatedCallRequest, options: { timeoutMs: number }): Promise<unknown> {
    this.calls.push({ request, timeoutMs: options.timeoutMs });
    return this.result;
  }
}

describe('FFI Library isolation', () => {
  let runner: RecordingRunner;
  let inProcessFunction: ReturnType<typeof vi.fn>;
  let library: Library;

  beforeEach(() => {
    runner = new RecordingRunner();
    inProcessFunction = vi.fn(() => 42);
    library = new Library(
      'kernel32.dll',
      {
        func: vi.fn(() => inProcessFunction),
      },
      'test-plugin',
      {
        isolateCalls: true,
        defaultCallTimeoutMs: 250,
        isolatedCallRunner: runner,
      }
    );
  });

  it('runs async call through the isolated runner by default', async () => {
    library.defineFunction('GetCurrentProcessId', { returns: 'int', args: [] });

    const result = await library.call('GetCurrentProcessId', []);

    expect(result).toBe(123);
    expect(inProcessFunction).not.toHaveBeenCalled();
    expect(runner.calls).toEqual([
      {
        request: {
          libPath: 'kernel32.dll',
          functionName: 'GetCurrentProcessId',
          signature: { returns: 'int', args: [] },
          args: [],
          callerId: 'test-plugin',
        },
        timeoutMs: 250,
      },
    ]);
  });

  it('uses signature timeout for isolated calls', async () => {
    library.defineFunction('Sleepy', { returns: 'int', args: [], timeoutMs: 10 });

    await library.call('Sleepy', []);

    expect(runner.calls[0].timeoutMs).toBe(10);
  });

  it('rejects isolated calls that require pointer or callback arguments', async () => {
    library.defineFunction('EnumWindows', { returns: 'bool', args: ['void*', 'long'] });

    await expect(library.call('EnumWindows', [vi.fn(), 0])).rejects.toThrow(
      'does not support argument type'
    );
    expect(runner.calls).toHaveLength(0);
  });

  it('allows explicit trusted in-process calls for callback-heavy APIs', async () => {
    library.defineFunction('EnumWindows', { returns: 'bool', args: ['void*', 'long'] });

    const result = await library.callUnsafeInProcess('EnumWindows', [vi.fn(), 0]);

    expect(result).toBe(42);
    expect(inProcessFunction).toHaveBeenCalledTimes(1);
    expect(runner.calls).toHaveLength(0);
  });
});
