import { createHash, randomUUID } from 'node:crypto';
import { ErrorCode, createStructuredError, type StructuredError } from '../../../types/error-codes';
import {
  createBuiltInCapabilityProvider,
  createUnifiedCapabilityCatalogFromProviders,
  type CapabilityCallResult,
  type CapabilityHandler,
  type CapabilityHandlerExecutionContext,
  type CapabilityProvider,
  type RegisteredCapability,
} from '../capabilities';
import { createStructuredErrorResult } from '../capabilities/result-utils';
import { bindAbortSignalToFacade } from '../../browser-core/abort-facade';
import type { BrowserInterface } from '../../../types/browser-interface';
import { createChildTraceContext, withTraceContext } from '../../observability/observation-context';
import { observationService, summarizeForObservation } from '../../observability/observation-service';
import { attachErrorContextArtifact } from '../../observability/error-context-artifact';
import {
  createCapabilitySchemaValidationError,
  validateCapabilitySchemaPayload,
} from './schema-validation';
import { requiresCapabilityConfirmation, validateCapabilityConfirmationGrant } from './confirmation';
import type {
  OrchestrationCapabilityDefinition,
  OrchestrationInvokeApiResult,
  OrchestrationInvokeMeta,
  OrchestrationInvokeOptions,
  OrchestrationInvokeOutput,
  OrchestrationDependencies,
  OrchestrationExecutor,
  OrchestrationInvokeRequest,
} from './types';

export type OrchestrationCapabilityRegistryView = 'publicMcp' | 'all';

export interface OrchestrationCapabilityRegistrySnapshot {
  generation: number;
  catalog: Record<string, RegisteredCapability>;
  handlers: Record<string, CapabilityHandler<OrchestrationDependencies>>;
  definitionsByName: Record<string, OrchestrationCapabilityDefinition>;
}

export class OrchestrationCapabilityRegistry {
  private providers: CapabilityProvider[];
  private providerUnsubscribers: Array<() => void> = [];
  private generation = 0;
  private snapshot: OrchestrationCapabilityRegistrySnapshot;
  private readonly view: OrchestrationCapabilityRegistryView;

  constructor(options: {
    providers?: readonly CapabilityProvider[];
    additionalProviders?: readonly CapabilityProvider[];
    view?: OrchestrationCapabilityRegistryView;
  } = {}) {
    this.providers = [
      ...(options.providers || [createBuiltInCapabilityProvider()]),
      ...(options.additionalProviders || []),
    ];
    this.view = options.view || 'publicMcp';
    this.subscribeToProviders();
    this.snapshot = this.buildSnapshot();
  }

  getGeneration(): number {
    return this.snapshot.generation;
  }

  getSnapshot(): OrchestrationCapabilityRegistrySnapshot {
    return this.snapshot;
  }

  listCapabilities(): OrchestrationCapabilityDefinition[] {
    return Object.values(this.snapshot.catalog).map((item) => item.definition);
  }

  hasCapability(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.snapshot.handlers, name);
  }

  replaceProviders(providers: readonly CapabilityProvider[]): void {
    this.unsubscribeFromProviders();
    this.providers = [...providers];
    this.subscribeToProviders();
    this.refresh();
  }

  refresh(): OrchestrationCapabilityRegistrySnapshot {
    this.generation += 1;
    this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  __replaceCatalogForTests(catalog: Record<string, RegisteredCapability>): () => void {
    const previousProviders = this.providers;
    const previousUnsubscribers = this.providerUnsubscribers;
    const previousGeneration = this.generation;
    const previousSnapshot = this.snapshot;

    this.unsubscribeFromProviders();
    this.generation += 1;
    this.snapshot = this.createSnapshotFromCatalog(catalog);

    return () => {
      this.unsubscribeFromProviders();
      this.providers = previousProviders;
      this.generation = previousGeneration;
      this.snapshot = previousSnapshot;
      this.providerUnsubscribers = previousUnsubscribers;
      this.subscribeToProviders();
    };
  }

  private subscribeToProviders(): void {
    this.providerUnsubscribers = this.providers
      .map((provider) => provider.subscribe?.(() => this.refresh()))
      .filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === 'function');
  }

  private unsubscribeFromProviders(): void {
    for (const unsubscribe of this.providerUnsubscribers.splice(0)) {
      unsubscribe();
    }
  }

  private buildSnapshot(): OrchestrationCapabilityRegistrySnapshot {
    const merged = createUnifiedCapabilityCatalogFromProviders(this.providers);
    const catalog =
      this.view === 'publicMcp'
        ? Object.fromEntries(
            Object.entries(merged).filter(
              ([, capability]) => capability.definition.assistantSurface?.publicMcp === true
            )
          )
        : merged;

    return this.createSnapshotFromCatalog(catalog);
  }

  private createSnapshotFromCatalog(
    catalog: Record<string, RegisteredCapability>
  ): OrchestrationCapabilityRegistrySnapshot {
    return {
      generation: this.generation,
      catalog,
      handlers: Object.fromEntries(
        Object.values(catalog).map((item) => [item.definition.name, item.handler])
      ),
      definitionsByName: Object.fromEntries(
        Object.values(catalog).map((item) => [item.definition.name, item.definition])
      ),
    };
  }
}

export function createOrchestrationCapabilityRegistry(options: {
  providers?: readonly CapabilityProvider[];
  additionalProviders?: readonly CapabilityProvider[];
  view?: OrchestrationCapabilityRegistryView;
} = {}): OrchestrationCapabilityRegistry {
  return new OrchestrationCapabilityRegistry(options);
}

export const defaultOrchestrationCapabilityRegistry = createOrchestrationCapabilityRegistry();

const ABORTED_INVOCATION_DRAIN_TIMEOUT_MS = 1_500;

function isStructuredError(error: unknown): error is StructuredError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as StructuredError).code === 'string' &&
    typeof (error as StructuredError).message === 'string'
  );
}

function formatStructuredErrorResult(error: StructuredError): CapabilityCallResult {
  return createStructuredErrorResult(error);
}

function isParamValidationLikeError(
  error: unknown
): error is { message: string; paramName?: string } {
  if (!(error instanceof Error)) {
    return false;
  }

  const maybeParamName = (error as { paramName?: unknown }).paramName;
  return (
    error.name === 'ParamValidationError' ||
    error.name === 'SchemaValidationError' ||
    typeof maybeParamName === 'string'
  );
}

interface InvokeOutcome {
  result: CapabilityCallResult;
  error?: StructuredError;
  meta?: OrchestrationInvokeMeta;
}

interface OrchestrationExecutionResult {
  capability: string;
  ok: boolean;
  output: OrchestrationInvokeOutput;
  error?: StructuredError;
  result: CapabilityCallResult;
  meta?: OrchestrationInvokeMeta;
}

interface InvokeExecutionContext {
  request: OrchestrationInvokeRequest;
  deps: OrchestrationDependencies;
  definition: OrchestrationCapabilityDefinition;
  handler: CapabilityHandler<OrchestrationDependencies>;
  options: OrchestrationInvokeOptions;
  runtime: InvokeRuntimeMeta;
}

interface InvokeCapabilityLookup {
  registry: OrchestrationCapabilityRegistry;
  executorGeneration: number;
}

interface InvokeRuntimeMeta {
  traceId: string;
  attemptTimeline: NonNullable<OrchestrationInvokeMeta['attemptTimeline']>;
  scopeDecision?: NonNullable<OrchestrationInvokeMeta['scopeDecision']>;
  idempotencyDecision?: NonNullable<OrchestrationInvokeMeta['idempotencyDecision']>;
  confirmationDecision?: NonNullable<OrchestrationInvokeMeta['confirmationDecision']>;
}

const NON_RETRYABLE_ABORT_REASONS = new Set<string>(['session_closing', 'invocation_aborted']);

const createInvocationAbortedError = (
  context: Pick<InvokeExecutionContext, 'request' | 'runtime'>,
  details?: string
): StructuredError =>
  createStructuredError(
    ErrorCode.OPERATION_FAILED,
    `Capability invocation aborted: ${context.request.name}`,
    {
      ...(details ? { details } : {}),
      context: {
        capability: context.request.name,
        traceId: context.runtime.traceId,
        reason: 'invocation_aborted',
      },
    }
  );

const resolveInvocationAbortError = (
  context: Pick<InvokeExecutionContext, 'request' | 'runtime'>,
  signal: AbortSignal
): StructuredError => {
  const reason = signal.reason;
  if (isStructuredError(reason)) {
    return reason;
  }
  if (reason instanceof Error && String(reason.message || '').trim()) {
    return createInvocationAbortedError(context, reason.message);
  }
  if (typeof reason === 'string' && reason.trim()) {
    return createInvocationAbortedError(context, reason.trim());
  }
  return createInvocationAbortedError(context);
};

const throwIfInvocationAborted = (context: Pick<InvokeExecutionContext, 'request' | 'runtime' | 'options'>): void => {
  const signal = context.options.signal;
  if (!signal?.aborted) {
    return;
  }
  throw resolveInvocationAbortError(context, signal);
};

const awaitAbortableInvocation = async <T>(
  task: Promise<T>,
  context: Pick<InvokeExecutionContext, 'request' | 'runtime' | 'options'>
): Promise<T> => {
  const signal = context.options.signal;
  if (!signal) {
    return task;
  }

  if (signal.aborted) {
    throw resolveInvocationAbortError(context, signal);
  }

  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(resolveInvocationAbortError(context, signal));
    signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    return await Promise.race([task, abortPromise]);
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }

    let drained = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        task
          .then(() => {
            drained = true;
          })
          .catch(() => {
            drained = true;
          }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, ABORTED_INVOCATION_DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    if (!drained) {
      throw createStructuredError(
        ErrorCode.OPERATION_FAILED,
        `Capability invocation did not stop after abort: ${context.request.name}`,
        {
          details:
            'The capability ignored AbortSignal beyond the cleanup budget; the caller must treat the session as unsafe for reuse.',
          context: {
            capability: context.request.name,
            traceId: context.runtime.traceId,
            reason: 'invocation_abandoned',
            cleanupBudgetMs: ABORTED_INVOCATION_DRAIN_TIMEOUT_MS,
          },
        }
      );
    }

    throw error;
  } finally {
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
};

const attachAbortSignalToBrowser = (
  browser: BrowserInterface,
  context: Pick<InvokeExecutionContext, 'request' | 'runtime' | 'options'>
): BrowserInterface => {
  const signal = context.options.signal;
  if (!signal) {
    return browser;
  }

  const nativeFacade =
    typeof browser.withAbortSignal === 'function' ? browser.withAbortSignal(signal) : undefined;
  if (nativeFacade) {
    return nativeFacade;
  }

  return bindAbortSignalToFacade(browser, {
    signal,
    label: context.request.name,
    createAbortError: () => resolveInvocationAbortError(context, signal),
  });
};

const buildExecutionDeps = (context: InvokeExecutionContext): OrchestrationDependencies => {
  const signal = context.options.signal;
  if (!signal) {
    return context.deps;
  }

  return {
    ...context.deps,
    signal,
    ...(context.deps.browser
      ? { browser: attachAbortSignalToBrowser(context.deps.browser, context) }
      : {}),
    ...(context.deps.browserFactory
      ? {
          browserFactory: async (options: { partition?: string; visible?: boolean }) =>
            attachAbortSignalToBrowser(
              await awaitAbortableInvocation(context.deps.browserFactory!(options), context),
              context
            ),
        }
      : {}),
  };
};

const buildCapabilityHandlerContext = (
  context: Pick<InvokeExecutionContext, 'request' | 'runtime' | 'options'>
): CapabilityHandlerExecutionContext => ({
  capability: context.request.name,
  traceId: context.runtime.traceId,
  signal: context.options.signal,
});

function buildOutput(result: CapabilityCallResult): OrchestrationInvokeOutput {
  const text: string[] = [];
  let imageCount = 0;

  for (const item of result.content) {
    if (item.type === 'text' && typeof item.text === 'string') {
      text.push(item.text);
    }
    if (item.type === 'image' && typeof item.data === 'string') {
      imageCount += 1;
    }
  }

  return {
    text,
    hasImage: imageCount > 0,
    imageCount,
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
}

function inferErrorFromResult(outcome: InvokeOutcome): StructuredError | undefined {
  if (outcome.error) {
    return outcome.error;
  }

  if (outcome.result._meta?.error) {
    return outcome.result._meta.error;
  }

  const structuredContentError =
    outcome.result.structuredContent &&
    typeof outcome.result.structuredContent === 'object' &&
    'error' in outcome.result.structuredContent
      ? (outcome.result.structuredContent as { error?: unknown }).error
      : undefined;
  if (isStructuredError(structuredContentError)) {
    return structuredContentError;
  }

  const structuredPayloadError =
    outcome.result.structuredContent &&
    typeof outcome.result.structuredContent === 'object' &&
    'error' in outcome.result.structuredContent &&
    typeof (outcome.result.structuredContent as { error?: unknown }).error === 'object'
      ? ((outcome.result.structuredContent as { error?: Record<string, unknown> }).error as
          | Record<string, unknown>
          | undefined)
      : undefined;
  if (
    structuredPayloadError &&
    typeof structuredPayloadError.code === 'string' &&
    typeof structuredPayloadError.message === 'string'
  ) {
    return createStructuredError(structuredPayloadError.code, structuredPayloadError.message, {
      ...(typeof structuredPayloadError.details === 'string'
        ? { details: structuredPayloadError.details }
        : {}),
      ...(typeof structuredPayloadError.suggestion === 'string'
        ? { suggestion: structuredPayloadError.suggestion }
        : {}),
      ...(structuredPayloadError.context &&
      typeof structuredPayloadError.context === 'object' &&
      !Array.isArray(structuredPayloadError.context)
        ? { context: structuredPayloadError.context as Record<string, unknown> }
        : {}),
      ...(typeof structuredPayloadError.reasonCode === 'string'
        ? { reasonCode: structuredPayloadError.reasonCode }
        : {}),
      ...(typeof structuredPayloadError.retryable === 'boolean'
        ? { retryable: structuredPayloadError.retryable }
        : {}),
      ...(Array.isArray(structuredPayloadError.recommendedNextTools)
        ? {
            recommendedNextTools: structuredPayloadError.recommendedNextTools.filter(
              (item): item is string => typeof item === 'string'
            ),
          }
        : {}),
      ...(Array.isArray(structuredPayloadError.authoritativeFields)
        ? {
            authoritativeFields: structuredPayloadError.authoritativeFields.filter(
              (item): item is string => typeof item === 'string'
            ),
          }
        : {}),
      ...(Array.isArray(structuredPayloadError.nextActionHints)
        ? {
            nextActionHints: structuredPayloadError.nextActionHints.filter(
              (item): item is string => typeof item === 'string'
            ),
          }
        : {}),
      ...(Array.isArray(structuredPayloadError.candidates)
        ? {
            candidates: structuredPayloadError.candidates.filter(
              (item): item is Record<string, unknown> =>
                typeof item === 'object' && item !== null && !Array.isArray(item)
            ),
          }
        : {}),
    });
  }

  if (!outcome.result.isError) {
    return undefined;
  }

  return createStructuredError(ErrorCode.OPERATION_FAILED, 'Capability execution failed');
}

function toExecutionResult(
  request: OrchestrationInvokeRequest,
  outcome: InvokeOutcome
): OrchestrationExecutionResult {
  const error = inferErrorFromResult(outcome);
  const ok = !outcome.result.isError;
  return {
    capability: request.name,
    ok,
    output: buildOutput(outcome.result),
    ...(error ? { error } : {}),
    result: outcome.result,
    ...(outcome.meta ? { meta: outcome.meta } : {}),
  };
}

const NON_RETRYABLE_ERROR_CODES = new Set<string>([
  ErrorCode.INVALID_PARAMETER,
  ErrorCode.MISSING_PARAMETER,
  ErrorCode.PARAMETER_TYPE_MISMATCH,
  ErrorCode.VALIDATION_ERROR,
  ErrorCode.PERMISSION_DENIED,
  ErrorCode.NOT_FOUND,
]);

type InvokeMiddleware = (
  context: InvokeExecutionContext,
  next: () => Promise<InvokeOutcome>
) => Promise<InvokeOutcome>;

const mergeInvokeMeta = (
  base: OrchestrationInvokeMeta | undefined,
  extra: OrchestrationInvokeMeta
): OrchestrationInvokeMeta => {
  return {
    ...(base || {}),
    ...extra,
  };
};

const buildRuntimeMeta = (runtime: InvokeRuntimeMeta): OrchestrationInvokeMeta => {
  return {
    traceId: runtime.traceId,
    ...(runtime.attemptTimeline.length > 0
      ? {
          attempts: runtime.attemptTimeline.length,
          attemptTimeline: runtime.attemptTimeline,
        }
      : {}),
    ...(runtime.scopeDecision ? { scopeDecision: runtime.scopeDecision } : {}),
    ...(runtime.idempotencyDecision ? { idempotencyDecision: runtime.idempotencyDecision } : {}),
    ...(runtime.confirmationDecision
      ? { confirmationDecision: runtime.confirmationDecision }
      : {}),
  };
};

const withRuntimeMeta = (
  runtime: InvokeRuntimeMeta,
  outcome: InvokeOutcome
): InvokeOutcome => {
  return {
    ...outcome,
    meta: mergeInvokeMeta(outcome.meta, buildRuntimeMeta(runtime)),
  };
};

const normalizeForHash = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalizeForHash(child)])
    );
  }
  return value;
};

export const hashOrchestrationInvokePayload = (
  name: string,
  args: Record<string, unknown>
): string => {
  return createHash('sha256')
    .update(JSON.stringify(normalizeForHash({ name, args })))
    .digest('hex');
};

const isRetryableError = (error: StructuredError | undefined): boolean => {
  if (!error) {
    return false;
  }
  if (
    typeof error.context?.reason === 'string' &&
    NON_RETRYABLE_ABORT_REASONS.has(error.context.reason)
  ) {
    return false;
  }
  return !NON_RETRYABLE_ERROR_CODES.has(error.code);
};

const applyMiddlewares = async (
  context: InvokeExecutionContext,
  middlewares: InvokeMiddleware[],
  terminal: () => Promise<InvokeOutcome>
): Promise<InvokeOutcome> => {
  const dispatch = async (index: number): Promise<InvokeOutcome> => {
    const middleware = middlewares[index];
    if (!middleware) {
      return terminal();
    }
    return middleware(context, () => dispatch(index + 1));
  };
  return dispatch(0);
};

const buildCapabilityObservationAttrs = (
  context: Pick<InvokeExecutionContext, 'request' | 'runtime'>,
  outcome?: InvokeOutcome
): Record<string, unknown> => ({
  capability: context.request.name,
  source: context.request.auth?.source ?? 'internal',
  arguments: summarizeForObservation(context.request.arguments, 2),
  attempts: context.runtime.attemptTimeline.length,
  attemptTimeline: summarizeForObservation(context.runtime.attemptTimeline, 2),
  ...(context.runtime.scopeDecision
    ? { scopeDecision: summarizeForObservation(context.runtime.scopeDecision, 2) }
    : {}),
  ...(context.runtime.idempotencyDecision
    ? { idempotencyDecision: summarizeForObservation(context.runtime.idempotencyDecision, 2) }
    : {}),
  ...(context.runtime.confirmationDecision
    ? {
        confirmationDecision: summarizeForObservation(
          context.runtime.confirmationDecision,
          2
        ),
      }
    : {}),
  ...(outcome
    ? {
        output: summarizeForObservation(
          outcome.result.structuredContent ?? outcome.result.content,
          2
        ),
      }
    : {}),
});

const scopeMiddleware: InvokeMiddleware = async (context, next) => {
  const requiredScopes = context.definition.requiredScopes || [];
  const providedScopes = context.request.auth?.scopes || [];
  const missingScopes = requiredScopes.filter((scope) => !providedScopes.includes(scope));
  const scopeEnforced = context.deps.enforceScopes !== false;

  const scopeDecision: NonNullable<OrchestrationInvokeMeta['scopeDecision']> = {
    enforced: scopeEnforced,
    requiredScopes,
    providedScopes,
    missingScopes,
    allowed: !scopeEnforced || missingScopes.length === 0,
  };
  context.runtime.scopeDecision = scopeDecision;

  if (!scopeEnforced || missingScopes.length === 0) {
    return next();
  }

  const error = createStructuredError(ErrorCode.PERMISSION_DENIED, '权限不足，缺少调用能力所需 scope', {
    details: `能力 "${context.request.name}" 需要 scope: ${requiredScopes.join(', ')}`,
    suggestion: '请在请求中提供 x-airpa-scopes 或通过 session_prepare 设置会话 scopes',
    context: {
      capability: context.request.name,
      requiredScopes,
      providedScopes,
      missingScopes,
    },
  });

  return {
    result: formatStructuredErrorResult(error),
    error,
    meta: {
      scopeDecision,
    },
  };
};

const idempotencyMiddleware: InvokeMiddleware = async (context, next) => {
  const idempotencyKey = context.options.idempotency?.key?.trim();
  if (!idempotencyKey) {
    context.runtime.idempotencyDecision = {
      enabled: false,
      status: 'skipped',
      reason: 'missing_idempotency_key',
    };
    return next();
  }

  if (!context.definition.idempotent) {
    context.runtime.idempotencyDecision = {
      enabled: true,
      key: idempotencyKey,
      status: 'rejected',
      reason: 'capability_not_idempotent',
    };
    const error = createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Capability ${context.request.name} is not idempotent, Idempotency-Key is not allowed`,
      {
        suggestion: '请仅对幂等能力使用 Idempotency-Key',
        context: {
          capability: context.request.name,
          idempotent: context.definition.idempotent ?? false,
        },
      }
    );
    return {
      result: formatStructuredErrorResult(error),
      error,
      meta: {
        idempotencyKey,
      },
    };
  }

  const store = context.options.idempotency?.store;
  if (!store) {
    context.runtime.idempotencyDecision = {
      enabled: true,
      key: idempotencyKey,
      status: 'rejected',
      reason: 'idempotency_store_missing',
    };
    const error = createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'Idempotency store is not configured',
      {
        suggestion: '请在调用编排执行器时传入 idempotency.store',
      }
    );
    return {
      result: formatStructuredErrorResult(error),
      error,
      meta: {
        idempotencyKey,
      },
    };
  }

  const requestHash = hashOrchestrationInvokePayload(
    context.request.name,
    context.request.arguments || {}
  );
  const cached = store.get(idempotencyKey);

  if (cached) {
    if (cached.requestHash !== requestHash || cached.capability !== context.request.name) {
      context.runtime.idempotencyDecision = {
        enabled: true,
        key: idempotencyKey,
        status: 'rejected',
        reason: 'idempotency_conflict',
      };
      const error = createStructuredError(
        ErrorCode.REQUEST_FAILED,
        'Idempotency-Key already used with a different request payload',
        {
          context: {
            idempotencyKey,
            capability: context.request.name,
            reason: 'idempotency_conflict',
          },
        }
      );
      return {
        result: formatStructuredErrorResult(error),
        error,
        meta: {
          idempotencyKey,
        },
      };
    }

    if (cached.state === 'running' || !cached.result) {
      context.runtime.idempotencyDecision = {
        enabled: true,
        key: idempotencyKey,
        status: 'rejected',
        reason: 'idempotency_request_running',
      };
      const error = createStructuredError(
        ErrorCode.REQUEST_FAILED,
        'Idempotency-Key is already reserved by an in-flight request',
        {
          context: {
            idempotencyKey,
            capability: context.request.name,
            reason: 'idempotency_request_running',
          },
        }
      );
      return {
        result: formatStructuredErrorResult(error),
        error,
        meta: {
          idempotencyKey,
        },
      };
    }

    context.runtime.idempotencyDecision = {
      enabled: true,
      key: idempotencyKey,
      status: 'replayed',
    };

    const cachedError = cached.error;
    return {
      result: cached.result,
      ...(cachedError ? { error: cachedError } : {}),
      meta: mergeInvokeMeta(cached.meta, {
        idempotencyKey,
        idempotencyStatus: 'replayed',
      }),
    };
  }

  context.runtime.idempotencyDecision = {
    enabled: true,
    key: idempotencyKey,
    status: 'stored',
  };

  const outcome = await next();
  const now = context.options.idempotency?.now || Date.now;
  const derivedError = inferErrorFromResult(outcome);

  if (derivedError?.reasonCode === 'capability_output_schema_validation_failed') {
    context.runtime.idempotencyDecision = {
      enabled: true,
      key: idempotencyKey,
      status: 'skipped',
      reason: 'schema_validation_failed',
    };
    return outcome;
  }

  store.set(idempotencyKey, {
    state: 'completed',
    requestHash,
    capability: context.request.name,
    createdAt: now(),
    result: outcome.result,
    ...(derivedError ? { error: derivedError } : {}),
    ...(outcome.meta ? { meta: outcome.meta } : {}),
  });

  return {
    ...outcome,
    meta: mergeInvokeMeta(outcome.meta, {
      idempotencyKey,
      idempotencyStatus: 'stored',
    }),
  };
};

const inputSchemaValidationMiddleware: InvokeMiddleware = async (context, next) => {
  const inputFailure = validateCapabilitySchemaPayload(
    context.definition,
    'input',
    context.definition.inputSchema,
    context.request.arguments || {}
  );
  if (inputFailure) {
    const error = createCapabilitySchemaValidationError(context.definition, inputFailure);
    return {
      result: formatStructuredErrorResult(error),
      error,
    };
  }

  return next();
};

const confirmationMiddleware: InvokeMiddleware = async (context, next) => {
  const validation = validateCapabilityConfirmationGrant({
    definition: context.definition,
    request: context.request,
    idempotencyKey: context.options.idempotency?.key?.trim(),
    now: context.options.confirmation?.now || context.options.idempotency?.now,
  });
  context.runtime.confirmationDecision = validation.decision;

  if (!validation.error) {
    return next();
  }

  return {
    result: formatStructuredErrorResult(validation.error),
    error: validation.error,
    meta: {
      confirmationDecision: validation.decision,
    },
  };
};

const outputSchemaValidationMiddleware: InvokeMiddleware = async (context, next) => {
  const outcome = await next();
  if (outcome.result.isError || !outcome.result.structuredContent) {
    return outcome;
  }

  const outputFailure = validateCapabilitySchemaPayload(
    context.definition,
    'output',
    context.definition.outputSchema,
    outcome.result.structuredContent
  );
  if (!outputFailure) {
    return outcome;
  }

  const error = createCapabilitySchemaValidationError(context.definition, outputFailure);
  return {
    result: formatStructuredErrorResult(error),
    error,
    meta: outcome.meta,
  };
};

const retryMiddleware: InvokeMiddleware = async (context, next) => {
  const retryPolicy = context.definition.retryPolicy;
  const retryable = Boolean(retryPolicy?.retryable);
  const configuredAttempts = Number.isFinite(retryPolicy?.maxAttempts)
    ? Math.max(1, Math.floor(retryPolicy?.maxAttempts as number))
    : 1;
  const overrideAttempts = retryable && Number.isFinite(context.options.retry?.maxAttempts)
    ? Math.max(1, Math.floor(context.options.retry?.maxAttempts as number))
    : undefined;
  const maxAttempts = retryable ? overrideAttempts ?? configuredAttempts : 1;

  let lastOutcome: InvokeOutcome | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const current = await next();
    const finishedAt = Date.now();

    const error = inferErrorFromResult(current);
    context.runtime.attemptTimeline.push({
      attempt,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
      ok: !current.result.isError,
      ...(error ? { errorCode: error.code } : {}),
    });

    const outcome = {
      ...current,
      meta: mergeInvokeMeta(current.meta, {
        attempts: context.runtime.attemptTimeline.length,
        attemptTimeline: [...context.runtime.attemptTimeline],
      }),
    };
    lastOutcome = outcome;

    if (!retryable || !isRetryableError(error) || attempt >= maxAttempts) {
      return outcome;
    }
  }

  return lastOutcome || (await next());
};

const invokeCapabilityCore = async (context: InvokeExecutionContext): Promise<InvokeOutcome> => {
  const args = context.request.arguments || {};
  const executionDeps = buildExecutionDeps(context);
  const handlerContext = buildCapabilityHandlerContext(context);

  try {
    throwIfInvocationAborted(context);
    return {
      result: await awaitAbortableInvocation(
        Promise.resolve().then(() => context.handler(args, executionDeps, handlerContext)),
        context
      ),
    };
  } catch (caught: unknown) {
    if (isParamValidationLikeError(caught)) {
      const paramName =
        typeof (caught as { paramName?: unknown }).paramName === 'string'
          ? ((caught as { paramName?: string }).paramName as string)
          : 'unknown';
      const error = createStructuredError(ErrorCode.INVALID_PARAMETER, `参数验证失败: ${caught.message}`, {
        details: `能力 "${context.request.name}" 的参数不符合要求`,
        suggestion: '请检查参数类型和必填字段',
        context: {
          capability: context.request.name,
          paramName,
        },
      });
      return {
        result: formatStructuredErrorResult(error),
        error,
      };
    }

    if (isStructuredError(caught)) {
      return {
        result: formatStructuredErrorResult(caught),
        error: caught,
      };
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    const error = createStructuredError(ErrorCode.OPERATION_FAILED, `能力执行失败: ${message}`, {
      details: `能力 "${context.request.name}" 执行过程中发生错误`,
      context: {
        capability: context.request.name,
        errorType: caught instanceof Error ? caught.constructor.name : typeof caught,
      },
    });
    return {
      result: formatStructuredErrorResult(error),
      error,
    };
  }
};

async function invokeCapability(
  request: OrchestrationInvokeRequest,
  deps: OrchestrationDependencies,
  options: OrchestrationInvokeOptions = {},
  lookup: InvokeCapabilityLookup = {
    registry: defaultOrchestrationCapabilityRegistry,
    executorGeneration: defaultOrchestrationCapabilityRegistry.getGeneration(),
  }
): Promise<InvokeOutcome> {
  const traceId = options.traceId?.trim() || randomUUID();
  const registrySnapshot = lookup.registry.getSnapshot();
  const handler = registrySnapshot.handlers[request.name];
  const definition = registrySnapshot.definitionsByName[request.name];
  const traceContext = createChildTraceContext({
    traceId,
    source: request.auth?.source ?? 'internal',
    capability: request.name,
    attributes: {
      principal: request.auth?.principal,
    },
  });

  return await withTraceContext(traceContext, async () => {
    const span = await observationService.startSpan({
      context: traceContext,
      component: 'orchestration',
      event: 'capability.invoke',
      attrs: {
        capability: request.name,
        source: request.auth?.source ?? 'internal',
      },
    });

    if (!handler || !definition) {
      const runtime = {
        traceId,
        attemptTimeline: [],
      };
      const error = createStructuredError(ErrorCode.NOT_FOUND, `未知能力: ${request.name}`, {
        suggestion: '请先调用 /api/v1/orchestration/capabilities 确认可用能力',
      });
      const artifact = await attachErrorContextArtifact({
        span,
        component: 'orchestration',
        label: 'capability failure context',
        data: {
          capability: request.name,
          reason: 'unknown_capability',
          traceId,
        },
      });
      await span.fail(error, {
        artifactRefs: [artifact.artifactId],
        attrs: buildCapabilityObservationAttrs(
          {
            request,
            runtime,
          },
          {
            result: formatStructuredErrorResult(error),
            error,
          }
        ),
      });
      return {
        result: formatStructuredErrorResult(error),
        error,
        meta: {
          traceId,
        },
      };
    }

    if (
      registrySnapshot.generation !== lookup.executorGeneration &&
      requiresCapabilityConfirmation(definition, request.arguments || {})
    ) {
      const runtime = {
        traceId,
        attemptTimeline: [],
      };
      const error = createStructuredError(
        ErrorCode.REQUEST_FAILED,
        `Capability registry changed before high-risk invocation: ${request.name}`,
        {
          reasonCode: 'capability_registry_generation_stale',
          suggestion: '请刷新 capability catalog 后重新确认并调用该高风险能力',
          context: {
            capability: request.name,
            executorGeneration: lookup.executorGeneration,
            registryGeneration: registrySnapshot.generation,
          },
        }
      );
      const artifact = await attachErrorContextArtifact({
        span,
        component: 'orchestration',
        label: 'capability failure context',
        data: {
          capability: request.name,
          reason: 'capability_registry_generation_stale',
          traceId,
          executorGeneration: lookup.executorGeneration,
          registryGeneration: registrySnapshot.generation,
        },
      });
      await span.fail(error, {
        artifactRefs: [artifact.artifactId],
        attrs: buildCapabilityObservationAttrs(
          {
            request,
            runtime,
          },
          {
            result: formatStructuredErrorResult(error),
            error,
          }
        ),
      });
      return {
        result: formatStructuredErrorResult(error),
        error,
        meta: {
          traceId,
        },
      };
    }

    const context: InvokeExecutionContext = {
      request,
      deps,
      definition,
      handler,
      options,
      runtime: {
        traceId,
        attemptTimeline: [],
      },
    };

    try {
      const outcome = await applyMiddlewares(
        context,
        [
          scopeMiddleware,
          inputSchemaValidationMiddleware,
          idempotencyMiddleware,
          confirmationMiddleware,
          outputSchemaValidationMiddleware,
          retryMiddleware,
        ],
        () => invokeCapabilityCore(context)
      );

      if (outcome.error || outcome.result.isError) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'orchestration',
          label: 'capability failure context',
          data: buildCapabilityObservationAttrs(context, outcome),
        });
        await span.fail(outcome.error || outcome.result._meta?.error || new Error('Capability failed'), {
          artifactRefs: [artifact.artifactId],
          attrs: buildCapabilityObservationAttrs(context, outcome),
        });
      } else {
        await span.succeed({
          attrs: buildCapabilityObservationAttrs(context, outcome),
        });
      }

      return withRuntimeMeta(context.runtime, outcome);
    } catch (error) {
      const artifact = await attachErrorContextArtifact({
        span,
        component: 'orchestration',
        label: 'capability failure context',
        data: buildCapabilityObservationAttrs(context),
      });
      await span.fail(error, {
        artifactRefs: [artifact.artifactId],
        attrs: buildCapabilityObservationAttrs(context),
      });
      throw error;
    }
  });
}

export function listOrchestrationCapabilities(): OrchestrationCapabilityDefinition[] {
  return defaultOrchestrationCapabilityRegistry.listCapabilities();
}

export function __setOrchestrationCapabilityCatalogForTests(
  catalog: Record<string, RegisteredCapability>
): () => void {
  return defaultOrchestrationCapabilityRegistry.__replaceCatalogForTests(catalog);
}

export function createOrchestrationExecutor(
  deps: OrchestrationDependencies,
  executorOptions: {
    registry?: OrchestrationCapabilityRegistry;
  } = {}
): OrchestrationExecutor {
  const registry = executorOptions.registry || defaultOrchestrationCapabilityRegistry;
  let executorGeneration = registry.getGeneration();
  const refreshGeneration = () => {
    executorGeneration = registry.getGeneration();
    return executorGeneration;
  };
  return {
    listCapabilities(): OrchestrationCapabilityDefinition[] {
      refreshGeneration();
      return registry.listCapabilities();
    },

    refreshGeneration,

    hasCapability(name: string): boolean {
      return registry.hasCapability(name);
    },

    async invoke(
      request: OrchestrationInvokeRequest,
      invokeOptions?: OrchestrationInvokeOptions
    ): Promise<CapabilityCallResult> {
      const outcome = await invokeCapability(request, deps, invokeOptions, {
        registry,
        executorGeneration,
      });
      const execution = toExecutionResult(request, outcome);
      return execution.result;
    },

    async invokeApi(
      request: OrchestrationInvokeRequest,
      invokeOptions?: OrchestrationInvokeOptions
    ): Promise<OrchestrationInvokeApiResult> {
      const outcome = await invokeCapability(request, deps, invokeOptions, {
        registry,
        executorGeneration,
      });
      const execution = toExecutionResult(request, outcome);
      return {
        ok: execution.ok,
        capability: execution.capability,
        output: execution.output,
        ...(execution.error ? { error: execution.error } : {}),
        ...(execution.meta ? { _meta: execution.meta } : {}),
      };
    },
  };
}
