import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianRunDetail,
  DoudianStaleGoodsAction,
  DoudianStaleGoodsCandidate,
  DoudianStaleGoodsCleanupResult,
  DoudianStaleGoodsExecution,
  DoudianStaleGoodsRow,
  DoudianStaleGoodsRules,
  DoudianStoreSummary
} from "../../types";
import { repositoryDelete, repositoryGetAll, repositoryPut } from "./repository";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";
import { requireChihuNative } from "../../native/client";
import { prepareMutationSafety, recordExecutionMutationResults } from "./mutationSafety";

interface StaleGoodsArgs {
  doudianAdapter?: DoudianAdapterPayload;
  mode?: "scan" | "execute" | string;
  shopIds?: string[];
  rules?: DoudianStaleGoodsRules;
  compassFileName?: string;
  compassRows?: Array<Record<string, unknown>>;
  operationId?: string;
  pageSize?: number;
  maxProductListPages?: number;
  mockProducts?: Array<Record<string, unknown>>;
  action?: DoudianStaleGoodsAction | string;
  candidateIds?: string[];
  candidates?: DoudianStaleGoodsCandidate[];
  sourceRunId?: string;
  confirmText?: string;
}

interface ScanRunRecord {
  id: string;
  mode: "scan";
  runId: string;
  operationId?: string;
  status: string;
  rows: DoudianStaleGoodsRow[];
  candidates: DoudianStaleGoodsCandidate[];
  details: DoudianRunDetail[];
  scanSummary: Record<string, number>;
  sourceHealth: Array<Record<string, unknown>>;
  rules: DoudianStaleGoodsRules;
  adapterVersion: string;
  scriptsVersion: string;
  cleanupRuleVersion: string;
  fieldSchemaVersion: string;
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
  action: string;
  confirmText: string;
  status: string;
  dryRun: boolean;
  executions: DoudianStaleGoodsExecution[];
  details: DoudianRunDetail[];
  summary: Record<string, number>;
  adapterVersion: string;
  scriptsVersion: string;
  cleanupRuleVersion: string;
  fieldSchemaVersion: string;
  requestPlanHash: string;
  createdAt: string;
  updatedAt: string;
}

function text(value: unknown) {
  return String(value || "").trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function policy(adapter: DoudianAdapterConfig, path: string, fallback: unknown = undefined): unknown {
  const value = getPathValue(adapter.policies || {}, path);
  return value === undefined ? fallback : value;
}

function policyArray(adapter: DoudianAdapterConfig, path: string) {
  const value = policy(adapter, path, []);
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
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

function mappings(adapter: DoudianAdapterConfig) {
  return objectRecord(objectRecord(adapter.responseMappings).staleGoodsCleanup);
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

function defaultRules(adapter: DoudianAdapterConfig): DoudianStaleGoodsRules {
  const config = objectRecord(policy(adapter, "staleGoodsCleanup.defaultRules", {}));
  return {
    totalSalesEnabled: config.totalSalesEnabled !== false,
    totalSalesMax: Number(config.totalSalesMax ?? 5),
    exposureEnabled: config.exposureEnabled !== false,
    exposureMax: Number(config.exposureMax ?? 800),
    clickEnabled: config.clickEnabled !== false,
    clickMax: Number(config.clickMax ?? 30),
    exposureUsersEnabled: config.exposureUsersEnabled === true,
    exposureUsersMax: Number(config.exposureUsersMax ?? 0),
    clickUsersEnabled: config.clickUsersEnabled === true,
    clickUsersMax: Number(config.clickUsersMax ?? 0),
    periodSalesEnabled: config.periodSalesEnabled === true,
    periodSalesMax: Number(config.periodSalesMax ?? 0),
    stockRangeEnabled: config.stockRangeEnabled === true,
    stockMin: Number(config.stockMin ?? 0),
    stockMax: Number(config.stockMax ?? 0),
    priceRangeEnabled: config.priceRangeEnabled === true,
    minPrice: Number(config.minPrice ?? 0),
    maxPrice: Number(config.maxPrice ?? 99999),
    skipCreatedDaysEnabled: config.skipCreatedDaysEnabled !== false,
    noSalesDays: Number(config.noSalesDays ?? 30),
    skipListedDaysEnabled: config.skipListedDaysEnabled === true,
    listedDays: Number(config.listedDays ?? 0),
    trafficPeriod: (config.trafficPeriod === "7d" || config.trafficPeriod === "90d") ? config.trafficPeriod : "30d",
    noSalesType: (config.noSalesType === "strict" || config.noSalesType === "trafficWaste") ? config.noSalesType : "balanced",
    requireLowRating: config.requireLowRating === true,
    requireLowInfo: config.requireLowInfo === true,
    requireLowImage: config.requireLowImage === true,
    requireSameStyleRisk: config.requireSameStyleRisk === true,
    requireBadTitle: config.requireBadTitle === true
  };
}

function normalizeRules(args: StaleGoodsArgs, adapter: DoudianAdapterConfig) {
  return { ...defaultRules(adapter), ...(args.rules || {}) };
}

function qualityIssues(row: DoudianStaleGoodsCandidate) {
  return {
    lowRating: Number(row.ratingScore || 0) > 0 && Number(row.ratingScore || 0) < 4.5,
    lowInfo: Number(row.infoQualityScore || 0) > 0 && Number(row.infoQualityScore || 0) < 70,
    lowImage: Number(row.mainImageScore || 0) > 0 && Number(row.mainImageScore || 0) < 70,
    sameStyleRisk: row.sameStyleRisk === true,
    badTitle: Number(row.titleQualityScore || 0) > 0 && Number(row.titleQualityScore || 0) < 70
  };
}

function qualityLabels(row: DoudianStaleGoodsCandidate) {
  const issues = qualityIssues(row);
  return [
    issues.lowRating ? "low rating" : "",
    issues.lowInfo ? "low info quality" : "",
    issues.lowImage ? "low main image quality" : "",
    issues.sameStyleRisk ? "same style risk" : "",
    issues.badTitle ? "low title quality" : ""
  ].filter(Boolean);
}

function scoreCandidate(row: DoudianStaleGoodsCandidate) {
  const qualityIssueCount = qualityLabels(row).length;
  const noPeriodSales = Number(row.periodSales || 0) === 0 ? 30 : 0;
  const lowTotalSales = Number(row.totalSales || 0) <= 5 ? 18 : 0;
  const trafficWaste = Number(row.exposureCount || 0) >= 1000 && Number(row.periodSales || 0) === 0 ? 20 : 0;
  const stockPressure = Number(row.stock || 0) >= 80 ? 12 : Number(row.stock || 0) >= 30 ? 8 : 4;
  const ageDays = Number(row.daysSinceAge ?? -1);
  const age = ageDays >= 90 ? 10 : ageDays >= 30 ? 6 : 0;
  const quality = Math.min(15, qualityIssueCount * 4);
  return Math.min(100, noPeriodSales + lowTotalSales + trafficWaste + stockPressure + age + quality);
}

function riskFromScore(score: number) {
  if (score >= 72) return "high";
  if (score >= 48) return "medium";
  return "low";
}

function actionFromCandidate(row: DoudianStaleGoodsCandidate) {
  const issues = qualityLabels(row);
  const hasTrafficWaste = Number(row.exposureCount || 0) >= 1000 && Number(row.periodSales || 0) === 0;
  if (Number(row.totalSales || 0) <= 1 && Number(row.periodSales || 0) === 0 && issues.length >= 3) return "delete";
  if (Number(row.totalSales || 0) <= 2 && Number(row.periodSales || 0) === 0 && Number(row.stock || 0) >= 80) return "recycle";
  if (hasTrafficWaste || Number(row.stock || 0) >= 30) return "offline";
  return "optimize";
}

function reasons(row: DoudianStaleGoodsCandidate) {
  const output = [];
  if (Number(row.periodSales || 0) === 0) output.push("no period sales");
  if (Number(row.totalSales || 0) <= 5) output.push("low total sales");
  if (Number(row.exposureCount || 0) >= 1000 && Number(row.periodSales || 0) === 0) output.push("traffic without conversion");
  if (Number(row.clickCount || 0) <= 30) output.push("low clicks");
  if (Number(row.stock || 0) >= 80) output.push("stock pressure");
  if (Number(row.daysSinceAge ?? -1) >= 30) output.push("old product");
  return [...output, ...qualityLabels(row)].slice(0, 5);
}

function candidateFromProduct(store: DoudianStoreSummary, product: Record<string, unknown>, adapter: DoudianAdapterConfig, runId: string, index: number, compassById: Map<string, Record<string, unknown>>) {
  const productId = readText(product, adapter, "productId") || `product-${index + 1}`;
  const compass = compassById.get(productId) || {};
  const createdAt = normalizeDate(readField(product, adapter, "createdAt") || compass.createdAt || compass.createTime);
  const listedAt = normalizeDate(readField(product, adapter, "listedAt") || compass.listedAt || compass.auditTime);
  const ageDate = createdAt || listedAt;
  const base: DoudianStaleGoodsCandidate = {
    id: `${runId}-${store.shopId}-${productId}`,
    candidateId: `${store.shopId}-${productId}`,
    sourceRunId: runId,
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    productId,
    title: readText(product, adapter, "title") || text(compass.title || compass.name) || productId,
    category: readText(product, adapter, "category") || text(compass.category) || "",
    status: readText(product, adapter, "status") || text(compass.status) || "\u5728\u552e",
    createdAt,
    listedAt,
    ageDate,
    ageDateType: createdAt ? "createdAt" : listedAt ? "listedAt" : "",
    daysSinceAge: daysSince(ageDate),
    daysSinceCreated: daysSince(createdAt),
    daysSinceListed: daysSince(listedAt),
    price: readNumber(product, adapter, "price", Number(compass.price || 0)),
    stock: readNumber(product, adapter, "stock", Number(compass.stock || 0)),
    totalSales: readNumber(product, adapter, "totalSales", Number(compass.totalSales || compass.sales || 0)),
    periodSales: readNumber(product, adapter, "periodSales", Number(compass.periodSales || compass.payOrderCount || 0)),
    exposureCount: readNumber(product, adapter, "exposureCount", Number(compass.exposureCount || compass.showCount || 0)),
    clickCount: readNumber(product, adapter, "clickCount", Number(compass.clickCount || 0)),
    exposureUsers: readNumber(product, adapter, "exposureUsers", Number(compass.exposureUsers || 0)),
    clickUsers: readNumber(product, adapter, "clickUsers", Number(compass.clickUsers || 0)),
    ratingScore: readNumber(product, adapter, "ratingScore", Number(compass.ratingScore || 0)),
    infoQualityScore: readNumber(product, adapter, "infoQualityScore", Number(compass.infoQualityScore || 0)),
    mainImageScore: readNumber(product, adapter, "mainImageScore", Number(compass.mainImageScore || 0)),
    titleQualityScore: readNumber(product, adapter, "titleQualityScore", Number(compass.titleQualityScore || 0)),
    sameStyleRisk: Boolean(readField(product, adapter, "sameStyleRisk") || compass.sameStyleRisk),
    risk: "low",
    riskScore: 0,
    action: "optimize",
    reasons: [],
    source: "platform product list"
  };
  const riskScore = scoreCandidate(base);
  base.riskScore = riskScore;
  base.risk = riskFromScore(riskScore);
  base.action = actionFromCandidate(base);
  base.reasons = reasons(base);
  return base;
}

function evaluateRules(row: DoudianStaleGoodsCandidate, rules: DoudianStaleGoodsRules) {
  const withinSales = !rules.totalSalesEnabled || Number(row.totalSales || 0) <= rules.totalSalesMax;
  const withinPeriodSales = !rules.periodSalesEnabled || Number(row.periodSales || 0) <= rules.periodSalesMax;
  const withinExposure = !rules.exposureEnabled || Number(row.exposureCount || 0) <= rules.exposureMax;
  const withinClick = !rules.clickEnabled || Number(row.clickCount || 0) <= rules.clickMax;
  const withinExposureUsers = !rules.exposureUsersEnabled || Number(row.exposureUsers || 0) <= Number(rules.exposureUsersMax || 0);
  const withinClickUsers = !rules.clickUsersEnabled || Number(row.clickUsers || 0) <= Number(rules.clickUsersMax || 0);
  const metricEnabled = [rules.totalSalesEnabled, rules.periodSalesEnabled, rules.exposureEnabled, rules.clickEnabled, rules.exposureUsersEnabled, rules.clickUsersEnabled].some(Boolean);
  const metricMatch = metricEnabled ? [withinSales, withinPeriodSales, withinExposure, withinClick, withinExposureUsers, withinClickUsers].every(Boolean) : true;
  const stockMax = Number(rules.stockMax || 0);
  const priceMax = Number(rules.maxPrice || 0);
  const stockMatch = !rules.stockRangeEnabled || (Number(row.stock || 0) >= rules.stockMin && (!stockMax || Number(row.stock || 0) <= stockMax));
  const priceMatch = !rules.priceRangeEnabled || (Number(row.price || 0) >= rules.minPrice && (!priceMax || Number(row.price || 0) <= priceMax));
  const createdOldEnough = !rules.skipCreatedDaysEnabled || (Number(row.daysSinceCreated ?? -1) >= rules.noSalesDays);
  const listedOldEnough = !rules.skipListedDaysEnabled || (Number(row.daysSinceListed ?? -1) >= Number(rules.listedDays || 0));
  const issues = qualityIssues(row);
  const qualityRules = [
    rules.requireLowRating ? issues.lowRating : false,
    rules.requireLowInfo ? issues.lowInfo : false,
    rules.requireLowImage ? issues.lowImage : false,
    rules.requireSameStyleRisk ? issues.sameStyleRisk : false,
    rules.requireBadTitle ? issues.badTitle : false
  ];
  const hasQualityRule = [rules.requireLowRating, rules.requireLowInfo, rules.requireLowImage, rules.requireSameStyleRisk, rules.requireBadTitle].some(Boolean);
  const qualityMatch = hasQualityRule ? qualityRules.some(Boolean) : true;
  const baseMatch = stockMatch && priceMatch && createdOldEnough && listedOldEnough && qualityMatch;
  const typeMatch = rules.noSalesType === "strict"
    ? Number(row.periodSales || 0) === 0 && (!rules.totalSalesEnabled || Number(row.totalSales || 0) <= rules.totalSalesMax)
    : rules.noSalesType === "trafficWaste"
      ? Number(row.exposureCount || 0) >= (rules.exposureEnabled ? rules.exposureMax : 0) && Number(row.periodSales || 0) <= rules.periodSalesMax
      : metricMatch;
  return baseMatch && typeMatch;
}

function buildRow(store: DoudianStoreSummary, candidates: DoudianStaleGoodsCandidate[], remoteTotal = 0): DoudianStaleGoodsRow {
  return {
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    status: store.status,
    totalProducts: remoteTotal || candidates.length,
    candidateCount: candidates.length,
    highRiskCount: candidates.filter((item) => item.risk === "high").length,
    offlineCount: candidates.filter((item) => item.action === "offline").length,
    recycleCount: candidates.filter((item) => item.action === "recycle").length,
    deleteCount: candidates.filter((item) => item.action === "delete").length,
    optimizeCount: candidates.filter((item) => item.action === "optimize").length,
    trafficWasteCount: candidates.filter((item) => Number(item.exposureCount || 0) >= 1000 && Number(item.periodSales || 0) === 0).length,
    qualityIssueCount: candidates.filter((item) => qualityLabels(item).length > 0).length,
    stockCount: candidates.reduce((sum, item) => sum + Number(item.stock || 0), 0)
  };
}

function adapterPayload(args: StaleGoodsArgs): DoudianAdapterPayload {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  return args.doudianAdapter;
}

function requestPlanKeys(adapter: DoudianAdapterConfig) {
  return policyArray(adapter, "staleGoodsCleanup.requestPlans");
}

function requestPlanHash(adapter: DoudianAdapterConfig, planKeys: string[]) {
  return `${adapter.version || ""}:${policyText(adapter, "staleGoodsCleanup.fieldSchemaVersion", "")}:${planKeys.join("|")}:${JSON.stringify(policy(adapter, "staleGoodsCleanup.executePlans", {}))}`;
}

function executePlans(adapter: DoudianAdapterConfig) {
  return objectRecord(policy(adapter, "staleGoodsCleanup.executePlans", {}));
}

function actionPlanKey(adapter: DoudianAdapterConfig, action: string) {
  const plans = executePlans(adapter);
  if (plans[action]) return text(plans[action]);
  if (action === "offline") return "staleGoodsBatchOffline";
  if (action === "recycle") return "staleGoodsBatchDelete";
  if (action === "delete") return "staleGoodsCompleteDelete";
  return "";
}

function executePlanGuard(adapter: DoudianAdapterConfig, action: string, planKey: string) {
  const plan = objectRecord(adapter.requestPlans?.[planKey]);
  return {
    ok: !!planKey && !!adapter.requestPlans?.[planKey] && ["offline", "recycle", "delete"].includes(action),
    dryRunOnly: plan.dryRunOnly !== false,
    action,
    planKey,
    method: text(plan.method || "GET").toUpperCase(),
    endpointKey: text(plan.endpointKey || planKey)
  };
}

function normalizeExecuteCandidates(args: StaleGoodsArgs) {
  const selectedIds = new Set((args.candidateIds || []).map((id) => text(id)).filter(Boolean));
  return (args.candidates || [])
    .filter((item) => item && typeof item === "object")
    .filter((item) => !selectedIds.size || selectedIds.has(text(item.id || `${item.shopId || ""}-${item.productId || ""}`)))
    .map((item) => ({
      ...item,
      id: text(item.id || `${item.shopId || ""}-${item.productId || ""}`),
      candidateId: text(item.candidateId || item.id || `${item.shopId || ""}-${item.productId || ""}`),
      sourceRunId: text(item.sourceRunId || args.sourceRunId),
      shopId: text(item.shopId),
      shopName: text(item.shopName),
      productId: text(item.productId),
      title: text(item.title),
      action: text(args.action || item.action)
    }))
    .filter((item) => item.shopId && item.productId && ["offline", "recycle", "delete"].includes(item.action));
}

async function validateExecuteSourceRun(sourceRunId: string, selected: DoudianStaleGoodsCandidate[]) {
  if (!sourceRunId) throw new Error("stale goods execute requires sourceRunId");
  const run = await repositoryGetAll<ScanRunRecord>("stale_scan_runs")
    .then((runs) => runs.find((item) => item.runId === sourceRunId || item.id === sourceRunId) || null);
  if (!run) throw new Error("stale goods source scan run not found");
  const candidates = await repositoryGetAll<DoudianStaleGoodsCandidate>("stale_candidates");
  const valid = new Set(candidates.filter((item) => item.sourceRunId === sourceRunId).flatMap((item) => [
    text(item.id),
    text(item.candidateId),
    `${item.shopId}-${item.productId}`
  ]).filter(Boolean));
  const invalid = selected.filter((item) => !valid.has(text(item.id)) && !valid.has(text(item.candidateId)) && !valid.has(`${item.shopId}-${item.productId}`));
  if (invalid.length) throw new Error(`stale goods candidates are not from source run: ${invalid.slice(0, 3).map((item) => item.productId).join(",")}`);
  return run;
}

function executeSummary(executions: DoudianStaleGoodsExecution[]) {
  return {
    executionCount: executions.length,
    submittedCount: executions.filter((item) => item.status === "submitted").length,
    dryRunCount: executions.filter((item) => item.status === "dry_run").length,
    failedCount: executions.filter((item) => item.ok === false).length,
    skippedCount: executions.filter((item) => item.status === "skipped").length,
    offlineCount: executions.filter((item) => item.action === "offline").length,
    recycleCount: executions.filter((item) => item.action === "recycle").length,
    deleteCount: executions.filter((item) => item.action === "delete").length
  };
}

function staleExecutionsFromRejected(
  store: DoudianStoreSummary,
  rejected: Array<{ item: DoudianStaleGoodsCandidate; mutationKey: string; status: string; ok: boolean; message: string; liveLifecycleStatus?: string }>,
  action: string,
  planKey: string
): DoudianStaleGoodsExecution[] {
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
    planKey
  }));
}

async function executeStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, candidates: DoudianStaleGoodsCandidate[], action: string, planKey: string, index: number, total: number, runId: string) {
  const guard = executePlanGuard(payload.adapter, action, planKey);
  let productIds = candidates.map((item) => item.productId).filter(Boolean);
  const requestContext = {
    productIds: productIds.join(","),
    productIdList: productIds,
    productCount: productIds.length,
    action,
    shopId: store.shopId,
    shopName: store.shopName,
    partition: store.partition,
    shopPartition: store.partition
  };
  if (!guard.ok) {
    const message = `stale goods execute plan unavailable for ${action}`;
    return {
      executions: candidates.map((item) => ({
        id: item.id,
        sourceRunId: item.sourceRunId,
        shopId: store.shopId,
        shopName: store.shopName,
        productId: item.productId,
        title: item.title || "",
        action,
        status: "failed",
        ok: false,
        message,
        planKey
      })),
      detail: {
        shopId: store.shopId,
        shopName: store.shopName,
        status: "failed",
        ok: false,
        message,
        reason: "stale-goods-execute-plan-missing",
        category: "adapter",
        diagnostic: { guard, productCount: productIds.length },
        index,
        total
      } as DoudianRunDetail
    };
  }
  if (guard.dryRunOnly) {
    const message = policyMessage(payload.adapter, "staleGoodsCleanup.messages.executeDryRun", "Stale goods cleanup dry-run only; no platform write request was submitted", { count: productIds.length });
    return {
      executions: candidates.map((item) => ({
        id: item.id,
        sourceRunId: item.sourceRunId,
        shopId: store.shopId,
        shopName: store.shopName,
        productId: item.productId,
        title: item.title || "",
        action,
        status: "dry_run",
        ok: true,
        message,
        planKey
      })),
      detail: {
        shopId: store.shopId,
        shopName: store.shopName,
        status: "dry_run",
        ok: true,
        message,
        reason: "stale-goods-execute-dry-run",
        category: "adapter-policy",
        diagnostic: { guard, requestContext },
        index,
        total
      } as DoudianRunDetail
    };
  }
  const safety = await prepareMutationSafety({
    payload,
    store,
    candidates,
    feature: "stale-goods",
    runId,
    sourceRunId: candidates.find((item) => item.sourceRunId)?.sourceRunId,
    operationId: runId,
    action,
    stage: action,
    planKey
  });
  const rejectedExecutions = staleExecutionsFromRejected(store, safety.rejected, action, planKey);
  const safeCandidates = safety.allowed;
  if (!safeCandidates.length) {
    return {
      executions: rejectedExecutions,
      detail: {
        shopId: store.shopId,
        shopName: store.shopName,
        status: rejectedExecutions.some((item) => item.ok === false) ? "failed" : "skipped",
        ok: rejectedExecutions.length > 0 && rejectedExecutions.every((item) => item.ok !== false),
        message: rejectedExecutions.find((item) => item.ok === false)?.message || rejectedExecutions[0]?.message || "stale goods execute blocked by live lookup",
        reason: "stale-goods-live-lookup-blocked",
        category: "catalog-mutation-safety",
        diagnostic: { guard, mutationSafety: safety.audit, productCount: productIds.length },
        index,
        total
      } as DoudianRunDetail
    };
  }
  productIds = safeCandidates.map((item) => item.productId).filter(Boolean);
  const safeRequestContext = {
    ...requestContext,
    productIds: productIds.join(","),
    productIdList: productIds,
    productCount: productIds.length
  };
  const response = await runDoudianRequestPlan(payload, { partition: store.partition, planKey, context: safeRequestContext });
  const ok = requestPlanResponseOk(response, payload.adapter, planKey, mappings(payload.adapter));
  const message = ok
    ? policyMessage(payload.adapter, "staleGoodsCleanup.messages.executedStore", "Stale goods cleanup executed", { count: productIds.length })
    : response.error || policyMessage(payload.adapter, "staleGoodsCleanup.messages.executeFailed", "Stale goods cleanup failed");
  const executions: DoudianStaleGoodsExecution[] = [
    ...rejectedExecutions,
    ...safeCandidates.map((item) => ({
      id: item.id,
      sourceRunId: item.sourceRunId,
      mutationKey: item.mutationKey,
      mutationStatus: ok ? "acknowledged" : "failed",
      liveLifecycleStatus: item.liveLifecycleStatus,
      shopId: store.shopId,
      shopName: store.shopName,
      productId: item.productId,
      title: item.title || "",
      action,
      status: ok ? "submitted" : "failed",
      ok,
      message,
      planKey
    }))
  ];
  await recordExecutionMutationResults({ store, executions, defaultAction: action }).catch(() => undefined);
  return {
    executions,
    detail: {
      shopId: store.shopId,
      shopName: store.shopName,
      status: ok ? "ok" : "failed",
      ok,
      message,
      reason: ok ? "" : "stale-goods-execute-request-failed",
      category: ok ? "" : "api",
      diagnostic: { guard, mutationSafety: safety.audit, response: { status: response.status, ok: response.ok, source: response.source }, productCount: productIds.length, requestContext: safeRequestContext },
      index,
      total
    } as DoudianRunDetail
  };
}

async function saveExecuteRun(record: ExecuteRunRecord) {
  await repositoryPut("stale_execute_runs", record);
}

function compassByProductId(rows: Array<Record<string, unknown>> = []) {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const productId = text(row.productId || row.product_id || row.goods_id || row["\u5546\u54c1ID"]);
    if (productId) map.set(productId, row);
  }
  return map;
}

async function collectProducts(payload: DoudianAdapterPayload, store: DoudianStoreSummary, planKeys: string[], args: StaleGoodsArgs) {
  if (args.mockProducts?.length) return { products: args.mockProducts, remoteTotal: args.mockProducts.length, sourceHealth: [], responses: {} as Record<string, RequestPlanResult> };
  const products: Record<string, unknown>[] = [];
  const responses: Record<string, RequestPlanResult> = {};
  let remoteTotal = 0;
  const pageSize = Math.max(10, Math.min(200, Math.floor(Number(args.pageSize || policyNumber(payload.adapter, "staleGoodsCleanup.pageSize", 100, 10, 200)))));
  const maxPages = Math.max(1, Math.min(50, Math.floor(Number(args.maxProductListPages || policyNumber(payload.adapter, "staleGoodsCleanup.maxProductListPages", 20, 1, 50)))));
  const pageStart = policyNumber(payload.adapter, "staleGoodsCleanup.pageStart", 0, 0, 1);
  for (const planKey of planKeys) {
    if (planKey !== "staleGoodsProductList") {
      responses[planKey] = await runDoudianRequestPlan(payload, { partition: store.partition, planKey, context: { page: "0", pageSize: String(pageSize), productStatus: "", keyword: "" } }).catch((error) => ({ ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error), source: planKey }));
      continue;
    }
    for (let page = pageStart; page < pageStart + maxPages; page += 1) {
      const response = await runDoudianRequestPlan(payload, {
        partition: store.partition,
        planKey,
        context: { page: String(page), pageSize: String(pageSize), productStatus: policyText(payload.adapter, "staleGoodsCleanup.productStatus", ""), keyword: "" }
      });
      responses[page === pageStart ? planKey : `${planKey}:page:${page}`] = response;
      const payloadForPage = { [planKey]: response.data };
      const items = firstArray(payloadForPage, listPaths(payload.adapter));
      products.push(...items.map((item) => objectRecord(item)));
      remoteTotal = readTotal(payloadForPage, payload.adapter) || remoteTotal;
      if (!requestPlanResponseOk(response, payload.adapter, planKey, mappings(payload.adapter))) break;
      if (!remoteTotal || products.length >= remoteTotal) break;
    }
  }
  return {
    products,
    remoteTotal: remoteTotal || products.length,
    sourceHealth: Object.entries(responses).map(([key, response]) => ({ key, status: response.status, ok: requestPlanResponseOk(response, payload.adapter, key.split(":page:")[0], mappings(payload.adapter)) })),
    responses
  };
}

function readTotal(payload: unknown, adapter: DoudianAdapterConfig) {
  const total = coerceNumber(firstPathValue(payload, totalPaths(adapter)));
  return total !== undefined ? total : 0;
}

function responseCode(response: RequestPlanResult | undefined) {
  return firstPathValue(response?.data, ["code", "st", "status_code", "statusCode", "errno"]);
}

function responseMessage(response: RequestPlanResult | undefined) {
  return text(firstPathValue(response?.data, ["msg", "message", "status_msg", "statusMessage"]) || response?.error || "").slice(0, 160);
}

function summarizeResponses(responses: Record<string, RequestPlanResult>, adapter: DoudianAdapterConfig) {
  return Object.fromEntries(Object.entries(responses).map(([key, response]) => {
    const planKey = key.split(":page:")[0] || key;
    return [key, {
      status: response.status || 0,
      success: requestPlanResponseOk(response, adapter, planKey, mappings(adapter)),
      code: responseCode(response) ?? null,
      message: responseMessage(response)
    }];
  }));
}

async function reportStaleGoodsRow(args: {
  store: DoudianStoreSummary;
  row: DoudianStaleGoodsRow;
  detail: DoudianRunDetail;
  products: DoudianStaleGoodsCandidate[];
  candidates: DoudianStaleGoodsCandidate[];
  responses: Record<string, RequestPlanResult>;
  adapter: DoudianAdapterConfig;
}) {
  try {
    const responseSummary = summarizeResponses(args.responses, args.adapter);
    await requireChihuNative().logs.report({
      category: "doudian-stale-goods",
      event: "row",
      shopId: args.store.shopId,
      shopName: args.store.shopName,
      partition: args.store.partition,
      ok: args.detail.ok === true,
      status: args.detail.status || "",
      reason: args.detail.reason || "",
      message: args.detail.message || "",
      metrics: {
        productCount: args.products.length,
        candidateCount: args.candidates.length,
        remoteTotal: args.row.totalProducts,
        highRiskCount: args.row.highRiskCount,
        offlineCount: args.row.offlineCount,
        recycleCount: args.row.recycleCount,
        deleteCount: args.row.deleteCount,
        optimizeCount: args.row.optimizeCount
      },
      sourceHealth: objectRecord(args.detail.diagnostic).sourceHealth || [],
      responses: responseSummary
    }).catch(() => undefined);
  } catch {
    // Diagnostics must never block syncing.
  }
}

async function scanStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, planKeys: string[], args: StaleGoodsArgs, runId: string, rules: DoudianStaleGoodsRules) {
  const collected = await collectProducts(payload, store, planKeys, args);
  const compass = compassByProductId(args.compassRows || []);
  const products = collected.products.map((product, index) => candidateFromProduct(store, product, payload.adapter, runId, index, compass));
  const candidates = products.filter((product) => evaluateRules(product, rules));
  const row = buildRow(store, candidates, collected.remoteTotal);
  const ok = args.mockProducts?.length ? true : planKeys.includes("staleGoodsProductList")
    ? Object.entries(collected.responses).some(([key, response]) => key.startsWith("staleGoodsProductList") && requestPlanResponseOk(response, payload.adapter, "staleGoodsProductList", mappings(payload.adapter)))
    : true;
  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? "ok" : "failed",
    ok,
    message: ok
      ? candidates.length ? policyMessage(payload.adapter, "staleGoodsCleanup.messages.scanned", "Stale goods scanned") : policyMessage(payload.adapter, "staleGoodsCleanup.messages.noCandidateStore", "No stale goods candidates")
      : policyMessage(payload.adapter, "staleGoodsCleanup.messages.failed", "Stale goods scan failed"),
    reason: ok ? (candidates.length ? "" : "stale-goods-no-candidate") : "stale-goods-request-failed",
    category: ok ? "" : "api",
    diagnostic: {
      productCount: products.length,
      candidateCount: candidates.length,
      remoteTotal: collected.remoteTotal,
      sourceHealth: collected.sourceHealth
    }
  };
  await reportStaleGoodsRow({
    store,
    row,
    detail,
    products,
    candidates,
    responses: collected.responses,
    adapter: payload.adapter
  });
  return { row, products, candidates, detail, sourceHealth: collected.sourceHealth };
}

async function saveScanRun(record: ScanRunRecord) {
  await repositoryPut("stale_scan_runs", record);
  for (const candidate of record.candidates) {
    await repositoryPut("stale_candidates", { ...candidate, id: candidate.id });
  }
}

function scanSummary(rows: DoudianStaleGoodsRow[], candidates: DoudianStaleGoodsCandidate[], details: DoudianRunDetail[], sourceHealth: Array<Record<string, unknown>>) {
  return {
    productCount: rows.reduce((sum, row) => sum + Number(row.totalProducts || 0), 0),
    remoteTotal: rows.reduce((sum, row) => sum + Number(row.totalProducts || 0), 0),
    candidateCount: candidates.length,
    ageBlocked: 0,
    missingCreatedAt: candidates.filter((item) => !item.createdAt).length,
    missingListedAt: candidates.filter((item) => !item.listedAt).length,
    missingAgeDate: candidates.filter((item) => !item.ageDate).length,
    sourceFailureCount: details.filter((detail) => detail.ok === false).length,
    diagnosticSourceCount: sourceHealth.filter((item) => item.key !== "staleGoodsProductList").length,
    truncatedStoreCount: 0,
    splitRequiredStoreCount: 0,
    fetchedPages: sourceHealth.filter((item) => String(item.key || "").includes("staleGoodsProductList")).length,
    plannedPages: sourceHealth.filter((item) => String(item.key || "").includes("staleGoodsProductList")).length
  };
}

async function fetchStaleGoodsExecute(payload: DoudianAdapterPayload, args: StaleGoodsArgs): Promise<DoudianStaleGoodsCleanupResult> {
  if (String(args.confirmText || "") !== "\u786e\u8ba4\u6e05\u7406") throw new Error("stale goods cleanup confirm text mismatch");
  const selected = normalizeExecuteCandidates(args);
  if (!selected.length) throw new Error("stale goods cleanup selected products missing");
  const action = text(args.action || selected[0]?.action);
  if (!["offline", "recycle", "delete"].includes(action)) throw new Error("unsupported stale goods cleanup action");
  const sourceRunId = text(args.sourceRunId || selected.find((item) => item.sourceRunId)?.sourceRunId);
  await validateExecuteSourceRun(sourceRunId, selected);

  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const requested = new Set((args.shopIds || []).map((id) => text(id)).filter(Boolean));
  const targets = requested.size ? stores.filter((store) => requested.has(store.shopId)) : stores;
  const byStore = new Map<string, { store: DoudianStoreSummary; candidates: DoudianStaleGoodsCandidate[] }>();
  for (const candidate of selected) {
    const store = targets.find((item) => item.shopId === candidate.shopId);
    if (!store) continue;
    const group = byStore.get(store.shopId) || { store, candidates: [] };
    group.candidates.push({ ...candidate, sourceRunId, action });
    byStore.set(store.shopId, group);
  }
  const groups = Array.from(byStore.values());
  if (!groups.length) throw new Error("stale goods cleanup selected stores missing");

  const runId = args.operationId || `stale-exec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const planKey = actionPlanKey(payload.adapter, action);
  const executions: DoudianStaleGoodsExecution[] = [];
  const details: DoudianRunDetail[] = [];
  for (const [index, group] of groups.entries()) {
    try {
      const result = await executeStore(payload, group.store, group.candidates, action, planKey, index + 1, groups.length, runId);
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
        reason: "stale-goods-execute-failed",
        category: "api",
        diagnostic: { action, planKey },
        index: index + 1,
        total: groups.length
      });
      executions.push(...group.candidates.map((item) => ({
        id: item.id,
        sourceRunId,
        shopId: group.store.shopId,
        shopName: group.store.shopName,
        productId: item.productId,
        title: item.title || "",
        action,
        status: "failed",
        ok: false,
        message,
        planKey
      })));
    }
  }
  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.filter((detail) => !detail.ok).length;
  const summary = executeSummary(executions);
  const cleanupRuleVersion = policyText(payload.adapter, "staleGoodsCleanup.ruleVersion", "stale-goods-rule");
  const fieldSchemaVersion = policyText(payload.adapter, "staleGoodsCleanup.fieldSchemaVersion", "stale-goods-fields");
  const requestHash = requestPlanHash(payload.adapter, requestPlanKeys(payload.adapter));
  const dryRun = executions.length > 0 && executions.every((item) => item.status === "dry_run");
  const status = failureCount ? (successCount ? "partial" : "failed") : "ok";
  const message = failureCount
    ? policyMessage(payload.adapter, "staleGoodsCleanup.messages.executePartial", "Stale goods cleanup submitted with {failureCount} failures", { successCount, failureCount })
    : dryRun
      ? policyMessage(payload.adapter, "staleGoodsCleanup.messages.executeDryRun", "Stale goods cleanup dry-run only; no platform write request was submitted", { count: executions.length })
      : policyMessage(payload.adapter, "staleGoodsCleanup.messages.executeDone", "Stale goods cleanup submitted for {count} products", { count: executions.length });
  const now = new Date().toISOString();
  await saveExecuteRun({
    id: runId,
    mode: "execute",
    runId,
    operationId: args.operationId,
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
    cleanupRuleVersion,
    fieldSchemaVersion,
    requestPlanHash: requestHash,
    createdAt: now,
    updatedAt: now
  });
  return {
    ok: failureCount === 0,
    status,
    mode: "execute",
    message,
    runId,
    operationId: args.operationId,
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
    cleanupRuleVersion,
    fieldSchemaVersion,
    requestPlanHash: requestHash,
    stores,
    groups: ledger.groups || []
  } as DoudianStaleGoodsCleanupResult;
}

export async function fetchStaleGoodsCleanup(args: StaleGoodsArgs = {}): Promise<DoudianStaleGoodsCleanupResult> {
  const payload = adapterPayload(args);
  if ((args.mode || "scan") === "execute") return fetchStaleGoodsExecute(payload, args);
  if ((args.mode || "scan") !== "scan") return { ok: false, status: "unsupported-mode", mode: args.mode, message: "unsupported stale goods mode", rows: [], candidates: [], executions: [] };
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const requested = new Set((args.shopIds || []).map((id) => text(id)).filter(Boolean));
  const targets = requested.size ? stores.filter((store) => requested.has(store.shopId)) : stores;
  const rules = normalizeRules(args, payload.adapter);
  const planKeys = requestPlanKeys(payload.adapter);
  const runId = args.operationId || `stale-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rows: DoudianStaleGoodsRow[] = [];
  const candidates: DoudianStaleGoodsCandidate[] = [];
  const details: DoudianRunDetail[] = [];
  const sourceHealth: Array<Record<string, unknown>> = [];
  for (const store of targets) {
    const result = await scanStore(payload, store, planKeys, args, runId, rules);
    rows.push(result.row);
    candidates.push(...result.candidates);
    details.push(result.detail);
    sourceHealth.push(...result.sourceHealth);
  }
  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.filter((detail) => !detail.ok).length;
  const summary = scanSummary(rows, candidates, details, sourceHealth);
  const cleanupRuleVersion = policyText(payload.adapter, "staleGoodsCleanup.ruleVersion", "stale-goods-rule");
  const fieldSchemaVersion = policyText(payload.adapter, "staleGoodsCleanup.fieldSchemaVersion", "stale-goods-fields");
  const requestHash = requestPlanHash(payload.adapter, planKeys);
  const status = failureCount ? (successCount ? "partial" : "failed") : "ok";
  const message = failureCount
    ? policyMessage(payload.adapter, "staleGoodsCleanup.messages.partial", "Stale goods scan partially failed", { successCount, failureCount })
    : policyMessage(payload.adapter, "staleGoodsCleanup.messages.done", "Stale goods scan done", { count: candidates.length });
  const record: ScanRunRecord = {
    id: runId,
    mode: "scan",
    runId,
    operationId: args.operationId,
    status,
    rows,
    candidates,
    details,
    scanSummary: summary,
    sourceHealth,
    rules,
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    cleanupRuleVersion,
    fieldSchemaVersion,
    requestPlanHash: requestHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await saveScanRun(record);
  return {
    ok: failureCount === 0,
    status,
    mode: "scan",
    message,
    runId,
    operationId: args.operationId,
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
    rules,
    cleanupRuleVersion,
    fieldSchemaVersion,
    requestPlanHash: requestHash,
    stores,
    groups: ledger.groups || []
  };
}

export async function restoreLatestStaleGoodsScan() {
  const runs = await repositoryGetAll<ScanRunRecord>("stale_scan_runs");
  return runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
}

export async function restoreLatestStaleGoodsExecute() {
  const runs = await repositoryGetAll<ExecuteRunRecord>("stale_execute_runs");
  return runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
}

export async function runDoudianStaleGoodsScanSelfCheck(options: { doudianAdapter?: DoudianAdapterPayload } = {}) {
  const payload = adapterPayload({ doudianAdapter: options.doudianAdapter });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopId = `stale-self-check-${suffix}`;
  const runId = `stale-self-check-run-${suffix}`;
  try {
    await upsertStoreLedger({ shopId, shopName: `Stale Self Check ${suffix}`, platform: "doudian", partition: `persist:chihu-stale-self-check-${suffix}`, status: "online", groupName: "Self Check", adapterVersion: payload.adapter.version });
    const result = await fetchStaleGoodsCleanup({
      doudianAdapter: payload,
      mode: "scan",
      shopIds: [shopId],
      operationId: runId,
      mockProducts: [{
        product_id: `product-${suffix}`,
        title: "Self Check Product",
        create_time: "2026-01-01",
        audit_time: "2026-01-02",
        price: 1999,
        stock: 120,
        total_sales: 1,
        period_sales: 0,
        exposure_count: 500,
        click_count: 5,
        info_quality_score: 60,
        main_image_score: 65,
        title_quality_score: 66
      }]
    });
    const restored = await restoreLatestStaleGoodsScan();
    const candidate = result.candidates?.[0];
    return {
      ok: result.ok === true && !!candidate && restored?.runId === runId,
      scanOk: result.ok === true,
      candidateOk: !!candidate && candidate.shopId === shopId && candidate.sourceRunId === runId,
      restoreOk: restored?.runId === runId,
      runId
    };
  } finally {
    await deleteStoreLedger([shopId]).catch(() => undefined);
    await repositoryDelete("stale_scan_runs", runId).catch(() => undefined);
    const candidates = await repositoryGetAll<DoudianStaleGoodsCandidate>("stale_candidates").catch(() => []);
    await Promise.all(candidates.filter((candidate) => candidate.sourceRunId === runId).map((candidate) => repositoryDelete("stale_candidates", candidate.id).catch(() => undefined)));
  }
}

export async function runDoudianStaleGoodsExecuteSelfCheck(options: { doudianAdapter?: DoudianAdapterPayload } = {}) {
  const payload = adapterPayload({ doudianAdapter: options.doudianAdapter });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopId = `stale-exec-self-check-${suffix}`;
  const scanRunId = `stale-exec-self-check-scan-${suffix}`;
  const executeRunIds: string[] = [];
  try {
    await upsertStoreLedger({ shopId, shopName: `Stale Execute Self Check ${suffix}`, platform: "doudian", partition: `persist:chihu-stale-exec-self-check-${suffix}`, status: "online", groupName: "Self Check", adapterVersion: payload.adapter.version });
    const scan = await fetchStaleGoodsCleanup({
      doudianAdapter: payload,
      mode: "scan",
      shopIds: [shopId],
      operationId: scanRunId,
      mockProducts: [0, 1, 2].map((index) => ({
        product_id: `exec-product-${index}-${suffix}`,
        title: `Execute Self Check Product ${index}`,
        create_time: "2026-01-01",
        audit_time: "2026-01-02",
        price: 1999,
        stock: 120,
        total_sales: 1,
        period_sales: 0,
        exposure_count: 500,
        click_count: 5,
        info_quality_score: 60,
        main_image_score: 65,
        title_quality_score: 66
      }))
    });
    const candidates = scan.candidates || [];
    const actions: Array<DoudianStaleGoodsAction> = ["offline", "recycle", "delete"];
    const results: DoudianStaleGoodsCleanupResult[] = [];
    for (const [index, action] of actions.entries()) {
      const candidate = candidates[index];
      if (!candidate) continue;
      const runId = `stale-exec-self-check-run-${action}-${suffix}`;
      executeRunIds.push(runId);
      results.push(await fetchStaleGoodsCleanup({
        doudianAdapter: payload,
        mode: "execute",
        shopIds: [shopId],
        action,
        candidateIds: [candidate.id],
        candidates: [{ ...candidate, action }],
        sourceRunId: scanRunId,
        confirmText: "\u786e\u8ba4\u6e05\u7406",
        operationId: runId
      }));
    }
    const restored = await restoreLatestStaleGoodsExecute();
    const executeRuns = await repositoryGetAll<ExecuteRunRecord>("stale_execute_runs");
    const relatedRuns = executeRuns.filter((run) => executeRunIds.includes(run.runId));
    const dryRunOk = results.length === actions.length && results.every((result) => result.ok === true && result.executions?.every((item) => item.status === "dry_run"));
    const sourceRunOk = results.every((result) => result.sourceRunId === scanRunId && result.executions?.every((item) => item.sourceRunId === scanRunId));
    const actionOk = actions.every((action) => results.some((result) => result.executions?.some((item) => item.action === action)));
    const persistedOk = relatedRuns.length === actions.length && relatedRuns.every((run) => run.sourceRunId === scanRunId && run.dryRun === true);
    return {
      ok: scan.ok === true && dryRunOk && sourceRunOk && actionOk && persistedOk && executeRunIds.includes(restored?.runId || ""),
      dryRunOk,
      sourceRunOk,
      actionOk,
      persistedOk,
      restoreOk: executeRunIds.includes(restored?.runId || ""),
      scanRunId,
      executeRunIds
    };
  } finally {
    await deleteStoreLedger([shopId]).catch(() => undefined);
    await repositoryDelete("stale_scan_runs", scanRunId).catch(() => undefined);
    await Promise.all(executeRunIds.map((runId) => repositoryDelete("stale_execute_runs", runId).catch(() => undefined)));
    const candidates = await repositoryGetAll<DoudianStaleGoodsCandidate>("stale_candidates").catch(() => []);
    await Promise.all(candidates.filter((candidate) => candidate.sourceRunId === scanRunId).map((candidate) => repositoryDelete("stale_candidates", candidate.id).catch(() => undefined)));
  }
}
