import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { DatasetFolderService } from '../dataset-folder-service';
import { DatasetMetadataService } from '../dataset-metadata-service';
import { DatasetStorageService } from '../dataset-storage-service';
import { parseRows } from '../utils';

describe('DatasetFolderService integration', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let folderService: DatasetFolderService;
  let metadataService: DatasetMetadataService;

  beforeEach(async () => {
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);

    const storageService = new DatasetStorageService(conn);
    folderService = new DatasetFolderService(conn);
    metadataService = new DatasetMetadataService(conn, storageService);

    await metadataService.initTable();
    await folderService.initTable();
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
    await conn.run(`
      CREATE TABLE IF NOT EXISTS dataset_tab_groups (
        id VARCHAR
      )
    `);
  });

  afterEach(() => {
    conn.closeSync();
    db.closeSync();
  });

  it('deletes nested folders in one transaction and moves datasets to root', async () => {
    const rootFolderId = await folderService.createFolder('Root');
    const childFolderId = await folderService.createFolder('Child', rootFolderId);

    await metadataService.saveMetadata({
      id: 'nested_dataset',
      name: 'Nested Dataset',
      filePath: 'nested_dataset.db',
      rowCount: 1,
      columnCount: 1,
      sizeBytes: 0,
      createdAt: Date.now(),
      folderId: childFolderId,
      schema: [{ name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true }],
    });

    await folderService.deleteFolder(rootFolderId, false);

    expect(await folderService.getFolder(rootFolderId)).toBeNull();
    expect(await folderService.getFolder(childFolderId)).toBeNull();

    const datasetRows = parseRows(
      await conn.runAndReadAll(`SELECT folder_id FROM datasets WHERE id = ?`, ['nested_dataset'])
    );
    expect(datasetRows[0]?.folder_id ?? null).toBeNull();
  });

  it('allows nested folders deeper than two levels', async () => {
    const rootFolderId = await folderService.createFolder('Root');
    const childFolderId = await folderService.createFolder('Child', rootFolderId);
    const grandchildFolderId = await folderService.createFolder('Grandchild', childFolderId);

    expect(await folderService.getFolder(rootFolderId)).not.toBeNull();
    expect(await folderService.getFolder(childFolderId)).not.toBeNull();
    const grandchild = await folderService.getFolder(grandchildFolderId);
    expect(grandchild?.parentId).toBe(childFolderId);
  });

  it('reorders tables and folders with bound parameters', async () => {
    const folderA = await folderService.createFolder('A');
    const folderB = await folderService.createFolder('B');

    await metadataService.saveMetadata({
      id: 'dataset_a',
      name: 'Dataset A',
      filePath: 'dataset_a.db',
      rowCount: 1,
      columnCount: 1,
      sizeBytes: 0,
      createdAt: Date.now(),
      folderId: folderA,
      tableOrder: 0,
      schema: [{ name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true }],
    });

    await metadataService.saveMetadata({
      id: 'dataset_b',
      name: 'Dataset B',
      filePath: 'dataset_b.db',
      rowCount: 1,
      columnCount: 1,
      sizeBytes: 0,
      createdAt: Date.now(),
      folderId: folderA,
      tableOrder: 1,
      schema: [{ name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true }],
    });

    await folderService.reorderTables(folderA, ['dataset_b', 'dataset_a']);
    await folderService.reorderFolders([folderB, folderA]);

    const datasetRows = parseRows(
      await conn.runAndReadAll(
        `SELECT id, table_order FROM datasets WHERE folder_id = ? ORDER BY table_order ASC`,
        [folderA]
      )
    );
    expect(datasetRows.map((row) => row.id)).toEqual(['dataset_b', 'dataset_a']);

    const folderRows = parseRows(
      await conn.runAndReadAll(
        `SELECT id, folder_order FROM dataset_folders WHERE id IN (?, ?) ORDER BY folder_order ASC`,
        [folderA, folderB]
      )
    );
    expect(folderRows.map((row) => row.id)).toEqual([folderB, folderA]);
  });

  it('does not interpolate quoted reorder ids into SQL', async () => {
    await expect(
      folderService.reorderTables("folder-x'--", ["dataset-x'--"])
    ).resolves.toBeUndefined();
    await expect(folderService.reorderFolders(["folder-x'--"])).resolves.toBeUndefined();
  });

  it('deletes nested folders and datasets when deleteContents=true', async () => {
    const rootFolderId = await folderService.createFolder('Unsafe Folder');
    const childFolderId = await folderService.createFolder('Child Folder', rootFolderId);

    await metadataService.saveMetadata({
      id: 'unsafe_dataset_root',
      name: 'Unsafe Dataset Root',
      filePath: 'unsafe_dataset_root.db',
      rowCount: 1,
      columnCount: 1,
      sizeBytes: 0,
      createdAt: Date.now(),
      folderId: rootFolderId,
      schema: [{ name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true }],
    });

    await metadataService.saveMetadata({
      id: 'unsafe_dataset_child',
      name: 'Unsafe Dataset Child',
      filePath: 'unsafe_dataset_child.db',
      rowCount: 1,
      columnCount: 1,
      sizeBytes: 0,
      createdAt: Date.now(),
      folderId: childFolderId,
      schema: [{ name: 'name', duckdbType: 'VARCHAR', fieldType: 'text', nullable: true }],
    });

    await folderService.deleteFolder(rootFolderId, true);

    expect(await folderService.getFolder(rootFolderId)).toBeNull();
    expect(await folderService.getFolder(childFolderId)).toBeNull();

    const datasetRows = parseRows(
      await conn.runAndReadAll(`SELECT id FROM datasets WHERE id IN (?, ?) ORDER BY id ASC`, [
        'unsafe_dataset_child',
        'unsafe_dataset_root',
      ])
    );
    expect(datasetRows).toEqual([]);
  }, 15000);
});
