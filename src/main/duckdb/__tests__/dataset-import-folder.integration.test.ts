import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const workerState = vi.hoisted(() => ({
  instances: [] as any[],
}));

vi.mock('worker_threads', () => ({
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
}));

vi.mock('../../../utils/id-generator', () => ({
  generateId: vi.fn(() => 'dataset_imported_folder'),
}));

import { DatasetService } from '../dataset-service';
import { getDatasetPath } from '../utils';

async function waitForWorker(): Promise<any> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return workerState.instances[0];
}

describe('DatasetService importDatasetFile folder placement', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let service: DatasetService;
  let tempDir: string;
  let prevArgv: string[];

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `airpa-import-folder-test-${Date.now()}`);
    await fs.ensureDir(path.join(tempDir, 'duckdb', 'imports'));
    prevArgv = [...process.argv];
    process.argv = [
      ...prevArgv.filter((arg) => !arg.startsWith('--airpa-user-data-dir')),
      `--airpa-user-data-dir=${tempDir}`,
    ];

    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);
    service = new DatasetService(conn);
    await service.initTable();
  });

  afterAll(async () => {
    if (conn) {
      conn.closeSync();
    }
    await fs.remove(tempDir);
    process.argv = [...prevArgv];
  });

  beforeEach(() => {
    workerState.instances.length = 0;
  });

  it('persists folder_id when importing directly into a folder', async () => {
    const importFilePath = path.join(tempDir, 'contacts.csv');
    await fs.writeFile(importFilePath, 'name\nAlice\n', 'utf8');

    const importPromise = service.importDatasetFile(importFilePath, 'contacts', {
      folderId: 'folder-1',
    });
    const worker = await waitForWorker();

    await fs.ensureFile(getDatasetPath('dataset_imported_folder'));

    await worker.emit('message', {
      type: 'complete',
      rowCount: 1,
      columnCount: 1,
      schema: [{ name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true }],
    });

    const datasetId = await importPromise;
    expect(datasetId).toBe('dataset_imported_folder');

    const info = await service.getDatasetInfo(datasetId);
    expect(info?.name).toBe('contacts');
    expect(info?.folderId).toBe('folder-1');

    const folderResult = await conn.runAndReadAll(`SELECT folder_id FROM datasets WHERE id = ?`, [
      datasetId,
    ]);
    expect(String(folderResult.getRows()[0][0])).toBe('folder-1');
  });
});
