import { describe, expect, it, vi } from 'vitest';
import { createDuckDbOrchestrationIdempotencyPersistence } from './orchestration-idempotency-duckdb-store';

function createDuckdbMock(rows: Array<Record<string, unknown>> = []) {
  return {
    executeWithParams: vi.fn().mockResolvedValue(undefined),
    executeSQLWithParams: vi.fn().mockResolvedValue(rows),
  };
}

describe('DuckDB orchestration idempotency persistence', () => {
  it('reserves a running idempotency entry when none exists', async () => {
    const duckdb = createDuckdbMock([]);
    const store = createDuckDbOrchestrationIdempotencyPersistence(duckdb as never);

    const result = await store.reserve!('order-1', 'key-1', {
      state: 'running',
      requestHash: 'hash-1',
      capability: 'browser_snapshot',
      createdAt: 1_700_000_000_000,
      meta: { idempotencyKey: 'key-1' },
    });

    expect(result.status).toBe('reserved');
    expect(duckdb.executeWithParams).toHaveBeenCalledWith(
      expect.stringContaining('ADD COLUMN IF NOT EXISTS state'),
      []
    );
    expect(duckdb.executeWithParams).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO orchestration_idempotency_entries'),
      expect.arrayContaining(['order-1', 'key-1', 'hash-1', 'browser_snapshot', 'running'])
    );
  });

  it('returns existing running reservations without inserting a duplicate', async () => {
    const duckdb = createDuckdbMock([
      {
        request_hash: 'hash-1',
        capability: 'browser_snapshot',
        state: 'running',
        created_at: 1_700_000_000_000,
        result_json: null,
        error_json: null,
        meta_json: JSON.stringify({ idempotencyKey: 'key-1' }),
      },
    ]);
    const store = createDuckDbOrchestrationIdempotencyPersistence(duckdb as never);

    const result = await store.reserve!('order-1', 'key-1', {
      state: 'running',
      requestHash: 'hash-1',
      capability: 'browser_snapshot',
      createdAt: 1_700_000_000_001,
    });

    expect(result.status).toBe('exists');
    expect(result.entry.state).toBe('running');
    expect(result.entry.result).toBeUndefined();
    const insertCalls = duckdb.executeWithParams.mock.calls.filter((call) =>
      String(call[0]).includes('INSERT INTO orchestration_idempotency_entries')
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('stores completed entries with completed state', async () => {
    const duckdb = createDuckdbMock([]);
    const store = createDuckDbOrchestrationIdempotencyPersistence(duckdb as never);

    await store.set('order-1', 'key-1', {
      state: 'completed',
      requestHash: 'hash-1',
      capability: 'browser_snapshot',
      createdAt: 1_700_000_000_000,
      result: {
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    });

    expect(duckdb.executeWithParams).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO orchestration_idempotency_entries'),
      expect.arrayContaining(['order-1', 'key-1', 'hash-1', 'browser_snapshot', 'completed'])
    );
  });
});
