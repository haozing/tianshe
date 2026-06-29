import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addColumnIfMissingStep,
  SchemaMigrationEngine,
  type SchemaMigration,
} from './migration-engine';
import { parseRows } from './utils';

describe('SchemaMigrationEngine', () => {
  let db: DuckDBInstance | null = null;
  let conn: DuckDBConnection | null = null;

  async function openMemoryDb(): Promise<DuckDBConnection> {
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);
    return conn;
  }

  afterEach(() => {
    conn?.closeSync();
    db?.closeSync();
    conn = null;
    db = null;
  });

  it('initializes schema_migrations and applies versioned migrations to a new table', async () => {
    const connection = await openMemoryDb();
    await connection.run(`CREATE TABLE example_items (id VARCHAR PRIMARY KEY)`);

    const engine = new SchemaMigrationEngine(connection);
    const applied = await engine.migrate([
      {
        id: 'example-001-add-status',
        description: 'Add status to example items',
        up: [addColumnIfMissingStep('example_items', 'status', `VARCHAR DEFAULT 'active'`)],
      },
    ]);

    expect(applied).toHaveLength(1);
    expect(await getColumnNames(connection, 'example_items')).toEqual(['id', 'status']);
    expect((await engine.listApplied()).map((migration) => migration.id)).toEqual([
      'example-001-add-status',
    ]);
  });

  it('upgrades a legacy table and records rollback metadata', async () => {
    const connection = await openMemoryDb();
    await connection.run(`CREATE TABLE legacy_accounts (id VARCHAR PRIMARY KEY)`);

    await new SchemaMigrationEngine(connection).migrate([
      {
        id: 'legacy-accounts-001-sync',
        description: 'Add sync flag',
        up: [addColumnIfMissingStep('legacy_accounts', 'sync_managed', 'BOOLEAN DEFAULT FALSE')],
      },
    ]);

    const applied = await new SchemaMigrationEngine(connection).listApplied();
    expect(await getColumnNames(connection, 'legacy_accounts')).toContain('sync_managed');
    expect(applied[0].rollbackSql).toContain('DROP COLUMN "sync_managed"');
  });

  it('skips already applied migrations without changing the final schema', async () => {
    const connection = await openMemoryDb();
    await connection.run(`CREATE TABLE repeat_items (id VARCHAR PRIMARY KEY)`);
    const migration: SchemaMigration = {
      id: 'repeat-001-add-columns',
      description: 'Add repeat columns',
      up: [
        addColumnIfMissingStep('repeat_items', 'name', 'VARCHAR'),
        addColumnIfMissingStep('repeat_items', 'enabled', 'BOOLEAN DEFAULT TRUE'),
      ],
    };
    const engine = new SchemaMigrationEngine(connection);

    await engine.migrate([migration]);
    const firstSchema = await getTableInfo(connection, 'repeat_items');
    const secondRun = await engine.migrate([migration]);
    const secondSchema = await getTableInfo(connection, 'repeat_items');

    expect(secondRun).toEqual([]);
    expect(secondSchema).toEqual(firstSchema);
  });

  it('rejects duplicate migration ids before applying anything', async () => {
    const connection = await openMemoryDb();
    await connection.run(`CREATE TABLE duplicate_items (id VARCHAR PRIMARY KEY)`);

    await expect(
      new SchemaMigrationEngine(connection).migrate([
        {
          id: 'duplicate-001',
          description: 'first',
          up: [addColumnIfMissingStep('duplicate_items', 'first_col', 'VARCHAR')],
        },
        {
          id: 'duplicate-001',
          description: 'second',
          up: [addColumnIfMissingStep('duplicate_items', 'second_col', 'VARCHAR')],
        },
      ])
    ).rejects.toThrow('Duplicate schema migration id: duplicate-001');
    expect(await getColumnNames(connection, 'duplicate_items')).toEqual(['id']);
  });

  it('rolls back all migration steps and the migration record when one step fails', async () => {
    const connection = await openMemoryDb();
    await connection.run(`CREATE TABLE atomic_items (id VARCHAR PRIMARY KEY)`);
    const engine = new SchemaMigrationEngine(connection);

    await expect(
      engine.migrate([
        {
          id: 'atomic-001-fail-midway',
          description: 'Fail after first schema change',
          up: [
            addColumnIfMissingStep('atomic_items', 'first_col', 'VARCHAR'),
            {
              description: 'throw after first column',
              run: async () => {
                throw new Error('boom midway');
              },
            },
          ],
        },
      ])
    ).rejects.toThrow('boom midway');

    expect(await getColumnNames(connection, 'atomic_items')).toEqual(['id']);
    expect(await engine.listApplied()).toEqual([]);

    await expect(
      engine.migrate([
        {
          id: 'atomic-001-fail-midway',
          description: 'Retry after failed migration',
          up: [
            addColumnIfMissingStep('atomic_items', 'first_col', 'VARCHAR'),
            addColumnIfMissingStep('atomic_items', 'second_col', 'VARCHAR'),
          ],
        },
      ])
    ).resolves.toHaveLength(1);

    expect(await getColumnNames(connection, 'atomic_items')).toEqual([
      'id',
      'first_col',
      'second_col',
    ]);
  });
});

async function getColumnNames(conn: DuckDBConnection, tableName: string): Promise<string[]> {
  return (await getTableInfo(conn, tableName)).map((row) => String(row.name));
}

async function getTableInfo(
  conn: DuckDBConnection,
  tableName: string
): Promise<Array<Record<string, unknown>>> {
  return parseRows(await conn.runAndReadAll(`PRAGMA table_info('${tableName}')`));
}
