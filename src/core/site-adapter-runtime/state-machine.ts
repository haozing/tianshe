import { randomUUID } from 'node:crypto';
import type { SiteAdapterSideEffectLevel } from './types';

export type SiteAdapterRunPhase =
  | 'created'
  | 'extracting'
  | 'verifying'
  | 'repair_evidence'
  | 'completed'
  | 'failed'
  | 'aborted';

export type ProcedureTransitionOutcome = 'started' | 'succeeded' | 'failed' | 'aborted';

export interface InteractorActionTraceEntry {
  actionId: string;
  stepId: string;
  action: string;
  sideEffectLevel: SiteAdapterSideEffectLevel | 'low' | 'high';
  startedAt: string;
  finishedAt?: string;
  outcome: ProcedureTransitionOutcome;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

export interface ProcedureTransition {
  transitionId: string;
  stepId: string;
  from: SiteAdapterRunPhase;
  to: SiteAdapterRunPhase;
  action: string;
  outcome: ProcedureTransitionOutcome;
  at: string;
  data?: Record<string, unknown>;
}

export interface SiteAdapterRunState {
  runId: string;
  adapterId: string;
  fixtureName?: string;
  sideEffectLevel: SiteAdapterSideEffectLevel | 'low' | 'high';
  phase: SiteAdapterRunPhase;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: string;
  updatedAt: string;
  transitions: ProcedureTransition[];
  actionTrace: InteractorActionTraceEntry[];
  values: Record<string, unknown>;
}

const FORBIDDEN_STATE_KEYS = new Set([
  'browser',
  'page',
  'context',
  'secret',
  'secrets',
  'password',
  'token',
  'cookie',
  'authorization',
]);

const nowIso = (): string => new Date().toISOString();

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '[truncated]';
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_STATE_KEYS.has(key.trim().toLowerCase())) {
        continue;
      }
      output[key] = sanitizeValue(nested, depth + 1);
    }
    return output;
  }
  return undefined;
}

export function sanitizeSiteAdapterStatePayload(
  payload: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!payload) {
    return undefined;
  }
  const sanitized = sanitizeValue(payload);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : undefined;
}

export function createSiteAdapterRunState(input: {
  adapterId: string;
  fixtureName?: string;
  sideEffectLevel?: SiteAdapterRunState['sideEffectLevel'];
  values?: Record<string, unknown>;
}): SiteAdapterRunState {
  const timestamp = nowIso();
  return {
    runId: randomUUID(),
    adapterId: input.adapterId,
    ...(input.fixtureName ? { fixtureName: input.fixtureName } : {}),
    sideEffectLevel: input.sideEffectLevel || 'read-only',
    phase: 'created',
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    transitions: [],
    actionTrace: [],
    values: sanitizeSiteAdapterStatePayload(input.values) || {},
  };
}

export function appendProcedureTransition(
  state: SiteAdapterRunState,
  input: {
    stepId: string;
    to: SiteAdapterRunPhase;
    action: string;
    outcome?: ProcedureTransitionOutcome;
    data?: Record<string, unknown>;
  }
): ProcedureTransition {
  const transition: ProcedureTransition = {
    transitionId: randomUUID(),
    stepId: input.stepId,
    from: state.phase,
    to: input.to,
    action: input.action,
    outcome: input.outcome || 'succeeded',
    at: nowIso(),
    ...(sanitizeSiteAdapterStatePayload(input.data)
      ? { data: sanitizeSiteAdapterStatePayload(input.data) }
      : {}),
  };
  state.phase = input.to;
  state.updatedAt = transition.at;
  if (input.to === 'completed') {
    state.status = 'completed';
  } else if (input.to === 'failed') {
    state.status = 'failed';
  } else if (input.to === 'aborted') {
    state.status = 'aborted';
  } else {
    state.status = 'running';
  }
  state.transitions.push(transition);
  return transition;
}

export function appendInteractorActionTrace(
  state: SiteAdapterRunState,
  input: Omit<InteractorActionTraceEntry, 'actionId' | 'startedAt' | 'sideEffectLevel'> & {
    actionId?: string;
    startedAt?: string;
    sideEffectLevel?: SiteAdapterRunState['sideEffectLevel'];
  }
): InteractorActionTraceEntry {
  const entry: InteractorActionTraceEntry = {
    actionId: input.actionId || randomUUID(),
    stepId: input.stepId,
    action: input.action,
    sideEffectLevel: input.sideEffectLevel || state.sideEffectLevel,
    startedAt: input.startedAt || nowIso(),
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    outcome: input.outcome,
    ...(sanitizeSiteAdapterStatePayload(input.input)
      ? { input: sanitizeSiteAdapterStatePayload(input.input) }
      : {}),
    ...(sanitizeSiteAdapterStatePayload(input.output)
      ? { output: sanitizeSiteAdapterStatePayload(input.output) }
      : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  state.updatedAt = entry.finishedAt || entry.startedAt;
  state.actionTrace.push(entry);
  return entry;
}

export function replaySiteAdapterTransitions(
  initialState: SiteAdapterRunState,
  transitions: readonly ProcedureTransition[]
): SiteAdapterRunState {
  const replayed: SiteAdapterRunState = {
    ...initialState,
    transitions: [],
    actionTrace: [...initialState.actionTrace],
    values: { ...initialState.values },
  };
  for (const transition of transitions) {
    appendProcedureTransition(replayed, {
      stepId: transition.stepId,
      to: transition.to,
      action: transition.action,
      outcome: transition.outcome,
      data: transition.data,
    });
  }
  return replayed;
}
