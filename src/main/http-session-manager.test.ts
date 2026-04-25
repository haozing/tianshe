import { describe, expect, it, vi } from 'vitest';
import type { BrowserHandle } from '../core/browser-pool';
import { ErrorCode } from '../types/error-codes';
import type { McpSessionInfo } from './mcp-http-types';
import {
  cleanupMcpSession,
  enqueueInvokeTask,
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
  browserAcquireFailureCount: 0,
  browserAcquireTimeoutCount: 0,
});

const createMcpSession = (
  overrides: Partial<McpSessionInfo> = {}
): McpSessionInfo => ({
  transport: {
    close: vi.fn(),
  } as never,
  lastActivity: Date.now(),
  invokeQueue: Promise.resolve(),
  pendingInvocations: 0,
  activeInvocations: 0,
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
      session,
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
    expect(session.pendingInvocations).toBe(0);
    expect(session.activeInvocations).toBe(0);
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
      session,
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
    expect(session.pendingInvocations).toBe(0);
    expect(session.activeInvocations).toBe(0);
  });
});
