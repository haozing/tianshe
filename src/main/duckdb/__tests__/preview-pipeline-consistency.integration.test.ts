import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { QueryEngine } from '../../../core/query-engine';
import type { Dataset } from '../types';
import { DatasetMetadataService } from '../dataset-metadata-service';
import { DatasetStorageService } from '../dataset-storage-service';
import { DatasetSchemaService } from '../dataset-schema-service';
import { DatasetQueryService } from '../dataset-query-service';
import { QueryTemplateService } from '../query-template-service';
import { SQLValidator } from '../sql-validator';
import { DependencyManager } from '../dependency-manager';
import { ValidationEngine } from '../validation-engine';
import { parseRows, quoteQualifiedName } from '../utils';

class MinimalDuckDBService {
  constructor(
    private conn: DuckDBConnection,
    private metadataService: DatasetMetadataService
  ) {}

  async getDatasetInfo(datasetId: string): Promise<Dataset | null> {
    return await this.metadataService.getDatasetInfo(datasetId);
  }

  async getDatasetTableName(datasetId: string): Promise<string> {
    return quoteQualifiedName(`ds_${datasetId}`, 'data');
  }

  async executeSQLWithParams(sql: string, params: any[]): Promise<any[]> {
    const stmt = await this.conn.prepare(sql);
    stmt.bind(params);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();
    return parseRows(result);
  }

  async queryDataset(
    _datasetId: string,
    sql: string
  ): Promise<{
    columns: string[];
    rows: any[];
    rowCount: number;
  }> {
    const result = await this.conn.runAndReadAll(sql);
    const rows = parseRows(result);

    return {
      columns: result.columnNames(),
      rows,
      rowCount: rows.length,
    };
  }
}

describe('preview pipeline consistency integration', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let tempDir: string;
  let metadataService: DatasetMetadataService;
  let storageService: DatasetStorageService;
  let schemaService: DatasetSchemaService;
  let queryService: DatasetQueryService;
  let queryTemplateService: QueryTemplateService;
  let queryEngine: QueryEngine;
  let datasetId: string;
  let datasetPath: string;

  const getAttachedDatabases = async () => {
    return parseRows(await conn.runAndReadAll(`SELECT database_name FROM duckdb_databases()`)).map(
      (row: any) => row.database_name
    );
  };

  const detachDatasetIfAttached = async (targetDatasetId: string) => {
    const attached = await getAttachedDatabases();
    if (attached.includes(`ds_${targetDatasetId}`)) {
      await conn.run(`DETACH ds_${targetDatasetId}`);
    }
  };

  const attachDatasetIfNeeded = async (targetDatasetId: string, targetDatasetPath: string) => {
    const attached = await getAttachedDatabases();
    if (attached.includes(`ds_${targetDatasetId}`)) {
      return;
    }

    const escapedPath = targetDatasetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    await conn.run(`ATTACH '${escapedPath}' AS ds_${targetDatasetId}`);
  };

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `airpa-preview-pipeline-${Date.now()}`);
    await fs.ensureDir(tempDir);

    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);

    storageService = new DatasetStorageService(conn);
    metadataService = new DatasetMetadataService(conn, storageService);
    await metadataService.initTable();
    await conn.run(`
      CREATE TABLE IF NOT EXISTS dataset_query_templates (
        id VARCHAR PRIMARY KEY,
        dataset_id VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        description VARCHAR,
        icon VARCHAR,
        query_config JSON NOT NULL,
        snapshot_table_name VARCHAR,
        is_default BOOLEAN DEFAULT FALSE,
        template_order INTEGER DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT,
        last_accessed_at BIGINT,
        access_count INTEGER DEFAULT 0
      )
    `);

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

    queryEngine = new QueryEngine(new MinimalDuckDBService(conn, metadataService) as any);
    queryService.setQueryEngine(queryEngine);
    queryTemplateService = new QueryTemplateService(conn);
    queryTemplateService.setQueryEngine(queryEngine);

    datasetId = 'preview_pipeline_main';
    datasetPath = path.join(tempDir, `${datasetId}.duckdb`);
    const escapedPath = datasetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");

    await conn.run(`ATTACH '${escapedPath}' AS ds_${datasetId}`);
    await conn.run(
      `CREATE TABLE ds_${datasetId}.data (_row_id INTEGER, price DOUBLE, quantity DOUBLE)`
    );
    await conn.run(`INSERT INTO ds_${datasetId}.data VALUES (3, 4, 2), (1, 10, 2), (2, 5, 7)`);
    await conn.run(`DETACH ds_${datasetId}`);

    await metadataService.saveMetadata({
      id: datasetId,
      name: 'Preview Pipeline Main',
      filePath: datasetPath,
      rowCount: 3,
      columnCount: 4,
      sizeBytes: 0,
      createdAt: Date.now(),
      schema: [
        { name: '_row_id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
        { name: 'price', duckdbType: 'DOUBLE', fieldType: 'number', nullable: false },
        { name: 'quantity', duckdbType: 'DOUBLE', fieldType: 'number', nullable: false },
        {
          name: 'total',
          duckdbType: 'DOUBLE',
          fieldType: 'number',
          nullable: true,
          storageMode: 'computed',
          computeConfig: {
            type: 'amount',
            params: {
              priceField: 'price',
              quantityField: 'quantity',
            },
          },
        },
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

  it('auto-attaches detached datasets for previewFilterCount', async () => {
    await detachDatasetIfAttached(datasetId);

    const before = await getAttachedDatabases();
    expect(before).not.toContain(`ds_${datasetId}`);

    const preview = await queryService.previewFilterCount(datasetId, {
      conditions: [{ type: 'greater_equal', field: 'price', value: 10 }],
    });

    expect(preview.totalRows).toBe(3);
    expect(preview.matchedRows).toBe(1);

    const after = await getAttachedDatabases();
    expect(after).toContain(`ds_${datasetId}`);
  });

  it('supports persisted computed columns in previewFilterCount', async () => {
    await detachDatasetIfAttached(datasetId);

    const preview = await queryService.previewFilterCount(datasetId, {
      conditions: [{ type: 'greater_than', field: 'total', value: 15 }],
    });

    expect(preview.totalRows).toBe(3);
    expect(preview.matchedRows).toBe(2);
    expect(preview.filteredRows).toBe(1);
  });

  it('supports persisted computed columns in previewAggregate', async () => {
    await detachDatasetIfAttached(datasetId);

    const preview = await queryService.previewAggregate(datasetId, {
      groupBy: ['total'],
      measures: [{ name: 'row_count', function: 'COUNT' }],
    });

    expect(preview.stats.groupCount).toBe(3);
    expect(preview.sampleRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ total: 8, row_count: 1 }),
        expect.objectContaining({ total: 20, row_count: 1 }),
        expect.objectContaining({ total: 35, row_count: 1 }),
      ])
    );
  });

  it('supports persisted computed columns and stable row ordering in previewClean', async () => {
    await attachDatasetIfNeeded(datasetId, datasetPath);

    const preview = await queryEngine.preview.previewClean(
      datasetId,
      [
        {
          field: 'total',
          operations: [{ type: 'unit_convert', params: { conversionFactor: 0.5 } }],
        },
      ],
      { limit: 10 }
    );

    expect(preview.cleanedData.map((row) => row._row_id)).toEqual([1, 2, 3]);
    expect(preview.cleanedData.map((row) => row.total)).toEqual([10, 17.5, 4]);
    expect(preview.stats.changedRows).toBe(3);
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'total', originalValue: 20, cleanedValue: 10 }),
        expect.objectContaining({ field: 'total', originalValue: 35, cleanedValue: 17.5 }),
        expect.objectContaining({ field: 'total', originalValue: 8, cleanedValue: 4 }),
      ])
    );
  });

  it('creates the default query template without materializing a snapshot table', async () => {
    await attachDatasetIfNeeded(datasetId, datasetPath);

    const template = await queryTemplateService.getOrCreateDefaultQueryTemplate(datasetId);

    expect(template.isDefault).toBe(true);
    expect(template.snapshotTableName).toBeUndefined();
  });

  it('supports persisted computed columns in execute', async () => {
    await attachDatasetIfNeeded(datasetId, datasetPath);

    const result = await queryEngine.execute(datasetId, {
      filter: {
        conditions: [{ type: 'greater_than', field: 'total', value: 15 }],
      },
      sort: {
        columns: [{ field: 'total', direction: 'ASC' }],
      },
    });

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.rows).toEqual([
      expect.objectContaining({ _row_id: 1, total: 20 }),
      expect.objectContaining({ _row_id: 2, total: 35 }),
    ]);
  });

  it('updates the default query template without rebuilding a snapshot table', async () => {
    await attachDatasetIfNeeded(datasetId, datasetPath);

    const template = await queryTemplateService.getOrCreateDefaultQueryTemplate(datasetId);

    await queryTemplateService.updateQueryTemplate(template.id, {
      queryConfig: {
        filter: {
          conditions: [{ type: 'greater_than', field: 'total', value: 15 }],
        },
        sort: {
          columns: [{ field: 'total', direction: 'ASC' }],
        },
      },
    });

    const updatedTemplate = await queryTemplateService.getQueryTemplate(template.id);
    expect(updatedTemplate?.queryConfig).toEqual({
      filter: {
        conditions: [{ type: 'greater_than', field: 'total', value: 15 }],
      },
      sort: {
        columns: [{ field: 'total', direction: 'ASC' }],
      },
    });
    expect(updatedTemplate?.snapshotTableName).toBeUndefined();
  });

  it('materializes the default query template when sampling is enabled', async () => {
    await attachDatasetIfNeeded(datasetId, datasetPath);

    const template = await queryTemplateService.getOrCreateDefaultQueryTemplate(datasetId);

    await queryTemplateService.updateQueryTemplate(template.id, {
      queryConfig: {
        sample: {
          type: 'rows',
          value: 2,
          seed: 9,
        },
      },
    });

    const updatedTemplate = await queryTemplateService.getQueryTemplate(template.id);
    expect(updatedTemplate?.snapshotTableName).toBeTruthy();

    const snapshotRows = parseRows(
      await conn.runAndReadAll(
        `SELECT _row_id FROM ${quoteQualifiedName(
          `ds_${datasetId}`,
          updatedTemplate!.snapshotTableName!
        )} ORDER BY rowid`
      )
    );

    expect(snapshotRows).toHaveLength(2);
  });

  it('returns the default query template to live mode after sampling is cleared', async () => {
    await attachDatasetIfNeeded(datasetId, datasetPath);

    const template = await queryTemplateService.getOrCreateDefaultQueryTemplate(datasetId);

    await queryTemplateService.updateQueryTemplate(template.id, {
      queryConfig: {
        sample: {
          type: 'rows',
          value: 2,
          seed: 9,
        },
      },
    });

    await queryTemplateService.updateQueryTemplate(template.id, {
      queryConfig: {},
    });

    const updatedTemplate = await queryTemplateService.getQueryTemplate(template.id);
    expect(updatedTemplate?.snapshotTableName).toBeUndefined();
  });

  it('supports persisted computed columns when rebuilding named query template snapshots', async () => {
    await attachDatasetIfNeeded(datasetId, datasetPath);

    const templateId = await queryTemplateService.createQueryTemplate({
      datasetId,
      name: `Snapshot Template ${Date.now()}`,
      queryConfig: {},
      generatedSQL: 'SELECT * FROM data',
    });

    await queryTemplateService.updateQueryTemplate(templateId, {
      queryConfig: {
        filter: {
          conditions: [{ type: 'greater_than', field: 'total', value: 15 }],
        },
        sort: {
          columns: [{ field: 'total', direction: 'ASC' }],
        },
      },
    });

    const updatedTemplate = await queryTemplateService.getQueryTemplate(templateId);
    expect(updatedTemplate?.snapshotTableName).toBeTruthy();

    const snapshotRows = parseRows(
      await conn.runAndReadAll(
        `SELECT total FROM ${quoteQualifiedName(
          `ds_${datasetId}`,
          updatedTemplate!.snapshotTableName!
        )} ORDER BY total`
      )
    );

    expect(snapshotRows).toEqual([{ total: 20 }, { total: 35 }]);
  });
});
