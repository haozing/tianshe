export type ProductCatalogPlatform = "doudian";
export type ProductCatalogQueryKind = "range" | "filtered" | "targeted" | "count-only";
export type ProductCatalogCoverageStatus = "running" | "exhausted" | "partial" | "failed" | "cancelled" | "abandoned" | "superseded";
export type ProductCatalogFreshness = "same-business-day" | "live" | { maxAgeMs: number };
export type ProductCatalogCompleteness = "prefer-exhausted" | "allow-partial" | "force-refresh";

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  [key: string]: unknown;
}

export interface ProductCatalogScopeV2 {
  lifecycleStatuses?: string[];
  checkStatuses?: string[];
  timeRange?: {
    field: string;
    startInclusive?: string;
    endExclusive?: string;
  };
  keyword?: string;
  categoryIds?: string[];
  productIds?: string[];
  productTab?: string;
  sort?: Array<{ field: string; direction: "asc" | "desc" }>;
}

export interface ProductCatalogReadRequirementV1 {
  requiredFields?: string[];
  projectionContractHash?: string;
  allowMissingFields?: boolean;
  [key: string]: unknown;
}

export interface NativeDataQuickCheckResult {
  ok: boolean;
  quickCheck: string[];
  foreignKeyViolations: unknown[];
}

export interface NativeDataHealthResult {
  ok: boolean;
  schemaVersion: number;
  userVersion: number;
  databasePath: string;
  openedAt: string;
  sqliteVersion: string;
  nodeVersion: string;
  electronVersion: string;
  journalMode: string;
  foreignKeys: number;
  busyTimeout: number;
  walAutoCheckpoint: number;
  tableCount: number;
  expectedTableCount: number;
  missingTables: string[];
  quickCheck: NativeDataQuickCheckResult;
  sizeBytes: number;
  walSizeBytes: number;
  shmSizeBytes: number;
}

export interface NativeDataRecoverOpenJobsResult {
  ok: boolean;
  abandonedJobs: number;
  abandonedRuns: number;
  reason: string;
  recoveredAt: string;
}

export interface NativeDataBackupResult {
  ok: boolean;
  backupPath: string;
  reason: string;
  createdAt: string;
  sizeBytes: number;
}

export type NativeDataRecordStoreName =
  | "stores"
  | "groups"
  | "business_latest"
  | "funds_latest"
  | "violations_latest"
  | "stale_scan_runs"
  | "stale_candidates"
  | "stale_execute_runs"
  | "bulk_delete_scan_runs_v1"
  | "bulk_delete_candidates_v1"
  | "bulk_delete_execute_runs_v1"
  | "bulk_delete_operation_events_v1"
  | "opportunity_clue_scan_runs_v1"
  | "opportunity_clue_candidates_v1"
  | "opportunity_product_scan_runs_v1"
  | "opportunity_product_candidates_v1"
  | "opportunity_prematch_runs_v1"
  | "opportunity_prematch_candidates_v1"
  | "opportunity_execute_runs_v1"
  | "opportunity_submit_attempts_v1"
  | "opportunity_pipeline_runs_v2"
  | "opportunity_pipeline_store_runs_v2"
  | "opportunity_store_category_snapshots_v2"
  | "opportunity_store_category_ledger_v2"
  | "opportunity_clue_cache_v2"
  | "opportunity_clue_cache_shards_v2"
  | "opportunity_clue_word_cache_v2"
  | "opportunity_clue_word_cache_shards_v2"
  | "opportunity_pipeline_candidates_v2"
  | "opportunity_pipeline_submit_tasks_v2"
  | "opportunity_pipeline_operation_events_v2"
  | "operations"
  | "runtime_meta";

export interface NativeDataRecordPutResult<T = Record<string, unknown>> {
  ok: boolean;
  storeName: NativeDataRecordStoreName;
  recordId: string;
  record?: T;
  payloadBytes?: number;
  largePayload?: boolean;
}

export interface NativeDataRecordPutManyResult<T = Record<string, unknown>> {
  ok: boolean;
  storeName: NativeDataRecordStoreName;
  count: number;
  records?: T[];
  payloadBytes?: number;
}

export interface NativeDataRecordDeleteResult {
  ok: boolean;
  storeName: NativeDataRecordStoreName;
  recordId: string;
  deleted: number;
  deletedAt: string;
  opportunityCleanup?: StoreOpportunityCleanupResult | null;
}

export interface NativeDataRecordDeleteManyResult {
  ok: boolean;
  storeName: NativeDataRecordStoreName;
  requested?: number;
  deleted: number;
  missing?: number;
  deletedAt: string;
}

export interface NativeDataOperationCleanupResult {
  ok: boolean;
  deleted: number;
  expired: number;
  overflow: number;
  cutoff: string;
  retentionDays: number;
  maxTerminalRecords: number;
}

export interface StoreIdentityArgs {
  platform?: ProductCatalogPlatform;
  tenantId: string;
  shopId: string;
  storeGeneration?: number;
  generation?: number;
  identityContractVersion?: string;
  namespace?: Record<string, unknown>;
}

export interface StoreIdentityResult {
  ok: boolean;
  platform: ProductCatalogPlatform;
  tenantId: string;
  shopId: string;
  storeGeneration: number;
  updatedAt: string;
}

export interface StoreTombstoneResult {
  ok: boolean;
  changed: number;
  cancelledJobs: number;
  cancelledRuns: number;
  deletedHeads: number;
  tenantId: string;
  shopId: string;
  storeGeneration: number;
  nextGeneration: number;
  tombstonedAt: string;
  opportunityCleanup?: StoreOpportunityCleanupResult;
}

export interface StoreOpportunityCleanupResult {
  cancelledStoreRuns: number;
  cancelledSubmitTasks: number;
  cancelledCandidates: number;
  unknownCandidates: number;
  deletedCategoryRecords: number;
  deletedCacheRecords: number;
  finalizedPipelineRuns: number;
  finalizedOperations: number;
}

export interface ProductCatalogTaskArgs extends StoreIdentityArgs {
  shops?: Array<{ shopId: string; storeGeneration: number }>;
  operationId?: string;
  profile: string;
  queryKind?: ProductCatalogQueryKind;
  scope: ProductCatalogScopeV2;
  readRequirement?: ProductCatalogReadRequirementV1;
  freshness?: ProductCatalogFreshness;
  completeness?: ProductCatalogCompleteness;
  reason: string;
  coverageKey?: string;
  requiredFields?: string[];
  projectionContractHash?: string;
  adapterVersion?: string;
  catalogContractHash?: string;
  ensureStoreIdentity?: boolean;
}

export interface CatalogJobHandle {
  jobId: string;
  runId?: string;
  operationId: string;
  activeCoverageKey: string;
  platform: ProductCatalogPlatform;
  tenantId: string;
  shopId: string;
  storeGeneration: number;
  profile: string;
  scope: ProductCatalogScopeV2;
  readRequirement: ProductCatalogReadRequirementV1;
  jobGeneration: number;
  ownerEpoch: string;
  status: string;
  runStatus?: ProductCatalogCoverageStatus;
  progress: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  heartbeatAt?: string;
  reused?: boolean;
}

export interface CatalogJobState extends CatalogJobHandle {}

export interface CatalogPageCommitResult {
  ok: boolean;
  committedCount: number;
  transactionId: string;
  firstCommit: boolean;
  runId: string;
  segmentIndex: number;
  pageNo: number;
  [key: string]: unknown;
}

export interface ProductCatalogTaskResult {
  ok: boolean;
  jobId: string;
  runId: string;
  status: ProductCatalogCoverageStatus;
  jobStatus: string;
  headChanged: number;
  finishedAt: string;
}

export interface ProductCatalogPageProductV2 {
  productId: string;
  productKey?: string;
  observationId?: string;
  occurrenceIndex?: number;
  contentHash?: string;
  title?: string;
  imageUrl?: string;
  categoryId?: string;
  categoryName?: string;
  categoryPath?: string[];
  brandId?: string;
  brandName?: string;
  articleNumber?: string;
  lifecycleStatus?: string;
  platformStatusRaw?: string | number | null;
  checkStatusRaw?: string | number | null;
  priceMinMinor?: string;
  priceMaxMinor?: string;
  currency?: "CNY" | string;
  stock?: number;
  totalSales?: number;
  createdAt?: string;
  auditTimeEpoch?: number;
  listedAt?: string;
  offlineAt?: string;
  platformUpdatedAt?: string;
  fieldState?: Record<string, {
    state: "present" | "cleared" | "missing" | "invalid" | "inferred";
    sourcePath?: string;
    platformFieldUpdatedAt?: string;
  }>;
}

export interface CatalogReportPageArgs {
  jobId: string;
  runId?: string;
  jobGeneration: number;
  ownerEpoch: string;
  commitToken: string;
  products: ProductCatalogPageProductV2[];
  segmentIndex?: number;
  pageNo?: number;
  pageIndex?: number;
  sourceRequestKey?: string;
  requestStartedAt?: string;
  observedAt?: string;
  requestFingerprint?: string;
  cursor?: string;
  minSortAnchor?: string;
  maxSortAnchor?: string;
  remoteTotal?: number;
  invalidRowCount?: number;
  elapsedMs?: number;
  status?: string;
  result?: Record<string, unknown>;
}

export interface CatalogFinishArgs {
  jobId: string;
  runId?: string;
  jobGeneration: number;
  ownerEpoch: string;
  status?: Exclude<ProductCatalogCoverageStatus, "running">;
  coverageStatus?: Exclude<ProductCatalogCoverageStatus, "running">;
  terminationReason?: string;
}

export interface ProductCatalogRunMemberV2 {
  runId: string;
  productKey: string;
  observationId: string;
  productVersionId: string;
  winnerReason: string;
  productId?: string;
  lifecycleStatus?: string;
  listedAt?: string;
  mergedFields?: Record<string, unknown>;
}

export interface ProductCatalogLatestV2 {
  productKey: string;
  platform: ProductCatalogPlatform;
  tenantId: string;
  shopId: string;
  storeGeneration: number;
  productId: string;
  latestObservationId: string;
  latestObservedProductVersionId: string;
  lifecycleStatus?: string;
  listedAt?: string;
  mergedFields: Record<string, unknown>;
  updatedAt: string;
}

export interface CatalogPageQueryArgs {
  coverageKey: string;
  cursor?: string;
  limit?: number;
  allowPartial?: boolean;
}

export interface CatalogLatestQueryArgs extends StoreIdentityArgs {
  cursor?: string;
  limit?: number;
}

export interface CatalogProductsByIdsArgs extends StoreIdentityArgs {
  productIds: string[];
}

export interface CatalogRecordedObservation {
  productId: string;
  productKey: string;
  observationId: string;
  versionId: string;
  contentHash: string;
}

export interface CatalogRecordLiveObservationsArgs extends StoreIdentityArgs {
  profile?: string;
  purpose?: string;
  operationId?: string;
  sourceRequestKey?: string;
  requestStartedAt?: string;
  observedAt?: string;
  catalogContractHash?: string;
  adapterVersion?: string;
  products: ProductCatalogPageProductV2[];
  invalidateCoverageKeys?: string[];
  ensureStoreIdentity?: boolean;
}

export interface CatalogRecordLiveObservationsResult {
  ok: boolean;
  runId: string;
  committedCount: number;
  observations: CatalogRecordedObservation[];
  invalidated: number;
}

export type CatalogMutationStatus =
  | "prepared"
  | "sending"
  | "acknowledged"
  | "unknown"
  | "confirmed"
  | "confirm-timeout"
  | "conflict"
  | "failed"
  | "cancelled"
  | "skipped";

export interface CatalogMutationRecordInput {
  mutationId?: string;
  mutationKey: string;
  productId: string;
  productKey?: string;
  action: "offline" | "recycle" | "delete" | "edit-title" | string;
  status?: CatalogMutationStatus;
  requestHash?: string;
  idempotencyKey?: string;
  lookupObservationId?: string;
  result?: Record<string, unknown>;
  responseSummary?: Record<string, unknown>;
  sentAt?: string;
  acknowledgedAt?: string;
  confirmedAt?: string;
}

export interface CatalogRecordMutationResultsArgs extends StoreIdentityArgs {
  mutations: CatalogMutationRecordInput[];
  ensureStoreIdentity?: boolean;
}

export interface CatalogMutationResultItem {
  mutationKey: string;
  mutationId: string;
  productId?: string;
  status: CatalogMutationStatus;
  confirmObservationId?: string;
}

export interface CatalogRecordMutationResultsResult {
  ok: boolean;
  changed: number;
  mutations: CatalogMutationResultItem[];
}

export interface CatalogMutationConfirmationInput {
  mutationId?: string;
  mutationKey?: string;
  status?: CatalogMutationStatus;
  confirmed?: boolean;
  confirmObservationId?: string;
  observation?: ProductCatalogPageProductV2;
  product?: ProductCatalogPageProductV2;
  profile?: string;
  operationId?: string;
  sourceRequestKey?: string;
  requestStartedAt?: string;
  observedAt?: string;
  catalogContractHash?: string;
  result?: Record<string, unknown>;
  responseSummary?: Record<string, unknown>;
  sentAt?: string;
  acknowledgedAt?: string;
  confirmedAt?: string;
}

export interface CatalogConfirmMutationsArgs extends StoreIdentityArgs {
  confirmations: CatalogMutationConfirmationInput[];
  profile?: string;
  operationId?: string;
  catalogContractHash?: string;
  invalidateCoverageKeys?: string[];
}

export interface CatalogConfirmMutationsResult {
  ok: boolean;
  changed: number;
  confirmations: CatalogMutationResultItem[];
  invalidated: number;
}

export interface CatalogJobFenceArgs {
  jobId: string;
  jobGeneration?: number;
  ownerEpoch?: string;
}

export interface NativeDataApi {
  maintenance: {
    getHealth: () => Promise<NativeDataHealthResult>;
    quickCheck: () => Promise<NativeDataQuickCheckResult>;
    listTables: () => Promise<string[]>;
    createBackup: (args?: { reason?: string; backupDir?: string; backupPath?: string }) => Promise<NativeDataBackupResult>;
    recoverOpenJobs: (args?: { reason?: string }) => Promise<NativeDataRecoverOpenJobsResult>;
  };
  stores: {
    upsertIdentity: (args: StoreIdentityArgs) => Promise<StoreIdentityResult>;
    assertActiveIdentity?: (args: StoreIdentityArgs) => Promise<StoreIdentityResult>;
    tombstoneIdentity: (args: StoreIdentityArgs & { reason?: string }) => Promise<StoreTombstoneResult>;
  };
  records: {
    put: <T extends Record<string, unknown>>(args: { storeName: NativeDataRecordStoreName; record: T }) => Promise<NativeDataRecordPutResult<T>>;
    putMany?: <T extends Record<string, unknown>>(args: { storeName: NativeDataRecordStoreName; records: T[]; omitRecords?: boolean }) => Promise<NativeDataRecordPutManyResult<T>>;
    acquireOperation?: <T extends Record<string, unknown>>(args: { operation: T; updatedAfter: string }) => Promise<{ acquired: boolean; operation: T }>;
    claimOpportunitySubmitTask?: <T extends Record<string, unknown>>(args: { taskId: string; ownerRunId: string; leaseExpiresAt: string; now: string }) => Promise<{ claimed: boolean; reason: string; task: T | null }>;
    get: <T extends Record<string, unknown>>(args: { storeName: NativeDataRecordStoreName; id: string }) => Promise<T | null>;
    getMany?: <T extends Record<string, unknown>>(args: { storeName: NativeDataRecordStoreName; ids: string[] }) => Promise<T[]>;
    list: <T extends Record<string, unknown>>(args: { storeName: NativeDataRecordStoreName; cursor?: string; limit?: number }) => Promise<CursorPage<T>>;
    latest?: <T extends Record<string, unknown>>(args: { storeName: NativeDataRecordStoreName }) => Promise<T | null>;
    queryOperations?: <T extends Record<string, unknown>>(args: { statuses?: string[]; taskType?: string; updatedAfter?: string; limit?: number }) => Promise<T[]>;
    cleanupOperations?: (args: { retentionDays?: number; maxTerminalRecords?: number }) => Promise<NativeDataOperationCleanupResult>;
    delete: (args: { storeName: NativeDataRecordStoreName; id: string; reason?: string }) => Promise<NativeDataRecordDeleteResult>;
    deleteMany?: (args: { storeName: NativeDataRecordStoreName; ids: string[]; reason?: string }) => Promise<NativeDataRecordDeleteManyResult>;
  };
  opportunityAttempts?: {
    putMany: (args: { attempts: Array<Record<string, unknown>> }) => Promise<{ ok: boolean; count: number }>;
    count: (args: { businessDate: string; shopId?: string }) => Promise<{ businessDate: string; shopId?: string; count?: number; counts?: Record<string, number> }>;
    listDedupeKeys: () => Promise<{ relationKeys: string[]; clueKeys: string[]; clueCategoryKeys: string[] }>;
    findDedupeKeys: (args: { relationKeys?: string[]; clueKeys?: string[]; clueCategoryKeys?: string[] }) => Promise<{ relationKeys: string[]; clueKeys: string[]; clueCategoryKeys: string[] }>;
    cleanup: (args?: { failedRetentionDays?: number }) => Promise<{ ok: boolean; deleted: number; cutoff: string }>;
  };
  catalogJobs: {
    acquire: (args: ProductCatalogTaskArgs) => Promise<CatalogJobHandle>;
    reportPage: (args: CatalogReportPageArgs) => Promise<CatalogPageCommitResult>;
    finish: (args: CatalogFinishArgs) => Promise<ProductCatalogTaskResult>;
    cancel: (args: { jobId: string }) => Promise<{ ok: boolean; changed: number }>;
    get: (args: { jobId: string }) => Promise<CatalogJobState | null>;
    heartbeat: (args: CatalogJobFenceArgs) => Promise<{ ok: boolean; heartbeatAt: string }>;
  };
  catalog: {
    queryHeadMembersPage: (args: CatalogPageQueryArgs) => Promise<CursorPage<ProductCatalogRunMemberV2>>;
    queryLastObservedPage: (args: CatalogLatestQueryArgs) => Promise<CursorPage<ProductCatalogLatestV2>>;
    getProductsByIds: (args: CatalogProductsByIdsArgs) => Promise<ProductCatalogLatestV2[]>;
    recordLiveObservations: (args: CatalogRecordLiveObservationsArgs) => Promise<CatalogRecordLiveObservationsResult>;
    recordMutationResults: (args: CatalogRecordMutationResultsArgs) => Promise<CatalogRecordMutationResultsResult>;
    summarizeOpportunityRunMutations?: (args: { runId: string }) => Promise<{
      ok: boolean;
      runId: string;
      acknowledged: number;
      failed: number;
      skipped: number;
      safetySkipped: number;
      unknown: number;
      confirmed: number;
      total: number;
      byShop: Record<string, { acknowledged: number; failed: number; skipped: number; safetySkipped: number; unknown: number; confirmed: number; total: number }>;
    }>;
    confirmMutations: (args: CatalogConfirmMutationsArgs) => Promise<CatalogConfirmMutationsResult>;
    invalidateCoverage: (args: { coverageKey: string; reason?: string }) => Promise<{ ok: boolean; changed: number; invalidatedAt: string }>;
  };
  features: {
    saveStaleRun: (args: unknown) => Promise<void>;
    loadStaleCandidates: (args: unknown) => Promise<unknown[]>;
    saveBulkRun: (args: unknown) => Promise<void>;
    loadBulkCandidates: (args: unknown) => Promise<unknown[]>;
    saveOpportunityRun: (args: unknown) => Promise<void>;
    loadOpportunityCandidates: (args: unknown) => Promise<unknown[]>;
  };
}
