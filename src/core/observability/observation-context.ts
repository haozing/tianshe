import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { TraceContext } from './types';

const traceStorage = new AsyncLocalStorage<TraceContext>();

function mergeAttributes(
  parent?: Record<string, unknown>,
  next?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!parent && !next) {
    return undefined;
  }
  return {
    ...(parent || {}),
    ...(next || {}),
  };
}

export function getCurrentTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

export function createRootTraceContext(partial: Partial<TraceContext> = {}): TraceContext {
  return {
    traceId: String(partial.traceId || '').trim() || randomUUID(),
    spanId: String(partial.spanId || '').trim() || randomUUID(),
    ...(partial.parentSpanId ? { parentSpanId: partial.parentSpanId } : {}),
    ...(partial.source ? { source: partial.source } : {}),
    ...(partial.capability ? { capability: partial.capability } : {}),
    ...(partial.pluginId ? { pluginId: partial.pluginId } : {}),
    ...(partial.browserEngine ? { browserEngine: partial.browserEngine } : {}),
    ...(partial.sessionId ? { sessionId: partial.sessionId } : {}),
    ...(partial.profileId ? { profileId: partial.profileId } : {}),
    ...(partial.datasetId ? { datasetId: partial.datasetId } : {}),
    ...(partial.browserId ? { browserId: partial.browserId } : {}),
    ...(partial.attributes ? { attributes: { ...partial.attributes } } : {}),
  };
}

export function createChildTraceContext(partial: Partial<TraceContext> = {}): TraceContext {
  const parent = getCurrentTraceContext();
  const traceId = String(partial.traceId || parent?.traceId || '').trim() || randomUUID();

  return {
    traceId,
    spanId: String(partial.spanId || '').trim() || randomUUID(),
    ...(partial.parentSpanId
      ? { parentSpanId: partial.parentSpanId }
      : parent?.spanId
        ? { parentSpanId: parent.spanId }
        : {}),
    ...(partial.source || parent?.source ? { source: partial.source ?? parent?.source } : {}),
    ...(partial.capability || parent?.capability
      ? { capability: partial.capability ?? parent?.capability }
      : {}),
    ...(partial.pluginId || parent?.pluginId ? { pluginId: partial.pluginId ?? parent?.pluginId } : {}),
    ...(partial.browserEngine || parent?.browserEngine
      ? { browserEngine: partial.browserEngine ?? parent?.browserEngine }
      : {}),
    ...(partial.sessionId || parent?.sessionId
      ? { sessionId: partial.sessionId ?? parent?.sessionId }
      : {}),
    ...(partial.profileId || parent?.profileId
      ? { profileId: partial.profileId ?? parent?.profileId }
      : {}),
    ...(partial.datasetId || parent?.datasetId
      ? { datasetId: partial.datasetId ?? parent?.datasetId }
      : {}),
    ...(partial.browserId || parent?.browserId
      ? { browserId: partial.browserId ?? parent?.browserId }
      : {}),
    ...(mergeAttributes(parent?.attributes, partial.attributes)
      ? { attributes: mergeAttributes(parent?.attributes, partial.attributes) }
      : {}),
  };
}

export function withTraceContext<T>(
  context: TraceContext,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return traceStorage.run(context, fn);
}
