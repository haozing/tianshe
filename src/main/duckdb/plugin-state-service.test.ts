import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginStateService } from './plugin-state-service';
import { parseRows } from './utils';

describe('PluginStateService', () => {
  let db: DuckDBInstance | null = null;
  let conn: DuckDBConnection | null = null;

  async function openService(): Promise<PluginStateService> {
    db = await DuckDBInstance.create(':memory:');
    conn = await DuckDBConnection.create(db);
    return new PluginStateService(conn);
  }

  afterEach(() => {
    conn?.closeSync();
    db?.closeSync();
    conn = null;
    db = null;
  });

  it('rewrites logical state table access into the plugin namespace', async () => {
    const service = await openService();

    await service.execute('plugin-a', 'INSERT INTO state (key, value) VALUES (?, ?)', [
      'cursor',
      '{"page":1}',
    ]);
    await service.execute('plugin-b', 'INSERT INTO state (key, value) VALUES (?, ?)', [
      'cursor',
      '{"page":2}',
    ]);

    await expect(
      service.query('plugin-a', 'SELECT key, value FROM plugin_relational_state')
    ).rejects.toMatchObject({
      name: 'DatabaseError',
      details: expect.not.objectContaining({ sql: expect.anything() }),
    });
    await expect(
      service.query('plugin-a', 'SELECT key, value FROM state JOIN accounts ON true')
    ).rejects.toMatchObject({
      name: 'DatabaseError',
      details: expect.not.objectContaining({ sql: expect.anything() }),
    });

    await expect(
      service.query<{ key: string }>('plugin-a', 'SELECT key FROM state')
    ).resolves.toEqual([
      {
        key: 'cursor',
      },
    ]);
  });

  it('rolls back transaction writes when a state operation fails', async () => {
    const service = await openService();

    await expect(
      service.transaction('plugin-a', async (tx) => {
        await tx.execute('INSERT INTO state (key, value) VALUES (?, ?)', ['step', '"one"']);
        await tx.execute('DROP TABLE accounts');
      })
    ).rejects.toMatchObject({
      name: 'DatabaseError',
    });

    await expect(service.query('plugin-a', 'SELECT key FROM state')).resolves.toEqual([]);
  });

  it('keeps UPDATE assignment params before injected namespace params', async () => {
    const service = await openService();

    await service.execute('plugin-a', 'INSERT INTO state (key, value) VALUES (?, ?)', [
      'cursor',
      '1',
    ]);
    await service.execute('plugin-a', 'UPDATE state SET value = ? WHERE key = ?', [
      '2',
      'cursor',
    ]);

    await expect(
      service.query<{ value: string }>('plugin-a', 'SELECT value FROM state WHERE key = ?', [
        'cursor',
      ])
    ).resolves.toEqual([{ value: '2' }]);
  });

  it('lists row state through the structured row API without expanding the SQL subset', async () => {
    const service = await openService();

    await service.execute('plugin-a', 'INSERT INTO state (key, value) VALUES (?, ?)', [
      'runs:1',
      '{"page":1}',
    ]);
    await service.execute('plugin-a', 'INSERT INTO state (key, value) VALUES (?, ?)', [
      'runs:2',
      '{"page":2}',
    ]);
    await service.execute('plugin-a', 'INSERT INTO state (key, value) VALUES (?, ?)', [
      'other:1',
      '{"page":3}',
    ]);
    await service.execute('plugin-b', 'INSERT INTO state (key, value) VALUES (?, ?)', [
      'runs:1',
      '{"page":99}',
    ]);

    await expect(
      service.listRows('plugin-a', { prefix: 'runs:', limit: 1 })
    ).resolves.toEqual([
      expect.objectContaining({
        key: 'runs:1',
        value: '{"page":1}',
        updatedAt: expect.any(String),
      }),
    ]);
    await expect(
      service.listRows('plugin-b', { prefix: 'runs:' })
    ).resolves.toEqual([
      expect.objectContaining({
        key: 'runs:1',
        value: '{"page":99}',
      }),
    ]);
    await expect(
      service.query('plugin-a', 'SELECT key FROM state WHERE key LIKE ? OR value LIKE ?', [
        'runs:%',
        '%page%',
      ])
    ).rejects.toMatchObject({
      name: 'DatabaseError',
    });
  });

  it('wraps backend execution errors without leaking rewritten SQL or params', async () => {
    const service = await openService();

    try {
      await service.query('plugin-a', 'SELECT key FROM state WHERE key = ?', []);
      throw new Error('expected query to fail');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'DatabaseError',
        message: 'Plugin state backend operation failed',
        details: expect.objectContaining({
          operation: 'state.query',
        }),
      });
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain('plugin_relational_state');
      expect(serialized).not.toContain('plugin-a');
      expect(serialized).not.toContain('SELECT key FROM');
    }
  });

  it('wraps backend mutation errors without leaking params', async () => {
    const service = await openService();

    try {
      await service.execute('plugin-a', 'INSERT INTO state (key, value) VALUES (?, ?)', [
        'secret-key',
      ]);
      throw new Error('expected execute to fail');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'DatabaseError',
        message: 'Plugin state backend operation failed',
        details: expect.objectContaining({
          operation: 'state.execute',
        }),
      });
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain('secret-key');
      expect(serialized).not.toContain('plugin_relational_state');
    }
  });

  it('applies migrations atomically and rejects checksum drift', async () => {
    const service = await openService();
    await service.migrate('plugin-a', [
      {
        id: 'state-001-seed',
        description: 'seed state',
        up: [
          `INSERT INTO state (key, value) VALUES ('first', '1')`,
          `INSERT INTO state (key, value) VALUES ('second', '2')`,
        ],
      },
    ], {
      namespace: 'runs',
    });

    await expect(
      service.query('plugin-a', 'SELECT key FROM state ORDER BY key ASC', [], {
        namespace: 'runs',
      })
    ).resolves.toEqual([{ key: 'first' }, { key: 'second' }]);
  });

  it('rolls back failed migrations and blocks checksum conflicts', async () => {
    const service = await openService();

    await expect(
      service.migrate('plugin-a', [
        {
          id: 'state-001-fail',
          up: [
            `INSERT INTO state (key, value) VALUES ('before-fail', '1')`,
            'DELETE FROM accounts WHERE id = ?',
          ],
        },
      ])
    ).rejects.toMatchObject({ name: 'DatabaseError' });

    expect(await getStateRows()).toEqual([]);
    expect(await getMigrationRows()).toEqual([]);

    const migration = {
      id: 'state-001-ok',
      description: 'ok',
      up: [`INSERT INTO state (key, value) VALUES ('ok', '1')`],
    };
    await service.migrate('plugin-a', [migration]);
    await expect(
      service.migrate('plugin-a', [
        {
          ...migration,
          up: ['INSERT INTO state (key, value) VALUES (?, ?)', 'DELETE FROM state WHERE key = ?'],
        },
      ])
    ).rejects.toMatchObject({
      name: 'DatabaseError',
      details: expect.objectContaining({
        migrationId: 'state-001-ok',
      }),
    });
  });

  async function getStateRows(): Promise<Array<Record<string, unknown>>> {
    if (!(await tableExists('plugin_relational_state'))) {
      return [];
    }
    return parseRows(
      await conn!.runAndReadAll('SELECT plugin_id, namespace, key FROM plugin_relational_state')
    );
  }

  async function getMigrationRows(): Promise<Array<Record<string, unknown>>> {
    if (!(await tableExists('plugin_state_migrations'))) {
      return [];
    }
    return parseRows(
      await conn!.runAndReadAll('SELECT plugin_id, namespace, migration_id FROM plugin_state_migrations')
    );
  }

  async function tableExists(tableName: string): Promise<boolean> {
    const rows = parseRows<{ table_name?: string; name?: string }>(
      await conn!.runAndReadAll(`PRAGMA show_tables`)
    );
    return rows.some((row) => row.name === tableName || row.table_name === tableName);
  }
});
