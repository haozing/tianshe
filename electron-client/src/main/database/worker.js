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

function applyForwardCompatibleFixups(database) {
  if (!tableHasColumn(database, "catalog_pages", "transaction_id")) {
    database.exec("ALTER TABLE catalog_pages ADD COLUMN transaction_id TEXT NOT NULL DEFAULT ''");
  }
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

    database.exec("COMMIT");
    return {
      ok: true,
      changed: result.changes,
      cancelledJobs: jobs.changes,
      cancelledRuns: runs.changes,
      deletedHeads: heads.changes,
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
  "opportunity_pipeline_candidates_v2",
  "opportunity_pipeline_submit_tasks_v2",
  "opportunity_pipeline_operation_events_v2",
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

function deleteNativeRecord(args = {}) {
  const database = ensureDb();
  const storeName = normalizeRecordStoreName(args.storeName || args.store);
  const recordId = recordIdFor(storeName, args.id || args.recordId);
  if (!recordId) throw createError("NATIVE_DATA_BAD_ARGUMENT", "Native record requires id", { storeName });
  const ts = nowIso();
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare("SELECT * FROM native_records WHERE store_name = ? AND record_id = ?").get(storeName, recordId);
    if (storeName === "stores" && existing) {
      const record = decodeJson(existing.payload_json, {});
      const tenantId = normalizeTenantId(record);
      const shopId = normalizeString(record.shopId || record.id || recordId);
      const generation = normalizeInteger(record.storeGeneration || record.generation) || activeStoreGeneration(database, tenantId, shopId) || maxStoreGeneration(database, tenantId, shopId);
      if (shopId && generation) {
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
    return { ok: true, storeName, recordId, deleted: result.changes, deletedAt: ts };
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
    case "stores.tombstoneIdentity": return tombstoneStoreIdentity(args);
    case "records.put": return putNativeRecord(args);
    case "records.putLarge.start": return startLargeNativeRecordPut(args);
    case "records.putLarge.chunk": return putLargeNativeRecordChunk(args);
    case "records.putLarge.commit": return commitLargeNativeRecordPut(args);
    case "records.putLarge.abort": return abortLargeNativeRecordPut(args);
    case "records.get": return getNativeRecord(args);
    case "records.list": return listNativeRecords(args);
    case "records.delete": return deleteNativeRecord(args);
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
