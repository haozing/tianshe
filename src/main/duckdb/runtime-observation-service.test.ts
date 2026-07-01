import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeObservationService } from './runtime-observation-service';
import type { RuntimeArtifact, RuntimeEvent } from '../../core/observability/types';

describe('RuntimeObservationService', () => {
  let service: RuntimeObservationService;
  let mockConnection: any;

  beforeEach(() => {
    mockConnection = {
      run: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn((query: string) => {
        if (query.includes('SELECT * FROM runtime_events')) {
          return {
            bind: vi.fn(),
            runAndReadAll: vi.fn().mockResolvedValue({
              columnNames: () => [
                'id',
                'trace_id',
                'span_id',
                'parent_span_id',
                'timestamp',
                'seq',
                'level',
                'event',
                'outcome',
                'component',
                'message',
                'duration_ms',
                'source',
                'capability',
                'plugin_id',
                'browser_engine',
                'session_id',
                'profile_id',
                'dataset_id',
                'browser_id',
                'attrs',
                'error',
                'artifact_refs',
              ],
              getRows: () => [
                [
                  'event-1',
                  'trace-1',
                  'span-1',
                  null,
                  1700000000000,
                  1700000000000000,
                  'info',
                  'capability.invoke.started',
                  'started',
                  'orchestration',
                  null,
                  null,
                  'http',
                  'browser_snapshot',
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  '{"capability":"browser_snapshot"}',
                  null,
                  '["artifact-1"]',
                ],
              ],
            }),
            run: vi.fn().mockResolvedValue(undefined),
            destroySync: vi.fn(),
          };
        }

        if (query.includes('SELECT * FROM runtime_artifacts')) {
          return {
            bind: vi.fn(),
            runAndReadAll: vi.fn().mockResolvedValue({
              columnNames: () => [
                'id',
                'trace_id',
                'span_id',
                'parent_span_id',
                'timestamp',
                'seq',
                'type',
                'component',
                'label',
                'mime_type',
                'source',
                'capability',
                'plugin_id',
                'browser_engine',
                'session_id',
                'profile_id',
                'dataset_id',
                'browser_id',
                'attrs',
                'payload',
                'data',
              ],
              getRows: () => [
                [
                  'artifact-1',
                  'trace-1',
                  'span-1',
                  null,
                  1700000000001,
                  1700000000001000,
                  'snapshot',
                  'browser',
                  'failure snapshot',
                  null,
                  'http',
                  null,
                  null,
                  'electron',
                  null,
                  null,
                  null,
                  'view-1',
                  null,
                  null,
                  '{"url":"https://example.com"}',
                ],
              ],
            }),
            run: vi.fn().mockResolvedValue(undefined),
            destroySync: vi.fn(),
          };
        }

        return {
          bind: vi.fn(),
          run: vi.fn().mockResolvedValue(undefined),
          runAndReadAll: vi.fn().mockResolvedValue({
            columnNames: () => [],
            getRows: () => [],
          }),
          destroySync: vi.fn(),
        };
      }),
    };

    service = new RuntimeObservationService(mockConnection);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates runtime observation tables and indexes', async () => {
    await service.initTable();

    expect(mockConnection.run).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS runtime_events')
    );
    expect(mockConnection.run).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS runtime_artifacts')
    );
    expect(mockConnection.run).toHaveBeenCalledWith(
      expect.stringContaining('idx_runtime_events_trace_seq')
    );
    expect(mockConnection.run).toHaveBeenCalledWith(
      'ALTER TABLE runtime_events ADD COLUMN IF NOT EXISTS browser_runtime_id VARCHAR'
    );
    expect(mockConnection.run).toHaveBeenCalledWith(
      'ALTER TABLE runtime_artifacts ADD COLUMN IF NOT EXISTS browser_runtime_id VARCHAR'
    );
    expect(mockConnection.run).toHaveBeenCalledWith(
      'ALTER TABLE runtime_artifacts ADD COLUMN IF NOT EXISTS payload JSON'
    );
  });

  it('serializes runtime events on write', async () => {
    const event: RuntimeEvent = {
      eventId: 'event-write-1',
      timestamp: 1700000000000,
      traceId: 'trace-write-1',
      spanId: 'span-write-1',
      level: 'info',
      event: 'capability.invoke.started',
      outcome: 'started',
      component: 'orchestration',
      attrs: {
        capability: 'browser_snapshot',
      },
      artifactRefs: ['artifact-write-1'],
    };

    await service.recordEvent(event);

    const insertStatement = mockConnection.prepare.mock.results.at(-1)?.value;

    expect(insertStatement?.bind).toHaveBeenCalledWith(
      expect.arrayContaining([
        'event-write-1',
        'trace-write-1',
        'span-write-1',
        expect.any(Number),
        'info',
        'capability.invoke.started',
      ])
    );
  });

  it('parses stored events and artifacts back into runtime models', async () => {
    const events = await service.listEventsByTrace('trace-1');
    const artifacts = await service.listArtifactsByTrace('trace-1');

    expect(events).toEqual([
      expect.objectContaining({
        eventId: 'event-1',
        traceId: 'trace-1',
        attrs: {
          capability: 'browser_snapshot',
        },
        artifactRefs: ['artifact-1'],
      }),
    ]);
    expect(artifacts).toEqual([
      expect.objectContaining({
        artifactId: 'artifact-1',
        traceId: 'trace-1',
        type: 'snapshot',
        label: 'failure snapshot',
      }),
    ]);
  });

  it('ignores corrupt JSON fields while returning the rest of the trace data', async () => {
    mockConnection.prepare.mockImplementation((query: string) => {
      if (query.includes('SELECT * FROM runtime_events')) {
        return {
          bind: vi.fn(),
          runAndReadAll: vi.fn().mockResolvedValue({
            columnNames: () => [
              'id',
              'trace_id',
              'span_id',
              'parent_span_id',
              'timestamp',
              'seq',
              'level',
              'event',
              'outcome',
              'component',
              'message',
              'duration_ms',
              'source',
              'capability',
              'plugin_id',
              'browser_runtime_id',
              'session_id',
              'profile_id',
              'dataset_id',
              'browser_id',
              'attrs',
              'error',
              'artifact_refs',
            ],
            getRows: () => [
              [
                'event-corrupt',
                'trace-corrupt',
                null,
                null,
                1700000000100,
                1700000000100000,
                'error',
                'capability.invoke.failed',
                'failed',
                'orchestration',
                'failed but readable',
                null,
                'http',
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                '{bad attrs',
                '{"message":"ok"}',
                '[bad refs',
              ],
            ],
          }),
          run: vi.fn().mockResolvedValue(undefined),
          destroySync: vi.fn(),
        };
      }

      if (query.includes('SELECT * FROM runtime_artifacts')) {
        return {
          bind: vi.fn(),
          runAndReadAll: vi.fn().mockResolvedValue({
            columnNames: () => [
              'id',
              'trace_id',
              'span_id',
              'parent_span_id',
              'timestamp',
              'seq',
              'type',
              'component',
              'label',
              'mime_type',
              'source',
              'capability',
              'plugin_id',
              'browser_runtime_id',
              'session_id',
              'profile_id',
              'dataset_id',
              'browser_id',
              'attrs',
              'payload',
              'data',
            ],
            getRows: () => [
              [
                'artifact-corrupt',
                'trace-corrupt',
                null,
                null,
                1700000000101,
                1700000000101000,
                'snapshot',
                'browser',
                'corrupt snapshot',
                null,
                'http',
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                '{"kind":"file","storageKey":"aa/artifact-corrupt/file.png","filename":"file.png","sizeBytes":10,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
                '{bad data',
              ],
            ],
          }),
          run: vi.fn().mockResolvedValue(undefined),
          destroySync: vi.fn(),
        };
      }

      return {
        bind: vi.fn(),
        run: vi.fn().mockResolvedValue(undefined),
        runAndReadAll: vi.fn().mockResolvedValue({
          columnNames: () => [],
          getRows: () => [],
        }),
        destroySync: vi.fn(),
      };
    });

    await expect(service.listEventsByTrace('trace-corrupt')).resolves.toEqual([
      expect.objectContaining({
        eventId: 'event-corrupt',
        traceId: 'trace-corrupt',
        error: { message: 'ok' },
      }),
    ]);
    await expect(service.listArtifactsByTrace('trace-corrupt')).resolves.toEqual([
      expect.objectContaining({
        artifactId: 'artifact-corrupt',
        traceId: 'trace-corrupt',
        label: 'corrupt snapshot',
      }),
    ]);
  });

  it('serializes runtime artifacts on write', async () => {
    const artifact: RuntimeArtifact = {
      artifactId: 'artifact-write-1',
      timestamp: 1700000000001,
      traceId: 'trace-write-1',
      spanId: 'span-write-1',
      type: 'network_summary',
      component: 'browser',
      label: 'network summary',
      payload: {
        kind: 'file',
        storageKey: 'aa/artifact-write-1/network.har',
        filename: 'network.har',
        mimeType: 'application/json',
        sizeBytes: 12,
        sha256: 'b'.repeat(64),
      },
      data: {
        total: 1,
      },
    };

    await service.recordArtifact(artifact);

    expect(mockConnection.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO runtime_artifacts')
    );
    const insertStatement = mockConnection.prepare.mock.results.at(-1)?.value;
    expect(insertStatement?.bind).toHaveBeenCalledWith(
      expect.arrayContaining([
        JSON.stringify({
          kind: 'file',
          storageKey: 'aa/artifact-write-1/network.har',
          filename: 'network.har',
          mimeType: 'application/json',
          sizeBytes: 12,
          sha256: 'b'.repeat(64),
        }),
      ])
    );
  });

  it('queries a single runtime artifact by id from the unified artifact table', async () => {
    const artifact = await service.getArtifactById(' artifact-1 ');

    expect(artifact).toEqual(
      expect.objectContaining({
        artifactId: 'artifact-1',
        traceId: 'trace-1',
        type: 'snapshot',
        label: 'failure snapshot',
      })
    );
    expect(mockConnection.prepare).toHaveBeenCalledWith(
      'SELECT * FROM runtime_artifacts WHERE id = ? LIMIT 1'
    );
  });

  it('cleans runtime observations older than retention cutoff', async () => {
    const statements: any[] = [];
    mockConnection.prepare.mockImplementation((query: string) => {
      const statement = {
        bind: vi.fn(),
        run: vi.fn().mockResolvedValue(undefined),
        runAndReadAll: vi.fn().mockResolvedValue({
          columnNames: () =>
            query.includes('SELECT * FROM runtime_artifacts')
              ? ['id', 'trace_id', 'timestamp', 'seq', 'type', 'component']
              : ['count'],
          getRows: () =>
            query.includes('SELECT * FROM runtime_artifacts')
              ? [
                  ['artifact-expired-1', 'trace-1', 1, 1, 'download', 'download'],
                  ['artifact-expired-2', 'trace-1', 1, 2, 'download', 'download'],
                  ['artifact-expired-3', 'trace-1', 1, 3, 'download', 'download'],
                ]
              : [[2]],
        }),
        destroySync: vi.fn(),
      };
      statements.push({ query, statement });
      return statement;
    });

    const result = await service.cleanupRetention({
      daysToKeep: 2,
      now: 1_700_000_000_000,
    });

    expect(result).toEqual({
      cutoffTimestamp: 1_699_827_200_000,
      artifactsDeleted: 3,
      eventsDeleted: 2,
    });
    expect(statements.map((item) => item.query)).toEqual(
      expect.arrayContaining([
        'SELECT * FROM runtime_artifacts WHERE timestamp < ?',
        'SELECT COUNT(*) AS count FROM runtime_events WHERE timestamp < ?',
        'DELETE FROM runtime_artifacts WHERE id IN (?, ?, ?)',
        'DELETE FROM runtime_events WHERE timestamp < ?',
      ])
    );
    for (const { query, statement } of statements.filter((item) => item.query.includes('timestamp < ?'))) {
      expect(statement.bind).toHaveBeenCalledWith([1_699_827_200_000]);
    }
  });

  it('deletes file-backed payloads during retention cleanup before deleting rows', async () => {
    const deletedPayloads: unknown[] = [];
    service = new RuntimeObservationService(mockConnection, {
      artifactFileStore: {
        deleteFilePayload: vi.fn(async (payload) => {
          deletedPayloads.push(payload);
          return true;
        }),
      },
    });
    mockConnection.prepare.mockImplementation((query: string) => {
      if (query === 'SELECT * FROM runtime_artifacts WHERE timestamp < ?') {
        return {
          bind: vi.fn(),
          run: vi.fn().mockResolvedValue(undefined),
          runAndReadAll: vi.fn().mockResolvedValue({
            columnNames: () => [
              'id',
              'trace_id',
              'timestamp',
              'seq',
              'type',
              'component',
              'payload',
            ],
            getRows: () => [
              [
                'artifact-expired',
                'trace-expired',
                1_699_000_000_000,
                1_699_000_000_000_000,
                'screenshot',
                'browser',
                '{"kind":"file","storageKey":"aa/artifact-expired/file.png","filename":"file.png","sizeBytes":10,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
              ],
            ],
          }),
          destroySync: vi.fn(),
        };
      }

      return {
        bind: vi.fn(),
        run: vi.fn().mockResolvedValue(undefined),
        runAndReadAll: vi.fn().mockResolvedValue({
          columnNames: () => ['count'],
          getRows: () => [[query.includes('runtime_artifacts') ? 1 : 0]],
        }),
        destroySync: vi.fn(),
      };
    });

    await service.cleanupRetention({
      daysToKeep: 2,
      now: 1_700_000_000_000,
    });

    expect(deletedPayloads).toEqual([
      expect.objectContaining({
        kind: 'file',
        storageKey: 'aa/artifact-expired/file.png',
      }),
    ]);
  });

  it('retains artifact rows when file deletion fails during retention cleanup', async () => {
    const deleteFilePayload = vi.fn(async () => {
      throw new Error('locked file');
    });
    service = new RuntimeObservationService(mockConnection, {
      artifactFileStore: {
        deleteFilePayload,
      },
    });
    const statements: any[] = [];
    mockConnection.prepare.mockImplementation((query: string) => {
      const statement = {
        bind: vi.fn(),
        run: vi.fn().mockResolvedValue(undefined),
        runAndReadAll: vi.fn().mockResolvedValue({
          columnNames: () =>
            query === 'SELECT * FROM runtime_artifacts WHERE timestamp < ?'
              ? [
                  'id',
                  'trace_id',
                  'timestamp',
                  'seq',
                  'type',
                  'component',
                  'payload',
                ]
              : ['count'],
          getRows: () =>
            query === 'SELECT * FROM runtime_artifacts WHERE timestamp < ?'
              ? [
                  [
                    'artifact-retained',
                    'trace-retained',
                    1_699_000_000_000,
                    1_699_000_000_000_000,
                    'download',
                    'download',
                    '{"kind":"file","storageKey":"aa/artifact-retained/file.png","filename":"file.png","sizeBytes":10,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
                  ],
                ]
              : [[0]],
        }),
        destroySync: vi.fn(),
      };
      statements.push({ query, statement });
      return statement;
    });

    const result = await service.cleanupRetention({
      daysToKeep: 2,
      now: 1_700_000_000_000,
    });

    expect(result).toMatchObject({
      artifactsDeleted: 0,
      artifactFilesDeleted: 0,
      artifactRowsRetained: 1,
    });
    expect(deleteFilePayload).toHaveBeenCalled();
    expect(statements.map((item) => item.query)).not.toContain(
      'DELETE FROM runtime_artifacts WHERE id IN (?)'
    );
  });
});
