import { describe, expect, it, vi } from 'vitest';
import type { McpSessionInfo } from './mcp-http-types';
import type { OrchestrationSessionInfo } from './orchestration-http-routes';
import { createHttpSessionBridge } from './http-session-bridge';

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
});

describe('http-session-bridge', () => {
  it('buildRuntimeMetricsPayload 返回会话与计数快照', () => {
    const transports = new Map<string, McpSessionInfo>();
    const orchestrationSessions = new Map<string, OrchestrationSessionInfo>();
    const runtimeMetrics = {
      queueOverflowCount: 2,
      invokeTimeoutCount: 1,
      browserAcquireFailureCount: 3,
      browserAcquireTimeoutCount: 1,
    };
    transports.set('mcp-1', {
      transport: {} as never,
      lastActivity: Date.now(),
      invokeQueue: Promise.resolve(),
      pendingInvocations: 0,
      activeInvocations: 0,
      maxQueueSize: 10,
    });
    orchestrationSessions.set('orch-1', {
      browserHandle: {} as never,
      executor: {} as never,
      invokeQueue: Promise.resolve(),
      pendingInvocations: 0,
      activeInvocations: 0,
      maxQueueSize: 10,
      lastActivity: Date.now(),
      idempotencyCache: new Map(),
    });

    const bridge = createHttpSessionBridge({
      transports,
      orchestrationSessions,
      runtimeMetrics,
      sessionTimeoutMs: 60_000,
      logger: createLogger(),
    });

    const payload = bridge.buildRuntimeMetricsPayload();
    expect(payload.activeSessions.total).toBe(2);
    expect(payload.activeSessions.mcp).toBe(1);
    expect(payload.activeSessions.orchestration).toBe(1);
    expect(payload.counters.queueOverflowCount).toBe(2);
    expect(payload.counters.browserAcquireFailureCount).toBe(3);
  });

  it('cleanupInactiveSessions 会调用会话清理并移除超时会话', async () => {
    const now = Date.now();
    const mcpCleanup = vi.fn().mockResolvedValue(undefined);
    const orchCleanup = vi.fn().mockResolvedValue(undefined);

    const transports = new Map<string, McpSessionInfo>([
      [
        'stale-mcp',
        {
          transport: {} as never,
          lastActivity: now - 120_000,
          invokeQueue: Promise.resolve(),
          pendingInvocations: 0,
          activeInvocations: 0,
          maxQueueSize: 10,
        },
      ],
    ]);
    const orchestrationSessions = new Map<string, OrchestrationSessionInfo>([
      [
        'stale-orch',
        {
          browserHandle: {} as never,
          executor: {} as never,
          invokeQueue: Promise.resolve(),
          pendingInvocations: 0,
          activeInvocations: 0,
          maxQueueSize: 10,
          lastActivity: now - 120_000,
          idempotencyCache: new Map(),
        },
      ],
    ]);

    const bridge = createHttpSessionBridge({
      transports,
      orchestrationSessions,
      runtimeMetrics: {
        queueOverflowCount: 0,
        invokeTimeoutCount: 0,
        browserAcquireFailureCount: 0,
        browserAcquireTimeoutCount: 0,
      },
      sessionTimeoutMs: 60_000,
      logger: createLogger(),
    });
    bridge.cleanupMcpSession = mcpCleanup;
    bridge.cleanupOrchestrationSession = orchCleanup;

    bridge.cleanupInactiveSessions();
    await Promise.resolve();

    expect(mcpCleanup).toHaveBeenCalledWith(
      'stale-mcp',
      expect.objectContaining({ lastActivity: expect.any(Number) })
    );
    expect(orchCleanup).toHaveBeenCalledWith(
      'stale-orch',
      expect.objectContaining({ lastActivity: expect.any(Number) })
    );
    expect(transports.size).toBe(0);
    expect(orchestrationSessions.size).toBe(0);
  });

  it('cleanupInactiveSessions 会更早回收未获取浏览器的空闲 MCP session', async () => {
    const now = Date.now();
    const mcpCleanup = vi.fn().mockResolvedValue(undefined);

    const transports = new Map<string, McpSessionInfo>([
      [
        'idle-without-browser',
        {
          transport: {} as never,
          lastActivity: now - 10 * 60 * 1000,
          invokeQueue: Promise.resolve(),
          pendingInvocations: 0,
          activeInvocations: 0,
          maxQueueSize: 10,
          visible: false,
        },
      ],
      [
        'idle-with-browser',
        {
          transport: {} as never,
          lastActivity: now - 10 * 60 * 1000,
          invokeQueue: Promise.resolve(),
          pendingInvocations: 0,
          activeInvocations: 0,
          maxQueueSize: 10,
          visible: false,
          browserHandle: {} as never,
        },
      ],
    ]);

    const bridge = createHttpSessionBridge({
      transports,
      orchestrationSessions: new Map(),
      runtimeMetrics: {
        queueOverflowCount: 0,
        invokeTimeoutCount: 0,
        browserAcquireFailureCount: 0,
        browserAcquireTimeoutCount: 0,
      },
      sessionTimeoutMs: 30 * 60 * 1000,
      logger: createLogger(),
    });
    bridge.cleanupMcpSession = mcpCleanup;

    bridge.cleanupInactiveSessions();
    await Promise.resolve();

    expect(mcpCleanup).toHaveBeenCalledTimes(1);
    expect(mcpCleanup).toHaveBeenCalledWith(
      'idle-without-browser',
      expect.objectContaining({ lastActivity: expect.any(Number) })
    );
    expect(transports.has('idle-without-browser')).toBe(false);
    expect(transports.has('idle-with-browser')).toBe(true);
  });

  it('cleanupInactiveSessions 会强制回收超过 grace 的 closing MCP session', async () => {
    const now = Date.now();
    const mcpCleanup = vi.fn().mockResolvedValue(undefined);

    const transports = new Map<string, McpSessionInfo>([
      [
        'closing-mcp',
        {
          transport: {} as never,
          lastActivity: now - 20_000,
          invokeQueue: Promise.resolve(),
          pendingInvocations: 1,
          activeInvocations: 1,
          maxQueueSize: 10,
          visible: false,
          closing: true,
        },
      ],
    ]);

    const bridge = createHttpSessionBridge({
      transports,
      orchestrationSessions: new Map(),
      runtimeMetrics: {
        queueOverflowCount: 0,
        invokeTimeoutCount: 0,
        browserAcquireFailureCount: 0,
        browserAcquireTimeoutCount: 0,
      },
      sessionTimeoutMs: 30 * 60 * 1000,
      logger: createLogger(),
    });
    bridge.cleanupMcpSession = mcpCleanup;

    bridge.cleanupInactiveSessions();
    await Promise.resolve();

    expect(mcpCleanup).toHaveBeenCalledTimes(1);
    expect(transports.size).toBe(0);
  });
});
