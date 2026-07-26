const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const SCHEMA_PATH = path.join(__dirname, "schema-v1.sql");

const EXPECTED_TABLES = [
  "runtime_meta",
  "native_records",
  "doudian_store_groups",
  "doudian_store_identities",
  "doudian_stores",
  "catalog_jobs",
  "catalog_runs",
  "catalog_pages",
  "catalog_product_versions",
  "catalog_observations",
  "catalog_run_members",
  "catalog_latest",
  "catalog_latest_fields",
  "catalog_heads",
  "catalog_mutations",
  "feature_catalog_run_refs",
  "feature_catalog_observation_refs",
  "feature_catalog_version_refs",
  "business_latest",
  "funds_latest",
  "violations_latest",
  "operations",
  "stale_scan_runs_v2",
  "stale_candidates_v2",
  "stale_execute_runs_v2",
  "bulk_delete_scan_runs_v2",
  "bulk_delete_candidates_v2",
  "bulk_delete_executions_v2",
  "bulk_delete_operation_events_v2",
  "opportunity_clue_runs_v2",
  "opportunity_clue_candidates_v2",
  "opportunity_product_runs_v2",
  "opportunity_product_candidates_v2",
  "opportunity_prematch_runs_v2",
  "opportunity_prematch_candidates_v2",
  "opportunity_execute_runs_v2",
  "opportunity_submit_attempts_v2",
  "opportunity_submit_request_attempts_v1"
];

function loadSchemaSql() {
  return fs.readFileSync(SCHEMA_PATH, "utf8");
}

module.exports = {
  EXPECTED_TABLES,
  SCHEMA_PATH,
  SCHEMA_VERSION,
  loadSchemaSql
};
