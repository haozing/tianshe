import { createHash, randomUUID } from 'node:crypto';
import type { ResourceAcquireOptions } from '../../resource-coordinator';
import { resourceCoordinator } from '../../resource-coordinator';
import type { CapabilityCallResult } from '../capabilities/types';
import { createStructuredErrorResult } from '../capabilities/result-utils';
import type {
  CapabilityRunArtifactRef,
  CapabilityRunAttemptKind,
  CapabilityRunCheckpoint,
  CapabilityRunRecord,
  CapabilityRunStore,
} from '../../../types/capability-run';
import { ErrorCode, createStructuredError, type StructuredError } from '../../../types/error-codes';
import type { CapabilityConfirmationGrant } from './types';

export type DurableCapabilityRunMode = 'start' | 'resume' | 'reconcile' | 'cancel';
type ExecutableCapabilityRunMode = Exclude<DurableCapabilityRunMode, 'cancel'>;

export interface DurableCapabilityDefinition {
  providerId: string;
  capability: string;
  pluginVersion?: string | null;
  capabilityVersion: string;
  sideEffectLevel?: 'none' | 'low' | 'high';
  resourceKeys?: string[];
}

export interface CapabilityRunContext {
  runId: string;
  providerId: string;
  capability: string;
  pluginVersion?: string | null;
  capabilityVersion: string;
  input: Record<string, unknown>;
  inputHash: string;
  traceId: string;
  resourceKeys: string[];
  mode: DurableCapabilityRunMode;
  signal: AbortSignal;
  checkpoint(
    checkpoint: Omit<CapabilityRunCheckpoint, 'sequence' | 'updatedAt'> & {
      sequence?: number;
      updatedAt?: string;
    }
  ): Promise<CapabilityRunCheckpoint>;
}

export interface CapabilityRunResult {
  result: CapabilityCallResult;
  checkpoint?: Omit<CapabilityRunCheckpoint, 'sequence' | 'updatedAt'> & {
    sequence?: number;
    updatedAt?: string;
  };
  artifactRefs?: CapabilityRunArtifactRef[];
}

export interface DurableCapabilityHandler {
  start(context: CapabilityRunContext): Promise<CapabilityRunResult>;
  resume?(checkpoint: unknown, context: CapabilityRunContext): Promise<CapabilityRunResult>;
  reconcile?(checkpoint: unknown, context: CapabilityRunContext): Promise<CapabilityRunResult>;
  cancel?(checkpoint: unknown, context: CapabilityRunContext): Promise<void>;
}

export interface StartCapabilityRunOptions {
  runId?: string;
  input?: Record<string, unknown>;
  confirmationGrant?: CapabilityConfirmationGrant | null;
  idempotencyKey?: string | null;
  traceId?: string;
  resourceKeys?: string[];
  signal?: AbortSignal;
}

export interface RecoverCapabilityRunOptions {
  handler?: DurableCapabilityHandler;
  definition?: DurableCapabilityDefinition;
  signal?: AbortSignal;
}

export interface CancelCapabilityRunOptions {
  reason?: string;
  handler?: DurableCapabilityHandler;
}

export interface CapabilityRunManagerOptions {
  store: CapabilityRunStore;
  now?: () => string;
  runIdGenerator?: () => string;
  attemptIdGenerator?: () => string;
  resourceRunner?: <T>(
    keys: string[],
    options: ResourceAcquireOptions | undefined,
    fn: () => Promise<T>
  ) => Promise<T>;
}

export class CapabilityRunManager {
  private readonly store: CapabilityRunStore;
  private readonly now: () => string;
  private readonly runIdGenerator: () => string;
  private readonly attemptIdGenerator: () => string;
  private readonly resourceRunner: NonNullable<CapabilityRunManagerOptions['resourceRunner']>;
  private readonly runningControllers = new Map<string, AbortController>();

  constructor(options: CapabilityRunManagerOptions) {
    this.store = options.store;
    this.now = options.now || (() => new Date().toISOString());
    this.runIdGenerator = options.runIdGenerator || (() => randomUUID());
    this.attemptIdGenerator = options.attemptIdGenerator || (() => randomUUID());
    this.resourceRunner =
      options.resourceRunner ||
      ((keys, acquireOptions, fn) => resourceCoordinator.runExclusive(keys, acquireOptions, fn));
  }

  async start(
    definition: DurableCapabilityDefinition,
    handler: DurableCapabilityHandler,
    options: StartCapabilityRunOptions = {}
  ): Promise<CapabilityRunRecord> {
    const input = normalizeInput(options.input);
    const run = await this.store.createRun({
      runId: normalizeIdentifier(options.runId) || this.runIdGenerator(),
      providerId: definition.providerId,
      capability: definition.capability,
      pluginVersion: definition.pluginVersion ?? null,
      capabilityVersion: definition.capabilityVersion,
      inputHash: hashCapabilityRunInput(input),
      input,
      confirmationGrant: options.confirmationGrant ?? null,
      idempotencyKey: options.idempotencyKey ?? null,
      traceId: normalizeIdentifier(options.traceId) || randomUUID(),
      resourceKeys: normalizeResourceKeys([...(definition.resourceKeys || []), ...(options.resourceKeys || [])]),
      now: this.now(),
    });

    return this.executeRun({
      run,
      definition,
      handler,
      mode: 'start',
      input,
      signal: options.signal,
    });
  }

  async recover(
    runId: string,
    options: RecoverCapabilityRunOptions = {}
  ): Promise<CapabilityRunRecord> {
    const run = await this.requireRun(runId);
    if (isTerminalRunStatus(run.status)) {
      throw createStructuredError(
        ErrorCode.VALIDATION_ERROR,
        `Cannot recover terminal capability run ${run.runId} in ${run.status} state`,
        {
          reasonCode: 'capability_run_terminal_not_recoverable',
          context: {
            runId: run.runId,
            status: run.status,
            capability: run.capability,
            traceId: run.traceId,
          },
        }
      );
    }
    this.assertRunNotExecuting(run);
    if (!options.handler || !options.definition) {
      return this.pauseForManualReview(run, 'capability_run_handler_missing');
    }

    const versionPause = await this.pauseIfVersionMismatch(run, options.definition);
    if (versionPause) {
      return versionPause;
    }

    const checkpoint = run.checkpoint ?? null;
    if (run.status === 'pending') {
      return this.executeRun({
        run,
        definition: options.definition,
        handler: options.handler,
        mode: 'start',
        input: normalizeInput(run.input),
        checkpoint,
        signal: options.signal,
      });
    }

    if (run.status === 'cancel_requested') {
      return this.recoverCancelRequestedRun(run, options.definition, options.handler);
    }

    if (options.handler.resume) {
      return this.executeRun({
        run,
        definition: options.definition,
        handler: options.handler,
        mode: 'resume',
        input: normalizeInput(run.input),
        checkpoint,
        signal: options.signal,
      });
    }

    if (options.handler.reconcile) {
      return this.executeRun({
        run,
        definition: options.definition,
        handler: options.handler,
        mode: 'reconcile',
        input: normalizeInput(run.input),
        checkpoint,
        signal: options.signal,
      });
    }

    return this.pauseForManualReview(run, 'capability_run_resume_contract_missing');
  }

  async recoverPending(
    registry: (run: CapabilityRunRecord) => RecoverCapabilityRunOptions | null | undefined,
    options: { limit?: number } = {}
  ): Promise<CapabilityRunRecord[]> {
    const runs = await this.store.listRecoverableRuns({ limit: options.limit });
    const recovered: CapabilityRunRecord[] = [];
    for (const run of runs) {
      const recovery = registry(run);
      recovered.push(await this.recover(run.runId, recovery || {}));
    }
    return recovered;
  }

  async requestCancel(
    runId: string,
    options: CancelCapabilityRunOptions = {}
  ): Promise<CapabilityRunRecord> {
    const run = await this.requireRun(runId);
    if (isTerminalRunStatus(run.status)) {
      return run;
    }
    const controller = this.runningControllers.get(run.runId);
    const hasRunningController = Boolean(controller && !controller.signal.aborted);
    const updated = await this.store.updateRun(run.runId, {
      status: 'cancel_requested',
      cancellationRequestedAt: this.now(),
      cancellationReason: normalizeIdentifier(options.reason) || null,
      updatedAt: this.now(),
    });

    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(options.reason || 'Capability run cancellation requested'));
    }

    if (options.handler?.cancel) {
      const cancelAttempt = await this.runCancelHandler(updated, {
        providerId: updated.providerId,
        capability: updated.capability,
        pluginVersion: updated.pluginVersion ?? null,
        capabilityVersion: updated.capabilityVersion,
        resourceKeys: updated.resourceKeys,
      }, options.handler);
      if (!cancelAttempt.ok) {
        if (!hasRunningController) {
          return this.store.updateRun(updated.runId, {
            status: 'paused_manual_review',
            error: cancelAttempt.error,
            manualReviewReason: 'capability_run_cancel_handler_failed',
            updatedAt: this.now(),
          });
        }
      }
    }

    if (!hasRunningController) {
      return this.store.updateRun(updated.runId, {
        status: 'cancelled',
        finishedAt: this.now(),
        updatedAt: this.now(),
      });
    }

    return this.requireRun(updated.runId);
  }

  private async executeRun(input: {
    run: CapabilityRunRecord;
    definition: DurableCapabilityDefinition;
    handler: DurableCapabilityHandler;
    mode: ExecutableCapabilityRunMode;
    input: Record<string, unknown>;
    checkpoint?: CapabilityRunCheckpoint | null;
    signal?: AbortSignal;
  }): Promise<CapabilityRunRecord> {
    this.assertRunNotExecuting(input.run);

    const controller = linkAbortSignals(input.signal);
    this.runningControllers.set(input.run.runId, controller);
    const attemptId = this.attemptIdGenerator();
    const attemptKind: CapabilityRunAttemptKind = input.mode;
    const startedAt = this.now();

    await this.store.appendAttempt({
      attemptId,
      runId: input.run.runId,
      kind: attemptKind,
      status: 'running',
      startedAt,
      checkpointSequence: input.run.checkpoint?.sequence ?? null,
      traceId: input.run.traceId,
    });

    let currentRun = await this.store.updateRun(input.run.runId, {
      status: input.mode === 'reconcile' ? 'reconciling' : 'running',
      startedAt: input.run.startedAt || startedAt,
      updatedAt: startedAt,
    });

    try {
      const context = await this.createContext({
        run: currentRun,
        definition: input.definition,
        input: input.input,
        mode: input.mode,
        signal: controller.signal,
      });
      const executeHandler = async () => {
        if (input.mode === 'resume') {
          return input.handler.resume!(input.checkpoint?.payload, context);
        }
        if (input.mode === 'reconcile') {
          return input.handler.reconcile!(input.checkpoint?.payload, context);
        }
        return input.handler.start(context);
      };
      const resourceKeys = currentRun.resourceKeys;
      const result = await this.resourceRunner(
        resourceKeys,
        {
          ownerToken: currentRun.runId,
          ownerSource: input.definition.providerId.startsWith('plugin:') ? 'plugin' : 'internal',
          ownerMetadata: {
            controllerKind: input.definition.providerId.startsWith('plugin:') ? 'plugin' : 'system',
            capability: currentRun.capability,
            traceId: currentRun.traceId,
            interruptibility: 'checkpoint',
          },
          signal: controller.signal,
        },
        executeHandler
      );

      if (result.checkpoint || result.artifactRefs?.length) {
        const nextArtifactRefs = result.artifactRefs || result.checkpoint?.artifactRefs || [];
        await context.checkpoint({
          ...(result.checkpoint || {}),
          artifactRefs: nextArtifactRefs,
        });
        currentRun = await this.requireRun(currentRun.runId);
      }

      const finishedAt = this.now();
      await this.store.updateAttempt(attemptId, {
        status: controller.signal.aborted ? 'cancelled' : 'completed',
        finishedAt,
        checkpointSequence: currentRun.checkpoint?.sequence ?? null,
      });
      return this.store.updateRun(currentRun.runId, {
        status: controller.signal.aborted ? 'cancelled' : 'completed',
        result: result.result,
        finishedAt,
        updatedAt: finishedAt,
      });
    } catch (error) {
      const structuredError = toStructuredCapabilityRunError(error, currentRun);
      const finishedAt = this.now();
      const cancelled = controller.signal.aborted || isAbortLikeError(error);
      await this.store.updateAttempt(attemptId, {
        status: cancelled ? 'cancelled' : 'failed',
        finishedAt,
        error: structuredError,
        checkpointSequence: currentRun.checkpoint?.sequence ?? null,
      });
      return this.store.updateRun(currentRun.runId, {
        status: cancelled ? 'cancelled' : 'failed',
        error: structuredError,
        result: createStructuredErrorResult(structuredError),
        finishedAt,
        updatedAt: finishedAt,
      });
    } finally {
      this.runningControllers.delete(input.run.runId);
    }
  }

  private async createContext(input: {
    run: CapabilityRunRecord;
    definition: DurableCapabilityDefinition;
    input: Record<string, unknown>;
    mode: DurableCapabilityRunMode;
    signal: AbortSignal;
  }): Promise<CapabilityRunContext> {
    return {
      runId: input.run.runId,
      providerId: input.run.providerId,
      capability: input.run.capability,
      pluginVersion: input.run.pluginVersion ?? null,
      capabilityVersion: input.run.capabilityVersion,
      input: input.input,
      inputHash: input.run.inputHash,
      traceId: input.run.traceId,
      resourceKeys: [...input.run.resourceKeys],
      mode: input.mode,
      signal: input.signal,
      checkpoint: async (checkpoint) => {
        const current = await this.requireRun(input.run.runId);
        const next: CapabilityRunCheckpoint = {
          sequence:
            typeof checkpoint.sequence === 'number' && Number.isFinite(checkpoint.sequence)
              ? Math.trunc(checkpoint.sequence)
              : (current.checkpoint?.sequence ?? 0) + 1,
          payload: checkpoint.payload,
          artifactRefs: normalizeArtifactRefs(checkpoint.artifactRefs),
          procedureResumeRef: normalizeIdentifier(checkpoint.procedureResumeRef) || undefined,
          updatedAt: normalizeIdentifier(checkpoint.updatedAt) || this.now(),
        };
        await this.store.updateRun(current.runId, {
          checkpoint: next,
          updatedAt: next.updatedAt,
        });
        return next;
      },
    };
  }

  private async requireRun(runId: string): Promise<CapabilityRunRecord> {
    const run = await this.store.getRun(runId);
    if (!run) {
      throw createStructuredError(ErrorCode.NOT_FOUND, `Capability run not found: ${runId}`, {
        reasonCode: 'capability_run_not_found',
      });
    }
    return run;
  }

  private assertRunNotExecuting(run: CapabilityRunRecord): void {
    const existingController = this.runningControllers.get(run.runId);
    if (!existingController || existingController.signal.aborted) {
      return;
    }
    throw createStructuredError(
      ErrorCode.RESOURCE_BUSY,
      `Capability run is already executing: ${run.runId}`,
      {
        reasonCode: 'capability_run_already_executing',
        context: {
          runId: run.runId,
          capability: run.capability,
          traceId: run.traceId,
        },
      }
    );
  }

  private async pauseIfVersionMismatch(
    run: CapabilityRunRecord,
    definition: DurableCapabilityDefinition
  ): Promise<CapabilityRunRecord | null> {
    const mismatched =
      run.providerId !== definition.providerId ||
      run.capability !== definition.capability ||
      run.capabilityVersion !== definition.capabilityVersion ||
      (run.pluginVersion ?? null) !== (definition.pluginVersion ?? null);
    if (!mismatched) {
      return null;
    }
    return this.store.updateRun(run.runId, {
      status: 'paused_version_mismatch',
      manualReviewReason: 'capability_run_version_mismatch',
      updatedAt: this.now(),
    });
  }

  private async pauseForManualReview(
    run: CapabilityRunRecord,
    reason: string
  ): Promise<CapabilityRunRecord> {
    const now = this.now();
    await this.store.appendAttempt({
      attemptId: this.attemptIdGenerator(),
      runId: run.runId,
      kind: 'reconcile',
      status: 'paused',
      startedAt: now,
      finishedAt: now,
      checkpointSequence: run.checkpoint?.sequence ?? null,
      traceId: run.traceId,
    });
    return this.store.updateRun(run.runId, {
      status: 'paused_manual_review',
      manualReviewReason: reason,
      updatedAt: now,
    });
  }

  private async recoverCancelRequestedRun(
    run: CapabilityRunRecord,
    definition: DurableCapabilityDefinition,
    handler: DurableCapabilityHandler
  ): Promise<CapabilityRunRecord> {
    if (!handler.cancel) {
      return this.pauseForManualReview(run, 'capability_run_cancel_handler_missing');
    }

    const cancelAttempt = await this.runCancelHandler(run, definition, handler);
    if (!cancelAttempt.ok) {
      return this.store.updateRun(run.runId, {
        status: 'paused_manual_review',
        error: cancelAttempt.error,
        manualReviewReason: 'capability_run_cancel_handler_failed',
        updatedAt: this.now(),
      });
    }

    return this.store.updateRun(run.runId, {
      status: 'cancelled',
      finishedAt: this.now(),
      updatedAt: this.now(),
    });
  }

  private async runCancelHandler(
    run: CapabilityRunRecord,
    definition: DurableCapabilityDefinition,
    handler: DurableCapabilityHandler
  ): Promise<{ ok: true } | { ok: false; error: StructuredError }> {
    const attemptId = this.attemptIdGenerator();
    await this.store.appendAttempt({
      attemptId,
      runId: run.runId,
      kind: 'cancel',
      status: 'running',
      startedAt: this.now(),
      checkpointSequence: run.checkpoint?.sequence ?? null,
      traceId: run.traceId,
    });
    try {
      const cancelController = new AbortController();
      const context = await this.createContext({
        run,
        definition,
        input: normalizeInput(run.input),
        mode: 'cancel',
        signal: cancelController.signal,
      });
      await handler.cancel!(run.checkpoint?.payload, context);
      const latestAfterCancel = await this.requireRun(run.runId);
      await this.store.updateAttempt(attemptId, {
        status: 'completed',
        finishedAt: this.now(),
        checkpointSequence: latestAfterCancel.checkpoint?.sequence ?? null,
      });
      return { ok: true };
    } catch (error) {
      const structuredError = toStructuredCapabilityRunError(error, run);
      await this.store.updateAttempt(attemptId, {
        status: 'failed',
        finishedAt: this.now(),
        error: structuredError,
      });
      return { ok: false, error: structuredError };
    }
  }
}

export function hashCapabilityRunInput(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(normalizeForHash(input))).digest('hex');
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeForHash(item)])
    );
  }
  return value;
}

function normalizeInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? { ...(input as Record<string, unknown>) }
    : {};
}

function normalizeResourceKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.map((key) => normalizeIdentifier(key)).filter(Boolean)));
}

function normalizeArtifactRefs(
  refs: CapabilityRunArtifactRef[] | undefined
): CapabilityRunArtifactRef[] | undefined {
  if (!Array.isArray(refs)) {
    return undefined;
  }
  const normalized = refs
    .map((ref) => ({
      artifactId: normalizeIdentifier(ref.artifactId),
      role: normalizeIdentifier(ref.role) || undefined,
      traceId: normalizeIdentifier(ref.traceId) || undefined,
    }))
    .filter((ref) => ref.artifactId);
  return normalized.length ? normalized : undefined;
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTerminalRunStatus(status: CapabilityRunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function linkAbortSignals(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (!signal) {
    return controller;
  }
  if (signal.aborted) {
    controller.abort(signal.reason);
    return controller;
  }
  signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return controller;
}

function toStructuredCapabilityRunError(
  error: unknown,
  run: CapabilityRunRecord
): StructuredError {
  if (isStructuredError(error)) {
    return error;
  }
  const aborted = isAbortLikeError(error);
  const message = error instanceof Error ? error.message : String(error || 'Capability run failed');
  return createStructuredError(
    aborted ? ErrorCode.REQUEST_FAILED : ErrorCode.OPERATION_FAILED,
    aborted ? `Capability run cancelled: ${run.capability}` : `Capability run failed: ${message}`,
    {
      reasonCode: aborted ? 'capability_run_cancelled' : 'capability_run_failed',
      context: {
        runId: run.runId,
        capability: run.capability,
        traceId: run.traceId,
      },
    }
  );
}

function isStructuredError(error: unknown): error is StructuredError {
  return (
    !!error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = String((error as { name?: unknown }).name || '');
  const message = String((error as { message?: unknown }).message || '').toLowerCase();
  return name === 'AbortError' || message.includes('abort') || message.includes('cancel');
}
