import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFs = vi.hoisted(() => ({
  stat: vi.fn(),
  pathExists: vi.fn(),
  pathExistsSync: vi.fn(() => true),
  remove: vi.fn(),
}));

const workerState = vi.hoisted(() => ({
  instances: [] as any[],
}));

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: mockFs,
}));

vi.mock('../../core/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock('worker_threads', () => {
  return {
    Worker: class {
      private listeners = new Map<string, Array<(payload: any) => unknown>>();

      constructor(_filePath: string, _options: { workerData: unknown }) {
        workerState.instances.push(this);
      }

      on(event: string, listener: (payload: any) => unknown) {
        const current = this.listeners.get(event) ?? [];
        current.push(listener);
        this.listeners.set(event, current);
        return this;
      }

      async emit(event: string, payload: any) {
        for (const listener of this.listeners.get(event) ?? []) {
          await listener(payload);
        }
      }

      terminate() {
        return Promise.resolve(0);
      }
    },
  };
});

vi.mock('../../utils/id-generator', () => ({
  generateId: vi.fn(() => 'dataset_rollback_case'),
}));

vi.mock('./utils', () => ({
  getDatasetPath: vi.fn((datasetId: string) => `D:\\tmp\\${datasetId}.db`),
  getFileSize: vi.fn(async () => 256),
  parseRows: vi.fn(() => []),
  quoteIdentifier: vi.fn((value: string) => `"${value}"`),
  quoteQualifiedName: vi.fn((schema: string, table: string) => `"${schema}"."${table}"`),
  runInDuckDbTransaction: vi.fn(async (conn: any, work: () => Promise<any>) => {
    await conn.run('BEGIN TRANSACTION');
    try {
      const result = await work();
      await conn.run('COMMIT');
      return result;
    } catch (error) {
      await conn.run('ROLLBACK');
      throw error;
    }
  }),
}));

import { DatasetImportService } from './dataset-import-service';

async function waitForWorker(): Promise<any> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return workerState.instances[0];
}

describe('dataset-import-service failure cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerState.instances.length = 0;
    mockFs.stat.mockResolvedValue({ size: 128 });
    mockFs.pathExists.mockResolvedValue(true);
    mockFs.remove.mockResolvedValue(undefined);
  });

  it('cleans up generated files and metadata when saveMetadata fails after worker completion', async () => {
    const metadataService = {
      saveMetadata: vi.fn().mockRejectedValue(new Error('save metadata failed')),
      deleteMetadata: vi.fn().mockResolvedValue(undefined),
    };

    const service = new DatasetImportService({} as any, metadataService as any);
    const importPromise = service.importDatasetFile('D:\\imports\\contacts.csv', 'contacts', {
      folderId: 'folder-1',
    });
    const worker = await waitForWorker();

    await worker.emit('message', {
      type: 'complete',
      rowCount: 12,
      columnCount: 3,
      schema: [],
    });

    await expect(importPromise).rejects.toThrow('save metadata failed');
    expect(metadataService.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: 'folder-1' })
    );
    expect(metadataService.deleteMetadata).toHaveBeenCalledWith('dataset_rollback_case');
    expect(mockFs.remove).toHaveBeenCalledWith(expect.stringContaining('dataset_rollback_case'));
  });

  it('cleans up partial artifacts when worker exits unexpectedly', async () => {
    const metadataService = {
      saveMetadata: vi.fn(),
      deleteMetadata: vi.fn().mockResolvedValue(undefined),
    };

    const service = new DatasetImportService({} as any, metadataService as any);
    const importPromise = service.importDatasetFile('D:\\imports\\contacts.csv', 'contacts');
    const worker = await waitForWorker();

    await worker.emit('exit', 1);

    await expect(importPromise).rejects.toThrow('Worker exited unexpectedly with code 1');
    expect(metadataService.deleteMetadata).toHaveBeenCalledWith('dataset_rollback_case');
    expect(mockFs.remove).toHaveBeenCalledWith(expect.stringContaining('dataset_rollback_case'));
  });

  it('logs checked worker path candidates when import worker is missing', async () => {
    mockFs.pathExistsSync.mockReturnValue(false);
    const metadataService = {
      saveMetadata: vi.fn(),
      deleteMetadata: vi.fn().mockResolvedValue(undefined),
    };

    const service = new DatasetImportService({} as any, metadataService as any);
    const importPromise = service.importDatasetFile('D:\\imports\\contacts.csv', 'contacts');
    const worker = await waitForWorker();

    await worker.emit('exit', 1);

    await expect(importPromise).rejects.toThrow('Worker exited unexpectedly with code 1');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Import worker was not found in expected locations, falling back to dev path',
      expect.objectContaining({
        fallbackPath: expect.stringContaining('import-worker.js'),
        candidates: expect.arrayContaining([expect.stringContaining('import-worker.js')]),
      })
    );
  });

  it('serializes import-records insert and row_count update through the target dataset queue', async () => {
    const metadataService = {
      getDatasetInfo: vi.fn().mockResolvedValue({
        id: 'target_dataset',
        filePath: 'D:\\tmp\\target_dataset.db',
      }),
      incrementRowCount: vi.fn().mockResolvedValue(undefined),
    };
    const storageService = {
      executeInQueue: vi.fn(async (_datasetId: string, work: () => Promise<any>) => work()),
    };
    const conn = {
      run: vi.fn().mockResolvedValue({}),
      runAndReadAll: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
    };
    const parseRows = await import('./utils').then((mod) => vi.mocked(mod.parseRows));
    parseRows
      .mockReturnValueOnce([{ column_name: 'name' }])
      .mockReturnValueOnce([{ count: 2 }]);

    const service = new DatasetImportService(
      conn as any,
      metadataService as any,
      storageService as any
    );
    const promise = service.importRecordsFromFile('target_dataset', 'D:\\imports\\records.csv');
    const worker = await waitForWorker();

    await worker.emit('message', { type: 'complete' });

    await expect(promise).resolves.toEqual({ recordsInserted: 2 });
    expect(storageService.executeInQueue).toHaveBeenCalledWith(
      'target_dataset',
      expect.any(Function)
    );
    expect(metadataService.incrementRowCount).toHaveBeenCalledWith('target_dataset', 2);
  });

  it('reconciles imported row_count when delta update fails', async () => {
    const metadataService = {
      getDatasetInfo: vi.fn().mockResolvedValue({
        id: 'target_dataset',
        filePath: 'D:\\tmp\\target_dataset.db',
      }),
      incrementRowCount: vi.fn().mockRejectedValue(new Error('row_count failed')),
      reconcileRowCountInCurrentQueue: vi.fn().mockResolvedValue(2),
    };
    const storageService = {
      executeInQueue: vi.fn(async (_datasetId: string, work: () => Promise<any>) => work()),
    };
    const conn = {
      run: vi.fn().mockResolvedValue({}),
      runAndReadAll: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
    };
    const parseRows = await import('./utils').then((mod) => vi.mocked(mod.parseRows));
    parseRows
      .mockReturnValueOnce([{ column_name: 'name' }])
      .mockReturnValueOnce([{ count: 2 }]);

    const service = new DatasetImportService(
      conn as any,
      metadataService as any,
      storageService as any
    );
    const promise = service.importRecordsFromFile('target_dataset', 'D:\\imports\\records.csv');
    const worker = await waitForWorker();

    await worker.emit('message', { type: 'complete' });

    await expect(promise).resolves.toEqual({ recordsInserted: 2 });
    expect(metadataService.reconcileRowCountInCurrentQueue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'target_dataset' })
    );
  });
});
