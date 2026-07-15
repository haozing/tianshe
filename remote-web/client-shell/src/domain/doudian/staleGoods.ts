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
import { repositoryDelete, repositoryGet, repositoryGetAll, repositoryGetMany, repositoryPut, repositoryPutMany } from "./repository";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";
import { requireChihuNative } from "../../native/client";
import { prepareMutationSafety, recordExecutionMutationResults } from "./mutationSafety";
import * as XLSX from "xlsx";

interface StaleGoodsArgs {
  doudianAdapter?: DoudianAdapterPayload;
  mode?: "scan" | "execute" | string;
  shopIds?: string[];
  rules?: DoudianStaleGoodsRules;
  compassFileName?: string;
  compassRows?: Array<Record<string, unknown>>;
  compassPeriod?: "7d" | "30d" | "90d";
  operationId?: string;
  pageSize?: number;
  maxProductListPages?: number;
  mockProducts?: Array<Record<string, unknown>>;
  action?: DoudianStaleGoodsAction | string;
  candidateIds?: string[];
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

function findArray(value: unknown, paths: string[]) {
  if (Array.isArray(value)) return { found: true, items: value };
  for (const path of paths) {
    const next = path ? getPathValue(value, path) : value;
    if (Array.isArray(next)) return { found: true, items: next };
  }
  return { found: false, items: [] as unknown[] };
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

function readOptionalNumber(record: unknown, adapter: DoudianAdapterConfig, field: string) {
  const value = coerceNumber(readField(record, adapter, field));
  return value === undefined ? undefined : value / fieldScale(adapter, field);
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
    totalSalesMax: Number(config.totalSalesMax ?? 0),
    exposureEnabled: config.exposureEnabled !== false,
    exposureMax: Number(config.exposureMax ?? 0),
    clickEnabled: config.clickEnabled !== false,
    clickMax: Number(config.clickMax ?? 0),
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
    perStoreLimit: Number(config.perStoreLimit ?? 0),
    trafficPeriod: (config.trafficPeriod === "30d" || config.trafficPeriod === "90d") ? config.trafficPeriod : "7d",
    productSource: config.productSource === "offline" || config.productSource === "importedIds" ? config.productSource : "selling",
    importedProductIds: Array.isArray(config.importedProductIds) ? config.importedProductIds.map((item) => text(item)).filter(Boolean) : [],
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
  const thresholds = new Set((row.recommendThresholds || []).map(Number));
  return {
    lowRating: thresholds.has(3) || (Number(row.ratingScore || 0) > 0 && Number(row.ratingScore || 0) < 4.5),
    lowInfo: thresholds.has(4) || (Number(row.infoQualityScore || 0) > 0 && Number(row.infoQualityScore || 0) < 70),
    lowImage: thresholds.has(21) || (Number(row.mainImageScore || 0) > 0 && Number(row.mainImageScore || 0) < 70),
    sameStyleRisk: thresholds.has(20) || row.sameStyleRisk === true,
    badTitle: thresholds.has(19) || (Number(row.titleQualityScore || 0) > 0 && Number(row.titleQualityScore || 0) < 70)
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
  const available = row.metricAvailability || {};
  const noPeriodSales = available.periodSales && Number(row.periodSales || 0) === 0 ? 30 : 0;
  const lowTotalSales = available.totalSales && Number(row.totalSales || 0) <= 5 ? 18 : 0;
  const trafficWaste = available.exposureCount && available.periodSales && Number(row.exposureCount || 0) >= 1000 && Number(row.periodSales || 0) === 0 ? 20 : 0;
  const stockPressure = !available.stock ? 0 : Number(row.stock || 0) >= 80 ? 12 : Number(row.stock || 0) >= 30 ? 8 : 4;
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
  const available = row.metricAvailability || {};
  const salesKnown = available.totalSales && available.periodSales;
  const hasTrafficWaste = available.exposureCount && available.periodSales && Number(row.exposureCount || 0) >= 1000 && Number(row.periodSales || 0) === 0;
  if (salesKnown && Number(row.totalSales || 0) <= 1 && Number(row.periodSales || 0) === 0 && issues.length >= 3) return "delete";
  if (salesKnown && available.stock && Number(row.totalSales || 0) <= 2 && Number(row.periodSales || 0) === 0 && Number(row.stock || 0) >= 80) return "recycle";
  if (hasTrafficWaste || (available.stock && Number(row.stock || 0) >= 30)) return "offline";
  return "optimize";
}

function reasons(row: DoudianStaleGoodsCandidate) {
  const available = row.metricAvailability || {};
  const output = [];
  if (available.periodSales && Number(row.periodSales || 0) === 0) output.push("no period sales");
  if (available.totalSales && Number(row.totalSales || 0) <= 5) output.push("low total sales");
  if (available.exposureCount && available.periodSales && Number(row.exposureCount || 0) >= 1000 && Number(row.periodSales || 0) === 0) output.push("traffic without conversion");
  if (available.clickCount && Number(row.clickCount || 0) <= 30) output.push("low clicks");
  if (available.stock && Number(row.stock || 0) >= 80) output.push("stock pressure");
  if (Number(row.daysSinceAge ?? -1) >= 30) output.push("old product");
  return [...output, ...qualityLabels(row)].slice(0, 5);
}

function firstRecordValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

const compassAliases: Record<string, string[]> = {
  productId: ["productId", "product_id", "goods_id", "\u5546\u54c1ID", "\u5546\u54c1id", "\u5546\u54c1\u7f16\u7801"],
  title: ["title", "name", "\u5546\u54c1\u6807\u9898", "\u5546\u54c1\u540d\u79f0"],
  totalSales: ["totalSales", "sales", "saleNum", "sell_num", "\u603b\u9500\u91cf", "\u7d2f\u8ba1\u9500\u91cf"],
  periodSales: ["periodSales", "payOrderCount", "turNover", "pay_cnt", "\u6210\u4ea4\u8ba2\u5355\u6570", "\u5468\u671f\u6210\u4ea4"],
  exposureCount: ["exposureCount", "showCount", "product_show_cnt", "\u5546\u54c1\u66dd\u5149\u6b21\u6570", "\u66dd\u5149\u6b21\u6570"],
  clickCount: ["clickCount", "product_click_cnt", "\u5546\u54c1\u70b9\u51fb\u6b21\u6570", "\u70b9\u51fb\u6b21\u6570"],
  exposureUsers: ["exposureUsers", "product_show_ucnt", "\u5546\u54c1\u66dd\u5149\u4eba\u6570", "\u66dd\u5149\u4eba\u6570"],
  clickUsers: ["clickUsers", "product_click_ucnt", "\u5546\u54c1\u70b9\u51fb\u4eba\u6570", "\u70b9\u51fb\u4eba\u6570"],
  price: ["price", "minPrice", "\u4ef7\u683c", "\u5546\u54c1\u4ef7\u683c"],
  stock: ["stock", "stockNum", "\u5e93\u5b58", "\u5e93\u5b58\u6570\u91cf"],
  ratingScore: ["ratingScore", "\u7efc\u5408\u8bc4\u4ef7"],
  infoQualityScore: ["infoQualityScore", "\u4fe1\u606f\u8d28\u91cf\u5206"],
  mainImageScore: ["mainImageScore", "\u4e3b\u56fe\u5f97\u5206"],
  titleQualityScore: ["titleQualityScore", "\u6807\u9898\u5f97\u5206"]
};

function compassNumber(record: Record<string, unknown>, field: string) {
  return coerceNumber(firstRecordValue(record, compassAliases[field] || [field]));
}

function joinedNumber(product: Record<string, unknown>, compass: Record<string, unknown>, adapter: DoudianAdapterConfig, field: string) {
  const productValue = readOptionalNumber(product, adapter, field);
  if (productValue !== undefined) return { value: productValue, available: true };
  const compassValue = compassNumber(compass, field);
  return { value: compassValue ?? 0, available: compassValue !== undefined };
}

function candidateFromProduct(
  store: DoudianStoreSummary,
  product: Record<string, unknown>,
  adapter: DoudianAdapterConfig,
  runId: string,
  compassById: Map<string, Record<string, unknown>>,
  recommendById: Map<string, Set<number>>,
  productSource: DoudianStaleGoodsRules["productSource"]
) {
  const productId = readText(product, adapter, "productId");
  if (!productId) return null;
  const compassMatched = compassById.has(productId);
  const compass = compassById.get(productId) || {};
  const createdAt = normalizeDate(readField(product, adapter, "createdAt") || compass.createdAt || compass.createTime);
  const listedAt = normalizeDate(readField(product, adapter, "listedAt") || compass.listedAt || compass.auditTime);
  const ageDate = createdAt || listedAt;
  const price = joinedNumber(product, compass, adapter, "price");
  const stock = joinedNumber(product, compass, adapter, "stock");
  const totalSales = joinedNumber(product, compass, adapter, "totalSales");
  const periodSales = joinedNumber(product, compass, adapter, "periodSales");
  const exposureCount = joinedNumber(product, compass, adapter, "exposureCount");
  const clickCount = joinedNumber(product, compass, adapter, "clickCount");
  const exposureUsers = joinedNumber(product, compass, adapter, "exposureUsers");
  const clickUsers = joinedNumber(product, compass, adapter, "clickUsers");
  const ratingScore = joinedNumber(product, compass, adapter, "ratingScore");
  const infoQualityScore = joinedNumber(product, compass, adapter, "infoQualityScore");
  const mainImageScore = joinedNumber(product, compass, adapter, "mainImageScore");
  const titleQualityScore = joinedNumber(product, compass, adapter, "titleQualityScore");
  const recommendThresholds = [...(recommendById.get(productId) || new Set<number>())];
  const sameStyleValue = readField(product, adapter, "sameStyleRisk");
  const base: DoudianStaleGoodsCandidate = {
    id: `${runId}-${store.shopId}-${productId}`,
    candidateId: `${store.shopId}-${productId}`,
    sourceRunId: runId,
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    productId,
    title: readText(product, adapter, "title") || text(firstRecordValue(compass, compassAliases.title)) || productId,
    category: readText(product, adapter, "category") || text(compass.category) || "",
    status: productSource === "offline" ? "\u5df2\u4e0b\u67b6" : readText(product, adapter, "status") || text(compass.status) || "\u5728\u552e",
    createdAt,
    listedAt,
    ageDate,
    ageDateType: createdAt ? "createdAt" : listedAt ? "listedAt" : "",
    daysSinceAge: daysSince(ageDate),
    daysSinceCreated: daysSince(createdAt),
    daysSinceListed: daysSince(listedAt),
    price: price.value,
    stock: stock.value,
    totalSales: totalSales.value,
    periodSales: periodSales.value,
    exposureCount: exposureCount.value,
    clickCount: clickCount.value,
    exposureUsers: exposureUsers.value,
    clickUsers: clickUsers.value,
    ratingScore: ratingScore.value,
    infoQualityScore: infoQualityScore.value,
    mainImageScore: mainImageScore.value,
    titleQualityScore: titleQualityScore.value,
    sameStyleRisk: recommendThresholds.includes(20) || Boolean(sameStyleValue || compass.sameStyleRisk),
    risk: "low",
    riskScore: 0,
    action: "optimize",
    reasons: [],
    source: ["platform product list", compassMatched ? "compass traffic" : "", recommendThresholds.length ? "recommend_admit" : ""].filter(Boolean).join(" + "),
    compassMatched,
    recommendThresholds,
    metricAvailability: {
      price: price.available,
      stock: stock.available,
      totalSales: totalSales.available,
      periodSales: periodSales.available,
      exposureCount: exposureCount.available,
      clickCount: clickCount.available,
      exposureUsers: exposureUsers.available,
      clickUsers: clickUsers.available,
      ratingScore: ratingScore.available,
      infoQualityScore: infoQualityScore.available,
      mainImageScore: mainImageScore.available,
      titleQualityScore: titleQualityScore.available,
      sameStyleRisk: recommendThresholds.includes(20) || sameStyleValue !== undefined || compass.sameStyleRisk !== undefined
    }
  };
  const riskScore = scoreCandidate(base);
  base.riskScore = riskScore;
  base.risk = riskFromScore(riskScore);
  base.action = actionFromCandidate(base);
  base.reasons = reasons(base);
  return base;
}

function evaluateRules(row: DoudianStaleGoodsCandidate, rules: DoudianStaleGoodsRules) {
  const available = row.metricAvailability || {};
  const withinMaximum = (enabled: boolean | undefined, field: string, value: number, maximum: number) => !enabled || (available[field] === true && value <= maximum);
  const withinSales = withinMaximum(rules.totalSalesEnabled, "totalSales", Number(row.totalSales || 0), rules.totalSalesMax);
  const withinPeriodSales = withinMaximum(rules.periodSalesEnabled, "periodSales", Number(row.periodSales || 0), rules.periodSalesMax);
  const withinExposure = withinMaximum(rules.exposureEnabled, "exposureCount", Number(row.exposureCount || 0), rules.exposureMax);
  const withinClick = withinMaximum(rules.clickEnabled, "clickCount", Number(row.clickCount || 0), rules.clickMax);
  const withinExposureUsers = withinMaximum(rules.exposureUsersEnabled, "exposureUsers", Number(row.exposureUsers || 0), Number(rules.exposureUsersMax || 0));
  const withinClickUsers = withinMaximum(rules.clickUsersEnabled, "clickUsers", Number(row.clickUsers || 0), Number(rules.clickUsersMax || 0));
  const metricEnabled = [rules.totalSalesEnabled, rules.periodSalesEnabled, rules.exposureEnabled, rules.clickEnabled, rules.exposureUsersEnabled, rules.clickUsersEnabled].some(Boolean);
  const metricMatch = metricEnabled ? [withinSales, withinPeriodSales, withinExposure, withinClick, withinExposureUsers, withinClickUsers].every(Boolean) : true;
  const stockMax = Number(rules.stockMax || 0);
  const priceMax = Number(rules.maxPrice || 0);
  const stockMatch = !rules.stockRangeEnabled || (available.stock === true && Number(row.stock || 0) >= rules.stockMin && (!stockMax || Number(row.stock || 0) <= stockMax));
  const priceMatch = !rules.priceRangeEnabled || (available.price === true && Number(row.price || 0) >= rules.minPrice && (!priceMax || Number(row.price || 0) <= priceMax));
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
  const baseWithoutAge = stockMatch && priceMatch && qualityMatch;
  const typeMatch = rules.noSalesType === "strict"
    ? available.periodSales === true && Number(row.periodSales || 0) === 0 && withinSales
    : rules.noSalesType === "trafficWaste"
      ? available.exposureCount === true && available.periodSales === true && Number(row.exposureCount || 0) >= (rules.exposureEnabled ? rules.exposureMax : 0) && Number(row.periodSales || 0) <= rules.periodSalesMax
      : metricMatch;
  const ageMatch = createdOldEnough && listedOldEnough;
  const ageKnown = (!rules.skipCreatedDaysEnabled || Number(row.daysSinceCreated ?? -1) >= 0) && (!rules.skipListedDaysEnabled || Number(row.daysSinceListed ?? -1) >= 0);
  return {
    match: baseWithoutAge && ageMatch && typeMatch,
    ageBlocked: baseWithoutAge && typeMatch && ageKnown && !ageMatch
  };
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
    trafficWasteCount: candidates.filter((item) => item.metricAvailability?.exposureCount && item.metricAvailability?.periodSales && Number(item.exposureCount || 0) >= 1000 && Number(item.periodSales || 0) === 0).length,
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
  if (action === "delete") return "staleGoodsBatchDelete";
  return "";
}

function completeDeletePlanKey(adapter: DoudianAdapterConfig) {
  return text(executePlans(adapter).completeDelete) || "staleGoodsCompleteDelete";
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

async function loadExecuteCandidates(sourceRunId: string, candidateIds: string[], action: string) {
  if (!sourceRunId) throw new Error("stale goods execute requires sourceRunId");
  const run = await repositoryGet<ScanRunRecord>("stale_scan_runs", sourceRunId);
  if (!run) throw new Error("stale goods source scan run not found");
  const ids = Array.from(new Set(candidateIds.map((id) => text(id)).filter(Boolean)));
  if (!ids.length) throw new Error("stale goods cleanup selected products missing");
  const candidates = await repositoryGetMany<DoudianStaleGoodsCandidate>("stale_candidates", ids);
  const byId = new Map(candidates.map((candidate) => [text(candidate.id), candidate]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`stale goods candidates missing from local snapshot: ${missing.slice(0, 3).join(",")}`);
  const selected = ids.map((id) => byId.get(id) as DoudianStaleGoodsCandidate);
  const invalid = selected.filter((candidate) => candidate.sourceRunId !== sourceRunId || !candidate.shopId || !candidate.productId);
  if (invalid.length) throw new Error(`stale goods candidates are not from source run: ${invalid.slice(0, 3).map((item) => item.id).join(",")}`);
  return selected.map((candidate) => ({ ...candidate, sourceRunId, action }));
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
  planKey: string,
  stage: string
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
    planKey,
    stage
  }));
}

async function executeStage(payload: DoudianAdapterPayload, store: DoudianStoreSummary, candidates: DoudianStaleGoodsCandidate[], action: string, planKey: string, stage: string, index: number, total: number, runId: string) {
  const guard = executePlanGuard(payload.adapter, action, planKey);
  let productIds = candidates.map((item) => item.productId).filter(Boolean);
  const formBody = (ids: string[]) => {
    const params = new URLSearchParams();
    ids.forEach((id) => params.append("product_ids[]", id));
    return params.toString();
  };
  const requestContext = {
    productIds: productIds.join(","),
    productIdList: productIds,
    productCount: productIds.length,
    formBody: formBody(productIds),
    action,
    stage,
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
        planKey,
        stage
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
        planKey,
        stage
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
    action: stage === "recycle" ? "recycle" : action,
    stage,
    planKey
  });
  const rejectedExecutions = staleExecutionsFromRejected(store, safety.rejected, action, planKey, stage);
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
    productCount: productIds.length,
    formBody: formBody(productIds)
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
      planKey,
      stage
    }))
  ];
  await recordExecutionMutationResults({ store, executions, defaultAction: stage === "recycle" ? "recycle" : action }).catch(() => undefined);
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

async function executeStore(
  payload: DoudianAdapterPayload,
  store: DoudianStoreSummary,
  candidates: DoudianStaleGoodsCandidate[],
  action: string,
  planKey: string,
  index: number,
  total: number,
  runId: string
) {
  const batchSize = policyNumber(payload.adapter, "staleGoodsCleanup.executeBatchSize", 100, 1, 100);
  const batches = chunksOf(candidates, batchSize);
  const completePlanKey = completeDeletePlanKey(payload.adapter);
  const firstGuard = executePlanGuard(payload.adapter, action, planKey);
  const completeGuard = action === "delete" ? executePlanGuard(payload.adapter, action, completePlanKey) : null;
  if (action === "delete" && !completeGuard?.ok) {
    const message = "stale goods complete delete plan unavailable";
    return {
      executions: candidates.map((candidate) => ({
        id: candidate.id,
        sourceRunId: candidate.sourceRunId,
        shopId: store.shopId,
        shopName: store.shopName,
        productId: candidate.productId,
        title: candidate.title,
        action,
        stage: "delete",
        status: "failed",
        ok: false,
        message,
        planKey: completePlanKey
      } as DoudianStaleGoodsExecution)),
      detail: { shopId: store.shopId, shopName: store.shopName, status: "failed", ok: false, message, reason: "stale-goods-complete-delete-plan-missing", category: "adapter", diagnostic: { planKey, completePlanKey }, index, total } as DoudianRunDetail
    };
  }
  if (firstGuard.ok && (firstGuard.dryRunOnly || completeGuard?.dryRunOnly)) {
    const message = policyMessage(payload.adapter, "staleGoodsCleanup.messages.executeDryRun", "Stale goods cleanup dry-run only; no platform write request was submitted", { count: candidates.length });
    const executions = candidates.map((candidate) => ({
      id: candidate.id,
      sourceRunId: candidate.sourceRunId,
      shopId: store.shopId,
      shopName: store.shopName,
      productId: candidate.productId,
      title: candidate.title,
      action,
      stage: action === "delete" ? "delete" : action,
      status: "dry_run",
      ok: true,
      message,
      planKey
    } as DoudianStaleGoodsExecution));
    return {
      executions,
      detail: {
        shopId: store.shopId,
        shopName: store.shopName,
        status: "dry_run",
        ok: true,
        message,
        reason: "stale-goods-execute-dry-run",
        category: "adapter-policy",
        diagnostic: { batchSize, batchCount: batches.length, firstGuard, completeGuard, twoStageDelete: action === "delete" },
        index,
        total
      } as DoudianRunDetail
    };
  }

  const executions: DoudianStaleGoodsExecution[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  for (const [batchIndex, batch] of batches.entries()) {
    const firstStageName = action === "offline" ? "offline" : "recycle";
    const first = await executeStage(payload, store, batch, action, planKey, firstStageName, batchIndex + 1, batches.length, runId);
    const diagnostic: Record<string, unknown> = { index: batchIndex + 1, total: batches.length, firstStage: first.detail.diagnostic };
    if (action !== "delete" || first.executions.every((execution) => execution.status === "dry_run")) {
      executions.push(...first.executions);
      if (action === "delete") diagnostic.completeDelete = { guard: completeGuard, plannedProductCount: batch.length };
      diagnostics.push(diagnostic);
      continue;
    }
    const successfulIds = new Set(first.executions.filter((execution) => execution.ok && execution.status === "submitted").map((execution) => execution.id));
    const firstStageFailures = first.executions.filter((execution) => !successfulIds.has(execution.id));
    const deleteCandidates = batch.filter((candidate) => successfulIds.has(candidate.id));
    executions.push(...firstStageFailures);
    if (deleteCandidates.length) {
      const second = await executeStage(payload, store, deleteCandidates, action, completePlanKey, "delete", batchIndex + 1, batches.length, runId);
      executions.push(...second.executions);
      diagnostic.completeDelete = second.detail.diagnostic;
    }
    diagnostics.push(diagnostic);
  }
  const failedCount = executions.filter((execution) => !execution.ok).length;
  const dryRun = executions.length > 0 && executions.every((execution) => execution.status === "dry_run");
  const ok = executions.length === candidates.length && failedCount === 0 && executions.every((execution) => execution.status === "submitted" || execution.status === "dry_run");
  const message = ok
    ? dryRun
      ? policyMessage(payload.adapter, "staleGoodsCleanup.messages.executeDryRun", "Stale goods cleanup dry-run only; no platform write request was submitted", { count: candidates.length })
      : policyMessage(payload.adapter, "staleGoodsCleanup.messages.executedStore", "Stale goods cleanup executed", { count: candidates.length })
    : executions.find((execution) => !execution.ok)?.message || policyMessage(payload.adapter, "staleGoodsCleanup.messages.executeFailed", "Stale goods cleanup failed");
  return {
    executions,
    detail: {
      shopId: store.shopId,
      shopName: store.shopName,
      status: ok ? (dryRun ? "dry_run" : "ok") : executions.some((execution) => execution.ok) ? "partial" : "failed",
      ok,
      message,
      reason: ok ? (dryRun ? "stale-goods-execute-dry-run" : "") : "stale-goods-execute-partial-or-failed",
      category: ok ? (dryRun ? "adapter-policy" : "") : "api",
      diagnostic: { batchSize, batches: diagnostics },
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
    const productId = text(firstRecordValue(row, compassAliases.productId));
    if (productId) map.set(productId, row);
  }
  return map;
}

function chunksOf<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function productSourceContext(source: DoudianStaleGoodsRules["productSource"]) {
  if (source === "offline") {
    return { checkStatus: "", isOnline: "", isOffline: "1", tab: "offline", orderField: "offline_time", productStatus: "" };
  }
  return { checkStatus: "3", isOnline: "1", isOffline: "", tab: "onSale", orderField: "audit_time", productStatus: "0" };
}

function optionalTotal(payload: unknown, adapter: DoudianAdapterConfig, paths = totalPaths(adapter)) {
  const total = coerceNumber(firstPathValue(payload, paths));
  return total !== undefined && total >= 0 ? total : undefined;
}

function productRecordId(record: Record<string, unknown>, adapter: DoudianAdapterConfig) {
  return readText(record, adapter, "productId");
}

async function runPlan(payload: DoudianAdapterPayload, store: DoudianStoreSummary, planKey: string, context: Record<string, unknown>) {
  return runDoudianRequestPlan(payload, { partition: store.partition, planKey, context })
    .catch((error) => ({ ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error), source: planKey } as RequestPlanResult));
}

async function collectProducts(payload: DoudianAdapterPayload, store: DoudianStoreSummary, args: StaleGoodsArgs, rules: DoudianStaleGoodsRules) {
  if (args.mockProducts?.length) {
    return {
      products: args.mockProducts,
      remoteTotal: args.mockProducts.length,
      complete: true,
      truncated: false,
      splitRequired: false,
      malformed: false,
      fetchedPages: 0,
      plannedPages: 0,
      sourceHealth: [] as Array<Record<string, unknown>>,
      responses: {} as Record<string, RequestPlanResult>
    };
  }
  const planKey = "staleGoodsProductList";
  const products = new Map<string, Record<string, unknown>>();
  const responses: Record<string, RequestPlanResult> = {};
  const pageSize = Math.max(10, Math.min(200, Math.floor(Number(args.pageSize || policyNumber(payload.adapter, "staleGoodsCleanup.pageSize", 100, 10, 200)))));
  const maxPages = Math.max(1, Math.min(200, Math.floor(Number(args.maxProductListPages || policyNumber(payload.adapter, "staleGoodsCleanup.maxProductListPages", 100, 1, 200)))));
  const idMaxPages = policyNumber(payload.adapter, "staleGoodsCleanup.maxProductIdSearchPages", 2, 1, 10);
  const pageStart = policyNumber(payload.adapter, "staleGoodsCleanup.pageStart", 0, 0, 1);
  const source = rules.productSource || "selling";
  const importedIds = Array.from(new Set((rules.importedProductIds || []).map((id) => text(id)).filter(Boolean)));
  const idBatches = source === "importedIds" ? chunksOf(importedIds, 100) : [[]];
  if (source === "importedIds" && !idBatches.length) {
    return { products: [], remoteTotal: 0, complete: false, truncated: false, splitRequired: false, malformed: false, fetchedPages: 0, plannedPages: 0, sourceHealth: [{ key: planKey, status: 0, ok: false, reason: "missing-imported-product-ids" }], responses };
  }
  let remoteTotal: number | undefined;
  let fetchedPages = 0;
  let plannedPages = 0;
  let malformed = false;
  let requestFailed = false;
  let incompleteBatch = false;
  const sourceHealth: Array<Record<string, unknown>> = [];
  const baseContext = productSourceContext(source);

  for (const [batchIndex, idBatch] of idBatches.entries()) {
    const batchSet = new Set(idBatch);
    let batchComplete = false;
    let batchFetchedItems = 0;
    let batchFetchedPages = 0;
    let batchTotal: number | undefined;
    const batchMaxPages = source === "importedIds" ? idMaxPages : maxPages;
    for (let offset = 0; offset < batchMaxPages; offset += 1) {
      const page = pageStart + offset;
      const response = await runPlan(payload, store, planKey, {
        page: String(page),
        pageSize: String(pageSize),
        keyword: source === "importedIds" ? idBatch.join(",") : "",
        ...baseContext
      });
      const responseKey = `${planKey}:batch:${batchIndex}:page:${page}`;
      responses[responseKey] = response;
      fetchedPages += 1;
      batchFetchedPages += 1;
      const payloadForPage = { [planKey]: response.data };
      const parsed = findArray(payloadForPage, listPaths(payload.adapter));
      const responseOk = requestPlanResponseOk(response, payload.adapter, planKey, mappings(payload.adapter));
      sourceHealth.push({ key: responseKey, status: response.status, ok: responseOk && parsed.found, parsed: parsed.found, itemCount: parsed.items.length });
      if (!responseOk) {
        requestFailed = true;
        break;
      }
      if (!parsed.found) {
        malformed = true;
        break;
      }
      batchFetchedItems += parsed.items.length;
      batchTotal = optionalTotal(payloadForPage, payload.adapter) ?? batchTotal;
      if (source !== "importedIds") remoteTotal = batchTotal ?? remoteTotal;
      for (const item of parsed.items) {
        const record = objectRecord(item);
        const productId = productRecordId(record, payload.adapter);
        if (!productId || (source === "importedIds" && !batchSet.has(productId))) continue;
        if (!products.has(productId)) products.set(productId, record);
      }
      const foundBatchIds = source === "importedIds" ? idBatch.filter((id) => products.has(id)).length : 0;
      if (source === "importedIds" && foundBatchIds >= idBatch.length) batchComplete = true;
      else if (batchTotal !== undefined && batchFetchedItems >= batchTotal) batchComplete = true;
      else if (parsed.items.length < pageSize) batchComplete = true;
      else if (source !== "importedIds" && remoteTotal !== undefined && products.size >= remoteTotal) batchComplete = true;
      if (batchComplete) break;
    }
    plannedPages += batchTotal === undefined ? (batchComplete ? batchFetchedPages : batchMaxPages) : Math.max(1, Math.ceil(batchTotal / pageSize));
    if (!batchComplete) incompleteBatch = true;
    if (requestFailed || malformed) break;
  }
  const complete = !requestFailed && !malformed && !incompleteBatch && (source === "importedIds" || remoteTotal === undefined || products.size >= remoteTotal);
  const splitRequired = source !== "importedIds" && remoteTotal !== undefined && remoteTotal > pageSize * maxPages;
  return {
    products: [...products.values()],
    remoteTotal: source === "importedIds" ? products.size : remoteTotal ?? products.size,
    complete,
    truncated: !complete && !requestFailed && !malformed,
    splitRequired,
    malformed,
    fetchedPages,
    plannedPages: Math.max(fetchedPages, plannedPages),
    sourceHealth,
    responses
  };
}

function mappingPathList(adapter: DoudianAdapterConfig, key: string) {
  const value = mappings(adapter)[key];
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function recommendThresholdTypes(rules: DoudianStaleGoodsRules) {
  const thresholds = [
    rules.requireLowRating ? 3 : 0,
    rules.requireLowInfo ? 4 : 0,
    rules.requireLowImage ? 21 : 0,
    rules.requireSameStyleRisk ? 20 : 0,
    rules.requireBadTitle ? 19 : 0,
    rules.noSalesType === "strict" ? 22 : 0
  ].filter(Boolean);
  return Array.from(new Set(thresholds.length ? thresholds : [3]));
}

function recommendProductId(record: Record<string, unknown>) {
  return text(firstPathValue(record, ["base_item_info.item_id", "baseItemInfo.itemId", "item_id", "itemId", "product_id", "productId"]));
}

async function collectRecommendAdmit(payload: DoudianAdapterPayload, store: DoudianStoreSummary, rules: DoudianStaleGoodsRules) {
  const planKey = "staleGoodsRecommendAdmit";
  const byId = new Map<string, Set<number>>();
  const sourceHealth: Array<Record<string, unknown>> = [];
  const responses: Record<string, RequestPlanResult> = {};
  if (!payload.adapter.requestPlans?.[planKey]) return { byId, complete: false, fetchedPages: 0, sourceHealth, responses };
  const thresholds = recommendThresholdTypes(rules);
  const pageSize = policyNumber(payload.adapter, "staleGoodsCleanup.recommendPageSize", 1000, 10, 1000);
  const maxPages = policyNumber(payload.adapter, "staleGoodsCleanup.maxRecommendPages", 20, 1, 100);
  let complete = true;
  let fetchedPages = 0;
  for (const threshold of thresholds) {
    let thresholdComplete = false;
    let fetchedItems = 0;
    let remoteTotal: number | undefined;
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await runPlan(payload, store, planKey, {
        recommendPage: page,
        recommendPageSize: pageSize,
        unreachedThresholdList: [threshold]
      });
      const key = `${planKey}:threshold:${threshold}:page:${page}`;
      responses[key] = response;
      fetchedPages += 1;
      const wrapped = { [planKey]: response.data };
      const parsed = findArray(wrapped, mappingPathList(payload.adapter, "recommendListPaths"));
      const responseOk = requestPlanResponseOk(response, payload.adapter, planKey, mappings(payload.adapter));
      sourceHealth.push({ key, status: response.status, ok: responseOk && parsed.found, parsed: parsed.found, itemCount: parsed.items.length, threshold });
      if (!responseOk || !parsed.found) break;
      fetchedItems += parsed.items.length;
      remoteTotal = optionalTotal(wrapped, payload.adapter, mappingPathList(payload.adapter, "recommendTotalPaths")) ?? remoteTotal;
      for (const item of parsed.items) {
        const productId = recommendProductId(objectRecord(item));
        if (!productId) continue;
        const current = byId.get(productId) || new Set<number>();
        current.add(threshold);
        byId.set(productId, current);
      }
      if ((remoteTotal !== undefined && fetchedItems >= remoteTotal) || parsed.items.length < pageSize) {
        thresholdComplete = true;
        break;
      }
    }
    if (!thresholdComplete) complete = false;
  }
  return { byId, complete, fetchedPages, sourceHealth, responses };
}

function localDateText(date: Date, separator = "-") {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day].join(separator);
}

function compassRequestContext(period: DoudianStaleGoodsRules["trafficPeriod"]) {
  const days = period === "90d" ? 90 : period === "30d" ? 30 : 7;
  const now = new Date();
  const dataDelayDays = now.getHours() >= 8 ? 1 : 2;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dataDelayDays);
  const begin = new Date(end.getFullYear(), end.getMonth(), end.getDate() - days + 1);
  const request = {
    date_type: days === 7 ? 21 : 23,
    begin_date: `${localDateText(begin, "/")} 00:00:00`,
    end_date: `${localDateText(end, "/")} 00:00:00`,
    is_activity: false,
    activity_id: "",
    key_word: "",
    index_selected: "pay_cnt,product_show_ucnt,product_click_ucnt,product_show_cnt,product_click_cnt",
    sale_type: 1,
    content_type: 1,
    cate_ids: "",
    product_tab: 0,
    only_abnormal: false,
    only_drop: false,
    new_version: true,
    abnormal_threshold: 20,
    page_no: 1,
    page_size: 10
  };
  return {
    compassFileName: `stale-goods-${localDateText(begin)}-${localDateText(end)}.xlsx`,
    compassRequestJson: JSON.stringify(request)
  };
}

function workbookRows(base64: string) {
  const workbook = XLSX.read(base64, { type: "base64" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return sheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null }) : [];
}

async function collectCompassRows(payload: DoudianAdapterPayload, store: DoudianStoreSummary, args: StaleGoodsArgs, rules: DoudianStaleGoodsRules) {
  if (args.compassRows?.length && args.compassPeriod === rules.trafficPeriod) {
    return {
      rows: args.compassRows,
      complete: true,
      sourceHealth: [{ key: "staleGoodsCompassImport", status: 200, ok: true, itemCount: args.compassRows.length, period: rules.trafficPeriod }],
      responses: {} as Record<string, RequestPlanResult>
    };
  }
  if (args.mockProducts?.length) return { rows: [] as Array<Record<string, unknown>>, complete: true, sourceHealth: [] as Array<Record<string, unknown>>, responses: {} as Record<string, RequestPlanResult> };
  const planKey = "staleGoodsCompassDownload";
  if (!payload.adapter.requestPlans?.[planKey]) return { rows: [] as Array<Record<string, unknown>>, complete: false, sourceHealth: [{ key: planKey, status: 0, ok: false, reason: "missing-plan" }], responses: {} as Record<string, RequestPlanResult> };
  const response = await runPlan(payload, store, planKey, compassRequestContext(rules.trafficPeriod));
  const responses = { [planKey]: response };
  const responseOk = requestPlanResponseOk(response, payload.adapter, planKey, mappings(payload.adapter));
  try {
    const rows = responseOk && typeof response.data === "string" ? workbookRows(response.data) : [];
    const complete = responseOk && rows.length > 0;
    return { rows, complete, sourceHealth: [{ key: planKey, status: response.status, ok: complete, itemCount: rows.length, period: rules.trafficPeriod }], responses };
  } catch (error) {
    return { rows: [] as Array<Record<string, unknown>>, complete: false, sourceHealth: [{ key: planKey, status: response.status, ok: false, reason: "workbook-parse-failed", message: error instanceof Error ? error.message : String(error) }], responses };
  }
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

async function scanStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, args: StaleGoodsArgs, runId: string, rules: DoudianStaleGoodsRules) {
  const [collected, compassResult, recommendResult] = await Promise.all([
    collectProducts(payload, store, args, rules),
    collectCompassRows(payload, store, args, rules),
    args.mockProducts?.length
      ? Promise.resolve({ byId: new Map<string, Set<number>>(), complete: true, fetchedPages: 0, sourceHealth: [] as Array<Record<string, unknown>>, responses: {} as Record<string, RequestPlanResult> })
      : collectRecommendAdmit(payload, store, rules)
  ]);
  const compass = compassByProductId(compassResult.rows);
  const products = collected.products
    .map((product) => candidateFromProduct(store, product, payload.adapter, runId, compass, recommendResult.byId, rules.productSource))
    .filter((product): product is DoudianStaleGoodsCandidate => Boolean(product));
  const evaluations = products.map((product) => ({ product, evaluation: evaluateRules(product, rules) }));
  const matched = evaluations.filter((item) => item.evaluation.match).map((item) => item.product);
  const perStoreLimit = Math.max(0, Math.floor(Number(rules.perStoreLimit || 0)));
  const limitedCandidates = perStoreLimit
    ? [...matched].sort((left, right) => Number(right.riskScore || 0) - Number(left.riskScore || 0)).slice(0, perStoreLimit)
    : matched;
  const enabledMetricFields = Array.from(new Set([
    rules.totalSalesEnabled ? "totalSales" : "",
    rules.periodSalesEnabled ? "periodSales" : "",
    rules.exposureEnabled ? "exposureCount" : "",
    rules.clickEnabled ? "clickCount" : "",
    rules.exposureUsersEnabled ? "exposureUsers" : "",
    rules.clickUsersEnabled ? "clickUsers" : "",
    rules.noSalesType === "strict" || rules.noSalesType === "trafficWaste" ? "periodSales" : "",
    rules.noSalesType === "trafficWaste" ? "exposureCount" : ""
  ].filter(Boolean)));
  const selectedQualityFields = [
    rules.requireLowRating ? "ratingScore" : "",
    rules.requireLowInfo ? "infoQualityScore" : "",
    rules.requireLowImage ? "mainImageScore" : "",
    rules.requireSameStyleRisk ? "sameStyleRisk" : "",
    rules.requireBadTitle ? "titleQualityScore" : ""
  ].filter(Boolean);
  const missingMetricCount = products.filter((product) => enabledMetricFields.some((field) => product.metricAvailability?.[field] !== true)).length;
  const metricComplete = missingMetricCount === 0;
  const qualityComplete = recommendResult.complete || products.every((product) => selectedQualityFields.every((field) => product.metricAvailability?.[field] === true));
  const trafficFieldsEnabled = enabledMetricFields.some((field) => ["periodSales", "exposureCount", "clickCount", "exposureUsers", "clickUsers"].includes(field));
  const compassRequired = trafficFieldsEnabled && !metricComplete;
  const ok = collected.complete && recommendResult.complete && qualityComplete && (!compassRequired || compassResult.complete) && metricComplete;
  const candidates = ok ? limitedCandidates : [];
  const sourceHealth = [...collected.sourceHealth, ...compassResult.sourceHealth, ...recommendResult.sourceHealth];
  const optionalSourceFailure = sourceHealth.some((item) => item.ok === false);
  const row = buildRow(store, candidates, collected.remoteTotal);
  const reason = collected.malformed
    ? "stale-goods-product-response-malformed"
    : collected.truncated
      ? "stale-goods-product-list-truncated"
      : !collected.complete
        ? "stale-goods-product-list-incomplete"
        : !recommendResult.complete || !qualityComplete
          ? "stale-goods-recommend-incomplete"
          : !metricComplete || (compassRequired && !compassResult.complete)
            ? "stale-goods-metrics-incomplete"
            : candidates.length ? "" : "stale-goods-no-candidate";
  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (optionalSourceFailure ? "partial" : "ok") : "failed",
    ok,
    message: ok
      ? candidates.length ? policyMessage(payload.adapter, "staleGoodsCleanup.messages.scanned", "Stale goods scanned") : policyMessage(payload.adapter, "staleGoodsCleanup.messages.noCandidateStore", "No stale goods candidates")
      : policyMessage(payload.adapter, "staleGoodsCleanup.messages.failed", "Stale goods scan failed"),
    reason,
    category: ok ? (optionalSourceFailure ? "source" : "") : collected.truncated ? "coverage" : "api",
    diagnostic: {
      productCount: products.length,
      candidateCount: candidates.length,
      remoteTotal: collected.remoteTotal,
      ageBlocked: evaluations.filter((item) => item.evaluation.ageBlocked).length,
      missingCreatedAt: products.filter((item) => !item.createdAt).length,
      missingListedAt: products.filter((item) => !item.listedAt).length,
      missingAgeDate: products.filter((item) => !item.ageDate).length,
      missingMetricCount,
      compassSourceCount: compass.size,
      compassMatchedCount: products.filter((item) => item.compassMatched).length,
      recommendMatchedCount: products.filter((item) => (item.recommendThresholds || []).length > 0).length,
      truncated: collected.truncated,
      splitRequired: collected.splitRequired,
      malformed: collected.malformed,
      fetchedPages: collected.fetchedPages,
      plannedPages: collected.plannedPages,
      recommendFetchedPages: recommendResult.fetchedPages,
      sourceHealth
    }
  };
  await reportStaleGoodsRow({
    store,
    row,
    detail,
    products,
    candidates,
    responses: { ...collected.responses, ...compassResult.responses, ...recommendResult.responses },
    adapter: payload.adapter
  });
  return { row, products, candidates, detail, sourceHealth };
}

async function saveScanRun(record: ScanRunRecord) {
  await repositoryPut("stale_scan_runs", record);
  await repositoryPutMany("stale_candidates", record.candidates.map((candidate) => ({ ...candidate, id: candidate.id })));
}

function scanSummary(rows: DoudianStaleGoodsRow[], candidates: DoudianStaleGoodsCandidate[], details: DoudianRunDetail[], sourceHealth: Array<Record<string, unknown>>) {
  const diagnosticNumber = (detail: DoudianRunDetail, key: string) => {
    const value = Number(objectRecord(detail.diagnostic)[key] || 0);
    return Number.isFinite(value) ? value : 0;
  };
  const productCount = details.reduce((sum, detail) => sum + diagnosticNumber(detail, "productCount"), 0);
  const compassMatchedCount = details.reduce((sum, detail) => sum + diagnosticNumber(detail, "compassMatchedCount"), 0);
  return {
    productCount,
    remoteTotal: rows.reduce((sum, row) => sum + Number(row.totalProducts || 0), 0),
    candidateCount: candidates.length,
    ageBlocked: details.reduce((sum, detail) => sum + diagnosticNumber(detail, "ageBlocked"), 0),
    missingCreatedAt: details.reduce((sum, detail) => sum + diagnosticNumber(detail, "missingCreatedAt"), 0),
    missingListedAt: details.reduce((sum, detail) => sum + diagnosticNumber(detail, "missingListedAt"), 0),
    missingAgeDate: details.reduce((sum, detail) => sum + diagnosticNumber(detail, "missingAgeDate"), 0),
    missingMetricCount: details.reduce((sum, detail) => sum + diagnosticNumber(detail, "missingMetricCount"), 0),
    sourceFailureCount: sourceHealth.filter((item) => item.ok === false).length,
    diagnosticSourceCount: sourceHealth.filter((item) => !String(item.key || "").startsWith("staleGoodsProductList")).length,
    truncatedStoreCount: details.filter((detail) => objectRecord(detail.diagnostic).truncated === true).length,
    splitRequiredStoreCount: details.filter((detail) => objectRecord(detail.diagnostic).splitRequired === true).length,
    fetchedPages: details.reduce((sum, detail) => sum + diagnosticNumber(detail, "fetchedPages"), 0),
    plannedPages: details.reduce((sum, detail) => sum + diagnosticNumber(detail, "plannedPages"), 0),
    compassSourceCount: details.reduce((sum, detail) => sum + diagnosticNumber(detail, "compassSourceCount"), 0),
    compassMatchedCount,
    compassMatchRate: productCount ? (compassMatchedCount / productCount) * 100 : 0
  };
}

async function fetchStaleGoodsExecute(payload: DoudianAdapterPayload, args: StaleGoodsArgs): Promise<DoudianStaleGoodsCleanupResult> {
  if (String(args.confirmText || "") !== "\u786e\u8ba4\u6e05\u7406") throw new Error("stale goods cleanup confirm text mismatch");
  const action = text(args.action);
  if (!["offline", "recycle", "delete"].includes(action)) throw new Error("unsupported stale goods cleanup action");
  const sourceRunId = text(args.sourceRunId);
  const selected = await loadExecuteCandidates(sourceRunId, args.candidateIds || [], action);

  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const selectedShopIds = new Set(selected.map((candidate) => candidate.shopId));
  const targets = stores.filter((store) => selectedShopIds.has(store.shopId));
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
  const successCount = executions.filter((execution) => execution.ok).length;
  const failureCount = executions.filter((execution) => !execution.ok).length;
  const successfulStoreCount = details.filter((detail) => detail.ok).length;
  const failedStoreCount = details.filter((detail) => !detail.ok).length;
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
    summary: { ...summary, successfulStoreCount, failedStoreCount },
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
    summary: { ...summary, successfulStoreCount, failedStoreCount },
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
  const concurrency = Math.max(1, Math.min(targets.length || 1, policyNumber(payload.adapter, "staleGoodsCleanup.concurrency", 2, 1, 8)));
  const results = new Array<Awaited<ReturnType<typeof scanStore>>>(targets.length);
  let nextStoreIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = nextStoreIndex;
      nextStoreIndex += 1;
      if (index >= targets.length) return;
      results[index] = await scanStore(payload, targets[index], args, runId, rules);
    }
  }));
  for (const result of results) {
    rows.push(result.row);
    candidates.push(...result.candidates);
    details.push(result.detail);
    sourceHealth.push(...result.sourceHealth);
  }
  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.filter((detail) => !detail.ok).length;
  const partialSourceCount = details.filter((detail) => detail.ok && detail.status === "partial").length;
  const summary = scanSummary(rows, candidates, details, sourceHealth);
  const cleanupRuleVersion = policyText(payload.adapter, "staleGoodsCleanup.ruleVersion", "stale-goods-rule");
  const fieldSchemaVersion = policyText(payload.adapter, "staleGoodsCleanup.fieldSchemaVersion", "stale-goods-fields");
  const requestHash = requestPlanHash(payload.adapter, planKeys);
  const status = failureCount ? (successCount ? "partial" : "failed") : partialSourceCount ? "partial" : "ok";
  const message = failureCount
    ? policyMessage(payload.adapter, "staleGoodsCleanup.messages.partial", "Stale goods scan partially failed", { successCount, failureCount })
    : partialSourceCount
      ? policyMessage(payload.adapter, "staleGoodsCleanup.messages.partialSourceStore", "Stale goods scan completed with source warnings", { count: partialSourceCount })
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
    ok: failureCount === 0 && partialSourceCount === 0,
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
    partialCount: failureCount + partialSourceCount,
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
  const latest = runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  if (!latest) return null;
  if (latest.candidates?.length) return latest;
  const candidates = await repositoryGetAll<DoudianStaleGoodsCandidate>("stale_candidates").catch(() => []);
  return {
    ...latest,
    candidates: candidates.filter((candidate) => candidate.sourceRunId === latest.runId || candidate.sourceRunId === latest.id)
  };
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
      rules: { ...defaultRules(payload.adapter), totalSalesMax: 5, exposureMax: 800, clickMax: 30 },
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
      rules: { ...defaultRules(payload.adapter), totalSalesMax: 5, exposureMax: 800, clickMax: 30 },
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
