import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { StructuredError } from '../types/error-codes';
import type { OrchestrationInvokeMeta } from '../core/ai-dev/orchestration';

export interface ResponseMeta {
  traceId: string;
  durationMs: number;
  sessionId?: string;
  capability?: string;
  idempotencyKey?: string;
  idempotencyStatus?: 'stored' | 'replayed';
  attempts?: number;
  attemptTimeline?: OrchestrationInvokeMeta['attemptTimeline'];
  scopeDecision?: OrchestrationInvokeMeta['scopeDecision'];
  idempotencyDecision?: OrchestrationInvokeMeta['idempotencyDecision'];
}

export const TRACE_HEADER = 'x-airpa-trace-id';

export const buildResponseMeta = (res: Response, extra?: Partial<ResponseMeta>): ResponseMeta => {
  const traceId =
    typeof res.locals.traceId === 'string' && res.locals.traceId.trim().length > 0
      ? (res.locals.traceId as string)
      : randomUUID();
  const startedAt =
    typeof res.locals.requestStartedAt === 'number'
      ? (res.locals.requestStartedAt as number)
      : Date.now();
  const durationMs = Math.max(0, Date.now() - startedAt);
  return {
    traceId,
    durationMs,
    ...(extra || {}),
  };
};

export const buildOrchestrationResponseMeta = (
  invokeMeta: OrchestrationInvokeMeta | undefined
): Partial<ResponseMeta> => {
  if (!invokeMeta) {
    return {};
  }

  return {
    ...(invokeMeta.traceId ? { traceId: invokeMeta.traceId } : {}),
    ...(Number.isFinite(invokeMeta.attempts) ? { attempts: invokeMeta.attempts } : {}),
    ...(invokeMeta.attemptTimeline ? { attemptTimeline: invokeMeta.attemptTimeline } : {}),
    ...(invokeMeta.scopeDecision ? { scopeDecision: invokeMeta.scopeDecision } : {}),
    ...(invokeMeta.idempotencyDecision
      ? { idempotencyDecision: invokeMeta.idempotencyDecision }
      : {}),
  };
};

export const sendSuccess = (
  res: Response,
  data?: unknown,
  message?: string,
  meta?: Partial<ResponseMeta>
) => {
  const response: { success: true; data?: unknown; message?: string; _meta: ResponseMeta } = {
    success: true,
    _meta: buildResponseMeta(res, meta),
  };
  if (data !== undefined) response.data = data;
  if (message) response.message = message;
  res.json(response);
};

export const sendStructuredError = (
  res: Response,
  error: StructuredError,
  status = 400,
  meta?: Partial<ResponseMeta>
) => {
  res.status(status).json({
    success: false,
    error: error.message,
    code: error.code,
    ...(error.details ? { details: error.details } : {}),
    ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}),
    ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    ...(error.recommendedNextTools?.length
      ? { recommendedNextTools: error.recommendedNextTools }
      : {}),
    ...(error.authoritativeFields?.length
      ? { authoritativeFields: error.authoritativeFields }
      : {}),
    ...(error.candidates?.length ? { candidates: error.candidates } : {}),
    ...(error.nextActionHints?.length ? { nextActionHints: error.nextActionHints } : {}),
    ...(error.context ? { context: error.context } : {}),
    _meta: buildResponseMeta(res, meta),
  });
};
