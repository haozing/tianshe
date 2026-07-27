const fs = require("node:fs");
const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { createHash, randomUUID } = require("node:crypto");
const { buildCoverageDescriptor } = require("./catalog-contracts");
const { EXPECTED_TABLES, SCHEMA_VERSION, loadSchemaSql } = require("./schema");
const {
  MAX_CATALOG_BATCH_PRODUCTS,
  MAX_LARGE_RECORD_BYTES,
  MAX_LARGE_RECORD_CHUNK_BYTES,
  serializeError
} = require("./protocol");

let db = null;
let databasePath = "";
let openedAt = "";
const largeRecordSessions = new Map();
const LARGE_RECORD_SESSION_TTL_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function businessDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function encodeJson(value, fallback = {}) {
  if (value === undefined) return JSON.stringify(fallback);
  return JSON.stringify(value);
}

function decodeJson(value, fallback) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const next = value[key];
    if (next !== undefined) output[key] = canonicalize(next);
  }
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function normalizeString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function ensureDb() {
  if (!db) throw createError("NATIVE_DATA_NOT_READY", "Native data service is not initialized");
  return db;
}

function firstValue(row) {
  if (!row || typeof row !== "object") return undefined;
  return row[Object.keys(row)[0]];
}

function pragmaGet(sql) {
  return firstValue(ensureDb().prepare(sql).get());
}

function applyConnectionPragmas(database) {
  const journalModeRow = database.prepare("PRAGMA journal_mode = WAL").get();
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA wal_autocheckpoint = 1000");

  const foreignKeys = firstValue(database.prepare("PRAGMA foreign_keys").get());
  const busyTimeout = firstValue(database.prepare("PRAGMA busy_timeout").get());
  return {
    journalMode: firstValue(journalModeRow),
    foreignKeys,
    busyTimeout
  };
}

function tableHasColumn(database, tableName, columnName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
}

function migrateOpportunityAttemptStatuses(database) {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'opportunity_submit_attempts_v2'").get();
  if (!row || String(row.sql || "").includes("'throttled'")) return;
  database.exec(`
    DROP INDEX IF EXISTS idx_opportunity_attempts_status;
    DROP INDEX IF EXISTS idx_opportunity_attempts_date_shop;
    DROP INDEX IF EXISTS idx_opportunity_attempts_relation_status;
    DROP INDEX IF EXISTS idx_opportunity_attempts_clue_status;
    DROP INDEX IF EXISTS idx_opportunity_attempts_category_status;
    ALTER TABLE opportunity_submit_attempts_v2 RENAME TO opportunity_submit_attempts_v2_legacy_status;
    CREATE TABLE opportunity_submit_attempts_v2 (
      attempt_id TEXT PRIMARY KEY,
      attempt_key TEXT NOT NULL UNIQUE,
      execute_run_id TEXT,
      business_date TEXT NOT NULL DEFAULT '',
      tenant_id TEXT NOT NULL DEFAULT 'local-user',
      shop_id TEXT NOT NULL DEFAULT '',
      clue_id TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL DEFAULT '',
      clue_category_id TEXT NOT NULL DEFAULT '',
      relation_key TEXT NOT NULL DEFAULT '',
      clue_key TEXT NOT NULL DEFAULT '',
      clue_category_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('prepared', 'sending', 'accepted', 'rejected', 'throttled', 'unknown', 'confirmed', 'failed', 'cancelled')),
      counts_against_daily_limit INTEGER NOT NULL DEFAULT 0 CHECK (counts_against_daily_limit IN (0, 1)),
      request_hash TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      resolved_at TEXT,
      FOREIGN KEY (execute_run_id) REFERENCES opportunity_execute_runs_v2 (run_id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );
    INSERT INTO opportunity_submit_attempts_v2 (
      attempt_id, attempt_key, execute_run_id, business_date, tenant_id, shop_id,
      clue_id, product_id, clue_category_id, relation_key, clue_key, clue_category_key,
      status, counts_against_daily_limit, request_hash, payload_json, created_at,
      updated_at, sent_at, resolved_at
    )
    SELECT
      attempt_id, attempt_key, execute_run_id, business_date, tenant_id, shop_id,
      clue_id, product_id, clue_category_id, relation_key, clue_key, clue_category_key,
      status, counts_against_daily_limit, request_hash, payload_json, created_at,
      updated_at, sent_at, resolved_at
    FROM opportunity_submit_attempts_v2_legacy_status;
    DROP TABLE opportunity_submit_attempts_v2_legacy_status;
  `);
}

function applyForwardCompatibleFixups(database) {
  if (!tableHasColumn(database, "catalog_pages", "transaction_id")) {
    database.exec("ALTER TABLE catalog_pages ADD COLUMN transaction_id TEXT NOT NULL DEFAULT ''");
  }
  const attemptColumns = [
    ["business_date", "TEXT NOT NULL DEFAULT ''"],
    ["tenant_id", "TEXT NOT NULL DEFAULT 'local-user'"],
    ["shop_id", "TEXT NOT NULL DEFAULT ''"],
    ["clue_id", "TEXT NOT NULL DEFAULT ''"],
    ["product_id", "TEXT NOT NULL DEFAULT ''"],
    ["clue_category_id", "TEXT NOT NULL DEFAULT ''"],
    ["relation_key", "TEXT NOT NULL DEFAULT ''"],
    ["clue_key", "TEXT NOT NULL DEFAULT ''"],
    ["clue_category_key", "TEXT NOT NULL DEFAULT ''"]
  ];
  for (const [column, definition] of attemptColumns) {
    if (!tableHasColumn(database, "opportunity_submit_attempts_v2", column)) {
      database.exec(`ALTER TABLE opportunity_submit_attempts_v2 ADD COLUMN ${column} ${definition}`);
    }
  }
  migrateOpportunityAttemptStatuses(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_opportunity_attempts_status
      ON opportunity_submit_attempts_v2 (status, created_at);
    CREATE INDEX IF NOT EXISTS idx_opportunity_attempts_date_shop
      ON opportunity_submit_attempts_v2 (business_date, shop_id, counts_against_daily_limit);
    CREATE INDEX IF NOT EXISTS idx_opportunity_attempts_relation_status
      ON opportunity_submit_attempts_v2 (relation_key, status);
    CREATE INDEX IF NOT EXISTS idx_opportunity_attempts_clue_status
      ON opportunity_submit_attempts_v2 (clue_key, status);
    CREATE INDEX IF NOT EXISTS idx_opportunity_attempts_category_status
      ON opportunity_submit_attempts_v2 (clue_category_key, status);
    CREATE INDEX IF NOT EXISTS idx_opportunity_submit_tasks_active
      ON native_records (
        json_extract(payload_json, '$.concurrencyKey'),
        json_extract(payload_json, '$.status'),
        json_extract(payload_json, '$.leaseExpiresAt')
      )
      WHERE store_name = 'opportunity_pipeline_submit_tasks_v2';
    CREATE INDEX IF NOT EXISTS idx_operations_active_dedupe
      ON native_records (
        json_extract(payload_json, '$.taskType'),
        json_extract(payload_json, '$.metadata.dedupeKey'),
        json_extract(payload_json, '$.status'),
        updated_at
      )
      WHERE store_name = 'operations';
    CREATE INDEX IF NOT EXISTS idx_opportunity_request_attempts_quota
      ON opportunity_submit_request_attempts_v1 (business_date, tenant_id, shop_id, status);
    CREATE INDEX IF NOT EXISTS idx_opportunity_request_attempts_task
      ON opportunity_submit_request_attempts_v1 (task_id, status, updated_at);
  `);
}

function tableExists(database, tableName) {
  const row = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return !!row;
}

function readRuntimeMeta(database, key, fallback = null) {
  if (!tableExists(database, "runtime_meta")) return fallback;
  const row = database.prepare("SELECT value_json FROM runtime_meta WHERE key = ?").get(key);
  return row ? decodeJson(row.value_json, fallback) : fallback;
}

function writeRuntimeMeta(database, key, value, ts = nowIso()) {
  database.prepare(`
    INSERT INTO runtime_meta (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, encodeJson(value), ts);
}

function runQuickCheck(database) {
  const quickRows = database.prepare("PRAGMA quick_check").all();
  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
  const quickValues = quickRows.map((row) => String(firstValue(row)));
  return {
    ok: quickValues.length === 1 && quickValues[0] === "ok" && foreignKeyRows.length === 0,
    quickCheck: quickValues,
    foreignKeyViolations: foreignKeyRows
  };
}

function createBackup(database, args = {}) {
  const reason = normalizeString(args.reason) || "manual";
  const baseDir = normalizeString(args.backupDir) || path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(baseDir, { recursive: true });
  const backupPath = normalizeString(args.backupPath) || path.join(baseDir, `chihu-business-${reason}-${safeTimestamp()}-schema-v${SCHEMA_VERSION}.sqlite3`);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  const ts = nowIso();
  if (tableExists(database, "runtime_meta")) {
    writeRuntimeMeta(database, `backup:${reason}:latest`, { backupPath, reason, schemaVersion: SCHEMA_VERSION, createdAt: ts }, ts);
  }
  return { ok: true, backupPath, reason, createdAt: ts, sizeBytes: fileSize(backupPath) };
}

function createStartupBackupIfNeeded(database, existingVersion) {
  if (!fs.existsSync(databasePath) || fileSize(databasePath) <= 0) return null;
  if (!tableExists(database, "runtime_meta") && !existingVersion) return null;
  const markerKey = `startup-backup:schema-v${SCHEMA_VERSION}`;
  const previous = readRuntimeMeta(database, markerKey, null);
  if (previous && previous.backupPath && fileSize(previous.backupPath) > 0) return previous;
  const backup = createBackup(database, { reason: `startup-v${existingVersion || 0}-to-v${SCHEMA_VERSION}` });
  if (tableExists(database, "runtime_meta")) writeRuntimeMeta(database, markerKey, backup);
  return backup;
}

function quarantineDatabaseFiles(reason = "corrupt") {
  const ts = safeTimestamp();
  const moved = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${databasePath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const target = `${source}.${reason}.${ts}`;
    fs.renameSync(source, target);
    moved.push({ source, target });
  }
  return { ok: true, reason, quarantinedAt: nowIso(), moved };
}

function abandonOpenJobs(database, reason = "worker-startup") {
  const ts = nowIso();
  const jobs = database.prepare(`
    UPDATE catalog_jobs
    SET status = 'abandoned', updated_at = ?, progress_json = ?
    WHERE status IN ('queued', 'running')
  `).run(ts, encodeJson({ abandonedReason: reason }));
  const runs = database.prepare(`
    UPDATE catalog_runs
    SET status = 'abandoned', finished_at = COALESCE(finished_at, ?), termination_reason = 'job-owner-lost', updated_at = ?
    WHERE status = 'running'
  `).run(ts, ts);
  return { ok: true, abandonedJobs: jobs.changes, abandonedRuns: runs.changes, reason, recoveredAt: ts };
}

function initializeDatabase(args = {}) {
  if (db) return getHealth();

  databasePath = String(args.databasePath || workerData.databasePath || "").trim();
  if (!databasePath) throw createError("NATIVE_DATA_BAD_PATH", "Missing SQLite database path");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  let database = new DatabaseSync(databasePath);
  try {
    applyConnectionPragmas(database);

    const check = runQuickCheck(database);
    if (!check.ok) {
      throw createError("NATIVE_DATA_CORRUPT", "SQLite quick_check failed", check);
    }

    const existingVersion = firstValue(database.prepare("PRAGMA user_version").get()) || 0;
    if (existingVersion > SCHEMA_VERSION) {
      throw createError("NATIVE_DATA_UNSUPPORTED_SCHEMA", `Unsupported SQLite schema version ${existingVersion}`, {
        currentVersion: existingVersion,
        supportedVersion: SCHEMA_VERSION
      });
    }

    createStartupBackupIfNeeded(database, existingVersion);

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(loadSchemaSql());
      applyForwardCompatibleFixups(database);
      abandonOpenJobs(database);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      const ts = nowIso();
      writeRuntimeMeta(database, "schema", { schemaVersion: SCHEMA_VERSION, initializedAt: ts }, ts);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    db = database;
    openedAt = nowIso();
    return getHealth();
  } catch (error) {
    try {
      database.close();
    } catch {}
    if (error && error.code === "NATIVE_DATA_CORRUPT" && args.recoveredFromCorruption !== true) {
      const quarantine = quarantineDatabaseFiles("corrupt");
      database = new DatabaseSync(databasePath);
      try {
        applyConnectionPragmas(database);
        database.exec("BEGIN IMMEDIATE");
        database.exec(loadSchemaSql());
        applyForwardCompatibleFixups(database);
        database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        const ts = nowIso();
        writeRuntimeMeta(database, "schema", { schemaVersion: SCHEMA_VERSION, initializedAt: ts, recoveredFromCorruption: true }, ts);
        writeRuntimeMeta(database, "corruption-recovery", quarantine, ts);
        database.exec("COMMIT");
        db = database;
        openedAt = nowIso();
        return getHealth();
      } catch (recoveryError) {
        try {
          database.close();
        } catch {}
        throw recoveryError;
      }
    }
    throw error;
  }
}

function quickCheck() {
  return runQuickCheck(ensureDb());
}

function listTables() {
  const rows = ensureDb().prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  return rows.map((row) => row.name);
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function getHealth() {
  const database = ensureDb();
  const tables = listTables();
  const missingTables = EXPECTED_TABLES.filter((name) => !tables.includes(name));
  const check = quickCheck();
  const sqliteVersion = firstValue(database.prepare("SELECT sqlite_version() AS version").get());
  return {
    ok: check.ok && missingTables.length === 0,
    schemaVersion: SCHEMA_VERSION,
    userVersion: pragmaGet("PRAGMA user_version"),
    databasePath,
    openedAt,
    sqliteVersion,
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron || "",
    journalMode: pragmaGet("PRAGMA journal_mode"),
    foreignKeys: pragmaGet("PRAGMA foreign_keys"),
    busyTimeout: pragmaGet("PRAGMA busy_timeout"),
    walAutoCheckpoint: pragmaGet("PRAGMA wal_autocheckpoint"),
    tableCount: tables.length,
    expectedTableCount: EXPECTED_TABLES.length,
    missingTables,
    quickCheck: check,
    sizeBytes: fileSize(databasePath),
    walSizeBytes: fileSize(`${databasePath}-wal`),
    shmSizeBytes: fileSize(`${databasePath}-shm`)
  };
}

function closeDatabase() {
  if (!db) return { ok: true, closed: false };
  db.close();
  db = null;
  return { ok: true, closed: true };
}

function validatePageSize(value, fallback = 100, max = 500) {
  const n = Math.floor(Number(value || fallback));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function normalizeIdentity(args = {}) {
  const platform = String(args.platform || "doudian");
  const tenantId = String(args.tenantId || "").trim();
  const shopId = String(args.shopId || "").trim();
  const storeGeneration = Math.floor(Number(args.storeGeneration || args.generation || 1));
  if (platform !== "doudian") throw createError("NATIVE_DATA_BAD_ARGUMENT", "Unsupported platform", { platform });
  if (!tenantId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Missing tenantId");
  if (!shopId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Missing shopId");
  if (!Number.isInteger(storeGeneration) || storeGeneration <= 0) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Invalid storeGeneration", { storeGeneration });
  }
  return { platform, tenantId, shopId, storeGeneration };
}

function getStoreIdentity(identity) {
  return ensureDb().prepare(`
    SELECT * FROM doudian_store_identities
    WHERE tenant_id = ? AND shop_id = ? AND generation = ?
  `).get(identity.tenantId, identity.shopId, identity.storeGeneration);
}

function assertActiveStoreIdentity(identity) {
  const row = getStoreIdentity(identity);
  if (!row) throw createError("NATIVE_DATA_STORE_NOT_FOUND", "Store identity is not registered", identity);
  if (row.lifecycle !== "active") {
    throw createError("NATIVE_DATA_STORE_TOMBSTONED", "Store generation is tombstoned", {
      tenantId: identity.tenantId,
      shopId: identity.shopId,
      storeGeneration: identity.storeGeneration,
      tombstonedAt: row.tombstoned_at
    });
  }
  return row;
}

function upsertStoreIdentity(args = {}) {
  const { platform, tenantId, shopId, storeGeneration } = normalizeIdentity(args);
  const ts = nowIso();
  const contractVersion = String(args.identityContractVersion || "unverified-phase2");
  const current = getStoreIdentity({ platform, tenantId, shopId, storeGeneration });
  if (current && current.lifecycle === "tombstoned" && args.allowReviveTombstoned !== true) {
    throw createError("NATIVE_DATA_STORE_TOMBSTONED", "Tombstoned store generation cannot be revived", {
      tenantId,
      shopId,
      storeGeneration,
      tombstonedAt: current.tombstoned_at
    });
  }
  ensureDb().prepare(`
    INSERT INTO doudian_store_identities (
      tenant_id, shop_id, generation, platform, identity_contract_version,
      lifecycle, namespace_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(tenant_id, shop_id, generation) DO UPDATE SET
      lifecycle = 'active',
      tombstoned_at = NULL,
      namespace_json = excluded.namespace_json,
      updated_at = excluded.updated_at
  `).run(
    tenantId,
    shopId,
    storeGeneration,
    platform,
    contractVersion,
    encodeJson(args.namespace || {}),
    ts,
    ts
  );
  return { ok: true, platform, tenantId, shopId, storeGeneration, updatedAt: ts };
}

function tombstoneStoreIdentity(args = {}) {
  const identity = normalizeIdentity(args);
  const database = ensureDb();
  const ts = nowIso();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database.prepare(`
      UPDATE doudian_store_identities
      SET lifecycle = 'tombstoned', tombstoned_at = COALESCE(tombstoned_at, ?), updated_at = ?
      WHERE tenant_id = ? AND shop_id = ? AND generation = ? AND lifecycle = 'active'
    `).run(ts, ts, identity.tenantId, identity.shopId, identity.storeGeneration);

    const jobs = database.prepare(`
      UPDATE catalog_jobs
      SET status = 'superseded', updated_at = ?, progress_json = ?
      WHERE tenant_id = ? AND shop_id = ? AND store_generation = ? AND status IN ('queued', 'running')
    `).run(ts, encodeJson({ tombstonedAt: ts, reason: args.reason || "store-tombstone" }), identity.tenantId, identity.shopId, identity.storeGeneration);

    const runs = database.prepare(`
      UPDATE catalog_runs
      SET status = 'superseded', finished_at = COALESCE(finished_at, ?), termination_reason = 'superseded', updated_at = ?
      WHERE tenant_id = ? AND shop_id = ? AND store_generation = ? AND status = 'running'
    `).run(ts, ts, identity.tenantId, identity.shopId, identity.storeGeneration);

    const heads = database.prepare(`
      UPDATE catalog_heads
      SET validity = 'deleted', invalidated_at = ?, invalidation_reason = ?, updated_at = ?
      WHERE coverage_key IN (
        SELECT DISTINCT coverage_key FROM catalog_runs
        WHERE tenant_id = ? AND shop_id = ? AND store_generation = ?
      )
    `).run(ts, String(args.reason || "store-tombstone"), ts, identity.tenantId, identity.shopId, identity.storeGeneration);

    const opportunityCleanup = cancelStoreOpportunityState(database, identity, ts, String(args.reason || "store-tombstone"));

    database.exec("COMMIT");
    return {
      ok: true,
      changed: result.changes,
      cancelledJobs: jobs.changes,
      cancelledRuns: runs.changes,
      deletedHeads: heads.changes,
      opportunityCleanup,
      tenantId: identity.tenantId,
      shopId: identity.shopId,
      storeGeneration: identity.storeGeneration,
      nextGeneration: identity.storeGeneration + 1,
      tombstonedAt: ts
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const NATIVE_RECORD_STORES = new Set([
  "stores",
  "groups",
  "business_latest",
  "funds_latest",
  "violations_latest",
  "stale_scan_runs",
  "stale_candidates",
  "stale_execute_runs",
  "bulk_delete_scan_runs_v1",
  "bulk_delete_candidates_v1",
  "bulk_delete_execute_runs_v1",
  "bulk_delete_operation_events_v1",
  "opportunity_clue_scan_runs_v1",
  "opportunity_clue_candidates_v1",
  "opportunity_product_scan_runs_v1",
  "opportunity_product_candidates_v1",
  "opportunity_prematch_runs_v1",
  "opportunity_prematch_candidates_v1",
  "opportunity_execute_runs_v1",
  "opportunity_submit_attempts_v1",
  "opportunity_pipeline_runs_v2",
  "opportunity_pipeline_store_runs_v2",
  "opportunity_store_category_snapshots_v2",
  "opportunity_store_category_ledger_v2",
  "opportunity_clue_cache_v2",
  "opportunity_clue_cache_shards_v2",
  "opportunity_clue_word_cache_v2",
  "opportunity_clue_word_cache_shards_v2",
  "opportunity_official_clue_words_cache_v1",
  "opportunity_official_clue_goods_cache_v1",
  "opportunity_official_clue_goods_cache_shards_v1",
  "opportunity_benefit_product_indexes_v1",
  "opportunity_submit_history_records_v1",
  "opportunity_submit_history_sync_v1",
  "opportunity_submit_history_product_indexes_v1",
  "opportunity_pipeline_candidates_v2",
  "opportunity_pipeline_submit_tasks_v2",
  "opportunity_pipeline_operation_events_v2",
  "opportunity_submit_rate_state_v1",
  "opportunity_submit_global_rate_state_v1",
  "opportunity_submit_attempt_groups_v1",
  "opportunity_submit_contract_snapshots_v1",
  "remote_feature_records_v1",
  "operations",
  "runtime_meta"
]);

const DEFAULT_TENANT_ID = "local-user";

function normalizeRecordStoreName(value) {
  const storeName = normalizeString(value);
  if (!storeName || !NATIVE_RECORD_STORES.has(storeName)) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Unsupported native record store", { storeName });
  }
  return storeName;
}

function normalizeRecordPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native record payload must be an object");
  }
  return { ...value };
}

function recordIdFor(storeName, recordOrId) {
  if (recordOrId && typeof recordOrId === "object") {
    return normalizeString(recordOrId.id || recordOrId.recordId || recordOrId.runId || recordOrId.operationId || recordOrId.attemptId || recordOrId.candidateId || recordOrId.shopId || recordOrId.groupId);
  }
  return normalizeString(recordOrId);
}

function maxStoreGeneration(database, tenantId, shopId) {
  const row = database.prepare(`
    SELECT MAX(generation) AS value FROM doudian_store_identities
    WHERE tenant_id = ? AND shop_id = ?
  `).get(tenantId, shopId);
  return Number(row && row.value ? row.value : 0);
}

function activeStoreGeneration(database, tenantId, shopId) {
  const row = database.prepare(`
    SELECT generation FROM doudian_store_identities
    WHERE tenant_id = ? AND shop_id = ? AND lifecycle = 'active'
    ORDER BY generation DESC
    LIMIT 1
  `).get(tenantId, shopId);
  return Number(row && row.generation ? row.generation : 0);
}

function normalizeTenantId(record) {
  return normalizeString(record.tenantId || record.tenant_id || record.namespace?.tenantId) || DEFAULT_TENANT_ID;
}

function syncStoreRecord(database, record, ts) {
  const shopId = normalizeString(record.shopId || record.id);
  if (!shopId) return record;
  const tenantId = normalizeTenantId(record);
  const explicitGeneration = normalizeInteger(record.storeGeneration || record.generation);
  const generation = explicitGeneration || activeStoreGeneration(database, tenantId, shopId) || maxStoreGeneration(database, tenantId, shopId) + 1 || 1;
  const nextRecord = { ...record, id: shopId, shopId, tenantId, storeGeneration: generation };
  upsertStoreIdentity({
    platform: "doudian",
    tenantId,
    shopId,
    storeGeneration: generation,
    identityContractVersion: normalizeString(record.identityContractVersion) || "local-store-ledger-v1",
    namespace: record.namespace || { source: "store-ledger" }
  });
  database.prepare(`
    INSERT INTO doudian_stores (
      tenant_id, shop_id, generation, platform, shop_name, partition, group_id,
      status, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'doudian', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, shop_id, generation) DO UPDATE SET
      shop_name = excluded.shop_name,
      partition = excluded.partition,
      group_id = excluded.group_id,
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    tenantId,
    shopId,
    generation,
    normalizeString(nextRecord.shopName) || shopId,
    normalizeString(nextRecord.partition),
    normalizeString(nextRecord.groupId || nextRecord.groupName),
    normalizeString(nextRecord.status) || "unknown",
    encodeJson(nextRecord),
    normalizeString(nextRecord.createdAt) || ts,
    ts
  );
  return nextRecord;
}

function syncGroupRecord(database, record, ts) {
  const groupId = normalizeString(record.groupId || record.id || record.groupName);
  const groupName = normalizeString(record.groupName || record.name || groupId);
  if (!groupId || !groupName) return record;
  const tenantId = normalizeTenantId(record);
  database.prepare(`
    INSERT INTO doudian_store_groups (tenant_id, group_id, group_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, group_id) DO UPDATE SET
      group_name = excluded.group_name,
      updated_at = excluded.updated_at
  `).run(tenantId, groupId, groupName, normalizeString(record.createdAt) || ts, ts);
  return { ...record, id: groupId, groupId, groupName, tenantId };
}

function prepareNativeRecord(storeName, record, ts) {
  if (storeName === "stores") return syncStoreRecord(ensureDb(), record, ts);
  if (storeName === "groups") return syncGroupRecord(ensureDb(), record, ts);
  return record;
}

function formatNativeRecord(row) {
  if (!row) return null;
  const record = decodeJson(row.payload_json, {});
  if (record && typeof record === "object" && !Array.isArray(record)) {
    return { ...record, id: record.id || row.record_id };
  }
  return record;
}

function putNativeRecord(args = {}, options = {}) {
  const database = ensureDb();
  const storeName = normalizeRecordStoreName(args.storeName || args.store);
  const ts = nowIso();
  const input = normalizeRecordPayload(args.record || args.payload || args.value);
  let record = { ...input };
  let recordId = recordIdFor(storeName, record);
  if (!recordId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native record requires id", { storeName });

  database.exec("BEGIN IMMEDIATE");
  try {
    record = prepareNativeRecord(storeName, { ...record, id: record.id || recordId }, ts);
    recordId = recordIdFor(storeName, record);
    const payloadJson = options.payloadJson && storeName !== "stores" && storeName !== "groups"
      ? String(options.payloadJson)
      : encodeJson(record);
    database.prepare(`
      INSERT INTO native_records (store_name, record_id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(store_name, record_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(storeName, recordId, payloadJson, normalizeString(record.createdAt) || ts, ts);
    database.exec("COMMIT");
    const result = {
      ok: true,
      storeName,
      recordId,
      payloadBytes: Buffer.byteLength(payloadJson, "utf8")
    };
    if (!options.omitRecord) result.record = record;
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function putManyNativeRecords(args = {}) {
  const database = ensureDb();
  const storeName = normalizeRecordStoreName(args.storeName || args.store);
  const inputs = Array.isArray(args.records || args.items || args.values) ? (args.records || args.items || args.values) : [];
  const ts = nowIso();
  if (!inputs.length) {
    return {
      ok: true,
      storeName,
      count: 0,
      records: args.omitRecords === true ? undefined : [],
      payloadBytes: 0
    };
  }

  const records = [];
  let totalPayloadBytes = 0;
  const statement = database.prepare(`
    INSERT INTO native_records (store_name, record_id, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(store_name, record_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const input of inputs) {
      let record = normalizeRecordPayload(input);
      let recordId = recordIdFor(storeName, record);
      if (!recordId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native record requires id", { storeName });
      record = prepareNativeRecord(storeName, { ...record, id: record.id || recordId }, ts);
      recordId = recordIdFor(storeName, record);
      const payloadJson = encodeJson(record);
      totalPayloadBytes += Buffer.byteLength(payloadJson, "utf8");
      statement.run(storeName, recordId, payloadJson, normalizeString(record.createdAt) || ts, ts);
      if (args.omitRecords !== true) records.push(record);
    }
    database.exec("COMMIT");
    return {
      ok: true,
      storeName,
      count: inputs.length,
      records: args.omitRecords === true ? undefined : records,
      payloadBytes: totalPayloadBytes
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function acquireNativeOperation(args = {}) {
  const database = ensureDb();
  const operation = normalizeRecordPayload(args.operation || args.record);
  const operationId = normalizeString(operation.operationId || operation.id);
  const taskType = normalizeString(operation.taskType);
  const dedupeKey = normalizeString(operation.metadata && operation.metadata.dedupeKey);
  const cutoff = normalizeString(args.updatedAfter) || new Date(Date.now() - 30 * 60 * 1000).toISOString();
  if (!operationId || !taskType || !dedupeKey) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Operation acquire requires operationId, taskType and dedupeKey");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const existingRow = database.prepare(`
      SELECT * FROM native_records
      WHERE store_name = 'operations'
        AND updated_at >= ?
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.taskType') = ?
        AND json_extract(payload_json, '$.metadata.dedupeKey') = ?
        AND json_extract(payload_json, '$.status') IN ('created', 'running')
      ORDER BY updated_at DESC, record_id DESC
      LIMIT 1
    `).get(cutoff, taskType, dedupeKey);
    if (existingRow) {
      database.exec("COMMIT");
      return { acquired: false, operation: formatNativeRecord(existingRow) };
    }
    const ts = nowIso();
    const record = { ...operation, id: operationId, operationId, updatedAt: ts };
    database.prepare(`
      INSERT INTO native_records (store_name, record_id, payload_json, created_at, updated_at)
      VALUES ('operations', ?, ?, ?, ?)
    `).run(operationId, encodeJson(record), normalizeString(record.createdAt) || ts, ts);
    database.exec("COMMIT");
    return { acquired: true, operation: record };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const OPPORTUNITY_SUBMIT_NON_TERMINAL_TASK_STATUSES = new Set([
  "preparing",
  "ready",
  "queued",
  "running",
  "cancelling",
  "cooling_down",
  "deferred",
  "deferred_contract_mismatch",
  "manual_reconcile"
]);

const OPPORTUNITY_SUBMIT_CLAIM_PRIORITY = new Map([
  ["cancelling", 0],
  ["manual_reconcile", 1],
  ["deferred_contract_mismatch", 2],
  ["running", 3],
  ["cooling_down", 4],
  ["deferred", 5],
  ["ready", 6],
  ["queued", 7],
  ["preparing", 8]
]);

function opportunitySubmitTaskClaimable(task, now) {
  const status = normalizeString(task.status) || "";
  if (status === "ready" || status === "queued") return !task.resumeAt || timestampMs(task.resumeAt) <= timestampMs(now);
  if (status === "running") return !task.leaseExpiresAt || String(task.leaseExpiresAt) < now;
  if (status === "cooling_down") return Boolean(task.resumeAt && String(task.resumeAt) <= now);
  if (status === "deferred") {
    if (task.requiresExplicitResume === true || task.deferredReason === "retry_exhausted") return false;
    return Boolean(task.resumeAt && String(task.resumeAt) <= now);
  }
  return false;
}

function claimOpportunitySubmitTask(args = {}) {
  const database = ensureDb();
  const taskId = normalizeString(args.taskId || args.id);
  const ownerRunId = normalizeString(args.ownerRunId);
  const leaseExpiresAt = normalizeString(args.leaseExpiresAt);
  const now = normalizeString(args.now) || nowIso();
  if (!taskId || !ownerRunId || !leaseExpiresAt) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Submit task claim requires taskId, ownerRunId and leaseExpiresAt");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare(`
      SELECT * FROM native_records
      WHERE store_name = 'opportunity_pipeline_submit_tasks_v2' AND record_id = ?
    `).get(taskId);
    if (!row) {
      database.exec("COMMIT");
      return { claimed: false, reason: "missing", task: null };
    }
    const task = formatNativeRecord(row);
    const hasStoreIdentityFence = Boolean(normalizeString(task.tenantId) && normalizeInteger(task.storeGeneration || task.generation));
    const identity = hasStoreIdentityFence ? normalizeIdentity(task) : null;
    const storeIdentity = identity ? getStoreIdentity(identity) : null;
    if (identity && (!storeIdentity || storeIdentity.lifecycle !== "active")) {
      const cancelledTask = {
        ...task,
        status: "cancelled",
        leaseExpiresAt: undefined,
        lastError: storeIdentity ? "store generation is tombstoned" : "store identity is missing",
        finishedAt: task.finishedAt || now,
        updatedAt: now
      };
      database.prepare(`
        UPDATE native_records SET payload_json = ?, updated_at = ?
        WHERE store_name = 'opportunity_pipeline_submit_tasks_v2' AND record_id = ?
      `).run(encodeJson(cancelledTask), now, taskId);
      database.exec("COMMIT");
      return { claimed: false, reason: storeIdentity ? "store-tombstoned" : "store-missing", task: cancelledTask };
    }
    const claimable = opportunitySubmitTaskClaimable(task, now);
    if (!claimable) {
      database.exec("COMMIT");
      return { claimed: false, reason: "not-claimable", task };
    }
    const competingRows = database.prepare(`
      SELECT * FROM native_records
      WHERE store_name = 'opportunity_pipeline_submit_tasks_v2'
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.concurrencyKey') = ?
        AND json_extract(payload_json, '$.status') IN ('preparing', 'ready', 'queued', 'running', 'cancelling', 'cooling_down', 'deferred', 'deferred_contract_mismatch', 'manual_reconcile')
    `).all(normalizeString(task.concurrencyKey) || "");
    const competingTasks = competingRows.map((candidateRow) => ({
      row: candidateRow,
      task: formatNativeRecord(candidateRow)
    })).sort((left, right) => {
      const priority = (OPPORTUNITY_SUBMIT_CLAIM_PRIORITY.get(left.task.status) ?? 99) - (OPPORTUNITY_SUBMIT_CLAIM_PRIORITY.get(right.task.status) ?? 99);
      if (priority) return priority;
      const created = String(left.task.createdAt || left.row.created_at).localeCompare(String(right.task.createdAt || right.row.created_at));
      return created || String(left.row.record_id).localeCompare(String(right.row.record_id));
    });
    const canonicalTask = competingTasks[0];
    if (canonicalTask && canonicalTask.row.record_id !== taskId) {
      database.exec("COMMIT");
      return {
        claimed: false,
        reason: canonicalTask.task.status === "running" ? "concurrency-active" : "concurrency-nonterminal",
        task: canonicalTask.task
      };
    }
    const fencingToken = Math.max(0, normalizeInteger(task.fencingToken) || 0) + 1;
    const claimedTask = {
      ...task,
      status: "running",
      ownerRunId,
      fencingToken,
      startedAt: task.startedAt || now,
      leaseExpiresAt,
      resumeAt: undefined,
      updatedAt: now
    };
    database.prepare(`
      UPDATE native_records SET payload_json = ?, updated_at = ?
      WHERE store_name = 'opportunity_pipeline_submit_tasks_v2' AND record_id = ?
    `).run(encodeJson(claimedTask), now, taskId);
    database.exec("COMMIT");
    return { claimed: true, reason: "claimed", task: claimedTask, fencingToken };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const OPPORTUNITY_SUBMIT_RATE_STORE = "opportunity_submit_rate_state_v1";
const OPPORTUNITY_SUBMIT_GLOBAL_RATE_STORE = "opportunity_submit_global_rate_state_v1";
const OPPORTUNITY_SUBMIT_GROUP_STORE = "opportunity_submit_attempt_groups_v1";
const OPPORTUNITY_SUBMIT_CONTRACT_STORE = "opportunity_submit_contract_snapshots_v1";
const OPPORTUNITY_SUBMIT_TASK_STORE = "opportunity_pipeline_submit_tasks_v2";
const OPPORTUNITY_SUBMIT_CANDIDATE_STORE = "opportunity_pipeline_candidates_v2";
const OPPORTUNITY_SUBMIT_TERMINAL_CANDIDATE_STATUSES = new Set([
  "accepted", "submitted", "failed", "skipped", "cancelled", "quota_exhausted"
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const number = normalizeInteger(value);
  return Math.max(minimum, Math.min(maximum, number === null ? fallback : number));
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
}

function timestampMs(value, fallback = 0) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isoAfter(base, delayMs) {
  return new Date(timestampMs(base, Date.now()) + Math.max(0, Number(delayMs || 0))).toISOString();
}

function hashParts(domain, ...parts) {
  const hash = createHash("sha256");
  hash.update(`${Buffer.byteLength(String(domain), "utf8")}:${domain}`, "utf8");
  for (const part of parts) {
    const value = typeof part === "string" ? part : canonicalJson(part);
    hash.update(`|${Buffer.byteLength(value, "utf8")}:${value}`, "utf8");
  }
  return hash.digest("hex");
}

function deterministicJitterMs(maximum, ...parts) {
  const max = Math.max(0, normalizeInteger(maximum) || 0);
  if (!max) return 0;
  const value = Number.parseInt(hashParts("submit-jitter:v1", ...parts).slice(0, 12), 16);
  return value % (max + 1);
}

function nativeRecordRowById(database, storeName, recordId) {
  return database.prepare("SELECT * FROM native_records WHERE store_name = ? AND record_id = ?").get(storeName, recordId);
}

function nativeRecordById(database, storeName, recordId) {
  const row = nativeRecordRowById(database, storeName, recordId);
  return row ? formatNativeRecord(row) : null;
}

function putNativeRecordInTransaction(database, storeName, record, ts) {
  const normalized = normalizeRecordPayload(record);
  const recordId = normalizeString(normalized.id);
  if (!recordId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native transaction record requires id", { storeName });
  const existing = nativeRecordRowById(database, storeName, recordId);
  const next = { ...normalized, id: recordId, updatedAt: normalizeString(normalized.updatedAt) || ts };
  if (existing) {
    database.prepare(`
      UPDATE native_records SET payload_json = ?, updated_at = ?
      WHERE store_name = ? AND record_id = ?
    `).run(encodeJson(next), ts, storeName, recordId);
  } else {
    database.prepare(`
      INSERT INTO native_records (store_name, record_id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(storeName, recordId, encodeJson(next), normalizeString(next.createdAt) || ts, ts);
  }
  return next;
}

function normalizeSubmitPacingPolicy(input = {}) {
  const initialIntervalMs = boundedInteger(input.initialIntervalMs ?? input.submitPacingInitialIntervalMs, 15000, 1000, 10 * 60 * 1000);
  const minIntervalMs = boundedInteger(input.minIntervalMs ?? input.submitPacingMinIntervalMs, 10000, 500, initialIntervalMs);
  const maxIntervalMs = boundedInteger(input.maxIntervalMs ?? input.submitPacingMaxIntervalMs, 60000, initialIntervalMs, 10 * 60 * 1000);
  return {
    policyVersion: normalizeString(input.policyVersion) || "opportunity-submit-adaptive-v1",
    initialIntervalMs,
    minIntervalMs,
    maxIntervalMs,
    jitterMs: boundedInteger(input.jitterMs ?? input.submitPacingJitterMs, 1500, 0, 60000),
    successesToDecrease: boundedInteger(input.successesToDecrease ?? input.submitPacingSuccessesToDecrease, 4, 1, 100),
    decreaseMs: boundedInteger(input.decreaseMs ?? input.submitPacingDecreaseMs, 5000, 1, 60000),
    isolated429IncreaseMs: boundedInteger(input.isolated429IncreaseMs ?? input.submitPacingIsolated429IncreaseMs, 5000, 1, 60000),
    multiplier429: boundedNumber(input.multiplier429 ?? input.submitPacing429Multiplier, 1.5, 1, 10),
    maxCooldownMs: boundedInteger(input.maxCooldownMs ?? input.submitPacingMaxCooldownMs, 120000, 1000, 24 * 60 * 60 * 1000),
    idleResetMs: boundedInteger(input.idleResetMs ?? input.submitPacingIdleResetMs, 600000, 60000, 24 * 60 * 60 * 1000),
    globalBurstSpacingMs: boundedInteger(input.globalBurstSpacingMs ?? input.submitGlobalBurstSpacingMs, 500, 0, 60000),
    globalInitialMs: boundedInteger(input.globalInitialMs ?? input.submitGlobalPacingInitialMs, 15000, 1000, 10 * 60 * 1000),
    globalMaxMs: boundedInteger(input.globalMaxMs ?? input.submitGlobalPacingMaxMs, 60000, 1000, 10 * 60 * 1000),
    globalMultiplier429: boundedNumber(input.globalMultiplier429 ?? input.submitGlobalPacing429Multiplier, 1.5, 1, 10),
    globalDecreaseMs: boundedInteger(input.globalDecreaseMs ?? input.submitGlobalPacingDecreaseMs, 5000, 1, 60000),
    global429WindowMs: boundedInteger(input.global429WindowMs ?? input.submitGlobal429WindowMs, 120000, 10000, 60 * 60 * 1000),
    globalDistinctStores: boundedInteger(input.globalDistinctStores ?? input.submitGlobal429DistinctStores, 2, 2, 1000),
    globalStableWindowsToExit: boundedInteger(input.globalStableWindowsToExit ?? input.submitGlobalStableWindowsToExit, 2, 1, 100),
    storeThrottleBudgetMs: boundedInteger(input.storeThrottleBudgetMs ?? input.submitStoreThrottleBudgetMs, 1800000, 1000, 24 * 60 * 60 * 1000),
    retryLimit: boundedInteger(input.retryLimit ?? input.submitRetryLimit, 3, 1, 100)
  };
}

function opportunitySubmitRateId(task) {
  return `${normalizeString(task.tenantId) || DEFAULT_TENANT_ID}-${normalizeString(task.shopId) || ""}-${normalizeInteger(task.storeGeneration || task.generation) || 1}`;
}

function opportunitySubmitGlobalRateId(tenantId, endpointContract) {
  return `${tenantId}-${hashParts("submit-global-rate:v1", endpointContract).slice(0, 24)}`;
}

function schedulerLeaseMetaKey(tenantId, endpointContract) {
  return `opportunity-submit-scheduler-lease:${hashParts("submit-scheduler:v1", tenantId, endpointContract)}`;
}

function claimOpportunitySubmitSchedulerLease(args = {}) {
  const database = ensureDb();
  const tenantId = normalizeString(args.tenantId) || DEFAULT_TENANT_ID;
  const endpointContract = normalizeString(args.endpointContract) || "opportunitySubmitClue";
  const ownerId = normalizeString(args.ownerId || args.ownerRunId);
  const now = normalizeString(args.now) || nowIso();
  const leaseExpiresAt = normalizeString(args.leaseExpiresAt);
  if (!ownerId || !leaseExpiresAt || timestampMs(leaseExpiresAt) <= timestampMs(now)) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Scheduler lease requires ownerId and a future leaseExpiresAt");
  }
  const key = schedulerLeaseMetaKey(tenantId, endpointContract);
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readRuntimeMeta(database, key, null);
    if (current && current.ownerId !== ownerId && timestampMs(current.leaseExpiresAt) >= timestampMs(now)) {
      database.exec("COMMIT");
      return { claimed: false, reason: "lease-active", lease: current };
    }
    const fencingToken = Math.max(0, normalizeInteger(current && current.fencingToken) || 0) + 1;
    const lease = {
      id: key,
      tenantId,
      endpointContract,
      ownerId,
      fencingToken,
      claimedAt: now,
      leaseExpiresAt,
      updatedAt: now
    };
    writeRuntimeMeta(database, key, lease, now);
    database.exec("COMMIT");
    return { claimed: true, reason: "claimed", lease };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function releaseOpportunitySubmitSchedulerLease(args = {}) {
  const database = ensureDb();
  const tenantId = normalizeString(args.tenantId) || DEFAULT_TENANT_ID;
  const endpointContract = normalizeString(args.endpointContract) || "opportunitySubmitClue";
  const ownerId = normalizeString(args.ownerId || args.schedulerOwnerId || args.ownerRunId);
  const fencingToken = normalizeInteger(args.fencingToken ?? args.schedulerFencingToken);
  const now = normalizeString(args.now) || nowIso();
  if (!ownerId || fencingToken == null) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Scheduler lease release requires ownerId and fencingToken");
  const key = schedulerLeaseMetaKey(tenantId, endpointContract);
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readRuntimeMeta(database, key, null);
    if (!current || current.ownerId !== ownerId || Number(current.fencingToken) !== fencingToken) {
      database.exec("COMMIT");
      return { released: false, reason: "stale-fence", lease: current };
    }
    const lease = {
      ...current,
      ownerId: "",
      leaseExpiresAt: now,
      releasedAt: now,
      updatedAt: now
    };
    writeRuntimeMeta(database, key, lease, now);
    database.exec("COMMIT");
    return { released: true, reason: "released", lease };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function assertOpportunitySchedulerLease(database, args, tenantId, endpointContract, now) {
  const key = schedulerLeaseMetaKey(tenantId, endpointContract);
  const lease = readRuntimeMeta(database, key, null);
  const ownerId = normalizeString(args.schedulerOwnerId || args.ownerRunId);
  const fencingToken = normalizeInteger(args.schedulerFencingToken);
  if (!lease || lease.ownerId !== ownerId || Number(lease.fencingToken) !== fencingToken || timestampMs(lease.leaseExpiresAt) < timestampMs(now)) {
    throw createError("NATIVE_DATA_STALE_FENCE", "Opportunity submit scheduler lease is stale", { tenantId, endpointContract });
  }
  return lease;
}

function assertOpportunityTaskFence(task, args, now, options = {}) {
  const ownerRunId = normalizeString(args.ownerRunId);
  const fencingToken = normalizeInteger(args.fencingToken);
  if (!task || task.ownerRunId !== ownerRunId || Number(task.fencingToken || 0) !== fencingToken) {
    throw createError("NATIVE_DATA_STALE_FENCE", "Opportunity submit task fence is stale", { taskId: args.taskId });
  }
  if (options.allowExpired !== true && task.leaseExpiresAt && timestampMs(task.leaseExpiresAt) < timestampMs(now)) {
    throw createError("NATIVE_DATA_STALE_FENCE", "Opportunity submit task lease expired", { taskId: args.taskId });
  }
}

function normalizeContractSnapshot(input = {}, task, ts) {
  const required = [
    "releaseId", "releaseManifestHash", "runnerArtifactHash", "adapterVersion", "scriptsVersion",
    "requestPlanHash", "submitContractVersion", "pacingPolicyHash", "adapterSnapshotHash"
  ];
  const snapshot = Object.fromEntries(required.map((key) => [key, normalizeString(input[key] ?? task[key]) || ""]));
  const missing = required.filter((key) => !snapshot[key]);
  if (missing.length) throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "Opportunity submit contract snapshot is incomplete", { missing });
  for (const key of required) {
    if (task[key] && normalizeString(task[key]) !== snapshot[key]) {
      throw createError("NATIVE_DATA_CONTRACT_MISMATCH", `Opportunity submit contract field changed: ${key}`, { key });
    }
  }
  return {
    id: hashParts("submit-contract-snapshot:v1", ...required.map((key) => snapshot[key])),
    ...snapshot,
    createdAt: normalizeString(input.createdAt) || ts,
    updatedAt: ts
  };
}

function initialStoreRateState(task, policy, ts) {
  return {
    id: opportunitySubmitRateId(task),
    tenantId: normalizeString(task.tenantId) || DEFAULT_TENANT_ID,
    shopId: normalizeString(task.shopId) || "",
    storeGeneration: normalizeInteger(task.storeGeneration || task.generation) || 1,
    mode: "normal",
    policyVersion: policy.policyVersion,
    intervalMs: policy.initialIntervalMs,
    consecutiveSuccesses: 0,
    consecutive429: 0,
    cooldownCount: 0,
    updatedAt: ts
  };
}

function settleStoreIdleRate(storeRate, policy, now) {
  const nowMs = timestampMs(now, Date.now());
  const lastActivityMs = Math.max(timestampMs(storeRate.lastAdmittedAt), timestampMs(storeRate.last429At));
  const stillCooling = Math.max(timestampMs(storeRate.cooldownUntil), timestampMs(storeRate.nextEligibleAt)) > nowMs;
  if (!lastActivityMs || stillCooling || nowMs - lastActivityMs < policy.idleResetMs) return storeRate;
  if (Number(storeRate.intervalMs || policy.initialIntervalMs) <= policy.initialIntervalMs && storeRate.mode === "normal") return storeRate;
  return {
    ...storeRate,
    mode: "normal",
    intervalMs: policy.initialIntervalMs,
    consecutiveSuccesses: 0,
    consecutive429: 0,
    cooldownStartedAt: undefined,
    cooldownUntil: undefined,
    nextEligibleAt: undefined,
    idleResetAt: now,
    updatedAt: now
  };
}

function initialGlobalRateState(tenantId, endpointContract, policy, ts) {
  return {
    id: opportunitySubmitGlobalRateId(tenantId, endpointContract),
    tenantId,
    endpointContract,
    mode: "inactive",
    policyVersion: policy.policyVersion,
    intervalMs: policy.globalInitialMs,
    burstSpacingMs: policy.globalBurstSpacingMs,
    rolling429Buckets: [],
    consecutiveAffectedWindows: 0,
    consecutiveStableWindows: 0,
    updatedAt: ts
  };
}

function settleGlobalStableWindows(globalRate, policy, now) {
  const nowMs = timestampMs(now, Date.now());
  const currentWindowStartedMs = nowMs - (nowMs % policy.global429WindowMs);
  const previousEvaluatedMs = timestampMs(globalRate.lastEvaluatedWindowStartedAt, currentWindowStartedMs);
  if (globalRate.mode !== "protective" || previousEvaluatedMs >= currentWindowStartedMs) {
    return { ...globalRate, lastEvaluatedWindowStartedAt: new Date(currentWindowStartedMs).toISOString() };
  }
  let intervalMs = Number(globalRate.intervalMs || policy.globalInitialMs);
  let consecutiveStableWindows = Number(globalRate.consecutiveStableWindows || 0);
  let consecutiveAffectedWindows = Number(globalRate.consecutiveAffectedWindows || 0);
  let mode = globalRate.mode;
  const buckets = Array.isArray(globalRate.rolling429Buckets) ? globalRate.rolling429Buckets : [];
  const elapsed = Math.min(20, Math.max(0, Math.floor((currentWindowStartedMs - previousEvaluatedMs) / policy.global429WindowMs)));
  for (let offset = 1; offset <= elapsed; offset += 1) {
    const windowStartedMs = previousEvaluatedMs + offset * policy.global429WindowMs;
    if (windowStartedMs >= currentWindowStartedMs) break;
    const key = new Date(windowStartedMs).toISOString();
    const affected = buckets.some((bucket) => bucket.windowStartedAt === key && Array.isArray(bucket.shopIds) && bucket.shopIds.length > 0);
    if (affected) {
      consecutiveStableWindows = 0;
      consecutiveAffectedWindows += 1;
    } else {
      consecutiveStableWindows += 1;
      intervalMs = Math.max(policy.globalInitialMs, intervalMs - policy.globalDecreaseMs);
      if (intervalMs <= policy.globalInitialMs && consecutiveStableWindows >= policy.globalStableWindowsToExit) {
        mode = "inactive";
        consecutiveAffectedWindows = 0;
      }
    }
  }
  return {
    ...globalRate,
    mode,
    intervalMs,
    consecutiveStableWindows,
    consecutiveAffectedWindows,
    rolling429Buckets: buckets.filter((bucket) => timestampMs(bucket.windowStartedAt) >= currentWindowStartedMs - policy.global429WindowMs * 2),
    lastEvaluatedWindowStartedAt: new Date(currentWindowStartedMs).toISOString()
  };
}

function opportunityQuotaUsage(database, args) {
  const candidateDispatched = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM opportunity_submit_attempts_v2
    WHERE business_date = ? AND tenant_id = ? AND shop_id = ? AND counts_against_daily_limit = 1
  `).get(args.businessDate, args.tenantId, args.shopId)?.count || 0);
  const candidateReserved = Number(database.prepare(`
    SELECT COALESCE(SUM(reserved_candidate_mutation_units), 0) AS count
    FROM opportunity_submit_request_attempts_v1
    WHERE business_date = ? AND tenant_id = ? AND shop_id = ? AND status = 'reserved'
  `).get(args.businessDate, args.tenantId, args.shopId)?.count || 0);
  const httpDispatched = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM opportunity_submit_request_attempts_v1
    WHERE business_date = ? AND tenant_id = ? AND endpoint_contract = ?
      AND status IN ('dispatched', 'accepted', 'partial', 'throttled', 'failed', 'unknown')
  `).get(args.businessDate, args.tenantId, args.endpointContract)?.count || 0);
  const httpReserved = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM opportunity_submit_request_attempts_v1
    WHERE business_date = ? AND tenant_id = ? AND endpoint_contract = ? AND status = 'reserved'
  `).get(args.businessDate, args.tenantId, args.endpointContract)?.count || 0);
  return { candidateDispatched, candidateReserved, httpDispatched, httpReserved };
}

function getOpportunitySubmitQuotaUsage(args = {}) {
  const tenantId = normalizeString(args.tenantId) || DEFAULT_TENANT_ID;
  const shopId = normalizeString(args.shopId) || "";
  const endpointContract = normalizeString(args.endpointContract) || "opportunitySubmitClue";
  const businessDateValue = normalizeString(args.businessDate) || businessDate();
  if (!shopId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Opportunity submit quota usage requires shopId");
  return {
    businessDate: businessDateValue,
    tenantId,
    shopId,
    endpointContract,
    ...opportunityQuotaUsage(ensureDb(), { businessDate: businessDateValue, tenantId, shopId, endpointContract })
  };
}

function summarizeOpportunitySubmitRun(args = {}) {
  const database = ensureDb();
  const runId = normalizeString(args.runId || args.operationId);
  if (!runId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Opportunity submit run summary requires runId");
  const endpointContract = normalizeString(args.endpointContract) || "opportunitySubmitClue";
  const businessDateValue = normalizeString(args.businessDate) || businessDate();
  const policy = normalizeSubmitPacingPolicy(args.policy);
  const candidateMutationLimit = boundedInteger(args.dailyCandidateMutationLimit, 1000, 1, 1000000);
  const httpRequestLimit = boundedInteger(args.dailyHttpRequestLimit, 1000, 1, 1000000);
  const tasks = nativeRecordRows(database, OPPORTUNITY_SUBMIT_TASK_STORE)
    .map(formatNativeRecord)
    .filter((task) => normalizeString(task.runId) === runId);
  const attempts = database.prepare(`
    SELECT attempt.*
    FROM opportunity_submit_request_attempts_v1 attempt
    INNER JOIN native_records task
      ON task.store_name = ? AND task.record_id = attempt.task_id
    WHERE json_extract(task.payload_json, '$.runId') = ?
    ORDER BY attempt.logical_group_id, attempt.retry_cycle, attempt.attempt_ordinal
  `).all(OPPORTUNITY_SUBMIT_TASK_STORE, runId);
  const dispatchedStatuses = new Set(["dispatched", "accepted", "partial", "throttled", "failed", "unknown"]);
  const dispatchedAttempts = attempts.filter((attempt) => dispatchedStatuses.has(normalizeString(attempt.status)));
  const throttleAttempts = dispatchedAttempts.filter((attempt) => normalizeString(attempt.status) === "throttled");
  const attemptsByGroup = new Map();
  for (const attempt of dispatchedAttempts) {
    const groupId = normalizeString(attempt.logical_group_id) || "";
    const groupAttempts = attemptsByGroup.get(groupId) || [];
    groupAttempts.push(attempt);
    attemptsByGroup.set(groupId, groupAttempts);
  }
  let recoveredAfterThrottleCount = 0;
  for (const groupAttempts of attemptsByGroup.values()) {
    let throttled = false;
    for (const attempt of groupAttempts) {
      const status = normalizeString(attempt.status);
      if (status === "throttled") throttled = true;
      else if (throttled && (status === "accepted" || status === "partial")) {
        recoveredAfterThrottleCount += 1;
        break;
      }
    }
  }
  const throttleBuckets = new Map();
  for (const attempt of throttleAttempts) {
    const occurredAt = timestampMs(attempt.resolved_at || attempt.updated_at || attempt.dispatched_at);
    const windowStartedMs = occurredAt - (occurredAt % policy.global429WindowMs);
    const bucket = throttleBuckets.get(windowStartedMs) || { shopIds: new Set(), count: 0 };
    bucket.shopIds.add(normalizeString(attempt.shop_id) || "");
    bucket.count += 1;
    throttleBuckets.set(windowStartedMs, bucket);
  }
  const globalThrottleCount = Array.from(throttleBuckets.values()).reduce((sum, bucket) => (
    bucket.shopIds.size >= policy.globalDistinctStores ? sum + bucket.count : sum
  ), 0);
  const storeIdentities = Array.from(new Map(tasks.map((task) => {
    const tenantId = normalizeString(task.tenantId) || DEFAULT_TENANT_ID;
    const shopId = normalizeString(task.shopId) || "";
    return [`${tenantId}:${shopId}`, { tenantId, shopId }];
  })).values()).filter((identity) => identity.shopId);
  const storeIntervals = Array.from(new Map(tasks.map((task) => [
    opportunitySubmitRateId(task),
    Number(nativeRecordById(database, OPPORTUNITY_SUBMIT_RATE_STORE, opportunitySubmitRateId(task))?.intervalMs || policy.initialIntervalMs)
  ])).values());
  const globalKeys = Array.from(new Map(tasks.map((task) => {
    const tenantId = normalizeString(task.tenantId) || DEFAULT_TENANT_ID;
    return [`${tenantId}:${endpointContract}`, { tenantId, endpointContract }];
  })).values());
  const globalRates = globalKeys.map((identity) => (
    nativeRecordById(database, OPPORTUNITY_SUBMIT_GLOBAL_RATE_STORE, opportunitySubmitGlobalRateId(identity.tenantId, identity.endpointContract))
      || initialGlobalRateState(identity.tenantId, identity.endpointContract, policy, nowIso())
  ));
  let dailyCandidateMutationUsed = 0;
  let dailyCandidateMutationReserved = 0;
  let dailyCandidateMutationRemaining = 0;
  for (const identity of storeIdentities) {
    const usage = opportunityQuotaUsage(database, { ...identity, businessDate: businessDateValue, endpointContract });
    dailyCandidateMutationUsed += usage.candidateDispatched;
    dailyCandidateMutationReserved += usage.candidateReserved;
    dailyCandidateMutationRemaining += Math.max(0, candidateMutationLimit - usage.candidateDispatched - usage.candidateReserved);
  }
  let dailyHttpRequestUsed = 0;
  let dailyHttpRequestReserved = 0;
  let dailyHttpRequestRemaining = 0;
  for (const identity of globalKeys) {
    const usage = opportunityQuotaUsage(database, {
      ...identity,
      businessDate: businessDateValue,
      shopId: storeIdentities.find((item) => item.tenantId === identity.tenantId)?.shopId || ""
    });
    dailyHttpRequestUsed += usage.httpDispatched;
    dailyHttpRequestReserved += usage.httpReserved;
    dailyHttpRequestRemaining += Math.max(0, httpRequestLimit - usage.httpDispatched - usage.httpReserved);
  }
  const firstHttpDispatchedAt = dispatchedAttempts
    .map((attempt) => normalizeString(attempt.dispatched_at || attempt.grant_consumed_at))
    .filter(Boolean)
    .sort()[0] || "";
  const lastHttpResolvedAt = dispatchedAttempts
    .map((attempt) => normalizeString(attempt.resolved_at || attempt.updated_at || attempt.dispatched_at))
    .filter(Boolean)
    .sort()
    .at(-1) || "";
  return {
    ok: true,
    runId,
    businessDate: businessDateValue,
    endpointContract,
    taskCount: tasks.length,
    shopCount: storeIdentities.length,
    throttleCount: throttleAttempts.length,
    recoveredAfterThrottleCount,
    globalThrottleCount,
    candidateMutationAttemptCount: dispatchedAttempts.reduce((sum, attempt) => sum + Number(attempt.reserved_candidate_mutation_units || 0), 0),
    httpRequestAttemptCount: dispatchedAttempts.length,
    maxStoreIntervalMs: storeIntervals.length ? Math.max(...storeIntervals) : policy.initialIntervalMs,
    averageStoreIntervalMs: storeIntervals.length ? Math.round(storeIntervals.reduce((sum, value) => sum + value, 0) / storeIntervals.length) : policy.initialIntervalMs,
    globalRateMode: globalRates.some((rate) => normalizeString(rate.mode) === "protective") ? "protective" : "inactive",
    globalIntervalMs: globalRates.length ? Math.max(...globalRates.map((rate) => Number(rate.intervalMs || policy.globalInitialMs))) : policy.globalInitialMs,
    dailyCandidateMutationUsed,
    dailyCandidateMutationReserved,
    dailyCandidateMutationRemaining,
    dailyHttpRequestUsed,
    dailyHttpRequestReserved,
    dailyHttpRequestRemaining,
    firstHttpDispatchedAt,
    lastHttpResolvedAt
  };
}

function candidateRowsForIds(database, candidateIds) {
  return candidateIds.map((candidateId) => {
    const row = nativeRecordRowById(database, OPPORTUNITY_SUBMIT_CANDIDATE_STORE, candidateId);
    if (!row) throw createError("NATIVE_DATA_NOT_FOUND", "Opportunity submit candidate is missing", { candidateId });
    return { row, candidate: formatNativeRecord(row) };
  });
}

function nextCandidateIndex(task, candidates) {
  const byId = new Map(candidates.map((candidate) => [normalizeString(candidate.id), candidate]));
  const index = (Array.isArray(task.candidateIds) ? task.candidateIds : []).findIndex((candidateId) => {
    const candidate = byId.get(normalizeString(candidateId));
    const status = normalizeString(candidate && (candidate.submitStatus || candidate.status)) || "";
    return !OPPORTUNITY_SUBMIT_TERMINAL_CANDIDATE_STATUSES.has(status);
  });
  return index < 0 ? (Array.isArray(task.candidateIds) ? task.candidateIds.length : 0) : index;
}

function admitOpportunitySubmitAttempt(args = {}) {
  const database = ensureDb();
  const taskId = normalizeString(args.taskId);
  const now = normalizeString(args.now) || nowIso();
  const endpointContract = normalizeString(args.endpointContract) || "opportunitySubmitClue";
  const businessDateValue = normalizeString(args.businessDate) || businessDate(new Date(now));
  const candidateIds = Array.from(new Set((Array.isArray(args.candidateIds) ? args.candidateIds : []).map(normalizeString).filter(Boolean)));
  if (!taskId || !candidateIds.length) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Submit admission requires taskId and candidateIds");
  const policy = normalizeSubmitPacingPolicy(args.policy);
  database.exec("BEGIN IMMEDIATE");
  try {
    const taskRow = nativeRecordRowById(database, OPPORTUNITY_SUBMIT_TASK_STORE, taskId);
    if (!taskRow) throw createError("NATIVE_DATA_NOT_FOUND", "Opportunity submit task is missing", { taskId });
    const task = formatNativeRecord(taskRow);
    assertOpportunityTaskFence(task, args, now);
    if (task.status !== "running") throw createError("NATIVE_DATA_BAD_ARGUMENT", "Opportunity submit task is not running", { taskId, status: task.status });
    const identity = normalizeIdentity(task);
    assertActiveStoreIdentity(identity);
    assertOpportunitySchedulerLease(database, args, identity.tenantId, endpointContract, now);
    const contractSnapshot = normalizeContractSnapshot(args.contractSnapshot || {}, task, now);
    putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_CONTRACT_STORE, contractSnapshot, now);

    const candidateEntries = candidateRowsForIds(database, candidateIds);
    if (candidateEntries.some(({ candidate }) => normalizeString(candidate.submitTaskId) !== taskId)) {
      throw createError("NATIVE_DATA_BAD_ARGUMENT", "Opportunity submit candidate belongs to another task", { taskId });
    }
    const clueId = normalizeString(args.clueId || candidateEntries[0].candidate.clueId) || "";
    if (candidateEntries.some(({ candidate }) => normalizeString(candidate.clueId) !== clueId)) {
      throw createError("NATIVE_DATA_BAD_ARGUMENT", "Logical submit group cannot mix clue ids", { taskId, clueId });
    }
    const requestBodyInput = typeof args.requestBodyCanonicalJson === "string"
      ? decodeJson(args.requestBodyCanonicalJson, null)
      : args.requestBody;
    if (!requestBodyInput || typeof requestBodyInput !== "object") {
      throw createError("NATIVE_DATA_BAD_ARGUMENT", "Submit admission requires a canonical request body");
    }
    const requestBodyCanonicalJson = canonicalJson(requestBodyInput);
    const requestBodyHash = sha256(requestBodyCanonicalJson);
    if (args.requestBodyHash && normalizeString(args.requestBodyHash) !== requestBodyHash) {
      throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "Submit request body hash mismatch");
    }
    const expectedGroupId = hashParts("submit-group:v1", taskId, clueId, candidateIds, requestBodyHash);
    const logicalGroupId = normalizeString(args.logicalGroupId) || expectedGroupId;
    if (logicalGroupId !== expectedGroupId) throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "Logical submit group id mismatch");
    const existingGroup = nativeRecordById(database, OPPORTUNITY_SUBMIT_GROUP_STORE, logicalGroupId);
    if (existingGroup) {
      if (canonicalJson(existingGroup.orderedCandidateIds || []) !== canonicalJson(candidateIds) || existingGroup.requestBodyHash !== requestBodyHash) {
        throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "Logical submit group snapshot changed", { logicalGroupId });
      }
      if (!new Set(["ready", "retry_waiting"]).has(existingGroup.status)) {
        throw createError("NATIVE_DATA_BAD_ARGUMENT", "Logical submit group is not admissible", { logicalGroupId, status: existingGroup.status });
      }
      if (candidateEntries.some(({ candidate }) => normalizeString(candidate.submitStatus || candidate.status) !== "retry_waiting")) {
        throw createError("NATIVE_DATA_BAD_ARGUMENT", "Retry group candidates must remain retry_waiting", { logicalGroupId });
      }
    } else if (candidateEntries.some(({ candidate }) => !new Set(["ready", "queued", "fallback"]).has(normalizeString(candidate.submitStatus || candidate.status)))) {
      throw createError("NATIVE_DATA_BAD_ARGUMENT", "New logical group contains a non-ready candidate", { logicalGroupId });
    }
    const retryCycle = Math.max(0, normalizeInteger(existingGroup && existingGroup.retryCycle) || 0);
    const attemptOrdinal = Math.max(1, normalizeInteger(existingGroup && existingGroup.nextAttemptOrdinal) || 1);
    if (attemptOrdinal > policy.retryLimit) {
      const exhaustedGroup = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_GROUP_STORE, {
        ...existingGroup,
        id: logicalGroupId,
        status: "retry_exhausted",
        updatedAt: now
      }, now);
      const deferredTask = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_TASK_STORE, {
        ...task,
        status: "deferred",
        deferredReason: "retry_exhausted",
        requiresExplicitResume: true,
        retryableRemainingCount: candidateIds.length,
        leaseExpiresAt: undefined,
        updatedAt: now
      }, now);
      database.exec("COMMIT");
      return { admitted: false, reason: "retry-exhausted", task: deferredTask, group: exhaustedGroup };
    }

    const rateId = opportunitySubmitRateId(task);
    const globalRateId = opportunitySubmitGlobalRateId(identity.tenantId, endpointContract);
    const storeRate = settleStoreIdleRate(
      nativeRecordById(database, OPPORTUNITY_SUBMIT_RATE_STORE, rateId) || initialStoreRateState(task, policy, now),
      policy,
      now
    );
    const globalRate = settleGlobalStableWindows(
      nativeRecordById(database, OPPORTUNITY_SUBMIT_GLOBAL_RATE_STORE, globalRateId) || initialGlobalRateState(identity.tenantId, endpointContract, policy, now),
      policy,
      now
    );
    if (storeRate.policyVersion !== policy.policyVersion || globalRate.policyVersion !== policy.policyVersion) {
      throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "Submit pacing policy requires an explicit migration", { policyVersion: policy.policyVersion });
    }
    const jitterMs = deterministicJitterMs(policy.jitterMs, identity.tenantId, identity.shopId, identity.storeGeneration, taskId, logicalGroupId, attemptOrdinal);
    const storeIntervalEligible = storeRate.lastAdmittedAt ? timestampMs(storeRate.lastAdmittedAt) + Number(storeRate.intervalMs || policy.initialIntervalMs) + jitterMs : 0;
    const storeCooldownEligible = Math.max(timestampMs(storeRate.cooldownUntil), timestampMs(storeRate.nextEligibleAt));
    const globalEligible = globalRate.mode === "protective"
      ? timestampMs(globalRate.nextEligibleAt)
      : globalRate.lastAdmittedAt
        ? timestampMs(globalRate.lastAdmittedAt) + Number(globalRate.burstSpacingMs || policy.globalBurstSpacingMs)
        : 0;
    const eligibleAtMs = Math.max(storeIntervalEligible, storeCooldownEligible, globalEligible);
    if (eligibleAtMs > timestampMs(now)) {
      const resumeAt = new Date(eligibleAtMs).toISOString();
      const delayedTask = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_TASK_STORE, {
        ...task,
        status: "cooling_down",
        resumeAt,
        leaseExpiresAt: undefined,
        ownerRunId: undefined,
        updatedAt: now
      }, now);
      database.exec("COMMIT");
      return { admitted: false, reason: "rate-delayed", task: delayedTask, resumeAt, jitterMs, storeRate, globalRate };
    }

    const candidateMutationLimit = boundedInteger(args.dailyCandidateMutationLimit, 1000, 1, 1000000);
    const httpRequestLimit = boundedInteger(args.dailyHttpRequestLimit, 1000, 1, 1000000);
    const usage = opportunityQuotaUsage(database, {
      businessDate: businessDateValue,
      tenantId: identity.tenantId,
      shopId: identity.shopId,
      endpointContract
    });
    if (usage.candidateDispatched + usage.candidateReserved + candidateIds.length > candidateMutationLimit ||
        usage.httpDispatched + usage.httpReserved + 1 > httpRequestLimit) {
      for (const { candidate } of candidateEntries) {
        putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_CANDIDATE_STORE, {
          ...candidate,
          eligible: false,
          estimatedCost: 0,
          status: "quota_exhausted",
          submitStatus: "quota_exhausted",
          skipReason: "daily_submit_quota_exhausted",
          updatedAt: now
        }, now);
      }
      const quotaTask = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_TASK_STORE, {
        ...task,
        status: "partial",
        quotaExhaustedCount: Number(task.quotaExhaustedCount || 0) + candidateIds.length,
        leaseExpiresAt: undefined,
        ownerRunId: undefined,
        finishedAt: now,
        updatedAt: now
      }, now);
      database.exec("COMMIT");
      return { admitted: false, reason: "quota-exhausted", task: quotaTask, usage, candidateMutationLimit, httpRequestLimit };
    }

    const attemptId = hashParts("submit-attempt:v1", logicalGroupId, retryCycle, attemptOrdinal);
    const quotaReservationId = hashParts("submit-quota-reservation:v1", attemptId);
    const httpGrantId = hashParts("submit-http-grant:v1", attemptId);
    const group = {
      ...(existingGroup || {}),
      id: logicalGroupId,
      taskId,
      clueId,
      orderedCandidateIds: candidateIds,
      requestPlanHash: contractSnapshot.requestPlanHash,
      requestBodyCanonicalJson,
      requestBodyHash,
      retryCycle,
      nextAttemptOrdinal: attemptOrdinal + 1,
      status: "sending",
      attempts: [
        ...(Array.isArray(existingGroup && existingGroup.attempts) ? existingGroup.attempts : []),
        {
          attemptId,
          attemptOrdinal,
          quotaReservationId,
          quotaBusinessDate: businessDateValue,
          reservedCandidateMutationUnits: candidateIds.length,
          reservedHttpRequestUnits: 1,
          httpGrantId,
          status: "reserved",
          admittedAt: now,
          persistedJitterMs: jitterMs,
          originGroupStatus: existingGroup?.status || "ready"
        }
      ],
      contractSnapshotId: contractSnapshot.id,
      createdAt: normalizeString(existingGroup && existingGroup.createdAt) || now,
      updatedAt: now
    };
    database.prepare(`
      INSERT INTO opportunity_submit_request_attempts_v1 (
        attempt_id, logical_group_id, retry_cycle, attempt_ordinal, task_id, tenant_id, shop_id,
        store_generation, endpoint_contract, business_date, quota_reservation_id, http_grant_id,
        reserved_candidate_mutation_units, reserved_http_request_units, status, admitted_at,
        payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'reserved', ?, ?, ?, ?)
    `).run(
      attemptId, logicalGroupId, retryCycle, attemptOrdinal, taskId, identity.tenantId, identity.shopId,
      identity.storeGeneration, endpointContract, businessDateValue, quotaReservationId, httpGrantId,
      candidateIds.length, now, encodeJson({ candidateIds, requestBodyHash, contractSnapshotId: contractSnapshot.id, jitterMs, originGroupStatus: existingGroup?.status || "ready" }), now, now
    );
    putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_GROUP_STORE, group, now);
    for (const { candidate } of candidateEntries) {
      putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_CANDIDATE_STORE, {
        ...candidate,
        status: "submitting",
        submitStatus: "sending",
        logicalGroupId,
        submitAttemptId: attemptId,
        attemptOrdinal,
        updatedAt: now
      }, now);
    }
    const nextStoreRate = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_RATE_STORE, {
      ...storeRate,
      mode: "normal",
      lastAdmittedAt: now,
      nextEligibleAt: isoAfter(now, Number(storeRate.intervalMs || policy.initialIntervalMs) + jitterMs),
      updatedAt: now
    }, now);
    const nextGlobalRate = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_GLOBAL_RATE_STORE, {
      ...globalRate,
      lastAdmittedAt: now,
      nextEligibleAt: isoAfter(now, globalRate.mode === "protective" ? Number(globalRate.intervalMs || policy.globalInitialMs) : Number(globalRate.burstSpacingMs || policy.globalBurstSpacingMs)),
      updatedAt: now
    }, now);
    const checkpointCandidates = candidateRowsForIds(database, Array.isArray(task.candidateIds) ? task.candidateIds : []).map(({ candidate }) => candidate);
    const nextTask = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_TASK_STORE, {
      ...task,
      inFlightAttemptId: attemptId,
      inFlightLogicalGroupId: logicalGroupId,
      inFlightCandidateIds: candidateIds,
      inFlightAttemptOrdinal: attemptOrdinal,
      quotaReservationId,
      httpGrantId,
      contractSnapshotId: contractSnapshot.id,
      checkpointVersion: "opportunity-submit-checkpoint-v1",
      nextCandidateIndex: nextCandidateIndex(task, checkpointCandidates),
      updatedAt: now
    }, now);
    database.exec("COMMIT");
    return {
      admitted: true,
      reason: "admitted",
      task: nextTask,
      group,
      attempt: { attemptId, logicalGroupId, retryCycle, attemptOrdinal, quotaReservationId, httpGrantId, businessDate: businessDateValue },
      quota: { ...usage, candidateMutationLimit, httpRequestLimit },
      rate: { store: nextStoreRate, global: nextGlobalRate, jitterMs }
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function updateSubmitGroupAttempt(group, attemptId, patch, ts) {
  const attempts = Array.isArray(group.attempts) ? group.attempts : [];
  let found = false;
  const nextAttempts = attempts.map((attempt) => {
    if (attempt.attemptId !== attemptId) return attempt;
    found = true;
    return { ...attempt, ...patch };
  });
  if (!found) throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "Logical submit group is missing the request attempt", { attemptId });
  return { ...group, attempts: nextAttempts, updatedAt: ts };
}

function consumeOpportunitySubmitHttpGrant(args = {}) {
  const database = ensureDb();
  const taskId = normalizeString(args.taskId);
  const attemptId = normalizeString(args.attemptId);
  const httpGrantId = normalizeString(args.httpGrantId);
  const now = normalizeString(args.now) || nowIso();
  if (!taskId || !attemptId || !httpGrantId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "HTTP grant dispatch requires taskId, attemptId and httpGrantId");
  database.exec("BEGIN IMMEDIATE");
  try {
    const task = nativeRecordById(database, OPPORTUNITY_SUBMIT_TASK_STORE, taskId);
    assertOpportunityTaskFence(task, args, now);
    if (task.inFlightAttemptId !== attemptId || task.httpGrantId !== httpGrantId) {
      throw createError("NATIVE_DATA_STALE_FENCE", "HTTP grant no longer matches the task checkpoint", { taskId, attemptId });
    }
    const attempt = database.prepare("SELECT * FROM opportunity_submit_request_attempts_v1 WHERE attempt_id = ?").get(attemptId);
    if (!attempt || attempt.task_id !== taskId || attempt.http_grant_id !== httpGrantId || attempt.status !== "reserved") {
      throw createError("NATIVE_DATA_STALE_FENCE", "HTTP grant is missing, stale, or already consumed", { taskId, attemptId });
    }
    assertOpportunitySchedulerLease(database, args, attempt.tenant_id, attempt.endpoint_contract, now);
    const payload = decodeJson(attempt.payload_json, {});
    const candidateIds = Array.isArray(payload.candidateIds) ? payload.candidateIds.map(normalizeString).filter(Boolean) : [];
    if (!candidateIds.length) throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "HTTP grant has no candidate snapshot", { attemptId });
    const candidateEntries = candidateRowsForIds(database, candidateIds);
    if (candidateEntries.some(({ candidate }) => candidate.submitAttemptId !== attemptId || normalizeString(candidate.submitStatus) !== "sending")) {
      throw createError("NATIVE_DATA_STALE_FENCE", "Candidate checkpoint changed before HTTP grant dispatch", { attemptId });
    }
    const updated = database.prepare(`
      UPDATE opportunity_submit_request_attempts_v1
      SET status = 'dispatched', grant_consumed_at = ?, dispatched_at = ?, updated_at = ?
      WHERE attempt_id = ? AND status = 'reserved' AND http_grant_id = ?
    `).run(now, now, now, attemptId, httpGrantId);
    if (updated.changes !== 1) throw createError("NATIVE_DATA_STALE_FENCE", "HTTP grant was consumed concurrently", { attemptId });
    const insertCandidateAttempt = database.prepare(`
      INSERT INTO opportunity_submit_attempts_v2 (
        attempt_id, attempt_key, execute_run_id, business_date, tenant_id, shop_id, clue_id,
        product_id, clue_category_id, relation_key, clue_key, clue_category_key, status,
        counts_against_daily_limit, request_hash, payload_json, created_at, updated_at, sent_at, resolved_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?, ?, ?, ?, NULL)
    `);
    for (const { candidate } of candidateEntries) {
      const candidateAttemptId = hashParts("submit-candidate-attempt:v1", attemptId, candidate.id);
      insertCandidateAttempt.run(
        candidateAttemptId,
        candidateAttemptId,
        attempt.business_date,
        attempt.tenant_id,
        attempt.shop_id,
        normalizeString(candidate.clueId) || "",
        normalizeString(candidate.productId) || "",
        normalizeString(candidate.clueLastCategoryId || candidate.clueCategoryId) || "",
        normalizeString(candidate.relationKey) || "",
        normalizeString(candidate.clueKey) || "",
        normalizeString(candidate.clueCategoryKey || candidate.clueLastCategoryKey) || "",
        normalizeString(payload.requestBodyHash) || "",
        encodeJson({
          candidateId: candidate.id,
          logicalGroupId: attempt.logical_group_id,
          requestAttemptId: attemptId,
          retryCycle: attempt.retry_cycle,
          attemptOrdinal: attempt.attempt_ordinal,
          quotaReservationId: attempt.quota_reservation_id,
          httpGrantId
        }),
        now,
        now,
        now
      );
    }
    const group = nativeRecordById(database, OPPORTUNITY_SUBMIT_GROUP_STORE, attempt.logical_group_id);
    if (!group || group.status !== "sending") throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "Logical submit group is not sending", { attemptId });
    const nextGroup = updateSubmitGroupAttempt(group, attemptId, {
      status: "dispatched",
      grantConsumedAt: now,
      dispatchedAt: now
    }, now);
    putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_GROUP_STORE, nextGroup, now);
    const nextTask = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_TASK_STORE, {
      ...task,
      httpGrantConsumedAt: now,
      dispatchedAt: now,
      candidateMutationAttemptCount: Number(task.candidateMutationAttemptCount || 0) + candidateIds.length,
      httpRequestAttemptCount: Number(task.httpRequestAttemptCount || 0) + 1,
      updatedAt: now
    }, now);
    const quota = opportunityQuotaUsage(database, {
      businessDate: attempt.business_date,
      tenantId: attempt.tenant_id,
      shopId: attempt.shop_id,
      endpointContract: attempt.endpoint_contract
    });
    database.exec("COMMIT");
    return { dispatched: true, task: nextTask, group: nextGroup, attemptId, httpGrantId, candidateMutationUnits: candidateIds.length, httpRequestUnits: 1, quota };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function normalizeResolvedCandidateStatus(value, fallback) {
  const status = normalizeString(value) || fallback;
  if (["accepted", "already_submitted", "submitted"].includes(status)) return "accepted";
  if (["failed", "rejected"].includes(status)) return "failed";
  if (status === "throttled" || status === "retry_waiting") return "retry_waiting";
  if (status === "skipped") return "skipped";
  if (status === "cancelled") return "cancelled";
  return "unknown";
}

function applyGlobalThrottle(globalRate, policy, shopId, now) {
  const nowMs = timestampMs(now, Date.now());
  const windowStartedAt = new Date(nowMs - (nowMs % policy.global429WindowMs)).toISOString();
  const buckets = (Array.isArray(globalRate.rolling429Buckets) ? globalRate.rolling429Buckets : [])
    .filter((bucket) => timestampMs(bucket.windowStartedAt) >= nowMs - policy.global429WindowMs * 2)
    .map((bucket) => ({ ...bucket, shopIds: Array.from(new Set(Array.isArray(bucket.shopIds) ? bucket.shopIds.map(String) : [])) }));
  let bucket = buckets.find((item) => item.windowStartedAt === windowStartedAt);
  if (!bucket) {
    bucket = { windowStartedAt, shopIds: [] };
    buckets.push(bucket);
  }
  if (!bucket.shopIds.includes(shopId)) bucket.shopIds.push(shopId);
  const affected = bucket.shopIds.length >= policy.globalDistinctStores;
  const firstAffectedSignal = affected && globalRate.lastAffectedWindowStartedAt !== windowStartedAt;
  const mode = affected ? "protective" : globalRate.mode;
  const intervalMs = firstAffectedSignal
    ? Math.min(policy.globalMaxMs, Math.max(policy.globalInitialMs, Math.ceil(Number(globalRate.intervalMs || policy.globalInitialMs) * policy.globalMultiplier429)))
    : Number(globalRate.intervalMs || policy.globalInitialMs);
  return {
    ...globalRate,
    mode,
    intervalMs,
    nextEligibleAt: mode === "protective" ? isoAfter(now, intervalMs) : globalRate.nextEligibleAt,
    rolling429Buckets: buckets,
    consecutiveAffectedWindows: firstAffectedSignal ? Number(globalRate.consecutiveAffectedWindows || 0) + 1 : Number(globalRate.consecutiveAffectedWindows || 0),
    consecutiveStableWindows: affected ? 0 : Number(globalRate.consecutiveStableWindows || 0),
    lastAffectedWindowStartedAt: affected ? windowStartedAt : globalRate.lastAffectedWindowStartedAt,
    lastEvaluatedWindowStartedAt: windowStartedAt,
    updatedAt: now
  };
}

function resolveOpportunitySubmitAttempt(args = {}) {
  const database = ensureDb();
  const taskId = normalizeString(args.taskId);
  const attemptId = normalizeString(args.attemptId);
  const now = normalizeString(args.now) || nowIso();
  const outcome = normalizeString(args.outcome);
  if (!taskId || !attemptId || !new Set(["accepted", "partial", "throttled", "failed", "unknown"]).has(outcome)) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Submit result requires taskId, attemptId and a supported outcome");
  }
  const policy = normalizeSubmitPacingPolicy(args.policy);
  database.exec("BEGIN IMMEDIATE");
  try {
    const task = nativeRecordById(database, OPPORTUNITY_SUBMIT_TASK_STORE, taskId);
    assertOpportunityTaskFence(task, args, now, { allowExpired: true });
    if (task.inFlightAttemptId !== attemptId) throw createError("NATIVE_DATA_STALE_FENCE", "Submit result no longer matches task checkpoint", { taskId, attemptId });
    const attempt = database.prepare("SELECT * FROM opportunity_submit_request_attempts_v1 WHERE attempt_id = ?").get(attemptId);
    if (!attempt || attempt.task_id !== taskId || attempt.status !== "dispatched") {
      throw createError("NATIVE_DATA_STALE_FENCE", "Submit request attempt is not dispatched", { taskId, attemptId });
    }
    assertOpportunitySchedulerLease(database, args, attempt.tenant_id, attempt.endpoint_contract, now);
    const group = nativeRecordById(database, OPPORTUNITY_SUBMIT_GROUP_STORE, attempt.logical_group_id);
    if (!group || group.status !== "sending") throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "Logical submit group is not sending", { attemptId });
    const candidateEntries = candidateRowsForIds(database, group.orderedCandidateIds || []);
    const resultByCandidateId = new Map((Array.isArray(args.candidateResults) ? args.candidateResults : [])
      .map((result) => [normalizeString(result.candidateId), result])
      .filter(([candidateId]) => Boolean(candidateId)));
    const fallbackStatus = outcome === "accepted" ? "accepted" : outcome === "throttled" ? "retry_waiting" : outcome === "failed" ? "failed" : "unknown";
    if (outcome === "partial" && resultByCandidateId.size !== candidateEntries.length) {
      throw createError("NATIVE_DATA_BAD_ARGUMENT", "Partial submit result must classify every candidate", { attemptId });
    }
    const resolvedCandidates = [];
    for (const { candidate } of candidateEntries) {
      const result = resultByCandidateId.get(normalizeString(candidate.id));
      const status = normalizeResolvedCandidateStatus(result && result.status, fallbackStatus);
      const next = {
        ...candidate,
        eligible: status === "retry_waiting",
        estimatedCost: status === "retry_waiting" ? 1 : 0,
        status: status === "accepted" ? "submitted" : status === "retry_waiting" ? "retry_waiting" : status,
        submitStatus: status,
        skipReason: status === "accepted"
          ? undefined
          : normalizeString(result && result.message) || (status === "failed" ? normalizeString(args.message) || candidate.skipReason : candidate.skipReason),
        submittedAt: status === "accepted" ? now : candidate.submittedAt,
        updatedAt: now
      };
      resolvedCandidates.push(putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_CANDIDATE_STORE, next, now));
      const candidateAttemptId = hashParts("submit-candidate-attempt:v1", attemptId, candidate.id);
      const candidateAttemptStatus = status === "retry_waiting" ? "throttled" : status === "accepted" ? "accepted" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "unknown";
      const row = database.prepare("SELECT payload_json FROM opportunity_submit_attempts_v2 WHERE attempt_id = ?").get(candidateAttemptId);
      if (!row) throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "Candidate mutation attempt is missing", { candidateAttemptId });
      database.prepare(`
        UPDATE opportunity_submit_attempts_v2
        SET status = ?, payload_json = ?, updated_at = ?, resolved_at = ?
        WHERE attempt_id = ? AND status = 'sending'
      `).run(
        candidateAttemptStatus,
        encodeJson({ ...decodeJson(row.payload_json, {}), responseClass: normalizeString(args.responseClass) || outcome, httpStatus: normalizeInteger(args.httpStatus), message: normalizeString(args.message) || "" }),
        now,
        now,
        candidateAttemptId
      );
    }
    database.prepare(`
      UPDATE opportunity_submit_request_attempts_v1
      SET status = ?, response_class = ?, payload_json = ?, resolved_at = ?, updated_at = ?
      WHERE attempt_id = ? AND status = 'dispatched'
    `).run(
      outcome,
      normalizeString(args.responseClass) || outcome,
      encodeJson({ ...decodeJson(attempt.payload_json, {}), httpStatus: normalizeInteger(args.httpStatus), message: normalizeString(args.message) || "" }),
      now,
      now,
      attemptId
    );

    const rateId = opportunitySubmitRateId(task);
    const globalRateId = opportunitySubmitGlobalRateId(attempt.tenant_id, attempt.endpoint_contract);
    const storeRate = nativeRecordById(database, OPPORTUNITY_SUBMIT_RATE_STORE, rateId) || initialStoreRateState(task, policy, now);
    const globalRate = nativeRecordById(database, OPPORTUNITY_SUBMIT_GLOBAL_RATE_STORE, globalRateId) || initialGlobalRateState(attempt.tenant_id, attempt.endpoint_contract, policy, now);
    let nextStoreRate = storeRate;
    let nextGlobalRate = globalRate;
    let resumeAt;
    if (outcome === "throttled") {
      const consecutive429 = Number(storeRate.consecutive429 || 0) + 1;
      const currentIntervalMs = Math.max(policy.initialIntervalMs, Number(storeRate.intervalMs || policy.initialIntervalMs));
      const increasedIntervalMs = consecutive429 > 1
        ? Math.ceil(currentIntervalMs * policy.multiplier429)
        : currentIntervalMs + policy.isolated429IncreaseMs;
      const intervalMs = Math.min(policy.maxIntervalMs, increasedIntervalMs);
      const generatedCooldownMs = Math.min(policy.maxCooldownMs, 30000 * (2 ** Math.max(0, consecutive429 - 1)));
      const cooldownJitterMs = deterministicJitterMs(policy.jitterMs, attempt.tenant_id, attempt.shop_id, attempt.store_generation, taskId, attempt.logical_group_id, attempt.attempt_ordinal, "cooldown");
      const platformRetryAfterMs = Math.max(0, normalizeInteger(args.retryAfterMs) || 0);
      const cooldownMs = Math.max(platformRetryAfterMs, Math.min(policy.maxCooldownMs, generatedCooldownMs + cooldownJitterMs));
      const cooldownUntil = isoAfter(now, cooldownMs);
      const nextAttemptJitterMs = deterministicJitterMs(
        policy.jitterMs,
        attempt.tenant_id,
        attempt.shop_id,
        attempt.store_generation,
        taskId,
        attempt.logical_group_id,
        Number(attempt.attempt_ordinal || 0) + 1
      );
      const intervalEligibleAtMs = timestampMs(storeRate.lastAdmittedAt) + intervalMs + nextAttemptJitterMs;
      const storeNextEligibleAt = new Date(Math.max(timestampMs(cooldownUntil), intervalEligibleAtMs)).toISOString();
      nextStoreRate = {
        ...storeRate,
        mode: "cooling_down",
        intervalMs,
        consecutiveSuccesses: 0,
        consecutive429,
        cooldownCount: Number(storeRate.cooldownCount || 0) + 1,
        cooldownStartedAt: now,
        cooldownUntil,
        nextEligibleAt: storeNextEligibleAt,
        last429At: now,
        lastHttpStatus: normalizeInteger(args.httpStatus) || 429,
        lastMessage: normalizeString(args.message) || "",
        updatedAt: now
      };
      nextGlobalRate = applyGlobalThrottle(globalRate, policy, attempt.shop_id, now);
      resumeAt = new Date(Math.max(timestampMs(storeNextEligibleAt), timestampMs(nextGlobalRate.nextEligibleAt))).toISOString();
    } else if (outcome === "accepted") {
      let consecutiveSuccesses = Number(storeRate.consecutiveSuccesses || 0) + 1;
      let intervalMs = Number(storeRate.intervalMs || policy.initialIntervalMs);
      if (consecutiveSuccesses >= policy.successesToDecrease) {
        intervalMs = Math.max(policy.minIntervalMs, intervalMs - policy.decreaseMs);
        consecutiveSuccesses = 0;
      }
      nextStoreRate = {
        ...storeRate,
        mode: "normal",
        intervalMs,
        consecutiveSuccesses,
        consecutive429: 0,
        cooldownStartedAt: undefined,
        cooldownUntil: undefined,
        updatedAt: now
      };
    }
    putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_RATE_STORE, nextStoreRate, now);
    putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_GLOBAL_RATE_STORE, nextGlobalRate, now);

    const throttlePauseMs = outcome === "throttled" && resumeAt ? Math.max(0, timestampMs(resumeAt) - timestampMs(now)) : 0;
    const accumulatedThrottlePauseMs = Number(task.throttlePauseMs || 0) + throttlePauseMs;
    const retryExhausted = outcome === "throttled" && attempt.attempt_ordinal >= policy.retryLimit;
    const throttleBudgetExceeded = outcome === "throttled" && !retryExhausted && accumulatedThrottlePauseMs >= policy.storeThrottleBudgetMs;
    const groupStatus = retryExhausted ? "retry_exhausted" : outcome === "throttled" ? "retry_waiting" : outcome;
    const nextGroup = updateSubmitGroupAttempt({ ...group, status: groupStatus }, attemptId, {
      status: outcome,
      resolvedAt: now,
      responseClass: normalizeString(args.responseClass) || outcome
    }, now);
    putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_GROUP_STORE, nextGroup, now);

    const allCandidates = candidateRowsForIds(database, Array.isArray(task.candidateIds) ? task.candidateIds : []).map(({ candidate }) => candidate);
    const statuses = allCandidates.map((candidate) => normalizeString(candidate.submitStatus || candidate.status) || "");
    const submittedCount = statuses.filter((status) => status === "accepted" || status === "submitted").length;
    const failedCount = statuses.filter((status) => status === "failed").length;
    const skippedCount = statuses.filter((status) => status === "skipped").length;
    const quotaExhaustedCount = statuses.filter((status) => status === "quota_exhausted").length;
    const unknownCount = statuses.filter((status) => status === "unknown").length;
    const retryableRemainingCount = statuses.filter((status) => status === "retry_waiting" || status === "ready" || status === "queued" || status === "fallback").length;
    const hasReady = statuses.some((status) => status === "ready" || status === "queued" || status === "fallback");
    if (outcome === "accepted" && hasReady) {
      const pacingResumeAtMs = Math.max(timestampMs(nextStoreRate.nextEligibleAt), timestampMs(nextGlobalRate.nextEligibleAt));
      resumeAt = pacingResumeAtMs > timestampMs(now) ? new Date(pacingResumeAtMs).toISOString() : undefined;
    }
    let taskStatus;
    let deferredReason;
    let requiresExplicitResume = false;
    if (retryExhausted) {
      taskStatus = "deferred";
      deferredReason = "retry_exhausted";
      requiresExplicitResume = true;
      resumeAt = undefined;
    } else if (throttleBudgetExceeded) {
      taskStatus = "deferred";
      deferredReason = "throttle_budget";
    } else if (outcome === "throttled") {
      taskStatus = "cooling_down";
    } else if (unknownCount > 0) {
      taskStatus = "manual_reconcile";
    } else if (hasReady) {
      taskStatus = "ready";
    } else if (failedCount > 0) {
      taskStatus = submittedCount || skippedCount ? "partial" : "failed";
    } else {
      taskStatus = "ok";
    }
    const terminalTask = new Set(["ok", "partial", "failed", "cancelled", "expired"]).has(taskStatus);
    const nextTask = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_TASK_STORE, {
      ...task,
      status: taskStatus,
      nextCandidateIndex: nextCandidateIndex(task, allCandidates),
      inFlightAttemptId: undefined,
      inFlightLogicalGroupId: undefined,
      inFlightCandidateIds: undefined,
      inFlightAttemptOrdinal: undefined,
      quotaReservationId: undefined,
      httpGrantId: undefined,
      leaseExpiresAt: undefined,
      ownerRunId: undefined,
      resumeAt,
      throttleCount: Number(task.throttleCount || 0) + (outcome === "throttled" ? 1 : 0),
      throttlePauseMs: accumulatedThrottlePauseMs,
      lastThrottleAt: outcome === "throttled" ? now : task.lastThrottleAt,
      retryableRemainingCount,
      deferredReason,
      requiresExplicitResume,
      submittedCount,
      failedCount,
      skippedCount,
      quotaExhaustedCount,
      unknownCount,
      remoteRequestCount: Number(task.remoteRequestCount || 0) + 1,
      finishedAt: terminalTask ? now : undefined,
      updatedAt: now
    }, now);
    database.exec("COMMIT");
    return { resolved: true, outcome, task: nextTask, group: nextGroup, rate: { store: nextStoreRate, global: nextGlobalRate }, resumeAt, retryExhausted, throttleBudgetExceeded };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function releaseOpportunitySubmitReservation(args = {}) {
  const database = ensureDb();
  const taskId = normalizeString(args.taskId);
  const attemptId = normalizeString(args.attemptId);
  const now = normalizeString(args.now) || nowIso();
  if (!taskId || !attemptId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Reservation release requires taskId and attemptId");
  database.exec("BEGIN IMMEDIATE");
  try {
    const task = nativeRecordById(database, OPPORTUNITY_SUBMIT_TASK_STORE, taskId);
    assertOpportunityTaskFence(task, args, now, { allowExpired: true });
    if (task.inFlightAttemptId !== attemptId) throw createError("NATIVE_DATA_STALE_FENCE", "Reservation no longer matches task checkpoint", { taskId, attemptId });
    const attempt = database.prepare("SELECT * FROM opportunity_submit_request_attempts_v1 WHERE attempt_id = ?").get(attemptId);
    if (!attempt || attempt.task_id !== taskId || attempt.status !== "reserved" || attempt.grant_consumed_at) {
      throw createError("NATIVE_DATA_STALE_FENCE", "Reservation cannot be proven unused", { taskId, attemptId });
    }
    assertOpportunitySchedulerLease(database, args, attempt.tenant_id, attempt.endpoint_contract, now);
    database.prepare(`
      UPDATE opportunity_submit_request_attempts_v1
      SET status = 'released', resolved_at = ?, updated_at = ?
      WHERE attempt_id = ? AND status = 'reserved' AND grant_consumed_at IS NULL
    `).run(now, now, attemptId);
    const payload = decodeJson(attempt.payload_json, {});
    const originStatus = payload.originGroupStatus === "retry_waiting" ? "retry_waiting" : "ready";
    const group = nativeRecordById(database, OPPORTUNITY_SUBMIT_GROUP_STORE, attempt.logical_group_id);
    if (!group) throw createError("NATIVE_DATA_CONTRACT_MISMATCH", "Released reservation group is missing", { attemptId });
    const nextGroup = updateSubmitGroupAttempt({ ...group, status: originStatus }, attemptId, { status: "released", resolvedAt: now }, now);
    putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_GROUP_STORE, nextGroup, now);
    const candidateEntries = candidateRowsForIds(database, Array.isArray(payload.candidateIds) ? payload.candidateIds : []);
    for (const { candidate } of candidateEntries) {
      putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_CANDIDATE_STORE, {
        ...candidate,
        status: originStatus,
        submitStatus: originStatus,
        eligible: true,
        estimatedCost: 1,
        submitAttemptId: undefined,
        updatedAt: now
      }, now);
    }
    const nextTask = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_TASK_STORE, {
      ...task,
      status: "ready",
      inFlightAttemptId: undefined,
      inFlightLogicalGroupId: undefined,
      inFlightCandidateIds: undefined,
      inFlightAttemptOrdinal: undefined,
      quotaReservationId: undefined,
      httpGrantId: undefined,
      leaseExpiresAt: undefined,
      ownerRunId: undefined,
      updatedAt: now
    }, now);
    database.exec("COMMIT");
    return { released: true, task: nextTask, group: nextGroup, attemptId };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const OPPORTUNITY_SUBMIT_AUTOMATIC_DEFER_REASONS = new Set([
  "authorization_wait",
  "login_wait",
  "throttle_budget"
]);

function deferOpportunitySubmitTask(args = {}) {
  const database = ensureDb();
  const taskId = normalizeString(args.taskId);
  const deferredReason = normalizeString(args.deferredReason || args.reason);
  const now = normalizeString(args.now) || nowIso();
  if (!taskId || !deferredReason) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Submit task deferral requires taskId and deferredReason");
  const contractMismatch = deferredReason === "contract_mismatch";
  if (!contractMismatch && !OPPORTUNITY_SUBMIT_AUTOMATIC_DEFER_REASONS.has(deferredReason)) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Submit task deferral reason is not supported", { deferredReason });
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const task = nativeRecordById(database, OPPORTUNITY_SUBMIT_TASK_STORE, taskId);
    if (!task) {
      database.exec("COMMIT");
      return { deferred: false, reason: "missing", task: null };
    }
    if (!OPPORTUNITY_SUBMIT_NON_TERMINAL_TASK_STATUSES.has(normalizeString(task.status))) {
      database.exec("COMMIT");
      return { deferred: false, reason: "terminal", task };
    }
    if (task.inFlightAttemptId) {
      database.exec("COMMIT");
      return { deferred: false, reason: "in-flight", task };
    }
    if (task.status === "running" && timestampMs(task.leaseExpiresAt) > timestampMs(now)) {
      database.exec("COMMIT");
      return { deferred: false, reason: "active-lease", task };
    }
    const requiresExplicitResume = contractMismatch || args.requiresExplicitResume === true;
    const resumeAt = requiresExplicitResume ? undefined : normalizeString(args.resumeAt) || now;
    const nextTask = putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_TASK_STORE, {
      ...task,
      status: contractMismatch ? "deferred_contract_mismatch" : "deferred",
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
      deferredReason,
      requiresExplicitResume,
      resumeAt,
      lastError: normalizeString(args.message) || task.lastError,
      recoverySource: normalizeString(args.recoverySource) || task.recoverySource,
      updatedAt: now
    }, now);
    database.exec("COMMIT");
    return { deferred: true, reason: deferredReason, task: nextTask };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function nudgeDeferredOpportunitySubmitTasks(args = {}) {
  const database = ensureDb();
  const now = normalizeString(args.now) || nowIso();
  const requestedReasons = new Set((Array.isArray(args.deferredReasons) ? args.deferredReasons : [args.deferredReason])
    .map(normalizeString)
    .filter((reason) => OPPORTUNITY_SUBMIT_AUTOMATIC_DEFER_REASONS.has(reason)));
  if (!requestedReasons.size) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Deferred submit task nudge requires a supported reason");
  const taskIds = new Set((Array.isArray(args.taskIds) ? args.taskIds : []).map(normalizeString).filter(Boolean));
  const shopIds = new Set((Array.isArray(args.shopIds) ? args.shopIds : []).map(normalizeString).filter(Boolean));
  database.exec("BEGIN IMMEDIATE");
  try {
    const rows = nativeRecordRows(database, OPPORTUNITY_SUBMIT_TASK_STORE);
    const tasks = [];
    for (const row of rows) {
      const task = formatNativeRecord(row);
      if (task.status !== "deferred" || task.requiresExplicitResume === true || task.inFlightAttemptId) continue;
      if (!requestedReasons.has(normalizeString(task.deferredReason))) continue;
      if (taskIds.size && !taskIds.has(normalizeString(task.id))) continue;
      if (shopIds.size && !shopIds.has(normalizeString(task.shopId))) continue;
      tasks.push(putNativeRecordInTransaction(database, OPPORTUNITY_SUBMIT_TASK_STORE, {
        ...task,
        resumeAt: now,
        recoverySource: normalizeString(args.recoverySource) || task.recoverySource,
        updatedAt: now
      }, now));
    }
    database.exec("COMMIT");
    return { nudged: tasks.length, tasks };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const OPPORTUNITY_ATTEMPT_STATUSES = new Set(["prepared", "sending", "accepted", "rejected", "throttled", "unknown", "confirmed", "failed", "cancelled"]);

function normalizeOpportunityAttemptStatus(value) {
  const status = normalizeString(value) || "unknown";
  return OPPORTUNITY_ATTEMPT_STATUSES.has(status) ? status : "unknown";
}

function putOpportunitySubmitAttempts(args = {}) {
  const database = ensureDb();
  const inputs = Array.isArray(args.attempts || args.records) ? (args.attempts || args.records) : [];
  if (!inputs.length) return { ok: true, count: 0 };
  const statement = database.prepare(`
    INSERT INTO opportunity_submit_attempts_v2 (
      attempt_id, attempt_key, execute_run_id, business_date, tenant_id, shop_id, clue_id,
      product_id, clue_category_id, relation_key, clue_key, clue_category_key, status,
      counts_against_daily_limit, request_hash, payload_json, created_at, updated_at, sent_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(attempt_key) DO UPDATE SET
      status = excluded.status,
      counts_against_daily_limit = excluded.counts_against_daily_limit,
      request_hash = excluded.request_hash,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at,
      sent_at = COALESCE(excluded.sent_at, opportunity_submit_attempts_v2.sent_at),
      resolved_at = COALESCE(excluded.resolved_at, opportunity_submit_attempts_v2.resolved_at)
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const input of inputs) {
      const attempt = normalizeRecordPayload(input);
      const attemptId = normalizeString(attempt.attemptId || attempt.id);
      const attemptKey = normalizeString(attempt.attemptKey) || attemptId;
      if (!attemptId || !attemptKey) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Opportunity attempt requires attemptId and attemptKey");
      const createdAt = normalizeString(attempt.createdAt) || nowIso();
      const updatedAt = normalizeString(attempt.updatedAt) || createdAt;
      const requestedExecuteRunId = normalizeString(attempt.executeRunId);
      const executeRunId = requestedExecuteRunId && database.prepare("SELECT 1 FROM opportunity_execute_runs_v2 WHERE run_id = ?").get(requestedExecuteRunId)
        ? requestedExecuteRunId
        : null;
      const attemptStatus = normalizeOpportunityAttemptStatus(attempt.status);
      const resolvedAt = ["prepared", "sending"].includes(attemptStatus)
        ? null
        : normalizeString(attempt.resolvedAt) || updatedAt;
      statement.run(
        attemptId,
        attemptKey,
        executeRunId,
        normalizeString(attempt.businessDate || attempt.date) || businessDate(new Date(createdAt)),
        normalizeString(attempt.tenantId) || DEFAULT_TENANT_ID,
        normalizeString(attempt.shopId) || "",
        normalizeString(attempt.clueId) || "",
        normalizeString(attempt.productId) || "",
        normalizeString(attempt.clueCategoryId || attempt.clueLastCategoryId) || "",
        normalizeString(attempt.relationKey) || "",
        normalizeString(attempt.clueKey) || "",
        normalizeString(attempt.clueCategoryKey) || "",
        attemptStatus,
        attempt.countsAgainstDailyLimit === false ? 0 : 1,
        normalizeString(attempt.requestHash) || "",
        encodeJson(attempt),
        createdAt,
        updatedAt,
        normalizeString(attempt.sentAt) || createdAt,
        resolvedAt
      );
    }
    database.exec("COMMIT");
    return { ok: true, count: inputs.length };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function countOpportunitySubmitAttempts(args = {}) {
  const businessDateValue = normalizeString(args.businessDate || args.date) || businessDate();
  const shopId = normalizeString(args.shopId);
  const row = shopId
    ? ensureDb().prepare(`
        SELECT COUNT(*) AS count FROM opportunity_submit_attempts_v2
        WHERE business_date = ? AND shop_id = ? AND counts_against_daily_limit = 1
      `).get(businessDateValue, shopId)
    : ensureDb().prepare(`
        SELECT shop_id, COUNT(*) AS count FROM opportunity_submit_attempts_v2
        WHERE business_date = ? AND counts_against_daily_limit = 1
        GROUP BY shop_id
      `).all(businessDateValue);
  return shopId
    ? { businessDate: businessDateValue, shopId, count: Number(row && row.count || 0) }
    : { businessDate: businessDateValue, counts: Object.fromEntries(row.map((item) => [item.shop_id, Number(item.count || 0)])) };
}

function listOpportunitySubmitDedupeKeys(args = {}) {
  const shopIds = Array.from(new Set(
    (Array.isArray(args.shopIds) ? args.shopIds : [args.shopId])
      .map(normalizeString)
      .filter(Boolean)
  ));
  const shopFilter = shopIds.length
    ? ` AND shop_id IN (${shopIds.map(() => "?").join(", ")})`
    : "";
  const rows = ensureDb().prepare(`
    SELECT relation_key, clue_key, clue_category_key
    FROM opportunity_submit_attempts_v2
    WHERE status IN ('accepted', 'confirmed')
    ${shopFilter}
  `).all(...shopIds);
  return {
    relationKeys: Array.from(new Set(rows.map((row) => row.relation_key).filter(Boolean))),
    clueKeys: Array.from(new Set(rows.map((row) => row.clue_key).filter(Boolean))),
    clueCategoryKeys: Array.from(new Set(rows.map((row) => row.clue_category_key).filter(Boolean)))
  };
}

function findOpportunitySubmitDedupeKeys(args = {}) {
  const database = ensureDb();
  const findKeys = (column, values) => {
    const requested = Array.from(new Set((Array.isArray(values) ? values : []).map(normalizeString).filter(Boolean)));
    const found = [];
    for (let index = 0; index < requested.length; index += 400) {
      const batch = requested.slice(index, index + 400);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = database.prepare(`
        SELECT ${column} AS value FROM opportunity_submit_attempts_v2
        WHERE status IN ('accepted', 'confirmed') AND ${column} IN (${placeholders})
        GROUP BY ${column}
      `).all(...batch);
      found.push(...rows.map((row) => row.value).filter(Boolean));
    }
    return found;
  };
  return {
    relationKeys: findKeys("relation_key", args.relationKeys),
    clueKeys: findKeys("clue_key", args.clueKeys),
    clueCategoryKeys: findKeys("clue_category_key", args.clueCategoryKeys)
  };
}

function cleanupOpportunitySubmitAttempts(args = {}) {
  const retentionDays = Math.max(1, Math.min(3650, Math.trunc(Number(args.failedRetentionDays || 90))));
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const result = ensureDb().prepare(`
    DELETE FROM opportunity_submit_attempts_v2
    WHERE status NOT IN ('accepted', 'confirmed') AND updated_at < ?
  `).run(cutoff);
  return { ok: true, deleted: result.changes, cutoff };
}

function cleanupLargeRecordSessions() {
  const now = Date.now();
  for (const [sessionId, session] of largeRecordSessions.entries()) {
    if (now - session.updatedAtMs > LARGE_RECORD_SESSION_TTL_MS) largeRecordSessions.delete(sessionId);
  }
}

function startLargeNativeRecordPut(args = {}) {
  cleanupLargeRecordSessions();
  const storeName = normalizeRecordStoreName(args.storeName || args.store);
  const recordId = normalizeString(args.recordId || args.id);
  const expectedBytes = normalizeInteger(args.expectedBytes ?? args.totalBytes);
  const expectedChunks = normalizeInteger(args.expectedChunks ?? args.totalChunks);
  if (!recordId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native large record requires recordId", { storeName });
  if (!Number.isInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_LARGE_RECORD_BYTES) {
    throw createError("NATIVE_DATA_MESSAGE_TOO_LARGE", "Native large record size is not allowed", {
      expectedBytes,
      max: MAX_LARGE_RECORD_BYTES
    });
  }
  if (!Number.isInteger(expectedChunks) || expectedChunks <= 0) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native large record requires expectedChunks", { storeName, recordId });
  }

  const sessionId = normalizeString(args.sessionId) || randomUUID();
  largeRecordSessions.set(sessionId, {
    sessionId,
    storeName,
    recordId,
    expectedBytes,
    expectedChunks,
    expectedHash: normalizeString(args.expectedHash || args.sha256),
    chunks: new Array(expectedChunks),
    receivedIndexes: new Set(),
    receivedBytes: 0,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now()
  });
  return { ok: true, sessionId, storeName, recordId, expectedBytes, expectedChunks };
}

function getLargeRecordSession(args = {}) {
  const sessionId = normalizeString(args.sessionId);
  if (!sessionId || !largeRecordSessions.has(sessionId)) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native large record session not found", { sessionId });
  }
  const session = largeRecordSessions.get(sessionId);
  session.updatedAtMs = Date.now();
  return session;
}

function putLargeNativeRecordChunk(args = {}) {
  cleanupLargeRecordSessions();
  const session = getLargeRecordSession(args);
  const index = normalizeInteger(args.index ?? args.chunkIndex);
  const chunk = typeof args.chunk === "string" ? args.chunk : null;
  if (!Number.isInteger(index) || index < 0 || index >= session.expectedChunks) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native large record chunk index is invalid", {
      sessionId: session.sessionId,
      index,
      expectedChunks: session.expectedChunks
    });
  }
  if (chunk === null) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native large record chunk must be a string", {
      sessionId: session.sessionId,
      index
    });
  }
  if (session.receivedIndexes.has(index)) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native large record chunk was already received", {
      sessionId: session.sessionId,
      index
    });
  }
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  if (chunkBytes > MAX_LARGE_RECORD_CHUNK_BYTES) {
    throw createError("NATIVE_DATA_MESSAGE_TOO_LARGE", "Native large record chunk is too large", {
      sessionId: session.sessionId,
      index,
      chunkBytes,
      max: MAX_LARGE_RECORD_CHUNK_BYTES
    });
  }
  if (session.receivedBytes + chunkBytes > session.expectedBytes) {
    throw createError("NATIVE_DATA_MESSAGE_TOO_LARGE", "Native large record exceeds expected size", {
      sessionId: session.sessionId,
      expectedBytes: session.expectedBytes,
      receivedBytes: session.receivedBytes + chunkBytes
    });
  }
  session.chunks[index] = chunk;
  session.receivedIndexes.add(index);
  session.receivedBytes += chunkBytes;
  return {
    ok: true,
    sessionId: session.sessionId,
    index,
    receivedChunks: session.receivedIndexes.size,
    expectedChunks: session.expectedChunks,
    receivedBytes: session.receivedBytes,
    expectedBytes: session.expectedBytes
  };
}

function commitLargeNativeRecordPut(args = {}) {
  const session = getLargeRecordSession(args);
  try {
    if (session.receivedIndexes.size !== session.expectedChunks) {
      throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native large record is missing chunks", {
        sessionId: session.sessionId,
        receivedChunks: session.receivedIndexes.size,
        expectedChunks: session.expectedChunks
      });
    }
    const payloadJson = session.chunks.join("");
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    if (payloadBytes !== session.expectedBytes) {
      throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native large record byte count mismatch", {
        sessionId: session.sessionId,
        payloadBytes,
        expectedBytes: session.expectedBytes
      });
    }
    if (session.expectedHash && sha256(payloadJson) !== session.expectedHash) {
      throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native large record hash mismatch", {
        sessionId: session.sessionId,
        expectedHash: session.expectedHash
      });
    }
    const record = JSON.parse(payloadJson);
    const recordId = recordIdFor(session.storeName, record);
    if (recordId !== session.recordId) {
      throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native large record id mismatch", {
        sessionId: session.sessionId,
        expectedRecordId: session.recordId,
        recordId
      });
    }
    const result = putNativeRecord(
      { storeName: session.storeName, record },
      { omitRecord: true, payloadJson }
    );
    return { ...result, largePayload: true, expectedHash: session.expectedHash || undefined };
  } finally {
    largeRecordSessions.delete(session.sessionId);
  }
}

function abortLargeNativeRecordPut(args = {}) {
  const sessionId = normalizeString(args.sessionId);
  const existed = sessionId ? largeRecordSessions.delete(sessionId) : false;
  return { ok: true, sessionId, aborted: existed };
}

function getNativeRecord(args = {}) {
  const storeName = normalizeRecordStoreName(args.storeName || args.store);
  const recordId = recordIdFor(storeName, args.id || args.recordId);
  if (!recordId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native record requires id", { storeName });
  const row = ensureDb().prepare("SELECT * FROM native_records WHERE store_name = ? AND record_id = ?").get(storeName, recordId);
  return formatNativeRecord(row);
}

function normalizeRecordIds(storeName, values) {
  const ids = Array.isArray(values) ? values : [];
  return Array.from(new Set(ids.map((value) => recordIdFor(storeName, value)).filter(Boolean)));
}

function getManyNativeRecords(args = {}) {
  const storeName = normalizeRecordStoreName(args.storeName || args.store);
  const recordIds = normalizeRecordIds(storeName, args.ids || args.recordIds);
  if (!recordIds.length) return [];
  const database = ensureDb();
  const records = new Map();
  for (let index = 0; index < recordIds.length; index += 400) {
    const chunk = recordIds.slice(index, index + 400);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database.prepare(`
      SELECT * FROM native_records
      WHERE store_name = ? AND record_id IN (${placeholders})
    `).all(storeName, ...chunk);
    for (const row of rows) records.set(row.record_id, formatNativeRecord(row));
  }
  return recordIds.map((recordId) => records.get(recordId)).filter(Boolean);
}

function listNativeRecords(args = {}) {
  const storeName = normalizeRecordStoreName(args.storeName || args.store);
  const limit = validatePageSize(args.limit, 10000, 50000);
  const cursor = normalizeString(args.cursor) || "";
  const rows = ensureDb().prepare(`
    SELECT * FROM native_records
    WHERE store_name = ? AND (? = '' OR record_id > ?)
    ORDER BY record_id
    LIMIT ?
  `).all(storeName, cursor, cursor, limit + 1);
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(formatNativeRecord);
  return {
    items,
    nextCursor: rows.length > limit ? pageRows[pageRows.length - 1].record_id : null,
    hasMore: rows.length > limit
  };
}

function nextRecordPrefix(prefix) {
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const code = prefix.charCodeAt(index);
    if (code < 0xffff) return `${prefix.slice(0, index)}${String.fromCharCode(code + 1)}`;
  }
  return `${prefix}\uffff`;
}

function queryNativeRecordsByPrefix(args = {}) {
  const storeName = normalizeRecordStoreName(args.storeName || args.store);
  const recordIdPrefix = normalizeString(args.recordIdPrefix);
  if (!recordIdPrefix) throw createError("NATIVE_DATA_BAD_ARGUMENT", "records.queryByPrefix requires recordIdPrefix");
  if (args.order !== undefined && args.order !== "updated_desc") {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "records.queryByPrefix only supports updated_desc");
  }
  const limit = validatePageSize(args.limit, 100, 1000);
  const cursor = args.cursor && typeof args.cursor === "object" ? args.cursor : {};
  const cursorUpdatedAt = normalizeString(cursor.updatedAt);
  const cursorRecordId = normalizeString(cursor.recordId);
  if ((cursorUpdatedAt && !cursorRecordId) || (!cursorUpdatedAt && cursorRecordId)) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "records.queryByPrefix cursor requires updatedAt and recordId");
  }
  const upperBound = nextRecordPrefix(recordIdPrefix);
  const cursorCondition = cursorUpdatedAt
    ? "AND (updated_at < ? OR (updated_at = ? AND record_id < ?))"
    : "";
  const params = [storeName, recordIdPrefix, upperBound];
  if (cursorUpdatedAt) params.push(cursorUpdatedAt, cursorUpdatedAt, cursorRecordId);
  const rows = ensureDb().prepare(`
    SELECT * FROM native_records
    WHERE store_name = ?
      AND record_id >= ?
      AND record_id < ?
      ${cursorCondition}
    ORDER BY updated_at DESC, record_id DESC
    LIMIT ?
  `).all(...params, limit + 1);
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(formatNativeRecord),
    nextCursor: rows.length > limit && last
      ? { updatedAt: last.updated_at, recordId: last.record_id }
      : null,
    hasMore: rows.length > limit
  };
}

function queryNativeOperations(args = {}) {
  const allowedStatuses = new Set(["created", "running", "cancelling", "interrupted", "reconciling", "succeeded", "partial", "failed", "cancelled"]);
  const statuses = Array.from(new Set((Array.isArray(args.statuses) ? args.statuses : [])
    .map(normalizeString)
    .filter((status) => allowedStatuses.has(status))));
  const taskType = normalizeString(args.taskType);
  const updatedAfter = normalizeString(args.updatedAfter);
  const limit = validatePageSize(args.limit, 200, 1000);
  const conditions = ["store_name = 'operations'"];
  const params = [];
  if (statuses.length) {
    conditions.push(`CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.status') END IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (taskType) {
    conditions.push("CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.taskType') END = ?");
    params.push(taskType);
  }
  if (updatedAfter) {
    conditions.push("updated_at >= ?");
    params.push(updatedAfter);
  }
  const rows = ensureDb().prepare(`
    SELECT * FROM native_records
    WHERE ${conditions.join(" AND ")}
    ORDER BY updated_at DESC, record_id DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map(formatNativeRecord);
}

function cleanupNativeOperations(args = {}) {
  const database = ensureDb();
  const terminalStatuses = ["succeeded", "partial", "failed", "cancelled"];
  const retentionDays = Math.max(1, Math.min(365, normalizeInteger(args.retentionDays) || 14));
  const maxTerminalRecords = Math.max(10, Math.min(10000, normalizeInteger(args.maxTerminalRecords) || 200));
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const statusPlaceholders = terminalStatuses.map(() => "?").join(", ");
  database.exec("BEGIN IMMEDIATE");
  try {
    const expired = database.prepare(`
      DELETE FROM native_records
      WHERE store_name = 'operations'
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.status') END IN (${statusPlaceholders})
        AND updated_at < ?
    `).run(...terminalStatuses, cutoff).changes;
    const overflow = database.prepare(`
      DELETE FROM native_records
      WHERE store_name = 'operations'
        AND record_id IN (
          SELECT record_id FROM native_records
          WHERE store_name = 'operations'
            AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.status') END IN (${statusPlaceholders})
          ORDER BY updated_at DESC, record_id DESC
          LIMIT -1 OFFSET ?
        )
    `).run(...terminalStatuses, maxTerminalRecords).changes;
    database.exec("COMMIT");
    return {
      ok: true,
      deleted: expired + overflow,
      expired,
      overflow,
      cutoff,
      retentionDays,
      maxTerminalRecords
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function nativeRecordRows(database, storeName) {
  return database.prepare("SELECT * FROM native_records WHERE store_name = ? ORDER BY record_id").all(storeName);
}

function nativeRecordMatchesIdentity(record, identity) {
  return normalizeTenantId(record) === identity.tenantId &&
    normalizeString(record.shopId) === identity.shopId &&
    (normalizeInteger(record.storeGeneration || record.generation) || 1) === identity.storeGeneration;
}

function updateNativeRecordPayload(database, row, record, ts) {
  database.prepare(`
    UPDATE native_records SET payload_json = ?, updated_at = ?
    WHERE store_name = ? AND record_id = ?
  `).run(encodeJson(record), ts, row.store_name, row.record_id);
}

function deleteNativeRecordRow(database, row) {
  return database.prepare("DELETE FROM native_records WHERE store_name = ? AND record_id = ?")
    .run(row.store_name, row.record_id).changes;
}

// Keep all UI-facing opportunity state consistent with the store tombstone in this transaction.
function cancelStoreOpportunityState(database, identity, ts, reason = "store-ledger-delete") {
  const affectedRunIds = new Set();
  const affectedTaskIds = new Set();
  const deletedClueCacheIds = new Set();
  const deletedWordCacheIds = new Set();
  const deletedOfficialGoodsCacheIds = new Set();
  const summary = {
    cancelledStoreRuns: 0,
    cancelledSubmitTasks: 0,
    cancelledCandidates: 0,
    unknownCandidates: 0,
    deletedCategoryRecords: 0,
    deletedCacheRecords: 0,
    deletedRateStates: 0,
    updatedGlobalRateStates: 0,
    finalizedPipelineRuns: 0,
    finalizedOperations: 0
  };

  for (const row of nativeRecordRows(database, "opportunity_pipeline_store_runs_v2")) {
    const record = formatNativeRecord(row);
    if (!nativeRecordMatchesIdentity(record, identity)) continue;
    const terminal = new Set(["ok", "partial", "failed", "cancelled", "skipped"]);
    if (terminal.has(normalizeString(record.status)) && record.phase === "finished") continue;
    if (record.runId) affectedRunIds.add(normalizeString(record.runId));
    updateNativeRecordPayload(database, row, {
      ...record,
      status: "cancelled",
      phase: "finished",
      skipReason: record.skipReason || reason,
      leaseExpiresAt: undefined,
      finishedAt: record.finishedAt || ts,
      updatedAt: ts
    }, ts);
    summary.cancelledStoreRuns += 1;
  }

  for (const row of nativeRecordRows(database, "opportunity_pipeline_submit_tasks_v2")) {
    const record = formatNativeRecord(row);
    if (!nativeRecordMatchesIdentity(record, identity)) continue;
    if (!OPPORTUNITY_SUBMIT_NON_TERMINAL_TASK_STATUSES.has(normalizeString(record.status))) continue;
    if (record.runId) affectedRunIds.add(normalizeString(record.runId));
    affectedTaskIds.add(normalizeString(record.id || row.record_id));
    const unresolvedDispatch = Boolean(record.inFlightAttemptId) || nativeRecordRows(database, OPPORTUNITY_SUBMIT_CANDIDATE_STORE)
      .map(formatNativeRecord)
      .some((candidate) => normalizeString(candidate.submitTaskId) === normalizeString(record.id || row.record_id) && ["sending", "submitting", "unknown"].includes(normalizeString(candidate.submitStatus || candidate.status)));
    updateNativeRecordPayload(database, row, {
      ...record,
      status: unresolvedDispatch ? "cancelling" : "cancelled",
      leaseExpiresAt: undefined,
      lastError: record.lastError || reason,
      finishedAt: unresolvedDispatch ? undefined : record.finishedAt || ts,
      updatedAt: ts
    }, ts);
    summary.cancelledSubmitTasks += 1;
  }

  for (const row of nativeRecordRows(database, "opportunity_pipeline_candidates_v2")) {
    const record = formatNativeRecord(row);
    const belongsToStore = nativeRecordMatchesIdentity(record, identity) ||
      affectedTaskIds.has(normalizeString(record.submitTaskId)) ||
      Array.from(affectedRunIds).some((runId) => normalizeString(record.storeRunId).startsWith(`${runId}-`) && normalizeString(record.shopId) === identity.shopId);
    if (!belongsToStore) continue;
    const currentStatus = normalizeString(record.submitStatus || record.status);
    if (["accepted", "submitted", "failed", "skipped", "cancelled", "quota_exhausted", "unknown"].includes(currentStatus)) continue;
    const unknown = currentStatus === "sending" || currentStatus === "submitting";
    updateNativeRecordPayload(database, row, {
      ...record,
      eligible: false,
      estimatedCost: 0,
      status: unknown ? "unknown" : "cancelled",
      submitStatus: unknown ? "unknown" : "cancelled",
      skipReason: record.skipReason || (unknown ? "store deleted while submit outcome was unresolved" : reason),
      updatedAt: ts
    }, ts);
    if (unknown) summary.unknownCandidates += 1;
    else summary.cancelledCandidates += 1;
  }

  for (const storeName of ["opportunity_store_category_snapshots_v2", "opportunity_store_category_ledger_v2"]) {
    for (const row of nativeRecordRows(database, storeName)) {
      const record = formatNativeRecord(row);
      if (!nativeRecordMatchesIdentity(record, identity)) continue;
      summary.deletedCategoryRecords += deleteNativeRecordRow(database, row);
    }
  }

  for (const row of nativeRecordRows(database, "opportunity_clue_cache_v2")) {
    const record = formatNativeRecord(row);
    if (!nativeRecordMatchesIdentity(record, identity) || record.cacheScope === "global") continue;
    deletedClueCacheIds.add(normalizeString(record.id || row.record_id));
    summary.deletedCacheRecords += deleteNativeRecordRow(database, row);
  }
  for (const row of nativeRecordRows(database, "opportunity_clue_cache_shards_v2")) {
    const record = formatNativeRecord(row);
    if (!deletedClueCacheIds.has(normalizeString(record.clueCacheKey))) continue;
    summary.deletedCacheRecords += deleteNativeRecordRow(database, row);
  }
  for (const row of nativeRecordRows(database, "opportunity_clue_word_cache_v2")) {
    const record = formatNativeRecord(row);
    if (!deletedClueCacheIds.has(normalizeString(record.clueCacheKey))) continue;
    deletedWordCacheIds.add(normalizeString(record.id || row.record_id));
    summary.deletedCacheRecords += deleteNativeRecordRow(database, row);
  }
  for (const row of nativeRecordRows(database, "opportunity_clue_word_cache_shards_v2")) {
    const record = formatNativeRecord(row);
    if (!deletedWordCacheIds.has(normalizeString(record.wordCacheKey))) continue;
    summary.deletedCacheRecords += deleteNativeRecordRow(database, row);
  }
  for (const row of nativeRecordRows(database, "opportunity_official_clue_words_cache_v1")) {
    const record = formatNativeRecord(row);
    if (!nativeRecordMatchesIdentity(record, identity)) continue;
    summary.deletedCacheRecords += deleteNativeRecordRow(database, row);
  }
  for (const row of nativeRecordRows(database, "opportunity_official_clue_goods_cache_v1")) {
    const record = formatNativeRecord(row);
    if (!nativeRecordMatchesIdentity(record, identity)) continue;
    deletedOfficialGoodsCacheIds.add(normalizeString(record.id || row.record_id));
    summary.deletedCacheRecords += deleteNativeRecordRow(database, row);
  }
  for (const row of nativeRecordRows(database, "opportunity_official_clue_goods_cache_shards_v1")) {
    const record = formatNativeRecord(row);
    if (!deletedOfficialGoodsCacheIds.has(normalizeString(record.cacheKey))) continue;
    summary.deletedCacheRecords += deleteNativeRecordRow(database, row);
  }
  for (const row of nativeRecordRows(database, "opportunity_benefit_product_indexes_v1")) {
    const record = formatNativeRecord(row);
    if (!nativeRecordMatchesIdentity(record, identity)) continue;
    summary.deletedCacheRecords += deleteNativeRecordRow(database, row);
  }
  for (const storeName of ["opportunity_submit_history_records_v1", "opportunity_submit_history_sync_v1", "opportunity_submit_history_product_indexes_v1"]) {
    for (const row of nativeRecordRows(database, storeName)) {
      const record = formatNativeRecord(row);
      if (!nativeRecordMatchesIdentity(record, identity)) continue;
      summary.deletedCacheRecords += deleteNativeRecordRow(database, row);
    }
  }

  for (const row of nativeRecordRows(database, OPPORTUNITY_SUBMIT_RATE_STORE)) {
    const record = formatNativeRecord(row);
    if (!nativeRecordMatchesIdentity(record, identity)) continue;
    summary.deletedRateStates += deleteNativeRecordRow(database, row);
  }
  for (const row of nativeRecordRows(database, OPPORTUNITY_SUBMIT_GLOBAL_RATE_STORE)) {
    const record = formatNativeRecord(row);
    if (normalizeTenantId(record) !== identity.tenantId) continue;
    const buckets = (Array.isArray(record.rolling429Buckets) ? record.rolling429Buckets : []).map((bucket) => ({
      ...bucket,
      shopIds: (Array.isArray(bucket.shopIds) ? bucket.shopIds : []).map(String).filter((shopId) => shopId !== identity.shopId)
    }));
    updateNativeRecordPayload(database, row, { ...record, rolling429Buckets: buckets, updatedAt: ts }, ts);
    summary.updatedGlobalRateStates += 1;
  }

  for (const runId of affectedRunIds) {
    if (!runId) continue;
    const runRow = database.prepare("SELECT * FROM native_records WHERE store_name = 'opportunity_pipeline_runs_v2' AND record_id = ?").get(runId);
    if (!runRow) continue;
    const run = formatNativeRecord(runRow);
    const storeRuns = nativeRecordRows(database, "opportunity_pipeline_store_runs_v2")
      .map(formatNativeRecord)
      .filter((record) => normalizeString(record.runId) === runId);
    const active = storeRuns.filter((record) => ["queued", "running", "submitting", "cancelling", "cooling_down"].includes(normalizeString(record.status)) && record.phase !== "finished");
    const unresolvedTasks = nativeRecordRows(database, OPPORTUNITY_SUBMIT_TASK_STORE)
      .map(formatNativeRecord)
      .filter((record) => normalizeString(record.runId) === runId && OPPORTUNITY_SUBMIT_NON_TERMINAL_TASK_STATUSES.has(normalizeString(record.status)));
    if (active.length) continue;
    if (unresolvedTasks.length) {
      updateNativeRecordPayload(database, runRow, {
        ...run,
        status: "partial",
        summary: {
          ...(run.summary || {}),
          manualReconcileCount: unresolvedTasks.filter((task) => task.status === "manual_reconcile" || task.status === "cancelling").length,
          retryableRemainingCount: unresolvedTasks.reduce((total, task) => total + Math.max(0, Number(task.retryableRemainingCount || 0)), 0)
        },
        updatedAt: ts
      }, ts);
      const operationId = normalizeString(run.operationId || run.runId);
      const operationRow = operationId
        ? database.prepare("SELECT * FROM native_records WHERE store_name = 'operations' AND record_id = ?").get(operationId)
        : null;
      if (operationRow) {
        const operation = formatNativeRecord(operationRow);
        if (["created", "running", "cancelling"].includes(normalizeString(operation.status))) {
          updateNativeRecordPayload(database, operationRow, {
            ...operation,
            status: "reconciling",
            resultSummary: "store deleted with dispatched opportunity submit outcome unresolved",
            updatedAt: ts
          }, ts);
          summary.finalizedOperations += 1;
        }
      }
      summary.finalizedPipelineRuns += 1;
      continue;
    }
    const submittedCount = storeRuns.reduce((total, record) => total + Math.max(0, Number(record.submittedCount || 0)), 0);
    const failedCount = storeRuns.reduce((total, record) => total + Math.max(0, Number(record.failedCount || 0)), 0);
    const cancelledCount = storeRuns.filter((record) => record.status === "cancelled").length;
    const status = submittedCount || storeRuns.some((record) => record.status === "ok" || record.status === "partial") ? "partial" : "cancelled";
    const nextRun = {
      ...run,
      status,
      processedStoreCount: storeRuns.length,
      submittedCount,
      failedCount,
      summary: {
        ...(run.summary || {}),
        processedStoreCount: storeRuns.length,
        totalStoreCount: Number(run.totalStoreCount || storeRuns.length),
        submittedCount,
        failedCount,
        cancelledStoreCount: cancelledCount
      },
      updatedAt: ts
    };
    updateNativeRecordPayload(database, runRow, nextRun, ts);
    summary.finalizedPipelineRuns += 1;

    const operationId = normalizeString(run.operationId || run.runId);
    const operationRow = operationId
      ? database.prepare("SELECT * FROM native_records WHERE store_name = 'operations' AND record_id = ?").get(operationId)
      : null;
    if (!operationRow) continue;
    const operation = formatNativeRecord(operationRow);
    if (!["created", "running"].includes(normalizeString(operation.status))) continue;
    updateNativeRecordPayload(database, operationRow, {
      ...operation,
      status,
      progress: 100,
      resultSummary: status === "cancelled" ? "store-deleted" : "partial-store-deleted",
      updatedAt: ts
    }, ts);
    summary.finalizedOperations += 1;
  }

  return summary;
}

function deleteNativeRecord(args = {}) {
  const database = ensureDb();
  const storeName = normalizeRecordStoreName(args.storeName || args.store);
  const recordId = recordIdFor(storeName, args.id || args.recordId);
  if (!recordId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native record requires id", { storeName });
  const ts = nowIso();
  let opportunityCleanup = null;
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare("SELECT * FROM native_records WHERE store_name = ? AND record_id = ?").get(storeName, recordId);
    if (storeName === "stores" && existing) {
      const record = decodeJson(existing.payload_json, {});
      const tenantId = normalizeTenantId(record);
      const shopId = normalizeString(record.shopId || record.id || recordId);
      const generation = normalizeInteger(record.storeGeneration || record.generation) || activeStoreGeneration(database, tenantId, shopId) || maxStoreGeneration(database, tenantId, shopId);
      if (shopId && generation) {
        const identity = { platform: "doudian", tenantId, shopId, storeGeneration: generation };
        database.prepare(`
          UPDATE doudian_store_identities
          SET lifecycle = 'tombstoned', tombstoned_at = COALESCE(tombstoned_at, ?), updated_at = ?
          WHERE tenant_id = ? AND shop_id = ? AND generation = ? AND lifecycle = 'active'
        `).run(ts, ts, tenantId, shopId, generation);
        database.prepare(`
          UPDATE catalog_jobs
          SET status = 'superseded', updated_at = ?, progress_json = ?
          WHERE tenant_id = ? AND shop_id = ? AND store_generation = ? AND status IN ('queued', 'running')
        `).run(ts, encodeJson({ tombstonedAt: ts, reason: args.reason || "store-ledger-delete" }), tenantId, shopId, generation);
        database.prepare(`
          UPDATE catalog_runs
          SET status = 'superseded', finished_at = COALESCE(finished_at, ?), termination_reason = 'superseded', updated_at = ?
          WHERE tenant_id = ? AND shop_id = ? AND store_generation = ? AND status = 'running'
        `).run(ts, ts, tenantId, shopId, generation);
        database.prepare(`
          UPDATE catalog_heads
          SET validity = 'deleted', invalidated_at = ?, invalidation_reason = ?, updated_at = ?
          WHERE coverage_key IN (
            SELECT DISTINCT coverage_key FROM catalog_runs
            WHERE tenant_id = ? AND shop_id = ? AND store_generation = ?
          )
        `).run(ts, String(args.reason || "store-ledger-delete"), ts, tenantId, shopId, generation);
        opportunityCleanup = cancelStoreOpportunityState(database, identity, ts, String(args.reason || "store-ledger-delete"));
      }
    }
    if (storeName === "groups" && existing) {
      const record = decodeJson(existing.payload_json, {});
      const tenantId = normalizeTenantId(record);
      const groupId = normalizeString(record.groupId || record.id || recordId);
      if (groupId) database.prepare("DELETE FROM doudian_store_groups WHERE tenant_id = ? AND group_id = ?").run(tenantId, groupId);
    }
    const result = database.prepare("DELETE FROM native_records WHERE store_name = ? AND record_id = ?").run(storeName, recordId);
    database.exec("COMMIT");
    return { ok: true, storeName, recordId, deleted: result.changes, deletedAt: ts, opportunityCleanup };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function deleteManyNativeRecords(args = {}) {
  const database = ensureDb();
  const storeName = normalizeRecordStoreName(args.storeName || args.store);
  if (storeName === "stores" || storeName === "groups") {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "records.deleteMany cannot bypass store/group delete side effects", { storeName });
  }
  const recordIds = normalizeRecordIds(storeName, args.ids || args.recordIds);
  const ts = nowIso();
  if (!recordIds.length) return { ok: true, storeName, requested: 0, deleted: 0, missing: 0, deletedAt: ts };
  let deleted = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < recordIds.length; index += 400) {
      const chunk = recordIds.slice(index, index + 400);
      const placeholders = chunk.map(() => "?").join(", ");
      deleted += database.prepare(`
        DELETE FROM native_records
        WHERE store_name = ? AND record_id IN (${placeholders})
      `).run(storeName, ...chunk).changes;
    }
    database.exec("COMMIT");
    return { ok: true, storeName, requested: recordIds.length, deleted, missing: recordIds.length - deleted, deletedAt: ts };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function latestNativeRecord(storeName) {
  const row = ensureDb().prepare(`
    SELECT * FROM native_records
    WHERE store_name = ?
    ORDER BY updated_at DESC, record_id DESC
    LIMIT 1
  `).get(storeName);
  return formatNativeRecord(row);
}

function filterNativeRecords(storeName, predicate) {
  return listNativeRecords({ storeName, limit: 50000 }).items.filter(predicate);
}

function saveFeatureRun(args = {}, defaultStoreName) {
  const record = args.record || args.run || args;
  return putNativeRecord({ storeName: args.storeName || defaultStoreName, record }).record;
}

function loadFeatureCandidates(args = {}, defaultStoreName) {
  const sourceRunId = normalizeString(args.sourceRunId || args.runId);
  const ids = new Set(Array.isArray(args.candidateIds) ? args.candidateIds.map((id) => normalizeString(id)).filter(Boolean) : []);
  return filterNativeRecords(args.storeName || defaultStoreName, (item) => {
    if (sourceRunId && normalizeString(item.sourceRunId || item.runId) !== sourceRunId) return false;
    if (!ids.size) return true;
    const keys = [item.id, item.candidateId, `${item.shopId || ""}-${item.productId || ""}`].map((key) => normalizeString(key)).filter(Boolean);
    return keys.some((key) => ids.has(key));
  });
}

function getLatestRunForJob(jobId) {
  return ensureDb().prepare(`
    SELECT run_id, status FROM catalog_runs
    WHERE job_id = ?
    ORDER BY started_at DESC
    LIMIT 1
  `).get(jobId);
}

function acquireCatalogJob(args = {}) {
  const identity = normalizeIdentity(args);
  const database = ensureDb();
  const ts = nowIso();
  const coverage = buildCoverageDescriptor({ ...args, ...identity });
  const coverageKey = normalizeString(args.coverageKey) || coverage.coverageKey;
  const forceRefresh = args.completeness === "force-refresh" || args.forceRefresh === true;

  database.exec("BEGIN IMMEDIATE");
  try {
    if (args.ensureStoreIdentity === true) upsertStoreIdentity({ ...args, ...identity });
    assertActiveStoreIdentity(identity);

    const active = database.prepare(`
      SELECT * FROM catalog_jobs
      WHERE active_coverage_key = ? AND status IN ('queued', 'running')
      ORDER BY job_generation DESC
      LIMIT 1
    `).get(coverageKey);

    if (active && !forceRefresh) {
      const activeRun = getLatestRunForJob(active.job_id);
      database.exec("COMMIT");
      return formatJob(active, { reused: true, runId: activeRun && activeRun.run_id, runStatus: activeRun && activeRun.status });
    }

    if (active && forceRefresh) {
      database.prepare(`
        UPDATE catalog_jobs
        SET status = 'superseded', updated_at = ?
        WHERE job_id = ?
      `).run(ts, active.job_id);
      database.prepare(`
        UPDATE catalog_runs
        SET status = 'superseded', finished_at = COALESCE(finished_at, ?), termination_reason = 'superseded', updated_at = ?
        WHERE job_id = ? AND status = 'running'
      `).run(ts, ts, active.job_id);
    }

    const latestGeneration = database.prepare(`
      SELECT MAX(job_generation) AS value FROM catalog_jobs
      WHERE active_coverage_key = ?
    `).get(coverageKey);
    const jobGeneration = Number(latestGeneration && latestGeneration.value ? latestGeneration.value : 0) + 1;
    const jobId = args.jobId ? String(args.jobId) : `catalog-job-${randomUUID()}`;
    const runId = args.runId ? String(args.runId) : `catalog-run-${randomUUID()}`;
    const operationId = args.operationId ? String(args.operationId) : `catalog-operation-${randomUUID()}`;
    const ownerEpoch = args.ownerEpoch ? String(args.ownerEpoch) : randomUUID();
    const profile = String(args.profile || "unknown");
    const queryKind = coverage.queryKind;

    database.prepare(`
      INSERT INTO catalog_jobs (
        job_id, active_coverage_key, operation_id, platform, tenant_id, shop_id, store_generation,
        profile, scope_json, read_requirement_json, reason, job_generation, owner_epoch,
        status, progress_json, created_at, updated_at, heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '{}', ?, ?, ?)
    `).run(
      jobId,
      coverageKey,
      operationId,
      identity.platform,
      identity.tenantId,
      identity.shopId,
      identity.storeGeneration,
      profile,
      encodeJson(coverage.normalizedScope),
      encodeJson(args.readRequirement || {}),
      String(args.reason || ""),
      jobGeneration,
      ownerEpoch,
      ts,
      ts,
      ts
    );

    if (active && forceRefresh) {
      database.prepare("UPDATE catalog_jobs SET superseded_by = ? WHERE job_id = ?").run(jobId, active.job_id);
    }

    database.prepare(`
      INSERT INTO catalog_runs (
        run_id, job_id, operation_id, platform, tenant_id, shop_id, store_generation,
        job_generation, owner_epoch, query_kind, profile, normalized_scope_json, coverage_key,
        status, started_at, business_date, required_fields_json, projection_contract_hash,
        adapter_version, catalog_contract_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      jobId,
      operationId,
      identity.platform,
      identity.tenantId,
      identity.shopId,
      identity.storeGeneration,
      jobGeneration,
      ownerEpoch,
      queryKind,
      profile,
      encodeJson(coverage.normalizedScope),
      coverageKey,
      ts,
      businessDate(),
      encodeJson(args.requiredFields || []),
      String(args.projectionContractHash || ""),
      String(args.adapterVersion || ""),
      coverage.catalogContractHash,
      ts,
      ts
    );

    const row = database.prepare("SELECT * FROM catalog_jobs WHERE job_id = ?").get(jobId);
    database.exec("COMMIT");
    return formatJob(row, { reused: false, runId });
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function formatJob(row, extra = {}) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    operationId: row.operation_id,
    activeCoverageKey: row.active_coverage_key,
    platform: row.platform,
    tenantId: row.tenant_id,
    shopId: row.shop_id,
    storeGeneration: row.store_generation,
    profile: row.profile,
    scope: decodeJson(row.scope_json, {}),
    readRequirement: decodeJson(row.read_requirement_json, {}),
    jobGeneration: row.job_generation,
    ownerEpoch: row.owner_epoch,
    status: row.status,
    progress: decodeJson(row.progress_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    heartbeatAt: row.heartbeat_at,
    ...extra
  };
}

function getCatalogJob(args = {}) {
  const database = ensureDb();
  const jobId = String(args.jobId || "").trim();
  if (!jobId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Missing jobId");
  const row = database.prepare("SELECT * FROM catalog_jobs WHERE job_id = ?").get(jobId);
  if (!row) return null;
  const run = getLatestRunForJob(jobId);
  return formatJob(row, { runId: run && run.run_id, runStatus: run && run.status });
}

function cancelCatalogJob(args = {}) {
  const database = ensureDb();
  const jobId = String(args.jobId || "").trim();
  if (!jobId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Missing jobId");
  const ts = nowIso();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database.prepare(`
      UPDATE catalog_jobs
      SET status = 'cancelled', updated_at = ?
      WHERE job_id = ? AND status IN ('queued', 'running')
    `).run(ts, jobId);
    database.prepare(`
      UPDATE catalog_runs
      SET status = 'cancelled', finished_at = COALESCE(finished_at, ?), termination_reason = 'cancelled', updated_at = ?
      WHERE job_id = ? AND status = 'running'
    `).run(ts, ts, jobId);
    database.exec("COMMIT");
    return { ok: true, changed: result.changes };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function heartbeatCatalogJob(args = {}) {
  const database = ensureDb();
  const jobId = String(args.jobId || "").trim();
  if (!jobId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Missing jobId");
  const ts = nowIso();
  const result = database.prepare(`
    UPDATE catalog_jobs
    SET status = CASE status WHEN 'queued' THEN 'running' ELSE status END,
      heartbeat_at = ?, updated_at = ?
    WHERE job_id = ?
      AND job_generation = ?
      AND owner_epoch = ?
      AND status IN ('queued', 'running')
  `).run(ts, ts, jobId, Number(args.jobGeneration), String(args.ownerEpoch || ""));
  if (!result.changes) throw createError("NATIVE_DATA_OWNER_LOST", "Catalog job owner fence rejected heartbeat");
  return { ok: true, heartbeatAt: ts };
}

function getJobAndRunForFence(args = {}) {
  const database = ensureDb();
  const jobId = String(args.jobId || "").trim();
  if (!jobId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Missing jobId");
  const jobGeneration = Number(args.jobGeneration);
  const ownerEpoch = String(args.ownerEpoch || "");
  if (!Number.isInteger(jobGeneration) || jobGeneration <= 0 || !ownerEpoch) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Missing jobGeneration or ownerEpoch");
  }
  const job = database.prepare(`
    SELECT * FROM catalog_jobs
    WHERE job_id = ? AND job_generation = ? AND owner_epoch = ?
  `).get(jobId, jobGeneration, ownerEpoch);
  if (!job) throw createError("NATIVE_DATA_OWNER_LOST", "Catalog job owner fence rejected request");
  if (!["queued", "running"].includes(job.status)) {
    throw createError("NATIVE_DATA_OWNER_LOST", "Catalog job is no longer active", { status: job.status });
  }
  const run = args.runId
    ? database.prepare("SELECT * FROM catalog_runs WHERE run_id = ? AND job_id = ?").get(String(args.runId), jobId)
    : database.prepare("SELECT * FROM catalog_runs WHERE job_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1").get(jobId);
  if (!run || run.status !== "running") {
    throw createError("NATIVE_DATA_OWNER_LOST", "Catalog run is no longer active", { runId: args.runId || null });
  }
  assertActiveStoreIdentity({
    platform: run.platform,
    tenantId: run.tenant_id,
    shopId: run.shop_id,
    storeGeneration: run.store_generation
  });
  return { job, run };
}

function normalizePageArgs(args = {}) {
  const products = Array.isArray(args.products) ? args.products : [];
  if (!products.length) throw createError("NATIVE_DATA_BAD_ARGUMENT", "reportPage requires products");
  if (products.length > MAX_CATALOG_BATCH_PRODUCTS) {
    throw createError("NATIVE_DATA_TOO_MANY_PRODUCTS", "Too many products in one page", {
      count: products.length,
      max: MAX_CATALOG_BATCH_PRODUCTS
    });
  }
  const pageNo = Math.max(1, Math.trunc(Number(args.pageNo || args.pageIndex || 1)));
  const segmentIndex = Math.max(0, Math.trunc(Number(args.segmentIndex || 0)));
  const commitToken = String(args.commitToken || "").trim();
  if (!commitToken) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Missing commitToken");
  return { products, pageNo, segmentIndex, commitToken };
}

function productKeyFor(run, productId) {
  return [run.platform, run.tenant_id, run.shop_id, run.store_generation, productId].join("::");
}

function extractFieldValues(product) {
  const fields = {
    title: product.title,
    imageUrl: product.imageUrl,
    categoryId: product.categoryId,
    categoryName: product.categoryName,
    categoryPath: product.categoryPath,
    brandId: product.brandId,
    brandName: product.brandName,
    articleNumber: product.articleNumber,
    lifecycleStatus: product.lifecycleStatus,
    platformStatusRaw: product.platformStatusRaw,
    checkStatusRaw: product.checkStatusRaw,
    priceMinMinor: product.priceMinMinor,
    priceMaxMinor: product.priceMaxMinor,
    currency: product.currency,
    stock: product.stock,
    totalSales: product.totalSales,
    createdAt: product.createdAt,
    auditTimeEpoch: product.auditTimeEpoch,
    listedAt: product.listedAt,
    offlineAt: product.offlineAt,
    platformUpdatedAt: product.platformUpdatedAt
  };
  const output = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function normalizeFieldState(product, fieldValues) {
  const provided = product && product.fieldState && typeof product.fieldState === "object" ? product.fieldState : {};
  const output = {};
  for (const fieldName of new Set([...Object.keys(fieldValues), ...Object.keys(provided)])) {
    const raw = provided[fieldName];
    const rawState = raw && typeof raw === "object" ? raw.state : raw;
    const state = ["present", "cleared", "missing", "invalid", "inferred"].includes(rawState)
      ? rawState
      : fieldValues[fieldName] === null
        ? "missing"
        : "present";
    output[fieldName] = raw && typeof raw === "object" ? { ...raw, state } : { state };
  }
  return output;
}

function normalizedProduct(run, product) {
  const productId = normalizeString(product.productId || product.id);
  if (!productId) throw createError("NATIVE_DATA_BAD_PRODUCT", "Product is missing productId");
  const productKey = normalizeString(product.productKey) || productKeyFor(run, productId);
  const fieldValues = extractFieldValues(product);
  const fieldState = normalizeFieldState(product, fieldValues);
  const facts = {
    schemaVersion: "product-catalog-product-version-v2",
    platform: run.platform,
    tenantId: run.tenant_id,
    shopId: run.shop_id,
    storeGeneration: run.store_generation,
    productId,
    productKey,
    ...fieldValues,
    fieldState
  };
  const contentHash = normalizeString(product.contentHash) || sha256(canonicalJson(facts));
  const versionId = `${productKey}::${contentHash}`;
  return { productId, productKey, fieldValues, fieldState, facts, contentHash, versionId };
}

function compareObservationRows(a, b) {
  if (!a && !b) return 0;
  if (a && !b) return 1;
  if (!a && b) return -1;
  const requestCompare = String(a.request_started_at || "").localeCompare(String(b.request_started_at || ""));
  if (requestCompare !== 0) return requestCompare;
  const observedCompare = String(a.observed_at || "").localeCompare(String(b.observed_at || ""));
  if (observedCompare !== 0) return observedCompare;
  return String(a.observation_id || "").localeCompare(String(b.observation_id || ""));
}

function maybeUpsertRunMember(runId, productKey, observationId, versionId) {
  const database = ensureDb();
  const current = database.prepare(`
    SELECT o.* FROM catalog_run_members m
    JOIN catalog_observations o ON o.observation_id = m.observation_id
    WHERE m.run_id = ? AND m.product_key = ?
  `).get(runId, productKey);
  const next = database.prepare("SELECT * FROM catalog_observations WHERE observation_id = ?").get(observationId);
  if (current && compareObservationRows(next, current) <= 0) return false;
  database.prepare(`
    INSERT INTO catalog_run_members (run_id, product_key, observation_id, version_id, winner_reason, created_at)
    VALUES (?, ?, ?, ?, 'request-started-at', ?)
    ON CONFLICT(run_id, product_key) DO UPDATE SET
      observation_id = excluded.observation_id,
      version_id = excluded.version_id,
      winner_reason = excluded.winner_reason
  `).run(runId, productKey, observationId, versionId, nowIso());
  return true;
}

function ensureLatestRow(run, product, observationId, versionId, ts) {
  const database = ensureDb();
  const current = database.prepare("SELECT * FROM catalog_latest WHERE product_key = ?").get(product.productKey);
  if (!current) {
    database.prepare(`
      INSERT INTO catalog_latest (
        product_key, platform, tenant_id, shop_id, store_generation, product_id,
        latest_observation_id, latest_observed_product_version_id, lifecycle_status,
        listed_at, merged_fields_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(
      product.productKey,
      run.platform,
      run.tenant_id,
      run.shop_id,
      run.store_generation,
      product.productId,
      observationId,
      versionId,
      normalizeString(product.fieldValues.lifecycleStatus),
      normalizeString(product.fieldValues.listedAt),
      ts
    );
    return {};
  }

  const currentObservation = database.prepare("SELECT * FROM catalog_observations WHERE observation_id = ?").get(current.latest_observation_id);
  const nextObservation = database.prepare("SELECT * FROM catalog_observations WHERE observation_id = ?").get(observationId);
  if (compareObservationRows(nextObservation, currentObservation) > 0) {
    database.prepare(`
      UPDATE catalog_latest
      SET latest_observation_id = ?, latest_observed_product_version_id = ?, lifecycle_status = ?, listed_at = ?, updated_at = ?
      WHERE product_key = ?
    `).run(
      observationId,
      versionId,
      normalizeString(product.fieldValues.lifecycleStatus),
      normalizeString(product.fieldValues.listedAt),
      ts,
      product.productKey
    );
  }
  return decodeJson(current.merged_fields_json, {});
}

function updateLatestFieldLineage(product, observationId, versionId, sourceProfile, observedAt) {
  const database = ensureDb();
  let mergedFields = decodeJson(database.prepare("SELECT merged_fields_json FROM catalog_latest WHERE product_key = ?").get(product.productKey).merged_fields_json, {});
  let changed = false;

  for (const [fieldName, stateInfo] of Object.entries(product.fieldState)) {
    const state = stateInfo && stateInfo.state;
    if (!["present", "cleared", "inferred"].includes(state)) continue;
    if (state !== "cleared" && product.fieldValues[fieldName] === undefined) continue;
    const current = database.prepare(`
      SELECT f.*, o.request_started_at, o.observed_at, o.observation_id
      FROM catalog_latest_fields f
      JOIN catalog_observations o ON o.observation_id = f.observation_id
      WHERE f.product_key = ? AND f.field_name = ?
    `).get(product.productKey, fieldName);
    const next = database.prepare("SELECT * FROM catalog_observations WHERE observation_id = ?").get(observationId);
    if (current && compareObservationRows(next, current) <= 0) continue;

    database.prepare(`
      INSERT INTO catalog_latest_fields (product_key, field_name, observation_id, version_id, field_state, observed_at, source_profile)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_key, field_name) DO UPDATE SET
        observation_id = excluded.observation_id,
        version_id = excluded.version_id,
        field_state = excluded.field_state,
        observed_at = excluded.observed_at,
        source_profile = excluded.source_profile
    `).run(product.productKey, fieldName, observationId, versionId, state, observedAt, sourceProfile);

    if (state === "cleared") delete mergedFields[fieldName];
    else mergedFields[fieldName] = product.fieldValues[fieldName];
    changed = true;
  }

  if (changed) {
    database.prepare("UPDATE catalog_latest SET merged_fields_json = ?, updated_at = ? WHERE product_key = ?")
      .run(encodeJson(mergedFields), nowIso(), product.productKey);
  }
}

function insertProductVersion(run, product, ts) {
  ensureDb().prepare(`
    INSERT INTO catalog_product_versions (
      version_id, product_key, platform, tenant_id, shop_id, store_generation, product_id,
      content_hash, title, image_url, category_id, category_name, lifecycle_status,
      platform_status_raw, check_status_raw, price_min_minor, price_max_minor, currency,
      stock, total_sales, created_at_platform, audit_time_epoch, listed_at, offline_at,
      platform_updated_at, facts_json, field_state_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_key, content_hash) DO NOTHING
  `).run(
    product.versionId,
    product.productKey,
    run.platform,
    run.tenant_id,
    run.shop_id,
    run.store_generation,
    product.productId,
    product.contentHash,
    normalizeString(product.fieldValues.title),
    normalizeString(product.fieldValues.imageUrl),
    normalizeString(product.fieldValues.categoryId),
    normalizeString(product.fieldValues.categoryName),
    normalizeString(product.fieldValues.lifecycleStatus),
    normalizeString(product.fieldValues.platformStatusRaw),
    normalizeString(product.fieldValues.checkStatusRaw),
    normalizeString(product.fieldValues.priceMinMinor),
    normalizeString(product.fieldValues.priceMaxMinor),
    normalizeString(product.fieldValues.currency),
    normalizeInteger(product.fieldValues.stock),
    normalizeInteger(product.fieldValues.totalSales),
    normalizeString(product.fieldValues.createdAt),
    normalizeInteger(product.fieldValues.auditTimeEpoch),
    normalizeString(product.fieldValues.listedAt),
    normalizeString(product.fieldValues.offlineAt),
    normalizeString(product.fieldValues.platformUpdatedAt),
    canonicalJson(product.facts),
    encodeJson(product.fieldState),
    ts
  );
}

function insertCatalogObservation(run, rawProduct, context = {}) {
  const ts = context.ts || nowIso();
  const sourceRequestKey = normalizeString(context.sourceRequestKey) || "catalog-observation";
  const segmentIndex = Math.max(0, Math.trunc(Number(context.segmentIndex || 0)));
  const pageNo = Math.max(1, Math.trunc(Number(context.pageNo || context.pageIndex || 1)));
  const requestStartedAt = normalizeString(context.requestStartedAt) || ts;
  const observedAt = normalizeString(context.observedAt) || ts;
  const product = normalizedProduct(run, rawProduct);
  const occurrenceIndex = Number.isInteger(context.occurrenceIndex)
    ? context.occurrenceIndex
    : Number.isInteger(rawProduct.occurrenceIndex)
      ? rawProduct.occurrenceIndex
      : 0;
  const observationId = normalizeString(rawProduct.observationId) || [
    run.run_id,
    sourceRequestKey,
    product.productId,
    occurrenceIndex,
    product.contentHash
  ].join("::");

  insertProductVersion(run, product, ts);
  ensureDb().prepare(`
    INSERT INTO catalog_observations (
      observation_id, run_id, product_key, version_id, platform, tenant_id, shop_id,
      store_generation, product_id, source_profile, source_request_key, segment_index,
      page_index, occurrence_index, request_started_at, observed_at, catalog_contract_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(observation_id) DO NOTHING
  `).run(
    observationId,
    run.run_id,
    product.productKey,
    product.versionId,
    run.platform,
    run.tenant_id,
    run.shop_id,
    run.store_generation,
    product.productId,
    run.profile,
    sourceRequestKey,
    segmentIndex,
    pageNo,
    occurrenceIndex,
    requestStartedAt,
    observedAt,
    run.catalog_contract_hash,
    ts
  );

  if (context.updateRunMember !== false) {
    maybeUpsertRunMember(run.run_id, product.productKey, observationId, product.versionId);
  }
  ensureLatestRow(run, product, observationId, product.versionId, ts);
  updateLatestFieldLineage(product, observationId, product.versionId, run.profile, observedAt);

  return {
    product,
    observationId,
    versionId: product.versionId,
    contentHash: product.contentHash
  };
}

function reportCatalogPage(args = {}) {
  const database = ensureDb();
  const { products, pageNo, segmentIndex, commitToken } = normalizePageArgs(args);
  const replay = database.prepare("SELECT * FROM catalog_pages WHERE commit_token = ?").get(commitToken);
  if (replay) {
    if (args.runId && replay.run_id !== String(args.runId)) {
      throw createError("NATIVE_DATA_COMMIT_TOKEN_CONFLICT", "commitToken belongs to a different run", {
        commitToken,
        existingRunId: replay.run_id,
        requestedRunId: String(args.runId)
      });
    }
    return {
      ok: true,
      firstCommit: false,
      committedCount: replay.committed_count,
      transactionId: replay.transaction_id,
      runId: replay.run_id,
      segmentIndex: replay.segment_index,
      pageNo: replay.page_no
    };
  }

  const { job, run } = getJobAndRunForFence(args);
  const ts = nowIso();
  const requestStartedAt = normalizeString(args.requestStartedAt) || ts;
  const observedAt = normalizeString(args.observedAt) || ts;
  const sourceRequestKey = normalizeString(args.sourceRequestKey) || `${segmentIndex}:${pageNo}:${commitToken}`;
  const transactionId = `catalog-page-${randomUUID()}`;
  const occurrenceByProduct = new Map();
  let committedCount = 0;

  database.exec("BEGIN IMMEDIATE");
  try {
    const conflict = database.prepare("SELECT * FROM catalog_pages WHERE commit_token = ?").get(commitToken);
    if (conflict) {
      if (args.runId && conflict.run_id !== String(args.runId)) {
        throw createError("NATIVE_DATA_COMMIT_TOKEN_CONFLICT", "commitToken belongs to a different run", {
          commitToken,
          existingRunId: conflict.run_id,
          requestedRunId: String(args.runId)
        });
      }
      database.exec("COMMIT");
      return {
        ok: true,
        firstCommit: false,
        committedCount: conflict.committed_count,
        transactionId: conflict.transaction_id,
        runId: conflict.run_id,
        segmentIndex: conflict.segment_index,
        pageNo: conflict.page_no
      };
    }

    database.prepare("UPDATE catalog_jobs SET status = 'running', heartbeat_at = ?, updated_at = ? WHERE job_id = ?")
      .run(ts, ts, job.job_id);

    for (const rawProduct of products) {
      const productId = normalizeString(rawProduct.productId || rawProduct.id);
      if (!productId) throw createError("NATIVE_DATA_BAD_PRODUCT", "Product is missing productId");
      const occurrenceIndex = Number.isInteger(rawProduct.occurrenceIndex)
        ? rawProduct.occurrenceIndex
        : occurrenceByProduct.get(productId) || 0;
      occurrenceByProduct.set(productId, occurrenceIndex + 1);
      insertCatalogObservation(run, rawProduct, {
        ts,
        sourceRequestKey,
        segmentIndex,
        pageNo,
        requestStartedAt,
        observedAt,
        occurrenceIndex
      });
      committedCount += 1;
    }

    const pageDuplicateCount = Math.max(0, products.length - new Set(products.map((item) => String(item.productId || item.id || "").trim()).filter(Boolean)).size);
    const invalidRowCount = Math.max(0, Math.trunc(Number(args.invalidRowCount || 0)));
    database.prepare(`
      INSERT INTO catalog_pages (
        run_id, segment_index, page_no, commit_token, transaction_id, source_request_key,
        request_fingerprint, cursor, min_sort_anchor, max_sort_anchor, remote_total,
        row_count, duplicate_count, invalid_row_count, elapsed_ms, status, result_json,
        committed_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.run_id,
      segmentIndex,
      pageNo,
      commitToken,
      transactionId,
      sourceRequestKey,
      String(args.requestFingerprint || ""),
      normalizeString(args.cursor),
      normalizeString(args.minSortAnchor),
      normalizeString(args.maxSortAnchor),
      normalizeInteger(args.remoteTotal),
      products.length,
      pageDuplicateCount,
      invalidRowCount,
      Math.max(0, Math.trunc(Number(args.elapsedMs || 0))),
      String(args.status || "committed"),
      encodeJson(args.result || {}),
      committedCount,
      ts
    );

    const uniqueCount = database.prepare("SELECT COUNT(*) AS count FROM catalog_run_members WHERE run_id = ?").get(run.run_id).count;
    const current = database.prepare("SELECT first_remote_total FROM catalog_runs WHERE run_id = ?").get(run.run_id);
    const firstTotal = current && current.first_remote_total !== null && current.first_remote_total !== undefined
      ? current.first_remote_total
      : normalizeInteger(args.remoteTotal);
    const lastTotal = normalizeInteger(args.remoteTotal);
    const drift = firstTotal !== null && lastTotal !== null ? lastTotal - firstTotal : null;
    const nextSegmentCount = segmentIndex + 1;

    database.prepare(`
      UPDATE catalog_runs
      SET first_remote_total = COALESCE(first_remote_total, ?),
        last_remote_total = COALESCE(?, last_remote_total),
        fetched_row_count = fetched_row_count + ?,
        unique_product_count = ?,
        duplicate_count = duplicate_count + ?,
        invalid_row_count = invalid_row_count + ?,
        page_count = page_count + 1,
        segment_count = CASE WHEN segment_count < ? THEN ? ELSE segment_count END,
        remote_total_drift = ?,
        min_sort_anchor = COALESCE(min_sort_anchor, ?),
        max_sort_anchor = COALESCE(?, max_sort_anchor),
        updated_at = ?
      WHERE run_id = ?
    `).run(
      firstTotal,
      lastTotal,
      products.length,
      uniqueCount,
      pageDuplicateCount,
      invalidRowCount,
      nextSegmentCount,
      nextSegmentCount,
      drift,
      normalizeString(args.minSortAnchor),
      normalizeString(args.maxSortAnchor),
      ts,
      run.run_id
    );

    database.exec("COMMIT");
    return { ok: true, firstCommit: true, committedCount, transactionId, runId: run.run_id, segmentIndex, pageNo };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function finishCatalogJob(args = {}) {
  const database = ensureDb();
  const { job, run } = getJobAndRunForFence(args);
  const ts = nowIso();
  const runStatus = String(args.status || args.coverageStatus || "exhausted");
  if (!["exhausted", "partial", "failed", "cancelled", "abandoned", "superseded"].includes(runStatus)) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Invalid finish status", { status: runStatus });
  }
  const jobStatus = runStatus === "exhausted" || runStatus === "partial" ? "finished" : runStatus;
  const terminationReason = String(args.terminationReason || (runStatus === "exhausted" ? "has-more-false" : runStatus));

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      UPDATE catalog_runs
      SET status = ?, finished_at = ?, termination_reason = ?, updated_at = ?
      WHERE run_id = ? AND status = 'running'
    `).run(runStatus, ts, terminationReason, ts, run.run_id);

    database.prepare(`
      UPDATE catalog_jobs
      SET status = ?, updated_at = ?, heartbeat_at = ?
      WHERE job_id = ? AND job_generation = ? AND owner_epoch = ? AND status IN ('queued', 'running')
    `).run(jobStatus, ts, ts, job.job_id, job.job_generation, job.owner_epoch);

    let headChanged = 0;
    if (runStatus === "exhausted" || runStatus === "partial") {
      const exhaustedRunId = runStatus === "exhausted" ? run.run_id : null;
      const partialRunId = runStatus === "partial" ? run.run_id : null;
      const existing = database.prepare("SELECT * FROM catalog_heads WHERE coverage_key = ?").get(run.coverage_key);
      if (!existing) {
        database.prepare(`
          INSERT INTO catalog_heads (
            coverage_key, job_generation, exhausted_run_id, latest_partial_run_id,
            validity, updated_at
          ) VALUES (?, ?, ?, ?, 'valid', ?)
        `).run(run.coverage_key, job.job_generation, exhaustedRunId, partialRunId, ts);
        headChanged = 1;
      } else if (Number(existing.job_generation) <= Number(job.job_generation)) {
        database.prepare(`
          UPDATE catalog_heads
          SET job_generation = ?,
            exhausted_run_id = COALESCE(?, exhausted_run_id),
            latest_partial_run_id = COALESCE(?, latest_partial_run_id),
            validity = 'valid',
            invalidated_at = NULL,
            invalidation_reason = NULL,
            updated_at = ?
          WHERE coverage_key = ? AND job_generation <= ?
        `).run(job.job_generation, exhaustedRunId, partialRunId, ts, run.coverage_key, job.job_generation);
        headChanged = database.prepare("SELECT changes() AS changes").get().changes;
      }
    }

    database.exec("COMMIT");
    return {
      ok: true,
      jobId: job.job_id,
      runId: run.run_id,
      status: runStatus,
      jobStatus,
      headChanged,
      finishedAt: ts
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function createCatalogRun(database, identity, args = {}) {
  const ts = args.ts || nowIso();
  const products = Array.isArray(args.products) ? args.products : [];
  const productIds = products.map((item) => normalizeString(item.productId || item.id)).filter(Boolean);
  const queryKind = args.queryKind || (productIds.length ? "targeted" : "range");
  const scope = args.scope || (productIds.length ? { productIds } : {});
  const coverage = buildCoverageDescriptor({ ...args, ...identity, queryKind, scope });
  const runId = normalizeString(args.runId) || `catalog-live-run-${randomUUID()}`;
  const operationId = normalizeString(args.operationId) || `catalog-live-operation-${randomUUID()}`;
  const profile = normalizeString(args.profile) || "live-lookup";
  const status = args.status || "exhausted";
  const fetchedRowCount = Math.max(0, Math.trunc(Number(args.fetchedRowCount ?? products.length)));
  const uniqueProductCount = Math.max(0, new Set(productIds).size);

  database.prepare(`
    INSERT INTO catalog_runs (
      run_id, job_id, operation_id, platform, tenant_id, shop_id, store_generation,
      job_generation, owner_epoch, query_kind, profile, normalized_scope_json, coverage_key,
      status, started_at, finished_at, business_date, fetched_row_count, unique_product_count,
      page_count, segment_count, termination_reason, required_fields_json, projection_contract_hash,
      missing_field_counts_json, adapter_version, catalog_contract_hash, created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
  `).run(
    runId,
    operationId,
    identity.platform,
    identity.tenantId,
    identity.shopId,
    identity.storeGeneration,
    Math.max(1, Math.trunc(Number(args.jobGeneration || 1))),
    normalizeString(args.ownerEpoch) || "native-data-service",
    coverage.queryKind,
    profile,
    encodeJson(coverage.normalizedScope),
    normalizeString(args.coverageKey) || coverage.coverageKey,
    status,
    normalizeString(args.startedAt) || ts,
    normalizeString(args.finishedAt) || ts,
    businessDate(new Date(normalizeString(args.finishedAt) || ts)),
    fetchedRowCount,
    uniqueProductCount,
    products.length ? 1 : 0,
    products.length ? 1 : 0,
    String(args.terminationReason || "has-more-false"),
    encodeJson(args.requiredFields || []),
    String(args.projectionContractHash || ""),
    String(args.adapterVersion || ""),
    coverage.catalogContractHash,
    ts,
    ts
  );

  return database.prepare("SELECT * FROM catalog_runs WHERE run_id = ?").get(runId);
}

function normalizeLiveObservationArgs(args = {}) {
  const identity = normalizeIdentity(args);
  const products = Array.isArray(args.products) ? args.products : Array.isArray(args.observations) ? args.observations : [];
  if (!products.length) throw createError("NATIVE_DATA_BAD_ARGUMENT", "recordLiveObservations requires products");
  if (products.length > MAX_CATALOG_BATCH_PRODUCTS) {
    throw createError("NATIVE_DATA_TOO_MANY_PRODUCTS", "Too many live observations", {
      count: products.length,
      max: MAX_CATALOG_BATCH_PRODUCTS
    });
  }
  return { identity, products };
}

function recordLiveObservations(args = {}) {
  const database = ensureDb();
  const { identity, products } = normalizeLiveObservationArgs(args);
  const ts = nowIso();
  const sourceRequestKey = normalizeString(args.sourceRequestKey) || `live:${args.purpose || "lookup"}:${randomUUID()}`;
  const requestStartedAt = normalizeString(args.requestStartedAt) || ts;
  const observedAt = normalizeString(args.observedAt) || ts;
  const occurrenceByProduct = new Map();
  const observations = [];

  database.exec("BEGIN IMMEDIATE");
  try {
    if (args.ensureStoreIdentity === true) upsertStoreIdentity({ ...args, ...identity });
    assertActiveStoreIdentity(identity);
    const run = createCatalogRun(database, identity, {
      ...args,
      products,
      ts,
      queryKind: "targeted",
      scope: args.scope || { productIds: products.map((item) => normalizeString(item.productId || item.id)).filter(Boolean) },
      profile: args.profile || "live-lookup",
      status: "exhausted",
      terminationReason: "has-more-false"
    });

    for (const rawProduct of products) {
      const productId = normalizeString(rawProduct.productId || rawProduct.id);
      const occurrenceIndex = Number.isInteger(rawProduct.occurrenceIndex)
        ? rawProduct.occurrenceIndex
        : occurrenceByProduct.get(productId) || 0;
      occurrenceByProduct.set(productId, occurrenceIndex + 1);
      const inserted = insertCatalogObservation(run, rawProduct, {
        ts,
        sourceRequestKey,
        requestStartedAt,
        observedAt,
        occurrenceIndex,
        updateRunMember: true
      });
      observations.push({
        productId: inserted.product.productId,
        productKey: inserted.product.productKey,
        observationId: inserted.observationId,
        versionId: inserted.versionId,
        contentHash: inserted.contentHash
      });
    }

    const invalidated = invalidateCoverageKeys(database, args.invalidateCoverageKeys, "live-observation", ts);
    database.exec("COMMIT");
    return { ok: true, runId: run.run_id, committedCount: observations.length, observations, invalidated };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const MUTATION_STATUSES = new Set([
  "prepared",
  "sending",
  "acknowledged",
  "unknown",
  "confirmed",
  "confirm-timeout",
  "conflict",
  "failed",
  "cancelled",
  "skipped"
]);

function normalizeMutationItems(args = {}) {
  const identity = normalizeIdentity(args);
  const items = Array.isArray(args.mutations) ? args.mutations : Array.isArray(args.items) ? args.items : [];
  if (!items.length) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Mutation request requires mutations");
  if (items.length > MAX_CATALOG_BATCH_PRODUCTS) {
    throw createError("NATIVE_DATA_TOO_MANY_PRODUCTS", "Too many mutations", {
      count: items.length,
      max: MAX_CATALOG_BATCH_PRODUCTS
    });
  }
  return { identity, items };
}

function normalizeMutationStatus(value, fallback = "prepared") {
  const status = normalizeString(value) || fallback;
  if (!MUTATION_STATUSES.has(status)) {
    throw createError("NATIVE_DATA_BAD_ARGUMENT", "Invalid mutation status", { status });
  }
  return status;
}

function mutationTimestampColumn(status) {
  if (status === "sending") return "sent_at";
  if (status === "acknowledged" || status === "unknown") return "acknowledged_at";
  if (status === "confirmed") return "confirmed_at";
  return null;
}

function recordMutationResults(args = {}) {
  const database = ensureDb();
  const { identity, items } = normalizeMutationItems(args);
  const ts = nowIso();
  let changed = 0;
  const mutations = [];

  database.exec("BEGIN IMMEDIATE");
  try {
    if (args.ensureStoreIdentity === true) upsertStoreIdentity({ ...args, ...identity });
    assertActiveStoreIdentity(identity);
    for (const item of items) {
      const productId = normalizeString(item.productId || item.id);
      const action = normalizeString(item.action);
      const mutationKey = normalizeString(item.mutationKey);
      if (!productId || !action || !mutationKey) {
        throw createError("NATIVE_DATA_BAD_ARGUMENT", "Mutation requires mutationKey, productId and action");
      }
      const status = normalizeMutationStatus(item.status, "prepared");
      const mutationId = normalizeString(item.mutationId) || `catalog-mutation-${randomUUID()}`;
      const productKey = normalizeString(item.productKey) || productKeyFor({
        platform: identity.platform,
        tenant_id: identity.tenantId,
        shop_id: identity.shopId,
        store_generation: identity.storeGeneration
      }, productId);
      const current = database.prepare("SELECT * FROM catalog_mutations WHERE mutation_key = ?").get(mutationKey);
      if (current && current.status === "confirmed" && status !== "confirmed") {
        throw createError("NATIVE_DATA_MUTATION_FINAL", "Confirmed mutation cannot be downgraded", { mutationKey });
      }

      database.prepare(`
        INSERT INTO catalog_mutations (
          mutation_id, mutation_key, platform, tenant_id, shop_id, store_generation,
          product_id, product_key, action, status, request_hash, idempotency_key,
          lookup_observation_id, result_json, created_at, updated_at, sent_at,
          acknowledged_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mutation_key) DO UPDATE SET
          status = excluded.status,
          request_hash = COALESCE(NULLIF(excluded.request_hash, ''), catalog_mutations.request_hash),
          idempotency_key = COALESCE(NULLIF(excluded.idempotency_key, ''), catalog_mutations.idempotency_key),
          lookup_observation_id = COALESCE(excluded.lookup_observation_id, catalog_mutations.lookup_observation_id),
          result_json = excluded.result_json,
          updated_at = excluded.updated_at,
          sent_at = COALESCE(excluded.sent_at, catalog_mutations.sent_at),
          acknowledged_at = COALESCE(excluded.acknowledged_at, catalog_mutations.acknowledged_at),
          confirmed_at = COALESCE(excluded.confirmed_at, catalog_mutations.confirmed_at)
      `).run(
        mutationId,
        mutationKey,
        identity.platform,
        identity.tenantId,
        identity.shopId,
        identity.storeGeneration,
        productId,
        productKey,
        action,
        status,
        String(item.requestHash || ""),
        String(item.idempotencyKey || ""),
        normalizeString(item.lookupObservationId),
        encodeJson(item.result || item.responseSummary || {}),
        ts,
        ts,
        status === "sending" ? (normalizeString(item.sentAt) || ts) : null,
        (status === "acknowledged" || status === "unknown") ? (normalizeString(item.acknowledgedAt) || ts) : null,
        status === "confirmed" ? (normalizeString(item.confirmedAt) || ts) : null
      );
      changed += 1;
      mutations.push({ mutationKey, mutationId: current ? current.mutation_id : mutationId, productId, status });
    }
    database.exec("COMMIT");
    return { ok: true, changed, mutations };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function summarizeOpportunityRunMutations(args = {}) {
  const database = ensureDb();
  const runId = normalizeString(args.runId || args.operationId);
  if (!runId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Opportunity mutation summary requires runId");
  const prefix = `catalog-mutation:opportunity-submit:${runId}:`;
  const rows = database.prepare(`
    SELECT shop_id, status, result_json
    FROM catalog_mutations
    WHERE substr(mutation_key, 1, length(?)) = ?
  `).all(prefix, prefix);
  const empty = () => ({ acknowledged: 0, failed: 0, pending: 0, skipped: 0, safetySkipped: 0, unknown: 0, confirmed: 0, total: 0 });
  const totals = empty();
  const byShop = {};
  for (const row of rows) {
    const shopId = normalizeString(row.shop_id);
    const summary = byShop[shopId] || (byShop[shopId] = empty());
    const status = normalizeMutationStatus(row.status, "unknown");
    const result = decodeJson(row.result_json, {});
    const diagnostic = result && typeof result.diagnostic === "object" ? result.diagnostic : {};
    const safetySkipped = status === "skipped" && (
      diagnostic.safetySkipped === true ||
      normalizeString(result.message).toLowerCase().includes("live lookup did not find product")
    );
    for (const target of [totals, summary]) {
      target.total += 1;
      if (status === "prepared" || status === "sending") target.pending += 1;
      else if (status === "acknowledged" || status === "confirmed" || status === "failed" || status === "skipped") target[status] += 1;
      else target.unknown += 1;
      if (safetySkipped) target.safetySkipped += 1;
    }
  }
  return { ok: true, runId, ...totals, byShop };
}

function invalidateCoverageKeys(database, coverageKeys, reason, ts = nowIso()) {
  const keys = Array.isArray(coverageKeys) ? [...new Set(coverageKeys.map((key) => normalizeString(key)).filter(Boolean))] : [];
  let changed = 0;
  for (const coverageKey of keys) {
    changed += database.prepare(`
      UPDATE catalog_heads
      SET validity = 'stale', invalidated_at = ?, invalidation_reason = ?, updated_at = ?
      WHERE coverage_key = ? AND validity = 'valid'
    `).run(ts, String(reason || "manual"), ts, coverageKey).changes;
  }
  return changed;
}

function confirmMutations(args = {}) {
  const database = ensureDb();
  const { identity, items } = normalizeMutationItems({ ...args, mutations: args.confirmations || args.mutations || args.items });
  const ts = nowIso();
  let changed = 0;
  const confirmations = [];

  database.exec("BEGIN IMMEDIATE");
  try {
    assertActiveStoreIdentity(identity);
    for (const item of items) {
      const mutationKey = normalizeString(item.mutationKey);
      const mutationId = normalizeString(item.mutationId);
      if (!mutationKey && !mutationId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Confirmation requires mutationKey or mutationId");
      const mutation = mutationKey
        ? database.prepare("SELECT * FROM catalog_mutations WHERE mutation_key = ?").get(mutationKey)
        : database.prepare("SELECT * FROM catalog_mutations WHERE mutation_id = ?").get(mutationId);
      if (!mutation) throw createError("NATIVE_DATA_NOT_FOUND", "Mutation not found", { mutationKey, mutationId });
      if (mutation.tenant_id !== identity.tenantId || mutation.shop_id !== identity.shopId || Number(mutation.store_generation) !== identity.storeGeneration) {
        throw createError("NATIVE_DATA_BAD_ARGUMENT", "Mutation identity mismatch", { mutationKey: mutation.mutation_key });
      }

      const status = normalizeMutationStatus(item.status, item.confirmed === false ? "conflict" : "confirmed");
      const timestampColumn = mutationTimestampColumn(status);
      let confirmObservationId = normalizeString(item.confirmObservationId);
      if (item.observation || item.product) {
        const run = createCatalogRun(database, identity, {
          ...args,
          products: [item.observation || item.product],
          ts,
          queryKind: "targeted",
          scope: { productIds: [mutation.product_id] },
          profile: item.profile || args.profile || "mutation-confirm",
          operationId: item.operationId || args.operationId,
          catalogContractHash: item.catalogContractHash || args.catalogContractHash,
          status: "exhausted",
          terminationReason: "has-more-false"
        });
        const inserted = insertCatalogObservation(run, item.observation || item.product, {
          ts,
          sourceRequestKey: normalizeString(item.sourceRequestKey) || `mutation-confirm:${mutation.mutation_key}`,
          requestStartedAt: normalizeString(item.requestStartedAt) || ts,
          observedAt: normalizeString(item.observedAt) || ts,
          updateRunMember: true
        });
        confirmObservationId = inserted.observationId;
      }
      if (status === "confirmed" && !confirmObservationId) {
        throw createError("NATIVE_DATA_BAD_ARGUMENT", "Confirmed mutation requires confirm observation");
      }

      const result = database.prepare(`
        UPDATE catalog_mutations
        SET status = ?,
          confirm_observation_id = COALESCE(?, confirm_observation_id),
          result_json = ?,
          updated_at = ?,
          confirmed_at = CASE WHEN ? = 'confirmed_at' THEN ? ELSE confirmed_at END,
          acknowledged_at = CASE WHEN ? = 'acknowledged_at' THEN ? ELSE acknowledged_at END,
          sent_at = CASE WHEN ? = 'sent_at' THEN ? ELSE sent_at END
        WHERE mutation_id = ?
      `).run(
        status,
        confirmObservationId,
        encodeJson(item.result || item.responseSummary || {}),
        ts,
        timestampColumn,
        normalizeString(item.confirmedAt) || ts,
        timestampColumn,
        normalizeString(item.acknowledgedAt) || ts,
        timestampColumn,
        normalizeString(item.sentAt) || ts,
        mutation.mutation_id
      );
      changed += result.changes;
      confirmations.push({ mutationKey: mutation.mutation_key, mutationId: mutation.mutation_id, status, confirmObservationId });
    }
    const invalidated = invalidateCoverageKeys(database, args.invalidateCoverageKeys, "mutation-confirmed", ts);
    database.exec("COMMIT");
    return { ok: true, changed, confirmations, invalidated };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function queryHeadMembersPage(args = {}) {
  const database = ensureDb();
  const coverageKey = String(args.coverageKey || "").trim();
  if (!coverageKey) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Missing coverageKey");
  const limit = validatePageSize(args.limit);
  const cursor = String(args.cursor || "").trim();
  const head = database.prepare("SELECT * FROM catalog_heads WHERE coverage_key = ? AND validity = 'valid'").get(coverageKey);
  const runId = head && (args.allowPartial ? (head.exhausted_run_id || head.latest_partial_run_id) : head.exhausted_run_id);
  if (!runId) return { items: [], nextCursor: null, hasMore: false, head: head || null };
  const run = database.prepare("SELECT platform, tenant_id, shop_id, store_generation FROM catalog_runs WHERE run_id = ?").get(runId);
  const identity = run && getStoreIdentity({
    platform: run.platform,
    tenantId: run.tenant_id,
    shopId: run.shop_id,
    storeGeneration: run.store_generation
  });
  if (!identity || identity.lifecycle !== "active") {
    return { items: [], nextCursor: null, hasMore: false, head, storeLifecycle: identity ? identity.lifecycle : "missing" };
  }

  const rows = database.prepare(`
    SELECT m.run_id, m.product_key, m.observation_id, m.version_id, m.winner_reason,
      v.product_id, v.lifecycle_status, v.listed_at, v.facts_json
    FROM catalog_run_members m
    JOIN catalog_product_versions v ON v.version_id = m.version_id
    WHERE m.run_id = ? AND (? = '' OR m.product_key > ?)
    ORDER BY m.product_key
    LIMIT ?
  `).all(runId, cursor, cursor, limit + 1);
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => ({
    runId: row.run_id,
    productKey: row.product_key,
    observationId: row.observation_id,
    productVersionId: row.version_id,
    winnerReason: row.winner_reason,
    productId: row.product_id,
    lifecycleStatus: row.lifecycle_status,
    listedAt: row.listed_at,
    mergedFields: extractFieldValues(decodeJson(row.facts_json, {}))
  }));
  return {
    items,
    nextCursor: rows.length > limit ? pageRows[pageRows.length - 1].productKey : null,
    hasMore: rows.length > limit,
    head
  };
}

function queryLastObservedPage(args = {}) {
  const identity = normalizeIdentity(args);
  const storeIdentity = getStoreIdentity(identity);
  if (!storeIdentity || storeIdentity.lifecycle !== "active") {
    return { items: [], nextCursor: null, hasMore: false, storeLifecycle: storeIdentity ? storeIdentity.lifecycle : "missing" };
  }
  const database = ensureDb();
  const limit = validatePageSize(args.limit);
  const cursor = String(args.cursor || "").trim();
  const rows = database.prepare(`
    SELECT * FROM catalog_latest
    WHERE tenant_id = ? AND shop_id = ? AND store_generation = ?
      AND (? = '' OR product_key > ?)
    ORDER BY product_key
    LIMIT ?
  `).all(identity.tenantId, identity.shopId, identity.storeGeneration, cursor, cursor, limit + 1);
  const pageRows = rows.slice(0, limit);
  return {
    items: pageRows.map(formatLatest),
    nextCursor: rows.length > limit ? pageRows[pageRows.length - 1].productKey : null,
    hasMore: rows.length > limit
  };
}

function formatLatest(row) {
  return {
    productKey: row.product_key,
    platform: row.platform,
    tenantId: row.tenant_id,
    shopId: row.shop_id,
    storeGeneration: row.store_generation,
    productId: row.product_id,
    latestObservationId: row.latest_observation_id,
    latestObservedProductVersionId: row.latest_observed_product_version_id,
    lifecycleStatus: row.lifecycle_status,
    listedAt: row.listed_at,
    mergedFields: decodeJson(row.merged_fields_json, {}),
    updatedAt: row.updated_at
  };
}

function getProductsByIds(args = {}) {
  const identity = normalizeIdentity(args);
  const storeIdentity = getStoreIdentity(identity);
  if (!storeIdentity || storeIdentity.lifecycle !== "active") return [];
  const ids = Array.isArray(args.productIds) ? args.productIds.map((id) => String(id).trim()).filter(Boolean) : [];
  if (!ids.length) return [];
  if (ids.length > MAX_CATALOG_BATCH_PRODUCTS) {
    throw createError("NATIVE_DATA_TOO_MANY_PRODUCTS", "Too many productIds", { count: ids.length, max: MAX_CATALOG_BATCH_PRODUCTS });
  }
  const placeholders = ids.map(() => "?").join(", ");
  const rows = ensureDb().prepare(`
    SELECT * FROM catalog_latest
    WHERE tenant_id = ? AND shop_id = ? AND store_generation = ?
      AND product_id IN (${placeholders})
    ORDER BY product_id
  `).all(identity.tenantId, identity.shopId, identity.storeGeneration, ...ids);
  return rows.map(formatLatest);
}

function invalidateCoverage(args = {}) {
  const coverageKey = String(args.coverageKey || "").trim();
  if (!coverageKey) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Missing coverageKey");
  const ts = nowIso();
  const result = ensureDb().prepare(`
    UPDATE catalog_heads
    SET validity = 'stale', invalidated_at = ?, invalidation_reason = ?, updated_at = ?
    WHERE coverage_key = ? AND validity = 'valid'
  `).run(ts, String(args.reason || "manual"), ts, coverageKey);
  return { ok: true, changed: result.changes, invalidatedAt: ts };
}

function handle(method, args = {}) {
  switch (method) {
    case "initialize": return initializeDatabase(args);
    case "maintenance.getHealth": return getHealth();
    case "maintenance.quickCheck": return quickCheck();
    case "maintenance.listTables": return listTables();
    case "maintenance.createBackup": return createBackup(ensureDb(), args);
    case "maintenance.recoverOpenJobs": return abandonOpenJobs(ensureDb(), args.reason || "manual-recovery");
    case "maintenance.close": return closeDatabase();
    case "stores.upsertIdentity": return upsertStoreIdentity(args);
    case "stores.assertActiveIdentity": {
      const identity = normalizeIdentity(args);
      const row = assertActiveStoreIdentity(identity);
      return { ok: true, ...identity, updatedAt: row.updated_at };
    }
    case "stores.tombstoneIdentity": return tombstoneStoreIdentity(args);
    case "records.put": return putNativeRecord(args);
    case "records.putMany": return putManyNativeRecords(args);
    case "records.acquireOperation": return acquireNativeOperation(args);
    case "records.claimOpportunitySubmitTask": return claimOpportunitySubmitTask(args);
    case "opportunitySubmit.claimSchedulerLease": return claimOpportunitySubmitSchedulerLease(args);
    case "opportunitySubmit.releaseSchedulerLease": return releaseOpportunitySubmitSchedulerLease(args);
    case "opportunitySubmit.admit": return admitOpportunitySubmitAttempt(args);
    case "opportunitySubmit.consumeHttpGrant": return consumeOpportunitySubmitHttpGrant(args);
    case "opportunitySubmit.resolve": return resolveOpportunitySubmitAttempt(args);
    case "opportunitySubmit.releaseReservation": return releaseOpportunitySubmitReservation(args);
    case "opportunitySubmit.deferTask": return deferOpportunitySubmitTask(args);
    case "opportunitySubmit.nudgeDeferredTasks": return nudgeDeferredOpportunitySubmitTasks(args);
    case "opportunitySubmit.getQuotaUsage": return getOpportunitySubmitQuotaUsage(args);
    case "opportunitySubmit.summarizeRun": return summarizeOpportunitySubmitRun(args);
    case "records.putLarge.start": return startLargeNativeRecordPut(args);
    case "records.putLarge.chunk": return putLargeNativeRecordChunk(args);
    case "records.putLarge.commit": return commitLargeNativeRecordPut(args);
    case "records.putLarge.abort": return abortLargeNativeRecordPut(args);
    case "records.get": return getNativeRecord(args);
    case "records.getMany": return getManyNativeRecords(args);
    case "records.list": return listNativeRecords(args);
    case "records.queryByPrefix": return queryNativeRecordsByPrefix(args);
    case "records.latest": return latestNativeRecord(normalizeRecordStoreName(args.storeName || args.store));
    case "records.queryOperations": return queryNativeOperations(args);
    case "records.cleanupOperations": return cleanupNativeOperations(args);
    case "records.delete": return deleteNativeRecord(args);
    case "records.deleteMany": return deleteManyNativeRecords(args);
    case "opportunityAttempts.putMany": return putOpportunitySubmitAttempts(args);
    case "opportunityAttempts.count": return countOpportunitySubmitAttempts(args);
    case "opportunityAttempts.listDedupeKeys": return listOpportunitySubmitDedupeKeys(args);
    case "opportunityAttempts.findDedupeKeys": return findOpportunitySubmitDedupeKeys(args);
    case "opportunityAttempts.cleanup": return cleanupOpportunitySubmitAttempts(args);
    case "catalogJobs.acquire": return acquireCatalogJob(args);
    case "catalogJobs.get": return getCatalogJob(args);
    case "catalogJobs.cancel": return cancelCatalogJob(args);
    case "catalogJobs.heartbeat": return heartbeatCatalogJob(args);
    case "catalogJobs.reportPage": return reportCatalogPage(args);
    case "catalogJobs.finish": return finishCatalogJob(args);
    case "catalog.queryHeadMembersPage": return queryHeadMembersPage(args);
    case "catalog.queryLastObservedPage": return queryLastObservedPage(args);
    case "catalog.getProductsByIds": return getProductsByIds(args);
    case "catalog.recordLiveObservations": return recordLiveObservations(args);
    case "catalog.recordMutationResults": return recordMutationResults(args);
    case "catalog.summarizeOpportunityRunMutations": return summarizeOpportunityRunMutations(args);
    case "catalog.confirmMutations": return confirmMutations(args);
    case "catalog.invalidateCoverage": return invalidateCoverage(args);
    case "features.saveStaleRun": return saveFeatureRun(args, args.mode === "execute" ? "stale_execute_runs" : "stale_scan_runs");
    case "features.loadStaleCandidates": return loadFeatureCandidates(args, "stale_candidates");
    case "features.saveBulkRun": return saveFeatureRun(args, args.mode === "execute" ? "bulk_delete_execute_runs_v1" : "bulk_delete_scan_runs_v1");
    case "features.loadBulkCandidates": return loadFeatureCandidates(args, "bulk_delete_candidates_v1");
    case "features.saveOpportunityRun": return saveFeatureRun(args, args.storeName || "opportunity_execute_runs_v1");
    case "features.loadOpportunityCandidates": return loadFeatureCandidates(args, args.storeName || "opportunity_prematch_candidates_v1");
    default:
      throw createError("NATIVE_DATA_UNKNOWN_METHOD", `Unknown native data method: ${method}`);
  }
}

parentPort.on("message", async (message) => {
  if (!message || message.type !== "request") return;
  const { id, method, args } = message;
  try {
    const result = handle(method, args || {});
    parentPort.postMessage({ type: "response", id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ type: "response", id, ok: false, error: serializeError(error) });
  }
});

process.on("uncaughtException", (error) => {
  parentPort.postMessage({ type: "worker-error", error: serializeError(error) });
});

process.on("unhandledRejection", (error) => {
  parentPort.postMessage({ type: "worker-error", error: serializeError(error) });
});
