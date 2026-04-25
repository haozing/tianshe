import { DuckDBConnection } from '@duckdb/node-api';
import { v4 as uuidv4 } from 'uuid';
import { parseRows } from './utils';
import type {
  ExtensionPackage,
  ExtensionPackagesMeta,
  ProfileExtensionBinding,
  ProfileExtensionInstallMode,
} from '../../types/profile';

export interface UpsertExtensionPackageParams {
  extensionId: string;
  name: string;
  version: string;
  sourceType: 'local' | 'cloud';
  sourceUrl?: string | null;
  archiveSha256?: string | null;
  manifest?: Record<string, unknown> | null;
  extractDir: string;
  enabled?: boolean;
}

export interface UpsertProfileExtensionBindingParams {
  extensionId: string;
  version?: string | null;
  installMode?: ProfileExtensionInstallMode;
  sortOrder?: number;
  enabled?: boolean;
}

export interface ExtensionLaunchDescriptor {
  extensionId: string;
  version: string;
  extractDir: string;
  installMode: ProfileExtensionInstallMode;
  sortOrder: number;
}

export class ExtensionPackagesService {
  private schemaInitPromise: Promise<void> | null = null;

  constructor(private conn: DuckDBConnection) {}

  private async ensureExtensionPackagesLatestSchema(): Promise<void> {
    const statements: Array<{ sql: string; backfill?: string }> = [
      {
        sql: `ALTER TABLE extension_packages ADD COLUMN IF NOT EXISTS source_type VARCHAR DEFAULT 'local'`,
      },
      { sql: `ALTER TABLE extension_packages ADD COLUMN IF NOT EXISTS source_url TEXT` },
      { sql: `ALTER TABLE extension_packages ADD COLUMN IF NOT EXISTS archive_sha256 VARCHAR` },
      { sql: `ALTER TABLE extension_packages ADD COLUMN IF NOT EXISTS manifest_json JSON` },
      { sql: `ALTER TABLE extension_packages ADD COLUMN IF NOT EXISTS extract_dir VARCHAR` },
      {
        sql: `ALTER TABLE extension_packages ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE`,
        backfill: `UPDATE extension_packages SET enabled = TRUE WHERE enabled IS NULL`,
      },
      {
        sql: `ALTER TABLE extension_packages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
        backfill: `UPDATE extension_packages SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL`,
      },
      {
        sql: `ALTER TABLE extension_packages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
        backfill: `UPDATE extension_packages SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`,
      },
    ];

    for (const statement of statements) {
      await this.conn.run(statement.sql);
      if (statement.backfill) {
        await this.conn.run(statement.backfill);
      }
    }

    await this.conn.run(`
      UPDATE extension_packages
      SET source_type = 'local'
      WHERE source_type IS NULL OR trim(source_type) = ''
    `);
  }

  private async ensureProfileExtensionsLatestSchema(): Promise<void> {
    const statements: Array<{ sql: string; backfill?: string }> = [
      { sql: `ALTER TABLE profile_extensions ADD COLUMN IF NOT EXISTS version VARCHAR` },
      {
        sql: `ALTER TABLE profile_extensions ADD COLUMN IF NOT EXISTS install_mode VARCHAR DEFAULT 'required'`,
        backfill: `UPDATE profile_extensions SET install_mode = 'required' WHERE install_mode IS NULL OR trim(install_mode) = ''`,
      },
      {
        sql: `ALTER TABLE profile_extensions ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`,
        backfill: `UPDATE profile_extensions SET sort_order = 0 WHERE sort_order IS NULL`,
      },
      {
        sql: `ALTER TABLE profile_extensions ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE`,
        backfill: `UPDATE profile_extensions SET enabled = TRUE WHERE enabled IS NULL`,
      },
      {
        sql: `ALTER TABLE profile_extensions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
        backfill: `UPDATE profile_extensions SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL`,
      },
      {
        sql: `ALTER TABLE profile_extensions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
        backfill: `UPDATE profile_extensions SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`,
      },
    ];

    for (const statement of statements) {
      await this.conn.run(statement.sql);
      if (statement.backfill) {
        await this.conn.run(statement.backfill);
      }
    }
  }

  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS extension_packages (
        id              VARCHAR PRIMARY KEY,
        extension_id    VARCHAR NOT NULL,
        name            VARCHAR NOT NULL,
        version         VARCHAR NOT NULL,
        source_type     VARCHAR NOT NULL,
        source_url      TEXT,
        archive_sha256  VARCHAR,
        manifest_json   JSON,
        extract_dir     VARCHAR NOT NULL,
        enabled         BOOLEAN DEFAULT TRUE,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.ensureExtensionPackagesLatestSchema();

    await this.conn.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_packages_ext_ver
      ON extension_packages(extension_id, version)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_extension_packages_enabled
      ON extension_packages(enabled)
    `);

    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS profile_extensions (
        id              VARCHAR PRIMARY KEY,
        profile_id      VARCHAR NOT NULL,
        extension_id    VARCHAR NOT NULL,
        version         VARCHAR,
        install_mode    VARCHAR DEFAULT 'required',
        sort_order      INTEGER DEFAULT 0,
        enabled         BOOLEAN DEFAULT TRUE,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.ensureProfileExtensionsLatestSchema();

    await this.conn.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_extensions_profile_ext
      ON profile_extensions(profile_id, extension_id)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_profile_extensions_profile_enabled_order
      ON profile_extensions(profile_id, enabled, sort_order)
    `);
  }

  private async ensureSchemaReady(): Promise<void> {
    if (!this.schemaInitPromise) {
      this.schemaInitPromise = this.initTable().catch((error) => {
        this.schemaInitPromise = null;
        throw error;
      });
    }

    await this.schemaInitPromise;
  }

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    await this.ensureSchemaReady();
    await this.conn.run('BEGIN TRANSACTION');
    try {
      const result = await work();
      await this.conn.run('COMMIT');
      return result;
    } catch (error) {
      await this.conn.run('ROLLBACK');
      throw error;
    }
  }

  private async ensureBindingsResolvable(
    bindings: UpsertProfileExtensionBindingParams[]
  ): Promise<void> {
    const checkedKeys = new Set<string>();

    for (const binding of bindings) {
      const extensionId = String(binding.extensionId || '').trim();
      if (!extensionId) {
        throw new Error('extensionId is required for extension package binding');
      }

      const version = String(binding.version || '').trim();
      const key = `${extensionId}@@${version || 'latest'}`;
      if (checkedKeys.has(key)) {
        continue;
      }
      checkedKeys.add(key);

      if (version) {
        const pkg = await this.getPackageByExtensionVersion(extensionId, version);
        if (!pkg || !pkg.enabled) {
          throw new Error(`Extension package not found or disabled: ${extensionId}@${version}`);
        }
        continue;
      }

      const latest = await this.getLatestEnabledPackageByExtensionId(extensionId);
      if (!latest) {
        throw new Error(`No enabled extension package found for binding: ${extensionId}@latest`);
      }
    }
  }

  async listPackages(): Promise<ExtensionPackage[]> {
    await this.ensureSchemaReady();
    const result = await this.conn.runAndReadAll(`
      SELECT
        id, extension_id, name, version, source_type, source_url, archive_sha256,
        manifest_json, extract_dir, enabled, created_at, updated_at
      FROM extension_packages
      ORDER BY updated_at DESC, created_at DESC
    `);
    const rows = parseRows(result);
    return rows.map((row) => this.mapRowToPackage(row));
  }

  async getPackageByExtensionVersion(
    extensionId: string,
    version: string
  ): Promise<ExtensionPackage | null> {
    await this.ensureSchemaReady();
    const stmt = await this.conn.prepare(`
      SELECT
        id, extension_id, name, version, source_type, source_url, archive_sha256,
        manifest_json, extract_dir, enabled, created_at, updated_at
      FROM extension_packages
      WHERE extension_id = ? AND version = ?
      LIMIT 1
    `);
    try {
      stmt.bind([extensionId, version]);
      const result = await stmt.runAndReadAll();
      const rows = parseRows(result);
      return rows.length > 0 ? this.mapRowToPackage(rows[0]) : null;
    } finally {
      stmt.destroySync();
    }
  }

  async getLatestEnabledPackageByExtensionId(
    extensionId: string
  ): Promise<ExtensionPackage | null> {
    await this.ensureSchemaReady();
    const stmt = await this.conn.prepare(`
      SELECT
        id, extension_id, name, version, source_type, source_url, archive_sha256,
        manifest_json, extract_dir, enabled, created_at, updated_at
      FROM extension_packages
      WHERE extension_id = ? AND enabled = TRUE
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `);
    try {
      stmt.bind([extensionId]);
      const result = await stmt.runAndReadAll();
      const rows = parseRows(result);
      return rows.length > 0 ? this.mapRowToPackage(rows[0]) : null;
    } finally {
      stmt.destroySync();
    }
  }

  async upsertPackage(params: UpsertExtensionPackageParams): Promise<ExtensionPackage> {
    await this.ensureSchemaReady();
    const id = uuidv4();
    const normalizedEnabled = params.enabled !== false;
    const manifestJSON = params.manifest ? JSON.stringify(params.manifest) : null;

    const stmt = await this.conn.prepare(`
      INSERT INTO extension_packages (
        id, extension_id, name, version, source_type, source_url, archive_sha256,
        manifest_json, extract_dir, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(extension_id, version)
      DO UPDATE SET
        name = EXCLUDED.name,
        source_type = EXCLUDED.source_type,
        source_url = EXCLUDED.source_url,
        archive_sha256 = EXCLUDED.archive_sha256,
        manifest_json = EXCLUDED.manifest_json,
        extract_dir = EXCLUDED.extract_dir,
        enabled = EXCLUDED.enabled,
        updated_at = now()
    `);

    try {
      stmt.bind([
        id,
        params.extensionId,
        params.name,
        params.version,
        params.sourceType,
        params.sourceUrl ?? null,
        params.archiveSha256 ?? null,
        manifestJSON,
        params.extractDir,
        normalizedEnabled,
      ]);
      await stmt.run();
    } finally {
      stmt.destroySync();
    }

    const pkg = await this.getPackageByExtensionVersion(params.extensionId, params.version);
    if (!pkg) {
      throw new Error(
        `Failed to read upserted extension package: ${params.extensionId}@${params.version}`
      );
    }
    return pkg;
  }

  async listProfileBindings(profileId: string): Promise<ProfileExtensionBinding[]> {
    await this.ensureSchemaReady();
    const stmt = await this.conn.prepare(`
      SELECT
        id, profile_id, extension_id, version, install_mode, sort_order, enabled, created_at, updated_at
      FROM profile_extensions
      WHERE profile_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `);
    try {
      stmt.bind([profileId]);
      const result = await stmt.runAndReadAll();
      const rows = parseRows(result);
      return rows.map((row) => this.mapRowToBinding(row));
    } finally {
      stmt.destroySync();
    }
  }

  async setProfileBindings(
    profileId: string,
    bindings: UpsertProfileExtensionBindingParams[],
    options?: { withinTransaction?: boolean }
  ): Promise<ProfileExtensionBinding[]> {
    await this.ensureSchemaReady();
    const execute = async () => {
      const deleteStmt = await this.conn.prepare(`
        DELETE FROM profile_extensions WHERE profile_id = ?
      `);
      try {
        deleteStmt.bind([profileId]);
        await deleteStmt.run();
      } finally {
        deleteStmt.destroySync();
      }
      if (bindings.length === 0) {
        return [];
      }
      await this.bindPackagesToProfiles([profileId], bindings, { withinTransaction: true });
      return this.listProfileBindings(profileId);
    };

    if (options?.withinTransaction) {
      return execute();
    }
    return this.runInTransaction(execute);
  }

  async bindPackagesToProfiles(
    profileIds: string[],
    bindings: UpsertProfileExtensionBindingParams[],
    options?: { withinTransaction?: boolean }
  ): Promise<void> {
    await this.ensureSchemaReady();
    const execute = async () => {
      if (profileIds.length === 0 || bindings.length === 0) return;

      await this.ensureBindingsResolvable(bindings);

      const stmt = await this.conn.prepare(`
        INSERT INTO profile_extensions (
          id, profile_id, extension_id, version, install_mode, sort_order, enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, extension_id)
        DO UPDATE SET
          version = EXCLUDED.version,
          install_mode = EXCLUDED.install_mode,
          sort_order = EXCLUDED.sort_order,
          enabled = EXCLUDED.enabled,
          updated_at = now()
      `);

      try {
        for (const profileId of profileIds) {
          for (const binding of bindings) {
            stmt.bind([
              uuidv4(),
              profileId,
              binding.extensionId,
              binding.version ?? null,
              binding.installMode ?? 'required',
              Number.isFinite(binding.sortOrder) ? Math.trunc(binding.sortOrder as number) : 0,
              binding.enabled !== false,
            ]);
            await stmt.run();
          }
        }
      } finally {
        stmt.destroySync();
      }
    };

    if (options?.withinTransaction) {
      await execute();
      return;
    }
    await this.runInTransaction(execute);
  }

  async unbindExtensionsFromProfiles(
    profileIds: string[],
    extensionIds: string[],
    options?: { withinTransaction?: boolean }
  ): Promise<number> {
    await this.ensureSchemaReady();
    const execute = async () => {
      if (profileIds.length === 0 || extensionIds.length === 0) return 0;

      const profilePlaceholders = profileIds.map(() => '?').join(', ');
      const extensionPlaceholders = extensionIds.map(() => '?').join(', ');
      const params = [...profileIds, ...extensionIds];

      const countStmt = await this.conn.prepare(`
        SELECT COUNT(*) as total
        FROM profile_extensions
        WHERE profile_id IN (${profilePlaceholders})
          AND extension_id IN (${extensionPlaceholders})
      `);
      let total = 0;
      try {
        countStmt.bind(params);
        const countResult = await countStmt.runAndReadAll();
        const countRows = parseRows(countResult);
        total = Number(countRows[0]?.total ?? 0);
      } finally {
        countStmt.destroySync();
      }

      const deleteStmt = await this.conn.prepare(`
        DELETE FROM profile_extensions
        WHERE profile_id IN (${profilePlaceholders})
          AND extension_id IN (${extensionPlaceholders})
      `);
      try {
        deleteStmt.bind(params);
        await deleteStmt.run();
      } finally {
        deleteStmt.destroySync();
      }
      return total;
    };

    if (options?.withinTransaction) {
      return execute();
    }
    return this.runInTransaction(execute);
  }

  async removePackagesByExtensionIds(extensionIds: string[]): Promise<ExtensionPackage[]> {
    await this.ensureSchemaReady();
    if (extensionIds.length === 0) return [];
    const placeholders = extensionIds.map(() => '?').join(', ');
    const listStmt = await this.conn.prepare(`
      SELECT
        id, extension_id, name, version, source_type, source_url, archive_sha256,
        manifest_json, extract_dir, enabled, created_at, updated_at
      FROM extension_packages
      WHERE extension_id IN (${placeholders})
      ORDER BY updated_at DESC, created_at DESC
    `);

    let removedPackages: ExtensionPackage[] = [];
    try {
      listStmt.bind(extensionIds);
      const result = await listStmt.runAndReadAll();
      removedPackages = parseRows(result).map((row) => this.mapRowToPackage(row));
    } finally {
      listStmt.destroySync();
    }

    if (removedPackages.length === 0) {
      return [];
    }

    const stmt = await this.conn.prepare(`
      DELETE FROM extension_packages
      WHERE extension_id IN (${placeholders})
    `);
    try {
      stmt.bind(extensionIds);
      await stmt.run();
    } finally {
      stmt.destroySync();
    }
    return removedPackages;
  }

  async countBindingsByExtensionId(extensionId: string): Promise<number> {
    await this.ensureSchemaReady();
    const stmt = await this.conn.prepare(`
      SELECT COUNT(*) as total
      FROM profile_extensions
      WHERE extension_id = ?
    `);
    try {
      stmt.bind([extensionId]);
      const result = await stmt.runAndReadAll();
      const rows = parseRows(result);
      return Number(rows[0]?.total ?? 0);
    } finally {
      stmt.destroySync();
    }
  }

  async resolveLaunchExtensions(profileId: string): Promise<ExtensionLaunchDescriptor[]> {
    const bindings = await this.listProfileBindings(profileId);
    if (bindings.length === 0) return [];

    const descriptors: ExtensionLaunchDescriptor[] = [];
    const latestPackageByExtensionId = new Map<string, ExtensionPackage | null>();

    for (const binding of bindings) {
      if (!binding.enabled) continue;
      let pkg: ExtensionPackage | null = null;
      if (binding.version) {
        pkg = await this.getPackageByExtensionVersion(binding.extensionId, binding.version);
      } else if (latestPackageByExtensionId.has(binding.extensionId)) {
        pkg = latestPackageByExtensionId.get(binding.extensionId) ?? null;
      } else {
        pkg = await this.getLatestEnabledPackageByExtensionId(binding.extensionId);
        latestPackageByExtensionId.set(binding.extensionId, pkg);
      }

      if (!pkg || !pkg.enabled) continue;
      descriptors.push({
        extensionId: binding.extensionId,
        version: pkg.version,
        extractDir: pkg.extractDir,
        installMode: binding.installMode,
        sortOrder: binding.sortOrder,
      });
    }

    descriptors.sort((a, b) => a.sortOrder - b.sortOrder);
    return descriptors;
  }

  async buildCloudMetaForProfile(profileId: string): Promise<ExtensionPackagesMeta> {
    const bindings = await this.listProfileBindings(profileId);
    const packages: ExtensionPackagesMeta['packages'] = [];

    for (const binding of bindings) {
      let pkg: ExtensionPackage | null = null;
      if (binding.version) {
        pkg = await this.getPackageByExtensionVersion(binding.extensionId, binding.version);
      } else {
        pkg = await this.getLatestEnabledPackageByExtensionId(binding.extensionId);
      }
      if (!pkg) {
        throw new Error(
          `Bound extension package not found for profile=${profileId}: ${binding.extensionId}@${binding.version || 'latest'}`
        );
      }

      packages.push({
        extensionId: binding.extensionId,
        name: pkg.name,
        version: pkg.version,
        downloadUrl: pkg.sourceUrl || undefined,
        archiveSha256: pkg.archiveSha256 || undefined,
        enabled: binding.enabled,
        sortOrder: binding.sortOrder,
      });
    }

    return {
      packages,
    };
  }

  private mapRowToPackage(row: any): ExtensionPackage {
    return {
      id: String(row.id),
      extensionId: String(row.extension_id),
      name: String(row.name),
      version: String(row.version),
      sourceType: row.source_type === 'cloud' ? 'cloud' : 'local',
      sourceUrl: row.source_url ? String(row.source_url) : null,
      archiveSha256: row.archive_sha256 ? String(row.archive_sha256) : null,
      manifest: row.manifest_json
        ? this.parseJSON<Record<string, unknown>>(row.manifest_json)
        : undefined,
      extractDir: String(row.extract_dir),
      enabled: row.enabled === true || row.enabled === 1,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapRowToBinding(row: any): ProfileExtensionBinding {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      extensionId: String(row.extension_id),
      version: row.version ? String(row.version) : null,
      installMode: row.install_mode === 'optional' ? 'optional' : 'required',
      sortOrder: Number(row.sort_order) || 0,
      enabled: row.enabled === true || row.enabled === 1,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private parseJSON<T>(value: any): T {
    if (value === null || value === undefined) return value as T;
    if (typeof value === 'object') return value as T;
    try {
      return JSON.parse(String(value)) as T;
    } catch {
      return value as T;
    }
  }
}
