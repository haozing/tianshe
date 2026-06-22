import { randomUUID } from 'node:crypto';
import type { DuckDBConnection } from '@duckdb/node-api';
import { allPrepared, runPrepared } from './statement-executor';
import { parseRows, quoteQualifiedName } from './utils';

export type DatasetMutationOperation = 'insert' | 'update' | 'delete' | 'staged_write';
export type DatasetRunLedgerStatus = 'planned' | 'running' | 'completed' | 'failed' | 'aborted';

export interface DatasetProvenanceContext {
  traceId?: string | null;
  adapterId?: string | null;
  adapterVersion?: string | null;
  runtimeId?: string | null;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface DatasetRunLedgerEntry extends DatasetProvenanceContext {
  runId: string;
  datasetId: string;
  operation: DatasetMutationOperation;
  status: DatasetRunLedgerStatus;
  rowCount: number;
  startedAt: number;
  finishedAt?: number | null;
  error?: string | null;
}

export interface DatasetRecordProvenanceEntry extends DatasetProvenanceContext {
  id: string;
  datasetId: string;
  rowId: number | null;
  runId: string;
  operation: DatasetMutationOperation;
  occurredAt: number;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export interface RecordDatasetRunParams extends DatasetProvenanceContext {
  runId?: string;
  datasetId: string;
  operation: DatasetMutationOperation;
  status: DatasetRunLedgerStatus;
  rowCount?: number;
  startedAt?: number;
  finishedAt?: number | null;
  error?: string | null;
}

export interface RecordDatasetProvenanceParams extends DatasetProvenanceContext {
  id?: string;
  datasetId: string;
  rowId?: number | null;
  runId: string;
  operation: DatasetMutationOperation;
  occurredAt?: number;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export interface DatasetProvenanceWriteTarget {
  datasetSidecar?: string;
}

const CENTRAL_RUN_LEDGER_TABLE = 'dataset_run_ledger';
const CENTRAL_RECORD_PROVENANCE_TABLE = 'dataset_record_provenance';
const SIDECAR_RUN_LEDGER_TABLE = '__dataset_run_ledger';
const SIDECAR_RECORD_PROVENANCE_TABLE = '__dataset_record_provenance';

function toJson(value: Record<string, unknown> | null | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeRowId(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export class DatasetProvenanceService {
  constructor(private conn: DuckDBConnection) {}

  private getRunLedgerTable(target?: DatasetProvenanceWriteTarget): string {
    return target?.datasetSidecar
      ? quoteQualifiedName(`ds_${target.datasetSidecar}`, SIDECAR_RUN_LEDGER_TABLE)
      : CENTRAL_RUN_LEDGER_TABLE;
  }

  private getRecordProvenanceTable(target?: DatasetProvenanceWriteTarget): string {
    return target?.datasetSidecar
      ? quoteQualifiedName(`ds_${target.datasetSidecar}`, SIDECAR_RECORD_PROVENANCE_TABLE)
      : CENTRAL_RECORD_PROVENANCE_TABLE;
  }

  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS dataset_run_ledger (
        run_id VARCHAR PRIMARY KEY,
        dataset_id VARCHAR NOT NULL,
        operation VARCHAR NOT NULL,
        status VARCHAR NOT NULL,
        trace_id VARCHAR,
        adapter_id VARCHAR,
        adapter_version VARCHAR,
        runtime_id VARCHAR,
        source_url VARCHAR,
        row_count BIGINT DEFAULT 0,
        started_at BIGINT NOT NULL,
        finished_at BIGINT,
        error VARCHAR,
        metadata JSON
      )
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_dataset_run_ledger_dataset
      ON dataset_run_ledger(dataset_id, started_at)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_dataset_run_ledger_trace
      ON dataset_run_ledger(trace_id)
    `);

    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS dataset_record_provenance (
        id VARCHAR PRIMARY KEY,
        dataset_id VARCHAR NOT NULL,
        row_id BIGINT,
        run_id VARCHAR NOT NULL,
        operation VARCHAR NOT NULL,
        trace_id VARCHAR,
        adapter_id VARCHAR,
        adapter_version VARCHAR,
        runtime_id VARCHAR,
        source_url VARCHAR,
        occurred_at BIGINT NOT NULL,
        before JSON,
        after JSON,
        metadata JSON
      )
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_dataset_record_provenance_row
      ON dataset_record_provenance(dataset_id, row_id, occurred_at)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_dataset_record_provenance_run
      ON dataset_record_provenance(run_id)
    `);
  }

  async ensureDatasetSidecarTables(datasetId: string): Promise<void> {
    const runLedgerTable = this.getRunLedgerTable({ datasetSidecar: datasetId });
    const recordProvenanceTable = this.getRecordProvenanceTable({ datasetSidecar: datasetId });

    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS ${runLedgerTable} (
        run_id VARCHAR PRIMARY KEY,
        dataset_id VARCHAR NOT NULL,
        operation VARCHAR NOT NULL,
        status VARCHAR NOT NULL,
        trace_id VARCHAR,
        adapter_id VARCHAR,
        adapter_version VARCHAR,
        runtime_id VARCHAR,
        source_url VARCHAR,
        row_count BIGINT DEFAULT 0,
        started_at BIGINT NOT NULL,
        finished_at BIGINT,
        error VARCHAR,
        metadata JSON
      )
    `);

    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS ${recordProvenanceTable} (
        id VARCHAR PRIMARY KEY,
        dataset_id VARCHAR NOT NULL,
        row_id BIGINT,
        run_id VARCHAR NOT NULL,
        operation VARCHAR NOT NULL,
        trace_id VARCHAR,
        adapter_id VARCHAR,
        adapter_version VARCHAR,
        runtime_id VARCHAR,
        source_url VARCHAR,
        occurred_at BIGINT NOT NULL,
        before JSON,
        after JSON,
        metadata JSON
      )
    `);
  }

  async recordRun(
    params: RecordDatasetRunParams,
    target?: DatasetProvenanceWriteTarget
  ): Promise<DatasetRunLedgerEntry> {
    const entry: DatasetRunLedgerEntry = {
      runId: params.runId || randomUUID(),
      datasetId: params.datasetId,
      operation: params.operation,
      status: params.status,
      rowCount: Math.max(0, Math.trunc(Number(params.rowCount ?? 0))),
      startedAt: params.startedAt ?? Date.now(),
      finishedAt: params.finishedAt ?? null,
      traceId: params.traceId ?? null,
      adapterId: params.adapterId ?? null,
      adapterVersion: params.adapterVersion ?? null,
      runtimeId: params.runtimeId ?? null,
      sourceUrl: params.sourceUrl ?? null,
      metadata: params.metadata ?? null,
      error: params.error ?? null,
    };

    await runPrepared(
      this.conn,
      `
      INSERT OR REPLACE INTO ${this.getRunLedgerTable(target)} (
        run_id, dataset_id, operation, status, trace_id, adapter_id, adapter_version,
        runtime_id, source_url, row_count, started_at, finished_at, error, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        entry.runId,
        entry.datasetId,
        entry.operation,
        entry.status,
        entry.traceId ?? null,
        entry.adapterId ?? null,
        entry.adapterVersion ?? null,
        entry.runtimeId ?? null,
        entry.sourceUrl ?? null,
        entry.rowCount,
        entry.startedAt,
        entry.finishedAt ?? null,
        entry.error ?? null,
        toJson(entry.metadata ?? null),
      ]
    );

    return entry;
  }

  async recordRows(
    params: RecordDatasetProvenanceParams[],
    target?: DatasetProvenanceWriteTarget
  ): Promise<DatasetRecordProvenanceEntry[]> {
    const entries = params.map((param) => ({
      id: param.id || randomUUID(),
      datasetId: param.datasetId,
      rowId: param.rowId ?? null,
      runId: param.runId,
      operation: param.operation,
      occurredAt: param.occurredAt ?? Date.now(),
      traceId: param.traceId ?? null,
      adapterId: param.adapterId ?? null,
      adapterVersion: param.adapterVersion ?? null,
      runtimeId: param.runtimeId ?? null,
      sourceUrl: param.sourceUrl ?? null,
      metadata: param.metadata ?? null,
      before: param.before ?? null,
      after: param.after ?? null,
    }));

    for (const entry of entries) {
      await runPrepared(
        this.conn,
        `
        INSERT INTO ${this.getRecordProvenanceTable(target)} (
          id, dataset_id, row_id, run_id, operation, trace_id, adapter_id, adapter_version,
          runtime_id, source_url, occurred_at, before, after, metadata
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          entry.id,
          entry.datasetId,
          entry.rowId,
          entry.runId,
          entry.operation,
          entry.traceId ?? null,
          entry.adapterId ?? null,
          entry.adapterVersion ?? null,
          entry.runtimeId ?? null,
          entry.sourceUrl ?? null,
          entry.occurredAt,
          toJson(entry.before ?? null),
          toJson(entry.after ?? null),
          toJson(entry.metadata ?? null),
        ]
      );
    }

    return entries;
  }

  async listRecordProvenance(
    datasetId: string,
    rowId: number,
    limit = 50
  ): Promise<DatasetRecordProvenanceEntry[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 50)));
    const rows: any[] = [];
    for (const table of [
      this.getRecordProvenanceTable({ datasetSidecar: datasetId }),
      this.getRecordProvenanceTable(),
    ]) {
      try {
        const result = await allPrepared(
          this.conn,
          `
          SELECT *
          FROM ${table}
          WHERE dataset_id = ? AND row_id = ?
          ORDER BY occurred_at DESC
          LIMIT ${safeLimit}
        `,
          [datasetId, rowId]
        );
        rows.push(...parseRows(result));
      } catch {
        // Sidecar table may not exist for legacy datasets.
      }
    }

    return rows
      .sort((left, right) => Number(right.occurred_at ?? 0) - Number(left.occurred_at ?? 0))
      .slice(0, safeLimit)
      .map((row) => ({
      id: String(row.id),
      datasetId: String(row.dataset_id),
      rowId: normalizeRowId(row.row_id),
      runId: String(row.run_id),
      operation: String(row.operation) as DatasetMutationOperation,
      occurredAt: Number(row.occurred_at),
      traceId: optionalString(row.trace_id),
      adapterId: optionalString(row.adapter_id),
      adapterVersion: optionalString(row.adapter_version),
      runtimeId: optionalString(row.runtime_id),
      sourceUrl: optionalString(row.source_url),
      before: parseJson(row.before),
      after: parseJson(row.after),
      metadata: parseJson(row.metadata),
    }));
  }

  async getRun(runId: string): Promise<DatasetRunLedgerEntry | null> {
    const result = await allPrepared(
      this.conn,
      'SELECT * FROM dataset_run_ledger WHERE run_id = ? LIMIT 1',
      [runId]
    );
    const row = parseRows(result)[0];
    if (!row) {
      return null;
    }

    return {
      runId: String(row.run_id),
      datasetId: String(row.dataset_id),
      operation: String(row.operation) as DatasetMutationOperation,
      status: String(row.status) as DatasetRunLedgerStatus,
      traceId: optionalString(row.trace_id),
      adapterId: optionalString(row.adapter_id),
      adapterVersion: optionalString(row.adapter_version),
      runtimeId: optionalString(row.runtime_id),
      sourceUrl: optionalString(row.source_url),
      rowCount: Number(row.row_count ?? 0),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
      error: optionalString(row.error),
      metadata: parseJson(row.metadata),
    };
  }

  async getDatasetRun(datasetId: string, runId: string): Promise<DatasetRunLedgerEntry | null> {
    const result = await allPrepared(
      this.conn,
      `SELECT * FROM ${this.getRunLedgerTable({ datasetSidecar: datasetId })} WHERE run_id = ? LIMIT 1`,
      [runId]
    );
    const row = parseRows(result)[0];
    if (!row) {
      return null;
    }

    return {
      runId: String(row.run_id),
      datasetId: String(row.dataset_id),
      operation: String(row.operation) as DatasetMutationOperation,
      status: String(row.status) as DatasetRunLedgerStatus,
      traceId: optionalString(row.trace_id),
      adapterId: optionalString(row.adapter_id),
      adapterVersion: optionalString(row.adapter_version),
      runtimeId: optionalString(row.runtime_id),
      sourceUrl: optionalString(row.source_url),
      rowCount: Number(row.row_count ?? 0),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
      error: optionalString(row.error),
      metadata: parseJson(row.metadata),
    };
  }
}
