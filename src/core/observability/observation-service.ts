import type {
  ObservationArtifactInput,
  ObservationEventInput,
  ObservationSink,
  ObservationSpanInput,
  RuntimeArtifact,
  RuntimeErrorInfo,
  RuntimeEvent,
  TraceContext,
} from './types';
import { createRuntimeArtifactId, createRuntimeEventId } from './types';
import { createChildTraceContext, getCurrentTraceContext, withTraceContext } from './observation-context';

export interface ObservationSpanHandle {
  context: TraceContext;
  startedAt: number;
  succeed(extra?: Omit<ObservationEventInput, 'context' | 'component' | 'event'>): Promise<RuntimeEvent>;
  fail(
    error: unknown,
    extra?: Omit<ObservationEventInput, 'context' | 'component' | 'event' | 'error'>
  ): Promise<RuntimeEvent>;
  attachArtifact(input: Omit<ObservationArtifactInput, 'context'>): Promise<RuntimeArtifact>;
}

let observationSink: ObservationSink | null = null;

function trimString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function summarizeArray(value: unknown[], depth: number): unknown[] {
  const items = value.slice(0, 10).map((item) => summarizeForObservation(item, depth - 1));
  if (value.length > 10) {
    items.push(`[+${value.length - 10} more]`);
  }
  return items;
}

function summarizeObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const entries = Object.entries(value).slice(0, 20);
  const summary = Object.fromEntries(
    entries.map(([key, nextValue]) => [key, summarizeForObservation(nextValue, depth - 1)])
  );
  if (Object.keys(value).length > entries.length) {
    summary.__truncatedKeys = Object.keys(value).length - entries.length;
  }
  return summary;
}

export function summarizeForObservation(value: unknown, depth: number = 2): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (depth <= 0) {
    if (typeof value === 'string') {
      return trimString(value, 200);
    }
    if (Array.isArray(value)) {
      return `[array(${value.length})]`;
    }
    if (typeof value === 'object') {
      return '[object]';
    }
    return value;
  }
  if (typeof value === 'string') {
    return trimString(value, 400);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: trimString(value.message || '', 400),
      ...(value.stack ? { stack: trimString(value.stack, 1000) } : {}),
    };
  }
  if (Array.isArray(value)) {
    return summarizeArray(value, depth);
  }
  if (typeof value === 'object') {
    return summarizeObject(value as Record<string, unknown>, depth);
  }
  return String(value);
}

export function normalizeObservationError(error: unknown): RuntimeErrorInfo {
  if (error instanceof Error) {
    const maybeCode =
      typeof (error as { code?: unknown }).code === 'string'
        ? ((error as { code?: string }).code as string)
        : undefined;
    return {
      name: error.name,
      ...(maybeCode ? { code: maybeCode } : {}),
      message: error.message || 'Unknown error',
      ...(error.stack ? { stack: trimString(error.stack, 4000) } : {}),
    };
  }
  if (typeof error === 'string') {
    return {
      message: error,
    };
  }
  return {
    message: 'Unknown error',
    details: summarizeForObservation(error, 2),
  };
}

function eventContext(context?: TraceContext): TraceContext {
  const active = context || getCurrentTraceContext();
  if (active) {
    return active;
  }
  return createChildTraceContext();
}

export function setObservationSink(nextSink: ObservationSink | null): void {
  observationSink = nextSink;
}

export function getObservationSink(): ObservationSink | null {
  return observationSink;
}

class ObservationService {
  async event(input: ObservationEventInput): Promise<RuntimeEvent> {
    const context = eventContext(input.context);
    const runtimeEvent: RuntimeEvent = {
      eventId: createRuntimeEventId(),
      timestamp: Date.now(),
      traceId: context.traceId,
      ...(context.spanId ? { spanId: context.spanId } : {}),
      ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
      level: input.level ?? (input.error ? 'error' : 'info'),
      event: input.event,
      ...(input.outcome ? { outcome: input.outcome } : {}),
      component: input.component,
      ...(input.message ? { message: trimString(input.message, 400) } : {}),
      ...(typeof input.durationMs === 'number' ? { durationMs: input.durationMs } : {}),
      ...(context.source ? { source: context.source } : {}),
      ...(context.capability ? { capability: context.capability } : {}),
      ...(context.pluginId ? { pluginId: context.pluginId } : {}),
      ...(context.browserEngine ? { browserEngine: context.browserEngine } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.profileId ? { profileId: context.profileId } : {}),
      ...(context.datasetId ? { datasetId: context.datasetId } : {}),
      ...(context.browserId ? { browserId: context.browserId } : {}),
      ...(input.attrs ? { attrs: summarizeForObservation(input.attrs, 2) as Record<string, unknown> } : {}),
      ...(input.error ? { error: normalizeObservationError(input.error) } : {}),
      ...(input.artifactRefs?.length ? { artifactRefs: [...input.artifactRefs] } : {}),
    };

    try {
      await observationSink?.recordEvent(runtimeEvent);
    } catch (error) {
      console.warn('[ObservationService] Failed to record runtime event:', error);
    }

    return runtimeEvent;
  }

  async attachArtifact(input: ObservationArtifactInput): Promise<RuntimeArtifact> {
    const context = eventContext(input.context);
    const artifact: RuntimeArtifact = {
      artifactId: createRuntimeArtifactId(),
      timestamp: Date.now(),
      traceId: context.traceId,
      ...(context.spanId ? { spanId: context.spanId } : {}),
      ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
      type: input.type,
      component: input.component,
      ...(input.label ? { label: trimString(input.label, 200) } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(context.source ? { source: context.source } : {}),
      ...(context.capability ? { capability: context.capability } : {}),
      ...(context.pluginId ? { pluginId: context.pluginId } : {}),
      ...(context.browserEngine ? { browserEngine: context.browserEngine } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.profileId ? { profileId: context.profileId } : {}),
      ...(context.datasetId ? { datasetId: context.datasetId } : {}),
      ...(context.browserId ? { browserId: context.browserId } : {}),
      ...(input.attrs ? { attrs: summarizeForObservation(input.attrs, 2) as Record<string, unknown> } : {}),
      ...(input.data !== undefined ? { data: summarizeForObservation(input.data, 3) } : {}),
    };

    try {
      await observationSink?.recordArtifact(artifact);
    } catch (error) {
      console.warn('[ObservationService] Failed to record runtime artifact:', error);
    }

    return artifact;
  }

  async startSpan(input: ObservationSpanInput): Promise<ObservationSpanHandle> {
    const context = input.context || createChildTraceContext();
    const startedAt = Date.now();

    await this.event({
      context,
      component: input.component,
      event: `${input.event}.started`,
      outcome: 'started',
      message: input.message,
      attrs: input.attrs,
    });

    return {
      context,
      startedAt,
      succeed: async (extra = {}) => {
        return await this.event({
          context,
          component: input.component,
          event: `${input.event}.succeeded`,
          outcome: 'succeeded',
          durationMs: Date.now() - startedAt,
          ...extra,
        });
      },
      fail: async (error, extra = {}) => {
        return await this.event({
          context,
          component: input.component,
          event: `${input.event}.failed`,
          level: 'error',
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          error,
          ...extra,
        });
      },
      attachArtifact: async (nextInput) => {
        return await this.attachArtifact({
          context,
          ...nextInput,
        });
      },
    };
  }

  async withContext<T>(context: TraceContext, fn: () => Promise<T>): Promise<T> {
    return await withTraceContext(context, fn);
  }
}

export const observationService = new ObservationService();
