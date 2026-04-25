/**
 * HTTP API 配置常量
 */

import { AIRPA_RUNTIME_CONFIG } from './runtime-config';

export interface HttpApiConfig {
  /** HTTP 服务器开关 */
  enabled: boolean;
  /** HTTP/MCP 监听端口，固定同步 runtime-config */
  port: number;
  /** Token 认证开关 */
  enableAuth: boolean;
  /**
   * MCP 端点是否需要鉴权
   * - true: /mcp 需要 Bearer token（默认，推荐）
   * - false: /mcp 免鉴权（仅限本地开发或已有其他安全措施）
   */
  mcpRequireAuth: boolean;
  mcpAllowedOrigins: string[];
  /** 认证 Token */
  token?: string;
  /** Webhook 回调 URL */
  callbackUrl?: string;
  /** MCP 服务开关（独立于 HTTP，供 Claude Code 等 AI 工具使用）*/
  enableMcp?: boolean;
  /** 是否强制执行 orchestration requiredScopes 校验 */
  enforceOrchestrationScopes: boolean;
  /**
   * 编排幂等存储策略
   * - memory: 默认，仅会话内内存
   * - duckdb: 使用现有 DuckDB 持久化
   */
  orchestrationIdempotencyStore: 'memory' | 'duckdb';
  /** 全局开发模式开关（打包后仍可启用开发功能）*/
  enableDevMode?: boolean;
}

/**
 * 默认 HTTP API 配置
 */
export const DEFAULT_HTTP_API_CONFIG: HttpApiConfig = {
  enabled: false,
  port: AIRPA_RUNTIME_CONFIG.http.port,
  enableAuth: false,
  mcpRequireAuth: true,
  mcpAllowedOrigins: [],
  token: '',
  callbackUrl: '',
  enableMcp: false,
  enforceOrchestrationScopes: false,
  orchestrationIdempotencyStore: 'memory',
  enableDevMode: false,
};

const readBoolean = (value: unknown, fallback: boolean): boolean => {
  return typeof value === 'boolean' ? value : fallback;
};

const readString = (value: unknown, fallback: string): string => {
  return typeof value === 'string' ? value : fallback;
};

const readStringArray = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);

  return Array.from(new Set(normalized));
};

const readIdempotencyStore = (value: unknown): 'memory' | 'duckdb' => {
  return value === 'duckdb' ? 'duckdb' : 'memory';
};

/**
 * 归一化 HTTP API 配置
 * - 为历史配置补齐新增字段
 * - 屏蔽无效类型，确保运行时拿到稳定布尔值
 */
export const normalizeHttpApiConfig = (input: Partial<HttpApiConfig> | null | undefined): HttpApiConfig => {
  const config = input ?? {};

  return {
    enabled: readBoolean(config.enabled, DEFAULT_HTTP_API_CONFIG.enabled),
    // Port is fixed by runtime config. Ignore any legacy value persisted in electron-store.
    port: DEFAULT_HTTP_API_CONFIG.port,
    enableAuth: readBoolean(config.enableAuth, DEFAULT_HTTP_API_CONFIG.enableAuth),
    mcpRequireAuth: readBoolean(config.mcpRequireAuth, DEFAULT_HTTP_API_CONFIG.mcpRequireAuth),
    mcpAllowedOrigins: readStringArray(
      config.mcpAllowedOrigins,
      DEFAULT_HTTP_API_CONFIG.mcpAllowedOrigins
    ),
    token: readString(config.token, DEFAULT_HTTP_API_CONFIG.token || ''),
    callbackUrl: readString(config.callbackUrl, DEFAULT_HTTP_API_CONFIG.callbackUrl || ''),
    enableMcp: readBoolean(config.enableMcp, DEFAULT_HTTP_API_CONFIG.enableMcp || false),
    enforceOrchestrationScopes: readBoolean(
      config.enforceOrchestrationScopes,
      DEFAULT_HTTP_API_CONFIG.enforceOrchestrationScopes
    ),
    orchestrationIdempotencyStore: readIdempotencyStore(
      config.orchestrationIdempotencyStore
    ),
    enableDevMode: readBoolean(config.enableDevMode, DEFAULT_HTTP_API_CONFIG.enableDevMode || false),
  };
};

export const applyRuntimeHttpApiOverrides = (config: HttpApiConfig): HttpApiConfig => ({
  ...config,
  ...(AIRPA_RUNTIME_CONFIG.http.enableHttpOverride !== null
    ? { enabled: AIRPA_RUNTIME_CONFIG.http.enableHttpOverride }
    : {}),
  ...(AIRPA_RUNTIME_CONFIG.http.enableMcpOverride !== null
    ? { enableMcp: AIRPA_RUNTIME_CONFIG.http.enableMcpOverride }
    : {}),
});

export const resolveEffectiveHttpApiConfig = (
  input: Partial<HttpApiConfig> | null | undefined
): HttpApiConfig => applyRuntimeHttpApiOverrides(normalizeHttpApiConfig(input));

export const getHttpApiRuntimeOverrideFlags = (): {
  enabled: boolean;
  enableMcp: boolean;
} => ({
  enabled: AIRPA_RUNTIME_CONFIG.http.enableHttpOverride !== null,
  enableMcp: AIRPA_RUNTIME_CONFIG.http.enableMcpOverride !== null,
});

/**
 * HTTP 服务器默认配置
 */
export const HTTP_SERVER_DEFAULTS = {
  PORT: AIRPA_RUNTIME_CONFIG.http.port,
  // Use explicit IPv4 loopback to avoid VPN/TUN mode localhost resolution issues.
  BIND_ADDRESS: '127.0.0.1',
  SESSION_TIMEOUT: 30 * 60 * 1000, // 30 分钟
  SESSION_CLEANUP_INTERVAL: 5 * 60 * 1000, // 5 分钟检查一次
  API_VERSION: '2026-02-23',
  ORCHESTRATION_API_V1_PREFIX: '/api/v1/orchestration',
  MCP_MAX_QUEUE_SIZE: AIRPA_RUNTIME_CONFIG.http.mcpMaxQueueSize,
  MCP_INVOKE_TIMEOUT_MS: AIRPA_RUNTIME_CONFIG.http.mcpInvokeTimeoutMs,
  ORCHESTRATION_MAX_QUEUE_SIZE: AIRPA_RUNTIME_CONFIG.http.orchestrationMaxQueueSize,
  ORCHESTRATION_INVOKE_TIMEOUT_MS: AIRPA_RUNTIME_CONFIG.http.orchestrationInvokeTimeoutMs,
  ORCHESTRATION_IDEMPOTENCY_TTL_MS: AIRPA_RUNTIME_CONFIG.http.orchestrationIdempotencyTtlMs,
  ORCHESTRATION_ALERT_INVOKE_TIMEOUT_WARN_COUNT:
    AIRPA_RUNTIME_CONFIG.http.orchestrationAlertInvokeTimeoutWarnCount,
  ORCHESTRATION_ALERT_INVOKE_TIMEOUT_CRITICAL_COUNT:
    AIRPA_RUNTIME_CONFIG.http.orchestrationAlertInvokeTimeoutCriticalCount,
  ORCHESTRATION_ALERT_QUEUE_OVERFLOW_WARN_COUNT:
    AIRPA_RUNTIME_CONFIG.http.orchestrationAlertQueueOverflowWarnCount,
  ORCHESTRATION_ALERT_QUEUE_OVERFLOW_CRITICAL_COUNT:
    AIRPA_RUNTIME_CONFIG.http.orchestrationAlertQueueOverflowCriticalCount,
  ORCHESTRATION_ALERT_BROWSER_ACQUIRE_FAILURE_WARN_COUNT:
    AIRPA_RUNTIME_CONFIG.http.orchestrationAlertBrowserAcquireFailureWarnCount,
  ORCHESTRATION_ALERT_BROWSER_ACQUIRE_FAILURE_CRITICAL_COUNT:
    AIRPA_RUNTIME_CONFIG.http.orchestrationAlertBrowserAcquireFailureCriticalCount,
  ORCHESTRATION_ALERT_BROWSER_ACQUIRE_TIMEOUT_WARN_COUNT:
    AIRPA_RUNTIME_CONFIG.http.orchestrationAlertBrowserAcquireTimeoutWarnCount,
  ORCHESTRATION_ALERT_BROWSER_ACQUIRE_TIMEOUT_CRITICAL_COUNT:
    AIRPA_RUNTIME_CONFIG.http.orchestrationAlertBrowserAcquireTimeoutCriticalCount,
  ORCHESTRATION_ALERT_TOTAL_PENDING_WARN: AIRPA_RUNTIME_CONFIG.http.orchestrationAlertTotalPendingWarn,
  ORCHESTRATION_ALERT_TOTAL_PENDING_CRITICAL:
    AIRPA_RUNTIME_CONFIG.http.orchestrationAlertTotalPendingCritical,
  ORCHESTRATION_ALERT_STALE_SESSIONS_WARN: AIRPA_RUNTIME_CONFIG.http.orchestrationAlertStaleSessionsWarn,
  ORCHESTRATION_ALERT_STALE_SESSIONS_CRITICAL:
    AIRPA_RUNTIME_CONFIG.http.orchestrationAlertStaleSessionsCritical,
} as const;
