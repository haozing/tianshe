import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return path.join(process.cwd(), 'test-data');
      }
      return '';
    },
  },
}));

import { DuckDBService } from './service';

describe('DuckDBService getDatasetRecordEvidence', () => {
  it('joins record provenance with observation evidence by trace id', async () => {
    const service = new DuckDBService();
    const provenance = [
      {
        id: 'prov-1',
        datasetId: 'dataset-1',
        rowId: 7,
        runId: 'run-1',
        operation: 'insert',
        occurredAt: 111,
        traceId: 'trace-1',
        adapterId: 'adapter-a',
        adapterVersion: '1.0.0',
        runtimeId: 'chromium-cloak-playwright',
        sourceUrl: 'https://example.test/item/1',
        metadata: { profileId: 'profile-a' },
        before: null,
        after: { name: 'Alpha' },
      },
      {
        id: 'prov-2',
        datasetId: 'dataset-1',
        rowId: 7,
        runId: 'run-2',
        operation: 'update',
        occurredAt: 222,
        traceId: 'trace-1',
        adapterId: 'adapter-a',
        adapterVersion: '1.0.0',
        runtimeId: 'chromium-cloak-playwright',
        sourceUrl: 'https://example.test/item/1',
        metadata: { profile_id: 'profile-b' },
        before: { name: 'Alpha' },
        after: { name: 'Beta' },
      },
      {
        id: 'prov-3',
        datasetId: 'dataset-1',
        rowId: 7,
        runId: 'run-3',
        operation: 'update',
        occurredAt: 333,
        traceId: 'trace-missing',
        adapterId: 'adapter-b',
        adapterVersion: '2.0.0',
        runtimeId: 'fixture',
        sourceUrl: null,
        metadata: null,
        before: null,
        after: null,
      },
    ];
    const datasetService = {
      listRecordProvenance: vi.fn().mockResolvedValue(provenance),
      countRecordProvenance: vi.fn().mockResolvedValue(5),
    };
    const observationQueryService = {
      getTraceSummary: vi.fn(async (traceId: string) => {
        if (traceId === 'trace-missing') {
          throw new Error('trace not found');
        }
        return { traceId, status: 'ok' };
      }),
      getFailureBundle: vi.fn(async (traceId: string) => ({ traceId, artifacts: [] })),
      getTraceTimeline: vi.fn(async (traceId: string) => ({ traceId, events: [] })),
    };

    Object.assign(service as any, {
      datasetService,
      observationQueryService,
    });

    const bundle = await service.getDatasetRecordEvidence(' dataset-1 ', 7, 20);

    expect(datasetService.listRecordProvenance).toHaveBeenCalledWith('dataset-1', 7, 20);
    expect(datasetService.countRecordProvenance).toHaveBeenCalledWith('dataset-1', 7);
    expect(bundle.summary).toEqual({
      totalProvenanceRecords: 5,
      returnedProvenanceRecords: 3,
      hasMoreProvenance: true,
      operationCounts: [
        { key: 'update', count: 2 },
        { key: 'insert', count: 1 },
      ],
      adapterCounts: [
        { key: 'adapter-a', count: 2 },
        { key: 'adapter-b', count: 1 },
      ],
      runtimeCounts: [
        { key: 'chromium-cloak-playwright', count: 2 },
        { key: 'fixture', count: 1 },
      ],
      traceStatusCounts: [
        { key: 'error', count: 1 },
        { key: 'ok', count: 1 },
      ],
    });
    expect(bundle.traceIds).toEqual(['trace-1', 'trace-missing']);
    expect(bundle.sources).toEqual([
      expect.objectContaining({
        id: 'prov-1',
        profileId: 'profile-a',
        adapterId: 'adapter-a',
        runtimeId: 'chromium-cloak-playwright',
      }),
      expect.objectContaining({
        id: 'prov-2',
        profileId: 'profile-b',
      }),
      expect.objectContaining({
        id: 'prov-3',
        profileId: null,
      }),
    ]);
    expect(bundle.traces[0]).toEqual(
      expect.objectContaining({
        traceId: 'trace-1',
        summary: { traceId: 'trace-1', status: 'ok' },
      })
    );
    expect(bundle.traces[1]).toEqual(
      expect.objectContaining({
        traceId: 'trace-missing',
        summary: null,
        failureBundle: null,
        timeline: null,
        error: 'trace not found',
      })
    );
    expect(observationQueryService.getTraceSummary).toHaveBeenCalledTimes(2);
    expect(observationQueryService.getFailureBundle).toHaveBeenCalledTimes(2);
    expect(observationQueryService.getTraceTimeline).toHaveBeenCalledWith('trace-1', 100);
  });
});
