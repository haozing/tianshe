import { describe, expect, it, vi } from 'vitest';
import { ObservationQueryService } from './observation-query-service';
import type { RuntimeArtifact, RuntimeEvent } from '../core/observability/types';

describe('ObservationQueryService', () => {
  it('builds a concise trace summary', async () => {
    const events: RuntimeEvent[] = [
      {
        eventId: 'event-1',
        timestamp: 100,
        traceId: 'trace-1',
        level: 'info',
        event: 'capability.invoke.started',
        outcome: 'started',
        component: 'orchestration',
        capability: 'browser_snapshot',
        source: 'http',
      },
      {
        eventId: 'event-2',
        timestamp: 200,
        traceId: 'trace-1',
        level: 'error',
        event: 'browser.action.click.failed',
        outcome: 'failed',
        component: 'browser',
        browserEngine: 'electron',
        browserId: 'view-1',
        error: {
          message: 'button not found',
        },
        artifactRefs: ['artifact-1'],
      },
    ];
    const artifacts: RuntimeArtifact[] = [
      {
        artifactId: 'artifact-1',
        timestamp: 201,
        traceId: 'trace-1',
        type: 'snapshot',
        component: 'browser',
        label: 'failure snapshot',
      },
    ];

    const service = new ObservationQueryService({
      listEventsByTrace: vi.fn().mockResolvedValue(events),
      listArtifactsByTrace: vi.fn().mockResolvedValue(artifacts),
      getArtifactsByIds: vi.fn().mockResolvedValue(artifacts),
    } as any);

    const summary = await service.getTraceSummary('trace-1');

    expect(summary).toMatchObject({
      traceId: 'trace-1',
      eventCount: 2,
      artifactCount: 1,
      finalStatus: 'failed',
      entities: {
        capability: 'browser_snapshot',
        browserEngine: 'electron',
        browserId: 'view-1',
        source: 'http',
      },
      firstFailure: {
        event: 'browser.action.click.failed',
      },
      recentArtifacts: [
        {
          artifactId: 'artifact-1',
          type: 'snapshot',
        },
      ],
    });
  });

  it('returns a stable failure bundle with recent artifacts', async () => {
    const events: RuntimeEvent[] = [
      {
        eventId: 'event-1',
        timestamp: 100,
        traceId: 'trace-2',
        level: 'info',
        event: 'browser.action.click.started',
        outcome: 'started',
        component: 'browser',
      },
      {
        eventId: 'event-2',
        timestamp: 200,
        traceId: 'trace-2',
        level: 'error',
        event: 'browser.action.click.failed',
        outcome: 'failed',
        component: 'browser',
        error: {
          message: 'click failed',
        },
        artifactRefs: ['artifact-snapshot', 'artifact-console', 'artifact-network'],
      },
    ];
    const artifacts: RuntimeArtifact[] = [
      {
        artifactId: 'artifact-snapshot',
        timestamp: 201,
        traceId: 'trace-2',
        type: 'snapshot',
        component: 'browser',
        label: 'failure snapshot',
      },
      {
        artifactId: 'artifact-console',
        timestamp: 202,
        traceId: 'trace-2',
        type: 'console_tail',
        component: 'browser',
        label: 'console tail',
      },
      {
        artifactId: 'artifact-network',
        timestamp: 203,
        traceId: 'trace-2',
        type: 'network_summary',
        component: 'browser',
        label: 'network summary',
      },
      {
        artifactId: 'artifact-context',
        timestamp: 204,
        traceId: 'trace-2',
        type: 'error_context',
        component: 'duckdb',
        label: 'query failure context',
      },
    ];

    const service = new ObservationQueryService({
      listEventsByTrace: vi.fn().mockResolvedValue(events),
      listArtifactsByTrace: vi.fn().mockResolvedValue(artifacts),
      getArtifactsByIds: vi.fn().mockResolvedValue(artifacts),
    } as any);

    const bundle = await service.getFailureBundle('trace-2');

    expect(bundle).toMatchObject({
      traceId: 'trace-2',
      error: {
        message: 'click failed',
      },
      failedEvent: {
        event: 'browser.action.click.failed',
      },
      snapshot: {
        artifactId: 'artifact-snapshot',
      },
      consoleTail: {
        artifactId: 'artifact-console',
      },
      networkSummary: {
        artifactId: 'artifact-network',
      },
      errorContext: {
        artifactId: 'artifact-context',
      },
    });
    expect(bundle.recentEvents).toHaveLength(2);
    expect(bundle.artifactRefs).toHaveLength(4);
  });

  it('builds trace timelines and recent failure summaries', async () => {
    const events: RuntimeEvent[] = [
      {
        eventId: 'event-1',
        timestamp: 100,
        traceId: 'trace-3',
        level: 'info',
        event: 'capability.invoke.started',
        outcome: 'started',
        component: 'orchestration',
      },
      {
        eventId: 'event-2',
        timestamp: 200,
        traceId: 'trace-3',
        level: 'error',
        event: 'db.query.failed',
        outcome: 'failed',
        component: 'duckdb',
        datasetId: 'dataset-1',
        error: {
          message: 'sql failed',
        },
      },
    ];
    const artifacts: RuntimeArtifact[] = [
      {
        artifactId: 'artifact-3',
        timestamp: 201,
        traceId: 'trace-3',
        type: 'error_context',
        component: 'duckdb',
        label: 'query failure context',
      },
    ];

    const service = new ObservationQueryService({
      listEventsByTrace: vi.fn().mockResolvedValue(events),
      listArtifactsByTrace: vi.fn().mockResolvedValue(artifacts),
      getArtifactsByIds: vi.fn().mockResolvedValue(artifacts),
      listRecentFailureEvents: vi.fn().mockResolvedValue([events[1]]),
      getArtifactCountsByTraceIds: vi.fn().mockResolvedValue(new Map([['trace-3', 1]])),
    } as any);

    const timeline = await service.getTraceTimeline('trace-3', 50);
    expect(timeline).toMatchObject({
      traceId: 'trace-3',
      finalStatus: 'failed',
      events: [
        {
          event: 'capability.invoke.started',
        },
        {
          event: 'db.query.failed',
        },
      ],
      artifactRefs: [
        {
          artifactId: 'artifact-3',
        },
      ],
    });

    const recentFailures = await service.searchRecentFailures(10);
    expect(recentFailures).toEqual([
      expect.objectContaining({
        traceId: 'trace-3',
        event: 'db.query.failed',
        datasetId: 'dataset-1',
        finalStatus: 'failed',
        artifactCount: 1,
      }),
    ]);
  });
});
