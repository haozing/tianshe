CREATE TABLE IF NOT EXISTS runtime_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS native_records (
  store_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_name, record_id)
);

CREATE TABLE IF NOT EXISTS doudian_store_groups (
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, group_id)
);

CREATE TABLE IF NOT EXISTS doudian_store_identities (
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  platform TEXT NOT NULL CHECK (platform = 'doudian'),
  identity_contract_version TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'tombstoned')),
  namespace_json TEXT NOT NULL DEFAULT '{}',
  tombstoned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, shop_id, generation)
);

CREATE TABLE IF NOT EXISTS doudian_stores (
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  platform TEXT NOT NULL CHECK (platform = 'doudian'),
  shop_name TEXT NOT NULL,
  partition TEXT,
  group_id TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, shop_id, generation),
  FOREIGN KEY (tenant_id, shop_id, generation)
    REFERENCES doudian_store_identities (tenant_id, shop_id, generation)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS catalog_jobs (
  job_id TEXT PRIMARY KEY,
  active_coverage_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'doudian'),
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  store_generation INTEGER NOT NULL CHECK (store_generation > 0),
  profile TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  read_requirement_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL DEFAULT '',
  job_generation INTEGER NOT NULL CHECK (job_generation > 0),
  owner_epoch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'finished', 'failed', 'cancelled', 'abandoned', 'superseded')),
  progress_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  heartbeat_at TEXT,
  superseded_by TEXT,
  FOREIGN KEY (tenant_id, shop_id, store_generation)
    REFERENCES doudian_store_identities (tenant_id, shop_id, generation)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (superseded_by) REFERENCES catalog_jobs (job_id)
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS catalog_runs (
  run_id TEXT PRIMARY KEY,
  job_id TEXT,
  operation_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'doudian'),
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  store_generation INTEGER NOT NULL CHECK (store_generation > 0),
  job_generation INTEGER NOT NULL CHECK (job_generation > 0),
  owner_epoch TEXT NOT NULL,
  query_kind TEXT NOT NULL CHECK (query_kind IN ('range', 'filtered', 'targeted', 'count-only')),
  profile TEXT NOT NULL,
  normalized_scope_json TEXT NOT NULL DEFAULT '{}',
  coverage_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'exhausted', 'partial', 'failed', 'cancelled', 'abandoned', 'superseded')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  business_date TEXT NOT NULL,
  first_remote_total INTEGER,
  last_remote_total INTEGER,
  fetched_row_count INTEGER NOT NULL DEFAULT 0 CHECK (fetched_row_count >= 0),
  unique_product_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_product_count >= 0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  invalid_row_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_row_count >= 0),
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  segment_count INTEGER NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
  remote_total_drift INTEGER,
  min_sort_anchor TEXT,
  max_sort_anchor TEXT,
  termination_reason TEXT NOT NULL DEFAULT 'unknown',
  required_fields_json TEXT NOT NULL DEFAULT '[]',
  projection_contract_hash TEXT NOT NULL DEFAULT '',
  missing_field_counts_json TEXT NOT NULL DEFAULT '{}',
  adapter_version TEXT NOT NULL DEFAULT '',
  catalog_contract_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES catalog_jobs (job_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, shop_id, store_generation)
    REFERENCES doudian_store_identities (tenant_id, shop_id, generation)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS catalog_pages (
  run_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL DEFAULT 0 CHECK (segment_index >= 0),
  page_no INTEGER NOT NULL CHECK (page_no >= 1),
  commit_token TEXT NOT NULL UNIQUE,
  transaction_id TEXT NOT NULL DEFAULT '',
  source_request_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL DEFAULT '',
  cursor TEXT,
  min_sort_anchor TEXT,
  max_sort_anchor TEXT,
  remote_total INTEGER,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  invalid_row_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_row_count >= 0),
  elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
  status TEXT NOT NULL DEFAULT 'committed',
  result_json TEXT NOT NULL DEFAULT '{}',
  committed_count INTEGER NOT NULL DEFAULT 0 CHECK (committed_count >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, segment_index, page_no),
  FOREIGN KEY (run_id) REFERENCES catalog_runs (run_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS catalog_product_versions (
  version_id TEXT PRIMARY KEY,
  product_key TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'doudian'),
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  store_generation INTEGER NOT NULL CHECK (store_generation > 0),
  product_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT,
  image_url TEXT,
  category_id TEXT,
  category_name TEXT,
  lifecycle_status TEXT,
  platform_status_raw TEXT,
  check_status_raw TEXT,
  price_min_minor TEXT,
  price_max_minor TEXT,
  currency TEXT,
  stock INTEGER,
  total_sales INTEGER,
  created_at_platform TEXT,
  audit_time_epoch INTEGER,
  listed_at TEXT,
  offline_at TEXT,
  platform_updated_at TEXT,
  facts_json TEXT NOT NULL DEFAULT '{}',
  field_state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (product_key, content_hash),
  FOREIGN KEY (tenant_id, shop_id, store_generation)
    REFERENCES doudian_store_identities (tenant_id, shop_id, generation)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS catalog_observations (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  version_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'doudian'),
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  store_generation INTEGER NOT NULL CHECK (store_generation > 0),
  product_id TEXT NOT NULL,
  source_profile TEXT NOT NULL,
  source_request_key TEXT NOT NULL,
  segment_index INTEGER NOT NULL DEFAULT 0 CHECK (segment_index >= 0),
  page_index INTEGER NOT NULL CHECK (page_index >= 1),
  occurrence_index INTEGER NOT NULL DEFAULT 0 CHECK (occurrence_index >= 0),
  request_started_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  catalog_contract_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES catalog_runs (run_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES catalog_product_versions (version_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, shop_id, store_generation)
    REFERENCES doudian_store_identities (tenant_id, shop_id, generation)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS catalog_run_members (
  run_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  winner_reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, product_key),
  FOREIGN KEY (run_id) REFERENCES catalog_runs (run_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (observation_id) REFERENCES catalog_observations (observation_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES catalog_product_versions (version_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS catalog_latest (
  product_key TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform = 'doudian'),
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  store_generation INTEGER NOT NULL CHECK (store_generation > 0),
  product_id TEXT NOT NULL,
  latest_observation_id TEXT NOT NULL,
  latest_observed_product_version_id TEXT NOT NULL,
  lifecycle_status TEXT,
  listed_at TEXT,
  merged_fields_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (latest_observation_id) REFERENCES catalog_observations (observation_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (latest_observed_product_version_id) REFERENCES catalog_product_versions (version_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, shop_id, store_generation)
    REFERENCES doudian_store_identities (tenant_id, shop_id, generation)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS catalog_latest_fields (
  product_key TEXT NOT NULL,
  field_name TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  field_state TEXT NOT NULL CHECK (field_state IN ('present', 'cleared', 'inferred')),
  observed_at TEXT NOT NULL,
  source_profile TEXT NOT NULL,
  PRIMARY KEY (product_key, field_name),
  FOREIGN KEY (product_key) REFERENCES catalog_latest (product_key)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (observation_id) REFERENCES catalog_observations (observation_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (version_id) REFERENCES catalog_product_versions (version_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS catalog_heads (
  coverage_key TEXT PRIMARY KEY,
  job_generation INTEGER NOT NULL CHECK (job_generation > 0),
  exhausted_run_id TEXT,
  latest_partial_run_id TEXT,
  validity TEXT NOT NULL CHECK (validity IN ('valid', 'stale', 'deleted')),
  invalidated_at TEXT,
  invalidation_reason TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (exhausted_run_id) REFERENCES catalog_runs (run_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (latest_partial_run_id) REFERENCES catalog_runs (run_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS catalog_mutations (
  mutation_id TEXT PRIMARY KEY,
  mutation_key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform = 'doudian'),
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  store_generation INTEGER NOT NULL CHECK (store_generation > 0),
  product_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'sending', 'acknowledged', 'unknown', 'confirmed', 'confirm-timeout', 'conflict', 'failed', 'cancelled', 'skipped')),
  request_hash TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  lookup_observation_id TEXT,
  confirm_observation_id TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  acknowledged_at TEXT,
  confirmed_at TEXT,
  FOREIGN KEY (tenant_id, shop_id, store_generation)
    REFERENCES doudian_store_identities (tenant_id, shop_id, generation)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (lookup_observation_id) REFERENCES catalog_observations (observation_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (confirm_observation_id) REFERENCES catalog_observations (observation_id)
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS feature_catalog_run_refs (
  feature_type TEXT NOT NULL,
  feature_run_id TEXT NOT NULL,
  catalog_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (feature_type, feature_run_id, catalog_run_id),
  FOREIGN KEY (catalog_run_id) REFERENCES catalog_runs (run_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS feature_catalog_observation_refs (
  feature_type TEXT NOT NULL,
  feature_run_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (feature_type, feature_run_id, observation_id),
  FOREIGN KEY (observation_id) REFERENCES catalog_observations (observation_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS feature_catalog_version_refs (
  feature_type TEXT NOT NULL,
  feature_run_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (feature_type, feature_run_id, version_id),
  FOREIGN KEY (version_id) REFERENCES catalog_product_versions (version_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS business_latest (
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, shop_id, generation),
  FOREIGN KEY (tenant_id, shop_id, generation)
    REFERENCES doudian_store_identities (tenant_id, shop_id, generation)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS funds_latest (
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, shop_id, generation),
  FOREIGN KEY (tenant_id, shop_id, generation)
    REFERENCES doudian_store_identities (tenant_id, shop_id, generation)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS violations_latest (
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, shop_id, generation),
  FOREIGN KEY (tenant_id, shop_id, generation)
    REFERENCES doudian_store_identities (tenant_id, shop_id, generation)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS stale_scan_runs_v2 (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stale_candidates_v2 (
  candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES stale_scan_runs_v2 (run_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stale_execute_runs_v2 (
  run_id TEXT PRIMARY KEY,
  source_scan_run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_scan_run_id) REFERENCES stale_scan_runs_v2 (run_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS bulk_delete_scan_runs_v2 (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bulk_delete_candidates_v2 (
  candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES bulk_delete_scan_runs_v2 (run_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bulk_delete_executions_v2 (
  execution_id TEXT PRIMARY KEY,
  source_scan_run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_scan_run_id) REFERENCES bulk_delete_scan_runs_v2 (run_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS bulk_delete_operation_events_v2 (
  event_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES bulk_delete_executions_v2 (execution_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS opportunity_clue_runs_v2 (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunity_clue_candidates_v2 (
  candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  clue_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES opportunity_clue_runs_v2 (run_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS opportunity_product_runs_v2 (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunity_product_candidates_v2 (
  candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES opportunity_product_runs_v2 (run_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS opportunity_prematch_runs_v2 (
  run_id TEXT PRIMARY KEY,
  product_run_id TEXT NOT NULL,
  clue_run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_run_id) REFERENCES opportunity_product_runs_v2 (run_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (clue_run_id) REFERENCES opportunity_clue_runs_v2 (run_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS opportunity_prematch_candidates_v2 (
  candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  clue_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES opportunity_prematch_runs_v2 (run_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS opportunity_execute_runs_v2 (
  run_id TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunity_submit_attempts_v2 (
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
  status TEXT NOT NULL CHECK (status IN ('prepared', 'sending', 'accepted', 'rejected', 'unknown', 'confirmed', 'failed', 'cancelled')),
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

CREATE INDEX IF NOT EXISTS idx_catalog_runs_coverage_finished
  ON catalog_runs (coverage_key, status, finished_at DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_runs_shop_started
  ON catalog_runs (tenant_id, shop_id, store_generation, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_observations_product_time
  ON catalog_observations (product_key, request_started_at DESC, observation_id);

CREATE INDEX IF NOT EXISTS idx_catalog_members_run
  ON catalog_run_members (run_id, product_key);

CREATE INDEX IF NOT EXISTS idx_catalog_latest_shop_status
  ON catalog_latest (tenant_id, shop_id, store_generation, lifecycle_status, product_key);

CREATE INDEX IF NOT EXISTS idx_catalog_latest_shop_listed
  ON catalog_latest (tenant_id, shop_id, store_generation, listed_at, product_key);

CREATE INDEX IF NOT EXISTS idx_catalog_mutations_status
  ON catalog_mutations (status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_jobs_active
  ON catalog_jobs (active_coverage_key)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_catalog_jobs_history
  ON catalog_jobs (active_coverage_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_pages_commit_token
  ON catalog_pages (commit_token);

CREATE INDEX IF NOT EXISTS idx_opportunity_attempts_status
  ON opportunity_submit_attempts_v2 (status, created_at);

CREATE INDEX IF NOT EXISTS idx_native_records_store_updated
  ON native_records (store_name, updated_at DESC, record_id);
