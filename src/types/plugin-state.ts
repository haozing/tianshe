export interface PluginMigration {
  id: string;
  description?: string;
  up: string[];
}

export interface PluginStateQueryOptions {
  namespace?: string;
}

export interface PluginStateMutationOptions extends PluginStateQueryOptions {}

export interface PluginStateMigrationOptions extends PluginStateQueryOptions {}

export interface PluginStateRowListOptions extends PluginStateQueryOptions {
  prefix?: string;
  limit?: number;
  orderBy?: 'key' | 'updatedAt';
  order?: 'asc' | 'desc';
}

export interface PluginStateRowRecord {
  key: string;
  value: string;
  updatedAt: string | null;
}

export interface PluginStateTransaction {
  query<T = Record<string, unknown>>(
    statement: string,
    params?: unknown[],
    options?: PluginStateQueryOptions
  ): Promise<T[]>;
  execute(
    statement: string,
    params?: unknown[],
    options?: PluginStateMutationOptions
  ): Promise<void>;
}

export interface PluginStateStore {
  migrate(
    pluginId: string,
    migrations: PluginMigration[],
    options?: PluginStateMigrationOptions
  ): Promise<void>;
  query<T = Record<string, unknown>>(
    pluginId: string,
    statement: string,
    params?: unknown[],
    options?: PluginStateQueryOptions
  ): Promise<T[]>;
  execute(
    pluginId: string,
    statement: string,
    params?: unknown[],
    options?: PluginStateMutationOptions
  ): Promise<void>;
  transaction<T>(
    pluginId: string,
    run: (tx: PluginStateTransaction) => Promise<T>,
    options?: PluginStateQueryOptions
  ): Promise<T>;
  listRows(pluginId: string, options?: PluginStateRowListOptions): Promise<PluginStateRowRecord[]>;
}
