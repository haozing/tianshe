import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFs = vi.hoisted(() => ({
  stat: vi.fn(),
  readdir: vi.fn(),
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

const mockGenerateId = vi.hoisted(() => vi.fn(() => 'dataset_rollback_case'));

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
  generateId: mockGenerateId,
}));

vi.mock('./utils', () => ({
  getDatasetPath: vi.fn((datasetId: string) => `D:\\tmp\\${datasetId}.db`),
  getImportsDir: vi.fn(() => 'D:\\tmp'),
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
    mockGenerateId.mockReset();
    mockGenerateId.mockReturnValue('dataset_rollback_case');
    mockFs.stat.mockReset();
    mockFs.readdir.mockReset();
    mockFs.pathExists.mockReset();
    mockFs.pathExistsSync.mockReset();
    mockFs.remove.mockReset();
    mockFs.stat.mockResolvedValue({ size: 128 });
    mockFs.readdir.mockResolvedValue([]);
    mockFs.pathExists.mockResolvedValue(true);
    mockFs.pathExistsSync.mockReturnValue(true);
    mockFs.remove.mockResolvedValue(undefined);
  });

  it('fails fast when the source file cannot be statted', async () => {
    mockFs.stat.mockRejectedValueOnce(new Error('ENOENT'));
    const metadataService = {
      saveMetadata: vi.fn(),
      deleteMetadata: vi.fn().mockResolvedValue(undefined),
    };

    const service = new DatasetImportService({} as any, metadataService as any);

    await expect(
      service.importDatasetFile('D:\\imports\\missing.csv', 'missing')
    ).rejects.toThrow('无法读取导入文件');
    expect(workerState.instances).toHaveLength(0);
    expect(metadataService.saveMetadata).not.toHaveBeenCalled();
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
    expect(conn.run).toHaveBeenCalledWith('DETACH "tmp_dataset_rollback_case"');
    expect(conn.run).toHaveBeenCalledWith('DETACH "ds_target_dataset"');
  });

  it('uses generated ids for import-records temp databases to avoid Date.now collisions', async () => {
    const idGenerator = await import('../../utils/id-generator');
    vi.mocked(idGenerator.generateId).mockImplementation((prefix: string) =>
      prefix === 'temp_import' ? 'temp_import_unique' : 'dataset_rollback_case'
    );
    const utils = await import('./utils');
    const getDatasetPath = vi.mocked(utils.getDatasetPath);

    const metadataService = {
      getDatasetInfo: vi.fn().mockResolvedValue({
        id: 'target_dataset',
        filePath: 'D:\\tmp\\target_dataset.db',
      }),
      incrementRowCount: vi.fn().mockResolvedValue(undefined),
    };
    const conn = {
      run: vi.fn().mockResolvedValue({}),
      runAndReadAll: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(utils.parseRows)
      .mockReturnValueOnce([{ column_name: 'name' }])
      .mockReturnValueOnce([{ count: 1 }]);

    const service = new DatasetImportService(conn as any, metadataService as any);
    const promise = service.importRecordsFromFile('target_dataset', 'D:\\imports\\records.csv');
    const worker = await waitForWorker();

    await worker.emit('message', { type: 'complete' });

    await expect(promise).resolves.toEqual({ recordsInserted: 1 });
    expect(idGenerator.generateId).toHaveBeenCalledWith('temp_import');
    expect(getDatasetPath).toHaveBeenCalledWith('temp_import_unique');
  });

  it('reconciles orphan import artifacts and missing metadata files', async () => {
    mockFs.readdir.mockResolvedValue(['dataset_orphan.db', 'notes.txt']);
    mockFs.pathExists.mockImplementation(async (filePath: string) => {
      return !filePath.includes('dataset_missing.db');
    });

    const metadataService = {
      listDatasets: vi.fn().mockResolvedValue([
        { id: 'dataset_ready', filePath: 'D:\\tmp\\dataset_ready.db' },
        { id: 'dataset_missing', filePath: 'D:\\tmp\\dataset_missing.db' },
      ]),
      deleteMetadata: vi.fn().mockResolvedValue(undefined),
    };

    const service = new DatasetImportService({} as any, metadataService as any);

    await expect(service.reconcileImportArtifacts()).resolves.toMatchObject({
      metadataChecked: 2,
      orphanMetadataDeleted: 1,
      orphanFilesDeleted: 1,
      failed: 0,
    });
    expect(metadataService.deleteMetadata).toHaveBeenCalledWith('dataset_missing');
    expect(metadataService.deleteMetadata).toHaveBeenCalledWith('dataset_orphan');
    expect(mockFs.remove).toHaveBeenCalledWith('D:\\tmp\\dataset_orphan.db');
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
