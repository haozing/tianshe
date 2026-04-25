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

  it('serializes runtime artifacts on write', async () => {
    const artifact: RuntimeArtifact = {
      artifactId: 'artifact-write-1',
      timestamp: 1700000000001,
      traceId: 'trace-write-1',
      spanId: 'span-write-1',
      type: 'network_summary',
      component: 'browser',
      label: 'network summary',
      data: {
        total: 1,
      },
    };

    await service.recordArtifact(artifact);

    expect(mockConnection.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO runtime_artifacts')
    );
  });
});
