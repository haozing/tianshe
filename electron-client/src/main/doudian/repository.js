const { app } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { logStoreEvent } = require("./run-logger");

const DB_FILE = "chihu-doudian.db";
const DEFAULT_GROUP_NAME = "未分组";
const ALL_GROUP_NAME = "全部分组";

let db = null;
let runtimePolicy = {
  defaultGroupName: DEFAULT_GROUP_NAME,
  allGroupName: ALL_GROUP_NAME,
  defaultPlatform: "doudian",
  defaultStatus: "unknown",
  preserveGroupOnUpsert: true
};

function configurePolicy(policy = {}) {
  if (!policy || typeof policy !== "object") return;
  runtimePolicy = {
    ...runtimePolicy,
    ...(typeof policy.defaultGroupName === "string" ? { defaultGroupName: policy.defaultGroupName } : {}),
    ...(typeof policy.emptyGroupName === "string" ? { defaultGroupName: policy.emptyGroupName } : {}),
    ...(typeof policy.allGroupName === "string" ? { allGroupName: policy.allGroupName } : {}),
    ...(typeof policy.defaultPlatform === "string" ? { defaultPlatform: policy.defaultPlatform } : {}),
    ...(typeof policy.defaultStatus === "string" ? { defaultStatus: policy.defaultStatus } : {}),
    ...(typeof policy.preserveGroupOnUpsert === "boolean" ? { preserveGroupOnUpsert: policy.preserveGroupOnUpsert } : {})
  };
}

function defaultGroupName() {
  return runtimePolicy.defaultGroupName || DEFAULT_GROUP_NAME;
}

function allGroupName() {
  return runtimePolicy.allGroupName || ALL_GROUP_NAME;
}

function dbPath() {
  return path.join(app.getPath("userData"), DB_FILE);
}

function safeDbPragma(targetDb, statement, options = {}) {
  try {
    return targetDb.pragma(statement, options);
  } catch (error) {
    logStoreEvent("repository.pragma.failed", {
      statement,
      code: error?.code || "",
      message: error?.message || ""
    });
    return null;
  }
}

function configureDbConnection(targetDb) {
  safeDbPragma(targetDb, "busy_timeout = 5000");
  const journalMode = safeDbPragma(targetDb, "journal_mode", { simple: true });
  if (String(journalMode || "").toLowerCase() !== "wal") {
    safeDbPragma(targetDb, "journal_mode = WAL");
  }
  safeDbPragma(targetDb, "foreign_keys = ON");
}

function getDb() {
  if (db) return db;

  const Database = require("better-sqlite3");
  const filePath = dbPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let nextDb = null;
  try {
    nextDb = new Database(filePath);
    configureDbConnection(nextDb);
    ensureSchema(nextDb);
    db = nextDb;
    return db;
  } catch (error) {
    logStoreEvent("repository.open.failed", {
      dbFile: DB_FILE,
      code: error?.code || "",
      message: error?.message || ""
    });
    try {
      if (nextDb) nextDb.close();
    } catch {}
    throw error;
  }
}

function ensureFundsDataV2Schema(targetDb) {
  const columns = targetDb.prepare("PRAGMA table_info(chihu_doudian_funds_data)").all();
  if (!columns.length) return;
  const names = new Set(columns.map((column) => String(column.name || "")));
  const requiredColumns = [
    "adapter_version",
    "field_schema_version",
    "request_plan_hash",
    "store_status",
    "sync_status"
  ];
  if (requiredColumns.some((column) => !names.has(column))) {
    targetDb.exec("DROP TABLE IF EXISTS chihu_doudian_funds_data;");
  }
}

function ensureViolationsDataV2Schema(targetDb) {
  const columns = targetDb.prepare("PRAGMA table_info(chihu_doudian_violations_data)").all();
  if (!columns.length) return;
  const names = new Set(columns.map((column) => String(column.name || "")));
  const requiredColumns = [
    "field_schema_version",
    "request_plan_hash",
    "product_linkage_version"
  ];
  if (requiredColumns.some((column) => !names.has(column))) {
    targetDb.exec("DROP TABLE IF EXISTS chihu_doudian_violations_data;");
  }
}

function ensureStaleGoodsDataV2Schema(targetDb) {
  const scanColumns = targetDb.prepare("PRAGMA table_info(chihu_stale_goods_scan_runs)").all();
  if (!scanColumns.length) return;
  const productColumns = targetDb.prepare("PRAGMA table_info(chihu_stale_goods_products)").all();
  const sourceColumns = targetDb.prepare("PRAGMA table_info(chihu_stale_goods_source_pages)").all();
  const scanNames = new Set(scanColumns.map((column) => String(column.name || "")));
  const productNames = new Set(productColumns.map((column) => String(column.name || "")));
  const sourceNames = new Set(sourceColumns.map((column) => String(column.name || "")));
  const requiredScanColumns = [
    "field_schema_version",
    "request_plan_hash",
    "summary",
    "rules",
    "detail"
  ];
  const requiredProductColumns = [
    "created_at_value",
    "listed_at_value",
    "created_at_source",
    "listed_at_source",
    "age_date_value",
    "age_date_source",
    "age_date_type",
    "days_since_age",
    "days_since_created",
    "days_since_listed",
    "created_at_missing",
    "listed_at_missing"
  ];
  const requiredSourceColumns = [
    "status",
    "http_status",
    "optional",
    "diagnostic_only",
    "pagination",
    "response_shape"
  ];
  const stale =
    requiredScanColumns.some((column) => !scanNames.has(column)) ||
    requiredProductColumns.some((column) => !productNames.has(column)) ||
    requiredSourceColumns.some((column) => !sourceNames.has(column));
  if (!stale) return;
  targetDb.exec(`
    DROP TABLE IF EXISTS chihu_stale_goods_execute_items;
    DROP TABLE IF EXISTS chihu_stale_goods_execute_runs;
    DROP TABLE IF EXISTS chihu_stale_goods_candidates;
    DROP TABLE IF EXISTS chihu_stale_goods_products;
    DROP TABLE IF EXISTS chihu_stale_goods_source_pages;
    DROP TABLE IF EXISTS chihu_stale_goods_scan_runs;
  `);
}

function ensureSchema(targetDb) {
  ensureFundsDataV2Schema(targetDb);
  ensureViolationsDataV2Schema(targetDb);
  ensureStaleGoodsDataV2Schema(targetDb);
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS chihu_doudian_stores (
      shop_id TEXT PRIMARY KEY,
      shop_name TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT 'doudian',
      partition TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unknown',
      operate_status TEXT NOT NULL DEFAULT '',
      group_id TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      shop_info_summary TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_check_at TEXT NOT NULL DEFAULT '',
      last_fetch_at TEXT NOT NULL DEFAULT '',
      last_failure_reason TEXT NOT NULL DEFAULT '',
      last_failure_message TEXT NOT NULL DEFAULT '',
      adapter_version TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_stores_group
      ON chihu_doudian_stores(group_name);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_stores_status
      ON chihu_doudian_stores(status);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_stores_updated
      ON chihu_doudian_stores(updated_at);

    CREATE TABLE IF NOT EXISTS chihu_doudian_store_groups (
      group_id TEXT PRIMARY KEY,
      group_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chihu_doudian_store_runs (
      run_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      adapter_version TEXT NOT NULL DEFAULT '',
      adapter_source TEXT NOT NULL DEFAULT '',
      scripts_version TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      store_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_store_runs_started
      ON chihu_doudian_store_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_store_runs_operation
      ON chihu_doudian_store_runs(operation_id);

    CREATE TABLE IF NOT EXISTS chihu_doudian_store_attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL DEFAULT '',
      shop_id TEXT NOT NULL DEFAULT '',
      shop_name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      diagnostic TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL,
      adapter_version TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_store_attempts_run
      ON chihu_doudian_store_attempts(run_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_store_attempts_shop
      ON chihu_doudian_store_attempts(shop_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_store_attempts_finished
      ON chihu_doudian_store_attempts(finished_at);

    CREATE TABLE IF NOT EXISTS chihu_doudian_business_data (
      shop_id TEXT NOT NULL,
      date_preset TEXT NOT NULL DEFAULT '',
      begin_date TEXT NOT NULL DEFAULT '',
      end_date TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      shop_name TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unknown',
      ok INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      adapter_version TEXT NOT NULL DEFAULT '',
      scripts_version TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL,
      row_data TEXT NOT NULL DEFAULT '{}',
      diagnostic TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (shop_id, date_preset, begin_date, end_date)
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_business_data_synced
      ON chihu_doudian_business_data(synced_at);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_business_data_shop
      ON chihu_doudian_business_data(shop_id);

    CREATE TABLE IF NOT EXISTS chihu_doudian_funds_data (
      shop_id TEXT NOT NULL,
      date_preset TEXT NOT NULL DEFAULT '',
      begin_date TEXT NOT NULL DEFAULT '',
      end_date TEXT NOT NULL DEFAULT '',
      adapter_version TEXT NOT NULL DEFAULT '',
      field_schema_version TEXT NOT NULL DEFAULT '',
      request_plan_hash TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      shop_name TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      store_status TEXT NOT NULL DEFAULT 'unknown',
      sync_status TEXT NOT NULL DEFAULT 'unknown',
      ok INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      scripts_version TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL,
      row_data TEXT NOT NULL DEFAULT '{}',
      diagnostic TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (shop_id, date_preset, begin_date, end_date, adapter_version, field_schema_version)
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_funds_data_synced
      ON chihu_doudian_funds_data(synced_at);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_funds_data_shop
      ON chihu_doudian_funds_data(shop_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_funds_data_contract
      ON chihu_doudian_funds_data(adapter_version, field_schema_version);

    CREATE TABLE IF NOT EXISTS chihu_doudian_violations_data (
      shop_id TEXT NOT NULL,
      date_preset TEXT NOT NULL DEFAULT '',
      begin_date TEXT NOT NULL DEFAULT '',
      end_date TEXT NOT NULL DEFAULT '',
      adapter_version TEXT NOT NULL DEFAULT '',
      field_schema_version TEXT NOT NULL DEFAULT '',
      request_plan_hash TEXT NOT NULL DEFAULT '',
      product_linkage_version TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      shop_name TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      store_status TEXT NOT NULL DEFAULT 'unknown',
      sync_status TEXT NOT NULL DEFAULT 'unknown',
      ok INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      scripts_version TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL,
      row_data TEXT NOT NULL DEFAULT '{}',
      records_data TEXT NOT NULL DEFAULT '[]',
      diagnostic TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (
        shop_id,
        date_preset,
        begin_date,
        end_date,
        adapter_version,
        field_schema_version,
        request_plan_hash,
        product_linkage_version
      )
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_violations_data_synced
      ON chihu_doudian_violations_data(synced_at);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_violations_data_shop
      ON chihu_doudian_violations_data(shop_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_violations_data_contract
      ON chihu_doudian_violations_data(adapter_version, field_schema_version, request_plan_hash, product_linkage_version);

    CREATE TABLE IF NOT EXISTS chihu_doudian_violation_records (
      shop_id TEXT NOT NULL,
      violation_id TEXT NOT NULL,
      adapter_version TEXT NOT NULL DEFAULT '',
      field_schema_version TEXT NOT NULL DEFAULT '',
      request_plan_hash TEXT NOT NULL DEFAULT '',
      product_linkage_version TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      shop_name TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      object_type TEXT NOT NULL DEFAULT '',
      object_name TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT '',
      process_status TEXT NOT NULL DEFAULT '',
      association_status TEXT NOT NULL DEFAULT 'not_checked',
      product_status TEXT NOT NULL DEFAULT '',
      due_at TEXT NOT NULL DEFAULT '',
      penalty_amount REAL NOT NULL DEFAULT 0,
      action_suggestion TEXT NOT NULL DEFAULT '',
      source_plan TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL,
      raw_data TEXT NOT NULL DEFAULT '{}',
      diagnostic TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (
        shop_id,
        violation_id,
        adapter_version,
        field_schema_version,
        request_plan_hash,
        product_linkage_version
      )
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_violation_records_shop
      ON chihu_doudian_violation_records(shop_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_violation_records_product
      ON chihu_doudian_violation_records(product_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_violation_records_synced
      ON chihu_doudian_violation_records(synced_at);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_violation_records_contract
      ON chihu_doudian_violation_records(adapter_version, field_schema_version, request_plan_hash, product_linkage_version);

    CREATE TABLE IF NOT EXISTS chihu_doudian_violation_failures (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL DEFAULT '',
      shop_id TEXT NOT NULL DEFAULT '',
      violation_id TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL DEFAULT '',
      phase TEXT NOT NULL DEFAULT '',
      plan_key TEXT NOT NULL DEFAULT '',
      action_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      diagnostic TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_violation_failures_run
      ON chihu_doudian_violation_failures(run_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_violation_failures_shop
      ON chihu_doudian_violation_failures(shop_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_doudian_violation_failures_created
      ON chihu_doudian_violation_failures(created_at);

    CREATE TABLE IF NOT EXISTS chihu_stale_goods_scan_runs (
      run_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL DEFAULT 'stale_goods.v2',
      adapter_version TEXT NOT NULL DEFAULT '',
      field_schema_version TEXT NOT NULL DEFAULT '',
      request_plan_hash TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'scan',
      status TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      store_count INTEGER NOT NULL DEFAULT 0,
      product_count INTEGER NOT NULL DEFAULT 0,
      remote_total INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '{}',
      rules TEXT NOT NULL DEFAULT '{}',
      detail TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_stale_goods_scan_runs_finished
      ON chihu_stale_goods_scan_runs(finished_at);

    CREATE TABLE IF NOT EXISTS chihu_stale_goods_source_pages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL DEFAULT '',
      shop_id TEXT NOT NULL DEFAULT '',
      shop_name TEXT NOT NULL DEFAULT '',
      source_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      http_status INTEGER NOT NULL DEFAULT 0,
      code TEXT NOT NULL DEFAULT '',
      optional INTEGER NOT NULL DEFAULT 0,
      diagnostic_only INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      pagination TEXT NOT NULL DEFAULT '{}',
      response_shape TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_stale_goods_source_pages_run
      ON chihu_stale_goods_source_pages(run_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_stale_goods_source_pages_shop
      ON chihu_stale_goods_source_pages(shop_id);

    CREATE TABLE IF NOT EXISTS chihu_stale_goods_products (
      run_id TEXT NOT NULL DEFAULT '',
      shop_id TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL DEFAULT '',
      shop_name TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      created_at_value TEXT NOT NULL DEFAULT '',
      listed_at_value TEXT NOT NULL DEFAULT '',
      created_at_source TEXT NOT NULL DEFAULT '',
      listed_at_source TEXT NOT NULL DEFAULT '',
      age_date_value TEXT NOT NULL DEFAULT '',
      age_date_source TEXT NOT NULL DEFAULT '',
      age_date_type TEXT NOT NULL DEFAULT '',
      days_since_age INTEGER NOT NULL DEFAULT -1,
      days_since_created INTEGER NOT NULL DEFAULT -1,
      days_since_listed INTEGER NOT NULL DEFAULT -1,
      created_at_missing INTEGER NOT NULL DEFAULT 0,
      listed_at_missing INTEGER NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      stock REAL NOT NULL DEFAULT 0,
      total_sales REAL NOT NULL DEFAULT 0,
      period_sales REAL NOT NULL DEFAULT 0,
      exposure_count REAL NOT NULL DEFAULT 0,
      click_count REAL NOT NULL DEFAULT 0,
      row_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, shop_id, product_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_stale_goods_products_shop
      ON chihu_stale_goods_products(shop_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_stale_goods_products_product
      ON chihu_stale_goods_products(product_id);

    CREATE TABLE IF NOT EXISTS chihu_stale_goods_candidates (
      candidate_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL DEFAULT '',
      shop_id TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL DEFAULT '',
      shop_name TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT '',
      risk_score REAL NOT NULL DEFAULT 0,
      reasons TEXT NOT NULL DEFAULT '[]',
      row_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_stale_goods_candidates_run
      ON chihu_stale_goods_candidates(run_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_stale_goods_candidates_shop
      ON chihu_stale_goods_candidates(shop_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_stale_goods_candidates_product
      ON chihu_stale_goods_candidates(product_id);

    CREATE TABLE IF NOT EXISTS chihu_stale_goods_execute_runs (
      execute_run_id TEXT PRIMARY KEY,
      source_run_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      confirm_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      dry_run INTEGER NOT NULL DEFAULT 1,
      item_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chihu_stale_goods_execute_items (
      id TEXT PRIMARY KEY,
      execute_run_id TEXT NOT NULL DEFAULT '',
      source_run_id TEXT NOT NULL DEFAULT '',
      candidate_id TEXT NOT NULL DEFAULT '',
      shop_id TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      ok INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      plan_key TEXT NOT NULL DEFAULT '',
      row_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chihu_stale_goods_execute_items_run
      ON chihu_stale_goods_execute_items(execute_run_id);
    CREATE INDEX IF NOT EXISTS idx_chihu_stale_goods_execute_items_candidate
      ON chihu_stale_goods_execute_items(candidate_id);
  `);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value) {
  return JSON.stringify(value == null ? {} : value);
}

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value == null ? "" : value))
    .digest("hex")
    .slice(0, 20);
}

function stableFailureId(parts) {
  return `violfail_${stableHash(parts)}`;
}

function stableStaleGoodsSourcePageId(parts) {
  return `stale_src_${stableHash(parts)}`;
}

function stableStaleGoodsCandidateId(runId, candidate) {
  return `stale_cand_${stableHash([
    runId,
    candidate?.candidateId || "",
    candidate?.id || "",
    candidate?.shopId || "",
    candidate?.productId || ""
  ])}`;
}

function stableStaleGoodsExecuteItemId(executeRunId, item) {
  return `stale_exec_item_${stableHash([
    executeRunId,
    item?.id || "",
    item?.shopId || "",
    item?.productId || "",
    item?.action || ""
  ])}`;
}

function rowToStore(row) {
  if (!row) return null;
  const data = parseJson(row.data, {});
  return {
    ...data,
    shopId: row.shop_id,
    shopName: row.shop_name,
    platform: row.platform || runtimePolicy.defaultPlatform || "doudian",
    partition: row.partition,
    status: row.status || runtimePolicy.defaultStatus || "unknown",
    operateStatus: row.operate_status || "",
    groupId: row.group_id || "",
    groupName: row.group_name || "",
    shopInfoSummary: parseJson(row.shop_info_summary, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginCheckAt: row.last_login_check_at || "",
    lastFetchAt: row.last_fetch_at || "",
    lastFailureReason: row.last_failure_reason || "",
    lastFailureMessage: row.last_failure_message || "",
    adapterVersion: row.adapter_version || ""
  };
}

function normalizeStore(store, previous = null) {
  const now = nowIso();
  const shopId = String(store?.shopId || store?.id || "");
  if (!shopId) return null;

  const previousStore = previous || {};
  const groupName = runtimePolicy.preserveGroupOnUpsert !== false
    ? previousStore.groupName || store.groupName || ""
    : store.groupName || previousStore.groupName || "";
  const next = {
    ...previousStore,
    ...store,
    shopId,
    shopName: String(store.shopName || store.shop_name || previousStore.shopName || ""),
    platform: String(store.platform || previousStore.platform || runtimePolicy.defaultPlatform || "doudian"),
    partition: String(store.partition || previousStore.partition || ""),
    status: String(store.status || previousStore.status || runtimePolicy.defaultStatus || "unknown"),
    operateStatus: String(store.operateStatus || previousStore.operateStatus || ""),
    groupId: String(previousStore.groupId || store.groupId || ""),
    groupName: String(groupName),
    shopInfoSummary: store.shopInfoSummary || previousStore.shopInfoSummary || store.rawSummary || store.raw || {},
    createdAt: previousStore.createdAt || store.createdAt || now,
    updatedAt: now,
    lastLoginCheckAt: String(store.lastLoginCheckAt ?? previousStore.lastLoginCheckAt ?? ""),
    lastFetchAt: String(store.lastFetchAt ?? previousStore.lastFetchAt ?? ""),
    lastFailureReason: String(store.lastFailureReason ?? previousStore.lastFailureReason ?? ""),
    lastFailureMessage: String(store.lastFailureMessage ?? previousStore.lastFailureMessage ?? ""),
    adapterVersion: String(store.adapterVersion ?? previousStore.adapterVersion ?? "")
  };

  if (next.groupName === defaultGroupName()) {
    next.groupId = "";
    next.groupName = "";
  }

  return next;
}

function storeParams(store) {
  return {
    shop_id: store.shopId,
    shop_name: store.shopName,
    platform: store.platform,
    partition: store.partition,
    status: store.status,
    operate_status: store.operateStatus,
    group_id: store.groupId,
    group_name: store.groupName,
    shop_info_summary: stringifyJson(store.shopInfoSummary),
    created_at: store.createdAt,
    updated_at: store.updatedAt,
    last_login_check_at: store.lastLoginCheckAt,
    last_fetch_at: store.lastFetchAt,
    last_failure_reason: store.lastFailureReason,
    last_failure_message: store.lastFailureMessage,
    adapter_version: store.adapterVersion,
    data: stringifyJson(store)
  };
}

function upsertGroup(groupName, groupId = "") {
  const name = String(groupName || "").trim();
  if (!name || name === defaultGroupName() || name === allGroupName()) return;

  const id = String(groupId || name);
  const now = nowIso();
  getDb().prepare(`
    INSERT INTO chihu_doudian_store_groups (group_id, group_name, created_at, updated_at)
    VALUES (@group_id, @group_name, @created_at, @updated_at)
    ON CONFLICT(group_id) DO UPDATE SET
      group_name = excluded.group_name,
      updated_at = excluded.updated_at
  `).run({
    group_id: id,
    group_name: name,
    created_at: now,
    updated_at: now
  });
}

function createGroup(groupName, groupId = "") {
  const name = String(groupName || "").trim();
  if (!name || name === defaultGroupName() || name === allGroupName()) {
    return { created: false, reason: "protected", group: null };
  }
  upsertGroup(name, groupId || name);
  return {
    created: true,
    reason: "",
    group: {
      groupId: String(groupId || name),
      groupName: name,
      count: 0
    }
  };
}

function listStores() {
  return getDb().prepare(`
    SELECT * FROM chihu_doudian_stores
    ORDER BY shop_name COLLATE NOCASE ASC, updated_at DESC
  `).all().map(rowToStore);
}

function listGroups() {
  const counts = new Map();
  const groups = new Map();

  for (const store of listStores()) {
    const groupName = String(store.groupName || defaultGroupName());
    counts.set(groupName, (counts.get(groupName) || 0) + 1);
    if (!groups.has(groupName)) {
      groups.set(groupName, {
        groupId: store.groupId || (groupName === defaultGroupName() ? "" : groupName),
        groupName,
        count: 0
      });
    }
  }

  const storedGroups = getDb().prepare(`
    SELECT group_id, group_name
    FROM chihu_doudian_store_groups
    ORDER BY group_name COLLATE NOCASE ASC
  `).all();

  for (const row of storedGroups) {
    const groupName = String(row.group_name || "").trim();
    if (!groupName) continue;
    groups.set(groupName, {
      groupId: row.group_id || groupName,
      groupName,
      count: 0
    });
  }

  if (!groups.has(defaultGroupName())) {
    groups.set(defaultGroupName(), {
      groupId: "",
      groupName: defaultGroupName(),
      count: 0
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      count: counts.get(group.groupName) || 0
    }))
    .sort((left, right) => {
      if (left.groupName === defaultGroupName()) return -1;
      if (right.groupName === defaultGroupName()) return 1;
      return left.groupName.localeCompare(right.groupName, "zh-CN");
    });
}

function findStore(shopId) {
  return rowToStore(getDb().prepare("SELECT * FROM chihu_doudian_stores WHERE shop_id = ?").get(String(shopId)));
}

function upsertStores(nextStores) {
  const list = Array.isArray(nextStores) ? nextStores : [];
  const changed = [];
  const stmt = getDb().prepare(`
    INSERT INTO chihu_doudian_stores (
      shop_id, shop_name, platform, partition, status, operate_status, group_id, group_name,
      shop_info_summary, created_at, updated_at, last_login_check_at, last_fetch_at,
      last_failure_reason, last_failure_message, adapter_version, data
    ) VALUES (
      @shop_id, @shop_name, @platform, @partition, @status, @operate_status, @group_id, @group_name,
      @shop_info_summary, @created_at, @updated_at, @last_login_check_at, @last_fetch_at,
      @last_failure_reason, @last_failure_message, @adapter_version, @data
    )
    ON CONFLICT(shop_id) DO UPDATE SET
      shop_name = excluded.shop_name,
      platform = excluded.platform,
      partition = excluded.partition,
      status = excluded.status,
      operate_status = excluded.operate_status,
      group_id = excluded.group_id,
      group_name = excluded.group_name,
      shop_info_summary = excluded.shop_info_summary,
      updated_at = excluded.updated_at,
      last_login_check_at = excluded.last_login_check_at,
      last_fetch_at = excluded.last_fetch_at,
      last_failure_reason = excluded.last_failure_reason,
      last_failure_message = excluded.last_failure_message,
      adapter_version = excluded.adapter_version,
      data = excluded.data
  `);

  getDb().transaction((stores) => {
    for (const store of stores) {
      const previous = store?.shopId ? findStore(store.shopId) : null;
      const next = normalizeStore(store, previous);
      if (!next) continue;
      if (next.groupName) upsertGroup(next.groupName, next.groupId || next.groupName);
      stmt.run(storeParams(next));
      changed.push(next);
    }
  })(list);

  return changed;
}

function replaceStores(nextStores) {
  return upsertStores(nextStores);
}

function updateStores(nextStores) {
  return upsertStores(nextStores);
}

function deleteStores(shopIds) {
  const ids = Array.from(new Set((shopIds || []).map((id) => String(id)).filter(Boolean)));
  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(",");
  const deleted = getDb().prepare(`SELECT * FROM chihu_doudian_stores WHERE shop_id IN (${placeholders})`).all(...ids).map(rowToStore);
  getDb().prepare(`DELETE FROM chihu_doudian_stores WHERE shop_id IN (${placeholders})`).run(...ids);
  return deleted;
}

function updateStoreGroup(shopIds, groupName, groupId = "") {
  const ids = Array.from(new Set((shopIds || []).map((id) => String(id)).filter(Boolean)));
  if (!ids.length) return [];

  const now = nowIso();
  const nextGroupName = String(groupName || "").trim();
  const nextGroupId = nextGroupName === defaultGroupName() ? "" : String(groupId || nextGroupName);
  const storedGroupName = nextGroupName === defaultGroupName() ? "" : nextGroupName;
  if (storedGroupName) upsertGroup(storedGroupName, nextGroupId);

  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT * FROM chihu_doudian_stores WHERE shop_id IN (${placeholders})`).all(...ids);
  const update = getDb().prepare(`
    UPDATE chihu_doudian_stores
    SET group_id = ?, group_name = ?, updated_at = ?, data = ?
    WHERE shop_id = ?
  `);
  const changed = [];

  getDb().transaction((stores) => {
    for (const row of stores) {
      const store = rowToStore(row);
      const updated = {
        ...store,
        groupId: nextGroupId,
        groupName: storedGroupName,
        updatedAt: now
      };
      update.run(nextGroupId, storedGroupName, now, stringifyJson(updated), store.shopId);
      changed.push(updated);
    }
  })(rows);

  return changed;
}

function renameGroup(oldGroupName, newGroupName) {
  const oldName = String(oldGroupName || "").trim();
  const nextName = String(newGroupName || "").trim() || defaultGroupName();
  if (!oldName || oldName === allGroupName()) return [];

  const current = listStores().filter((store) => String(store.groupName || defaultGroupName()) === oldName);
  const changed = updateStoreGroup(current.map((store) => store.shopId), nextName, nextName);
  if (oldName !== defaultGroupName()) {
    getDb().prepare("DELETE FROM chihu_doudian_store_groups WHERE group_name = ?").run(oldName);
  }
  return changed;
}

function deleteEmptyGroup(groupName) {
  const name = String(groupName || "").trim();
  if (!name || name === defaultGroupName() || name === allGroupName()) return { deleted: false, reason: "protected" };

  const exists = getDb().prepare("SELECT 1 FROM chihu_doudian_stores WHERE group_name = ? LIMIT 1").get(name);
  if (exists) return { deleted: false, reason: "not-empty" };

  getDb().prepare("DELETE FROM chihu_doudian_store_groups WHERE group_name = ?").run(name);
  return { deleted: true, reason: "" };
}

function createRun(input = {}) {
  const now = nowIso();
  const run = {
    runId: input.runId || generateId("run"),
    operationId: String(input.operationId || ""),
    type: String(input.type || "unknown"),
    status: String(input.status || "running"),
    adapterVersion: String(input.adapterVersion || ""),
    adapterSource: String(input.adapterSource || ""),
    scriptsVersion: String(input.scriptsVersion || ""),
    startedAt: input.startedAt || now,
    finishedAt: String(input.finishedAt || ""),
    storeCount: Number(input.storeCount || 0),
    successCount: Number(input.successCount || 0),
    failureCount: Number(input.failureCount || 0),
    cancelled: input.cancelled ? 1 : 0,
    message: String(input.message || ""),
    detail: input.detail || {}
  };

  getDb().prepare(`
    INSERT INTO chihu_doudian_store_runs (
      run_id, operation_id, type, status, adapter_version, adapter_source, scripts_version,
      started_at, finished_at, store_count, success_count, failure_count, cancelled, message, detail
    ) VALUES (
      @run_id, @operation_id, @type, @status, @adapter_version, @adapter_source, @scripts_version,
      @started_at, @finished_at, @store_count, @success_count, @failure_count, @cancelled, @message, @detail
    )
  `).run({
    run_id: run.runId,
    operation_id: run.operationId,
    type: run.type,
    status: run.status,
    adapter_version: run.adapterVersion,
    adapter_source: run.adapterSource,
    scripts_version: run.scriptsVersion,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    store_count: run.storeCount,
    success_count: run.successCount,
    failure_count: run.failureCount,
    cancelled: run.cancelled,
    message: run.message,
    detail: stringifyJson(run.detail)
  });

  return run;
}

function finishRun(runId, input = {}) {
  if (!runId) return null;

  const now = nowIso();
  getDb().prepare(`
    UPDATE chihu_doudian_store_runs
    SET status = COALESCE(@status, status),
      finished_at = @finished_at,
      store_count = COALESCE(@store_count, store_count),
      success_count = COALESCE(@success_count, success_count),
      failure_count = COALESCE(@failure_count, failure_count),
      cancelled = COALESCE(@cancelled, cancelled),
      message = COALESCE(@message, message),
      detail = COALESCE(@detail, detail)
    WHERE run_id = @run_id
  `).run({
    run_id: String(runId),
    status: input.status == null ? null : String(input.status),
    finished_at: input.finishedAt || now,
    store_count: input.storeCount == null ? null : Number(input.storeCount || 0),
    success_count: input.successCount == null ? null : Number(input.successCount || 0),
    failure_count: input.failureCount == null ? null : Number(input.failureCount || 0),
    cancelled: input.cancelled == null ? null : input.cancelled ? 1 : 0,
    message: input.message == null ? null : String(input.message || ""),
    detail: input.detail == null ? null : stringifyJson(input.detail)
  });

  return getRun(runId);
}

function getRun(runId) {
  const row = getDb().prepare("SELECT * FROM chihu_doudian_store_runs WHERE run_id = ?").get(String(runId));
  if (!row) return null;
  return {
    runId: row.run_id,
    operationId: row.operation_id,
    type: row.type,
    status: row.status,
    adapterVersion: row.adapter_version,
    adapterSource: row.adapter_source,
    scriptsVersion: row.scripts_version,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    storeCount: row.store_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    cancelled: !!row.cancelled,
    message: row.message,
    detail: parseJson(row.detail, {})
  };
}

function recordAttempt(input = {}) {
  const now = nowIso();
  const attempt = {
    attemptId: input.attemptId || generateId("attempt"),
    runId: String(input.runId || ""),
    shopId: String(input.shopId || ""),
    shopName: String(input.shopName || ""),
    type: String(input.type || "unknown"),
    status: String(input.status || (input.ok ? "ok" : "failed")),
    ok: input.ok ? 1 : 0,
    reason: String(input.reason || ""),
    category: String(input.category || ""),
    message: String(input.message || ""),
    diagnostic: input.diagnostic || {},
    startedAt: String(input.startedAt || ""),
    finishedAt: input.finishedAt || now,
    adapterVersion: String(input.adapterVersion || ""),
    data: input.data || {}
  };

  getDb().prepare(`
    INSERT INTO chihu_doudian_store_attempts (
      attempt_id, run_id, shop_id, shop_name, type, status, ok, reason, category,
      message, diagnostic, started_at, finished_at, adapter_version, data
    ) VALUES (
      @attempt_id, @run_id, @shop_id, @shop_name, @type, @status, @ok, @reason, @category,
      @message, @diagnostic, @started_at, @finished_at, @adapter_version, @data
    )
  `).run({
    attempt_id: attempt.attemptId,
    run_id: attempt.runId,
    shop_id: attempt.shopId,
    shop_name: attempt.shopName,
    type: attempt.type,
    status: attempt.status,
    ok: attempt.ok,
    reason: attempt.reason,
    category: attempt.category,
    message: attempt.message,
    diagnostic: stringifyJson(attempt.diagnostic),
    started_at: attempt.startedAt,
    finished_at: attempt.finishedAt,
    adapter_version: attempt.adapterVersion,
    data: stringifyJson(attempt.data)
  });

  return attempt;
}

function saveBusinessDataRows(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (!rows.length) return 0;
  const details = Array.isArray(input.details) ? input.details : [];
  const detailById = new Map(details.map((detail) => [String(detail.shopId || ""), detail]));
  const dateRange = input.dateRange || {};
  const datePreset = String(dateRange.datePreset || input.datePreset || "");
  const beginDate = String(dateRange.beginDate || input.beginDate || "");
  const endDate = String(dateRange.endDate || input.endDate || "");
  const syncedAt = input.syncedAt || nowIso();
  const statement = getDb().prepare(`
    INSERT INTO chihu_doudian_business_data (
      shop_id, date_preset, begin_date, end_date, run_id, shop_name, group_name, status,
      ok, message, adapter_version, scripts_version, synced_at, row_data, diagnostic
    ) VALUES (
      @shop_id, @date_preset, @begin_date, @end_date, @run_id, @shop_name, @group_name, @status,
      @ok, @message, @adapter_version, @scripts_version, @synced_at, @row_data, @diagnostic
    )
    ON CONFLICT(shop_id, date_preset, begin_date, end_date) DO UPDATE SET
      run_id = excluded.run_id,
      shop_name = excluded.shop_name,
      group_name = excluded.group_name,
      status = excluded.status,
      ok = excluded.ok,
      message = excluded.message,
      adapter_version = excluded.adapter_version,
      scripts_version = excluded.scripts_version,
      synced_at = excluded.synced_at,
      row_data = excluded.row_data,
      diagnostic = excluded.diagnostic
  `);
  const transaction = getDb().transaction(() => {
    for (const row of rows) {
      const shopId = String(row.shopId || "");
      if (!shopId) continue;
      const detail = detailById.get(shopId) || {};
      statement.run({
        shop_id: shopId,
        date_preset: datePreset,
        begin_date: beginDate,
        end_date: endDate,
        run_id: String(input.runId || ""),
        shop_name: String(row.shopName || detail.shopName || ""),
        group_name: String(row.group || row.groupName || ""),
        status: String(row.status || detail.status || "unknown"),
        ok: detail.ok === false ? 0 : 1,
        message: String(detail.message || ""),
        adapter_version: String(input.adapterVersion || ""),
        scripts_version: String(input.scriptsVersion || ""),
        synced_at: syncedAt,
        row_data: stringifyJson(row),
        diagnostic: stringifyJson(detail.diagnostic || {})
      });
    }
  });
  transaction();
  return rows.length;
}

function listBusinessDataRows(input = {}) {
  const datePreset = String(input.datePreset || "");
  const beginDate = String(input.beginDate || "");
  const endDate = String(input.endDate || "");
  const shopIds = Array.isArray(input.shopIds) ? input.shopIds.map((id) => String(id)).filter(Boolean) : [];
  const where = [];
  const params = {};
  if (datePreset) {
    where.push("date_preset = @date_preset");
    params.date_preset = datePreset;
  }
  if (beginDate) {
    where.push("begin_date = @begin_date");
    params.begin_date = beginDate;
  }
  if (endDate) {
    where.push("end_date = @end_date");
    params.end_date = endDate;
  }
  if (shopIds.length) {
    where.push(`shop_id IN (${shopIds.map((_, index) => `@shop_id_${index}`).join(", ")})`);
    shopIds.forEach((id, index) => {
      params[`shop_id_${index}`] = id;
    });
  }
  const rows = getDb().prepare(`
    SELECT * FROM chihu_doudian_business_data
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY synced_at DESC
  `).all(params);
  return rows.map((row) => ({
    shopId: row.shop_id,
    shopName: row.shop_name,
    group: row.group_name,
    status: row.status,
    ok: !!row.ok,
    message: row.message,
    runId: row.run_id,
    adapterVersion: row.adapter_version,
    scriptsVersion: row.scripts_version,
    syncedAt: row.synced_at,
    datePreset: row.date_preset,
    beginDate: row.begin_date,
    endDate: row.end_date,
    row: parseJson(row.row_data, {}),
    diagnostic: parseJson(row.diagnostic, {})
  }));
}

function saveFundsDataRows(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (!rows.length) return 0;
  const details = Array.isArray(input.details) ? input.details : [];
  const detailById = new Map(details.map((detail) => [String(detail.shopId || ""), detail]));
  const dateRange = input.dateRange || {};
  const datePreset = String(dateRange.datePreset || input.datePreset || "");
  const beginDate = String(dateRange.beginDate || input.beginDate || "");
  const endDate = String(dateRange.endDate || input.endDate || "");
  const syncedAt = input.syncedAt || nowIso();
  const adapterVersion = String(input.adapterVersion || "");
  const fieldSchemaVersion = String(input.fieldSchemaVersion || "");
  const requestPlanHash = String(input.requestPlanHash || "");
  const statement = getDb().prepare(`
    INSERT INTO chihu_doudian_funds_data (
      shop_id, date_preset, begin_date, end_date, adapter_version, field_schema_version, request_plan_hash,
      run_id, shop_name, group_name, store_status, sync_status, ok, message, scripts_version, synced_at, row_data, diagnostic
    ) VALUES (
      @shop_id, @date_preset, @begin_date, @end_date, @adapter_version, @field_schema_version, @request_plan_hash,
      @run_id, @shop_name, @group_name, @store_status, @sync_status, @ok, @message, @scripts_version, @synced_at, @row_data, @diagnostic
    )
    ON CONFLICT(shop_id, date_preset, begin_date, end_date, adapter_version, field_schema_version) DO UPDATE SET
      request_plan_hash = excluded.request_plan_hash,
      run_id = excluded.run_id,
      shop_name = excluded.shop_name,
      group_name = excluded.group_name,
      store_status = excluded.store_status,
      sync_status = excluded.sync_status,
      ok = excluded.ok,
      message = excluded.message,
      scripts_version = excluded.scripts_version,
      synced_at = excluded.synced_at,
      row_data = excluded.row_data,
      diagnostic = excluded.diagnostic
  `);
  const transaction = getDb().transaction(() => {
    for (const row of rows) {
      const shopId = String(row.shopId || "");
      if (!shopId) continue;
      const detail = detailById.get(shopId) || {};
      statement.run({
        shop_id: shopId,
        date_preset: datePreset,
        begin_date: beginDate,
        end_date: endDate,
        adapter_version: adapterVersion,
        field_schema_version: fieldSchemaVersion,
        request_plan_hash: requestPlanHash,
        run_id: String(input.runId || ""),
        shop_name: String(row.shopName || detail.shopName || ""),
        group_name: String(row.group || row.groupName || ""),
        store_status: String(row.status || "unknown"),
        sync_status: String(detail.status || (detail.ok === true ? "ok" : "failed")),
        ok: detail.ok === true ? 1 : 0,
        message: String(detail.message || ""),
        scripts_version: String(input.scriptsVersion || ""),
        synced_at: syncedAt,
        row_data: stringifyJson(row),
        diagnostic: stringifyJson(detail.diagnostic || {})
      });
    }
  });
  transaction();
  return rows.length;
}

function listFundsDataRows(input = {}) {
  const datePreset = String(input.datePreset || "");
  const beginDate = String(input.beginDate || "");
  const endDate = String(input.endDate || "");
  const adapterVersion = String(input.adapterVersion || "");
  const fieldSchemaVersion = String(input.fieldSchemaVersion || "");
  const shopIds = Array.isArray(input.shopIds) ? input.shopIds.map((id) => String(id)).filter(Boolean) : [];
  const where = [];
  const params = {};
  if (datePreset) {
    where.push("date_preset = @date_preset");
    params.date_preset = datePreset;
  }
  if (beginDate) {
    where.push("begin_date = @begin_date");
    params.begin_date = beginDate;
  }
  if (endDate) {
    where.push("end_date = @end_date");
    params.end_date = endDate;
  }
  if (adapterVersion) {
    where.push("adapter_version = @adapter_version");
    params.adapter_version = adapterVersion;
  }
  if (fieldSchemaVersion) {
    where.push("field_schema_version = @field_schema_version");
    params.field_schema_version = fieldSchemaVersion;
  }
  if (shopIds.length) {
    where.push(`shop_id IN (${shopIds.map((_, index) => `@shop_id_${index}`).join(", ")})`);
    shopIds.forEach((id, index) => {
      params[`shop_id_${index}`] = id;
    });
  }
  const rows = getDb().prepare(`
    SELECT * FROM chihu_doudian_funds_data
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY synced_at DESC
  `).all(params);
  return rows.map((row) => ({
    shopId: row.shop_id,
    shopName: row.shop_name,
    group: row.group_name,
    status: row.store_status,
    syncStatus: row.sync_status,
    ok: !!row.ok,
    message: row.message,
    runId: row.run_id,
    adapterVersion: row.adapter_version,
    fieldSchemaVersion: row.field_schema_version,
    requestPlanHash: row.request_plan_hash,
    scriptsVersion: row.scripts_version,
    syncedAt: row.synced_at,
    datePreset: row.date_preset,
    beginDate: row.begin_date,
    endDate: row.end_date,
    row: parseJson(row.row_data, {}),
    diagnostic: parseJson(row.diagnostic, {})
  }));
}

function saveViolationsDataRows(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (!rows.length) return 0;
  const records = Array.isArray(input.records) ? input.records : [];
  const recordsByShop = new Map();
  for (const record of records) {
    const shopId = String(record?.shopId || "");
    if (!shopId) continue;
    if (!recordsByShop.has(shopId)) recordsByShop.set(shopId, []);
    recordsByShop.get(shopId).push(record);
  }
  const details = Array.isArray(input.details) ? input.details : [];
  const detailById = new Map(details.map((detail) => [String(detail.shopId || ""), detail]));
  const dateRange = input.dateRange || {};
  const datePreset = String(dateRange.datePreset || input.datePreset || "");
  const beginDate = String(dateRange.beginDate || input.beginDate || "");
  const endDate = String(dateRange.endDate || input.endDate || "");
  const syncedAt = input.syncedAt || nowIso();
  const adapterVersion = String(input.adapterVersion || "");
  const fieldSchemaVersion = String(input.fieldSchemaVersion || "");
  const requestPlanHash = String(input.requestPlanHash || "");
  const productLinkageVersion = String(input.productLinkageVersion || "");
  const statement = getDb().prepare(`
    INSERT INTO chihu_doudian_violations_data (
      shop_id, date_preset, begin_date, end_date, adapter_version, field_schema_version, request_plan_hash, product_linkage_version,
      run_id, shop_name, group_name,
      store_status, sync_status, ok, message, scripts_version, synced_at, row_data, records_data, diagnostic
    ) VALUES (
      @shop_id, @date_preset, @begin_date, @end_date, @adapter_version, @field_schema_version, @request_plan_hash, @product_linkage_version,
      @run_id, @shop_name, @group_name,
      @store_status, @sync_status, @ok, @message, @scripts_version, @synced_at, @row_data, @records_data, @diagnostic
    )
    ON CONFLICT(shop_id, date_preset, begin_date, end_date, adapter_version, field_schema_version, request_plan_hash, product_linkage_version) DO UPDATE SET
      run_id = excluded.run_id,
      shop_name = excluded.shop_name,
      group_name = excluded.group_name,
      store_status = excluded.store_status,
      sync_status = excluded.sync_status,
      ok = excluded.ok,
      message = excluded.message,
      scripts_version = excluded.scripts_version,
      synced_at = excluded.synced_at,
      row_data = excluded.row_data,
      records_data = excluded.records_data,
      diagnostic = excluded.diagnostic
  `);
  const recordStatement = getDb().prepare(`
    INSERT INTO chihu_doudian_violation_records (
      shop_id, violation_id, adapter_version, field_schema_version, request_plan_hash, product_linkage_version,
      run_id, shop_name, group_name, object_type, object_name, product_id, reason, severity, process_status,
      association_status, product_status, due_at, penalty_amount, action_suggestion, source_plan,
      synced_at, raw_data, diagnostic
    ) VALUES (
      @shop_id, @violation_id, @adapter_version, @field_schema_version, @request_plan_hash, @product_linkage_version,
      @run_id, @shop_name, @group_name, @object_type, @object_name, @product_id, @reason, @severity, @process_status,
      @association_status, @product_status, @due_at, @penalty_amount, @action_suggestion, @source_plan,
      @synced_at, @raw_data, @diagnostic
    )
    ON CONFLICT(shop_id, violation_id, adapter_version, field_schema_version, request_plan_hash, product_linkage_version) DO UPDATE SET
      run_id = excluded.run_id,
      shop_name = excluded.shop_name,
      group_name = excluded.group_name,
      object_type = excluded.object_type,
      object_name = excluded.object_name,
      product_id = excluded.product_id,
      reason = excluded.reason,
      severity = excluded.severity,
      process_status = excluded.process_status,
      association_status = excluded.association_status,
      product_status = excluded.product_status,
      due_at = excluded.due_at,
      penalty_amount = excluded.penalty_amount,
      action_suggestion = excluded.action_suggestion,
      source_plan = excluded.source_plan,
      synced_at = excluded.synced_at,
      raw_data = excluded.raw_data,
      diagnostic = excluded.diagnostic
  `);
  const failureStatement = getDb().prepare(`
    INSERT OR REPLACE INTO chihu_doudian_violation_failures (
      id, run_id, shop_id, violation_id, product_id, phase, plan_key, action_key, status, message, diagnostic, created_at
    ) VALUES (
      @id, @run_id, @shop_id, @violation_id, @product_id, @phase, @plan_key, @action_key, @status, @message, @diagnostic, @created_at
    )
  `);
  const insertFailure = (failure = {}) => {
    const payload = {
      run_id: String(input.runId || ""),
      shop_id: String(failure.shopId || ""),
      violation_id: String(failure.violationId || ""),
      product_id: String(failure.productId || ""),
      phase: String(failure.phase || ""),
      plan_key: String(failure.planKey || ""),
      action_key: String(failure.actionKey || ""),
      status: String(failure.status || ""),
      message: String(failure.message || ""),
      diagnostic: stringifyJson(failure.diagnostic || {}),
      created_at: syncedAt
    };
    failureStatement.run({
      id: String(failure.id || stableFailureId(payload)),
      ...payload
    });
  };
  const transaction = getDb().transaction(() => {
    for (const row of rows) {
      const shopId = String(row.shopId || "");
      if (!shopId) continue;
      const detail = detailById.get(shopId) || {};
      statement.run({
        shop_id: shopId,
        date_preset: datePreset,
        begin_date: beginDate,
        end_date: endDate,
        adapter_version: adapterVersion,
        field_schema_version: fieldSchemaVersion,
        request_plan_hash: requestPlanHash,
        product_linkage_version: productLinkageVersion,
        run_id: String(input.runId || ""),
        shop_name: String(row.shopName || detail.shopName || ""),
        group_name: String(row.group || row.groupName || ""),
        store_status: String(row.status || "unknown"),
        sync_status: String(detail.status || (detail.ok === true ? "ok" : "failed")),
        ok: detail.ok === false ? 0 : 1,
        message: String(detail.message || ""),
        scripts_version: String(input.scriptsVersion || ""),
        synced_at: syncedAt,
        row_data: stringifyJson(row),
        records_data: stringifyJson(recordsByShop.get(shopId) || []),
        diagnostic: stringifyJson(detail.diagnostic || {})
      });
    }
    records.forEach((record, index) => {
      const shopId = String(record?.shopId || "");
      if (!shopId) return;
      const violationId = String(record.id || `${shopId}:violation:${index + 1}`);
      const diagnostic = {
        associationStatus: String(record.associationStatus || ""),
        failureReason: String(record.failureReason || "")
      };
      recordStatement.run({
        shop_id: shopId,
        violation_id: violationId,
        adapter_version: adapterVersion,
        field_schema_version: fieldSchemaVersion,
        request_plan_hash: requestPlanHash,
        product_linkage_version: productLinkageVersion,
        run_id: String(input.runId || ""),
        shop_name: String(record.shopName || ""),
        group_name: String(record.group || record.groupName || ""),
        object_type: String(record.objectType || ""),
        object_name: String(record.objectName || ""),
        product_id: String(record.productId || ""),
        reason: String(record.reason || ""),
        severity: String(record.severity || ""),
        process_status: String(record.processStatus || ""),
        association_status: String(record.associationStatus || "not_checked"),
        product_status: String(record.productStatus || ""),
        due_at: String(record.dueAt || ""),
        penalty_amount: Number.isFinite(Number(record.penaltyAmount)) ? Number(record.penaltyAmount) : 0,
        action_suggestion: String(record.action || record.actionSuggestion || ""),
        source_plan: String(record.sourcePlan || record.source || "violationPenaltyList"),
        synced_at: syncedAt,
        raw_data: stringifyJson(record),
        diagnostic: stringifyJson(diagnostic)
      });
      if (record.failureReason) {
        insertFailure({
          shopId,
          violationId,
          productId: record.productId,
          phase: "record",
          planKey: record.sourcePlan || record.source || "violationPenaltyList",
          actionKey: "extractViolationRecords",
          status: "failed",
          message: record.failureReason,
          diagnostic: record
        });
      }
    });
    for (const detail of details) {
      const shopId = String(detail?.shopId || "");
      if (!shopId) continue;
      const diagnostic = detail?.diagnostic && typeof detail.diagnostic === "object" ? detail.diagnostic : {};
      const sourceFailures = Array.isArray(diagnostic.sourceFailures) ? diagnostic.sourceFailures : [];
      if (detail.ok === false && !sourceFailures.length) {
        insertFailure({
          shopId,
          phase: "store",
          actionKey: "fetchViolationsData",
          status: String(detail.status || "failed"),
          message: detail.message || "",
          diagnostic
        });
      }
      sourceFailures.forEach((failure, index) => {
        insertFailure({
          shopId,
          productId: failure?.productId || "",
          phase: failure?.phase || (failure?.optional ? "optional_source" : "source"),
          planKey: failure?.key || failure?.planKey || "",
          actionKey: "fetchViolationsData",
          status: failure?.status ? `HTTP ${failure.status}` : String(detail.status || "failed"),
          message: failure?.message || detail.message || "",
          diagnostic: {
            ...failure,
            detailReason: detail.reason || "",
            sourceFailureIndex: index
          }
        });
      });
    }
  });
  transaction();
  return rows.length;
}

function saveStaleGoodsScanSnapshot(input = {}) {
  const runId = String(input.runId || "");
  if (!runId) return { saved: 0, candidateSnapshotIds: [] };
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const products = Array.isArray(input.products) ? input.products : [];
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const details = Array.isArray(input.details) ? input.details : [];
  const syncedAt = input.syncedAt || nowIso();
  const candidateSnapshotIds = [];

  const runStatement = getDb().prepare(`
    INSERT INTO chihu_stale_goods_scan_runs (
      run_id, schema_version, adapter_version, field_schema_version, request_plan_hash, mode, status,
      started_at, finished_at, store_count, product_count, remote_total, candidate_count, summary, rules, detail
    ) VALUES (
      @run_id, @schema_version, @adapter_version, @field_schema_version, @request_plan_hash, @mode, @status,
      @started_at, @finished_at, @store_count, @product_count, @remote_total, @candidate_count, @summary, @rules, @detail
    )
    ON CONFLICT(run_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      adapter_version = excluded.adapter_version,
      field_schema_version = excluded.field_schema_version,
      request_plan_hash = excluded.request_plan_hash,
      mode = excluded.mode,
      status = excluded.status,
      finished_at = excluded.finished_at,
      store_count = excluded.store_count,
      product_count = excluded.product_count,
      remote_total = excluded.remote_total,
      candidate_count = excluded.candidate_count,
      summary = excluded.summary,
      rules = excluded.rules,
      detail = excluded.detail
  `);
  const sourceStatement = getDb().prepare(`
    INSERT OR REPLACE INTO chihu_stale_goods_source_pages (
      id, run_id, shop_id, shop_name, source_key, status, http_status, code, optional, diagnostic_only,
      message, pagination, response_shape, created_at
    ) VALUES (
      @id, @run_id, @shop_id, @shop_name, @source_key, @status, @http_status, @code, @optional, @diagnostic_only,
      @message, @pagination, @response_shape, @created_at
    )
  `);
  const productStatement = getDb().prepare(`
    INSERT OR REPLACE INTO chihu_stale_goods_products (
      run_id, shop_id, product_id, shop_name, title, status, created_at_value, listed_at_value,
      created_at_source, listed_at_source, age_date_value, age_date_source, age_date_type,
      days_since_age, days_since_created, days_since_listed, created_at_missing, listed_at_missing,
      price, stock, total_sales, period_sales, exposure_count, click_count, row_data, created_at
    ) VALUES (
      @run_id, @shop_id, @product_id, @shop_name, @title, @status, @created_at_value, @listed_at_value,
      @created_at_source, @listed_at_source, @age_date_value, @age_date_source, @age_date_type,
      @days_since_age, @days_since_created, @days_since_listed, @created_at_missing, @listed_at_missing,
      @price, @stock, @total_sales, @period_sales, @exposure_count, @click_count, @row_data, @created_at
    )
  `);
  const candidateStatement = getDb().prepare(`
    INSERT OR REPLACE INTO chihu_stale_goods_candidates (
      candidate_id, run_id, shop_id, product_id, shop_name, title, action, risk, risk_score,
      reasons, row_data, created_at
    ) VALUES (
      @candidate_id, @run_id, @shop_id, @product_id, @shop_name, @title, @action, @risk, @risk_score,
      @reasons, @row_data, @created_at
    )
  `);

  getDb().transaction(() => {
    runStatement.run({
      run_id: runId,
      schema_version: String(input.schemaVersion || "stale_goods.v2"),
      adapter_version: String(input.adapterVersion || ""),
      field_schema_version: String(input.fieldSchemaVersion || ""),
      request_plan_hash: String(input.requestPlanHash || ""),
      mode: String(input.mode || "scan"),
      status: String(input.status || ""),
      started_at: String(input.startedAt || ""),
      finished_at: String(input.finishedAt || syncedAt),
      store_count: Number(input.storeCount ?? rows.length ?? 0),
      product_count: Number(input.scanSummary?.productCount || products.length || 0),
      remote_total: Number(input.scanSummary?.remoteTotal || 0),
      candidate_count: Number(input.scanSummary?.candidateCount || candidates.length || 0),
      summary: stringifyJson(input.scanSummary || input.summary || {}),
      rules: stringifyJson(input.rules || {}),
      detail: stringifyJson({ rows, details })
    });

    for (const detail of details) {
      const diagnostic = detail?.diagnostic || {};
      for (const source of diagnostic.sourceHealth || []) {
        const sourceKey = String(source.key || "");
        sourceStatement.run({
          id: stableStaleGoodsSourcePageId([runId, detail.shopId || "", sourceKey]),
          run_id: runId,
          shop_id: String(detail.shopId || ""),
          shop_name: String(detail.shopName || ""),
          source_key: sourceKey,
          status: String(source.status || ""),
          http_status: Number(source.httpStatus || 0),
          code: source.code == null ? "" : String(source.code),
          optional: source.optional ? 1 : 0,
          diagnostic_only: source.diagnosticOnly ? 1 : 0,
          message: String(source.message || ""),
          pagination: stringifyJson(source.pagination || {}),
          response_shape: stringifyJson(diagnostic.responseShape || {}),
          created_at: syncedAt
        });
      }
    }

    for (const product of products) {
      productStatement.run({
        run_id: runId,
        shop_id: String(product.shopId || ""),
        product_id: String(product.productId || ""),
        shop_name: String(product.shopName || ""),
        title: String(product.title || ""),
        status: String(product.status || ""),
        created_at_value: String(product.createdAt || ""),
        listed_at_value: String(product.listedAt || ""),
        created_at_source: String(product.createdAtSource || ""),
        listed_at_source: String(product.listedAtSource || ""),
        age_date_value: String(product.ageDate || ""),
        age_date_source: String(product.ageDateSource || ""),
        age_date_type: String(product.ageDateType || ""),
        days_since_age: Number(product.daysSinceAge ?? -1),
        days_since_created: Number(product.daysSinceCreated ?? -1),
        days_since_listed: Number(product.daysSinceListed ?? -1),
        created_at_missing: product.createdAtMissing ? 1 : 0,
        listed_at_missing: product.listedAtMissing ? 1 : 0,
        price: Number(product.price || 0),
        stock: Number(product.stock || 0),
        total_sales: Number(product.totalSales || 0),
        period_sales: Number(product.periodSales || 0),
        exposure_count: Number(product.exposureCount || 0),
        click_count: Number(product.clickCount || 0),
        row_data: stringifyJson(product),
        created_at: syncedAt
      });
    }

    for (const candidate of candidates) {
      const candidateId = stableStaleGoodsCandidateId(runId, candidate);
      candidateSnapshotIds.push(candidateId);
      candidateStatement.run({
        candidate_id: candidateId,
        run_id: runId,
        shop_id: String(candidate.shopId || ""),
        product_id: String(candidate.productId || ""),
        shop_name: String(candidate.shopName || ""),
        title: String(candidate.title || ""),
        action: String(candidate.action || ""),
        risk: String(candidate.risk || ""),
        risk_score: Number(candidate.riskScore || 0),
        reasons: stringifyJson(Array.isArray(candidate.reasons) ? candidate.reasons : []),
        row_data: stringifyJson({ ...candidate, candidateId }),
        created_at: syncedAt
      });
    }
  })();

  return { saved: products.length + candidates.length + details.length + 1, candidateSnapshotIds };
}

function listStaleGoodsCandidatesByRun(runId) {
  const id = String(runId || "");
  if (!id) return [];
  return getDb().prepare(`
    SELECT * FROM chihu_stale_goods_candidates
    WHERE run_id = ?
    ORDER BY created_at DESC
  `).all(id).map((row) => ({
    candidateId: row.candidate_id,
    runId: row.run_id,
    shopId: row.shop_id,
    productId: row.product_id,
    row: parseJson(row.row_data, {})
  }));
}

function saveStaleGoodsExecuteSnapshot(input = {}) {
  const executeRunId = String(input.executeRunId || input.runId || generateId("stale_exec"));
  const executions = Array.isArray(input.executions) ? input.executions : [];
  const createdAt = input.createdAt || nowIso();
  const runStatement = getDb().prepare(`
    INSERT OR REPLACE INTO chihu_stale_goods_execute_runs (
      execute_run_id, source_run_id, action, confirm_text, status, dry_run, item_count, summary, created_at
    ) VALUES (
      @execute_run_id, @source_run_id, @action, @confirm_text, @status, @dry_run, @item_count, @summary, @created_at
    )
  `);
  const itemStatement = getDb().prepare(`
    INSERT OR REPLACE INTO chihu_stale_goods_execute_items (
      id, execute_run_id, source_run_id, candidate_id, shop_id, product_id, action, status, ok,
      message, plan_key, row_data, created_at
    ) VALUES (
      @id, @execute_run_id, @source_run_id, @candidate_id, @shop_id, @product_id, @action, @status, @ok,
      @message, @plan_key, @row_data, @created_at
    )
  `);
  getDb().transaction(() => {
    runStatement.run({
      execute_run_id: executeRunId,
      source_run_id: String(input.sourceRunId || ""),
      action: String(input.action || ""),
      confirm_text: String(input.confirmText || ""),
      status: String(input.status || ""),
      dry_run: input.dryRun === false ? 0 : 1,
      item_count: executions.length,
      summary: stringifyJson(input.summary || {}),
      created_at: createdAt
    });
    for (const item of executions) {
      itemStatement.run({
        id: stableStaleGoodsExecuteItemId(executeRunId, item),
        execute_run_id: executeRunId,
        source_run_id: String(input.sourceRunId || ""),
        candidate_id: String(item.candidateId || item.id || ""),
        shop_id: String(item.shopId || ""),
        product_id: String(item.productId || ""),
        action: String(item.action || input.action || ""),
        status: String(item.status || ""),
        ok: item.ok ? 1 : 0,
        message: String(item.message || ""),
        plan_key: String(item.planKey || ""),
        row_data: stringifyJson(item),
        created_at: createdAt
      });
    }
  })();
  return { executeRunId, saved: executions.length };
}

function listViolationsDataRows(input = {}) {
  const datePreset = String(input.datePreset || "");
  const beginDate = String(input.beginDate || "");
  const endDate = String(input.endDate || "");
  const adapterVersion = String(input.adapterVersion || "");
  const fieldSchemaVersion = String(input.fieldSchemaVersion || "");
  const requestPlanHash = String(input.requestPlanHash || "");
  const productLinkageVersion = String(input.productLinkageVersion || "");
  const shopIds = Array.isArray(input.shopIds) ? input.shopIds.map((id) => String(id)).filter(Boolean) : [];
  const where = [];
  const params = {};
  if (datePreset) {
    where.push("date_preset = @date_preset");
    params.date_preset = datePreset;
  }
  if (beginDate) {
    where.push("begin_date = @begin_date");
    params.begin_date = beginDate;
  }
  if (endDate) {
    where.push("end_date = @end_date");
    params.end_date = endDate;
  }
  if (adapterVersion) {
    where.push("adapter_version = @adapter_version");
    params.adapter_version = adapterVersion;
  }
  if (fieldSchemaVersion) {
    where.push("field_schema_version = @field_schema_version");
    params.field_schema_version = fieldSchemaVersion;
  }
  if (requestPlanHash) {
    where.push("request_plan_hash = @request_plan_hash");
    params.request_plan_hash = requestPlanHash;
  }
  if (productLinkageVersion) {
    where.push("product_linkage_version = @product_linkage_version");
    params.product_linkage_version = productLinkageVersion;
  }
  if (shopIds.length) {
    where.push(`shop_id IN (${shopIds.map((_, index) => `@shop_id_${index}`).join(", ")})`);
    shopIds.forEach((id, index) => {
      params[`shop_id_${index}`] = id;
    });
  }
  const rows = getDb().prepare(`
    SELECT * FROM chihu_doudian_violations_data
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY synced_at DESC
  `).all(params);
  return rows.map((row) => ({
    shopId: row.shop_id,
    shopName: row.shop_name,
    group: row.group_name,
    status: row.store_status,
    syncStatus: row.sync_status,
    ok: !!row.ok,
    message: row.message,
    runId: row.run_id,
    adapterVersion: row.adapter_version,
    fieldSchemaVersion: row.field_schema_version,
    requestPlanHash: row.request_plan_hash,
    productLinkageVersion: row.product_linkage_version,
    scriptsVersion: row.scripts_version,
    syncedAt: row.synced_at,
    datePreset: row.date_preset,
    beginDate: row.begin_date,
    endDate: row.end_date,
    row: parseJson(row.row_data, {}),
    records: parseJson(row.records_data, []),
    diagnostic: parseJson(row.diagnostic, {})
  }));
}

module.exports = {
  configurePolicy,
  createGroup,
  createRun,
  deleteStores,
  deleteEmptyGroup,
  finishRun,
  getRun,
  listBusinessDataRows,
  listFundsDataRows,
  listViolationsDataRows,
  listGroups,
  listStores,
  recordAttempt,
  saveBusinessDataRows,
  saveFundsDataRows,
  saveStaleGoodsExecuteSnapshot,
  saveStaleGoodsScanSnapshot,
  saveViolationsDataRows,
  listStaleGoodsCandidatesByRun,
  replaceStores,
  renameGroup,
  updateStoreGroup,
  updateStores,
  upsertStores
};
