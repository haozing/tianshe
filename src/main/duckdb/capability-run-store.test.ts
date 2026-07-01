import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it } from 'vitest';
import { DuckDbCapabilityRunStore } from './capability-run-store';
import { parseRows } from './utils';

describe('DuckDbCapabilityRunStore', () => {
  let db: DuckDBInstance | null = null;
  let conn: DuckDBConnection | null = null;

  async function openStore(): Promise<DuckDbCapabilityRunStore> {
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);
    const store = new DuckDbCapabilityRunStore(conn);
    await store.initTable();
    return store;
  }

  afterEach(() => {
    conn?.closeSync();
    db?.closeSync();
    conn = null;
    db = null;
  });

  it('persists run metadata, checkpoint, artifact refs and attempt timeline in independent tables', async () => {
    const store = await openStore();
    const run = await store.createRun({
      runId: 'run-duck-1',
      providerId: 'plugin:billing',
      capability: 'billing.exportLedger',
      pluginVersion: '2.1.0',
      capabilityVersion: '2026-06-30',
      inputHash: 'hash-ledger',
      input: { account: 'acct-1' },
      confirmationGrant: { grantId: 'grant-1' },
      idempotencyKey: 'idem-ledger-1',
      traceId: 'trace-ledger-1',
      resourceKeys: ['dataset:ledger'],
      now: '2026-06-30T00:00:00.000Z',
    });
    await store.appendAttempt({
      attemptId: 'attempt-duck-1',
      runId: run.runId,
      kind: 'start',
      status: 'running',
      startedAt: '2026-06-30T00:00:01.000Z',
      traceId: 'trace-ledger-1',
      checkpointSequence: null,
    });
    await store.updateRun(run.runId, {
      status: 'running',
      checkpoint: {
        sequence: 1,
        payload: { exportCursor: 'page-3' },
        artifactRefs: [{ artifactId: 'artifact-ledger-1', role: 'export' }],
        updatedAt: '2026-06-30T00:00:02.000Z',
      },
      updatedAt: '2026-06-30T00:00:02.000Z',
    });
    await store.updateAttempt('attempt-duck-1', {
      status: 'completed',
      finishedAt: '2026-06-30T00:00:03.000Z',
      checkpointSequence: 1,
    });

    await expect(store.getRun(run.runId)).resolves.toMatchObject({
      runId: 'run-duck-1',
      providerId: 'plugin:billing',
      capability: 'billing.exportLedger',
      pluginVersion: '2.1.0',
      input: { account: 'acct-1' },
      confirmationGrant: { grantId: 'grant-1' },
      resourceKeys: ['dataset:ledger'],
      checkpoint: {
        sequence: 1,
        payload: { exportCursor: 'page-3' },
        artifactRefs: [{ artifactId: 'artifact-ledger-1', role: 'export' }],
      },
    });
    await expect(store.listAttempts(run.runId)).resolves.toEqual([
      expect.objectContaining({
        attemptId: 'attempt-duck-1',
        kind: 'start',
        status: 'completed',
        checkpointSequence: 1,
      }),
    ]);

    const tables = parseRows<{ table_name: string }>(
      await conn!.runAndReadAll("SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%task%'")
    );
    expect(tables).toEqual([]);
  });

  it('lists only recoverable pending/running/cancel/reconcile runs deterministically', async () => {
    const store = await openStore();
    await store.createRun({
      runId: 'run-pending',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      capabilityVersion: '2026-06-30',
      inputHash: 'hash-pending',
      traceId: 'trace-pending',
      now: '2026-06-30T00:00:00.500Z',
    });
    await store.createRun({
      runId: 'run-running',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      capabilityVersion: '2026-06-30',
      inputHash: 'hash-running',
      traceId: 'trace-running',
      now: '2026-06-30T00:00:00.000Z',
    });
    await store.createRun({
      runId: 'run-completed',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      capabilityVersion: '2026-06-30',
      inputHash: 'hash-completed',
      traceId: 'trace-completed',
      now: '2026-06-30T00:00:01.000Z',
    });
    await store.createRun({
      runId: 'run-cancel',
      providerId: 'plugin:billing',
      capability: 'billing.exportLedger',
      capabilityVersion: '2026-06-30',
      inputHash: 'hash-cancel',
      traceId: 'trace-cancel',
      now: '2026-06-30T00:00:02.000Z',
    });
    await store.updateRun('run-running', {
      status: 'running',
      updatedAt: '2026-06-30T00:02:00.000Z',
    });
    await store.updateRun('run-completed', {
      status: 'completed',
      updatedAt: '2026-06-30T00:01:00.000Z',
    });
    await store.updateRun('run-cancel', {
      status: 'cancel_requested',
      updatedAt: '2026-06-30T00:03:00.000Z',
    });

    await expect(store.listRecoverableRuns()).resolves.toEqual([
      expect.objectContaining({ runId: 'run-pending', status: 'pending' }),
      expect.objectContaining({ runId: 'run-running', status: 'running' }),
      expect.objectContaining({ runId: 'run-cancel', status: 'cancel_requested' }),
    ]);
  });

  it('rejects invalid run and attempt status values before persisting them', async () => {
    const store = await openStore();
    const run = await store.createRun({
      runId: 'run-invalid-status',
      providerId: 'plugin:inventory',
      capability: 'inventory.syncSnapshot',
      capabilityVersion: '2026-06-30',
      inputHash: 'hash-invalid-status',
      traceId: 'trace-invalid-status',
      now: '2026-06-30T00:00:00.000Z',
    });

    await expect(
      store.updateRun(run.runId, {
        status: 'definitely_not_a_status',
      } as any)
    ).rejects.toThrow(/Invalid capability run status/);

    await expect(
      store.appendAttempt({
        attemptId: 'attempt-invalid-kind',
        runId: run.runId,
        kind: 'not_a_kind',
        status: 'running',
        startedAt: '2026-06-30T00:00:01.000Z',
      } as any)
    ).rejects.toThrow(/Invalid capability run attempt kind/);

    await store.appendAttempt({
      attemptId: 'attempt-invalid-status',
      runId: run.runId,
      kind: 'start',
      status: 'running',
      startedAt: '2026-06-30T00:00:01.000Z',
    });
    await expect(
      store.updateAttempt('attempt-invalid-status', {
        status: 'not_a_status',
      } as any)
    ).rejects.toThrow(/Invalid capability run attempt status/);
  });
});
