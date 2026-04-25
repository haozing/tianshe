import { describe, expect, it } from 'vitest';
import { createHttpRuntimeState, getSessionCounts } from './http-runtime-state';

describe('http-runtime-state', () => {
  it('默认初始化为空会话与零指标', () => {
    const state = createHttpRuntimeState();
    expect(state.transports.size).toBe(0);
    expect(state.orchestrationSessions.size).toBe(0);
    expect(state.runtimeMetrics).toEqual({
      queueOverflowCount: 0,
      invokeTimeoutCount: 0,
      browserAcquireFailureCount: 0,
      browserAcquireTimeoutCount: 0,
    });
  });

  it('getSessionCounts 返回聚合会话计数', () => {
    const state = createHttpRuntimeState();
    state.transports.set('mcp-1', {} as never);
    state.transports.set('mcp-2', {} as never);
    state.orchestrationSessions.set('orch-1', {} as never);

    expect(getSessionCounts(state)).toEqual({
      activeSessions: 3,
      mcpSessions: 2,
      orchestrationSessions: 1,
    });
  });
});
