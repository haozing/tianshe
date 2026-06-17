import { createHash } from 'node:crypto';
import type { DuckDBConnection } from '@duckdb/node-api';
import {
  escapeSqlStringLiteral,
  parseRows,
  quoteIdentifier,
  runInDuckDbTransaction,
} from './utils';

export type SchemaMigrationStep =
  | string
  | {
      description: string;
      run: (context: SchemaMigrationContext) => Promise<void>;
      rollbackSql?: string;
    };

export interface SchemaMigration {
  id: string;
  description: string;
  up: SchemaMigrationStep[];
  down?: string[];
}

export interface AppliedSchemaMigration {
  id: string;
  description: string | null;
  checksum: string;
  appliedAt: number;
  rollbackSql: string | null;
}

export class SchemaMigrationContext {
  constructor(private readonly conn: DuckDBConnection) {}

  async run(sql: string): Promise<void> {
    await this.conn.run(sql);
  }

  async tableColumns(tableName: string): Promise<string[]> {
    const result = await this.conn.runAndReadAll(
      `PRAGMA table_info('${escapeSqlStringLiteral(tableName)}')`
    );
    return parseRows(result).map((row) =>
      String(row.name ?? row.column_name ?? '').trim().toLowerCase()
    );
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const columns = await this.tableColumns(tableName);
    return columns.includes(columnName.trim().toLowerCase());
  }

  async addColumnIfMissing(
    tableName: string,
    columnName: string,
    columnDefinition: string
  ): Promise<void> {
    if (await this.hasColumn(tableName, columnName)) {
      return;
    }
    await this.conn.run(
      `ALTER TABLE ${tableName} ADD COLUMN ${quoteIdentifier(columnName)} ${columnDefinition}`
    );
  }
}

export class SchemaMigrationEngine {
  constructor(private readonly conn: DuckDBConnection) {}

  async migrate(migrations: SchemaMigration[]): Promise<AppliedSchemaMigration[]> {
    await this.ensureMigrationTable();
    this.ensureUniqueIds(migrations);

    const appliedById = await this.getAppliedMigrationMap();
    const appliedNow: AppliedSchemaMigration[] = [];

    for (const migration of migrations) {
      const checksum = getSchemaMigrationChecksum(migration);
      const existing = appliedById.get(migration.id);
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(
            `Schema migration checksum mismatch for ${migration.id}: expected ${existing.checksum}, got ${checksum}`
          );
        }
        continue;
      }

      const appliedAt = Date.now();
      const rollbackSql = getRollbackSql(migration);
      await runInDuckDbTransaction(this.conn, async () => {
        const context = new SchemaMigrationContext(this.conn);
        for (const step of migration.up) {
          if (typeof step === 'string') {
            await context.run(step);
          } else {
            await step.run(context);
          }
        }

        await this.conn.run(`
          INSERT INTO schema_migrations (id, description, checksum, applied_at, rollback_sql)
          VALUES (
            ${toSqlStringLiteral(migration.id)},
            ${toSqlStringLiteral(migration.description)},
            ${toSqlStringLiteral(checksum)},
            ${appliedAt},
            ${toSqlStringLiteral(rollbackSql)}
          )
        `);
      });

      const applied: AppliedSchemaMigration = {
        id: migration.id,
        description: migration.description,
        checksum,
        appliedAt,
        rollbackSql,
      };
      appliedById.set(migration.id, applied);
      appliedNow.push(applied);
    }

    return appliedNow;
  }

  async listApplied(): Promise<AppliedSchemaMigration[]> {
    await this.ensureMigrationTable();
    const result = await this.conn.runAndReadAll(`
      SELECT id, description, checksum, applied_at, rollback_sql
      FROM schema_migrations
      ORDER BY applied_at, id
    `);
    return parseRows(result).map(toAppliedMigration);
  }

  private async ensureMigrationTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR PRIMARY KEY,
        description TEXT,
        checksum VARCHAR NOT NULL,
        applied_at BIGINT NOT NULL,
        rollback_sql TEXT
      )
    `);
  }

  private ensureUniqueIds(migrations: SchemaMigration[]): void {
    const seen = new Set<string>();
    for (const migration of migrations) {
      if (seen.has(migration.id)) {
        throw new Error(`Duplicate schema migration id: ${migration.id}`);
      }
      seen.add(migration.id);
    }
  }

  private async getAppliedMigrationMap(): Promise<Map<string, AppliedSchemaMigration>> {
    const result = await this.conn.runAndReadAll(`
      SELECT id, description, checksum, applied_at, rollback_sql
      FROM schema_migrations
    `);
    return new Map(parseRows(result).map((row) => {
      const applied = toAppliedMigration(row);
      return [applied.id, applied] as const;
    }));
  }
}

export function addColumnIfMissingStep(
  tableName: string,
  columnName: string,
  columnDefinition: string
): SchemaMigrationStep {
  return {
    description: `add ${tableName}.${columnName} ${columnDefinition}`,
    rollbackSql: `ALTER TABLE ${tableName} DROP COLUMN ${quoteIdentifier(columnName)}`,
    run: (context) => context.addColumnIfMissing(tableName, columnName, columnDefinition),
  };
}

function getSchemaMigrationChecksum(migration: SchemaMigration): string {
  const payload = JSON.stringify({
    id: migration.id,
    description: migration.description,
    up: migration.up.map((step) =>
      typeof step === 'string'
        ? { sql: step }
        : { description: step.description, rollbackSql: step.rollbackSql ?? null }
    ),
    down: migration.down ?? [],
  });
  return createHash('sha256').update(payload).digest('hex');
}

function getRollbackSql(migration: SchemaMigration): string | null {
  const statements = [
    ...(migration.down ?? []),
    ...migration.up.flatMap((step) =>
      typeof step === 'string' || !step.rollbackSql ? [] : [step.rollbackSql]
    ),
  ];
  return statements.length > 0 ? statements.join(';\n') : null;
}

function toAppliedMigration(row: Record<string, unknown>): AppliedSchemaMigration {
  const rawAppliedAt = row.applied_at ?? row.appliedAt ?? 0;
  return {
    id: String(row.id),
    description: row.description == null ? null : String(row.description),
    checksum: String(row.checksum),
    appliedAt:
      typeof rawAppliedAt === 'bigint' ? Number(rawAppliedAt) : Number(rawAppliedAt ?? 0),
    rollbackSql: row.rollback_sql == null ? null : String(row.rollback_sql),
  };
}

function toSqlStringLiteral(value: string | null): string {
  return value == null ? 'NULL' : `'${escapeSqlStringLiteral(value)}'`;
}
