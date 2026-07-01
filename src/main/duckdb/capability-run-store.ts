import type { DuckDBConnection } from '@duckdb/node-api';
import type {
  CapabilityRunAttemptRecord,
  CapabilityRunAttemptStatus,
  CapabilityRunCreateInput,
  CapabilityRunRecord,
  CapabilityRunStatus,
  CapabilityRunStore,
} from '../../types/capability-run';
import type { StructuredError } from '../../types/error-codes';
import { parseRows, quoteIdentifier } from './utils';
import { allPrepared, runPrepared } from './statement-executor';

const RUN_TABLE = 'capability_runs';
const ATTEMPT_TABLE = 'capability_run_attempts';

export class DuckDbCapabilityRunStore implements CapabilityRunStore {
  private initialized = false;

  constructor(private readonly conn: DuckDBConnection) {}

  async initTable(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(RUN_TABLE)} (
        run_id VARCHAR PRIMARY KEY,
        provider_id VARCHAR NOT NULL,
        capability VARCHAR NOT NULL,
        plugin_version VARCHAR,
        capability_version VARCHAR NOT NULL,
        input_hash VARCHAR NOT NULL,
        input_json TEXT,
        confirmation_grant_json TEXT,
        idempotency_key VARCHAR,
        trace_id VARCHAR NOT NULL,
        resource_keys_json TEXT NOT NULL,
        status VARCHAR NOT NULL,
        checkpoint_json TEXT,
        result_json TEXT,
        error_json TEXT,
        created_at VARCHAR NOT NULL,
        updated_at VARCHAR NOT NULL,
        started_at VARCHAR,
        finished_at VARCHAR,
        cancellation_requested_at VARCHAR,
        cancellation_reason VARCHAR,
        manual_review_reason VARCHAR,
        metadata_json TEXT
      )
    `);
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(ATTEMPT_TABLE)} (
        attempt_id VARCHAR PRIMARY KEY,
        run_id VARCHAR NOT NULL,
        kind VARCHAR NOT NULL,
        status VARCHAR NOT NULL,
        started_at VARCHAR NOT NULL,
        finished_at VARCHAR,
        error_json TEXT,
        checkpoint_sequence BIGINT,
        trace_id VARCHAR
      )
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_capability_runs_status_updated
      ON ${quoteIdentifier(RUN_TABLE)} (status, updated_at)
    `);
    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_capability_run_attempts_run
      ON ${quoteIdentifier(ATTEMPT_TABLE)} (run_id, started_at)
    `);
    this.initialized = true;
  }

  async createRun(input: CapabilityRunCreateInput): Promise<CapabilityRunRecord> {
    await this.initTable();
    const now = normalizeIso(input.now) || new Date().toISOString();
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
      resourceKeys: normalizeStringArray(input.resourceKeys),
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

    await runPrepared(
      this.conn,
      `
        INSERT INTO ${quoteIdentifier(RUN_TABLE)} (
          run_id,
          provider_id,
          capability,
          plugin_version,
          capability_version,
          input_hash,
          input_json,
          confirmation_grant_json,
          idempotency_key,
          trace_id,
          resource_keys_json,
          status,
          checkpoint_json,
          result_json,
          error_json,
          created_at,
          updated_at,
          started_at,
          finished_at,
          cancellation_requested_at,
          cancellation_reason,
          manual_review_reason,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      serializeRun(record)
    );
    return record;
  }

  async getRun(runId: string): Promise<CapabilityRunRecord | null> {
    await this.initTable();
    const rows = await this.queryRunRows(
      `
        SELECT *
        FROM ${quoteIdentifier(RUN_TABLE)}
        WHERE run_id = ?
        LIMIT 1
      `,
      [runId]
    );
    return rows[0] ?? null;
  }

  async updateRun(
    runId: string,
    updates: Parameters<CapabilityRunStore['updateRun']>[1]
  ): Promise<CapabilityRunRecord> {
    await this.initTable();
    const existing = await this.getRun(runId);
    if (!existing) {
      throw new Error(`Capability run not found: ${runId}`);
    }
    const next: CapabilityRunRecord = {
      ...existing,
      ...updates,
      resourceKeys: existing.resourceKeys,
      updatedAt: updates.updatedAt || new Date().toISOString(),
    };
    assertRunStatus(next.status);

    await runPrepared(
      this.conn,
      `
        UPDATE ${quoteIdentifier(RUN_TABLE)}
        SET
          status = ?,
          checkpoint_json = ?,
          result_json = ?,
          error_json = ?,
          updated_at = ?,
          started_at = ?,
          finished_at = ?,
          cancellation_requested_at = ?,
          cancellation_reason = ?,
          manual_review_reason = ?,
          metadata_json = ?
        WHERE run_id = ?
      `,
      [
        next.status,
        serializeNullable(next.checkpoint),
        serializeNullable(next.result),
        serializeNullable(next.error),
        next.updatedAt,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        next.cancellationRequestedAt ?? null,
        next.cancellationReason ?? null,
        next.manualReviewReason ?? null,
        serializeNullable(next.metadata),
        runId,
      ]
    );

    return next;
  }

  async appendAttempt(attempt: CapabilityRunAttemptRecord): Promise<void> {
    await this.initTable();
    assertAttemptKind(attempt.kind);
    assertAttemptStatus(attempt.status);
    await runPrepared(
      this.conn,
      `
        INSERT INTO ${quoteIdentifier(ATTEMPT_TABLE)} (
          attempt_id,
          run_id,
          kind,
          status,
          started_at,
          finished_at,
          error_json,
          checkpoint_sequence,
          trace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        attempt.attemptId,
        attempt.runId,
        attempt.kind,
        attempt.status,
        attempt.startedAt,
        attempt.finishedAt ?? null,
        serializeNullable(attempt.error),
        attempt.checkpointSequence ?? null,
        attempt.traceId ?? null,
      ]
    );
  }

  async updateAttempt(
    attemptId: string,
    updates: Parameters<CapabilityRunStore['updateAttempt']>[1]
  ): Promise<void> {
    await this.initTable();
    const existing = await this.getAttempt(attemptId);
    if (!existing) {
      throw new Error(`Capability run attempt not found: ${attemptId}`);
    }
    const next: CapabilityRunAttemptRecord = {
      ...existing,
      ...updates,
    };
    assertAttemptStatus(next.status);
    await runPrepared(
      this.conn,
      `
        UPDATE ${quoteIdentifier(ATTEMPT_TABLE)}
        SET
          status = ?,
          finished_at = ?,
          error_json = ?,
          checkpoint_sequence = ?,
          trace_id = ?
        WHERE attempt_id = ?
      `,
      [
        next.status,
        next.finishedAt ?? null,
        serializeNullable(next.error),
        next.checkpointSequence ?? null,
        next.traceId ?? null,
        attemptId,
      ]
    );
  }

  async listAttempts(runId: string): Promise<CapabilityRunAttemptRecord[]> {
    await this.initTable();
    const reader = await allPrepared(
      this.conn,
      `
        SELECT *
        FROM ${quoteIdentifier(ATTEMPT_TABLE)}
        WHERE run_id = ?
        ORDER BY started_at ASC, attempt_id ASC
      `,
      [runId]
    );
    return parseRows<Record<string, unknown>>(reader).map(rowToAttemptRecord);
  }

  async listRecoverableRuns(options: { limit?: number } = {}): Promise<CapabilityRunRecord[]> {
    await this.initTable();
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(Number(options.limit) || 100)));
    return this.queryRunRows(
      `
        SELECT *
        FROM ${quoteIdentifier(RUN_TABLE)}
        WHERE status IN ('pending', 'running', 'cancel_requested', 'reconciling')
        ORDER BY updated_at ASC
        LIMIT ?
      `,
      [safeLimit]
    );
  }

  private async getAttempt(attemptId: string): Promise<CapabilityRunAttemptRecord | null> {
    const reader = await allPrepared(
      this.conn,
      `
        SELECT *
        FROM ${quoteIdentifier(ATTEMPT_TABLE)}
        WHERE attempt_id = ?
        LIMIT 1
      `,
      [attemptId]
    );
    const rows = parseRows<Record<string, unknown>>(reader);
    return rows.length ? rowToAttemptRecord(rows[0]) : null;
  }

  private async queryRunRows(sql: string, params: unknown[]): Promise<CapabilityRunRecord[]> {
    const reader = await allPrepared(this.conn, sql, params);
    return parseRows<Record<string, unknown>>(reader).map(rowToRunRecord);
  }
}

function serializeRun(record: CapabilityRunRecord): unknown[] {
  return [
    record.runId,
    record.providerId,
    record.capability,
    record.pluginVersion ?? null,
    record.capabilityVersion,
    record.inputHash,
    serializeNullable(record.input),
    serializeNullable(record.confirmationGrant),
    record.idempotencyKey ?? null,
    record.traceId,
    JSON.stringify(record.resourceKeys),
    record.status,
    serializeNullable(record.checkpoint),
    serializeNullable(record.result),
    serializeNullable(record.error),
    record.createdAt,
    record.updatedAt,
    record.startedAt ?? null,
    record.finishedAt ?? null,
    record.cancellationRequestedAt ?? null,
    record.cancellationReason ?? null,
    record.manualReviewReason ?? null,
    serializeNullable(record.metadata),
  ];
}

function rowToRunRecord(row: Record<string, unknown>): CapabilityRunRecord {
  return {
    runId: String(row.run_id || ''),
    providerId: String(row.provider_id || ''),
    capability: String(row.capability || ''),
    pluginVersion: nullableString(row.plugin_version),
    capabilityVersion: String(row.capability_version || ''),
    inputHash: String(row.input_hash || ''),
    input: parseJson<Record<string, unknown>>(row.input_json) || {},
    confirmationGrant: parseJson<unknown>(row.confirmation_grant_json),
    idempotencyKey: nullableString(row.idempotency_key),
    traceId: String(row.trace_id || ''),
    resourceKeys: normalizeStringArray(parseJson<unknown[]>(row.resource_keys_json)),
    status: normalizeRunStatus(row.status),
    checkpoint: parseJson(row.checkpoint_json),
    result: parseJson(row.result_json),
    error: parseJson<StructuredError>(row.error_json),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at),
    cancellationRequestedAt: nullableString(row.cancellation_requested_at),
    cancellationReason: nullableString(row.cancellation_reason),
    manualReviewReason: nullableString(row.manual_review_reason),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
  };
}

function rowToAttemptRecord(row: Record<string, unknown>): CapabilityRunAttemptRecord {
  return {
    attemptId: String(row.attempt_id || ''),
    runId: String(row.run_id || ''),
    kind:
      row.kind === 'resume' || row.kind === 'reconcile' || row.kind === 'cancel'
        ? row.kind
        : 'start',
    status: normalizeAttemptStatus(row.status),
    startedAt: String(row.started_at || ''),
    finishedAt: nullableString(row.finished_at),
    error: parseJson<StructuredError>(row.error_json),
    checkpointSequence:
      row.checkpoint_sequence === null || row.checkpoint_sequence === undefined
        ? null
        : Number(row.checkpoint_sequence),
    traceId: nullableString(row.trace_id),
  };
}

function serializeNullable(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)))
    : [];
}

function normalizeIso(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeRunStatus(value: unknown): CapabilityRunStatus {
  const status = String(value || '');
  return [
    'pending',
    'running',
    'completed',
    'failed',
    'cancel_requested',
    'cancelled',
    'paused_manual_review',
    'paused_version_mismatch',
    'reconciling',
  ].includes(status)
    ? (status as CapabilityRunStatus)
    : 'failed';
}

function normalizeAttemptStatus(value: unknown): CapabilityRunAttemptStatus {
  const status = String(value || '');
  return ['running', 'completed', 'failed', 'cancelled', 'paused'].includes(status)
    ? (status as CapabilityRunAttemptStatus)
    : 'failed';
}

function assertRunStatus(status: unknown): asserts status is CapabilityRunStatus {
  if (
    ![
      'pending',
      'running',
      'completed',
      'failed',
      'cancel_requested',
      'cancelled',
      'paused_manual_review',
      'paused_version_mismatch',
      'reconciling',
    ].includes(String(status || ''))
  ) {
    throw new Error(`Invalid capability run status: ${String(status)}`);
  }
}

function assertAttemptKind(kind: unknown): asserts kind is CapabilityRunAttemptRecord['kind'] {
  if (!['start', 'resume', 'reconcile', 'cancel'].includes(String(kind || ''))) {
    throw new Error(`Invalid capability run attempt kind: ${String(kind)}`);
  }
}

function assertAttemptStatus(status: unknown): asserts status is CapabilityRunAttemptStatus {
  if (!['running', 'completed', 'failed', 'cancelled', 'paused'].includes(String(status || ''))) {
    throw new Error(`Invalid capability run attempt status: ${String(status)}`);
  }
}
