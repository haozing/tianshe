import { describe, expect, it, vi } from 'vitest';
import type { IDuckDBService } from '../../../types/duckdb';
import type { JSPluginManifest } from '../../../types/js-plugin';
import { StateNamespace } from './state';

function createStateNamespace(manifest?: Partial<JSPluginManifest>) {
  const storage = {
    getData: vi.fn(async () => null),
    setData: vi.fn(async () => undefined),
    deleteData: vi.fn(async () => undefined),
    getAllData: vi.fn(async () => ({})),
    clearAllData: vi.fn(async () => undefined),
  } as any;
  const store = {
    migrate: vi.fn(async () => undefined),
    query: vi.fn(async () => [{ key: 'cursor', value: '{"page":2}', updated_at: 'now' }]),
    listRows: vi.fn(async () => [{ key: 'cursor', value: '{"page":2}', updatedAt: 'now' }]),
    execute: vi.fn(async () => undefined),
    transaction: vi.fn(async (_pluginId: string, run: any, options?: any) =>
      run({
        query: vi.fn(async () => []),
        execute: vi.fn(async () => undefined),
        options,
      })
    ),
  };
  const duckdb = {
    getPluginStateService: vi.fn(() => store),
  } as unknown as IDuckDBService;
  const state = new StateNamespace(storage, duckdb, 'plugin-a', {
    id: 'plugin-a',
    name: 'Plugin A',
    version: '1.0.0',
    author: 'A',
    main: 'index.js',
    ...manifest,
  } as JSPluginManifest);

  return { state, storage, store, duckdb };
}

describe('StateNamespace', () => {
  it('keeps plugin-scoped KV state backed by storage namespace', async () => {
    const { state, storage } = createStateNamespace();

    await state.set('cursor', { page: 1 });
    await state.get('cursor');
    await state.delete('cursor');
    await state.list();
    await state.clear();
    await state.kv.clear();

    expect(storage.setData).toHaveBeenCalledWith('cursor', { page: 1 });
    expect(storage.getData).toHaveBeenCalledWith('cursor', null);
    expect(storage.deleteData).toHaveBeenCalledWith('cursor');
    expect(storage.getAllData).toHaveBeenCalled();
    expect(storage.clearAllData).toHaveBeenCalledTimes(2);
  });

  it('requires manifest.state.rows before exposing migration and transaction state', async () => {
    const { state, duckdb } = createStateNamespace();

    await expect(
      state.query('SELECT key FROM state WHERE key = ?', ['cursor'])
    ).rejects.toMatchObject({
      name: 'DatabaseError',
      details: expect.objectContaining({
        operation: 'state.rows',
      }),
    });
    expect(duckdb.getPluginStateService).not.toHaveBeenCalled();
  });

  it('forwards row state calls through the controlled plugin state service', async () => {
    const { state, store } = createStateNamespace({
      state: {
        rows: true,
      },
    });

    await state.migrate([{ id: 'm1', up: [`INSERT INTO state (key, value) VALUES ('a', '1')`] }]);
    await state.execute('INSERT INTO state (key, value) VALUES (?, ?)', ['cursor', '"1"']);
    await expect(
      state.query('SELECT key FROM state WHERE key = ?', ['cursor'])
    ).resolves.toEqual([{ key: 'cursor', value: '{"page":2}', updated_at: 'now' }]);
    await state.transaction(async (tx) => {
      await tx.execute('UPDATE state SET value = ? WHERE key = ?', ['"2"', 'cursor']);
      return 'ok';
    }, {
      namespace: 'runs',
    });

    expect(store.migrate).toHaveBeenCalledWith('plugin-a', expect.any(Array), undefined);
    expect(store.execute).toHaveBeenCalledWith(
      'plugin-a',
      'INSERT INTO state (key, value) VALUES (?, ?)',
      ['cursor', '"1"'],
      undefined
    );
    expect(store.query).toHaveBeenCalledWith(
      'plugin-a',
      'SELECT key FROM state WHERE key = ?',
      ['cursor'],
      undefined
    );
    expect(store.transaction).toHaveBeenCalledWith('plugin-a', expect.any(Function), {
      namespace: 'runs',
    });
  });

  it('keeps manifest.state.relational as a compatibility alias for row state', async () => {
    const { state, store } = createStateNamespace({
      state: {
        relational: true,
      },
    });

    await state.execute('INSERT INTO state (key, value) VALUES (?, ?)', ['cursor', '"1"']);

    expect(store.execute).toHaveBeenCalledWith(
      'plugin-a',
      'INSERT INTO state (key, value) VALUES (?, ?)',
      ['cursor', '"1"'],
      undefined
    );
  });

  it('adds row helpers and explicit clear scopes for transactional namespaced row state', async () => {
    const { state, storage, store } = createStateNamespace({
      state: {
        rows: true,
      },
    });

    await state.rows.upsert('runs:cursor', { page: 2 }, { namespace: 'runs' });
    await expect(state.rows.get('runs:cursor', null, { namespace: 'runs' })).resolves.toEqual({
      page: 2,
    });
    await expect(
      state.rows.list<{ page: number }>({ prefix: 'runs:', namespace: 'runs', limit: 10 })
    ).resolves.toEqual([
      {
        key: 'cursor',
        value: { page: 2 },
        updatedAt: 'now',
      },
    ]);
    await state.rows.delete('runs:*', { namespace: 'runs' });
    await state.clear({ scope: 'relational', namespace: 'runs' });
    await state.clear({ scope: 'all', namespace: 'runs' });

    expect(store.execute).toHaveBeenCalledWith(
      'plugin-a',
      'INSERT INTO state (key, value) VALUES (?, ?)',
      ['runs:cursor', '{"page":2}'],
      { namespace: 'runs' }
    );
    expect(store.query).toHaveBeenCalledWith(
      'plugin-a',
      'SELECT value FROM state WHERE key = ?',
      ['runs:cursor'],
      { namespace: 'runs' }
    );
    expect(store.listRows).toHaveBeenCalledWith('plugin-a', {
      namespace: 'runs',
      prefix: 'runs:',
      limit: 10,
    });
    expect(store.execute).toHaveBeenCalledWith(
      'plugin-a',
      'DELETE FROM state WHERE key LIKE ?',
      ['runs:%'],
      { namespace: 'runs' }
    );
    expect(store.execute).toHaveBeenCalledWith('plugin-a', "DELETE FROM state WHERE key LIKE '%'", [], {
      namespace: 'runs',
    });
    expect(storage.clearAllData).toHaveBeenCalledTimes(1);
  });
});
