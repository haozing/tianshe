import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => 'test-data',
  },
}));

import { DuckDBService } from './service';
import { setObservationSink } from '../../core/observability/observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../../core/observability/types';

class MemoryObservationSink implements ObservationSink {
  events: RuntimeEvent[] = [];
  artifacts: RuntimeArtifact[] = [];

  recordEvent(event: RuntimeEvent): void {
    this.events.push(event);
  }

  recordArtifact(artifact: RuntimeArtifact): void {
    this.artifacts.push(artifact);
  }
}

describe('DuckDBService observation hooks', () => {
  let service: DuckDBService;
  let datasetService: {
    queryDataset: ReturnType<typeof vi.fn>;
    createEmptyDataset: ReturnType<typeof vi.fn>;
    importDatasetFile: ReturnType<typeof vi.fn>;
    renameDataset: ReturnType<typeof vi.fn>;
    deleteDataset: ReturnType<typeof vi.fn>;
    listGroupTabsByDataset: ReturnType<typeof vi.fn>;
    withDatasetAttached: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    service = new DuckDBService();
    datasetService = {
      queryDataset: vi.fn().mockResolvedValue({
        columns: ['id'],
        rows: [{ id: 1 }],
        rowCount: 1,
        filteredTotalCount: 1,
      }),
      createEmptyDataset: vi.fn().mockResolvedValue('dataset-new'),
      importDatasetFile: vi.fn().mockResolvedValue('dataset-imported'),
      renameDataset: vi.fn().mockResolvedValue(undefined),
      deleteDataset: vi.fn().mockResolvedValue(undefined),
      listGroupTabsByDataset: vi.fn().mockResolvedValue([]),
      withDatasetAttached: vi.fn().mockImplementation(async (_datasetId: string, fn: () => Promise<void>) => {
        await fn();
      }),
    };
    (service as any).datasetService = datasetService;
    (service as any).queryTemplateService = {
      getOrCreateDefaultQueryTemplate: vi.fn().mockResolvedValue({ id: 'template-1' }),
    };
  });

  afterEach(() => {
    setObservationSink(null);
    vi.clearAllMocks();
  });

  it('records db.query events when querying a dataset', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    const result = await service.queryDataset('dataset-1', 'SELECT * FROM data LIMIT 1', 0, 1);

    expect(result.rowCount).toBe(1);
    expect(
      sink.events.filter((event) => event.event.startsWith('db.query')).map((event) => event.event)
    ).toEqual(['db.query.started', 'db.query.succeeded']);
    expect(
      sink.events.find((event) => event.event === 'db.query.succeeded')?.attrs
    ).toMatchObject({
      datasetId: 'dataset-1',
      queryKind: 'custom_sql',
      rowCount: 1,
      filteredTotalCount: 1,
    });
  });

  it('records dataset lifecycle events for create, rename, and delete', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    const datasetId = await service.createEmptyDataset('Leads Queue', { folderId: 'folder-1' });
    await service.renameDataset(datasetId, 'Qualified Leads');
    await service.deleteDataset(datasetId);

    expect(datasetId).toBe('dataset-new');
    expect(datasetService.createEmptyDataset).toHaveBeenCalledWith('Leads Queue', {
      folderId: 'folder-1',
    });
    expect(datasetService.renameDataset).toHaveBeenCalledWith('dataset-new', 'Qualified Leads');
    expect(datasetService.deleteDataset).toHaveBeenCalledWith('dataset-new');

    expect(
      sink.events
        .filter((event) => event.event.startsWith('dataset.lifecycle'))
        .map((event) => event.event)
    ).toEqual([
      'dataset.lifecycle.create_empty.started',
      'dataset.lifecycle.create_empty.succeeded',
      'dataset.lifecycle.rename.started',
      'dataset.lifecycle.rename.succeeded',
      'dataset.lifecycle.delete.started',
      'dataset.lifecycle.delete.succeeded',
    ]);
  });

  it('records dataset.lifecycle.import_file events when importing a dataset file', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    const datasetId = await service.importDatasetFile('D:\\data\\orders.csv', 'Orders', {
      folderId: 'folder-2',
    });

    expect(datasetId).toBe('dataset-imported');
    expect(datasetService.importDatasetFile).toHaveBeenCalledWith(
      'D:\\data\\orders.csv',
      'Orders',
      { folderId: 'folder-2' },
      expect.any(Function)
    );
    expect(
      sink.events
        .filter((event) => event.event.startsWith('dataset.lifecycle.import_file'))
        .map((event) => event.event)
    ).toEqual([
      'dataset.lifecycle.import_file.started',
      'dataset.lifecycle.import_file.succeeded',
    ]);
    expect(
      sink.events.find((event) => event.event === 'dataset.lifecycle.import_file.succeeded')?.attrs
    ).toMatchObject({
      datasetId: 'dataset-imported',
      datasetName: 'Orders',
      folderId: 'folder-2',
    });
  });
});
