import { HTTP_SERVER_DEFAULTS } from '../constants/http-api';
import { getRuntimeFingerprint } from './runtime-fingerprint';

export type HttpRuntimeDiagnosisSeverity = 'info' | 'warning' | 'critical';
export type HttpRuntimeOwner = 'self' | 'other_airpa' | 'unknown';
export type HttpRuntimeDiagnosisCode =
  | 'healthy_self'
  | 'healthy_other_airpa'
  | 'no_listener'
  | 'unresponsive_listener'
  | 'unexpected_health_response';

export interface HttpRuntimeDiagnosis {
  code: HttpRuntimeDiagnosisCode;
  severity: HttpRuntimeDiagnosisSeverity;
  owner: HttpRuntimeOwner;
  summary: string;
  detail?: string;
  suggestedAction?: string;
  httpStatus?: number;
}

export interface ProbeLocalHttpRuntimeOptions {
  port?: number;
  metricsHeaders?: Record<string, string>;
  requestTimeoutMs?: number;
}

export interface ProbeLocalHttpRuntimeResult {
  port: number;
  baseUrl: string;
  running: boolean;
  reachable: boolean;
  health: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  runtimeAlerts: Array<Record<string, unknown>>;
  diagnosis: HttpRuntimeDiagnosis;
}

interface HttpResponseSnapshot {
  ok: boolean;
  status: number;
  body: unknown;
  bodySnippet: string | null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 2500;
const MAX_BODY_SNIPPET_LENGTH = 220;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isAbortError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'));

const classifyNetworkError = (
  error: unknown,
  port: number,
  timeoutMs: number
): HttpRuntimeDiagnosis => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('econnrefused')) {
    return {
      code: 'no_listener',
      severity: 'warning',
      owner: 'unknown',
      summary: `Port ${port} does not currently have a reachable HTTP service.`,
      detail: message,
      suggestedAction:
        'Confirm that the HTTP server is enabled. If configuration or build output just changed, restart the current Electron instance and retry.',
    };
  }

  return {
    code: 'unresponsive_listener',
    severity: 'critical',
    owner: 'unknown',
    summary: `The HTTP service on port ${port} did not respond cleanly to /health.`,
    detail: isAbortError(error)
      ? `The health probe timed out after ${timeoutMs}ms, which usually means the listener is hung or half-alive.`
      : message,
    suggestedAction:
      'Restart the Electron or Airpa process that owns this port, then retry from the current instance.',
  };
};

const buildBodySnippet = (bodyText: string): string | null => {
  const normalized = bodyText.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_BODY_SNIPPET_LENGTH);
};

const fetchResponseSnapshot = async (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<HttpResponseSnapshot> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let body: unknown = null;
    if (bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      bodySnippet: buildBodySnippet(bodyText),
    };
  } finally {
    clearTimeout(timer);
  }
};

const extractAirpaHealthData = (
  snapshot: HttpResponseSnapshot
): Record<string, unknown> | null => {
  if (!snapshot.ok || !isRecord(snapshot.body) || !isRecord(snapshot.body.data)) {
    return null;
  }

  const data = snapshot.body.data;
  if (
    !['ok', 'degraded', 'error'].includes(String(data.status || '')) ||
    typeof data.processStartTime !== 'string'
  ) {
    return null;
  }

  return data;
};

const describeUnexpectedHealthResponse = (
  port: number,
  snapshot: HttpResponseSnapshot
): HttpRuntimeDiagnosis => {
  const detailParts: string[] = [`/health returned an unexpected response (HTTP ${snapshot.status}).`];
  if (snapshot.bodySnippet) {
    detailParts.push(`Response snippet: ${snapshot.bodySnippet}`);
  }

  return {
    code: 'unexpected_health_response',
    severity: 'critical',
    owner: 'unknown',
    summary: `Port ${port} is occupied by another service, or an older Airpa instance has a broken health endpoint.`,
    detail: detailParts.join(' '),
    suggestedAction:
      'Inspect the process that owns this port. If it is an older Airpa or Electron instance, stop it before retrying.',
    httpStatus: snapshot.status,
  };
};

export const probeLocalHttpRuntime = async ({
  port = HTTP_SERVER_DEFAULTS.PORT,
  metricsHeaders,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: ProbeLocalHttpRuntimeOptions = {}): Promise<ProbeLocalHttpRuntimeResult> => {
  const baseUrl = `http://${HTTP_SERVER_DEFAULTS.BIND_ADDRESS}:${port}`;
  const healthUrl = `${baseUrl}/health`;
  const currentProcessStartTime = getRuntimeFingerprint().processStartTime;

  let healthSnapshot: HttpResponseSnapshot;
  try {
    healthSnapshot = await fetchResponseSnapshot(
      healthUrl,
      {
        accept: 'application/json',
      },
      requestTimeoutMs
    );
  } catch (error) {
    const diagnosis = classifyNetworkError(error, port, requestTimeoutMs);
    return {
      port,
      baseUrl,
      running: false,
      reachable: false,
      health: null,
      metrics: null,
      runtimeAlerts: [],
      diagnosis,
    };
  }

  const healthData = extractAirpaHealthData(healthSnapshot);
  if (!healthData) {
    return {
      port,
      baseUrl,
      running: false,
      reachable: true,
      health: null,
      metrics: null,
      runtimeAlerts: [],
      diagnosis: describeUnexpectedHealthResponse(port, healthSnapshot),
    };
  }

  const owner: HttpRuntimeOwner =
    healthData.processStartTime === currentProcessStartTime ? 'self' : 'other_airpa';
  const running = owner === 'self';
  const diagnosis: HttpRuntimeDiagnosis =
    owner === 'self'
      ? {
          code: 'healthy_self',
          severity: 'info',
          owner,
          summary: `The HTTP service on port ${port} belongs to the current Airpa process.`,
          ...(healthData.status === 'degraded' || healthData.status === 'error'
            ? {
                detail: `The service reports health status "${String(healthData.status)}". Review runtimeAlerts for machine-readable diagnostics.`,
              }
            : {}),
          suggestedAction:
            'Prefer the canonical `airpa-browser-http` `/mcp` endpoint, and call `session_prepare` before browser work when profile, engine, visibility, or scopes matter.',
        }
      : {
          code: 'healthy_other_airpa',
          severity: 'warning',
          owner,
          summary: `Port ${port} is owned by another Airpa or Electron process.`,
          detail: `Current process start time: ${currentProcessStartTime}. Port owner start time: ${String(healthData.processStartTime)}.`,
          suggestedAction:
            'Stop the older instance before retrying, or intentionally connect to the MCP/HTTP endpoint that it already exposes.',
        };

  let metrics: Record<string, unknown> | null = null;
  if (running) {
    try {
      const metricsSnapshot = await fetchResponseSnapshot(
        `${baseUrl}${HTTP_SERVER_DEFAULTS.ORCHESTRATION_API_V1_PREFIX}/metrics`,
        {
          accept: 'application/json',
          ...(metricsHeaders || {}),
        },
        requestTimeoutMs
      );
      if (metricsSnapshot.ok && isRecord(metricsSnapshot.body) && isRecord(metricsSnapshot.body.data)) {
        metrics = metricsSnapshot.body.data;
      }
    } catch {
      // Metrics are supplemental. Health diagnosis should still succeed when metrics are unavailable.
    }
  }

  return {
    port,
    baseUrl,
    running,
    reachable: true,
    health: healthData,
    metrics,
    runtimeAlerts:
      Array.isArray(healthData.runtimeAlerts) && healthData.runtimeAlerts.every(isRecord)
        ? healthData.runtimeAlerts
        : Array.isArray(metrics?.alerts) && metrics.alerts.every(isRecord)
          ? (metrics.alerts as Array<Record<string, unknown>>)
          : [],
    diagnosis,
  };
};
