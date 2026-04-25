import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { SyncOutboxService } from './sync-outbox-service';

describe('SyncOutboxService pending dedupe', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let service: SyncOutboxService;

  beforeAll(async () => {
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);
    service = new SyncOutboxService(conn);
    await service.initTable();
  });

  afterAll(() => {
    conn.closeSync();
    db.closeSync();
  });

  beforeEach(async () => {
    await conn.run('DELETE FROM sync_outbox');
  });

  it('merges high-frequency upserts for the same entity into one pending event', async () => {
    const first = await service.enqueue({
      domain: 'profile',
      entityType: 'profile',
      localId: 'profile-1',
      eventType: 'upsert',
      eventSource: 'crud',
      payload: { name: 'v1' },
    });

    const second = await service.enqueue({
      domain: 'profile',
      entityType: 'profile',
      localId: 'profile-1',
      eventType: 'upsert',
      eventSource: 'crud',
      payload: { name: 'v2' },
    });

    const pending = await service.listPending(20, Date.now() + 10_000);

    expect(second.eventId).toBe(first.eventId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).toEqual({ name: 'v2' });
    expect(pending[0]?.eventType).toBe('upsert');
  });

  it('collapses pre-existing duplicate pending rows when enqueue is called again', async () => {
    const first = await service.enqueue({
      domain: 'profile',
      entityType: 'profile',
      localId: 'profile-dup',
      eventType: 'upsert',
      eventSource: 'crud',
      payload: { name: 'v1' },
    });

    await conn.run(`
      INSERT INTO sync_outbox (
        event_id, domain, entity_type, local_id, event_type, event_source,
        payload_json, idempotency_key, retry_count, status,
        created_at, updated_at, locked_at, next_retry_at, last_error
      ) VALUES (
        'evt-manual-dup', 'profile', 'profile', 'profile-dup', 'upsert', 'crud',
        '{"name":"stale"}', 'evt-manual-dup', 0, 'pending',
        ${Date.now() - 1000}, ${Date.now() - 1000}, NULL, ${Date.now() - 1000}, NULL
      )
    `);

    const merged = await service.enqueue({
      domain: 'profile',
      entityType: 'profile',
      localId: 'profile-dup',
      eventType: 'upsert',
      eventSource: 'crud',
      payload: { name: 'latest' },
    });

    const pending = await service.listPending(20, Date.now() + 10_000);

    expect(merged.eventId).toBe(first.eventId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.eventId).toBe(first.eventId);
    expect(pending[0]?.payload).toEqual({ name: 'latest' });
  });

  it('keeps at most one pending event while one event is processing', async () => {
    const processingEvent = await service.enqueue({
      domain: 'profile',
      entityType: 'profile',
      localId: 'profile-processing',
      eventType: 'upsert',
      eventSource: 'crud',
      payload: { name: 'processing' },
    });
    const markResult = await service.markProcessing(processingEvent.eventId);
    expect(markResult).toBe(true);

    const pending1 = await service.enqueue({
      domain: 'profile',
      entityType: 'profile',
      localId: 'profile-processing',
      eventType: 'upsert',
      eventSource: 'crud',
      payload: { name: 'v2' },
    });
    const pending2 = await service.enqueue({
      domain: 'profile',
      entityType: 'profile',
      localId: 'profile-processing',
      eventType: 'upsert',
      eventSource: 'crud',
      payload: { name: 'v3' },
    });

    const processingAfter = await service.get(processingEvent.eventId);
    const pending = await service.listPending(20, Date.now() + 10_000);

    expect(processingAfter?.status).toBe('processing');
    expect(pending).toHaveLength(1);
    expect(pending2.eventId).toBe(pending1.eventId);
    expect(pending[0]?.payload).toEqual({ name: 'v3' });
  });

  it('replaces pending upsert with delete for the same entity without creating a new event id', async () => {
    const first = await service.enqueue({
      domain: 'profile',
      entityType: 'profile',
      localId: 'profile-delete',
      eventType: 'upsert',
      eventSource: 'crud',
      payload: { name: 'to-delete' },
    });

    const deleted = await service.enqueue({
      domain: 'profile',
      entityType: 'profile',
      localId: 'profile-delete',
      eventType: 'delete',
      eventSource: 'crud',
      payload: null,
    });

    const pending = await service.listPending(20, Date.now() + 10_000);

    expect(deleted.eventId).toBe(first.eventId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.eventType).toBe('delete');
    expect(pending[0]?.payload).toBeNull();
    expect(pending[0]?.idempotencyKey).toBe(first.eventId);
  });
});

