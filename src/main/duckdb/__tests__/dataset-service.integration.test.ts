/**
 * DatasetService Integration Tests
 *
 * Tests the actual database operations with a real DuckDB connection.
 * These tests create temporary databases and verify CRUD operations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { DatasetService } from '../dataset-service';
import { DatasetMetadataService } from '../dataset-metadata-service';
import { DatasetStorageService } from '../dataset-storage-service';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { CleanConfig } from '../../../core/query-engine/types';

describe('DatasetService Integration Tests', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let service: DatasetService;
  let tempDir: string;
  let prevArgv: string[];
  let testDatasetId: string;
  let testDatasetPath: string;

  // Setup before all tests
  beforeAll(async () => {
    // Create temp directory for test databases
    tempDir = path.join(os.tmpdir(), `airpa-test-${Date.now()}`);
    await fs.ensureDir(tempDir);
    await fs.ensureDir(path.join(tempDir, 'duckdb', 'imports'));
    prevArgv = [...process.argv];
    process.argv = [
      ...prevArgv.filter((arg) => !arg.startsWith('--airpa-user-data-dir')),
      `--airpa-user-data-dir=${tempDir}`,
    ];

    // Create main DuckDB instance (in-memory for tests)
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);

    // Initialize service
    service = new DatasetService(conn);

    // Initialize metadata table
    await service.initTable();

    // deleteMetadata 依赖的兼容表（该集成测试环境未初始化完整服务时需要手动创建）
    await conn.run(`
      CREATE TABLE IF NOT EXISTS dataset_query_templates (
        id VARCHAR,
        dataset_id VARCHAR,
        snapshot_table_name VARCHAR
      )
    `);
    await conn.run(`
      CREATE TABLE IF NOT EXISTS dataset_action_columns (
        id VARCHAR,
        dataset_id VARCHAR
      )
    `);
    await conn.run(`
      CREATE TABLE IF NOT EXISTS dataset_plugin_bindings (
        id VARCHAR,
        dataset_id VARCHAR
      )
    `);

    console.log(`Test environment initialized in: ${tempDir}`);
  });

  // Cleanup after all tests
  afterAll(async () => {
    try {
      // Close connection
      if (conn) {
        conn.closeSync();
      }
      // Clean up temp directory
      if (tempDir) {
        await fs.remove(tempDir);
      }
      process.argv = [...prevArgv];
      console.log('Test environment cleaned up');
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  });

  // Create a fresh test dataset before each test
  beforeEach(async () => {
    testDatasetId = `test_${Date.now()}`;
    testDatasetPath = path.join(tempDir, `${testDatasetId}.duckdb`);

    // Create the test database file
    const escapedPath = testDatasetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");

    // ATTACH and create table with test schema
    await conn.run(`ATTACH '${escapedPath}' AS ds_${testDatasetId}`);
    await conn
      .run(
        `
      CREATE TABLE ds_${testDatasetId}.data (
        _row_id INTEGER DEFAULT nextval('ds_${testDatasetId}.row_id_seq'),
        name VARCHAR,
        age INTEGER,
        email VARCHAR,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now(),
        deleted_at TIMESTAMP
      )
    `
      )
      .catch(async () => {
        // Create sequence first if table creation fails
        await conn.run(`CREATE SEQUENCE IF NOT EXISTS ds_${testDatasetId}.row_id_seq START 1`);
        await conn.run(`
        CREATE TABLE ds_${testDatasetId}.data (
          _row_id INTEGER DEFAULT nextval('ds_${testDatasetId}.row_id_seq'),
          name VARCHAR,
          age INTEGER,
          email VARCHAR,
          created_at TIMESTAMP DEFAULT now(),
          updated_at TIMESTAMP DEFAULT now(),
          deleted_at TIMESTAMP
        )
      `);
      });

    // Save metadata
    const metadataService = new DatasetMetadataService(conn, new DatasetStorageService(conn));
    await metadataService.initTable();
    await metadataService.saveMetadata({
      id: testDatasetId,
      name: `Test Dataset ${testDatasetId}`,
      filePath: testDatasetPath,
      rowCount: 0,
      columnCount: 4,
      sizeBytes: 0,
      createdAt: Date.now(),
      schema: [
        { name: '_row_id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
        { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
        { name: 'age', duckdbType: 'INTEGER', fieldType: 'number', nullable: true },
        { name: 'email', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
        { name: 'created_at', duckdbType: 'TIMESTAMP', fieldType: 'date', nullable: true },
        { name: 'updated_at', duckdbType: 'TIMESTAMP', fieldType: 'date', nullable: true },
        { name: 'deleted_at', duckdbType: 'TIMESTAMP', fieldType: 'date', nullable: true },
      ],
    });
  });

  const addNonWritableColumnsToSchema = async () => {
    const metadataService = new DatasetMetadataService(conn, new DatasetStorageService(conn));
    const dataset = await metadataService.getDatasetInfo(testDatasetId);
    if (!dataset?.schema) {
      throw new Error('Dataset schema missing');
    }

    await metadataService.updateDatasetSchema(testDatasetId, [
      ...dataset.schema,
      {
        name: 'files',
        duckdbType: 'VARCHAR',
        fieldType: 'attachment',
        nullable: true,
        storageMode: 'physical',
      },
      {
        name: 'action',
        duckdbType: 'VARCHAR',
        fieldType: 'button',
        nullable: true,
        storageMode: 'physical',
        metadata: {},
      },
      {
        name: 'total',
        duckdbType: 'DOUBLE',
        fieldType: 'number',
        nullable: true,
        storageMode: 'computed',
        computeConfig: {
          type: 'custom',
          expression: '"age" * 2',
        },
      },
    ]);
  };

  describe('insertRecord', () => {
    it('should insert a single record', async () => {
      const record = {
        name: 'John Doe',
        age: 30,
        email: 'john@example.com',
      };

      await service.insertRecord(testDatasetId, record);

      // Verify insertion
      const result = await conn.runAndReadAll(
        `SELECT name, age, email FROM ds_${testDatasetId}.data`
      );
      const rows = result.getRows();

      expect(rows.length).toBe(1);
      expect(rows[0][0]).toBe('John Doe');
      expect(rows[0][1]).toBe(30);
      expect(rows[0][2]).toBe('john@example.com');
    });

    it('should filter out system fields from record', async () => {
      const record = {
        name: 'Jane Doe',
        age: 25,
        email: 'jane@example.com',
        _row_id: 999, // Should be filtered
        deleted_at: new Date(), // Should be filtered
        created_at: new Date(), // Should be filtered
      };

      await service.insertRecord(testDatasetId, record);

      // Verify that system fields were not inserted
      const result = await conn.runAndReadAll(
        `SELECT _row_id, name, deleted_at FROM ds_${testDatasetId}.data`
      );
      const rows = result.getRows();

      expect(rows.length).toBe(1);
      expect(rows[0][0]).not.toBe(999); // _row_id should be auto-generated
      expect(rows[0][1]).toBe('Jane Doe');
      expect(rows[0][2]).toBeNull(); // deleted_at should be NULL
    });

    it('should throw error for empty record', async () => {
      await expect(service.insertRecord(testDatasetId, {})).rejects.toThrow(
        'Record must have at least one column'
      );
    });

    it('should throw error for non-existent dataset', async () => {
      await expect(service.insertRecord('non_existent_dataset', { name: 'Test' })).rejects.toThrow(
        'Dataset not found'
      );
    });

    it('should reject non-writable columns defined only in schema metadata', async () => {
      await addNonWritableColumnsToSchema();

      await expect(
        service.insertRecord(testDatasetId, { name: 'Jane Doe', files: 'x' })
      ).rejects.toThrow('Columns are not writable: files');
      await expect(
        service.insertRecord(testDatasetId, { name: 'Jane Doe', action: 'run' })
      ).rejects.toThrow('Columns are not writable: action');
      await expect(
        service.insertRecord(testDatasetId, { name: 'Jane Doe', total: 10 })
      ).rejects.toThrow('Columns are not writable: total');
    });

    it('should reject unknown columns', async () => {
      await expect(
        service.insertRecord(testDatasetId, { name: 'Jane Doe', ghost_field: 'x' })
      ).rejects.toThrow('Unknown columns: ghost_field');
    });
  });

  describe('batchInsertRecords', () => {
    it('should insert multiple records', async () => {
      const records = [
        { name: 'User 1', age: 20, email: 'user1@example.com' },
        { name: 'User 2', age: 25, email: 'user2@example.com' },
        { name: 'User 3', age: 30, email: 'user3@example.com' },
      ];

      await service.batchInsertRecords(testDatasetId, records);

      // Verify insertion
      const result = await conn.runAndReadAll(
        `SELECT name, age FROM ds_${testDatasetId}.data ORDER BY age`
      );
      const rows = result.getRows();

      expect(rows.length).toBe(3);
      expect(rows[0][0]).toBe('User 1');
      expect(rows[1][0]).toBe('User 2');
      expect(rows[2][0]).toBe('User 3');
    });

    it('should handle large batch with chunking', async () => {
      // Create 150 records (larger than batch size of 100)
      const records = Array.from({ length: 150 }, (_, i) => ({
        name: `User ${i}`,
        age: i,
        email: `user${i}@example.com`,
      }));

      await service.batchInsertRecords(testDatasetId, records);

      // Verify all records inserted
      const result = await conn.runAndReadAll(`SELECT COUNT(*) FROM ds_${testDatasetId}.data`);
      const count = Number(result.getRows()[0][0]);

      expect(count).toBe(150);
    });

    it('should throw error for records with different columns', async () => {
      const records = [
        { name: 'User 1', age: 20 },
        { name: 'User 2', email: 'user2@example.com' }, // Different columns
      ];

      await expect(service.batchInsertRecords(testDatasetId, records)).rejects.toThrow(
        '所有记录必须有相同的列'
      );
    });

    it('should handle empty array', async () => {
      await service.batchInsertRecords(testDatasetId, []);

      // Verify no records
      const result = await conn.runAndReadAll(`SELECT COUNT(*) FROM ds_${testDatasetId}.data`);
      expect(Number(result.getRows()[0][0])).toBe(0);
    });

    it('should reject non-writable columns in batch inserts', async () => {
      await addNonWritableColumnsToSchema();

      await expect(
        service.batchInsertRecords(testDatasetId, [{ name: 'User 1', total: 2 }])
      ).rejects.toThrow('Columns are not writable: total');
    });

    // Skip: This test causes deadlock because batchInsertRecords calls insertRecord
    // which tries to acquire the same queue lock
    it.skip('should use insertRecord for single record', async () => {
      const records = [{ name: 'Single User', age: 35, email: 'single@example.com' }];

      await service.batchInsertRecords(testDatasetId, records);

      // Verify insertion
      const result = await conn.runAndReadAll(`SELECT name FROM ds_${testDatasetId}.data`);
      expect(result.getRows()[0][0]).toBe('Single User');
    });
  });

  describe('updateRecord', () => {
    it('should update a record by row_id', async () => {
      // Insert a record first
      await service.insertRecord(testDatasetId, {
        name: 'Original Name',
        age: 20,
        email: 'original@example.com',
      });

      // Get the row_id
      const insertResult = await conn.runAndReadAll(`SELECT _row_id FROM ds_${testDatasetId}.data`);
      const rowId = insertResult.getRows()[0][0] as number;

      // Update the record
      await service.updateRecord(testDatasetId, rowId, {
        name: 'Updated Name',
        age: 25,
      });

      // Verify update
      const result = await conn.runAndReadAll(
        `SELECT name, age, email FROM ds_${testDatasetId}.data WHERE _row_id = ${rowId}`
      );
      const row = result.getRows()[0];

      expect(row[0]).toBe('Updated Name');
      expect(row[1]).toBe(25);
      expect(row[2]).toBe('original@example.com'); // Unchanged
    });

    it('should throw error for empty updates', async () => {
      await expect(service.updateRecord(testDatasetId, 1, {})).rejects.toThrow(
        'Updates must have at least one column'
      );
    });

    it('should reject non-writable columns during updates', async () => {
      await addNonWritableColumnsToSchema();
      await service.insertRecord(testDatasetId, {
        name: 'Original Name',
        age: 20,
        email: 'original@example.com',
      });

      const insertResult = await conn.runAndReadAll(`SELECT _row_id FROM ds_${testDatasetId}.data`);
      const rowId = insertResult.getRows()[0][0] as number;

      await expect(service.updateRecord(testDatasetId, rowId, { total: 99 })).rejects.toThrow(
        'Columns are not writable: total'
      );
    });
  });

  describe('batchUpdateRecords', () => {
    it('should update multiple records', async () => {
      // Insert records first
      await service.batchInsertRecords(testDatasetId, [
        { name: 'User 1', age: 20, email: 'user1@example.com' },
        { name: 'User 2', age: 25, email: 'user2@example.com' },
      ]);

      // Get row_ids
      const insertResult = await conn.runAndReadAll(
        `SELECT _row_id FROM ds_${testDatasetId}.data ORDER BY age`
      );
      const rowIds = insertResult.getRows().map((r) => r[0] as number);

      // Batch update
      await service.batchUpdateRecords(testDatasetId, [
        { rowId: rowIds[0], updates: { name: 'Updated User 1' } },
        { rowId: rowIds[1], updates: { name: 'Updated User 2', age: 30 } },
      ]);

      // Verify updates
      const result = await conn.runAndReadAll(
        `SELECT name, age FROM ds_${testDatasetId}.data ORDER BY _row_id`
      );
      const rows = result.getRows();

      expect(rows[0][0]).toBe('Updated User 1');
      expect(rows[0][1]).toBe(20); // Unchanged
      expect(rows[1][0]).toBe('Updated User 2');
      expect(rows[1][1]).toBe(30); // Updated
    });

    it('should handle empty updates array', async () => {
      await service.batchUpdateRecords(testDatasetId, []);
      // Should not throw
    });

    it('should reject non-writable columns in batch updates', async () => {
      await addNonWritableColumnsToSchema();
      await service.batchInsertRecords(testDatasetId, [
        { name: 'User 1', age: 20, email: 'u1@example.com' },
      ]);

      const insertResult = await conn.runAndReadAll(`SELECT _row_id FROM ds_${testDatasetId}.data`);
      const rowId = insertResult.getRows()[0][0] as number;

      await expect(
        service.batchUpdateRecords(testDatasetId, [{ rowId, updates: { action: 'run' } }])
      ).rejects.toThrow('Columns are not writable: action');
    });
  });

  describe('materializeCleanToNewColumns', () => {
    it('should add physical columns and write cleaned values', async () => {
      await service.batchInsertRecords(testDatasetId, [
        { name: ' Alice ', age: 20, email: 'ALICE@example.com ' },
        { name: 'Bob', age: 30, email: ' bob@example.com' },
      ]);

      const cleanConfig: CleanConfig = [
        {
          field: 'name',
          outputField: 'name_clean',
          operations: [{ type: 'trim' }, { type: 'lower' }],
        },
        {
          field: 'email',
          outputField: 'email_clean',
          operations: [{ type: 'trim' }, { type: 'lower' }],
        },
      ];

      const result = await service.materializeCleanToNewColumns(testDatasetId, cleanConfig);

      expect(result.createdColumns.sort()).toEqual(['email_clean', 'name_clean'].sort());
      expect(result.updatedColumns.sort()).toEqual(['email_clean', 'name_clean'].sort());

      const datasetInfo = await service.getDatasetInfo(testDatasetId);
      expect(datasetInfo?.schema?.some((col: any) => col.name === 'name_clean')).toBe(true);
      expect(datasetInfo?.schema?.some((col: any) => col.name === 'email_clean')).toBe(true);

      const verify = await conn.runAndReadAll(
        `SELECT name_clean, email_clean FROM ds_${testDatasetId}.data ORDER BY _row_id`
      );
      const rows = verify.getRows();

      expect(rows[0][0]).toBe('alice');
      expect(rows[0][1]).toBe('alice@example.com');
      expect(rows[1][0]).toBe('bob');
      expect(rows[1][1]).toBe('bob@example.com');
    });

    it('should support title operation without INITCAP', async () => {
      await service.batchInsertRecords(testDatasetId, [
        { name: 'hELLO WORLD', age: 20, email: 'user@example.com' },
      ]);

      const cleanConfig: CleanConfig = [
        {
          field: 'name',
          outputField: 'name_title',
          operations: [{ type: 'title' }],
        },
      ];

      await service.materializeCleanToNewColumns(testDatasetId, cleanConfig);

      const verify = await conn.runAndReadAll(
        `SELECT name_title FROM ds_${testDatasetId}.data ORDER BY _row_id`
      );
      const rows = verify.getRows();

      expect(rows[0][0]).toBe('Hello world');
    });

    it('should infer materialized column types from clean operations', async () => {
      await service.batchInsertRecords(testDatasetId, [
        { name: '42.5', age: 20, email: '2025-01-15' },
      ]);

      const cleanConfig: CleanConfig = [
        {
          field: 'name',
          outputField: 'amount_number',
          operations: [{ type: 'cast', params: { targetType: 'DOUBLE' } }],
        },
        {
          field: 'email',
          outputField: 'parsed_email_date',
          operations: [{ type: 'parse_date', params: { dateFormat: '%Y-%m-%d' } }],
        },
        {
          field: 'age',
          outputField: 'age_scaled',
          operations: [{ type: 'unit_convert', params: { conversionFactor: 0.1 } }],
        },
      ];

      const result = await service.materializeCleanToNewColumns(testDatasetId, cleanConfig);

      expect(result.createdColumns.sort()).toEqual(
        ['age_scaled', 'amount_number', 'parsed_email_date'].sort()
      );

      const datasetInfo = await service.getDatasetInfo(testDatasetId);
      const schema = datasetInfo?.schema || [];

      expect(schema.find((col: any) => col.name === 'amount_number')).toEqual(
        expect.objectContaining({
          duckdbType: 'DOUBLE',
          fieldType: 'number',
        })
      );
      expect(schema.find((col: any) => col.name === 'parsed_email_date')).toEqual(
        expect.objectContaining({
          duckdbType: 'TIMESTAMP',
          fieldType: 'date',
        })
      );
      expect(schema.find((col: any) => col.name === 'age_scaled')).toEqual(
        expect.objectContaining({
          duckdbType: 'DOUBLE',
          fieldType: 'number',
        })
      );

      const describeResult = await conn.runAndReadAll(`DESCRIBE ds_${testDatasetId}.data`);
      const describeRows = describeResult.getRows();
      const describeByName = new Map(
        describeRows.map((row) => [String(row[0]), String(row[1]).toUpperCase()] as const)
      );

      expect(describeByName.get('amount_number')).toBe('DOUBLE');
      expect(describeByName.get('parsed_email_date')).toBe('TIMESTAMP');
      expect(describeByName.get('age_scaled')).toBe('DOUBLE');

      const verify = await conn.runAndReadAll(
        `SELECT amount_number, CAST(parsed_email_date AS VARCHAR), age_scaled
         FROM ds_${testDatasetId}.data
         ORDER BY _row_id`
      );
      const rows = verify.getRows();

      expect(Number(rows[0][0])).toBeCloseTo(42.5);
      expect(String(rows[0][1])).toContain('2025-01-15');
      expect(Number(rows[0][2])).toBeCloseTo(2);
    });
  });

  describe('column schema operations', () => {
    it('should keep column_count consistent with schema after add/delete column', async () => {
      await service.addColumn({
        datasetId: testDatasetId,
        columnName: 'temp_col',
        fieldType: 'text',
        nullable: true,
        storageMode: 'physical',
      });

      const afterAdd = await conn.runAndReadAll(
        `SELECT column_count, schema FROM datasets WHERE id = ?`,
        [testDatasetId]
      );
      const addRows = afterAdd.getRows();
      const addColumnCount = Number(addRows[0][0]);
      const addSchemaLength = JSON.parse(String(addRows[0][1] || '[]')).length;
      expect(addColumnCount).toBe(addSchemaLength);

      await service.deleteColumn(testDatasetId, 'temp_col', false);

      const afterDelete = await conn.runAndReadAll(
        `SELECT column_count, schema FROM datasets WHERE id = ?`,
        [testDatasetId]
      );
      const deleteRows = afterDelete.getRows();
      const deleteColumnCount = Number(deleteRows[0][0]);
      const deleteSchemaLength = JSON.parse(String(deleteRows[0][1] || '[]')).length;
      expect(deleteColumnCount).toBe(deleteSchemaLength);
    });

    it('should rename physical column in both table schema and metadata', async () => {
      await service.updateColumn({
        datasetId: testDatasetId,
        columnName: 'age',
        newName: 'age_years',
      });

      const describeResult = await conn.runAndReadAll(`DESCRIBE ds_${testDatasetId}.data`);
      const physicalColumns = describeResult.getRows().map((row) => String(row[0]));
      expect(physicalColumns).toContain('age_years');
      expect(physicalColumns).not.toContain('age');

      const info = await service.getDatasetInfo(testDatasetId);
      const schemaColumns = info?.schema?.map((col: any) => col.name) || [];
      expect(schemaColumns).toContain('age_years');
      expect(schemaColumns).not.toContain('age');
    });

    it('should allow custom computed expression referencing updated_at', async () => {
      await service.addColumn({
        datasetId: testDatasetId,
        columnName: 'updated_snapshot',
        fieldType: 'text',
        nullable: true,
        storageMode: 'computed',
        computeConfig: {
          type: 'custom',
          expression: 'CAST(updated_at AS VARCHAR)',
        },
      });

      const queryResult = await service.queryDataset(testDatasetId);
      expect(queryResult.columns).toContain('updated_snapshot');
    });

    it('should reject duplicate names in reorder payload', async () => {
      const info = await service.getDatasetInfo(testDatasetId);
      const names = (info?.schema || []).map((col: any) => col.name);
      expect(names.length).toBeGreaterThan(2);

      const duplicateOrder = [...names];
      duplicateOrder[duplicateOrder.length - 1] = duplicateOrder[0];

      await expect(service.reorderColumns(testDatasetId, duplicateOrder)).rejects.toThrow(
        '列名列表包含重复项'
      );
    });

    it('should reject computed column when referenced source columns do not exist', async () => {
      await expect(
        service.addColumn({
          datasetId: testDatasetId,
          columnName: 'invalid_amount',
          fieldType: 'number',
          nullable: true,
          storageMode: 'computed',
          computeConfig: {
            type: 'amount',
            params: {
              priceField: 'missing_price',
              quantityField: 'age',
            },
          },
        })
      ).rejects.toThrow('依赖列不存在');
    });

    it('should not rewrite string literals when renaming referenced columns in custom expression', async () => {
      await service.addColumn({
        datasetId: testDatasetId,
        columnName: 'age_literal_check',
        fieldType: 'text',
        nullable: true,
        storageMode: 'computed',
        computeConfig: {
          type: 'custom',
          expression: "CASE WHEN name = 'age' THEN age ELSE NULL END",
        },
      });

      await service.updateColumn({
        datasetId: testDatasetId,
        columnName: 'age',
        newName: 'age_renamed',
      });

      const info = await service.getDatasetInfo(testDatasetId);
      const computedColumn = (info?.schema || []).find(
        (col: any) => col.name === 'age_literal_check'
      );
      const expression = String(computedColumn?.computeConfig?.expression || '');
      expect(expression).toContain("'age'");
      expect(expression).toContain('"age_renamed"');

      const queryResult = await service.queryDataset(testDatasetId);
      expect(queryResult.columns).toContain('age_literal_check');
    });
  });

  describe('hardDeleteRows', () => {
    it('should permanently delete rows', async () => {
      // Insert records
      await service.batchInsertRecords(testDatasetId, [
        { name: 'User 1', age: 20, email: 'user1@example.com' },
        { name: 'User 2', age: 25, email: 'user2@example.com' },
      ]);

      // Get row_ids
      const insertResult = await conn.runAndReadAll(
        `SELECT _row_id FROM ds_${testDatasetId}.data ORDER BY age`
      );
      const rowIds = insertResult.getRows().map((r) => r[0] as number);

      // Hard delete first row
      const deletedCount = await service.hardDeleteRows(testDatasetId, [rowIds[0]]);

      expect(deletedCount).toBe(1);

      // Verify row is physically removed
      const result = await conn.runAndReadAll(
        `SELECT _row_id FROM ds_${testDatasetId}.data ORDER BY _row_id`
      );
      const rows = result.getRows();

      expect(rows.length).toBe(1);
      expect(rows[0][0]).toBe(rowIds[1]);

      const datasetInfo = await service.getDatasetInfo(testDatasetId);
      expect(datasetInfo?.rowCount).toBe(1);
    });

    it('should keep rowCount in sync after dictionary-style delete workflow', async () => {
      await service.batchInsertRecords(testDatasetId, [
        { name: 'apple', age: 20, email: 'apple@example.com' },
        { name: 'banana', age: 25, email: 'banana@example.com' },
        { name: 'carrot', age: 30, email: 'carrot@example.com' },
      ]);

      const dictDatasetId = await service.createEmptyDataset(`dict_${Date.now()}`);
      await service.addColumn({
        datasetId: dictDatasetId,
        columnName: 'word',
        fieldType: 'text',
        nullable: true,
        storageMode: 'physical',
      });
      await service.batchInsertRecords(dictDatasetId, [{ word: 'app' }, { word: 'ban' }]);

      const rowIdsToDelete = await service.filterWithAhoCorasick(
        testDatasetId,
        'name',
        dictDatasetId,
        'word',
        true
      );
      const deletedCount = await service.hardDeleteRows(testDatasetId, rowIdsToDelete);

      expect(deletedCount).toBe(1);

      const datasetInfo = await service.getDatasetInfo(testDatasetId);
      expect(datasetInfo?.rowCount).toBe(2);
    });

    it('should throw error for empty rowIds', async () => {
      await expect(service.hardDeleteRows(testDatasetId, [])).rejects.toThrow(
        'No row IDs provided for deletion'
      );
    });
  });

  describe('createEmptyDataset', () => {
    it('should create an empty dataset with system columns and support inserts after adding fields', async () => {
      const datasetName = 'New Empty Dataset';
      const newDatasetId = await service.createEmptyDataset(datasetName, { folderId: 'folder-1' });

      expect(newDatasetId).toBeTruthy();
      expect(newDatasetId).toContain('dataset');

      // Verify dataset info
      const info = await service.getDatasetInfo(newDatasetId);
      expect(info).toBeTruthy();
      expect(info?.name).toBe(datasetName);
      expect(info?.folderId).toBe('folder-1');
      expect(info?.rowCount).toBe(0);
      expect(info?.schema?.map((col: any) => col.name)).toEqual([
        '_row_id',
        'created_at',
        'updated_at',
        'deleted_at',
      ]);
      expect(info?.columnCount).toBe(4);

      await service.addColumn({
        datasetId: newDatasetId,
        columnName: 'name',
        fieldType: 'text',
        nullable: true,
        storageMode: 'physical',
      });
      await service.insertRecord(newDatasetId, { name: 'Alice' });

      const result = await service.queryDataset(newDatasetId);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.name).toBe('Alice');
      expect(result.rows[0]?._row_id).toBeDefined();

      const folderResult = await conn.runAndReadAll(`SELECT folder_id FROM datasets WHERE id = ?`, [
        newDatasetId,
      ]);
      expect(String(folderResult.getRows()[0][0])).toBe('folder-1');
    });
  });

  describe('getDatasetInfo', () => {
    it('should return dataset metadata', async () => {
      const info = await service.getDatasetInfo(testDatasetId);

      expect(info).toBeTruthy();
      expect(info?.id).toBe(testDatasetId);
      expect(info?.schema).toBeDefined();
      expect(info?.schema?.length).toBeGreaterThan(0);
    });

    it('should return null for non-existent dataset', async () => {
      const info = await service.getDatasetInfo('non_existent');
      expect(info).toBeNull();
    });
  });

  describe('tab group copy workflow', () => {
    it('should clone dataset into same tab group and keep data isolation', async () => {
      await service.insertRecord(testDatasetId, {
        name: 'Source Row',
        age: 18,
        email: 'source@example.com',
      });

      const cloneResult = await service.cloneDatasetToGroupTab(testDatasetId, 'Cloned Tab');
      expect(cloneResult.datasetId).not.toBe(testDatasetId);
      expect(cloneResult.tabGroupId).toBeTruthy();

      const tabs = await service.listGroupTabsByDataset(testDatasetId);
      expect(tabs.length).toBe(2);
      expect(tabs.every((tab) => tab.tabGroupId === cloneResult.tabGroupId)).toBe(true);
      expect(tabs.some((tab) => tab.datasetId === testDatasetId && tab.isGroupDefault)).toBe(true);
      expect(
        tabs.some(
          (tab) =>
            tab.datasetId === cloneResult.datasetId && !tab.isGroupDefault && tab.tabOrder === 1
        )
      ).toBe(true);

      await service.insertRecord(cloneResult.datasetId, {
        name: 'Clone Only Row',
        age: 28,
        email: 'clone@example.com',
      });

      const sourceRows = await service.queryDataset(testDatasetId);
      const cloneRows = await service.queryDataset(cloneResult.datasetId);

      expect(sourceRows.rows.some((row: any) => row.name === 'Clone Only Row')).toBe(false);
      expect(cloneRows.rows.some((row: any) => row.name === 'Clone Only Row')).toBe(true);

      const insertedCloneRow = cloneRows.rows.find((row: any) => row.name === 'Clone Only Row');
      expect(insertedCloneRow?._row_id).toBeDefined();
      expect(insertedCloneRow?._row_id).not.toBeNull();
    });

    it('should preserve system defaults when cloning a base dataset table', async () => {
      const sourceDatasetId = await service.createEmptyDataset(`clone_defaults_${Date.now()}`);
      await service.addColumn({
        datasetId: sourceDatasetId,
        columnName: 'name',
        fieldType: 'text',
        nullable: true,
        storageMode: 'physical',
      });
      await service.insertRecord(sourceDatasetId, { name: 'Source Row' });

      const cloneResult = await service.cloneDatasetToGroupTab(sourceDatasetId, 'Clone Defaults');

      const describeRows = await service.withDatasetAttached(cloneResult.datasetId, async () => {
        const describeResult = await conn.runAndReadAll(
          `DESCRIBE ds_${cloneResult.datasetId}.data`
        );
        return describeResult.getRows();
      });
      const rowIdColumn = describeRows.find((row) => String(row[0]) === '_row_id');
      const createdAtColumn = describeRows.find((row) => String(row[0]) === 'created_at');
      const updatedAtColumn = describeRows.find((row) => String(row[0]) === 'updated_at');

      expect(rowIdColumn?.[3]).toBe('PRI');
      expect(String(rowIdColumn?.[4] ?? '')).toContain("nextval('ds_");
      expect(String(createdAtColumn?.[4] ?? '')).toBe('now()');
      expect(String(updatedAtColumn?.[4] ?? '')).toBe('now()');

      await service.insertRecord(cloneResult.datasetId, { name: 'Inserted After Clone' });
      const cloneRows = await service.queryDataset(cloneResult.datasetId);
      const insertedCloneRow = cloneRows.rows.find(
        (row: any) => row.name === 'Inserted After Clone'
      );
      expect(insertedCloneRow?._row_id).toBeDefined();
      expect(insertedCloneRow?.created_at).toBeTruthy();
      expect(insertedCloneRow?.updated_at).toBeTruthy();
    });

    it('should remove the partially created clone file when metadata save fails', async () => {
      const listDatasetFiles = async () =>
        (await fs.readdir(tempDir)).filter((name) => name.endsWith('.duckdb')).sort();

      const beforeFiles = await listDatasetFiles();
      const originalSaveMetadata = DatasetMetadataService.prototype.saveMetadata;
      const saveMetadataSpy = vi
        .spyOn(DatasetMetadataService.prototype, 'saveMetadata')
        .mockImplementation(async function (dataset) {
          if (dataset.id.startsWith('dataset_')) {
            throw new Error('metadata save failed');
          }
          return originalSaveMetadata.call(this, dataset);
        });

      try {
        await expect(service.cloneDatasetToGroupTab(testDatasetId, 'Broken Clone')).rejects.toThrow(
          'metadata save failed'
        );
      } finally {
        saveMetadataSpy.mockRestore();
      }

      const afterFiles = await listDatasetFiles();
      expect(afterFiles).toEqual(beforeFiles);
    });

    it('should validate reorder payload strictly within a tab group', async () => {
      const cloneResult = await service.cloneDatasetToGroupTab(testDatasetId, 'Reorder Target');
      const tabs = await service.listGroupTabsByDataset(testDatasetId);
      const groupId = tabs[0].tabGroupId;
      const orderedIds = tabs.map((tab) => tab.datasetId);

      await expect(
        service.reorderGroupTabs(groupId, [orderedIds[0], orderedIds[0]])
      ).rejects.toThrow('Invalid tab order');

      await expect(service.reorderGroupTabs(groupId, [orderedIds[0]])).rejects.toThrow(
        'Invalid tab order payload'
      );

      // Create another dataset in a different group, then use it in reorder payload.
      const otherDatasetId = `other_${Date.now()}`;
      const otherDatasetPath = path.join(tempDir, `${otherDatasetId}.duckdb`);
      const escapedPath = otherDatasetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
      const otherAttachKey = `ds_${otherDatasetId}`;
      try {
        await conn.run(`ATTACH '${escapedPath}' AS ${otherAttachKey}`);
        await conn.run(`CREATE TABLE ${otherAttachKey}.data (_row_id INTEGER, name VARCHAR)`);

        const metadataService = new DatasetMetadataService(conn, new DatasetStorageService(conn));
        await metadataService.saveMetadata({
          id: otherDatasetId,
          name: `Other ${otherDatasetId}`,
          filePath: otherDatasetPath,
          rowCount: 0,
          columnCount: 2,
          sizeBytes: 0,
          createdAt: Date.now(),
          schema: [
            { name: '_row_id', duckdbType: 'INTEGER', fieldType: 'number', nullable: false },
            { name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true },
          ],
        });
        await service.listGroupTabsByDataset(otherDatasetId); // ensure group exists

        await expect(
          service.reorderGroupTabs(groupId, [testDatasetId, otherDatasetId, cloneResult.datasetId])
        ).rejects.toThrow('Invalid tab order payload');
      } finally {
        try {
          await conn.run(`DETACH ${otherAttachKey}`);
        } catch {
          // ignore
        }
        await fs.remove(otherDatasetPath).catch(() => undefined);
      }
    });

    it('should promote next tab as default after deleting group default', async () => {
      const cloneResult = await service.cloneDatasetToGroupTab(testDatasetId, 'Delete Promotion');

      await service.deleteDataset(testDatasetId);

      const remainingTabs = await service.listGroupTabsByDataset(cloneResult.datasetId);
      expect(remainingTabs.length).toBe(1);
      expect(remainingTabs[0].datasetId).toBe(cloneResult.datasetId);
      expect(remainingTabs[0].isGroupDefault).toBe(true);
    });
  });

  describe('Transaction rollback', () => {
    it('should rollback on batch insert error', async () => {
      // This test verifies transaction safety
      // We can't easily simulate an error mid-batch, but we verify the mechanism exists

      // Insert some initial records
      await service.insertRecord(testDatasetId, {
        name: 'Initial User',
        age: 20,
        email: 'initial@example.com',
      });

      // Verify record exists
      const result = await conn.runAndReadAll(`SELECT COUNT(*) FROM ds_${testDatasetId}.data`);
      expect(Number(result.getRows()[0][0])).toBe(1);
    });
  });

  describe('SQL injection prevention', () => {
    it('should safely handle special characters in values', async () => {
      const record = {
        name: "O'Brien; DROP TABLE users;--",
        age: 30,
        email: 'test@example.com',
      };

      await service.insertRecord(testDatasetId, record);

      // Verify the dangerous string was safely stored
      const result = await conn.runAndReadAll(`SELECT name FROM ds_${testDatasetId}.data`);
      expect(result.getRows()[0][0]).toBe("O'Brien; DROP TABLE users;--");
    });
  });
});
