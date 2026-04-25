import { createLogger } from '../core/logger';
import type { OrchestrationIdempotencyEntry } from '../core/ai-dev/orchestration/types';
import type { DuckDBService } from './duckdb/service';
import type { OrchestrationIdempotencyPersistenceStore } from '../types/http-api';

const logger = createLogger('ORCH-IDEMPOTENCY');

const TABLE_NAME = 'orchestration_idempotency_entries';

const createTableSql = `
  CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    namespace VARCHAR NOT NULL,
    idempotency_key VARCHAR NOT NULL,
    request_hash VARCHAR NOT NULL,
    capability VARCHAR NOT NULL,
    created_at BIGINT NOT NULL,
    result_json TEXT NOT NULL,
    error_json TEXT,
    meta_json TEXT,
    PRIMARY KEY (namespace, idempotency_key)
  )
`;

const createIndexSql = `
  CREATE INDEX IF NOT EXISTS idx_orch_idem_created_at
  ON ${TABLE_NAME} (created_at)
`;

const serialize = (value: unknown): string => JSON.stringify(value);

const parseJson = <T>(value: unknown): T | null => {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

class DuckDbOrchestrationIdempotencyPersistence implements OrchestrationIdempotencyPersistenceStore {
  private initialized = false;

  constructor(private readonly duckdb: DuckDBService) {}

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.duckdb.executeWithParams(createTableSql, []);
    await this.duckdb.executeWithParams(createIndexSql, []);
    this.initialized = true;
  }

  async get(namespace: string, key: string): Promise<OrchestrationIdempotencyEntry | null> {
    await this.ensureInitialized();
    const rows = (await this.duckdb.executeSQLWithParams(
      `
        SELECT
          request_hash,
          capability,
          created_at,
          result_json,
          error_json,
          meta_json
        FROM ${TABLE_NAME}
        WHERE namespace = ? AND idempotency_key = ?
        LIMIT 1
      `,
      [namespace, key]
    )) as Array<Record<string, unknown>>;

    if (!rows.length) {
      return null;
    }

    const row = rows[0];
    const requestHash = typeof row.request_hash === 'string' ? row.request_hash : '';
    const capability = typeof row.capability === 'string' ? row.capability : '';
    const createdAt = Number(row.created_at);
    const result = parseJson<OrchestrationIdempotencyEntry['result']>(row.result_json);
    const error = parseJson<OrchestrationIdempotencyEntry['error']>(row.error_json);
    const meta = parseJson<OrchestrationIdempotencyEntry['meta']>(row.meta_json);

    if (!requestHash || !capability || !Number.isFinite(createdAt) || !result) {
      logger.warn(`Corrupted idempotency entry detected, namespace=${namespace}, key=${key}`);
      return null;
    }

    return {
      requestHash,
      capability,
      createdAt,
      result,
      ...(error ? { error } : {}),
      ...(meta ? { meta } : {}),
    };
  }

  async set(namespace: string, key: string, entry: OrchestrationIdempotencyEntry): Promise<void> {
    await this.ensureInitialized();
    await this.duckdb.executeWithParams(
      `
        DELETE FROM ${TABLE_NAME}
        WHERE namespace = ? AND idempotency_key = ?
      `,
      [namespace, key]
    );
    await this.duckdb.executeWithParams(
      `
        INSERT INTO ${TABLE_NAME} (
          namespace,
          idempotency_key,
          request_hash,
          capability,
          created_at,
          result_json,
          error_json,
          meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        namespace,
        key,
        entry.requestHash,
        entry.capability,
        entry.createdAt,
        serialize(entry.result),
        entry.error ? serialize(entry.error) : null,
        entry.meta ? serialize(entry.meta) : null,
      ]
    );
  }

  async deleteNamespace(namespace: string): Promise<void> {
    await this.ensureInitialized();
    await this.duckdb.executeWithParams(
      `
        DELETE FROM ${TABLE_NAME}
        WHERE namespace = ?
      `,
      [namespace]
    );
  }

  async pruneExpired(ttlMs: number, nowMs = Date.now()): Promise<number> {
    await this.ensureInitialized();
    const cutoff = nowMs - ttlMs;
    const countRows = (await this.duckdb.executeSQLWithParams(
      `
        SELECT COUNT(*) AS count
        FROM ${TABLE_NAME}
        WHERE created_at < ?
      `,
      [cutoff]
    )) as Array<Record<string, unknown>>;
    const deleted = Number(countRows[0]?.count || 0);
    if (deleted > 0) {
      await this.duckdb.executeWithParams(
        `
          DELETE FROM ${TABLE_NAME}
          WHERE created_at < ?
        `,
        [cutoff]
      );
    }
    return Number.isFinite(deleted) ? deleted : 0;
  }
}

export const createDuckDbOrchestrationIdempotencyPersistence = (
  duckdb: DuckDBService
): OrchestrationIdempotencyPersistenceStore => {
  return new DuckDbOrchestrationIdempotencyPersistence(duckdb);
};
