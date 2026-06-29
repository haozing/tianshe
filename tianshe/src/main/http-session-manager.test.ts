import { describe, expect, it, vi } from 'vitest';
import type { BrowserHandle } from '../core/browser-pool';
import { ErrorCode } from '../types/error-codes';
import {
  createMcpSessionInfo,
  type CreateMcpSessionInfoOptions,
  type McpSessionInfo,
} from './mcp-http-types';
import {
  cleanupMcpSession,
  enqueueInvokeTask,
  getMcpInvokeQueueState,
  type RuntimeMetricsSnapshot,
} from './http-session-manager';

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
});

const createRuntimeMetrics = (): RuntimeMetricsSnapshot => ({
  queueOverflowCount: 0,
  invokeTimeoutCount: 0,
  abandonedInvocationCount: 0,
  browserAcquireFailureCount: 0,
  browserAcquireTimeoutCount: 0,
});

const createMcpSession = (
  overrides: Partial<CreateMcpSessionInfoOptions> = {}
): McpSessionInfo =>
  createMcpSessionInfo({
    transport: {
      close: vi.fn(),
    } as never,
    lastActivity: Date.now(),
    maxQueueSize: 8,
    visible: false,
    ...overrides,
  });

describe('http-session-manager', () => {
  it('enqueueInvokeTask aborts the task signal when invoke timeout fires', async () => {
    const runtimeMetrics = createRuntimeMetrics();
    const logger = createLogger();
    const session = createMcpSession();
    let capturedSignal: AbortSignal | undefined;

    const invoke = enqueueInvokeTask({
      sessionLabel: 'mcp-timeout',
      session: getMcpInvokeQueueState(session),
      task: async ({ signal }) => {
        capturedSignal = signal;
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
          );
        });
      },
      options: { timeoutMs: 30 },
      runtimeMetrics,
      logger,
    });

    await expect(invoke).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
      context: expect.objectContaining({ reason: 'invoke_timeout' }),
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(runtimeMetrics.invokeTimeoutCount).toBe(1);
    expect(session.queue.pendingInvocations).toBe(0);
    expect(session.queue.activeInvocations).toBe(0);
  });

  it('does not start the next invoke until a timed-out task has actually drained', async () => {
    vi.useFakeTimers();
    const runtimeMetrics = createRuntimeMetrics();
    const logger = createLogger();
    const session = createMcpSession();
    const events: string[] = [];
    let finishFirst!: () => void;

    const firstInvoke = enqueueInvokeTask({
      sessionLabel: 'mcp-serial-timeout',
      session: getMcpInvokeQueueState(session),
      task: async () => {
        events.push('first:start');
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        events.push('first:end');
        return 'first';
      },
      options: { timeoutMs: 30, drainTimeoutMs: 1_000 },
      runtimeMetrics,
      logger,
    });
    const firstExpectation = expect(firstInvoke).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
      context: expect.objectContaining({ reason: 'invoke_timeout' }),
    });

    await vi.advanceTimersByTimeAsync(1);
    const secondInvoke = enqueueInvokeTask({
      sessionLabel: 'mcp-serial-timeout',
      session: getMcpInvokeQueueState(session),
      task: async () => {
        events.push('second:start');
        return 'second';
      },
      options: { timeoutMs: 1_000, drainTimeoutMs: 1_000 },
      runtimeMetrics,
      logger,
    });
    const secondExpectation = expect(secondInvoke).resolves.toBe('second');

    await vi.advanceTimersByTimeAsync(30);
    await firstExpectation;
    expect(events).toEqual(['first:start']);
    expect(session.queue.pendingInvocations).toBe(2);
    expect(session.queue.activeInvocations).toBe(1);

    finishFirst();
    await vi.advanceTimersByTimeAsync(1);
    await secondExpectation;
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(runtimeMetrics.abandonedInvocationCount ?? 0).toBe(0);
    expect(session.queue.pendingInvocations).toBe(0);
    expect(session.queue.activeInvocations).toBe(0);
    vi.useRealTimers();
  });

  it('closes the session when a timed-out task ignores abort beyond the drain budget', async () => {
    vi.useFakeTimers();
    const runtimeMetrics = createRuntimeMetrics();
    const logger = createLogger();
    const session = createMcpSession();
    const events: string[] = [];

    const firstInvoke = enqueueInvokeTask({
      sessionLabel: 'mcp-abandoned',
      session: getMcpInvokeQueueState(session),
      task: async () => {
        events.push('first:start');
        return await new Promise<string>(() => undefined);
      },
      options: { timeoutMs: 30, drainTimeoutMs: 40 },
      runtimeMetrics,
      logger,
    });
    const firstExpectation = expect(firstInvoke).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
      context: expect.objectContaining({ reason: 'invoke_timeout' }),
    });

    await vi.advanceTimersByTimeAsync(1);
    const secondInvoke = enqueueInvokeTask({
      sessionLabel: 'mcp-abandoned',
      session: getMcpInvokeQueueState(session),
      task: async () => {
        events.push('second:start');
        return 'second';
      },
      options: { timeoutMs: 1_000, drainTimeoutMs: 40 },
      runtimeMetrics,
      logger,
    });
    const secondExpectation = expect(secondInvoke).rejects.toMatchObject({
      code: ErrorCode.OPERATION_FAILED,
      context: expect.objectContaining({ reason: 'invoke_abandoned' }),
    });

    await vi.advanceTimersByTimeAsync(30);
    await firstExpectation;
    await vi.advanceTimersByTimeAsync(40);
    await secondExpectation;
    expect(events).toEqual(['first:start']);
    expect(runtimeMetrics.abandonedInvocationCount).toBe(1);
    expect(session.lifecycle.closing).toBe(true);
    expect(session.queue.pendingInvocations).toBe(0);
    expect(session.queue.activeInvocations).toBe(0);
    vi.useRealTimers();
  });

  it('cleanupMcpSession aborts in-flight invoke and forces browser release', async () => {
    const runtimeMetrics = createRuntimeMetrics();
    const logger = createLogger();
    const release = vi.fn().mockResolvedValue({
      browserId: 'browser-1',
      sessionId: 'pool-1',
      remainingBrowserCount: 0,
      state: 'destroyed',
    });
    const browserHandle = {
      release,
    } as unknown as BrowserHandle;
    const transportClose = vi.fn();
    const session = createMcpSession({
      sessionId: 'mcp-cleanup',
      transport: {
        close: transportClose,
      } as never,
      browserHandle,
    });

    const invoke = enqueueInvokeTask({
      sessionLabel: 'mcp-cleanup',
      session: getMcpInvokeQueueState(session),
      task: async ({ signal }) =>
        await new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
          );
        }),
      options: { timeoutMs: 5_000 },
      runtimeMetrics,
      logger,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await cleanupMcpSession('mcp-cleanup', session, logger);

    await expect(invoke).rejects.toMatchObject({
      code: ErrorCode.OPERATION_FAILED,
      context: expect.objectContaining({ reason: 'session_closing' }),
    });
    expect(transportClose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ destroy: true });
    expect(session.queue.pendingInvocations).toBe(0);
    expect(session.queue.activeInvocations).toBe(0);
  });
});
