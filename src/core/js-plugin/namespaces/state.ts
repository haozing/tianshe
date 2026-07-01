/**
 * Plugin State Namespace
 *
 * Provides plugin-scoped state. KV operations are backed by plugin_data;
 * row state is available only through the controlled row-store contract.
 */

import type { IDuckDBService } from '../../../types/duckdb';
import type { JSPluginManifest } from '../../../types/js-plugin';
import type {
  PluginMigration,
  PluginStateMigrationOptions,
  PluginStateMutationOptions,
  PluginStateQueryOptions,
  PluginStateTransaction,
} from '../../../types/plugin-state';
import { DatabaseError } from '../errors';
import { StorageNamespace } from './storage';

export type StateClearScope = 'kv' | 'relational' | 'rows' | 'all';

export interface StateClearOptions {
  scope?: StateClearScope;
  namespace?: string;
}

export interface StateRowListOptions {
  prefix?: string;
  namespace?: string;
  limit?: number;
}

export interface StateRowsNamespace {
  get<T = unknown>(key: string, defaultValue?: T | null, options?: PluginStateQueryOptions): Promise<T | null>;
  upsert(key: string, value: unknown, options?: PluginStateMutationOptions): Promise<void>;
  delete(key: string, options?: PluginStateMutationOptions): Promise<void>;
  list<T = unknown>(options?: StateRowListOptions): Promise<Array<{ key: string; value: T; updatedAt: string | null }>>;
  clear(options?: PluginStateMutationOptions): Promise<void>;
}

export class StateNamespace {
  readonly kv = {
    get: <T = unknown>(key: string, defaultValue: T | null = null): Promise<T | null> =>
      this.get(key, defaultValue),
    set: (key: string, value: unknown): Promise<void> => this.set(key, value),
    delete: (key: string): Promise<void> => this.delete(key),
    list: (): Promise<Record<string, unknown>> => this.list(),
    clear: (): Promise<void> => this.clear({ scope: 'kv' }),
  };

  readonly rows: StateRowsNamespace = {
    get: <T = unknown>(
      key: string,
      defaultValue: T | null = null,
      options?: PluginStateQueryOptions
    ): Promise<T | null> => this.getRow(key, defaultValue, options),
    upsert: (key: string, value: unknown, options?: PluginStateMutationOptions): Promise<void> =>
      this.upsertRow(key, value, options),
    delete: (key: string, options?: PluginStateMutationOptions): Promise<void> =>
      this.deleteRows(key, options),
    list: <T = unknown>(options?: StateRowListOptions) => this.listRows<T>(options),
    clear: (options?: PluginStateMutationOptions): Promise<void> => this.clearRows(options),
  };

  constructor(
    private storage: StorageNamespace,
    private duckdb: IDuckDBService,
    private pluginId: string,
    private manifest: JSPluginManifest
  ) {}

  /**
   * Read plugin-scoped state.
   */
  async get<T = unknown>(key: string, defaultValue: T | null = null): Promise<T | null> {
    return (await this.storage.getData(key, defaultValue)) as T | null;
  }

  /**
   * Write plugin-scoped state.
   */
  async set(key: string, value: unknown): Promise<void> {
    await this.storage.setData(key, value);
  }

  /**
   * Delete one plugin-scoped state key.
   */
  async delete(key: string): Promise<void> {
    await this.storage.deleteData(key);
  }

  /**
   * List all plugin-scoped state values.
   */
  async list(): Promise<Record<string, unknown>> {
    return this.storage.getAllData();
  }

  /**
   * Clear plugin-scoped state. Defaults to KV only for backwards compatibility.
   */
  async clear(options: StateClearOptions = {}): Promise<void> {
    const scope = options.scope || 'kv';
    if (scope === 'kv') {
      await this.storage.clearAllData();
      return;
    }
    if (scope === 'relational' || scope === 'rows') {
      await this.clearRows({ namespace: options.namespace });
      return;
    }
    if (scope === 'all') {
      await this.storage.clearAllData();
      await this.clearRows({ namespace: options.namespace });
      return;
    }
    throw new DatabaseError(`Unsupported helpers.state.clear scope: ${String(scope)}`, {
      pluginId: this.pluginId,
      operation: 'state.clear',
    });
  }

  async migrate(
    migrations: PluginMigration[],
    options?: PluginStateMigrationOptions
  ): Promise<void> {
    await this.getRelationalStore().migrate(this.pluginId, migrations, options);
  }

  async query<T = Record<string, unknown>>(
    statement: string,
    params?: unknown[],
    options?: PluginStateQueryOptions
  ): Promise<T[]> {
    return this.getRelationalStore().query<T>(this.pluginId, statement, params, options);
  }

  async execute(
    statement: string,
    params?: unknown[],
    options?: PluginStateMutationOptions
  ): Promise<void> {
    await this.getRelationalStore().execute(this.pluginId, statement, params, options);
  }

  async transaction<T>(
    run: (tx: PluginStateTransaction) => Promise<T>,
    options?: PluginStateQueryOptions
  ): Promise<T> {
    return this.getRelationalStore().transaction(this.pluginId, run, options);
  }

  async getRow<T = unknown>(
    key: string,
    defaultValue: T | null = null,
    options?: PluginStateQueryOptions
  ): Promise<T | null> {
    const rows = await this.query<{ value: string }>(
      'SELECT value FROM state WHERE key = ?',
      [this.normalizeRowKey(key)],
      options
    );
    if (!rows.length) {
      return defaultValue;
    }
    return this.parseRowValue<T>(rows[0].value);
  }

  async upsertRow(
    key: string,
    value: unknown,
    options?: PluginStateMutationOptions
  ): Promise<void> {
    await this.execute(
      'INSERT INTO state (key, value) VALUES (?, ?)',
      [this.normalizeRowKey(key), JSON.stringify(value)],
      options
    );
  }

  async deleteRows(keyOrPrefix: string, options?: PluginStateMutationOptions): Promise<void> {
    const key = this.normalizeRowKey(keyOrPrefix);
    if (key.endsWith('*')) {
      await this.execute('DELETE FROM state WHERE key LIKE ?', [key.slice(0, -1) + '%'], options);
      return;
    }
    await this.execute('DELETE FROM state WHERE key = ?', [key], options);
  }

  async listRows<T = unknown>(
    options: StateRowListOptions = {}
  ): Promise<Array<{ key: string; value: T; updatedAt: string | null }>> {
    const rows = await this.getRelationalStore().listRows(this.pluginId, {
      namespace: options.namespace,
      ...(options.prefix ? { prefix: this.normalizeRowKey(options.prefix) } : {}),
      ...(typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? { limit: options.limit }
        : {}),
    });
    return rows.map((row) => ({
      key: row.key,
      value: this.parseRowValue<T>(row.value),
      updatedAt: row.updatedAt,
    }));
  }

  async clearRows(options?: PluginStateMutationOptions): Promise<void> {
    await this.execute("DELETE FROM state WHERE key LIKE '%'", [], options);
  }

  private getRelationalStore() {
    if (this.manifest.state?.rows !== true && this.manifest.state?.relational !== true) {
      throw new DatabaseError(
        'helpers.state rows API requires manifest.state.rows = true',
        {
          pluginId: this.pluginId,
          operation: 'state.rows',
        }
      );
    }

    const store = this.duckdb.getPluginStateService?.();
    if (!store) {
      throw new DatabaseError('Plugin row state backend is not available', {
        pluginId: this.pluginId,
        operation: 'state.rows',
      });
    }

    return store;
  }

  private normalizeRowKey(key: string): string {
    const normalized = String(key || '').trim();
    if (!normalized) {
      throw new DatabaseError('helpers.state.rows key must be a non-empty string', {
        pluginId: this.pluginId,
        operation: 'state.rows',
      });
    }
    return normalized;
  }

  private parseRowValue<T>(value: unknown): T {
    if (typeof value !== 'string') {
      return value as T;
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }
}
