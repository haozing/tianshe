import { randomUUID } from 'node:crypto';

export type ObservationLevel = 'debug' | 'info' | 'warn' | 'error';

export type ObservationOutcome =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'timeout'
  | 'cancelled';

export type RuntimeArtifactType =
  | 'snapshot'
  | 'console_tail'
  | 'network_summary'
  | 'screenshot'
  | 'error_context';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  source?: string;
  capability?: string;
  pluginId?: string;
  browserEngine?: 'electron' | 'extension' | 'ruyi';
  sessionId?: string;
  profileId?: string;
  datasetId?: string;
  browserId?: string;
  attributes?: Record<string, unknown>;
}

export interface RuntimeErrorInfo {
  name?: string;
  code?: string;
  message: string;
  stack?: string;
  details?: unknown;
}

export interface RuntimeEvent {
  eventId: string;
  timestamp: number;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  level: ObservationLevel;
  event: string;
  outcome?: ObservationOutcome;
  component: string;
  message?: string;
  durationMs?: number;
  source?: string;
  capability?: string;
  pluginId?: string;
  browserEngine?: 'electron' | 'extension' | 'ruyi';
  sessionId?: string;
  profileId?: string;
  datasetId?: string;
  browserId?: string;
  attrs?: Record<string, unknown>;
  error?: RuntimeErrorInfo;
  artifactRefs?: string[];
}

export interface RuntimeArtifact {
  artifactId: string;
  timestamp: number;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  type: RuntimeArtifactType;
  component: string;
  label?: string;
  mimeType?: string;
  source?: string;
  capability?: string;
  pluginId?: string;
  browserEngine?: 'electron' | 'extension' | 'ruyi';
  sessionId?: string;
  profileId?: string;
  datasetId?: string;
  browserId?: string;
  attrs?: Record<string, unknown>;
  data?: unknown;
}

export interface RuntimeArtifactRef {
  artifactId: string;
  type: RuntimeArtifactType;
  label?: string;
  timestamp: number;
}

export interface TraceSummary {
  traceId: string;
  eventCount: number;
  artifactCount: number;
  startedAt?: number;
  finishedAt?: number;
  finalStatus: 'succeeded' | 'failed' | 'in_progress' | 'blocked' | 'unknown';
  rootEvent?: RuntimeEvent;
  lastEvent?: RuntimeEvent;
  firstFailure?: RuntimeEvent;
  entities: {
    capability?: string;
    pluginId?: string;
    browserEngine?: 'electron' | 'extension' | 'ruyi';
    sessionId?: string;
    profileId?: string;
    datasetId?: string;
    browserId?: string;
    source?: string;
  };
  recentArtifacts: RuntimeArtifactRef[];
}

export interface FailureBundle {
  traceId: string;
  error?: RuntimeErrorInfo;
  failedEvent?: RuntimeEvent;
  recentEvents: RuntimeEvent[];
  artifactRefs: RuntimeArtifactRef[];
  snapshot?: RuntimeArtifact;
  screenshot?: RuntimeArtifact;
  consoleTail?: RuntimeArtifact;
  networkSummary?: RuntimeArtifact;
  errorContext?: RuntimeArtifact;
}

export interface TraceTimeline {
  traceId: string;
  finalStatus: TraceSummary['finalStatus'];
  events: RuntimeEvent[];
  artifactRefs: RuntimeArtifactRef[];
}

export interface RecentFailureSummary {
  traceId: string;
  failedAt: number;
  eventId: string;
  event: string;
  component: string;
  message?: string;
  capability?: string;
  pluginId?: string;
  sessionId?: string;
  profileId?: string;
  datasetId?: string;
  browserId?: string;
  browserEngine?: 'electron' | 'extension' | 'ruyi';
  error?: RuntimeErrorInfo;
  finalStatus: TraceSummary['finalStatus'];
  artifactCount: number;
}

export interface ObservationSink {
  recordEvent(event: RuntimeEvent): Promise<void> | void;
  recordArtifact(artifact: RuntimeArtifact): Promise<void> | void;
}

export interface ObservationEventInput {
  context?: TraceContext;
  level?: ObservationLevel;
  event: string;
  outcome?: ObservationOutcome;
  component: string;
  message?: string;
  durationMs?: number;
  attrs?: Record<string, unknown>;
  error?: unknown;
  artifactRefs?: string[];
}

export interface ObservationArtifactInput {
  context?: TraceContext;
  type: RuntimeArtifactType;
  component: string;
  label?: string;
  mimeType?: string;
  attrs?: Record<string, unknown>;
  data?: unknown;
}

export interface ObservationSpanInput {
  context?: TraceContext;
  event: string;
  component: string;
  message?: string;
  attrs?: Record<string, unknown>;
}

export function createRuntimeEventId(): string {
  return randomUUID();
}

export function createRuntimeArtifactId(): string {
  return randomUUID();
}
