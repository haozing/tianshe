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

vi.mock('fs-extra', () => ({
  default: mockFs,
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
});
