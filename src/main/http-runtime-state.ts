import type { McpSessionInfo } from './mcp-http-types';
import type { OrchestrationSessionInfo } from './orchestration-http-routes';
import type { RuntimeMetricsSnapshot } from './http-session-manager';

export interface HttpRuntimeState {
  transports: Map<string, McpSessionInfo>;
  orchestrationSessions: Map<string, OrchestrationSessionInfo>;
  runtimeMetrics: RuntimeMetricsSnapshot;
}

/**
 * 创建 HTTP 入口运行时状态（会话与指标）。
 */
export const createHttpRuntimeState = (): HttpRuntimeState => ({
  transports: new Map<string, McpSessionInfo>(),
  orchestrationSessions: new Map<string, OrchestrationSessionInfo>(),
  runtimeMetrics: {
    queueOverflowCount: 0,
    invokeTimeoutCount: 0,
    browserAcquireFailureCount: 0,
    browserAcquireTimeoutCount: 0,
  },
});

export interface SessionCountsSnapshot {
  activeSessions: number;
  mcpSessions: number;
  orchestrationSessions: number;
}

export const getSessionCounts = (
  state: Pick<HttpRuntimeState, 'transports' | 'orchestrationSessions'>
): SessionCountsSnapshot => {
  const mcpSessions = state.transports.size;
  const orchestrationSessions = state.orchestrationSessions.size;
  return {
    activeSessions: mcpSessions + orchestrationSessions,
    mcpSessions,
    orchestrationSessions,
  };
};
