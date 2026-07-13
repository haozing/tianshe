import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianOpportunityClueRow,
  DoudianOpportunityExecution,
  DoudianOpportunityFilters,
  DoudianOpportunityGoodsMatchType,
  DoudianOpportunityMatchRules,
  DoudianOpportunityPrematchCandidate,
  DoudianOpportunityPrematchMode,
  DoudianOpportunityProductRow,
  DoudianOpportunityReportResult,
  DoudianOpportunityStoreCategoryLedger,
  DoudianOpportunitySubmitMode,
  DoudianOpportunityTitleMatchMode,
  DoudianOpportunityTitleUpdatePosition,
  DoudianRunDetail,
  DoudianStoreSummary
} from "../../types";
import { repositoryDelete, repositoryGet, repositoryGetAll, repositoryGetAllByPrefix, repositoryGetMany, repositoryPut, repositoryPutMany } from "./repository";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";
import { prepareMutationSafety, recordExecutionMutationResults } from "./mutationSafety";
import { getChihuNative } from "../../native/client";

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
const pipelineCandidateStore = "opportunity_pipeline_candidates_v2" as const;
const pipelineSubmitTaskStore = "opportunity_pipeline_submit_tasks_v2" as const;
const pipelineOperationEventStore = "opportunity_pipeline_operation_events_v2" as const;

const defaultActiveKey = "11,MATCH_DEGREE";
const submitBatchSizeFallback = 40;
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
let pipelineSubmitWorkerRunning = false;

interface OpportunityArgs {
  doudianAdapter?: DoudianAdapterPayload;
  mode?: string;
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
  mockClues?: Array<Record<string, unknown>>;
  mockProducts?: Array<Record<string, unknown>>;
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
  shopIds: string[];
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
  createdAt: string;
  updatedAt: string;
}

interface PipelineStoreRunRecord extends PipelineStoreIdentity {
  id: string;
  runId: string;
  status: string;
  phase: "product-scan" | "category-ledger" | "clue-load" | "tokenize" | "match" | "submit-queued" | "submitting" | "finished";
  productCount: number;
  currentCategoryCount: number;
  effectiveCategoryCount: number;
  clueCount: number;
  tokenCount: number;
  candidateCount: number;
  eligibleCandidateCount?: number;
  submittedCount: number;
  failedCount: number;
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
  status: "queued" | "running" | "ok" | "partial" | "failed" | "cancelled";
  concurrencyKey: string;
  ownerRunId?: string;
  candidateIds: string[];
  candidateCount: number;
  submittedCount: number;
  skippedCount: number;
  failedCount: number;
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
  shardCount: number;
  rowCount: number;
  remoteTotal: number;
  sourceHealth: Array<Record<string, unknown>>;
  sourceShopId: string;
  shopScoped: boolean;
  clueWordsSource: "realtime" | "clueWordsApi" | "mixed";
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
  createdAt: string;
  updatedAt: string;
}

interface ClueWordCacheShardRecord {
  id: string;
  wordCacheKey: string;
  clueCacheKey: string;
  shardNo: number;
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

function text(value: unknown) {
  return String(value ?? "").trim();
}

function platformIntId(value: unknown) {
  const raw = text(value);
  if (!/^\d+$/.test(raw)) return raw;
  const next = Number(raw);
  return Number.isSafeInteger(next) ? next : raw;
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

function nowIso() {
  return new Date().toISOString();
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    return new Date(ms).toISOString().slice(0, 10);
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
  const clueId = text(detail.clue_id || detail.clueId || raw.clue_id || raw.clueId || detail.id);
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
  if (code == null || code === "") return response.ok === true;
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
  const planKeys = ["opportunityClueRealtimeList", "opportunityClueWords", "opportunitySubmitClue", "opportunityProductList"];
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
      fields: objectRecord(mappings(adapter).fields)
    },
    policies: {
      cluePageSize: policy(adapter, "opportunityReport.cluePageSize"),
      maxCluePages: policy(adapter, "opportunityReport.maxCluePages"),
      productPageSize: policy(adapter, "opportunityReport.productPageSize"),
      maxProductListPages: policy(adapter, "opportunityReport.maxProductListPages"),
      enableRemoteClueWords: policy(adapter, "opportunityReport.enableRemoteClueWords")
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
    pageSize: Math.max(10, Math.min(100, Math.floor(Number(filters.pageSize || policyNumber(adapter, "opportunityReport.cluePageSize", 72, 10, 100))))),
    maxPages: Math.max(1, Math.min(10, Math.floor(Number(filters.maxPages || filters.cluePage || policyNumber(adapter, "opportunityReport.maxCluePages", 2, 1, 10))))),
    sortField: sortField || "MATCH_DEGREE",
    sortDirection: 1
  };
}

function stableFilterHash(filters: DoudianOpportunityFilters = {}, adapter: DoudianAdapterConfig) {
  return stableHash(normalizedClueFilter(filters, adapter));
}

function stableMatchRulesHash(args: OpportunityArgs) {
  const rules = normalizeOpportunityMatchRules(args.matchRules);
  return stableHash({
    storeCategoryKeys: [...(rules.storeCategoryKeys || [])].sort(),
    minTokenHitRatio: rules.minTokenHitRatio,
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
    "opportunityClueRealtimeList",
    "opportunityClueWords",
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
    ["productTotalPaths", ["opportunityProductList.data.total", "opportunityProductList.total"]]
  ];
  for (const [key, fallback] of requiredListMappings) {
    if (!mappingArray(adapter, key, fallback).length) missing.push(`responseMappings.opportunityReport.${key}`);
  }
  if (!mappingArray(adapter, "clueWordPaths", ["data.data", "data", "data.words", "data.list", "words", "list"]).length) {
    missing.push("responseMappings.opportunityReport.clueWordPaths");
  }
  const requiredFields: Array<[string, string[]]> = [
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
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().slice(0, 10);
}

function productListContext(filters: DoudianOpportunityFilters = {}, page: number, pageSize: number, categoryLeafId = "") {
  return {
    page: String(page),
    pageSize: String(pageSize),
    keyword: text(filters.keyword),
    categoryLeafId: text(categoryLeafId || filters.categoryLeafId),
    startTime: text(filters.startTime || thirtyDaysAgo()),
    endTime: text(filters.endTime || new Date().toISOString().slice(0, 10))
  };
}

async function scanCluesForStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, args: OpportunityArgs, runId: string, index: number, total: number) {
  const planKey = "opportunityClueRealtimeList";
  const pageSize = policyNumber(payload.adapter, "opportunityReport.cluePageSize", 72, 10, 100);
  const maxPages = Math.max(1, Math.min(10, Math.floor(Number(args.maxPages || args.filters?.maxPages || args.filters?.cluePage || policyNumber(payload.adapter, "opportunityReport.maxCluePages", 2, 1, 10)))));
  const rawRows: Record<string, unknown>[] = [];
  const responses: Record<string, RequestPlanResult> = {};
  const sourceHealth: Array<Record<string, unknown>> = [];
  let remoteTotal = 0;

  if (args.mockClues?.length) {
    rawRows.push(...args.mockClues);
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
      rawRows.push(...rows);
      remoteTotal = readTotal(wrapped, payload.adapter, "clueTotalPaths") || remoteTotal;
      const ok = planOk(response, payload.adapter, planKey);
      sourceHealth.push({ key: responseKey, status: response.status, ok, count: rows.length });
      if (!ok || !rows.length) break;
      if (remoteTotal && rawRows.length >= remoteTotal) break;
    }
  }

  const rows = rawRows.map((row, rowIndex) => normalizeClue(store, row, payload.adapter, runId, rowIndex)).filter((row): row is DoudianOpportunityClueRow => Boolean(row));
  const ok = args.mockClues?.length ? true : sourceHealth.some((item) => item.ok === true);
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
      rowCount: rows.length,
      sourceHealth
    },
    index,
    total
  };
  return { rows, detail, sourceHealth, remoteTotal };
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
  const maxPages = Math.max(1, Math.min(50, Math.floor(Number(args.maxPages || args.filters?.maxPages || policyNumber(payload.adapter, "opportunityReport.maxProductListPages", 10, 1, 50)))));
  const pageStart = policyNumber(payload.adapter, "opportunityReport.productPageStart", 0, 0, 1);
  const rawRows: Record<string, unknown>[] = [];
  const sourceHealth: Array<Record<string, unknown>> = [];
  let remoteTotal = 0;

  if (args.mockProducts?.length) {
    rawRows.push(...args.mockProducts);
  } else {
    for (let page = pageStart; page < pageStart + maxPages; page += 1) {
      const context = productListContext(args.filters, page, pageSize, categoryLeafId);
      const response = await runDoudianRequestPlan(payload, { partition: store.partition, planKey, context });
      const responseKey = page === pageStart ? planKey : `${planKey}:page:${page}`;
      const wrapped = { [planKey]: response.data };
      const rows = firstArray(wrapped, mappingArray(payload.adapter, "productListPaths", [
        "opportunityProductList.data",
        "opportunityProductList.data.list",
        "opportunityProductList.list"
      ])).map(objectRecord);
      rawRows.push(...rows);
      remoteTotal = readTotal(wrapped, payload.adapter, "productTotalPaths") || remoteTotal;
      const ok = planOk(response, payload.adapter, planKey);
      sourceHealth.push({ key: responseKey, status: response.status, ok, count: rows.length });
      if (!ok || !rows.length) break;
      if (remoteTotal && rawRows.length >= remoteTotal) break;
    }
  }

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
  const ok = args.mockProducts?.length ? true : sourceHealth.some((item) => item.ok === true);
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
      productCount: products.length,
      sourceHealth
    },
    index,
    total
  };
  return { products, detail, sourceHealth, remoteTotal };
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

function pipelineCacheScope(adapter: DoudianAdapterConfig): "shop" | "global" {
  const requested = policyText(adapter, "opportunityReport.pipelineCacheScope", "shop").toLocaleLowerCase();
  const globalEnabled = policyBoolean(adapter, "opportunityReport.enableGlobalPipelineCache", false);
  return requested === "global" && globalEnabled ? "global" : "shop";
}

function pipelineScopeId(cacheScope: "shop" | "global", identity: PipelineStoreIdentity) {
  return cacheScope === "global" ? "global" : storeScopeId(identity);
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

async function loadPipelineSubmitTasksForRun(runId: string, maxItems = 10000) {
  const id = text(runId);
  if (!id) return [];
  return repositoryGetAllByPrefix<PipelineSubmitTaskRecord>(
    pipelineSubmitTaskStore,
    pipelineRunRecordPrefix(id),
    { pageSize: 500, maxItems }
  ).catch(() => []);
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
  return stableHash(["clue-v2", args.cacheScope, args.scopeId, args.adapterVersion, args.requestPlanHash, args.categoryKey, args.filterHash].join("|"));
}

function wordCacheKey(clueCacheKeyValue: string, tokenizerVersion: string, stopwordVersion: string) {
  return stableHash(["word-v2", clueCacheKeyValue, tokenizerVersion, stopwordVersion].join("|"));
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

async function loadClueCacheRows(cacheKey: string, store: DoudianStoreSummary, runId: string) {
  const shards = (await repositoryGetAll<ClueCacheShardRecord>(clueCacheShardStore).catch(() => []))
    .filter((item) => item.clueCacheKey === cacheKey)
    .sort((left, right) => left.shardNo - right.shardNo);
  return shards.flatMap((shard) => shard.rows || []).map((row, index) => materializeCachedClue(row, store, runId, index));
}

function sourceHealthSucceeded(sourceHealth: Array<Record<string, unknown>> = []) {
  return sourceHealth.some((item) => {
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
  const words = await queryClueWords(payload, store, clue, dryRun).catch(() => []);
  return uniqueText([...base, ...words, ...(clue.recommendList || []), ...(clue.profitInfoList || [])]).filter((word) => word.length > 1);
}

async function fetchCluesForCategory(args: {
  payload: DoudianAdapterPayload;
  store: DoudianStoreSummary;
  runId: string;
  filters: DoudianOpportunityFilters;
  category: StoreCategorySummary;
  dryRun?: boolean;
  mockClues?: Array<Record<string, unknown>>;
}) {
  const planKey = "opportunityClueRealtimeList";
  const normalized = normalizedClueFilter(args.filters, args.payload.adapter);
  const pageSize = normalized.pageSize;
  const maxPages = normalized.maxPages;
  const rawRows: Record<string, unknown>[] = [];
  const sourceHealth: Array<Record<string, unknown>> = [];
  let remoteTotal = 0;
  if (args.mockClues?.length) {
    rawRows.push(...args.mockClues);
    remoteTotal = args.mockClues.length;
    sourceHealth.push({ key: `${planKey}:${args.category.categoryKey}:mock`, status: 200, ok: true, count: args.mockClues.length, categoryKey: args.category.categoryKey });
  } else {
    for (let page = 1; page <= maxPages; page += 1) {
    const body = buildClueSearchBody(filtersForStoreCategory(args.filters, args.category), page, pageSize);
    const response = await runDoudianRequestPlan(args.payload, { partition: args.store.partition, planKey, context: bodyContext(body) });
    const responseKey = page === 1 ? `${planKey}:${args.category.categoryKey}` : `${planKey}:${args.category.categoryKey}:page:${page}`;
    const wrapped = { [planKey]: response.data };
    const rows = firstArray(wrapped, mappingArray(args.payload.adapter, "clueListPaths", [
      "opportunityClueRealtimeList.data",
      "opportunityClueRealtimeList.data.data",
      "opportunityClueRealtimeList.list"
    ])).map(objectRecord);
    rawRows.push(...rows);
    remoteTotal = readTotal(wrapped, args.payload.adapter, "clueTotalPaths") || remoteTotal;
    const ok = planOk(response, args.payload.adapter, planKey);
    sourceHealth.push({ key: responseKey, status: response.status, ok, count: rows.length, categoryKey: args.category.categoryKey });
    if (!ok || !rows.length) break;
    if (remoteTotal && rawRows.length >= remoteTotal) break;
    }
  }
  const rows = rawRows
    .map((row, rowIndex) => normalizeClue(args.store, row, args.payload.adapter, args.runId, rowIndex))
    .filter((row): row is DoudianOpportunityClueRow => Boolean(row));
  return { rows: mergeClues(rows), sourceHealth, remoteTotal };
}

async function loadCluesByCategoryWithCache(args: {
  payload: DoudianAdapterPayload;
  store: DoudianStoreSummary;
  identity: PipelineStoreIdentity;
  runId: string;
  filters: DoudianOpportunityFilters;
  category: StoreCategorySummary;
  dryRun?: boolean;
  mockClues?: Array<Record<string, unknown>>;
}) {
  const categoryKey = cacheCategoryKey(args.category);
  const cacheScope = pipelineCacheScope(args.payload.adapter);
  const scopeId = pipelineScopeId(cacheScope, args.identity);
  if (!categoryKey) {
    return { cacheKey: "", cacheScope, scopeId, rows: [] as DoudianOpportunityClueRow[], sourceHealth: [], remoteTotal: 0, cacheHit: false, skipReason: "missing-category-id" };
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
  if (cached && (!cached.expiresAt || String(cached.expiresAt) > now)) {
    const cachedRows = await loadClueCacheRows(key, args.store, args.runId);
    const allowEmptyCacheHit = policyBoolean(args.payload.adapter, "opportunityReport.allowEmptyClueCacheHit", false);
    if (!sourceHealthFailed(cached.sourceHealth) && (cachedRows.length || allowEmptyCacheHit)) {
      return {
        cacheKey: key,
        cacheScope,
        scopeId,
        rows: cachedRows,
        sourceHealth: [{ key: "opportunityClueCache", ok: true, cacheHit: true, categoryKey, cacheScope, scopeId, rowCount: cachedRows.length }],
        remoteTotal: cached.remoteTotal,
        cacheHit: true
      };
    }
  }

  const fetched = await fetchCluesForCategory({
    payload: args.payload,
    store: args.store,
    runId: args.runId,
    filters: args.filters,
    category: args.category,
    dryRun: args.dryRun,
    mockClues: args.mockClues
  });
  const fetchedSourceOk = args.mockClues?.length ? true : sourceHealthSucceeded(fetched.sourceHealth);
  if (!fetchedSourceOk) {
    return { cacheKey: key, cacheScope, scopeId, rows: [], sourceHealth: fetched.sourceHealth, remoteTotal: fetched.remoteTotal, cacheHit: false };
  }
  const rows: DoudianOpportunityClueRow[] = [];
  let clueWordsApiCount = 0;
  for (const [index, clue] of fetched.rows.entries()) {
    const words = await loadClueWordsForCache(args.payload, args.store, clue, args.dryRun);
    if (words.length) clueWordsApiCount += 1;
    rows.push({
      ...clue,
      id: `${args.runId}-${clue.clueId}`,
      clueWords: words,
      raw: { ...(clue.raw || {}), __cache_miss: true, __row_index: index }
    });
  }
  const allowEmptyCacheWrite = policyBoolean(args.payload.adapter, "opportunityReport.allowEmptyClueCacheWrite", false);
  if (!rows.length && !allowEmptyCacheWrite) {
    return { cacheKey: key, cacheScope, scopeId, rows, sourceHealth: fetched.sourceHealth, remoteTotal: fetched.remoteTotal, cacheHit: false };
  }
  const cacheRows = rows.map(cacheableClueRow);
  const shards = chunk(cacheRows, 100).map((items, index) => ({
    id: `${key}-${index + 1}`,
    clueCacheKey: key,
    categoryKey,
    filterHash,
    cacheScope,
    scopeId,
    shardNo: index + 1,
    rows: items,
    rowCount: items.length,
    createdAt: now,
    updatedAt: now
  } satisfies ClueCacheShardRecord));
  const ttlHours = policyNumber(args.payload.adapter, "opportunityReport.clueCacheTtlHours", 24, 1, 168);
  await repositoryPut(clueCacheStore, {
    id: key,
    ...args.identity,
    categoryKey,
    filterHash,
    requestPlanHash: planHash,
    adapterVersion: args.payload.adapter.version || "",
    cacheScope,
    scopeId,
    shardCount: shards.length,
    rowCount: rows.length,
    remoteTotal: fetched.remoteTotal,
    sourceHealth: fetched.sourceHealth,
    sourceShopId: args.identity.shopId,
    shopScoped: cacheScope === "shop",
    clueWordsSource: clueWordsApiCount ? "mixed" : "realtime",
    clueWordsRequestHash: stableHash({
      adapterVersion: args.payload.adapter.version || "",
      plan: args.payload.adapter.requestPlans?.opportunityClueWords || {},
      endpoint: args.payload.adapter.endpoints?.[text(objectRecord(args.payload.adapter.requestPlans?.opportunityClueWords).endpointKey || "opportunityClueWords")] || ""
    }),
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString(),
    createdAt: now,
    updatedAt: now
  } satisfies ClueCacheRecord);
  await repositoryPutMany(clueCacheShardStore, shards, { concurrency: 2 });
  return { cacheKey: key, cacheScope, scopeId, rows, sourceHealth: fetched.sourceHealth, remoteTotal: fetched.remoteTotal, cacheHit: false };
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
  if (!record) return null;
  const shards = (await repositoryGetAll<ClueWordCacheShardRecord>(clueWordCacheShardStore).catch(() => []))
    .filter((item) => item.wordCacheKey === wordCacheKeyValue)
    .sort((left, right) => left.shardNo - right.shardNo);
  const tokenToClueIds: Record<string, string[]> = {};
  const clueTokens: Record<string, string[]> = {};
  const tokens: string[] = [];
  for (const shard of shards) {
    for (const token of shard.tokens || []) tokens.push(token);
    Object.assign(tokenToClueIds, shard.tokenToClueIds || {});
    Object.assign(clueTokens, shard.clueTokens || {});
  }
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
  const existing = (await repositoryGetAll<ClueWordCacheRecord>(clueWordCacheStore).catch(() => []))
    .filter((item) => item.clueCacheKey === args.clueCacheKey)
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
    wordCacheKey: wordCacheKey(args.clueCacheKey, segmented.tokenizerVersion, segmented.stopwordVersion),
    tokenizerVersion: segmented.tokenizerVersion,
    stopwordVersion: segmented.stopwordVersion,
    tokens,
    tokenToClueIds: Object.fromEntries(Array.from(tokenToClueIds.entries()).map(([token, clueSet]) => [token, Array.from(clueSet)])),
    clueTokens
  };
  const now = nowIso();
  const tokenShards = chunk(tokens, 500);
  const shards = tokenShards.map((tokenList, index) => {
    const shardTokenToClueIds = Object.fromEntries(tokenList.map((token) => [token, tokenIndex.tokenToClueIds[token] || []]));
    const shardClueTokens: Record<string, string[]> = {};
    const clueIdsInShard = new Set(Object.values(shardTokenToClueIds).flat());
    for (const clueId of clueIdsInShard) shardClueTokens[clueId] = tokenIndex.clueTokens[clueId] || [];
    return {
      id: `${tokenIndex.wordCacheKey}-${index + 1}`,
      wordCacheKey: tokenIndex.wordCacheKey,
      clueCacheKey: args.clueCacheKey,
      shardNo: index + 1,
      tokens: tokenList,
      tokenToClueIds: shardTokenToClueIds,
      clueTokens: shardClueTokens,
      createdAt: now,
      updatedAt: now
    } satisfies ClueWordCacheShardRecord;
  });
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
    createdAt: now,
    updatedAt: now
  } satisfies ClueWordCacheRecord);
  await repositoryPutMany(clueWordCacheShardStore, shards, { concurrency: 2 });
  return tokenIndex;
}

function tokenMatchesTitle(title: string, token: string) {
  return text(title).toLocaleLowerCase().includes(text(token).toLocaleLowerCase());
}

function matchStoreProductsByTokens(args: {
  runId: string;
  storeRunId: string;
  clueCacheKey: string;
  wordCacheKey: string;
  effectiveCategoryKey: string;
  products: DoudianOpportunityProductRow[];
  clues: DoudianOpportunityClueRow[];
  tokenIndex: TokenIndex;
  minTokenHitRatio: number;
  matchRulesHash: string;
  opportunityArgs: OpportunityArgs;
  dedupeIndex: SubmitDedupeIndex;
}) {
  const clueById = new Map(args.clues.map((clue) => [clue.clueId, clue]));
  const candidates: DoudianOpportunityPrematchCandidate[] = [];
  const productCategoryKeys = new Set([args.effectiveCategoryKey]);
  for (const product of args.products) {
    if (!productCategoryKeys.has(cacheCategoryKey({
      categoryId: text(product.categoryId),
      categoryName: text(product.categoryName || product.category),
      categoryPath: product.categoryPath || normalizeCategoryPath(product.category),
      lastCategoryKey: text(product.lastCategoryKey)
    }))) continue;
    const hitTokens = args.tokenIndex.tokens.filter((token) => tokenMatchesTitle(product.title, token));
    if (!hitTokens.length) continue;
    const matchedByClue = new Map<string, Set<string>>();
    for (const token of hitTokens) {
      for (const clueId of args.tokenIndex.tokenToClueIds[token] || []) {
        const set = matchedByClue.get(clueId) || new Set<string>();
        set.add(token);
        matchedByClue.set(clueId, set);
      }
    }
    for (const [clueId, tokenSet] of matchedByClue.entries()) {
      const clue = clueById.get(clueId);
      if (!clue) continue;
      const clueTokens = uniqueText(args.tokenIndex.clueTokens[clueId] || []);
      const effectiveTokenCount = clueTokens.length;
      if (effectiveTokenCount <= 0) continue;
      const matchedTokens = Array.from(tokenSet);
      const matchedTokenCount = matchedTokens.length;
      const requiredTokenHits = Math.max(1, Math.ceil(effectiveTokenCount * args.minTokenHitRatio));
      if (matchedTokenCount < requiredTokenHits) continue;
      const tokenHitRatio = matchedTokenCount / effectiveTokenCount;
      const categoryScore = 32;
      const wordScore = Math.round(Math.min(1, tokenHitRatio) * 58);
      const nameScore = clue.name && tokenMatchesTitle(product.title, clue.name) ? 10 : 0;
      const matchScore = Math.min(100, categoryScore + wordScore + nameScore);
      const submittedSkipReason = shouldSkipSubmittedCandidate(args.opportunityArgs, args.dedupeIndex, {
        shopId: product.shopId,
        clueId: clue.clueId,
        productId: product.productId,
        clueLastCategoryId: clue.lastCategoryId
      });
      const eligible = !submittedSkipReason;
      const id = `${args.runId}-${product.shopId}-${product.productId}-${clue.clueId}`;
      candidates.push({
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
        effectiveTokenCount,
        matchedTokenCount,
        requiredTokenHits,
        tokenHitRatio,
        minTokenHitRatio: args.minTokenHitRatio,
        matchRulesHash: args.matchRulesHash,
        matchMode: prematchMode(args.opportunityArgs),
        matchScore,
        categoryScore,
        wordScore,
        eligible,
        estimatedCost: eligible ? 1 : 0,
        skipReason: submittedSkipReason,
        status: eligible ? "ready" : "skipped",
        raw: {
          product,
          productRaw: product.raw || {},
          clue,
          clueRaw: clue.raw || {},
          matchRulesHash: args.matchRulesHash
        }
      });
    }
  }
  const sorted = candidates.sort((left, right) => right.matchScore - left.matchScore);
  const bestByProduct = new Set<string>();
  return sorted.map((candidate) => {
    if (!candidate.eligible) return candidate;
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
}

async function enqueueStoreSubmit(args: {
  runId: string;
  storeRunId: string;
  identity: PipelineStoreIdentity;
  candidates: DoudianOpportunityPrematchCandidate[];
}) {
  const candidateIds = args.candidates.filter((item) => item.eligible && item.status === "ready").map((item) => item.id);
  if (!candidateIds.length) return null;
  const concurrencyKey = storeScopeId(args.identity);
  const active = (await repositoryGetAll<PipelineSubmitTaskRecord>(pipelineSubmitTaskStore).catch(() => []))
    .find((task) => task.concurrencyKey === concurrencyKey && (task.status === "queued" || task.status === "running"));
  if (active) return active;
  const now = nowIso();
  const task: PipelineSubmitTaskRecord = {
    id: `${args.storeRunId}-task-1`,
    runId: args.runId,
    storeRunId: args.storeRunId,
    ...args.identity,
    status: "queued",
    concurrencyKey,
    ownerRunId: args.runId,
    candidateIds,
    candidateCount: candidateIds.length,
    submittedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    createdAt: now,
    updatedAt: now
  };
  await repositoryPut(pipelineSubmitTaskStore, task);
  return task;
}

async function refreshPipelineRunSummary(runId: string) {
  const run = await repositoryGet<PipelineRunRecord>(pipelineRunStore, runId).catch(() => null);
  if (!run) return null;
  const [storeRuns, tasks] = await Promise.all([
    loadPipelineStoreRunsForRun(runId),
    loadPipelineSubmitTasksForRun(runId)
  ]);
  const scopedStoreRuns = storeRuns.filter((item) => item.runId === runId);
  const scopedTasks = tasks.filter((item) => item.runId === runId);
  const submittedCount = scopedTasks.reduce((sum, item) => sum + Number(item.submittedCount || 0), 0);
  const failedStoreCount = scopedStoreRuns.filter((item) => item.status === "failed").length;
  const taskFailedCount = scopedTasks.reduce((sum, item) => sum + Number(item.failedCount || 0), 0);
  const failedCount = failedStoreCount + taskFailedCount;
  const skippedCount =
    scopedStoreRuns.filter((item) => item.status === "skipped").length +
    scopedTasks.reduce((sum, item) => sum + Number(item.skippedCount || 0), 0);
  const candidateCount = scopedStoreRuns.reduce((sum, item) => sum + Number(item.candidateCount || 0), 0);
  const eligibleCandidateCount = scopedTasks.reduce((sum, item) => sum + Number(item.candidateCount || 0), 0);
  const runningCount =
    scopedTasks.filter((item) => item.status === "queued" || item.status === "running").length +
    scopedStoreRuns.filter((item) => item.status === "queued" || item.status === "running").length;
  const status: PipelineRunRecord["status"] = runningCount
    ? "running"
    : failedCount
      ? (submittedCount || skippedCount ? "partial" : "failed")
      : "ok";
  const summary = {
    ...(run.summary || {}),
    productCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.productCount || 0), 0),
    currentCategoryCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.currentCategoryCount || 0), 0),
    effectiveCategoryCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.effectiveCategoryCount || 0), 0),
    clueCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.clueCount || 0), 0),
    tokenCount: scopedStoreRuns.reduce((sum, item) => sum + Number(item.tokenCount || 0), 0),
    candidateCount,
    eligibleCandidateCount,
    submitTaskCount: scopedTasks.length,
    submittedCount,
    failedCount,
    skippedCount,
    processedStoreCount: scopedStoreRuns.length,
    totalStoreCount: run.totalStoreCount
  };
  const updated = {
    ...run,
    status,
    processedStoreCount: scopedStoreRuns.length,
    submittedCount,
    skippedCount,
    failedCount,
    summary,
    updatedAt: nowIso()
  } satisfies PipelineRunRecord;
  await repositoryPut(pipelineRunStore, updated);
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
  return {
    storeCategoryKeys: uniqueText(value.storeCategoryKeys || []),
    minTokenHitRatio: Number.isFinite(ratio) ? Math.max(0.1, Math.min(1, ratio)) : 0.33
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
  return new Date().toISOString().slice(0, 10);
}

function dailyAttemptLimit(args: OpportunityArgs, adapter: DoudianAdapterConfig) {
  return Math.max(1, Math.min(10000, Math.floor(Number(args.dailyAttemptLimit || policyNumber(adapter, "opportunityReport.dailyAttemptLimit", 1000, 1, 10000)))));
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

async function listSubmitAttempts(date = todayKey()) {
  const attempts = await repositoryGetAll<SubmitAttemptRecord>(submitAttemptStore).catch(() => []);
  return attempts.filter((item) => item.date === date);
}

interface SubmitDedupeIndex {
  relationKeys: Set<string>;
  clueKeys: Set<string>;
  clueCategoryKeys: Set<string>;
}

async function submittedDedupeIndex(): Promise<SubmitDedupeIndex> {
  const relationKeys = new Set<string>();
  const clueKeys = new Set<string>();
  const clueCategoryKeys = new Set<string>();
  const attempts = await repositoryGetAll<SubmitAttemptRecord>(submitAttemptStore).catch(() => []);
  attempts.forEach((item) => {
    relationKeys.add(relationKey(item));
    clueKeys.add(clueKey(item));
    if (item.clueLastCategoryId) clueCategoryKeys.add(clueCategoryKey(item));
  });
  const runs = await repositoryGetAll<ExecuteRunRecord>(opportunityExecuteStore).catch(() => []);
  for (const run of runs) {
    for (const item of run.executions || []) {
      if (item.stage === "submit" && item.planKey === "opportunitySubmitClue") {
        relationKeys.add(relationKey(item));
        clueKeys.add(clueKey(item));
      }
    }
  }
  return { relationKeys, clueKeys, clueCategoryKeys };
}

async function attemptedRelationKeys() {
  return (await submittedDedupeIndex()).relationKeys;
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

function candidateToProduct(candidate: DoudianOpportunityPrematchCandidate): DoudianOpportunityProductRow {
  const raw = objectRecord(candidate.raw);
  const product = objectRecord(raw.product);
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
    raw: objectRecord(raw.productRaw)
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

  const dedupeIndex = await submittedDedupeIndex();
  const candidates: DoudianOpportunityPrematchCandidate[] = [];
  const wordCache = new Map<string, string[]>();
  for (const clue of limitedClues) {
    const words = wordCache.get(clue.clueId) || await prematchClueWords(payload, stores, clue, args.dryRun);
    wordCache.set(clue.clueId, words);
    for (const shop of clue.shopList) {
      const shopProducts = productsByShop.get(shop.shopId) || [];
      for (const product of shopProducts) {
        const scored = scorePrematchCandidate({ product, clue, words, mode });
        let eligible = scored.eligible;
        let skipReason = scored.skipReason;
        const submittedSkipReason = eligible
          ? shouldSkipSubmittedCandidate(args, dedupeIndex, {
            shopId: product.shopId,
            clueId: clue.clueId,
            productId: product.productId,
            clueLastCategoryId: clue.lastCategoryId
          })
          : "";
        if (submittedSkipReason) {
          eligible = false;
          skipReason = submittedSkipReason;
        }
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

  const sorted = candidates.sort((left, right) => right.matchScore - left.matchScore);
  const bestByProduct = new Set<string>();
  const deduped = sorted.map((candidate) => {
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
  }).slice(0, maxCandidates);

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
  const todayAttempts = await listSubmitAttempts();
  const limit = dailyAttemptLimit(args, payload.adapter);
  const summary = {
    productCount: limitedProducts.length,
    clueCount: limitedClues.length,
    candidateCount: deduped.length,
    eligibleCount: deduped.filter((candidate) => candidate.eligible).length,
    skippedCount: deduped.filter((candidate) => !candidate.eligible).length,
    estimatedCost: deduped.reduce((sum, candidate) => sum + Number(candidate.estimatedCost || 0), 0),
    dailyAttemptLimit: limit,
    dailyAttemptUsed: todayAttempts.length,
    dailyAttemptRemaining: Math.max(0, limit - todayAttempts.length)
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
    dailyAttemptUsed: todayAttempts.length,
    dailyAttemptRemaining: Math.max(0, limit - todayAttempts.length)
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

async function queryClueWords(payload: DoudianAdapterPayload, store: DoudianStoreSummary, clue: DoudianOpportunityClueRow, dryRun = false) {
  const fallback = baseClueWords(clue);
  if (dryRun || !policyBoolean(payload.adapter, "opportunityReport.enableRemoteClueWords", false)) return fallback;
  const planKey = "opportunityClueWords";
  const body = { clue_id: platformIntId(clue.clueId) };
  const response = await runDoudianRequestPlan(payload, {
    partition: store.partition,
    planKey,
    context: bodyContext(body)
  });
  const words = firstArray(response.data, mappingArray(payload.adapter, "clueWordPaths", ["data.data", "data", "data.words", "data.list", "words", "list"])).map((item) => {
    if (typeof item === "string" || typeof item === "number") return text(item);
    const record = objectRecord(item);
    return text(record.word || record.name || record.clue_word || record.clueWord || record.keyword || record.title);
  }).filter(Boolean);
  return uniqueText(words.length ? words : fallback);
}

function rawPriceCents(product: DoudianOpportunityProductRow) {
  const raw = product.raw || {};
  const rawPrice = coerceNumber(raw.price || raw.min_price || raw.minPrice || raw.product_price_min || raw.productPriceMin);
  if (rawPrice !== undefined && rawPrice > 999) return Math.floor(rawPrice);
  return Math.floor(Number(product.price || 0) * 100);
}

function submitProductPayload(product: DoudianOpportunityProductRow, store: DoudianStoreSummary) {
  const raw = product.raw || {};
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
  return {
    product_id: product.productId,
    title: product.title,
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
    brand_id: text(raw.brand_id || raw.brandId),
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
  return !message || status === 429 || status === 502 || status === 504 || message.includes("频繁") || message.includes("系统") || message.includes("network");
}

function normalizedSubmitMessage(message: string) {
  if (message.includes("访问过于频繁") || message.includes("环境存在风险")) return "商机中心存在环境风控，暂无法提报";
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

async function submitWithRetry(payload: DoudianAdapterPayload, store: DoudianStoreSummary, body: Record<string, unknown>) {
  const planKey = "opportunitySubmitClue";
  const retryLimit = policyNumber(payload.adapter, "opportunityReport.submitRetryLimit", 3, 1, 5);
  const retryDelay = policyNumber(payload.adapter, "opportunityReport.submitRetryDelayMs", 5900, 0, 30000);
  let response: RequestPlanResult | undefined;
  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    response = await runDoudianRequestPlan(payload, { partition: store.partition, planKey, context: bodyContext(body) });
    const message = responseMessage(response);
    if (submitResponseOk(response) || !transientSubmitMessage(message, response)) break;
    if (attempt < retryLimit - 1 && retryDelay) await wait(retryDelay);
  }
  return response;
}

async function editTitles(payload: DoudianAdapterPayload, store: DoudianStoreSummary, products: DoudianOpportunityProductRow[], nextTitles: Map<string, string>, dryRun = false) {
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
    context: bodyContext(body)
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
    planKey: args.planKey
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
    dryRun: args.dryRun
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
      planKey: entry.planKey || "opportunitySubmitClue"
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
  const edit = await editTitles(args.payload, args.store, safeProducts, filtered.nextTitles, args.dryRun);
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
      const response = await submitWithRetry(args.payload, args.store, submitBody(args.clue, batch, args.store, args.module));
      const ok = submitResponseOk(response);
      const message = ok ? "商机提报已提交" : normalizedSubmitMessage(responseMessage(response));
      const failureMessages = ok ? new Map<string, string>() : productFailureMessages(message);
      const hasBatchFailureItems = batch.some((product) => failureMessages.has(product.productId));
      if (!ok && hasBatchFailureItems) {
        const failedProducts = batch.filter((product) => failureMessages.has(product.productId));
        const submittedProducts = batch.filter((product) => !failureMessages.has(product.productId));
        if (submittedProducts.length) {
          executions.push(...executionForProducts({
            runId: args.runId,
            sourceRunId: args.sourceRunId,
            store: args.store,
            clue: args.clue,
            products: submittedProducts,
            status: "submitted",
            ok: true,
            message: "商机提报已提交",
            planKey: "opportunitySubmitClue",
            stage: "submit"
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
            stage: "submit"
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
          stage: "submit"
        }));
      }
    }
    if (batchIndex < batches.length - 1 && delayMs && !args.dryRun) await wait(delayMs);
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
          dryRun: args.dryRun
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
          dryRun: args.dryRun
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
  const submitExecutions = args.executions.filter((item) => item.stage === "submit" && item.planKey === "opportunitySubmitClue");
  await repositoryPutMany(submitAttemptStore, submitExecutions.map((item) => ({
    id: `${date}-${args.runId}-${args.candidate.id}-${item.productId || args.candidate.productId}`,
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
    status: item.status,
    ok: item.ok,
    message: item.message,
    createdAt: now
  } satisfies SubmitAttemptRecord)));
  return submitExecutions.length;
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
  let used = (await listSubmitAttempts()).length;
  const dedupeIndex = await submittedDedupeIndex();
  const candidates = (await loadPrematchCandidates(args))
    .filter((candidate) => candidate.eligible && candidate.status !== "submitted")
    .sort((left, right) => right.matchScore - left.matchScore);
  const executions: DoudianOpportunityExecution[] = [];
  const details: DoudianRunDetail[] = [];
  const updatedCandidates: DoudianOpportunityPrematchCandidate[] = [];

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
      dailyAttemptUsed: used,
      dailyAttemptRemaining: Math.max(0, limit - used)
    };
  }

  for (const candidate of candidates) {
    const remaining = Math.max(0, limit - used);
    if (remaining <= 0) {
      const skipped = {
        ...candidate,
        eligible: false,
        estimatedCost: 0,
        status: "skipped",
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
        status: "skipped",
        ok: true,
        message: "今日提报尝试额度不足，已跳过",
        diagnostic: { dailyAttemptLimit: limit, dailyAttemptUsed: used }
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
      dryRun: args.dryRun
    });
    const attempts = args.dryRun ? 0 : await recordSubmitAttempts({ runId, matchRunId, candidate, executions: nextExecutions });
    used += attempts;
    executions.push(...nextExecutions.map((item) => ({
      ...item,
      diagnostic: {
        ...(item.diagnostic || {}),
        prematchCandidateId: candidate.id,
        matchScore: candidate.matchScore,
        matchedWords: candidate.matchedWords,
        dailyAttemptUsed: used,
        dailyAttemptLimit: limit
      }
    })));
    const candidateExecutions = executions.slice(beforeCount);
    const failed = candidateExecutions.some((item) => item.ok === false);
    const submitted = candidateExecutions.some((item) => item.stage === "submit" && item.ok === true);
    const skipped = !submitted && candidateExecutions.every((item) => item.status === "skipped" || item.status === "dry_run");
    const updated = {
      ...candidate,
      status: submitted ? "submitted" : failed ? "failed" : skipped ? "skipped" : candidate.status,
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
    dailyAttemptUsed: used,
    dailyAttemptRemaining: Math.max(0, limit - used)
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
  return {
    executionCount: executions.length,
    successCount: executions.filter((item) => item.ok).length,
    failureCount: executions.filter((item) => item.ok === false).length,
    skippedCount: executions.filter((item) => item.status === "skipped").length,
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
  const successCount = args.details.filter((detail) => detail.ok).length || (summary.failureCount ? 0 : 1);
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

async function runSubmitWorker(payload: DoudianAdapterPayload, args: OpportunityArgs = {}) {
  if (pipelineSubmitWorkerRunning) return { ok: true, skipped: true, reason: "worker-running" };
  pipelineSubmitWorkerRunning = true;
  try {
    const ledger = await listStoreLedger();
    const stores = ledger.stores || [];
    let processed = 0;
    while (true) {
      const nowMs = Date.now();
      const tasks = (await repositoryGetAll<PipelineSubmitTaskRecord>(pipelineSubmitTaskStore).catch(() => []))
        .filter((task) => task.status === "queued" || (task.status === "running" && (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) < nowMs)))
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
      if (!tasks.length) break;
      const activeKeys = new Set<string>();
      let processedThisPass = 0;
      for (const task of tasks) {
      if (activeKeys.has(task.concurrencyKey)) continue;
      activeKeys.add(task.concurrencyKey);
      const startedAt = nowIso();
      await repositoryPut(pipelineSubmitTaskStore, {
        ...task,
        status: "running",
        startedAt: task.startedAt || startedAt,
        leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        updatedAt: startedAt
      } satisfies PipelineSubmitTaskRecord);
      const store = stores.find((item) => item.shopId === task.shopId);
      const taskCandidateIdSet = new Set(task.candidateIds);
      const taskCandidates = (await repositoryGetMany<DoudianOpportunityPrematchCandidate>(pipelineCandidateStore, task.candidateIds).catch(() => []))
        .filter((candidate) => taskCandidateIdSet.has(candidate.id));
      const updatedCandidates: DoudianOpportunityPrematchCandidate[] = [];
      const executions: DoudianOpportunityExecution[] = [];
      let submittedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;
      try {
        if (!store) throw new Error("Selected store is missing login partition");
        const limit = dailyAttemptLimit(args, payload.adapter);
        let used = (await listSubmitAttempts()).length;
        const dedupeIndex = await submittedDedupeIndex();
        for (const candidate of taskCandidates) {
          if (!candidate.eligible || candidate.status !== "ready") {
            skippedCount += 1;
            updatedCandidates.push(candidate);
            continue;
          }
          const remaining = Math.max(0, limit - used);
          const submittedSkipReason = remaining <= 0
            ? "今日提报尝试额度不足"
            : shouldSkipSubmittedCandidate(args, dedupeIndex, candidate);
          if (submittedSkipReason) {
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
          const nextExecutions = await submitProductsForClue({
            payload,
            store,
            clue: candidateToClue(candidate),
            products: [candidateToProduct(candidate)],
            runId: task.runId,
            sourceRunId: task.runId,
            submitMode: submitMode(args),
            titleMatchMode: titleMatchMode(args),
            titleUpdatePosition: titleUpdatePosition(args),
            module: "search_page_query",
            dryRun: args.dryRun,
            validatedByPipeline: true,
            pipelineWords: candidate.clueWords
          });
          const attempts = args.dryRun ? 0 : await recordSubmitAttempts({ runId: task.runId, matchRunId: task.runId, candidate, executions: nextExecutions });
          used += attempts;
          executions.push(...nextExecutions.map((item) => ({
            ...item,
            diagnostic: {
              ...(item.diagnostic || {}),
              pipelineCandidateId: candidate.id,
              tokenHitRatio: candidate.tokenHitRatio,
              matchedTokens: candidate.matchedTokens,
              dailyAttemptUsed: used,
              dailyAttemptLimit: limit
            }
          })));
          const failed = nextExecutions.some((item) => item.ok === false);
          const submitted = nextExecutions.some((item) => item.stage === "submit" && item.ok === true);
          if (submitted) submittedCount += 1;
          if (failed) failedCount += 1;
          if (!submitted && !failed) skippedCount += 1;
          updatedCandidates.push({
            ...candidate,
            status: submitted ? "submitted" : failed ? "failed" : "skipped",
            submitStatus: submitted ? "submitted" : failed ? "failed" : "skipped",
            skipReason: failed ? nextExecutions.find((item) => item.ok === false)?.message : candidate.skipReason,
            submittedAt: submitted ? nowIso() : undefined
          });
        }
        if (updatedCandidates.length) await repositoryPutMany(pipelineCandidateStore, updatedCandidates, { concurrency: 2 });
        const finalStatus = failedCount ? (submittedCount || skippedCount ? "partial" : "failed") : "ok";
        const finishedAt = nowIso();
        await repositoryPut(pipelineSubmitTaskStore, {
          ...task,
          status: finalStatus,
          submittedCount,
          skippedCount,
          failedCount,
          leaseExpiresAt: undefined,
          finishedAt,
          updatedAt: finishedAt
        } satisfies PipelineSubmitTaskRecord);
        const storeRun = await repositoryGet<PipelineStoreRunRecord>(pipelineStoreRunStore, task.storeRunId).catch(() => null);
        if (storeRun) {
          await repositoryPut(pipelineStoreRunStore, {
            ...storeRun,
            status: finalStatus,
            phase: "finished",
            submittedCount,
            failedCount,
            updatedAt: finishedAt,
            finishedAt
          } satisfies PipelineStoreRunRecord);
        }
        await writePipelineEvent({
          runId: task.runId,
          storeRunId: task.storeRunId,
          shopId: task.shopId,
          level: failedCount ? "warn" : "info",
          event: "pipeline-submit-task-finished",
          message: failedCount ? "商机提报部分失败" : "商机提报任务完成",
          detail: { submittedCount, skippedCount, failedCount, executionCount: executions.length }
        }).catch(() => undefined);
        await refreshPipelineRunSummary(task.runId).catch(() => null);
      } catch (error) {
        failedCount = Math.max(1, failedCount);
        const failedAt = nowIso();
        await repositoryPut(pipelineSubmitTaskStore, {
          ...task,
          status: "failed",
          submittedCount,
          skippedCount,
          failedCount,
          leaseExpiresAt: undefined,
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: failedAt,
          updatedAt: failedAt
        } satisfies PipelineSubmitTaskRecord);
        await writePipelineEvent({
          runId: task.runId,
          storeRunId: task.storeRunId,
          shopId: task.shopId,
          level: "error",
          event: "pipeline-submit-task-failed",
          message: error instanceof Error ? error.message : String(error),
          detail: { submittedCount, skippedCount, failedCount }
        }).catch(() => undefined);
        await refreshPipelineRunSummary(task.runId).catch(() => null);
      }
      processed += 1;
      processedThisPass += 1;
      }
      if (!processedThisPass) break;
    }
    return { ok: true, processed };
  } finally {
    pipelineSubmitWorkerRunning = false;
  }
}

async function fetchPipelineSubmit(payload: DoudianAdapterPayload, args: OpportunityArgs): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds);
  const runId = args.operationId || `opportunity-pipeline-submit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

  const now = nowIso();
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
  let eligibleCandidateCount = 0;
  const pipelineClues: DoudianOpportunityClueRow[] = [];
  const pipelineCandidates: DoudianOpportunityPrematchCandidate[] = [];
  const matchRulesHash = stableMatchRulesHash(args);
  const dedupeIndex = await submittedDedupeIndex();

  await repositoryPut(pipelineRunStore, {
    id: runId,
    runId,
    operationId: args.operationId,
    mode: "pipeline-submit",
    filters,
    matchRules,
    shopIds: targets.map((store) => store.shopId),
    tenantId: normalizePipelineStoreIdentity(targets[0]).tenantId,
    clientCapability,
    status: "running",
    totalStoreCount: targets.length,
    processedStoreCount: 0,
    submittedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    summary: {},
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    requestPlanHash: requestPlanHash(payload.adapter),
    createdAt: now,
    updatedAt: now
  } satisfies PipelineRunRecord);

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

  for (const [index, store] of targets.entries()) {
    const identity = normalizePipelineStoreIdentity(store);
    const id = storeRunId(runId, identity);
    const startedAt = nowIso();
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
      submittedCount: 0,
      failedCount: 0,
      startedAt,
      updatedAt: startedAt
    } satisfies PipelineStoreRunRecord);
    try {
      const scan = await scanProductsForStore(payload, store, args, runId, index + 1, targets.length);
      products.push(...scan.products);
      sourceHealth.push(...scan.sourceHealth);
      const extracted = extractCurrentStoreCategories(scan.products);
      const effective = effectiveStoreCategories(extracted.categories, matchRules);
      currentCategoryCount += extracted.categories.length;
      effectiveCategoryCount += effective.length;
      await saveStoreCategorySnapshot({
        runId,
        identity,
        categories: extracted.categories,
        productCount: scan.products.length,
        missingCategoryProductCount: extracted.missingCategoryProductCount,
        createdAt: nowIso()
      });
      await upsertStoreCategoryLedger({ identity, categories: extracted.categories, seenAt: nowIso() });

      let storeClueCount = 0;
      let storeTokenCount = 0;
      const storeCandidates: DoudianOpportunityPrematchCandidate[] = [];
      const storeSourceHealth = [...scan.sourceHealth];
      const missingCategoryIdCategories = effective.filter((category) => !text(category.categoryId));
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
        const clueResult = await loadCluesByCategoryWithCache({
          payload,
          store,
          identity,
          runId,
          filters,
          category,
          dryRun: args.dryRun,
          mockClues: args.mockClues
        });
        storeSourceHealth.push(...clueResult.sourceHealth);
        sourceHealth.push(...clueResult.sourceHealth);
        if (!clueResult.rows.length || !clueResult.cacheKey) continue;
        pipelineClues.push(...clueResult.rows);
        storeClueCount += clueResult.rows.length;
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
        storeCandidates.push(...matchStoreProductsByTokens({
          runId,
          storeRunId: id,
          clueCacheKey: clueResult.cacheKey,
          wordCacheKey: tokenIndex.wordCacheKey,
          effectiveCategoryKey: categoryKey,
          products: scan.products,
          clues: clueResult.rows,
          tokenIndex,
          minTokenHitRatio: Number(matchRules.minTokenHitRatio || 0.33),
          matchRulesHash,
          opportunityArgs: args,
          dedupeIndex
        }));
      }
      const bestByProduct = new Set<string>();
      const dedupedStoreCandidates = storeCandidates
        .sort((left, right) => right.matchScore - left.matchScore)
        .map((candidate) => {
          if (!candidate.eligible) return candidate;
          const key = `${candidate.shopId}::${candidate.productId}`;
          if (!bestByProduct.has(key)) {
            bestByProduct.add(key);
            return candidate;
          }
          return { ...candidate, eligible: false, estimatedCost: 0, status: "skipped", skipReason: "同商品已有更高分商机" };
        });
      if (dedupedStoreCandidates.length) {
        await repositoryPutMany(pipelineCandidateStore, dedupedStoreCandidates, { concurrency: 2 });
        pipelineCandidates.push(...dedupedStoreCandidates);
      }
      const task = await enqueueStoreSubmit({
        runId,
        storeRunId: id,
        identity,
        candidates: dedupedStoreCandidates
      });
      if (task) {
        submitTaskCount += 1;
        const queuedCandidates = dedupedStoreCandidates.map((candidate) => candidate.eligible && candidate.status === "ready"
          ? { ...candidate, submitTaskId: task.id, submitStatus: "queued" }
          : candidate);
        await repositoryPutMany(pipelineCandidateStore, queuedCandidates, { concurrency: 2 });
        for (const queued of queuedCandidates) {
          const indexInRun = pipelineCandidates.findIndex((candidate) => candidate.id === queued.id);
          if (indexInRun >= 0) pipelineCandidates[indexInRun] = queued;
        }
        void runSubmitWorker(payload, args).catch(() => undefined);
      }
      const eligibleCount = dedupedStoreCandidates.filter((candidate) => candidate.eligible && candidate.status === "ready").length;
      let skipReason = "";
      if (!effective.length) skipReason = "no-effective-category";
      else if (!storeClueCount) skipReason = "no-clue-for-effective-category";
      else if (!dedupedStoreCandidates.length) skipReason = "no-token-match-candidate";
      else if (!eligibleCount) skipReason = "no-eligible-candidate";
      if (skipReason) skippedCount += 1;
      clueCount += storeClueCount;
      tokenCount += storeTokenCount;
      candidateCount += dedupedStoreCandidates.length;
      eligibleCandidateCount += eligibleCount;
      processedStoreCount += 1;
      const finishedAt = nowIso();
      await repositoryPut(pipelineStoreRunStore, {
        id,
        runId,
        ...identity,
        status: task ? "queued" : skipReason ? "skipped" : "ok",
        phase: task ? "submit-queued" : "finished",
        productCount: scan.products.length,
        currentCategoryCount: extracted.categories.length,
        effectiveCategoryCount: effective.length,
        clueCount: storeClueCount,
        tokenCount: storeTokenCount,
        candidateCount: dedupedStoreCandidates.length,
        eligibleCandidateCount: eligibleCount,
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
        message: task ? "商机候选已生成并进入提报队列" : skipReason ? "店铺未生成可提报任务" : "店铺商机提报处理完成",
        detail: {
          productCount: scan.products.length,
          currentCategoryCount: extracted.categories.length,
          effectiveCategoryCount: effective.length,
          missingCategoryProductCount: extracted.missingCategoryProductCount,
          clueCount: storeClueCount,
          tokenCount: storeTokenCount,
          candidateCount: dedupedStoreCandidates.length,
          eligibleCount,
          submitTaskId: task?.id
        }
      }).catch(() => undefined);
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        status: task ? "queued" : skipReason ? "skipped" : "ok",
        ok: !skipReason,
        message: task ? "已生成候选并进入提报队列" : skipReason ? "未生成可提报任务" : "店铺商机提报处理完成",
        reason: skipReason,
        diagnostic: {
          productCount: scan.products.length,
          currentCategoryCount: extracted.categories.length,
          effectiveCategoryCount: effective.length,
          missingCategoryProductCount: extracted.missingCategoryProductCount,
          effectiveCategoryKeys: effective.map((category) => category.categoryKey),
          clueCount: storeClueCount,
          tokenCount: storeTokenCount,
          candidateCount: dedupedStoreCandidates.length,
          eligibleCount,
          submitTaskId: task?.id
        },
        index: index + 1,
        total: targets.length
      });
    } catch (error) {
      failedCount += 1;
      const failedAt = nowIso();
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
        submittedCount: 0,
        failedCount: 1,
        skipReason: "pipeline-product-scan-failed",
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
        detail: { phase: "product-scan" }
      }).catch(() => undefined);
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        status: "failed",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        reason: "pipeline-product-scan-failed",
        category: "api",
        index: index + 1,
        total: targets.length
      });
    }
  }

  const status = failedCount
    ? (processedStoreCount ? "partial" : "failed")
    : submitTaskCount
      ? "running"
      : "ok";
  const summary = {
    productCount: products.length,
    currentCategoryCount,
    effectiveCategoryCount,
    clueCount,
    tokenCount,
    candidateCount,
    eligibleCandidateCount,
    submitTaskCount,
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
    shopIds: targets.map((store) => store.shopId),
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
  const finalSummary = refreshedRun?.summary || summary;

  return {
    ...ledger,
    ok: finalStatus === "ok",
    status: finalStatus,
    mode: "pipeline-submit",
    message: submitTaskCount
      ? "商机提报已生成候选并进入提报队列，提报 worker 正在后台推进"
      : failedCount
        ? "商机提报商品/类目阶段部分失败"
        : "商机提报处理完成",
    runId,
    operationId: args.operationId,
    rows: pipelineClues,
    clues: pipelineClues,
    products,
    prematches: pipelineCandidates,
    executions: [],
    details,
    successCount: details.filter((detail) => detail.ok).length,
    failureCount: failedCount,
    partialCount: submitTaskCount,
    summary: finalSummary,
    scanSummary: finalSummary,
    sourceHealth,
    filters,
    matchRules,
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
  if (mode === "clue-submit") return fetchClueSubmit(payload, args);
  if (mode === "product-submit") return fetchProductSubmit(payload, args);
  if (mode === "prematch-submit") return fetchPrematchSubmit(payload, args);
  if (mode === "collect") return fetchCollect(payload, args);
  if (mode === "latest") return fetchOpportunityReportLatest(args);
  return { ok: false, status: "unsupported-mode", mode, message: "unsupported opportunity report mode", rows: [], clues: [], products: [], executions: [] };
}

export async function fetchOpportunityReportLatest(args: OpportunityArgs = {}): Promise<DoudianOpportunityReportResult> {
  const ledger = await listStoreLedger();
  const payload = adapterPayload(args);
  const pipelineRuns = await repositoryGetAll<PipelineRunRecord>(pipelineRunStore).catch(() => []);
  const latestPipeline = pipelineRuns.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  if (latestPipeline) {
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
      status: "cached",
      mode: "latest",
      message: "已恢复最近一次商机提报数据",
      runId: latestPipeline.runId,
      operationId: latestPipeline.operationId,
      sourceRunId: latestPipeline.runId,
      rows: [],
      clues: [],
      products: [],
      prematches,
      executions: [],
      details: storeRuns.map((storeRun, index) => ({
        shopId: storeRun.shopId,
        shopName: storeRun.shopName,
        status: storeRun.status,
        ok: storeRun.status === "ok" || storeRun.status === "skipped",
        message: storeRun.skipReason || storeRun.phase,
        diagnostic: {
          phase: storeRun.phase,
          productCount: storeRun.productCount,
          currentCategoryCount: storeRun.currentCategoryCount,
          effectiveCategoryCount: storeRun.effectiveCategoryCount,
          candidateCount: storeRun.candidateCount,
          eligibleCandidateCount: storeRun.eligibleCandidateCount
        },
        index: index + 1,
        total: storeRuns.length
      })),
      summary,
      scanSummary: summary,
      sourceHealth: [],
      filters: args.filters || latestPipeline.filters,
      matchRules: args.matchRules || latestPipeline.matchRules,
      requestPlanHash: latestPipeline.requestPlanHash
    };
  }
  const [clueRuns, productRuns, prematchRuns, executeRuns] = await Promise.all([
    repositoryGetAll<ClueScanRunRecord>(clueScanStore).catch(() => []),
    repositoryGetAll<ProductScanRunRecord>(productScanStore).catch(() => []),
    repositoryGetAll<PrematchRunRecord>(prematchRunStore).catch(() => []),
    repositoryGetAll<ExecuteRunRecord>(opportunityExecuteStore).catch(() => [])
  ]);
  const latestClue = clueRuns.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  const latestProduct = productRuns.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  const latestPrematch = prematchRuns.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  const latestExecute = executeRuns.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  const latestClues = latestClue?.rows?.length ? latestClue.rows : await loadCluesForRun(latestClue?.runId || "");
  const latestProducts = latestProduct?.products?.length ? latestProduct.products : await loadProductsForRun(latestProduct?.runId || "");
  const latestPrematches = latestPrematch?.candidates?.length ? latestPrematch.candidates : await loadPrematchesForRun(latestPrematch?.runId || "");
  const limit = dailyAttemptLimit(args, payload.adapter);
  const used = (await listSubmitAttempts()).length;
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
    dailyAttemptRemaining: Math.max(0, limit - used)
  };
}

export async function listOpportunityStoreCategoryLedger(args: { shopIds?: string[] } = {}) {
  const requested = new Set((args.shopIds || []).map(text).filter(Boolean));
  const rows = await repositoryGetAll<DoudianOpportunityStoreCategoryLedger>(storeCategoryLedgerStore).catch(() => []);
  return rows
    .filter((row) => !requested.size || requested.has(row.shopId))
    .sort((left, right) => {
      const time = String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || ""));
      if (time) return time;
      return Number(right.productCount || 0) - Number(left.productCount || 0);
    });
}

export async function restoreLatestOpportunityClueScan() {
  const runs = await repositoryGetAll<ClueScanRunRecord>(clueScanStore);
  const latest = runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  if (!latest) return null;
  if (latest.rows?.length) return latest;
  return { ...latest, rows: await loadCluesForRun(latest.runId) };
}

export async function restoreLatestOpportunityProductScan() {
  const runs = await repositoryGetAll<ProductScanRunRecord>(productScanStore);
  const latest = runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  if (!latest) return null;
  if (latest.products?.length) return latest;
  return { ...latest, products: await loadProductsForRun(latest.runId) };
}

export async function restoreLatestOpportunityExecute() {
  const runs = await repositoryGetAll<ExecuteRunRecord>(opportunityExecuteStore);
  return runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
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
        clue_id: `clue-${suffix}`,
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
      matchRules: { minTokenHitRatio: 0.33 },
      dryRun: true
    });
    await runSubmitWorker(payload, { doudianAdapter: payload, dryRun: true }).catch(() => undefined);
    const pipelineLatest = await fetchOpportunityReportLatest({ doudianAdapter: payload, matchRules: { minTokenHitRatio: 0.33 } });
    const restored = await fetchOpportunityReportLatest({ doudianAdapter: payload });
    return {
      ok: clueScan.ok === true &&
        productScan.ok === true &&
        submit.ok === true &&
        collect.ok === true &&
        (pipeline.prematches || []).length > 0 &&
        pipelineLatest.status === "cached" &&
        restored.status === "cached",
      clueScanOk: clueScan.ok === true,
      productScanOk: productScan.ok === true,
      submitDryRunOk: submit.executions?.every((item) => item.status === "dry_run" || item.status === "skipped") === true,
      collectDryRunOk: collect.executions?.some((item) => item.status === "dry_run") === true,
      pipelineDryRunOk: (pipeline.prematches || []).length > 0,
      pipelineRestoreOk: pipelineLatest.status === "cached",
      restoreOk: restored.status === "cached",
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
