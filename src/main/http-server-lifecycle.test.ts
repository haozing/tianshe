import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { startHttpServer, stopHttpServer } from './http-server-lifecycle';

const createLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
});

describe('http-server-lifecycle', () => {
  const serversToClose: HttpServer[] = [];

  afterEach(async () => {
    while (serversToClose.length > 0) {
      const server = serversToClose.pop();
      if (!server) {
        continue;
      }
      if (!server.listening) {
        continue;
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('startHttpServer 在开启 session 支持时会设置 cleanup timer', async () => {
    const app = express();
    const cleanupSpy = vi.fn();
    const logger = createLogger();

    const started = await startHttpServer({
      app,
      port: 0,
      bindAddress: '127.0.0.1',
      mcpEnabled: true,
      availableToolsCount: 38,
      sessionSupportEnabled: true,
      sessionTimeoutMs: 30000,
      sessionCleanupIntervalMs: 20,
      onCleanupInactiveSessions: cleanupSpy,
      logger,
    });
    serversToClose.push(started.httpServer);

    expect(started.httpServer.listening).toBe(true);
    expect(started.cleanupTimer).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(cleanupSpy).toHaveBeenCalled();

    const stopped = await stopHttpServer({
      httpServer: started.httpServer,
      cleanupTimer: started.cleanupTimer,
      transports: new Map<string, {}>(),
      orchestrationSessions: new Map<string, {}>(),
      cleanupMcpSession: vi.fn().mockResolvedValue(undefined),
      cleanupOrchestrationSession: vi.fn().mockResolvedValue(undefined),
      logger,
    });
    expect(stopped.httpServer).toBeNull();
    expect(stopped.cleanupTimer).toBeNull();
  });

  it('stopHttpServer 会等待会话清理任务结束后再返回', async () => {
    const app = express();
    const logger = createLogger();
    const started = await startHttpServer({
      app,
      port: 0,
      bindAddress: '127.0.0.1',
      mcpEnabled: false,
      availableToolsCount: 0,
      sessionSupportEnabled: false,
      sessionTimeoutMs: 30000,
      sessionCleanupIntervalMs: 1000,
      onCleanupInactiveSessions: vi.fn(),
      logger,
    });
    serversToClose.push(started.httpServer);

    let resolveMcpCleanup: (() => void) | undefined;
    let resolveOrchestrationCleanup: (() => void) | undefined;
    const cleanupMcpSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMcpCleanup = resolve;
        })
    );
    const cleanupOrchestrationSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOrchestrationCleanup = resolve;
        })
    );

    const transports = new Map<string, {}>([['mcp-session-1', {}]]);
    const orchestrationSessions = new Map<string, {}>([['orch-session-1', {}]]);

    let stopResolved = false;
    const stopPromise = stopHttpServer({
      httpServer: started.httpServer,
      cleanupTimer: started.cleanupTimer,
      transports,
      orchestrationSessions,
      cleanupMcpSession,
      cleanupOrchestrationSession,
      logger,
    }).then(() => {
      stopResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopResolved).toBe(false);
    expect(cleanupMcpSession).toHaveBeenCalledWith('mcp-session-1', {});
    expect(cleanupOrchestrationSession).toHaveBeenCalledWith('orch-session-1', {});
    expect(transports.size).toBe(0);
    expect(orchestrationSessions.size).toBe(0);

    resolveMcpCleanup?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopResolved).toBe(false);

    resolveOrchestrationCleanup?.();
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it('stopHttpServer 在底层 server 已关闭时应幂等返回', async () => {
    const app = express();
    const logger = createLogger();
    const started = await startHttpServer({
      app,
      port: 0,
      bindAddress: '127.0.0.1',
      mcpEnabled: false,
      availableToolsCount: 0,
      sessionSupportEnabled: false,
      sessionTimeoutMs: 30000,
      sessionCleanupIntervalMs: 1000,
      onCleanupInactiveSessions: vi.fn(),
      logger,
    });

    await new Promise<void>((resolve) => {
      started.httpServer.close(() => resolve());
    });

    const stopped = await stopHttpServer({
      httpServer: started.httpServer,
      cleanupTimer: started.cleanupTimer,
      transports: new Map<string, {}>(),
      orchestrationSessions: new Map<string, {}>(),
      cleanupMcpSession: vi.fn().mockResolvedValue(undefined),
      cleanupOrchestrationSession: vi.fn().mockResolvedValue(undefined),
      logger,
    });

    expect(stopped.httpServer).toBeNull();
    expect(stopped.cleanupTimer).toBeNull();
  });
});
