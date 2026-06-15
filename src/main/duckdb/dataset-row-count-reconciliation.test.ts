import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatasetService } from './dataset-service';
import { DatasetMetadataService } from './dataset-metadata-service';
import { DatasetStorageService } from './dataset-storage-service';

describe('dataset row_count reconciliation', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `tianshe-row-count-${Date.now()}`);
    await fs.ensureDir(tempDir);
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);
  });

  afterEach(async () => {
    conn?.closeSync();
    db?.closeSync();
    await fs.remove(tempDir);
  });

  it('repairs stale metadata row_count during dataset service initialization', async () => {
    const service = new DatasetService(conn);
    await service.initTable();

    const datasetId = `reconcile_${Date.now()}`;
    const datasetPath = path.join(tempDir, `${datasetId}.duckdb`);
    const escapedPath = datasetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const attachKey = `ds_${datasetId}`;

    await conn.run(`ATTACH '${escapedPath}' AS ${attachKey}`);
    await conn.run(`CREATE SEQUENCE ${attachKey}.row_id_seq START 1`);
    await conn.run(`
      CREATE TABLE ${attachKey}.data (
        _row_id BIGINT DEFAULT nextval('${attachKey}.row_id_seq'),
        name VARCHAR
      )
    `);
    await conn.run(`INSERT INTO ${attachKey}.data (name) VALUES ('Ada'), ('Grace'), ('Linus')`);

    const metadataService = new DatasetMetadataService(conn, new DatasetStorageService(conn));
    await metadataService.saveMetadata({
      id: datasetId,
      name: 'Stale row count',
      filePath: datasetPath,
      rowCount: 0,
      columnCount: 2,
      sizeBytes: 0,
      createdAt: Date.now(),
      schema: [
        { name: '_row_id', duckdbType: 'BIGINT', fieldType: 'number', nullable: false },
        { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      ],
    });

    expect((await service.getDatasetInfo(datasetId))?.rowCount).toBe(0);

    const restartedService = new DatasetService(conn);
    await restartedService.initTable();

    const repairedDataset = await restartedService.getDatasetInfo(datasetId);
    expect(repairedDataset?.rowCount).toBe(3);
  });
});
