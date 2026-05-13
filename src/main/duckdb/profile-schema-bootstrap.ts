import type { DuckDBConnection } from '@duckdb/node-api';
import { parseRows, runInDuckDbTransaction } from './utils';
import { allPrepared, runPrepared } from './statement-executor';
import { SchemaMigrationEngine } from './migration-engine';
import {
  BROWSER_PROFILE_SCHEMA_BACKFILLS,
  BROWSER_PROFILE_SCHEMA_MIGRATIONS,
  runSchemaBackfills,
} from './schema-migrations';
import { DEFAULT_BROWSER_PROFILE } from '../../constants/browser-pool';
import { UNBOUND_PROFILE_ID, isBrowserRuntimeId } from '../../types/profile';
import { DEFAULT_BROWSER_RUNTIME_ID } from '../../types/browser-runtime';
import type { ProfileFingerprintPersistence } from './profile-fingerprint-persistence';
import { isCanonicalFingerprintConfig } from './profile-fingerprint-persistence';
import type { ProfilePartitionCleanupService } from './profile-partition-cleanup-service';
import { parseProfileJson } from './profile-row-mapper';
import { extractFingerprintCoreConfig } from '../../constants/fingerprint-defaults';
import { validateFingerprintConfig } from '../../core/fingerprint/fingerprint-validation';
import { createLogger } from '../../core/logger';

const logger = createLogger('ProfileSchemaBootstrap');

export class ProfileSchemaBootstrap {
  constructor(
    private readonly conn: DuckDBConnection,
    private readonly fingerprintPersistence: ProfileFingerprintPersistence,
    private readonly partitionCleanup: ProfilePartitionCleanupService
  ) {}

  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS profile_groups (
        id              VARCHAR PRIMARY KEY,
        name            VARCHAR NOT NULL,
        parent_id       VARCHAR,
        color           VARCHAR,
        icon            VARCHAR,
        description     TEXT,
        sort_order      INTEGER DEFAULT 0,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS browser_profiles (
        id              VARCHAR PRIMARY KEY,
        name            VARCHAR NOT NULL,
        runtime_id      VARCHAR DEFAULT 'electron-webcontents',
        runtime_source_override JSON,
        group_id        VARCHAR,
        partition       VARCHAR NOT NULL UNIQUE,
        proxy_config    JSON,
        fingerprint     JSON NOT NULL,
        fingerprint_core JSON,
        fingerprint_source JSON,
        notes           TEXT,
        tags            JSON DEFAULT '[]',
        color           VARCHAR,
        status          VARCHAR DEFAULT 'idle',
        last_error      TEXT,
        last_active_at  TIMESTAMP,
        total_uses      INTEGER DEFAULT 0,
        quota           INTEGER DEFAULT 1,
        idle_timeout_ms INTEGER DEFAULT 300000,
        lock_timeout_ms INTEGER DEFAULT 300000,
        is_system       BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.ensureBrowserProfilesLatestSchema();
    await this.cleanupInvalidStoredProfiles();

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_profile_groups_parent_id
      ON profile_groups(parent_id)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_browser_profiles_group_id
      ON browser_profiles(group_id)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_browser_profiles_status
      ON browser_profiles(status)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_browser_profiles_is_system
      ON browser_profiles(is_system)
    `);

    await this.ensureDefaultProfileExists();

    logger.info('Profile tables initialized');
  }

  private async tableExists(tableName: string): Promise<boolean> {
    try {
      const escapedTableName = tableName.replace(/'/g, "''");
      const result = await this.conn.runAndReadAll(`PRAGMA table_info('${escapedTableName}')`);
      return parseRows(result).length > 0;
    } catch {
      return false;
    }
  }

  private async cleanupInvalidStoredProfiles(): Promise<void> {
    const result = await this.conn.runAndReadAll(`
      SELECT id, partition, runtime_id, fingerprint
      FROM browser_profiles
      ORDER BY id ASC
    `);
    const rows = parseRows(result);
    const invalidProfiles: Array<{
      id: string;
      partition: string;
      reason: string;
    }> = [];

    for (const row of rows) {
      const id = String(row.id || '').trim();
      if (!id) {
        continue;
      }

      const rawRuntimeId = String(row.runtime_id || '').trim();
      if (!isBrowserRuntimeId(rawRuntimeId)) {
        invalidProfiles.push({
          id,
          partition: String(row.partition || '').trim(),
          reason: `unsupported runtimeId: ${rawRuntimeId || '(empty)'}`,
        });
        continue;
      }

      const fingerprint = parseProfileJson<unknown>(row.fingerprint);
      if (!isCanonicalFingerprintConfig(fingerprint)) {
        invalidProfiles.push({
          id,
          partition: String(row.partition || '').trim(),
          reason: 'non-canonical fingerprint payload',
        });
        continue;
      }

      const validation = validateFingerprintConfig(fingerprint, rawRuntimeId);
      if (!validation.valid) {
        invalidProfiles.push({
          id,
          partition: String(row.partition || '').trim(),
          reason: validation.warnings.join(', '),
        });
      }
    }

    if (invalidProfiles.length === 0) {
      return;
    }

    const profileIds = invalidProfiles.map((profile) => profile.id);
    const placeholders = profileIds.map(() => '?').join(', ');
    const hasAccountsTable = await this.tableExists('accounts');
    const hasProfileExtensionsTable = await this.tableExists('profile_extensions');

    await runInDuckDbTransaction(this.conn, async () => {
      if (hasAccountsTable) {
        await runPrepared(
          this.conn,
          `
          UPDATE accounts
          SET profile_id = ?
          WHERE profile_id IN (${placeholders})
        `,
          [UNBOUND_PROFILE_ID, ...profileIds]
        );
      }

      if (hasProfileExtensionsTable) {
        await runPrepared(
          this.conn,
          `
          DELETE FROM profile_extensions
          WHERE profile_id IN (${placeholders})
        `,
          profileIds
        );
      }

      await runPrepared(
        this.conn,
        `
        DELETE FROM browser_profiles
        WHERE id IN (${placeholders})
      `,
        profileIds
      );
    });

    for (const profile of invalidProfiles) {
      if (profile.partition) {
        await this.partitionCleanup.purgePartitionData(profile.partition);
      }
      await this.partitionCleanup.purgeExtensionProfileData(profile.id);
    }

    logger.warn('Removed invalid stored profiles', {
      count: invalidProfiles.length,
      profiles: invalidProfiles.map((profile) => ({
        id: profile.id,
        reason: profile.reason,
      })),
    });
  }

  private async ensureBrowserProfilesLatestSchema(): Promise<void> {
    await new SchemaMigrationEngine(this.conn).migrate(BROWSER_PROFILE_SCHEMA_MIGRATIONS);
    await runSchemaBackfills(this.conn, BROWSER_PROFILE_SCHEMA_BACKFILLS);
  }

  private async ensureDefaultProfileExists(): Promise<void> {
    const systemDefaultFingerprint =
      this.fingerprintPersistence.buildSystemDefaultFingerprint();
    const fingerprintJson = JSON.stringify(systemDefaultFingerprint);
    const fingerprintCoreJson = JSON.stringify(
      extractFingerprintCoreConfig(systemDefaultFingerprint)
    );
    const fingerprintSourceJson = JSON.stringify(systemDefaultFingerprint.source);
    const result = await allPrepared(
      this.conn,
      `
      SELECT fingerprint, fingerprint_core, fingerprint_source
      FROM browser_profiles
      WHERE id = ?
      LIMIT 1
    `,
      [DEFAULT_BROWSER_PROFILE.id]
    );

    const rows = parseRows(result);
    if (rows.length === 0) {
      await runPrepared(
        this.conn,
        `
        INSERT INTO browser_profiles (
          id, name, runtime_id, runtime_source_override, group_id, partition, proxy_config, fingerprint, fingerprint_core, fingerprint_source,
          notes, tags, color, status, quota, idle_timeout_ms, lock_timeout_ms, is_system,
          created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
        [
          DEFAULT_BROWSER_PROFILE.id,
          DEFAULT_BROWSER_PROFILE.name,
          DEFAULT_BROWSER_RUNTIME_ID,
          null,
          DEFAULT_BROWSER_PROFILE.partition,
          null,
          fingerprintJson,
          fingerprintCoreJson,
          fingerprintSourceJson,
          DEFAULT_BROWSER_PROFILE.notes,
          JSON.stringify(DEFAULT_BROWSER_PROFILE.tags),
          DEFAULT_BROWSER_PROFILE.color,
          DEFAULT_BROWSER_PROFILE.quota,
          DEFAULT_BROWSER_PROFILE.idleTimeoutMs,
          DEFAULT_BROWSER_PROFILE.lockTimeoutMs,
        ]
      );
      return;
    }

    const currentFingerprint = parseProfileJson<any>(rows[0]?.fingerprint);
    const needsFingerprintRefresh =
      !isCanonicalFingerprintConfig(currentFingerprint) ||
      (process.platform === 'win32' &&
        (!String(currentFingerprint.identity.hardware.userAgent || '').includes('Edg/') ||
          currentFingerprint.identity.hardware.browserFamily !==
            systemDefaultFingerprint.identity.hardware.browserFamily));
    const currentFingerprintCore = parseProfileJson<any>(rows[0]?.fingerprint_core);
    const currentFingerprintSource = parseProfileJson<any>(rows[0]?.fingerprint_source);

    const updateFields = [
      `name = ?`,
      `runtime_id = ?`,
      `runtime_source_override = NULL`,
      `partition = ?`,
      `notes = ?`,
      `tags = ?`,
      `color = ?`,
      `status = COALESCE(NULLIF(status, ''), 'idle')`,
      `quota = ?`,
      `idle_timeout_ms = ?`,
      `lock_timeout_ms = ?`,
      `is_system = TRUE`,
      `updated_at = CURRENT_TIMESTAMP`,
    ];
    const updateValues: any[] = [
      DEFAULT_BROWSER_PROFILE.name,
      DEFAULT_BROWSER_RUNTIME_ID,
      DEFAULT_BROWSER_PROFILE.partition,
      DEFAULT_BROWSER_PROFILE.notes,
      JSON.stringify(DEFAULT_BROWSER_PROFILE.tags),
      DEFAULT_BROWSER_PROFILE.color,
      DEFAULT_BROWSER_PROFILE.quota,
      DEFAULT_BROWSER_PROFILE.idleTimeoutMs,
      DEFAULT_BROWSER_PROFILE.lockTimeoutMs,
    ];
    const needsFingerprintCoreRefresh = !currentFingerprintCore || needsFingerprintRefresh;
    const needsFingerprintSourceRefresh = !currentFingerprintSource || needsFingerprintRefresh;
    if (needsFingerprintCoreRefresh) {
      updateFields.push(`fingerprint_core = ?`);
      updateValues.push(fingerprintCoreJson);
    }
    if (needsFingerprintSourceRefresh) {
      updateFields.push(`fingerprint_source = ?`);
      updateValues.push(fingerprintSourceJson);
    }
    if (needsFingerprintRefresh) {
      updateFields.push(`fingerprint = ?`);
      updateValues.push(fingerprintJson);
    }
    updateValues.push(DEFAULT_BROWSER_PROFILE.id);

    await runPrepared(
      this.conn,
      `
      UPDATE browser_profiles
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `,
      updateValues
    );
  }
}
