import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from '../duckdb/utils';
import type { SyncDomain, SyncEntityType } from '../../types/sync-contract';

const MAPPINGS_TABLE = 'sync_entity_mappings_v2';
const DOMAIN_STATE_TABLE = 'sync_domain_state_v2';
const LEGACY_MAPPINGS_TABLE = 'sync_entity_mappings';
const LEGACY_DOMAIN_STATE_TABLE = 'sync_domain_state';
const MAX_QUERY_LIMIT = 1000;
const DEFAULT_SCOPE_KEY = 'company:0';

export interface SyncScopeContext {
  scopeKey?: string;
}

export interface SyncEntityMapping {
  domain: SyncDomain;
  entityType: SyncEntityType;
  localId: string;
  globalUid: string;
  remoteUid?: string;
  version: number;
  contentHash?: string;
  updatedAt: number;
}

export interface UpsertSyncEntityMappingInput {
  domain: SyncDomain;
  entityType: SyncEntityType;
  localId: string;
  globalUid: string;
  remoteUid?: string | null;
  version?: number;
  contentHash?: string | null;
  updatedAt?: number;
}

export interface ListSyncEntityMappingsOptions {
  scopeKey?: string;
  domain?: SyncDomain;
  entityType?: SyncEntityType;
  limit?: number;
  offset?: number;
}

export interface SyncDomainState {
  domain: SyncDomain;
  domainVersion: number;
  lastPulledAt?: number;
  lastPushedAt?: number;
  updatedAt: number;
}

export interface SetSyncDomainStateInput {
  domain: SyncDomain;
  domainVersion?: number;
  lastPulledAt?: number | null;
  lastPushedAt?: number | null;
  updatedAt?: number;
}

interface SyncEntityMappingRow {
  scope_key: string | null;
  domain: string;
  entity_type: string;
  local_id: string;
  global_uid: string;
  remote_uid: string | null;
  version: number;
  content_hash: string | null;
  updated_at: number;
}

interface SyncDomainStateRow {
  scope_key: string | null;
  domain: string;
  domain_version: number;
  last_pulled_at: number | null;
  last_pushed_at: number | null;
  updated_at: number;
}

function normalizeNonEmpty(value: unknown, fieldName: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function normalizeVersion(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function normalizeNullableTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric);
}

function normalizeLimit(value: unknown, defaultValue: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return defaultValue;
  }
  return Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.trunc(numeric)));
}

function normalizeOffset(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.trunc(numeric);
}

function normalizeScopeKey(rawScopeKey: unknown): string {
  const value = String(rawScopeKey || '').trim().toLowerCase();
  return value || DEFAULT_SCOPE_KEY;
}

export class SyncMetadataService {
  private initialized = false;

  constructor(private readonly conn: DuckDBConnection) {}

  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS ${MAPPINGS_TABLE} (
        scope_key     VARCHAR NOT NULL,
        domain        VARCHAR NOT NULL,
        entity_type   VARCHAR NOT NULL,
        local_id      VARCHAR NOT NULL,
        global_uid    VARCHAR NOT NULL,
        remote_uid    VARCHAR,
        version       INTEGER NOT NULL DEFAULT 0,
        content_hash  VARCHAR,
        updated_at    BIGINT NOT NULL,
        PRIMARY KEY (scope_key, domain, entity_type, local_id)
      )
    `);

    await this.ensureRemoteUidColumn();

    await this.conn.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_entity_mappings_global_uid
      ON ${MAPPINGS_TABLE} (scope_key, domain, entity_type, global_uid)
    `);

    await this.conn.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_entity_mappings_remote_uid
      ON ${MAPPINGS_TABLE} (scope_key, domain, entity_type, remote_uid)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_sync_entity_mappings_updated_at
      ON ${MAPPINGS_TABLE} (scope_key, updated_at)
    `);

    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS ${DOMAIN_STATE_TABLE} (
        scope_key       VARCHAR NOT NULL,
        domain          VARCHAR NOT NULL,
        domain_version  INTEGER NOT NULL DEFAULT 0,
        last_pulled_at  BIGINT,
        last_pushed_at  BIGINT,
        updated_at      BIGINT NOT NULL,
        PRIMARY KEY (scope_key, domain)
      )
    `);

    await this.migrateLegacyTables();

    this.initialized = true;
  }

  async upsertEntityMapping(
    input: UpsertSyncEntityMappingInput,
    context?: SyncScopeContext
  ): Promise<SyncEntityMapping> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(context?.scopeKey);
    const domain = normalizeNonEmpty(input.domain, 'domain') as SyncDomain;
    const entityType = normalizeNonEmpty(input.entityType, 'entityType') as SyncEntityType;
    const localId = normalizeNonEmpty(input.localId, 'localId');
    const globalUid = normalizeNonEmpty(input.globalUid, 'globalUid');
    const now = Date.now();
    const updatedAt = normalizeTimestamp(input.updatedAt, now);
    const version = normalizeVersion(input.version, 0);
    const remoteUid = String(input.remoteUid || '').trim() || null;
    const contentHash = String(input.contentHash || '').trim() || null;

    const stmt = await this.conn.prepare(`
      INSERT INTO ${MAPPINGS_TABLE} (
        scope_key, domain, entity_type, local_id, global_uid, remote_uid, version, content_hash, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, domain, entity_type, local_id)
      DO UPDATE SET
        global_uid = EXCLUDED.global_uid,
        remote_uid = EXCLUDED.remote_uid,
        version = EXCLUDED.version,
        content_hash = EXCLUDED.content_hash,
        updated_at = EXCLUDED.updated_at
    `);
    stmt.bind([
      scopeKey,
      domain,
      entityType,
      localId,
      globalUid,
      remoteUid,
      version,
      contentHash,
      updatedAt,
    ]);
    await stmt.run();
    stmt.destroySync();

    const mapping = await this.getEntityMapping(domain, entityType, localId, { scopeKey });
    if (!mapping) {
      throw new Error(
        `Failed to read entity mapping after upsert: ${domain}/${entityType}/${localId}`
      );
    }
    return mapping;
  }

  async getEntityMapping(
    domain: SyncDomain,
    entityType: SyncEntityType,
    localId: string,
    context?: SyncScopeContext
  ): Promise<SyncEntityMapping | null> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(context?.scopeKey);
    const normalizedDomain = normalizeNonEmpty(domain, 'domain');
    const normalizedEntityType = normalizeNonEmpty(entityType, 'entityType');
    const normalizedLocalId = normalizeNonEmpty(localId, 'localId');

    const stmt = await this.conn.prepare(`
      SELECT
        scope_key, domain, entity_type, local_id, global_uid, remote_uid, version, content_hash, updated_at
      FROM ${MAPPINGS_TABLE}
      WHERE scope_key = ? AND domain = ? AND entity_type = ? AND local_id = ?
      LIMIT 1
    `);
    stmt.bind([scopeKey, normalizedDomain, normalizedEntityType, normalizedLocalId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows<SyncEntityMappingRow>(result);
    if (!rows.length) return null;
    return this.mapEntityMapping(rows[0]);
  }

  async getEntityMappingByGlobalUid(
    domain: SyncDomain,
    entityType: SyncEntityType,
    globalUid: string,
    context?: SyncScopeContext
  ): Promise<SyncEntityMapping | null> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(context?.scopeKey);
    const normalizedDomain = normalizeNonEmpty(domain, 'domain');
    const normalizedEntityType = normalizeNonEmpty(entityType, 'entityType');
    const normalizedGlobalUid = normalizeNonEmpty(globalUid, 'globalUid');

    const stmt = await this.conn.prepare(`
      SELECT
        scope_key, domain, entity_type, local_id, global_uid, remote_uid, version, content_hash, updated_at
      FROM ${MAPPINGS_TABLE}
      WHERE scope_key = ? AND domain = ? AND entity_type = ? AND global_uid = ?
      LIMIT 1
    `);
    stmt.bind([scopeKey, normalizedDomain, normalizedEntityType, normalizedGlobalUid]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows<SyncEntityMappingRow>(result);
    if (!rows.length) return null;
    return this.mapEntityMapping(rows[0]);
  }

  async getEntityMappingByRemoteUid(
    domain: SyncDomain,
    entityType: SyncEntityType,
    remoteUid: string,
    context?: SyncScopeContext
  ): Promise<SyncEntityMapping | null> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(context?.scopeKey);
    const normalizedDomain = normalizeNonEmpty(domain, 'domain');
    const normalizedEntityType = normalizeNonEmpty(entityType, 'entityType');
    const normalizedRemoteUid = normalizeNonEmpty(remoteUid, 'remoteUid');

    const stmt = await this.conn.prepare(`
      SELECT
        scope_key, domain, entity_type, local_id, global_uid, remote_uid, version, content_hash, updated_at
      FROM ${MAPPINGS_TABLE}
      WHERE scope_key = ? AND domain = ? AND entity_type = ? AND remote_uid = ?
      LIMIT 1
    `);
    stmt.bind([scopeKey, normalizedDomain, normalizedEntityType, normalizedRemoteUid]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows<SyncEntityMappingRow>(result);
    if (!rows.length) return null;
    return this.mapEntityMapping(rows[0]);
  }

  async getEntityMappingByGlobalUidAnyScope(
    domain: SyncDomain,
    entityType: SyncEntityType,
    globalUid: string
  ): Promise<SyncEntityMapping | null> {
    await this.ensureInitialized();

    const normalizedDomain = normalizeNonEmpty(domain, 'domain');
    const normalizedEntityType = normalizeNonEmpty(entityType, 'entityType');
    const normalizedGlobalUid = normalizeNonEmpty(globalUid, 'globalUid');

    const stmt = await this.conn.prepare(`
      SELECT
        scope_key, domain, entity_type, local_id, global_uid, remote_uid, version, content_hash, updated_at
      FROM ${MAPPINGS_TABLE}
      WHERE domain = ? AND entity_type = ? AND global_uid = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    stmt.bind([normalizedDomain, normalizedEntityType, normalizedGlobalUid]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows<SyncEntityMappingRow>(result);
    if (!rows.length) return null;
    return this.mapEntityMapping(rows[0]);
  }

  async getEntityMappingByRemoteUidAnyScope(
    domain: SyncDomain,
    entityType: SyncEntityType,
    remoteUid: string
  ): Promise<SyncEntityMapping | null> {
    await this.ensureInitialized();

    const normalizedDomain = normalizeNonEmpty(domain, 'domain');
    const normalizedEntityType = normalizeNonEmpty(entityType, 'entityType');
    const normalizedRemoteUid = normalizeNonEmpty(remoteUid, 'remoteUid');

    const stmt = await this.conn.prepare(`
      SELECT
        scope_key, domain, entity_type, local_id, global_uid, remote_uid, version, content_hash, updated_at
      FROM ${MAPPINGS_TABLE}
      WHERE domain = ? AND entity_type = ? AND remote_uid = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    stmt.bind([normalizedDomain, normalizedEntityType, normalizedRemoteUid]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows<SyncEntityMappingRow>(result);
    if (!rows.length) return null;
    return this.mapEntityMapping(rows[0]);
  }

  async listEntityMappings(options: ListSyncEntityMappingsOptions = {}): Promise<SyncEntityMapping[]> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(options.scopeKey);
    const whereParts: string[] = [];
    const params: any[] = [scopeKey];

    whereParts.push('scope_key = ?');

    if (options.domain) {
      whereParts.push('domain = ?');
      params.push(normalizeNonEmpty(options.domain, 'domain'));
    }
    if (options.entityType) {
      whereParts.push('entity_type = ?');
      params.push(normalizeNonEmpty(options.entityType, 'entityType'));
    }

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    const limit = normalizeLimit(options.limit, 200);
    const offset = normalizeOffset(options.offset);

    const stmt = await this.conn.prepare(`
      SELECT
        scope_key, domain, entity_type, local_id, global_uid, remote_uid, version, content_hash, updated_at
      FROM ${MAPPINGS_TABLE}
      ${whereClause}
      ORDER BY updated_at DESC, domain ASC, entity_type ASC, local_id ASC
      LIMIT ? OFFSET ?
    `);
    stmt.bind([...params, limit, offset]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    return parseRows<SyncEntityMappingRow>(result).map((row) => this.mapEntityMapping(row));
  }

  async deleteEntityMapping(
    domain: SyncDomain,
    entityType: SyncEntityType,
    localId: string,
    context?: SyncScopeContext
  ): Promise<void> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(context?.scopeKey);
    const normalizedDomain = normalizeNonEmpty(domain, 'domain');
    const normalizedEntityType = normalizeNonEmpty(entityType, 'entityType');
    const normalizedLocalId = normalizeNonEmpty(localId, 'localId');

    const stmt = await this.conn.prepare(`
      DELETE FROM ${MAPPINGS_TABLE}
      WHERE scope_key = ? AND domain = ? AND entity_type = ? AND local_id = ?
    `);
    stmt.bind([scopeKey, normalizedDomain, normalizedEntityType, normalizedLocalId]);
    await stmt.run();
    stmt.destroySync();
  }

  async setDomainState(input: SetSyncDomainStateInput, context?: SyncScopeContext): Promise<SyncDomainState> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(context?.scopeKey);
    const domain = normalizeNonEmpty(input.domain, 'domain') as SyncDomain;
    const existing = await this.getDomainState(domain, { scopeKey });
    const now = Date.now();
    const domainVersion = normalizeVersion(input.domainVersion, existing?.domainVersion ?? 0);
    const lastPulledAt =
      input.lastPulledAt === undefined
        ? normalizeNullableTimestamp(existing?.lastPulledAt)
        : normalizeNullableTimestamp(input.lastPulledAt);
    const lastPushedAt =
      input.lastPushedAt === undefined
        ? normalizeNullableTimestamp(existing?.lastPushedAt)
        : normalizeNullableTimestamp(input.lastPushedAt);
    const updatedAt = normalizeTimestamp(input.updatedAt, now);

    const stmt = await this.conn.prepare(`
      INSERT INTO ${DOMAIN_STATE_TABLE} (
        scope_key, domain, domain_version, last_pulled_at, last_pushed_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, domain)
      DO UPDATE SET
        domain_version = EXCLUDED.domain_version,
        last_pulled_at = EXCLUDED.last_pulled_at,
        last_pushed_at = EXCLUDED.last_pushed_at,
        updated_at = EXCLUDED.updated_at
    `);
    stmt.bind([scopeKey, domain, domainVersion, lastPulledAt, lastPushedAt, updatedAt]);
    await stmt.run();
    stmt.destroySync();

    const state = await this.getDomainState(domain, { scopeKey });
    if (!state) {
      throw new Error(`Failed to read domain state after upsert: ${domain}`);
    }
    return state;
  }

  async getDomainState(domain: SyncDomain, context?: SyncScopeContext): Promise<SyncDomainState | null> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(context?.scopeKey);
    const normalizedDomain = normalizeNonEmpty(domain, 'domain');
    const stmt = await this.conn.prepare(`
      SELECT scope_key, domain, domain_version, last_pulled_at, last_pushed_at, updated_at
      FROM ${DOMAIN_STATE_TABLE}
      WHERE scope_key = ? AND domain = ?
      LIMIT 1
    `);
    stmt.bind([scopeKey, normalizedDomain]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows<SyncDomainStateRow>(result);
    if (!rows.length) return null;
    return this.mapDomainState(rows[0]);
  }

  async listDomainStates(context?: SyncScopeContext): Promise<SyncDomainState[]> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(context?.scopeKey);
    const stmt = await this.conn.prepare(`
      SELECT scope_key, domain, domain_version, last_pulled_at, last_pushed_at, updated_at
      FROM ${DOMAIN_STATE_TABLE}
      WHERE scope_key = ?
      ORDER BY domain ASC
    `);
    stmt.bind([scopeKey]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();
    return parseRows<SyncDomainStateRow>(result).map((row) => this.mapDomainState(row));
  }

  async deleteDomainState(domain: SyncDomain, context?: SyncScopeContext): Promise<void> {
    await this.ensureInitialized();

    const scopeKey = normalizeScopeKey(context?.scopeKey);
    const normalizedDomain = normalizeNonEmpty(domain, 'domain');
    const stmt = await this.conn.prepare(`
      DELETE FROM ${DOMAIN_STATE_TABLE}
      WHERE scope_key = ? AND domain = ?
    `);
    stmt.bind([scopeKey, normalizedDomain]);
    await stmt.run();
    stmt.destroySync();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initTable();
    }
  }

  private async migrateLegacyTables(): Promise<void> {
    try {
      await this.conn.run(`
        INSERT INTO ${MAPPINGS_TABLE} (
          scope_key, domain, entity_type, local_id, global_uid, remote_uid, version, content_hash, updated_at
        )
        SELECT
          '${DEFAULT_SCOPE_KEY}' AS scope_key,
          domain,
          entity_type,
          local_id,
          global_uid,
          NULL AS remote_uid,
          version,
          content_hash,
          updated_at
        FROM ${LEGACY_MAPPINGS_TABLE}
        ON CONFLICT (scope_key, domain, entity_type, local_id) DO NOTHING
      `);
    } catch {
      // ignore when legacy table does not exist
    }

    try {
      await this.conn.run(`
        INSERT INTO ${DOMAIN_STATE_TABLE} (
          scope_key, domain, domain_version, last_pulled_at, last_pushed_at, updated_at
        )
        SELECT
          '${DEFAULT_SCOPE_KEY}' AS scope_key,
          domain,
          domain_version,
          last_pulled_at,
          last_pushed_at,
          updated_at
        FROM ${LEGACY_DOMAIN_STATE_TABLE}
        ON CONFLICT (scope_key, domain) DO NOTHING
      `);
    } catch {
      // ignore when legacy table does not exist
    }
  }

  private mapEntityMapping(row: SyncEntityMappingRow): SyncEntityMapping {
    const contentHash = String(row.content_hash || '').trim();
    const remoteUid = String(row.remote_uid || '').trim();
    return {
      domain: normalizeNonEmpty(row.domain, 'domain') as SyncDomain,
      entityType: normalizeNonEmpty(row.entity_type, 'entityType') as SyncEntityType,
      localId: normalizeNonEmpty(row.local_id, 'localId'),
      globalUid: normalizeNonEmpty(row.global_uid, 'globalUid'),
      remoteUid: remoteUid || undefined,
      version: normalizeVersion(row.version, 0),
      contentHash: contentHash || undefined,
      updatedAt: normalizeTimestamp(row.updated_at, Date.now()),
    };
  }

  private async ensureRemoteUidColumn(): Promise<void> {
    try {
      await this.conn.run(`ALTER TABLE ${MAPPINGS_TABLE} ADD COLUMN remote_uid VARCHAR`);
    } catch {
      // ignore when column already exists
    }
  }

  private mapDomainState(row: SyncDomainStateRow): SyncDomainState {
    const lastPulledAt = normalizeNullableTimestamp(row.last_pulled_at);
    const lastPushedAt = normalizeNullableTimestamp(row.last_pushed_at);
    return {
      domain: normalizeNonEmpty(row.domain, 'domain') as SyncDomain,
      domainVersion: normalizeVersion(row.domain_version, 0),
      lastPulledAt: lastPulledAt ?? undefined,
      lastPushedAt: lastPushedAt ?? undefined,
      updatedAt: normalizeTimestamp(row.updated_at, Date.now()),
    };
  }
}
