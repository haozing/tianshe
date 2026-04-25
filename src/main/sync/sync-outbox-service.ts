import { DuckDBConnection } from '@duckdb/node-api';
import { v4 as uuidv4 } from 'uuid';
import { parseRows } from '../duckdb/utils';
import type {
  SyncDomain,
  SyncEntityType,
  SyncEventSource,
  SyncOperationType,
} from '../../types/sync-contract';

const TABLE_NAME = 'sync_outbox';
const MAX_LIST_LIMIT = 1000;
const DEFAULT_SCOPE_KEY = 'company:0';

const ALLOWED_EVENT_TYPES: ReadonlySet<SyncOperationType> = new Set(['upsert', 'delete']);
const ALLOWED_EVENT_SOURCES: ReadonlySet<SyncEventSource> = new Set(['crud']);

export type SyncOutboxStatus = 'pending' | 'processing' | 'acked' | 'failed';

export interface SyncOutboxListPendingOptions {
  scopeKey?: string;
}

export interface SyncOutboxEventInput {
  eventId?: string;
  scopeKey?: string;
  domain: SyncDomain;
  entityType: SyncEntityType;
  localId: string;
  eventType: SyncOperationType;
  eventSource: SyncEventSource;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string;
  createdAt?: number;
  nextRetryAt?: number;
}

export interface SyncOutboxEvent {
  eventId: string;
  scopeKey: string;
  domain: SyncDomain;
  entityType: SyncEntityType;
  localId: string;
  eventType: SyncOperationType;
  eventSource: SyncEventSource;
  payload: Record<string, unknown> | null;
  idempotencyKey?: string;
  retryCount: number;
  status: SyncOutboxStatus;
  createdAt: number;
  updatedAt: number;
  lockedAt?: number;
  nextRetryAt: number;
  lastError?: string;
}

interface SyncOutboxRow {
  event_id: string;
  scope_key: string | null;
  domain: string;
  entity_type: string;
  local_id: string;
  event_type: string;
  event_source: string;
  payload_json: string | null;
  idempotency_key: string | null;
  retry_count: number;
  status: string;
  created_at: number;
  updated_at: number;
  locked_at: number | null;
  next_retry_at: number;
  last_error: string | null;
}

function normalizeNonEmpty(value: unknown, fieldName: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function normalizeTimestamp(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function normalizeListLimit(limit: number): number {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) {
    return 100;
  }
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(value)));
}

function normalizeStatus(raw: unknown): SyncOutboxStatus {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'processing') return 'processing';
  if (value === 'acked') return 'acked';
  if (value === 'failed') return 'failed';
  return 'pending';
}

function normalizeScopeKey(rawScopeKey: unknown): string {
  const value = String(rawScopeKey || '').trim().toLowerCase();
  return value || DEFAULT_SCOPE_KEY;
}

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore invalid payload and return null
  }
  return null;
}

export class SyncOutboxService {
  private initialized = false;

  constructor(private readonly conn: DuckDBConnection) {}

  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        event_id        VARCHAR PRIMARY KEY,
        scope_key       VARCHAR NOT NULL DEFAULT '${DEFAULT_SCOPE_KEY}',
        domain          VARCHAR NOT NULL,
        entity_type     VARCHAR NOT NULL,
        local_id        VARCHAR NOT NULL,
        event_type      VARCHAR NOT NULL,
        event_source    VARCHAR NOT NULL,
        payload_json    TEXT,
        idempotency_key VARCHAR,
        retry_count     INTEGER NOT NULL DEFAULT 0,
        status          VARCHAR NOT NULL DEFAULT 'pending',
        created_at      BIGINT NOT NULL,
        updated_at      BIGINT NOT NULL,
        locked_at       BIGINT,
        next_retry_at   BIGINT NOT NULL,
        last_error      TEXT
      )
    `);

    await this.ensureScopeKeyColumn();

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_retry
      ON ${TABLE_NAME} (status, next_retry_at, created_at)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_scope_status_retry
      ON ${TABLE_NAME} (scope_key, status, next_retry_at, created_at)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_domain_entity
      ON ${TABLE_NAME} (domain, entity_type, local_id)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_scope_domain_entity
      ON ${TABLE_NAME} (scope_key, domain, entity_type, local_id)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity_pending
      ON ${TABLE_NAME} (domain, entity_type, local_id, status, created_at)
    `);

    this.initialized = true;
  }

  async enqueue(input: SyncOutboxEventInput): Promise<SyncOutboxEvent> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(input.scopeKey);
    const domain = normalizeNonEmpty(input.domain, 'domain') as SyncDomain;
    const entityType = normalizeNonEmpty(input.entityType, 'entityType') as SyncEntityType;
    const localId = normalizeNonEmpty(input.localId, 'localId');
    const eventType = normalizeNonEmpty(input.eventType, 'eventType') as SyncOperationType;
    const eventSource = normalizeNonEmpty(input.eventSource, 'eventSource') as SyncEventSource;

    if (!ALLOWED_EVENT_TYPES.has(eventType)) {
      throw new Error(`Unsupported eventType: ${eventType}`);
    }
    if (!ALLOWED_EVENT_SOURCES.has(eventSource)) {
      throw new Error(`Unsupported eventSource: ${eventSource}`);
    }

    const now = Date.now();
    const eventId = normalizeNonEmpty(input.eventId || uuidv4(), 'eventId');
    const createdAt = normalizeTimestamp(input.createdAt, now);
    const nextRetryAt = normalizeTimestamp(input.nextRetryAt, createdAt);
    const payload =
      input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
        ? input.payload
        : null;
    const payloadJson = payload ? JSON.stringify(payload) : null;
    const idempotencyKey = String(input.idempotencyKey || '').trim() || eventId;

    const mergedPending = await this.mergeIntoPendingEvent({
      scopeKey,
      domain,
      entityType,
      localId,
      eventType,
      eventSource,
      payloadJson,
    });
    if (mergedPending) {
      return mergedPending;
    }

    const stmt = await this.conn.prepare(`
      INSERT INTO ${TABLE_NAME} (
        event_id, scope_key, domain, entity_type, local_id, event_type, event_source,
        payload_json, idempotency_key, retry_count, status,
        created_at, updated_at, locked_at, next_retry_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, NULL, ?, NULL)
    `);

    stmt.bind([
      eventId,
      scopeKey,
      domain,
      entityType,
      localId,
      eventType,
      eventSource,
      payloadJson,
      idempotencyKey,
      createdAt,
      now,
      nextRetryAt,
    ]);

    await stmt.run();
    stmt.destroySync();

    const row = await this.get(eventId);
    if (!row) {
      throw new Error(`Failed to read outbox event after insert: ${eventId}`);
    }
    return row;
  }

  async get(eventId: string): Promise<SyncOutboxEvent | null> {
    await this.ensureInitialized();

    const normalizedEventId = normalizeNonEmpty(eventId, 'eventId');
    const stmt = await this.conn.prepare(`
      SELECT
        event_id, scope_key, domain, entity_type, local_id, event_type, event_source,
        payload_json, idempotency_key, retry_count, status,
        created_at, updated_at, locked_at, next_retry_at, last_error
      FROM ${TABLE_NAME}
      WHERE event_id = ?
      LIMIT 1
    `);
    stmt.bind([normalizedEventId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows<SyncOutboxRow>(result);
    if (!rows.length) return null;
    return this.mapRow(rows[0]);
  }

  async listPending(
    limit = 100,
    nowMs = Date.now(),
    options?: SyncOutboxListPendingOptions
  ): Promise<SyncOutboxEvent[]> {
    await this.ensureInitialized();

    const normalizedLimit = normalizeListLimit(limit);
    const now = normalizeTimestamp(nowMs, Date.now());
    const scopeKey = normalizeScopeKey(options?.scopeKey);

    const stmt = await this.conn.prepare(`
      SELECT
        event_id, scope_key, domain, entity_type, local_id, event_type, event_source,
        payload_json, idempotency_key, retry_count, status,
        created_at, updated_at, locked_at, next_retry_at, last_error
      FROM ${TABLE_NAME}
      WHERE scope_key = ?
        AND status = 'pending'
        AND next_retry_at <= ?
      ORDER BY created_at ASC
      LIMIT ?
    `);
    stmt.bind([scopeKey, now, normalizedLimit]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    return parseRows<SyncOutboxRow>(result).map((row) => this.mapRow(row));
  }

  async markProcessing(eventId: string): Promise<boolean> {
    await this.ensureInitialized();

    const current = await this.get(eventId);
    if (!current || current.status !== 'pending') {
      return false;
    }

    const now = Date.now();
    const stmt = await this.conn.prepare(`
      UPDATE ${TABLE_NAME}
      SET status = 'processing', locked_at = ?, updated_at = ?, last_error = NULL
      WHERE event_id = ? AND status = 'pending'
    `);
    stmt.bind([now, now, current.eventId]);
    await stmt.run();
    stmt.destroySync();

    return true;
  }

  async ack(eventId: string): Promise<void> {
    await this.ensureInitialized();

    const normalizedEventId = normalizeNonEmpty(eventId, 'eventId');
    const now = Date.now();
    const stmt = await this.conn.prepare(`
      UPDATE ${TABLE_NAME}
      SET status = 'acked', updated_at = ?, locked_at = NULL, last_error = NULL
      WHERE event_id = ?
    `);
    stmt.bind([now, normalizedEventId]);
    await stmt.run();
    stmt.destroySync();
  }

  async fail(eventId: string, error: string, retryDelayMs = 0): Promise<void> {
    await this.ensureInitialized();

    const normalizedEventId = normalizeNonEmpty(eventId, 'eventId');
    const message = String(error || '').trim() || 'unknown sync outbox error';
    const now = Date.now();
    const retryDelay = Number(retryDelayMs);
    const shouldRetry = Number.isFinite(retryDelay) && retryDelay > 0;
    const nextStatus: SyncOutboxStatus = shouldRetry ? 'pending' : 'failed';
    const nextRetryAt = shouldRetry ? now + Math.trunc(retryDelay) : now;

    const stmt = await this.conn.prepare(`
      UPDATE ${TABLE_NAME}
      SET
        retry_count = retry_count + 1,
        status = ?,
        updated_at = ?,
        locked_at = NULL,
        next_retry_at = ?,
        last_error = ?
      WHERE event_id = ?
    `);
    stmt.bind([nextStatus, now, nextRetryAt, message, normalizedEventId]);
    await stmt.run();
    stmt.destroySync();
  }

  async deleteAcked(beforeUpdatedAtMs: number): Promise<number> {
    await this.ensureInitialized();

    const cutoff = normalizeTimestamp(beforeUpdatedAtMs, Date.now());
    const countStmt = await this.conn.prepare(`
      SELECT COUNT(*) AS count
      FROM ${TABLE_NAME}
      WHERE status = 'acked' AND updated_at <= ?
    `);
    countStmt.bind([cutoff]);
    const countResult = await countStmt.runAndReadAll();
    countStmt.destroySync();

    const countRows = parseRows<{ count: number }>(countResult);
    const count = Number(countRows[0]?.count ?? 0);
    const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
    if (normalizedCount <= 0) {
      return 0;
    }

    const deleteStmt = await this.conn.prepare(`
      DELETE FROM ${TABLE_NAME}
      WHERE status = 'acked' AND updated_at <= ?
    `);
    deleteStmt.bind([cutoff]);
    await deleteStmt.run();
    deleteStmt.destroySync();

    return normalizedCount;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initTable();
    }
  }

  private async ensureScopeKeyColumn(): Promise<void> {
    try {
      await this.conn.run(`ALTER TABLE ${TABLE_NAME} ADD COLUMN scope_key VARCHAR`);
    } catch {
      // ignore when column already exists
    }

    await this.conn.run(`
      UPDATE ${TABLE_NAME}
      SET scope_key = '${DEFAULT_SCOPE_KEY}'
      WHERE scope_key IS NULL OR TRIM(scope_key) = ''
    `);
  }

  private async mergeIntoPendingEvent(input: {
    scopeKey: string;
    domain: SyncDomain;
    entityType: SyncEntityType;
    localId: string;
    eventType: SyncOperationType;
    eventSource: SyncEventSource;
    payloadJson: string | null;
  }): Promise<SyncOutboxEvent | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        event_id, scope_key, domain, entity_type, local_id, event_type, event_source,
        payload_json, idempotency_key, retry_count, status,
        created_at, updated_at, locked_at, next_retry_at, last_error
      FROM ${TABLE_NAME}
      WHERE scope_key = ?
        AND domain = ?
        AND entity_type = ?
        AND local_id = ?
        AND status = 'pending'
      ORDER BY created_at ASC, updated_at ASC
    `);
    stmt.bind([input.scopeKey, input.domain, input.entityType, input.localId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const pendingRows = parseRows<SyncOutboxRow>(result).map((row) => this.mapRow(row));
    if (!pendingRows.length) return null;

    const primary = pendingRows[0];
    const now = Date.now();
    const idempotencyKey = String(primary.idempotencyKey || '').trim() || primary.eventId;

    const updateStmt = await this.conn.prepare(`
      UPDATE ${TABLE_NAME}
      SET
        event_type = ?,
        event_source = ?,
        payload_json = ?,
        idempotency_key = ?,
        retry_count = 0,
        updated_at = ?,
        next_retry_at = ?,
        locked_at = NULL,
        last_error = NULL
      WHERE event_id = ? AND status = 'pending'
    `);
    updateStmt.bind([
      input.eventType,
      input.eventSource,
      input.payloadJson,
      idempotencyKey,
      now,
      now,
      primary.eventId,
    ]);
    await updateStmt.run();
    updateStmt.destroySync();

    const redundantIds = pendingRows.slice(1).map((event) => event.eventId);
    if (redundantIds.length > 0) {
      const placeholders = redundantIds.map(() => '?').join(', ');
      const deleteStmt = await this.conn.prepare(`
        DELETE FROM ${TABLE_NAME}
        WHERE event_id IN (${placeholders}) AND status = 'pending'
      `);
      deleteStmt.bind(redundantIds);
      await deleteStmt.run();
      deleteStmt.destroySync();
    }

    return this.get(primary.eventId);
  }

  private mapRow(row: SyncOutboxRow): SyncOutboxEvent {
    const idempotencyKey = String(row.idempotency_key || '').trim();
    const lastError = String(row.last_error || '').trim();
    const lockedAtNumber = Number(row.locked_at);
    const lockedAt =
      Number.isFinite(lockedAtNumber) && lockedAtNumber > 0 ? Math.trunc(lockedAtNumber) : undefined;

    return {
      eventId: String(row.event_id),
      scopeKey: normalizeScopeKey(row.scope_key),
      domain: String(row.domain) as SyncDomain,
      entityType: String(row.entity_type) as SyncEntityType,
      localId: String(row.local_id),
      eventType: String(row.event_type) as SyncOperationType,
      eventSource: String(row.event_source) as SyncEventSource,
      payload: parsePayload(row.payload_json),
      idempotencyKey: idempotencyKey || undefined,
      retryCount: Math.max(0, Math.trunc(Number(row.retry_count) || 0)),
      status: normalizeStatus(row.status),
      createdAt: normalizeTimestamp(row.created_at, Date.now()),
      updatedAt: normalizeTimestamp(row.updated_at, Date.now()),
      lockedAt,
      nextRetryAt: normalizeTimestamp(row.next_retry_at, Date.now()),
      lastError: lastError || undefined,
    };
  }
}
