import { createHash } from 'node:crypto';
import type { DuckDBConnection } from '@duckdb/node-api';
import type {
  PluginMigration,
  PluginStateMigrationOptions,
  PluginStateMutationOptions,
  PluginStateQueryOptions,
  PluginStateRowListOptions,
  PluginStateRowRecord,
  PluginStateStore,
  PluginStateTransaction,
} from '../../types/plugin-state';
import { DatabaseError } from '../../core/js-plugin/errors';
import { parseRows, quoteIdentifier, runInDuckDbTransaction } from './utils';
import { allPrepared, runPrepared } from './statement-executor';

const STATE_TABLE_NAME = 'plugin_relational_state';
const MIGRATION_TABLE_NAME = 'plugin_state_migrations';
const DEFAULT_NAMESPACE = 'default';
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type PluginStateStatementKind = 'select' | 'insert' | 'update' | 'delete';

interface RewriteResult {
  sql: string;
  params: unknown[];
  kind: PluginStateStatementKind;
}

interface PluginStateExecutionTarget {
  run(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
  execute(sql: string, params: unknown[]): Promise<void>;
}

export class PluginStateService implements PluginStateStore {
  constructor(private readonly conn: DuckDBConnection) {}

  async migrate(
    pluginId: string,
    migrations: PluginMigration[],
    options?: PluginStateMigrationOptions
  ): Promise<void> {
    const namespace = normalizeNamespace(options?.namespace);
    assertPluginId(pluginId);
    assertMigrationList(migrations);

    await runInDuckDbTransaction(this.conn, async () => {
      const target = this.createTarget();
      await this.ensureTables(target);

      for (const migration of migrations) {
        const checksum = getPluginMigrationChecksum(migration);
        const rows = await target.query<{ checksum: string }>(
          `SELECT checksum FROM ${quoteIdentifier(MIGRATION_TABLE_NAME)}
           WHERE plugin_id = ? AND namespace = ? AND migration_id = ?`,
          [pluginId, namespace, migration.id]
        );

        if (rows.length > 0) {
          if (String(rows[0].checksum) !== checksum) {
            throw new DatabaseError('Plugin state migration checksum mismatch', {
              pluginId,
              namespace,
              migrationId: migration.id,
              operation: 'state.migrate',
            });
          }
          continue;
        }

        const tx = this.createTransaction(pluginId, namespace, target);
        for (const statement of migration.up) {
          await tx.execute(statement);
        }

        await target.execute(
          `INSERT INTO ${quoteIdentifier(MIGRATION_TABLE_NAME)}
             (plugin_id, namespace, migration_id, checksum, description, applied_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            pluginId,
            namespace,
            migration.id,
            checksum,
            migration.description ?? null,
            Date.now(),
          ]
        );
      }
    });
  }

  async query<T = Record<string, unknown>>(
    pluginId: string,
    statement: string,
    params?: unknown[],
    options?: PluginStateQueryOptions
  ): Promise<T[]> {
    const namespace = normalizeNamespace(options?.namespace);
    assertPluginId(pluginId);
    const target = this.createTarget();
    await this.ensureTables(target);
    const rewrite = rewritePluginStateStatement(statement, params ?? [], {
      pluginId,
      namespace,
      expectedKinds: new Set(['select']),
    });
    return target.query<T>(rewrite.sql, rewrite.params);
  }

  async execute(
    pluginId: string,
    statement: string,
    params?: unknown[],
    options?: PluginStateMutationOptions
  ): Promise<void> {
    const namespace = normalizeNamespace(options?.namespace);
    assertPluginId(pluginId);
    const target = this.createTarget();
    await this.ensureTables(target);
    const rewrite = rewritePluginStateStatement(statement, params ?? [], {
      pluginId,
      namespace,
      expectedKinds: new Set(['insert', 'update', 'delete']),
    });
    await target.execute(rewrite.sql, rewrite.params);
  }

  async transaction<T>(
    pluginId: string,
    run: (tx: PluginStateTransaction) => Promise<T>,
    options?: PluginStateQueryOptions
  ): Promise<T> {
    const namespace = normalizeNamespace(options?.namespace);
    assertPluginId(pluginId);

    return runInDuckDbTransaction(this.conn, async () => {
      const target = this.createTarget();
      await this.ensureTables(target);
      return run(this.createTransaction(pluginId, namespace, target));
    });
  }

  async listRows(
    pluginId: string,
    options: PluginStateRowListOptions = {}
  ): Promise<PluginStateRowRecord[]> {
    const namespace = normalizeNamespace(options.namespace);
    assertPluginId(pluginId);
    const target = this.createTarget();
    await this.ensureTables(target);

    const where: string[] = ['plugin_id = ?', 'namespace = ?'];
    const params: unknown[] = [pluginId, namespace];
    if (options.prefix) {
      where.push('key LIKE ?');
      params.push(`${normalizeStateRowPrefix(options.prefix)}%`);
    }

    const orderColumn = options.orderBy === 'updatedAt' ? 'updated_at' : 'key';
    const order = options.order === 'desc' ? 'DESC' : 'ASC';
    const limit =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.max(1, Math.min(500, Math.trunc(options.limit)))
        : 500;

    const rows = await target.query<{ key: string; value: string; updated_at?: string | null }>(
      `SELECT key, value, updated_at FROM ${quoteIdentifier(STATE_TABLE_NAME)}
       WHERE ${where.join(' AND ')}
       ORDER BY ${quoteIdentifier(orderColumn)} ${order}, ${quoteIdentifier('key')} ASC
       LIMIT ?`,
      [...params, limit]
    );
    return rows.map((row) => ({
      key: String(row.key || ''),
      value: String(row.value ?? ''),
      updatedAt: row.updated_at == null ? null : String(row.updated_at),
    }));
  }

  private createTransaction(
    pluginId: string,
    namespace: string,
    target: PluginStateExecutionTarget
  ): PluginStateTransaction {
    return {
      query: async <T = Record<string, unknown>>(
        statement: string,
        params?: unknown[],
        options?: PluginStateQueryOptions
      ) => {
        const rewrite = rewritePluginStateStatement(statement, params ?? [], {
          pluginId,
          namespace: normalizeNamespace(options?.namespace ?? namespace),
          expectedKinds: new Set(['select']),
        });
        return target.query<T>(rewrite.sql, rewrite.params);
      },
      execute: async (
        statement: string,
        params?: unknown[],
        options?: PluginStateMutationOptions
      ) => {
        const rewrite = rewritePluginStateStatement(statement, params ?? [], {
          pluginId,
          namespace: normalizeNamespace(options?.namespace ?? namespace),
          expectedKinds: new Set(['insert', 'update', 'delete']),
        });
        await target.execute(rewrite.sql, rewrite.params);
      },
    };
  }

  private createTarget(): PluginStateExecutionTarget {
    return {
      run: async (sql) => {
        try {
          await this.conn.run(sql);
        } catch (error) {
          throw wrapStateBackendError(error, 'state.internal');
        }
      },
      query: async <T = Record<string, unknown>>(sql: string, params: unknown[]) => {
        try {
          const result = await allPrepared(this.conn, sql, params);
          return parseRows<T>(result);
        } catch (error) {
          throw wrapStateBackendError(error, 'state.query');
        }
      },
      execute: async (sql: string, params: unknown[]) => {
        try {
          await runPrepared(this.conn, sql, params);
        } catch (error) {
          throw wrapStateBackendError(error, 'state.execute');
        }
      },
    };
  }

  private async ensureTables(target: PluginStateExecutionTarget): Promise<void> {
    await target.run(`
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(STATE_TABLE_NAME)} (
        plugin_id VARCHAR NOT NULL,
        namespace VARCHAR NOT NULL,
        key VARCHAR NOT NULL,
        value JSON,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (plugin_id, namespace, key)
      )
    `);
    await target.run(`
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(MIGRATION_TABLE_NAME)} (
        plugin_id VARCHAR NOT NULL,
        namespace VARCHAR NOT NULL,
        migration_id VARCHAR NOT NULL,
        checksum VARCHAR NOT NULL,
        description TEXT,
        applied_at BIGINT NOT NULL,
        PRIMARY KEY (plugin_id, namespace, migration_id)
      )
    `);
  }
}

function rewritePluginStateStatement(
  statement: string,
  params: unknown[],
  options: {
    pluginId: string;
    namespace: string;
    expectedKinds: Set<PluginStateStatementKind>;
  }
): RewriteResult {
  assertStateStatementInput(statement, params);
  const trimmed = stripTrailingSemicolon(statement.trim());
  const kind = getStatementKind(trimmed);
  if (!options.expectedKinds.has(kind)) {
    throw new DatabaseError('Plugin state statement kind is not allowed here', {
      pluginId: options.pluginId,
      namespace: options.namespace,
      operation: 'state.statement',
      statementKind: kind,
    });
  }

  switch (kind) {
    case 'select':
      return rewriteSelect(trimmed, params, options);
    case 'insert':
      return rewriteInsert(trimmed, params, options);
    case 'update':
      return rewriteUpdate(trimmed, params, options);
    case 'delete':
      return rewriteDelete(trimmed, params, options);
  }
}

function rewriteSelect(
  statement: string,
  params: unknown[],
  options: { pluginId: string; namespace: string }
): RewriteResult {
  const match = statement.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s+state(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\?|\d+))?(?:\s+OFFSET\s+(\?|\d+))?\s*$/i);
  if (!match) {
    throwStateSqlError('Only SELECT ... FROM state with optional WHERE/ORDER BY/LIMIT/OFFSET is allowed');
  }

  const projection = validateProjection(match[1]);
  const where = match[2] ? ` AND ${validateWhereClause(match[2])}` : '';
  const orderBy = match[3] ? ` ORDER BY ${validateOrderByClause(match[3])}` : '';
  const limit = match[4] ? ` LIMIT ${match[4]}` : '';
  const offset = match[5] ? ` OFFSET ${match[5]}` : '';

  return {
    kind: 'select',
    sql:
      `SELECT ${projection} FROM ${quoteIdentifier(STATE_TABLE_NAME)} ` +
      `WHERE plugin_id = ? AND namespace = ?${where}${orderBy}${limit}${offset}`,
    params: [options.pluginId, options.namespace, ...params],
  };
}

function rewriteInsert(
  statement: string,
  params: unknown[],
  options: { pluginId: string; namespace: string }
): RewriteResult {
  const match = statement.match(/^\s*INSERT\s+INTO\s+state\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)(?:\s+ON\s+CONFLICT\s*\(\s*key\s*\)\s+DO\s+UPDATE\s+SET\s+value\s*=\s*excluded\.value\s*,\s*updated_at\s*=\s*excluded\.updated_at)?\s*$/i);
  if (!match) {
    throwStateSqlError(
      'Only INSERT INTO state (key, value[, updated_at]) VALUES (...) with optional key upsert is allowed'
    );
  }

  const columns = parseColumnList(match[1]);
  if (
    columns.length < 2 ||
    columns.length > 3 ||
    columns[0] !== 'key' ||
    columns[1] !== 'value' ||
    (columns[2] !== undefined && columns[2] !== 'updated_at')
  ) {
    throwStateSqlError('State INSERT columns must be (key, value) or (key, value, updated_at)');
  }

  const values = parseValueList(match[2]);
  if (values.length !== columns.length) {
    throwStateSqlError('State INSERT values must match the column list');
  }

  const updatedAtValue = columns.includes('updated_at') ? values[2] : '?';
  const rewrittenValues = [
    '?',
    '?',
    values[0],
    values[1],
    updatedAtValue,
  ].join(', ');
  const rewrittenParams = columns.includes('updated_at')
    ? [options.pluginId, options.namespace, ...params]
    : [options.pluginId, options.namespace, ...params, Date.now()];

  return {
    kind: 'insert',
    sql:
      `INSERT INTO ${quoteIdentifier(STATE_TABLE_NAME)} ` +
      `(plugin_id, namespace, key, value, updated_at) VALUES (${rewrittenValues}) ` +
      `ON CONFLICT (plugin_id, namespace, key) DO UPDATE SET ` +
      `value = excluded.value, updated_at = excluded.updated_at`,
    params: rewrittenParams,
  };
}

function rewriteUpdate(
  statement: string,
  params: unknown[],
  options: { pluginId: string; namespace: string }
): RewriteResult {
  const match = statement.match(/^\s*UPDATE\s+state\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+?)\s*$/i);
  if (!match) {
    throwStateSqlError('Only UPDATE state SET ... WHERE ... is allowed');
  }

  const assignments = validateAssignmentClause(match[1]);
  const where = validateWhereClause(match[2]);
  const assignmentPlaceholderCount = countQuestionPlaceholders(assignments);
  return {
    kind: 'update',
    sql:
      `UPDATE ${quoteIdentifier(STATE_TABLE_NAME)} SET ${assignments} ` +
      `WHERE plugin_id = ? AND namespace = ? AND ${where}`,
    params: [
      ...params.slice(0, assignmentPlaceholderCount),
      options.pluginId,
      options.namespace,
      ...params.slice(assignmentPlaceholderCount),
    ],
  };
}

function rewriteDelete(
  statement: string,
  params: unknown[],
  options: { pluginId: string; namespace: string }
): RewriteResult {
  const match = statement.match(/^\s*DELETE\s+FROM\s+state\s+WHERE\s+([\s\S]+?)\s*$/i);
  if (!match) {
    throwStateSqlError('Only DELETE FROM state WHERE ... is allowed');
  }

  const where = validateWhereClause(match[1]);
  return {
    kind: 'delete',
    sql:
      `DELETE FROM ${quoteIdentifier(STATE_TABLE_NAME)} ` +
      `WHERE plugin_id = ? AND namespace = ? AND ${where}`,
    params: [options.pluginId, options.namespace, ...params],
  };
}

function validateProjection(projection: string): string {
  const trimmed = projection.trim();
  if (trimmed === '*') {
    return 'key, value, updated_at';
  }
  const columns = parseColumnList(trimmed);
  if (columns.length === 0 || columns.some((column) => !isPublicStateColumn(column))) {
    throwStateSqlError('State SELECT can only project key, value, and updated_at');
  }
  return columns.map(quoteIdentifier).join(', ');
}

function validateWhereClause(where: string): string {
  return where
    .split(/\s+AND\s+/i)
    .map((part) => validatePredicate(part.trim()))
    .join(' AND ');
}

function validatePredicate(predicate: string): string {
  const binary = predicate.match(/^(key|value|updated_at)\s*(=|<>|!=|<|<=|>|>=|LIKE)\s*(\?|[-]?\d+(?:\.\d+)?|'(?:''|[^'])*')$/i);
  if (binary) {
    return `${quoteIdentifier(binary[1].toLowerCase())} ${binary[2]} ${binary[3]}`;
  }

  const isNull = predicate.match(/^(key|value|updated_at)\s+IS\s+(NOT\s+)?NULL$/i);
  if (isNull) {
    return `${quoteIdentifier(isNull[1].toLowerCase())} IS ${isNull[2] ? 'NOT ' : ''}NULL`;
  }

  const inList = predicate.match(/^(key|value|updated_at)\s+IN\s*\(([^)]+)\)$/i);
  if (inList) {
    const values = parseValueList(inList[2]);
    if (values.length === 0) {
      throwStateSqlError('State IN predicates require at least one value');
    }
    return `${quoteIdentifier(inList[1].toLowerCase())} IN (${values.join(', ')})`;
  }

  throwStateSqlError('State WHERE clauses only support simple predicates joined by AND');
}

function validateOrderByClause(orderBy: string): string {
  return orderBy
    .split(',')
    .map((part) => {
      const match = part.trim().match(/^(key|value|updated_at)(?:\s+(ASC|DESC))?$/i);
      if (!match) {
        throwStateSqlError('State ORDER BY can only reference key, value, or updated_at');
      }
      return `${quoteIdentifier(match[1].toLowerCase())}${match[2] ? ` ${match[2].toUpperCase()}` : ''}`;
    })
    .join(', ');
}

function validateAssignmentClause(assignments: string): string {
  const parts = assignments.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throwStateSqlError('State UPDATE requires at least one assignment');
  }

  return parts
    .map((part) => {
      const match = part.match(/^(value|updated_at)\s*=\s*(\?|[-]?\d+(?:\.\d+)?|'(?:''|[^'])*')$/i);
      if (!match) {
        throwStateSqlError('State UPDATE can only assign value and updated_at');
      }
      return `${quoteIdentifier(match[1].toLowerCase())} = ${match[2]}`;
    })
    .join(', ');
}

function countQuestionPlaceholders(sqlFragment: string): number {
  return (sqlFragment.match(/\?/g) || []).length;
}

function parseColumnList(input: string): string[] {
  return input.split(',').map((column) => normalizeIdentifier(column.trim()));
}

function parseValueList(input: string): string[] {
  return input.split(',').map((value) => validateValueExpression(value.trim()));
}

function validateValueExpression(value: string): string {
  if (value === '?') {
    return value;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return value;
  }
  if (/^'(?:''|[^'])*'$/.test(value)) {
    return value;
  }
  throwStateSqlError('State SQL values must be parameters, numeric literals, or string literals');
}

function normalizeIdentifier(identifier: string): string {
  const unquoted = identifier.replace(/^"(.+)"$/, '$1').replace(/^`(.+)`$/, '$1');
  if (!SAFE_IDENTIFIER_PATTERN.test(unquoted)) {
    throwStateSqlError(`Invalid state column identifier: ${identifier}`);
  }
  return unquoted.toLowerCase();
}

function isPublicStateColumn(column: string): boolean {
  return column === 'key' || column === 'value' || column === 'updated_at';
}

function assertStateStatementInput(statement: string, params: unknown[]): void {
  if (typeof statement !== 'string' || statement.trim() === '') {
    throw new DatabaseError('Plugin state SQL must be a non-empty string', {
      operation: 'state.statement',
    });
  }
  if (!Array.isArray(params)) {
    throw new DatabaseError('Plugin state SQL params must be an array', {
      operation: 'state.statement',
      params,
    });
  }
  const withoutTrailing = stripTrailingSemicolon(statement.trim());
  if (withoutTrailing.includes(';')) {
    throwStateSqlError('Only one plugin state SQL statement is allowed');
  }
  const illegalKeyword = withoutTrailing.match(
    /\b(ALTER|ATTACH|CALL|CHECKPOINT|COPY|CREATE|DETACH|DROP|EXPORT|IMPORT|INSTALL|LOAD|MERGE|PRAGMA|REPLACE|TRUNCATE|VACUUM|WITH|JOIN)\b/i
  )?.[1];
  if (illegalKeyword) {
    throwStateSqlError(`Plugin state SQL must not contain ${illegalKeyword.toUpperCase()}`);
  }
}

function getStatementKind(statement: string): PluginStateStatementKind {
  const match = statement.match(/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i);
  if (!match) {
    throwStateSqlError('Plugin state SQL must be SELECT, INSERT, UPDATE, or DELETE');
  }
  return match[1].toLowerCase() as PluginStateStatementKind;
}

function stripTrailingSemicolon(statement: string): string {
  return statement.replace(/;\s*$/, '').trim();
}

function normalizeNamespace(namespace?: string): string {
  const value = (namespace || DEFAULT_NAMESPACE).trim();
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new DatabaseError('Plugin state namespace must be a safe identifier', {
      namespace,
      operation: 'state.namespace',
    });
  }
  return value;
}

function normalizeStateRowPrefix(prefix: string): string {
  const normalized = String(prefix || '').trim();
  if (!normalized) {
    throw new DatabaseError('Plugin state row prefix must be a non-empty string', {
      operation: 'state.rows.list',
    });
  }
  return normalized;
}

function assertPluginId(pluginId: string): void {
  if (typeof pluginId !== 'string' || pluginId.trim() === '') {
    throw new DatabaseError('Plugin state pluginId must be a non-empty string', {
      operation: 'state.plugin',
    });
  }
}

function assertMigrationList(migrations: PluginMigration[]): void {
  if (!Array.isArray(migrations)) {
    throw new DatabaseError('Plugin state migrations must be an array', {
      operation: 'state.migrate',
    });
  }
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (!migration || typeof migration !== 'object') {
      throw new DatabaseError('Plugin state migration must be an object', {
        operation: 'state.migrate',
      });
    }
    if (typeof migration.id !== 'string' || migration.id.trim() === '') {
      throw new DatabaseError('Plugin state migration id must be a non-empty string', {
        operation: 'state.migrate',
      });
    }
    if (seen.has(migration.id)) {
      throw new DatabaseError('Duplicate plugin state migration id', {
        operation: 'state.migrate',
        migrationId: migration.id,
      });
    }
    seen.add(migration.id);
    if (!Array.isArray(migration.up) || migration.up.length === 0) {
      throw new DatabaseError('Plugin state migration up steps must be a non-empty array', {
        operation: 'state.migrate',
        migrationId: migration.id,
      });
    }
  }
}

function getPluginMigrationChecksum(migration: PluginMigration): string {
  const normalized = {
    id: migration.id,
    description: migration.description ?? null,
    up: migration.up,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function throwStateSqlError(message: string): never {
  throw new DatabaseError(message, {
    operation: 'state.statement',
  });
}

function wrapStateBackendError(error: unknown, operation: string): DatabaseError {
  if (error instanceof DatabaseError) {
    return error;
  }
  return new DatabaseError('Plugin state backend operation failed', {
    operation,
    backendErrorName:
      error && typeof error === 'object' && 'name' in error
        ? String((error as { name?: unknown }).name || 'Error')
        : 'Error',
  });
}
