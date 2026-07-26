import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianOpportunityClueRow,
  DoudianOpportunityExecution,
  DoudianOpportunityFilters,
  DoudianOpportunityGoodsMatchType,
  DoudianOpportunityMatchRules,
  MatchDiagnostics,
  PipelineInputCoverage,
  DoudianOpportunityCandidatePage,
  DoudianOpportunityPrematchCandidate,
  DoudianOpportunityPrematchMode,
  DoudianOpportunityProductRow,
  DoudianOpportunityReportResult,
  DoudianOpportunityStoreCategoryLedger,
  DoudianOpportunitySubmitMode,
  DoudianOpportunityTitleMatchMode,
  DoudianOpportunityTitleUpdatePosition,
  DoudianRunDetail,
  DoudianStoreIdentityRef,
  DoudianStoreSummary
} from "../../types";
import { repositoryClaimOpportunitySubmitTask, repositoryDelete, repositoryDeleteMany, repositoryGet, repositoryGetAll, repositoryGetAllByPrefix, repositoryGetMany, repositoryLatest, repositoryListByPrefix, repositoryPut, repositoryPutMany } from "./repository";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";
import { assertMutationStoreActive, prepareMutationSafety, recordExecutionMutationResults } from "./mutationSafety";
import { getChihuNative } from "../../native/client";
import { getNativeData } from "../../nativeData/client";
import { dispatchDoudianProgress } from "./progress";
import { businessDateDaysAgo, businessDateKey } from "./businessDate";
import { reportDoudianDiagnostic } from "./diagnosticLog";
import {
  candidateExecutionState,
  isAlreadySubmittedOpportunityMessage,
  isFinalRateLimitedExecution,
  isProductClueLimitMessage,
  isRemoteSubmittedExecution,
  isStoreDailyQuotaMessage,
  preserveCancelledStatus,
  unresolvedBatchProductStatus
} from "./opportunityExecutionPolicy";
import {
  AhoTokenMatcher,
  ANCHOR_RULE_VERSION,
  boundedProductCandidateLimit,
  compareCandidatesByEvidence,
  createMatchDiagnostics,
  createTokenQualityMap,
  deriveAnchorEvidence,
  flattenProductTopK,
  groupEvidenceTerms,
  keepProductTopK,
  LOCAL_MATCH_VERSION,
  matchedEvidenceGroups,
  matchDiagnosticsSummary,
  mergeMatchDiagnostics,
  productCandidateKey,
  rankCandidatesAfterFiltering,
  scoreAhoTokenMatch,
  type TokenQuality
} from "./opportunity/matching";
import {
  clueCoverageSatisfiesPolicy,
  evaluateClueScanCoverage,
  evaluateInputScanCoverage,
  officialDecisionAllowsWrite,
  officialEnforcementReady,
  officialWriteAllowed,
  parseOfficialBusinessStatus,
  parseOfficialGoodsPage,
  parseOfficialWordsPayload,
  validateOfficialCandidate,
  type OfficialClueGoodsResult,
  type OfficialClueWordsResult,
  type OfficialGoodsContractMode,
  type OfficialValidationPolicy,
  type OfficialWordsSemantics
} from "./opportunity/officialValidation";
import { SUBMIT_HISTORY_CLUE_CAPACITY, advanceSubmitHistoryThrottle, evaluateSubmitHistoryPageCoverage, isSubmitHistoryBusinessSuccess, parseSubmitHistorySnapshot, submitHistoryBusinessFacts, submitHistoryCapacityFacts, submitHistoryInitialStart, submitHistoryPageBatchRange, submitHistoryPageReachesEnd, submitHistoryRemoteUpdatedAtWatermark, submitHistoryWindows } from "./opportunity/submitHistory";
import { isUnresolvedSubmitState, logicalSubmitAttemptId, recoverUnresolvedSubmitCandidate } from "./opportunity/submitRecovery.ts";
import { activeSubmitTasksForRun, canSupersedeContractMismatchTask, hasRemainingLegacySubmitWork, isDeferredSubmitTaskStatus, orphanedSubmitQueueStoreRuns, submitWorkerProgress } from "./opportunity/submitWorkerState.ts";
import { responseHeaderText, retryAfterMs, submitRetryWaitMs } from "./opportunity/submitRetryPolicy.ts";
import { classifyCoordinatedSubmitAttempt, type CoordinatedSubmitClassification } from "./opportunity/submitAttemptClassifier.ts";
import { pipelineDiagnosticsBlockCompletion, pipelineInputCoverageAllowsWrite, pipelineMutationTerminalFailureCount, pipelineNoCandidateSkipReason, pipelineStoreResultMessage, pipelineSubmitResponseStatus, pipelineSubmitResultMessage, pipelineTaskAwaitsAutomaticRecovery, pipelineTaskCoverageGate, pipelineTaskRetryableRemainingCount } from "./opportunity/pipelineResult.ts";
import { aggregateCategoryDemands, mapConcurrentOrdered } from "./opportunity/pipelinePreparation.ts";
import { evaluateSharedCacheProbe, resolvePipelineCacheScope } from "./opportunity/pipelineCachePolicy.ts";
import {
  evaluateSubmitConcurrencyReadiness,
  type SubmitConcurrencyEvaluation,
  type SubmitConcurrencyRunSnapshot
} from "./opportunity/submitConcurrencyReadiness.ts";

const clueScanStore = "opportunity_clue_scan_runs_v1" as const;
const clueCandidateStore = "opportunity_clue_candidates_v1" as const;
const productScanStore = "opportunity_product_scan_runs_v1" as const;
const productCandidateStore = "opportunity_product_candidates_v1" as const;
const prematchRunStore = "opportunity_prematch_runs_v1" as const;
const prematchCandidateStore = "opportunity_prematch_candidates_v1" as const;
const opportunityExecuteStore = "opportunity_execute_runs_v1" as const;
const submitAttemptStore = "opportunity_submit_attempts_v1" as const;
const pipelineRunStore = "opportunity_pipeline_runs_v2" as const;
const pipelineStoreRunStore = "opportunity_pipeline_store_runs_v2" as const;
const storeCategorySnapshotStore = "opportunity_store_category_snapshots_v2" as const;
const storeCategoryLedgerStore = "opportunity_store_category_ledger_v2" as const;
const clueCacheStore = "opportunity_clue_cache_v2" as const;
const clueCacheShardStore = "opportunity_clue_cache_shards_v2" as const;
const clueWordCacheStore = "opportunity_clue_word_cache_v2" as const;
const clueWordCacheShardStore = "opportunity_clue_word_cache_shards_v2" as const;
const officialClueWordsCacheStore = "opportunity_official_clue_words_cache_v1" as const;
const officialClueGoodsCacheStore = "opportunity_official_clue_goods_cache_v1" as const;
const officialClueGoodsCacheShardStore = "opportunity_official_clue_goods_cache_shards_v1" as const;
const submitHistoryRecordStore = "opportunity_submit_history_records_v1" as const;
const submitHistorySyncStore = "opportunity_submit_history_sync_v1" as const;
const submitHistoryProductIndexStore = "opportunity_submit_history_product_indexes_v1" as const;
const pipelineCandidateStore = "opportunity_pipeline_candidates_v2" as const;
const pipelineSubmitTaskStore = "opportunity_pipeline_submit_tasks_v2" as const;
const pipelineOperationEventStore = "opportunity_pipeline_operation_events_v2" as const;

const defaultActiveKey = "11,MATCH_DEGREE";
const submitBatchSizeFallback = 10;
const inputCoverageVersion = "opportunity-input-coverage-v3";
const latestPipelineCandidatePreviewLimit = 200;
const productCategoryIdFallbackPaths = [
  "category_id",
  "categoryId",
  "leaf_category_id",
  "leafCategoryId",
  "category_leaf_id",
  "categoryLeafId",
  "category_detail.leaf_cid",
  "categoryDetail.leafCid",
  "category_detail.fourth_cid",
  "categoryDetail.fourthCid",
  "category_detail.third_cid",
  "categoryDetail.thirdCid",
  "category_detail.second_cid",
  "categoryDetail.secondCid",
  "category_detail.first_cid",
  "categoryDetail.firstCid"
];
let pipelineSubmitWorkerTail: Promise<unknown> = Promise.resolve();
let submitHistoryRequestTail: Promise<void> = Promise.resolve();
let submitHistoryGlobalThrottle = { busyStreak: 0, nextEligibleAtMs: 0 };
const cancelledPipelineRunIds = new Set<string>();
const clueCacheLoadFlights = new Map<string, Promise<unknown>>();

interface OpportunityArgs {
  doudianAdapter?: DoudianAdapterPayload;
  mode?: string;
  runId?: string;
  shopIds?: string[];
  filters?: DoudianOpportunityFilters;
  matchRules?: DoudianOpportunityMatchRules;
  submitMode?: DoudianOpportunitySubmitMode | string;
  goodsMatchType?: DoudianOpportunityGoodsMatchType | string;
  matchMode?: DoudianOpportunityPrematchMode | string;
  titleMatchMode?: DoudianOpportunityTitleMatchMode | string;
  titleUpdatePosition?: DoudianOpportunityTitleUpdatePosition | string;
  clueIds?: string[];
  productIds?: string[];
  candidateIds?: string[];
  sourceRunId?: string;
  productRunId?: string;
  clueRunId?: string;
  matchRunId?: string;
  dailyAttemptLimit?: number;
  skipSubmittedClueCategory?: boolean;
  skipSubmittedClue?: boolean;
  skipSubmittedProductInSameClue?: boolean;
  operationId?: string;
  dryRun?: boolean;
  pageSize?: number;
  maxPages?: number;
  includeCandidates?: boolean;
  submitTaskId?: string;
  taskId?: string;
  reason?: string;
  taskContract?: {
    releaseId?: string;
    releaseManifestHash?: string;
    runnerArtifactHash?: string;
    adapterSnapshotHash?: string;
  };
  mockClues?: Array<Record<string, unknown>>;
  mockProducts?: Array<Record<string, unknown>>;
  mockOfficialClueWords?: Record<string, string[]>;
  mockOfficialProductsByClue?: Record<string, Array<Record<string, unknown>>>;
  mockOfficialWordsContract?: Record<string, OfficialWordsSemantics>;
  mockOfficialGoodsContract?: Record<string, OfficialGoodsContractMode>;
  mockPlatformAuditByAttempt?: Record<string, "pending" | "approved" | "rejected">;
  isCancelled?: () => boolean;
  beginMutation?: () => void;
  endMutation?: () => void;
}

interface ClueScanRunRecord {
  id: string;
  mode: "clue-scan";
  runId: string;
  operationId?: string;
  status: string;
  rows: DoudianOpportunityClueRow[];
  details: DoudianRunDetail[];
  scanSummary: Record<string, number>;
  sourceHealth: Array<Record<string, unknown>>;
  filters: DoudianOpportunityFilters;
  adapterVersion: string;
  scriptsVersion: string;
  requestPlanHash: string;
  createdAt: string;
  updatedAt: string;
}

interface ProductScanRunRecord {
  id: string;
  mode: "product-scan";
  runId: string;
  operationId?: string;
  status: string;
  products: DoudianOpportunityProductRow[];
  details: DoudianRunDetail[];
  scanSummary: Record<string, number>;
  sourceHealth: Array<Record<string, unknown>>;
  filters: DoudianOpportunityFilters;
  adapterVersion: string;
  scriptsVersion: string;
  requestPlanHash: string;
  createdAt: string;
  updatedAt: string;
}

interface PrematchRunRecord {
  id: string;
  mode: "product-prematch";
  runId: string;
  operationId?: string;
  productRunId: string;
  clueRunId: string;
  status: string;
  matchMode: DoudianOpportunityPrematchMode;
  candidates: DoudianOpportunityPrematchCandidate[];
  details: DoudianRunDetail[];
  summary: Record<string, number>;
  filters: DoudianOpportunityFilters;
  adapterVersion: string;
  scriptsVersion: string;
  requestPlanHash: string;
  createdAt: string;
  updatedAt: string;
}

interface SubmitAttemptRecord {
  id: string;
  date: string;
  runId: string;
  matchRunId?: string;
  candidateId?: string;
  shopId: string;
  shopName: string;
  clueId: string;
  clueName: string;
  clueCategoryName?: string;
  clueLastCategoryId?: string;
  clueLastCategoryKey?: string;
  productId: string;
  title: string;
  status: string;
  ok: boolean;
  message: string;
  stage?: string;
  planKey?: string;
  diagnostic?: Record<string, unknown>;
  createdAt: string;
}

interface ExecuteRunRecord {
  id: string;
  mode: "clue-submit" | "product-submit" | "collect";
  runId: string;
  operationId?: string;
  sourceRunId?: string;
  submitMode?: string;
  goodsMatchType?: string;
  status: string;
  dryRun: boolean;
  executions: DoudianOpportunityExecution[];
  details: DoudianRunDetail[];
  summary: Record<string, number>;
  adapterVersion: string;
  scriptsVersion: string;
  requestPlanHash: string;
  createdAt: string;
  updatedAt: string;
}

interface PipelineStoreIdentity {
  tenantId: string;
  shopId: string;
  shopName: string;
  storeGeneration: number;
  partition?: string;
  group?: string;
}

interface StoreCategorySummary {
  categoryId: string;
  categoryName: string;
  categoryPath: string[];
  lastCategoryKey: string;
  categoryKey: string;
  productCount: number;
  sampleProductIds: string[];
}

interface PipelineRunRecord {
  id: string;
  runId: string;
  operationId?: string;
  mode: "pipeline-submit";
  filters: DoudianOpportunityFilters;
  matchRules: DoudianOpportunityMatchRules;
  pipelineOptions?: {
    skipSubmittedClueCategory?: boolean;
    skipSubmittedClue?: boolean;
    skipSubmittedProductInSameClue?: boolean;
  };
  shopIds: string[];
  storeRefs?: PipelineStoreIdentity[];
  tenantId: string;
  clientCapability: Record<string, unknown>;
  status: "running" | "partial" | "ok" | "failed" | "cancelled";
  totalStoreCount: number;
  processedStoreCount: number;
  submittedCount: number;
  skippedCount: number;
  failedCount: number;
  summary: Record<string, number>;
  adapterVersion: string;
  scriptsVersion: string;
  requestPlanHash: string;
  submitConcurrencyEvaluation?: SubmitConcurrencyEvaluation & {
    signature: string;
    evaluatedAt: string;
  };
  recoverySource?: string;
  lastRecoveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface PipelineStoreRunRecord extends PipelineStoreIdentity {
  id: string;
  runId: string;
  status: string;
  phase: "product-scan" | "submit-history-sync" | "category-ledger" | "clue-load" | "tokenize" | "match" | "submit-queued" | "official-validate" | "submitting" | "finished";
  inputCoverage?: PipelineInputCoverage;
  productCount: number;
  benefitProductCount?: number;
  benefitAcquiredExposure?: number;
  benefitEstimatedExposure?: number;
  benefitAcquiredExposureParsedCount?: number;
  benefitAcquiredExposureUnparsedCount?: number;
  benefitEstimatedExposureParsedCount?: number;
  benefitEstimatedExposureUnparsedCount?: number;
  benefitSubmitRecordCount?: number;
  benefitAssociatedClueCount?: number;
  benefitSaturatedProductCount?: number;
  currentCategoryCount: number;
  effectiveCategoryCount: number;
  clueCount: number;
  tokenCount: number;
  candidateCount: number;
  persistedCandidateCount?: number;
  eligibleCandidateCount?: number;
  alternativeCandidateCount?: number;
  filteredByHistoryCount?: number;
  qualifiedCandidateCount?: number;
  primaryCandidateCount?: number;
  fallbackCandidateCount?: number;
  plannedSubmitCandidateCount?: number;
  primarySubmitCandidateCount?: number;
  fallbackSubmitCandidateCount?: number;
  dailyAttemptLimit?: number;
  quotaUsedBefore?: number;
  quotaRemainingBefore?: number;
  quotaRemainingAfterPlan?: number;
  quotaAttemptCount?: number;
  quotaRemainingAfterSubmit?: number;
  matchDiagnostics?: MatchDiagnostics;
  rawPairCount?: number;
  passedThresholdCount?: number;
  filteredByNoTokenCount?: number;
  filteredByWeakSingleTokenCount?: number;
  filteredByThresholdCount?: number;
  filteredByGenericOnlyCount?: number;
  droppedByTopKCount?: number;
  submittedCount: number;
  failedCount: number;
  skippedCount?: number;
  safetySkippedCount?: number;
  quotaExhaustedCount?: number;
  cancelledCount?: number;
  unknownCount?: number;
  localCandidateCount?: number;
  validationPendingCount?: number;
  officialVerifiedCount?: number;
  officialRejectedCount?: number;
  validationUnknownCount?: number;
  validationBudgetExhaustedCount?: number;
  officialWordsRequestCount?: number;
  officialWordsCount?: number;
  officialGoodsRequestCount?: number;
  officialValidationCacheHitCount?: number;
  officialValidationDurationMs?: number;
  officialValidationCompleteRatio?: number;
  distinctValidationGroupCount?: number;
  remoteRequestCount?: number;
  estimatedSubmitGroupCount?: number;
  estimatedSubmitDurationMs?: number;
  skipReason?: string;
  sourceHealth?: Array<Record<string, unknown>>;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

interface StoreCategorySnapshotRecord extends PipelineStoreIdentity {
  id: string;
  runId: string;
  categories: StoreCategorySummary[];
  productCount: number;
  missingCategoryProductCount: number;
  createdAt: string;
}

interface StoreCategoryLedgerRecord extends PipelineStoreIdentity {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryPath: string[];
  lastCategoryKey: string;
  categoryKey: string;
  productCount: number;
  seenCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sampleProductIds: string[];
}

interface PipelineSubmitTaskRecord extends PipelineStoreIdentity {
  id: string;
  runId: string;
  storeRunId: string;
  status: "preparing" | "ready" | "queued" | "running" | "cancelling" | "cooling_down" | "ok" | "partial" | "deferred" | "deferred_contract_mismatch" | "manual_reconcile" | "failed" | "cancelled" | "expired";
  concurrencyKey: string;
  ownerRunId?: string;
  candidateIds: string[];
  candidateCount: number;
  candidateIdsHash?: string;
  snapshotVersion?: string;
  primaryCandidateCount?: number;
  fallbackCandidateCount?: number;
  submittedCount: number;
  skippedCount: number;
  failedCount: number;
  safetySkippedCount?: number;
  quotaExhaustedCount?: number;
  cancelledCount?: number;
  unknownCount?: number;
  validationStatus?: "not_started" | "pending" | "complete" | "partial" | "failed";
  validationStartedAt?: string;
  validationFinishedAt?: string;
  officialWordsRequestCount?: number;
  officialWordsCount?: number;
  officialGoodsRequestCount?: number;
  officialVerifiedCount?: number;
  officialRejectedCount?: number;
  validationUnknownCount?: number;
  validationBudgetExhaustedCount?: number;
  validationPolicyVersion?: string;
  officialContractVersion?: string;
  inputCoverageStatus?: "complete" | "partial_coverage" | "failed";
  productComplete?: boolean;
  benefitComplete?: boolean;
  clueCoverageSatisfied?: boolean;
  remoteRequestCount?: number;
  candidateMutationAttemptCount?: number;
  httpRequestAttemptCount?: number;
  nextCandidateIndex?: number;
  inFlightAttemptId?: string;
  inFlightLogicalGroupId?: string;
  inFlightCandidateIds?: string[];
  inFlightAttemptOrdinal?: number;
  quotaReservationId?: string;
  httpGrantId?: string;
  httpGrantConsumedAt?: string;
  fencingToken?: number;
  resumeAt?: string;
  throttleCount?: number;
  throttlePauseMs?: number;
  lastThrottleAt?: string;
  retryableRemainingCount?: number;
  checkpointVersion?: string;
  deferredReason?: "throttle_budget" | "authorization_wait" | "login_wait" | "contract_mismatch" | "retry_exhausted";
  requiresExplicitResume?: boolean;
  releaseId?: string;
  releaseManifestHash?: string;
  runnerArtifactHash?: string;
  adapterVersion?: string;
  scriptsVersion?: string;
  requestPlanHash?: string;
  submitContractVersion?: string;
  pacingPolicyHash?: string;
  adapterSnapshotHash?: string;
  submitThrottleRecoveryEnabled?: boolean;
  contractSnapshotId?: string;
  startedAt?: string;
  leaseExpiresAt?: string;
  finishedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

interface PipelineOperationEventRecord {
  id: string;
  runId: string;
  storeRunId?: string;
  shopId?: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

interface ClueCacheRecord extends PipelineStoreIdentity {
  id: string;
  categoryKey: string;
  filterHash: string;
  requestPlanHash: string;
  adapterVersion: string;
  cacheScope: "shop" | "global";
  scopeId: string;
  generation: string;
  shardCount: number;
  rowCount: number;
  remoteTotal: number;
  remoteTotalKnown?: boolean;
  scanStatus?: "complete" | "truncated" | "failed";
  fetchedPages?: number;
  nextPage?: number;
  sourceHealth: Array<Record<string, unknown>>;
  sourceShopId: string;
  shopScoped: boolean;
  clueWordsSource: "realtime" | "clueWordsApi" | "mixed" | "local-clue-fields";
  clueWordsRequestHash: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface ClueCacheShardRecord {
  id: string;
  clueCacheKey: string;
  categoryKey: string;
  filterHash: string;
  cacheScope: "shop" | "global";
  scopeId: string;
  generation: string;
  shardNo: number;
  rows: DoudianOpportunityClueRow[];
  rowCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ClueWordCacheRecord {
  id: string;
  clueCacheKey: string;
  tokenizerVersion: string;
  stopwordVersion: string;
  categoryKey: string;
  filterHash: string;
  cacheScope: "shop" | "global";
  scopeId: string;
  shardCount: number;
  tokenCount: number;
  clueCount: number;
  clueIdsHash: string;
  generation: string;
  createdAt: string;
  updatedAt: string;
}

interface ClueWordCacheShardRecord {
  id: string;
  wordCacheKey: string;
  clueCacheKey: string;
  shardNo: number;
  generation: string;
  tokens: string[];
  tokenToClueIds: Record<string, string[]>;
  clueTokens: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
}

interface TokenIndex {
  wordCacheKey: string;
  tokenizerVersion: string;
  stopwordVersion: string;
  tokens: string[];
  tokenToClueIds: Record<string, string[]>;
  clueTokens: Record<string, string[]>;
}

interface ClueCategoryLoadResult {
  cacheKey: string;
  cacheScope: "shop" | "global";
  scopeId: string;
  rows: DoudianOpportunityClueRow[];
  sourceHealth: Array<Record<string, unknown>>;
  remoteTotal: number;
  remoteTotalKnown: boolean;
  scanStatus: "complete" | "truncated" | "failed";
  fetchedPages: number;
  nextPage?: number;
  cacheHit: boolean;
  ok: boolean;
  coverageSatisfied: boolean;
  skipReason?: string;
  cacheScopeDowngraded?: boolean;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function platformIntId(value: unknown) {
  const raw = text(value);
  if (!/^\d+$/.test(raw)) return raw;
  const next = Number(raw);
  return Number.isSafeInteger(next) ? next : raw;
}

function platformNumberId(value: unknown, fallback = 0) {
  const raw = text(value);
  if (!/^\d+$/.test(raw)) return fallback;
  const next = Number(raw);
  return Number.isSafeInteger(next) ? next : fallback;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bodyContext(body: Record<string, unknown>) {
  return { body, bodyJson: JSON.stringify(body) };
}

function arrayRecord(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(objectRecord).filter((item) => Object.keys(item).length) : [];
}

function arrayText(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function uniqueText(values: string[]) {
  return Array.from(new Set(values.map(text).filter(Boolean)));
}

function productTitleAliases(productTitle: string) {
  return {
    title: productTitle,
    name: productTitle,
    product_name: productTitle,
    productName: productTitle,
    product_title: productTitle,
    productTitle: productTitle,
    goods_name: productTitle,
    goodsName: productTitle,
    goods_title: productTitle,
    goodsTitle: productTitle,
    item_name: productTitle,
    itemName: productTitle,
    item_title: productTitle,
    itemTitle: productTitle
  };
}

function nowIso() {
  return new Date().toISOString();
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface OfficialClueWordsCacheRecord extends PipelineStoreIdentity {
  id: string;
  result: OfficialClueWordsResult;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface OfficialClueGoodsCacheRecord extends PipelineStoreIdentity {
  id: string;
  result: Omit<OfficialClueGoodsResult, "productIds">;
  generation: string;
  shardCount: number;
  rowCount: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface OfficialClueGoodsCacheShardRecord {
  id: string;
  cacheKey: string;
  generation: string;
  shardNo: number;
  productIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface OpportunityMutationCounts {
  acknowledged: number;
  failed: number;
  pending: number;
  skipped: number;
  safetySkipped: number;
  unknown: number;
  confirmed: number;
  total: number;
}

interface OpportunityMutationSummary extends OpportunityMutationCounts {
  ok: boolean;
  runId: string;
  byShop: Record<string, OpportunityMutationCounts>;
}

interface OpportunitySubmitRunMetrics {
  throttleCount: number;
  recoveredAfterThrottleCount: number;
  globalThrottleCount: number;
  candidateMutationAttemptCount: number;
  httpRequestAttemptCount: number;
  maxStoreIntervalMs: number;
  averageStoreIntervalMs: number;
  globalRateMode: "inactive" | "protective";
  globalIntervalMs: number;
  dailyCandidateMutationUsed: number;
  dailyCandidateMutationReserved: number;
  dailyCandidateMutationRemaining: number;
  dailyHttpRequestUsed: number;
  dailyHttpRequestReserved: number;
  dailyHttpRequestRemaining: number;
  firstHttpDispatchedAt: string;
  lastHttpResolvedAt: string;
}

function assertNotCancelled(shouldCancel?: () => boolean) {
  if (shouldCancel?.()) throw new Error("商机提报任务已取消");
}

async function cancellableWait(ms: number, shouldCancel?: () => boolean) {
  let remaining = Math.max(0, ms);
  while (remaining > 0) {
    assertNotCancelled(shouldCancel);
    const delayMs = Math.min(remaining, 250);
    await wait(delayMs);
    remaining -= delayMs;
  }
  assertNotCancelled(shouldCancel);
}

async function waitForSubmitHistoryCooldown(
  args: OpportunityArgs,
  resumeAtMs: number,
  shopLabel: string,
  checkpointNextPage?: number
) {
  while (resumeAtMs > Date.now()) {
    const remainingMs = resumeAtMs - Date.now();
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const checkpointMessage = checkpointNextPage && checkpointNextPage > 1
      ? `，恢复后从第 ${checkpointNextPage} 页继续`
      : "";
    dispatchPipelineProgress(args, 15, `提报历史校验受平台限流：${shopLabel}，${remainingSeconds} 秒后自动恢复${checkpointMessage}`);
    await cancellableWait(Math.min(5_000, remainingMs), () => pipelineCancelled(args));
  }
}

function adapterPayload(args: OpportunityArgs): DoudianAdapterPayload {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  return args.doudianAdapter;
}

function policy(adapter: DoudianAdapterConfig, path: string, fallback: unknown = undefined): unknown {
  const value = getPathValue(adapter.policies || {}, path);
  return value === undefined ? fallback : value;
}

function policyText(adapter: DoudianAdapterConfig, path: string, fallback = "") {
  const value = policy(adapter, path, fallback);
  return value == null ? fallback : String(value);
}

function policyNumber(adapter: DoudianAdapterConfig, path: string, fallback: number, min = 1, max = 1000) {
  const value = Math.floor(Number(policy(adapter, path, fallback)));
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function policyBoolean(adapter: DoudianAdapterConfig, path: string, fallback = false) {
  const value = policy(adapter, path, fallback);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLocaleLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return value == null ? fallback : Boolean(value);
}

function policyArray(adapter: DoudianAdapterConfig, path: string) {
  const value = policy(adapter, path, []);
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function policyMessage(adapter: DoudianAdapterConfig, path: string, fallback: string, values: Record<string, unknown> = {}) {
  return policyText(adapter, path, fallback).replace(/\{([^}]+)\}/g, (_match, key) => String(values[key] ?? ""));
}

function mappings(adapter: DoudianAdapterConfig) {
  return objectRecord(objectRecord(adapter.responseMappings).opportunityReport);
}

function mappingArray(adapter: DoudianAdapterConfig, key: string, fallback: string[] = []) {
  const value = mappings(adapter)[key];
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : fallback;
}

function fieldPaths(adapter: DoudianAdapterConfig, field: string, fallback: string[] = []) {
  const fields = objectRecord(mappings(adapter).fields);
  const value = fields[field];
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  const config = objectRecord(value);
  return Array.isArray(config.paths) ? config.paths.map((item) => text(item)).filter(Boolean) : fallback;
}

function fieldScale(adapter: DoudianAdapterConfig, field: string) {
  const scales = objectRecord(mappings(adapter).fieldScales);
  const config = objectRecord(objectRecord(mappings(adapter).fields)[field]);
  const value = Number(config.scale || scales[field] || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function firstArray(root: unknown, paths: string[]) {
  if (Array.isArray(root)) return root;
  for (const path of paths) {
    const value = path ? getPathValue(root, path) : root;
    if (Array.isArray(value)) return value;
  }
  return [];
}

type OfficialValidationMode = "disabled" | "local" | "observe" | "enforce" | "legacy";

function officialValidationMode(adapter: DoudianAdapterConfig): OfficialValidationMode {
  void adapter;
  return "local";
}

function officialWordsSemantics(adapter: DoudianAdapterConfig): OfficialWordsSemantics {
  const value = policyText(adapter, "opportunityReport.officialWordsSemantics", "unknown");
  return value === "alternative_terms" || value === "conjunctive_parts" ? value : "unknown";
}

function officialGoodsContractMode(adapter: DoudianAdapterConfig): OfficialGoodsContractMode {
  const value = policyText(adapter, "opportunityReport.officialGoodsContractMode", "unknown");
  return value === "exhaustive" || value === "positive_only" ? value : "unknown";
}

function officialValidationPolicy(adapter: DoudianAdapterConfig): OfficialValidationPolicy {
  const anchorMode = policyText(adapter, "opportunityReport.anchorEnforcementMode", "observe");
  return {
    version: policyText(adapter, "opportunityReport.officialValidationPolicyVersion", "official-validation-policy-v1"),
    goodsContractMode: officialGoodsContractMode(adapter),
    goodsMembershipSufficientForSubmit: policyBoolean(adapter, "opportunityReport.goodsMembershipSufficientForSubmit", false),
    wordsRequiredForSubmit: policyBoolean(adapter, "opportunityReport.wordsRequiredForSubmit", true),
    absenceIsHardRejection: policyBoolean(adapter, "opportunityReport.officialGoodsAbsenceIsHardRejection", false),
    anchorEnforcementMode: anchorMode === "enforce_high_confidence" ? "enforce_high_confidence" : "observe"
  };
}

function validatedAnchorWordsForClue(adapter: DoudianAdapterConfig, clue: DoudianOpportunityClueRow) {
  const byClueId = objectRecord(policy(adapter, "opportunityReport.validatedAnchorWordsByClueId"));
  const byClueName = objectRecord(policy(adapter, "opportunityReport.validatedAnchorWordsByClueName"));
  return uniqueText([
    ...arrayText(byClueId[clue.clueId]),
    ...arrayText(byClueName[clue.name])
  ]);
}

function coerceNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "val", "amount", "count", "cnt", "num", "score", "rate", "total", "text"]) {
      const next = coerceNumber(record[key]);
      if (next !== undefined) return next;
    }
    return undefined;
  }
  const source = String(value).replace(/,/g, "").replace(/¥/g, "").trim();
  const match = source.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const numberValue = Number(match[0]);
  if (!Number.isFinite(numberValue)) return undefined;
  return /万|w/i.test(source) ? numberValue * 10000 : numberValue;
}

function readField(record: unknown, adapter: DoudianAdapterConfig, field: string, fallbackPaths: string[] = []) {
  return firstPathValue(record, fieldPaths(adapter, field, fallbackPaths));
}

function readText(record: unknown, adapter: DoudianAdapterConfig, field: string, fallback = "", fallbackPaths: string[] = []) {
  return text(readField(record, adapter, field, fallbackPaths)) || fallback;
}

function readNonZeroText(record: unknown, adapter: DoudianAdapterConfig, field: string, fallbackPaths: string[] = []) {
  for (const path of fieldPaths(adapter, field, fallbackPaths)) {
    const value = text(path ? getPathValue(record, path) : record);
    if (value && value !== "0") return value;
  }
  return "";
}

function readNumber(record: unknown, adapter: DoudianAdapterConfig, field: string, fallback = 0, fallbackPaths: string[] = []) {
  const value = coerceNumber(readField(record, adapter, field, fallbackPaths));
  return value === undefined ? fallback : value / fieldScale(adapter, field);
}

interface BenefitProductIndexRecord extends PipelineStoreIdentity {
  id: string;
  productId: string;
  associatedClueIds: string[];
  associatedClueCount: number;
  remainingClueCapacity: number;
  submissionRecordIds: string[];
  sourceRecordCount: number;
  saturatedByRemoteError?: boolean;
  acquiredProfitIds: number[];
  unacquiredProfitIds: number[];
  acquiredExposure: number | null;
  estimatedExposure: number | null;
  sourceStatus: "complete" | "truncated" | "failed";
  sourceRemoteTotal?: number;
  fetchedAt: string;
  updatedAt: string;
}

interface SubmitHistoryRecord extends PipelineStoreIdentity {
  id: string;
  remoteRecordId: string;
  productId: string;
  productTitle: string;
  clueId: string;
  clueName: string;
  clueChannel: string;
  submitTimeMs: number;
  auditTimeMs: number | null;
  remoteUpdatedAtMs: number;
  auditStatus: string;
  appealStatus: string;
  isAutoSubmitted: boolean;
  raw?: Record<string, unknown>;
  fetchedAt: string;
  updatedAt: string;
}

interface SubmitHistorySyncRecord extends PipelineStoreIdentity {
  id: string;
  initialized: boolean;
  status: "complete" | "truncated" | "failed" | "cooling_down";
  initialStartEpochSeconds: number;
  initialCursorStartEpochSeconds: number;
  watermarkMs: number;
  remoteUpdatedAtWatermarkMs?: number;
  recordCount: number;
  lastMode: "initial" | "incremental";
  lastSuccessfulSyncAt?: string;
  lastError?: string;
  resumeAt?: string;
  throttleAttemptCount?: number;
  lastBusinessCode?: string;
  lastBusinessMessage?: string;
  checkpointWindowStartEpochSeconds?: number;
  checkpointWindowEndEpochSeconds?: number;
  checkpointNextPage?: number;
  checkpointRemoteTotal?: number;
  historyCompactionCursor?: string;
  historyCompactionCompletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface BenefitProductOverview {
  productCount: number;
  acquiredExposure: number;
  estimatedExposure: number;
  acquiredExposureParsedCount: number;
  acquiredExposureUnparsedCount: number;
  estimatedExposureParsedCount: number;
  estimatedExposureUnparsedCount: number;
  recordCount: number;
  associatedClueCount: number;
  saturatedProductCount: number;
  unparsedProductIds: string[];
}

function summarizeBenefitProducts(records: BenefitProductIndexRecord[]): BenefitProductOverview {
  const overview: BenefitProductOverview = {
    productCount: records.length,
    acquiredExposure: 0,
    estimatedExposure: 0,
    acquiredExposureParsedCount: 0,
    acquiredExposureUnparsedCount: 0,
    estimatedExposureParsedCount: 0,
    estimatedExposureUnparsedCount: 0,
    recordCount: 0,
    associatedClueCount: 0,
    saturatedProductCount: 0,
    unparsedProductIds: []
  };
  for (const record of records) {
    if (record.acquiredExposure === null) overview.acquiredExposureUnparsedCount += 1;
    else {
      overview.acquiredExposure += record.acquiredExposure;
      overview.acquiredExposureParsedCount += 1;
    }
    if (record.estimatedExposure === null) overview.estimatedExposureUnparsedCount += 1;
    else {
      overview.estimatedExposure += record.estimatedExposure;
      overview.estimatedExposureParsedCount += 1;
    }
    overview.recordCount += record.sourceRecordCount;
    overview.associatedClueCount += record.associatedClueCount;
    if (record.remainingClueCapacity <= 0) overview.saturatedProductCount += 1;
    if ((record.acquiredExposure === null || record.estimatedExposure === null) && overview.unparsedProductIds.length < 20) {
      overview.unparsedProductIds.push(record.productId);
    }
  }
  return overview;
}

function rawMappedId(record: Record<string, unknown>, adapter: DoudianAdapterConfig, field: string, fallbackPaths: string[]) {
  return readText(record, adapter, field, "", fallbackPaths);
}

const CLUE_ID_PATHS = [
  "clue_detail.clue_id",
  "clue_detail.clueId",
  "clueDetail.clue_id",
  "clueDetail.clueId",
  "detail.clue_id",
  "detail.clueId",
  "clue_id",
  "clueId",
  "id"
];

function rawClueId(record: Record<string, unknown>, adapter: DoudianAdapterConfig) {
  return rawMappedId(record, adapter, "clueId", CLUE_ID_PATHS);
}

function compactDiagnosticValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 180)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 6).map((item) => compactDiagnosticValue(item, depth + 1));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).slice(0, depth >= 2 ? 8 : 16);
    return Object.fromEntries(entries.map(([key, next]) => [key, compactDiagnosticValue(next, depth + 1)]));
  }
  return text(value).slice(0, 180);
}

function diagnosticValueShape(value: unknown, depth = 0): unknown {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      itemShape: value.length && depth < 3 ? diagnosticValueShape(value[0], depth + 1) : undefined
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 64);
    return {
      type: "object",
      keys: entries.map(([key]) => key).sort(),
      fields: depth < 3
        ? Object.fromEntries(entries.map(([key, next]) => [key, diagnosticValueShape(next, depth + 1)]))
        : undefined
    };
  }
  return {
    type: typeof value,
    ...(typeof value === "string" ? { length: value.length } : {})
  };
}

function benefitSchemaSample(row: Record<string, unknown>) {
  const associationHints = Object.fromEntries(Object.entries(row)
    .filter(([key]) => /clue|chance|opportun|associate|relation|linked|submit|count|num|total/i.test(key))
    .slice(0, 32)
    .map(([key, value]) => [key, compactDiagnosticValue(value)]));
  return {
    shape: diagnosticValueShape(row),
    associationHints
  };
}

function diagnosticPathLooksUseful(path: string) {
  const lower = path.toLocaleLowerCase();
  return /category|cate|cid|类目|first|second|third|fourth|leaf/.test(lower);
}

function collectDiagnosticPathValues(record: unknown, maxDepth = 5, maxItems = 80) {
  const rows: Array<{ path: string; value: unknown }> = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (rows.length >= maxItems || depth > maxDepth || value == null) return;
    if (Array.isArray(value)) {
      value.slice(0, 4).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, next] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (diagnosticPathLooksUseful(nextPath)) {
        rows.push({ path: nextPath, value: compactDiagnosticValue(next) });
        if (rows.length >= maxItems) return;
      }
      visit(next, nextPath, depth + 1);
      if (rows.length >= maxItems) return;
    }
  };
  visit(record, "", 0);
  return rows;
}

function configuredFieldDiagnostic(record: Record<string, unknown>, adapter: DoudianAdapterConfig, field: string, fallbackPaths: string[] = []) {
  return fieldPaths(adapter, field, fallbackPaths).map((path) => {
    const value = path ? getPathValue(record, path) : record;
    return {
      path,
      present: value !== undefined && value !== null && text(value) !== "",
      value: compactDiagnosticValue(value)
    };
  });
}

function productCategoryParseDiagnostic(
  rawRows: Record<string, unknown>[],
  products: DoudianOpportunityProductRow[],
  adapter: DoudianAdapterConfig,
  remoteTotal: number,
  sourceHealth: Array<Record<string, unknown>>
) {
  const byRawIndex = new Map<number, DoudianOpportunityProductRow>();
  for (const product of products) {
    const index = Number(objectRecord(product.raw).__row_index);
    if (Number.isInteger(index)) byRawIndex.set(index, product);
  }
  const missingIdIndexes = products
    .filter((product) => !text(product.categoryId) && (text(product.categoryName) || product.categoryPath?.length))
    .map((product) => Number(objectRecord(product.raw).__row_index))
    .filter((index) => Number.isInteger(index));
  const sampleIndexes = uniqueText([...missingIdIndexes, 0, 1, 2, 3].map((index) => String(index))).slice(0, 4).map((index) => Number(index));
  const samples = sampleIndexes
    .filter((index) => rawRows[index])
    .map((index) => {
      const raw = rawRows[index];
      const product = byRawIndex.get(index);
      return {
        rowIndex: index,
        topLevelKeys: Object.keys(raw).slice(0, 80),
        configuredFields: {
          productId: configuredFieldDiagnostic(raw, adapter, "productId", ["product_id", "productId", "goods_id", "goodsId", "id"]),
          productCategoryId: configuredFieldDiagnostic(raw, adapter, "productCategoryId", productCategoryIdFallbackPaths),
          productCategoryPath: configuredFieldDiagnostic(raw, adapter, "productCategoryPath", ["category_path", "categoryPath", "category_name", "categoryName", "category"]),
          productCategoryName: configuredFieldDiagnostic(raw, adapter, "productCategoryName", ["category_name", "categoryName", "category"]),
          productLastCategoryKey: configuredFieldDiagnostic(raw, adapter, "productLastCategoryKey", ["levelKey", "level_key", "lastCategoryKey", "last_category_key"])
        },
        usefulRawPaths: collectDiagnosticPathValues(raw),
        normalized: product ? {
          productId: product.productId,
          title: compactDiagnosticValue(product.title),
          categoryId: product.categoryId,
          categoryName: product.categoryName,
          categoryPath: product.categoryPath,
          lastCategoryKey: product.lastCategoryKey
        } : null
      };
    });
  return {
    rawRowCount: rawRows.length,
    productCount: products.length,
    remoteTotal,
    sourceHealth,
    categoryIdCount: products.filter((product) => text(product.categoryId)).length,
    categoryNameCount: products.filter((product) => text(product.categoryName)).length,
    categoryPathCount: products.filter((product) => product.categoryPath?.length).length,
    missingCategoryIdWithCategoryCount: products.filter((product) => !text(product.categoryId) && (text(product.categoryName) || product.categoryPath?.length)).length,
    samples
  };
}

async function reportOpportunityPipelineDiagnostic(event: string, detail: Record<string, unknown>) {
  const native = getChihuNative();
  if (!native?.logs?.report) return;
  await native.logs.report({
    category: "opportunity-pipeline-diagnostic",
    event,
    ...detail
  }).catch(() => undefined);
}

function normalizeDate(value: unknown) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : value;
    return businessDateKey(new Date(ms));
  }
  const next = text(value);
  if (/^\d+$/.test(next)) return normalizeDate(Number(next));
  const match = next.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
  return match ? match[0].replace(/\//g, "-").split("-").map((part, index) => index ? part.padStart(2, "0") : part).join("-") : "";
}

function normalizeRate(value: unknown) {
  const numberValue = coerceNumber(value) || 0;
  return Math.abs(numberValue) > 0 && Math.abs(numberValue) <= 1 ? numberValue * 100 : numberValue;
}

function categoryLevelKey(level: number) {
  if (level <= 1) return "first_cid";
  if (level === 2) return "second_cid";
  if (level === 3) return "third_cid";
  return "fourth_cid";
}

function isCategoryLevelKey(key: string) {
  return key === "first_cid" || key === "second_cid" || key === "third_cid" || key === "fourth_cid";
}

function categoryDetailValue(detail: Record<string, unknown>, key: string) {
  if (key === "first_cid") return text(detail.first_cid || detail.firstCid);
  if (key === "second_cid") return text(detail.second_cid || detail.secondCid);
  if (key === "third_cid") return text(detail.third_cid || detail.thirdCid);
  if (key === "fourth_cid") return text(detail.fourth_cid || detail.fourthCid);
  return "";
}

function inferProductCategoryLevelKey(raw: Record<string, unknown>, leafId: string, fallbackPathLength = 0) {
  const detail = objectRecord(raw.category_detail || raw.categoryDetail);
  const leaf = text(
    leafId ||
    raw.category_leaf_id ||
    raw.categoryLeafId ||
    raw.leaf_category_id ||
    raw.leafCategoryId ||
    detail.leaf_cid ||
    detail.leafCid
  );
  const keys = ["fourth_cid", "third_cid", "second_cid", "first_cid"];
  if (leaf) {
    const matched = keys.find((key) => {
      const value = categoryDetailValue(detail, key);
      return value && value !== "0" && value === leaf;
    });
    if (matched) return matched;
  }
  const deepest = keys.find((key) => {
    const value = categoryDetailValue(detail, key);
    return value && value !== "0";
  });
  if (deepest) return deepest;
  if (fallbackPathLength) return categoryLevelKey(fallbackPathLength);
  return "";
}

function categoryPathNames(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string" || typeof item === "number") return text(item);
    const record = objectRecord(item);
    return text(record.name || record.label || record.category_name || record.categoryName || record.title);
  }).filter(Boolean);
}

function normalizeCategoryPath(value: unknown) {
  if (Array.isArray(value)) return categoryPathNames(value);
  const source = text(value);
  if (!source) return [];
  return source.split(/[>／/]/).map((part) => part.trim()).filter(Boolean);
}

function categoryKeyOf(value: { categoryId?: string; categoryPath?: string[]; categoryName?: string; lastCategoryKey?: string }) {
  const id = text(value.categoryId);
  const path = (value.categoryPath || []).map(text).filter(Boolean).join(">");
  const name = text(value.categoryName);
  const configuredKey = text(value.lastCategoryKey);
  const key = isCategoryLevelKey(configuredKey)
    ? configuredKey
    : (value.categoryPath?.length ? categoryLevelKey(value.categoryPath.length) : "");
  if (!id && !path && !name) return "";
  return [key || "category_id", id || path || name].filter(Boolean).join(":");
}

function normalizePipelineStoreIdentity(store: DoudianStoreSummary): PipelineStoreIdentity {
  return {
    tenantId: text(store.tenantId) || "local-user",
    shopId: store.shopId,
    shopName: store.shopName,
    storeGeneration: Math.max(1, Math.floor(Number(store.storeGeneration || 1))),
    partition: store.partition,
    group: store.groupName || ""
  };
}

function labelNames(value: unknown, key: string) {
  return Array.isArray(value)
    ? value.map((item) => {
      const record = objectRecord(item);
      return text(record[key] || record.label_name || record.name || record.label || item);
    }).filter(Boolean)
    : [];
}

function normalizeClue(store: DoudianStoreSummary, raw: Record<string, unknown>, adapter: DoudianAdapterConfig, runId: string, index: number): DoudianOpportunityClueRow | null {
  const detail = objectRecord(raw.clue_detail || raw.clueDetail || raw.detail || raw);
  const indicator = objectRecord(raw.clue_indicator || raw.clueIndicator || raw.indicator);
  const autoSubmit = objectRecord(raw.auto_submit_task || raw.autoSubmitTask);
  const clueId = rawClueId(raw, adapter);
  if (!clueId) return null;
  const categoryPath = categoryPathNames(detail.category_path || detail.categoryPath);
  const depth = Math.max(1, Math.min(4, categoryPath.length || 1));
  const lastCategoryKey = text(detail.lastCategoryKey) || categoryLevelKey(depth);
  const lastCategoryId = text(detail[lastCategoryKey] || detail.fourth_cid || detail.third_cid || detail.second_cid || detail.first_cid || detail.leaf_category_id || detail.category_id);
  const brandName = text(detail.brand_name || detail.brandName);
  const name = text(detail.name || detail.clue_name || detail.clueName || detail.title) || clueId;
  const shortName = text(detail.short_name || detail.shortName);
  const autoSubmitId = text(autoSubmit.auto_submit_task_id || autoSubmit.autoSubmitTaskId);
  const searchCountText = text(indicator.search_pv_cnt_range || indicator.searchPvCntRange);
  const payMoney = text(indicator.pay_amount_ind_range || indicator.payAmountIndRange).replace(/¥/g, "");
  const onlineGoodsNum = text(indicator.online_prod_cnt_range || indicator.onlineProdCntRange || indicator.onlineGoodsNum) || "--";
  const row: DoudianOpportunityClueRow = {
    id: `${runId}-${clueId}`,
    candidateId: `${store.shopId}-${clueId}`,
    sourceRunId: runId,
    clueId,
    name,
    shortName: brandName ? `${brandName}${shortName || name}` : shortName || name,
    img: text(detail.product_pic_url || detail.productPicUrl || detail.img || detail.image),
    categoryName: categoryPath.join(">"),
    firstCategoryId: text(detail.first_cid || detail.firstCid),
    lastCategoryId,
    lastCategoryKey,
    clueWords: [],
    recommendList: labelNames(detail.clue_label_list || detail.clueLabelList, "label_name"),
    profitInfoList: labelNames(detail.profit_info_list || detail.profitInfoList, "profit_name"),
    shopList: [{
      shopId: store.shopId,
      shopName: store.shopName,
      partition: store.partition,
      group: store.groupName || "",
      ...(autoSubmitId ? { autoSubmitId } : {})
    }],
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    searchCount: coerceNumber(indicator.search_pv_cnt || indicator.searchPvCnt || searchCountText) || 0,
    searchCountText,
    growthRate: normalizeRate(indicator.pay_amount_ind_30d_rate || indicator.payAmountInd30dRate),
    demandSupplyRate: coerceNumber(indicator.demand_supply_rate || indicator.demandSupplyRate) || 0,
    onlineGoodsNum,
    onlineGoodsNumSort: coerceNumber(indicator.online_prod_cnt || indicator.onlineProdCnt || onlineGoodsNum) || 0,
    hotCount: text(indicator.demand_heat_range || indicator.demandHeatRange) || "--",
    hotCountSort: coerceNumber(indicator.search_heat || indicator.searchHeat) || 0,
    payMoney: payMoney || "--",
    payMoneySort: coerceNumber(indicator.pay_amount_ind || indicator.payAmountInd || payMoney) || 0,
    productCount: coerceNumber(indicator.online_prod_cnt || indicator.onlineProdCnt) || 0,
    autoSubmitId,
    status: autoSubmitId ? "collected" : "ready",
    raw: { ...raw, __row_index: index }
  };
  return row;
}

function mergeClues(rows: DoudianOpportunityClueRow[]) {
  const byClueId = new Map<string, DoudianOpportunityClueRow>();
  for (const row of rows) {
    const current = byClueId.get(row.clueId);
    if (!current) {
      byClueId.set(row.clueId, { ...row, shopList: [...row.shopList] });
      continue;
    }
    const shopMap = new Map(current.shopList.map((shop) => [shop.shopId, shop]));
    for (const shop of row.shopList) shopMap.set(shop.shopId, { ...(shopMap.get(shop.shopId) || {}), ...shop });
    current.shopList = Array.from(shopMap.values());
    current.status = current.shopList.some((shop) => shop.autoSubmitId) ? "collected" : current.status;
    current.autoSubmitId = current.shopList.find((shop) => shop.autoSubmitId)?.autoSubmitId || current.autoSubmitId;
  }
  return Array.from(byClueId.values());
}

function normalizeProduct(
  store: DoudianStoreSummary,
  raw: Record<string, unknown>,
  adapter: DoudianAdapterConfig,
  runId: string,
  index: number,
  extra: Partial<DoudianOpportunityProductRow> = {}
): DoudianOpportunityProductRow | null {
  const productId = readText(raw, adapter, "productId", "", ["product_id", "productId", "goods_id", "goodsId", "id"]);
  if (!productId) return null;
  const title = readText(raw, adapter, "title", productId, ["title", "name", "product_name", "productName", "goods_name"]);
  const categoryPath = normalizeCategoryPath(readField(raw, adapter, "productCategoryPath", [
    "category_path",
    "categoryPath",
    "category_name",
    "categoryName",
    "category"
  ]));
  const categoryName = readText(raw, adapter, "productCategoryName", "", [
    "category_name",
    "categoryName",
    "category"
  ]) || categoryPath[categoryPath.length - 1] || "";
  const category = categoryPath.length ? categoryPath.join(">") : categoryName;
  const categoryId = readNonZeroText(raw, adapter, "productCategoryId", productCategoryIdFallbackPaths);
  const configuredLastCategoryKey = readText(raw, adapter, "productLastCategoryKey", "", [
    "levelKey",
    "level_key",
    "lastCategoryKey",
    "last_category_key"
  ]);
  const inferredLastCategoryKey = inferProductCategoryLevelKey(raw, categoryId, categoryPath.length);
  const lastCategoryKey = isCategoryLevelKey(configuredLastCategoryKey)
    ? configuredLastCategoryKey
    : inferredLastCategoryKey || (categoryPath.length ? categoryLevelKey(categoryPath.length) : "");
  return {
    id: `${runId}-${store.shopId}-${productId}`,
    candidateId: `${store.shopId}-${productId}`,
    sourceRunId: runId,
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    productId,
    title,
    img: readText(raw, adapter, "img", "", ["pic_url", "img", "image", "cover", "main_image", "mainImage"]),
    category,
    categoryId,
    categoryName,
    categoryPath,
    lastCategoryKey,
    price: readNumber(raw, adapter, "price", 0, ["price", "min_price", "minPrice"]),
    stock: readNumber(raw, adapter, "stock", 0, ["stock_num", "stockNum", "stock", "inventory"]),
    sales: readNumber(raw, adapter, "sales", 0, ["sell_num", "sellNum", "sale_num", "saleNum", "sales"]),
    createdAt: normalizeDate(readField(raw, adapter, "createdAt", ["create_time", "createTime", "created_at", "createdAt"])),
    listedAt: normalizeDate(readField(raw, adapter, "listedAt", ["audit_time", "auditTime", "online_time", "onlineTime"])),
    status: extra.status || "ready",
    raw: { ...raw, __row_index: index },
    ...extra
  };
}

function readTotal(payload: unknown, adapter: DoudianAdapterConfig, key: string) {
  return coerceNumber(firstPathValue(payload, mappingArray(adapter, key))) || 0;
}

function readOptionalTotal(payload: unknown, adapter: DoudianAdapterConfig, key: string) {
  for (const path of mappingArray(adapter, key)) {
    const value = coerceNumber(path ? getPathValue(payload, path) : payload);
    if (value !== undefined && value >= 0) return value;
  }
  return undefined;
}

function responseMessage(response: RequestPlanResult | undefined) {
  return text(firstPathValue(response?.data, [
    "base_resp.status_message",
    "data.base_resp.status_message",
    "msg",
    "message",
    "status_msg",
    "statusMessage"
  ]) || response?.error).slice(0, 240);
}

function responseCode(response: RequestPlanResult | undefined) {
  return firstPathValue(response?.data, ["base_resp.status_code", "data.base_resp.status_code", "code", "st", "status_code", "statusCode", "errno"]);
}

function submitResponseOk(response: RequestPlanResult | undefined) {
  if (!response?.ok) return false;
  const code = responseCode(response);
  if (code == null || code === "") return false;
  return ["0", "200"].includes(String(code));
}

function planOk(response: RequestPlanResult | undefined, adapter: DoudianAdapterConfig, planKey: string) {
  return requestPlanResponseOk(response, adapter, planKey, mappings(adapter));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function stableHash(value: unknown) {
  const textValue = typeof value === "string" ? value : stableStringify(value);
  let hash = 0;
  for (let index = 0; index < textValue.length; index += 1) hash = ((hash << 5) - hash + textValue.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function requestPlanHash(adapter: DoudianAdapterConfig) {
  const planKeys = ["opportunityClueRealtimeList", "opportunitySubmitHistoryList", "opportunitySubmitClue", "opportunityProductList"];
  return stableHash({
    adapterVersion: adapter.version || "",
    fieldSchemaVersion: policyText(adapter, "opportunityReport.fieldSchemaVersion", ""),
    plans: planKeys.map((key) => ({
      key,
      endpoint: adapter.endpoints?.[text(objectRecord(adapter.requestPlans?.[key]).endpointKey || key)] || "",
      plan: adapter.requestPlans?.[key] || {}
    })),
    mappings: {
      clueListPaths: mappingArray(adapter, "clueListPaths"),
      clueTotalPaths: mappingArray(adapter, "clueTotalPaths"),
      productListPaths: mappingArray(adapter, "productListPaths"),
      productTotalPaths: mappingArray(adapter, "productTotalPaths"),
      clueGoodsListPaths: mappingArray(adapter, "clueGoodsListPaths"),
      clueGoodsTotalPaths: mappingArray(adapter, "clueGoodsTotalPaths"),
      fields: objectRecord(mappings(adapter).fields)
    },
    policies: {
      cluePageSize: policy(adapter, "opportunityReport.cluePageSize"),
      maxCluePages: policy(adapter, "opportunityReport.maxCluePages"),
      productPageSize: policy(adapter, "opportunityReport.productPageSize"),
      maxProductListPages: policy(adapter, "opportunityReport.maxProductListPages"),
      enableRemoteClueWords: policy(adapter, "opportunityReport.enableRemoteClueWords"),
      submitHistoryPageSize: policy(adapter, "opportunityReport.submitHistoryPageSize"),
      maxSubmitHistoryPagesPerWindow: policy(adapter, "opportunityReport.maxSubmitHistoryPagesPerWindow"),
      submitHistoryWindowDays: policy(adapter, "opportunityReport.submitHistoryWindowDays"),
      submitHistoryInitialLookbackDays: policy(adapter, "opportunityReport.submitHistoryInitialLookbackDays"),
      submitHistoryIncrementalOverlapSeconds: policy(adapter, "opportunityReport.submitHistoryIncrementalOverlapSeconds"),
      submitHistoryPageDelayMs: policy(adapter, "opportunityReport.submitHistoryPageDelayMs")
    }
  });
}

function normalizedClueFilter(filters: DoudianOpportunityFilters = {}, adapter: DoudianAdapterConfig) {
  const activeKey = text(filters.activeKey || defaultActiveKey);
  const [, sortField] = activeKey.split(",");
  return {
    activeKey,
    keyword: text(filters.keyword),
    tagIdList: [...(filters.tagIdList || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b),
    profitIdList: [...(filters.profitIdList || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b),
    benefitContentType: benefitContentTypeFilter(filters.benefitContentType).sort(),
    recentlyDayType: Number(filters.recentlyDayType ?? 3),
    clueBrandExists: filters.clueBrandExists === undefined ? null : filters.clueBrandExists,
    cluePage: Number(filters.cluePage || 2),
    clueCoveragePages: Math.max(1, Math.min(200, Math.floor(Number(filters.clueCoveragePages || policyNumber(adapter, "opportunityReport.clueCoveragePages", 5, 1, 200))))),
    pageSize: Math.max(10, Math.min(100, Math.floor(Number(filters.pageSize || policyNumber(adapter, "opportunityReport.cluePageSize", 72, 10, 100))))),
    maxPages: Math.max(1, Math.min(200, Math.floor(Number(filters.maxPages || policyNumber(adapter, "opportunityReport.maxCluePages", 200, 1, 200))))),
    sortField: sortField || "MATCH_DEGREE",
    sortDirection: 1
  };
}

function stableFilterHash(filters: DoudianOpportunityFilters = {}, adapter: DoudianAdapterConfig) {
  const normalized = normalizedClueFilter(filters, adapter);
  const { clueCoveragePages: _coveragePages, maxPages: _maxPages, ...platformFilter } = normalized;
  return stableHash(platformFilter);
}

const opportunitySubmitContractVersion = "opportunity-submit-contract-v1";

function submitCoordinatorEnabled(adapter: DoudianAdapterConfig) {
  return policyBoolean(adapter, "opportunityReport.submitThrottleRecoveryEnabled", false);
}

function submitCoordinatorPolicy(adapter: DoudianAdapterConfig) {
  return {
    policyVersion: "opportunity-submit-adaptive-v1",
    submitPacingInitialIntervalMs: policyNumber(adapter, "opportunityReport.submitPacingInitialIntervalMs", 15000, 1000, 600000),
    submitPacingMinIntervalMs: policyNumber(adapter, "opportunityReport.submitPacingMinIntervalMs", 10000, 500, 600000),
    submitPacingMaxIntervalMs: policyNumber(adapter, "opportunityReport.submitPacingMaxIntervalMs", 60000, 1000, 600000),
    submitPacingJitterMs: policyNumber(adapter, "opportunityReport.submitPacingJitterMs", 1500, 0, 60000),
    submitPacingSuccessesToDecrease: policyNumber(adapter, "opportunityReport.submitPacingSuccessesToDecrease", 8, 1, 100),
    submitPacingDecreaseMs: policyNumber(adapter, "opportunityReport.submitPacingDecreaseMs", 1000, 1, 60000),
    submitPacing429Multiplier: Number(policy(adapter, "opportunityReport.submitPacing429Multiplier", 1.5)),
    submitPacingMaxCooldownMs: policyNumber(adapter, "opportunityReport.submitPacingMaxCooldownMs", 120000, 1000, 86400000),
    submitGlobalBurstSpacingMs: policyNumber(adapter, "opportunityReport.submitGlobalBurstSpacingMs", 500, 0, 60000),
    submitGlobalPacingInitialMs: policyNumber(adapter, "opportunityReport.submitGlobalPacingInitialMs", 15000, 1000, 600000),
    submitGlobalPacingMaxMs: policyNumber(adapter, "opportunityReport.submitGlobalPacingMaxMs", 60000, 1000, 600000),
    submitGlobalPacing429Multiplier: Number(policy(adapter, "opportunityReport.submitGlobalPacing429Multiplier", 1.5)),
    submitGlobalPacingDecreaseMs: policyNumber(adapter, "opportunityReport.submitGlobalPacingDecreaseMs", 5000, 1, 60000),
    submitGlobal429WindowMs: policyNumber(adapter, "opportunityReport.submitGlobal429WindowMs", 120000, 10000, 3600000),
    submitGlobal429DistinctStores: policyNumber(adapter, "opportunityReport.submitGlobal429DistinctStores", 2, 2, 1000),
    submitGlobalStableWindowsToExit: policyNumber(adapter, "opportunityReport.submitGlobalStableWindowsToExit", 2, 1, 100),
    submitStoreThrottleBudgetMs: policyNumber(adapter, "opportunityReport.submitStoreThrottleBudgetMs", 1800000, 60000, 3600000),
    submitRetryLimit: policyNumber(adapter, "opportunityReport.submitRetryLimit", 3, 1, 100)
  };
}

function submitTaskContract(payload: DoudianAdapterPayload, args: OpportunityArgs) {
  const trusted = objectRecord(args.taskContract);
  const pacingPolicy = submitCoordinatorPolicy(payload.adapter);
  return {
    releaseId: text(trusted.releaseId) || "unbound",
    releaseManifestHash: text(trusted.releaseManifestHash) || "unbound",
    runnerArtifactHash: text(trusted.runnerArtifactHash) || "unbound",
    adapterVersion: payload.adapter.version || "unbound",
    scriptsVersion: payload.scripts?.version || "unbound",
    requestPlanHash: requestPlanHash(payload.adapter),
    submitContractVersion: opportunitySubmitContractVersion,
    pacingPolicyHash: stableHash(pacingPolicy),
    adapterSnapshotHash: text(trusted.adapterSnapshotHash) || "unbound",
    submitThrottleRecoveryEnabled: submitCoordinatorEnabled(payload.adapter)
  };
}

function assertBoundSubmitTaskContract(task: PipelineSubmitTaskRecord) {
  const fields = [
    task.releaseId,
    task.releaseManifestHash,
    task.runnerArtifactHash,
    task.adapterVersion,
    task.scriptsVersion,
    task.requestPlanHash,
    task.submitContractVersion,
    task.pacingPolicyHash,
    task.adapterSnapshotHash
  ];
  if (fields.some((value) => !text(value) || value === "unbound")) throw new Error("Opportunity submit task is missing a trusted release contract");
  if (task.submitThrottleRecoveryEnabled !== true) throw new Error("Opportunity submit task was not created with recovery enabled");
}

function stableMatchRulesHash(args: OpportunityArgs) {
  const rules = normalizeOpportunityMatchRules(args.matchRules);
  return stableHash({
    storeCategoryKeys: [...(rules.storeCategoryKeys || [])].sort(),
    minTokenHitRatio: rules.minTokenHitRatio,
    minWeightHitRatio: rules.minWeightHitRatio,
    topKPerProduct: rules.topKPerProduct,
    genericTokenDfRatio: rules.genericTokenDfRatio,
    matchMode: prematchMode(args),
    skipSubmittedClueCategory: args.skipSubmittedClueCategory === true,
    skipSubmittedClue: args.skipSubmittedClue === true,
    skipSubmittedProductInSameClue: args.skipSubmittedProductInSameClue !== false
  });
}

function assertOpportunityPipelineContract(adapter: DoudianAdapterConfig) {
  const missing: string[] = [];
  const requiredPlans = [
    "opportunityProductList",
    "opportunitySubmitHistoryList",
    "opportunityClueRealtimeList",
    "opportunitySubmitClue"
  ];
  for (const planKey of requiredPlans) {
    const plan = objectRecord(adapter.requestPlans?.[planKey]);
    const endpointKey = text(plan.endpointKey || planKey);
    if (!Object.keys(plan).length) missing.push(`requestPlans.${planKey}`);
    if (!endpointKey || !adapter.endpoints?.[endpointKey]) missing.push(`endpoints.${endpointKey || planKey}`);
  }
  const requiredListMappings: Array<[string, string[]]> = [
    ["clueListPaths", ["opportunityClueRealtimeList.data", "opportunityClueRealtimeList.data.data", "opportunityClueRealtimeList.list"]],
    ["productListPaths", ["opportunityProductList.data", "opportunityProductList.data.list", "opportunityProductList.list"]],
    ["productTotalPaths", ["opportunityProductList.data.total", "opportunityProductList.total"]],
    ["submitHistoryListPaths", ["opportunitySubmitHistoryList.data", "opportunitySubmitHistoryList.data.list"]],
    ["submitHistoryTotalPaths", ["opportunitySubmitHistoryList.total", "opportunitySubmitHistoryList.data.total"]]
  ];
  for (const [key, fallback] of requiredListMappings) {
    if (!mappingArray(adapter, key, fallback).length) missing.push(`responseMappings.opportunityReport.${key}`);
  }
  const requiredFields: Array<[string, string[]]> = [
    ["clueId", CLUE_ID_PATHS],
    ["productId", ["product_id", "productId", "goods_id", "goodsId", "id"]],
    ["title", ["title", "name", "product_name", "productName", "goods_name"]],
    ["productCategoryId", productCategoryIdFallbackPaths],
    ["productCategoryPath", ["category_path", "categoryPath", "category_name", "categoryName", "category"]],
    ["productCategoryName", ["category_name", "categoryName", "category"]],
    ["productLastCategoryKey", ["levelKey", "level_key", "lastCategoryKey", "last_category_key"]]
  ];
  for (const [field, fallback] of requiredFields) {
    if (!fieldPaths(adapter, field, fallback).length) missing.push(`responseMappings.opportunityReport.fields.${field}`);
  }
  if (missing.length) throw new Error(`opportunity pipeline adapter contract missing: ${uniqueText(missing).join(", ")}`);
}

function categoryFilter(filters: DoudianOpportunityFilters = {}) {
  const path = filters.categoryPath || [];
  const last = path[path.length - 1];
  if (last?.id != null && last.id !== "") {
    const key = isCategoryLevelKey(text(last.key))
      ? text(last.key)
      : categoryLevelKey(Number(last.level || path.length || 3));
    return [{ [key]: platformIntId(last.id) }];
  }
  if (filters.categoryLeafId != null && filters.categoryLeafId !== "") {
    return [{ third_cid: platformIntId(filters.categoryLeafId) }];
  }
  return undefined;
}

function benefitContentTypeFilter(value: DoudianOpportunityFilters["benefitContentType"]) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const next = text(value);
  return next ? [next] : [];
}

function buildClueSearchBody(filters: DoudianOpportunityFilters = {}, current = 1, pageSize = 72) {
  const activeKey = text(filters.activeKey || defaultActiveKey);
  const [clueTypeNew, sortField] = activeKey.split(",");
  const categories = categoryFilter(filters);
  return {
    condition: {
      clue_info: text(filters.keyword),
      sort: {
        sort_direction: 1,
        sort_field: sortField || "MATCH_DEGREE"
      },
      tag_id_list: filters.tagIdList || [],
      profit_id_list: filters.profitIdList || [],
      benefit_crowd_group: [],
      benefit_content_type: benefitContentTypeFilter(filters.benefitContentType),
      clue_attr_key_list: [],
      hit_clue_label_ext: true,
      show_new_supply_link: true,
      recently_created: false,
      category_qualification: false,
      category_clue_auto_submit: false,
      attr_values: [],
      include_hot_sales_products: true,
      recently_day_type: Number(filters.recentlyDayType ?? 3),
      clue_brand_exists: filters.clueBrandExists === undefined ? null : filters.clueBrandExists,
      ...(categories ? { categories } : {})
    },
    clue_type: "",
    clue_type_new: Number(clueTypeNew) || 11,
    page: {
      current,
      page_size: pageSize
    },
    terminal_type: 0,
    source: "business_center",
    clue_page: Number(filters.cluePage || 2)
  };
}

function thirtyDaysAgo() {
  return businessDateDaysAgo(30);
}

let submitAttemptMigrationPromise: Promise<boolean> | null = null;
const submitAttemptMigrationMetaId = "opportunity-submit-attempts-v2-migration";

function productListContext(filters: DoudianOpportunityFilters = {}, page: number, pageSize: number, categoryLeafId = "") {
  const idNameCode = text(filters.keyword);
  return {
    page: String(page),
    pageSize: String(pageSize),
    keyword: idNameCode,
    idNameCode,
    categoryLeafId: text(categoryLeafId || filters.categoryLeafId),
    startTime: text(filters.startTime || thirtyDaysAgo()),
    endTime: text(filters.endTime || businessDateKey())
  };
}

async function scanCluesForStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, args: OpportunityArgs, runId: string, index: number, total: number) {
  const planKey = "opportunityClueRealtimeList";
  const pageSize = policyNumber(payload.adapter, "opportunityReport.cluePageSize", 72, 10, 100);
  const maxPages = Math.max(1, Math.min(200, Math.floor(Number(args.maxPages || args.filters?.maxPages || policyNumber(payload.adapter, "opportunityReport.maxCluePages", 200, 1, 200)))));
  const rawRows: Record<string, unknown>[] = [];
  const rowById = new Map<string, Record<string, unknown>>();
  const responses: Record<string, RequestPlanResult> = {};
  const sourceHealth: Array<Record<string, unknown>> = [];
  let remoteTotal = 0;
  let remoteTotalKnown = false;
  let fetchedPages = 0;
  let lastPageRowCount: number | undefined;
  let missingIdCount = 0;
  let duplicatePage = false;
  let totalZeroWithRows = false;

  if (args.mockClues?.length) {
    for (const row of args.mockClues) {
      const id = rawClueId(row, payload.adapter);
      if (!id) missingIdCount += 1;
      else if (rowById.has(id)) duplicatePage = true;
      else rowById.set(id, row);
    }
  } else {
    for (let page = 1; page <= maxPages; page += 1) {
      const body = buildClueSearchBody(args.filters, page, pageSize);
      const response = await runDoudianRequestPlan(payload, { partition: store.partition, planKey, context: bodyContext(body) });
      const responseKey = page === 1 ? planKey : `${planKey}:page:${page}`;
      responses[responseKey] = response;
      const wrapped = { [planKey]: response.data };
      const rows = firstArray(wrapped, mappingArray(payload.adapter, "clueListPaths", [
        "opportunityClueRealtimeList.data",
        "opportunityClueRealtimeList.data.data"
      ])).map(objectRecord);
      fetchedPages += 1;
      lastPageRowCount = rows.length;
      let pageNew = 0;
      let pageMissingIdCount = 0;
      let missingIdSample: unknown;
      for (const row of rows) {
        const clueId = rawClueId(row, payload.adapter);
        if (!clueId) {
          missingIdCount += 1;
          pageMissingIdCount += 1;
          missingIdSample ??= diagnosticValueShape(row);
        }
        else if (rowById.has(clueId)) duplicatePage = true;
        else {
          rowById.set(clueId, row);
          pageNew += 1;
        }
      }
      const pageRemoteTotal = readOptionalTotal(wrapped, payload.adapter, "clueTotalPaths");
      if (pageRemoteTotal !== undefined) {
        remoteTotal = pageRemoteTotal;
        remoteTotalKnown = true;
      }
      if (remoteTotalKnown && remoteTotal === 0 && rows.length > 0) totalZeroWithRows = true;
      const ok = planOk(response, payload.adapter, planKey);
      sourceHealth.push({
        key: responseKey,
        status: response.status,
        ok,
        count: rows.length,
        uniqueCount: rowById.size,
        pageNew,
        missingIdCount: pageMissingIdCount,
        missingIdSample
      });
      if (!ok || !rows.length) break;
      if (remoteTotalKnown && rowById.size >= remoteTotal) break;
      if (!pageNew) break;
    }
  }

  rawRows.push(...rowById.values());
  const rows = rawRows.map((row, rowIndex) => normalizeClue(store, row, payload.adapter, runId, rowIndex)).filter((row): row is DoudianOpportunityClueRow => Boolean(row));
  if (args.mockClues?.length) {
    remoteTotal = args.mockClues.length;
    remoteTotalKnown = true;
    fetchedPages = 1;
    lastPageRowCount = args.mockClues.length;
    sourceHealth.push({ key: `${planKey}:mock`, status: 200, ok: true, count: args.mockClues.length, uniqueCount: rowById.size });
  }
  const coverage = evaluateInputScanCoverage({
    requestFailed: !sourceHealth.length || sourceHealth.some((item) => item.ok !== true),
    schemaMismatch: missingIdCount > 0 || (rawRows.length > 0 && rows.length !== rawRows.length),
    fetchedCount: rows.length,
    uniqueFetchedCount: rowById.size,
    remoteTotal: remoteTotalKnown ? remoteTotal : undefined,
    remoteTotalKnown,
    fetchedPages,
    maxPages,
    pageSize,
    lastPageRowCount,
    duplicatePage,
    totalZeroWithRows
  });
  const ok = coverage.status !== "failed";
  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? "ok" : "failed",
    ok,
    message: ok
      ? policyMessage(payload.adapter, "opportunityReport.messages.clueScannedStore", "Opportunity clues scanned", { count: rows.length })
      : responseMessage(Object.values(responses)[0]) || policyMessage(payload.adapter, "opportunityReport.messages.clueScanFailed", "Opportunity clue scan failed"),
    reason: ok ? "" : "opportunity-clue-scan-failed",
    category: ok ? "" : "api",
    diagnostic: {
      remoteTotal,
      remoteTotalKnown,
      scanStatus: coverage.status,
      fetchedPages,
      rowCount: rows.length,
      sourceHealth
    },
    index,
    total
  };
  return { rows, detail, sourceHealth, remoteTotal, remoteTotalKnown, scanStatus: coverage.status, fetchedPages, nextPage: coverage.nextPage };
}

async function scanProductsForStore(
  payload: DoudianAdapterPayload,
  store: DoudianStoreSummary,
  args: OpportunityArgs,
  runId: string,
  index: number,
  total: number,
  extra: Partial<DoudianOpportunityProductRow> = {},
  categoryLeafId = ""
) {
  const planKey = "opportunityProductList";
  const pageSize = Math.max(10, Math.min(200, Math.floor(Number(args.pageSize || args.filters?.pageSize || policyNumber(payload.adapter, "opportunityReport.productPageSize", 100, 10, 200)))));
  const maxPages = Math.max(1, Math.min(500, Math.floor(Number(args.maxPages || args.filters?.maxPages || policyNumber(payload.adapter, "opportunityReport.maxProductListPages", 100, 1, 500)))));
  const pageStart = policyNumber(payload.adapter, "opportunityReport.productPageStart", 0, 0, 1);
  const rawRows: Record<string, unknown>[] = [];
  const rowById = new Map<string, Record<string, unknown>>();
  const sourceHealth: Array<Record<string, unknown>> = [];
  let remoteTotal = 0;
  let remoteTotalKnown = false;
  let fetchedPages = 0;
  let lastPageRowCount: number | undefined;
  let missingIdCount = 0;
  let duplicateIdCount = 0;
  let duplicatePage = false;
  let totalZeroWithRows = false;

  if (args.mockProducts?.length) {
    for (const row of args.mockProducts) {
      const productId = rawMappedId(row, payload.adapter, "productId", ["product_id", "productId", "goods_id", "goodsId", "id"]);
      if (!productId) missingIdCount += 1;
      else if (rowById.has(productId)) duplicatePage = true;
      else rowById.set(productId, row);
    }
    remoteTotal = args.mockProducts.length;
    remoteTotalKnown = true;
    fetchedPages = 1;
    lastPageRowCount = args.mockProducts.length;
    sourceHealth.push({ key: `${planKey}:mock`, status: 200, ok: true, count: args.mockProducts.length });
  } else {
    for (let page = pageStart; page < pageStart + maxPages; page += 1) {
      const shouldCancel = () => pipelineCancelled(args);
      assertNotCancelled(shouldCancel);
      const context = productListContext(args.filters, page, pageSize, categoryLeafId);
      const response = await runDoudianRequestPlan(payload, { partition: store.partition, planKey, context, shouldCancel });
      const responseKey = page === pageStart ? planKey : `${planKey}:page:${page}`;
      const wrapped = { [planKey]: response.data };
      const rows = firstArray(wrapped, mappingArray(payload.adapter, "productListPaths", [
        "opportunityProductList.data",
        "opportunityProductList.data.list",
        "opportunityProductList.list"
      ])).map(objectRecord);
      fetchedPages += 1;
      lastPageRowCount = rows.length;
      let pageNew = 0;
      for (const row of rows) {
        const productId = rawMappedId(row, payload.adapter, "productId", ["product_id", "productId", "goods_id", "goodsId", "id"]);
        if (!productId) missingIdCount += 1;
        else if (rowById.has(productId)) duplicatePage = true;
        else {
          rowById.set(productId, row);
          pageNew += 1;
        }
      }
      const pageRemoteTotal = readOptionalTotal(wrapped, payload.adapter, "productTotalPaths");
      if (pageRemoteTotal !== undefined) {
        remoteTotal = pageRemoteTotal;
        remoteTotalKnown = true;
      }
      if (remoteTotalKnown && remoteTotal === 0 && rows.length > 0) totalZeroWithRows = true;
      const ok = planOk(response, payload.adapter, planKey);
      sourceHealth.push({ key: responseKey, status: response.status, ok, count: rows.length, uniqueCount: rowById.size, pageNew });
      if (!ok || !rows.length) break;
      if (remoteTotalKnown && rowById.size >= remoteTotal) break;
      if (!pageNew) break;
    }
  }

  rawRows.push(...rowById.values());
  const products = rawRows
    .map((row, rowIndex) => normalizeProduct(store, row, payload.adapter, runId, rowIndex, extra))
    .filter((row): row is DoudianOpportunityProductRow => Boolean(row));
  const categoryDiagnostic = productCategoryParseDiagnostic(rawRows, products, payload.adapter, remoteTotal, sourceHealth);
  if (categoryDiagnostic.missingCategoryIdWithCategoryCount > 0 || (products.length > 0 && categoryDiagnostic.categoryIdCount === 0)) {
    await reportOpportunityPipelineDiagnostic("product-category-id-scan", {
      runId,
      shopId: store.shopId,
      shopName: store.shopName,
      partition: store.partition,
      categoryLeafId,
      diagnostic: categoryDiagnostic
    });
  }
  const requestFailed = !sourceHealth.length || sourceHealth.some((item) => item.ok !== true);
  const schemaMismatch = missingIdCount > 0 || (rawRows.length > 0 && products.length !== rawRows.length);
  const coverageResult = evaluateInputScanCoverage({
    requestFailed,
    schemaMismatch,
    fetchedCount: products.length,
    uniqueFetchedCount: rowById.size,
    remoteTotal: remoteTotalKnown ? remoteTotal : undefined,
    remoteTotalKnown,
    fetchedPages,
    maxPages,
    pageSize,
    lastPageRowCount,
    duplicatePage,
    totalZeroWithRows
  });
  const productScanStatus = coverageResult.status;
  const ok = productScanStatus !== "failed";
  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? "ok" : "failed",
    ok,
    message: ok
      ? policyMessage(payload.adapter, "opportunityReport.messages.productScannedStore", "Opportunity products scanned", { count: products.length })
      : policyMessage(payload.adapter, "opportunityReport.messages.productScanFailed", "Opportunity product scan failed"),
    reason: ok ? "" : "opportunity-product-scan-failed",
    category: ok ? "" : "api",
    diagnostic: {
      remoteTotal,
      remoteTotalKnown,
      productScanStatus,
      fetchedPages,
      nextPage: productScanStatus === "truncated" ? pageStart + fetchedPages : undefined,
      productCount: products.length,
      sourceHealth
    },
    index,
    total
  };
  return {
    products,
    detail,
    sourceHealth,
    remoteTotal,
    remoteTotalKnown,
    scanStatus: productScanStatus,
    fetchedPages,
    nextPage: productScanStatus === "truncated" ? pageStart + fetchedPages : undefined
  };
}

function submitHistoryListBody(window: { startEpochSeconds: number; endEpochSeconds: number }, page: number, pageSize: number) {
  return {
    condition: {
      clue_channel: "",
      item_info: "",
      gmt_start_time: window.startEpochSeconds,
      gmt_end_time: window.endEpochSeconds,
      status_list: [0, 1, 2, 3, 4, 5, 6]
    },
    page: { current: page, page_size: pageSize }
  };
}

function submitHistoryResponseOk(response: RequestPlanResult, adapter: DoudianAdapterConfig, planKey: string) {
  if (!planOk(response, adapter, planKey)) return false;
  return isSubmitHistoryBusinessSuccess(response.data);
}

function submitHistoryThrottlePolicy(adapter: DoudianAdapterConfig) {
  const multiplierValue = Number(policy(adapter, "opportunityReport.submitHistoryThrottleMultiplier", 1.5));
  return {
    requestSpacingMs: policyNumber(adapter, "opportunityReport.submitHistoryRequestSpacingMs", 1500, 0, 60_000),
    initialCooldownMs: policyNumber(adapter, "opportunityReport.submitHistoryThrottleInitialCooldownMs", 60_000, 10_000, 10 * 60_000),
    maxCooldownMs: policyNumber(adapter, "opportunityReport.submitHistoryThrottleMaxCooldownMs", 300_000, 10_000, 30 * 60_000),
    multiplier: Number.isFinite(multiplierValue) ? Math.max(1, Math.min(4, multiplierValue)) : 1.5
  };
}

async function runSubmitHistoryRequest(
  payload: DoudianAdapterPayload,
  store: DoudianStoreSummary,
  args: OpportunityArgs,
  planKey: string,
  body: Record<string, unknown>
) {
  const previous = submitHistoryRequestTail;
  let release: () => void = () => undefined;
  submitHistoryRequestTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    const shouldCancel = () => pipelineCancelled(args);
    const waitMs = Math.max(0, submitHistoryGlobalThrottle.nextEligibleAtMs - Date.now());
    if (waitMs > 0) await cancellableWait(waitMs, shouldCancel);
    const response = await runDoudianRequestPlan(payload, {
      partition: store.partition,
      planKey,
      context: bodyContext(body),
      shouldCancel,
      maxAttempts: 1
    });
    const parsedBusiness = submitHistoryBusinessFacts(response.data);
    const business = response.status === 429 && !parsedBusiness.busy
      ? { found: true, ok: false, code: "429", message: response.error || "HTTP 429", busy: true }
      : parsedBusiness;
    const outcome = business.busy
      ? "busy" as const
      : submitHistoryResponseOk(response, payload.adapter, planKey)
        ? "success" as const
        : "failure" as const;
    submitHistoryGlobalThrottle = advanceSubmitHistoryThrottle(
      submitHistoryGlobalThrottle,
      outcome,
      Date.now(),
      submitHistoryThrottlePolicy(payload.adapter)
    );
    return {
      response,
      business,
      throttleResumeAt: business.busy ? new Date(submitHistoryGlobalThrottle.nextEligibleAtMs).toISOString() : undefined
    };
  } finally {
    release();
  }
}

function submitHistoryRecordId(identity: PipelineStoreIdentity, remoteRecordId: string) {
  return `${storeScopeId(identity)}-record-${encodeURIComponent(remoteRecordId)}`;
}

function normalizeSubmitHistoryRecord(identity: PipelineStoreIdentity, raw: Record<string, unknown>, fetchedAt: string): SubmitHistoryRecord | null {
  const snapshot = parseSubmitHistorySnapshot(raw);
  if (!snapshot) return null;
  return {
    id: submitHistoryRecordId(identity, snapshot.remoteRecordId),
    ...identity,
    ...snapshot,
    fetchedAt,
    updatedAt: fetchedAt
  } satisfies SubmitHistoryRecord;
}

async function compactSubmitHistoryRawRecords(identity: PipelineStoreIdentity, maxRecords: number) {
  const syncId = `${storeScopeId(identity)}-sync`;
  const sync = await repositoryGet<SubmitHistorySyncRecord>(submitHistorySyncStore, syncId).catch(() => null);
  if (!sync || sync.historyCompactionCompletedAt) {
    return { scannedCount: 0, compactedCount: 0, complete: Boolean(sync?.historyCompactionCompletedAt) };
  }
  const prefix = `${storeScopeId(identity)}-`;
  const page = await repositoryListByPrefix<SubmitHistoryRecord>(submitHistoryRecordStore, prefix, {
    cursor: sync.historyCompactionCursor || null,
    pageSize: Math.max(1, Math.min(500, Math.floor(Number(maxRecords || 500))))
  });
  const compacted = page.items.flatMap((record) => {
    if (!record.raw) return [];
    const { raw: _raw, ...canonical } = record;
    return [canonical as SubmitHistoryRecord];
  });
  if (compacted.length) await repositoryPutMany(submitHistoryRecordStore, compacted, { concurrency: 2 });
  const compactedAt = nowIso();
  await repositoryPut(submitHistorySyncStore, {
    ...sync,
    historyCompactionCursor: page.hasMore ? text(page.nextCursor) || sync.historyCompactionCursor : undefined,
    historyCompactionCompletedAt: page.hasMore ? undefined : compactedAt,
    updatedAt: compactedAt
  });
  return { scannedCount: page.items.length, compactedCount: compacted.length, complete: !page.hasMore };
}

async function mergeSubmitHistoryIndexes(
  identity: PipelineStoreIdentity,
  records: SubmitHistoryRecord[],
  previousRecords: SubmitHistoryRecord[] = []
) {
  if (!records.length) return;
  const prefix = `${storeScopeId(identity)}-`;
  const existing = await repositoryGetAllByPrefix<BenefitProductIndexRecord>(submitHistoryProductIndexStore, prefix, { pageSize: 500, maxItems: 500000 }).catch(() => []);
  const byProduct = new Map(existing.map((record) => [record.productId, record]));
  const touched = new Map<string, BenefitProductIndexRecord>();
  for (const record of records) {
    const current = touched.get(record.productId) || byProduct.get(record.productId) || {
      id: `${prefix}product-${encodeURIComponent(record.productId)}`,
      ...identity,
      productId: record.productId,
      associatedClueIds: [],
      associatedClueCount: 0,
      remainingClueCapacity: SUBMIT_HISTORY_CLUE_CAPACITY,
      submissionRecordIds: [],
      sourceRecordCount: 0,
      acquiredProfitIds: [],
      unacquiredProfitIds: [],
      acquiredExposure: 0,
      estimatedExposure: 0,
      sourceStatus: "complete" as const,
      fetchedAt: record.fetchedAt,
      updatedAt: record.updatedAt
    } satisfies BenefitProductIndexRecord;
    const clueIds = new Set(current.associatedClueIds || []);
    clueIds.add(record.clueId);
    const recordIds = new Set(current.submissionRecordIds || []);
    recordIds.add(record.remoteRecordId);
    const associatedClueIds = Array.from(clueIds);
    const capacity = submitHistoryCapacityFacts(associatedClueIds, recordIds, current.saturatedByRemoteError === true);
    touched.set(record.productId, {
      ...current,
      associatedClueIds,
      associatedClueCount: associatedClueIds.length,
      remainingClueCapacity: capacity.remainingClueCapacity,
      submissionRecordIds: Array.from(recordIds),
      sourceRecordCount: recordIds.size,
      updatedAt: record.updatedAt
    });
  }

  const incomingByRemoteId = new Map(records.map((record) => [record.remoteRecordId, record]));
  const previousByRemoteId = new Map(previousRecords.map((record) => [record.remoteRecordId, record]));
  const changedProductIds = new Set<string>();
  for (const record of records) {
    const previousRecord = previousByRemoteId.get(record.remoteRecordId);
    if (!previousRecord) continue;
    if (previousRecord.productId !== record.productId || previousRecord.clueId !== record.clueId) {
      changedProductIds.add(previousRecord.productId);
      changedProductIds.add(record.productId);
    }
  }

  const deleteIndexIds: string[] = [];
  for (const productId of changedProductIds) {
    const current = touched.get(productId) || byProduct.get(productId);
    if (!current) continue;
    const remoteRecordIds = uniqueText([
      ...(current.submissionRecordIds || []),
      ...records.filter((record) => record.productId === productId).map((record) => record.remoteRecordId)
    ]);
    const persisted = remoteRecordIds.length
      ? await repositoryGetMany<SubmitHistoryRecord>(
          submitHistoryRecordStore,
          remoteRecordIds.map((remoteRecordId) => submitHistoryRecordId(identity, remoteRecordId))
        ).catch(() => [])
      : [];
    const afterByRemoteId = new Map(persisted.map((record) => [record.remoteRecordId, record]));
    const beforeByRemoteId = new Map(afterByRemoteId);
    for (const remoteRecordId of incomingByRemoteId.keys()) {
      const previousRecord = previousByRemoteId.get(remoteRecordId);
      if (previousRecord) beforeByRemoteId.set(remoteRecordId, previousRecord);
      else beforeByRemoteId.delete(remoteRecordId);
    }
    const backedClueIdsBefore = new Set(Array.from(beforeByRemoteId.values())
      .filter((record) => record.productId === productId)
      .map((record) => record.clueId));
    const optimisticClueIds = (current.associatedClueIds || []).filter((clueId) => !backedClueIdsBefore.has(clueId));
    const currentRecords = Array.from(afterByRemoteId.values()).filter((record) => record.productId === productId);
    const associatedClueIds = uniqueText([...optimisticClueIds, ...currentRecords.map((record) => record.clueId)]);
    const submissionRecordIds = uniqueText(currentRecords.map((record) => record.remoteRecordId));
    if (!associatedClueIds.length && !submissionRecordIds.length && current.saturatedByRemoteError !== true) {
      touched.delete(productId);
      deleteIndexIds.push(current.id);
      continue;
    }
    const capacity = submitHistoryCapacityFacts(associatedClueIds, submissionRecordIds, current.saturatedByRemoteError === true);
    touched.set(productId, {
      ...current,
      associatedClueIds,
      associatedClueCount: associatedClueIds.length,
      remainingClueCapacity: capacity.remainingClueCapacity,
      submissionRecordIds,
      sourceRecordCount: submissionRecordIds.length,
      updatedAt: records.find((record) => record.productId === productId)?.updatedAt || current.updatedAt
    });
  }
  await repositoryPutMany(submitHistoryProductIndexStore, Array.from(touched.values()), { concurrency: 2 });
  if (deleteIndexIds.length) await repositoryDeleteMany(submitHistoryProductIndexStore, deleteIndexIds);
}

async function persistSubmitHistoryBatch(identity: PipelineStoreIdentity, records: SubmitHistoryRecord[]) {
  if (!records.length) return { insertedCount: 0 };
  const recordIds = records.map((record) => record.id);
  const previousRecords = await repositoryGetMany<SubmitHistoryRecord>(submitHistoryRecordStore, recordIds).catch(() => []);
  const existingIds = new Set(previousRecords.map((record) => record.id));
  await repositoryPutMany(submitHistoryRecordStore, records, { concurrency: 2 });
  await mergeSubmitHistoryIndexes(identity, records, previousRecords);
  return { insertedCount: records.filter((record) => !existingIds.has(record.id)).length };
}

async function fetchSubmitHistoryWindow(
  payload: DoudianAdapterPayload,
  store: DoudianStoreSummary,
  args: OpportunityArgs,
  window: { startEpochSeconds: number; endEpochSeconds: number },
  options: { startPage?: number; pageBatchSize?: number; remoteTotal?: number } = {}
) {
  const planKey = "opportunitySubmitHistoryList";
  const pageSize = policyNumber(payload.adapter, "opportunityReport.submitHistoryPageSize", 100, 10, 200);
  const maxPages = policyNumber(payload.adapter, "opportunityReport.maxSubmitHistoryPagesPerWindow", 1000, 1, 2000);
  const pageRange = submitHistoryPageBatchRange(options.startPage || 1, maxPages, options.pageBatchSize || maxPages);
  const pageDelayMs = policyNumber(payload.adapter, "opportunityReport.submitHistoryPageDelayMs", 150, 0, 5000);
  const rowsById = new Map<string, Record<string, unknown>>();
  const sourceHealth: Array<Record<string, unknown>> = [];
  let remoteTotal = Number.isFinite(Number(options.remoteTotal)) ? Math.max(0, Math.floor(Number(options.remoteTotal))) : 0;
  let remoteTotalKnown = Number.isFinite(Number(options.remoteTotal));
  let fetchedPages = 0;
  let requestFailed = false;
  let schemaMismatch = false;
  let schemaMismatchCount = 0;
  let rawRowCount = 0;
  let duplicateRecordCount = 0;
  let duplicatePage = false;
  let totalZeroWithRows = false;
  let endReached = false;
  let businessBusyCount = 0;
  let lastBusinessCode = "";
  let lastBusinessMessage = "";
  let throttleResumeAt: string | undefined;
  let lastSuccessfulPage = pageRange.startPage - 1;
  let failedPage: number | undefined;
  const schemaSamples: Array<Record<string, unknown>> = [];
  for (let page = pageRange.startPage; page <= pageRange.endPage; page += 1) {
    const shouldCancel = () => pipelineCancelled(args);
    assertNotCancelled(shouldCancel);
    const body = submitHistoryListBody(window, page, pageSize);
    try {
      const request = await runSubmitHistoryRequest(payload, store, args, planKey, body);
      const response = request.response;
      const wrapped = { [planKey]: response.data };
      const rows = firstArray(wrapped, mappingArray(payload.adapter, "submitHistoryListPaths", [
        "opportunitySubmitHistoryList.data",
        "opportunitySubmitHistoryList.data.list",
        "opportunitySubmitHistoryList.list"
      ])).map(objectRecord);
      const ok = submitHistoryResponseOk(response, payload.adapter, planKey);
      const business = request.business;
      rawRowCount += rows.length;
      fetchedPages += 1;
      const pageTotal = readOptionalTotal(wrapped, payload.adapter, "submitHistoryTotalPaths");
      if (ok && pageTotal !== undefined) {
        remoteTotal = Math.max(remoteTotal, pageTotal);
        remoteTotalKnown = true;
      }
      if (ok && pageTotal === 0 && rows.length) totalZeroWithRows = true;
      const parsedRows: Array<{ remoteRecordId: string; row: Record<string, unknown> }> = [];
      const pageRecordIds = new Set<string>();
      let pageSchemaMismatchCount = 0;
      let pageNew = 0;
      for (const row of rows) {
        const snapshot = parseSubmitHistorySnapshot(row);
        if (!snapshot) {
          schemaMismatch = true;
          schemaMismatchCount += 1;
          pageSchemaMismatchCount += 1;
          if (schemaSamples.length < 5) schemaSamples.push({ page, shape: diagnosticValueShape(row) });
          continue;
        }
        if (rowsById.has(snapshot.remoteRecordId) || pageRecordIds.has(snapshot.remoteRecordId)) {
          duplicateRecordCount += 1;
        } else {
          pageRecordIds.add(snapshot.remoteRecordId);
          parsedRows.push({ remoteRecordId: snapshot.remoteRecordId, row });
          pageNew += 1;
        }
      }
      if (business.busy) {
        businessBusyCount += 1;
        lastBusinessCode = business.code;
        lastBusinessMessage = business.message;
        throttleResumeAt = request.throttleResumeAt;
      }
      sourceHealth.push({
        key: page === 1 ? planKey : `${planKey}:page:${page}`,
        status: response.status,
        ok,
        count: rows.length,
        uniqueCount: rowsById.size + pageNew,
        pageNew,
        duplicateRecordCount,
        pageTotal,
        businessCode: business.code,
        businessMessage: business.message,
        businessBusy: business.busy
      });
      const pageReachesEnd = submitHistoryPageReachesEnd(page, pageSize, rows.length, remoteTotalKnown ? remoteTotal : undefined);
      if (!ok || pageSchemaMismatchCount > 0 || totalZeroWithRows || (!rows.length && remoteTotalKnown && !pageReachesEnd)) {
        requestFailed = true;
        failedPage = page;
        break;
      }
      if (rows.length > 0 && !pageNew) {
        duplicatePage = true;
        requestFailed = true;
        failedPage = page;
        break;
      }
      for (const parsed of parsedRows) rowsById.set(parsed.remoteRecordId, parsed.row);
      lastSuccessfulPage = page;
      if (pageReachesEnd) {
        endReached = true;
        break;
      }
      if (pageDelayMs > 0 && page < pageRange.endPage) await cancellableWait(pageDelayMs, shouldCancel);
    } catch (error) {
      requestFailed = true;
      failedPage = page;
      sourceHealth.push({ key: page === 1 ? planKey : `${planKey}:page:${page}`, status: 0, ok: false, error: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  const batchBoundaryReached = !requestFailed
    && !schemaMismatch
    && !duplicatePage
    && !totalZeroWithRows
    && !endReached
    && lastSuccessfulPage >= pageRange.endPage;
  const status = evaluateSubmitHistoryPageCoverage({
    requestFailed: requestFailed || !sourceHealth.length || sourceHealth.some((item) => item.ok !== true),
    schemaMismatch,
    duplicatePage,
    totalZeroWithRows,
    endReached,
    fetchedPages,
    maxPages: pageRange.endPage - pageRange.startPage + 1
  });
  const fetchedAt = nowIso();
  const records = Array.from(rowsById.values())
    .map((row) => normalizeSubmitHistoryRecord(normalizePipelineStoreIdentity(store), row, fetchedAt))
    .filter((record): record is SubmitHistoryRecord => Boolean(record));
  const normalizedRecords = records.length === rowsById.size;
  const finalStatus = normalizedRecords ? status : "failed" as const;
  const nextPage = finalStatus === "complete"
    ? undefined
    : finalStatus === "failed"
      ? failedPage || Math.max(pageRange.startPage, lastSuccessfulPage + 1)
      : lastSuccessfulPage < maxPages
        ? lastSuccessfulPage + 1
        : undefined;
  return {
    status: finalStatus,
    records,
    sourceHealth: [...sourceHealth, { key: "opportunitySubmitHistorySchema", ok: !schemaMismatch && normalizedRecords, rawRowCount, parsedRecordCount: records.length, schemaMismatchCount, schemaSamples }],
    remoteTotal,
    remoteTotalKnown,
    fetchedPages,
    businessBusyCount,
    lastBusinessCode,
    lastBusinessMessage,
    throttleResumeAt,
    startPage: pageRange.startPage,
    endPage: pageRange.endPage,
    lastSuccessfulPage,
    failedPage,
    nextPage,
    batchBoundaryReached,
    diagnostic: { status: finalStatus, window, startPage: pageRange.startPage, endPage: pageRange.endPage, lastSuccessfulPage, failedPage, nextPage, batchBoundaryReached, rawRowCount, parsedRecordCount: records.length, remoteTotal: remoteTotalKnown ? remoteTotal : undefined, remoteTotalKnown, endReached, requestFailed, schemaMismatch, schemaMismatchCount, duplicatePage, duplicateRecordCount, totalZeroWithRows, businessBusyCount, lastBusinessCode, lastBusinessMessage, throttleResumeAt }
  };
}

async function scanBenefitProductsForStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, args: OpportunityArgs) {
  const identity = normalizePipelineStoreIdentity(store);
  const shopLabel = identity.shopName || identity.shopId;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const initialLookbackDays = policyNumber(payload.adapter, "opportunityReport.submitHistoryInitialLookbackDays", 30, 1, 3650);
  const configuredInitialStart = submitHistoryInitialStart(nowSeconds, initialLookbackDays);
  const prewarmSlice = args.mode === "history-prewarm";
  const windowDays = prewarmSlice
    ? policyNumber(payload.adapter, "opportunityReport.submitHistoryPrewarmWindowDays", 1, 1, 31)
    : policyNumber(payload.adapter, "opportunityReport.submitHistoryWindowDays", 31, 1, 366);
  const overlapSeconds = policyNumber(payload.adapter, "opportunityReport.submitHistoryIncrementalOverlapSeconds", 86400, 0, 31 * 86400);
  const pageSize = policyNumber(payload.adapter, "opportunityReport.submitHistoryPageSize", 100, 10, 200);
  const checkpointPageBatchSize = policyNumber(payload.adapter, "opportunityReport.submitHistoryCheckpointPageBatchSize", 10, 1, 100);
  const syncId = `${storeScopeId(identity)}-sync`;
  const previous = await repositoryGet<SubmitHistorySyncRecord>(submitHistorySyncStore, syncId).catch(() => null);
  const initialStart = previous && !previous.initialized && previous.initialStartEpochSeconds > 0
    ? previous.initialStartEpochSeconds
    : configuredInitialStart;
  const throttleRecoveryEnabled = !prewarmSlice && policyBoolean(payload.adapter, "opportunityReport.submitHistoryThrottleRecoveryEnabled", true);
  const throttleRecoveryBudgetMs = policyNumber(payload.adapter, "opportunityReport.submitHistoryThrottleRecoveryBudgetMs", 30 * 60_000, 60_000, 2 * 60 * 60_000);
  const throttleRecoveryDeadlineMs = Date.now() + throttleRecoveryBudgetMs;
  let throttleRecoveryCount = 0;
  const storedCheckpointNextPage = Math.max(1, Math.floor(Number(previous?.checkpointNextPage) || 1));
  const previousResumeAtMs = Date.parse(String(previous?.resumeAt || ""));
  if (throttleRecoveryEnabled && previous?.status === "cooling_down" && Number.isFinite(previousResumeAtMs) && previousResumeAtMs > Date.now()) {
    const diagnosticRunId = text(args.runId || args.operationId);
    if (diagnosticRunId) await writePipelineEvent({
      runId: diagnosticRunId,
      shopId: identity.shopId,
      level: "warn",
      event: "pipeline-submit-history-waiting",
      message: "提报历史校验正在等待平台限流恢复",
      detail: { resumeAt: previous.resumeAt, checkpointNextPage: storedCheckpointNextPage, businessCode: previous.lastBusinessCode, businessMessage: previous.lastBusinessMessage }
    }).catch(() => undefined);
    await waitForSubmitHistoryCooldown(args, previousResumeAtMs, shopLabel, storedCheckpointNextPage);
  }
  const isInitial = !previous || !previous.initialized;
  const startEpochSeconds = isInitial
    ? Math.max(initialStart, previous?.initialCursorStartEpochSeconds || initialStart)
    : Math.max(initialStart, Math.floor(previous.watermarkMs / 1000) - overlapSeconds);
  const checkpointWindowStart = Math.floor(Number(previous?.checkpointWindowStartEpochSeconds));
  const checkpointWindowEnd = Math.floor(Number(previous?.checkpointWindowEndEpochSeconds));
  const hasWindowCheckpoint = Number.isFinite(checkpointWindowStart)
    && Number.isFinite(checkpointWindowEnd)
    && checkpointWindowStart >= startEpochSeconds
    && checkpointWindowStart <= nowSeconds
    && checkpointWindowEnd >= checkpointWindowStart
    && storedCheckpointNextPage > 1;
  let allWindows = submitHistoryWindows(startEpochSeconds, nowSeconds, windowDays);
  if (hasWindowCheckpoint) {
    const resumedWindow = {
      startEpochSeconds: checkpointWindowStart,
      endEpochSeconds: Math.min(nowSeconds, checkpointWindowEnd)
    };
    allWindows = [
      resumedWindow,
      ...submitHistoryWindows(resumedWindow.endEpochSeconds + 1, nowSeconds, windowDays)
    ];
  }
  const maxWindows = prewarmSlice && isInitial
    ? policyNumber(payload.adapter, "opportunityReport.submitHistoryPrewarmMaxWindowsPerRun", 1, 1, 31)
    : allWindows.length;
  const windows = allWindows.slice(0, maxWindows);
  let recordCount = previous?.recordCount || 0;
  let fetchedPages = 0;
  let remoteTotal = 0;
  let remoteTotalKnown = false;
  let businessBusyCount = 0;
  let remoteUpdatedAtWatermarkMs = Math.max(0, Number(previous?.remoteUpdatedAtWatermarkMs || 0));
  const remoteTotalByWindow = new Map<string, number>();
  const sourceHealth: Array<Record<string, unknown>> = [];
  for (const window of windows) {
    const windowKey = `${window.startEpochSeconds}-${window.endEpochSeconds}`;
    const resumesStoredWindow = hasWindowCheckpoint
      && window.startEpochSeconds === checkpointWindowStart
      && window.endEpochSeconds === Math.min(nowSeconds, checkpointWindowEnd);
    let windowNextPage = resumesStoredWindow ? storedCheckpointNextPage : 1;
    let windowRemoteTotal = resumesStoredWindow && Number.isFinite(Number(previous?.checkpointRemoteTotal))
      ? Math.max(0, Math.floor(Number(previous?.checkpointRemoteTotal)))
      : undefined;
    if (windowRemoteTotal !== undefined) remoteTotalByWindow.set(windowKey, windowRemoteTotal);
    let windowThrottleRecoveryCount = 0;
    while (true) {
      const result = await fetchSubmitHistoryWindow(payload, store, args, window, {
        startPage: windowNextPage,
        pageBatchSize: checkpointPageBatchSize,
        remoteTotal: windowRemoteTotal
      });
      fetchedPages += result.fetchedPages;
      if (result.remoteTotalKnown) {
        windowRemoteTotal = result.remoteTotal;
        remoteTotalByWindow.set(windowKey, result.remoteTotal);
      }
      remoteTotal = Array.from(remoteTotalByWindow.values()).reduce((sum, value) => sum + value, 0);
      remoteTotalKnown = remoteTotalByWindow.size > 0;
      businessBusyCount += result.businessBusyCount;
      const evidenceByKey = new Map<string, Record<string, unknown>>();
      for (const item of [result.sourceHealth[0], ...result.sourceHealth.filter((entry) => entry.ok === false), ...result.sourceHealth.slice(-5)]) {
        if (item) evidenceByKey.set(text(item.key), item);
      }
      const windowDiagnostic = { ...result.diagnostic, mode: isInitial ? "initial" : "incremental", requestEvidence: Array.from(evidenceByKey.values()) };
      sourceHealth.push(windowDiagnostic);
      await reportDoudianDiagnostic({ category: "opportunity-pipeline", event: "submit-history-window", runId: args.runId || args.operationId, shopId: identity.shopId, ...windowDiagnostic }, true).catch(() => undefined);
      remoteUpdatedAtWatermarkMs = submitHistoryRemoteUpdatedAtWatermark(result.records, remoteUpdatedAtWatermarkMs);
      const persisted = await persistSubmitHistoryBatch(identity, result.records);
      recordCount += persisted.insertedCount;
      const checkpointNextPage = result.nextPage || windowNextPage;
      const totalPages = windowRemoteTotal === undefined ? undefined : Math.max(1, Math.ceil(windowRemoteTotal / pageSize));
      if (result.lastSuccessfulPage >= result.startPage) {
        const progressDetail = {
          mode: isInitial ? "initial" : "incremental",
          window,
          batchStartPage: result.startPage,
          lastSuccessfulPage: result.lastSuccessfulPage,
          checkpointNextPage,
          totalPages,
          batchRecordCount: result.records.length,
          persistedRecordCount: recordCount
        };
        const progressMessage = `同步提报历史：${shopLabel}，已保存第 ${result.lastSuccessfulPage}${totalPages ? `/${totalPages}` : ""} 页`;
        dispatchPipelineProgress(args, 15, progressMessage);
        await reportDoudianDiagnostic({ category: "opportunity-pipeline", event: "submit-history-progress", runId: args.runId || args.operationId, shopId: identity.shopId, ...progressDetail }, true).catch(() => undefined);
        const diagnosticRunId = text(args.runId || args.operationId);
        if (diagnosticRunId) await writePipelineEvent({
          runId: diagnosticRunId,
          shopId: identity.shopId,
          level: "info",
          event: "pipeline-submit-history-progress",
          message: progressMessage,
          detail: progressDetail
        }).catch(() => undefined);
      }
      if (result.status === "truncated" && result.nextPage) {
        const checkpointAt = nowIso();
        await repositoryPut(submitHistorySyncStore, {
          id: syncId,
          ...identity,
          initialized: previous?.initialized === true,
          status: "truncated",
          initialStartEpochSeconds: initialStart,
          initialCursorStartEpochSeconds: isInitial ? window.startEpochSeconds : startEpochSeconds,
          watermarkMs: previous?.watermarkMs || 0,
          remoteUpdatedAtWatermarkMs,
          recordCount,
          lastMode: isInitial ? "initial" : "incremental",
          checkpointWindowStartEpochSeconds: window.startEpochSeconds,
          checkpointWindowEndEpochSeconds: window.endEpochSeconds,
          checkpointNextPage: result.nextPage,
          checkpointRemoteTotal: windowRemoteTotal,
          historyCompactionCursor: previous?.historyCompactionCursor,
          historyCompactionCompletedAt: previous?.historyCompactionCompletedAt,
          createdAt: previous?.createdAt || checkpointAt,
          updatedAt: checkpointAt
        } satisfies SubmitHistorySyncRecord);
        windowNextPage = result.nextPage;
        continue;
      }
      if (result.status !== "complete") {
        const resumeAtMs = Date.parse(String(result.throttleResumeAt || ""));
        const canRecoverThrottle = throttleRecoveryEnabled
          && result.businessBusyCount > 0
          && Number.isFinite(resumeAtMs)
          && resumeAtMs <= throttleRecoveryDeadlineMs;
        if (canRecoverThrottle) {
          throttleRecoveryCount += 1;
          windowThrottleRecoveryCount += 1;
          const coolingAt = nowIso();
          const resumeAt = new Date(resumeAtMs).toISOString();
          await repositoryPut(submitHistorySyncStore, {
            id: syncId,
            ...identity,
            initialized: previous?.initialized === true,
            status: "cooling_down",
            initialStartEpochSeconds: initialStart,
            initialCursorStartEpochSeconds: isInitial ? window.startEpochSeconds : startEpochSeconds,
            watermarkMs: previous?.watermarkMs || 0,
            remoteUpdatedAtWatermarkMs,
            recordCount,
            lastMode: isInitial ? "initial" : "incremental",
            lastError: "submit history throttled",
            resumeAt,
            throttleAttemptCount: throttleRecoveryCount,
            lastBusinessCode: result.lastBusinessCode,
            lastBusinessMessage: result.lastBusinessMessage,
            checkpointWindowStartEpochSeconds: window.startEpochSeconds,
            checkpointWindowEndEpochSeconds: window.endEpochSeconds,
            checkpointNextPage,
            checkpointRemoteTotal: windowRemoteTotal,
            historyCompactionCursor: previous?.historyCompactionCursor,
            historyCompactionCompletedAt: previous?.historyCompactionCompletedAt,
            createdAt: previous?.createdAt || coolingAt,
            updatedAt: coolingAt
          } satisfies SubmitHistorySyncRecord);
          const waitSeconds = Math.max(1, Math.ceil((resumeAtMs - Date.now()) / 1000));
          const diagnosticRunId = text(args.runId || args.operationId);
          const throttleDetail = {
            status: "cooling_down",
            businessCode: result.lastBusinessCode,
            businessMessage: result.lastBusinessMessage,
            resumeAt,
            waitSeconds,
            checkpointNextPage,
            lastSuccessfulPage: result.lastSuccessfulPage,
            persistedRecordCount: recordCount,
            throttleAttemptCount: throttleRecoveryCount,
            throttleRecoveryBudgetMs
          };
          await reportDoudianDiagnostic({ category: "opportunity-pipeline", event: "submit-history-throttled", runId: diagnosticRunId, shopId: identity.shopId, ...throttleDetail }, true).catch(() => undefined);
          if (diagnosticRunId) await writePipelineEvent({
            runId: diagnosticRunId,
            shopId: identity.shopId,
            level: "warn",
            event: "pipeline-submit-history-throttled",
            message: `平台访问频率受限，${waitSeconds} 秒后自动恢复`,
            detail: throttleDetail
          }).catch(() => undefined);
          await waitForSubmitHistoryCooldown(args, resumeAtMs, shopLabel, checkpointNextPage);
          windowNextPage = checkpointNextPage;
          continue;
        }
        const failedAt = nowIso();
        const throttleExhausted = result.businessBusyCount > 0 && throttleRecoveryEnabled;
        const lastError = throttleExhausted ? "submit history throttle recovery exhausted" : "submit history window incomplete";
        await repositoryPut(submitHistorySyncStore, {
          id: syncId,
          ...identity,
          initialized: previous?.initialized === true,
          status: result.status,
          initialStartEpochSeconds: initialStart,
          initialCursorStartEpochSeconds: isInitial ? window.startEpochSeconds : startEpochSeconds,
          watermarkMs: previous?.watermarkMs || 0,
          remoteUpdatedAtWatermarkMs,
          recordCount,
          lastMode: isInitial ? "initial" : "incremental",
          lastError,
          throttleAttemptCount: throttleRecoveryCount || undefined,
          lastBusinessCode: result.lastBusinessCode || undefined,
          lastBusinessMessage: result.lastBusinessMessage || undefined,
          checkpointWindowStartEpochSeconds: window.startEpochSeconds,
          checkpointWindowEndEpochSeconds: window.endEpochSeconds,
          checkpointNextPage,
          checkpointRemoteTotal: windowRemoteTotal,
          historyCompactionCursor: previous?.historyCompactionCursor,
          historyCompactionCompletedAt: previous?.historyCompactionCompletedAt,
          createdAt: previous?.createdAt || failedAt,
          updatedAt: failedAt
        } satisfies SubmitHistorySyncRecord).catch(() => undefined);
        const diagnosticRunId = text(args.runId || args.operationId);
        if (diagnosticRunId) await writePipelineEvent({
          runId: diagnosticRunId,
          shopId: identity.shopId,
          level: "error",
          event: throttleExhausted ? "pipeline-submit-history-throttle-exhausted" : "pipeline-submit-history-incomplete",
          message: throttleExhausted ? "提报历史校验限流恢复超时" : "submit history sync incomplete",
          detail: { ...result.diagnostic, throttleRecoveryCount, throttleRecoveryBudgetMs, sourceHealth }
        }).catch(() => undefined);
        const index = await loadBenefitIndexForStore(identity);
        const records = Array.from(index.values());
        return { status: "failed" as const, mode: isInitial ? "initial" as const : "incremental" as const, records, overview: summarizeBenefitProducts(records), sourceHealth, remoteTotal, remoteTotalKnown, fetchedPages, businessBusyCount, throttleRecoveryCount, nextPage: checkpointNextPage };
      }
      if (windowThrottleRecoveryCount > 0) {
        const diagnosticRunId = text(args.runId || args.operationId);
        dispatchPipelineProgress(args, 16, `提报历史校验已恢复：${identity.shopName || identity.shopId}`);
        if (diagnosticRunId) await writePipelineEvent({
          runId: diagnosticRunId,
          shopId: identity.shopId,
          level: "info",
          event: "pipeline-submit-history-recovered",
          message: "提报历史校验已从平台限流中恢复",
          detail: { throttleRecoveryCount: windowThrottleRecoveryCount }
        }).catch(() => undefined);
      }
      const nextCursor = window.endEpochSeconds + 1;
      const checkpointAt = nowIso();
      await repositoryPut(submitHistorySyncStore, {
        id: syncId,
        ...identity,
        initialized: previous?.initialized === true,
        status: "truncated",
        initialStartEpochSeconds: initialStart,
        initialCursorStartEpochSeconds: isInitial ? nextCursor : previous?.initialCursorStartEpochSeconds || initialStart,
        watermarkMs: isInitial ? previous?.watermarkMs || 0 : Math.max(previous?.watermarkMs || 0, window.endEpochSeconds * 1000),
        remoteUpdatedAtWatermarkMs,
        recordCount,
        lastMode: isInitial ? "initial" : "incremental",
        historyCompactionCursor: previous?.historyCompactionCursor,
        historyCompactionCompletedAt: previous?.historyCompactionCompletedAt,
        createdAt: previous?.createdAt || checkpointAt,
        updatedAt: checkpointAt
      } satisfies SubmitHistorySyncRecord);
      break;
    }
  }
  if (isInitial && windows.length < allWindows.length) {
    const index = await loadBenefitIndexForStore(identity);
    const records = Array.from(index.values());
    return {
      status: "truncated" as const,
      mode: "initial" as const,
      records,
      overview: summarizeBenefitProducts(records),
      sourceHealth,
      remoteTotal,
      remoteTotalKnown,
      fetchedPages,
      businessBusyCount,
      nextPage: undefined
    };
  }
  const finishedAt = nowIso();
  await repositoryPut(submitHistorySyncStore, {
    id: syncId,
    ...identity,
    initialized: true,
    status: "complete",
    initialStartEpochSeconds: initialStart,
    initialCursorStartEpochSeconds: nowSeconds + 1,
    watermarkMs: nowSeconds * 1000,
    remoteUpdatedAtWatermarkMs,
    recordCount,
    lastMode: isInitial ? "initial" : "incremental",
    lastSuccessfulSyncAt: finishedAt,
    historyCompactionCursor: previous?.historyCompactionCursor,
    historyCompactionCompletedAt: previous?.historyCompactionCompletedAt,
    createdAt: previous?.createdAt || finishedAt,
    updatedAt: finishedAt
  } satisfies SubmitHistorySyncRecord);
  const index = await loadBenefitIndexForStore(identity);
  const records = Array.from(index.values());
  const overview = summarizeBenefitProducts(records);
  await reportDoudianDiagnostic({ category: "opportunity-pipeline", event: "submit-history-sync-complete", runId: args.runId || args.operationId, shopId: identity.shopId, mode: isInitial ? "initial" : "incremental", recordCount, fetchedPages, remoteTotal: remoteTotalKnown ? remoteTotal : undefined, queryWatermarkMs: nowSeconds * 1000, remoteUpdatedAtWatermarkMs, sourceHealth }, true).catch(() => undefined);
  return { status: "complete" as const, mode: isInitial ? "initial" as const : "incremental" as const, records, overview, sourceHealth, remoteTotal, remoteTotalKnown, fetchedPages, businessBusyCount, nextPage: undefined };
}

export async function runOpportunityHistoryPrewarmTask(args: OpportunityArgs = {}): Promise<DoudianOpportunityReportResult> {
  const payload = adapterPayload(args);
  const ledger = await listStoreLedger();
  const targets = targetStores(ledger.stores || [], args.shopIds);
  const operationId = text(args.operationId) || `opportunity-history-prewarm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (!targets.length) {
    return { ...ledger, ok: false, status: "no-store", mode: "history-prewarm", message: "No Doudian stores selected", details: [], successCount: 0, failureCount: 0 };
  }
  const details: DoudianRunDetail[] = [];
  const sourceHealth: Array<Record<string, unknown>> = [];
  let initialSyncCount = 0;
  let incrementalSyncCount = 0;
  let businessBusyCount = 0;
  let fetchedPages = 0;
  let recordCount = 0;
  let compactedRecordCount = 0;
  let deferredSliceCount = 0;
  for (const [index, store] of targets.entries()) {
    assertNotCancelled(args.isCancelled);
    const identity = normalizePipelineStoreIdentity(store);
    const startedAt = nowIso();
    dispatchDoudianProgress({
      operationId,
      taskType: "opportunityHistoryPrewarm",
      status: "running",
      progress: Math.max(1, Math.floor((index / targets.length) * 99)),
      message: `预热报名历史：${store.shopName || store.shopId}`
    });
    await writePipelineEvent({
      runId: operationId,
      shopId: identity.shopId,
      level: "info",
      event: "submit-history-prewarm-started",
      message: "submit history prewarm started",
      detail: { reason: text(args.reason) || "idle-maintenance", startedAt }
    }).catch(() => undefined);
    try {
      if (store.status !== "online") throw new Error("store login is not online");
      await assertMutationStoreActive(store);
      const result = await scanBenefitProductsForStore(payload, store, { ...args, operationId, runId: operationId });
      const compaction = await compactSubmitHistoryRawRecords(
        identity,
        policyNumber(payload.adapter, "opportunityReport.submitHistoryPrewarmCompactionBatchSize", 500, 1, 500)
      ).catch(() => ({ scannedCount: 0, compactedCount: 0, complete: false }));
      sourceHealth.push(...result.sourceHealth);
      businessBusyCount += result.businessBusyCount;
      fetchedPages += result.fetchedPages;
      recordCount += result.records.length;
      compactedRecordCount += compaction.compactedCount;
      if (result.mode === "initial") initialSyncCount += 1;
      else incrementalSyncCount += 1;
      const ok = result.status !== "failed";
      const deferredSlice = result.status === "truncated";
      if (deferredSlice) deferredSliceCount += 1;
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        status: result.status === "complete" ? "ok" : ok ? "partial" : "failed",
        ok,
        message: result.status === "complete" ? "报名历史预热完成" : deferredSlice ? "报名历史预热切片已保存" : "报名历史预热未完成",
        reason: result.status === "complete" ? undefined : deferredSlice ? "submit-history-prewarm-slice-complete" : result.businessBusyCount > 0 ? "submit-history-business-busy" : "submit-history-incomplete",
        diagnostic: {
          mode: result.mode,
          fetchedPages: result.fetchedPages,
          recordCount: result.records.length,
          businessBusyCount: result.businessBusyCount,
          compactedRecordCount: compaction.compactedCount,
          compactionComplete: compaction.complete,
          remoteTotal: result.remoteTotalKnown ? result.remoteTotal : undefined
        },
        attemptedAt: startedAt,
        index: index + 1,
        total: targets.length
      });
      await writePipelineEvent({
        runId: operationId,
        shopId: identity.shopId,
        level: ok ? "info" : "warn",
        event: result.status === "complete" ? "submit-history-prewarm-finished" : "submit-history-prewarm-deferred",
        message: result.status === "complete" ? "submit history prewarm finished" : "submit history prewarm slice checkpointed",
        detail: { mode: result.mode, fetchedPages: result.fetchedPages, recordCount: result.records.length, businessBusyCount: result.businessBusyCount, compactedRecordCount: compaction.compactedCount }
      }).catch(() => undefined);
      if (result.businessBusyCount > 0) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        status: "failed",
        ok: false,
        message,
        reason: "submit-history-prewarm-failed",
        attemptedAt: startedAt,
        index: index + 1,
        total: targets.length
      });
      await writePipelineEvent({
        runId: operationId,
        shopId: identity.shopId,
        level: "error",
        event: "submit-history-prewarm-failed",
        message,
        detail: { reason: text(args.reason) || "idle-maintenance" }
      }).catch(() => undefined);
    }
  }
  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.length - successCount;
  const status = failureCount === 0 ? "ok" : successCount > 0 ? "partial" : "failed";
  dispatchDoudianProgress({
    operationId,
    taskType: "opportunityHistoryPrewarm",
    status: status === "ok" ? "succeeded" : status,
    progress: 99,
    message: status === "ok" ? "报名历史预热完成" : "报名历史预热部分未完成"
  });
  return {
    ...ledger,
    ok: failureCount === 0,
    status,
    mode: "history-prewarm",
    message: failureCount === 0 ? "报名历史预热完成" : "报名历史预热部分未完成",
    details,
    successCount,
    failureCount,
    sourceHealth,
    summary: { initialSyncCount, incrementalSyncCount, businessBusyCount, fetchedPages, recordCount, compactedRecordCount, deferredSliceCount }
  };
}

async function loadBenefitIndexForStore(identity: PipelineStoreIdentity) {
  const prefix = `${storeScopeId(identity)}-`;
  const records = await repositoryGetAllByPrefix<BenefitProductIndexRecord>(submitHistoryProductIndexStore, prefix, { pageSize: 500, maxItems: 500000 }).catch(() => []);
  return new Map(records.map((record) => [record.productId, record]));
}

async function updateBenefitIndexAfterAssociation(identity: PipelineStoreIdentity, productId: string, clueId: string) {
  const id = `${storeScopeId(identity)}-product-${encodeURIComponent(productId)}`;
  const current = await repositoryGet<BenefitProductIndexRecord>(submitHistoryProductIndexStore, id).catch(() => null);
  if (!productId || !clueId) return;
  const base = current || {
    id,
    ...identity,
    productId,
    associatedClueIds: [],
    associatedClueCount: 0,
    remainingClueCapacity: SUBMIT_HISTORY_CLUE_CAPACITY,
    submissionRecordIds: [],
    sourceRecordCount: 0,
    acquiredProfitIds: [],
    unacquiredProfitIds: [],
    acquiredExposure: 0,
    estimatedExposure: 0,
    sourceStatus: "complete" as const,
    fetchedAt: nowIso(),
    updatedAt: nowIso()
  } satisfies BenefitProductIndexRecord;
  const currentClueIds = base.associatedClueIds || [];
  const currentSourceRecordCount = Number(base.sourceRecordCount || 0);
  if (currentClueIds.includes(clueId)) return;
  const associatedClueIds = [...currentClueIds, clueId];
  await repositoryPut(submitHistoryProductIndexStore, {
    ...base,
    associatedClueIds,
    associatedClueCount: associatedClueIds.length,
    remainingClueCapacity: Math.max(0, SUBMIT_HISTORY_CLUE_CAPACITY - Math.max(associatedClueIds.length, currentSourceRecordCount)),
    updatedAt: nowIso()
  });
}

async function markBenefitIndexSaturated(identity: PipelineStoreIdentity, productId: string, clueId?: string) {
  const id = `${storeScopeId(identity)}-product-${encodeURIComponent(productId)}`;
  const current = await repositoryGet<BenefitProductIndexRecord>(submitHistoryProductIndexStore, id).catch(() => null);
  if (!productId) return;
  const base = current || {
    id,
    ...identity,
    productId,
    associatedClueIds: [],
    associatedClueCount: 0,
    remainingClueCapacity: SUBMIT_HISTORY_CLUE_CAPACITY,
    submissionRecordIds: [],
    sourceRecordCount: 0,
    acquiredProfitIds: [],
    unacquiredProfitIds: [],
    acquiredExposure: 0,
    estimatedExposure: 0,
    sourceStatus: "complete" as const,
    fetchedAt: nowIso(),
    updatedAt: nowIso()
  } satisfies BenefitProductIndexRecord;
  const currentClueIds = base.associatedClueIds || [];
  const currentSourceRecordCount = Number(base.sourceRecordCount || 0);
  const associatedClueIds = clueId && !currentClueIds.includes(clueId)
    ? [...currentClueIds, clueId]
    : currentClueIds;
  await repositoryPut(submitHistoryProductIndexStore, {
    ...base,
    associatedClueIds,
    associatedClueCount: Math.max(SUBMIT_HISTORY_CLUE_CAPACITY, base.associatedClueCount || 0, associatedClueIds.length),
    sourceRecordCount: Math.max(SUBMIT_HISTORY_CLUE_CAPACITY, currentSourceRecordCount),
    remainingClueCapacity: 0,
    saturatedByRemoteError: true,
    updatedAt: nowIso()
  });
}

function extractCurrentStoreCategories(products: DoudianOpportunityProductRow[]) {
  const byKey = new Map<string, StoreCategorySummary>();
  let missingCategoryProductCount = 0;
  for (const product of products) {
    const categoryKey = categoryKeyOf(product);
    if (!categoryKey || (!product.categoryId && !product.categoryName && !product.categoryPath?.length)) {
      missingCategoryProductCount += 1;
      continue;
    }
    const current = byKey.get(categoryKey) || {
      categoryId: text(product.categoryId),
      categoryName: text(product.categoryName || product.category),
      categoryPath: (product.categoryPath || normalizeCategoryPath(product.category)).map(text).filter(Boolean),
      lastCategoryKey: isCategoryLevelKey(text(product.lastCategoryKey))
        ? text(product.lastCategoryKey)
        : (product.categoryPath?.length ? categoryLevelKey(product.categoryPath.length) : "third_cid"),
      categoryKey,
      productCount: 0,
      sampleProductIds: []
    };
    current.productCount += 1;
    if (current.sampleProductIds.length < 10 && product.productId) current.sampleProductIds.push(product.productId);
    byKey.set(categoryKey, current);
  }
  return {
    categories: Array.from(byKey.values()),
    missingCategoryProductCount
  };
}

function effectiveStoreCategories(categories: StoreCategorySummary[], matchRules: DoudianOpportunityMatchRules = {}) {
  const selected = new Set((matchRules.storeCategoryKeys || []).map(text).filter(Boolean));
  return selected.size ? categories.filter((category) => selected.has(category.categoryKey)) : categories;
}

function storeScopeId(identity: PipelineStoreIdentity) {
  return `${identity.tenantId}-${identity.shopId}-${identity.storeGeneration}`;
}

function pipelineScopeId(cacheScope: "shop" | "global", identity: PipelineStoreIdentity) {
  return cacheScope === "global" ? `tenant:${identity.tenantId}` : storeScopeId(identity);
}

function storeRunId(runId: string, identity: PipelineStoreIdentity) {
  return `${runId}-${storeScopeId(identity)}`;
}

function pipelineRunRecordPrefix(runId: string) {
  return `${runId}-`;
}

async function loadPipelineStoreRunsForRun(runId: string, maxItems = 10000) {
  const id = text(runId);
  if (!id) return [];
  return repositoryGetAllByPrefix<PipelineStoreRunRecord>(
    pipelineStoreRunStore,
    pipelineRunRecordPrefix(id),
    { pageSize: 500, maxItems }
  ).catch(() => []);
}

async function updatePipelineStoreRunProgress(id: string, patch: Partial<PipelineStoreRunRecord>) {
  const key = text(id);
  if (!key) return null;
  const current = await repositoryGet<PipelineStoreRunRecord>(pipelineStoreRunStore, key).catch(() => null);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    status: preserveCancelledStatus(current.status, text(patch.status || current.status)),
    phase: current.status === "cancelled" ? "finished" : patch.phase || current.phase,
    updatedAt: nowIso()
  } as PipelineStoreRunRecord;
  await repositoryPut(pipelineStoreRunStore, next);
  return next;
}

async function loadPipelineSubmitTasksForRun(runId: string, maxItems = 10000) {
  return loadPipelineSubmitTasksForRunStrict(runId, maxItems).catch(() => []);
}

async function loadPipelineSubmitTasksForRunStrict(runId: string, maxItems = 10000) {
  const id = text(runId);
  if (!id) return [];
  return repositoryGetAllByPrefix<PipelineSubmitTaskRecord>(
    pipelineSubmitTaskStore,
    pipelineRunRecordPrefix(id),
    { pageSize: 500, maxItems }
  );
}

async function loadPipelineCandidatesForRun(runId: string, maxItems = latestPipelineCandidatePreviewLimit) {
  const id = text(runId);
  if (!id) return [];
  return repositoryGetAllByPrefix<DoudianOpportunityPrematchCandidate>(
    pipelineCandidateStore,
    pipelineRunRecordPrefix(id),
    { pageSize: Math.min(100, maxItems), maxItems }
  ).catch(() => []);
}

async function saveStoreCategorySnapshot(args: {
  runId: string;
  identity: PipelineStoreIdentity;
  categories: StoreCategorySummary[];
  productCount: number;
  missingCategoryProductCount: number;
  createdAt: string;
}) {
  await repositoryPut(storeCategorySnapshotStore, {
    id: storeRunId(args.runId, args.identity),
    runId: args.runId,
    ...args.identity,
    categories: args.categories,
    productCount: args.productCount,
    missingCategoryProductCount: args.missingCategoryProductCount,
    createdAt: args.createdAt
  } satisfies StoreCategorySnapshotRecord);
}

async function upsertStoreCategoryLedger(args: {
  identity: PipelineStoreIdentity;
  categories: StoreCategorySummary[];
  seenAt: string;
}) {
  const records: StoreCategoryLedgerRecord[] = [];
  for (const category of args.categories) {
    const id = `${storeScopeId(args.identity)}-${category.categoryKey}`;
    const existing = await repositoryGet<StoreCategoryLedgerRecord>(storeCategoryLedgerStore, id).catch(() => null);
    records.push({
      id,
      ...args.identity,
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      categoryPath: category.categoryPath,
      lastCategoryKey: category.lastCategoryKey,
      categoryKey: category.categoryKey,
      productCount: category.productCount,
      seenCount: Number(existing?.seenCount || 0) + 1,
      firstSeenAt: existing?.firstSeenAt || args.seenAt,
      lastSeenAt: args.seenAt,
      sampleProductIds: uniqueText([...(existing?.sampleProductIds || []), ...category.sampleProductIds]).slice(0, 20)
    });
  }
  await repositoryPutMany(storeCategoryLedgerStore, records, { concurrency: 2 });
  return records;
}

function categoryLevelFromKey(key: string) {
  if (key === "first_cid") return 1;
  if (key === "second_cid") return 2;
  if (key === "third_cid") return 3;
  if (key === "fourth_cid") return 4;
  return undefined;
}

function cacheCategoryKey(category: { categoryId?: string; categoryName?: string; categoryPath?: string[]; lastCategoryKey?: string }) {
  const id = text(category.categoryId);
  if (!id) return "";
  const key = isCategoryLevelKey(text(category.lastCategoryKey))
    ? text(category.lastCategoryKey)
    : (category.categoryPath?.length ? categoryLevelKey(category.categoryPath.length) : "third_cid");
  return `${key}:${id}`;
}

function filtersForStoreCategory(filters: DoudianOpportunityFilters, category: StoreCategorySummary): DoudianOpportunityFilters {
  const level = categoryLevelFromKey(category.lastCategoryKey) || (category.categoryPath?.length ? category.categoryPath.length : 3);
  const key = isCategoryLevelKey(text(category.lastCategoryKey))
    ? text(category.lastCategoryKey)
    : categoryLevelKey(level);
  return {
    ...filters,
    categoryLeafId: undefined,
    categoryPath: [{
      id: category.categoryId,
      key,
      name: category.categoryName,
      level
    }]
  };
}

function clueCacheKey(args: {
  cacheScope: "shop" | "global";
  scopeId: string;
  adapterVersion: string;
  requestPlanHash: string;
  categoryKey: string;
  filterHash: string;
}) {
  return stableHash(["clue-v3-coverage", args.cacheScope, args.scopeId, args.adapterVersion, args.requestPlanHash, args.categoryKey, args.filterHash].join("|"));
}

function wordCacheKey(clueCacheKeyValue: string, tokenizerVersion: string, stopwordVersion: string, clueIdsHash: string) {
  return `${clueCacheKeyValue}::${stableHash(["word-v3", clueCacheKeyValue, tokenizerVersion, stopwordVersion, clueIdsHash].join("|"))}`;
}

async function loadOpportunityMutationSummary(runId: string): Promise<OpportunityMutationSummary | null> {
  const summarize = getNativeData()?.catalog.summarizeOpportunityRunMutations;
  if (!summarize) return null;
  return summarize({ runId }).catch(() => null);
}

async function loadOpportunitySubmitRunMetrics(run: PipelineRunRecord): Promise<OpportunitySubmitRunMetrics | null> {
  const summarize = getNativeData()?.opportunitySubmit?.summarizeRun;
  if (!summarize) return null;
  const result = await summarize({
    runId: run.runId,
    businessDate: businessDateKey(),
    endpointContract: "opportunitySubmitClue",
    dailyCandidateMutationLimit: Number(run.summary?.dailyCandidateMutationLimit || 1000),
    dailyHttpRequestLimit: Number(run.summary?.dailyHttpRequestLimit || 1000),
    policy: {
      submitPacingInitialIntervalMs: Number(run.summary?.submitPacingInitialIntervalMs || 15000),
      submitGlobalPacingInitialMs: Number(run.summary?.submitGlobalPacingInitialMs || 15000),
      submitGlobal429WindowMs: Number(run.summary?.submitGlobal429WindowMs || 120000),
      submitGlobal429DistinctStores: Number(run.summary?.submitGlobal429DistinctStores || 2)
    }
  }).catch(() => null);
  return result as unknown as OpportunitySubmitRunMetrics | null;
}

function submitConcurrencySnapshot(run: PipelineRunRecord): SubmitConcurrencyRunSnapshot {
  return {
    runId: run.runId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    summary: run.summary || {}
  };
}

async function submitTaskIsCancelled(task: PipelineSubmitTaskRecord, args: OpportunityArgs) {
  if (cancelledPipelineRunIds.has(task.runId) || pipelineCancelled({ ...args, runId: task.runId })) return true;
  const current = await repositoryGet<PipelineSubmitTaskRecord>(pipelineSubmitTaskStore, task.id).catch(() => null);
  return current?.status === "cancelled" || current?.status === "cancelling";
}

async function updateSubmitTaskFromWorker(
  task: PipelineSubmitTaskRecord,
  workerId: string,
  patch: Partial<PipelineSubmitTaskRecord>
) {
  const current = await repositoryGet<PipelineSubmitTaskRecord>(pipelineSubmitTaskStore, task.id).catch(() => null);
  if (!current) return null;
  const cancelled = cancelledPipelineRunIds.has(task.runId) || current.status === "cancelled" || current.status === "cancelling";
  if (!cancelled && current.ownerRunId && current.ownerRunId !== workerId) return current;
  const requestedStatus = text(patch.status || current.status);
  const nextStatus = (current.status === "cancelling" && requestedStatus !== "cancelled"
    ? "cancelling"
    : preserveCancelledStatus(current.status, requestedStatus)) as PipelineSubmitTaskRecord["status"];
  const next = {
    ...current,
    ...patch,
    status: nextStatus,
    leaseExpiresAt: nextStatus === "cancelled" || nextStatus === "cancelling"
      ? undefined
      : Object.prototype.hasOwnProperty.call(patch, "leaseExpiresAt")
        ? patch.leaseExpiresAt
        : current.leaseExpiresAt,
    updatedAt: text(patch.updatedAt) || nowIso()
  } satisfies PipelineSubmitTaskRecord;
  if (cancelledPipelineRunIds.has(task.runId) && next.status !== "cancelled") return current;
  await repositoryPut(pipelineSubmitTaskStore, next);
  return next;
}

const opportunityRetentionMetaId = "opportunity-retention-v1";
const officialValidationCacheRemovalMetaId = "opportunity-official-validation-cache-removed-v1";

function expiredHistoryRecords<T extends { id: string; createdAt?: string; updatedAt?: string; status?: string }>(records: T[], cutoffMs: number, maxRecords: number) {
  const terminal = records
    .filter((item) => !["preparing", "ready", "running", "queued", "cancelling", "cooling_down", "deferred", "deferred_contract_mismatch", "manual_reconcile"].includes(item.status || ""))
    .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  return terminal.filter((item, index) => {
    const timestamp = Date.parse(String(item.updatedAt || item.createdAt || ""));
    return index >= maxRecords || (Number.isFinite(timestamp) && timestamp < cutoffMs);
  });
}

async function deleteStoreRecordsByPrefix(storeName: Parameters<typeof repositoryGetAllByPrefix>[0], prefix: string) {
  for (;;) {
    const records = await repositoryGetAllByPrefix<{ id: string }>(storeName, prefix, { pageSize: 1000, maxItems: 5000 }).catch(() => []);
    if (!records.length) return;
    await repositoryDeleteMany(storeName, records.map((item) => item.id));
    if (records.length < 5000) return;
  }
}

async function removeLegacyOfficialValidationCaches() {
  const migration = await repositoryGet<{ id: string }>("runtime_meta", officialValidationCacheRemovalMetaId).catch(() => null);
  if (migration) return;
  const [wordCaches, goodsCaches] = await Promise.all([
    repositoryGetAll<OfficialClueWordsCacheRecord>(officialClueWordsCacheStore).catch(() => []),
    repositoryGetAll<OfficialClueGoodsCacheRecord>(officialClueGoodsCacheStore).catch(() => [])
  ]);
  for (const cache of goodsCaches) await deleteStoreRecordsByPrefix(officialClueGoodsCacheShardStore, `${cache.id}-`);
  if (wordCaches.length) await repositoryDeleteMany(officialClueWordsCacheStore, wordCaches.map((cache) => cache.id));
  if (goodsCaches.length) await repositoryDeleteMany(officialClueGoodsCacheStore, goodsCaches.map((cache) => cache.id));
  await repositoryPut("runtime_meta", { id: officialValidationCacheRemovalMetaId, removedAt: nowIso() });
}

async function cleanupOpportunityData(adapter: DoudianAdapterConfig) {
  await ensureStructuredSubmitAttempts();
  await removeLegacyOfficialValidationCaches();
  const meta = await repositoryGet<{ id: string; cleanedAt?: string }>("runtime_meta", opportunityRetentionMetaId).catch(() => null);
  const cleanedAtMs = Date.parse(String(meta?.cleanedAt || ""));
  if (Number.isFinite(cleanedAtMs) && Date.now() - cleanedAtMs < 24 * 60 * 60 * 1000) return;

  const retentionDays = policyNumber(adapter, "opportunityReport.historyRetentionDays", 30, 1, 3650);
  const maxRuns = policyNumber(adapter, "opportunityReport.maxHistoryRuns", 200, 10, 5000);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const [pipelineRuns, pipelineTasks, clueRuns, productRuns, prematchRuns, executeRuns, clueCaches, wordCaches] = await Promise.all([
    repositoryGetAll<PipelineRunRecord>(pipelineRunStore).catch(() => []),
    repositoryGetAll<PipelineSubmitTaskRecord>(pipelineSubmitTaskStore).catch(() => []),
    repositoryGetAll<ClueScanRunRecord>(clueScanStore).catch(() => []),
    repositoryGetAll<ProductScanRunRecord>(productScanStore).catch(() => []),
    repositoryGetAll<PrematchRunRecord>(prematchRunStore).catch(() => []),
    repositoryGetAll<ExecuteRunRecord>(opportunityExecuteStore).catch(() => []),
    repositoryGetAll<ClueCacheRecord>(clueCacheStore).catch(() => []),
    repositoryGetAll<ClueWordCacheRecord>(clueWordCacheStore).catch(() => [])
  ]);

  const stalePipelineRuns = expiredHistoryRecords(pipelineRuns, cutoffMs, maxRuns);
  for (const run of stalePipelineRuns) {
    const prefix = pipelineRunRecordPrefix(run.runId);
    await Promise.all([
      deleteStoreRecordsByPrefix(pipelineStoreRunStore, prefix),
      deleteStoreRecordsByPrefix(storeCategorySnapshotStore, prefix),
      deleteStoreRecordsByPrefix(pipelineCandidateStore, prefix),
      deleteStoreRecordsByPrefix(pipelineSubmitTaskStore, prefix),
      deleteStoreRecordsByPrefix(pipelineOperationEventStore, prefix)
    ]);
  }
  if (stalePipelineRuns.length) await repositoryDeleteMany(pipelineRunStore, stalePipelineRuns.map((run) => run.id));

  const preparingTaskTtlMinutes = policyNumber(adapter, "opportunityReport.preparingTaskTtlMinutes", 60, 5, 1440);
  const preparingCutoff = Date.now() - preparingTaskTtlMinutes * 60 * 1000;
  const stalePreparingTasks = pipelineTasks.filter((task) => task.status === "preparing" && Date.parse(task.updatedAt || task.createdAt) < preparingCutoff);
  for (const task of stalePreparingTasks) {
    if (task.candidateIds.length) await repositoryDeleteMany(pipelineCandidateStore, task.candidateIds).catch(() => 0);
  }
  if (stalePreparingTasks.length) {
    const failedAt = nowIso();
    await repositoryPutMany(pipelineSubmitTaskStore, stalePreparingTasks.map((task) => ({
      ...task,
      status: "failed",
      failedCount: Math.max(1, task.failedCount),
      lastError: "preparing_snapshot_expired",
      finishedAt: failedAt,
      updatedAt: failedAt
    } satisfies PipelineSubmitTaskRecord)), { concurrency: 2 });
  }

  const legacyRunGroups: Array<[typeof clueScanStore | typeof productScanStore | typeof prematchRunStore | typeof opportunityExecuteStore, typeof clueCandidateStore | typeof productCandidateStore | typeof prematchCandidateStore | null, Array<{ id: string; runId: string; createdAt?: string; updatedAt?: string; status?: string }>]> = [
    [clueScanStore, clueCandidateStore, clueRuns],
    [productScanStore, productCandidateStore, productRuns],
    [prematchRunStore, prematchCandidateStore, prematchRuns],
    [opportunityExecuteStore, null, executeRuns]
  ];
  for (const [runStore, childStore, runs] of legacyRunGroups) {
    const staleRuns = expiredHistoryRecords(runs, cutoffMs, maxRuns);
    if (childStore) {
      for (const run of staleRuns) await deleteStoreRecordsByPrefix(childStore, `${run.runId}-`);
    }
    if (staleRuns.length) await repositoryDeleteMany(runStore, staleRuns.map((run) => run.id));
  }

  const now = nowIso();
  const staleClueCaches = clueCaches.filter((cache) => (cache.expiresAt && cache.expiresAt <= now) || Date.parse(cache.updatedAt || cache.createdAt) < cutoffMs);
  const staleClueIds = new Set(staleClueCaches.map((cache) => cache.id));
  const staleWordCaches = wordCaches.filter((cache) => staleClueIds.has(cache.clueCacheKey) || Date.parse(cache.updatedAt || cache.createdAt) < cutoffMs);
  for (const cache of staleClueCaches) await deleteStoreRecordsByPrefix(clueCacheShardStore, `${cache.id}-`);
  for (const cache of staleWordCaches) await deleteStoreRecordsByPrefix(clueWordCacheShardStore, `${cache.id}-`);
  if (staleClueCaches.length) await repositoryDeleteMany(clueCacheStore, staleClueCaches.map((cache) => cache.id));
  if (staleWordCaches.length) await repositoryDeleteMany(clueWordCacheStore, staleWordCaches.map((cache) => cache.id));
  // Submission history is a durable reconciliation source. It must not be
  // deleted by the short-lived opportunity run retention policy.

  await getNativeData()?.opportunityAttempts?.cleanup({
    failedRetentionDays: policyNumber(adapter, "opportunityReport.failedAttemptRetentionDays", 90, 1, 3650)
  }).catch(() => undefined);
  await repositoryPut("runtime_meta", { id: opportunityRetentionMetaId, cleanedAt: now });
}

function cacheableClueRow(clue: DoudianOpportunityClueRow): DoudianOpportunityClueRow {
  return {
    id: clue.clueId,
    candidateId: clue.clueId,
    sourceRunId: clue.sourceRunId,
    clueId: clue.clueId,
    name: clue.name,
    shortName: clue.shortName,
    img: clue.img,
    categoryName: clue.categoryName,
    firstCategoryId: clue.firstCategoryId,
    lastCategoryId: clue.lastCategoryId,
    lastCategoryKey: clue.lastCategoryKey,
    clueWords: uniqueText(clue.clueWords || []),
    recommendList: uniqueText(clue.recommendList || []),
    profitInfoList: uniqueText(clue.profitInfoList || []),
    shopList: [],
    searchCount: clue.searchCount,
    searchCountText: clue.searchCountText,
    growthRate: clue.growthRate,
    demandSupplyRate: clue.demandSupplyRate,
    onlineGoodsNum: clue.onlineGoodsNum,
    onlineGoodsNumSort: clue.onlineGoodsNumSort,
    hotCount: clue.hotCount,
    hotCountSort: clue.hotCountSort,
    payMoney: clue.payMoney,
    payMoneySort: clue.payMoneySort,
    productCount: clue.productCount,
    status: "ready"
  };
}

function materializeCachedClue(row: DoudianOpportunityClueRow, store: DoudianStoreSummary, runId: string, index: number): DoudianOpportunityClueRow {
  return {
    ...row,
    id: `${runId}-${row.clueId}`,
    candidateId: `${store.shopId}-${row.clueId}`,
    sourceRunId: runId,
    shopList: [{
      shopId: store.shopId,
      shopName: store.shopName,
      partition: store.partition,
      group: store.groupName || ""
    }],
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    status: "ready",
    raw: { __cache_hit: true, __row_index: index }
  };
}

async function loadClueCacheRows(cache: ClueCacheRecord, store: DoudianStoreSummary, runId: string) {
  if (!cache.generation
    || !Number.isInteger(Number(cache.shardCount))
    || Number(cache.shardCount) < 0
    || !Number.isInteger(Number(cache.rowCount))
    || Number(cache.rowCount) < 0) return null;
  const shards = (await repositoryGetAllByPrefix<ClueCacheShardRecord>(clueCacheShardStore, `${cache.id}-`, { pageSize: 500, maxItems: 10000 }).catch(() => []))
    .filter((shard) => shard.generation && shard.generation === cache.generation)
    .sort((left, right) => left.shardNo - right.shardNo);
  const expectedShardNos = Array.from({ length: Math.max(0, Number(cache.shardCount || 0)) }, (_, index) => index + 1);
  const actualShardNos = shards.map((shard) => shard.shardNo);
  const invalidShard = shards.some((shard) => {
    const rows = Array.isArray(shard.rows) ? shard.rows : [];
    return shard.clueCacheKey !== cache.id
      || shard.categoryKey !== cache.categoryKey
      || shard.cacheScope !== cache.cacheScope
      || shard.scopeId !== cache.scopeId
      || !Number.isInteger(Number(shard.rowCount))
      || Number(shard.rowCount) !== rows.length;
  });
  const rowCount = shards.reduce((sum, shard) => sum + Number(shard.rowCount || 0), 0);
  if (invalidShard || shards.length !== Number(cache.shardCount || 0) || rowCount !== Number(cache.rowCount || 0) || expectedShardNos.some((value, index) => actualShardNos[index] !== value)) return null;
  const rows = shards.flatMap((shard) => shard.rows || []);
  const uniqueClueIds = new Set(rows.map((row) => text(row.clueId)).filter(Boolean));
  if (uniqueClueIds.size !== rows.length || (cache.scanStatus === "complete" && cache.remoteTotalKnown && Number(cache.remoteTotal || 0) > rows.length)) return null;
  return rows.map((row, index) => materializeCachedClue(row, store, runId, index));
}

function sourceHealthComplete(sourceHealth: Array<Record<string, unknown>> = []) {
  return sourceHealth.length > 0 && sourceHealth.every((item) => {
    const status = Number(item.status || 0);
    return item.ok === true && (!status || (status >= 200 && status < 400));
  });
}

function sourceHealthFailed(sourceHealth: Array<Record<string, unknown>> = []) {
  return sourceHealth.some((item) => {
    const status = Number(item.status || 0);
    return item.ok === false || status >= 400;
  });
}

async function loadClueWordsForCache(payload: DoudianAdapterPayload, store: DoudianStoreSummary, clue: DoudianOpportunityClueRow, dryRun = false) {
  const base = baseClueWords(clue);
  void payload;
  void store;
  void dryRun;
  return uniqueText([...base, ...(clue.recommendList || []), ...(clue.profitInfoList || [])]).filter((word) => word.length > 1);
}

async function fetchCluesForCategory(args: {
  payload: DoudianAdapterPayload;
  store: DoudianStoreSummary;
  runId: string;
  filters: DoudianOpportunityFilters;
  category: StoreCategorySummary;
  dryRun?: boolean;
  mockClues?: Array<Record<string, unknown>>;
  requestedPages?: number;
  pageBudgetSatisfiesCoverage?: boolean;
  startPage?: number;
  existingRows?: DoudianOpportunityClueRow[];
  existingRemoteTotal?: number;
  existingRemoteTotalKnown?: boolean;
}) {
  const planKey = "opportunityClueRealtimeList";
  const normalized = normalizedClueFilter(args.filters, args.payload.adapter);
  const pageSize = normalized.pageSize;
  const requestedPages = Math.max(1, Math.floor(Number(args.requestedPages || normalized.maxPages)));
  const startPage = Math.max(1, Math.floor(Number(args.startPage || 1)));
  const maxPages = requestedPages;
  const rawRows: Record<string, unknown>[] = [];
  const rowById = new Map<string, Record<string, unknown>>();
  const sourceHealth: Array<Record<string, unknown>> = [];
  let remoteTotal = Number(args.existingRemoteTotal || 0);
  let remoteTotalKnown = args.existingRemoteTotalKnown === true;
  let fetchedPages = 0;
  let lastPageRowCount: number | undefined;
  let missingIdCount = 0;
  let duplicateIdCount = 0;
  let duplicatePage = false;
  let totalZeroWithRows = false;
  for (const existing of args.existingRows || []) {
    const clueId = text(existing.clueId);
    if (clueId) rowById.set(clueId, existing as unknown as Record<string, unknown>);
  }
  if (args.mockClues?.length) {
    let pageNew = 0;
    let pageDuplicateCount = 0;
    for (const row of args.mockClues) {
      const clueId = rawClueId(row, args.payload.adapter);
      if (!clueId) missingIdCount += 1;
      else if (rowById.has(clueId)) {
        duplicateIdCount += 1;
        pageDuplicateCount += 1;
      } else {
        rowById.set(clueId, row);
        pageNew += 1;
      }
    }
    duplicatePage = args.mockClues.length > 0 && pageNew === 0 && pageDuplicateCount > 0;
    remoteTotal = args.mockClues.length;
    remoteTotalKnown = true;
    fetchedPages = 1;
    lastPageRowCount = args.mockClues.length;
    sourceHealth.push({ key: `${planKey}:${args.category.categoryKey}:mock`, status: 200, ok: true, count: args.mockClues.length, categoryKey: args.category.categoryKey });
  } else {
    for (let page = startPage; page <= maxPages; page += 1) {
    const body = buildClueSearchBody(filtersForStoreCategory(args.filters, args.category), page, pageSize);
    const response = await runDoudianRequestPlan(args.payload, { partition: args.store.partition, planKey, context: bodyContext(body) });
    const responseKey = page === 1 ? `${planKey}:${args.category.categoryKey}` : `${planKey}:${args.category.categoryKey}:page:${page}`;
    const wrapped = { [planKey]: response.data };
    const rows = firstArray(wrapped, mappingArray(args.payload.adapter, "clueListPaths", [
      "opportunityClueRealtimeList.data",
      "opportunityClueRealtimeList.data.data",
      "opportunityClueRealtimeList.list"
    ])).map(objectRecord);
    fetchedPages += 1;
    lastPageRowCount = rows.length;
    let pageNew = 0;
    let pageDuplicateCount = 0;
    let pageMissingIdCount = 0;
    let missingIdSample: unknown;
    for (const row of rows) {
      const clueId = rawClueId(row, args.payload.adapter);
      if (!clueId) {
        missingIdCount += 1;
        pageMissingIdCount += 1;
        missingIdSample ??= diagnosticValueShape(row);
      } else if (rowById.has(clueId)) {
        duplicateIdCount += 1;
        pageDuplicateCount += 1;
      }
      else {
        rowById.set(clueId, row);
        pageNew += 1;
      }
    }
    const pageRemoteTotal = readOptionalTotal(wrapped, args.payload.adapter, "clueTotalPaths");
    if (pageRemoteTotal !== undefined) {
      remoteTotal = pageRemoteTotal;
      remoteTotalKnown = true;
    }
    if (remoteTotalKnown && remoteTotal === 0 && rows.length > 0) totalZeroWithRows = true;
    const ok = planOk(response, args.payload.adapter, planKey);
    const noNewPage = rows.length > 0 && pageNew === 0;
    if (noNewPage && pageDuplicateCount > 0 && pageMissingIdCount === 0) duplicatePage = true;
    sourceHealth.push({
      key: responseKey,
      status: response.status,
      ok,
      count: rows.length,
      uniqueCount: rowById.size,
      pageNew,
      duplicateCount: pageDuplicateCount,
      missingIdCount: pageMissingIdCount,
      missingIdSample,
      duplicatePage: noNewPage && pageDuplicateCount > 0 && pageMissingIdCount === 0,
      remoteTotal: remoteTotalKnown ? remoteTotal : undefined,
      categoryKey: args.category.categoryKey
    });
    if (!ok || !rows.length) break;
    if (remoteTotalKnown && rowById.size >= remoteTotal) break;
    if (!pageNew) break;
    }
  }
  rawRows.push(...rowById.values());
  const rows = rawRows
    .map((row, rowIndex) => normalizeClue(args.store, row, args.payload.adapter, args.runId, rowIndex))
    .filter((row): row is DoudianOpportunityClueRow => Boolean(row));
  const totalFetchedPages = Math.max(0, startPage - 1) + fetchedPages;
  const coverage = evaluateClueScanCoverage({
    requestFailed: !sourceHealth.length || sourceHealth.some((item) => item.ok !== true),
    schemaMismatch: missingIdCount > 0 || (rawRows.length > 0 && rows.length !== rawRows.length),
    fetchedCount: rows.length,
    uniqueFetchedCount: rowById.size,
    remoteTotal: remoteTotalKnown ? remoteTotal : undefined,
    remoteTotalKnown,
    fetchedPages: totalFetchedPages,
    maxPages: requestedPages,
    pageSize,
    lastPageRowCount,
    duplicatePage,
    totalZeroWithRows
  }, {
    requestedPages,
    pageBudgetSatisfiesCoverage: args.pageBudgetSatisfiesCoverage
  });
  const coverageSatisfied = clueCoverageSatisfiesPolicy({
    status: coverage.status,
    fetchedPages: totalFetchedPages,
    requestedPages,
    pageBudgetSatisfiesCoverage: args.pageBudgetSatisfiesCoverage
  });
  return {
    rows: mergeClues(rows),
    sourceHealth,
    remoteTotal,
    remoteTotalKnown,
    scanStatus: coverage.status,
    fetchedPages: totalFetchedPages,
    nextPage: coverage.status === "truncated" ? totalFetchedPages + 1 : undefined,
    coverageSatisfied,
    duplicateIdCount,
    missingIdCount,
    duplicatePage,
    totalZeroWithRows
  };
}

async function probeSharedClueCache(args: {
  payload: DoudianAdapterPayload;
  store: DoudianStoreSummary;
  filters: DoudianOpportunityFilters;
  category: StoreCategorySummary;
  cachedRows: DoudianOpportunityClueRow[];
  cachedRemoteTotal: number;
  cachedRemoteTotalKnown: boolean;
}) {
  const planKey = "opportunityClueRealtimeList";
  const pageSize = normalizedClueFilter(args.filters, args.payload.adapter).pageSize;
  const body = buildClueSearchBody(filtersForStoreCategory(args.filters, args.category), 1, pageSize);
  try {
    const response = await runDoudianRequestPlan(args.payload, {
      partition: args.store.partition,
      planKey,
      context: bodyContext(body),
      maxAttempts: 1
    });
    const wrapped = { [planKey]: response.data };
    const rawRows = firstArray(wrapped, mappingArray(args.payload.adapter, "clueListPaths", [
      "opportunityClueRealtimeList.data",
      "opportunityClueRealtimeList.data.data",
      "opportunityClueRealtimeList.list"
    ])).map(objectRecord);
    const probeIds = rawRows.map((row) => rawClueId(row, args.payload.adapter)).filter(Boolean);
    const cachedIds = args.cachedRows.slice(0, pageSize).map((row) => text(row.clueId)).filter(Boolean);
    const remoteTotal = readOptionalTotal(wrapped, args.payload.adapter, "clueTotalPaths");
    const probeEvaluation = evaluateSharedCacheProbe({
      cachedIds,
      probeIds,
      cachedRemoteTotal: args.cachedRemoteTotal,
      cachedRemoteTotalKnown: args.cachedRemoteTotalKnown,
      probeRemoteTotal: remoteTotal
    });
    const totalMatches = probeEvaluation.totalMatches;
    const fingerprintMatches = probeIds.length === rawRows.length && probeEvaluation.fingerprintMatches;
    const ok = planOk(response, args.payload.adapter, planKey) && totalMatches && fingerprintMatches;
    return {
      key: `shared-cache-probe:${cacheCategoryKey(args.category)}`,
      status: response.status,
      ok,
      totalMatches,
      fingerprintMatches,
      cachedRemoteTotal: args.cachedRemoteTotalKnown ? args.cachedRemoteTotal : null,
      probeRemoteTotal: remoteTotal ?? null,
      cachedFingerprint: stableHash([...cachedIds].sort()),
      probeFingerprint: stableHash([...probeIds].sort()),
      sourceShopId: args.store.shopId
    };
  } catch (error) {
    return {
      key: `shared-cache-probe:${cacheCategoryKey(args.category)}`,
      status: 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      sourceShopId: args.store.shopId
    };
  }
}

async function loadCluesByCategoryWithCacheCore(args: {
  payload: DoudianAdapterPayload;
  store: DoudianStoreSummary;
  identity: PipelineStoreIdentity;
  runId: string;
  filters: DoudianOpportunityFilters;
  category: StoreCategorySummary;
  dryRun?: boolean;
  mockClues?: Array<Record<string, unknown>>;
  requestedPages?: number;
  pageBudgetSatisfiesCoverage?: boolean;
  cacheScopeOverride?: "shop" | "global";
}): Promise<ClueCategoryLoadResult> {
  const categoryKey = cacheCategoryKey(args.category);
  const requestedCacheScope = args.cacheScopeOverride || policyText(args.payload.adapter, "opportunityReport.pipelineCacheScope", "shop");
  const cacheScope = resolvePipelineCacheScope(
    requestedCacheScope,
    args.cacheScopeOverride === "shop" ? false : policyBoolean(args.payload.adapter, "opportunityReport.enableGlobalPipelineCache", false),
    args.identity.tenantId
  );
  const scopeId = pipelineScopeId(cacheScope, args.identity);
  if (!categoryKey) {
    return { cacheKey: "", cacheScope, scopeId, rows: [] as DoudianOpportunityClueRow[], sourceHealth: [], remoteTotal: 0, remoteTotalKnown: false, scanStatus: "failed" as const, fetchedPages: 0, cacheHit: false, ok: true, coverageSatisfied: false, skipReason: "missing-category-id" };
  }
  const filterHash = stableFilterHash(args.filters, args.payload.adapter);
  const planHash = requestPlanHash(args.payload.adapter);
  const key = clueCacheKey({
    cacheScope,
    scopeId,
    adapterVersion: args.payload.adapter.version || "",
    requestPlanHash: planHash,
    categoryKey,
    filterHash
  });
  const now = nowIso();
  const cached = await repositoryGet<ClueCacheRecord>(clueCacheStore, key).catch(() => null);
  const requestedPages = Math.max(1, Math.floor(Number(args.requestedPages || normalizedClueFilter(args.filters, args.payload.adapter).maxPages)));
  const cachedValid = Boolean(cached && (!cached.expiresAt || String(cached.expiresAt) > now));
  const cachedRows = cachedValid && cached
    ? await loadClueCacheRows(cached, args.store, args.runId)
    : null;
  const cacheProbeHealth: Array<Record<string, unknown>> = [];
  if (cached
    && cachedRows
    && cacheScope === "global"
    && cached.sourceShopId
    && cached.sourceShopId !== args.identity.shopId
    && !args.mockClues?.length) {
    const probe = await probeSharedClueCache({
      payload: args.payload,
      store: args.store,
      filters: args.filters,
      category: args.category,
      cachedRows,
      cachedRemoteTotal: cached.remoteTotal,
      cachedRemoteTotalKnown: cached.remoteTotalKnown === true
    });
    cacheProbeHealth.push(probe);
    if (probe.ok !== true) {
      const downgraded = await loadCluesByCategoryWithCacheCore({ ...args, cacheScopeOverride: "shop" });
      return { ...downgraded, sourceHealth: [...cacheProbeHealth, ...downgraded.sourceHealth], cacheScopeDowngraded: true };
    }
  }
  if (cached && (!cached.expiresAt || String(cached.expiresAt) > now)) {
    const allowEmptyCacheHit = policyBoolean(args.payload.adapter, "opportunityReport.allowEmptyClueCacheHit", false);
    const cacheCoverageSatisfied = cached.scanStatus === "complete"
      || (args.pageBudgetSatisfiesCoverage === true && cached.scanStatus === "truncated" && Number(cached.fetchedPages || 0) >= requestedPages);
    if (cachedRows && cacheCoverageSatisfied && !sourceHealthFailed(cached.sourceHealth) && (cachedRows.length || allowEmptyCacheHit)) {
      return {
        cacheKey: key,
        cacheScope,
        scopeId,
        rows: cachedRows,
        sourceHealth: [...cacheProbeHealth, { key: "opportunityClueCache", ok: true, cacheHit: true, categoryKey, cacheScope, scopeId, rowCount: cachedRows.length }],
        remoteTotal: cached.remoteTotal,
        remoteTotalKnown: cached.remoteTotalKnown === true,
        scanStatus: cached.scanStatus || "complete",
        fetchedPages: Number(cached.fetchedPages || 0),
        nextPage: cached.nextPage,
        cacheHit: true,
        ok: true,
        coverageSatisfied: true
      };
    }
  }

  if (cachedRows && cached?.scanStatus === "truncated" && Number(cached.fetchedPages || 0) >= requestedPages && !sourceHealthFailed(cached.sourceHealth)) {
    return {
      cacheKey: key,
      cacheScope,
      scopeId,
      rows: cachedRows,
      sourceHealth: [...cacheProbeHealth, { key: "opportunityClueCache", ok: true, cacheHit: true, categoryKey, cacheScope, scopeId, rowCount: cachedRows.length }],
      remoteTotal: cached.remoteTotal,
      remoteTotalKnown: cached.remoteTotalKnown === true,
      scanStatus: "truncated" as const,
      fetchedPages: Number(cached.fetchedPages || 0),
      nextPage: cached.nextPage,
      cacheHit: true,
      ok: true,
      coverageSatisfied: false
    };
  }

  const fetched = await fetchCluesForCategory({
    payload: args.payload,
    store: args.store,
    runId: args.runId,
    filters: args.filters,
    category: args.category,
    dryRun: args.dryRun,
    mockClues: args.mockClues,
    requestedPages,
    pageBudgetSatisfiesCoverage: args.pageBudgetSatisfiesCoverage,
    startPage: cached && cachedRows && cached.scanStatus === "truncated" ? Math.max(1, Number(cached.nextPage || Number(cached.fetchedPages || 0) + 1)) : 1,
    existingRows: cachedRows || [],
    existingRemoteTotal: cached?.remoteTotal,
    existingRemoteTotalKnown: cached?.remoteTotalKnown === true
  });
  const fetchedSourceHealth = [...cacheProbeHealth, ...fetched.sourceHealth];
  const fetchedSourceOk = fetched.scanStatus !== "failed" && (args.mockClues?.length ? true : sourceHealthComplete(fetched.sourceHealth));
  if (!fetchedSourceOk) {
    return { cacheKey: key, cacheScope, scopeId, rows: [], sourceHealth: fetchedSourceHealth, remoteTotal: fetched.remoteTotal, remoteTotalKnown: fetched.remoteTotalKnown, scanStatus: "failed" as const, fetchedPages: fetched.fetchedPages, cacheHit: false, ok: false, coverageSatisfied: false };
  }
  const rows: DoudianOpportunityClueRow[] = [];
  for (const [index, clue] of fetched.rows.entries()) {
    const words = await loadClueWordsForCache(args.payload, args.store, clue, args.dryRun);
    rows.push({
      ...clue,
      id: `${args.runId}-${clue.clueId}`,
      clueWords: words,
      raw: { ...(clue.raw || {}), __cache_miss: true, __row_index: index }
    });
  }
  const allowEmptyCacheWrite = policyBoolean(args.payload.adapter, "opportunityReport.allowEmptyClueCacheWrite", false);
  if (!rows.length && !allowEmptyCacheWrite) {
    return { cacheKey: key, cacheScope, scopeId, rows, sourceHealth: fetchedSourceHealth, remoteTotal: fetched.remoteTotal, remoteTotalKnown: fetched.remoteTotalKnown, scanStatus: fetched.scanStatus, fetchedPages: fetched.fetchedPages, nextPage: fetched.nextPage, cacheHit: false, ok: true, coverageSatisfied: fetched.coverageSatisfied };
  }
  const cacheRows = rows.map(cacheableClueRow);
  const generation = `${Date.now()}-${stableHash(`${key}:${rows.map((row) => row.clueId).sort().join(",")}`)}`;
  const shards = chunk(cacheRows, 100).map((items, index) => ({
    id: `${key}-${generation}-${index + 1}`,
    clueCacheKey: key,
    categoryKey,
    filterHash,
    cacheScope,
    scopeId,
    generation,
    shardNo: index + 1,
    rows: items,
    rowCount: items.length,
    createdAt: now,
    updatedAt: now
  } satisfies ClueCacheShardRecord));
  const ttlHours = policyNumber(args.payload.adapter, "opportunityReport.clueCacheTtlHours", 24, 1, 168);
  await repositoryPutMany(clueCacheShardStore, shards, { concurrency: 2 });
  await repositoryPut(clueCacheStore, {
    id: key,
    ...args.identity,
    categoryKey,
    filterHash,
    requestPlanHash: planHash,
    adapterVersion: args.payload.adapter.version || "",
    cacheScope,
    scopeId,
    generation,
    shardCount: shards.length,
    rowCount: rows.length,
    remoteTotal: fetched.remoteTotal,
    remoteTotalKnown: fetched.remoteTotalKnown,
    scanStatus: fetched.scanStatus,
    fetchedPages: fetched.fetchedPages,
    nextPage: fetched.nextPage,
    sourceHealth: fetchedSourceHealth,
    sourceShopId: args.identity.shopId,
    shopScoped: cacheScope === "shop",
    clueWordsSource: "local-clue-fields",
    clueWordsRequestHash: stableHash({
      adapterVersion: args.payload.adapter.version || "",
      sources: ["clueWords", "name", "shortName", "recommendList", "profitInfoList"]
    }),
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString(),
    createdAt: now,
    updatedAt: now
  } satisfies ClueCacheRecord);
  const staleShardIds = (await repositoryGetAllByPrefix<ClueCacheShardRecord>(clueCacheShardStore, `${key}-`, { pageSize: 500, maxItems: 10000 }).catch(() => []))
    .filter((shard) => shard.generation !== generation)
    .map((shard) => shard.id);
  if (staleShardIds.length) await repositoryDeleteMany(clueCacheShardStore, staleShardIds).catch(() => undefined);
  return { cacheKey: key, cacheScope, scopeId, rows, sourceHealth: fetchedSourceHealth, remoteTotal: fetched.remoteTotal, remoteTotalKnown: fetched.remoteTotalKnown, scanStatus: fetched.scanStatus, fetchedPages: fetched.fetchedPages, nextPage: fetched.nextPage, cacheHit: false, ok: true, coverageSatisfied: fetched.coverageSatisfied };
}

async function loadCluesByCategoryWithCache(args: Parameters<typeof loadCluesByCategoryWithCacheCore>[0]): Promise<ClueCategoryLoadResult> {
  const categoryKey = cacheCategoryKey(args.category);
  if (!categoryKey) return loadCluesByCategoryWithCacheCore(args);
  const requestedScope = args.cacheScopeOverride || policyText(args.payload.adapter, "opportunityReport.pipelineCacheScope", "shop");
  const cacheScope = resolvePipelineCacheScope(
    requestedScope,
    args.cacheScopeOverride === "shop" ? false : policyBoolean(args.payload.adapter, "opportunityReport.enableGlobalPipelineCache", false),
    args.identity.tenantId
  );
  const scopeId = pipelineScopeId(cacheScope, args.identity);
  const flightKey = clueCacheKey({
    cacheScope,
    scopeId,
    adapterVersion: args.payload.adapter.version || "",
    requestPlanHash: requestPlanHash(args.payload.adapter),
    categoryKey,
    filterHash: stableFilterHash(args.filters, args.payload.adapter)
  });
  const activeFlight = clueCacheLoadFlights.get(flightKey);
  if (activeFlight) {
    await activeFlight.catch(() => undefined);
    return loadCluesByCategoryWithCacheCore(args);
  }
  const load = loadCluesByCategoryWithCacheCore(args);
  const tracked = load.then(() => undefined, () => undefined);
  clueCacheLoadFlights.set(flightKey, tracked);
  try {
    return await load;
  } finally {
    if (clueCacheLoadFlights.get(flightKey) === tracked) clueCacheLoadFlights.delete(flightKey);
  }
}

function clueTokenSources(clue: DoudianOpportunityClueRow) {
  return uniqueText([
    clue.name,
    clue.shortName || "",
    ...(clue.clueWords || []),
    ...(clue.recommendList || []),
    ...(clue.profitInfoList || [])
  ]).filter((item) => item.length > 1);
}

async function segmentTextsWithNative(
  texts: string[],
  options: { mode?: "search" | "default"; minTokenLength?: number; stopwordVersion?: string; allowFallback?: boolean } = {}
) {
  const native = window.chihuNative;
  if (!native?.text?.segment) throw new Error("window.chihuNative.text.segment is unavailable");
  const items: Array<{ source: string; tokens: string[] }> = [];
  let tokenizerVersion = "";
  let stopwordVersion = options.stopwordVersion || "chihu-stopwords-v1";
  for (const batch of chunk(texts, 200)) {
    const result = await native.text.segment({
      texts: batch,
      mode: options.mode || "search",
      minTokenLength: options.minTokenLength || 2,
      stopwordVersion
    });
    tokenizerVersion = tokenizerVersion || result.tokenizerVersion;
    stopwordVersion = result.stopwordVersion || stopwordVersion;
    if (result.tokenizerFallback && !options.allowFallback) {
      throw new Error(`native tokenizer fallback is not allowed: ${result.fallbackReason || result.tokenizerVersion}`);
    }
    items.push(...(result.items || []));
  }
  return { tokenizerVersion, stopwordVersion, items };
}

async function loadTokenIndexFromCache(wordCacheKeyValue: string): Promise<TokenIndex | null> {
  const record = await repositoryGet<ClueWordCacheRecord>(clueWordCacheStore, wordCacheKeyValue).catch(() => null);
  if (!record
    || !record.generation
    || !record.clueCacheKey
    || !Number.isInteger(Number(record.shardCount))
    || Number(record.shardCount) < 0
    || !Number.isInteger(Number(record.tokenCount))
    || Number(record.tokenCount) < 0
    || !Number.isInteger(Number(record.clueCount))
    || Number(record.clueCount) < 0) return null;
  const shards = (await repositoryGetAllByPrefix<ClueWordCacheShardRecord>(clueWordCacheShardStore, `${wordCacheKeyValue}-`, { pageSize: 500, maxItems: 10000 }).catch(() => []))
    .filter((shard) => shard.generation && shard.generation === record.generation)
    .sort((left, right) => left.shardNo - right.shardNo);
  const expectedShardNos = Array.from({ length: Math.max(0, Number(record.shardCount || 0)) }, (_, index) => index + 1);
  if (shards.length !== Number(record.shardCount || 0) || expectedShardNos.some((value, index) => shards[index]?.shardNo !== value)) return null;
  const tokenToClueIds: Record<string, string[]> = {};
  const clueTokens: Record<string, string[]> = {};
  const tokens: string[] = [];
  if (shards.some((shard) => shard.wordCacheKey !== record.id || shard.clueCacheKey !== record.clueCacheKey)) return null;
  for (const shard of shards) {
    for (const token of shard.tokens || []) tokens.push(token);
    Object.assign(tokenToClueIds, shard.tokenToClueIds || {});
    Object.assign(clueTokens, shard.clueTokens || {});
  }
  if (uniqueText(tokens).length !== Number(record.tokenCount || 0) || Object.keys(clueTokens).length !== Number(record.clueCount || 0)) return null;
  return {
    wordCacheKey: wordCacheKeyValue,
    tokenizerVersion: record.tokenizerVersion,
    stopwordVersion: record.stopwordVersion,
    tokens: uniqueText(tokens),
    tokenToClueIds,
    clueTokens
  };
}

async function tokenizeCluesWithCache(args: {
  clues: DoudianOpportunityClueRow[];
  clueCacheKey: string;
  categoryKey: string;
  filterHash: string;
  cacheScope: "shop" | "global";
  scopeId: string;
  allowTokenizerFallback?: boolean;
}) {
  const clueIdsHash = stableHash(args.clues.map((clue) => clue.clueId).sort());
  const existing = (await repositoryGetAllByPrefix<ClueWordCacheRecord>(clueWordCacheStore, `${args.clueCacheKey}::`, { pageSize: 20, maxItems: 100 }).catch(() => []))
    .filter((record) => record.clueIdsHash === clueIdsHash)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
  if (existing) {
    const cached = await loadTokenIndexFromCache(existing.id);
    if (cached) return cached;
  }

  const clueIds: string[] = [];
  const texts: string[] = [];
  for (const clue of args.clues) {
    clueIds.push(clue.clueId);
    texts.push(clueTokenSources(clue).join(" "));
  }
  const segmented = await segmentTextsWithNative(texts, {
    mode: "search",
    minTokenLength: 2,
    allowFallback: args.allowTokenizerFallback
  });
  const tokenToClueIds = new Map<string, Set<string>>();
  const clueTokens: Record<string, string[]> = {};
  for (const [index, item] of segmented.items.entries()) {
    const clueId = clueIds[index];
    if (!clueId) continue;
    const tokens = uniqueText(item.tokens || []);
    clueTokens[clueId] = tokens;
    for (const token of tokens) {
      const clueSet = tokenToClueIds.get(token) || new Set<string>();
      clueSet.add(clueId);
      tokenToClueIds.set(token, clueSet);
    }
  }
  const tokens = Array.from(tokenToClueIds.keys()).sort();
  const tokenIndex: TokenIndex = {
    wordCacheKey: wordCacheKey(args.clueCacheKey, segmented.tokenizerVersion, segmented.stopwordVersion, clueIdsHash),
    tokenizerVersion: segmented.tokenizerVersion,
    stopwordVersion: segmented.stopwordVersion,
    tokens,
    tokenToClueIds: Object.fromEntries(Array.from(tokenToClueIds.entries()).map(([token, clueSet]) => [token, Array.from(clueSet)])),
    clueTokens
  };
  const now = nowIso();
  const generation = `${Date.now()}-${stableHash(`${tokenIndex.wordCacheKey}:${clueIdsHash}`)}`;
  const tokenShards = chunk(tokens, 500);
  const shards = tokenShards.map((tokenList, index) => {
    const shardTokenToClueIds = Object.fromEntries(tokenList.map((token) => [token, tokenIndex.tokenToClueIds[token] || []]));
    const shardClueTokens: Record<string, string[]> = {};
    const clueIdsInShard = new Set(Object.values(shardTokenToClueIds).flat());
    for (const clueId of clueIdsInShard) shardClueTokens[clueId] = tokenIndex.clueTokens[clueId] || [];
    return {
      id: `${tokenIndex.wordCacheKey}-${generation}-${index + 1}`,
      wordCacheKey: tokenIndex.wordCacheKey,
      clueCacheKey: args.clueCacheKey,
      shardNo: index + 1,
      generation,
      tokens: tokenList,
      tokenToClueIds: shardTokenToClueIds,
      clueTokens: shardClueTokens,
      createdAt: now,
      updatedAt: now
    } satisfies ClueWordCacheShardRecord;
  });
  await repositoryPutMany(clueWordCacheShardStore, shards, { concurrency: 2 });
  await repositoryPut(clueWordCacheStore, {
    id: tokenIndex.wordCacheKey,
    clueCacheKey: args.clueCacheKey,
    tokenizerVersion: tokenIndex.tokenizerVersion,
    stopwordVersion: tokenIndex.stopwordVersion,
    categoryKey: args.categoryKey,
    filterHash: args.filterHash,
    cacheScope: args.cacheScope,
    scopeId: args.scopeId,
    shardCount: shards.length,
    tokenCount: tokens.length,
    clueCount: Object.keys(clueTokens).length,
    clueIdsHash,
    generation,
    createdAt: now,
    updatedAt: now
  } satisfies ClueWordCacheRecord);
  const staleShardIds = (await repositoryGetAllByPrefix<ClueWordCacheShardRecord>(clueWordCacheShardStore, `${tokenIndex.wordCacheKey}-`, { pageSize: 500, maxItems: 10000 }).catch(() => []))
    .filter((shard) => shard.generation !== generation)
    .map((shard) => shard.id);
  if (staleShardIds.length) await repositoryDeleteMany(clueWordCacheShardStore, staleShardIds).catch(() => undefined);
  return tokenIndex;
}

function tokenMatchesTitle(title: string, token: string) {
  return text(title).toLocaleLowerCase().includes(text(token).toLocaleLowerCase());
}

function groupProductsByCategoryKey(products: DoudianOpportunityProductRow[]) {
  const groups = new Map<string, DoudianOpportunityProductRow[]>();
  for (const product of products) {
    const key = cacheCategoryKey({
      categoryId: text(product.categoryId),
      categoryName: text(product.categoryName || product.category),
      categoryPath: product.categoryPath || normalizeCategoryPath(product.category),
      lastCategoryKey: text(product.lastCategoryKey)
    });
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(product);
    groups.set(key, list);
  }
  return groups;
}

function tokenWeight(tokenQuality: Map<string, TokenQuality>, token: string) {
  return tokenQuality.get(token)?.finalWeight || 1;
}

function candidateHistorySkipReason(args: {
  opportunityArgs: OpportunityArgs;
  dedupeIndex: SubmitDedupeIndex;
  benefitIndex: Map<string, BenefitProductIndexRecord>;
}, candidate: { shopId: string; productId: string; clueId: string; clueLastCategoryId?: string }) {
  const benefit = args.benefitIndex.get(candidate.productId);
  const submittedSkipReason = shouldSkipSubmittedCandidate(args.opportunityArgs, args.dedupeIndex, candidate);
  const submissionCount = benefit ? Math.max(benefit.sourceRecordCount || 0, benefit.associatedClueCount) : 0;
  const benefitSkipReason = benefit && (benefit.saturatedByRemoteError === true || submissionCount >= SUBMIT_HISTORY_CLUE_CAPACITY)
    ? `报名记录预检：商品已提交 ${submissionCount}/${SUBMIT_HISTORY_CLUE_CAPACITY} 次，提前排除`
    : benefit && (benefit.associatedClueIds || []).includes(candidate.clueId)
      ? "报名记录预检：商品此前已提交该商机，提前排除重复提报"
      : "";
  return submittedSkipReason || benefitSkipReason;
}

function matchCategoryProductsByAhoTokens(args: {
  adapter: DoudianAdapterConfig;
  runId: string;
  storeRunId: string;
  clueCacheKey: string;
  wordCacheKey: string;
  effectiveCategoryKey: string;
  products: DoudianOpportunityProductRow[];
  clues: DoudianOpportunityClueRow[];
  tokenIndex: TokenIndex;
  minTokenHitRatio: number;
  minWeightHitRatio: number;
  genericTokenDfRatio: number;
  topKPerProduct: number;
  dedupeIndex: SubmitDedupeIndex;
  benefitIndex: Map<string, BenefitProductIndexRecord>;
  matchRulesHash: string;
  opportunityArgs: OpportunityArgs;
}) {
  const diagnostics = createMatchDiagnostics({
    productCount: args.products.length,
    clueCount: args.clues.length,
    tokenCount: args.tokenIndex.tokens.length
  });
  const clueById = new Map(args.clues.map((clue) => [clue.clueId, clue]));
  const matcher = new AhoTokenMatcher(args.tokenIndex.tokens);
  const productHits = new Map<string, string[]>();
  const productDf = new Map<string, number>();

  for (const product of args.products) {
    diagnostics.titleScannedCount += 1;
    const hitTokens = matcher.match(product.title);
    productHits.set(product.id || `${product.shopId}-${product.productId}`, hitTokens);
    diagnostics.tokenHitCount += hitTokens.length;
    if (!hitTokens.length) {
      diagnostics.filteredByNoTokenCount += 1;
      continue;
    }
    for (const token of hitTokens) productDf.set(token, (productDf.get(token) || 0) + 1);
  }

  const quality = createTokenQualityMap({
    tokens: args.tokenIndex.tokens,
    tokenToClueIds: args.tokenIndex.tokenToClueIds,
    productDf,
    productCount: args.products.length,
    genericTokenDfRatio: args.genericTokenDfRatio
  });
  const topMatches = new Map<string, DoudianOpportunityPrematchCandidate[]>();

  for (const product of args.products) {
    const hitTokens = productHits.get(product.id || `${product.shopId}-${product.productId}`) || [];
    if (!hitTokens.length) continue;
    const matchedByClue = new Map<string, Set<string>>();
    for (const token of hitTokens) {
      for (const clueId of args.tokenIndex.tokenToClueIds[token] || []) {
        const set = matchedByClue.get(clueId) || new Set<string>();
        set.add(token);
        matchedByClue.set(clueId, set);
      }
    }
    diagnostics.rawPairCount += matchedByClue.size;

    for (const [clueId, tokenSet] of matchedByClue.entries()) {
      const clue = clueById.get(clueId);
      if (!clue) continue;
      const historySkipReason = candidateHistorySkipReason(args, {
        shopId: product.shopId,
        productId: product.productId,
        clueId: clue.clueId,
        clueLastCategoryId: clue.lastCategoryId
      });
      if (historySkipReason) {
        diagnostics.filteredByHistoryCount += 1;
        continue;
      }
      const clueTokens = uniqueText(args.tokenIndex.clueTokens[clueId] || []);
      const clueEvidenceGroups = groupEvidenceTerms(clueTokens);
      const clueTokenCount = clueTokens.length;
      const evidenceGroupCount = clueEvidenceGroups.length;
      if (clueTokenCount <= 0 || evidenceGroupCount <= 0) continue;
      const matchedTokens = Array.from(tokenSet).filter((token) => clueTokens.includes(token));
      const matchedTokenCount = matchedTokens.length;
      const matchedGroups = matchedEvidenceGroups(clueEvidenceGroups, matchedTokens);
      const matchedEvidenceGroupCount = matchedGroups.length;
      const strongMatchedTokens = matchedTokens.filter((token) => quality.get(token)?.isStrong);
      const genericMatchedTokens = matchedTokens.filter((token) => quality.get(token)?.isGeneric);
      const effectiveMatchedTokenCount = matchedGroups.filter((group) => group.members.some((token) => !quality.get(token)?.isGeneric)).length;
      const totalTokenWeight = clueEvidenceGroups.reduce((sum, group) => sum + Math.max(...group.members.map((token) => tokenWeight(quality, token))), 0);
      const matchedTokenWeight = matchedGroups.reduce((sum, group) => sum + Math.max(...group.members.map((token) => tokenWeight(quality, token))), 0);
      const matchedWeightRatio = totalTokenWeight > 0 ? matchedTokenWeight / totalTokenWeight : 0;
      const requiredTokenHits = evidenceGroupCount === 1
        ? 1
        : Math.max(2, Math.ceil(evidenceGroupCount * args.minTokenHitRatio));
      const fullClueNameMatched = Boolean(clue.name && tokenMatchesTitle(product.title, clue.name));

      if (evidenceGroupCount === 1) {
        const group = matchedGroups[0];
        if (!group || !group.members.some((token) => quality.get(token)?.isStrong)) {
          diagnostics.filteredByWeakSingleTokenCount += 1;
          continue;
        }
      } else if (effectiveMatchedTokenCount <= 0) {
        diagnostics.filteredByGenericOnlyCount += 1;
        continue;
      } else if (matchedEvidenceGroupCount < requiredTokenHits || matchedWeightRatio < args.minWeightHitRatio) {
        diagnostics.filteredByThresholdCount += 1;
        continue;
      }

      const score = scoreAhoTokenMatch({
        matchedTokenCount: matchedEvidenceGroupCount,
        clueTokenCount: evidenceGroupCount,
        matchedWeightRatio,
        strongMatchedTokenCount: strongMatchedTokens.length,
        fullClueNameMatched
      });
      const clueRaw = objectRecord(clue.raw);
      const anchorEvidence = deriveAnchorEvidence({
        groups: clueEvidenceGroups,
        structuredWords: uniqueText([
          text(clueRaw.brand_name || clueRaw.brandName),
          text(clueRaw.model || clueRaw.model_name || clueRaw.modelName),
          ...arrayText(clueRaw.required_words || clueRaw.requiredWords)
        ]),
        validatedRuleWords: uniqueText([
          ...arrayText(clueRaw.validated_anchor_words || clueRaw.validatedAnchorWords),
          ...validatedAnchorWordsForClue(args.adapter, clue)
        ])
      });
      const missingAnchorWords = anchorEvidence.words.filter((word) => !tokenMatchesTitle(product.title, word));
      diagnostics.passedThresholdCount += 1;
      const id = `${args.runId}-${product.shopId}-${product.productId}-${clue.clueId}`;
      keepProductTopK(topMatches, {
        id,
        candidateId: `${product.shopId}-${product.productId}-${clue.clueId}`,
        sourceRunId: args.runId,
        matchRunId: args.runId,
        productRunId: args.runId,
        clueRunId: args.clueCacheKey,
        pipelineRunId: args.runId,
        storeRunId: args.storeRunId,
        clueCacheKey: args.clueCacheKey,
        wordCacheKey: args.wordCacheKey,
        effectiveCategoryKey: args.effectiveCategoryKey,
        shopId: product.shopId,
        shopName: product.shopName,
        group: product.group,
        productId: product.productId,
        title: product.title,
        productCategory: product.category,
        productCategoryId: product.categoryId,
        clueId: clue.clueId,
        clueName: clue.name,
        clueCategoryName: clue.categoryName,
        clueLastCategoryId: clue.lastCategoryId,
        clueLastCategoryKey: clue.lastCategoryKey,
        clueWords: clueTokens,
        matchedWords: matchedTokens,
        matchedTokens,
        effectiveTokenCount: clueTokenCount,
        matchedTokenCount,
        requiredTokenHits,
        tokenHitRatio: matchedEvidenceGroupCount / Math.max(1, evidenceGroupCount),
        matchedTokenWeight,
        matchedWeightRatio,
        strongMatchedTokens,
        genericMatchedTokens,
        matchedEvidenceGroups: matchedGroups.map((group) => group.members),
        matchedEvidenceGroupCount,
        requiredEvidenceGroupCount: requiredTokenHits,
        anchorWords: anchorEvidence.words,
        missingAnchorWords,
        localMatchVersion: LOCAL_MATCH_VERSION,
        anchorRuleVersion: ANCHOR_RULE_VERSION,
        anchorConfidence: anchorEvidence.confidence,
        matchStatus: "local_candidate",
        submitStatus: "not_queued",
        auditStatus: "not_started",
        fullClueNameMatched,
        minTokenHitRatio: args.minTokenHitRatio,
        matchRulesHash: args.matchRulesHash,
        matchMode: prematchMode(args.opportunityArgs),
        matchScore: score.matchScore,
        categoryScore: score.categoryScore,
        wordScore: score.wordScore,
        eligible: true,
        estimatedCost: 1,
        status: "ready",
        raw: {
          product,
          productRaw: product.raw || {},
          clue,
          clueRaw: clue.raw || {},
          matchRulesHash: args.matchRulesHash
        }
      }, args.topKPerProduct);
    }
  }

  const candidates = flattenProductTopK(topMatches).map((candidate) => ({
    ...candidate,
    rankForProduct: (topMatches.get(productCandidateKey(candidate)) || []).findIndex((item) => item.id === candidate.id) + 1
  }));
  diagnostics.persistedCandidateCount = candidates.length;
  diagnostics.droppedByTopKCount = Math.max(0, diagnostics.passedThresholdCount - candidates.length);
  return { candidates, diagnostics };
}

function markProductRanks(args: {
  candidates: DoudianOpportunityPrematchCandidate[];
  topKPerProduct: number;
  opportunityArgs: OpportunityArgs;
  dedupeIndex: SubmitDedupeIndex;
  benefitIndex: Map<string, BenefitProductIndexRecord>;
}) {
  const grouped = new Map<string, DoudianOpportunityPrematchCandidate[]>();
  for (const candidate of args.candidates) {
    const key = productCandidateKey(candidate);
    const list = grouped.get(key) || [];
    list.push(candidate);
    grouped.set(key, list);
  }
  const ranked: DoudianOpportunityPrematchCandidate[] = [];
  for (const list of grouped.values()) {
    const filtered = rankCandidatesAfterFiltering(list, {
      limit: args.topKPerProduct,
      skipReason: (candidate) => {
        const historySkipReason = candidateHistorySkipReason({
          opportunityArgs: args.opportunityArgs,
          dedupeIndex: args.dedupeIndex,
          benefitIndex: args.benefitIndex
        }, {
          shopId: candidate.shopId,
          clueId: candidate.clueId,
          productId: candidate.productId,
          clueLastCategoryId: candidate.clueLastCategoryId
        });
        return historySkipReason || candidate.skipReason || "";
      }
    });
    filtered.ranked.forEach(({ candidate, rankForProduct }) => {
      const alternative = rankForProduct > 1;
      ranked.push({
        ...candidate,
        rankForProduct,
        alternative,
        eligible: !alternative,
        estimatedCost: alternative ? 0 : 1,
        status: alternative ? "alternative" : "ready",
        skipReason: undefined
      });
    });
    ranked.push(...filtered.skipped.map(({ candidate, skipReason }) => ({
      ...candidate,
      eligible: false,
      estimatedCost: 0,
      status: "skipped" as const,
      submitStatus: "skipped" as const,
      skipReason
    })));
  }
  return ranked.sort(compareCandidatesByEvidence);
}

function candidateRank(candidate: DoudianOpportunityPrematchCandidate) {
  const rank = Math.floor(Number(candidate.rankForProduct || 1));
  return Number.isFinite(rank) && rank > 0 ? rank : 1;
}

function isSubmitQualifiedCandidate(candidate: DoudianOpportunityPrematchCandidate) {
  if (candidate.skipReason) return false;
  if (!text(candidate.shopId) || !text(candidate.productId) || !text(candidate.clueId)) return false;
  const status = text(candidate.status);
  return status === "ready" || status === "alternative";
}

function compareFallbackCandidates(left: DoudianOpportunityPrematchCandidate, right: DoudianOpportunityPrematchCandidate) {
  const rankDiff = candidateRank(left) - candidateRank(right);
  if (rankDiff) return rankDiff;
  return compareCandidatesByEvidence(left, right);
}

function compareSubmitQueueCandidates(left: DoudianOpportunityPrematchCandidate, right: DoudianOpportunityPrematchCandidate) {
  const priorityDiff = (left.submitPriority === "fallback" ? 1 : 0) - (right.submitPriority === "fallback" ? 1 : 0);
  if (priorityDiff) return priorityDiff;
  return compareFallbackCandidates(left, right);
}

function selectStoreSubmitCandidates(args: {
  candidates: DoudianOpportunityPrematchCandidate[];
  dailyAttemptLimit: number;
  quotaUsedBefore: number;
  maxCandidates?: number;
  fallbackOnlyAfterPrimaryFailure?: boolean;
}) {
  const dailyAttemptLimit = Math.max(1, Math.floor(Number(args.dailyAttemptLimit || 1000)));
  const quotaUsedBefore = Math.max(0, Math.floor(Number(args.quotaUsedBefore || 0)));
  const quotaRemainingBefore = Math.max(0, dailyAttemptLimit - quotaUsedBefore);
  const primaryCandidates = args.candidates
    .filter((candidate) => candidateRank(candidate) <= 1 && isSubmitQualifiedCandidate(candidate))
    .sort(compareCandidatesByEvidence);
  const fallbackCandidates = args.candidates
    .filter((candidate) => candidateRank(candidate) > 1 && isSubmitQualifiedCandidate(candidate))
    .sort(compareFallbackCandidates);
  const runCapacity = Math.min(quotaRemainingBefore, Math.max(1, Math.floor(Number(args.maxCandidates || quotaRemainingBefore || 1))));
  const selectedPrimary = primaryCandidates.slice(0, runCapacity);
  const fallbackCapacity = Math.max(0, runCapacity - selectedPrimary.length);
  const selectedFallback = args.fallbackOnlyAfterPrimaryFailure === false ? fallbackCandidates.slice(0, fallbackCapacity) : [];
  const selectedPrimaryIds = new Set(selectedPrimary.map((candidate) => candidate.id));
  const selectedFallbackIds = new Set(selectedFallback.map((candidate) => candidate.id));
  const fallbackProductCount = new Set(fallbackCandidates.map((candidate) => candidate.productId)).size;
  const selectedIds = new Set([...selectedPrimaryIds, ...selectedFallbackIds]);
  const plannedSubmitCandidateCount = selectedIds.size;
  const quotaRemainingAfterPlan = Math.max(0, quotaRemainingBefore - plannedSubmitCandidateCount);
  const quotaSkipReason = quotaRemainingBefore <= 0 ? "今日提报尝试额度不足" : "未进入本次提报名额";
  const candidates = args.candidates.map((candidate) => {
    if (selectedPrimaryIds.has(candidate.id)) {
      return {
        ...candidate,
        alternative: false,
        eligible: true,
        estimatedCost: 1,
        status: "ready",
        submitPriority: "primary",
        fallbackSubmit: false,
        skipReason: undefined
      } satisfies DoudianOpportunityPrematchCandidate;
    }
    if (selectedFallbackIds.has(candidate.id)) {
      return {
        ...candidate,
        alternative: false,
        eligible: true,
        estimatedCost: 1,
        status: "ready",
        submitPriority: "fallback",
        fallbackSubmit: true,
        skipReason: undefined
      } satisfies DoudianOpportunityPrematchCandidate;
    }
    if (candidateRank(candidate) > 1 && isSubmitQualifiedCandidate(candidate)) {
      return {
        ...candidate,
        alternative: true,
        eligible: false,
        estimatedCost: 0,
        status: "alternative",
        submitPriority: "fallback",
        fallbackSubmit: true
      } satisfies DoudianOpportunityPrematchCandidate;
    }
    if (candidateRank(candidate) <= 1 && isSubmitQualifiedCandidate(candidate)) {
      return {
        ...candidate,
        eligible: false,
        estimatedCost: 0,
        status: "skipped",
        submitStatus: "skipped",
        submitPriority: "primary",
        fallbackSubmit: false,
        skipReason: candidate.skipReason || quotaSkipReason
      } satisfies DoudianOpportunityPrematchCandidate;
    }
    return candidate;
  });
  return {
    candidates,
    selectedIds,
    qualifiedCandidateCount: primaryCandidates.length + fallbackCandidates.length,
    primaryCandidateCount: primaryCandidates.length,
    fallbackCandidateCount: fallbackCandidates.length,
    plannedSubmitCandidateCount,
    primarySubmitCandidateCount: selectedPrimary.length,
    fallbackSubmitCandidateCount: args.fallbackOnlyAfterPrimaryFailure === false ? selectedFallback.length : fallbackProductCount,
    dailyAttemptLimit,
    quotaUsedBefore,
    quotaRemainingBefore,
    quotaRemainingAfterPlan
  };
}

async function enqueueStoreSubmit(args: {
  runId: string;
  storeRunId: string;
  identity: PipelineStoreIdentity;
  candidates: DoudianOpportunityPrematchCandidate[];
  snapshotVersion: string;
  inputCoverage: PipelineInputCoverage;
  candidateLimitPerProduct: number;
  contract: ReturnType<typeof submitTaskContract>;
}) {
  const writeCoverageComplete = pipelineInputCoverageAllowsWrite(args.inputCoverage);
  if (!writeCoverageComplete) {
    const blockedCandidates = args.candidates.map((candidate) => ({
      ...candidate,
      eligible: false,
      estimatedCost: 0,
      status: "skipped" as const,
      submitStatus: "skipped" as const,
      skipReason: candidate.skipReason || "input_coverage_not_complete"
    }));
    if (blockedCandidates.length) await repositoryPutMany(pipelineCandidateStore, blockedCandidates, { concurrency: 2 });
    return null;
  }
  const readyCandidates = args.candidates
    .filter((item) => item.eligible && item.status === "ready")
    .sort(compareSubmitQueueCandidates);
  const primaryProductIds = new Set(readyCandidates.map((item) => item.productId));
  const fallbackCountByProduct = new Map<string, number>();
  const fallbackCandidates = args.candidates
    .filter((item) => item.submitPriority === "fallback" && item.status === "alternative" && primaryProductIds.has(item.productId))
    .sort(compareSubmitQueueCandidates)
    .filter((item) => {
      const current = fallbackCountByProduct.get(item.productId) || 0;
      if (current >= Math.max(0, args.candidateLimitPerProduct - 1)) return false;
      fallbackCountByProduct.set(item.productId, current + 1);
      return true;
    });
  const taskCandidates = [...readyCandidates, ...fallbackCandidates];
  const candidateIds = taskCandidates.map((item) => item.id);
  if (!candidateIds.length) {
    if (args.candidates.length) await repositoryPutMany(pipelineCandidateStore, args.candidates, { concurrency: 2 });
    return null;
  }
  const concurrencyKey = storeScopeId(args.identity);
  const activeStatuses = ["preparing", "ready", "queued", "running", "cancelling", "cooling_down", "deferred", "deferred_contract_mismatch", "manual_reconcile"];
  const activeTasks = (await repositoryGetAll<PipelineSubmitTaskRecord>(pipelineSubmitTaskStore))
    .filter((task) => task.concurrencyKey === concurrencyKey && activeStatuses.includes(task.status));
  const currentRunTask = activeTasks.find((task) => task.runId === args.runId);
  if (currentRunTask && currentRunTask.status !== "preparing") return currentRunTask;
  const staleTasks = activeTasks.filter((task) => task.runId !== args.runId);
  for (const staleTask of staleTasks) {
    const mutationSummary = await loadOpportunityMutationSummary(staleTask.runId);
    const mutationCounts = mutationSummary?.byShop[staleTask.shopId];
    if (!canSupersedeContractMismatchTask(staleTask, mutationCounts)) {
      throw new Error(`店铺存在其他运行的未完成提报任务（${staleTask.status}），请先完成或核对该任务`);
    }
    const retiredAt = nowIso();
    await repositoryPut(pipelineSubmitTaskStore, {
      ...staleTask,
      status: "expired",
      ownerRunId: undefined,
      leaseExpiresAt: undefined,
      finishedAt: staleTask.finishedAt || retiredAt,
      lastError: `已由新运行 ${args.runId} 替代无法恢复的旧版本任务`,
      updatedAt: retiredAt
    } satisfies PipelineSubmitTaskRecord);
    await updatePipelineStoreRunProgress(staleTask.storeRunId, {
      status: "partial",
      phase: "finished",
      skipReason: "superseded_contract_mismatch",
      finishedAt: retiredAt
    });
    await writePipelineEvent({
      runId: staleTask.runId,
      storeRunId: staleTask.storeRunId,
      shopId: staleTask.shopId,
      level: "warn",
      event: "pipeline-submit-task-superseded",
      message: "旧版本提报任务无法恢复，已保存历史结果并由新运行重新规划",
      detail: { taskId: staleTask.id, supersededByRunId: args.runId }
    }).catch(() => undefined);
    await refreshPipelineRunSummary(staleTask.runId).catch(() => null);
  }
  const active = currentRunTask;
  const now = nowIso();
  const task: PipelineSubmitTaskRecord = {
    ...(active || {} as PipelineSubmitTaskRecord),
    id: active?.id || `${args.storeRunId}-task-1`,
    runId: args.runId,
    storeRunId: args.storeRunId,
    ...args.identity,
    status: "preparing",
    concurrencyKey,
    ownerRunId: args.runId,
    candidateIds,
    candidateCount: candidateIds.length,
    candidateIdsHash: stableHash([...candidateIds].sort()),
    snapshotVersion: args.snapshotVersion,
    inputCoverageStatus: writeCoverageComplete
      ? "complete"
      : args.inputCoverage.productScanStatus === "failed" || args.inputCoverage.benefitScanStatus === "failed" || args.inputCoverage.clueScanStatus === "failed"
        ? "failed"
        : "partial_coverage",
    productComplete: args.inputCoverage.productScanStatus === "complete",
    benefitComplete: args.inputCoverage.benefitScanStatus === "complete",
    clueCoverageSatisfied: args.inputCoverage.clueCoverageSatisfied,
    primaryCandidateCount: readyCandidates.filter((item) => item.submitPriority !== "fallback").length,
    fallbackCandidateCount: fallbackCandidates.length + readyCandidates.filter((item) => item.submitPriority === "fallback").length,
    submittedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    ...args.contract,
    createdAt: active?.createdAt || now,
    updatedAt: now
  };
  await repositoryPut(pipelineSubmitTaskStore, task);
  const taskCandidateIds = new Set(candidateIds);
  const persistedCandidates = args.candidates.map((candidate) => taskCandidateIds.has(candidate.id)
    ? {
        ...candidate,
        submitTaskId: task.id,
        submitStatus: candidate.eligible && candidate.status === "ready" ? "queued" : "fallback"
      }
    : candidate);
  await repositoryPutMany(pipelineCandidateStore, persistedCandidates, { concurrency: 2 });
  const snapshot = await repositoryGetMany<DoudianOpportunityPrematchCandidate>(pipelineCandidateStore, candidateIds);
  const snapshotHash = stableHash([...snapshot.map((candidate) => candidate.id)].sort());
  if (snapshot.length !== candidateIds.length || snapshotHash !== task.candidateIdsHash) {
    const failedAt = nowIso();
    const failedTask = {
      ...task,
      status: "failed" as const,
      lastError: "snapshot_incomplete",
      failedCount: Math.max(1, task.failedCount),
      finishedAt: failedAt,
      updatedAt: failedAt
    };
    await repositoryPut(pipelineSubmitTaskStore, failedTask);
    throw new Error("Submit task candidate snapshot is incomplete");
  }
  const readyTask = { ...task, status: "ready" as const, updatedAt: nowIso() };
  await repositoryPut(pipelineSubmitTaskStore, readyTask);
  return readyTask;
}

async function cancelPipelinePendingWorkForRun(runId: string, reason = "已取消商机提报任务") {
  const id = text(runId);
  if (!id) return;
  cancelledPipelineRunIds.add(id);
  const now = nowIso();
  const [storeRuns, tasks] = await Promise.all([
    loadPipelineStoreRunsForRun(id),
    loadPipelineSubmitTasksForRun(id)
  ]);
  const cancellableStoreRuns = storeRuns.filter((item) => item.status === "running" || item.status === "queued");
  if (cancellableStoreRuns.length) {
    await repositoryPutMany(pipelineStoreRunStore, cancellableStoreRuns.map((item) => ({
      ...item,
      status: "cancelled",
      phase: "finished",
      skipReason: item.skipReason || reason,
      updatedAt: now,
      finishedAt: item.finishedAt || now
    } satisfies PipelineStoreRunRecord)), { concurrency: 2 });
  }
  const cancellableTasks = tasks.filter((item) => ["preparing", "ready", "queued", "running", "cancelling", "cooling_down", "deferred", "deferred_contract_mismatch", "manual_reconcile"].includes(item.status));
  if (!cancellableTasks.length) return;
  await repositoryPutMany(pipelineSubmitTaskStore, cancellableTasks.map((item) => ({
    ...item,
    status: item.inFlightAttemptId ? "cancelling" : "cancelled",
    leaseExpiresAt: undefined,
    lastError: reason,
    updatedAt: now,
    finishedAt: item.inFlightAttemptId ? undefined : item.finishedAt || now
  } satisfies PipelineSubmitTaskRecord)), { concurrency: 2 });
  const taskIds = new Set(cancellableTasks.map((task) => task.id));
  const candidateIds = Array.from(new Set(
    cancellableTasks
      .flatMap((task) => task.candidateIds || [])
      .map(text)
      .filter(Boolean)
  ));
  const candidatePages = await Promise.all(
    chunk(candidateIds, 500).map((ids) => repositoryGetMany<DoudianOpportunityPrematchCandidate>(pipelineCandidateStore, ids).catch(() => []))
  );
  const candidates = candidatePages.flat();
  const updatedCandidates = candidates
    .filter((candidate) => candidate.submitTaskId && taskIds.has(candidate.submitTaskId))
    .filter((candidate) => candidate.submitStatus === "queued" || candidate.submitStatus === "fallback" || candidate.submitStatus === "retry_waiting" || candidate.status === "ready" || candidate.status === "alternative" || candidate.status === "retry_waiting")
    .map((candidate) => ({
      ...candidate,
      eligible: false,
      estimatedCost: 0,
      status: "skipped",
      submitStatus: "cancelled",
      skipReason: candidate.skipReason || reason
    } satisfies DoudianOpportunityPrematchCandidate));
  if (updatedCandidates.length) await repositoryPutMany(pipelineCandidateStore, updatedCandidates, { concurrency: 2 });
}

export async function cancelOpportunityPipelineSubmitTask(args: {
  operationId?: string;
  runId?: string;
  reason?: string;
} = {}) {
  const runId = text(args.runId || args.operationId);
  const reason = args.reason || "已取消商机提报任务";
  if (!runId) return { ok: false, status: "missing-run", message: "missing pipeline run id" };
  await cancelPipelinePendingWorkForRun(runId, reason);
  const refreshedRun = await refreshPipelineRunSummary(runId).catch(() => null);
  if (refreshedRun) {
    await repositoryPut(pipelineRunStore, {
      ...refreshedRun,
      status: "cancelled",
      updatedAt: nowIso()
    } satisfies PipelineRunRecord).catch(() => undefined);
  }
  return {
    ok: false,
    status: "cancelled",
    runId,
    operationId: args.operationId || runId,
    message: reason,
    summary: refreshedRun?.summary || {}
  };
}

async function refreshPipelineRunSummary(runId: string) {
  const run = await repositoryGet<PipelineRunRecord>(pipelineRunStore, runId).catch(() => null);
  if (!run) return null;
  const [storeRuns, tasks, mutationSummary, submitMetrics] = await Promise.all([
    loadPipelineStoreRunsForRun(runId),
    loadPipelineSubmitTasksForRunStrict(runId),
    loadOpportunityMutationSummary(runId),
    loadOpportunitySubmitRunMetrics(run)
  ]);
  let scopedStoreRuns = storeRuns.filter((item) => item.runId === runId);
  const scopedTasks = tasks.filter((item) => item.runId === runId);
  const hasMutationSummary = Boolean(mutationSummary?.total);
  if (hasMutationSummary) {
    const reconciledStoreRuns = scopedStoreRuns.map((storeRun) => {
      const counts = mutationSummary!.byShop[storeRun.shopId];
      if (!counts?.total) return storeRun;
      return {
        ...storeRun,
        submittedCount: Number(counts.acknowledged || 0) + Number(counts.confirmed || 0),
        failedCount: pipelineMutationTerminalFailureCount(counts),
        skippedCount: Number(counts.skipped || 0),
        safetySkippedCount: Number(counts.safetySkipped || 0),
        unknownCount: Number(counts.unknown || 0)
      } satisfies PipelineStoreRunRecord;
    });
    const changed = reconciledStoreRuns.filter((item, index) => {
      const previous = scopedStoreRuns[index];
      return item.submittedCount !== previous.submittedCount ||
        item.failedCount !== previous.failedCount ||
        item.skippedCount !== previous.skippedCount ||
        item.safetySkippedCount !== previous.safetySkippedCount ||
        item.unknownCount !== previous.unknownCount;
    });
    if (changed.length) await repositoryPutMany(pipelineStoreRunStore, changed, { concurrency: 2 });
    scopedStoreRuns = reconciledStoreRuns;
  }
  const taskStoreRunIds = new Set(scopedTasks.map((task) => task.storeRunId));
  const orphanedStoreRuns = orphanedSubmitQueueStoreRuns(scopedStoreRuns, scopedTasks);
  if (orphanedStoreRuns.length) {
    const repairedAt = nowIso();
    const orphanedIds = new Set(orphanedStoreRuns.map((item) => item.id));
    const repairedStoreRuns = orphanedStoreRuns.map((item) => ({
      ...item,
      status: "failed",
      phase: "finished" as const,
      failedCount: Math.max(1, Number(item.failedCount || 0)),
      skipReason: "submit_task_missing",
      updatedAt: repairedAt,
      finishedAt: item.finishedAt || repairedAt
    } satisfies PipelineStoreRunRecord));
    await repositoryPutMany(pipelineStoreRunStore, repairedStoreRuns, { concurrency: 2 });
    const repairedById = new Map(repairedStoreRuns.map((item) => [item.id, item]));
    scopedStoreRuns = scopedStoreRuns.map((item) => orphanedIds.has(item.id) ? repairedById.get(item.id)! : item);
    await Promise.all(repairedStoreRuns.map((item) => writePipelineEvent({
      runId,
      storeRunId: item.id,
      shopId: item.shopId,
      level: "error",
      event: "pipeline-submit-orphaned-store-run-repaired",
      message: "提报队列记录缺少对应任务，已自动结束以避免持续卡住",
      detail: { previousStatus: "queued", previousPhase: "submit-queued" }
    }).catch(() => undefined)));
  }
  const failedStoreCount = scopedStoreRuns.filter((item) => item.status === "failed" && !taskStoreRunIds.has(item.id)).length;
  const skippedStoreCount = scopedStoreRuns.filter((item) => item.status === "skipped" && !taskStoreRunIds.has(item.id)).length;
  const taskSubmittedCount = scopedTasks.reduce((sum, item) => sum + Number(item.submittedCount || 0), 0);
  const taskFailedCount = scopedTasks.reduce((sum, item) => sum + Number(item.failedCount || 0), 0);
  const taskSkippedCount = scopedTasks.reduce((sum, item) => sum + Number(item.skippedCount || 0), 0);
  const taskSafetySkippedCount = scopedTasks.reduce((sum, item) => sum + Number(item.safetySkippedCount || 0), 0);
  const submittedCount = hasMutationSummary
    ? Number(mutationSummary!.acknowledged || 0) + Number(mutationSummary!.confirmed || 0)
    : taskSubmittedCount;
  const failedCount = failedStoreCount + (hasMutationSummary
    ? pipelineMutationTerminalFailureCount(mutationSummary)
    : taskFailedCount);
  const skippedCount = skippedStoreCount + (hasMutationSummary
    ? Number(mutationSummary!.skipped || 0) + Math.max(0, taskSkippedCount - taskSafetySkippedCount)
    : taskSkippedCount);
  const candidateCount = scopedStoreRuns.reduce((sum, item) => sum + Number(item.candidateCount || 0), 0);
  const qualifiedCandidateCount = scopedStoreRuns.reduce((sum, item) => sum + Number(item.qualifiedCandidateCount || 0), 0);
  const eligibleCandidateCount = scopedStoreRuns.reduce((sum, item) => sum + Number(item.eligibleCandidateCount || 0), 0);
  const alternativeCandidateCount = scopedStoreRuns.reduce((sum, item) => sum + Number(item.alternativeCandidateCount || 0), 0);
  const plannedSubmitCandidateCount = scopedStoreRuns.reduce((sum, item) => sum + Number(item.plannedSubmitCandidateCount || 0), 0);
  const primarySubmitCandidateCount = scopedStoreRuns.reduce((sum, item) => sum + Number(item.primarySubmitCandidateCount || 0), 0);
  const fallbackSubmitCandidateCount = scopedStoreRuns.reduce((sum, item) => sum + Number(item.fallbackSubmitCandidateCount || 0), 0);
  const runningCount =
    scopedTasks.filter((item) => ["preparing", "ready", "queued", "running"].includes(item.status)).length +
    scopedStoreRuns.filter((item) => item.status === "queued" || item.status === "running").length;
  const deferredCount = scopedTasks.filter((item) => ["cooling_down", "deferred", "deferred_contract_mismatch", "manual_reconcile"].includes(item.status)).length;
  const automaticRecoveryPendingCount = scopedTasks.filter(pipelineTaskAwaitsAutomaticRecovery).length;
  const retryableRemainingCount = scopedTasks.reduce((sum, item) => sum + pipelineTaskRetryableRemainingCount(item), 0);
  const retryExhaustedCount = scopedTasks.filter((item) => item.deferredReason === "retry_exhausted").length;
  const unknownCount = hasMutationSummary ? Number(mutationSummary!.unknown || 0) : scopedTasks.reduce((sum, item) => sum + Number(item.unknownCount || 0), 0);
  const authorizationWaitingCount = scopedTasks.filter((item) => item.deferredReason === "authorization_wait").length;
  const contractMismatchCount = scopedTasks.filter((item) => item.status === "deferred_contract_mismatch" || item.deferredReason === "contract_mismatch").length;
  const inputCoveragePartialCount = scopedStoreRuns.filter((item) => item.inputCoverage && (
    item.inputCoverage.productScanStatus !== "complete"
    || item.inputCoverage.benefitScanStatus !== "complete"
    || item.inputCoverage.clueCoverageSatisfied !== true
  )).length;
  const productIncompleteCount = scopedStoreRuns.filter((item) => item.inputCoverage?.productScanStatus !== "complete").length;
  const benefitIncompleteCount = scopedStoreRuns.filter((item) => item.inputCoverage?.benefitScanStatus !== "complete").length;
  const clueCoverageUnsatisfiedCount = scopedStoreRuns.filter((item) => item.inputCoverage?.clueCoverageSatisfied !== true).length;
  const diagnosticsBlockCompletion = pipelineDiagnosticsBlockCompletion({
    productIncompleteCount,
    benefitIncompleteCount,
    clueCoverageUnsatisfiedCount
  });
  const status: PipelineRunRecord["status"] = run.status === "cancelled"
    ? "cancelled"
    : runningCount
      ? "running"
      : failedCount
        ? (submittedCount || skippedCount ? "partial" : "failed")
        : deferredCount || retryableRemainingCount || unknownCount || Number(mutationSummary?.pending || 0)
          ? "partial"
        : diagnosticsBlockCompletion
          ? "partial"
          : "ok";
  const safetySkippedCount = hasMutationSummary ? Number(mutationSummary!.safetySkipped || 0) : taskSafetySkippedCount;
  const quotaExhaustedCount = scopedTasks.reduce((sum, item) => sum + Number(item.quotaExhaustedCount || 0), 0);
  const cancelledCount = scopedTasks.reduce((sum, item) => sum + Number(item.cancelledCount || 0), 0);
  const remoteRequestCount = scopedTasks.reduce((sum, item) => sum + Number(item.remoteRequestCount || 0), 0);
  const estimatedSubmitGroupCount = scopedStoreRuns.reduce((sum, item) => sum + Number(item.estimatedSubmitGroupCount || 0), 0);
  const estimatedSubmitDurationMs = scopedStoreRuns.reduce((sum, item) => sum + Number(item.estimatedSubmitDurationMs || 0), 0);
  const firstHttpDispatchedMs = Date.parse(String(submitMetrics?.firstHttpDispatchedAt || ""));
  const lastHttpResolvedMs = Date.parse(String(submitMetrics?.lastHttpResolvedAt || ""));
  const submitPacingInitialIntervalMs = Number(run.summary?.submitPacingInitialIntervalMs || 15000);
  const submitWindowDurationMs = submitMetrics?.httpRequestAttemptCount
    ? Math.max(
      submitPacingInitialIntervalMs,
      Number.isFinite(firstHttpDispatchedMs) && Number.isFinite(lastHttpResolvedMs)
        ? Math.max(0, lastHttpResolvedMs - firstHttpDispatchedMs)
        : 0
    )
    : 0;
  const effectiveCompletionPerMinute = submitWindowDurationMs > 0
    ? Number(((submittedCount * 60000) / submitWindowDurationMs).toFixed(4))
    : 0;
  const summary: Record<string, number> = {
    ...(run.summary || {}),
    productCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.productCount || 0), 0),
    productFetchedCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.inputCoverage?.productFetchedCount || item.productCount || 0), 0),
    productRemoteTotal: scopedStoreRuns.reduce((sum, item) => sum + Number(item.inputCoverage?.productRemoteTotal || 0), 0),
    productRemoteTotalKnownStoreCount: scopedStoreRuns.filter((item) => item.inputCoverage?.productRemoteTotalKnown).length,
    productScanTruncatedCount: scopedStoreRuns.filter((item) => item.inputCoverage?.productScanStatus === "truncated").length,
    benefitProductCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.benefitProductCount || 0), 0),
    benefitAcquiredExposure: scopedStoreRuns.reduce((sum, item) => sum + Number(item.benefitAcquiredExposure || 0), 0),
    benefitEstimatedExposure: scopedStoreRuns.reduce((sum, item) => sum + Number(item.benefitEstimatedExposure || 0), 0),
    benefitAcquiredExposureParsedCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.benefitAcquiredExposureParsedCount || 0), 0),
    benefitAcquiredExposureUnparsedCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.benefitAcquiredExposureUnparsedCount || 0), 0),
    benefitEstimatedExposureParsedCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.benefitEstimatedExposureParsedCount || 0), 0),
    benefitEstimatedExposureUnparsedCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.benefitEstimatedExposureUnparsedCount || 0), 0),
    benefitSubmitRecordCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.benefitSubmitRecordCount || 0), 0),
    benefitAssociatedClueCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.benefitAssociatedClueCount || 0), 0),
    benefitSaturatedProductCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.benefitSaturatedProductCount || 0), 0),
    benefitFetchedUniqueProductCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.inputCoverage?.benefitFetchedUniqueProductCount || 0), 0),
    benefitRemoteTotal: scopedStoreRuns.reduce((sum, item) => sum + Number(item.inputCoverage?.benefitRemoteTotal || 0), 0),
    benefitRemoteTotalKnownStoreCount: scopedStoreRuns.filter((item) => item.inputCoverage?.benefitRemoteTotalKnown).length,
    benefitScanTruncatedCount: scopedStoreRuns.filter((item) => item.inputCoverage?.benefitScanStatus === "truncated").length,
    clueCoverageSatisfiedStoreCount: scopedStoreRuns.filter((item) => item.inputCoverage?.clueCoverageSatisfied === true).length,
    clueFetchedUniqueCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.inputCoverage?.clueFetchedUniqueCount || 0), 0),
    clueTruncatedCategoryCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.inputCoverage?.clueTruncatedCategoryCount || 0), 0),
    inputCoveragePartialCount,
    currentCategoryCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.currentCategoryCount || 0), 0),
    effectiveCategoryCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.effectiveCategoryCount || 0), 0),
    clueCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.clueCount || 0), 0),
    tokenCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.tokenCount || 0), 0),
    candidateCount,
    qualifiedCandidateCount,
    eligibleCandidateCount,
    alternativeCandidateCount,
    plannedSubmitCandidateCount,
    primarySubmitCandidateCount,
    fallbackSubmitCandidateCount,
    quotaUsedBefore: scopedStoreRuns.reduce((sum, item) => sum + Number(item.quotaUsedBefore || 0), 0),
    quotaRemainingBefore: scopedStoreRuns.reduce((sum, item) => sum + Number(item.quotaRemainingBefore || 0), 0),
    quotaRemainingAfterPlan: scopedStoreRuns.reduce((sum, item) => sum + Number(item.quotaRemainingAfterPlan || 0), 0),
    quotaAttemptCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.quotaAttemptCount ?? item.quotaUsedBefore ?? 0), 0),
    quotaRemainingAfterSubmit: scopedStoreRuns.reduce((sum, item) => sum + Number(item.quotaRemainingAfterSubmit || item.quotaRemainingAfterPlan || 0), 0),
    rawPairCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.rawPairCount || item.matchDiagnostics?.rawPairCount || 0), 0),
    passedThresholdCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.passedThresholdCount || item.matchDiagnostics?.passedThresholdCount || 0), 0),
    filteredByHistoryCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.filteredByHistoryCount || item.matchDiagnostics?.filteredByHistoryCount || 0), 0),
    filteredByNoTokenCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.filteredByNoTokenCount || item.matchDiagnostics?.filteredByNoTokenCount || 0), 0),
    filteredByWeakSingleTokenCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.filteredByWeakSingleTokenCount || item.matchDiagnostics?.filteredByWeakSingleTokenCount || 0), 0),
    filteredByThresholdCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.filteredByThresholdCount || item.matchDiagnostics?.filteredByThresholdCount || 0), 0),
    filteredByGenericOnlyCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.filteredByGenericOnlyCount || item.matchDiagnostics?.filteredByGenericOnlyCount || 0), 0),
    droppedByTopKCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.droppedByTopKCount || item.matchDiagnostics?.droppedByTopKCount || 0), 0),
    submitTaskCount: scopedTasks.length,
    orphanedSubmitQueueRepairCount: Number(run.summary?.orphanedSubmitQueueRepairCount || 0) + orphanedStoreRuns.length,
    deferredCount,
    automaticRecoveryPendingCount,
    pendingMutationCount: Number(mutationSummary?.pending || 0),
    retryableRemainingCount,
    retryExhaustedCount,
    throttleCount: Number(submitMetrics?.throttleCount ?? scopedTasks.reduce((sum, item) => sum + Number(item.throttleCount || 0), 0)),
    throttlePauseMs: scopedTasks.reduce((sum, item) => sum + Number(item.throttlePauseMs || 0), 0),
    recoveredAfterThrottleCount: Number(submitMetrics?.recoveredAfterThrottleCount || 0),
    globalThrottleCount: Number(submitMetrics?.globalThrottleCount || 0),
    maxStoreIntervalMs: Number(submitMetrics?.maxStoreIntervalMs || submitPacingInitialIntervalMs),
    averageStoreIntervalMs: Number(submitMetrics?.averageStoreIntervalMs || submitPacingInitialIntervalMs),
    globalRateMode: submitMetrics?.globalRateMode === "protective" ? 1 : 0,
    globalIntervalMs: Number(submitMetrics?.globalIntervalMs || run.summary?.submitGlobalPacingInitialMs || 15000),
    candidateMutationAttemptCount: Number(submitMetrics?.candidateMutationAttemptCount || 0),
    httpRequestAttemptCount: Number(submitMetrics?.httpRequestAttemptCount ?? remoteRequestCount),
    dailyCandidateMutationUsed: Number(submitMetrics?.dailyCandidateMutationUsed || 0),
    dailyCandidateMutationReserved: Number(submitMetrics?.dailyCandidateMutationReserved || 0),
    dailyCandidateMutationRemaining: Number(submitMetrics?.dailyCandidateMutationRemaining || 0),
    dailyHttpRequestUsed: Number(submitMetrics?.dailyHttpRequestUsed || 0),
    dailyHttpRequestReserved: Number(submitMetrics?.dailyHttpRequestReserved || 0),
    dailyHttpRequestRemaining: Number(submitMetrics?.dailyHttpRequestRemaining || 0),
    submitWindowDurationMs,
    effectiveCompletionPerMinute,
    manualReconcileCount: scopedTasks.filter((item) => item.status === "manual_reconcile").length,
    authorizationWaitingCount,
    contractMismatchCount,
    submittedCount,
    submitAcceptedCount: submittedCount,
    platformApprovedCount: 0,
    platformRejectedCount: 0,
    platformAuditPendingCount: submittedCount,
    platformAuditExpiredUnknownCount: 0,
    platformAuditManualObservation: 1,
    failedCount,
    skippedCount,
    safetySkippedCount,
    quotaExhaustedCount,
    cancelledCount,
    unknownCount,
    remoteRequestCount,
    estimatedSubmitGroupCount,
    estimatedSubmitDurationMs,
    mutationReconciled: hasMutationSummary ? 1 : 0,
    processedStoreCount: scopedStoreRuns.length,
    totalStoreCount: run.totalStoreCount
  };
  let concurrencyEvaluation = run.submitConcurrencyEvaluation;
  let concurrencyEvaluationChanged = false;
  if (status !== "running") {
    const previousRuns = (await repositoryGetAll<PipelineRunRecord>(pipelineRunStore).catch(() => []))
      .filter((item) => item.runId !== runId);
    const evaluation = evaluateSubmitConcurrencyReadiness(
      submitConcurrencySnapshot({ ...run, status, summary, updatedAt: nowIso() }),
      previousRuns.map(submitConcurrencySnapshot)
    );
    const signature = stableHash(JSON.stringify({
      decision: evaluation.decision,
      reasons: evaluation.reasons,
      evaluatedRunIds: evaluation.evaluatedRunIds,
      evidence: evaluation.evidence
    }));
    concurrencyEvaluationChanged = run.submitConcurrencyEvaluation?.signature !== signature;
    concurrencyEvaluation = concurrencyEvaluationChanged
      ? { ...evaluation, signature, evaluatedAt: nowIso() }
      : run.submitConcurrencyEvaluation;
    summary.submitConcurrencyDecisionCode = evaluation.decision === "eligible_for_canary_3"
      ? 1
      : evaluation.decision === "continue_canary_3"
        ? 2
        : evaluation.decision === "rollback_to_2"
          ? 3
          : 0;
    summary.submitConcurrencyStableRunCount = evaluation.stableRunCount;
  }
  const updated = {
    ...run,
    status,
    processedStoreCount: scopedStoreRuns.length,
    submittedCount,
    skippedCount,
    failedCount,
    summary,
    submitConcurrencyEvaluation: concurrencyEvaluation,
    updatedAt: nowIso()
  } satisfies PipelineRunRecord;
  await repositoryPut(pipelineRunStore, updated);
  if (concurrencyEvaluationChanged && concurrencyEvaluation) {
    await writePipelineEvent({
      runId,
      level: concurrencyEvaluation.decision === "rollback_to_2" ? "warn" : "info",
      event: "pipeline-submit-concurrency-evaluated",
      message: concurrencyEvaluation.decision,
      detail: { ...concurrencyEvaluation }
    }).catch(() => undefined);
  }
  return updated;
}

async function detectPipelineClientCapability(runId: string) {
  const native = window.chihuNative;
  let nativeTextSegment = false;
  let nativeTextSegmentAvailable = false;
  let tokenizerVersion = "";
  let tokenizerFallback = false;
  let fallbackReason = "";
  if (native?.text?.segment) {
    try {
      const result = await native.text.segment({ texts: ["pipeline segment smoke"], mode: "search", minTokenLength: 2 });
      nativeTextSegmentAvailable = Boolean(result?.tokenizerVersion && result.items?.[0]?.tokens?.length);
      tokenizerFallback = Boolean(result?.tokenizerFallback);
      fallbackReason = result?.fallbackReason || "";
      nativeTextSegment = nativeTextSegmentAvailable && !tokenizerFallback;
      tokenizerVersion = result?.tokenizerVersion || "";
    } catch {
      nativeTextSegment = false;
      nativeTextSegmentAvailable = false;
    }
  }
  let v2StoreSmokeOk = false;
  const smokeId = `${runId}-pipeline-v2-store-smoke`;
  try {
    await repositoryPut(pipelineOperationEventStore, {
      id: smokeId,
      runId,
      level: "info",
      event: "pipeline-v2-store-smoke",
      message: "pipeline v2 store smoke",
      createdAt: nowIso()
    } satisfies PipelineOperationEventRecord);
    const readBack = await repositoryGet<PipelineOperationEventRecord>(pipelineOperationEventStore, smokeId);
    await repositoryDelete(pipelineOperationEventStore, smokeId);
    v2StoreSmokeOk = readBack?.id === smokeId;
  } catch {
    v2StoreSmokeOk = false;
  }
  return {
    nativeTextSegment,
    nativeTextSegmentAvailable,
    tokenizerVersion,
    tokenizerFallback,
    fallbackReason,
    nativeDataStoreVersion: "native-record-store-v2",
    v2StoreSmokeOk
  };
}

function normalizeOpportunityMatchRules(value: DoudianOpportunityMatchRules = {}): DoudianOpportunityMatchRules {
  const ratio = Number(value.minTokenHitRatio ?? 0.33);
  const weightRatio = Number(value.minWeightHitRatio ?? 0.35);
  const topK = Math.floor(Number(value.topKPerProduct ?? 10));
  const genericTokenDfRatio = Number(value.genericTokenDfRatio ?? 0.12);
  return {
    storeCategoryKeys: uniqueText(value.storeCategoryKeys || []),
    minTokenHitRatio: Number.isFinite(ratio) ? Math.max(0.1, Math.min(1, ratio)) : 0.33,
    minWeightHitRatio: Number.isFinite(weightRatio) ? Math.max(0.05, Math.min(1, weightRatio)) : 0.35,
    topKPerProduct: Number.isFinite(topK) ? Math.max(1, Math.min(1000, topK)) : 10,
    genericTokenDfRatio: Number.isFinite(genericTokenDfRatio) ? Math.max(0.01, Math.min(1, genericTokenDfRatio)) : 0.12
  };
}

async function writePipelineEvent(record: Omit<PipelineOperationEventRecord, "id" | "createdAt"> & { createdAt?: string }) {
  const createdAt = record.createdAt || nowIso();
  await repositoryPut(pipelineOperationEventStore, {
    ...record,
    id: `${record.runId}-${record.storeRunId || record.shopId || "run"}-${createdAt}-${Math.random().toString(16).slice(2)}`,
    createdAt
  });
}

function dispatchPipelineProgress(args: OpportunityArgs, progress: number, message: string) {
  const operationId = text(args.operationId || args.runId);
  if (!operationId) return;
  dispatchDoudianProgress({
    operationId,
    taskType: "opportunityPipelineSubmit",
    status: "running",
    progress: Math.max(0, Math.min(99, Math.round(progress))),
    message
  });
}

function pipelineCancelled(args: OpportunityArgs) {
  const runId = text(args.runId || args.operationId || args.sourceRunId);
  return args.isCancelled?.() === true || (runId ? cancelledPipelineRunIds.has(runId) : false);
}

function targetStores(stores: DoudianStoreSummary[], shopIds: string[] = []) {
  const requested = new Set(shopIds.map(text).filter(Boolean));
  return requested.size ? stores.filter((store) => requested.has(store.shopId)) : stores;
}

function scanSummary(details: DoudianRunDetail[], clueRows: DoudianOpportunityClueRow[], products: DoudianOpportunityProductRow[], sourceHealth: Array<Record<string, unknown>>) {
  return {
    storeCount: details.length,
    successStoreCount: details.filter((detail) => detail.ok).length,
    failedStoreCount: details.filter((detail) => detail.ok === false).length,
    clueCount: clueRows.length,
    productCount: products.length,
    sourceFailureCount: sourceHealth.filter((item) => item.ok === false).length,
    fetchedPages: sourceHealth.length
  };
}

async function saveClueScan(record: ClueScanRunRecord) {
  await repositoryPut(clueScanStore, record);
  await repositoryPutMany(clueCandidateStore, record.rows.map((row) => ({ ...row, id: row.id })));
}

async function saveProductScan(record: ProductScanRunRecord) {
  await repositoryPut(productScanStore, record);
  await repositoryPutMany(productCandidateStore, record.products.map((row) => ({ ...row, id: row.id })));
}

async function savePrematchRun(record: PrematchRunRecord) {
  await repositoryPut(prematchRunStore, record);
  await repositoryPutMany(prematchCandidateStore, record.candidates.map((row) => ({ ...row, id: row.id })));
}

function prematchMode(args: OpportunityArgs): DoudianOpportunityPrematchMode {
  return args.matchMode === "loose" ? "loose" : "precise";
}

function todayKey() {
  return businessDateKey();
}

function pipelineOptions(args: OpportunityArgs) {
  return {
    skipSubmittedClueCategory: args.skipSubmittedClueCategory === true,
    skipSubmittedClue: args.skipSubmittedClue === true,
    skipSubmittedProductInSameClue: args.skipSubmittedProductInSameClue !== false
  };
}

function dailyAttemptLimit(args: OpportunityArgs, adapter: DoudianAdapterConfig) {
  const configured = Math.max(1, Math.min(10000, Math.floor(Number(args.dailyAttemptLimit || policyNumber(adapter, "opportunityReport.dailyAttemptLimit", 1000, 1, 10000)))));
  if (officialValidationMode(adapter) !== "enforce") return configured;
  return Math.min(configured, policyNumber(adapter, "opportunityReport.canaryDailyAttemptLimit", 10, 1, 1000));
}

function relationKey(value: { shopId?: string; clueId?: string; productId?: string }) {
  return [value.shopId, value.clueId, value.productId].map(text).join("::");
}

function clueKey(value: { shopId?: string; clueId?: string }) {
  return [value.shopId, value.clueId].map(text).join("::");
}

function clueCategoryKey(value: { shopId?: string; clueLastCategoryId?: string }) {
  return [value.shopId, value.clueLastCategoryId].map(text).join("::");
}

interface SubmitDedupeIndex {
  relationKeys: Set<string>;
  clueKeys: Set<string>;
  clueCategoryKeys: Set<string>;
}

function submittedForDedupe(value: { ok?: boolean; status?: string; stage?: string; planKey?: string; diagnostic?: Record<string, unknown> }) {
  const status = text(value.status).toLocaleLowerCase();
  if (status === "accepted" || status === "confirmed" || status === "already_submitted") return true;
  return isRemoteSubmittedExecution(value);
}

function structuredAttemptStatus(value: { ok?: boolean; status?: string }) {
  if (submittedForDedupe(value)) return "accepted";
  const status = text(value.status).toLocaleLowerCase();
  if (status === "prepared" || status === "sending") return status;
  if (status === "cancelled") return "cancelled";
  if (status === "unknown") return "unknown";
  if (status === "rejected") return "rejected";
  return "failed";
}

function structuredSubmitAttempt(record: SubmitAttemptRecord, countsAgainstDailyLimit = true) {
  const status = structuredAttemptStatus(record);
  const resolved = !["prepared", "sending"].includes(status);
  return {
    ...record,
    attemptId: record.id,
    attemptKey: record.id,
    executeRunId: record.runId,
    businessDate: record.date,
    tenantId: "local-user",
    clueCategoryId: record.clueLastCategoryId || "",
    relationKey: relationKey(record),
    clueKey: clueKey(record),
    clueCategoryKey: record.clueLastCategoryId ? clueCategoryKey(record) : "",
    status,
    countsAgainstDailyLimit,
    updatedAt: record.createdAt,
    sentAt: record.createdAt,
    resolvedAt: resolved ? record.createdAt : undefined
  };
}

async function persistSubmitAttemptRecords(records: SubmitAttemptRecord[], countsAgainstDailyLimit = true) {
  if (!records.length) return;
  if (await ensureStructuredSubmitAttempts()) {
    for (const batch of chunk(records.map((record) => structuredSubmitAttempt(record, countsAgainstDailyLimit)), 500)) {
      await getNativeData()!.opportunityAttempts!.putMany({ attempts: batch });
    }
    return;
  }
  await repositoryPutMany(submitAttemptStore, records);
}

function logicalSubmitAttemptRecord(args: {
  id: string;
  runId: string;
  candidate: DoudianOpportunityPrematchCandidate;
  status: "sending" | "accepted" | "already_submitted" | "failed" | "unknown" | "cancelled";
  message: string;
}) {
  return {
    id: args.id,
    date: todayKey(),
    runId: args.runId,
    matchRunId: args.runId,
    candidateId: args.candidate.id,
    shopId: args.candidate.shopId,
    shopName: args.candidate.shopName,
    clueId: args.candidate.clueId,
    clueName: args.candidate.clueName,
    clueCategoryName: args.candidate.clueCategoryName,
    clueLastCategoryId: args.candidate.clueLastCategoryId,
    clueLastCategoryKey: args.candidate.clueLastCategoryKey,
    productId: args.candidate.productId,
    title: args.candidate.title,
    status: args.status,
    ok: args.status === "accepted",
    message: args.message,
    stage: "submit",
    planKey: "opportunitySubmitClue",
    diagnostic: { logicalSubmitAttempt: true, pipelineCandidateId: args.candidate.id },
    createdAt: nowIso()
  } satisfies SubmitAttemptRecord;
}

async function ensureStructuredSubmitAttempts() {
  const api = getNativeData()?.opportunityAttempts;
  if (!api) return false;
  if (submitAttemptMigrationPromise) return submitAttemptMigrationPromise;
  submitAttemptMigrationPromise = (async () => {
    const marker = await repositoryGet<{ id: string; completedAt?: string }>("runtime_meta", submitAttemptMigrationMetaId).catch(() => null);
    if (marker?.completedAt) return true;
    const [legacyAttempts, executeRuns] = await Promise.all([
      repositoryGetAll<SubmitAttemptRecord>(submitAttemptStore).catch(() => []),
      repositoryGetAll<ExecuteRunRecord>(opportunityExecuteStore).catch(() => [])
    ]);
    const migrated: Array<Record<string, unknown>> = legacyAttempts.map((attempt) => structuredSubmitAttempt(attempt));
    for (const run of executeRuns) {
      for (const execution of run.executions || []) {
        if (execution.stage !== "submit" || execution.planKey !== "opportunitySubmitClue" || !submittedForDedupe(execution)) continue;
        const createdAt = run.updatedAt || run.createdAt;
        const attempt: SubmitAttemptRecord = {
          id: `legacy-execution-${run.runId}-${execution.id}`,
          date: businessDateKey(new Date(createdAt)),
          runId: run.runId,
          matchRunId: run.sourceRunId,
          shopId: execution.shopId,
          shopName: execution.shopName,
          clueId: execution.clueId || "",
          clueName: execution.clueName || "",
          productId: execution.productId || "",
          title: execution.title || "",
          status: execution.status,
          ok: execution.ok,
          message: execution.message,
          createdAt
        };
        migrated.push(structuredSubmitAttempt(attempt, false));
      }
    }
    for (const batch of chunk(migrated, 500)) await api.putMany({ attempts: batch });
    if (legacyAttempts.length) await repositoryDeleteMany(submitAttemptStore, legacyAttempts.map((item) => item.id));
    await api.cleanup({ failedRetentionDays: 90 }).catch(() => undefined);
    await repositoryPut("runtime_meta", {
      id: submitAttemptMigrationMetaId,
      completedAt: nowIso(),
      legacyAttemptCount: legacyAttempts.length,
      legacyExecutionAttemptCount: migrated.length - legacyAttempts.length
    });
    return true;
  })().catch(() => false);
  return submitAttemptMigrationPromise;
}

async function submitAttemptCountsByShop(date = todayKey()) {
  if (await ensureStructuredSubmitAttempts()) {
    const result = await getNativeData()!.opportunityAttempts!.count({ businessDate: date });
    return new Map(Object.entries(result.counts || {}).map(([shopId, count]) => [shopId, Number(count || 0)]));
  }
  const attempts = await repositoryGetAll<SubmitAttemptRecord>(submitAttemptStore).catch(() => []);
  const counts = new Map<string, number>();
  attempts.filter((item) => item.date === date).forEach((item) => counts.set(item.shopId, (counts.get(item.shopId) || 0) + 1));
  return counts;
}

async function submitAttemptCountForShop(shopId: string, date = todayKey()) {
  if (await ensureStructuredSubmitAttempts()) {
    const result = await getNativeData()!.opportunityAttempts!.count({ businessDate: date, shopId });
    return Number(result.count || 0);
  }
  const attempts = await repositoryGetAll<SubmitAttemptRecord>(submitAttemptStore).catch(() => []);
  return attempts.filter((item) => item.date === date && item.shopId === shopId).length;
}

async function submittedDedupeIndex(
  values: Array<{ shopId?: string; clueId?: string; productId?: string; clueLastCategoryId?: string }> = [],
  shopIds: string[] = []
): Promise<SubmitDedupeIndex> {
  const targetShopIds = new Set(shopIds.map(text).filter(Boolean));
  if (await ensureStructuredSubmitAttempts()) {
    const attempts = getNativeData()!.opportunityAttempts!;
    const keys = values.length
      ? await attempts.findDedupeKeys({
          relationKeys: uniqueText(values.map(relationKey)),
          clueKeys: uniqueText(values.map(clueKey)),
          clueCategoryKeys: uniqueText(values.filter((item) => item.clueLastCategoryId).map(clueCategoryKey))
        })
      : await attempts.listDedupeKeys({ shopIds: Array.from(targetShopIds) });
    return {
      relationKeys: new Set(keys.relationKeys || []),
      clueKeys: new Set(keys.clueKeys || []),
      clueCategoryKeys: new Set(keys.clueCategoryKeys || [])
    };
  }
  const relationKeys = new Set<string>();
  const clueKeys = new Set<string>();
  const clueCategoryKeys = new Set<string>();
  const attempts = await repositoryGetAll<SubmitAttemptRecord>(submitAttemptStore).catch(() => []);
  attempts.forEach((item) => {
    if (targetShopIds.size && !targetShopIds.has(text(item.shopId))) return;
    if (!submittedForDedupe(item)) return;
    relationKeys.add(relationKey(item));
    clueKeys.add(clueKey(item));
    if (item.clueLastCategoryId) clueCategoryKeys.add(clueCategoryKey(item));
  });
  const runs = await repositoryGetAll<ExecuteRunRecord>(opportunityExecuteStore).catch(() => []);
  for (const run of runs) {
    for (const item of run.executions || []) {
      if (targetShopIds.size && !targetShopIds.has(text(item.shopId))) continue;
      if (item.stage === "submit" && item.planKey === "opportunitySubmitClue" && submittedForDedupe(item)) {
        relationKeys.add(relationKey(item));
        clueKeys.add(clueKey(item));
      }
    }
  }
  return { relationKeys, clueKeys, clueCategoryKeys };
}

function shouldSkipSubmittedCandidate(
  args: OpportunityArgs,
  index: SubmitDedupeIndex,
  value: { shopId?: string; clueId?: string; productId?: string; clueLastCategoryId?: string }
) {
  if (args.skipSubmittedClueCategory === true && value.clueLastCategoryId && index.clueCategoryKeys.has(clueCategoryKey(value))) {
    return "已报商机类目";
  }
  if (args.skipSubmittedClue === true && index.clueKeys.has(clueKey(value))) {
    return "已报商机";
  }
  if (args.skipSubmittedProductInSameClue !== false && index.relationKeys.has(relationKey(value))) {
    return "已报商品（同一商机）";
  }
  return "";
}

function baseClueWords(clue: DoudianOpportunityClueRow) {
  return uniqueText([
    ...(clue.clueWords || []),
    clue.name,
    clue.shortName || ""
  ]).filter((word) => word.length > 1).slice(0, 12);
}

async function prematchClueWords(payload: DoudianAdapterPayload, stores: DoudianStoreSummary[], clue: DoudianOpportunityClueRow, dryRun = false) {
  const fallback = baseClueWords(clue);
  if (dryRun || !policyBoolean(payload.adapter, "opportunityReport.enableRemoteClueWords", false)) return fallback;
  const ref = clue.shopList.map((shop) => storeFromRef(stores, shop)).find(Boolean);
  if (!ref) return fallback;
  const words = await queryClueWords(payload, ref, clue, dryRun).catch(() => []);
  return uniqueText([...words, ...fallback]).filter((word) => word.length > 1).slice(0, 12);
}

function textIncludes(source: string, word: string) {
  return source.toLocaleLowerCase().includes(word.toLocaleLowerCase());
}

function categoryMatchScore(product: DoudianOpportunityProductRow, clue: DoudianOpportunityClueRow, mode: DoudianOpportunityPrematchMode) {
  if (product.categoryId && clue.lastCategoryId && text(product.categoryId) === text(clue.lastCategoryId)) {
    return { ok: true, score: 32, reason: "" };
  }
  const expected = splitCategoryPath(clue.categoryName);
  const actual = splitCategoryPath(product.categoryPath?.length ? product.categoryPath : product.raw?.category_path || product.raw?.categoryPath || product.category);
  if (!expected.length || !actual.length) {
    return mode === "loose"
      ? { ok: true, score: 6, reason: "" }
      : { ok: false, score: 0, reason: "类目信息不足" };
  }
  let prefix = 0;
  for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
    if (expected[index] !== actual[index]) break;
    prefix += 1;
  }
  const requiredDepth = clue.lastCategoryKey === "fourth_cid" ? 4 : clue.lastCategoryKey === "third_cid" ? 3 : 2;
  if (prefix >= Math.min(requiredDepth, expected.length, actual.length)) return { ok: true, score: 32, reason: "" };
  if (mode === "loose" && prefix >= 1) return { ok: true, score: 14, reason: "" };
  return { ok: false, score: 0, reason: "商品类目与商机类目不匹配" };
}

function scorePrematchCandidate(args: {
  product: DoudianOpportunityProductRow;
  clue: DoudianOpportunityClueRow;
  words: string[];
  mode: DoudianOpportunityPrematchMode;
}) {
  const category = categoryMatchScore(args.product, args.clue, args.mode);
  const words = args.words.filter(Boolean);
  const matchedWords = words.filter((word) => textIncludes(args.product.title, word));
  const wordRatio = words.length ? matchedWords.length / words.length : 0;
  const wordScore = Math.round(wordRatio * 58);
  const nameScore = args.clue.name && textIncludes(args.product.title, args.clue.name) ? 10 : 0;
  const score = Math.min(100, category.score + wordScore + nameScore);
  const requiredWords = args.mode === "precise"
    ? Math.max(1, Math.ceil(words.length * 0.6))
    : 1;
  const wordOk = matchedWords.length >= requiredWords;
  const threshold = args.mode === "precise" ? 76 : 45;
  const eligible = category.ok && wordOk && score >= threshold;
  const skipReason = category.ok
    ? wordOk ? (eligible ? "" : "匹配分不足") : "未命中足够商机词"
    : category.reason;
  return {
    matchedWords,
    wordScore,
    categoryScore: category.score,
    matchScore: score,
    eligible,
    skipReason
  };
}

function candidateFromMatch(args: {
  runId: string;
  productRunId: string;
  clueRunId: string;
  product: DoudianOpportunityProductRow;
  clue: DoudianOpportunityClueRow;
  words: string[];
  matchedWords: string[];
  matchMode: DoudianOpportunityPrematchMode;
  matchScore: number;
  categoryScore: number;
  wordScore: number;
  eligible: boolean;
  skipReason?: string;
}): DoudianOpportunityPrematchCandidate {
  const id = `${args.runId}-${args.product.shopId}-${args.product.productId}-${args.clue.clueId}`;
  return {
    id,
    candidateId: `${args.product.shopId}-${args.product.productId}-${args.clue.clueId}`,
    sourceRunId: args.runId,
    matchRunId: args.runId,
    productRunId: args.productRunId,
    clueRunId: args.clueRunId,
    shopId: args.product.shopId,
    shopName: args.product.shopName,
    group: args.product.group,
    productId: args.product.productId,
    title: args.product.title,
    productCategory: args.product.category,
    productCategoryId: args.product.categoryId,
    clueId: args.clue.clueId,
    clueName: args.clue.name,
    clueCategoryName: args.clue.categoryName,
    clueLastCategoryId: args.clue.lastCategoryId,
    clueLastCategoryKey: args.clue.lastCategoryKey,
    clueWords: args.words,
    matchedWords: args.matchedWords,
    matchMode: args.matchMode,
    matchScore: args.matchScore,
    categoryScore: args.categoryScore,
    wordScore: args.wordScore,
    eligible: args.eligible,
    estimatedCost: args.eligible ? 1 : 0,
    skipReason: args.skipReason,
    status: args.eligible ? "ready" : "skipped",
    raw: {
      product: args.product,
      productRaw: args.product.raw || {},
      clue: args.clue,
      clueRaw: args.clue.raw || {}
    }
  };
}

function compactProductRawForSubmit(product: DoudianOpportunityProductRow) {
  const raw = objectRecord(product.raw);
  const categoryDetail = objectRecord(raw.category_detail || raw.categoryDetail);
  return {
    pic_url: text(raw.pic_url || raw.picUrl || raw.img || raw.cover || product.img),
    category_id: text(
      raw.category_id ||
      raw.categoryId ||
      raw.leaf_category_id ||
      raw.leafCategoryId ||
      raw.category_leaf_id ||
      raw.categoryLeafId ||
      categoryDetail.leaf_cid ||
      categoryDetail.leafCid ||
      categoryDetail.fourth_cid ||
      categoryDetail.fourthCid ||
      categoryDetail.third_cid ||
      categoryDetail.thirdCid ||
      categoryDetail.second_cid ||
      categoryDetail.secondCid ||
      categoryDetail.first_cid ||
      categoryDetail.firstCid ||
      product.categoryId
    ),
    category_path: text(raw.category_path || raw.categoryPath || product.category),
    stock_num: coerceNumber(raw.stock_num || raw.stockNum || raw.stock || product.stock) || 0,
    sell_num: coerceNumber(raw.sell_num || raw.sellNum || raw.sale_num || raw.saleNum || product.sales) || 0,
    price: coerceNumber(raw.price || raw.min_price || raw.minPrice || raw.product_price_min || raw.productPriceMin) || 0,
    product_price_min: coerceNumber(raw.product_price_min || raw.productPriceMin) || 0,
    product_price_max: coerceNumber(raw.product_price_max || raw.productPriceMax || raw.max_price || raw.maxPrice) || 0,
    audit_time: coerceNumber(raw.audit_time || raw.auditTime || raw.audit_time_num || raw.auditTimeNum) || 0,
    brand_id: platformNumberId(raw.brand_id || raw.brandId),
    brand_name: text(raw.brand_name || raw.brandName),
    art_number: text(raw.art_number || raw.artNumber)
  };
}

function compactPipelineCandidate(candidate: DoudianOpportunityPrematchCandidate): DoudianOpportunityPrematchCandidate {
  const raw = objectRecord(candidate.raw);
  const product = objectRecord(raw.product);
  const clue = objectRecord(raw.clue);
  return {
    ...candidate,
    raw: {
      product: {
        categoryName: text(product.categoryName || candidate.productCategory),
        categoryPath: Array.isArray(product.categoryPath) ? product.categoryPath.map(text).filter(Boolean) : normalizeCategoryPath(candidate.productCategory),
        lastCategoryKey: text(product.lastCategoryKey),
        price: coerceNumber(product.price) || 0,
        stock: coerceNumber(product.stock) || 0,
        sales: coerceNumber(product.sales) || 0
      },
      productRaw: compactProductRawForSubmit(candidateToProduct(candidate)),
      clue: {
        shortName: text(clue.shortName),
        recommendList: Array.isArray(clue.recommendList) ? clue.recommendList.map(text).filter(Boolean).slice(0, 12) : [],
        profitInfoList: Array.isArray(clue.profitInfoList) ? clue.profitInfoList.map(text).filter(Boolean).slice(0, 12) : []
      },
      matchRulesHash: text(raw.matchRulesHash || candidate.matchRulesHash)
    }
  };
}

function candidateToProduct(candidate: DoudianOpportunityPrematchCandidate): DoudianOpportunityProductRow {
  const raw = objectRecord(candidate.raw);
  const product = objectRecord(raw.product);
  const productRaw = objectRecord(raw.productRaw);
  const productTitle = text(
    productRaw.title ||
    productRaw.name ||
    productRaw.product_name ||
    productRaw.productName ||
    productRaw.product_title ||
    productRaw.productTitle ||
    productRaw.goods_name ||
    productRaw.goodsName ||
    productRaw.goods_title ||
    productRaw.goodsTitle ||
    productRaw.item_name ||
    productRaw.itemName ||
    productRaw.item_title ||
    productRaw.itemTitle ||
    candidate.title
  );
  return {
    id: `${candidate.matchRunId}-${candidate.shopId}-${candidate.productId}`,
    candidateId: `${candidate.shopId}-${candidate.productId}`,
    sourceRunId: candidate.productRunId,
    shopId: candidate.shopId,
    shopName: candidate.shopName,
    group: candidate.group,
    productId: candidate.productId,
    title: candidate.title,
    category: candidate.productCategory,
    categoryId: candidate.productCategoryId,
    categoryName: text(product.categoryName || candidate.productCategory),
    categoryPath: Array.isArray(product.categoryPath) ? product.categoryPath.map(text).filter(Boolean) : normalizeCategoryPath(candidate.productCategory),
    lastCategoryKey: text(product.lastCategoryKey),
    price: coerceNumber(product.price) || 0,
    stock: coerceNumber(product.stock) || 0,
    sales: coerceNumber(product.sales) || 0,
    matchedClueId: candidate.clueId,
    matchedClueName: candidate.clueName,
    status: "matched",
    raw: {
      ...productRaw,
      ...productTitleAliases(productTitle)
    }
  };
}

function candidateToClue(candidate: DoudianOpportunityPrematchCandidate): DoudianOpportunityClueRow {
  const raw = objectRecord(candidate.raw);
  const clue = objectRecord(raw.clue);
  return {
    id: `${candidate.matchRunId}-${candidate.shopId}-${candidate.clueId}`,
    candidateId: `${candidate.shopId}-${candidate.clueId}`,
    sourceRunId: candidate.clueRunId,
    clueId: candidate.clueId,
    name: candidate.clueName,
    shortName: text(clue.shortName),
    categoryName: candidate.clueCategoryName,
    lastCategoryId: candidate.clueLastCategoryId,
    lastCategoryKey: candidate.clueLastCategoryKey,
    clueWords: candidate.clueWords,
    recommendList: Array.isArray(clue.recommendList) ? clue.recommendList.map(text).filter(Boolean) : [],
    profitInfoList: Array.isArray(clue.profitInfoList) ? clue.profitInfoList.map(text).filter(Boolean) : [],
    shopList: [{ shopId: candidate.shopId, shopName: candidate.shopName, group: candidate.group }],
    shopId: candidate.shopId,
    shopName: candidate.shopName,
    group: candidate.group,
    status: "ready",
    raw: objectRecord(raw.clueRaw)
  };
}

async function loadProductsForRun(runId: string) {
  if (!runId) return [];
  const products = await repositoryGetAll<DoudianOpportunityProductRow>(productCandidateStore).catch(() => []);
  return products.filter((product) => product.sourceRunId === runId);
}

async function loadCluesForRun(runId: string) {
  if (!runId) return [];
  const clues = await repositoryGetAll<DoudianOpportunityClueRow>(clueCandidateStore).catch(() => []);
  return clues.filter((clue) => clue.sourceRunId === runId);
}

async function loadPrematchCandidates(args: OpportunityArgs) {
  const matchRunId = args.matchRunId || args.sourceRunId || "";
  if (!matchRunId) return [];
  const selected = selectionSet(args.candidateIds);
  const stored = await repositoryGetAll<DoudianOpportunityPrematchCandidate>(prematchCandidateStore).catch(() => []);
  return stored.filter((row) => {
    if (row.matchRunId !== matchRunId && row.sourceRunId !== matchRunId) return false;
    if (!selected.size) return true;
    return selected.has(row.id) || selected.has(row.candidateId || "");
  });
}

async function loadPrematchesForRun(runId: string) {
  if (!runId) return [];
  const stored = await repositoryGetAll<DoudianOpportunityPrematchCandidate>(prematchCandidateStore).catch(() => []);
  return stored.filter((row) => row.matchRunId === runId || row.sourceRunId === runId);
}

async function latestRunId<T extends { updatedAt: string; runId: string }>(storeName: typeof productScanStore | typeof clueScanStore) {
  const runs = await repositoryGetAll<T>(storeName).catch(() => []);
  return runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0]?.runId || "";
}

async function fetchClueScan(payload: DoudianAdapterPayload, args: OpportunityArgs): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds);
  const runId = args.operationId || `opportunity-clue-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (!targets.length) return { ...ledger, ok: false, status: "no-store", mode: "clue-scan", message: "No Doudian stores selected", rows: [], clues: [], products: [], executions: [] };

  const details: DoudianRunDetail[] = [];
  const sourceHealth: Array<Record<string, unknown>> = [];
  const collected: DoudianOpportunityClueRow[] = [];
  for (const [index, store] of targets.entries()) {
    try {
      const result = await scanCluesForStore(payload, store, args, runId, index + 1, targets.length);
      collected.push(...result.rows);
      details.push(result.detail);
      sourceHealth.push(...result.sourceHealth);
    } catch (error) {
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        status: "failed",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        reason: "opportunity-clue-scan-error",
        category: "api",
        index: index + 1,
        total: targets.length
      });
    }
  }
  const rows = mergeClues(collected);
  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.filter((detail) => detail.ok === false).length;
  const status = failureCount ? (successCount ? "partial" : "failed") : "ok";
  const summary = scanSummary(details, rows, [], sourceHealth);
  const message = failureCount
    ? policyMessage(payload.adapter, "opportunityReport.messages.clueScanPartial", "Opportunity clue scan partially failed", { successCount, failureCount })
    : policyMessage(payload.adapter, "opportunityReport.messages.clueScanDone", "Opportunity clue scan done", { count: rows.length });
  const now = nowIso();
  await saveClueScan({
    id: runId,
    mode: "clue-scan",
    runId,
    operationId: args.operationId,
    status,
    rows,
    details,
    scanSummary: summary,
    sourceHealth,
    filters: args.filters || {},
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    requestPlanHash: requestPlanHash(payload.adapter),
    createdAt: now,
    updatedAt: now
  });
  return {
    ...ledger,
    ok: failureCount === 0,
    status,
    mode: "clue-scan",
    message,
    runId,
    operationId: args.operationId,
    rows,
    clues: rows,
    products: [],
    executions: [],
    details,
    successCount,
    failureCount,
    partialCount: failureCount,
    summary,
    scanSummary: summary,
    sourceHealth,
    filters: args.filters || {},
    requestPlanHash: requestPlanHash(payload.adapter)
  };
}

async function fetchProductScan(payload: DoudianAdapterPayload, args: OpportunityArgs): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds);
  const runId = args.operationId || `opportunity-product-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (!targets.length) return { ...ledger, ok: false, status: "no-store", mode: "product-scan", message: "No Doudian stores selected", rows: [], clues: [], products: [], executions: [] };

  const details: DoudianRunDetail[] = [];
  const sourceHealth: Array<Record<string, unknown>> = [];
  const products: DoudianOpportunityProductRow[] = [];
  for (const [index, store] of targets.entries()) {
    try {
      const result = await scanProductsForStore(payload, store, args, runId, index + 1, targets.length);
      products.push(...result.products);
      details.push(result.detail);
      sourceHealth.push(...result.sourceHealth);
    } catch (error) {
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        status: "failed",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        reason: "opportunity-product-scan-error",
        category: "api",
        index: index + 1,
        total: targets.length
      });
    }
  }
  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.filter((detail) => detail.ok === false).length;
  const status = failureCount ? (successCount ? "partial" : "failed") : "ok";
  const summary = scanSummary(details, [], products, sourceHealth);
  const message = failureCount
    ? policyMessage(payload.adapter, "opportunityReport.messages.productScanPartial", "Opportunity product scan partially failed", { successCount, failureCount })
    : policyMessage(payload.adapter, "opportunityReport.messages.productScanDone", "Opportunity product scan done", { count: products.length });
  const now = nowIso();
  await saveProductScan({
    id: runId,
    mode: "product-scan",
    runId,
    operationId: args.operationId,
    status,
    products,
    details,
    scanSummary: summary,
    sourceHealth,
    filters: args.filters || {},
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    requestPlanHash: requestPlanHash(payload.adapter),
    createdAt: now,
    updatedAt: now
  });
  return {
    ...ledger,
    ok: failureCount === 0,
    status,
    mode: "product-scan",
    message,
    runId,
    operationId: args.operationId,
    rows: [],
    clues: [],
    products,
    executions: [],
    details,
    successCount,
    failureCount,
    partialCount: failureCount,
    summary,
    scanSummary: summary,
    sourceHealth,
    filters: args.filters || {},
    requestPlanHash: requestPlanHash(payload.adapter)
  };
}

async function fetchProductPrematch(payload: DoudianAdapterPayload, args: OpportunityArgs): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const productRunId = args.productRunId || await latestRunId<ProductScanRunRecord>(productScanStore);
  const clueRunId = args.clueRunId || await latestRunId<ClueScanRunRecord>(clueScanStore);
  const runId = args.operationId || `opportunity-prematch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const mode = prematchMode(args);
  if (!productRunId || !clueRunId) {
    return { ...ledger, ok: false, status: "missing-source-run", mode: "product-prematch", message: "需要先同步商品并扫描商机", rows: [], clues: [], products: [], prematches: [], executions: [] };
  }

  const products = await loadProductsForRun(productRunId);
  const clues = await loadCluesForRun(clueRunId);
  if (!products.length || !clues.length) {
    return { ...ledger, ok: false, status: "empty-source-run", mode: "product-prematch", message: "商品或商机快照为空", rows: clues, clues, products, prematches: [], executions: [] };
  }

  const requested = new Set((args.shopIds || []).map(text).filter(Boolean));
  const scopedProducts = products.filter((product) => !requested.size || requested.has(product.shopId));
  const scopedClues = clues.map((clue) => ({
    ...clue,
    shopList: clue.shopList.filter((shop) => !requested.size || requested.has(shop.shopId))
  })).filter((clue) => clue.shopList.length);
  const maxProducts = policyNumber(payload.adapter, "opportunityReport.maxPrematchProducts", 10000, 1, 50000);
  const maxClues = policyNumber(payload.adapter, "opportunityReport.maxPrematchClues", 80, 1, 500);
  const maxCandidates = policyNumber(payload.adapter, "opportunityReport.maxPrematchCandidates", 2000, 1, 50000);
  const limitedProducts = scopedProducts.slice(0, maxProducts);
  const limitedClues = scopedClues.slice(0, maxClues);
  const productsByShop = new Map<string, DoudianOpportunityProductRow[]>();
  for (const product of limitedProducts) {
    const list = productsByShop.get(product.shopId) || [];
    list.push(product);
    productsByShop.set(product.shopId, list);
  }

  const candidates: DoudianOpportunityPrematchCandidate[] = [];
  const wordCache = new Map<string, string[]>();
  for (const clue of limitedClues) {
    const words = wordCache.get(clue.clueId) || await prematchClueWords(payload, stores, clue, args.dryRun);
    wordCache.set(clue.clueId, words);
    for (const shop of clue.shopList) {
      const shopProducts = productsByShop.get(shop.shopId) || [];
      for (const product of shopProducts) {
        const scored = scorePrematchCandidate({ product, clue, words, mode });
        const eligible = scored.eligible;
        const skipReason = scored.skipReason;
        if (scored.matchScore <= 0 && !eligible) continue;
        candidates.push(candidateFromMatch({
          runId,
          productRunId,
          clueRunId,
          product,
          clue,
          words,
          matchedWords: scored.matchedWords,
          matchMode: mode,
          matchScore: scored.matchScore,
          categoryScore: scored.categoryScore,
          wordScore: scored.wordScore,
          eligible,
          skipReason
        }));
      }
    }
  }

  const sorted = candidates.sort((left, right) => right.matchScore - left.matchScore).slice(0, maxCandidates);
  const dedupeIndex = await submittedDedupeIndex(sorted);
  const historyFiltered = sorted.map((candidate) => {
    if (!candidate.eligible) return candidate;
    const submittedSkipReason = shouldSkipSubmittedCandidate(args, dedupeIndex, candidate);
    return submittedSkipReason
      ? { ...candidate, eligible: false, estimatedCost: 0, status: "skipped" as const, skipReason: submittedSkipReason }
      : candidate;
  });
  const bestByProduct = new Set<string>();
  const deduped = historyFiltered.map((candidate) => {
    if (mode !== "precise" || !candidate.eligible) return candidate;
    const key = `${candidate.shopId}::${candidate.productId}`;
    if (!bestByProduct.has(key)) {
      bestByProduct.add(key);
      return candidate;
    }
    return {
      ...candidate,
      eligible: false,
      estimatedCost: 0,
      status: "skipped",
      skipReason: "同商品已有更高分商机"
    };
  });

  const details: DoudianRunDetail[] = Array.from(new Map(deduped.map((candidate) => [candidate.shopId, candidate.shopName])).entries()).map(([shopId, shopName], index, list) => {
    const shopCandidates = deduped.filter((candidate) => candidate.shopId === shopId);
    const eligibleCount = shopCandidates.filter((candidate) => candidate.eligible).length;
    return {
      shopId,
      shopName,
      status: eligibleCount ? "ok" : "empty",
      ok: true,
      message: `生成 ${eligibleCount} 个可提报候选`,
      diagnostic: { candidateCount: shopCandidates.length, eligibleCount },
      index: index + 1,
      total: list.length
    };
  });
  const limit = dailyAttemptLimit(args, payload.adapter);
  const usedByShop = await submitAttemptCountsByShop();
  const summaryShopIds = uniqueText(deduped.map((candidate) => candidate.shopId));
  const dailyAttemptUsed = summaryShopIds.reduce((sum, shopId) => sum + (usedByShop.get(shopId) || 0), 0);
  const dailyAttemptRemaining = summaryShopIds.reduce((sum, shopId) => sum + Math.max(0, limit - (usedByShop.get(shopId) || 0)), 0);
  const summary = {
    productCount: limitedProducts.length,
    clueCount: limitedClues.length,
    candidateCount: deduped.length,
    eligibleCount: deduped.filter((candidate) => candidate.eligible).length,
    skippedCount: deduped.filter((candidate) => !candidate.eligible).length,
    estimatedCost: deduped.reduce((sum, candidate) => sum + Number(candidate.estimatedCost || 0), 0),
    dailyAttemptLimit: limit,
    dailyAttemptUsed,
    dailyAttemptRemaining
  };
  const now = nowIso();
  await savePrematchRun({
    id: runId,
    mode: "product-prematch",
    runId,
    operationId: args.operationId,
    productRunId,
    clueRunId,
    status: "ok",
    matchMode: mode,
    candidates: deduped,
    details,
    summary,
    filters: args.filters || {},
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    requestPlanHash: requestPlanHash(payload.adapter),
    createdAt: now,
    updatedAt: now
  });
  return {
    ...ledger,
    ok: true,
    status: "ok",
    mode: "product-prematch",
    message: `已生成 ${summary.eligibleCount} 个可提报候选`,
    runId,
    sourceRunId: runId,
    productRunId,
    clueRunId,
    matchRunId: runId,
    rows: clues,
    clues,
    products,
    prematches: deduped,
    executions: [],
    details,
    summary,
    filters: args.filters || {},
    requestPlanHash: requestPlanHash(payload.adapter),
    dailyAttemptLimit: limit,
    dailyAttemptUsed,
    dailyAttemptRemaining
  };
}

function selectionSet(...values: Array<string[] | undefined>) {
  return new Set(values.flatMap((items) => items || []).map(text).filter(Boolean));
}

async function loadSelectedClues(args: OpportunityArgs) {
  if (!args.sourceRunId) return [];
  const selected = selectionSet(args.clueIds);
  if (!selected.size) return [];
  const stored = await repositoryGetAll<DoudianOpportunityClueRow>(clueCandidateStore).catch(() => []);
  return stored.filter((row) => {
    if (row.sourceRunId !== args.sourceRunId) return false;
    return selected.has(row.id) || selected.has(row.clueId) || selected.has(row.candidateId || "");
  });
}

async function loadSelectedProducts(args: OpportunityArgs) {
  if (!args.sourceRunId) return [];
  const selected = selectionSet(args.productIds);
  if (!selected.size) return [];
  const stored = await repositoryGetAll<DoudianOpportunityProductRow>(productCandidateStore).catch(() => []);
  return stored.filter((row) => {
    if (row.sourceRunId !== args.sourceRunId) return false;
    return selected.has(row.id) || selected.has(row.productId) || selected.has(row.candidateId || "");
  });
}

function submitMode(args: OpportunityArgs): DoudianOpportunitySubmitMode {
  return args.submitMode === "updateTitle" ? "updateTitle" : "validate";
}

function goodsMatchType(args: OpportunityArgs): DoudianOpportunityGoodsMatchType {
  return args.goodsMatchType === "official" ? "official" : "new";
}

function titleMatchMode(args: OpportunityArgs | { titleMatchMode?: string }): DoudianOpportunityTitleMatchMode {
  return args.titleMatchMode === "all" ? "all" : "any";
}

function titleUpdatePosition(args: OpportunityArgs | { titleUpdatePosition?: string }): DoudianOpportunityTitleUpdatePosition {
  return args.titleUpdatePosition === "head" ? "head" : "tail";
}

function titleHasClueWord(title: string, words: string[], matchMode: DoudianOpportunityTitleMatchMode) {
  const nextWords = words.map(text).filter(Boolean);
  if (!nextWords.length) return false;
  return matchMode === "all"
    ? nextWords.every((word) => title.includes(word))
    : nextWords.some((word) => title.includes(word));
}

function titleWithClueWord(
  title: string,
  words: string[],
  adapter: DoudianAdapterConfig,
  position: DoudianOpportunityTitleUpdatePosition
) {
  const maxLength = policyNumber(adapter, "opportunityReport.maxTitleLength", 60, 20, 120);
  const baseTitle = title.slice(0, maxLength);
  const wordText = uniqueText(words).join("").slice(0, maxLength);
  if (!wordText) return baseTitle;
  if (wordText.length >= maxLength) return wordText.slice(0, maxLength);
  if (position === "head") return `${wordText}${baseTitle.slice(wordText.length)}`.slice(0, maxLength);
  return `${baseTitle.slice(0, Math.max(0, maxLength - wordText.length))}${wordText}`.slice(0, maxLength);
}

function officialPlanHash(adapter: DoudianAdapterConfig, planKey: "opportunityClueWords" | "opportunityClueGoodsList") {
  const plan = objectRecord(adapter.requestPlans?.[planKey]);
  const endpointKey = text(plan.endpointKey || planKey);
  return stableHash({
    adapterVersion: adapter.version || "",
    planKey,
    endpoint: adapter.endpoints?.[endpointKey] || "",
    plan,
    mappings: planKey === "opportunityClueWords"
      ? { paths: mappingArray(adapter, "clueWordPaths") }
      : {
          listPaths: mappingArray(adapter, "clueGoodsListPaths"),
          totalPaths: mappingArray(adapter, "clueGoodsTotalPaths"),
          successStatusPaths: mappingArray(adapter, "clueGoodsSuccessStatusPaths"),
          successCodes: mappingArray(adapter, "clueGoodsSuccessCodes")
        },
    pageSize: planKey === "opportunityClueGoodsList" ? policy(adapter, "opportunityReport.officialProductPageSize") : undefined,
    maxPages: planKey === "opportunityClueGoodsList" ? policy(adapter, "opportunityReport.maxOfficialProductPages") : undefined
  });
}

function officialWordsCacheKey(adapter: DoudianAdapterConfig, identity: PipelineStoreIdentity, clueId: string, semantics: OfficialWordsSemantics) {
  return stableHash([
    "official-words-v1",
    storeScopeId(identity),
    clueId,
    adapter.version || "",
    officialPlanHash(adapter, "opportunityClueWords"),
    policyText(adapter, "opportunityReport.officialWordsContractVersion", "official-words-contract-unverified-v1"),
    semantics
  ].join("|"));
}

function officialGoodsCacheKey(adapter: DoudianAdapterConfig, identity: PipelineStoreIdentity, clue: DoudianOpportunityClueRow, contractMode: OfficialGoodsContractMode) {
  return stableHash([
    "official-goods-v1",
    identity.tenantId,
    identity.shopId,
    identity.storeGeneration,
    clue.clueId,
    clue.lastCategoryKey || "third_cid",
    clue.lastCategoryId || "",
    adapter.version || "",
    officialPlanHash(adapter, "opportunityClueGoodsList"),
    policyText(adapter, "opportunityReport.officialGoodsContractVersion", "official-goods-contract-unverified-v1"),
    contractMode
  ].join("|"));
}

async function queryOfficialClueWords(args: {
  payload: DoudianAdapterPayload;
  store: DoudianStoreSummary;
  clue: DoudianOpportunityClueRow;
  opportunityArgs?: OpportunityArgs;
  shouldCancel?: () => boolean;
}): Promise<OfficialClueWordsResult & { cacheKey: string }> {
  const identity = normalizePipelineStoreIdentity(args.store);
  const semantics = args.opportunityArgs?.mockOfficialWordsContract?.[args.clue.clueId] || officialWordsSemantics(args.payload.adapter);
  const contractVersion = policyText(args.payload.adapter, "opportunityReport.officialWordsContractVersion", "official-words-contract-unverified-v1");
  const body = { clue_id: platformIntId(args.clue.clueId) };
  const requestHash = stableHash({ planHash: officialPlanHash(args.payload.adapter, "opportunityClueWords"), body });
  const cacheKey = officialWordsCacheKey(args.payload.adapter, identity, args.clue.clueId, semantics);
  const cached = await repositoryGet<OfficialClueWordsCacheRecord>(officialClueWordsCacheStore, cacheKey).catch(() => null);
  if (cached && cached.expiresAt > nowIso()) {
    return { ...cached.result, source: "cache", cacheHit: true, requestCount: 0, cacheKey };
  }
  assertNotCancelled(args.shouldCancel);
  const mock = args.opportunityArgs?.mockOfficialClueWords;
  const hasMock = Boolean(mock && Object.prototype.hasOwnProperty.call(mock, args.clue.clueId));
  let status: OfficialClueWordsResult["status"] = "failed";
  let words: string[] = [];
  let responseHash = "";
  let message = "";
  let requestCount = 0;
  if (hasMock) {
    words = uniqueText(mock?.[args.clue.clueId] || []);
    status = words.length ? "complete" : "no_terms";
    responseHash = stableHash(words);
  } else {
    try {
      const response = await runDoudianRequestPlan(args.payload, {
        partition: args.store.partition,
        planKey: "opportunityClueWords",
        context: bodyContext(body),
        shouldCancel: args.shouldCancel
      });
      requestCount = Math.max(1, Math.floor(Number(response.attemptCount || 1)));
      assertNotCancelled(args.shouldCancel);
      message = responseMessage(response);
      responseHash = stableHash(response.data || null);
      if (!planOk(response, args.payload.adapter, "opportunityClueWords")) {
        status = "failed";
      } else {
        const mapped = parseOfficialWordsPayload(response.data, mappingArray(args.payload.adapter, "clueWordPaths", ["data.data", "data", "data.words", "data.list", "words", "list"]));
        if (!mapped.found) {
          status = "schema_mismatch";
        } else {
          words = mapped.words;
          status = words.length ? "complete" : "no_terms";
        }
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      status = "failed";
    }
  }
  const result: OfficialClueWordsResult = {
    status,
    words,
    source: "remote",
    semantics,
    clueId: args.clue.clueId,
    requestCount,
    cacheHit: false,
    requestHash,
    responseHash,
    contractVersion,
    message: message || undefined
  };
  if (status === "complete" || status === "no_terms") {
    const now = nowIso();
    const ttlMinutes = policyNumber(args.payload.adapter, "opportunityReport.officialWordsCacheTtlMinutes", 360, 1, 1440);
    await repositoryPut(officialClueWordsCacheStore, {
      id: cacheKey,
      ...identity,
      result,
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
      createdAt: now,
      updatedAt: now
    } satisfies OfficialClueWordsCacheRecord).catch(() => undefined);
  }
  return { ...result, cacheKey };
}

async function loadOfficialGoodsCache(cacheKey: string) {
  const cached = await repositoryGet<OfficialClueGoodsCacheRecord>(officialClueGoodsCacheStore, cacheKey).catch(() => null);
  if (!cached
    || !cached.generation
    || !cached.expiresAt
    || cached.expiresAt <= nowIso()
    || !Number.isInteger(Number(cached.shardCount))
    || Number(cached.shardCount) < 0
    || !Number.isInteger(Number(cached.rowCount))
    || Number(cached.rowCount) < 0) return null;
  const shards = (await repositoryGetAllByPrefix<OfficialClueGoodsCacheShardRecord>(officialClueGoodsCacheShardStore, `${cacheKey}-`, { pageSize: 100, maxItems: 10000 }).catch(() => []))
    .filter((shard) => shard.generation && shard.generation === cached.generation)
    .sort((left, right) => left.shardNo - right.shardNo);
  const expectedShardNos = Array.from({ length: Math.max(0, Number(cached.shardCount || 0)) }, (_, index) => index + 1);
  const invalidShard = shards.some((shard) => !Array.isArray(shard.productIds)
    || shard.cacheKey !== cacheKey
    || shard.generation !== cached.generation);
  const rowCount = shards.reduce((sum, shard) => sum + (shard.productIds?.length || 0), 0);
  if (invalidShard
    || shards.length !== Number(cached.shardCount || 0)
    || rowCount !== Number(cached.rowCount || 0)
    || expectedShardNos.some((value, index) => shards[index]?.shardNo !== value)) return null;
  const productIds = shards.flatMap((shard) => shard.productIds || []);
  if (new Set(productIds).size !== productIds.length) return null;
  return {
    ...cached.result,
    productIds: uniqueText(productIds),
    cacheHit: true,
    requestCount: 0
  } satisfies OfficialClueGoodsResult;
}

async function queryOfficialClueGoods(args: {
  payload: DoudianAdapterPayload;
  store: DoudianStoreSummary;
  clue: DoudianOpportunityClueRow;
  runId: string;
  opportunityArgs?: OpportunityArgs;
  maxRequests?: number;
  shouldCancel?: () => boolean;
}): Promise<OfficialClueGoodsResult & { cacheKey: string }> {
  const identity = normalizePipelineStoreIdentity(args.store);
  const contractMode = args.opportunityArgs?.mockOfficialGoodsContract?.[args.clue.clueId] || officialGoodsContractMode(args.payload.adapter);
  const contractVersion = policyText(args.payload.adapter, "opportunityReport.officialGoodsContractVersion", "official-goods-contract-unverified-v1");
  const cacheKey = officialGoodsCacheKey(args.payload.adapter, identity, args.clue, contractMode);
  const cached = await loadOfficialGoodsCache(cacheKey);
  if (cached) return { ...cached, cacheKey };
  const pageSize = policyNumber(args.payload.adapter, "opportunityReport.officialProductPageSize", 100, 10, 200);
  const configuredMaxPages = policyNumber(args.payload.adapter, "opportunityReport.maxOfficialProductPages", 20, 1, 50);
  const maxPages = configuredMaxPages;
  const requestBudget = Math.max(0, Math.floor(Number(args.maxRequests ?? configuredMaxPages)));
  const validationConcurrency = policyNumber(args.payload.adapter, "opportunityReport.officialValidationConcurrency", 2, 1, 10);
  const configuredPageConcurrency = policyNumber(args.payload.adapter, "opportunityReport.officialGoodsPageConcurrency", 2, 1, 10);
  const pageConcurrency = Math.min(validationConcurrency, configuredPageConcurrency);
  const productIds: string[] = [];
  const responseHashes: string[] = [];
  let remoteTotal = 0;
  let remoteTotalKnown = false;
  let fetchedRowCount = 0;
  let matchedRowCount = 0;
  let fetchedPages = 0;
  let requestCount = 0;
  let lastPageRowCount: number | undefined;
  let requestFailed = false;
  let schemaMismatch = false;
  let duplicatePage = false;
  let totalZeroWithRows = false;
  const uniqueProductIds = new Set<string>();
  let message = "";
  const mock = args.opportunityArgs?.mockOfficialProductsByClue;
  const hasMock = Boolean(mock && Object.prototype.hasOwnProperty.call(mock, args.clue.clueId));
  if (hasMock) {
    const rows = mock?.[args.clue.clueId] || [];
    fetchedPages = 1;
    fetchedRowCount = rows.length;
    lastPageRowCount = rows.length;
    remoteTotal = rows.length;
    remoteTotalKnown = true;
    const normalized = rows
      .map((row, index) => normalizeProduct(args.store, row, args.payload.adapter, args.runId, index, { matchedClueId: args.clue.clueId, matchedClueName: args.clue.name, status: "matched" }))
      .filter((row): row is DoudianOpportunityProductRow => Boolean(row));
    const matched = normalized.filter((row) => officialProductMatchesClueCategory(row, args.clue));
    matchedRowCount = matched.length;
    for (const row of normalized) {
      if (uniqueProductIds.has(row.productId)) duplicatePage = true;
      else uniqueProductIds.add(row.productId);
    }
    productIds.push(...matched.map((row) => row.productId));
    schemaMismatch = rows.length > 0 && normalized.length !== rows.length;
    responseHashes.push(stableHash(rows));
  } else if (requestBudget <= 0) {
    return {
      status: "truncated",
      contractMode,
      shopId: args.store.shopId,
      clueId: args.clue.clueId,
      productIds: [],
      remoteTotal: 0,
      remoteTotalKnown: false,
      fetchedRowCount: 0,
      matchedRowCount: 0,
      fetchedPages: 0,
      requestCount: 0,
      cacheHit: false,
      requestHash: officialPlanHash(args.payload.adapter, "opportunityClueGoodsList"),
      responseHash: "",
      contractVersion,
      message: "official validation request budget exhausted",
      cacheKey
    };
  } else {
    let nextPage = 1;
    let stopPaging = false;
    while (nextPage <= maxPages && requestCount < requestBudget && !stopPaging) {
      assertNotCancelled(args.shouldCancel);
      const remainingBudget = requestBudget - requestCount;
      const knownPageCount = remoteTotalKnown ? Math.max(1, Math.ceil(remoteTotal / pageSize)) : maxPages;
      if (remoteTotalKnown && nextPage > knownPageCount) break;
      const concurrentPageCount = nextPage === 1 || !remoteTotalKnown
        ? 1
        : Math.min(pageConcurrency, remainingBudget, maxPages - nextPage + 1, knownPageCount - nextPage + 1);
      const pages = Array.from({ length: concurrentPageCount }, (_, index) => nextPage + index);
      try {
        const responses = await Promise.all(pages.map(async (page) => {
          const body = {
            condition: {
              [args.clue.lastCategoryKey || "third_cid"]: platformIntId(args.clue.lastCategoryId),
              clue_id: platformIntId(args.clue.clueId)
            },
            page: { current: page, page_size: pageSize },
            with_suggest_seo_title_words: true
          };
          const response = await runDoudianRequestPlan(args.payload, {
            partition: args.store.partition,
            planKey: "opportunityClueGoodsList",
            context: bodyContext(body),
            shouldCancel: args.shouldCancel,
            maxAttempts: pages.length > 1 ? 1 : Math.max(1, remainingBudget)
          });
          return { page, response };
        }));
        requestCount += responses.reduce((sum, item) => sum + Math.max(1, Math.floor(Number(item.response.attemptCount || 1))), 0);
        fetchedPages += responses.length;
        responseHashes.push(...responses.map((item) => stableHash(item.response.data || null)));
        for (const { response } of responses) {
        if (!planOk(response, args.payload.adapter, "opportunityClueGoodsList")) {
          requestFailed = true;
          message = responseMessage(response) || "official goods request failed";
          stopPaging = true;
          break;
        }
        const businessStatus = parseOfficialBusinessStatus(
          response.data,
          mappingArray(args.payload.adapter, "clueGoodsSuccessStatusPaths", ["base_resp.status_code", "data.base_resp.status_code"]),
          mappingArray(args.payload.adapter, "clueGoodsSuccessCodes", ["200"])
        );
        if (!businessStatus.found || !businessStatus.ok) {
          requestFailed = true;
          message = businessStatus.found
            ? `official goods business status ${businessStatus.code}`
            : "official goods business status mapping mismatch";
          stopPaging = true;
          break;
        }
        const wrapped = { opportunityClueGoodsList: response.data };
        const mapped = parseOfficialGoodsPage(wrapped, mappingArray(args.payload.adapter, "clueGoodsListPaths", [
          "opportunityClueGoodsList.data",
          "opportunityClueGoodsList.data.data",
          "opportunityClueGoodsList.data.list",
          "opportunityClueGoodsList.list"
        ]), mappingArray(args.payload.adapter, "clueGoodsTotalPaths", [
          "opportunityClueGoodsList.data.total",
          "opportunityClueGoodsList.data.data.total",
          "opportunityClueGoodsList.total"
        ]));
        if (!mapped.found) {
          schemaMismatch = true;
          message = "official goods response list mapping mismatch";
          stopPaging = true;
          break;
        }
        const rows = mapped.rows.map(objectRecord);
        lastPageRowCount = rows.length;
        fetchedRowCount += rows.length;
        if (mapped.remoteTotalKnown) {
          remoteTotal = mapped.remoteTotal;
          remoteTotalKnown = true;
        }
        if (remoteTotalKnown && remoteTotal === 0 && rows.length) totalZeroWithRows = true;
        const normalized = rows
          .map((row, index) => normalizeProduct(args.store, row, args.payload.adapter, args.runId, fetchedRowCount - rows.length + index, { matchedClueId: args.clue.clueId, matchedClueName: args.clue.name, status: "matched" }))
          .filter((row): row is DoudianOpportunityProductRow => Boolean(row));
        if (rows.length && normalized.length !== rows.length) {
          schemaMismatch = true;
          message = "official goods product id mapping mismatch";
          stopPaging = true;
          break;
        }
        const matched = normalized.filter((row) => officialProductMatchesClueCategory(row, args.clue));
        if (rows.length && matched.length !== normalized.length) {
          schemaMismatch = true;
          message = "official goods category contract mismatch";
          stopPaging = true;
          break;
        }
        for (const row of normalized) {
          if (uniqueProductIds.has(row.productId)) duplicatePage = true;
          else uniqueProductIds.add(row.productId);
        }
        matchedRowCount += matched.length;
        productIds.push(...matched.map((row) => row.productId));
        if ((remoteTotalKnown && fetchedRowCount >= remoteTotal) || rows.length < pageSize) {
          stopPaging = true;
          break;
        }
        }
      } catch (error) {
        requestFailed = true;
        message = error instanceof Error ? error.message : String(error);
        stopPaging = true;
      }
      nextPage += pages.length;
    }
  }
  const coverage = evaluateInputScanCoverage({
    requestFailed,
    schemaMismatch,
    fetchedCount: fetchedRowCount,
    uniqueFetchedCount: uniqueProductIds.size,
    remoteTotal: remoteTotalKnown ? remoteTotal : undefined,
    remoteTotalKnown,
    fetchedPages,
    maxPages,
    pageSize,
    lastPageRowCount,
    limitReached: requestCount >= requestBudget,
    duplicatePage,
    totalZeroWithRows
  });
  const status: OfficialClueGoodsResult["status"] = schemaMismatch
    ? "schema_mismatch"
    : coverage.status;
  const requestHash = stableHash({
    planHash: officialPlanHash(args.payload.adapter, "opportunityClueGoodsList"),
    clueId: args.clue.clueId,
    categoryKey: args.clue.lastCategoryKey,
    categoryId: args.clue.lastCategoryId,
    pageSize,
    maxPages: configuredMaxPages
  });
  const result: OfficialClueGoodsResult = {
    status,
    contractMode,
    shopId: args.store.shopId,
    clueId: args.clue.clueId,
    productIds: uniqueText(productIds),
    remoteTotal,
    remoteTotalKnown,
    fetchedRowCount,
    matchedRowCount,
    fetchedPages,
    requestCount,
    cacheHit: false,
    requestHash,
    responseHash: stableHash(responseHashes),
    contractVersion,
    message: message || undefined
  };
  if (result.status === "complete") {
    const now = nowIso();
    const ttlPath = result.productIds.length ? "opportunityReport.officialGoodsCacheTtlMinutes" : "opportunityReport.officialEmptyGoodsCacheTtlMinutes";
    const ttlMinutes = policyNumber(args.payload.adapter, ttlPath, result.productIds.length ? 15 : 5, 1, 360);
    const generation = `${Date.now()}-${stableHash(`${cacheKey}:${result.productIds.join(",")}`)}`;
    const shards = chunk(result.productIds, 250).map((ids, index) => ({
      id: `${cacheKey}-${generation}-${index + 1}`,
      cacheKey,
      generation,
      shardNo: index + 1,
      productIds: ids,
      createdAt: now,
      updatedAt: now
    } satisfies OfficialClueGoodsCacheShardRecord));
    const { productIds: _productIds, ...cacheResult } = result;
    try {
      // Publish the manifest only after every shard is durable. A failed write
      // leaves the previous generation active and makes the partial generation
      // unreachable to readers.
      await repositoryPutMany(officialClueGoodsCacheShardStore, shards, { concurrency: 2 });
      await repositoryPut(officialClueGoodsCacheStore, {
        id: cacheKey,
        ...identity,
        result: cacheResult,
        generation,
        shardCount: shards.length,
        rowCount: result.productIds.length,
        expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
        createdAt: now,
        updatedAt: now
      } satisfies OfficialClueGoodsCacheRecord);
      const staleShardIds = (await repositoryGetAllByPrefix<OfficialClueGoodsCacheShardRecord>(officialClueGoodsCacheShardStore, `${cacheKey}-`, { pageSize: 100, maxItems: 10000 }).catch(() => []))
        .filter((shard) => shard.generation !== generation)
        .map((shard) => shard.id);
      if (staleShardIds.length) await repositoryDeleteMany(officialClueGoodsCacheShardStore, staleShardIds).catch(() => undefined);
    } catch {
      // Keep the previous manifest when shard or manifest persistence fails.
    }
  }
  return { ...result, cacheKey };
}

async function queryClueWords(payload: DoudianAdapterPayload, store: DoudianStoreSummary, clue: DoudianOpportunityClueRow, dryRun = false) {
  const fallback = baseClueWords(clue);
  if (dryRun || !policyBoolean(payload.adapter, "opportunityReport.enableRemoteClueWords", false)) return fallback;
  const result = await queryOfficialClueWords({ payload, store, clue });
  return result.status === "complete" ? result.words : fallback;
}

function rawPriceCents(product: DoudianOpportunityProductRow) {
  const raw = product.raw || {};
  const rawPrice = coerceNumber(raw.price || raw.min_price || raw.minPrice || raw.product_price_min || raw.productPriceMin);
  if (rawPrice !== undefined && rawPrice > 999) return Math.floor(rawPrice);
  return Math.floor(Number(product.price || 0) * 100);
}

function submitProductPayload(product: DoudianOpportunityProductRow, store: DoudianStoreSummary) {
  const raw = product.raw || {};
  const productTitle = text(
    raw.title ||
    raw.name ||
    raw.product_name ||
    raw.productName ||
    raw.product_title ||
    raw.productTitle ||
    raw.goods_name ||
    raw.goodsName ||
    raw.goods_title ||
    raw.goodsTitle ||
    raw.item_name ||
    raw.itemName ||
    raw.item_title ||
    raw.itemTitle ||
    product.title ||
    product.productId
  );
  const price = rawPriceCents(product);
  const shopIdNumber = Number(product.shopId || store.shopId);
  const rawCategoryDetail = objectRecord(raw.category_detail || raw.categoryDetail);
  const rawCategoryId = text(
    raw.category_id ||
    raw.categoryId ||
    raw.leaf_category_id ||
    raw.leafCategoryId ||
    raw.category_leaf_id ||
    raw.categoryLeafId ||
    rawCategoryDetail.leaf_cid ||
    rawCategoryDetail.leafCid ||
    rawCategoryDetail.fourth_cid ||
    rawCategoryDetail.fourthCid ||
    rawCategoryDetail.third_cid ||
    rawCategoryDetail.thirdCid ||
    rawCategoryDetail.second_cid ||
    rawCategoryDetail.secondCid ||
    rawCategoryDetail.first_cid ||
    rawCategoryDetail.firstCid ||
    product.categoryId
  );
  const titleFields = productTitleAliases(productTitle);
  const productInfo = {
    product_id: product.productId,
    productId: product.productId,
    ...titleFields
  };
  return {
    product_id: product.productId,
    ...titleFields,
    product_info: productInfo,
    productInfo,
    product_detail: productInfo,
    productDetail: productInfo,
    pic_url: text(raw.pic_url || raw.picUrl || raw.img || raw.cover || product.img),
    category_id: platformIntId(rawCategoryId === "0" ? product.categoryId : rawCategoryId),
    stock_num: coerceNumber(raw.stock_num || raw.stockNum || raw.stock || product.stock) || 0,
    sell_num: coerceNumber(raw.sell_num || raw.sellNum || raw.sale_num || raw.saleNum || product.sales) || 0,
    price,
    product_price_min: coerceNumber(raw.product_price_min || raw.productPriceMin) || price,
    product_price_max: coerceNumber(raw.product_price_max || raw.productPriceMax || raw.max_price || raw.maxPrice) || price,
    audit_time: coerceNumber(raw.audit_time || raw.auditTime || raw.audit_time_num || raw.auditTimeNum) || 0,
    category_path: text(raw.category_path || raw.categoryPath || product.category),
    shop_id: Number.isFinite(shopIdNumber) ? shopIdNumber : product.shopId || store.shopId,
    shop_name: product.shopName || store.shopName,
    brand_id: platformNumberId(raw.brand_id || raw.brandId),
    brand_name: text(raw.brand_name || raw.brandName),
    art_number: text(raw.art_number || raw.artNumber)
  };
}

function submitBody(clue: DoudianOpportunityClueRow, products: DoudianOpportunityProductRow[], store: DoudianStoreSummary, module: "query" | "search_page_query") {
  return {
    clue_id: platformIntId(clue.clueId),
    products: products.map((product) => submitProductPayload(product, store)),
    terminal_type: 0,
    source: "business_center",
    module,
    scene: ""
  };
}

function transientSubmitMessage(message: string, response?: RequestPlanResult) {
  const status = Number(response?.status || 0);
  if (status === 429) return true;
  if (submitFrequencyLimitedMessage(message, response)) return false;
  return !message || status === 429 || status === 502 || status === 504 || message.includes("频繁") || message.includes("系统") || message.includes("network");
}

function submitFrequencyLimitedMessage(message: string, response?: RequestPlanResult) {
  const value = text(message || responseMessage(response));
  if (!value) return false;
  return value.includes("操作太频繁") ||
    value.includes("访问过于频繁") ||
    value.includes("频控") ||
    (value.includes("频繁") && (value.includes("稍后") || value.includes("访问")));
}

function submitManualInterventionMessage(message: string, response?: RequestPlanResult) {
  const value = text(message || responseMessage(response));
  return Boolean(value && /环境存在风险|账号风控|身份校验|滑块|验证码|验证后重试|重新登录/.test(value));
}

function productIdsFromSubmitMessage(message: string) {
  const ids = new Set<string>();
  const value = String(message || "");
  for (const match of value.matchAll(/(?:ID|id|商品ID|商品id)[:：]?\s*(\d{5,})/g)) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}

function submitCandidateDelayMs(adapter: DoudianAdapterConfig) {
  const base = policyNumber(adapter, "opportunityReport.submitCandidateDelayMs", 10000, 0, 120000);
  const jitter = policyNumber(adapter, "opportunityReport.submitCandidateJitterMs", 2500, 0, 60000);
  return base + (jitter ? Math.floor(Math.random() * (jitter + 1)) : 0);
}

function stopStoreOnSubmitFrequency(adapter: DoudianAdapterConfig) {
  return policyBoolean(adapter, "opportunityReport.stopStoreOnSubmitFrequency", true);
}

function submitTaskLeaseMs(adapter: DoudianAdapterConfig) {
  return policyNumber(adapter, "opportunityReport.submitTaskLeaseMs", 30 * 60 * 1000, 5 * 60 * 1000, 4 * 60 * 60 * 1000);
}

function submitLeaseRenewalMs(adapter: DoudianAdapterConfig) {
  return policyNumber(adapter, "opportunityReport.submitLeaseRenewalMs", 2 * 60 * 1000, 30 * 1000, 10 * 60 * 1000);
}

function submitLeaseExpiresAt(adapter: DoudianAdapterConfig) {
  return new Date(Date.now() + submitTaskLeaseMs(adapter)).toISOString();
}

function submitWorkerBatchSize(adapter: DoudianAdapterConfig) {
  return policyNumber(adapter, "opportunityReport.submitBatchSize", submitBatchSizeFallback, 1, 100);
}

function submitTaskConcurrency(adapter: DoudianAdapterConfig) {
  return policyNumber(adapter, "opportunityReport.submitTaskConcurrency", 2, 1, 4);
}

function estimateSubmitGroups(candidates: DoudianOpportunityPrematchCandidate[], adapter: DoudianAdapterConfig) {
  const batchSize = submitWorkerBatchSize(adapter);
  const grouped = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.eligible || candidate.status !== "ready") continue;
    const key = [candidate.shopId, candidate.clueId, candidate.submitPriority || "primary"].map(text).join("::");
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  return Array.from(grouped.values()).reduce((sum, count) => sum + Math.ceil(count / batchSize), 0);
}

function estimateSubmitDurationMs(groupCount: number, adapter: DoudianAdapterConfig) {
  const base = policyNumber(adapter, "opportunityReport.submitCandidateDelayMs", 10000, 0, 120000);
  const jitter = policyNumber(adapter, "opportunityReport.submitCandidateJitterMs", 2500, 0, 60000);
  return Math.max(0, groupCount) * (base + Math.floor(jitter / 2));
}

function sameSubmitBatchCandidate(seed: DoudianOpportunityPrematchCandidate, candidate: DoudianOpportunityPrematchCandidate) {
  return text(seed.shopId) === text(candidate.shopId) &&
    text(seed.clueId) === text(candidate.clueId) &&
    text(seed.submitPriority) === text(candidate.submitPriority);
}

function executionsForCandidate(executions: DoudianOpportunityExecution[], candidate: DoudianOpportunityPrematchCandidate) {
  const productId = text(candidate.productId);
  const clueId = text(candidate.clueId);
  return executions.filter((item) => text(item.productId) === productId && (!text(item.clueId) || text(item.clueId) === clueId));
}

function normalizedSubmitMessage(message: string) {
  if (submitFrequencyLimitedMessage(message)) return "商机中心提交触发频控，已停止本店后续提报";
  if (message.includes("商品数不可超过10000")) return "已达当前店铺今日提报商品上限，请次日再试";
  if (message.includes("最多支持关联") || message.includes("最多可关联")) return message;
  if (message.includes("存在老品")) return "存在老品，已跳过提报";
  if (!message || message.includes("滑块")) return "关联商品存在功能滑块，请处理后再试";
  return message;
}

function submitMessageState(message: string) {
  const normalized = normalizedSubmitMessage(message);
  if (normalized.includes("已通过审核") || normalized.includes("已在同款审核中")) {
    return { ok: true, status: "skipped", message: normalized };
  }
  return { ok: false, status: "failed", message: normalized };
}

function productFailureMessages(message: string) {
  const failures = new Map<string, string>();
  const lines = String(message || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = lines.length ? lines : [String(message || "")];
  for (const line of candidates) {
    const matches = Array.from(line.matchAll(/\[(\d+)\]/g));
    for (const match of matches) {
      if (match[1]) failures.set(match[1], line);
    }
  }
  return failures;
}

interface CoordinatedRemoteSubmitResult {
  response?: RequestPlanResult;
  attemptCount: number;
  deferred?: boolean;
  classification?: CoordinatedSubmitClassification;
  coordination?: Record<string, unknown>;
  settledTask?: PipelineSubmitTaskRecord;
}

function coordinatedSubmitEventDetail(args: {
  task: PipelineSubmitTaskRecord;
  taskState?: PipelineSubmitTaskRecord;
  schedulerLease: OpportunitySubmitSchedulerLease;
  workerId: string;
  workerSlot?: number;
  taskConcurrency?: number;
  candidates?: DoudianOpportunityPrematchCandidate[];
  attempt?: Record<string, unknown>;
  rate?: Record<string, unknown>;
  quota?: Record<string, unknown>;
  nextEligibleAt?: unknown;
  reason?: unknown;
  extra?: Record<string, unknown>;
}) {
  const taskState = args.taskState || args.task;
  const attempt = objectRecord(args.attempt);
  const rate = objectRecord(args.rate);
  const storeRate = objectRecord(rate.store);
  const globalRate = objectRecord(rate.global);
  const quota = objectRecord(args.quota);
  const candidateIds = (args.candidates || []).map((candidate) => candidate.id);
  return {
    taskId: args.task.id,
    logicalGroupId: text(attempt.logicalGroupId || taskState.inFlightLogicalGroupId),
    attemptId: text(attempt.attemptId || taskState.inFlightAttemptId),
    candidateId: candidateIds.length === 1 ? candidateIds[0] : undefined,
    candidateIds,
    retryCycle: Number(attempt.retryCycle || 0),
    attemptOrdinal: Number(attempt.attemptOrdinal || taskState.inFlightAttemptOrdinal || 0),
    quotaReservationId: text(attempt.quotaReservationId || taskState.quotaReservationId),
    httpGrantId: text(attempt.httpGrantId || taskState.httpGrantId),
    nextEligibleAt: text(args.nextEligibleAt || storeRate.nextEligibleAt || taskState.resumeAt),
    storeIntervalMs: Number(storeRate.intervalMs || 0),
    globalIntervalMs: Number(globalRate.intervalMs || 0),
    globalMode: text(globalRate.mode),
    throttleCount: Number(taskState.throttleCount || 0),
    candidateMutationAttemptCount: Number(taskState.candidateMutationAttemptCount ?? 0),
    httpRequestAttemptCount: Number(taskState.httpRequestAttemptCount ?? taskState.remoteRequestCount ?? 0),
    dailyCandidateMutationUsed: Number(quota.candidateDispatched || 0),
    dailyHttpRequestUsed: Number(quota.httpDispatched || 0),
    retryableRemainingCount: Number(taskState.retryableRemainingCount || 0),
    workerId: args.workerId,
    workerSlot: args.workerSlot,
    taskConcurrency: args.taskConcurrency,
    schedulerOwnerId: args.schedulerLease.ownerId,
    schedulerFencingToken: args.schedulerLease.fencingToken,
    releaseId: args.task.releaseId,
    releaseManifestHash: args.task.releaseManifestHash,
    submitContractVersion: args.task.submitContractVersion,
    pacingPolicyHash: args.task.pacingPolicyHash,
    policyVersion: text(storeRate.policyVersion || globalRate.policyVersion),
    schedulerReason: text(args.reason),
    ...args.extra
  };
}

async function submitWithRetry(
  payload: DoudianAdapterPayload,
  store: DoudianStoreSummary,
  body: Record<string, unknown>,
  shouldCancel?: () => boolean,
  beginMutation?: () => void,
  endMutation?: () => void,
  trace?: {
    runId?: string;
    sourceRunId?: string;
    clueId?: string;
    productIds?: string[];
  }
) {
  const planKey = "opportunitySubmitClue";
  const coordinated = submitCoordinatorEnabled(payload.adapter);
  const retryLimit = coordinated ? 1 : policyNumber(payload.adapter, "opportunityReport.submitRetryLimit", 3, 1, 3);
  const retryDelay = policyNumber(payload.adapter, "opportunityReport.submitRetryDelayMs", 10000, 0, 30000);
  const clueId = text(trace?.clueId || body.clue_id);
  const productIds = uniqueText(trace?.productIds || (Array.isArray(body.products)
    ? body.products.map((item) => text(objectRecord(item).product_id))
    : []));
  let response: RequestPlanResult | undefined;
  let attemptCount = 0;
  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    assertNotCancelled(shouldCancel);
    const attemptStartedAt = Date.now();
    await reportDoudianDiagnostic({
      category: "opportunity-pipeline",
      event: "submit-attempt-started",
      runId: trace?.runId,
      sourceRunId: trace?.sourceRunId,
      shopId: store.shopId,
      shopName: store.shopName,
      clueId,
      productIds,
      outerAttempt: attempt + 1,
      outerAttemptLimit: retryLimit,
      requestPlanMaxAttempts: 1,
      startedAt: new Date(attemptStartedAt).toISOString()
    }, true);
    response = await runDoudianRequestPlan(payload, {
      partition: store.partition,
      planKey,
      context: bodyContext(body),
      shouldCancel,
      beginMutation,
      endMutation,
      maxAttempts: 1
    });
    const requestAttemptCount = Math.max(1, Math.floor(Number(response.attemptCount || 1)));
    attemptCount += requestAttemptCount;
    const message = responseMessage(response);
    const accepted = submitResponseOk(response);
    const retryable = !accepted && transientSubmitMessage(message, response);
    const status = Number(response.status || 0);
    const retryAfterMs = response ? submitRetryWaitMs({
      baseDelayMs: retryDelay,
      attemptIndex: attempt,
      status,
      headers: response.headers,
      jitterMs: coordinated ? 0 : status === 429 ? Math.floor(Math.random() * 5001) : 0
    }) : 0;
    await reportDoudianDiagnostic({
      category: "opportunity-pipeline",
      event: "submit-attempt-finished",
      runId: trace?.runId,
      sourceRunId: trace?.sourceRunId,
      shopId: store.shopId,
      shopName: store.shopName,
      clueId,
      productIds,
      outerAttempt: attempt + 1,
      outerAttemptLimit: retryLimit,
      requestAttemptCount,
      totalRequestAttemptCount: attemptCount,
      status,
      accepted,
      retryable,
      message,
      responseError: text(response.error).slice(0, 300),
      responseContentType: responseHeaderText(response.headers, "content-type"),
      responseRetryAfter: responseHeaderText(response.headers, "retry-after"),
      durationMs: Math.max(0, Date.now() - attemptStartedAt)
    }, true);
    if (accepted || !retryable) break;
    if (attempt < retryLimit - 1 && retryAfterMs) {
      const waitDetail = {
        shopName: store.shopName,
        clueId,
        productIds,
        status,
        outerAttempt: attempt + 1,
        nextOuterAttempt: attempt + 2,
        outerAttemptLimit: retryLimit,
        waitMs: retryAfterMs,
        totalRequestAttemptCount: attemptCount,
        rateLimitScope: "store-only",
        otherStoreWorkersBlocked: false
      };
      if (trace?.runId) {
        await writePipelineEvent({
          runId: trace.runId,
          shopId: store.shopId,
          level: "warn",
          event: "pipeline-submit-retry-waiting",
          message: status === 429
            ? `HTTP 429 received; store ${store.shopName || store.shopId} waits ${Math.ceil(retryAfterMs / 1000)}s before retry; other store workers are not blocked`
            : `Submit request failed; store ${store.shopName || store.shopId} waits ${Math.ceil(retryAfterMs / 1000)}s before retry`,
          detail: waitDetail
        }).catch(() => undefined);
      }
      await reportDoudianDiagnostic({
        category: "opportunity-pipeline",
        event: "submit-retry-wait-started",
        runId: trace?.runId,
        sourceRunId: trace?.sourceRunId,
        shopId: store.shopId,
        ...waitDetail
      }, true);
      await cancellableWait(retryAfterMs, shouldCancel);
      if (trace?.runId) {
        await writePipelineEvent({
          runId: trace.runId,
          shopId: store.shopId,
          level: "info",
          event: "pipeline-submit-retry-resumed",
          message: `Retry wait finished for store ${store.shopName || store.shopId}; starting attempt ${attempt + 2}/${retryLimit}`,
          detail: waitDetail
        }).catch(() => undefined);
      }
      await reportDoudianDiagnostic({
        category: "opportunity-pipeline",
        event: "submit-retry-wait-finished",
        runId: trace?.runId,
        sourceRunId: trace?.sourceRunId,
        shopId: store.shopId,
        ...waitDetail
      }, true);
    }
  }
  return { response, attemptCount };
}

async function editTitles(
  payload: DoudianAdapterPayload,
  store: DoudianStoreSummary,
  products: DoudianOpportunityProductRow[],
  nextTitles: Map<string, string>,
  dryRun = false,
  beginMutation?: () => void,
  endMutation?: () => void
) {
  const productIds = products.map((product) => product.productId).filter(Boolean);
  if (!productIds.length || !nextTitles.size) return { ok: true, message: "" };
  if (dryRun) return { ok: true, message: "dry-run title edit skipped" };
  const body = {
    product_ids: productIds,
    name: Object.fromEntries(productIds.map((id) => [id, nextTitles.get(id) || products.find((item) => item.productId === id)?.title || ""]))
  };
  const response = await runDoudianRequestPlan(payload, {
    partition: store.partition,
    planKey: "opportunityEditGoodsTitle",
    context: bodyContext(body),
    beginMutation,
    endMutation
  });
  return {
    ok: planOk(response, payload.adapter, "opportunityEditGoodsTitle"),
    message: responseMessage(response)
  };
}

function chunk<T>(items: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function executionForProducts(args: {
  runId: string;
  sourceRunId?: string;
  store: DoudianStoreSummary;
  clue: DoudianOpportunityClueRow;
  products: Array<DoudianOpportunityProductRow & { mutationKey?: string; liveLifecycleStatus?: string }>;
  action?: string;
  status: string;
  ok: boolean;
  message: string;
  planKey?: string;
  stage?: string;
  diagnostic?: Record<string, unknown>;
}) {
  return args.products.map((product) => ({
    id: `${args.runId}-${args.store.shopId}-${args.clue.clueId}-${product.productId}-${args.stage || args.status}`,
    sourceRunId: args.sourceRunId,
    mutationKey: product.mutationKey,
    mutationStatus: args.status === "submitted" ? "acknowledged" : args.status,
    liveLifecycleStatus: product.liveLifecycleStatus,
    shopId: args.store.shopId,
    shopName: args.store.shopName,
    clueId: args.clue.clueId,
    clueName: args.clue.name,
    productId: product.productId,
    title: product.title,
    action: args.action || "submit",
    stage: args.stage,
    status: args.status,
    ok: args.ok,
    message: args.message,
    planKey: args.planKey,
    diagnostic: args.diagnostic
  }));
}

function splitCategoryPath(value: unknown) {
  if (Array.isArray(value)) return categoryPathNames(value);
  return text(value).split(/[>／/]/).map((part) => part.trim()).filter(Boolean);
}

function officialProductMatchesClueCategory(product: DoudianOpportunityProductRow, clue: DoudianOpportunityClueRow) {
  const key = clue.lastCategoryKey || "third_cid";
  if (key === "first_cid" || key === "second_cid") return true;
  const depth = key === "fourth_cid" ? 4 : 3;
  const expected = splitCategoryPath(clue.categoryName);
  const actual = splitCategoryPath(product.categoryPath?.length ? product.categoryPath : product.raw?.category_path || product.raw?.categoryPath || product.category);
  if (expected.length < depth || actual.length < depth) return false;
  for (let index = 0; index < depth; index += 1) {
    if (expected[index] !== actual[index]) return false;
  }
  return true;
}

async function collectOfficialProductsForClue(payload: DoudianAdapterPayload, store: DoudianStoreSummary, clue: DoudianOpportunityClueRow, args: OpportunityArgs, runId: string) {
  const planKey = "opportunityClueGoodsList";
  const pageSize = policyNumber(payload.adapter, "opportunityReport.officialProductPageSize", 100, 10, 200);
  const maxPages = policyNumber(payload.adapter, "opportunityReport.maxOfficialProductPages", 20, 1, 50);
  const products: DoudianOpportunityProductRow[] = [];
  let remoteTotal = 0;
  if (args.mockProducts?.length) {
    return args.mockProducts
      .map((row, index) => normalizeProduct(store, row, payload.adapter, runId, index, { matchedClueId: clue.clueId, matchedClueName: clue.name, status: "matched" }))
      .filter((row): row is DoudianOpportunityProductRow => Boolean(row))
      .filter((row) => officialProductMatchesClueCategory(row, clue));
  }
  for (let page = 1; page <= maxPages; page += 1) {
    const body = {
      condition: {
        [clue.lastCategoryKey || "third_cid"]: platformIntId(clue.lastCategoryId),
        clue_id: platformIntId(clue.clueId)
      },
      page: {
        current: page,
        page_size: pageSize
      },
      with_suggest_seo_title_words: true
    };
    const response = await runDoudianRequestPlan(payload, { partition: store.partition, planKey, context: bodyContext(body) });
    const wrapped = { [planKey]: response.data };
    const rows = firstArray(wrapped, mappingArray(payload.adapter, "clueGoodsListPaths", [
      "opportunityClueGoodsList.data",
      "opportunityClueGoodsList.data.data",
      "opportunityClueGoodsList.data.list"
    ])).map(objectRecord);
    const normalized = rows
      .map((row, rowIndex) => normalizeProduct(store, row, payload.adapter, runId, rowIndex, { matchedClueId: clue.clueId, matchedClueName: clue.name, status: "matched" }))
      .filter((row): row is DoudianOpportunityProductRow => Boolean(row));
    const matched = normalized.filter((row) => officialProductMatchesClueCategory(row, clue));
    products.push(...matched);
    remoteTotal = readTotal(wrapped, payload.adapter, "clueGoodsTotalPaths") || remoteTotal;
    if (!planOk(response, payload.adapter, planKey) || !rows.length) break;
    if (normalized.length && !matched.length) break;
    if (remoteTotal && products.length >= remoteTotal) break;
  }
  return products;
}

async function collectNewProductsForClue(payload: DoudianAdapterPayload, store: DoudianStoreSummary, clue: DoudianOpportunityClueRow, args: OpportunityArgs, runId: string) {
  const result = await scanProductsForStore(
    payload,
    store,
    { ...args, filters: { ...(args.filters || {}), categoryLeafId: clue.lastCategoryId, keyword: "" } },
    runId,
    1,
    1,
    { matchedClueId: clue.clueId, matchedClueName: clue.name, status: "matched" },
    clue.lastCategoryId || ""
  );
  return result.products;
}

function filterAndTitleProducts(
  payload: DoudianAdapterPayload,
  products: DoudianOpportunityProductRow[],
  words: string[],
  mode: DoudianOpportunitySubmitMode,
  matchMode: DoudianOpportunityTitleMatchMode,
  updatePosition: DoudianOpportunityTitleUpdatePosition
) {
  const selected: DoudianOpportunityProductRow[] = [];
  const skipped: DoudianOpportunityProductRow[] = [];
  const nextTitles = new Map<string, string>();
  for (const product of products) {
    if (mode === "validate" && !titleHasClueWord(product.title, words, matchMode)) {
      skipped.push(product);
      continue;
    }
    const nextTitle = mode === "updateTitle" ? titleWithClueWord(product.title, words, payload.adapter, updatePosition) : product.title;
    if (nextTitle && nextTitle !== product.title) nextTitles.set(product.productId, nextTitle);
    selected.push({ ...product, title: nextTitle || product.title });
  }
  return { selected, skipped, nextTitles };
}

async function submitProductsForClue(args: {
  payload: DoudianAdapterPayload;
  store: DoudianStoreSummary;
  clue: DoudianOpportunityClueRow;
  products: DoudianOpportunityProductRow[];
  runId: string;
  sourceRunId?: string;
  submitMode: DoudianOpportunitySubmitMode;
  titleMatchMode: DoudianOpportunityTitleMatchMode;
  titleUpdatePosition: DoudianOpportunityTitleUpdatePosition;
  module: "query" | "search_page_query";
  dryRun?: boolean;
  validatedByPipeline?: boolean;
  pipelineWords?: string[];
  shouldCancel?: () => boolean;
  beginMutation?: () => void;
  endMutation?: () => void;
  onRemoteSubmitStart?: (products: DoudianOpportunityProductRow[]) => Promise<void>;
  submitRemote?: (body: Record<string, unknown>, products: DoudianOpportunityProductRow[]) => Promise<CoordinatedRemoteSubmitResult>;
}) {
  const executions: DoudianOpportunityExecution[] = [];
  const words = args.pipelineWords || (args.validatedByPipeline ? baseClueWords(args.clue) : await queryClueWords(args.payload, args.store, args.clue, args.dryRun));
  const filtered = args.validatedByPipeline
    ? { selected: args.products, skipped: [] as DoudianOpportunityProductRow[], nextTitles: new Map<string, string>() }
    : filterAndTitleProducts(args.payload, args.products, words, args.submitMode, args.titleMatchMode, args.titleUpdatePosition);
  if (filtered.skipped.length) {
    executions.push(...executionForProducts({
      runId: args.runId,
      sourceRunId: args.sourceRunId,
      store: args.store,
      clue: args.clue,
      products: filtered.skipped,
      status: "skipped",
      ok: true,
      message: "未包含商机下的商机词，已跳过提报",
      stage: "match"
    }));
  }
  const safety = await prepareMutationSafety({
    payload: args.payload,
    store: args.store,
    candidates: filtered.selected,
    feature: "opportunity-submit",
    runId: args.runId,
    sourceRunId: args.sourceRunId,
    operationId: args.runId,
    action: "submit",
    stage: "submit",
    planKey: "opportunitySubmitClue",
    extraKey: () => args.clue.clueId,
    dryRun: args.dryRun,
    shouldCancel: args.shouldCancel
  });
  if (safety.rejected.length) {
    executions.push(...safety.rejected.map((entry) => ({
      id: `${args.runId}-${args.store.shopId}-${args.clue.clueId}-${entry.item.productId}-blocked`,
      sourceRunId: args.sourceRunId,
      mutationKey: entry.mutationKey,
      mutationStatus: entry.status,
      liveLifecycleStatus: entry.liveLifecycleStatus,
      shopId: args.store.shopId,
      shopName: args.store.shopName,
      clueId: args.clue.clueId,
      clueName: args.clue.name,
      productId: entry.item.productId,
      title: entry.item.title || "",
      action: "submit",
      stage: "submit",
      status: entry.status,
      ok: entry.ok,
      message: entry.message,
      planKey: entry.planKey || "opportunitySubmitClue",
      diagnostic: {
        safetySkipped: entry.status === "skipped",
        safetyReason: entry.reason,
        liveLookupPlanKey: entry.planKey || ""
      }
    })));
  }
  const safeProducts = safety.allowed.map((entry) => ({
    ...entry.item,
    mutationKey: entry.mutationKey,
    liveLifecycleStatus: entry.liveLifecycleStatus
  }));
  if (!filtered.selected.length) {
    executions.push({
      id: `${args.runId}-${args.store.shopId}-${args.clue.clueId}-empty`,
      sourceRunId: args.sourceRunId,
      shopId: args.store.shopId,
      shopName: args.store.shopName,
      clueId: args.clue.clueId,
      clueName: args.clue.name,
      action: "submit",
      stage: "match",
      status: "skipped",
      ok: true,
      message: "店铺内暂无适配的相同类目商品"
    });
    await recordExecutionMutationResults({ store: args.store, executions, defaultAction: "submit" }).catch(() => undefined);
    return executions;
  }
  if (!safeProducts.length) {
    await recordExecutionMutationResults({ store: args.store, executions, defaultAction: "submit" }).catch(() => undefined);
    return executions;
  }
  if (!args.dryRun) await assertMutationStoreActive(args.store);
  const edit = await editTitles(
    args.payload,
    args.store,
    safeProducts,
    filtered.nextTitles,
    args.dryRun,
    args.beginMutation,
    args.endMutation
  );
  if (!edit.ok) {
    executions.push(...executionForProducts({
      runId: args.runId,
      sourceRunId: args.sourceRunId,
      store: args.store,
      clue: args.clue,
      products: safeProducts,
      action: "editTitle",
      status: "failed",
      ok: false,
      message: edit.message || "商品标题更新失败",
      planKey: "opportunityEditGoodsTitle",
      stage: "editTitle"
    }));
    await recordExecutionMutationResults({ store: args.store, executions, defaultAction: "submit" }).catch(() => undefined);
    return executions;
  }

  const batchSize = policyNumber(args.payload.adapter, "opportunityReport.submitBatchSize", submitBatchSizeFallback, 1, 100);
  const delayMs = policyNumber(args.payload.adapter, "opportunityReport.submitBatchDelayMs", 1900, 0, 30000);
  const batches = chunk(safeProducts, batchSize);
  for (const [batchIndex, batch] of batches.entries()) {
    if (args.dryRun) {
      executions.push(...executionForProducts({
        runId: args.runId,
        sourceRunId: args.sourceRunId,
        store: args.store,
        clue: args.clue,
        products: batch,
        status: "dry_run",
        ok: true,
        message: "dry-run opportunity submit skipped",
        planKey: "opportunitySubmitClue",
        stage: "submit"
      }));
    } else {
      assertNotCancelled(args.shouldCancel);
      await assertMutationStoreActive(args.store);
      const body = submitBody(args.clue, batch, args.store, args.module);
      let submitResult: CoordinatedRemoteSubmitResult;
      if (args.submitRemote) {
        submitResult = await args.submitRemote(body, batch);
      } else {
        await args.onRemoteSubmitStart?.(batch);
        submitResult = await submitWithRetry(
          args.payload,
          args.store,
          body,
          args.shouldCancel,
          args.beginMutation,
          args.endMutation,
          {
            runId: args.runId,
            sourceRunId: args.sourceRunId,
            clueId: args.clue.clueId,
            productIds: batch.map((product) => product.productId)
          }
        );
      }
      if (submitResult.deferred) continue;
      const response = submitResult.response;
      const remoteCode = responseCode(response);
      const ok = submitResponseOk(response);
      const submitDiagnostic = {
        remoteSubmitAttempt: true,
        remoteAccepted: ok,
        remoteResponseCode: remoteCode == null ? "" : String(remoteCode),
        remoteHttpStatus: Number(response?.status || 0),
        submitAttemptCount: submitResult.attemptCount,
        ...(submitResult.coordination || {})
      };
      const message = ok ? "商机提报已提交" : normalizedSubmitMessage(responseMessage(response));
      const failureMessages = ok ? new Map<string, string>() : productFailureMessages(message);
      const hasBatchFailureItems = batch.some((product) => failureMessages.has(product.productId));
      if (submitResult.classification?.outcome === "throttled") {
        executions.push(...executionForProducts({
          runId: args.runId,
          sourceRunId: args.sourceRunId,
          store: args.store,
          clue: args.clue,
          products: batch,
          status: "retry_waiting",
          ok: false,
          message: message || "商机提报触发频控，已进入持久化冷却",
          planKey: "opportunitySubmitClue",
          stage: "submit",
          diagnostic: submitDiagnostic
        }));
      } else if (submitResult.classification?.outcome === "unknown") {
        executions.push(...executionForProducts({
          runId: args.runId,
          sourceRunId: args.sourceRunId,
          store: args.store,
          clue: args.clue,
          products: batch,
          status: "unknown",
          ok: false,
          message: message || "提报结果无法确认，已转人工对账",
          planKey: "opportunitySubmitClue",
          stage: "submit",
          diagnostic: submitDiagnostic
        }));
      } else if (!ok && hasBatchFailureItems) {
        const failedProducts = batch.filter((product) => failureMessages.has(product.productId));
        const unresolvedProducts = batch.filter((product) => !failureMessages.has(product.productId));
        if (unresolvedProducts.length) {
          executions.push(...executionForProducts({
            runId: args.runId,
            sourceRunId: args.sourceRunId,
            store: args.store,
            clue: args.clue,
            products: unresolvedProducts,
            status: unresolvedBatchProductStatus(false, false),
            ok: false,
            message: "批量提报响应未明确确认该商品成功，已记录为未知结果",
            planKey: "opportunitySubmitClue",
            stage: "submit",
            diagnostic: submitDiagnostic
          }));
        }
        for (const product of failedProducts) {
          const state = submitMessageState(failureMessages.get(product.productId) || message);
          executions.push(...executionForProducts({
            runId: args.runId,
            sourceRunId: args.sourceRunId,
            store: args.store,
            clue: args.clue,
            products: [product],
            status: state.status,
            ok: state.ok,
            message: state.message,
            planKey: "opportunitySubmitClue",
            stage: "submit",
            diagnostic: submitDiagnostic
          }));
        }
      } else {
        const state = ok ? { ok: true, status: "submitted", message } : submitMessageState(message);
        executions.push(...executionForProducts({
          runId: args.runId,
          sourceRunId: args.sourceRunId,
          store: args.store,
          clue: args.clue,
          products: batch,
          status: state.status,
          ok: state.ok,
          message: state.message,
          planKey: "opportunitySubmitClue",
          stage: "submit",
          diagnostic: submitDiagnostic
        }));
      }
    }
    if (batchIndex < batches.length - 1 && delayMs && !args.dryRun) await cancellableWait(delayMs, args.shouldCancel);
  }
  await recordExecutionMutationResults({ store: args.store, executions, defaultAction: "submit" }).catch(() => undefined);
  return executions;
}

function storeFromRef(stores: DoudianStoreSummary[], ref: { shopId?: string }): DoudianStoreSummary | null {
  return stores.find((store) => store.shopId === ref.shopId) || null;
}

async function fetchClueSubmit(payload: DoudianAdapterPayload, args: OpportunityArgs): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  if (!args.sourceRunId) {
    return { ...ledger, ok: false, status: "no-source-run", mode: "clue-submit", message: "Source scan run is required for opportunity submit", rows: [], clues: [], products: [], executions: [] };
  }
  const clues = await loadSelectedClues(args);
  const runId = args.operationId || `opportunity-submit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourceRunId = args.sourceRunId;
  const mode = submitMode(args);
  const matchType = goodsMatchType(args);
  const matchMode = titleMatchMode(args);
  const updatePosition = titleUpdatePosition(args);
  const requested = new Set((args.shopIds || []).map(text).filter(Boolean));
  const executions: DoudianOpportunityExecution[] = [];
  const details: DoudianRunDetail[] = [];
  if (!clues.length) return { ...ledger, ok: false, status: "no-clue", mode: "clue-submit", message: "No opportunity clues selected", rows: [], clues: [], products: [], executions: [] };

  for (const clue of clues) {
    const shopRefs = clue.shopList.filter((shop) => !requested.size || requested.has(shop.shopId));
    for (const shopRef of shopRefs) {
      const store = storeFromRef(stores, shopRef);
      if (!store) {
        executions.push({
          id: `${runId}-${shopRef.shopId || "missing"}-${clue.clueId}`,
          sourceRunId,
          shopId: shopRef.shopId || "",
          shopName: shopRef.shopName || "",
          clueId: clue.clueId,
          clueName: clue.name,
          action: "submit",
          status: "failed",
          ok: false,
          message: "Selected store is missing login partition"
        });
        continue;
      }
      const beforeCount = executions.length;
      try {
        const products = matchType === "official"
          ? await collectOfficialProductsForClue(payload, store, clue, args, runId)
          : await collectNewProductsForClue(payload, store, clue, args, runId);
        if (!products.length) {
          executions.push({
            id: `${runId}-${store.shopId}-${clue.clueId}-no-product`,
            sourceRunId,
            shopId: store.shopId,
            shopName: store.shopName,
            clueId: clue.clueId,
            clueName: clue.name,
            action: "submit",
            status: "failed",
            ok: false,
            message: matchType === "official" ? "官方范围未返回符合商机类目的商品" : "店铺内暂无适配的相同类目商品"
          });
          continue;
        }
        const nextExecutions = await submitProductsForClue({
          payload,
          store,
          clue,
          products,
          runId,
          sourceRunId,
          submitMode: mode,
          titleMatchMode: matchMode,
          titleUpdatePosition: updatePosition,
          module: "query",
          dryRun: args.dryRun,
          beginMutation: args.beginMutation,
          endMutation: args.endMutation
        });
        executions.push(...nextExecutions);
      } catch (error) {
        executions.push({
          id: `${runId}-${store.shopId}-${clue.clueId}-error`,
          sourceRunId,
          shopId: store.shopId,
          shopName: store.shopName,
          clueId: clue.clueId,
          clueName: clue.name,
          action: "submit",
          status: "failed",
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      const storeExecutions = executions.slice(beforeCount);
      const failed = storeExecutions.filter((item) => item.ok === false).length;
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        status: failed ? (storeExecutions.some((item) => item.ok) ? "partial" : "failed") : "ok",
        ok: failed === 0,
        message: failed ? "商机提报部分失败" : "商机提报已处理",
        reason: failed ? "opportunity-submit-partial-or-failed" : "",
        category: failed ? "api" : "",
        diagnostic: { clueId: clue.clueId, executionCount: storeExecutions.length, failed },
        index: details.length + 1,
        total: clues.length
      });
    }
  }
  return saveExecuteResult(payload, ledger, {
    runId,
    operationId: args.operationId,
    sourceRunId,
    mode: "clue-submit",
    submitMode: mode,
    goodsMatchType: matchType,
    dryRun: args.dryRun === true,
    executions,
    details
  });
}

async function searchClueForProduct(payload: DoudianAdapterPayload, store: DoudianStoreSummary, product: DoudianOpportunityProductRow, args: OpportunityArgs, runId: string) {
  if (args.mockClues?.length) {
    return normalizeClue(store, args.mockClues[0], payload.adapter, runId, 0);
  }
  const body = buildClueSearchBody({
    ...(args.filters || {}),
    keyword: product.title,
    activeKey: defaultActiveKey,
    categoryLeafId: product.categoryId || args.filters?.categoryLeafId
  }, 1, policyNumber(payload.adapter, "opportunityReport.cluePageSize", 72, 10, 100));
  const response = await runDoudianRequestPlan(payload, {
    partition: store.partition,
    planKey: "opportunityClueRealtimeList",
    context: bodyContext(body)
  });
  if (!planOk(response, payload.adapter, "opportunityClueRealtimeList")) return null;
  const wrapped = { opportunityClueRealtimeList: response.data };
  const raw = firstArray(wrapped, mappingArray(payload.adapter, "clueListPaths")).map(objectRecord)[0];
  return raw ? normalizeClue(store, raw, payload.adapter, runId, 0) : null;
}

async function fetchProductSubmit(payload: DoudianAdapterPayload, args: OpportunityArgs): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  if (!args.sourceRunId) {
    return { ...ledger, ok: false, status: "no-source-run", mode: "product-submit", message: "Source scan run is required for opportunity product submit", rows: [], clues: [], products: [], executions: [] };
  }
  const products = await loadSelectedProducts(args);
  const runId = args.operationId || `opportunity-product-submit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourceRunId = args.sourceRunId;
  const mode = submitMode(args);
  const matchMode = titleMatchMode(args);
  const updatePosition = titleUpdatePosition(args);
  const executions: DoudianOpportunityExecution[] = [];
  const details: DoudianRunDetail[] = [];
  if (!products.length) return { ...ledger, ok: false, status: "no-product", mode: "product-submit", message: "No opportunity products selected", rows: [], clues: [], products: [], executions: [] };

  for (const product of products) {
    const store = storeFromRef(stores, product);
    if (!store) {
      executions.push({
        id: `${runId}-${product.shopId}-${product.productId}-missing-store`,
        sourceRunId,
        shopId: product.shopId,
        shopName: product.shopName,
        productId: product.productId,
        title: product.title,
        action: "submit",
        status: "failed",
        ok: false,
        message: "Selected product store is missing login partition"
      });
      continue;
    }
    const beforeCount = executions.length;
    try {
      const clue = await searchClueForProduct(payload, store, product, args, runId);
      if (!clue) {
        executions.push({
          id: `${runId}-${store.shopId}-${product.productId}-no-clue`,
          sourceRunId,
          shopId: store.shopId,
          shopName: store.shopName,
          productId: product.productId,
          title: product.title,
          action: "submit",
          status: "failed",
          ok: false,
          message: "暂无当前条件下的合适商机，商品匹配商机失败"
        });
      } else {
        executions.push(...await submitProductsForClue({
          payload,
          store,
          clue,
          products: [{ ...product, matchedClueId: clue.clueId, matchedClueName: clue.name }],
          runId,
          sourceRunId,
          submitMode: mode,
          titleMatchMode: matchMode,
          titleUpdatePosition: updatePosition,
          module: "search_page_query",
          dryRun: args.dryRun,
          beginMutation: args.beginMutation,
          endMutation: args.endMutation
        }));
      }
    } catch (error) {
      executions.push({
        id: `${runId}-${store.shopId}-${product.productId}-error`,
        sourceRunId,
        shopId: store.shopId,
        shopName: store.shopName,
        productId: product.productId,
        title: product.title,
        action: "submit",
        status: "failed",
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    const productExecutions = executions.slice(beforeCount);
    const failed = productExecutions.filter((item) => item.ok === false).length;
    details.push({
      shopId: store.shopId,
      shopName: store.shopName,
      status: failed ? "failed" : "ok",
      ok: failed === 0,
      message: failed ? "商品提报失败" : "商品提报已处理",
      reason: failed ? "opportunity-product-submit-failed" : "",
      category: failed ? "api" : "",
      diagnostic: { productId: product.productId, executionCount: productExecutions.length, failed },
      index: details.length + 1,
      total: products.length
    });
  }

  return saveExecuteResult(payload, ledger, {
    runId,
    operationId: args.operationId,
    sourceRunId,
    mode: "product-submit",
    submitMode: mode,
    goodsMatchType: goodsMatchType(args),
    dryRun: args.dryRun === true,
    executions,
    details
  });
}

async function recordSubmitAttempts(args: {
  runId: string;
  matchRunId?: string;
  candidate: DoudianOpportunityPrematchCandidate;
  executions: DoudianOpportunityExecution[];
}) {
  const date = todayKey();
  const now = nowIso();
  const submitExecutions = args.executions.filter((item) => {
    const diagnostic = objectRecord(item.diagnostic);
    return item.stage === "submit" && item.planKey === "opportunitySubmitClue" && diagnostic.remoteSubmitAttempt === true;
  });
  const records: SubmitAttemptRecord[] = [];
  for (const item of submitExecutions) {
    const diagnostic = objectRecord(item.diagnostic);
    const attemptCount = Math.max(1, Math.floor(Number(diagnostic.submitAttemptCount || 1)));
    for (let attemptIndex = 1; attemptIndex <= attemptCount; attemptIndex += 1) {
      const finalAttempt = attemptIndex === attemptCount;
      records.push({
        id: `${date}-${args.runId}-${args.candidate.id}-${item.productId || args.candidate.productId}-attempt-${attemptIndex}`,
        date,
        runId: args.runId,
        matchRunId: args.matchRunId,
        candidateId: args.candidate.id,
        shopId: args.candidate.shopId,
        shopName: args.candidate.shopName,
        clueId: args.candidate.clueId,
        clueName: args.candidate.clueName,
        clueCategoryName: args.candidate.clueCategoryName,
        clueLastCategoryId: args.candidate.clueLastCategoryId,
        clueLastCategoryKey: args.candidate.clueLastCategoryKey,
        productId: item.productId || args.candidate.productId,
        title: item.title || args.candidate.title,
        status: finalAttempt ? item.status : "failed",
        ok: finalAttempt ? item.ok : false,
        message: finalAttempt ? item.message : `${item.message || "商机提报重试"}（第 ${attemptIndex} 次请求未成功）`,
        stage: item.stage,
        planKey: item.planKey,
        diagnostic: item.diagnostic,
        createdAt: now
      } satisfies SubmitAttemptRecord);
    }
  }
  await persistSubmitAttemptRecords(records);
  return records.length;
}

async function fetchPrematchSubmit(payload: DoudianAdapterPayload, args: OpportunityArgs): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const matchRunId = args.matchRunId || args.sourceRunId || "";
  if (!matchRunId) {
    return { ...ledger, ok: false, status: "no-match-run", mode: "prematch-submit", message: "Source prematch run is required", rows: [], clues: [], products: [], prematches: [], executions: [] };
  }
  const runId = args.operationId || `opportunity-prematch-submit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const mode = submitMode(args);
  const matchMode = titleMatchMode(args);
  const updatePosition = titleUpdatePosition(args);
  const limit = dailyAttemptLimit(args, payload.adapter);
  const usedByShop = await submitAttemptCountsByShop();
  const candidates = (await loadPrematchCandidates(args))
    .filter((candidate) => candidate.eligible && candidate.status !== "submitted")
    .sort((left, right) => right.matchScore - left.matchScore);
  const dedupeIndex = await submittedDedupeIndex(candidates);
  const executions: DoudianOpportunityExecution[] = [];
  const details: DoudianRunDetail[] = [];
  const updatedCandidates: DoudianOpportunityPrematchCandidate[] = [];
  const quotaExhaustedByShop = new Map<string, string>();

  if (!candidates.length) {
    return {
      ...ledger,
      ok: false,
      status: "no-candidate",
      mode: "prematch-submit",
      message: "没有可提报的预匹配候选",
      rows: [],
      clues: [],
      products: [],
      prematches: [],
      executions: [],
      matchRunId,
      dailyAttemptLimit: limit,
      dailyAttemptUsed: 0,
      dailyAttemptRemaining: limit
    };
  }

  for (const candidate of candidates) {
    const used = usedByShop.get(candidate.shopId) || 0;
    const remaining = Math.max(0, limit - used);
    const remoteQuotaReason = quotaExhaustedByShop.get(candidate.shopId);
    if (remoteQuotaReason) {
      updatedCandidates.push({ ...candidate, eligible: false, estimatedCost: 0, status: "quota_exhausted", submitStatus: "quota_exhausted", skipReason: remoteQuotaReason });
      executions.push({
        id: `${runId}-${candidate.id}-remote-quota`,
        sourceRunId: matchRunId,
        shopId: candidate.shopId,
        shopName: candidate.shopName,
        clueId: candidate.clueId,
        clueName: candidate.clueName,
        productId: candidate.productId,
        title: candidate.title,
        action: "submit",
        stage: "quota",
        status: "quota_exhausted",
        ok: true,
        message: remoteQuotaReason,
        diagnostic: { quotaExhausted: true }
      });
      continue;
    }
    if (remaining <= 0) {
      const skipped = {
        ...candidate,
        eligible: false,
        estimatedCost: 0,
        status: "quota_exhausted",
        submitStatus: "quota_exhausted",
        skipReason: "今日提报尝试额度不足"
      };
      updatedCandidates.push(skipped);
      executions.push({
        id: `${runId}-${candidate.id}-quota`,
        sourceRunId: matchRunId,
        shopId: candidate.shopId,
        shopName: candidate.shopName,
        clueId: candidate.clueId,
        clueName: candidate.clueName,
        productId: candidate.productId,
        title: candidate.title,
        action: "submit",
        stage: "quota",
        status: "quota_exhausted",
        ok: true,
        message: "今日提报尝试额度不足，已跳过",
        diagnostic: { dailyAttemptLimit: limit, dailyAttemptUsed: used, quotaExhausted: true }
      });
      continue;
    }
    const submittedSkipReason = shouldSkipSubmittedCandidate(args, dedupeIndex, candidate);
    if (submittedSkipReason) {
      const skipped = {
        ...candidate,
        eligible: false,
        estimatedCost: 0,
        status: "skipped",
        skipReason: submittedSkipReason
      };
      updatedCandidates.push(skipped);
      executions.push({
        id: `${runId}-${candidate.id}-attempted`,
        sourceRunId: matchRunId,
        shopId: candidate.shopId,
        shopName: candidate.shopName,
        clueId: candidate.clueId,
        clueName: candidate.clueName,
        productId: candidate.productId,
        title: candidate.title,
        action: "submit",
        stage: "dedupe",
        status: "skipped",
        ok: true,
        message: `${submittedSkipReason}，已跳过`
      });
      continue;
    }

    const store = storeFromRef(stores, candidate);
    if (!store) {
      const failed = { ...candidate, status: "failed", skipReason: "店铺登录分区缺失" };
      updatedCandidates.push(failed);
      executions.push({
        id: `${runId}-${candidate.id}-missing-store`,
        sourceRunId: matchRunId,
        shopId: candidate.shopId,
        shopName: candidate.shopName,
        clueId: candidate.clueId,
        clueName: candidate.clueName,
        productId: candidate.productId,
        title: candidate.title,
        action: "submit",
        status: "failed",
        ok: false,
        message: "Selected store is missing login partition"
      });
      continue;
    }

    const beforeCount = executions.length;
    const clue = candidateToClue(candidate);
    const product = candidateToProduct(candidate);
    const nextExecutions = await submitProductsForClue({
      payload,
      store,
      clue,
      products: [product],
      runId,
      sourceRunId: matchRunId,
      submitMode: mode,
      titleMatchMode: matchMode,
      titleUpdatePosition: updatePosition,
      module: "search_page_query",
      dryRun: args.dryRun,
      beginMutation: args.beginMutation,
      endMutation: args.endMutation
    });
    const attempts = args.dryRun ? 0 : await recordSubmitAttempts({ runId, matchRunId, candidate, executions: nextExecutions });
    const nextUsed = used + attempts;
    usedByShop.set(candidate.shopId, nextUsed);
    executions.push(...nextExecutions.map((item) => ({
      ...item,
      diagnostic: {
        ...(item.diagnostic || {}),
        prematchCandidateId: candidate.id,
        matchScore: candidate.matchScore,
        matchedWords: candidate.matchedWords,
        dailyAttemptUsed: nextUsed,
        dailyAttemptLimit: limit
      }
    })));
    const candidateExecutions = executions.slice(beforeCount);
    const { failed, failureMessage, submitted, skipped, unknown } = candidateExecutionState(candidateExecutions);
    if (failureMessage && isStoreDailyQuotaMessage(failureMessage)) {
      quotaExhaustedByShop.set(candidate.shopId, normalizedSubmitMessage(failureMessage));
    }
    const updated = {
      ...candidate,
      status: submitted ? "submitted" : unknown ? "unknown" : failed ? "failed" : skipped ? "skipped" : candidate.status,
      skipReason: failed ? candidateExecutions.find((item) => item.ok === false)?.message : candidate.skipReason
    };
    updatedCandidates.push(updated);
    details.push({
      shopId: candidate.shopId,
      shopName: candidate.shopName,
      status: failed ? "failed" : "ok",
      ok: !failed,
      message: failed ? "预匹配提报失败" : "预匹配提报已处理",
      reason: failed ? "prematch-submit-failed" : "",
      category: failed ? "api" : "",
      diagnostic: { candidateId: candidate.id, productId: candidate.productId, clueId: candidate.clueId, attempts },
      index: details.length + 1,
      total: candidates.length
    });
  }

  await repositoryPutMany(prematchCandidateStore, updatedCandidates);
  const failedCount = executions.filter((item) => item.ok === false).length;
  const usedTotal = Array.from(usedByShop.values()).reduce((sum, value) => sum + value, 0);
  const shopLimitTotal = limit * Math.max(1, usedByShop.size);
  const result = await saveExecuteResult(payload, ledger, {
    runId,
    operationId: args.operationId,
    sourceRunId: matchRunId,
    mode: "product-submit",
    submitMode: mode,
    goodsMatchType: "new",
    dryRun: args.dryRun === true,
    executions,
    details
  });
  return {
    ...result,
    mode: "prematch-submit",
    status: failedCount ? (executions.some((item) => item.ok) ? "partial" : "failed") : "ok",
    message: failedCount ? "商品预匹配提报部分失败" : "商品预匹配提报已处理",
    prematches: updatedCandidates,
    matchRunId,
    dailyAttemptLimit: limit,
    dailyAttemptUsed: usedTotal,
    dailyAttemptRemaining: Math.max(0, shopLimitTotal - usedTotal)
  };
}

async function fetchCollect(payload: DoudianAdapterPayload, args: OpportunityArgs): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  if (!args.sourceRunId) {
    return { ...ledger, ok: false, status: "no-source-run", mode: "collect", message: "Source scan run is required for opportunity collect", rows: [], clues: [], products: [], executions: [] };
  }
  const clues = await loadSelectedClues(args);
  const runId = args.operationId || `opportunity-collect-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourceRunId = args.sourceRunId;
  const executions: DoudianOpportunityExecution[] = [];
  const details: DoudianRunDetail[] = [];
  const requested = new Set((args.shopIds || []).map(text).filter(Boolean));
  if (!clues.length) return { ...ledger, ok: false, status: "no-clue", mode: "collect", message: "No opportunity clues selected", rows: [], clues: [], products: [], executions: [] };

  for (const clue of clues) {
    for (const shopRef of clue.shopList.filter((shop) => !requested.size || requested.has(shop.shopId))) {
      const store = storeFromRef(stores, shopRef);
      if (!store) {
        executions.push({
          id: `${runId}-${shopRef.shopId || "missing"}-${clue.clueId}-missing-store`,
          sourceRunId,
          shopId: shopRef.shopId || "",
          shopName: shopRef.shopName || "",
          clueId: clue.clueId,
          clueName: clue.name,
          action: "collect",
          status: "failed",
          ok: false,
          message: "Selected store is missing login partition"
        });
        continue;
      }
      if (shopRef.autoSubmitId) {
        executions.push({
          id: `${runId}-${store.shopId}-${clue.clueId}-collected`,
          sourceRunId,
          shopId: store.shopId,
          shopName: store.shopName,
          clueId: clue.clueId,
          clueName: clue.name,
          action: "collect",
          status: "skipped",
          ok: true,
          message: "该店铺已收藏该商机"
        });
        continue;
      }
      if (args.dryRun) {
        executions.push({
          id: `${runId}-${store.shopId}-${clue.clueId}-dry-run`,
          sourceRunId,
          shopId: store.shopId,
          shopName: store.shopName,
          clueId: clue.clueId,
          clueName: clue.name,
          action: "collect",
          status: "dry_run",
          ok: true,
          message: "dry-run opportunity collect skipped",
          planKey: "opportunityCollectClue"
        });
        continue;
      }
      const body = {
        is_cate_type: false,
        clue_id: platformIntId(clue.clueId),
        terminal_type: 0,
        source: "business_center",
        module: "search_page_all",
        scene: ""
      };
      const response = await runDoudianRequestPlan(payload, { partition: store.partition, planKey: "opportunityCollectClue", context: bodyContext(body) });
      const ok = planOk(response, payload.adapter, "opportunityCollectClue");
      executions.push({
        id: `${runId}-${store.shopId}-${clue.clueId}`,
        sourceRunId,
        shopId: store.shopId,
        shopName: store.shopName,
        clueId: clue.clueId,
        clueName: clue.name,
        action: "collect",
        status: ok ? "collected" : "failed",
        ok,
        message: ok ? "商机已加入收藏" : responseMessage(response) || "商机收藏失败",
        planKey: "opportunityCollectClue"
      });
    }
  }
  const byShop = new Map<string, DoudianOpportunityExecution[]>();
  for (const execution of executions) {
    const items = byShop.get(execution.shopId) || [];
    items.push(execution);
    byShop.set(execution.shopId, items);
  }
  for (const [shopId, items] of byShop.entries()) {
    const store = stores.find((item) => item.shopId === shopId);
    const failed = items.filter((item) => item.ok === false).length;
    details.push({
      shopId,
      shopName: store?.shopName || items[0]?.shopName || shopId,
      status: failed ? "partial" : "ok",
      ok: failed === 0,
      message: failed ? "商机收藏部分失败" : "商机收藏已处理",
      reason: failed ? "opportunity-collect-partial" : "",
      category: failed ? "api" : "",
      diagnostic: { executionCount: items.length, failed }
    });
  }
  return saveExecuteResult(payload, ledger, {
    runId,
    operationId: args.operationId,
    sourceRunId,
    mode: "collect",
    dryRun: args.dryRun === true,
    executions,
    details
  });
}

function executeSummary(executions: DoudianOpportunityExecution[]) {
  const submittedCount = executions.filter(isRemoteSubmittedExecution).length;
  const collectedCount = executions.filter((item) => item.ok === true && item.status === "collected").length;
  return {
    executionCount: executions.length,
    successCount: submittedCount + collectedCount,
    submittedCount,
    collectedCount,
    failureCount: executions.filter((item) => item.ok === false).length,
    skippedCount: executions.filter((item) => item.status === "skipped").length,
    safetySkippedCount: executions.filter((item) => item.status === "skipped" && objectRecord(item.diagnostic).safetySkipped === true).length,
    quotaExhaustedCount: executions.filter((item) => item.status === "quota_exhausted").length,
    unknownCount: executions.filter((item) => item.status === "unknown").length,
    dryRunCount: executions.filter((item) => item.status === "dry_run").length,
    productCount: uniqueText(executions.map((item) => item.productId || "")).length,
    clueCount: uniqueText(executions.map((item) => item.clueId || "")).length
  };
}

async function saveExecuteResult(
  payload: DoudianAdapterPayload,
  ledger: Awaited<ReturnType<typeof listStoreLedger>>,
  args: {
    runId: string;
    operationId?: string;
    sourceRunId?: string;
    mode: "clue-submit" | "product-submit" | "collect";
    submitMode?: string;
    goodsMatchType?: string;
    dryRun: boolean;
    executions: DoudianOpportunityExecution[];
    details: DoudianRunDetail[];
  }
): Promise<DoudianOpportunityReportResult> {
  const summary = executeSummary(args.executions);
  const successCount = summary.successCount;
  const failureCount = args.details.filter((detail) => detail.ok === false).length || summary.failureCount;
  const status = failureCount ? (successCount ? "partial" : "failed") : "ok";
  const message = failureCount
    ? policyMessage(payload.adapter, "opportunityReport.messages.executePartial", "Opportunity execution partially failed", { successCount, failureCount })
    : args.dryRun
      ? policyMessage(payload.adapter, "opportunityReport.messages.executeDryRun", "Opportunity dry-run done", { count: args.executions.length })
      : policyMessage(payload.adapter, "opportunityReport.messages.executeDone", "Opportunity execution done", { count: args.executions.length });
  const now = nowIso();
  await repositoryPut(opportunityExecuteStore, {
    id: args.runId,
    mode: args.mode,
    runId: args.runId,
    operationId: args.operationId,
    sourceRunId: args.sourceRunId,
    submitMode: args.submitMode,
    goodsMatchType: args.goodsMatchType,
    status,
    dryRun: args.dryRun,
    executions: args.executions,
    details: args.details,
    summary,
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    requestPlanHash: requestPlanHash(payload.adapter),
    createdAt: now,
    updatedAt: now
  } satisfies ExecuteRunRecord);
  return {
    ...ledger,
    ok: failureCount === 0,
    status,
    mode: args.mode,
    submitMode: args.submitMode as DoudianOpportunitySubmitMode,
    goodsMatchType: args.goodsMatchType as DoudianOpportunityGoodsMatchType,
    message,
    runId: args.runId,
    operationId: args.operationId,
    sourceRunId: args.sourceRunId,
    rows: [],
    clues: [],
    products: [],
    executions: args.executions,
    details: args.details,
    successCount,
    failureCount,
    partialCount: failureCount,
    summary,
    scanSummary: {},
    sourceHealth: [],
    requestPlanHash: requestPlanHash(payload.adapter)
  };
}

interface TaskOfficialValidationResult {
  candidates: DoudianOpportunityPrematchCandidate[];
  writeEnabled: boolean;
  status: PipelineSubmitTaskRecord["validationStatus"];
  startedAt: string;
  finishedAt: string;
  wordsRequestCount: number;
  officialWordCount: number;
  goodsRequestCount: number;
  cacheHitCount: number;
  verifiedCount: number;
  rejectedCount: number;
  unknownCount: number;
  budgetExhaustedCount: number;
  distinctGroupCount: number;
  skippedCount: number;
  durationMs: number;
  policyVersion: string;
  contractVersion: string;
}

async function validateTaskCandidatesOfficially(args: {
  payload: DoudianAdapterPayload;
  store: DoudianStoreSummary;
  task: PipelineSubmitTaskRecord;
  candidates: DoudianOpportunityPrematchCandidate[];
  opportunityArgs: OpportunityArgs;
  shouldCancel: () => boolean;
}): Promise<TaskOfficialValidationResult> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const mode = officialValidationMode(args.payload.adapter);
  const coverageGate = pipelineTaskCoverageGate(args.task);
  const writeEnabled = officialWriteAllowed(mode, coverageGate);
  const inputCoverageAllowsWrite = officialWriteAllowed("local", coverageGate);
  const validationPolicy = officialValidationPolicy(args.payload.adapter);
  const contractVersion = stableHash({
    words: policyText(args.payload.adapter, "opportunityReport.officialWordsContractVersion", "official-words-contract-unverified-v1"),
    goods: policyText(args.payload.adapter, "opportunityReport.officialGoodsContractVersion", "official-goods-contract-unverified-v1"),
    wordsSemantics: officialWordsSemantics(args.payload.adapter),
    goodsContractMode: officialGoodsContractMode(args.payload.adapter)
  });
  if (mode === "legacy") {
    const candidates = writeEnabled
      ? args.candidates
      : args.candidates.map((candidate) => ({
          ...candidate,
          eligible: false,
          estimatedCost: 0,
          status: "skipped",
          submitStatus: "skipped",
          skipReason: "input_coverage_not_complete"
        } satisfies DoudianOpportunityPrematchCandidate));
    return {
      candidates, writeEnabled, status: "not_started", startedAt, finishedAt: nowIso(),
      wordsRequestCount: 0, officialWordCount: 0, goodsRequestCount: 0, cacheHitCount: 0, verifiedCount: 0, rejectedCount: 0,
      unknownCount: 0, budgetExhaustedCount: 0, distinctGroupCount: 0, skippedCount: 0,
      durationMs: Date.now() - startedMs, policyVersion: validationPolicy.version, contractVersion
    };
  }
  if (mode === "disabled") {
    const candidates = args.candidates.map((candidate) => ({
      ...candidate,
      eligible: false,
      estimatedCost: 0,
      status: "skipped",
      validationStatus: "not_started" as const,
      validationReason: "official_validation_disabled",
      submitStatus: "skipped",
      skipReason: "官方校验已停用，安全模式禁止自动提报"
    }));
    return {
      candidates, writeEnabled: false, status: "not_started", startedAt, finishedAt: nowIso(),
      wordsRequestCount: 0, officialWordCount: 0, goodsRequestCount: 0, cacheHitCount: 0, verifiedCount: 0, rejectedCount: 0,
      unknownCount: 0, budgetExhaustedCount: 0, distinctGroupCount: 0, skippedCount: candidates.length,
      durationMs: Date.now() - startedMs, policyVersion: validationPolicy.version, contractVersion
    };
  }
  if (mode === "local") {
    const candidates = args.candidates.map((candidate) => writeEnabled
      ? {
          ...candidate,
          validationStatus: "not_started" as const,
          validationReason: undefined,
          submitStatus: candidate.submitStatus,
          skipReason: candidate.skipReason
        }
      : {
          ...candidate,
          eligible: false,
          estimatedCost: 0,
          status: "skipped" as const,
          validationStatus: "not_started" as const,
          validationReason: "input_coverage_not_complete",
          submitStatus: "skipped" as const,
          skipReason: "input_coverage_not_complete"
        });
    return {
      candidates,
      writeEnabled,
      status: "not_started",
      startedAt,
      finishedAt: nowIso(),
      wordsRequestCount: 0,
      officialWordCount: 0,
      goodsRequestCount: 0,
      cacheHitCount: 0,
      verifiedCount: 0,
      rejectedCount: 0,
      unknownCount: 0,
      budgetExhaustedCount: 0,
      distinctGroupCount: 0,
      skippedCount: writeEnabled ? 0 : candidates.length,
      durationMs: Date.now() - startedMs,
      policyVersion: validationPolicy.version,
      contractVersion
    };
  }
  const reusableSnapshot = Boolean(
    args.task.validationFinishedAt
    && (args.task.validationStatus === "complete" || args.task.validationStatus === "partial")
    && args.task.validationPolicyVersion === validationPolicy.version
    && args.task.officialContractVersion === contractVersion
  );
  if (reusableSnapshot) {
    const candidates = args.candidates.map((candidate) => {
      const submitState = text(candidate.submitStatus || candidate.status);
      const alreadyResolved = ["accepted", "submitted", "sending", "unknown", "failed", "cancelled", "quota_exhausted"].includes(submitState);
      const canSubmit = !alreadyResolved && officialDecisionAllowsWrite({
        mode,
        writeEnabled,
        locallyEligible: candidate.eligible,
        localStatus: candidate.status,
        validationStatus: candidate.validationStatus
      });
      if (mode === "observe" && writeEnabled) return candidate;
      return {
        ...candidate,
        eligible: canSubmit,
        estimatedCost: canSubmit ? 1 : 0,
        status: canSubmit ? "ready" : candidate.status,
        submitStatus: canSubmit ? "queued" : candidate.submitStatus
      };
    });
    return {
      candidates,
      writeEnabled,
      status: args.task.validationStatus,
      startedAt: args.task.validationStartedAt || startedAt,
      finishedAt: args.task.validationFinishedAt || nowIso(),
      wordsRequestCount: Number(args.task.officialWordsRequestCount || 0),
      officialWordCount: Number(args.task.officialWordsCount || 0),
      goodsRequestCount: Number(args.task.officialGoodsRequestCount || 0),
      cacheHitCount: 0,
      verifiedCount: Number(args.task.officialVerifiedCount || 0),
      rejectedCount: Number(args.task.officialRejectedCount || 0),
      unknownCount: Number(args.task.validationUnknownCount || 0),
      budgetExhaustedCount: Number(args.task.validationBudgetExhaustedCount || 0),
      distinctGroupCount: 0,
      skippedCount: 0,
      durationMs: Date.now() - startedMs,
      policyVersion: validationPolicy.version,
      contractVersion
    };
  }

  const timeoutMs = policyNumber(args.payload.adapter, "opportunityReport.officialValidationTimeoutMsPerStore", 60000, 1000, 600000);
  const maxGroups = policyNumber(args.payload.adapter, "opportunityReport.officialValidationMaxGroupsPerStore", 20, 1, 1000);
  const maxRequests = policyNumber(args.payload.adapter, "opportunityReport.officialValidationMaxRequestsPerStore", 100, 1, 5000);
  const depthMax = policyNumber(args.payload.adapter, "opportunityReport.officialValidationCandidateDepthMax", 5, 1, 20);
  const wordsByClue = new Map<string, Awaited<ReturnType<typeof queryOfficialClueWords>>>();
  const goodsByClue = new Map<string, Awaited<ReturnType<typeof queryOfficialClueGoods>>>();
  const validationGroups = new Set<string>();
  const resultById = new Map<string, DoudianOpportunityPrematchCandidate>();
  let wordsRequestCount = 0;
  let goodsRequestCount = 0;
  let cacheHitCount = 0;
  let verifiedCount = 0;
  let rejectedCount = 0;
  let unknownCount = 0;
  let budgetExhaustedCount = 0;
  const markBudgetExhausted = (candidate: DoudianOpportunityPrematchCandidate, reason: string) => {
    budgetExhaustedCount += 1;
    resultById.set(candidate.id, {
      ...candidate,
      eligible: mode === "observe" && writeEnabled ? candidate.eligible : false,
      estimatedCost: mode === "observe" && writeEnabled ? candidate.estimatedCost : 0,
      status: mode === "observe" && writeEnabled ? candidate.status : "skipped",
      validationStatus: "budget_exhausted",
      validationReason: reason,
      validatedAt: nowIso(),
      validationPolicyVersion: validationPolicy.version,
      submitStatus: mode === "observe" && writeEnabled ? candidate.submitStatus : "skipped",
      skipReason: mode === "observe" && writeEnabled ? candidate.skipReason : "官方校验预算已耗尽"
    });
  };
  const byProduct = new Map<string, DoudianOpportunityPrematchCandidate[]>();
  for (const candidate of args.candidates) {
    const list = byProduct.get(candidate.productId) || [];
    list.push(candidate);
    byProduct.set(candidate.productId, list);
  }
  for (const candidates of byProduct.values()) {
    const ranked = candidates.sort(compareFallbackCandidates).slice(0, depthMax);
    let selected = false;
    let blocked = false;
    for (const candidate of ranked) {
      assertNotCancelled(args.shouldCancel);
      if (selected || blocked) break;
      const groupKey = `${args.store.shopId}::${candidate.clueId}`;
      const timedOut = Date.now() - startedMs >= timeoutMs;
      const groupBudgetReached = !validationGroups.has(groupKey) && validationGroups.size >= maxGroups;
      const requestBudgetReached = wordsRequestCount + goodsRequestCount >= maxRequests;
      if (timedOut || groupBudgetReached || requestBudgetReached) {
        blocked = true;
        markBudgetExhausted(candidate, timedOut ? "validation_timeout" : groupBudgetReached ? "validation_group_budget_exhausted" : "validation_request_budget_exhausted");
        break;
      }
      validationGroups.add(groupKey);
      const clue = candidateToClue(candidate);
      let wordsResult = wordsByClue.get(candidate.clueId);
      if (!wordsResult) {
        wordsResult = await queryOfficialClueWords({ payload: args.payload, store: args.store, clue, opportunityArgs: args.opportunityArgs, shouldCancel: args.shouldCancel });
        wordsByClue.set(candidate.clueId, wordsResult);
        wordsRequestCount += wordsResult.requestCount;
        if (wordsResult.cacheHit) cacheHitCount += 1;
      }
      if (Date.now() - startedMs >= timeoutMs) {
        blocked = true;
        markBudgetExhausted(candidate, "validation_timeout");
        break;
      }
      const remainingRequests = Math.max(0, maxRequests - wordsRequestCount - goodsRequestCount);
      let goodsResult = goodsByClue.get(candidate.clueId);
      if (!goodsResult) {
        goodsResult = await queryOfficialClueGoods({
          payload: args.payload,
          store: args.store,
          clue,
          runId: args.task.runId,
          opportunityArgs: args.opportunityArgs,
          maxRequests: remainingRequests,
          shouldCancel: args.shouldCancel
        });
        goodsByClue.set(candidate.clueId, goodsResult);
        goodsRequestCount += goodsResult.requestCount;
        if (goodsResult.cacheHit) cacheHitCount += 1;
      }
      if (Date.now() - startedMs >= timeoutMs) {
        blocked = true;
        markBudgetExhausted(candidate, "validation_timeout");
        break;
      }
      const decision = validateOfficialCandidate({
        title: candidate.title,
        clueName: candidate.clueName,
        productId: candidate.productId,
        anchorWords: candidate.anchorWords,
        anchorConfidence: candidate.anchorConfidence,
        words: wordsResult,
        goods: goodsResult,
        policy: validationPolicy
      });
      if (decision.status === "verified") verifiedCount += 1;
      else if (decision.status === "rejected") rejectedCount += 1;
      else unknownCount += 1;
      const canSubmit = officialDecisionAllowsWrite({
        mode,
        writeEnabled,
        locallyEligible: candidate.eligible,
        localStatus: candidate.status,
        validationStatus: decision.status
      });
      const observeWrite = mode === "observe" && writeEnabled;
      resultById.set(candidate.id, {
        ...candidate,
        eligible: canSubmit,
        estimatedCost: canSubmit ? Math.max(1, Number(candidate.estimatedCost || 1)) : 0,
        status: observeWrite ? candidate.status : canSubmit ? "ready" : "skipped",
        validationStatus: decision.status,
        validationReason: decision.reason,
        validatedAt: nowIso(),
        validationPolicyVersion: validationPolicy.version,
        missingAnchorWords: decision.missingAnchorWords,
        officialWords: wordsResult.words,
        officialWordsHash: wordsResult.responseHash,
        officialWordsSemantics: wordsResult.semantics,
        officialWordsCacheKey: wordsResult.cacheKey,
        officialGoodsCacheKey: goodsResult.cacheKey,
        officialGoodsComplete: goodsResult.status === "complete",
        officialGoodsMatched: decision.officialGoodsMatched,
        officialGoodsContractMode: goodsResult.contractMode,
        officialGoodsResponseHash: goodsResult.responseHash,
        submitStatus: observeWrite ? candidate.submitStatus : canSubmit ? "queued" : "skipped",
        submitPriority: observeWrite ? candidate.submitPriority : canSubmit ? "primary" : candidate.submitPriority,
        fallbackSubmit: observeWrite ? candidate.fallbackSubmit : canSubmit ? false : candidate.fallbackSubmit,
        submitModule: candidate.submitModule || "search_page_query",
        submitModuleDecisionVersion: policyText(args.payload.adapter, "opportunityReport.submitModuleDecisionVersion", "submit-module-existing-source-v1"),
        skipReason: observeWrite
          ? candidate.skipReason
          : canSubmit
            ? undefined
          : decision.status === "verified" && !inputCoverageAllowsWrite
            ? "input_coverage_not_complete"
            : decision.reason
      });
      if (decision.status === "verified") selected = true;
      if (decision.status === "unknown" || decision.status === "budget_exhausted") blocked = true;
    }
  }
  const candidates: DoudianOpportunityPrematchCandidate[] = args.candidates.map((candidate) => resultById.get(candidate.id) || (mode === "observe" && writeEnabled
    ? ({
        ...candidate,
        validationStatus: "not_started" as const,
        validationReason: candidate.validationReason || "higher_rank_candidate_resolved"
      } satisfies DoudianOpportunityPrematchCandidate)
    : ({
        ...candidate,
        eligible: false,
        estimatedCost: 0,
        status: "skipped",
        submitStatus: "skipped",
        validationStatus: "not_started",
        validationReason: candidate.validationReason || "higher_rank_candidate_resolved",
        skipReason: candidate.skipReason || "更高排名候选已完成官方决策"
      } satisfies DoudianOpportunityPrematchCandidate)));
  const finishedAt = nowIso();
  const status: PipelineSubmitTaskRecord["validationStatus"] = budgetExhaustedCount || unknownCount ? "partial" : "complete";
  return {
    candidates,
    writeEnabled,
    status,
    startedAt,
    finishedAt,
    wordsRequestCount,
    officialWordCount: uniqueText(Array.from(wordsByClue.values()).flatMap((result) => result.words)).length,
    goodsRequestCount,
    cacheHitCount,
    verifiedCount,
    rejectedCount,
    unknownCount,
    budgetExhaustedCount,
    distinctGroupCount: validationGroups.size,
    skippedCount: candidates.filter((candidate) => candidate.submitStatus === "skipped").length,
    durationMs: Date.now() - startedMs,
    policyVersion: validationPolicy.version,
    contractVersion
  };
}

interface OpportunitySubmitSchedulerLease {
  tenantId: string;
  endpointContract: string;
  ownerId: string;
  fencingToken: number;
  leaseExpiresAt?: string;
}

async function claimSubmitSchedulerLease(
  task: PipelineSubmitTaskRecord,
  payload: DoudianAdapterPayload,
  ownerId: string,
  workerSlot: number,
  taskConcurrency: number
) {
  const coordinator = getNativeData()?.opportunitySubmit;
  if (!coordinator) throw new Error("Opportunity submit coordinator is unavailable");
  const tenantId = text(task.tenantId) || "default";
  const endpointContract = "opportunitySubmitClue";
  const throttleBudgetMs = policyNumber(payload.adapter, "opportunityReport.submitStoreThrottleBudgetMs", 1800000, 60000, 3600000);
  const now = nowIso();
  const result = objectRecord(await coordinator.claimSchedulerLease({
    tenantId,
    endpointContract,
    ownerId,
    now,
    leaseExpiresAt: new Date(Date.now() + Math.min(3600000, throttleBudgetMs + 300000)).toISOString()
  }));
  if (result.claimed !== true) return null;
  const lease = objectRecord(result.lease);
  const fencingToken = Math.max(0, Math.floor(Number(lease.fencingToken || 0)));
  if (!fencingToken) throw new Error("Opportunity submit scheduler returned an invalid fencing token");
  const schedulerLease = {
    tenantId,
    endpointContract,
    ownerId,
    fencingToken,
    leaseExpiresAt: text(lease.leaseExpiresAt)
  } satisfies OpportunitySubmitSchedulerLease;
  await writePipelineEvent({
    runId: task.runId,
    storeRunId: task.storeRunId,
    shopId: task.shopId,
    level: "info",
    event: "submit-scheduler-lease-claimed",
    message: "Submit scheduler lease claimed",
    detail: coordinatedSubmitEventDetail({
      task,
      schedulerLease,
      workerId: ownerId,
      workerSlot,
      taskConcurrency,
      reason: text(result.reason),
      nextEligibleAt: schedulerLease.leaseExpiresAt,
      extra: { endpointContract }
    })
  }).catch(() => undefined);
  return schedulerLease;
}

async function releaseSubmitSchedulerLease(lease: OpportunitySubmitSchedulerLease | null | undefined) {
  const coordinator = getNativeData()?.opportunitySubmit;
  if (!coordinator || !lease) return;
  await coordinator.releaseSchedulerLease({
    tenantId: lease.tenantId,
    endpointContract: lease.endpointContract,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    now: nowIso()
  }).catch(() => undefined);
}

interface CoordinatedInFlightRecoveryResult {
  task: PipelineSubmitTaskRecord;
  action: "reservation_released" | "dispatched_marked_unknown";
  attemptId: string;
}

async function recoverCoordinatedInFlightAttempt(args: {
  payload: DoudianAdapterPayload;
  task: PipelineSubmitTaskRecord;
  workerId: string;
  schedulerLease: OpportunitySubmitSchedulerLease;
}): Promise<CoordinatedInFlightRecoveryResult> {
  const coordinator = getNativeData()?.opportunitySubmit;
  if (!coordinator) throw new Error("Opportunity submit coordinator is unavailable");
  assertBoundSubmitTaskContract(args.task);
  const attemptId = text(args.task.inFlightAttemptId);
  const fencingToken = Number(args.task.fencingToken || 0);
  if (!attemptId || !fencingToken) throw new Error("Opportunity submit recovery checkpoint is incomplete");
  const fence = {
    taskId: args.task.id,
    ownerRunId: args.workerId,
    fencingToken,
    schedulerOwnerId: args.schedulerLease.ownerId,
    schedulerFencingToken: args.schedulerLease.fencingToken,
    endpointContract: args.schedulerLease.endpointContract
  };
  try {
    const released = objectRecord(await coordinator.releaseReservation({ ...fence, attemptId, now: nowIso() }));
    if (released.released === true) {
      return {
        task: objectRecord(released.task) as unknown as PipelineSubmitTaskRecord,
        action: "reservation_released",
        attemptId
      };
    }
  } catch {
    // A consumed grant cannot be released. Resolve it as unknown under the new fence.
  }
  const resolved = objectRecord(await coordinator.resolve({
    ...fence,
    attemptId,
    now: nowIso(),
    outcome: "unknown",
    responseClass: "worker-recovery-dispatched-unknown",
    message: "submit result unresolved after worker recovery",
    policy: submitCoordinatorPolicy(args.payload.adapter)
  }));
  return {
    task: objectRecord(resolved.task) as unknown as PipelineSubmitTaskRecord,
    action: "dispatched_marked_unknown",
    attemptId
  };
}

async function coordinatedSubmitAttempt(args: {
  payload: DoudianAdapterPayload;
  opportunityArgs: OpportunityArgs;
  store: DoudianStoreSummary;
  task: PipelineSubmitTaskRecord;
  workerId: string;
  workerSlot: number;
  taskConcurrency: number;
  schedulerLease: OpportunitySubmitSchedulerLease;
  candidates: DoudianOpportunityPrematchCandidate[];
  products: DoudianOpportunityProductRow[];
  body: Record<string, unknown>;
  shouldCancel?: () => boolean;
  beginMutation?: () => void;
  endMutation?: () => void;
}): Promise<CoordinatedRemoteSubmitResult> {
  const coordinator = getNativeData()?.opportunitySubmit;
  if (!coordinator) throw new Error("Opportunity submit coordinator is unavailable");
  assertBoundSubmitTaskContract(args.task);
  const candidateByProductId = new Map(args.candidates.map((candidate) => [candidate.productId, candidate]));
  const orderedCandidates = args.products.map((product) => candidateByProductId.get(product.productId)).filter((candidate): candidate is DoudianOpportunityPrematchCandidate => Boolean(candidate));
  if (orderedCandidates.length !== args.products.length) throw new Error("Coordinated submit candidate snapshot does not match the remote batch");
  const logicalGroupIds = uniqueText(orderedCandidates.map((candidate) => text(candidate.logicalGroupId)));
  if (logicalGroupIds.length > 1) throw new Error("Coordinated submit retry batch mixes logical groups");
  const policySnapshot = submitCoordinatorPolicy(args.payload.adapter);
  const fence = {
    taskId: args.task.id,
    ownerRunId: args.workerId,
    fencingToken: Number(args.task.fencingToken || 0),
    schedulerOwnerId: args.schedulerLease.ownerId,
    schedulerFencingToken: args.schedulerLease.fencingToken,
    endpointContract: args.schedulerLease.endpointContract
  };
  if (!fence.fencingToken) throw new Error("Opportunity submit task is missing a fencing token");
  const admission = objectRecord(await coordinator.admit({
    ...fence,
    now: nowIso(),
    businessDate: businessDateKey(),
    candidateIds: orderedCandidates.map((candidate) => candidate.id),
    clueId: text(args.body.clue_id || orderedCandidates[0]?.clueId),
    requestBody: args.body,
    logicalGroupId: logicalGroupIds[0] || undefined,
    dailyCandidateMutationLimit: dailyAttemptLimit(args.opportunityArgs, args.payload.adapter),
    dailyHttpRequestLimit: policyNumber(args.payload.adapter, "opportunityReport.submitDailyHttpRequestLimit", 1000, 1, 1000000),
    policy: policySnapshot,
    contractSnapshot: {
      releaseId: args.task.releaseId,
      releaseManifestHash: args.task.releaseManifestHash,
      runnerArtifactHash: args.task.runnerArtifactHash,
      adapterVersion: args.task.adapterVersion,
      scriptsVersion: args.task.scriptsVersion,
      requestPlanHash: args.task.requestPlanHash,
      submitContractVersion: args.task.submitContractVersion,
      pacingPolicyHash: args.task.pacingPolicyHash,
      adapterSnapshotHash: args.task.adapterSnapshotHash
    }
  }));
  const admissionTask = objectRecord(admission.task) as unknown as PipelineSubmitTaskRecord;
  const admissionRate = objectRecord(admission.rate);
  const admissionQuota = objectRecord(admission.quota);
  if (admission.admitted !== true) {
    const reason = text(admission.reason);
    const event = reason === "rate-delayed"
      ? "submit-rate-delayed"
      : reason === "retry-exhausted"
        ? "submit-retry-exhausted"
        : "submit-task-deferred";
    await writePipelineEvent({
      runId: args.task.runId,
      storeRunId: args.task.storeRunId,
      shopId: args.task.shopId,
      level: reason === "rate-delayed" ? "info" : "warn",
      event,
      message: reason === "rate-delayed" ? "Submit request delayed by pacing policy" : "Submit request deferred by coordinator",
      detail: coordinatedSubmitEventDetail({
        task: args.task,
        taskState: admissionTask,
        schedulerLease: args.schedulerLease,
        workerId: args.workerId,
        workerSlot: args.workerSlot,
        taskConcurrency: args.taskConcurrency,
        candidates: orderedCandidates,
        rate: { store: admission.storeRate, global: admission.globalRate },
        quota: objectRecord(admission.usage),
        nextEligibleAt: admission.resumeAt,
        reason
      })
    }).catch(() => undefined);
    return {
      attemptCount: 0,
      deferred: true,
      settledTask: admissionTask,
      coordination: {
        coordinatorReason: text(admission.reason),
        coordinatorTaskStatus: text(objectRecord(admission.task).status),
        coordinatorResumeAt: text(admission.resumeAt || objectRecord(admission.task).resumeAt)
      }
    };
  }

  const attempt = objectRecord(admission.attempt);
  const attemptId = text(attempt.attemptId);
  const httpGrantId = text(attempt.httpGrantId);
  if (!attemptId || !httpGrantId) throw new Error("Opportunity submit admission returned an incomplete HTTP grant");
  await writePipelineEvent({
    runId: args.task.runId,
    storeRunId: args.task.storeRunId,
    shopId: args.task.shopId,
    level: "info",
    event: "submit-rate-admitted",
    message: "Submit request admitted by pacing policy",
    detail: coordinatedSubmitEventDetail({
      task: args.task,
      taskState: admissionTask,
      schedulerLease: args.schedulerLease,
      workerId: args.workerId,
      workerSlot: args.workerSlot,
      taskConcurrency: args.taskConcurrency,
      candidates: orderedCandidates,
      attempt,
      rate: admissionRate,
      quota: admissionQuota,
      reason: admission.reason
    })
  }).catch(() => undefined);
  let dispatched = false;
  let dispatchResult: Record<string, unknown> = {};
  try {
    assertNotCancelled(args.shouldCancel);
    dispatchResult = objectRecord(await coordinator.consumeHttpGrant({ ...fence, attemptId, httpGrantId, now: nowIso() }));
    dispatched = true;
    await writePipelineEvent({
      runId: args.task.runId,
      storeRunId: args.task.storeRunId,
      shopId: args.task.shopId,
      level: "info",
      event: "submit-http-grant-dispatched",
      message: "Submit HTTP grant dispatched",
      detail: coordinatedSubmitEventDetail({
        task: args.task,
        taskState: objectRecord(dispatchResult.task) as unknown as PipelineSubmitTaskRecord,
        schedulerLease: args.schedulerLease,
        workerId: args.workerId,
        workerSlot: args.workerSlot,
        taskConcurrency: args.taskConcurrency,
        candidates: orderedCandidates,
        attempt,
        rate: admissionRate,
        quota: objectRecord(dispatchResult.quota),
        reason: "http-grant-consumed"
      })
    }).catch(() => undefined);
  } catch (error) {
    if (!dispatched) await coordinator.releaseReservation({ ...fence, attemptId, now: nowIso() }).catch(() => undefined);
    throw error;
  }

  let response: RequestPlanResult | undefined;
  let requestError = "";
  try {
    const submitResult = await submitWithRetry(
      args.payload,
      args.store,
      args.body,
      args.shouldCancel,
      args.beginMutation,
      args.endMutation,
      {
        runId: args.task.runId,
        sourceRunId: args.task.runId,
        clueId: text(args.body.clue_id),
        productIds: args.products.map((product) => product.productId)
      }
    );
    response = submitResult.response;
  } catch (error) {
    requestError = error instanceof Error ? error.message : String(error);
  }

  const message = requestError || responseMessage(response);
  const accepted = submitResponseOk(response);
  const wholeBatchState = accepted ? undefined : submitMessageState(message);
  const classification = classifyCoordinatedSubmitAttempt({
    accepted,
    httpStatus: Number(response?.status || 0),
    message,
    candidates: orderedCandidates.map((candidate) => ({ candidateId: candidate.id, productId: candidate.productId })),
    failureMessages: accepted ? undefined : productFailureMessages(message),
    wholeBatchStatus: wholeBatchState?.status === "skipped" ? "skipped" : "failed",
    frequencyLimited: submitFrequencyLimitedMessage(message, response),
    manualInterventionRequired: submitManualInterventionMessage(message, response),
    uncertain: Boolean(requestError) || transientSubmitMessage(message, response)
  });
  const resolved = objectRecord(await coordinator.resolve({
    ...fence,
    attemptId,
    now: nowIso(),
    outcome: classification.outcome,
    responseClass: classification.responseClass,
    candidateResults: classification.candidateResults,
    httpStatus: Number(response?.status || 0),
    retryAfterMs: retryAfterMs(response?.headers),
    message,
    policy: policySnapshot
  }));
  const settledTask = objectRecord(resolved.task) as unknown as PipelineSubmitTaskRecord;
  const resolvedRate = objectRecord(resolved.rate);
  const resolvedDetail = coordinatedSubmitEventDetail({
    task: args.task,
    taskState: settledTask,
    schedulerLease: args.schedulerLease,
    workerId: args.workerId,
    workerSlot: args.workerSlot,
    taskConcurrency: args.taskConcurrency,
    candidates: orderedCandidates,
    attempt,
    rate: resolvedRate,
    quota: objectRecord(dispatchResult.quota),
    nextEligibleAt: resolved.resumeAt,
    reason: classification.outcome,
    extra: {
      coordinatorOutcome: classification.outcome,
      responseClass: classification.responseClass,
      httpStatus: Number(response?.status || 0),
      retryExhausted: resolved.retryExhausted === true,
      throttleBudgetExceeded: resolved.throttleBudgetExceeded === true
    }
  });
  await writePipelineEvent({
    runId: args.task.runId,
    storeRunId: args.task.storeRunId,
    shopId: args.task.shopId,
    level: classification.outcome === "failed" || classification.outcome === "unknown" ? "warn" : "info",
    event: "submit-result-reconciled",
    message: "Submit result reconciled with the persisted checkpoint",
    detail: resolvedDetail
  }).catch(() => undefined);
  const admittedStoreRate = objectRecord(admissionRate.store);
  const admittedGlobalRate = objectRecord(admissionRate.global);
  const nextStoreRate = objectRecord(resolvedRate.store);
  const nextGlobalRate = objectRecord(resolvedRate.global);
  const rateAdjusted = Number(admittedStoreRate.intervalMs || 0) !== Number(nextStoreRate.intervalMs || 0)
    || Number(admittedGlobalRate.intervalMs || 0) !== Number(nextGlobalRate.intervalMs || 0)
    || text(admittedGlobalRate.mode) !== text(nextGlobalRate.mode);
  if (classification.outcome === "throttled") {
    await writePipelineEvent({
      runId: args.task.runId,
      storeRunId: args.task.storeRunId,
      shopId: args.task.shopId,
      level: "warn",
      event: "submit-throttle-detected",
      message: "Submit throttle detected and isolated to the affected store",
      detail: resolvedDetail
    }).catch(() => undefined);
  }
  if (rateAdjusted) {
    await writePipelineEvent({
      runId: args.task.runId,
      storeRunId: args.task.storeRunId,
      shopId: args.task.shopId,
      level: classification.outcome === "throttled" ? "warn" : "info",
      event: "submit-rate-adjusted",
      message: "Submit pacing rate adjusted",
      detail: {
        ...resolvedDetail,
        previousStoreIntervalMs: Number(admittedStoreRate.intervalMs || 0),
        previousGlobalIntervalMs: Number(admittedGlobalRate.intervalMs || 0),
        previousGlobalMode: text(admittedGlobalRate.mode)
      }
    }).catch(() => undefined);
  }
  if (resolved.retryExhausted === true) {
    await writePipelineEvent({
      runId: args.task.runId,
      storeRunId: args.task.storeRunId,
      shopId: args.task.shopId,
      level: "warn",
      event: "submit-retry-exhausted",
      message: "Submit retry limit exhausted",
      detail: resolvedDetail
    }).catch(() => undefined);
  }
  return {
    response,
    attemptCount: 1,
    classification,
    settledTask,
    coordination: {
      logicalGroupId: text(attempt.logicalGroupId),
      coordinatorCandidateIds: orderedCandidates.map((candidate) => candidate.id),
      requestAttemptId: attemptId,
      retryCycle: Number(attempt.retryCycle || 0),
      attemptOrdinal: Number(attempt.attemptOrdinal || 0),
      quotaReservationId: text(attempt.quotaReservationId),
      httpGrantId,
      coordinatorReason: classification.outcome === "throttled" ? "throttled" : "resolved",
      coordinatorOutcome: classification.outcome,
      coordinatorTaskStatus: text(objectRecord(resolved.task).status),
      coordinatorResumeAt: text(resolved.resumeAt)
    }
  };
}

async function executeSubmitWorker(payload: DoudianAdapterPayload, args: OpportunityArgs = {}) {
    const ledger = await listStoreLedger();
    const stores = ledger.stores || [];
    const scopedRunId = text(args.runId || args.operationId || args.sourceRunId);
    const taskConcurrency = submitTaskConcurrency(payload.adapter);
    const workerId = `${scopedRunId || "global"}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const coordinated = submitCoordinatorEnabled(payload.adapter) && !args.dryRun;
    const schedulerLeases = new Map<string, Promise<OpportunitySubmitSchedulerLease | null>>();
    let schedulerBusy = false;
    const schedulerLeaseForTask = (task: PipelineSubmitTaskRecord, workerSlot: number) => {
      const tenantId = text(task.tenantId) || "default";
      let pending = schedulerLeases.get(tenantId);
      if (!pending) {
        pending = claimSubmitSchedulerLease(task, payload, workerId, workerSlot, taskConcurrency);
        schedulerLeases.set(tenantId, pending);
      }
      return pending;
    };
    void reportDoudianDiagnostic({
      category: "opportunity-pipeline",
      event: "submit-worker-started",
      runId: scopedRunId,
      workerId,
      taskConcurrency,
      rateLimitIsolation: "store-only-test",
      otherStoreTasksContinueOnRateLimit: true
    }, true);
    let processed = 0;
    try {
    while (true) {
      const nowMs = Date.now();
      const taskPool = scopedRunId
        ? await loadPipelineSubmitTasksForRunStrict(scopedRunId)
        : await repositoryGetAll<PipelineSubmitTaskRecord>(pipelineSubmitTaskStore);
      const tasks = taskPool
        .filter((task) => !scopedRunId || task.runId === scopedRunId)
        .filter((task) => !args.submitTaskId || task.id === args.submitTaskId)
        .filter((task) => ((task.status === "ready" || task.status === "queued") && (!task.resumeAt || Date.parse(task.resumeAt) <= nowMs)) ||
          (task.status === "running" && (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) < nowMs)) ||
          (coordinated && task.status === "cooling_down" && Boolean(task.resumeAt) && Date.parse(task.resumeAt || "") <= nowMs) ||
          (coordinated && task.status === "deferred" && task.requiresExplicitResume !== true && Boolean(task.resumeAt) && Date.parse(task.resumeAt || "") <= nowMs))
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
      if (!tasks.length) break;
      const activeKeys = new Set<string>();
      let processedThisPass = 0;
      const selectedTasks: PipelineSubmitTaskRecord[] = [];
      for (const candidateTask of tasks) {
        if (activeKeys.has(candidateTask.concurrencyKey)) continue;
        activeKeys.add(candidateTask.concurrencyKey);
        selectedTasks.push(candidateTask);
      }
      if (!selectedTasks.length) break;
      const slotCount = Math.min(taskConcurrency, selectedTasks.length);
      let nextTaskIndex = 0;
      const runWorkerSlot = async (workerSlot: number) => {
      while (true) {
      const initialTask = selectedTasks[nextTaskIndex];
      nextTaskIndex += 1;
      if (!initialTask) return;
      const schedulerLease = coordinated ? await schedulerLeaseForTask(initialTask, workerSlot) : null;
      if (coordinated && !schedulerLease) {
        schedulerBusy = true;
        continue;
      }
      let task = initialTask;
      const startedAt = nowIso();
      const leaseExpiresAt = submitLeaseExpiresAt(payload.adapter);
      const claimed = await repositoryClaimOpportunitySubmitTask<PipelineSubmitTaskRecord & Record<string, unknown>>({
        taskId: task.id,
        ownerRunId: workerId,
        leaseExpiresAt,
        now: startedAt
      });
      if (claimed) {
        if (!claimed.claimed || !claimed.task) continue;
        task = claimed.task;
      } else {
        task = {
          ...task,
          status: "running",
          ownerRunId: workerId,
          startedAt: task.startedAt || startedAt,
          leaseExpiresAt,
          updatedAt: startedAt
        } satisfies PipelineSubmitTaskRecord;
        await repositoryPut(pipelineSubmitTaskStore, task);
      }
      if (coordinated && schedulerLease && ["cooling_down", "deferred"].includes(initialTask.status)) {
        await writePipelineEvent({
          runId: task.runId,
          storeRunId: task.storeRunId,
          shopId: task.shopId,
          level: "info",
          event: "submit-task-resumed",
          message: "Submit task resumed from a persisted checkpoint",
          detail: coordinatedSubmitEventDetail({
            task,
            schedulerLease,
            workerId,
            workerSlot,
            taskConcurrency,
            reason: initialTask.deferredReason || initialTask.status,
            extra: { resumedFromStatus: initialTask.status }
          })
        }).catch(() => undefined);
      }
      const store = stores.find((item) => item.shopId === task.shopId);
      const loadedTaskCandidates = await repositoryGetMany<DoudianOpportunityPrematchCandidate>(pipelineCandidateStore, task.candidateIds).catch(() => []);
      const taskCandidateById = new Map(loadedTaskCandidates.map((candidate) => [candidate.id, candidate]));
      let taskCandidates = task.candidateIds
        .map((id) => taskCandidateById.get(id))
        .filter((candidate): candidate is DoudianOpportunityPrematchCandidate => Boolean(candidate));
      dispatchPipelineProgress(args, submitWorkerProgress(0, taskCandidates.length), `商机提报队列已接管，待处理 ${taskCandidates.length} 项`);
      void reportDoudianDiagnostic({
        category: "opportunity-pipeline",
        event: "submit-worker-task-claimed",
        runId: task.runId,
        taskId: task.id,
        shopId: task.shopId,
        candidateCount: taskCandidates.length,
        workerId,
        workerSlot,
        taskConcurrency,
        activeStoreTaskCount: slotCount,
        queuedStoreTaskCount: selectedTasks.length
      }, true);
      await writePipelineEvent({
        runId: task.runId,
        storeRunId: task.storeRunId,
        shopId: task.shopId,
        level: "info",
        event: "pipeline-submit-task-dispatched",
        message: `Store ${task.shopName || task.shopId} started in worker slot ${workerSlot}/${taskConcurrency}`,
        detail: {
          taskId: task.id,
          workerId,
          workerSlot,
          taskConcurrency,
          activeStoreTaskCount: slotCount,
          queuedStoreTaskCount: selectedTasks.length,
          candidateCount: taskCandidates.length,
          rateLimitIsolation: "store-only-test",
          otherStoreTasksContinueOnRateLimit: slotCount > 1
        }
      }).catch(() => undefined);
      const updatedCandidates: DoudianOpportunityPrematchCandidate[] = [];
      const executions: DoudianOpportunityExecution[] = [];
      let submittedCount = Number(task.submittedCount || 0);
      let skippedCount = Number(task.skippedCount || 0);
      let failedCount = Number(task.failedCount || 0);
      let safetySkippedCount = Number(task.safetySkippedCount || 0);
      let quotaExhaustedCount = Number(task.quotaExhaustedCount || 0);
      let cancelledCount = Number(task.cancelledCount || 0);
      let unknownCount = Number(task.unknownCount || 0);
      let remoteRequestCount = Number(task.remoteRequestCount || 0);
      let submitThrottleReason = "";
      let quotaExhaustedReason = "";
      let cancelledDuringTask = false;
      let coordinatedTaskState: PipelineSubmitTaskRecord | null = null;
      let coordinatedTaskReason = "";
      let coordinatedTaskOutcome = "";
      const blockedProductIds = new Set<string>();
      const fallbackEligibleProductIds = new Set<string>();
      const processedCandidateIds = new Set<string>();
      const sendingCandidateIds = new Set<string>();
      const allowPostSubmitFallback = policyBoolean(payload.adapter, "opportunityReport.allowPostSubmitFallback", false);
      try {
        if (!store) throw new Error("Selected store is missing login partition");
        if (taskCandidates.length !== task.candidateIds.length) throw new Error("Submit task candidate snapshot is incomplete");
        if (task.candidateIdsHash && task.candidateIdsHash !== stableHash([...taskCandidates.map((candidate) => candidate.id)].sort())) {
          throw new Error("Submit task candidate snapshot hash is incomplete");
        }
        if (coordinated && task.inFlightAttemptId) {
          const recovery = await recoverCoordinatedInFlightAttempt({
            payload,
            task,
            workerId,
            schedulerLease: schedulerLease!
          });
          coordinatedTaskState = recovery.task;
          const recoveredStatus = text(recovery.task.status);
          const recoveredAt = nowIso();
          await updatePipelineStoreRunProgress(task.storeRunId, {
            status: recoveredStatus === "ready" ? "running" : "partial",
            phase: "submitting",
            submittedCount: Number(recovery.task.submittedCount || 0),
            failedCount: Number(recovery.task.failedCount || 0),
            skippedCount: Number(recovery.task.skippedCount || 0),
            quotaExhaustedCount: Number(recovery.task.quotaExhaustedCount || 0),
            unknownCount: Number(recovery.task.unknownCount || 0),
            remoteRequestCount: Number(recovery.task.remoteRequestCount || 0),
            finishedAt: recoveredStatus === "ready" ? undefined : recoveredAt
          }).catch(() => null);
          await writePipelineEvent({
            runId: task.runId,
            storeRunId: task.storeRunId,
            shopId: task.shopId,
            level: recovery.action === "reservation_released" ? "info" : "warn",
            event: recovery.action === "reservation_released"
              ? "pipeline-submit-reservation-released-after-recovery"
              : "pipeline-submit-dispatched-marked-unknown-after-recovery",
            message: recovery.action === "reservation_released"
              ? "Unused submit reservation was released after worker recovery"
              : "Dispatched submit result was unresolved and requires manual reconciliation",
            detail: {
              taskId: task.id,
              attemptId: recovery.attemptId,
              taskStatus: recoveredStatus,
              workerId
            }
          }).catch(() => undefined);
          await reportDoudianDiagnostic({
            category: "opportunity-pipeline",
            event: "submit-worker-in-flight-recovered",
            runId: task.runId,
            storeRunId: task.storeRunId,
            shopId: task.shopId,
            taskId: task.id,
            attemptId: recovery.attemptId,
            recoveryAction: recovery.action,
            taskStatus: recoveredStatus,
            workerId
          }, true);
          await refreshPipelineRunSummary(task.runId).catch(() => null);
          processed += 1;
          processedThisPass += 1;
          continue;
        }
        const recoveredSending = taskCandidates.filter(isUnresolvedSubmitState);
        if (recoveredSending.length) {
          const recoveredAt = nowIso();
          const recoveredDedupe = await submittedDedupeIndex(recoveredSending);
          const recoveredAcceptedIds = new Set(recoveredSending
            .filter((candidate) => recoveredDedupe.relationKeys.has(relationKey(candidate)))
            .map((candidate) => candidate.id));
          const recoveredIds = new Map(recoveredSending.map((candidate) => [
            candidate.id,
            candidate.submitAttemptId || logicalSubmitAttemptId(task.runId, candidate)
          ]));
          taskCandidates = taskCandidates.map((candidate) => recoveredIds.has(candidate.id)
            ? recoveredAcceptedIds.has(candidate.id)
              ? {
                  ...candidate,
                  eligible: false,
                  estimatedCost: 0,
                  status: "submitted",
                  submitStatus: "accepted",
                  auditStatus: "pending",
                  submitAttemptId: recoveredIds.get(candidate.id),
                  skipReason: undefined,
                  submittedAt: candidate.submittedAt || recoveredAt,
                  updatedAt: recoveredAt
                }
              : recoverUnresolvedSubmitCandidate(candidate, {
                  runId: task.runId,
                  reason: "submit_result_unresolved_after_worker_recovery",
                  updatedAt: recoveredAt
                })
            : candidate);
          submittedCount += recoveredAcceptedIds.size;
          unknownCount += recoveredSending.length - recoveredAcceptedIds.size;
          await repositoryPutMany(pipelineCandidateStore, taskCandidates.filter((candidate) => recoveredIds.has(candidate.id)), { concurrency: 2 });
          const recoveredAcceptedAttempts = recoveredSending.filter((candidate) => recoveredAcceptedIds.has(candidate.id)).map((candidate) => logicalSubmitAttemptRecord({
            id: recoveredIds.get(candidate.id)!,
            runId: task.runId,
            candidate,
            status: "accepted",
            message: "submit acceptance recovered from persisted attempt evidence"
          }));
          const recoveredUnknownAttempts = recoveredSending.filter((candidate) => !recoveredAcceptedIds.has(candidate.id)).map((candidate) => logicalSubmitAttemptRecord({
            id: recoveredIds.get(candidate.id)!,
            runId: task.runId,
            candidate,
            status: "unknown",
            message: "submit result unresolved after worker recovery"
          }));
          await persistSubmitAttemptRecords(recoveredAcceptedAttempts, false);
          await persistSubmitAttemptRecords(recoveredUnknownAttempts);
        }
        const shouldCancelSubmit = () => cancelledPipelineRunIds.has(task.runId) || args.isCancelled?.() === true;
        await updatePipelineStoreRunProgress(task.storeRunId, {
          status: "running",
          phase: "submitting",
          finishedAt: undefined
        }).catch(() => null);
        if (!args.dryRun) await assertMutationStoreActive(store);
        const coverageAllowsWrite = officialWriteAllowed("local", pipelineTaskCoverageGate(task));
        if (!coverageAllowsWrite) {
          taskCandidates = taskCandidates.map((candidate) => ({
            ...candidate,
            eligible: false,
            estimatedCost: 0,
            status: "skipped" as const,
            submitStatus: "skipped" as const,
            skipReason: "input_coverage_not_complete"
          }));
          skippedCount += taskCandidates.length;
          await repositoryPutMany(pipelineCandidateStore, taskCandidates, { concurrency: 2 });
        }
        const limit = dailyAttemptLimit(args, payload.adapter);
        let used = await submitAttemptCountForShop(store.shopId);
        const dedupeIndex = await submittedDedupeIndex(taskCandidates);
        const leaseRenewalIntervalMs = submitLeaseRenewalMs(payload.adapter);
        let lastLeaseRenewalMs = Date.now();
        await updatePipelineStoreRunProgress(task.storeRunId, {
          status: "running",
          phase: "submitting",
          quotaAttemptCount: used,
          quotaRemainingAfterSubmit: Math.max(0, limit - used)
        }).catch(() => null);
        const updateStoreSubmitProgress = async () => {
          await updatePipelineStoreRunProgress(task.storeRunId, {
            status: "running",
            phase: "submitting",
            submittedCount,
            failedCount,
            safetySkippedCount,
            quotaExhaustedCount,
          cancelledCount,
          unknownCount,
          remoteRequestCount,
          quotaAttemptCount: used,
            quotaRemainingAfterSubmit: Math.max(0, limit - used)
          }).catch(() => null);
        };
        for (const [candidateIndex, candidate] of taskCandidates.entries()) {
          if (processedCandidateIds.has(candidate.id)) continue;
          if (await submitTaskIsCancelled(task, args)) {
            cancelledDuringTask = true;
            cancelledCount = Math.max(cancelledCount, taskCandidates.length - processedCandidateIds.size);
            break;
          }
          const isFallback = candidate.submitPriority === "fallback" || candidate.submitStatus === "fallback";
          const terminalStatus = text(candidate.submitStatus || candidate.status);
          const retryLogicalGroupId = coordinated && terminalStatus === "retry_waiting" ? text(candidate.logicalGroupId) : "";
          if (["accepted", "submitted", "failed", "skipped", "cancelled", "quota_exhausted", "unknown"].includes(terminalStatus)) {
            processedCandidateIds.add(candidate.id);
            continue;
          }
          if (!retryLogicalGroupId && isFallback && (!allowPostSubmitFallback || !fallbackEligibleProductIds.has(candidate.productId))) {
            processedCandidateIds.add(candidate.id);
            skippedCount += 1;
            updatedCandidates.push({
              ...candidate,
              eligible: false,
              estimatedCost: 0,
              status: "skipped",
              submitStatus: "skipped",
              skipReason: "主候选已成功或未发生明确失败，fallback 无需提报"
            });
            continue;
          }
          if (!retryLogicalGroupId && !isFallback && (!candidate.eligible || candidate.status !== "ready")) {
            processedCandidateIds.add(candidate.id);
            skippedCount += 1;
            updatedCandidates.push(candidate);
            continue;
          }
          if (quotaExhaustedReason) {
            processedCandidateIds.add(candidate.id);
            skippedCount += 1;
            quotaExhaustedCount += 1;
            updatedCandidates.push({
              ...candidate,
              eligible: false,
              estimatedCost: 0,
              status: "quota_exhausted",
              submitStatus: "quota_exhausted",
              skipReason: quotaExhaustedReason
            });
            executions.push({
              id: `${task.id}-${candidate.id}-quota-exhausted`,
              sourceRunId: task.runId,
              shopId: candidate.shopId,
              shopName: candidate.shopName,
              clueId: candidate.clueId,
              clueName: candidate.clueName,
              productId: candidate.productId,
              title: candidate.title,
              action: "submit",
              stage: "quota",
              status: "quota_exhausted",
              ok: true,
              message: quotaExhaustedReason,
              diagnostic: { quotaExhausted: true }
            });
            continue;
          }
          if (submitThrottleReason) {
            processedCandidateIds.add(candidate.id);
            skippedCount += 1;
            updatedCandidates.push({
              ...candidate,
              eligible: false,
              estimatedCost: 0,
              status: "skipped",
              submitStatus: "skipped",
              skipReason: submitThrottleReason
            });
            executions.push({
              id: `${task.id}-${candidate.id}-submit-throttle-skipped`,
              sourceRunId: task.runId,
              shopId: candidate.shopId,
              shopName: candidate.shopName,
              clueId: candidate.clueId,
              clueName: candidate.clueName,
              productId: candidate.productId,
              title: candidate.title,
              action: "submit",
              stage: "submit-throttle",
              status: "skipped",
              ok: true,
              message: submitThrottleReason
            });
            continue;
          }
          if (blockedProductIds.has(candidate.productId)) {
            processedCandidateIds.add(candidate.id);
            const limitReason = "商品已达到商机关联上限，本轮后续同商品不再提报";
            skippedCount += 1;
            updatedCandidates.push({
              ...candidate,
              eligible: false,
              estimatedCost: 0,
              status: "skipped",
              submitStatus: "skipped",
              skipReason: limitReason
            });
            executions.push({
              id: `${task.id}-${candidate.id}-product-limit-skipped`,
              sourceRunId: task.runId,
              shopId: candidate.shopId,
              shopName: candidate.shopName,
              clueId: candidate.clueId,
              clueName: candidate.clueName,
              productId: candidate.productId,
              title: candidate.title,
              action: "submit",
              stage: "product-limit",
              status: "skipped",
              ok: true,
              message: limitReason
            });
            continue;
          }
          const remaining = Math.max(0, limit - used);
          if (!coordinated && remaining <= 0) {
            processedCandidateIds.add(candidate.id);
            quotaExhaustedReason = "今日提报尝试额度不足，已停止本店后续提报";
            skippedCount += 1;
            quotaExhaustedCount += 1;
            updatedCandidates.push({
              ...candidate,
              eligible: false,
              estimatedCost: 0,
              status: "quota_exhausted",
              submitStatus: "quota_exhausted",
              skipReason: quotaExhaustedReason
            });
            executions.push({
              id: `${task.id}-${candidate.id}-quota-exhausted`,
              sourceRunId: task.runId,
              shopId: candidate.shopId,
              shopName: candidate.shopName,
              clueId: candidate.clueId,
              clueName: candidate.clueName,
              productId: candidate.productId,
              title: candidate.title,
              action: "submit",
              stage: "quota",
              status: "quota_exhausted",
              ok: true,
              message: quotaExhaustedReason,
              diagnostic: { quotaExhausted: true }
            });
            continue;
          }
          const submittedSkipReason = retryLogicalGroupId ? "" : shouldSkipSubmittedCandidate(args, dedupeIndex, candidate);
          if (submittedSkipReason) {
            processedCandidateIds.add(candidate.id);
            skippedCount += 1;
            updatedCandidates.push({
              ...candidate,
              eligible: false,
              estimatedCost: 0,
              status: "skipped",
              submitStatus: "skipped",
              skipReason: submittedSkipReason
            });
            executions.push({
              id: `${task.id}-${candidate.id}-skipped`,
              sourceRunId: task.runId,
              shopId: candidate.shopId,
              shopName: candidate.shopName,
              clueId: candidate.clueId,
              clueName: candidate.clueName,
              productId: candidate.productId,
              title: candidate.title,
              action: "submit",
              stage: "dedupe",
              status: "skipped",
              ok: true,
              message: `${submittedSkipReason}，已跳过`
            });
            continue;
          }
          const batchLimit = coordinated ? submitWorkerBatchSize(payload.adapter) : Math.min(submitWorkerBatchSize(payload.adapter), remaining);
          const batchCandidates = retryLogicalGroupId
            ? taskCandidates.filter((item) => text(item.logicalGroupId) === retryLogicalGroupId)
            : [candidate];
          const candidateAttemptIds = new Map<string, string>();
          for (let nextIndex = candidateIndex + 1; !retryLogicalGroupId && nextIndex < taskCandidates.length && batchCandidates.length < batchLimit; nextIndex += 1) {
            const nextCandidate = taskCandidates[nextIndex];
            if (!nextCandidate || processedCandidateIds.has(nextCandidate.id)) continue;
            if (!sameSubmitBatchCandidate(candidate, nextCandidate)) continue;
            if (!nextCandidate.eligible || nextCandidate.status !== "ready") continue;
            if (blockedProductIds.has(nextCandidate.productId)) continue;
            if (shouldSkipSubmittedCandidate(args, dedupeIndex, nextCandidate)) continue;
            batchCandidates.push(nextCandidate);
          }
          let coordinatedRemoteResult: CoordinatedRemoteSubmitResult | undefined;
          const nextExecutions = await submitProductsForClue({
            payload,
            store,
            clue: candidateToClue(candidate),
            products: batchCandidates.map(candidateToProduct),
            runId: task.runId,
            sourceRunId: task.runId,
            submitMode: submitMode(args),
            titleMatchMode: titleMatchMode(args),
            titleUpdatePosition: titleUpdatePosition(args),
            module: candidate.submitModule || "search_page_query",
            dryRun: args.dryRun,
            validatedByPipeline: true,
            pipelineWords: candidate.clueWords,
            shouldCancel: shouldCancelSubmit,
            beginMutation: args.beginMutation,
            endMutation: args.endMutation,
            onRemoteSubmitStart: coordinated ? undefined : async (remoteProducts) => {
              assertNotCancelled(shouldCancelSubmit);
              const remoteProductIds = new Set(remoteProducts.map((product) => product.productId));
              const sendingCandidates = batchCandidates.filter((batchCandidate) => remoteProductIds.has(batchCandidate.productId));
              const sendingAt = nowIso();
              sendingCandidates.forEach((batchCandidate) => {
                sendingCandidateIds.add(batchCandidate.id);
                candidateAttemptIds.set(batchCandidate.id, logicalSubmitAttemptId(task.runId, batchCandidate));
              });
              await persistSubmitAttemptRecords(sendingCandidates.map((batchCandidate) => logicalSubmitAttemptRecord({
                id: candidateAttemptIds.get(batchCandidate.id)!,
                runId: task.runId,
                candidate: batchCandidate,
                status: "sending",
                message: "submit request is in flight"
              })));
              await repositoryPutMany(pipelineCandidateStore, sendingCandidates.map((batchCandidate) => ({
                ...batchCandidate,
                status: "submitting",
                submitStatus: "sending",
                submitAttemptId: candidateAttemptIds.get(batchCandidate.id),
                submittedAt: undefined,
                updatedAt: sendingAt
              })), { concurrency: 2 });
              assertNotCancelled(shouldCancelSubmit);
            },
            submitRemote: coordinated ? async (body, remoteProducts) => {
              coordinatedRemoteResult = await coordinatedSubmitAttempt({
                payload,
                opportunityArgs: args,
                store,
                task,
                workerId,
                workerSlot,
                taskConcurrency,
                schedulerLease: schedulerLease!,
                candidates: batchCandidates,
                products: remoteProducts,
                body,
                shouldCancel: shouldCancelSubmit,
                beginMutation: args.beginMutation,
                endMutation: args.endMutation
              });
              coordinatedTaskState = coordinatedRemoteResult.settledTask || null;
              coordinatedTaskReason = text(coordinatedRemoteResult.coordination?.coordinatorReason);
              coordinatedTaskOutcome = text(coordinatedRemoteResult.classification?.outcome);
              return coordinatedRemoteResult;
            } : undefined
          });
          coordinatedTaskState = coordinatedRemoteResult?.settledTask || coordinatedTaskState;
          if (coordinatedRemoteResult?.deferred) break;
          const batchRemoteRequestCount = coordinatedRemoteResult?.attemptCount ?? nextExecutions.reduce((maximum, item) => {
            const itemDiagnostic = objectRecord(item.diagnostic);
            return Math.max(maximum, Math.max(0, Math.floor(Number(itemDiagnostic.submitAttemptCount || 0))));
          }, 0);
          remoteRequestCount += batchRemoteRequestCount;
          let batchAttempts = 0;
          const resolvedBatchCandidates: DoudianOpportunityPrematchCandidate[] = [];
          const coordinatedCandidateIds = new Set(arrayText(coordinatedRemoteResult?.coordination?.coordinatorCandidateIds));
          const coordinatedCandidateResults = new Map((coordinatedRemoteResult?.classification?.candidateResults || []).map((result) => [result.candidateId, result]));
          for (const batchCandidate of batchCandidates) {
            processedCandidateIds.add(batchCandidate.id);
            const candidateExecutions = executionsForCandidate(nextExecutions, batchCandidate);
            const coordinatedCandidate = coordinatedCandidateIds.has(batchCandidate.id);
            const attempts = args.dryRun
              ? 0
              : coordinatedCandidate
                ? 1
                : await recordSubmitAttempts({ runId: task.runId, matchRunId: task.runId, candidate: batchCandidate, executions: candidateExecutions });
            batchAttempts += attempts;
            used += attempts;
            const decoratedExecutions = candidateExecutions.map((item) => ({
              ...item,
              diagnostic: {
                ...(item.diagnostic || {}),
                pipelineCandidateId: batchCandidate.id,
                tokenHitRatio: batchCandidate.tokenHitRatio,
                matchedTokens: batchCandidate.matchedTokens,
                dailyAttemptUsed: used,
                dailyAttemptLimit: limit,
                submitBatchSize: batchCandidates.length
              }
            }));
            executions.push(...decoratedExecutions);
            const executionState = candidateExecutionState(candidateExecutions);
            const coordinatedCandidateResult = coordinatedCandidateResults.get(batchCandidate.id);
            const coordinatedStatus = coordinatedCandidateResult?.status || (coordinatedCandidate
              ? coordinatedRemoteResult?.classification?.outcome === "accepted"
                ? "accepted"
                : coordinatedRemoteResult?.classification?.outcome === "failed"
                  ? "failed"
                  : coordinatedRemoteResult?.classification?.outcome === "unknown"
                    ? "unknown"
                    : coordinatedRemoteResult?.classification?.outcome === "throttled"
                      ? "retry_waiting"
                      : ""
              : "");
            const submitted = coordinatedCandidate ? coordinatedStatus === "accepted" : executionState.submitted;
            const failed = coordinatedCandidate ? coordinatedStatus === "failed" : executionState.failed;
            const unknown = coordinatedCandidate ? coordinatedStatus === "unknown" : executionState.unknown;
            const retryWaiting = coordinatedCandidate && coordinatedStatus === "retry_waiting";
            const safetySkipped = coordinatedCandidate ? false : executionState.safetySkipped;
            const failureMessage = coordinatedCandidateResult?.message || executionState.failureMessage;
            const alreadySubmitted = coordinatedCandidate ? coordinatedStatus === "skipped" : Boolean(failed && failureMessage && isAlreadySubmittedOpportunityMessage(failureMessage));
            const dailyQuotaExhausted = Boolean(failureMessage && isStoreDailyQuotaMessage(failureMessage));
            if (dailyQuotaExhausted && !quotaExhaustedReason) {
              quotaExhaustedReason = normalizedSubmitMessage(failureMessage) || "已达店铺今日商机提报上限";
              await writePipelineEvent({
                runId: task.runId,
                storeRunId: task.storeRunId,
                shopId: task.shopId,
                level: "warn",
                event: "pipeline-submit-quota-exhausted",
                message: quotaExhaustedReason,
                detail: { dailyAttemptUsed: used, dailyAttemptLimit: limit, candidateId: batchCandidate.id }
              }).catch(() => undefined);
            }
            if (!dailyQuotaExhausted && failureMessage && isProductClueLimitMessage(failureMessage)) {
              blockedProductIds.add(batchCandidate.productId);
              const saturatedProductIds = new Set([batchCandidate.productId, ...productIdsFromSubmitMessage(failureMessage)]);
              for (const productId of saturatedProductIds) {
                blockedProductIds.add(productId);
                await markBenefitIndexSaturated(
                  { tenantId: task.tenantId, shopId: task.shopId, shopName: task.shopName, storeGeneration: task.storeGeneration },
                  productId,
                  productId === batchCandidate.productId ? batchCandidate.clueId : undefined
                );
              }
            }
            if (submitted || alreadySubmitted) {
              await updateBenefitIndexAfterAssociation(
                { tenantId: task.tenantId, shopId: task.shopId, shopName: task.shopName, storeGeneration: task.storeGeneration },
                batchCandidate.productId,
                batchCandidate.clueId
              );
              dedupeIndex.relationKeys.add(relationKey(batchCandidate));
            }
            const rateLimitedExecutions = candidateExecutions.filter(isFinalRateLimitedExecution);
            const finalRateLimited = rateLimitedExecutions.length > 0;
            const remoteHttpStatuses = uniqueText(candidateExecutions.map((item) => text(objectRecord(item.diagnostic).remoteHttpStatus)));
            const submitAttemptCount = candidateExecutions.reduce((maximum, item) => (
              Math.max(maximum, Math.max(0, Math.floor(Number(objectRecord(item.diagnostic).submitAttemptCount || 0))))
            ), 0);
            if (!coordinated && !submitThrottleReason && stopStoreOnSubmitFrequency(payload.adapter) && ((failureMessage && submitFrequencyLimitedMessage(failureMessage)) || finalRateLimited)) {
              submitThrottleReason = finalRateLimited ? "HTTP 429 重试后仍被限流，已停止本店后续提报" : failureMessage || "商机中心提交触发频控，已停止本店后续提报";
              await writePipelineEvent({
                runId: task.runId,
                storeRunId: task.storeRunId,
                shopId: task.shopId,
                level: "warn",
                event: "pipeline-submit-throttled",
                message: submitThrottleReason,
                detail: {
                  candidateId: batchCandidate.id,
                  productId: batchCandidate.productId,
                  clueId: batchCandidate.clueId,
                  dailyAttemptUsed: used,
                  dailyAttemptLimit: limit,
                  submitBatchSize: batchCandidates.length,
                  remoteHttpStatuses,
                  submitAttemptCount,
                  retryLimit: policyNumber(payload.adapter, "opportunityReport.submitRetryLimit", 3, 1, 3),
                  retryDelayMs: policyNumber(payload.adapter, "opportunityReport.submitRetryDelayMs", 10000, 0, 30000),
                  requestPlanMaxAttempts: 1,
                  workerId,
                  workerSlot,
                  taskConcurrency,
                  activeStoreTaskCount: slotCount,
                  queuedStoreTaskCount: selectedTasks.length,
                  otherActiveStoreSlots: Math.max(0, slotCount - 1),
                  rateLimitScope: "store-only-test",
                  stoppedStoreOnly: true,
                  globalCooldownAfterFinalRateLimit: false,
                  otherStoreTasksContinue: slotCount > 1
                }
              }).catch(() => undefined);
              await reportDoudianDiagnostic({
                category: "opportunity-pipeline",
                event: "store-rate-limit-isolated",
                runId: task.runId,
                storeRunId: task.storeRunId,
                shopId: task.shopId,
                shopName: task.shopName,
                candidateId: batchCandidate.id,
                productId: batchCandidate.productId,
                clueId: batchCandidate.clueId,
                remoteHttpStatuses,
                submitAttemptCount,
                workerId,
                workerSlot,
                taskConcurrency,
                activeStoreTaskCount: slotCount,
                queuedStoreTaskCount: selectedTasks.length,
                rateLimitScope: "store-only-test",
                stoppedStoreOnly: true,
                otherStoreTasksContinue: slotCount > 1
              }, true);
            }
            if (submitted) submittedCount += 1;
            if (failed && !alreadySubmitted) failedCount += 1;
            if (safetySkipped) safetySkippedCount += 1;
            if (unknown) unknownCount += 1;
            if (!retryWaiting && (alreadySubmitted || (!submitted && !failed && !unknown))) skippedCount += 1;
            if (isFallback && submitted) fallbackEligibleProductIds.delete(batchCandidate.productId);
            if (allowPostSubmitFallback && !isFallback && failed && !alreadySubmitted && !unknown && !dailyQuotaExhausted && !submitThrottleReason) fallbackEligibleProductIds.add(batchCandidate.productId);
            const logicalAttemptId = coordinatedCandidate
              ? text(coordinatedRemoteResult?.coordination?.requestAttemptId)
              : candidateAttemptIds.get(batchCandidate.id) || batchCandidate.submitAttemptId;
            if (!coordinatedCandidate && logicalAttemptId) {
              await persistSubmitAttemptRecords([logicalSubmitAttemptRecord({
                id: logicalAttemptId,
                runId: task.runId,
                candidate: batchCandidate,
                status: submitted ? "accepted" : alreadySubmitted ? "already_submitted" : unknown ? "unknown" : failed ? "failed" : "unknown",
                message: submitted ? "submit request accepted" : alreadySubmitted ? "platform reports product already submitted for this clue" : failureMessage || "submit result unresolved"
              })], attempts <= 0);
            }
            if (!coordinatedCandidate) resolvedBatchCandidates.push({
              ...batchCandidate,
              eligible: false,
              estimatedCost: 0,
              status: submitted ? "submitted" : alreadySubmitted ? "skipped" : unknown ? "unknown" : failed ? "failed" : "skipped",
              submitStatus: submitted ? "accepted" : alreadySubmitted ? "skipped" : unknown ? "unknown" : failed ? "failed" : "skipped",
              auditStatus: submitted ? "pending" : batchCandidate.auditStatus,
              submitAttemptId: logicalAttemptId,
              skipReason: submitted ? undefined : alreadySubmitted ? "报名记录索引已回写：商品此前已提交该商机" : failed ? failureMessage : batchCandidate.skipReason,
              submittedAt: submitted ? nowIso() : undefined
            });
          }
          if (resolvedBatchCandidates.length) {
            await repositoryPutMany(pipelineCandidateStore, resolvedBatchCandidates, { concurrency: 2 });
            resolvedBatchCandidates.forEach((batchCandidate) => sendingCandidateIds.delete(batchCandidate.id));
          }
          if (batchAttempts > 0 || batchCandidates.length > 1) await updateStoreSubmitProgress();
          dispatchPipelineProgress(
            args,
            submitWorkerProgress(processedCandidateIds.size, taskCandidates.length),
            `商机提报处理中 ${processedCandidateIds.size}/${taskCandidates.length}`
          );
          if (!coordinated && !args.dryRun && batchAttempts > 0 && !submitThrottleReason && hasRemainingLegacySubmitWork(taskCandidates, processedCandidateIds)) {
            const delayMs = submitCandidateDelayMs(payload.adapter);
            if (delayMs) await cancellableWait(delayMs, shouldCancelSubmit);
          }
          if (!coordinated && Date.now() - lastLeaseRenewalMs >= leaseRenewalIntervalMs) {
            lastLeaseRenewalMs = Date.now();
            const renewedAt = nowIso();
            await updateSubmitTaskFromWorker(task, workerId, {
              status: "running",
              submittedCount,
              skippedCount,
              failedCount,
              safetySkippedCount,
              quotaExhaustedCount,
              cancelledCount,
              unknownCount,
              remoteRequestCount,
              leaseExpiresAt: submitLeaseExpiresAt(payload.adapter),
              updatedAt: renewedAt
            });
          }
          if (coordinatedTaskState) break;
        }
        if (updatedCandidates.length) await repositoryPutMany(pipelineCandidateStore, updatedCandidates, { concurrency: 2 });
        if (coordinatedTaskState) {
          submittedCount = Number(coordinatedTaskState.submittedCount || submittedCount);
          skippedCount = Number(coordinatedTaskState.skippedCount || skippedCount);
          failedCount = Number(coordinatedTaskState.failedCount || failedCount);
          quotaExhaustedCount = Number(coordinatedTaskState.quotaExhaustedCount || quotaExhaustedCount);
          unknownCount = Number(coordinatedTaskState.unknownCount || unknownCount);
          remoteRequestCount = Number(coordinatedTaskState.remoteRequestCount || remoteRequestCount);
          const coordinatedStatus = coordinatedTaskState.status;
          const continuesImmediately = coordinatedStatus === "ready" || coordinatedStatus === "queued" || coordinatedStatus === "running";
          const deferred = coordinatedStatus === "cooling_down" || coordinatedStatus === "deferred" || coordinatedStatus === "deferred_contract_mismatch" || coordinatedStatus === "manual_reconcile";
          const throttleCooling = coordinatedStatus === "cooling_down" && coordinatedTaskOutcome === "throttled";
          const storeStatus: PipelineStoreRunRecord["status"] = continuesImmediately
            ? "running"
            : deferred
              ? "partial"
              : coordinatedStatus === "ok"
                ? "ok"
                : coordinatedStatus === "cancelled"
                  ? "cancelled"
                  : coordinatedStatus === "failed"
                    ? "failed"
                    : "partial";
          const settledAt = nowIso();
          const finalQuotaAttemptCount = await submitAttemptCountForShop(store.shopId);
          await updatePipelineStoreRunProgress(task.storeRunId, {
            status: storeStatus,
            phase: continuesImmediately ? "submitting" : "finished",
            submittedCount,
            failedCount,
            skippedCount,
            safetySkippedCount,
            quotaExhaustedCount,
            cancelledCount,
            unknownCount,
            remoteRequestCount,
            skipReason: deferred ? coordinatedTaskState.deferredReason || coordinatedStatus : undefined,
            quotaAttemptCount: finalQuotaAttemptCount,
            quotaRemainingAfterSubmit: Math.max(0, limit - finalQuotaAttemptCount),
            finishedAt: continuesImmediately ? undefined : settledAt
          }).catch(() => null);
          await writePipelineEvent({
            runId: task.runId,
            storeRunId: task.storeRunId,
            shopId: task.shopId,
            level: throttleCooling || (deferred && coordinatedStatus !== "cooling_down") || failedCount || unknownCount ? "warn" : "info",
            event: throttleCooling
              ? "submit-task-cooling-down"
              : coordinatedStatus === "cooling_down"
                ? "submit-checkpoint-persisted"
              : deferred
                ? "submit-task-deferred"
                : continuesImmediately
                  ? "submit-checkpoint-persisted"
                  : "pipeline-submit-task-finished",
            message: throttleCooling
              ? "Submit task entered cooldown after a throttle response"
              : coordinatedStatus === "cooling_down"
                ? "Submit task checkpoint persisted while waiting for the next pacing window"
              : deferred
                ? "商机提报任务需要后续恢复或人工处理"
                : continuesImmediately
                  ? "商机提报批次已结算，任务等待下一次领取"
                  : "商机提报任务完成",
            detail: {
              taskId: task.id,
              taskStatus: coordinatedStatus,
              coordinatorReason: coordinatedTaskReason,
              coordinatorOutcome: coordinatedTaskOutcome,
              resumeAt: coordinatedTaskState.resumeAt,
              retryableRemainingCount: coordinatedTaskState.retryableRemainingCount,
              submittedCount,
              failedCount,
              skippedCount,
              quotaExhaustedCount,
              unknownCount,
              remoteRequestCount
            }
          }).catch(() => undefined);
          await refreshPipelineRunSummary(task.runId).catch(() => null);
        } else {
        cancelledDuringTask = cancelledDuringTask || await submitTaskIsCancelled(task, args);
        const coverageBlocksCompletion = !officialWriteAllowed("local", pipelineTaskCoverageGate(task));
        const finalStatus: PipelineSubmitTaskRecord["status"] = cancelledDuringTask
          ? "cancelled"
          : task.inputCoverageStatus === "failed"
            ? "failed"
          : unknownCount || coverageBlocksCompletion
            ? "partial"
          : failedCount
            ? (submittedCount || skippedCount ? "partial" : "failed")
            : "ok";
        const finishedAt = nowIso();
        await updateSubmitTaskFromWorker(task, workerId, {
          status: finalStatus,
          submittedCount,
          skippedCount,
          failedCount,
          safetySkippedCount,
          quotaExhaustedCount,
          cancelledCount,
          unknownCount,
          remoteRequestCount,
          retryableRemainingCount: 0,
          leaseExpiresAt: undefined,
          lastError: finalStatus === "ok" ? undefined : quotaExhaustedReason || submitThrottleReason || task.lastError,
          finishedAt,
          updatedAt: finishedAt
        });
        dispatchPipelineProgress(args, 94, `店铺 ${task.shopName || task.shopId} 商机提报队列处理完成`);
        const finalQuotaAttemptCount = await submitAttemptCountForShop(store.shopId);
        await updatePipelineStoreRunProgress(task.storeRunId, {
          status: finalStatus,
          phase: "finished",
          submittedCount,
          failedCount,
          safetySkippedCount,
          quotaExhaustedCount,
          cancelledCount,
          unknownCount,
          remoteRequestCount,
          skipReason: quotaExhaustedReason || submitThrottleReason || undefined,
          quotaAttemptCount: finalQuotaAttemptCount,
          quotaRemainingAfterSubmit: Math.max(0, limit - finalQuotaAttemptCount),
          finishedAt
        }).catch(() => null);
        await writePipelineEvent({
          runId: task.runId,
          storeRunId: task.storeRunId,
          shopId: task.shopId,
          level: failedCount || cancelledDuringTask ? "warn" : "info",
          event: cancelledDuringTask ? "pipeline-submit-task-cancelled" : "pipeline-submit-task-finished",
          message: cancelledDuringTask ? "商机提报任务已取消" : failedCount ? "商机提报部分失败" : "商机提报任务完成",
          detail: {
            accepted: submittedCount,
            submittedCount,
            skippedCount,
            failedCount,
            safetySkipped: safetySkippedCount,
            safetySkippedCount,
            quotaExhausted: quotaExhaustedCount,
            quotaExhaustedCount,
            cancelled: cancelledCount,
            cancelledCount,
            unknownCount,
            remoteRequestCount,
            executionCount: executions.length,
            quotaAttemptCount: finalQuotaAttemptCount,
            dailyAttemptLimit: limit,
            submitThrottleReason,
            quotaExhaustedReason,
            blockedProductCount: blockedProductIds.size
          }
        }).catch(() => undefined);
        await reportDoudianDiagnostic({
          category: "opportunity-pipeline",
          event: "store-submit-summary",
          runId: task.runId,
          storeRunId: task.storeRunId,
          shopId: task.shopId,
          status: finalStatus,
          accepted: submittedCount,
          failed: failedCount,
          safetySkipped: safetySkippedCount,
          quotaExhausted: quotaExhaustedCount,
          cancelled: cancelledCount,
          unknown: unknownCount,
          remoteRequestCount,
          quotaAttemptCount: finalQuotaAttemptCount,
          dailyAttemptLimit: limit
        }, true);
        await refreshPipelineRunSummary(task.runId).catch(() => null);
        }
      } catch (error) {
        const cancelled = await submitTaskIsCancelled(task, args);
        if (sendingCandidateIds.size) {
          const unresolvedSending = await repositoryGetMany<DoudianOpportunityPrematchCandidate>(pipelineCandidateStore, Array.from(sendingCandidateIds)).catch(() => []);
          const cancelledAt = nowIso();
          const unresolvedCandidates = unresolvedSending
            .filter(isUnresolvedSubmitState)
            .map((candidate) => recoverUnresolvedSubmitCandidate(candidate, {
              runId: task.runId,
              reason: cancelled ? "submit_result_unresolved_during_cancellation" : "submit_result_unresolved_after_worker_error",
              updatedAt: cancelledAt
            }));
          await repositoryPutMany(pipelineCandidateStore, unresolvedCandidates, { concurrency: 2 }).catch(() => []);
          await persistSubmitAttemptRecords(unresolvedCandidates
            .filter((candidate) => candidate.submitAttemptId)
            .map((candidate) => logicalSubmitAttemptRecord({
              id: candidate.submitAttemptId!,
              runId: task.runId,
              candidate,
              status: "unknown",
              message: cancelled ? "submit result unresolved during cancellation" : "submit result unresolved after worker error"
            }))).catch(() => undefined);
          unknownCount += unresolvedCandidates.length;
        }
        if (!cancelled) failedCount = Math.max(1, failedCount);
        const failedAt = nowIso();
        await updateSubmitTaskFromWorker(task, workerId, {
          status: cancelled ? "cancelled" : "failed",
          submittedCount,
          skippedCount,
          failedCount,
          safetySkippedCount,
          quotaExhaustedCount,
          cancelledCount,
          unknownCount,
          remoteRequestCount,
          leaseExpiresAt: undefined,
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: failedAt,
          updatedAt: failedAt
        });
        await writePipelineEvent({
          runId: task.runId,
          storeRunId: task.storeRunId,
          shopId: task.shopId,
          level: cancelled ? "warn" : "error",
          event: cancelled ? "pipeline-submit-task-cancelled" : "pipeline-submit-task-failed",
          message: error instanceof Error ? error.message : String(error),
          detail: { accepted: submittedCount, submittedCount, skippedCount, failedCount, safetySkipped: safetySkippedCount, quotaExhausted: quotaExhaustedCount, cancelled: cancelledCount, unknownCount, remoteRequestCount }
        }).catch(() => undefined);
        await reportDoudianDiagnostic({
          category: "opportunity-pipeline",
          event: "store-submit-summary",
          runId: task.runId,
          storeRunId: task.storeRunId,
          shopId: task.shopId,
          status: cancelled ? "cancelled" : "failed",
          accepted: submittedCount,
          failed: failedCount,
          safetySkipped: safetySkippedCount,
          quotaExhausted: quotaExhaustedCount,
          cancelled: cancelledCount,
          unknown: unknownCount,
          remoteRequestCount,
          error: error instanceof Error ? error.message : String(error)
        }, true);
        await refreshPipelineRunSummary(task.runId).catch(() => null);
      }
      processed += 1;
      processedThisPass += 1;
      }
      };
      await Promise.all(Array.from({ length: slotCount }, (_, slotIndex) => runWorkerSlot(slotIndex + 1)));
      if (!processedThisPass) break;
    }
    void reportDoudianDiagnostic({
      category: "opportunity-pipeline",
      event: "submit-worker-finished",
      runId: scopedRunId,
      workerId,
      processed,
      taskConcurrency
    }, true);
    return { ok: true, processed, schedulerBusy };
    } finally {
      await Promise.all(Array.from(schedulerLeases.values()).map(async (pending) => releaseSubmitSchedulerLease(await pending)));
    }
}

function runSubmitWorker(payload: DoudianAdapterPayload, args: OpportunityArgs = {}) {
  const scheduled = pipelineSubmitWorkerTail
    .catch(() => undefined)
    .then(() => executeSubmitWorker(payload, args));
  pipelineSubmitWorkerTail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

async function failUnconsumedSubmitTasks(tasks: PipelineSubmitTaskRecord[], reason: string) {
  const failedAt = nowIso();
  await repositoryPutMany(pipelineSubmitTaskStore, tasks.map((task) => ({
    ...task,
    status: "failed" as const,
    leaseExpiresAt: undefined,
    failedCount: Math.max(1, Number(task.failedCount || 0)),
    lastError: reason,
    finishedAt: task.finishedAt || failedAt,
    updatedAt: failedAt
  })), { concurrency: 2 });
  await Promise.all(tasks.map(async (task) => {
    await updatePipelineStoreRunProgress(task.storeRunId, {
      status: "failed",
      phase: "finished",
      failedCount: Math.max(1, Number(task.failedCount || 0)),
      skipReason: reason,
      finishedAt: failedAt
    }).catch(() => null);
    await writePipelineEvent({
      runId: task.runId,
      storeRunId: task.storeRunId,
      shopId: task.shopId,
      level: "error",
      event: "pipeline-submit-worker-stalled",
      message: reason,
      detail: { taskId: task.id, taskStatus: task.status }
    }).catch(() => undefined);
  }));
}

async function fetchPipelineSubmit(payload: DoudianAdapterPayload, args: OpportunityArgs): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds);
  const runId = args.operationId || `opportunity-pipeline-submit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  cancelledPipelineRunIds.delete(runId);
  const matchRules = normalizeOpportunityMatchRules(args.matchRules);
  const filters = args.filters || {};
  try {
    assertOpportunityPipelineContract(payload.adapter);
  } catch (error) {
    return {
      ...ledger,
      ok: false,
      status: "adapter-contract-error",
      mode: "pipeline-submit",
      message: error instanceof Error ? error.message : String(error),
      rows: [],
      clues: [],
      products: [],
      prematches: [],
      executions: [],
      filters,
      matchRules
    };
  }
  if (!targets.length) {
    return {
      ...ledger,
      ok: false,
      status: "no-store",
      mode: "pipeline-submit",
      message: "No Doudian stores selected",
      rows: [],
      clues: [],
      products: [],
      prematches: [],
      executions: [],
      filters,
      matchRules
    };
  }

  const clientCapability = await detectPipelineClientCapability(runId);
  const allowTokenizerFallback = Boolean(args.dryRun);
  if (!clientCapability.nativeTextSegmentAvailable || (!clientCapability.nativeTextSegment && !allowTokenizerFallback) || !clientCapability.v2StoreSmokeOk) {
    return {
      ...ledger,
      ok: false,
      status: "client-capability-missing",
      mode: "pipeline-submit",
      message: "当前客户端缺少商机提报所需 native 分词能力或 v2 本地记录能力，请升级客户端",
      rows: [],
      clues: [],
      products: [],
      prematches: [],
      executions: [],
      details: [{
        status: "failed",
        ok: false,
        message: "pipeline native capability check failed",
        reason: "client-capability-missing",
        diagnostic: clientCapability
      }],
      filters,
      matchRules
    };
  }

  await cleanupOpportunityData(payload.adapter).catch(() => undefined);

  const now = nowIso();
  const coordinatorPolicy = submitCoordinatorPolicy(payload.adapter);
  const pipelineRuntimePolicySummary = {
    submitTaskConcurrency: submitTaskConcurrency(payload.adapter),
    dailyCandidateMutationLimit: dailyAttemptLimit(args, payload.adapter),
    dailyHttpRequestLimit: policyNumber(payload.adapter, "opportunityReport.submitDailyHttpRequestLimit", 1000, 1, 1000000),
    submitPacingInitialIntervalMs: coordinatorPolicy.submitPacingInitialIntervalMs,
    submitGlobalPacingInitialMs: coordinatorPolicy.submitGlobalPacingInitialMs,
    submitGlobal429WindowMs: coordinatorPolicy.submitGlobal429WindowMs,
    submitGlobal429DistinctStores: coordinatorPolicy.submitGlobal429DistinctStores
  };
  const details: DoudianRunDetail[] = [];
  const sourceHealth: Array<Record<string, unknown>> = [];
  const products: DoudianOpportunityProductRow[] = [];
  let processedStoreCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let submitTaskCount = 0;
  let currentCategoryCount = 0;
  let effectiveCategoryCount = 0;
  let clueCount = 0;
  let tokenCount = 0;
  let candidateCount = 0;
  let qualifiedCandidateCount = 0;
  let eligibleCandidateCount = 0;
  let plannedSubmitCandidateCount = 0;
  let primarySubmitCandidateCount = 0;
  let fallbackSubmitCandidateCount = 0;
  let estimatedSubmitGroupCount = 0;
  let estimatedSubmitDurationMs = 0;
  let coverageBlockedCount = 0;
  let benefitProductCount = 0;
  let benefitAcquiredExposure = 0;
  let benefitEstimatedExposure = 0;
  let benefitAcquiredExposureParsedCount = 0;
  let benefitAcquiredExposureUnparsedCount = 0;
  let benefitEstimatedExposureParsedCount = 0;
  let benefitEstimatedExposureUnparsedCount = 0;
  let benefitSubmitRecordCount = 0;
  let benefitAssociatedClueCount = 0;
  let benefitSaturatedProductCount = 0;
  const pipelineClues: DoudianOpportunityClueRow[] = [];
  const matchRulesHash = stableMatchRulesHash(args);
  await repositoryPut(pipelineRunStore, {
    id: runId,
    runId,
    operationId: args.operationId,
    mode: "pipeline-submit",
    filters,
    matchRules,
    pipelineOptions: pipelineOptions(args),
    shopIds: targets.map((store) => store.shopId),
    storeRefs: targets.map(normalizePipelineStoreIdentity),
    tenantId: normalizePipelineStoreIdentity(targets[0]).tenantId,
    clientCapability,
    status: "running",
    totalStoreCount: targets.length,
    processedStoreCount: 0,
    submittedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    summary: pipelineRuntimePolicySummary,
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    requestPlanHash: requestPlanHash(payload.adapter),
    createdAt: now,
    updatedAt: now
  } satisfies PipelineRunRecord);
  dispatchPipelineProgress(args, 3, "商机提报任务已初始化");

  if (clientCapability.tokenizerFallback) {
    await writePipelineEvent({
      runId,
      level: "warn",
      event: "pipeline-tokenizer-fallback",
      message: "native tokenizer fallback used in dry-run",
      detail: {
        tokenizerFallback: true,
        tokenizerVersion: clientCapability.tokenizerVersion,
        fallbackReason: clientCapability.fallbackReason
      }
    }).catch(() => undefined);
  }

  const finishCancelled = async (): Promise<DoudianOpportunityReportResult> => {
    const cancelledAt = nowIso();
    await cancelPipelinePendingWorkForRun(runId);
    const summary = {
      ...pipelineRuntimePolicySummary,
      productCount: products.length,
      currentCategoryCount,
      effectiveCategoryCount,
      clueCount,
      tokenCount,
      candidateCount,
      qualifiedCandidateCount,
      eligibleCandidateCount,
      plannedSubmitCandidateCount,
      benefitProductCount,
      benefitAcquiredExposure,
      benefitEstimatedExposure,
      benefitAcquiredExposureParsedCount,
      benefitAcquiredExposureUnparsedCount,
      benefitEstimatedExposureParsedCount,
      benefitEstimatedExposureUnparsedCount,
      benefitSubmitRecordCount,
      benefitAssociatedClueCount,
      benefitSaturatedProductCount,
      primarySubmitCandidateCount,
      fallbackSubmitCandidateCount,
      estimatedSubmitGroupCount,
      estimatedSubmitDurationMs,
      submitTaskCount,
      submittedCount: 0,
      failedCount,
      skippedCount,
      processedStoreCount,
      totalStoreCount: targets.length
    };
    await repositoryPut(pipelineRunStore, {
      id: runId,
      runId,
      operationId: args.operationId,
      mode: "pipeline-submit",
      filters,
      matchRules,
      pipelineOptions: pipelineOptions(args),
      shopIds: targets.map((item) => item.shopId),
      storeRefs: targets.map(normalizePipelineStoreIdentity),
      tenantId: normalizePipelineStoreIdentity(targets[0]).tenantId,
      clientCapability,
      status: "cancelled",
      totalStoreCount: targets.length,
      processedStoreCount,
      submittedCount: 0,
      skippedCount,
      failedCount,
      summary,
      adapterVersion: payload.adapter.version || "",
      scriptsVersion: payload.scripts?.version || "",
      requestPlanHash: requestPlanHash(payload.adapter),
      createdAt: now,
      updatedAt: cancelledAt
    } satisfies PipelineRunRecord);
    return {
      ...ledger,
      ok: false,
      status: "cancelled",
      mode: "pipeline-submit",
      message: "已取消商机提报任务",
      runId,
      operationId: args.operationId,
      rows: pipelineClues,
      clues: pipelineClues,
      products,
      prematches: [],
      executions: [],
      details,
      successCount: details.filter((detail) => detail.ok).length,
      failureCount: failedCount,
      partialCount: 0,
      summary,
      scanSummary: summary,
      sourceHealth,
      filters,
      matchRules,
      requestPlanHash: requestPlanHash(payload.adapter)
    };
  };

  const storePrepareConcurrency = 2;
  const persistedDedupeIndex = await submittedDedupeIndex([], targets.map((store) => store.shopId));
  const preparedStores = await mapConcurrentOrdered(targets, storePrepareConcurrency, async (store, index) => {
    const identity = normalizePipelineStoreIdentity(store);
    const id = storeRunId(runId, identity);
    const startedAt = nowIso();
    let failurePhase: PipelineStoreRunRecord["phase"] = "product-scan";
    await repositoryPut(pipelineStoreRunStore, {
      id,
      runId,
      ...identity,
      status: "running",
      phase: "product-scan",
      productCount: 0,
      currentCategoryCount: 0,
      effectiveCategoryCount: 0,
      clueCount: 0,
      tokenCount: 0,
      candidateCount: 0,
      eligibleCandidateCount: 0,
      qualifiedCandidateCount: 0,
      plannedSubmitCandidateCount: 0,
      submittedCount: 0,
      failedCount: 0,
      startedAt,
      updatedAt: startedAt
    } satisfies PipelineStoreRunRecord);
    try {
      dispatchPipelineProgress(args, 5 + (index / targets.length) * 20, `扫描店铺商品：${store.shopName || store.shopId}`);
      const scan = await scanProductsForStore(payload, store, args, runId, index + 1, targets.length);
      if (!scan.detail.ok) throw new Error(scan.detail.message || "opportunity product scan failed");
      failurePhase = "submit-history-sync";
      const benefitScan = await scanBenefitProductsForStore(payload, store, args);
      if (benefitScan.status !== "complete") throw new Error("submit history sync incomplete");
      const benefitOverview = benefitScan.overview;
      const inputCoverage: PipelineInputCoverage = {
        productScanStatus: scan.scanStatus,
        productFetchedCount: scan.products.length,
        productRemoteTotal: scan.remoteTotalKnown ? scan.remoteTotal : undefined,
        productRemoteTotalKnown: scan.remoteTotalKnown,
        productFetchedPages: scan.fetchedPages,
        productNextPage: scan.nextPage,
        clueScanStatus: "complete",
        clueFetchedUniqueCount: 0,
        clueRemoteTotalByCategory: {},
        clueTruncatedCategoryCount: 0,
        benefitScanStatus: benefitScan.status,
        benefitFetchedUniqueProductCount: benefitScan.records.length,
        benefitRemoteTotal: benefitScan.remoteTotalKnown ? benefitScan.remoteTotal : undefined,
        benefitRemoteTotalKnown: benefitScan.remoteTotalKnown,
        benefitNextPage: benefitScan.nextPage,
        clueCoverageSatisfied: true,
        coverageVersion: inputCoverageVersion
      };
      const extracted = extractCurrentStoreCategories(scan.products);
      const effective = effectiveStoreCategories(extracted.categories, matchRules);
      failurePhase = "category-ledger";
      await saveStoreCategorySnapshot({
        runId,
        identity,
        categories: extracted.categories,
        productCount: scan.products.length,
        missingCategoryProductCount: extracted.missingCategoryProductCount,
        createdAt: nowIso()
      });
      await upsertStoreCategoryLedger({ identity, categories: extracted.categories, seenAt: nowIso() });
      await updatePipelineStoreRunProgress(id, {
        phase: "clue-load",
        productCount: scan.products.length,
        currentCategoryCount: extracted.categories.length,
        effectiveCategoryCount: effective.length
      }).catch(() => null);
      const storeDailyAttemptLimit = dailyAttemptLimit(args, payload.adapter);
      const quotaUsedBefore = await submitAttemptCountForShop(identity.shopId);
      const quotaRemainingBefore = Math.max(0, storeDailyAttemptLimit - quotaUsedBefore);
      const storeCandidateLimitPerProduct = policyNumber(payload.adapter, "opportunityReport.candidateLimitPerProduct", 5, 1, 20);
      return {
        ok: true as const,
        store,
        index,
        identity,
        id,
        startedAt,
        scan,
        benefitScan,
        benefitOverview,
        benefitIndex: new Map(benefitScan.records.map((record) => [record.productId, record])),
        dedupeIndex: persistedDedupeIndex,
        inputCoverage,
        extracted,
        effective,
        productsByCategoryKey: groupProductsByCategoryKey(scan.products),
        storeDailyAttemptLimit,
        quotaUsedBefore,
        quotaRemainingBefore,
        storeCandidateLimitPerProduct,
        storeTopKPerProduct: boundedProductCandidateLimit(Number(matchRules.topKPerProduct || 1), storeCandidateLimitPerProduct)
      };
    } catch (error) {
      return { ok: false as const, store, index, identity, id, startedAt, failurePhase, error };
    }
  }, { shouldStop: () => pipelineCancelled(args) });
  if (pipelineCancelled(args)) return finishCancelled();

  const fullCluePageBudget = policyNumber(payload.adapter, "opportunityReport.maxCluePages", 200, 1, 200);
  const boundedCluePageBudget = normalizedClueFilter(filters, payload.adapter).clueCoveragePages;
  const categoryDemand = aggregateCategoryDemands(preparedStores.flatMap((prepared) => prepared.ok ? [{
    tenantId: prepared.identity.tenantId,
    shopId: prepared.identity.shopId,
    categoryKeys: prepared.effective.map(cacheCategoryKey).filter(Boolean),
    requestedPages: prepared.effective.length === 1 ? fullCluePageBudget : boundedCluePageBudget,
    fullCoverage: prepared.effective.length === 1
  }] : []));
  await reportDoudianDiagnostic({
    category: "opportunity-pipeline",
    event: "category-demand-aggregated",
    runId,
    storePrepareConcurrency,
    preparedStoreCount: preparedStores.filter((item) => item.ok).length,
    categoryDemand: Array.from(categoryDemand.entries()).map(([categoryKey, demand]) => ({ categoryKey, ...demand }))
  }, true);

  const streamingSubmitEnabled = policyBoolean(payload.adapter, "opportunityReport.submitPipelineStreamingEnabled", false);
  const streamingWorkerRuns: Array<Promise<{
    result?: Awaited<ReturnType<typeof runSubmitWorker>>;
    error?: unknown;
  }>> = [];
  const scheduleStreamingSubmitWorker = () => {
    if (!streamingSubmitEnabled) return;
    const scheduled = runSubmitWorker(payload, { ...args, runId })
      .then((result) => ({ result }), (error) => ({ error }));
    streamingWorkerRuns.push(scheduled);
  };

  await mapConcurrentOrdered(preparedStores, storePrepareConcurrency, async (prepared, index) => {
    const { store, identity, id, startedAt } = prepared;
    if (!prepared.ok) {
      failedCount += 1;
      const failedAt = nowIso();
      const failureReason = prepared.failurePhase === "product-scan" ? "pipeline-product-scan-failed" : `pipeline-${prepared.failurePhase}-failed`;
      await repositoryPut(pipelineStoreRunStore, {
        id,
        runId,
        ...identity,
        status: "failed",
        phase: "finished",
        productCount: 0,
        currentCategoryCount: 0,
        effectiveCategoryCount: 0,
        clueCount: 0,
        tokenCount: 0,
        candidateCount: 0,
        eligibleCandidateCount: 0,
        qualifiedCandidateCount: 0,
        plannedSubmitCandidateCount: 0,
        submittedCount: 0,
        failedCount: 1,
        skipReason: failureReason,
        startedAt,
        updatedAt: failedAt,
        finishedAt: failedAt
      } satisfies PipelineStoreRunRecord);
      await writePipelineEvent({
        runId,
        storeRunId: id,
        shopId: identity.shopId,
        level: "error",
        event: "pipeline-store-prepare-failed",
        message: prepared.error instanceof Error ? prepared.error.message : String(prepared.error),
        detail: { phase: prepared.failurePhase, storePrepareConcurrency }
      }).catch(() => undefined);
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        status: "failed",
        ok: false,
        message: prepared.error instanceof Error ? prepared.error.message : String(prepared.error),
        reason: failureReason,
        category: "api",
        index: index + 1,
        total: targets.length
      });
      processedStoreCount += 1;
      return;
    }
    const {
      scan,
      benefitScan,
      benefitOverview,
      benefitIndex,
      dedupeIndex,
      inputCoverage,
      extracted,
      effective,
      productsByCategoryKey,
      storeDailyAttemptLimit,
      quotaUsedBefore,
      quotaRemainingBefore,
      storeCandidateLimitPerProduct,
      storeTopKPerProduct
    } = prepared;
    if (pipelineCancelled(args)) return;
    let failurePhase: PipelineStoreRunRecord["phase"] = "clue-load";
    try {
      dispatchPipelineProgress(args, 5 + (index / targets.length) * 70, `扫描店铺商品：${store.shopName || store.shopId}`);
      sourceHealth.push(...scan.sourceHealth);
      sourceHealth.push(...benefitScan.sourceHealth);
      products.push(...scan.products);
      benefitProductCount += benefitOverview.productCount;
      benefitAcquiredExposure += benefitOverview.acquiredExposure;
      benefitEstimatedExposure += benefitOverview.estimatedExposure;
      benefitAcquiredExposureParsedCount += benefitOverview.acquiredExposureParsedCount;
      benefitAcquiredExposureUnparsedCount += benefitOverview.acquiredExposureUnparsedCount;
      benefitEstimatedExposureParsedCount += benefitOverview.estimatedExposureParsedCount;
      benefitEstimatedExposureUnparsedCount += benefitOverview.estimatedExposureUnparsedCount;
      benefitSubmitRecordCount += benefitOverview.recordCount;
      benefitAssociatedClueCount += benefitOverview.associatedClueCount;
      benefitSaturatedProductCount += benefitOverview.saturatedProductCount;
      currentCategoryCount += extracted.categories.length;
      effectiveCategoryCount += effective.length;
      await updatePipelineStoreRunProgress(id, {
        phase: "clue-load",
        productCount: scan.products.length,
        benefitProductCount: benefitOverview.productCount,
        benefitAcquiredExposure: benefitOverview.acquiredExposure,
        benefitEstimatedExposure: benefitOverview.estimatedExposure,
        benefitAcquiredExposureParsedCount: benefitOverview.acquiredExposureParsedCount,
        benefitAcquiredExposureUnparsedCount: benefitOverview.acquiredExposureUnparsedCount,
        benefitEstimatedExposureParsedCount: benefitOverview.estimatedExposureParsedCount,
        benefitEstimatedExposureUnparsedCount: benefitOverview.estimatedExposureUnparsedCount,
        benefitSubmitRecordCount: benefitOverview.recordCount,
        benefitAssociatedClueCount: benefitOverview.associatedClueCount,
        benefitSaturatedProductCount: benefitOverview.saturatedProductCount,
        currentCategoryCount: extracted.categories.length,
        effectiveCategoryCount: effective.length
      }).catch(() => null);

      let storeClueCount = 0;
      let storeTokenCount = 0;
      const storeClueIds = new Set<string>();
      const storeCandidates: DoudianOpportunityPrematchCandidate[] = [];
      const storeDiagnostics = createMatchDiagnostics();
      const storeSourceHealth = [...scan.sourceHealth, ...benefitScan.sourceHealth];
      const missingCategoryIdCategories = effective.filter((category) => !text(category.categoryId));
      if (missingCategoryIdCategories.length) {
        // A product category without a stable platform id cannot be queried,
        // so the clue gate must remain closed even if other categories load.
        inputCoverage.clueScanStatus = "failed";
        inputCoverage.clueCoverageSatisfied = false;
      }
      if (missingCategoryIdCategories.length) {
        await writePipelineEvent({
          runId,
          storeRunId: id,
          shopId: identity.shopId,
          level: "warn",
          event: "pipeline-category-id-diagnostic",
          message: "商品类目有名称但缺少 categoryId，商机加载将跳过",
          detail: {
            productCount: scan.products.length,
            currentCategoryCount: extracted.categories.length,
            effectiveCategoryCount: effective.length,
            missingCategoryIdCategoryCount: missingCategoryIdCategories.length,
            sampleCategories: missingCategoryIdCategories.slice(0, 10).map((category) => ({
              categoryId: category.categoryId,
              categoryName: category.categoryName,
              categoryPath: category.categoryPath,
              lastCategoryKey: category.lastCategoryKey,
              categoryKey: category.categoryKey,
              productCount: category.productCount,
              sampleProductIds: category.sampleProductIds
            }))
          }
        }).catch(() => undefined);
      }
      for (const category of effective) {
        if (pipelineCancelled(args)) return;
        const categoryKey = cacheCategoryKey(category);
        if (!categoryKey) {
          await writePipelineEvent({
            runId,
            storeRunId: id,
            shopId: identity.shopId,
            level: "warn",
            event: "pipeline-category-skipped",
            message: "商品类目缺少 categoryId，已跳过商机加载",
            detail: { category }
          }).catch(() => undefined);
          continue;
        }
        const categoryProducts = productsByCategoryKey.get(categoryKey) || [];
        if (!categoryProducts.length) continue;
        const demand = categoryDemand.get(`${identity.tenantId}::${categoryKey}`) || {
          requestedPages: effective.length === 1 ? fullCluePageBudget : boundedCluePageBudget,
          fullCoverage: effective.length === 1,
          consumerShopIds: [identity.shopId]
        };
        storeSourceHealth.push({
          key: `category-demand:${categoryKey}`,
          ok: true,
          categoryKey,
          requestedCoverage: demand.fullCoverage ? "all-pages" : `${demand.requestedPages}-pages`,
          requestedPages: demand.requestedPages,
          consumerShopIds: demand.consumerShopIds
        });
        failurePhase = "clue-load";
        const clueResult = await loadCluesByCategoryWithCache({
          payload,
          store,
          identity,
          runId,
          filters,
          category,
          dryRun: args.dryRun,
          mockClues: args.mockClues,
          requestedPages: demand.requestedPages,
          pageBudgetSatisfiesCoverage: effective.length > 1
        });
        const clueLoadSummary = {
          shopId: identity.shopId,
          categoryKey,
          ok: clueResult.ok,
          cacheHit: clueResult.cacheHit,
          cacheScope: clueResult.cacheScope,
          scanStatus: clueResult.scanStatus,
          coverageSatisfied: clueResult.coverageSatisfied,
          fetchedPages: clueResult.fetchedPages,
          rowCount: clueResult.rows.length,
          remoteTotal: clueResult.remoteTotalKnown ? clueResult.remoteTotal : undefined,
          remoteTotalKnown: clueResult.remoteTotalKnown,
          sourceHealth: clueResult.sourceHealth.map((item) => ({
            key: item.key,
            status: item.status,
            ok: item.ok,
            count: item.count,
            uniqueCount: item.uniqueCount,
            pageNew: item.pageNew,
            duplicateCount: item.duplicateCount,
            missingIdCount: item.missingIdCount,
            duplicatePage: item.duplicatePage,
            remoteTotal: item.remoteTotal,
            error: item.error
          }))
        };
        await reportDoudianDiagnostic({
          category: "opportunity-pipeline",
          event: "clue-load-summary",
          runId,
          ...clueLoadSummary
        }, true).catch(() => undefined);
        storeSourceHealth.push(...clueResult.sourceHealth);
        sourceHealth.push(...clueResult.sourceHealth);
        if (clueResult.ok === false) {
          await writePipelineEvent({
            runId,
            storeRunId: id,
            shopId: identity.shopId,
            level: "error",
            event: "pipeline-clue-load-failed",
            message: "opportunity clue loading failed",
            detail: clueLoadSummary
          }).catch(() => undefined);
          throw new Error("opportunity clue loading failed");
        }
        inputCoverage.clueRemoteTotalByCategory[categoryKey] = clueResult.remoteTotalKnown ? clueResult.remoteTotal : null;
        if (clueResult.scanStatus === "truncated") {
          inputCoverage.clueScanStatus = "truncated";
          inputCoverage.clueTruncatedCategoryCount += 1;
        } else if (clueResult.scanStatus === "failed") {
          inputCoverage.clueScanStatus = "failed";
        }
        if (!clueResult.coverageSatisfied) inputCoverage.clueCoverageSatisfied = false;
        if (!clueResult.rows.length || !clueResult.cacheKey) continue;
        pipelineClues.push(...clueResult.rows);
        storeClueCount += clueResult.rows.length;
        clueResult.rows.forEach((clue) => storeClueIds.add(clue.clueId));
        inputCoverage.clueFetchedUniqueCount = storeClueIds.size;
        await updatePipelineStoreRunProgress(id, {
          phase: "clue-load",
          productCount: scan.products.length,
          benefitProductCount: benefitOverview.productCount,
          benefitAcquiredExposure: benefitOverview.acquiredExposure,
          benefitEstimatedExposure: benefitOverview.estimatedExposure,
          benefitAcquiredExposureUnparsedCount: benefitOverview.acquiredExposureUnparsedCount,
          benefitEstimatedExposureUnparsedCount: benefitOverview.estimatedExposureUnparsedCount,
          currentCategoryCount: extracted.categories.length,
          effectiveCategoryCount: effective.length,
          clueCount: storeClueCount
        }).catch(() => null);
        failurePhase = "tokenize";
        const tokenIndex = await tokenizeCluesWithCache({
          clues: clueResult.rows,
          clueCacheKey: clueResult.cacheKey,
          categoryKey,
          filterHash: stableFilterHash(filters, payload.adapter),
          cacheScope: clueResult.cacheScope,
          scopeId: clueResult.scopeId,
          allowTokenizerFallback: Boolean(args.dryRun)
        });
        storeTokenCount += tokenIndex.tokens.length;
        await updatePipelineStoreRunProgress(id, {
          phase: "match",
          productCount: scan.products.length,
          benefitProductCount: benefitOverview.productCount,
          benefitAcquiredExposure: benefitOverview.acquiredExposure,
          benefitEstimatedExposure: benefitOverview.estimatedExposure,
          benefitAcquiredExposureUnparsedCount: benefitOverview.acquiredExposureUnparsedCount,
          benefitEstimatedExposureUnparsedCount: benefitOverview.estimatedExposureUnparsedCount,
          currentCategoryCount: extracted.categories.length,
          effectiveCategoryCount: effective.length,
          clueCount: storeClueCount,
          tokenCount: storeTokenCount
        }).catch(() => null);
        dispatchPipelineProgress(args, 12 + ((index + 0.35) / targets.length) * 70, `匹配商机词：${identity.shopName || identity.shopId}`);
        failurePhase = "match";
        const matchResult = matchCategoryProductsByAhoTokens({
          adapter: payload.adapter,
          runId,
          storeRunId: id,
          clueCacheKey: clueResult.cacheKey,
          wordCacheKey: tokenIndex.wordCacheKey,
          effectiveCategoryKey: categoryKey,
          products: categoryProducts,
          clues: clueResult.rows,
          tokenIndex,
          minTokenHitRatio: Number(matchRules.minTokenHitRatio || 0.33),
          minWeightHitRatio: Number(matchRules.minWeightHitRatio || 0.35),
          genericTokenDfRatio: Number(matchRules.genericTokenDfRatio || 0.12),
          topKPerProduct: storeTopKPerProduct,
          dedupeIndex,
          benefitIndex,
          matchRulesHash,
          opportunityArgs: args
        });
        storeCandidates.push(...matchResult.candidates);
        mergeMatchDiagnostics(storeDiagnostics, matchResult.diagnostics);
      }
      if (pipelineCancelled(args)) return;
      const rankedStoreCandidates = markProductRanks({
        candidates: storeCandidates,
        topKPerProduct: storeTopKPerProduct,
        opportunityArgs: args,
        dedupeIndex,
        benefitIndex
      });
      const plannedSelection = selectStoreSubmitCandidates({
        candidates: rankedStoreCandidates,
        dailyAttemptLimit: storeDailyAttemptLimit,
        quotaUsedBefore,
        maxCandidates: policyNumber(payload.adapter, "opportunityReport.maxSubmitCandidatesPerStore", 1000, 1, 10000),
        fallbackOnlyAfterPrimaryFailure: policyBoolean(payload.adapter, "opportunityReport.fallbackOnlyAfterPrimaryFailure", true)
      });
      const plannedStoreCandidates = plannedSelection.candidates;
      const storeEstimatedSubmitGroupCount = estimateSubmitGroups(plannedStoreCandidates, payload.adapter);
      const storeEstimatedSubmitDurationMs = estimateSubmitDurationMs(storeEstimatedSubmitGroupCount, payload.adapter);
      const eligibleCount = plannedSelection.plannedSubmitCandidateCount;
      const writeCoverageComplete = pipelineInputCoverageAllowsWrite(inputCoverage);
      const persistedEligibleCount = writeCoverageComplete ? eligibleCount : 0;
      const persistedPlannedSubmitCandidateCount = writeCoverageComplete ? plannedSelection.plannedSubmitCandidateCount : 0;
      const persistedPrimarySubmitCandidateCount = writeCoverageComplete ? plannedSelection.primarySubmitCandidateCount : 0;
      const persistedFallbackSubmitCandidateCount = writeCoverageComplete ? plannedSelection.fallbackSubmitCandidateCount : 0;
      const persistedEstimatedSubmitGroupCount = writeCoverageComplete ? storeEstimatedSubmitGroupCount : 0;
      const persistedEstimatedSubmitDurationMs = writeCoverageComplete ? storeEstimatedSubmitDurationMs : 0;
      const persistedQuotaRemainingAfterPlan = writeCoverageComplete
        ? plannedSelection.quotaRemainingAfterPlan
        : plannedSelection.quotaRemainingBefore;
      const alternativeCount = plannedStoreCandidates.filter((candidate) => candidateRank(candidate) > 1 || candidate.alternative === true).length;
      storeDiagnostics.persistedCandidateCount = plannedStoreCandidates.length;
      storeDiagnostics.eligibleCandidateCount = persistedEligibleCount;
      storeDiagnostics.alternativeCandidateCount = alternativeCount;
      storeDiagnostics.droppedByTopKCount = Math.max(0, storeDiagnostics.passedThresholdCount - plannedStoreCandidates.length);
      const compactedStoreCandidates = plannedStoreCandidates.map((candidate) => ({
        ...compactPipelineCandidate(candidate),
        tenantId: identity.tenantId,
        storeGeneration: identity.storeGeneration
      }));
      failurePhase = "submit-queued";
      const task = await enqueueStoreSubmit({
        runId,
        storeRunId: id,
        identity,
        candidates: compactedStoreCandidates,
        snapshotVersion: matchRulesHash,
        inputCoverage,
        candidateLimitPerProduct: storeCandidateLimitPerProduct,
        contract: submitTaskContract(payload, args)
      });
      if (task && task.runId !== runId) {
        throw new Error(`提报任务运行归属不一致：期望 ${runId}，实际 ${task.runId}`);
      }
      if (task) {
        submitTaskCount += 1;
      }
      if (!writeCoverageComplete) coverageBlockedCount += 1;
      if (pipelineCancelled(args)) return;
      let skipReason = "";
      if (!writeCoverageComplete) skipReason = "input_coverage_not_complete";
      else if (!effective.length) skipReason = "no-effective-category";
      else if (!storeClueCount) skipReason = "no-clue-for-effective-category";
      else if (!plannedStoreCandidates.length) skipReason = pipelineNoCandidateSkipReason(storeDiagnostics);
      else if (!eligibleCount) skipReason = "no-eligible-candidate";
      const skipMessage = pipelineStoreResultMessage(skipReason);
      if (skipReason) skippedCount += 1;
      clueCount += storeClueCount;
      tokenCount += storeTokenCount;
      candidateCount += plannedStoreCandidates.length;
      qualifiedCandidateCount += plannedSelection.qualifiedCandidateCount;
      eligibleCandidateCount += persistedEligibleCount;
      plannedSubmitCandidateCount += persistedPlannedSubmitCandidateCount;
      primarySubmitCandidateCount += persistedPrimarySubmitCandidateCount;
      fallbackSubmitCandidateCount += persistedFallbackSubmitCandidateCount;
      estimatedSubmitGroupCount += persistedEstimatedSubmitGroupCount;
      estimatedSubmitDurationMs += persistedEstimatedSubmitDurationMs;
      processedStoreCount += 1;
      const finishedAt = nowIso();
      await repositoryPut(pipelineStoreRunStore, {
        id,
        runId,
        ...identity,
        status: task ? "queued" : skipReason ? "skipped" : "ok",
        phase: task ? "submit-queued" : "finished",
        inputCoverage,
        productCount: scan.products.length,
        benefitProductCount: benefitOverview.productCount,
        benefitAcquiredExposure: benefitOverview.acquiredExposure,
        benefitEstimatedExposure: benefitOverview.estimatedExposure,
        benefitAcquiredExposureParsedCount: benefitOverview.acquiredExposureParsedCount,
        benefitAcquiredExposureUnparsedCount: benefitOverview.acquiredExposureUnparsedCount,
        benefitEstimatedExposureParsedCount: benefitOverview.estimatedExposureParsedCount,
        benefitEstimatedExposureUnparsedCount: benefitOverview.estimatedExposureUnparsedCount,
        benefitSubmitRecordCount: benefitOverview.recordCount,
        benefitAssociatedClueCount: benefitOverview.associatedClueCount,
        benefitSaturatedProductCount: benefitOverview.saturatedProductCount,
        currentCategoryCount: extracted.categories.length,
        effectiveCategoryCount: effective.length,
        clueCount: storeClueCount,
        tokenCount: storeTokenCount,
        matchDiagnostics: storeDiagnostics,
        ...matchDiagnosticsSummary(storeDiagnostics),
        candidateCount: plannedStoreCandidates.length,
        eligibleCandidateCount: persistedEligibleCount,
        alternativeCandidateCount: alternativeCount,
        qualifiedCandidateCount: plannedSelection.qualifiedCandidateCount,
        primaryCandidateCount: plannedSelection.primaryCandidateCount,
        fallbackCandidateCount: plannedSelection.fallbackCandidateCount,
        plannedSubmitCandidateCount: persistedPlannedSubmitCandidateCount,
        primarySubmitCandidateCount: persistedPrimarySubmitCandidateCount,
        fallbackSubmitCandidateCount: persistedFallbackSubmitCandidateCount,
        estimatedSubmitGroupCount: persistedEstimatedSubmitGroupCount,
        estimatedSubmitDurationMs: persistedEstimatedSubmitDurationMs,
        dailyAttemptLimit: plannedSelection.dailyAttemptLimit,
        quotaUsedBefore: plannedSelection.quotaUsedBefore,
        quotaRemainingBefore: plannedSelection.quotaRemainingBefore,
        quotaRemainingAfterPlan: persistedQuotaRemainingAfterPlan,
        quotaAttemptCount: plannedSelection.quotaUsedBefore,
        quotaRemainingAfterSubmit: plannedSelection.quotaRemainingBefore,
        submittedCount: 0,
        failedCount: 0,
        skipReason,
        sourceHealth: storeSourceHealth,
        startedAt,
        updatedAt: finishedAt,
        finishedAt: task ? undefined : finishedAt
      } satisfies PipelineStoreRunRecord);
      await writePipelineEvent({
        runId,
        storeRunId: id,
        shopId: identity.shopId,
        level: task ? "info" : skipReason ? "warn" : "info",
        event: task ? "pipeline-submit-task-queued" : skipReason ? "pipeline-store-skipped" : "pipeline-store-finished",
        message: task ? "商机候选已生成并进入提报队列" : skipReason ? skipMessage : "店铺商机提报处理完成",
        detail: {
          productCount: scan.products.length,
          benefitProductCount: benefitOverview.productCount,
          benefitAcquiredExposure: benefitOverview.acquiredExposure,
          benefitEstimatedExposure: benefitOverview.estimatedExposure,
          benefitAcquiredExposureUnparsedCount: benefitOverview.acquiredExposureUnparsedCount,
          benefitEstimatedExposureUnparsedCount: benefitOverview.estimatedExposureUnparsedCount,
          currentCategoryCount: extracted.categories.length,
          effectiveCategoryCount: effective.length,
          missingCategoryProductCount: extracted.missingCategoryProductCount,
          clueCount: storeClueCount,
          tokenCount: storeTokenCount,
          candidateCount: plannedStoreCandidates.length,
          qualifiedCandidateCount: plannedSelection.qualifiedCandidateCount,
          eligibleCount: persistedEligibleCount,
          plannedSubmitCandidateCount: persistedPlannedSubmitCandidateCount,
          primarySubmitCandidateCount: persistedPrimarySubmitCandidateCount,
          fallbackSubmitCandidateCount: persistedFallbackSubmitCandidateCount,
          maxSubmitCandidatesPerStore: policyNumber(payload.adapter, "opportunityReport.maxSubmitCandidatesPerStore", 1000, 1, 10000),
          estimatedSubmitGroupCount: persistedEstimatedSubmitGroupCount,
          estimatedSubmitDurationMs: persistedEstimatedSubmitDurationMs,
          alternativeCount,
          dailyAttemptLimit: plannedSelection.dailyAttemptLimit,
          quotaUsedBefore: plannedSelection.quotaUsedBefore,
          quotaRemainingBefore: plannedSelection.quotaRemainingBefore,
          quotaRemainingAfterPlan: persistedQuotaRemainingAfterPlan,
          matchDiagnostics: matchDiagnosticsSummary(storeDiagnostics),
          submitTaskId: task?.id
        }
      }).catch(() => undefined);
      if (task) scheduleStreamingSubmitWorker();
      if (!task) {
        await reportDoudianDiagnostic({
          category: "opportunity-pipeline",
          event: "store-submit-summary",
          runId,
          storeRunId: id,
          shopId: identity.shopId,
          status: skipReason ? "skipped" : "ok",
          accepted: 0,
          failed: 0,
          safetySkipped: 0,
          quotaExhausted: 0,
          cancelled: 0,
          unknown: 0,
          remoteRequestCount: 0,
          productCount: scan.products.length,
          candidateCount: plannedStoreCandidates.length,
          reason: skipReason
        }, true);
      }
      dispatchPipelineProgress(args, 8 + ((index + 1) / targets.length) * 70, `店铺候选已落库：${identity.shopName || identity.shopId}`);
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        status: task ? "queued" : skipReason ? "skipped" : "ok",
        ok: !skipReason,
        message: task ? "已生成候选并进入提报队列" : skipReason ? skipMessage : "店铺商机提报处理完成",
        reason: skipReason,
        diagnostic: {
          productCount: scan.products.length,
          benefitProductCount: benefitOverview.productCount,
          benefitAcquiredExposure: benefitOverview.acquiredExposure,
          benefitEstimatedExposure: benefitOverview.estimatedExposure,
          benefitAcquiredExposureUnparsedCount: benefitOverview.acquiredExposureUnparsedCount,
          benefitEstimatedExposureUnparsedCount: benefitOverview.estimatedExposureUnparsedCount,
          currentCategoryCount: extracted.categories.length,
          effectiveCategoryCount: effective.length,
          missingCategoryProductCount: extracted.missingCategoryProductCount,
          effectiveCategoryKeys: effective.map((category) => category.categoryKey),
          clueCount: storeClueCount,
          tokenCount: storeTokenCount,
          candidateCount: plannedStoreCandidates.length,
          qualifiedCandidateCount: plannedSelection.qualifiedCandidateCount,
          eligibleCount: persistedEligibleCount,
          eligibleCandidateCount: persistedEligibleCount,
          plannedSubmitCandidateCount: persistedPlannedSubmitCandidateCount,
          primarySubmitCandidateCount: persistedPrimarySubmitCandidateCount,
          fallbackSubmitCandidateCount: persistedFallbackSubmitCandidateCount,
          alternativeCount,
          alternativeCandidateCount: alternativeCount,
          dailyAttemptLimit: plannedSelection.dailyAttemptLimit,
          quotaUsedBefore: plannedSelection.quotaUsedBefore,
          quotaRemainingBefore: plannedSelection.quotaRemainingBefore,
          quotaRemainingAfterPlan: persistedQuotaRemainingAfterPlan,
          quotaAttemptCount: plannedSelection.quotaUsedBefore,
          quotaRemainingAfterSubmit: plannedSelection.quotaRemainingBefore,
          matchDiagnostics: matchDiagnosticsSummary(storeDiagnostics),
          submitTaskId: task?.id
        },
        index: index + 1,
        total: targets.length
      });
    } catch (error) {
      failedCount += 1;
      const failedAt = nowIso();
      const failureReason = `pipeline-${failurePhase}-failed`;
      await repositoryPut(pipelineStoreRunStore, {
        id,
        runId,
        ...identity,
        status: "failed",
        phase: "finished",
        productCount: 0,
        currentCategoryCount: 0,
        effectiveCategoryCount: 0,
        clueCount: 0,
        tokenCount: 0,
        candidateCount: 0,
        eligibleCandidateCount: 0,
        qualifiedCandidateCount: 0,
        plannedSubmitCandidateCount: 0,
        submittedCount: 0,
        failedCount: 1,
        skipReason: failureReason,
        startedAt,
        updatedAt: failedAt,
        finishedAt: failedAt
      } satisfies PipelineStoreRunRecord);
      await writePipelineEvent({
        runId,
        storeRunId: id,
        shopId: identity.shopId,
        level: "error",
        event: "pipeline-store-failed",
        message: error instanceof Error ? error.message : String(error),
        detail: { phase: failurePhase }
      }).catch(() => undefined);
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        status: "failed",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        reason: failureReason,
        category: "api",
        index: index + 1,
        total: targets.length
      });
    }
  }, { shouldStop: () => pipelineCancelled(args) });

  if (pipelineCancelled(args)) return finishCancelled();
  if (submitTaskCount > 0) {
    dispatchPipelineProgress(args, 82, "自动提报任务处理中");
    const workerResults: Array<Awaited<ReturnType<typeof runSubmitWorker>>> = [];
    if (streamingSubmitEnabled) {
      const streamed = await Promise.all(streamingWorkerRuns);
      const failedWorker = streamed.find((item) => item.error !== undefined);
      if (failedWorker?.error !== undefined) throw failedWorker.error;
      workerResults.push(...streamed.flatMap((item) => item.result ? [item.result] : []));
      workerResults.push(await runSubmitWorker(payload, { ...args, runId }));
    } else {
      workerResults.push(await runSubmitWorker(payload, { ...args, runId }));
    }
    const workerResult = {
      ok: workerResults.every((item) => item.ok !== false),
      processed: workerResults.reduce((sum, item) => sum + Number(item.processed || 0), 0),
      schedulerBusy: workerResults.some((item) => item.schedulerBusy === true)
    };
    const submitTasksAfterWorker = await loadPipelineSubmitTasksForRunStrict(runId);
    const resumableTasks = submitTasksAfterWorker.filter((task) => task.runId === runId && (
      task.status === "cooling_down" ||
      isDeferredSubmitTaskStatus(task.status) ||
      ((task.status === "ready" || task.status === "queued") && Boolean(task.resumeAt) && Date.parse(task.resumeAt || "") > Date.now()) ||
      (workerResult.schedulerBusy && (task.status === "ready" || task.status === "queued"))
    ));
    if (resumableTasks.length) {
      const deferredAt = nowIso();
      await Promise.all(resumableTasks.map((task) => updatePipelineStoreRunProgress(task.storeRunId, {
        status: "partial",
        phase: "finished",
        submittedCount: Number(task.submittedCount || 0),
        failedCount: Number(task.failedCount || 0),
        skippedCount: Number(task.skippedCount || 0),
        quotaExhaustedCount: Number(task.quotaExhaustedCount || 0),
        unknownCount: Number(task.unknownCount || 0),
        remoteRequestCount: Number(task.remoteRequestCount || 0),
        skipReason: task.deferredReason || (task.status === "cooling_down" ? "rate_cooling_down" : workerResult.schedulerBusy ? "scheduler_lease_busy" : task.status),
        finishedAt: deferredAt
      }).catch(() => null)));
      details.push(...resumableTasks.map((task) => ({
        shopId: task.shopId,
        shopName: task.shopName,
        status: "partial",
        ok: false,
        message: task.status === "cooling_down" ? "提报触发频控，已保存进度并等待恢复" : "提报任务已保存，等待后续恢复",
        reason: task.deferredReason || (workerResult.schedulerBusy ? "scheduler-lease-busy" : task.status),
        category: "client",
        diagnostic: { taskId: task.id, taskStatus: task.status, resumeAt: task.resumeAt, workerProcessed: workerResult.processed }
      } satisfies DoudianRunDetail)));
    }
    const resumableTaskIds = new Set(resumableTasks.map((task) => task.id));
    const unconsumedTasks = activeSubmitTasksForRun(submitTasksAfterWorker, runId).filter((task) => !resumableTaskIds.has(task.id));
    if (unconsumedTasks.length) {
      const reason = `商机提报 worker 已退出，但仍有 ${unconsumedTasks.length} 个队列任务未消费`;
      await failUnconsumedSubmitTasks(unconsumedTasks, reason);
      failedCount += unconsumedTasks.length;
      details.push(...unconsumedTasks.map((task) => ({
        shopId: task.shopId,
        shopName: task.shopName,
        status: "failed",
        ok: false,
        message: reason,
        reason: "submit-worker-unconsumed-task",
        category: "client",
        diagnostic: { taskId: task.id, taskStatus: task.status, workerProcessed: workerResult.processed }
      } satisfies DoudianRunDetail)));
      await reportDoudianDiagnostic({
        category: "opportunity-pipeline",
        event: "submit-worker-stalled",
        runId,
        unconsumedTaskCount: unconsumedTasks.length,
        workerProcessed: workerResult.processed
      }, true);
    }
    dispatchPipelineProgress(args, 95, "自动提报任务已完成，正在汇总");
  }

  const status = failedCount
    ? (processedStoreCount ? "partial" : "failed")
    : coverageBlockedCount
      ? "partial"
      : "ok";
  const summary = {
    ...pipelineRuntimePolicySummary,
    inputCoverageReportMode: policyText(payload.adapter, "opportunityReport.inputCoverageMode", "enforce") === "report" ? 1 : 0,
    inputCoveragePartialCount: coverageBlockedCount,
    productCount: products.length,
    benefitProductCount,
    benefitAcquiredExposure,
    benefitEstimatedExposure,
    benefitAcquiredExposureParsedCount,
    benefitAcquiredExposureUnparsedCount,
    benefitEstimatedExposureParsedCount,
    benefitEstimatedExposureUnparsedCount,
    benefitSubmitRecordCount,
    benefitAssociatedClueCount,
    benefitSaturatedProductCount,
    currentCategoryCount,
    effectiveCategoryCount,
    clueCount,
    tokenCount,
    candidateCount,
    qualifiedCandidateCount,
    eligibleCandidateCount,
    plannedSubmitCandidateCount,
    primarySubmitCandidateCount,
    fallbackSubmitCandidateCount,
    estimatedSubmitGroupCount,
    estimatedSubmitDurationMs,
    submitTaskCount,
    streamingSubmitEnabled: streamingSubmitEnabled ? 1 : 0,
    streamingWorkerRunCount: streamingWorkerRuns.length,
    coverageBlockedCount,
    submittedCount: 0,
    failedCount,
    skippedCount,
    processedStoreCount,
    totalStoreCount: targets.length
  };
  const updatedAt = nowIso();
  await repositoryPut(pipelineRunStore, {
    id: runId,
    runId,
    operationId: args.operationId,
    mode: "pipeline-submit",
    filters,
    matchRules,
    pipelineOptions: pipelineOptions(args),
    shopIds: targets.map((store) => store.shopId),
    storeRefs: targets.map(normalizePipelineStoreIdentity),
    tenantId: normalizePipelineStoreIdentity(targets[0]).tenantId,
    clientCapability,
    status,
    totalStoreCount: targets.length,
    processedStoreCount,
    submittedCount: 0,
    skippedCount,
    failedCount,
    summary,
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    requestPlanHash: requestPlanHash(payload.adapter),
    createdAt: now,
    updatedAt
  } satisfies PipelineRunRecord);
  const refreshedRun = await refreshPipelineRunSummary(runId).catch(() => null);
  const finalStatus = refreshedRun?.status || status;
  const responseStatus = pipelineSubmitResponseStatus(finalStatus);
  const finalSummary: Record<string, number> = refreshedRun?.summary || summary;
  const finalFailedCount = Number(finalSummary.failedCount || failedCount || 0);
  const finalSubmittedCount = Number(finalSummary.submittedCount || 0);
  const finalCoverageBlockedCount = Math.max(Number(finalSummary.inputCoveragePartialCount || 0), coverageBlockedCount);
  const previewCandidates = await loadPipelineCandidatesForRun(runId, latestPipelineCandidatePreviewLimit);
  const candidateTotalCount = Number(finalSummary.candidateCount || candidateCount || previewCandidates.length);
  const responseSummary = {
    ...finalSummary,
    candidateTotalCount,
    candidateLoadedCount: previewCandidates.length,
    candidateListTruncated: candidateTotalCount > previewCandidates.length ? 1 : 0
  };

  return {
    ...ledger,
    ok: responseStatus === "ok",
    status: responseStatus,
    mode: "pipeline-submit",
    message: pipelineSubmitResultMessage({
      failedCount: finalFailedCount,
      submittedCount: finalSubmittedCount,
      submitTaskCount,
      coverageBlockedCount: finalCoverageBlockedCount,
      automaticRecoveryPendingCount: Number(finalSummary.automaticRecoveryPendingCount || 0),
      retryableRemainingCount: Number(finalSummary.retryableRemainingCount || 0),
      filteredByHistoryCount: Number(finalSummary.filteredByHistoryCount || 0)
    }),
    runId,
    operationId: args.operationId,
    rows: pipelineClues,
    clues: pipelineClues,
    products,
    prematches: previewCandidates,
    executions: [],
    details,
    successCount: details.filter((detail) => detail.ok).length,
    failureCount: finalFailedCount,
    partialCount: responseStatus === "partial" ? Math.max(submitTaskCount, finalCoverageBlockedCount) : 0,
    summary: responseSummary,
    scanSummary: responseSummary,
    sourceHealth,
    filters,
    matchRules,
    pipelineOptions: pipelineOptions(args),
    requestPlanHash: requestPlanHash(payload.adapter)
  };
}

export async function fetchOpportunityReport(args: OpportunityArgs = {}): Promise<DoudianOpportunityReportResult> {
  const payload = adapterPayload(args);
  const mode = args.mode || "clue-scan";
  if (mode === "clue-scan") return fetchClueScan(payload, args);
  if (mode === "product-scan") return fetchProductScan(payload, args);
  if (mode === "product-prematch") return fetchProductPrematch(payload, args);
  if (mode === "pipeline-submit") return fetchPipelineSubmit(payload, args);
  if (["clue-submit", "product-submit", "prematch-submit"].includes(mode)) {
    return { ok: false, status: "retired-direct-submit", mode, message: "Direct opportunity submit is retired; use pipeline-submit", rows: [], clues: [], products: [], executions: [] };
  }
  if (mode === "collect") return fetchCollect(payload, args);
  if (mode === "latest") return fetchOpportunityReportLatest(args);
  return { ok: false, status: "unsupported-mode", mode, message: "unsupported opportunity report mode", rows: [], clues: [], products: [], executions: [] };
}

export async function runOpportunityPipelineSubmitTask(args: OpportunityArgs = {}): Promise<DoudianOpportunityReportResult> {
  const result = await fetchOpportunityReport({
    ...args,
    mode: "pipeline-submit",
    operationId: args.operationId || args.runId
  });
  if (result.status !== "cancelled" && result.status !== "partial" && result.ok === false) {
    throw new Error(result.message || `商机提报任务失败：${result.status || "unknown"}`);
  }
  const persistedResult = result.runId
    ? await fetchOpportunityPipelineRun({ runId: result.runId, includeCandidates: false }).catch(() => null)
    : null;
  const finalResult = persistedResult?.status !== "missing" ? persistedResult || result : result;
  return {
    ok: finalResult.ok,
    status: finalResult.status,
    mode: result.mode,
    message: result.message,
    runId: finalResult.runId || result.runId,
    operationId: finalResult.operationId || result.operationId,
    rows: [],
    clues: [],
    products: [],
    prematches: [],
    executions: [],
    details: finalResult.details || result.details || [],
    successCount: finalResult.successCount ?? result.successCount,
    failureCount: finalResult.failureCount ?? result.failureCount,
    partialCount: finalResult.partialCount ?? result.partialCount,
    summary: finalResult.summary || result.summary || {},
    scanSummary: finalResult.scanSummary || finalResult.summary || result.scanSummary || result.summary || {},
    sourceHealth: [],
    filters: result.filters,
    matchRules: result.matchRules,
    requestPlanHash: result.requestPlanHash
  };
}

export async function runOpportunitySubmitContinuationTask(args: OpportunityArgs = {}): Promise<DoudianOpportunityReportResult> {
  const payload = adapterPayload(args);
  const taskId = text(args.submitTaskId || args.taskId);
  if (!taskId) throw new Error("Opportunity submit continuation requires taskId");
  const task = await repositoryGet<PipelineSubmitTaskRecord>(pipelineSubmitTaskStore, taskId);
  if (!task) throw new Error("Opportunity submit continuation task is missing");
  if (["ok", "partial", "failed", "cancelled", "expired"].includes(task.status)) {
    return {
      ok: task.status === "ok",
      status: task.status,
      mode: "submit-continuation",
      message: "提报任务已处于终态",
      runId: task.runId,
      operationId: args.operationId,
      rows: [], clues: [], products: [], prematches: [], executions: [], sourceHealth: [],
      details: [{
        shopId: task.shopId,
        shopName: task.shopName,
        status: task.status,
        ok: task.status === "ok",
        message: "提报任务已处于终态",
        diagnostic: { taskId: task.id, taskStatus: task.status }
      }],
      summary: { remoteRequestCount: Number(task.remoteRequestCount || 0) }
    };
  }
  const currentContract = submitTaskContract(payload, args);
  for (const key of ["releaseId", "releaseManifestHash", "runnerArtifactHash", "adapterSnapshotHash", "adapterVersion", "scriptsVersion", "requestPlanHash", "submitContractVersion", "pacingPolicyHash", "submitThrottleRecoveryEnabled"] as const) {
    if (text(task[key]) !== text(currentContract[key])) throw new Error(`Opportunity submit continuation contract changed: ${key}`);
  }
  const workerResult = await runSubmitWorker(payload, {
    ...args,
    runId: task.runId,
    submitTaskId: task.id
  });
  const settledTask = await repositoryGet<PipelineSubmitTaskRecord>(pipelineSubmitTaskStore, task.id) || task;
  let pipelineRun: PipelineRunRecord | null = await refreshPipelineRunSummary(task.runId).catch(() => null);
  if (pipelineRun) {
    const recoveredAt = nowIso();
    const recoveredPipelineRun: PipelineRunRecord = {
      ...pipelineRun,
      recoverySource: text(args.reason) || "background-scheduler",
      lastRecoveredAt: recoveredAt,
      updatedAt: recoveredAt
    };
    pipelineRun = recoveredPipelineRun;
    await repositoryPut(pipelineRunStore, recoveredPipelineRun);
    await writePipelineEvent({
      runId: task.runId,
      storeRunId: task.storeRunId,
      shopId: task.shopId,
      level: settledTask.status === "manual_reconcile" ? "warn" : "info",
      event: "pipeline-submit-background-recovery-finished",
      message: "Background submit continuation updated the pipeline run",
      detail: {
        taskId: task.id,
        taskStatus: settledTask.status,
        recoverySource: recoveredPipelineRun.recoverySource,
        resumeAt: settledTask.resumeAt
      }
    }).catch(() => undefined);
  }
  const partial = ["ready", "queued", "running", "cooling_down", "deferred", "deferred_contract_mismatch", "manual_reconcile"].includes(settledTask.status);
  return {
    ok: settledTask.status === "ok",
    status: partial ? "partial" : settledTask.status,
    mode: "submit-continuation",
    message: settledTask.status === "cooling_down"
      ? "提报仍在冷却，已保存恢复时间"
      : partial
        ? "提报任务仍有待恢复项目"
        : "提报 continuation 已完成",
    runId: task.runId,
    operationId: args.operationId,
    rows: [], clues: [], products: [], prematches: [], executions: [], sourceHealth: [],
    details: [{
      shopId: settledTask.shopId,
      shopName: settledTask.shopName,
      status: settledTask.status,
      ok: settledTask.status === "ok",
      message: settledTask.status === "cooling_down" ? "提报仍在冷却，已保存恢复时间" : "提报 continuation 已结算",
      diagnostic: { taskId: settledTask.id, taskStatus: settledTask.status, resumeAt: settledTask.resumeAt }
    }],
    summary: {
      ...(pipelineRun?.summary || {}),
      retryableRemainingCount: pipelineTaskRetryableRemainingCount(settledTask),
      workerProcessed: workerResult.processed,
      schedulerBusy: workerResult.schedulerBusy === true ? 1 : 0
    }
  };
}

async function buildPipelineRunCachedResult(
  args: OpportunityArgs,
  pipelineRun: PipelineRunRecord,
  message: string
): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const [pipelineStoreRuns, pipelineCandidates] = await Promise.all([
    loadPipelineStoreRunsForRun(pipelineRun.runId),
    args.includeCandidates === false
      ? Promise.resolve([] as DoudianOpportunityPrematchCandidate[])
      : loadPipelineCandidatesForRun(pipelineRun.runId, latestPipelineCandidatePreviewLimit)
  ]);
  const storeRuns = pipelineStoreRuns.filter((item) => item.runId === pipelineRun.runId);
  const prematches = pipelineCandidates.filter((item) => item.pipelineRunId === pipelineRun.runId || item.sourceRunId === pipelineRun.runId);
  const candidateTotalCount = Number(pipelineRun.summary?.candidateCount || prematches.length);
  const summary = {
    ...(pipelineRun.summary || {}),
    candidateTotalCount,
    candidateLoadedCount: prematches.length,
    candidateListTruncated: candidateTotalCount > prematches.length ? 1 : 0
  };
  return {
    ...ledger,
    ok: pipelineRun.status === "ok",
    status: pipelineRun.status,
    pipelineStatus: pipelineRun.status,
    resultSource: "cached",
    mode: "latest",
    message,
    runId: pipelineRun.runId,
    operationId: pipelineRun.operationId,
    sourceRunId: pipelineRun.runId,
    shopIds: pipelineRun.shopIds,
    rows: [],
    clues: [],
    products: [],
    prematches,
    executions: [],
    details: storeRuns.map((storeRun, index) => ({
      tenantId: storeRun.tenantId,
      shopId: storeRun.shopId,
      shopName: storeRun.shopName,
      storeGeneration: storeRun.storeGeneration,
      status: storeRun.status,
      ok: storeRun.status === "ok" || storeRun.status === "skipped",
      message: pipelineStoreResultMessage(storeRun.skipReason) || storeRun.phase,
      diagnostic: {
        phase: storeRun.phase,
        productCount: storeRun.productCount,
        benefitProductCount: storeRun.benefitProductCount,
        benefitAcquiredExposure: storeRun.benefitAcquiredExposure,
        benefitEstimatedExposure: storeRun.benefitEstimatedExposure,
        benefitAcquiredExposureUnparsedCount: storeRun.benefitAcquiredExposureUnparsedCount,
        benefitEstimatedExposureUnparsedCount: storeRun.benefitEstimatedExposureUnparsedCount,
        clueCount: storeRun.clueCount,
        currentCategoryCount: storeRun.currentCategoryCount,
        effectiveCategoryCount: storeRun.effectiveCategoryCount,
        candidateCount: storeRun.candidateCount,
        eligibleCandidateCount: storeRun.eligibleCandidateCount,
        alternativeCandidateCount: storeRun.alternativeCandidateCount,
        qualifiedCandidateCount: storeRun.qualifiedCandidateCount,
        primaryCandidateCount: storeRun.primaryCandidateCount,
        fallbackCandidateCount: storeRun.fallbackCandidateCount,
        plannedSubmitCandidateCount: storeRun.plannedSubmitCandidateCount,
        primarySubmitCandidateCount: storeRun.primarySubmitCandidateCount,
        fallbackSubmitCandidateCount: storeRun.fallbackSubmitCandidateCount,
        dailyAttemptLimit: storeRun.dailyAttemptLimit,
        quotaUsedBefore: storeRun.quotaUsedBefore,
        quotaRemainingBefore: storeRun.quotaRemainingBefore,
        quotaRemainingAfterPlan: storeRun.quotaRemainingAfterPlan,
        quotaAttemptCount: storeRun.quotaAttemptCount,
        quotaRemainingAfterSubmit: storeRun.quotaRemainingAfterSubmit,
        submittedCount: storeRun.submittedCount,
        failedCount: storeRun.failedCount,
        safetySkippedCount: storeRun.safetySkippedCount,
        quotaExhaustedCount: storeRun.quotaExhaustedCount,
        cancelledCount: storeRun.cancelledCount,
        unknownCount: storeRun.unknownCount,
        remoteRequestCount: storeRun.remoteRequestCount,
        estimatedSubmitGroupCount: storeRun.estimatedSubmitGroupCount,
        estimatedSubmitDurationMs: storeRun.estimatedSubmitDurationMs
      },
      index: index + 1,
      total: storeRuns.length
    })),
    summary,
    scanSummary: summary,
    sourceHealth: [],
    filters: args.filters || pipelineRun.filters,
    matchRules: args.matchRules || pipelineRun.matchRules,
    pipelineOptions: pipelineRun.pipelineOptions,
    requestPlanHash: pipelineRun.requestPlanHash,
    storeRefs: (pipelineRun.storeRefs?.length ? pipelineRun.storeRefs : storeRuns.map((storeRun) => ({
      tenantId: storeRun.tenantId,
      shopId: storeRun.shopId,
      storeGeneration: storeRun.storeGeneration
    }))) as DoudianStoreIdentityRef[]
  };
}

export async function fetchOpportunityPipelineRun(args: OpportunityArgs = {}): Promise<DoudianOpportunityReportResult> {
  const runId = text(args.runId || args.operationId);
  const pipelineRun = runId
    ? await repositoryGet<PipelineRunRecord>(pipelineRunStore, runId).catch(() => null)
    : null;
  if (pipelineRun) {
    const refreshed = await refreshPipelineRunSummary(pipelineRun.runId).catch(() => null);
    return buildPipelineRunCachedResult(args, refreshed || pipelineRun, "已恢复本次商机提报数据");
  }
  const ledger = await listStoreLedger();
  return {
    ...ledger,
    ok: false,
    status: "missing",
    mode: "latest",
    message: runId ? "未找到本次商机提报数据" : "missing pipeline run id",
    runId,
    sourceRunId: runId,
    rows: [],
    clues: [],
    products: [],
    prematches: [],
    executions: [],
    details: [],
    summary: {},
    scanSummary: {},
    sourceHealth: [],
    filters: args.filters || {},
    matchRules: normalizeOpportunityMatchRules(args.matchRules),
    requestPlanHash: ""
  };
}

export async function fetchOpportunityPipelineSummary(args: OpportunityArgs = {}): Promise<DoudianOpportunityReportResult> {
  return fetchOpportunityPipelineRun({ ...args, includeCandidates: false });
}

export async function fetchOpportunityReportLatest(args: OpportunityArgs = {}): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const payload = adapterPayload(args);
  const latestPipeline = await repositoryLatest<PipelineRunRecord>(pipelineRunStore).catch(() => null);
  if (latestPipeline) {
    const refreshed = await refreshPipelineRunSummary(latestPipeline.runId).catch(() => null);
    if (refreshed) Object.assign(latestPipeline, refreshed);
    const [pipelineStoreRuns, pipelineCandidates] = await Promise.all([
      loadPipelineStoreRunsForRun(latestPipeline.runId),
      loadPipelineCandidatesForRun(latestPipeline.runId, latestPipelineCandidatePreviewLimit)
    ]);
    const storeRuns = pipelineStoreRuns.filter((item) => item.runId === latestPipeline.runId);
    const prematches = pipelineCandidates.filter((item) => item.pipelineRunId === latestPipeline.runId || item.sourceRunId === latestPipeline.runId);
    const candidateTotalCount = Number(latestPipeline.summary?.candidateCount || prematches.length);
    const summary = {
      ...(latestPipeline.summary || {}),
      candidateTotalCount,
      candidateLoadedCount: prematches.length,
      candidateListTruncated: candidateTotalCount > prematches.length ? 1 : 0
    };
    return {
      ...ledger,
      ok: latestPipeline.status === "ok",
      status: latestPipeline.status,
      pipelineStatus: latestPipeline.status,
      resultSource: "cached",
      mode: "latest",
      message: "已恢复最近一次商机提报数据",
      runId: latestPipeline.runId,
      operationId: latestPipeline.operationId,
      sourceRunId: latestPipeline.runId,
      shopIds: latestPipeline.shopIds,
      rows: [],
      clues: [],
      products: [],
      prematches,
      executions: [],
      details: storeRuns.map((storeRun, index) => ({
        tenantId: storeRun.tenantId,
        shopId: storeRun.shopId,
        shopName: storeRun.shopName,
        storeGeneration: storeRun.storeGeneration,
        status: storeRun.status,
        ok: storeRun.status === "ok" || storeRun.status === "skipped",
        message: pipelineStoreResultMessage(storeRun.skipReason) || storeRun.phase,
        diagnostic: {
        phase: storeRun.phase,
        productCount: storeRun.productCount,
        benefitProductCount: storeRun.benefitProductCount,
        benefitAcquiredExposure: storeRun.benefitAcquiredExposure,
        benefitEstimatedExposure: storeRun.benefitEstimatedExposure,
        benefitAcquiredExposureUnparsedCount: storeRun.benefitAcquiredExposureUnparsedCount,
        benefitEstimatedExposureUnparsedCount: storeRun.benefitEstimatedExposureUnparsedCount,
        clueCount: storeRun.clueCount,
          currentCategoryCount: storeRun.currentCategoryCount,
          effectiveCategoryCount: storeRun.effectiveCategoryCount,
          candidateCount: storeRun.candidateCount,
          eligibleCandidateCount: storeRun.eligibleCandidateCount,
          alternativeCandidateCount: storeRun.alternativeCandidateCount,
          qualifiedCandidateCount: storeRun.qualifiedCandidateCount,
          primaryCandidateCount: storeRun.primaryCandidateCount,
          fallbackCandidateCount: storeRun.fallbackCandidateCount,
          plannedSubmitCandidateCount: storeRun.plannedSubmitCandidateCount,
          primarySubmitCandidateCount: storeRun.primarySubmitCandidateCount,
          fallbackSubmitCandidateCount: storeRun.fallbackSubmitCandidateCount,
          dailyAttemptLimit: storeRun.dailyAttemptLimit,
          quotaUsedBefore: storeRun.quotaUsedBefore,
          quotaRemainingBefore: storeRun.quotaRemainingBefore,
          quotaRemainingAfterPlan: storeRun.quotaRemainingAfterPlan,
          quotaAttemptCount: storeRun.quotaAttemptCount,
          quotaRemainingAfterSubmit: storeRun.quotaRemainingAfterSubmit,
          submittedCount: storeRun.submittedCount,
          failedCount: storeRun.failedCount,
          safetySkippedCount: storeRun.safetySkippedCount,
          quotaExhaustedCount: storeRun.quotaExhaustedCount,
          cancelledCount: storeRun.cancelledCount,
          unknownCount: storeRun.unknownCount,
          remoteRequestCount: storeRun.remoteRequestCount,
          estimatedSubmitGroupCount: storeRun.estimatedSubmitGroupCount,
          estimatedSubmitDurationMs: storeRun.estimatedSubmitDurationMs
        },
        index: index + 1,
        total: storeRuns.length
      })),
      summary,
      scanSummary: summary,
      sourceHealth: [],
      filters: args.filters || latestPipeline.filters,
      matchRules: args.matchRules || latestPipeline.matchRules,
      requestPlanHash: latestPipeline.requestPlanHash,
      storeRefs: (latestPipeline.storeRefs?.length ? latestPipeline.storeRefs : storeRuns.map((storeRun) => ({
        tenantId: storeRun.tenantId,
        shopId: storeRun.shopId,
        storeGeneration: storeRun.storeGeneration
      }))) as DoudianStoreIdentityRef[]
    };
  }
  const [clueRuns, productRuns, prematchRuns, executeRuns] = await Promise.all([
    repositoryLatest<ClueScanRunRecord>(clueScanStore).catch(() => null),
    repositoryLatest<ProductScanRunRecord>(productScanStore).catch(() => null),
    repositoryLatest<PrematchRunRecord>(prematchRunStore).catch(() => null),
    repositoryLatest<ExecuteRunRecord>(opportunityExecuteStore).catch(() => null)
  ]);
  const latestClue = clueRuns;
  const latestProduct = productRuns;
  const latestPrematch = prematchRuns;
  const latestExecute = executeRuns;
  const latestClues = latestClue?.rows?.length ? latestClue.rows : await loadCluesForRun(latestClue?.runId || "");
  const latestProducts = latestProduct?.products?.length ? latestProduct.products : await loadProductsForRun(latestProduct?.runId || "");
  const latestPrematches = latestPrematch?.candidates?.length ? latestPrematch.candidates : await loadPrematchesForRun(latestPrematch?.runId || "");
  const limit = dailyAttemptLimit(args, payload.adapter);
  const usedByShop = await submitAttemptCountsByShop();
  const requestedShopIds = uniqueText(args.shopIds || []);
  const latestShopIds = uniqueText([
    ...requestedShopIds,
    ...(latestPrematches || []).map((candidate) => candidate.shopId),
    ...(latestExecute?.executions || []).map((execution) => execution.shopId)
  ]);
  const quotaShopIds = latestShopIds.length ? latestShopIds : (ledger.stores || []).map((store) => store.shopId);
  const used = quotaShopIds.reduce((sum, shopId) => sum + (usedByShop.get(shopId) || 0), 0);
  const remaining = quotaShopIds.reduce((sum, shopId) => sum + Math.max(0, limit - (usedByShop.get(shopId) || 0)), 0);
  return {
    ...ledger,
    ok: true,
    status: latestClue || latestProduct || latestPrematch || latestExecute ? "cached" : "empty",
    mode: "latest",
    message: latestClue || latestProduct || latestPrematch || latestExecute ? "已恢复最近一次商机提报数据" : "暂无商机提报缓存",
    runId: latestExecute?.runId || latestPrematch?.runId || latestClue?.runId || latestProduct?.runId,
    sourceRunId: latestPrematch?.runId || latestExecute?.sourceRunId || latestClue?.runId || latestProduct?.runId,
    productRunId: latestPrematch?.productRunId || latestProduct?.runId,
    clueRunId: latestPrematch?.clueRunId || latestClue?.runId,
    matchRunId: latestPrematch?.runId,
    rows: latestClues,
    clues: latestClues,
    products: latestProducts,
    prematches: latestPrematches,
    executions: latestExecute?.executions || [],
    details: latestExecute?.details || latestClue?.details || latestProduct?.details || [],
    summary: latestExecute?.summary || latestPrematch?.summary || latestClue?.scanSummary || latestProduct?.scanSummary || {},
    scanSummary: latestClue?.scanSummary || latestProduct?.scanSummary || {},
    sourceHealth: latestClue?.sourceHealth || latestProduct?.sourceHealth || [],
    filters: args.filters || latestPrematch?.filters || latestClue?.filters || latestProduct?.filters || {},
    matchRules: normalizeOpportunityMatchRules(args.matchRules),
    requestPlanHash: latestExecute?.requestPlanHash || latestPrematch?.requestPlanHash || latestClue?.requestPlanHash || latestProduct?.requestPlanHash || "",
    dailyAttemptLimit: limit,
    dailyAttemptUsed: used,
    dailyAttemptRemaining: remaining
  };
}

export async function listOpportunityPipelineCandidatesPage(args: {
  runId?: string;
  cursor?: string | null;
  pageSize?: number;
  onlyRequested?: boolean;
} = {}): Promise<DoudianOpportunityCandidatePage> {
  const runId = text(args.runId);
  const pageSize = Math.max(1, Math.min(200, Math.floor(Number(args.pageSize || 100))));
  if (!runId) {
    return { runId: "", items: [], nextCursor: null, hasMore: false, pageSize, totalCount: 0, loadedCount: 0 };
  }
  if (args.onlyRequested === true) {
    const candidates = await repositoryGetAllByPrefix<DoudianOpportunityPrematchCandidate>(
      pipelineCandidateStore,
      pipelineRunRecordPrefix(runId),
      { pageSize: 500, maxItems: 100000 }
    ).catch(() => []);
    const requestedCandidates = candidates.filter((candidate) => Boolean(text(candidate.submitAttemptId)));
    const cursorText = text(args.cursor);
    const cursorOffset = cursorText.startsWith("requested:") ? Math.max(0, Math.floor(Number(cursorText.slice("requested:".length)) || 0)) : 0;
    const items = requestedCandidates.slice(cursorOffset, cursorOffset + pageSize);
    const nextOffset = cursorOffset + items.length;
    return {
      runId,
      items,
      nextCursor: nextOffset < requestedCandidates.length ? `requested:${nextOffset}` : null,
      hasMore: nextOffset < requestedCandidates.length,
      pageSize,
      totalCount: requestedCandidates.length,
      loadedCount: items.length
    };
  }
  const [run, page] = await Promise.all([
    repositoryGet<PipelineRunRecord>(pipelineRunStore, runId).catch(() => null),
    repositoryListByPrefix<DoudianOpportunityPrematchCandidate>(
      pipelineCandidateStore,
      pipelineRunRecordPrefix(runId),
      { cursor: args.cursor || null, pageSize }
    ).catch(() => ({ items: [], nextCursor: null, hasMore: false }))
  ]);
  const totalCount = Number(run?.summary?.candidateCount || page.items.length);
  return {
    runId,
    items: page.items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    pageSize,
    totalCount,
    loadedCount: page.items.length
  };
}

export async function listOpportunityStoreCategoryLedger(args: { shopIds?: string[]; storeRefs?: DoudianStoreIdentityRef[] } = {}) {
  const requested = new Set((args.shopIds || []).map(text).filter(Boolean));
  const requestedRefs = new Set((args.storeRefs || []).map((ref) => `${text(ref.tenantId) || "local-user"}::${text(ref.shopId)}::${Math.max(1, Math.trunc(Number(ref.storeGeneration || 1)))}`));
  const rows = await repositoryGetAll<DoudianOpportunityStoreCategoryLedger>(storeCategoryLedgerStore).catch(() => []);
  return rows
    .filter((row) => requestedRefs.size
      ? requestedRefs.has(`${text(row.tenantId) || "local-user"}::${text(row.shopId)}::${Math.max(1, Math.trunc(Number(row.storeGeneration || 1)))}`)
      : (!requested.size || requested.has(row.shopId)))
    .sort((left, right) => {
      const time = String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || ""));
      if (time) return time;
      return Number(right.productCount || 0) - Number(left.productCount || 0);
    });
}

export async function restoreLatestOpportunityClueScan() {
  const latest = await repositoryLatest<ClueScanRunRecord>(clueScanStore);
  if (!latest) return null;
  if (latest.rows?.length) return latest;
  return { ...latest, rows: await loadCluesForRun(latest.runId) };
}

export async function restoreLatestOpportunityProductScan() {
  const latest = await repositoryLatest<ProductScanRunRecord>(productScanStore);
  if (!latest) return null;
  if (latest.products?.length) return latest;
  return { ...latest, products: await loadProductsForRun(latest.runId) };
}

export async function restoreLatestOpportunityExecute() {
  return repositoryLatest<ExecuteRunRecord>(opportunityExecuteStore);
}

export async function runDoudianOpportunityReportSelfCheck(options: { doudianAdapter?: DoudianAdapterPayload } = {}) {
  const payload = adapterPayload({ doudianAdapter: options.doudianAdapter });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopId = `opportunity-self-check-${suffix}`;
  const clueRunId = `opportunity-clue-self-check-${suffix}`;
  const productRunId = `opportunity-product-self-check-${suffix}`;
  const pipelineRunId = `opportunity-pipeline-self-check-${suffix}`;
  const submitRunId = `opportunity-submit-self-check-${suffix}`;
  const collectRunId = `opportunity-collect-self-check-${suffix}`;
  const mockClueId = `clue-${suffix}`;
  try {
    await upsertStoreLedger({
      shopId,
      shopName: `Opportunity Self Check ${suffix}`,
      platform: "doudian",
      partition: `persist:chihu-opportunity-self-check-${suffix}`,
      status: "online",
      groupName: "Self Check",
      adapterVersion: payload.adapter.version
    });
    const mockClue = {
      clue_detail: {
        clue_id: mockClueId,
        name: "Self Check Opportunity",
        short_name: "Self Check Opportunity",
        category_path: ["Self", "Check"],
        second_cid: "1002",
        clue_label_list: [{ label_name: "Test" }],
        profit_info_list: [{ profit_name: "Test Benefit" }]
      },
      clue_indicator: {
        search_pv_cnt: 1200,
        search_pv_cnt_range: "1000-2000",
        pay_amount_ind_30d_rate: 0.2,
        demand_supply_rate: 2.5,
        online_prod_cnt: 12,
        demand_heat_range: "High",
        pay_amount_ind: 30000
      }
    };
    const mockProduct = {
      product_id: `product-${suffix}`,
      title: "Self Check Opportunity Product",
      category_name: "Self>Check",
      category_id: "1002",
      price: 1999,
      stock_num: 20,
      sell_num: 3,
      audit_time: "2026-07-01"
    };
    const clueScan = await fetchOpportunityReport({
      doudianAdapter: payload,
      mode: "clue-scan",
      shopIds: [shopId],
      operationId: clueRunId,
      mockClues: [mockClue]
    });
    const productScan = await fetchOpportunityReport({
      doudianAdapter: payload,
      mode: "product-scan",
      shopIds: [shopId],
      operationId: productRunId,
      mockProducts: [mockProduct]
    });
    const submit = await fetchOpportunityReport({
      doudianAdapter: payload,
      mode: "clue-submit",
      shopIds: [shopId],
      operationId: submitRunId,
      sourceRunId: clueRunId,
      clueIds: (clueScan.clues || []).map((clue) => clue.id),
      mockProducts: [mockProduct],
      submitMode: "validate",
      goodsMatchType: "new",
      dryRun: true
    });
    const collect = await fetchOpportunityReport({
      doudianAdapter: payload,
      mode: "collect",
      shopIds: [shopId],
      operationId: collectRunId,
      sourceRunId: clueRunId,
      clueIds: (clueScan.clues || []).map((clue) => clue.id),
      dryRun: true
    });
    const pipeline = await fetchOpportunityReport({
      doudianAdapter: payload,
      mode: "pipeline-submit",
      shopIds: [shopId],
      operationId: pipelineRunId,
      mockClues: [mockClue],
      mockProducts: [mockProduct],
      mockOfficialClueWords: { [mockClueId]: ["Self Check Opportunity"] },
      mockOfficialProductsByClue: { [mockClueId]: [mockProduct] },
      mockOfficialWordsContract: { [mockClueId]: "alternative_terms" },
      mockOfficialGoodsContract: { [mockClueId]: "positive_only" },
      matchRules: { minTokenHitRatio: 0.33 },
      dryRun: true
    });
    await runSubmitWorker(payload, { doudianAdapter: payload, dryRun: true }).catch(() => undefined);
    const pipelineLatest = await fetchOpportunityReportLatest({ doudianAdapter: payload, matchRules: { minTokenHitRatio: 0.33 } });
    const restored = await fetchOpportunityReportLatest({ doudianAdapter: payload });
    const businessDateBoundaryOk = businessDateKey(new Date("2026-07-14T16:00:00.000Z")) === "2026-07-15" &&
      businessDateKey(new Date("2026-07-14T15:59:59.999Z")) === "2026-07-14";
    const sourceFailureClassificationOk = sourceHealthComplete([{ ok: true, status: 200 }, { ok: false, status: 500 }]) === false;
    return {
      ok: clueScan.ok === true &&
        productScan.ok === true &&
        submit.ok === true &&
        collect.ok === true &&
        (pipeline.prematches || []).length > 0 &&
        pipelineLatest.status === pipeline.status &&
        pipelineLatest.resultSource === "cached" &&
        restored.status === pipeline.status &&
        businessDateBoundaryOk &&
        sourceFailureClassificationOk,
      clueScanOk: clueScan.ok === true,
      productScanOk: productScan.ok === true,
      submitDryRunOk: submit.executions?.every((item) => item.status === "dry_run" || item.status === "skipped") === true,
      collectDryRunOk: collect.executions?.some((item) => item.status === "dry_run") === true,
      pipelineDryRunOk: (pipeline.prematches || []).length > 0,
      pipelineRestoreOk: pipelineLatest.status === pipeline.status && pipelineLatest.resultSource === "cached",
      restoreOk: restored.status === pipeline.status,
      businessDateBoundaryOk,
      sourceFailureClassificationOk,
      clueRunId,
      productRunId,
      pipelineRunId,
      executeRunIds: [submitRunId, collectRunId]
    };
  } finally {
    await deleteStoreLedger([shopId]).catch(() => undefined);
    await repositoryDelete(clueScanStore, clueRunId).catch(() => undefined);
    await repositoryDelete(productScanStore, productRunId).catch(() => undefined);
    await repositoryDelete(pipelineRunStore, pipelineRunId).catch(() => undefined);
    await repositoryDelete(opportunityExecuteStore, submitRunId).catch(() => undefined);
    await repositoryDelete(opportunityExecuteStore, collectRunId).catch(() => undefined);
    const clues = await repositoryGetAll<DoudianOpportunityClueRow>(clueCandidateStore).catch(() => []);
    await Promise.all(clues.filter((clue) => clue.sourceRunId === clueRunId).map((clue) => repositoryDelete(clueCandidateStore, clue.id).catch(() => undefined)));
    const products = await repositoryGetAll<DoudianOpportunityProductRow>(productCandidateStore).catch(() => []);
    await Promise.all(products.filter((product) => product.sourceRunId === productRunId).map((product) => repositoryDelete(productCandidateStore, product.id).catch(() => undefined)));
    const scope = `${"local-user"}-${shopId}-1`;
    const [storeRuns, snapshots, ledgers, candidates, tasks, events, clueCaches, clueShards, wordCaches, wordShards] = await Promise.all([
      loadPipelineStoreRunsForRun(pipelineRunId),
      repositoryGetAll<StoreCategorySnapshotRecord>(storeCategorySnapshotStore).catch(() => []),
      repositoryGetAll<StoreCategoryLedgerRecord>(storeCategoryLedgerStore).catch(() => []),
      loadPipelineCandidatesForRun(pipelineRunId, 10000),
      loadPipelineSubmitTasksForRun(pipelineRunId),
      repositoryGetAllByPrefix<PipelineOperationEventRecord>(pipelineOperationEventStore, pipelineRunRecordPrefix(pipelineRunId), { pageSize: 500, maxItems: 10000 }).catch(() => []),
      repositoryGetAll<ClueCacheRecord>(clueCacheStore).catch(() => []),
      repositoryGetAll<ClueCacheShardRecord>(clueCacheShardStore).catch(() => []),
      repositoryGetAll<ClueWordCacheRecord>(clueWordCacheStore).catch(() => []),
      repositoryGetAll<ClueWordCacheShardRecord>(clueWordCacheShardStore).catch(() => [])
    ]);
    const selfCheckClueCacheIds = new Set(clueCaches.filter((item) => item.scopeId === scope || item.sourceShopId === shopId).map((item) => item.id));
    const selfCheckWordCacheIds = new Set(wordCaches.filter((item) => selfCheckClueCacheIds.has(item.clueCacheKey)).map((item) => item.id));
    await Promise.all([
      ...storeRuns.filter((item) => item.runId === pipelineRunId).map((item) => repositoryDelete(pipelineStoreRunStore, item.id).catch(() => undefined)),
      ...snapshots.filter((item) => item.runId === pipelineRunId || item.shopId === shopId).map((item) => repositoryDelete(storeCategorySnapshotStore, item.id).catch(() => undefined)),
      ...ledgers.filter((item) => item.shopId === shopId).map((item) => repositoryDelete(storeCategoryLedgerStore, item.id).catch(() => undefined)),
      ...candidates.filter((item) => item.pipelineRunId === pipelineRunId || item.sourceRunId === pipelineRunId).map((item) => repositoryDelete(pipelineCandidateStore, item.id).catch(() => undefined)),
      ...tasks.filter((item) => item.runId === pipelineRunId || item.shopId === shopId).map((item) => repositoryDelete(pipelineSubmitTaskStore, item.id).catch(() => undefined)),
      ...events.filter((item) => item.runId === pipelineRunId || item.shopId === shopId).map((item) => repositoryDelete(pipelineOperationEventStore, item.id).catch(() => undefined)),
      ...clueCaches.filter((item) => selfCheckClueCacheIds.has(item.id)).map((item) => repositoryDelete(clueCacheStore, item.id).catch(() => undefined)),
      ...clueShards.filter((item) => selfCheckClueCacheIds.has(item.clueCacheKey)).map((item) => repositoryDelete(clueCacheShardStore, item.id).catch(() => undefined)),
      ...wordCaches.filter((item) => selfCheckWordCacheIds.has(item.id)).map((item) => repositoryDelete(clueWordCacheStore, item.id).catch(() => undefined)),
      ...wordShards.filter((item) => selfCheckWordCacheIds.has(item.wordCacheKey)).map((item) => repositoryDelete(clueWordCacheShardStore, item.id).catch(() => undefined))
    ]);
  }
}
