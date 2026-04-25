import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { QueryEngine } from '../../../core/query-engine';
import type { QueryConfig } from '../../../core/query-engine/types';
import type { Dataset } from '../types';
import { DatasetMetadataService } from '../dataset-metadata-service';
import { DatasetStorageService } from '../dataset-storage-service';
import { DatasetSchemaService } from '../dataset-schema-service';
import { DatasetQueryService } from '../dataset-query-service';
import { SQLValidator } from '../sql-validator';
import { DependencyManager } from '../dependency-manager';
import { ValidationEngine } from '../validation-engine';
import { parseRows, quoteQualifiedName } from '../utils';

class MinimalDuckDBService {
  private queryEngine: QueryEngine | null = null;

  constructor(
    private conn: DuckDBConnection,
    private metadataService: DatasetMetadataService
  ) {}

  setQueryEngine(queryEngine: QueryEngine): void {
    this.queryEngine = queryEngine;
  }

  async getDatasetInfo(datasetId: string): Promise<Dataset | null> {
    return await this.metadataService.getDatasetInfo(datasetId);
  }

  async getDatasetTableName(datasetId: string): Promise<string> {
    // Relying on DatasetQueryService to smartAttach before querying.
    return quoteQualifiedName(`ds_${datasetId}`, 'data');
  }

  async datasetExists(datasetId: string): Promise<boolean> {
    return (await this.metadataService.getDatasetInfo(datasetId)) !== null;
  }

  async queryDataset(_datasetId: string, sql: string) {
    const result = await this.conn.runAndReadAll(sql);
    const rows = parseRows(result);
    return {
      columns: result.columnNames(),
      rows,
      rowCount: rows.length,
    };
  }

  async executeSQLWithParams(sql: string, params: any[]): Promise<any[]> {
    const stmt = await this.conn.prepare(sql);
    stmt.bind(params);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();
    return parseRows(result);
  }

  async buildExportSQL(datasetId: string, queryConfig: QueryConfig): Promise<string> {
    if (!this.queryEngine) {
      throw new Error('QueryEngine not initialized');
    }

    const configWithoutPagination: QueryConfig = {
      ...queryConfig,
      sort: queryConfig.sort
        ? {
            ...queryConfig.sort,
            pagination: undefined,
            topK: undefined,
          }
        : undefined,
    };

    let sql = await this.queryEngine.buildSQL(datasetId, configWithoutPagination);

    const hasExplicitLimit = !!(
      configWithoutPagination.sort?.pagination || configWithoutPagination.sort?.topK
    );
    if (!hasExplicitLimit) {
      sql = sql.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/gi, '');
    }

    return sql;
  }

  async filterWithAhoCorasick(): Promise<number[]> {
    throw new Error('Aho-Corasick path is not enabled in this test suite');
  }

  async createTempRowIdTable(): Promise<void> {}

  async dropTempRowIdTable(): Promise<void> {}
}

describe('previewLookup auto-attach integration', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let tempDir: string;
  let metadataService: DatasetMetadataService;
  let storageService: DatasetStorageService;
  let schemaService: DatasetSchemaService;
  let queryService: DatasetQueryService;
  let duckdbService: MinimalDuckDBService;
  let queryEngine: QueryEngine;
  let datasetId: string;
  let datasetPath: string;
  let lookupDatasetId: string;
  let lookupDatasetPath: string;

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `airpa-lookup-preview-${Date.now()}`);
    await fs.ensureDir(tempDir);

    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);

    storageService = new DatasetStorageService(conn);
    metadataService = new DatasetMetadataService(conn, storageService);
    await metadataService.initTable();

    const sqlValidator = new SQLValidator(conn);
    const dependencyManager = new DependencyManager();
    const validationEngine = new ValidationEngine(conn);
    schemaService = new DatasetSchemaService(
      conn,
      metadataService,
      storageService,
      sqlValidator,
      dependencyManager,
      validationEngine
    );

    queryService = new DatasetQueryService(conn, metadataService, schemaService, storageService);

    duckdbService = new MinimalDuckDBService(conn, metadataService);
    queryEngine = new QueryEngine(duckdbService as any);
    duckdbService.setQueryEngine(queryEngine);
    queryService.setQueryEngine(queryEngine);

    datasetId = 'preview_main';
    datasetPath = path.join(tempDir, `${datasetId}.duckdb`);
    const escapedMain = datasetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");

    // Create main dataset file + table, then DETACH (so preview must smartAttach later)
    await conn.run(`ATTACH '${escapedMain}' AS ds_${datasetId}`);
    await conn.run(`CREATE TABLE ds_${datasetId}.data (_row_id INTEGER, category VARCHAR)`);
    await conn.run(`INSERT INTO ds_${datasetId}.data VALUES (1, 'A'), (2, 'B'), (3, 'C')`);
    await conn.run(`DETACH ds_${datasetId}`);

    lookupDatasetId = 'preview_lookup';
    lookupDatasetPath = path.join(tempDir, `${lookupDatasetId}.duckdb`);
    const escapedLookup = lookupDatasetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");

    await conn.run(`ATTACH '${escapedLookup}' AS ds_${lookupDatasetId}`);
    await conn.run(
      `CREATE TABLE ds_${lookupDatasetId}.data (_row_id INTEGER, code VARCHAR, label VARCHAR)`
    );
    await conn.run(
      `INSERT INTO ds_${lookupDatasetId}.data VALUES (1, 'A', 'Alpha'), (2, 'B', 'Beta')`
    );
    await conn.run(`DETACH ds_${lookupDatasetId}`);

    await metadataService.saveMetadata({
      id: datasetId,
      name: 'Preview Main',
      filePath: datasetPath,
      rowCount: 3,
      columnCount: 2,
      sizeBytes: 0,
      createdAt: Date.now(),
      schema: [
        { name: '_row_id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
        { name: 'category', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      ],
    });

    await metadataService.saveMetadata({
      id: lookupDatasetId,
      name: 'Preview Lookup',
      filePath: lookupDatasetPath,
      rowCount: 2,
      columnCount: 3,
      sizeBytes: 0,
      createdAt: Date.now(),
      schema: [
        { name: '_row_id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
        { name: 'code', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
        { name: 'label', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      ],
    });
  });

  afterAll(async () => {
    try {
      conn?.closeSync();
      db?.closeSync();
    } finally {
      if (tempDir) {
        await fs.remove(tempDir);
      }
    }
  });

  it('attaches datasets and returns match stats', async () => {
    // Sanity: datasets start detached
    const before = parseRows(
      await conn.runAndReadAll(`SELECT database_name FROM duckdb_databases()`)
    ).map((r: any) => r.database_name);
    expect(before).not.toContain(`ds_${datasetId}`);
    expect(before).not.toContain(`ds_${lookupDatasetId}`);

    const preview = await queryService.previewLookup(
      datasetId,
      {
        type: 'join',
        lookupDatasetId,
        joinKey: 'category',
        lookupKey: 'code',
        selectColumns: ['label'],
        leftJoin: true,
      },
      { limit: 5 }
    );

    expect(preview.stats.totalRows).toBe(3);
    expect(preview.stats.matchedRows).toBe(2);
    expect(preview.stats.unmatchedRows).toBe(1);

    const after = parseRows(
      await conn.runAndReadAll(`SELECT database_name FROM duckdb_databases()`)
    ).map((r: any) => r.database_name);
    expect(after).toContain(`ds_${datasetId}`);
    expect(after).toContain(`ds_${lookupDatasetId}`);
  });
});
