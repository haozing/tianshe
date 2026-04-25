import type { Application } from 'express';
import type { RestApiConfig } from '../types/http-api';
import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import {
  MCP_PROTOCOL_COMPATIBILITY_MODE,
  MCP_PROTOCOL_ALLOWED_VERSIONS,
  MCP_PROTOCOL_SDK_SUPPORTED_VERSIONS,
  MCP_PROTOCOL_UNIFIED_VERSION,
} from '../constants/mcp-protocol';
import type { RuntimeMetricsPayload } from './http-session-manager';
import { SESSION_CLEANUP_POLICY } from './http-session-manager';
import { getRuntimeFingerprint } from './runtime-fingerprint';
import { sendSuccess } from './http-response-mapper';
import type { OrchestrationSystemHealthSnapshot } from '../core/ai-dev/orchestration';

interface SessionCountsSnapshot {
  mcpSessions: number;
  orchestrationSessions: number;
}

interface RegisterHealthRouteOptions {
  app: Application;
  serverName: string;
  serverVersion: string;
  restApiConfig?: RestApiConfig;
  mcpConfigured: boolean;
  mcpEndpointEnabled: boolean;
  getSessionCounts: () => SessionCountsSnapshot;
  getRuntimeMetrics: () => RuntimeMetricsPayload;
}

interface BuildHealthPayloadOptions {
  serverName: string;
  serverVersion: string;
  restApiConfig?: RestApiConfig;
  mcpConfigured: boolean;
  mcpEndpointEnabled: boolean;
  getSessionCounts: () => SessionCountsSnapshot;
  getRuntimeMetrics: () => RuntimeMetricsPayload;
}

type HealthStatus = 'ok' | 'degraded' | 'error';

type HealthAlertSeverity = 'warning' | 'critical';

interface HealthAlert {
  code: string;
  severity: HealthAlertSeverity;
  message: string;
  source: 'runtime_metrics' | 'build_freshness' | 'mcp_sdk' | 'session_leak_risk';
  [key: string]: unknown;
}

const buildBuildFreshnessAlerts = (
  runtimeFingerprint: ReturnType<typeof getRuntimeFingerprint>
): HealthAlert[] => {
  const alerts: HealthAlert[] = [];
  const components = [
    {
      key: 'main' as const,
      label: 'main',
      snapshot: runtimeFingerprint.buildFreshness.main,
    },
    {
      key: 'renderer' as const,
      label: 'renderer',
      snapshot: runtimeFingerprint.buildFreshness.renderer,
    },
  ];

  for (const component of components) {
    if (component.snapshot.ok || component.snapshot.reason === 'missing_source_tree') {
      continue;
    }

    alerts.push({
      code: `${component.key}_build_${component.snapshot.reason}`,
      severity:
        component.snapshot.reason === 'missing_dist_artifacts' ? 'critical' : 'warning',
      message:
        component.snapshot.reason === 'missing_dist_artifacts'
          ? `${component.label} dist artifacts are missing.`
          : `${component.label} dist artifacts are older than source.`,
      source: 'build_freshness',
      reason: component.snapshot.reason,
      lagMs: component.snapshot.lagMs,
    });
  }

  return alerts;
};

const buildHealthAlerts = (
  runtimeMetrics: RuntimeMetricsPayload,
  runtimeFingerprint: ReturnType<typeof getRuntimeFingerprint>
): HealthAlert[] => {
  const alerts: HealthAlert[] = runtimeMetrics.alerts.map((alert) => ({
    ...alert,
    source: 'runtime_metrics',
  }));

  alerts.push(...buildBuildFreshnessAlerts(runtimeFingerprint));

  if (runtimeFingerprint.mcpSdk.degraded) {
    alerts.push({
      code: 'mcp_sdk_initialize_shim_degraded',
      severity: 'warning',
      message:
        runtimeFingerprint.mcpSdk.initializeShimReason ||
        'The MCP SDK initialize shim is running in degraded mode.',
      source: 'mcp_sdk',
      sdkVersion: runtimeFingerprint.mcpSdk.version,
      mode: runtimeFingerprint.mcpSdk.initializeShimMode,
    });
  }

  if (runtimeMetrics.sessionLeakRisk.totalStaleSessions > 0) {
    alerts.push({
      code: 'session_leak_risk',
      severity: 'warning',
      message: `Detected ${runtimeMetrics.sessionLeakRisk.totalStaleSessions} stale session(s) beyond the cleanup timeout.`,
      source: 'session_leak_risk',
      staleMcpSessions: runtimeMetrics.sessionLeakRisk.staleMcpSessions,
      staleOrchestrationSessions: runtimeMetrics.sessionLeakRisk.staleOrchestrationSessions,
      timeoutMs: runtimeMetrics.sessionLeakRisk.timeoutMs,
    });
  }

  return alerts;
};

const resolveHealthStatus = (alerts: readonly HealthAlert[]): HealthStatus => {
  if (alerts.some((alert) => alert.severity === 'critical')) {
    return 'error';
  }
  return alerts.length > 0 ? 'degraded' : 'ok';
};

export const buildHealthPayload = ({
  serverName,
  serverVersion,
  restApiConfig,
  mcpConfigured,
  mcpEndpointEnabled,
  getSessionCounts,
  getRuntimeMetrics,
}: BuildHealthPayloadOptions): OrchestrationSystemHealthSnapshot => {
  const sessions = getSessionCounts();
  const runtimeMetrics = getRuntimeMetrics();
  const runtimeFingerprint = getRuntimeFingerprint();
  const runtimeAlerts = buildHealthAlerts(runtimeMetrics, runtimeFingerprint);

  return {
    status: resolveHealthStatus(runtimeAlerts),
    name: serverName,
    version: serverVersion,
    activeSessions: sessions.mcpSessions + sessions.orchestrationSessions,
    mcpSessions: sessions.mcpSessions,
    orchestrationSessions: sessions.orchestrationSessions,
    authEnabled: restApiConfig?.enableAuth ?? false,
    mcpConfigured,
    mcpEnabled: mcpEndpointEnabled,
    mcpRequireAuth: restApiConfig?.mcpRequireAuth ?? true,
    mcpProtocolCompatibilityMode: MCP_PROTOCOL_COMPATIBILITY_MODE,
    mcpProtocolVersion: MCP_PROTOCOL_UNIFIED_VERSION,
    mcpSupportedProtocolVersions: [...MCP_PROTOCOL_ALLOWED_VERSIONS],
    mcpSdkSupportedProtocolVersions: [...MCP_PROTOCOL_SDK_SUPPORTED_VERSIONS],
    enforceOrchestrationScopes: restApiConfig?.enforceOrchestrationScopes ?? false,
    orchestrationIdempotencyStore: restApiConfig?.orchestrationIdempotencyStore ?? 'memory',
    queueDepth: runtimeMetrics.queueDepth as unknown as Record<string, unknown>,
    runtimeCounters: runtimeMetrics.counters as unknown as Record<string, unknown>,
    sessionLeakRisk: runtimeMetrics.sessionLeakRisk as unknown as Record<string, unknown>,
    sessionCleanupPolicy: SESSION_CLEANUP_POLICY as unknown as Record<string, unknown>,
    ...runtimeFingerprint,
    runtimeAlerts,
  };
};

/**
 * 注册系统级路由（health）。
 */
export const registerHealthRoute = ({
  app,
  serverName,
  serverVersion,
  restApiConfig,
  mcpConfigured,
  mcpEndpointEnabled,
  getSessionCounts,
  getRuntimeMetrics,
}: RegisterHealthRouteOptions): void => {
  app.get('/health', (req, res) => {
    sendSuccess(
      res,
      buildHealthPayload({
        serverName,
        serverVersion,
        restApiConfig,
        mcpConfigured,
        mcpEndpointEnabled,
        getSessionCounts,
        getRuntimeMetrics,
      })
    );
  });
};
