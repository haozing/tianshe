import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { DatasetMetadataService } from './dataset-metadata-service';
import { DatasetProvenanceService } from './dataset-provenance-service';
import { DatasetRecordMutationService } from './dataset-record-mutation-service';
import { DatasetStorageService } from './dataset-storage-service';
import { parseRows } from './utils';

describe('dataset provenance and staged write plans', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let tempDir: string;
  let datasetPath: string;
  let storageService: DatasetStorageService;
  let metadataService: DatasetMetadataService;
  let provenanceService: DatasetProvenanceService;
  let mutationService: DatasetRecordMutationService;

  const datasetId = 'test_provenance';

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `airpa-provenance-${Date.now()}`);
    await fs.ensureDir(tempDir);
    datasetPath = path.join(tempDir, `${datasetId}.duckdb`);

    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);
    storageService = new DatasetStorageService(conn);
    metadataService = new DatasetMetadataService(conn, storageService);
    provenanceService = new DatasetProvenanceService(conn);
    mutationService = new DatasetRecordMutationService({
      conn,
      storageService,
      metadataService,
      provenanceService,
      getTableName: (safeDatasetId) => `"ds_${safeDatasetId}"."data"`,
      ensureAttached: async (dataset) => {
        const escapedPath = dataset.filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        await storageService.smartAttach(dataset.id, escapedPath);
      },
    });

    await metadataService.initTable();
    await provenanceService.initTable();

    const escapedPath = datasetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    await conn.run(`ATTACH '${escapedPath}' AS "ds_${datasetId}"`);
    await conn.run(`CREATE SEQUENCE "ds_${datasetId}"."row_id_seq" START 1 INCREMENT 1`);
    await conn.run(`
      CREATE TABLE "ds_${datasetId}"."data" (
        _row_id BIGINT PRIMARY KEY DEFAULT nextval('"ds_${datasetId}"."row_id_seq"'),
        name VARCHAR NOT NULL,
        status VARCHAR,
        updated_at TIMESTAMP DEFAULT now()
      )
    `);

    await metadataService.saveMetadata({
      id: datasetId,
      name: 'Provenance Dataset',
      filePath: datasetPath,
      rowCount: 0,
      columnCount: 4,
      sizeBytes: 0,
      createdAt: Date.now(),
      schema: [
        { name: '_row_id', duckdbType: 'BIGINT', fieldType: 'number', nullable: false },
        { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: false },
        { name: 'status', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
        { name: 'updated_at', duckdbType: 'TIMESTAMP', fieldType: 'date', nullable: true },
      ],
    });
  });

  afterEach(async () => {
    try {
      await conn?.run(`DETACH "ds_${datasetId}"`);
    } catch {
      // ignore cleanup detach failures
    }
    conn?.closeSync();
    db?.closeSync();
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  it('commits staged rows and records row-level provenance', async () => {
    const plan = await mutationService.createStagedWritePlan(
      datasetId,
      [{ type: 'insert', record: { name: 'Alice', status: 'new' } }],
      {
        traceId: 'trace-dataset-1',
        adapterVersion: '1.2.3',
        runtimeId: 'electron-webcontents',
        sourceUrl: 'https://example.test/item/1',
      }
    );

    const beforeRows = parseRows(
      await conn.runAndReadAll(`SELECT COUNT(*) AS count FROM "ds_${datasetId}"."data"`)
    );
    expect(Number(beforeRows[0]?.count ?? 0)).toBe(0);

    const commit = await mutationService.commitStagedWritePlan(plan, { confirmRisk: true });
    expect(commit).toMatchObject({
      planId: plan.planId,
      datasetId,
      affectedRowCount: 1,
      provenanceRecorded: true,
    });
    expect(commit.insertedRowIds).toEqual([1]);

    const provenance = await provenanceService.listRecordProvenance(datasetId, 1);
    expect(provenance).toEqual([
      expect.objectContaining({
        datasetId,
        rowId: 1,
        runId: commit.runId,
        operation: 'insert',
        traceId: 'trace-dataset-1',
        adapterVersion: '1.2.3',
        runtimeId: 'electron-webcontents',
        sourceUrl: 'https://example.test/item/1',
      }),
    ]);

    const run = await provenanceService.getDatasetRun(datasetId, commit.runId);
    expect(run).toMatchObject({
      runId: commit.runId,
      datasetId,
      operation: 'staged_write',
      status: 'completed',
      rowCount: 1,
    });
  });

  it('persists artifact refs in provenance metadata without retaining local paths', async () => {
    await provenanceService.ensureDatasetSidecarTables(datasetId);

    const run = await provenanceService.recordRun(
      {
        runId: 'run-artifact-ref',
        datasetId,
        operation: 'staged_write',
        status: 'completed',
        traceId: 'trace-artifact-ref',
        runtimeId: 'electron-webcontents',
        rowCount: 1,
        metadata: {
          artifactRefs: ['artifact-file-1'],
          filePath: path.join(tempDir, 'secret', 'evidence.har'),
          nested: {
            storagePath: path.join(tempDir, 'secret', 'nested.png'),
          },
        },
      },
      { datasetSidecar: datasetId }
    );
    expect(run.metadata).toMatchObject({
      artifactRefs: ['artifact-file-1'],
      filePath: '[redacted-path]',
      nested: {
        storagePath: '[redacted-path]',
      },
    });

    await provenanceService.recordRows(
      [
        {
          id: 'row-artifact-ref',
          datasetId,
          rowId: 1,
          runId: run.runId,
          operation: 'insert',
          traceId: 'trace-artifact-ref',
          metadata: {
            artifactRefs: ['artifact-file-1'],
            storagePath: path.join(tempDir, 'secret', 'row.txt'),
          },
          after: {
            name: 'Evidence row',
            status: 'ok',
          },
        },
      ],
      { datasetSidecar: datasetId }
    );

    const storedRun = await provenanceService.getDatasetRun(datasetId, run.runId);
    const provenance = await provenanceService.listRecordProvenance(datasetId, 1);
    expect(storedRun?.metadata).toMatchObject({
      artifactRefs: ['artifact-file-1'],
      filePath: '[redacted-path]',
    });
    expect(provenance[0]?.metadata).toMatchObject({
      artifactRefs: ['artifact-file-1'],
      storagePath: '[redacted-path]',
    });
    expect(JSON.stringify({ storedRun, provenance })).not.toContain(tempDir);
  });

  it('rolls back rows and provenance together when a staged commit fails', async () => {
    const plan = await mutationService.createStagedWritePlan(datasetId, [
      { type: 'insert', record: { name: 'Valid row', status: 'ok' } },
      { type: 'insert', record: { status: 'missing required name' } },
    ]);

    await expect(
      mutationService.commitStagedWritePlan(plan, { confirmRisk: true })
    ).rejects.toThrow();

    const rows = parseRows(
      await conn.runAndReadAll(`SELECT COUNT(*) AS count FROM "ds_${datasetId}"."data"`)
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
    await expect(provenanceService.listRecordProvenance(datasetId, 1)).resolves.toEqual([]);
    await expect(provenanceService.getDatasetRun(datasetId, plan.planId)).resolves.toBeNull();
  });
});
