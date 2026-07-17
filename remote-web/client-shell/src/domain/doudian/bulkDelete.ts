import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianBulkDeleteAction,
  DoudianBulkDeleteCandidate,
  DoudianBulkDeleteExecution,
  DoudianBulkDeleteFilters,
  DoudianBulkDeleteImportItem,
  DoudianBulkDeleteProgress,
  DoudianBulkDeleteProductStatus,
  DoudianBulkDeleteProductStatusFilter,
  DoudianBulkDeleteProtectMode,
  DoudianBulkDeleteResult,
  DoudianBulkDeleteRow,
  DoudianBulkDeleteSourceMode,
  DoudianRunDetail,
  DoudianStoreSummary
} from "../../types";
import { requireChihuNative } from "../../native/client";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { repositoryDelete, repositoryDeleteMany, repositoryGet, repositoryGetAll, repositoryGetAllByPrefix, repositoryGetMany, repositoryPut, repositoryPutMany } from "./repository";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";
import { prepareMutationSafety, recordExecutionMutationResults } from "./mutationSafety";
import { normalizeDoudianProductStatus } from "./productStatus";

interface BulkDeleteArgs {
  doudianAdapter?: DoudianAdapterPayload;
  mode?: "scan" | "execute" | string;
  shopIds?: string[];
  sourceMode?: DoudianBulkDeleteSourceMode;
  filters?: DoudianBulkDeleteFilters;
  action?: DoudianBulkDeleteAction | string;
  protectMode?: DoudianBulkDeleteProtectMode;
  candidateIds?: string[];
  sourceRunId?: string;
  confirmText?: string;
  operationId?: string;
  pageSize?: number;
  maxProductListPages?: number;
  mockProducts?: Array<Record<string, unknown>>;
  dryRun?: boolean;
  allowPartialScan?: boolean;
  onProgress?: (progress: DoudianBulkDeleteProgress) => void;
  shouldCancel?: () => boolean;
}

interface ScanRunRecord {
  id: string;
  mode: "scan";
  runId: string;
  operationId?: string;
  status: string;
  sourceMode: DoudianBulkDeleteSourceMode;
  action: DoudianBulkDeleteAction;
  protectMode: DoudianBulkDeleteProtectMode;
  rows: DoudianBulkDeleteRow[];
  candidates: DoudianBulkDeleteCandidate[];
  details: DoudianRunDetail[];
  scanSummary: Record<string, number>;
  sourceHealth: Array<Record<string, unknown>>;
  filters: DoudianBulkDeleteFilters;
  adapterVersion: string;
  scriptsVersion: string;
  requestPlanHash: string;
  createdAt: string;
  updatedAt: string;
}

interface ExecuteRunRecord {
  id: string;
  mode: "execute";
  runId: string;
  operationId?: string;
  sourceRunId: string;
  action: DoudianBulkDeleteAction;
  confirmText: string;
  status: string;
  dryRun: boolean;
  executions: DoudianBulkDeleteExecution[];
  details: DoudianRunDetail[];
  summary: Record<string, number>;
  adapterVersion: string;
  scriptsVersion: string;
  requestPlanHash: string;
  createdAt: string;
  updatedAt: string;
}

interface OperationEventRecord {
  id: string;
  operationId: string;
  runId: string;
  phase: "scan" | "recycle" | "delete" | "execute" | string;
  shopId?: string;
  shopName?: string;
  batchIndex?: number;
  attempt?: number;
  status: string;
  ok?: boolean;
  message?: string;
  metrics?: Record<string, unknown>;
  createdAt: string;
}

const bulkDeleteScanStore = "bulk_delete_scan_runs_v1" as const;
const bulkDeleteCandidateStore = "bulk_delete_candidates_v1" as const;
const bulkDeleteExecuteStore = "bulk_delete_execute_runs_v1" as const;
const bulkDeleteOperationEventStore = "bulk_delete_operation_events_v1" as const;
const bulkDeleteContractVersion = "bulk-delete-contract.status-fields-partial-v2";

function text(value: unknown) {
  return String(value || "").trim();
}

function operationCancelled(args: BulkDeleteArgs) {
  return args.shouldCancel?.() === true;
}

function reportProgress(args: BulkDeleteArgs, progress: Omit<DoudianBulkDeleteProgress, "percent"> & { percent?: number }) {
  const total = Math.max(0, Number(progress.total || 0));
  const completed = Math.max(0, Math.min(total || Number(progress.completed || 0), Number(progress.completed || 0)));
  const percent = progress.percent === undefined
    ? total > 0 ? Math.round((completed / total) * 100) : 0
    : Math.max(0, Math.min(100, Math.round(progress.percent)));
  args.onProgress?.({ ...progress, completed, total, percent });
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

function policyMessage(adapter: DoudianAdapterConfig, path: string, fallback: string, values: Record<string, unknown> = {}) {
  return policyText(adapter, path, fallback).replace(/\{([^}]+)\}/g, (_match, key) => String(values[key] ?? ""));
}

function adapterPayload(args: BulkDeleteArgs): DoudianAdapterPayload {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  return args.doudianAdapter;
}

function mappings(adapter: DoudianAdapterConfig) {
  const responseMappings = objectRecord(adapter.responseMappings);
  const bulkDeleteMappings = objectRecord(responseMappings.bulkDelete);
  if (!Object.keys(bulkDeleteMappings).length) throw new Error("bulk delete response mapping missing");
  return bulkDeleteMappings;
}

function listPaths(adapter: DoudianAdapterConfig) {
  const paths = mappings(adapter).listPaths;
  return Array.isArray(paths) ? paths.map((item) => text(item)).filter(Boolean) : [];
}

function totalPaths(adapter: DoudianAdapterConfig) {
  const paths = mappings(adapter).totalPaths;
  return Array.isArray(paths) ? paths.map((item) => text(item)).filter(Boolean) : [];
}

function fieldPaths(adapter: DoudianAdapterConfig, field: string) {
  const fields = objectRecord(mappings(adapter).fields);
  const value = fields[field];
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  const config = objectRecord(value);
  return Array.isArray(config.paths) ? config.paths.map((item) => text(item)).filter(Boolean) : [];
}

function fieldScale(adapter: DoudianAdapterConfig, field: string) {
  const scales = objectRecord(mappings(adapter).fieldScales);
  const config = objectRecord(objectRecord(mappings(adapter).fields)[field]);
  const value = Number(config.scale || scales[field] || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function firstArray(value: unknown, paths: string[]) {
  if (Array.isArray(value)) return value;
  for (const path of paths) {
    const next = path ? getPathValue(value, path) : value;
    if (Array.isArray(next)) return next;
  }
  return [];
}

function coerceNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "val", "amount", "count", "cnt", "num", "score", "rate", "total", "text"]) {
      const next = coerceNumber(record[key]);
      if (next !== undefined) return next;
    }
    return undefined;
  }
  const match = String(value).replace(/,/g, "").replace(/%/g, "").trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const next = Number(match[0]);
  return Number.isFinite(next) ? next : undefined;
}

function readField(record: unknown, adapter: DoudianAdapterConfig, field: string) {
  return firstPathValue(record, fieldPaths(adapter, field));
}

function readNumber(record: unknown, adapter: DoudianAdapterConfig, field: string, fallback = 0) {
  const value = coerceNumber(readField(record, adapter, field));
  return value === undefined ? fallback : value / fieldScale(adapter, field);
}

function firstMappedPath(record: unknown, paths: string[]) {
  for (const path of paths) {
    const value = path ? getPathValue(record, path) : record;
    if (value !== undefined && value !== null && value !== "") return { value, path };
  }
  return { value: undefined, path: "" };
}

function readAuditedNumber(record: unknown, adapter: DoudianAdapterConfig, field: string) {
  const paths = fieldPaths(adapter, field);
  const mapped = firstMappedPath(record, paths);
  const rawValue = mapped.value;
  const value = coerceNumber(rawValue);
  const scale = fieldScale(adapter, field);
  return {
    value: value === undefined ? undefined : value / scale,
    source: {
      field,
      paths,
      path: mapped.path,
      scale,
      valueType: Array.isArray(rawValue) ? "array" : typeof rawValue,
      mapped: value !== undefined,
      validated: false
    }
  };
}

function readText(record: unknown, adapter: DoudianAdapterConfig, field: string, fallback = "") {
  return text(readField(record, adapter, field)) || fallback;
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

function daysSince(value: string) {
  const ms = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 864e5)) : -1;
}

function readProductStatus(record: Record<string, unknown>, adapter: DoudianAdapterConfig) {
  const paths = fieldPaths(adapter, "status");
  const values = paths
    .map((path) => ({ path, value: path ? getPathValue(record, path) : record }))
    .filter(({ value }) => value !== undefined && value !== null && value !== "");
  // Prefer a display label such as `tab: 审核驳回` over a numeric companion code.
  const selected = values.find(({ value }) => Number.isNaN(Number(value))) || values[0];
  const rawStatus = selected ? text(selected.value) : "";
  return {
    status: normalizeDoudianProductStatus(selected?.value),
    rawStatus,
    source: {
      field: "status",
      paths,
      path: selected?.path || "",
      valueType: Array.isArray(selected?.value) ? "array" : typeof selected?.value,
      mapped: Boolean(selected)
    }
  };
}

function productListPlanKey(adapter: DoudianAdapterConfig) {
  if (!adapter.requestPlans?.bulkDeleteProductList) throw new Error("bulk delete request plan missing: bulkDeleteProductList");
  return "bulkDeleteProductList";
}

function recyclePlanKey(adapter: DoudianAdapterConfig) {
  if (!adapter.requestPlans?.bulkDeleteBatchDelete) throw new Error("bulk delete request plan missing: bulkDeleteBatchDelete");
  return "bulkDeleteBatchDelete";
}

function completeDeletePlanKey(adapter: DoudianAdapterConfig) {
  if (!adapter.requestPlans?.bulkDeleteCompleteDelete) throw new Error("bulk delete request plan missing: bulkDeleteCompleteDelete");
  return "bulkDeleteCompleteDelete";
}

function validateBulkDeleteAdapter(adapter: DoudianAdapterConfig) {
  mappings(adapter);
  productListPlanKey(adapter);
  recyclePlanKey(adapter);
  completeDeletePlanKey(adapter);
}

function requestPlanHash(adapter: DoudianAdapterConfig) {
  return [
    adapter.version || "",
    productListPlanKey(adapter),
    recyclePlanKey(adapter),
    completeDeletePlanKey(adapter),
    policyText(adapter, "bulkDelete.ruleVersion", "bulk-delete-rule"),
    bulkDeleteContractVersion
  ].join(":");
}

function normalizeSourceMode(value: unknown): DoudianBulkDeleteSourceMode {
  return value === "ids" ? "ids" : "range";
}

function normalizeAction(value: unknown): DoudianBulkDeleteAction {
  return value === "delete" ? "delete" : "recycle";
}

function normalizeProtectMode(value: unknown): DoudianBulkDeleteProtectMode {
  return value === "includeSelling" ? "includeSelling" : "skipSelling";
}

function enforceSellingPolicy(filters: DoudianBulkDeleteFilters, action: DoudianBulkDeleteAction, protectMode: DoudianBulkDeleteProtectMode) {
  if (filters.status !== "selling") return { action, protectMode };
  return { action: "recycle" as DoudianBulkDeleteAction, protectMode: "includeSelling" as DoudianBulkDeleteProtectMode };
}

function normalizeImportText(value: unknown) {
  return text(value).replace(/\s+/g, "").toLowerCase();
}

function normalizeImportItem(value: unknown): DoudianBulkDeleteImportItem | null {
  const record = objectRecord(value);
  const productId = text(record.productId);
  if (!productId) return null;
  return {
    productId,
    shopId: text(record.shopId) || undefined,
    shopName: text(record.shopName) || undefined,
    sourceLine: Number.isFinite(Number(record.sourceLine)) ? Number(record.sourceLine) : undefined,
    sourceFile: text(record.sourceFile) || undefined,
    validationStatus: text(record.validationStatus) || "ok",
    raw: text(record.raw) || undefined
  };
}

function normalizeFilters(filters: DoudianBulkDeleteFilters | undefined): DoudianBulkDeleteFilters {
  const importItems = Array.isArray(filters?.importItems)
    ? filters.importItems
      .map((item) => normalizeImportItem(item))
      .filter((item): item is DoudianBulkDeleteImportItem => item !== null && (!item.validationStatus || item.validationStatus === "ok"))
    : [];
  const productIds = Array.from(new Set([
    ...(!filters?.importItems?.length && Array.isArray(filters?.productIds) ? filters.productIds.map((id) => text(id)).filter(Boolean) : []),
    ...importItems.map((item) => text(item.productId)).filter(Boolean)
  ]));
  return {
    keyword: text(filters?.keyword),
    productIds,
    importItems,
    status: filters?.status === "selling" || filters?.status === "offline" ? filters.status : "all",
    priceMin: Math.max(0, Number(filters?.priceMin ?? 0)),
    priceMax: Math.max(0, Number(filters?.priceMax ?? 999999999)),
    salesMin: Math.max(0, Number(filters?.salesMin ?? 0)),
    salesMax: Math.max(0, Number(filters?.salesMax ?? 999999999)),
    createdDaysMin: Math.max(0, Number(filters?.createdDaysMin ?? 0)),
    listedDaysMin: Math.max(0, Number(filters?.listedDaysMin ?? 0)),
    perStoreLimit: Math.max(0, Number(filters?.perStoreLimit ?? 0))
  };
}

function statusContext(status: DoudianBulkDeleteProductStatusFilter | undefined) {
  const base = {
    productStatus: "",
    checkStatus: "",
    draftStatus: "",
    isOnline: "1",
    isOffline: "",
    offlineType: "",
    productTab: "all",
    needPayNoStockSkus: "false",
    commentPercent: "",
    orderField: "",
    sort: ""
  };
  if (status === "selling") {
    return {
      ...base,
      productStatus: "0",
      checkStatus: "3",
      draftStatus: "0",
      productTab: "onSale",
      needPayNoStockSkus: "true",
      orderField: "audit_time",
      sort: "desc"
    };
  }
  if (status === "offline") {
    return {
      ...base,
      isOnline: "",
      isOffline: "1",
      offlineType: "",
      productTab: "offline",
      orderField: "offline_time",
      sort: "desc"
    };
  }
  return base;
}

function importItemMatchesStore(item: DoudianBulkDeleteImportItem, store: DoudianStoreSummary) {
  const shopId = text(item.shopId);
  const shopName = normalizeImportText(item.shopName);
  if (!shopId && !shopName) return true;
  if (shopId && shopId === text(store.shopId)) return true;
  return Boolean(shopName && shopName === normalizeImportText(store.shopName));
}

function importItemsForStore(filters: DoudianBulkDeleteFilters, store: DoudianStoreSummary) {
  return (filters.importItems || []).filter((item) => item.productId && importItemMatchesStore(item, store));
}

function productIdsForStore(filters: DoudianBulkDeleteFilters, store: DoudianStoreSummary) {
  if (filters.importItems?.length) return Array.from(new Set(importItemsForStore(filters, store).map((item) => item.productId)));
  return Array.from(new Set((filters.productIds || []).map((id) => text(id)).filter(Boolean)));
}

function importItemForProduct(filters: DoudianBulkDeleteFilters, store: DoudianStoreSummary, productId: string) {
  return importItemsForStore(filters, store).find((item) => item.productId === productId) || null;
}

function productFromRecord(store: DoudianStoreSummary, record: Record<string, unknown>, adapter: DoudianAdapterConfig, runId: string, index: number, sourceMode: DoudianBulkDeleteSourceMode, action: DoudianBulkDeleteAction, protectMode: DoudianBulkDeleteProtectMode): DoudianBulkDeleteCandidate {
  const productId = readText(record, adapter, "productId", text(record.product_id || record.productId || record.id));
  const title = readText(record, adapter, "title", productId ? `商品 ${productId}` : "未命名商品");
  const statusField = readProductStatus(record, adapter);
  const rawStatus = statusField.rawStatus || text(record.tab || record.status || record.status_name);
  const status = statusField.status;
  const createdAt = normalizeDate(readField(record, adapter, "createdAt"));
  const listedAt = normalizeDate(readField(record, adapter, "listedAt"));
  const importItem = normalizeImportItem(record.__bulkDeleteImportItem);
  const price = readAuditedNumber(record, adapter, "price");
  const stock = readAuditedNumber(record, adapter, "stock");
  const sales = readAuditedNumber(record, adapter, "totalSales");
  const exposure = readAuditedNumber(record, adapter, "exposureCount");
  const excludedReason = status === "unknown"
    ? "商品状态未知，已从执行清单排除"
    : protectMode === "skipSelling" && status === "selling"
      ? "已保护售卖中商品"
      : "";
  const targetAction = action === "delete" ? "彻底删除" : "加入回收站";
  const warning = action === "delete" && status === "selling" && !excludedReason ? "将先加入回收站，再彻底删除" : "";
  const id = `${runId}:${store.shopId}:${productId || index}`;
  return {
    id,
    candidateId: id,
    sourceRunId: runId,
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    productId,
    title,
    category: readText(record, adapter, "category"),
    status,
    rawStatus,
    createdAt,
    listedAt,
    daysSinceCreated: createdAt ? daysSince(createdAt) : -1,
    daysSinceListed: listedAt ? daysSince(listedAt) : -1,
    price: price.value,
    stock: stock.value,
    sales: sales.value,
    exposure: exposure.value,
    fieldSources: {
      status: statusField.source,
      price: price.source,
      stock: stock.source,
      sales: sales.source,
      exposure: exposure.source
    },
    importItem: importItem || undefined,
    importSourceLine: importItem?.sourceLine,
    importShopRef: importItem ? text(importItem.shopId || importItem.shopName) : undefined,
    source: sourceMode === "ids" ? importItem?.shopId || importItem?.shopName ? "商品ID导入(店铺匹配)" : "商品ID导入" : "范围筛选",
    action,
    targetAction,
    excludedReason,
    warning,
    ok: !excludedReason && status !== "unknown",
    raw: record
  };
}

function matchesFilters(row: DoudianBulkDeleteCandidate, filters: DoudianBulkDeleteFilters, sourceMode: DoudianBulkDeleteSourceMode, productIds: Set<string>) {
  const keyword = text(filters.keyword).toLowerCase();
  if (sourceMode === "ids" && productIds.size && !productIds.has(row.productId)) return false;
  if (keyword && !`${row.title} ${row.productId}`.toLowerCase().includes(keyword)) return false;
  if (filters.status && filters.status !== "all" && row.status !== filters.status) return false;
  const priceMin = Number(filters.priceMin || 0);
  const priceMax = Number(filters.priceMax || 999999999);
  const salesMin = Number(filters.salesMin || 0);
  const salesMax = Number(filters.salesMax || 999999999);
  if (row.price === undefined ? priceMin > 0 || priceMax < 999999999 : row.price < priceMin || row.price > priceMax) return false;
  if (row.sales === undefined ? salesMin > 0 || salesMax < 999999999 : row.sales < salesMin || row.sales > salesMax) return false;
  if (Number(filters.createdDaysMin || 0) > 0 && Number(row.daysSinceCreated ?? -1) >= 0 && Number(row.daysSinceCreated) < Number(filters.createdDaysMin)) return false;
  if (Number(filters.listedDaysMin || 0) > 0 && Number(row.daysSinceListed ?? -1) >= 0 && Number(row.daysSinceListed) < Number(filters.listedDaysMin)) return false;
  return true;
}

function buildRow(store: DoudianStoreSummary, products: DoudianBulkDeleteCandidate[], matches: DoudianBulkDeleteCandidate[]): DoudianBulkDeleteRow {
  const stockEstimateCount = matches.filter((item) => item.ok && item.stock !== undefined).reduce((sum, item) => sum + Number(item.stock), 0);
  return {
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    status: store.status,
    productCount: products.length,
    matchedCount: matches.length,
    executableCount: matches.filter((item) => item.ok).length,
    excludedCount: matches.filter((item) => !item.ok).length,
    recycleCount: matches.filter((item) => item.action === "recycle" && item.ok).length,
    deleteCount: matches.filter((item) => item.action === "delete" && item.ok).length,
    sellingCount: matches.filter((item) => item.status === "selling").length,
    stockCount: 0,
    stockEstimateCount,
    stockFieldMappedCount: matches.filter((item) => objectRecord(item.fieldSources?.stock).mapped === true).length,
    stockFieldAuditedCount: matches.filter((item) => objectRecord(item.fieldSources?.stock).validated === true).length
  };
}

function readTotal(payload: unknown, adapter: DoudianAdapterConfig) {
  const total = coerceNumber(firstPathValue(payload, totalPaths(adapter)));
  return total !== undefined ? total : 0;
}

async function runProductListPage(payload: DoudianAdapterPayload, store: DoudianStoreSummary, planKey: string, context: Record<string, unknown>) {
  return runDoudianRequestPlan(payload, { partition: store.partition, planKey, context })
    .catch((error) => ({ ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error), source: planKey } as RequestPlanResult));
}

async function collectProducts(payload: DoudianAdapterPayload, store: DoudianStoreSummary, args: BulkDeleteArgs, filters: DoudianBulkDeleteFilters, sourceMode: DoudianBulkDeleteSourceMode) {
  if (args.mockProducts?.length) {
    return { products: args.mockProducts, remoteTotal: args.mockProducts.length, truncated: false, requestOk: true, pageSize: args.mockProducts.length, maxPages: 1, sourceHealth: [], responses: {} as Record<string, RequestPlanResult> };
  }
  const planKey = productListPlanKey(payload.adapter);
  const pageSize = Math.max(10, Math.min(200, Math.floor(Number(args.pageSize || policyNumber(payload.adapter, "bulkDelete.pageSize", 100, 10, 200)))));
  const rangeMaxPages = Math.max(1, Math.min(50, Math.floor(Number(args.maxProductListPages || policyNumber(payload.adapter, "bulkDelete.maxProductListPages", 20, 1, 50)))));
  const idMaxPages = Math.max(1, Math.min(rangeMaxPages, policyNumber(payload.adapter, "bulkDelete.maxProductIdSearchPages", 2, 1, 10)));
  const pageStart = policyNumber(payload.adapter, "bulkDelete.pageStart", 0, 0, 1);
  const storeProductIds = sourceMode === "ids" ? productIdsForStore(filters, store) : [];
  const keywordList = sourceMode === "ids" ? storeProductIds : [filters.keyword || ""];
  const maxPages = sourceMode === "ids" ? idMaxPages : rangeMaxPages;
  const products: Record<string, unknown>[] = [];
  const responses: Record<string, RequestPlanResult> = {};
  let remoteTotal = 0;
  if (sourceMode === "ids" && !keywordList.length) {
    return {
      products: [],
      remoteTotal: 0,
      truncated: false,
      requestOk: true,
      pageSize,
      maxPages,
      sourceHealth: [{ key: `${planKey}:import-skip`, status: 0, ok: true, skipped: true, reason: "no-import-item-for-store" }],
      responses
    };
  }
  let nextKeywordIndex = 0;
  const keywordConcurrency = Math.min(keywordList.length, policyNumber(payload.adapter, "bulkDelete.productIdLookupConcurrency", 2, 1, 4));
  async function keywordWorker() {
    for (;;) {
      const keywordIndex = nextKeywordIndex;
      nextKeywordIndex += 1;
      if (keywordIndex >= keywordList.length) return;
      const keyword = keywordList[keywordIndex];
      const importItem = sourceMode === "ids" ? importItemForProduct(filters, store, keyword) : null;
      let keywordProductCount = 0;
      for (let page = pageStart; page < pageStart + maxPages; page += 1) {
        if (operationCancelled(args)) throw new Error("bulk delete operation cancelled");
        const response = await runProductListPage(payload, store, planKey, {
          page: String(page),
          pageSize: String(pageSize),
          keyword,
          ...statusContext(filters.status)
        });
        const responseKey = `${planKey}:keyword:${keywordIndex}:page:${page}`;
        responses[responseKey] = response;
        const payloadForPage = { [planKey]: response.data };
        const items = firstArray(payloadForPage, listPaths(payload.adapter));
        products.push(...items.map((item) => ({ ...objectRecord(item), ...(importItem ? { __bulkDeleteImportItem: importItem } : {}) })));
        keywordProductCount += items.length;
        remoteTotal = Math.max(readTotal(payloadForPage, payload.adapter), remoteTotal);
        if (!requestPlanResponseOk(response, payload.adapter, planKey, mappings(payload.adapter))) break;
        if (sourceMode !== "ids" && remoteTotal && keywordProductCount >= remoteTotal) break;
        if (items.length < pageSize) break;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, keywordConcurrency) }, () => keywordWorker()));
  const deduped = new Map<string, Record<string, unknown>>();
  products.forEach((item, index) => {
    const id = text(firstPathValue(item, fieldPaths(payload.adapter, "productId"))) || `row-${index}`;
    if (!deduped.has(id)) deduped.set(id, item);
  });
  const dedupedProducts = [...deduped.values()];
  const effectiveRemoteTotal = remoteTotal || deduped.size;
  return {
    products: dedupedProducts,
    remoteTotal: effectiveRemoteTotal,
    truncated: sourceMode !== "ids" && effectiveRemoteTotal > dedupedProducts.length,
    requestOk: Object.values(responses).length > 0 && Object.values(responses).every((response) => requestPlanResponseOk(response, payload.adapter, planKey, mappings(payload.adapter))),
    pageSize,
    maxPages,
    sourceHealth: Object.entries(responses).map(([key, response]) => ({
      key,
      status: response.status,
      ok: requestPlanResponseOk(response, payload.adapter, planKey, mappings(payload.adapter)),
      source: response.source,
      attemptCount: response.attemptCount || 0,
      durationMs: response.durationMs || 0,
      requestDiagnostic: response.requestDiagnostic || null
    })),
    responses
  };
}

function responseCode(response: RequestPlanResult | undefined) {
  return firstPathValue(response?.data, ["code", "st", "status_code", "statusCode", "errno"]);
}

function responseMessage(response: RequestPlanResult | undefined) {
  return text(firstPathValue(response?.data, ["msg", "message", "status_msg", "statusMessage"]) || response?.error || "").slice(0, 160);
}

function summarizeResponses(responses: Record<string, RequestPlanResult>, adapter: DoudianAdapterConfig) {
  return Object.fromEntries(Object.entries(responses).map(([key, response]) => {
    const planKey = key.split(":")[0] || key;
    return [key, {
      status: response.status || 0,
      success: requestPlanResponseOk(response, adapter, planKey, mappings(adapter)),
      code: responseCode(response) ?? null,
      message: responseMessage(response),
      source: response.source,
      attemptCount: response.attemptCount || 0,
      durationMs: response.durationMs || 0,
      requestDiagnostic: response.requestDiagnostic || null
    }];
  }));
}

async function recordOperationEvent(args: Omit<OperationEventRecord, "id" | "createdAt">) {
  const createdAt = new Date().toISOString();
  const id = `${args.operationId}:${args.phase}:${args.shopId || "all"}:${args.batchIndex || 0}:${args.attempt || 0}:${createdAt}:${Math.random().toString(16).slice(2)}`;
  const record: OperationEventRecord = { ...args, id, createdAt };
  await repositoryPut(bulkDeleteOperationEventStore, record).catch(() => undefined);
  try {
    await requireChihuNative().logs.report({
      category: "doudian-bulk-delete",
      event: "operation-event",
      ...record
    }).catch(() => undefined);
  } catch {
    // Operation events are best-effort diagnostics and must not block deletion.
  }
}

async function reportBulkDeleteRow(args: {
  store: DoudianStoreSummary;
  row: DoudianBulkDeleteRow;
  detail: DoudianRunDetail;
  responses: Record<string, RequestPlanResult>;
  adapter: DoudianAdapterConfig;
}) {
  try {
    await requireChihuNative().logs.report({
      category: "doudian-bulk-delete",
      event: "scan-row",
      shopId: args.store.shopId,
      shopName: args.store.shopName,
      partition: args.store.partition,
      ok: args.detail.ok === true,
      status: args.detail.status || "",
      reason: args.detail.reason || "",
      message: args.detail.message || "",
      metrics: args.row,
      responses: summarizeResponses(args.responses, args.adapter)
    }).catch(() => undefined);
  } catch {
    // Diagnostics must never block the business flow.
  }
}

async function scanStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, args: BulkDeleteArgs, runId: string, filters: DoudianBulkDeleteFilters, sourceMode: DoudianBulkDeleteSourceMode, action: DoudianBulkDeleteAction, protectMode: DoudianBulkDeleteProtectMode) {
  const collected = await collectProducts(payload, store, args, filters, sourceMode);
  const products = collected.products.map((product, index) => productFromRecord(store, product, payload.adapter, runId, index, sourceMode, action, protectMode));
  const filterProductIds = new Set((filters.productIds || []).map((id) => text(id)).filter(Boolean));
  let matches = products.filter((product) => product.productId && matchesFilters(product, filters, sourceMode, filterProductIds));
  if (Number(filters.perStoreLimit || 0) > 0) matches = matches.slice(0, Number(filters.perStoreLimit));
  const candidates = collected.truncated ? [] : matches;
  const row = buildRow(store, products, candidates);
  const listPlanKey = productListPlanKey(payload.adapter);
  const requestOk = collected.requestOk;
  const ok = !collected.truncated && requestOk;
  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? "ok" : "failed",
    ok,
    message: collected.truncated
      ? policyMessage(payload.adapter, "bulkDelete.messages.truncated", "Bulk delete scan stopped because the product list exceeded the current page window")
      : ok
      ? matches.length ? policyMessage(payload.adapter, "bulkDelete.messages.scanned", "Bulk delete products scanned", { count: matches.length }) : policyMessage(payload.adapter, "bulkDelete.messages.noCandidateStore", "No matched products")
      : policyMessage(payload.adapter, "bulkDelete.messages.failed", "Bulk delete scan failed"),
    reason: collected.truncated ? "bulk-delete-product-list-truncated" : ok ? (matches.length ? "" : "bulk-delete-no-candidate") : "bulk-delete-request-failed",
    category: collected.truncated ? "adapter-policy" : ok ? "" : "api",
    diagnostic: {
      productCount: products.length,
      matchedCount: matches.length,
      candidateCount: candidates.length,
      remoteTotal: collected.remoteTotal,
      truncated: collected.truncated,
      pageSize: collected.pageSize,
      maxPages: collected.maxPages,
      importItemCount: sourceMode === "ids" ? filters.importItems?.length || 0 : 0,
      storeImportItemCount: sourceMode === "ids" ? productIdsForStore(filters, store).length : 0,
      sourceHealth: collected.sourceHealth
    }
  };
  await reportBulkDeleteRow({ store, row, detail, responses: collected.responses, adapter: payload.adapter });
  await recordOperationEvent({
    operationId: args.operationId || runId,
    runId,
    phase: "scan",
    shopId: store.shopId,
    shopName: store.shopName,
    status: detail.status || (detail.ok ? "ok" : "failed"),
    ok: detail.ok,
    message: detail.message,
    metrics: { productCount: row.productCount, matchedCount: row.matchedCount, executableCount: row.executableCount, remoteTotal: collected.remoteTotal, truncated: collected.truncated }
  });
  return { row, products, candidates, detail, sourceHealth: collected.sourceHealth };
}

type ScanStoreResult = Awaited<ReturnType<typeof scanStore>>;

function failedScanStoreResult(store: DoudianStoreSummary, error: unknown, index: number, total: number): ScanStoreResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    row: {
      shopId: store.shopId,
      shopName: store.shopName,
      group: store.groupName || "",
      status: store.status,
      productCount: 0,
      matchedCount: 0,
      executableCount: 0,
      excludedCount: 0,
      recycleCount: 0,
      deleteCount: 0,
      sellingCount: 0,
      stockCount: 0
    },
    products: [],
    candidates: [],
    detail: {
      shopId: store.shopId,
      shopName: store.shopName,
      status: "failed",
      ok: false,
      message,
      reason: "bulk-delete-scan-store-failed",
      category: "api",
      diagnostic: { index, total }
    },
    sourceHealth: []
  };
}

async function scanStoresWithConcurrency(payload: DoudianAdapterPayload, targets: DoudianStoreSummary[], args: BulkDeleteArgs, runId: string, filters: DoudianBulkDeleteFilters, sourceMode: DoudianBulkDeleteSourceMode, action: DoudianBulkDeleteAction, protectMode: DoudianBulkDeleteProtectMode) {
  const concurrency = Math.min(targets.length || 1, policyNumber(payload.adapter, "bulkDelete.concurrency", 2, 1, 4));
  const results = new Array<ScanStoreResult>(targets.length);
  let nextIndex = 0;
  let completed = 0;
  async function worker() {
    for (;;) {
      if (operationCancelled(args)) return;
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= targets.length) return;
      const store = targets[currentIndex];
      try {
        results[currentIndex] = await scanStore(payload, store, args, runId, filters, sourceMode, action, protectMode);
      } catch (error) {
        results[currentIndex] = failedScanStoreResult(store, error, currentIndex + 1, targets.length);
        await recordOperationEvent({
          operationId: args.operationId || runId,
          runId,
          phase: "scan",
          shopId: store.shopId,
          shopName: store.shopName,
          status: "failed",
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          metrics: { index: currentIndex + 1, total: targets.length }
        });
      }
      completed += 1;
      reportProgress(args, { phase: "scan", completed, total: targets.length, shopId: store.shopId });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results.filter(Boolean);
}

async function pruneScanHistory(adapter: DoudianAdapterConfig) {
  const retention = policyNumber(adapter, "bulkDelete.scanHistoryLimit", 5, 1, 50);
  const runs = (await repositoryGetAll<ScanRunRecord>(bulkDeleteScanStore))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  for (const staleRun of runs.slice(retention)) {
    const candidates = await repositoryGetAllByPrefix<DoudianBulkDeleteCandidate>(bulkDeleteCandidateStore, `${staleRun.runId}:`, { pageSize: 1000, maxItems: 100000 }).catch(() => []);
    const eventPrefix = `${staleRun.operationId || staleRun.runId}:`;
    const events = await repositoryGetAllByPrefix<OperationEventRecord>(bulkDeleteOperationEventStore, eventPrefix, { pageSize: 1000, maxItems: 100000 }).catch(() => []);
    await repositoryDeleteMany(bulkDeleteCandidateStore, candidates.map((item) => item.id)).catch(() => 0);
    await repositoryDeleteMany(bulkDeleteOperationEventStore, events.map((item) => item.id)).catch(() => 0);
    await repositoryDelete(bulkDeleteScanStore, staleRun.id).catch(() => undefined);
  }
}

async function saveScanRun(record: ScanRunRecord, adapter: DoudianAdapterConfig) {
  await repositoryPut(bulkDeleteScanStore, record);
  await repositoryPutMany(bulkDeleteCandidateStore, record.candidates.map((candidate) => ({ ...candidate, id: candidate.id })));
  await pruneScanHistory(adapter).catch(() => undefined);
}

function scanSummary(rows: DoudianBulkDeleteRow[], candidates: DoudianBulkDeleteCandidate[], details: DoudianRunDetail[], sourceHealth: Array<Record<string, unknown>>) {
  return {
    productCount: rows.reduce((sum, row) => sum + Number(row.productCount || 0), 0),
    matchedCount: candidates.length,
    executableCount: candidates.filter((item) => item.ok).length,
    excludedCount: candidates.filter((item) => !item.ok).length,
    sourceFailureCount: details.filter((detail) => detail.ok === false).length,
    truncatedStoreCount: details.filter((detail) => detail.reason === "bulk-delete-product-list-truncated").length,
    fetchedPages: sourceHealth.length,
    recycleCount: candidates.filter((item) => item.ok && item.action === "recycle").length,
    deleteCount: candidates.filter((item) => item.ok && item.action === "delete").length,
    sellingCount: candidates.filter((item) => item.status === "selling").length,
    stockCount: 0,
    stockEstimateCount: candidates.filter((item) => item.ok && item.stock !== undefined).reduce((sum, item) => sum + Number(item.stock), 0),
    stockFieldMappedCount: candidates.filter((item) => objectRecord(item.fieldSources?.stock).mapped === true).length,
    stockFieldAuditedCount: candidates.filter((item) => objectRecord(item.fieldSources?.stock).validated === true).length
  };
}

function executeSummary(executions: DoudianBulkDeleteExecution[]) {
  return {
    executionCount: executions.length,
    submittedCount: executions.filter((item) => item.status === "submitted").length,
    dryRunCount: executions.filter((item) => item.status === "dry_run").length,
    failedCount: executions.filter((item) => item.ok === false).length,
    skippedCount: executions.filter((item) => item.status === "skipped").length,
    recycleCount: executions.filter((item) => item.action === "recycle").length,
    deleteCount: executions.filter((item) => item.action === "delete").length
  };
}

function candidateKeys(candidate: DoudianBulkDeleteCandidate) {
  return [
    text(candidate.id),
    text(candidate.candidateId),
    `${candidate.shopId}-${candidate.productId}`
  ].filter(Boolean);
}

function normalizeStoredCandidate(candidate: DoudianBulkDeleteCandidate, sourceRunId: string, action: DoudianBulkDeleteAction): DoudianBulkDeleteCandidate {
  const id = text(candidate.id || `${candidate.shopId || ""}-${candidate.productId || ""}`);
  return {
    ...candidate,
    id,
    candidateId: text(candidate.candidateId || id),
    sourceRunId,
    shopId: text(candidate.shopId),
    shopName: text(candidate.shopName),
    productId: text(candidate.productId),
    title: text(candidate.title),
    action
  };
}

async function loadExecuteCandidates(args: BulkDeleteArgs) {
  const sourceRunId = text(args.sourceRunId);
  if (!sourceRunId) throw new Error("bulk delete execute requires sourceRunId");
  const run = await repositoryGet<ScanRunRecord>(bulkDeleteScanStore, sourceRunId);
  if (!run) throw new Error("bulk delete source scan run not found");
  const selectedIds = new Set((args.candidateIds || []).map((id) => text(id)).filter(Boolean));
  if (!selectedIds.size) throw new Error("bulk delete selected products missing");

  const action = normalizeAction(run.action);
  const stored = await repositoryGetMany<DoudianBulkDeleteCandidate>(bulkDeleteCandidateStore, [...selectedIds]);
  const candidates = stored
    .filter((item) => text(item.sourceRunId) === run.runId || text(item.sourceRunId) === sourceRunId)
    .map((item) => normalizeStoredCandidate(item, run.runId, action))
    .filter((item) => item.shopId && item.productId && item.ok !== false);

  const byKey = new Map<string, DoudianBulkDeleteCandidate>();
  candidates.forEach((candidate) => candidateKeys(candidate).forEach((key) => byKey.set(key, candidate)));
  const selected: DoudianBulkDeleteCandidate[] = [];
  const invalid: string[] = [];
  selectedIds.forEach((id) => {
    const candidate = byKey.get(id);
    if (candidate) selected.push(candidate);
    else invalid.push(id);
  });
  if (invalid.length) throw new Error(`bulk delete candidates are not from source run: ${invalid.slice(0, 3).join(",")}`);
  return { run, sourceRunId: run.runId, selected, action };
}

function executePlanGuard(adapter: DoudianAdapterConfig, action: string, planKey: string) {
  const plan = objectRecord(adapter.requestPlans?.[planKey]);
  return {
    ok: !!planKey && !!adapter.requestPlans?.[planKey] && ["recycle", "delete"].includes(action),
    dryRunOnly: plan.dryRunOnly !== false,
    action,
    planKey,
    method: text(plan.method || "GET").toUpperCase(),
    endpointKey: text(plan.endpointKey || planKey)
  };
}

const executeBatchSize = 100;
const executeBatchDelayMs = 3000;
const executeTransientRetryLimit = 3;

function executionFor(candidates: Array<DoudianBulkDeleteCandidate & { mutationKey?: string; liveLifecycleStatus?: string }>, store: DoudianStoreSummary, action: DoudianBulkDeleteAction, status: string, ok: boolean, message: string, planKey: string, stage: string): DoudianBulkDeleteExecution[] {
  return candidates.map((item) => ({
    id: item.id,
    sourceRunId: item.sourceRunId,
    mutationKey: item.mutationKey,
    mutationStatus: status === "submitted" ? "acknowledged" : status,
    liveLifecycleStatus: item.liveLifecycleStatus,
    shopId: store.shopId,
    shopName: store.shopName,
    productId: item.productId,
    title: item.title || "",
    action,
    status,
    ok,
    message,
    planKey,
    stage
  }));
}

function bulkExecutionsFromRejected(
  store: DoudianStoreSummary,
  rejected: Array<{ item: DoudianBulkDeleteCandidate; mutationKey: string; status: string; ok: boolean; message: string; liveLifecycleStatus?: string }>,
  action: DoudianBulkDeleteAction,
  planKey: string,
  stage: string
): DoudianBulkDeleteExecution[] {
  return rejected.map((entry) => ({
    id: entry.item.id,
    sourceRunId: entry.item.sourceRunId,
    mutationKey: entry.mutationKey,
    mutationStatus: entry.status,
    liveLifecycleStatus: entry.liveLifecycleStatus,
    shopId: store.shopId,
    shopName: store.shopName,
    productId: entry.item.productId,
    title: entry.item.title || "",
    action,
    status: entry.status,
    ok: entry.ok,
    message: entry.message,
    planKey,
    stage
  }));
}

function chunksOf<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizedCode(value: unknown) {
  if (value === 0) return "0";
  if (value === false) return "false";
  return String(value ?? "").trim().toLowerCase();
}

function successCode(value: unknown) {
  const code = normalizedCode(value);
  return code === "0" || code === "success" || code === "true";
}

function itemMessage(record: Record<string, unknown>, fallback: string) {
  return text(firstPathValue(record, ["msg", "message", "status_msg", "statusMessage", "reason"])) || fallback;
}

function itemProductId(record: Record<string, unknown>) {
  return text(firstPathValue(record, ["product_id", "productId", "product_id_str", "id"]));
}

function itemOk(record: Record<string, unknown>) {
  const code = firstPathValue(record, ["code", "st", "status_code", "statusCode", "errno"]);
  if (code !== undefined) return successCode(code);
  const ok = firstPathValue(record, ["ok", "success"]);
  if (ok !== undefined) return ok === true || successCode(ok);
  return false;
}

function stageItemRows(response: RequestPlanResult | undefined) {
  return firstArray(response?.data, ["data", "data.data", "result", "result.data", "data.list", "list"]).map((item) => objectRecord(item));
}

function transientExecuteMessage(message: string) {
  return /系统错误|查询异常|频繁/.test(message);
}

function stageExecutionsFromResponse(args: {
  response: RequestPlanResult;
  adapter: DoudianAdapterConfig;
  planKey: string;
  store: DoudianStoreSummary;
  candidates: DoudianBulkDeleteCandidate[];
  action: DoudianBulkDeleteAction;
  stage: string;
  useItemRows: boolean;
}) {
  const topLevelOk = requestPlanResponseOk(args.response, args.adapter, args.planKey, mappings(args.adapter));
  const fallbackMessage = topLevelOk
    ? policyMessage(args.adapter, "bulkDelete.messages.executedStore", "Bulk delete executed", { count: args.candidates.length })
    : args.response.error || responseMessage(args.response) || policyMessage(args.adapter, "bulkDelete.messages.executeFailed", "Bulk delete failed");

  if (!topLevelOk) {
    return {
      topLevelOk,
      itemResultCount: 0,
      successfulCandidates: [] as DoudianBulkDeleteCandidate[],
      transientCandidates: [] as DoudianBulkDeleteCandidate[],
      executions: executionFor(args.candidates, args.store, args.action, "failed", false, fallbackMessage, args.planKey, args.stage)
    };
  }

  const rows = args.useItemRows ? stageItemRows(args.response) : [];
  if (!args.useItemRows) {
    return {
      topLevelOk,
      itemResultCount: rows.length,
      successfulCandidates: args.candidates,
      transientCandidates: [] as DoudianBulkDeleteCandidate[],
      executions: executionFor(args.candidates, args.store, args.action, "submitted", true, fallbackMessage, args.planKey, args.stage)
    };
  }
  if (!rows.length) {
    const message = "bulk delete item results missing";
    return {
      topLevelOk: false,
      itemResultCount: 0,
      successfulCandidates: [] as DoudianBulkDeleteCandidate[],
      transientCandidates: [] as DoudianBulkDeleteCandidate[],
      executions: executionFor(args.candidates, args.store, args.action, "failed", false, message, args.planKey, args.stage)
    };
  }

  const byProductId = new Map<string, Record<string, unknown>>();
  rows.forEach((row) => {
    const productId = itemProductId(row);
    if (productId) byProductId.set(productId, row);
  });
  const successfulCandidates: DoudianBulkDeleteCandidate[] = [];
  const transientCandidates: DoudianBulkDeleteCandidate[] = [];
  const executions = args.candidates.map((candidate) => {
    const row = byProductId.get(candidate.productId);
    const ok = row ? itemOk(row) : false;
    const message = row ? itemMessage(row, fallbackMessage) : "bulk delete item result missing";
    if (ok) successfulCandidates.push(candidate);
    else if (args.stage === "recycle" && row && transientExecuteMessage(message)) transientCandidates.push(candidate);
    return {
      id: candidate.id,
      sourceRunId: candidate.sourceRunId,
      mutationKey: text(candidate.mutationKey) || undefined,
      mutationStatus: ok ? "acknowledged" : "failed",
      liveLifecycleStatus: text(candidate.liveLifecycleStatus) || undefined,
      shopId: args.store.shopId,
      shopName: args.store.shopName,
      productId: candidate.productId,
      title: candidate.title || "",
      action: args.action,
      status: ok ? "submitted" : "failed",
      ok,
      message,
      planKey: args.planKey,
      stage: args.stage
    };
  });
  return { topLevelOk, itemResultCount: rows.length, successfulCandidates, transientCandidates, executions };
}

async function executeRequestStage(payload: DoudianAdapterPayload, store: DoudianStoreSummary, candidates: DoudianBulkDeleteCandidate[], action: DoudianBulkDeleteAction, planKey: string, stage: string, forceDryRun: boolean, runId: string, protectMode: DoudianBulkDeleteProtectMode, operationArgs: BulkDeleteArgs) {
  const guard = executePlanGuard(payload.adapter, action, planKey);
  let productIds = candidates.map((item) => item.productId).filter(Boolean);
  const candidateKey = (candidate: DoudianBulkDeleteCandidate) => candidate.id || `${candidate.shopId}-${candidate.productId}`;
  const buildRequestContext = (items: DoudianBulkDeleteCandidate[]) => {
    const currentProductIds = items.map((item) => item.productId).filter(Boolean);
    const formBody = new URLSearchParams();
    currentProductIds.forEach((productId) => formBody.append("product_ids[]", productId));
    return {
      productIds: currentProductIds.join(","),
      productIdList: currentProductIds,
      productCount: currentProductIds.length,
      formBody: formBody.toString(),
      action,
      stage,
      shopId: store.shopId,
      shopName: store.shopName,
      partition: store.partition,
      shopPartition: store.partition
    };
  };
  if (operationCancelled(operationArgs)) throw new Error("bulk delete operation cancelled");
  if (!guard.ok) {
    const message = `bulk delete execute plan unavailable for ${action}:${stage}`;
    return {
      ok: false,
      dryRun: false,
      executions: executionFor(candidates, store, action, "failed", false, message, planKey, stage),
      successfulCandidates: [] as DoudianBulkDeleteCandidate[],
      diagnostic: { guard, productCount: productIds.length }
    };
  }
  if (guard.dryRunOnly || forceDryRun) {
    const message = policyMessage(payload.adapter, "bulkDelete.messages.executeDryRun", "Bulk delete dry-run only; no platform write request was submitted", { count: productIds.length });
    return {
      ok: true,
      dryRun: true,
      executions: executionFor(candidates, store, action, "dry_run", true, message, planKey, stage),
      successfulCandidates: candidates,
      diagnostic: { guard, requestContext: buildRequestContext(candidates) }
    };
  }
  const auditAction = stage === "delete" ? "delete" : "recycle";
  const safety = await prepareMutationSafety({
    payload,
    store,
    candidates,
    feature: "bulk-delete",
    runId,
    sourceRunId: candidates.find((item) => item.sourceRunId)?.sourceRunId,
    operationId: runId,
    action: auditAction,
    stage,
    planKey,
    protectMode,
    lookupConcurrency: policyNumber(payload.adapter, "bulkDelete.liveLookupConcurrency", 4, 1, 8),
    confirmAttempts: policyNumber(payload.adapter, "bulkDelete.recycleConfirmAttempts", 5, 1, 10),
    confirmDelayMs: policyNumber(payload.adapter, "bulkDelete.recycleConfirmDelayMs", 1000, 0, 10000),
    shouldCancel: operationArgs.shouldCancel
  });
  const rejectedExecutions = bulkExecutionsFromRejected(store, safety.rejected, auditAction as DoudianBulkDeleteAction, planKey, stage);
  const alreadySatisfiedCandidates = stage === "recycle"
    ? safety.rejected.filter((entry) => entry.reason === "already-recycled").map((entry) => entry.item)
    : [];
  const safeCandidates = safety.allowed;
  if (!safeCandidates.length) {
    await recordExecutionMutationResults({ store, executions: rejectedExecutions.map((item) => ({ ...item, action: auditAction })), defaultAction: auditAction }).catch(() => undefined);
    return {
      ok: rejectedExecutions.length > 0 && rejectedExecutions.every((item) => item.ok !== false),
      dryRun: false,
      executions: rejectedExecutions,
      successfulCandidates: alreadySatisfiedCandidates,
      diagnostic: { guard, mutationSafety: safety.audit, productCount: productIds.length }
    };
  }
  productIds = safeCandidates.map((item) => item.productId).filter(Boolean);
  let pending: Array<DoudianBulkDeleteCandidate & { mutationKey?: string; liveLifecycleStatus?: string }> = safeCandidates;
  let transientAttempts = 0;
  let lastResponse: RequestPlanResult | undefined;
  let lastItemResultCount = 0;
  const attempts: Array<Record<string, unknown>> = [];
  const executionsById = new Map<string, DoudianBulkDeleteExecution>();
  const successfulById = new Map<string, DoudianBulkDeleteCandidate>();
  alreadySatisfiedCandidates.forEach((candidate) => successfulById.set(candidateKey(candidate), candidate));
  while (pending.length) {
    if (operationCancelled(operationArgs)) throw new Error("bulk delete operation cancelled");
    const current = pending;
    const requestContext = buildRequestContext(current);
    const response = await runDoudianRequestPlan(payload, { partition: store.partition, planKey, context: requestContext });
    lastResponse = response;
    const stageResult = stageExecutionsFromResponse({
      response,
      adapter: payload.adapter,
      planKey,
      store,
      candidates: current,
      action,
      stage,
      useItemRows: stage === "recycle"
    });
    lastItemResultCount = stageResult.itemResultCount;
    const topLevelTransient = false;
    const retryCandidates = stageResult.transientCandidates;
    const canRetry = stage === "recycle" && retryCandidates.length > 0 && transientAttempts < executeTransientRetryLimit;
    const retryIds = new Set(canRetry ? retryCandidates.map(candidateKey) : []);

    for (const execution of stageResult.executions) {
      const key = text(execution.id || `${execution.shopId}-${execution.productId}`);
      if (!retryIds.has(key)) executionsById.set(key, execution);
    }
    stageResult.successfulCandidates.forEach((candidate) => successfulById.set(candidateKey(candidate), candidate));
    attempts.push({
      attempt: attempts.length + 1,
      productCount: current.length,
      response: { status: response.status, ok: response.ok, source: response.source },
      itemResultCount: stageResult.itemResultCount,
      topLevelTransient,
      itemTransientCount: stageResult.transientCandidates.length,
      retriedCount: canRetry ? retryCandidates.length : 0
    });

    if (!canRetry) break;
    transientAttempts += 1;
    if (operationCancelled(operationArgs)) throw new Error("bulk delete operation cancelled");
    await wait(1000 * transientAttempts);
    pending = retryCandidates;
  }
  const executions = safeCandidates
    .map((candidate) => executionsById.get(candidateKey(candidate)))
    .filter((item): item is DoudianBulkDeleteExecution => Boolean(item));
  const missingCandidates = safeCandidates.filter((candidate) => !executionsById.has(candidateKey(candidate)));
  if (missingCandidates.length) {
    executions.push(...executionFor(missingCandidates, store, action, "failed", false, "bulk delete execution result missing", planKey, stage));
  }
  const allExecutions = [...rejectedExecutions, ...executions];
  await recordExecutionMutationResults({ store, executions: allExecutions.map((item) => ({ ...item, action: auditAction })), defaultAction: auditAction }).catch(() => undefined);
  const ok = executions.length === safeCandidates.length && executions.every((item) => item.ok) && rejectedExecutions.every((item) => item.ok !== false);
  return {
    ok,
    dryRun: false,
    executions: allExecutions,
    successfulCandidates: [...alreadySatisfiedCandidates, ...safeCandidates.filter((candidate) => successfulById.has(candidateKey(candidate)))],
    diagnostic: { guard, mutationSafety: safety.audit, response: lastResponse ? { status: lastResponse.status, ok: lastResponse.ok, source: lastResponse.source } : null, productCount: productIds.length, itemResultCount: lastItemResultCount, transientAttempts, attempts }
  };
}

async function executeStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, candidates: DoudianBulkDeleteCandidate[], action: DoudianBulkDeleteAction, index: number, total: number, forceDryRun: boolean, runId: string, operationId: string, protectMode: DoudianBulkDeleteProtectMode, operationArgs: BulkDeleteArgs, progressState: { completed: number; total: number }) {
  const recycleKey = recyclePlanKey(payload.adapter);
  const finalKey = completeDeletePlanKey(payload.adapter);
  const batchSize = policyNumber(payload.adapter, "bulkDelete.executeBatchSize", executeBatchSize, 1, 100);
  const batchDelayMs = policyNumber(payload.adapter, "bulkDelete.executeBatchDelayMs", executeBatchDelayMs, 0, 30000);
  const batches = chunksOf(candidates, batchSize);
  const executions: DoudianBulkDeleteExecution[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  let dryRun = false;

  for (const [batchIndex, batch] of batches.entries()) {
    if (operationCancelled(operationArgs)) {
      executions.push(...executionFor(batch, store, action, "cancelled", false, "bulk delete operation cancelled before batch submission", recycleKey, "recycle"));
      continue;
    }
    reportProgress(operationArgs, { phase: "recycle", completed: progressState.completed, total: progressState.total, shopId: store.shopId, batchIndex: batchIndex + 1, totalBatches: batches.length });
    let firstStage: Awaited<ReturnType<typeof executeRequestStage>>;
    try {
      firstStage = await executeRequestStage(payload, store, batch, action, recycleKey, "recycle", forceDryRun, runId, protectMode, operationArgs);
    } catch (error) {
      if (!operationCancelled(operationArgs)) throw error;
      executions.push(...executionFor(batch, store, action, "cancelled", false, "bulk delete operation cancelled before batch submission", recycleKey, "recycle"));
      continue;
    }
    dryRun = dryRun || firstStage.dryRun;
    const diagnostic: Record<string, unknown> = { index: batchIndex + 1, total: batches.length, recycle: firstStage.diagnostic };
    await recordOperationEvent({
      operationId,
      runId,
      phase: "recycle",
      shopId: store.shopId,
      shopName: store.shopName,
      batchIndex: batchIndex + 1,
      status: firstStage.ok ? (firstStage.dryRun ? "dry_run" : "ok") : "failed",
      ok: firstStage.ok,
      message: firstStage.executions.find((item) => item.ok === false)?.message || "",
      metrics: { productCount: batch.length, successCount: firstStage.successfulCandidates.length, failedCount: firstStage.executions.filter((item) => item.ok === false).length, totalBatches: batches.length }
    });

    let secondStage: Awaited<ReturnType<typeof executeRequestStage>> | null = null;
    let cancelledAfterRecycle = false;
    if (action === "delete" && firstStage.successfulCandidates.length && !firstStage.dryRun) {
      cancelledAfterRecycle = operationCancelled(operationArgs);
      if (!cancelledAfterRecycle) {
        reportProgress(operationArgs, { phase: "delete", completed: progressState.completed, total: progressState.total, shopId: store.shopId, batchIndex: batchIndex + 1, totalBatches: batches.length });
        try {
          secondStage = await executeRequestStage(payload, store, firstStage.successfulCandidates, action, finalKey, "delete", forceDryRun, runId, protectMode, operationArgs);
        } catch (error) {
          if (!operationCancelled(operationArgs)) throw error;
          cancelledAfterRecycle = true;
        }
        if (secondStage) {
          dryRun = dryRun || secondStage.dryRun;
          diagnostic.delete = secondStage.diagnostic;
          await recordOperationEvent({
            operationId,
            runId,
            phase: "delete",
            shopId: store.shopId,
            shopName: store.shopName,
            batchIndex: batchIndex + 1,
            status: secondStage.ok ? (secondStage.dryRun ? "dry_run" : "ok") : "failed",
            ok: secondStage.ok,
            message: secondStage.executions.find((item) => item.ok === false)?.message || "",
            metrics: { productCount: firstStage.successfulCandidates.length, successCount: secondStage.successfulCandidates.length, failedCount: secondStage.executions.filter((item) => item.ok === false).length, totalBatches: batches.length }
          });
        }
      }
    }

    const firstById = new Map(firstStage.executions.map((execution) => [text(execution.id || `${execution.shopId}-${execution.productId}`), execution]));
    const secondById = new Map((secondStage?.executions || []).map((execution) => [text(execution.id || `${execution.shopId}-${execution.productId}`), execution]));
    for (const candidate of batch) {
      const key = text(candidate.id || `${candidate.shopId}-${candidate.productId}`);
      const first = firstById.get(key);
      const second = secondById.get(key);
      const recycledButCancelled = cancelledAfterRecycle && firstStage.successfulCandidates.some((item) => item.id === candidate.id);
      const terminal = recycledButCancelled
        ? executionFor([candidate], store, action, "cancelled", false, "bulk delete operation cancelled after recycle and before complete delete", finalKey, "delete")[0]
        : second || first || executionFor([candidate], store, action, "failed", false, "bulk delete execution result missing", recycleKey, "recycle")[0];
      const stageRows = [first, second].filter((item): item is DoudianBulkDeleteExecution => Boolean(item));
      executions.push({
        ...terminal,
        action,
        stages: stageRows.map((item) => ({ stage: item.stage || "recycle", status: item.status, ok: item.ok, message: item.message, planKey: item.planKey }))
      });
    }

    diagnostics.push(diagnostic);
    progressState.completed += batch.length;
    reportProgress(operationArgs, { phase: "execute", completed: progressState.completed, total: progressState.total, shopId: store.shopId, batchIndex: batchIndex + 1, totalBatches: batches.length });
    if (batchIndex < batches.length - 1 && !forceDryRun) {
      if (!operationCancelled(operationArgs)) await wait(batchDelayMs);
    }
  }
  const failedCount = executions.filter((item) => item.ok === false).length;
  const ok = failedCount === 0;
  const message = ok
    ? dryRun
      ? policyMessage(payload.adapter, "bulkDelete.messages.executeDryRun", "Bulk delete dry-run only; no platform write request was submitted", { count: candidates.length })
      : policyMessage(payload.adapter, "bulkDelete.messages.executedStore", "Bulk delete executed", { count: candidates.length })
    : executions.find((item) => item.ok === false)?.message || policyMessage(payload.adapter, "bulkDelete.messages.executeFailed", "Bulk delete failed");
  return {
    executions,
    detail: {
      shopId: store.shopId,
      shopName: store.shopName,
      status: ok ? (dryRun ? "dry_run" : "ok") : executions.some((item) => item.ok) ? "partial" : "failed",
      ok,
      message,
      reason: ok ? (dryRun ? "bulk-delete-execute-dry-run" : "") : "bulk-delete-execute-partial-or-failed",
      category: ok ? (dryRun ? "adapter-policy" : "") : "api",
      diagnostic: { batchSize, batches: diagnostics },
      index,
      total
    } as DoudianRunDetail
  };
}

async function saveExecuteRun(record: ExecuteRunRecord) {
  await repositoryPut(bulkDeleteExecuteStore, record);
}

async function fetchBulkDeleteScan(payload: DoudianAdapterPayload, args: BulkDeleteArgs): Promise<DoudianBulkDeleteResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const requested = new Set((args.shopIds || []).map((id) => text(id)).filter(Boolean));
  const targets = requested.size ? stores.filter((store) => requested.has(store.shopId)) : stores;
  const filters = normalizeFilters(args.filters);
  const sourceMode = normalizeSourceMode(args.sourceMode);
  if (sourceMode === "ids") {
    const unscopedCount = filters.importItems?.length
      ? filters.importItems.filter((item) => !text(item.shopId) && !text(item.shopName)).length
      : (filters.productIds || []).length;
    const maxUnscoped = policyNumber(payload.adapter, "bulkDelete.maxUnscopedProductIds", 50, 1, 500);
    const idMaxPages = policyNumber(payload.adapter, "bulkDelete.maxProductIdSearchPages", 2, 1, 10);
    const projectedRequests = targets.reduce((sum, store) => sum + productIdsForStore(filters, store).length * idMaxPages, 0);
    const maxRequests = policyNumber(payload.adapter, "bulkDelete.maxProjectedIdLookupRequests", 500, 1, 5000);
    if (unscopedCount > maxUnscoped) throw new Error(`bulk delete unscoped product IDs exceed limit: ${unscopedCount}/${maxUnscoped}`);
    if (projectedRequests > maxRequests) throw new Error(`bulk delete projected product lookup requests exceed limit: ${projectedRequests}/${maxRequests}`);
  }
  const { action, protectMode } = enforceSellingPolicy(filters, normalizeAction(args.action), normalizeProtectMode(args.protectMode));
  const runId = args.operationId || `bulk-delete-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const operationId = args.operationId || runId;
  const rows: DoudianBulkDeleteRow[] = [];
  const candidates: DoudianBulkDeleteCandidate[] = [];
  const details: DoudianRunDetail[] = [];
  const sourceHealth: Array<Record<string, unknown>> = [];
  reportProgress(args, { phase: "scan", completed: 0, total: targets.length, percent: 0 });
  const results = await scanStoresWithConcurrency(payload, targets, args, runId, filters, sourceMode, action, protectMode);
  for (const result of results) {
    rows.push(result.row);
    candidates.push(...result.candidates);
    details.push(result.detail);
    sourceHealth.push(...result.sourceHealth);
  }
  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.filter((detail) => !detail.ok).length;
  const cancelled = operationCancelled(args);
  if (cancelled) candidates.splice(0, candidates.length);
  const summary = scanSummary(rows, candidates, details, sourceHealth);
  const status = cancelled ? "cancelled" : failureCount ? (successCount ? "partial" : "failed") : "ok";
  const requestHash = requestPlanHash(payload.adapter);
  const message = cancelled
    ? policyMessage(payload.adapter, "bulkDelete.messages.cancelled", "Bulk delete scan cancelled")
    : failureCount
    ? policyMessage(payload.adapter, "bulkDelete.messages.partial", "Bulk delete scan partially failed", { successCount, failureCount })
    : policyMessage(payload.adapter, "bulkDelete.messages.done", "Bulk delete scan done", { count: candidates.length });
  const now = new Date().toISOString();
  reportProgress(args, { phase: "done", completed: details.length, total: targets.length, percent: cancelled ? undefined : 100, message });
  await saveScanRun({
    id: runId,
    mode: "scan",
    runId,
    operationId,
    status,
    sourceMode,
    action,
    protectMode,
    rows,
    candidates,
    details,
    scanSummary: summary,
    sourceHealth,
    filters,
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    requestPlanHash: requestHash,
    createdAt: now,
    updatedAt: now
  }, payload.adapter);
  return {
    ok: !cancelled && failureCount === 0,
    status,
    mode: "scan",
    sourceMode,
    action,
    protectMode,
    message,
    runId,
    operationId,
    rows,
    candidates,
    executions: [],
    details,
    successCount,
    failureCount,
    partialCount: failureCount,
    summary,
    scanSummary: summary,
    sourceHealth,
    filters,
    requestPlanHash: requestHash,
    stores,
    groups: ledger.groups || []
  };
}

async function fetchBulkDeleteExecute(payload: DoudianAdapterPayload, args: BulkDeleteArgs): Promise<DoudianBulkDeleteResult> {
  if (String(args.confirmText || "") !== "确认删除") throw new Error("bulk delete confirm text mismatch");
  const { run, sourceRunId, selected, action } = await loadExecuteCandidates(args);
  if (run.status !== "ok" && !(run.status === "partial" && args.allowPartialScan === true)) {
    throw new Error("bulk delete source scan is incomplete; explicitly allow execution for completed stores only");
  }
  const requestHash = requestPlanHash(payload.adapter);
  const maxPreviewAgeMs = policyNumber(payload.adapter, "bulkDelete.maxPreviewAgeMs", 15 * 60 * 1000, 60000, 24 * 60 * 60 * 1000);
  const previewAgeMs = Date.now() - new Date(run.createdAt).getTime();
  if (!Number.isFinite(previewAgeMs) || previewAgeMs > maxPreviewAgeMs) throw new Error("bulk delete source preview expired; generate a new preview");
  if (run.adapterVersion !== (payload.adapter.version || "") || run.requestPlanHash !== requestHash) throw new Error("bulk delete adapter changed after preview; generate a new preview");
  if (args.action && normalizeAction(args.action) !== action) throw new Error("bulk delete action differs from source preview");
  const protectMode = normalizeProtectMode(run.protectMode);
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const selectedShopIds = new Set(selected.map((candidate) => candidate.shopId).filter(Boolean));
  const targets = stores.filter((store) => selectedShopIds.has(store.shopId));
  if (targets.length !== selectedShopIds.size) throw new Error("bulk delete selected store ledger changed; generate a new preview");
  const byStore = new Map<string, { store: DoudianStoreSummary; candidates: DoudianBulkDeleteCandidate[] }>();
  for (const candidate of selected) {
    const store = targets.find((item) => item.shopId === candidate.shopId);
    if (!store) continue;
    const group = byStore.get(store.shopId) || { store, candidates: [] };
    group.candidates.push({ ...candidate, sourceRunId, action });
    byStore.set(store.shopId, group);
  }
  const groups = Array.from(byStore.values());
  if (!groups.length) throw new Error("bulk delete selected stores missing");
  const runId = args.operationId || `bulk-delete-exec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const operationId = args.operationId || runId;
  const executions: DoudianBulkDeleteExecution[] = [];
  const details: DoudianRunDetail[] = [];
  const progressState = { completed: 0, total: selected.length };
  reportProgress(args, { phase: "execute", completed: 0, total: selected.length, percent: 0 });
  for (const [index, group] of groups.entries()) {
    if (operationCancelled(args)) break;
    try {
      const result = await executeStore(payload, group.store, group.candidates, action, index + 1, groups.length, args.dryRun === true, runId, operationId, protectMode, args, progressState);
      executions.push(...result.executions);
      details.push(result.detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      details.push({
        shopId: group.store.shopId,
        shopName: group.store.shopName,
        status: "failed",
        ok: false,
        message,
        reason: "bulk-delete-execute-failed",
        category: "api",
        diagnostic: { action },
        index: index + 1,
        total: groups.length
      });
      executions.push(...executionFor(group.candidates, group.store, action, "failed", false, message, recyclePlanKey(payload.adapter), "recycle"));
      await recordOperationEvent({
        operationId,
        runId,
        phase: "execute",
        shopId: group.store.shopId,
        shopName: group.store.shopName,
        status: "failed",
        ok: false,
        message,
        metrics: { productCount: group.candidates.length, index: index + 1, total: groups.length }
      });
      if (operationCancelled(args)) break;
    }
  }
  const cancelled = operationCancelled(args);
  if (cancelled) {
    const executedIds = new Set(executions.map((execution) => text(execution.id || `${execution.shopId}-${execution.productId}`)));
    for (const candidate of selected) {
      const key = text(candidate.id || `${candidate.shopId}-${candidate.productId}`);
      if (executedIds.has(key)) continue;
      const store = targets.find((item) => item.shopId === candidate.shopId);
      if (store) executions.push(...executionFor([candidate], store, action, "cancelled", false, "bulk delete operation cancelled before batch submission", recyclePlanKey(payload.adapter), "recycle"));
    }
  }
  const successCount = executions.filter((execution) => execution.ok && execution.status === "submitted").length;
  const failureCount = executions.filter((execution) => execution.ok === false).length;
  const summary = executeSummary(executions);
  const dryRun = executions.length > 0 && executions.every((item) => item.status === "dry_run");
  const status = cancelled ? "cancelled" : failureCount ? (successCount ? "partial" : "failed") : "ok";
  const message = cancelled
    ? policyMessage(payload.adapter, "bulkDelete.messages.cancelled", "Bulk delete operation cancelled")
    : failureCount
    ? policyMessage(payload.adapter, "bulkDelete.messages.executePartial", "Bulk delete submitted with {failureCount} failures", { successCount, failureCount })
    : dryRun
      ? policyMessage(payload.adapter, "bulkDelete.messages.executeDryRun", "Bulk delete dry-run only; no platform write request was submitted", { count: executions.length })
      : policyMessage(payload.adapter, "bulkDelete.messages.executeDone", "Bulk delete submitted for {count} products", { count: selected.length });
  const now = new Date().toISOString();
  reportProgress(args, { phase: "done", completed: progressState.completed, total: progressState.total, percent: cancelled ? undefined : 100, message });
  await saveExecuteRun({
    id: runId,
    mode: "execute",
    runId,
    operationId,
    sourceRunId,
    action,
    confirmText: String(args.confirmText || ""),
    status,
    dryRun,
    executions,
    details,
    summary,
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    requestPlanHash: requestHash,
    createdAt: now,
    updatedAt: now
  });
  return {
    ok: !cancelled && failureCount === 0,
    status,
    mode: "execute",
    action,
    message,
    runId,
    operationId,
    sourceRunId,
    rows: [],
    candidates: selected,
    executions,
    details,
    successCount,
    failureCount,
    partialCount: failureCount,
    summary,
    scanSummary: {},
    sourceHealth: [],
    requestPlanHash: requestHash,
    stores,
    groups: ledger.groups || []
  };
}

export async function fetchBulkDeleteProducts(args: BulkDeleteArgs = {}): Promise<DoudianBulkDeleteResult> {
  const payload = adapterPayload(args);
  validateBulkDeleteAdapter(payload.adapter);
  if ((args.mode || "scan") === "execute") return fetchBulkDeleteExecute(payload, args);
  if ((args.mode || "scan") !== "scan") return { ok: false, status: "unsupported-mode", mode: args.mode, message: "unsupported bulk delete mode", rows: [], candidates: [], executions: [] };
  return fetchBulkDeleteScan(payload, args);
}

export async function restoreLatestBulkDeleteScan() {
  const runs = await repositoryGetAll<ScanRunRecord>(bulkDeleteScanStore);
  const latest = runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  if (!latest) return null;
  if (latest.candidates?.length) return latest;
  const candidates = await repositoryGetAllByPrefix<DoudianBulkDeleteCandidate>(bulkDeleteCandidateStore, `${latest.runId}:`, { pageSize: 500, maxItems: 50000 }).catch(() => []);
  return {
    ...latest,
    candidates: candidates.filter((candidate) => candidate.sourceRunId === latest.runId || candidate.sourceRunId === latest.id)
  };
}

export async function restoreLatestBulkDeleteExecute() {
  const runs = await repositoryGetAll<ExecuteRunRecord>(bulkDeleteExecuteStore);
  return runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
}

export async function runDoudianBulkDeleteSelfCheck(options: { doudianAdapter?: DoudianAdapterPayload } = {}) {
  const payload = adapterPayload({ doudianAdapter: options.doudianAdapter });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopId = `bulk-delete-self-check-${suffix}`;
  const scanRunId = `bulk-delete-self-check-scan-${suffix}`;
  const execRunId = `bulk-delete-self-check-exec-${suffix}`;
  try {
    await upsertStoreLedger({ shopId, shopName: `Bulk Delete Self Check ${suffix}`, platform: "doudian", partition: `persist:chihu-bulk-delete-self-check-${suffix}`, status: "online", groupName: "Self Check", adapterVersion: payload.adapter.version });
    const scan = await fetchBulkDeleteProducts({
      doudianAdapter: payload,
      mode: "scan",
      shopIds: [shopId],
      operationId: scanRunId,
      sourceMode: "range",
      action: "delete",
      protectMode: "includeSelling",
      filters: { keyword: "Self Check", status: "all", productIds: [] },
      mockProducts: [{
       product_id: `bulk-product-${suffix}`,
        title: "Self Check Bulk Product",
        status_name: "售卖中",
        create_time: "2026-01-01",
        audit_time: "2026-01-02",
        price: 1999,
        stock: 20,
         total_sales: 1
       }, {
         product_id: `bulk-rejected-${suffix}`,
         title: "Self Check Rejected Product",
         status: "1",
         tab: "审核驳回",
         stock: 3
       }, {
         product_id: `bulk-unknown-${suffix}`,
         title: "Self Check Unknown Product",
         status: "unmapped-status"
       }]
     });
     const candidate = scan.candidates?.[0];
     const rejectedCandidate = scan.candidates?.find((item) => item.productId === `bulk-rejected-${suffix}`);
     const unknownCandidate = scan.candidates?.find((item) => item.productId === `bulk-unknown-${suffix}`);
     const statusMappingOk = rejectedCandidate?.status === "rejected" && rejectedCandidate.ok === true;
     const unknownFieldOk = unknownCandidate?.status === "unknown" && unknownCandidate.ok === false && unknownCandidate.price === undefined && unknownCandidate.sales === undefined;
    const execute = await fetchBulkDeleteProducts({
      doudianAdapter: payload,
      mode: "execute",
      shopIds: [shopId],
      operationId: execRunId,
      action: "delete",
      candidateIds: candidate ? [candidate.id] : [],
      sourceRunId: scanRunId,
      confirmText: "确认删除",
      dryRun: true
    });
    const restoredScan = await restoreLatestBulkDeleteScan();
    const restoredExecute = await restoreLatestBulkDeleteExecute();
    const dryRunOk = execute.executions?.every((item) => item.status === "dry_run") === true;
    return {
       ok: scan.ok === true && !!candidate && statusMappingOk && unknownFieldOk && execute.ok === true && dryRunOk && restoredScan?.runId === scanRunId && restoredExecute?.runId === execRunId,
      scanOk: scan.ok === true,
       candidateOk: !!candidate,
       statusMappingOk,
       unknownFieldOk,
      executeOk: execute.ok === true,
      dryRunOk,
      restoreScanOk: restoredScan?.runId === scanRunId,
      restoreExecuteOk: restoredExecute?.runId === execRunId,
      scanRunId,
      execRunId
    };
  } finally {
    await deleteStoreLedger([shopId]).catch(() => undefined);
    await repositoryDelete(bulkDeleteScanStore, scanRunId).catch(() => undefined);
    await repositoryDelete(bulkDeleteExecuteStore, execRunId).catch(() => undefined);
    const candidates = await repositoryGetAllByPrefix<DoudianBulkDeleteCandidate>(bulkDeleteCandidateStore, `${scanRunId}:`, { pageSize: 500, maxItems: 50000 }).catch(() => []);
    await Promise.all(candidates.map((candidate) => repositoryDelete(bulkDeleteCandidateStore, candidate.id).catch(() => undefined)));
    const scanEvents = await repositoryGetAllByPrefix<OperationEventRecord>(bulkDeleteOperationEventStore, `${scanRunId}:`, { pageSize: 500, maxItems: 50000 }).catch(() => []);
    const executeEvents = await repositoryGetAllByPrefix<OperationEventRecord>(bulkDeleteOperationEventStore, `${execRunId}:`, { pageSize: 500, maxItems: 50000 }).catch(() => []);
    await Promise.all([...scanEvents, ...executeEvents].map((event) => repositoryDelete(bulkDeleteOperationEventStore, event.id).catch(() => undefined)));
  }
}
