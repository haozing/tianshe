import type { McpSessionInfo } from './mcp-http-types';
import type { OrchestrationSessionInfo } from './orchestration-http-routes';
import {
  buildRuntimeMetricsPayload,
  cleanupInactiveSessions,
  cleanupMcpSession,
  cleanupOrchestrationSession,
  enqueueInvokeTask,
  enqueueOrchestrationInvoke,
  type InvokeTaskContext,
  type InvokeQueueState,
  type RuntimeMetricsPayload,
  type RuntimeMetricsSnapshot,
} from './http-session-manager';

interface LoggerLike {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface CreateHttpSessionBridgeOptions {
  transports: Map<string, McpSessionInfo>;
  orchestrationSessions: Map<string, OrchestrationSessionInfo>;
  runtimeMetrics: RuntimeMetricsSnapshot;
  sessionTimeoutMs: number;
  logger: LoggerLike;
}

export interface HttpSessionBridge {
  buildRuntimeMetricsPayload: () => RuntimeMetricsPayload;
  enqueueInvokeTask: <T>(
    sessionLabel: string,
    session: InvokeQueueState,
    task: (context: InvokeTaskContext) => Promise<T>,
    options: { timeoutMs: number }
  ) => Promise<T>;
  enqueueOrchestrationInvoke: <T>(
    sessionId: string,
    session: OrchestrationSessionInfo,
    task: (context: InvokeTaskContext) => Promise<T>
  ) => Promise<T>;
  cleanupInactiveSessions: () => void;
  cleanupMcpSession: (sessionId: string, session: McpSessionInfo) => Promise<void>;
  cleanupOrchestrationSession: (
    sessionId: string,
    session: OrchestrationSessionInfo
  ) => Promise<void>;
}

/**
 * 统一封装 HTTP 会话相关桥接逻辑（队列、清理、指标）。
 */
export const createHttpSessionBridge = ({
  transports,
  orchestrationSessions,
  runtimeMetrics,
  sessionTimeoutMs,
  logger,
}: CreateHttpSessionBridgeOptions): HttpSessionBridge => {
  const bridge: HttpSessionBridge = {
    buildRuntimeMetricsPayload: () =>
      buildRuntimeMetricsPayload({
        transports,
        orchestrationSessions,
        runtimeMetrics,
      }),
    enqueueInvokeTask: (sessionLabel, session, task, options) =>
      enqueueInvokeTask({
        sessionLabel,
        session,
        task,
        options,
        runtimeMetrics,
        logger,
      }),
    enqueueOrchestrationInvoke: (sessionId, session, task) =>
      enqueueOrchestrationInvoke({
        sessionId,
        session,
        task,
        runtimeMetrics,
        logger,
      }),
    cleanupInactiveSessions: () =>
      cleanupInactiveSessions({
        transports,
        orchestrationSessions,
        timeoutMs: sessionTimeoutMs,
        logger,
        cleanupMcpSession: (sessionId, session) => bridge.cleanupMcpSession(sessionId, session),
        cleanupOrchestrationSession: (sessionId, session) =>
          bridge.cleanupOrchestrationSession(sessionId, session),
      }),
    cleanupMcpSession: (sessionId, session) => cleanupMcpSession(sessionId, session, logger),
    cleanupOrchestrationSession: (sessionId, session) =>
      cleanupOrchestrationSession(sessionId, session, logger),
  };

  return bridge;
};
