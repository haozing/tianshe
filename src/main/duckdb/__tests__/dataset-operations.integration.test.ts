import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { QueryEngine } from '../../../core/query-engine';
import type {
  CleanConfig,
  DedupeConfig,
  FilterConfig,
  QueryConfig,
  SampleConfig,
} from '../../../core/query-engine/types';
import type { Dataset } from '../types';
import { DatasetMetadataService } from '../dataset-metadata-service';
import { DatasetStorageService } from '../dataset-storage-service';
import { DatasetExportService } from '../dataset-export-service';
import { parseRows } from '../utils';
import type { ExportOptions } from '../../../types/electron';

class TestDuckDBService {
  private queryEngine: QueryEngine | null = null;

  constructor(
    private conn: DuckDBConnection,
    private datasets: Map<string, Dataset>
  ) {}

  setQueryEngine(queryEngine: QueryEngine): void {
    this.queryEngine = queryEngine;
  }

  async getDatasetInfo(datasetId: string): Promise<Dataset | null> {
    return this.datasets.get(datasetId) ?? null;
  }

  async getDatasetTableName(datasetId: string): Promise<string> {
    return `ds_${datasetId}.data`;
  }

  async datasetExists(datasetId: string): Promise<boolean> {
    return this.datasets.has(datasetId);
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

function parseCsv(content: string): { header: string[]; rowCount: number } {
  const lines = content.trim().split(/\r?\n/);
  const header = lines[0]?.split(',') ?? [];
  return { header, rowCount: Math.max(0, lines.length - 1) };
}

describe('Dataset operations integration', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let tempDir: string;
  let datasetId: string;
  let datasetPath: string;
  let lookupDatasetId: string;
  let lookupDatasetPath: string;
  let queryEngine: QueryEngine;
  let exportService: DatasetExportService;
  let testDb: TestDuckDBService;
  let metadataService: DatasetMetadataService;

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `airpa-dataset-ops-${Date.now()}`);
    await fs.ensureDir(tempDir);

    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);

    const storageService = new DatasetStorageService(conn);
    metadataService = new DatasetMetadataService(conn, storageService);
    await metadataService.initTable();

    datasetId = 'test_ops';
    datasetPath = path.join(tempDir, `${datasetId}.duckdb`);
    const escapedPath = datasetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    await conn.run(`ATTACH '${escapedPath}' AS ds_${datasetId}`);

    await conn.run(`
      CREATE TABLE ds_${datasetId}.data (
        _row_id INTEGER,
        id INTEGER,
        name VARCHAR,
        email VARCHAR,
        city VARCHAR,
        category VARCHAR,
        status VARCHAR,
        amount DOUBLE,
        created_at TIMESTAMP,
        updated_at TIMESTAMP,
        deleted_at TIMESTAMP,
        notes VARCHAR
      )
    `);

    const rows = [
      {
        _row_id: 1,
        id: 1,
        name: ' Alice ',
        email: 'ALICE@example.com ',
        city: 'Beijing',
        category: 'A',
        status: 'active',
        amount: 10,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        deleted_at: null,
        notes: '  hello ',
      },
      {
        _row_id: 2,
        id: 2,
        name: 'Bob',
        email: 'bob@example.com',
        city: 'Shanghai',
        category: 'B',
        status: 'inactive',
        amount: 20,
        created_at: '2024-01-02T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        deleted_at: null,
        notes: 'note',
      },
      {
        _row_id: 3,
        id: 3,
        name: 'alice',
        email: 'alice@example.com',
        city: 'Beijing',
        category: 'A',
        status: 'active',
        amount: 10,
        created_at: '2024-01-03T00:00:00Z',
        updated_at: '2024-01-03T00:00:00Z',
        deleted_at: null,
        notes: 'dup',
      },
      {
        _row_id: 4,
        id: 4,
        name: 'Carol',
        email: null,
        city: null,
        category: 'B',
        status: 'active',
        amount: null,
        created_at: '2024-01-04T00:00:00Z',
        updated_at: '2024-01-04T00:00:00Z',
        deleted_at: null,
        notes: 'missing',
      },
      {
        _row_id: 5,
        id: 5,
        name: 'Dave',
        email: 'dave@example.com',
        city: 'Shenzhen',
        category: 'C',
        status: 'active',
        amount: 50,
        created_at: '2024-01-05T00:00:00Z',
        updated_at: '2024-01-05T00:00:00Z',
        deleted_at: null,
        notes: 'top',
      },
      {
        _row_id: 6,
        id: 6,
        name: 'Eve',
        email: 'eve@example.com',
        city: 'Beijing',
        category: 'C',
        status: 'inactive',
        amount: 10,
        created_at: '2024-01-06T00:00:00Z',
        updated_at: '2024-01-06T00:00:00Z',
        deleted_at: null,
        notes: 'inactive',
      },
      {
        _row_id: 7,
        id: 7,
        name: ' Frank ',
        email: 'frank@example.com',
        city: 'Beijing',
        category: 'A',
        status: 'active',
        amount: 30,
        created_at: '2024-01-07T00:00:00Z',
        updated_at: '2024-01-07T00:00:00Z',
        deleted_at: null,
        notes: 'regex:abc123',
      },
      {
        _row_id: 8,
        id: 8,
        name: 'Grace',
        email: 'grace@example.com',
        city: 'Shanghai',
        category: 'B',
        status: 'active',
        amount: 30,
        created_at: '2024-01-08T00:00:00Z',
        updated_at: '2024-01-08T00:00:00Z',
        deleted_at: null,
        notes: 'abc123',
      },
      {
        _row_id: 9,
        id: 9,
        name: 'Heidi',
        email: 'heidi@example.com',
        city: 'Shanghai',
        category: 'B',
        status: 'active',
        amount: 40,
        created_at: '2024-01-09T00:00:00Z',
        updated_at: '2024-01-09T00:00:00Z',
        deleted_at: null,
        notes: 'abc-999',
      },
      {
        _row_id: 10,
        id: 10,
        name: 'Alice',
        email: 'alice@example.com',
        city: 'Beijing',
        category: 'A',
        status: 'active',
        amount: 10,
        created_at: '2024-01-10T00:00:00Z',
        updated_at: '2024-01-10T00:00:00Z',
        deleted_at: null,
        notes: 'dup2',
      },
    ];

    const stmt = await conn.prepare(`
      INSERT INTO ds_${datasetId}.data (
        _row_id, id, name, email, city, category, status,
        amount, created_at, updated_at, deleted_at, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      stmt.bind([
        row._row_id,
        row.id,
        row.name,
        row.email,
        row.city,
        row.category,
        row.status,
        row.amount,
        row.created_at,
        row.updated_at,
        row.deleted_at,
        row.notes,
      ]);
      await stmt.run();
    }
    stmt.destroySync();

    const schema: Dataset['schema'] = [
      { name: '_row_id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
      { name: 'id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
      { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      { name: 'email', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      { name: 'city', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      { name: 'category', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      { name: 'status', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      { name: 'amount', duckdbType: 'DOUBLE', fieldType: 'number', nullable: true },
      { name: 'created_at', duckdbType: 'TIMESTAMP', fieldType: 'date', nullable: true },
      { name: 'updated_at', duckdbType: 'TIMESTAMP', fieldType: 'date', nullable: true },
      { name: 'deleted_at', duckdbType: 'TIMESTAMP', fieldType: 'date', nullable: true },
      { name: 'notes', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
    ];

    let sizeBytes = 0;
    try {
      sizeBytes = (await fs.stat(datasetPath)).size;
    } catch {
      sizeBytes = 0;
    }

    await metadataService.saveMetadata({
      id: datasetId,
      name: 'Test Ops Dataset',
      filePath: datasetPath,
      rowCount: rows.length,
      columnCount: schema.length,
      sizeBytes,
      createdAt: Date.now(),
      schema,
    });

    const datasetInfo = await metadataService.getDatasetInfo(datasetId);
    if (!datasetInfo) {
      throw new Error('Failed to load dataset metadata');
    }

    // Create a lookup dataset for JOIN tests (category code -> name)
    lookupDatasetId = 'test_lookup_categories';
    lookupDatasetPath = path.join(tempDir, `${lookupDatasetId}.duckdb`);
    const lookupEscapedPath = lookupDatasetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    await conn.run(`ATTACH '${lookupEscapedPath}' AS ds_${lookupDatasetId}`);

    await conn.run(`
      CREATE TABLE ds_${lookupDatasetId}.data (
        _row_id INTEGER,
        code VARCHAR,
        category_name VARCHAR
      )
    `);

    const lookupStmt = await conn.prepare(`
      INSERT INTO ds_${lookupDatasetId}.data (_row_id, code, category_name)
      VALUES (?, ?, ?)
    `);

    const lookupRows = [
      { _row_id: 1, code: 'A', category_name: 'Alpha' },
      { _row_id: 2, code: 'B', category_name: 'Beta' },
      // intentionally omit 'C' to produce unmatched rows in preview
    ];

    for (const row of lookupRows) {
      lookupStmt.bind([row._row_id, row.code, row.category_name]);
      await lookupStmt.run();
    }
    lookupStmt.destroySync();

    await metadataService.saveMetadata({
      id: lookupDatasetId,
      name: 'Lookup Categories',
      filePath: lookupDatasetPath,
      rowCount: lookupRows.length,
      columnCount: 3,
      sizeBytes: 0,
      createdAt: Date.now(),
      schema: [
        { name: '_row_id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
        { name: 'code', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
        { name: 'category_name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
      ],
    });

    const lookupInfo = await metadataService.getDatasetInfo(lookupDatasetId);
    if (!lookupInfo) {
      throw new Error('Failed to load lookup dataset metadata');
    }

    testDb = new TestDuckDBService(
      conn,
      new Map([
        [datasetId, datasetInfo],
        [lookupDatasetId, lookupInfo],
      ])
    );
    queryEngine = new QueryEngine(testDb as any);
    testDb.setQueryEngine(queryEngine);

    exportService = new DatasetExportService(conn, metadataService, storageService);
    exportService.setExportQuerySQLBuilder(testDb as any);
  });

  afterAll(async () => {
    try {
      if (conn && datasetId) {
        try {
          await conn.run(`DETACH ds_${datasetId}`);
        } catch {
          // ignore detach failures during cleanup
        }
      }
      if (conn && lookupDatasetId) {
        try {
          await conn.run(`DETACH ds_${lookupDatasetId}`);
        } catch {
          // ignore detach failures during cleanup
        }
      }
      conn?.closeSync();
      db?.closeSync();
    } finally {
      if (tempDir) {
        await fs.remove(tempDir);
      }
    }
  });

  it('previews filter counts', async () => {
    const filterConfig: FilterConfig = {
      combinator: 'AND',
      conditions: [{ field: 'status', type: 'equal', value: 'active' }],
    };

    const preview = await queryEngine.previewFilterCount(datasetId, filterConfig);

    expect(preview.totalRows).toBe(10);
    expect(preview.matchedRows).toBe(8);
    expect(preview.filteredRows).toBe(2);
  });

  it('executes filter + sort', async () => {
    const filterConfig: FilterConfig = {
      combinator: 'AND',
      conditions: [{ field: 'status', type: 'equal', value: 'active' }],
    };

    const result = await queryEngine.execute(datasetId, {
      filter: filterConfig,
      sort: { columns: [{ field: 'amount', direction: 'DESC' }] },
    });

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(8);
    expect(result.rows?.[0].amount).toBe(50);
  });

  it('previews clean changes', async () => {
    const cleanConfig: CleanConfig = [
      { field: 'name', operations: [{ type: 'trim' }] },
      { field: 'email', operations: [{ type: 'trim' }, { type: 'lower' }] },
    ];

    const preview = await queryEngine.preview.previewClean(datasetId, cleanConfig, { limit: 10 });
    const row = preview.cleanedData.find((item) => item._row_id === 1);

    expect(row?.name).toBe('Alice');
    expect(row?.email).toBe('alice@example.com');
    expect(preview.stats.changedRows).toBeGreaterThan(0);
  });

  it('previews dedupe stats', async () => {
    const dedupeConfig: DedupeConfig = {
      type: 'row_number',
      partitionBy: ['email'],
      orderBy: [{ field: '_row_id', direction: 'ASC' }],
      keepStrategy: 'first',
      tieBreaker: '_row_id',
    };

    const preview = await queryEngine.preview.previewDedupe(datasetId, dedupeConfig, {
      sampleSize: 5,
      limitStats: 5,
    });

    expect(preview.stats.totalRows).toBe(10);
    expect(preview.stats.duplicateGroups).toBe(1);
    expect(preview.stats.duplicateRows).toBe(2);
    expect(preview.stats.willBeRemoved).toBe(1);
  });

  it('previews dedupe stats against the pre-dedupe query context', async () => {
    const cleanConfig: CleanConfig = [
      { field: 'email', operations: [{ type: 'trim' }, { type: 'lower' }] },
    ];
    const dedupeConfig: DedupeConfig = {
      type: 'row_number',
      partitionBy: ['email'],
      orderBy: [{ field: '_row_id', direction: 'ASC' }],
      keepStrategy: 'first',
      tieBreaker: '_row_id',
    };

    const preview = await queryEngine.preview.previewDedupe(datasetId, dedupeConfig, {
      baseConfig: { clean: cleanConfig },
    });

    expect(preview.stats.totalRows).toBe(10);
    expect(preview.stats.duplicateGroups).toBe(1);
    expect(preview.stats.duplicateRows).toBe(3);
    expect(preview.stats.willBeRemoved).toBe(2);
    expect(preview.stats.willBeKept).toBe(8);
  });

  it('executes dedupe', async () => {
    const dedupeConfig: DedupeConfig = {
      type: 'row_number',
      partitionBy: ['email'],
      orderBy: [{ field: '_row_id', direction: 'ASC' }],
      keepStrategy: 'first',
      tieBreaker: '_row_id',
    };

    const result = await queryEngine.execute(datasetId, { dedupe: dedupeConfig });

    const emails = (result.rows ?? []).map((row) => row.email);
    const aliceCount = emails.filter((email) => email === 'alice@example.com').length;

    expect(result.rowCount).toBe(9);
    expect(aliceCount).toBe(1);
  });

  it('executes clean + dedupe', async () => {
    const cleanConfig: CleanConfig = [
      { field: 'email', operations: [{ type: 'trim' }, { type: 'lower' }] },
    ];
    const dedupeConfig: DedupeConfig = {
      type: 'row_number',
      partitionBy: ['email'],
      orderBy: [{ field: '_row_id', direction: 'ASC' }],
      keepStrategy: 'first',
      tieBreaker: '_row_id',
    };

    const result = await queryEngine.execute(datasetId, {
      clean: cleanConfig,
      dedupe: dedupeConfig,
    });

    const emails = (result.rows ?? []).map((row) => row.email);
    const aliceCount = emails.filter((email) => email === 'alice@example.com').length;

    expect(result.rowCount).toBe(8);
    expect(aliceCount).toBe(1);
  });

  it('previews sample with filter', async () => {
    const filterConfig: FilterConfig = {
      combinator: 'AND',
      conditions: [{ field: 'status', type: 'equal', value: 'active' }],
    };
    const sampleConfig: SampleConfig = { type: 'rows', value: 4, seed: 7 };

    const preview = await queryEngine.preview.previewSample(datasetId, sampleConfig, filterConfig);

    expect(preview.stats.originalRows).toBe(8);
    expect(preview.sampleSize).toBe(4);
  });

  it('previews sample with the full query pipeline instead of filter-only estimation', async () => {
    const preview = await queryEngine.preview.previewSample(
      datasetId,
      { type: 'rows', value: 3, seed: 7 },
      {
        sort: {
          topK: 1,
        },
      }
    );

    expect(preview.stats.originalRows).toBe(1);
    expect(preview.sampleSize).toBe(1);
  });

  it('reports quality metrics for stratified sample preview', async () => {
    const preview = await queryEngine.preview.previewSample(datasetId, {
      type: 'stratified',
      stratifyBy: ['status'],
      value: 1,
      seed: 11,
    });

    expect(preview.sampleSize).toBe(2);
    expect(preview.quality?.representativeness).toBeGreaterThan(0);
    expect(preview.quality?.distributionMatch).toBeTruthy();
  });

  it('executes sample rows', async () => {
    const sampleConfig: SampleConfig = { type: 'rows', value: 3 };
    const result = await queryEngine.execute(datasetId, { sample: sampleConfig });

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(3);
  });

  it('executes lookup join and exposes merged columns', async () => {
    const config: QueryConfig = {
      lookup: [
        {
          type: 'join',
          lookupDatasetId,
          joinKey: 'category',
          lookupKey: 'code',
          selectColumns: ['category_name'],
          leftJoin: true,
        },
      ],
    };

    const result = await queryEngine.execute(datasetId, config);
    expect(result.success).toBe(true);
    expect(result.columns).toContain('category_name');

    const rowA = (result.rows ?? []).find((row) => row.category === 'A');
    const rowB = (result.rows ?? []).find((row) => row.category === 'B');
    const rowC = (result.rows ?? []).find((row) => row.category === 'C');

    expect(rowA?.category_name).toBe('Alpha');
    expect(rowB?.category_name).toBe('Beta');
    expect(rowC?.category_name).toBeNull(); // unmatched lookup
  });

  it('previews lookup join match stats', async () => {
    const preview = await queryEngine.preview.previewLookup(
      datasetId,
      {
        type: 'join',
        lookupDatasetId,
        joinKey: 'category',
        lookupKey: 'code',
        selectColumns: ['category_name'],
        leftJoin: true,
      },
      { limit: 5 }
    );

    expect(preview.stats.totalRows).toBe(10);
    expect(preview.stats.matchedRows).toBe(8);
    expect(preview.stats.unmatchedRows).toBe(2);
    expect(preview.stats.resultRows).toBe(10);
    expect(preview.stats.duplicatedRows).toBe(0);
    expect(preview.stats.matchRate).toBeCloseTo(0.8, 5);
    expect(preview.sampleMatched.length).toBeGreaterThan(0);
    expect(preview.sampleUnmatched.length).toBeGreaterThan(0);
  });

  it('previews lookup should respect INNER JOIN result rows', async () => {
    const preview = await queryEngine.preview.previewLookup(
      datasetId,
      {
        type: 'join',
        lookupDatasetId,
        joinKey: 'category',
        lookupKey: 'code',
        selectColumns: ['category_name'],
        leftJoin: false,
      },
      { limit: 5 }
    );

    expect(preview.stats.totalRows).toBe(10);
    expect(preview.stats.matchedRows).toBe(8);
    expect(preview.stats.unmatchedRows).toBe(2);
    expect(preview.stats.resultRows).toBe(8);
    expect(preview.stats.matchRate).toBeCloseTo(0.8, 5);
  });

  it('previews lookup join should keep matchRate <= 1 in one-to-many joins', async () => {
    await conn.run(
      `INSERT INTO ds_${lookupDatasetId}.data (_row_id, code, category_name) VALUES (999, 'A', 'Alpha-2')`
    );

    try {
      const preview = await queryEngine.preview.previewLookup(
        datasetId,
        {
          type: 'join',
          lookupDatasetId,
          joinKey: 'category',
          lookupKey: 'code',
          selectColumns: ['category_name'],
          leftJoin: true,
        },
        { limit: 5 }
      );

      expect(preview.stats.totalRows).toBe(10);
      expect(preview.stats.matchedRows).toBe(8);
      expect(preview.stats.unmatchedRows).toBe(2);
      expect(preview.stats.matchRate).toBeLessThanOrEqual(1);
      expect(preview.stats.resultRows).toBe(14);
      expect(preview.stats.duplicatedRows).toBe(4);
    } finally {
      await conn.run(`DELETE FROM ds_${lookupDatasetId}.data WHERE _row_id = 999`);
    }
  });

  it('previews lookup map with correct matched/unmatched stats', async () => {
    const preview = await queryEngine.preview.previewLookup(
      datasetId,
      {
        type: 'map',
        joinKey: 'status',
        lookupKey: 'status_label',
        codeMapping: { active: 'ACTIVE' },
      },
      { limit: 5 }
    );

    expect(preview.stats.totalRows).toBe(10);
    expect(preview.stats.matchedRows).toBe(8);
    expect(preview.stats.unmatchedRows).toBe(2);
    expect(preview.stats.resultRows).toBe(10);
    expect(preview.stats.matchRate).toBeCloseTo(0.8, 5);
    expect(preview.sampleUnmatched.every((row: any) => row.status === 'inactive')).toBe(true);
  });

  it('exports dataset with lookup join columns', async () => {
    const outputPath = path.join(tempDir, 'export-lookup.csv');
    const options: ExportOptions = {
      datasetId,
      format: 'csv',
      outputPath,
      mode: 'data',
      includeHeader: true,
      respectHiddenColumns: true,
      applyFilters: true,
      applySort: false,
      applySample: false,
      postExportAction: 'keep',
      activeQueryTemplate: {
        queryConfig: {
          lookup: [
            {
              type: 'join',
              lookupDatasetId,
              joinKey: 'category',
              lookupKey: 'code',
              selectColumns: ['category_name'],
              leftJoin: true,
            },
          ],
        },
      },
    };

    const result = await exportService.exportDataset(options);
    expect(result.success).toBe(true);

    const content = await fs.readFile(outputPath, 'utf8');
    const parsed = parseCsv(content);

    expect(parsed.rowCount).toBe(10);
    expect(parsed.header).toContain('category_name');
    expect(parsed.header).not.toContain('_row_id');
    expect(content).toContain('Alpha');
    expect(content).toContain('Beta');
  });

  it('keeps filters but skips sort when applySort is false', async () => {
    const outputPath = path.join(tempDir, 'export-no-sort.json');
    const options: ExportOptions = {
      datasetId,
      format: 'json',
      outputPath,
      mode: 'data',
      includeHeader: true,
      respectHiddenColumns: true,
      applyFilters: true,
      applySort: false,
      applySample: false,
      postExportAction: 'keep',
      activeQueryTemplate: {
        queryConfig: {
          filter: {
            combinator: 'AND',
            conditions: [{ field: 'status', type: 'equal', value: 'active' }],
          },
          sort: {
            columns: [{ field: 'amount', direction: 'DESC' }],
          },
        },
      },
    };

    const result = await exportService.exportDataset(options);
    expect(result.success).toBe(true);

    const rows = await fs.readJson(outputPath);
    expect(rows).toHaveLength(8);
    expect(rows[0]?.name).toBe(' Alice ');
    expect(rows[0]?.amount).toBe(10);
  });

  it('applies sort but removes topK/pagination limits during export', async () => {
    const outputPath = path.join(tempDir, 'export-sort-without-topk.json');
    const options: ExportOptions = {
      datasetId,
      format: 'json',
      outputPath,
      mode: 'data',
      includeHeader: true,
      respectHiddenColumns: true,
      applyFilters: true,
      applySort: true,
      applySample: false,
      postExportAction: 'keep',
      activeQueryTemplate: {
        queryConfig: {
          sort: {
            columns: [{ field: 'amount', direction: 'DESC' }],
            topK: 1,
          },
        },
      },
    };

    const result = await exportService.exportDataset(options);
    expect(result.success).toBe(true);

    const rows = await fs.readJson(outputPath);
    expect(rows).toHaveLength(10);
    expect(rows[0]?.name).toBe('Dave');
    expect(rows[0]?.amount).toBe(50);
  });

  it('exports selected rows and respects hidden columns', async () => {
    const outputPath = path.join(tempDir, 'export-selected.csv');
    const options: ExportOptions = {
      datasetId,
      format: 'csv',
      outputPath,
      mode: 'data',
      includeHeader: true,
      selectedRowIds: [1, 3],
      respectHiddenColumns: true,
      applyFilters: false,
      applySort: false,
      applySample: false,
      postExportAction: 'keep',
      activeQueryTemplate: {
        queryConfig: { columns: { hide: ['notes'] } },
      },
    };

    const result = await exportService.exportDataset(options);
    expect(result.success).toBe(true);

    const content = await fs.readFile(outputPath, 'utf8');
    const parsed = parseCsv(content);

    expect(parsed.rowCount).toBe(2);
    expect(parsed.header).toContain('email');
    expect(parsed.header).not.toContain('_row_id');
    expect(parsed.header).not.toContain('notes');
  });

  it('exports selected rows from the query-backed view', async () => {
    const outputPath = path.join(tempDir, 'export-selected-query-view.csv');
    const options: ExportOptions = {
      datasetId,
      format: 'csv',
      outputPath,
      mode: 'data',
      includeHeader: true,
      selectedRowIds: [1, 3],
      respectHiddenColumns: true,
      applyFilters: true,
      applySort: false,
      applySample: false,
      postExportAction: 'keep',
      activeQueryTemplate: {
        queryConfig: {
          lookup: [
            {
              type: 'join',
              lookupDatasetId,
              joinKey: 'category',
              lookupKey: 'code',
              selectColumns: ['category_name'],
              leftJoin: true,
            },
          ],
          columns: { select: ['name', 'category_name'] },
        },
      },
    };

    const result = await exportService.exportDataset(options);
    expect(result.success).toBe(true);

    const content = await fs.readFile(outputPath, 'utf8');
    const parsed = parseCsv(content);

    expect(parsed.rowCount).toBe(2);
    expect(parsed.header).toEqual(['name', 'category_name']);
    expect(content).toContain('Alpha');
    expect(content).not.toContain('_row_id');
  });

  it('applies sample config during export when applySample is true', async () => {
    const outputPath = path.join(tempDir, 'export-sample.json');
    const options: ExportOptions = {
      datasetId,
      format: 'json',
      outputPath,
      mode: 'data',
      includeHeader: true,
      respectHiddenColumns: true,
      applyFilters: true,
      applySort: false,
      applySample: true,
      postExportAction: 'keep',
      activeQueryTemplate: {
        queryConfig: {
          sample: { type: 'rows', value: 3, seed: 7 },
        },
      },
    };

    const result = await exportService.exportDataset(options);
    expect(result.success).toBe(true);

    const rows = await fs.readJson(outputPath);
    expect(rows).toHaveLength(3);
  });

  it('respects dataset display hidden columns during export', async () => {
    await metadataService.updateColumnDisplayConfig(datasetId, 'notes', { hidden: true });

    try {
      const outputPath = path.join(tempDir, 'export-display-hidden.csv');
      const options: ExportOptions = {
        datasetId,
        format: 'csv',
        outputPath,
        mode: 'data',
        includeHeader: true,
        respectHiddenColumns: true,
        applyFilters: false,
        applySort: false,
        applySample: false,
        postExportAction: 'keep',
      };

      const result = await exportService.exportDataset(options);
      expect(result.success).toBe(true);

      const content = await fs.readFile(outputPath, 'utf8');
      const parsed = parseCsv(content);

      expect(parsed.header).toContain('email');
      expect(parsed.header).not.toContain('notes');
    } finally {
      await metadataService.updateColumnDisplayConfig(datasetId, 'notes', { hidden: false });
    }
  });

  it('allows query-template show to override dataset display hidden columns during export', async () => {
    await metadataService.updateColumnDisplayConfig(datasetId, 'notes', { hidden: true });

    try {
      const outputPath = path.join(tempDir, 'export-display-show-override.csv');
      const options: ExportOptions = {
        datasetId,
        format: 'csv',
        outputPath,
        mode: 'data',
        includeHeader: true,
        respectHiddenColumns: true,
        applyFilters: true,
        applySort: false,
        applySample: false,
        postExportAction: 'keep',
        activeQueryTemplate: {
          queryConfig: { columns: { show: ['notes'] } },
        },
      };

      const result = await exportService.exportDataset(options);
      expect(result.success).toBe(true);

      const content = await fs.readFile(outputPath, 'utf8');
      const parsed = parseCsv(content);

      expect(parsed.header).toContain('notes');
      expect(parsed.header).not.toContain('_row_id');
      expect(parsed.header).not.toContain('created_at');
      expect(parsed.header).not.toContain('updated_at');
    } finally {
      await metadataService.updateColumnDisplayConfig(datasetId, 'notes', { hidden: false });
    }
  });

  it('allows explicit column selection to override dataset display hidden columns during export', async () => {
    await metadataService.updateColumnDisplayConfig(datasetId, 'notes', { hidden: true });

    try {
      const outputPath = path.join(tempDir, 'export-display-select-override.csv');
      const options: ExportOptions = {
        datasetId,
        format: 'csv',
        outputPath,
        mode: 'data',
        includeHeader: true,
        respectHiddenColumns: true,
        applyFilters: true,
        applySort: false,
        applySample: false,
        postExportAction: 'keep',
        activeQueryTemplate: {
          queryConfig: { columns: { select: ['name', 'notes'] } },
        },
      };

      const result = await exportService.exportDataset(options);
      expect(result.success).toBe(true);

      const content = await fs.readFile(outputPath, 'utf8');
      const parsed = parseCsv(content);

      expect(parsed.header).toEqual(['name', 'notes']);
    } finally {
      await metadataService.updateColumnDisplayConfig(datasetId, 'notes', { hidden: false });
    }
  });

  it('ignores query-template hidden columns when respectHiddenColumns is false', async () => {
    const outputPath = path.join(tempDir, 'export-ignore-hidden.csv');
    const options: ExportOptions = {
      datasetId,
      format: 'csv',
      outputPath,
      mode: 'data',
      includeHeader: true,
      respectHiddenColumns: false,
      applyFilters: true,
      applySort: false,
      applySample: false,
      postExportAction: 'keep',
      activeQueryTemplate: {
        queryConfig: { columns: { hide: ['notes'] } },
      },
    };

    const result = await exportService.exportDataset(options);
    expect(result.success).toBe(true);

    const content = await fs.readFile(outputPath, 'utf8');
    const parsed = parseCsv(content);

    expect(parsed.header).toContain('notes');
  });

  it('should fail when applyFilters is true but activeQueryTemplate has no queryConfig', async () => {
    const outputPath = path.join(tempDir, 'export-missing-query-config.csv');
    const options: ExportOptions = {
      datasetId,
      format: 'csv',
      outputPath,
      mode: 'data',
      includeHeader: true,
      respectHiddenColumns: true,
      applyFilters: true,
      applySort: false,
      applySample: false,
      postExportAction: 'keep',
      activeQueryTemplate: {
        id: 'template_missing_query_config',
      },
    };

    const result = await exportService.exportDataset(options);
    expect(result.success).toBe(false);
    expect(result.error).toContain('activeQueryTemplate.queryConfig is required');
  });

  it('deletes exported rows using query-backed row ids even when _row_id is not exported', async () => {
    const outputPath = path.join(tempDir, 'export-delete-query-view.csv');
    const options: ExportOptions = {
      datasetId,
      format: 'csv',
      outputPath,
      mode: 'data',
      includeHeader: true,
      respectHiddenColumns: true,
      applyFilters: true,
      applySort: false,
      applySample: false,
      postExportAction: 'delete',
      activeQueryTemplate: {
        queryConfig: {
          filter: {
            combinator: 'AND',
            conditions: [{ field: 'status', type: 'equal', value: 'active' }],
          },
          lookup: [
            {
              type: 'join',
              lookupDatasetId,
              joinKey: 'category',
              lookupKey: 'code',
              selectColumns: ['category_name'],
              leftJoin: true,
            },
          ],
          columns: { select: ['name', 'category_name'] },
        },
      },
    };

    const result = await exportService.exportDataset(options);
    expect(result.success).toBe(true);
    expect(result.totalRows).toBe(8);
    expect(result.deletedRows).toBe(8);

    const content = await fs.readFile(outputPath, 'utf8');
    const parsed = parseCsv(content);
    expect(parsed.header).toEqual(['name', 'category_name']);
    expect(parsed.rowCount).toBe(8);

    const remainingRows = parseRows<{ count: number }>(
      await conn.runAndReadAll(`SELECT COUNT(*) as count FROM ds_${datasetId}.data`)
    );
    expect(Number(remainingRows[0]?.count ?? 0)).toBe(2);

    const remainingStatuses = parseRows<{ status: string }>(
      await conn.runAndReadAll(`SELECT DISTINCT status FROM ds_${datasetId}.data ORDER BY status`)
    );
    expect(remainingStatuses.map((row) => row.status)).toEqual(['inactive']);
  });
});
