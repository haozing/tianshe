import { describe, expect, it, vi } from 'vitest';
import { ShutdownCoordinator, ShutdownStepTimeoutError } from './shutdown-coordinator';

describe('ShutdownCoordinator', () => {
  it('runs shutdown steps in order and returns an aggregate result', async () => {
    const calls: string[] = [];
    const coordinator = new ShutdownCoordinator({
      now: () => calls.length,
      steps: [
        { label: 'first', run: () => calls.push('first') },
        { label: 'second', run: async () => calls.push('second') },
      ],
    });

    await expect(coordinator.run()).resolves.toEqual({
      ok: true,
      exitCode: 0,
      steps: [
        { label: 'first', status: 'completed', durationMs: 1, error: null },
        { label: 'second', status: 'completed', durationMs: 1, error: null },
      ],
    });
    expect(calls).toEqual(['first', 'second']);
  });

  it('continues after failed steps and reports an error exit code', async () => {
    const calls: string[] = [];
    const consoleRef = { error: vi.fn() };
    const coordinator = new ShutdownCoordinator({
      consoleRef,
      steps: [
        {
          label: 'first',
          run: () => {
            calls.push('first');
            throw new Error('boom');
          },
        },
        { label: 'second', run: () => calls.push('second') },
      ],
    });

    const result = await coordinator.run();

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.steps).toMatchObject([
      { label: 'first', status: 'failed', error: 'boom' },
      { label: 'second', status: 'completed', error: null },
    ]);
    expect(calls).toEqual(['first', 'second']);
    expect(consoleRef.error).toHaveBeenCalledWith('[ERROR] first failed:', expect.any(Error));
  });

  it('marks stuck steps as timed out', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ShutdownCoordinator({
        defaultStepTimeoutMs: 25,
        steps: [
          {
            label: 'stuck',
            run: () => new Promise(() => undefined),
          },
        ],
      });

      const runPromise = coordinator.run();
      await vi.advanceTimersByTimeAsync(25);

      await expect(runPromise).resolves.toMatchObject({
        ok: false,
        exitCode: 1,
        steps: [
          {
            label: 'stuck',
            status: 'timed-out',
            error: 'Shutdown step "stuck" timed out after 25ms',
          },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes a typed timeout error for callers that need to inspect failures', () => {
    const error = new ShutdownStepTimeoutError('duckdb', 50);

    expect(error.name).toBe('ShutdownStepTimeoutError');
    expect(error.label).toBe('duckdb');
    expect(error.timeoutMs).toBe(50);
  });
});
