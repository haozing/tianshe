import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilityRunAttemptRecord,
  CapabilityRunCreateInput,
  CapabilityRunRecord,
  CapabilityRunStore,
} from '../../../types/capability-run';
import {
  CapabilityRunManager,
  hashCapabilityRunInput,
  type DurableCapabilityDefinition,
  type DurableCapabilityHandler,
} from './durable-capability-run';

class MemoryCapabilityRunStore implements CapabilityRunStore {
  readonly runs = new Map<string, CapabilityRunRecord>();
  readonly attempts = new Map<string, CapabilityRunAttemptRecord>();

  async createRun(input: CapabilityRunCreateInput): Promise<CapabilityRunRecord> {
    const now = input.now || '2026-06-30T00:00:00.000Z';
    const record: CapabilityRunRecord = {
      runId: input.runId,
      providerId: input.providerId,
      capability: input.capability,
      pluginVersion: input.pluginVersion ?? null,
      capabilityVersion: input.capabilityVersion,
      inputHash: input.inputHash,
      input: input.input || {},
      confirmationGrant: input.confirmationGrant ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      traceId: input.traceId,
      resourceKeys: input.resourceKeys || [],
      status: 'pending',
      checkpoint: null,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      cancellationRequestedAt: null,
      cancellationReason: null,
      manualReviewReason: null,
      metadata: null,
    };
    this.runs.set(record.runId, record);
    return clone(record);
  }

  async getRun(runId: string): Promise<CapabilityRunRecord | null> {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  async updateRun(
    runId: string,
    updates: Parameters<CapabilityRunStore['updateRun']>[1]
  ): Promise<CapabilityRunRecord> {
    const current = this.runs.get(runId);
    if (!current) {
      throw new Error(`missing run ${runId}`);
    }
    const next = {
      ...current,
      ...updates,
      resourceKeys: current.resourceKeys,
      updatedAt: updates.updatedAt || current.updatedAt,
    };
    this.runs.set(runId, next);
    return clone(next);
  }

  async appendAttempt(attempt: CapabilityRunAttemptRecord): Promise<void> {
    this.attempts.set(attempt.attemptId, clone(attempt));
  }

  async updateAttempt(
    attemptId: string,
    updates: Parameters<CapabilityRunStore['updateAttempt']>[1]
  ): Promise<void> {
    const current = this.attempts.get(attemptId);
    if (!current) {
      throw new Error(`missing attempt ${attemptId}`);
    }
    this.attempts.set(attemptId, { ...current, ...updates });
  }

  async listAttempts(runId: string): Promise<CapabilityRunAttemptRecord[]> {
    return Array.from(this.attempts.values())
      .filter((attempt) => attempt.runId === runId)
      .map((attempt) => clone(attempt));
  }

  async listRecoverableRuns(): Promise<CapabilityRunRecord[]> {
    return Array.from(this.runs.values())
      .filter((run) => ['pending', 'running', 'cancel_requested', 'reconciling'].includes(run.status))
      .map((run) => clone(run));
  }
}

function createManager(store = new MemoryCapabilityRunStore()) {
  let tick = 0;
  const resourceRunner = vi.fn(async (_keys, _options, fn) => fn());
  const manager = new CapabilityRunManager({
    store,
    now: () => `2026-06-30T00:00:${String(tick++).padStart(2, '0')}.000Z`,
    runIdGenerator: () => `run-${tick}`,
    attemptIdGenerator: () => `attempt-${tick}`,
    resourceRunner,
  });
  return { manager, store, resourceRunner };
}

function success(summary = 'done') {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: { ok: true, summary },
  };
}

function inventoryDefinition(overrides: Partial<DurableCapabilityDefinition> = {}) {
  return {
    providerId: 'plugin:inventory',
    capability: 'inventory.syncSnapshot',
    pluginVersion: '1.0.0',
    capabilityVersion: '2026-06-30',
    sideEffectLevel: 'high' as const,
    resourceKeys: ['profile:shop-alpha'],
    ...overrides,
  };
}

function ledgerDefinition() {
  return {
    providerId: 'plugin:billing',
    capability: 'billing.exportLedger',
    pluginVersion: '2.1.0',
    capabilityVersion: '2026-06-30',
    sideEffectLevel: 'low' as const,
    resourceKeys: ['dataset:ledger'],
  };
}

describe('CapabilityRunManager', () => {
  it('starts an opt-in durable run with fixed metadata, resource keys, checkpoint and artifact refs', async () => {
    const { manager, store, resourceRunner } = createManager();
    const handler: DurableCapabilityHandler = {
      start: async (context) => {
        await context.checkpoint({
          payload: { cursor: 'page-2' },
          artifactRefs: [{ artifactId: 'artifact-download-1', role: 'download' }],
        });
        return {
          result: success('inventory synced'),
          artifactRefs: [{ artifactId: 'artifact-summary-1', role: 'summary' }],
        };
      },
    };

    const run = await manager.start(inventoryDefinition(), handler, {
      runId: 'run-inventory-1',
      traceId: 'trace-inventory-1',
      idempotencyKey: 'idem-inventory-1',
      input: { shop: 'alpha', since: '2026-06-01' },
    });

    expect(run).toMatchObject({
      runId: 'run-inventory-1',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      pluginVersion: '1.0.0',
      capabilityVersion: '2026-06-30',
      inputHash: hashCapabilityRunInput({ shop: 'alpha', since: '2026-06-01' }),
      idempotencyKey: 'idem-inventory-1',
      traceId: 'trace-inventory-1',
      resourceKeys: ['profile:shop-alpha'],
      status: 'completed',
    });
    expect(run.checkpoint).toMatchObject({
      sequence: 2,
      artifactRefs: [{ artifactId: 'artifact-summary-1', role: 'summary' }],
    });
    expect(resourceRunner).toHaveBeenCalledWith(
      ['profile:shop-alpha'],
      expect.objectContaining({
        ownerToken: 'run-inventory-1',
        ownerSource: 'plugin',
        ownerMetadata: expect.objectContaining({
          controllerKind: 'plugin',
          capability: 'inventory.syncSnapshot',
          traceId: 'trace-inventory-1',
          interruptibility: 'checkpoint',
        }),
      }),
      expect.any(Function)
    );
    await expect(store.listAttempts('run-inventory-1')).resolves.toEqual([
      expect.objectContaining({ kind: 'start', status: 'completed', checkpointSequence: 2 }),
    ]);
  });

  it('resumes after restart by handler contract and keeps procedure resume refs opaque', async () => {
    const sharedStore = new MemoryCapabilityRunStore();
    const first = createManager(sharedStore);
    const startHandler: DurableCapabilityHandler = {
      start: async (context) => {
        await context.checkpoint({
          payload: { adapter: 'github-profile', step: 'await-login' },
          procedureResumeRef: 'site-procedure-resume:github:abc123',
        });
        throw new Error('process exited');
      },
    };
    await first.manager.start(inventoryDefinition(), startHandler, {
      runId: 'run-resume-1',
      traceId: 'trace-resume-1',
      input: { profileId: 'profile-github' },
    });
    await sharedStore.updateRun('run-resume-1', {
      status: 'running',
      finishedAt: null,
      error: null,
      result: null,
      updatedAt: '2026-06-30T00:02:00.000Z',
    });

    const second = createManager(sharedStore);
    const resumeHandler: DurableCapabilityHandler = {
      start: vi.fn(),
      resume: async (checkpoint, context) => {
        expect(checkpoint).toEqual({ adapter: 'github-profile', step: 'await-login' });
        expect(context.mode).toBe('resume');
        return { result: success('resumed') };
      },
    };

    const recovered = await second.manager.recover('run-resume-1', {
      definition: inventoryDefinition(),
      handler: resumeHandler,
    });

    expect(recovered.status).toBe('completed');
    expect(recovered.checkpoint).toMatchObject({
      procedureResumeRef: 'site-procedure-resume:github:abc123',
    });
    await expect(sharedStore.listAttempts('run-resume-1')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'start', status: 'failed' }),
        expect.objectContaining({ kind: 'resume', status: 'completed' }),
      ])
    );
  });

  it('enters deterministic pause states for missing handlers, missing resume contract and version mismatch', async () => {
    const { manager, store } = createManager();
    const handler: DurableCapabilityHandler = {
      start: async (context) => {
        await context.checkpoint({ payload: { cursor: 'after-side-effect' } });
        throw new Error('crash after side effect');
      },
    };
    await manager.start(inventoryDefinition(), handler, {
      runId: 'run-pause-1',
      traceId: 'trace-pause-1',
    });
    await store.updateRun('run-pause-1', {
      status: 'running',
      finishedAt: null,
      error: null,
      result: null,
      updatedAt: '2026-06-30T00:10:00.000Z',
    });

    await expect(manager.recover('run-pause-1', {})).resolves.toMatchObject({
      status: 'paused_manual_review',
      manualReviewReason: 'capability_run_handler_missing',
    });
    await store.updateRun('run-pause-1', { status: 'running', manualReviewReason: null });

    await expect(
      manager.recover('run-pause-1', {
        definition: inventoryDefinition(),
        handler: { start: vi.fn() },
      })
    ).resolves.toMatchObject({
      status: 'paused_manual_review',
      manualReviewReason: 'capability_run_resume_contract_missing',
    });
    await store.updateRun('run-pause-1', { status: 'running', manualReviewReason: null });

    await expect(
      manager.recover('run-pause-1', {
        definition: inventoryDefinition({ capabilityVersion: '2026-07-01' }),
        handler: {
          start: vi.fn(),
          resume: vi.fn(),
        },
      })
    ).resolves.toMatchObject({
      status: 'paused_version_mismatch',
      manualReviewReason: 'capability_run_version_mismatch',
    });
  });

  it('recovers pending runs by executing start after create-before-execute crashes', async () => {
    const { manager, store } = createManager();
    await store.createRun({
      runId: 'run-pending-recover-1',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      pluginVersion: '1.0.0',
      capabilityVersion: '2026-06-30',
      inputHash: hashCapabilityRunInput({ shop: 'alpha' }),
      input: { shop: 'alpha' },
      traceId: 'trace-pending-recover-1',
      resourceKeys: ['profile:shop-alpha'],
      now: '2026-06-30T00:11:00.000Z',
    });

    const handler: DurableCapabilityHandler = {
      start: async (context) => {
        expect(context.mode).toBe('start');
        expect(context.input).toEqual({ shop: 'alpha' });
        await context.checkpoint({ payload: { restartedFrom: 'pending' } });
        return { result: success('pending recovered') };
      },
      resume: vi.fn(),
    };

    const recovered = await manager.recover('run-pending-recover-1', {
      definition: inventoryDefinition(),
      handler,
    });

    expect(recovered).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({
        structuredContent: { ok: true, summary: 'pending recovered' },
      }),
    });
    expect(recovered.checkpoint?.payload).toEqual({ restartedFrom: 'pending' });
    expect(handler.resume).not.toHaveBeenCalled();
    await expect(store.listAttempts('run-pending-recover-1')).resolves.toEqual([
      expect.objectContaining({ kind: 'start', status: 'completed' }),
    ]);
  });

  it('rejects public recover calls for terminal runs without mutating them', async () => {
    const { manager, store } = createManager();
    await store.createRun({
      runId: 'run-terminal-recover-1',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      pluginVersion: '1.0.0',
      capabilityVersion: '2026-06-30',
      inputHash: hashCapabilityRunInput({ shop: 'alpha' }),
      input: { shop: 'alpha' },
      traceId: 'trace-terminal-recover-1',
      resourceKeys: ['profile:shop-alpha'],
      now: '2026-06-30T00:12:00.000Z',
    });
    await store.updateRun('run-terminal-recover-1', {
      status: 'completed',
      result: success('already done'),
      finishedAt: '2026-06-30T00:13:00.000Z',
      updatedAt: '2026-06-30T00:13:00.000Z',
    });

    await expect(
      manager.recover('run-terminal-recover-1', {
        definition: inventoryDefinition(),
        handler: { start: vi.fn(), resume: vi.fn() },
      })
    ).rejects.toMatchObject({
      reasonCode: 'capability_run_terminal_not_recoverable',
      context: expect.objectContaining({
        runId: 'run-terminal-recover-1',
        status: 'completed',
      }),
    });
    await expect(store.getRun('run-terminal-recover-1')).resolves.toMatchObject({
      status: 'completed',
      manualReviewReason: null,
    });
    await expect(store.listAttempts('run-terminal-recover-1')).resolves.toEqual([]);
  });

  it('rejects duplicate in-process execution claims for the same run id', async () => {
    const { manager } = createManager();
    let release!: () => void;
    const handler: DurableCapabilityHandler = {
      start: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { result: success('released') };
      },
    };

    const running = manager.start(inventoryDefinition(), handler, {
      runId: 'run-duplicate-claim-1',
      traceId: 'trace-duplicate-claim-1',
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    await expect(
      manager.recover('run-duplicate-claim-1', {
        definition: inventoryDefinition(),
        handler,
      })
    ).rejects.toMatchObject({
      reasonCode: 'capability_run_already_executing',
      context: expect.objectContaining({
        runId: 'run-duplicate-claim-1',
      }),
    });

    release();
    await expect(running).resolves.toMatchObject({ status: 'completed' });
  });

  it('cancels cooperatively through AbortSignal without claiming side effects never happened', async () => {
    const { manager } = createManager();
    let seenSignal: AbortSignal | null = null;
    let release!: () => void;
    const handler: DurableCapabilityHandler = {
      start: async (context) => {
        seenSignal = context.signal;
        await context.checkpoint({ payload: { sideEffectStarted: true } });
        await new Promise<void>((resolve) => {
          release = resolve;
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (context.signal.aborted) {
          throw new DOMException('Capability run aborted after side effect checkpoint', 'AbortError');
        }
        return { result: success('not cancelled') };
      },
    };

    const running = manager.start(inventoryDefinition(), handler, {
      runId: 'run-cancel-1',
      traceId: 'trace-cancel-1',
    });
    await vi.waitFor(() => expect(seenSignal).not.toBeNull());
    const requested = await manager.requestCancel('run-cancel-1', {
      reason: 'user_requested',
    });
    release();
    const finished = await running;

    expect(requested).toMatchObject({
      status: 'cancel_requested',
      cancellationReason: 'user_requested',
    });
    expect(seenSignal?.aborted).toBe(true);
    expect(finished.status).toBe('cancelled');
    expect(finished.checkpoint?.payload).toEqual({ sideEffectStarted: true });
  });

  it('finalizes an idle run after cancel handler cleanup and exposes cancel mode', async () => {
    const { manager, store } = createManager();
    await store.createRun({
      runId: 'run-idle-cancel-1',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      pluginVersion: '1.0.0',
      capabilityVersion: '2026-06-30',
      inputHash: hashCapabilityRunInput({ shop: 'alpha' }),
      input: { shop: 'alpha' },
      traceId: 'trace-idle-cancel-1',
      resourceKeys: ['profile:shop-alpha'],
      now: '2026-06-30T00:20:00.000Z',
    });

    const handler: DurableCapabilityHandler = {
      start: vi.fn(),
      cancel: async (checkpoint, context) => {
        expect(checkpoint).toBeUndefined();
        expect(context.mode).toBe('cancel');
        expect(context.signal.aborted).toBe(false);
        await context.checkpoint({ payload: { cleanup: 'done' } });
      },
    };

    const cancelled = await manager.requestCancel('run-idle-cancel-1', {
      reason: 'user_requested',
      handler,
    });

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'user_requested',
    });
    expect(cancelled.checkpoint?.payload).toEqual({ cleanup: 'done' });
    await expect(store.listAttempts('run-idle-cancel-1')).resolves.toEqual([
      expect.objectContaining({ kind: 'cancel', status: 'completed', checkpointSequence: 1 }),
    ]);
    await expect(store.listRecoverableRuns()).resolves.toEqual([]);
  });

  it('pauses an idle run for manual review when cancel handler fails', async () => {
    const { manager, store } = createManager();
    await store.createRun({
      runId: 'run-idle-cancel-fail-1',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      pluginVersion: '1.0.0',
      capabilityVersion: '2026-06-30',
      inputHash: hashCapabilityRunInput({ shop: 'alpha' }),
      input: { shop: 'alpha' },
      traceId: 'trace-idle-cancel-fail-1',
      resourceKeys: ['profile:shop-alpha'],
      now: '2026-06-30T00:21:00.000Z',
    });

    const cancelled = await manager.requestCancel('run-idle-cancel-fail-1', {
      reason: 'cleanup_failed',
      handler: {
        start: vi.fn(),
        cancel: async (_checkpoint, context) => {
          expect(context.mode).toBe('cancel');
          throw new Error('cleanup crashed');
        },
      },
    });

    expect(cancelled).toMatchObject({
      status: 'paused_manual_review',
      manualReviewReason: 'capability_run_cancel_handler_failed',
    });
    expect(cancelled.error).toMatchObject({
      context: expect.objectContaining({
        runId: 'run-idle-cancel-fail-1',
      }),
    });
    await expect(store.listAttempts('run-idle-cancel-fail-1')).resolves.toEqual([
      expect.objectContaining({ kind: 'cancel', status: 'failed' }),
    ]);
    await expect(store.listRecoverableRuns()).resolves.toEqual([]);
  });

  it('recovers cancel_requested runs by canceling instead of resuming', async () => {
    const { manager, store } = createManager();
    await store.createRun({
      runId: 'run-cancel-recover-1',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      pluginVersion: '1.0.0',
      capabilityVersion: '2026-06-30',
      inputHash: hashCapabilityRunInput({ shop: 'alpha' }),
      input: { shop: 'alpha' },
      traceId: 'trace-cancel-recover-1',
      resourceKeys: ['profile:shop-alpha'],
      now: '2026-06-30T00:22:00.000Z',
    });
    await store.updateRun('run-cancel-recover-1', {
      status: 'cancel_requested',
      cancellationRequestedAt: '2026-06-30T00:23:00.000Z',
      cancellationReason: 'user_requested',
      checkpoint: {
        sequence: 1,
        payload: { sideEffectStarted: true },
        updatedAt: '2026-06-30T00:22:30.000Z',
      },
    });

    const handler: DurableCapabilityHandler = {
      start: vi.fn(),
      resume: vi.fn(),
      reconcile: vi.fn(),
      cancel: async (checkpoint, context) => {
        expect(checkpoint).toEqual({ sideEffectStarted: true });
        expect(context.mode).toBe('cancel');
        await context.checkpoint({ payload: { cleanup: 'done' } });
      },
    };

    const recovered = await manager.recover('run-cancel-recover-1', {
      definition: inventoryDefinition(),
      handler,
    });

    expect(recovered).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'user_requested',
    });
    expect(recovered.checkpoint?.payload).toEqual({ cleanup: 'done' });
    expect(handler.resume).not.toHaveBeenCalled();
    expect(handler.reconcile).not.toHaveBeenCalled();
    await expect(store.listAttempts('run-cancel-recover-1')).resolves.toEqual([
      expect.objectContaining({ kind: 'cancel', status: 'completed', checkpointSequence: 2 }),
    ]);
  });

  it('pauses cancel_requested recovery when no cancel handler exists', async () => {
    const { manager, store } = createManager();
    await store.createRun({
      runId: 'run-cancel-recover-no-handler-1',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      pluginVersion: '1.0.0',
      capabilityVersion: '2026-06-30',
      inputHash: hashCapabilityRunInput({ shop: 'alpha' }),
      input: { shop: 'alpha' },
      traceId: 'trace-cancel-recover-no-handler-1',
      resourceKeys: ['profile:shop-alpha'],
      now: '2026-06-30T00:24:00.000Z',
    });
    await store.updateRun('run-cancel-recover-no-handler-1', {
      status: 'cancel_requested',
      cancellationRequestedAt: '2026-06-30T00:25:00.000Z',
      cancellationReason: 'user_requested',
    });
    const handler: DurableCapabilityHandler = {
      start: vi.fn(),
      resume: vi.fn(),
      reconcile: vi.fn(),
    };

    await expect(
      manager.recover('run-cancel-recover-no-handler-1', {
        definition: inventoryDefinition(),
        handler,
      })
    ).resolves.toMatchObject({
      status: 'paused_manual_review',
      manualReviewReason: 'capability_run_cancel_handler_missing',
    });
    expect(handler.resume).not.toHaveBeenCalled();
    expect(handler.reconcile).not.toHaveBeenCalled();
    await expect(store.listAttempts('run-cancel-recover-no-handler-1')).resolves.toEqual([
      expect.objectContaining({ kind: 'reconcile', status: 'paused' }),
    ]);
  });

  it('pauses cancel_requested recovery when cancel cleanup fails', async () => {
    const { manager, store } = createManager();
    await store.createRun({
      runId: 'run-cancel-recover-fail-1',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      pluginVersion: '1.0.0',
      capabilityVersion: '2026-06-30',
      inputHash: hashCapabilityRunInput({ shop: 'alpha' }),
      input: { shop: 'alpha' },
      traceId: 'trace-cancel-recover-fail-1',
      resourceKeys: ['profile:shop-alpha'],
      now: '2026-06-30T00:26:00.000Z',
    });
    await store.updateRun('run-cancel-recover-fail-1', {
      status: 'cancel_requested',
      cancellationRequestedAt: '2026-06-30T00:27:00.000Z',
      cancellationReason: 'user_requested',
    });

    await expect(
      manager.recover('run-cancel-recover-fail-1', {
        definition: inventoryDefinition(),
        handler: {
          start: vi.fn(),
          resume: vi.fn(),
          cancel: async (_checkpoint, context) => {
            expect(context.mode).toBe('cancel');
            throw new Error('cleanup crashed');
          },
        },
      })
    ).resolves.toMatchObject({
      status: 'paused_manual_review',
      manualReviewReason: 'capability_run_cancel_handler_failed',
      error: expect.objectContaining({
        context: expect.objectContaining({ runId: 'run-cancel-recover-fail-1' }),
      }),
    });
    await expect(store.listAttempts('run-cancel-recover-fail-1')).resolves.toEqual([
      expect.objectContaining({ kind: 'cancel', status: 'failed' }),
    ]);
  });

  it('uses the same run/checkpoint contract for unrelated long capabilities without shared item schema', async () => {
    const { manager, store } = createManager();
    const inventoryHandler: DurableCapabilityHandler = {
      start: async (context) => {
        await context.checkpoint({ payload: { cursor: 'sku-page-4', changedSkuCount: 12 } });
        return { result: success('inventory') };
      },
    };
    const ledgerHandler: DurableCapabilityHandler = {
      start: async (context) => {
        await context.checkpoint({
          payload: { exportWindow: { from: '2026-06-01', to: '2026-06-30' }, fileArtifact: 'artifact-ledger' },
          artifactRefs: [{ artifactId: 'artifact-ledger', role: 'export' }],
        });
        return { result: success('ledger') };
      },
    };

    const inventory = await manager.start(inventoryDefinition(), inventoryHandler, {
      runId: 'run-industry-inventory',
      traceId: 'trace-industry-inventory',
    });
    const ledger = await manager.start(ledgerDefinition(), ledgerHandler, {
      runId: 'run-industry-ledger',
      traceId: 'trace-industry-ledger',
    });

    expect(inventory.checkpoint?.payload).toEqual({ cursor: 'sku-page-4', changedSkuCount: 12 });
    expect(ledger.checkpoint?.payload).toEqual({
      exportWindow: { from: '2026-06-01', to: '2026-06-30' },
      fileArtifact: 'artifact-ledger',
    });
    expect(Array.from(store.runs.values()).every((run) => !('partition' in run))).toBe(true);
    expect(Array.from(store.runs.values()).every((run) => !('item' in run))).toBe(true);
  });
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
