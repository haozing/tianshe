import { describe, expect, it, vi } from 'vitest';
import { DatasetExportService } from './dataset-export-service';

describe('DatasetExportService', () => {
  const createService = () => {
    const conn = {
      runAndReadAll: vi.fn(),
    } as any;
    const metadataService = {
      getDatasetInfo: vi.fn(async (id: string) => ({
        id,
        filePath: 'C:\\tmp\\dataset.duckdb',
        schema: [{ name: 'name', fieldType: 'text' }],
      })),
    } as any;
    const storageService = {
      executeInQueue: vi.fn(async (_id: string, work: () => Promise<any>) => work()),
      smartAttach: vi.fn(async () => undefined),
    } as any;

    return {
      conn,
      storageService,
      service: new DatasetExportService(conn, metadataService, storageService),
    };
  };

  it('returns a clear initialization error for query-backed export before SQL builder injection', async () => {
    const { conn, service, storageService } = createService();

    const result = await service.exportDataset({
      datasetId: 'dataset-1',
      format: 'csv',
      outputPath: 'C:\\tmp\\export.csv',
      mode: 'data',
      includeHeader: true,
      activeQueryTemplate: {
        queryConfig: {},
      },
    } as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      'Export query SQL builder is required to rebuild export SQL from queryTemplate'
    );
    expect(storageService.smartAttach).toHaveBeenCalledWith(
      'dataset-1',
      'C:\\\\tmp\\\\dataset.duckdb'
    );
    expect(conn.runAndReadAll).not.toHaveBeenCalled();
  });
});
