import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianRunDetail,
  DoudianStoreSummary,
  DoudianViolationRecord,
  DoudianViolationsDataResult,
  DoudianViolationsDataRow
} from "../../types";
import { requireChihuNative } from "../../native/client";
import { getNativeData } from "../../nativeData/client";
import { repositoryDelete, repositoryGetAll, repositoryGetMany, repositoryPutMany } from "./repository";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";
import { dispatchDoudianProgress } from "./progress";
import violationsResponseFixture from "./fixtures/violationsResponse.json";

const VIOLATION_DATA_FIELDS = [
  "totalRecords",
  "pendingCount",
  "appealCount",
  "rectificationCount",
  "highRiskCount",
  "dueSoonCount",
  "overdueCount",
  "productLinkedCount",
  "productMissingCount",
  "offlineProductCount",
  "failedCount",
  "penaltyAmount"
] as const;

type ViolationField = typeof VIOLATION_DATA_FIELDS[number];

interface ViolationsDataArgs {
  doudianAdapter?: DoudianAdapterPayload;
  shopIds?: string[];
  datePreset?: string;
  beginDate?: string;
  endDate?: string;
  processStatus?: string;
  operationId?: string;
  page?: number;
  pageSize?: number;
  maxPages?: number;
  concurrency?: number;
  mockRecords?: DoudianViolationRecord[];
  isCancelled?: () => boolean;
  trackWindow?: (winId: number) => void;
}

function throwIfCancelled(args: ViolationsDataArgs) {
  if (args.isCancelled?.()) throw new Error("cancelled");
}

interface DateContext {
  [key: string]: string;
  datePreset: string;
  dateType: string;
  legacyActiveKey: string;
  legacyDateType: string;
  beginDate: string;
  endDate: string;
  beginDateSlash: string;
  endDateSlash: string;
  startDate: string;
  beginDateCompact: string;
  endDateCompact: string;
  startDateCompact: string;
}

type ViolationsCoverageStatus = "complete" | "truncated" | "partial" | "failed" | "not_queried";

interface StoreCoverage {
  coverageStatus: ViolationsCoverageStatus;
  complete: boolean;
  truncated: boolean;
  fetchedAt: string;
  remoteTotal?: number;
  fetchedRecords: number;
}

interface ViolationsLatestRecord {
  id: string;
  shopId: string;
  shopName: string;
  ok: boolean;
  message: string;
  row: DoudianViolationsDataRow;
  records: DoudianViolationRecord[];
  diagnostic?: unknown;
  datePreset: string;
  beginDate: string;
  endDate: string;
  adapterVersion: string;
  ruleVersion: string;
  scriptsVersion: string;
  fieldSchemaVersion: string;
  requestPlanHash: string;
  productLinkageVersion: string;
  updatedAt: string;
}

function nowIso() {
  return new Date().toISOString();
}

function text(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validIsoDate(value: unknown) {
  const next = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(next) ? next : "";
}

function formatLocalIsoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDateDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function compactDate(value: string) {
  return value.replace(/-/g, "");
}

function slashDateStart(value: string) {
  return `${value.replace(/-/g, "/")} 00:00:00`;
}

function localDateStartMs(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return parsed.getTime();
}

function recordInDateRange(record: DoudianViolationRecord, dateContext: DateContext) {
  if (dateContext.datePreset === "all") return true;
  const value = String(record.violationAt || record.createdAt || "");
  const timestamp = dueMs(value);
  const begin = localDateStartMs(dateContext.beginDate);
  const endExclusive = addDateDays(new Date(`${dateContext.endDate}T00:00:00`), 1).getTime();
  return Number.isFinite(timestamp) && Number.isFinite(begin) && Number.isFinite(endExclusive) && timestamp >= begin && timestamp < endExclusive;
}

function policy(adapter: DoudianAdapterConfig, path: string, fallback: unknown = undefined): unknown {
  const value = getPathValue(adapter.policies || {}, path);
  return value === undefined ? fallback : value;
}

function policyArray(adapter: DoudianAdapterConfig, path: string): string[] {
  const value = policy(adapter, path, []);
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function policyText(adapter: DoudianAdapterConfig, path: string, fallback = "") {
  const value = policy(adapter, path, fallback);
  return value == null ? fallback : String(value);
}

function policyNumber(adapter: DoudianAdapterConfig, path: string, fallback: number) {
  const value = Number(policy(adapter, path, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function policyMessage(adapter: DoudianAdapterConfig, path: string, fallback: string, values: Record<string, unknown> = {}) {
  return policyText(adapter, path, fallback).replace(/\{([^}]+)\}/g, (_match, key) => String(values[key] ?? ""));
}

function dataPresetPolicy(adapter: DoudianAdapterConfig, preset: string) {
  const presets = objectRecord(policy(adapter, "violationsData.datePresets", {}));
  const direct = objectRecord(presets[preset]);
  if (Object.keys(direct).length) return direct;
  const matched = Object.values(presets).find((item) => {
    const config = objectRecord(item);
    return text(config.dateType) === preset || text(config.legacyDateType) === preset || text(config.legacyActiveKey) === preset;
  });
  return objectRecord(matched);
}

function dataPresetNumber(adapter: DoudianAdapterConfig, preset: string, key: string, fallback: number) {
  const value = Number(dataPresetPolicy(adapter, preset)[key]);
  return Number.isFinite(value) ? value : fallback;
}

function dataPresetText(adapter: DoudianAdapterConfig, preset: string, key: string, fallback = "") {
  const value = dataPresetPolicy(adapter, preset)[key];
  return value == null ? fallback : String(value);
}

function resolveDatePreset(adapter: DoudianAdapterConfig, value = "all") {
  const key = text(value) || "all";
  const presets = objectRecord(policy(adapter, "violationsData.datePresets", {}));
  if (presets[key]) return key;
  const matched = Object.entries(presets).find(([, item]) => {
    const config = objectRecord(item);
    return text(config.dateType) === key || text(config.legacyDateType) === key || text(config.legacyActiveKey) === key;
  });
  return matched ? matched[0] : key;
}

function violationsDateContext(args: ViolationsDataArgs, adapter: DoudianAdapterConfig): DateContext {
  const preset = resolveDatePreset(adapter, args.datePreset || "all");
  const today = new Date();
  let beginDate = validIsoDate(args.beginDate);
  let endDate = validIsoDate(args.endDate);
  if (!beginDate || !endDate) {
    const fallbackStart = preset === "all" ? -3650 : preset === "7d" ? -6 : preset === "30d" ? -29 : 0;
    beginDate = formatLocalIsoDate(addDateDays(today, dataPresetNumber(adapter, preset, "startOffsetDays", fallbackStart)));
    endDate = formatLocalIsoDate(addDateDays(today, dataPresetNumber(adapter, preset, "endOffsetDays", 0)));
    if (dataPresetPolicy(adapter, preset).sameDay === true) endDate = beginDate;
  }
  const dateType = dataPresetText(adapter, preset, "dateType", policyText(adapter, `violationsData.datePresetMap.${preset}`, preset));
  const legacyDateType = dataPresetText(adapter, preset, "legacyDateType", "999");
  const legacyActiveKey = dataPresetText(adapter, preset, "legacyActiveKey", "999");
  return {
    datePreset: preset,
    dateType,
    legacyActiveKey,
    legacyDateType,
    beginDate,
    endDate,
    beginDateSlash: slashDateStart(beginDate),
    endDateSlash: slashDateStart(endDate),
    startDate: beginDate,
    beginDateCompact: compactDate(beginDate),
    endDateCompact: compactDate(endDate),
    startDateCompact: compactDate(beginDate)
  };
}

function publicDateRange(dateContext: DateContext) {
  return {
    datePreset: dateContext.datePreset,
    beginDate: dateContext.beginDate,
    endDate: dateContext.endDate,
    dateType: dateContext.dateType,
    legacyActiveKey: dateContext.legacyActiveKey,
    legacyDateType: dateContext.legacyDateType
  };
}

function responseMappings(adapter: DoudianAdapterConfig) {
  return objectRecord(adapter.responseMappings);
}

function violationsDataMappings(adapter: DoudianAdapterConfig) {
  return objectRecord(responseMappings(adapter).violationsData);
}

function violationFieldConfig(adapter: DoudianAdapterConfig, field: string) {
  const fields = objectRecord(violationsDataMappings(adapter).fields);
  const value = fields[field];
  if (Array.isArray(value)) return { paths: value };
  return objectRecord(value);
}

function violationFieldPaths(adapter: DoudianAdapterConfig, field: string) {
  const paths = violationFieldConfig(adapter, field).paths;
  return Array.isArray(paths) ? paths.map((item) => text(item)).filter(Boolean) : [];
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

function readViolationField(record: unknown, adapter: DoudianAdapterConfig, field: string) {
  return firstPathValue(record, violationFieldPaths(adapter, field));
}

function fieldScale(adapter: DoudianAdapterConfig, field: string) {
  const scales = objectRecord(violationsDataMappings(adapter).fieldScales);
  const config = violationFieldConfig(adapter, field);
  const value = Number(config.scale || scales[field] || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function normalizeDateTime(value: unknown) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : value;
    return formatDateTime(new Date(ms));
  }
  const next = text(value);
  if (/^\d+$/.test(next)) return normalizeDateTime(Number(next));
  const parsed = new Date(next.includes("T") ? next : next.replace(/\//g, "-").replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? next.slice(0, 32) : formatDateTime(parsed);
}

function formatDateTime(date: Date) {
  if (Number.isNaN(date.getTime())) return "";
  return `${formatLocalIsoDate(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dueMs(value: string) {
  const parsed = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  return parsed.getTime();
}

function dueSoon(value: string) {
  const ms = dueMs(value);
  if (!Number.isFinite(ms)) return false;
  const hours = (ms - Date.now()) / 36e5;
  return hours >= 0 && hours <= 24;
}

function overdue(value: string) {
  const ms = dueMs(value);
  return Number.isFinite(ms) && ms < Date.now();
}

function normalizeSeverity(value: unknown) {
  const number = coerceNumber(value);
  const next = text(value).toLowerCase();
  if (/(高|严重|重大|high|severe|critical)/i.test(next) || (number !== undefined && number >= 3)) return "high";
  if (/(中|一般|medium|mid)/i.test(next) || number === 2) return "medium";
  return "low";
}

function normalizeProcessStatus(value: unknown) {
  const next = text(value).toLowerCase();
  if (!next) return "unknown";
  if (/(完成|成功|已处理|已处置|已处罚|已撤销|关闭|通过|done|success|finish|closed)/i.test(next)) return "done";
  if (/(失败|异常|error|fail)/i.test(next)) return "failed";
  if (/(申诉|appeal)/i.test(next)) return "appealing";
  if (/(整改|修复|rectif|repair)/i.test(next)) return "rectifying";
  if (/(待|未处理|pending|waiting|todo)/i.test(next)) return "pending";
  return "unknown";
}

function normalizeWorkflowStatus(value: unknown, kind: "appeal" | "rectification" | "penalty") {
  const next = String(value ?? "").trim().toLowerCase();
  if (!next || /^-1$/.test(next) || /(不支持|无需|not supported)/i.test(next)) return "unknown";
  if (kind === "appeal" && next === "0") return "appealing";
  if (kind === "rectification" && next === "0") return "rectifying";
  if ((kind === "appeal" || kind === "rectification") && next === "1") return "done";
  if ((kind === "appeal" || kind === "rectification") && ["2", "11", "21"].includes(next)) return "failed";
  if (kind === "appeal" && next === "3") return "appealing";
  if (kind === "rectification" && next === "3") return "rectifying";
  if ((kind === "appeal" || kind === "rectification") && next === "20") return "pending";
  if (kind === "penalty" && ["1", "2"].includes(next)) return "done";
  if (kind === "penalty" && next === "3") return "pending";
  return normalizeProcessStatus(next);
}

function resolveProcessStatus(record: unknown, adapter: DoudianAdapterConfig) {
  const explicit = normalizeProcessStatus(readViolationField(record, adapter, "processStatus"));
  if (explicit !== "unknown") return explicit;
  const statuses = [
    normalizeWorkflowStatus(readViolationField(record, adapter, "appealStatus"), "appeal"),
    normalizeWorkflowStatus(readViolationField(record, adapter, "rectificationStatus"), "rectification")
  ];
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("appealing")) return "appealing";
  if (statuses.includes("rectifying")) return "rectifying";
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("done")) return "done";
  return normalizeWorkflowStatus(readViolationField(record, adapter, "penaltyStatus"), "penalty");
}

function normalizeProductStatus(value: unknown, productId = "") {
  if (!productId) return "无需关联";
  const next = text(value).toLowerCase();
  if (!next) return "未查询";
  if (/(无需|不涉及|no need)/i.test(next)) return "无需关联";
  if (/(未关联|缺失|找不到|不存在|missing|not found)/i.test(next)) return "未关联";
  if (/(回收|recycle)/i.test(next)) return "回收站";
  if (/(下架|不可售|offline|off[-_ ]?sale|sold out)/i.test(next)) return "已下架";
  if (/(在售|售卖|online|on[-_ ]?sale|selling)/i.test(next)) return "在售";
  return "未查询";
}

function associationStatus(productStatus: string, productId = "") {
  if (!productId || productStatus === "无需关联") return "not_required";
  if (productStatus === "未查询") return "not_checked";
  if (productStatus === "未关联") return "not_found";
  if (productStatus === "回收站") return "recycled";
  if (productStatus === "已下架") return "offline";
  if (productStatus === "在售") return "online";
  return "unknown";
}

const OBJECT_TYPE_LABELS: Record<string, string> = {
  "1": "订单",
  "2": "商品",
  "3": "店铺",
  "25": "渠道商品",
  "32": "售后单",
  "61": "电商门店"
};

function normalizeObjectType(value: unknown, productId = "") {
  const next = text(value).toLowerCase();
  if (OBJECT_TYPE_LABELS[next]) return OBJECT_TYPE_LABELS[next];
  if (/(渠道商品|channel.{0,4}(goods|product|item))/i.test(next)) return "渠道商品";
  if (/(售后单|after.?sale)/i.test(next)) return "售后单";
  if (/(电商门店|e.?commerce.{0,4}store)/i.test(next)) return "电商门店";
  if (/(商品|goods|product|item|sku)/i.test(next)) return "商品";
  if (/(订单|order)/i.test(next)) return "订单";
  if (/(内容|素材|content|material)/i.test(next)) return "内容";
  if (/(店铺|shop|store)/i.test(next)) return "店铺";
  if (!next && productId) return "商品";
  return next ? "未知" : "店铺";
}

function amount(value: unknown, scale = 1) {
  const number = coerceNumber(value);
  return number !== undefined ? number / scale : 0;
}

function payloadFromResponses(responses: Record<string, RequestPlanResult>) {
  const payload: Record<string, unknown> = { responses };
  for (const [key, response] of Object.entries(responses)) payload[key] = response.data;
  return payload;
}

function mappedPlanPaths(adapter: DoudianAdapterConfig, kind: "listPaths" | "totalPaths", planKey = "") {
  const mappings = violationsDataMappings(adapter);
  const byPlan = objectRecord(mappings[`${kind}ByPlan`]);
  const planPaths = planKey ? byPlan[planKey] : undefined;
  if (Array.isArray(planPaths)) return planPaths.map((item) => text(item)).filter(Boolean);
  const paths = mappings[kind];
  return Array.isArray(paths) ? paths.map((item) => text(item)).filter(Boolean) : [];
}

function listPaths(adapter: DoudianAdapterConfig, planKey = "") {
  return mappedPlanPaths(adapter, "listPaths", planKey);
}

function totalPaths(adapter: DoudianAdapterConfig, planKey = "") {
  return mappedPlanPaths(adapter, "totalPaths", planKey);
}

function readTotal(payload: unknown, adapter: DoudianAdapterConfig, planKey = ""): number | undefined {
  const total = coerceNumber(firstPathValue(payload, totalPaths(adapter, planKey)));
  return total !== undefined && total >= 0 ? total : undefined;
}

function paginationCoverage(args: {
  remoteTotal?: number;
  mergedRecordCount: number;
  stoppedOnShortPage: boolean;
  requestFailed: boolean;
  fetchedPages: number;
  maxPages: number;
}) {
  const totalSatisfied = args.remoteTotal !== undefined && args.mergedRecordCount >= args.remoteTotal;
  const truncated = !args.requestFailed && !args.stoppedOnShortPage && !totalSatisfied && args.fetchedPages >= args.maxPages;
  const complete = !args.requestFailed && !truncated && (args.stoppedOnShortPage || totalSatisfied || args.remoteTotal === 0);
  const coverageStatus: ViolationsCoverageStatus = truncated
    ? "truncated"
    : args.requestFailed
      ? (args.mergedRecordCount ? "partial" : "failed")
      : complete
        ? "complete"
        : "partial";
  return { totalSatisfied, truncated, complete, coverageStatus };
}

function mergePagePayloads(planKey: string, responses: RequestPlanResult[], adapter: DoudianAdapterConfig) {
  const list = responses.flatMap((response) => firstArray({ [planKey]: response.data }, listPaths(adapter, planKey)));
  const totals = responses.map((response) => readTotal({ [planKey]: response.data }, adapter, planKey)).filter((value): value is number => value !== undefined);
  const total = totals.length ? Math.max(...totals) : undefined;
  const first = responses[0];
  if (!first) return { ok: false, status: 0, data: null, error: "missing response", source: planKey };
  return {
    ...first,
    ok: responses.every((response) => response.ok),
    status: first.status || responses.find((response) => response.status)?.status || 0,
    error: responses.map((response) => response.error).filter(Boolean).join("; "),
    data: {
      data: {
        tickets: list,
        total: total ?? list.length
      },
      tickets: list,
      total: total ?? list.length
    }
  };
}

function readViolationListField(record: unknown, adapter: DoudianAdapterConfig, field: string) {
  const config = violationFieldConfig(adapter, field);
  const arrayPaths = Array.isArray(config.arrayPaths) ? config.arrayPaths.map((item) => text(item)).filter(Boolean) : [];
  const itemPaths = Array.isArray(config.itemPaths) ? config.itemPaths.map((item) => text(item)).filter(Boolean) : [];
  for (const path of arrayPaths) {
    const list = getPathValue(record, path);
    if (!Array.isArray(list)) continue;
    return list.map((item) => text(itemPaths.length ? firstPathValue(item, itemPaths) : item)).filter(Boolean);
  }
  return [];
}

function normalizeTicketType(value: unknown, planKey = "") {
  const next = text(value).toLowerCase();
  if (next === "risk" || /risk/i.test(planKey)) return "risk";
  return "penalty";
}

function statusValueMap(adapter: DoudianAdapterConfig, kind: "labels" | "buckets", ticketType: string) {
  return objectRecord(objectRecord(policy(adapter, `violationsData.processStatus.${kind}`, {}))[ticketType]);
}

function rawProcessStatusCode(record: unknown, adapter: DoudianAdapterConfig) {
  return readViolationField(record, adapter, "processStatusCode") ?? readViolationField(record, adapter, "penaltyStatus");
}

function resolvedProcessStatusLabel(record: unknown, adapter: DoudianAdapterConfig, ticketType: string) {
  const code = text(rawProcessStatusCode(record, adapter));
  return text(statusValueMap(adapter, "labels", ticketType)[code]) || text(readViolationField(record, adapter, "processStatus"));
}

function resolveMappedProcessStatus(record: unknown, adapter: DoudianAdapterConfig, ticketType: string) {
  const code = text(rawProcessStatusCode(record, adapter));
  const mapped = text(statusValueMap(adapter, "buckets", ticketType)[code]);
  if (mapped) return mapped;
  return resolveProcessStatus(record, adapter);
}

function extractRecords(store: DoudianStoreSummary, responses: Record<string, RequestPlanResult>, requestContext: Record<string, unknown>, adapter: DoudianAdapterConfig): DoudianViolationRecord[] {
  const sources = Object.entries(responses).flatMap(([planKey, response]) => (
    firstArray({ [planKey]: response.data }, listPaths(adapter, planKey)).map((item) => ({ item, planKey }))
  ));
  const records = sources.map(({ item, planKey }, index) => {
    const candidateProductId = text(readViolationField(item, adapter, "productId"));
    const objectId = text(readViolationField(item, adapter, "objectId")) || candidateProductId;
    const rawObjectType = readViolationField(item, adapter, "objectType");
    const objectType = normalizeObjectType(rawObjectType, candidateProductId);
    const productId = objectType === "商品" ? (candidateProductId || objectId) : "";
    const reason = text(readViolationField(item, adapter, "reason"));
    const dueAt = normalizeDateTime(readViolationField(item, adapter, "dueAt"));
    const violationAt = normalizeDateTime(readViolationField(item, adapter, "violationAt"));
    const createdAt = normalizeDateTime(readViolationField(item, adapter, "createdAt"));
    const id = text(readViolationField(item, adapter, "id")) || `${store.shopId || "shop"}-violation-${index + 1}`;
    const productStatus = normalizeProductStatus(readViolationField(item, adapter, "productStatus"), productId);
    const ticketType = normalizeTicketType(readViolationField(item, adapter, "ticketType"), planKey);
    const severityCode = readViolationField(item, adapter, "severityCode") ?? readViolationField(item, adapter, "severity");
    const executionTypes = readViolationListField(item, adapter, "executionTypes");
    const processStatusCode = rawProcessStatusCode(item, adapter);
    return {
      id,
      shopId: store.shopId,
      shopName: store.shopName,
      group: store.groupName || "",
      objectType,
      objectId,
      objectTypeCode: text(rawObjectType),
      objectName: text(readViolationField(item, adapter, "objectName")) || reason || id,
      objectImage: text(readViolationField(item, adapter, "objectImage")),
      ticketType,
      ticketTypeLabel: ticketType === "risk" ? "预警" : "处罚",
      productId,
      reason: reason || "违规原因待确认",
      violationDetail: text(readViolationField(item, adapter, "violationDetail")),
      severity: normalizeSeverity(severityCode),
      severityCode: text(severityCode),
      severityLabel: normalizeSeverity(severityCode) === "high" ? "严重" : normalizeSeverity(severityCode) === "medium" ? "一般" : "轻微",
      processStatus: resolveMappedProcessStatus(item, adapter, ticketType),
      processStatusCode: text(processStatusCode),
      processStatusLabel: resolvedProcessStatusLabel(item, adapter, ticketType),
      productStatus,
      associationStatus: associationStatus(productStatus, productId),
      action: text(readViolationField(item, adapter, "action")) || executionTypes.join(",") || "待人工确认",
      executionTypes,
      dueAt,
      violationAt,
      createdAt,
      penaltyAmount: amount(readViolationField(item, adapter, "penaltyAmount"), fieldScale(adapter, "penaltyAmount")),
      failureReason: text(readViolationField(item, adapter, "failureReason")),
      sourcePlan: planKey || String(requestContext.sourcePlan || ""),
      source: text(readViolationField(item, adapter, "source")) || (ticketType === "risk" ? "违规预警列表" : "违规处罚列表")
    };
  });
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = text(record.id);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyRow(store: DoudianStoreSummary): DoudianViolationsDataRow {
  return {
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    status: store.status,
    totalRecords: 0,
    pendingCount: 0,
    appealCount: 0,
    rectificationCount: 0,
    highRiskCount: 0,
    dueSoonCount: 0,
    overdueCount: 0,
    productLinkedCount: 0,
    productMissingCount: 0,
    offlineProductCount: 0,
    failedCount: 0,
    penaltyAmount: 0,
    coverageStatus: "not_queried",
    complete: false,
    truncated: false,
    fetchedAt: ""
  };
}

function buildRow(store: DoudianStoreSummary, records: DoudianViolationRecord[], dateContext: DateContext, coverage: StoreCoverage = {
  coverageStatus: "complete",
  complete: true,
  truncated: false,
  fetchedAt: nowIso(),
  fetchedRecords: records.length
}) {
  const row = emptyRow(store);
  row.totalRecords = records.length;
  row.riskRecords = records.filter((record) => record.ticketType === "risk").length;
  row.penaltyRecords = records.filter((record) => record.ticketType !== "risk").length;
  row.pendingCount = records.filter((record) => record.processStatus === "pending").length;
  row.appealCount = records.filter((record) => record.processStatus === "appealing").length;
  row.rectificationCount = records.filter((record) => record.processStatus === "rectifying").length;
  row.highRiskCount = records.filter((record) => record.severity === "high").length;
  row.dueSoonCount = records.filter((record) => record.processStatus !== "done" && dueSoon(String(record.dueAt || ""))).length;
  row.overdueCount = records.filter((record) => record.processStatus !== "done" && overdue(String(record.dueAt || ""))).length;
  row.productLinkedCount = records.filter((record) => ["online", "offline", "recycled"].includes(String(record.associationStatus || ""))).length;
  row.productMissingCount = records.filter((record) => record.associationStatus === "not_found").length;
  row.offlineProductCount = records.filter((record) => record.productStatus === "已下架" || record.productStatus === "回收站").length;
  row.failedCount = records.filter((record) => record.processStatus === "failed" || record.failureReason).length;
  row.penaltyAmount = records.reduce((sum, record) => sum + Number(record.penaltyAmount || 0), 0);
  row.datePreset = dateContext.datePreset;
  row.beginDate = dateContext.beginDate;
  row.endDate = dateContext.endDate;
  row.coverageStatus = coverage.coverageStatus;
  row.complete = coverage.complete;
  row.truncated = coverage.truncated;
  row.fetchedAt = coverage.fetchedAt;
  if (coverage.remoteTotal !== undefined) row.remoteTotal = coverage.remoteTotal;
  row.fetchedRecords = coverage.fetchedRecords;
  row.sourceTotal = coverage.remoteTotal ?? coverage.fetchedRecords;
  row.filteredTotal = records.length;
  return row;
}

function rowSummary(row: DoudianViolationsDataRow, records: DoudianViolationRecord[]) {
  const nonZeroFields = VIOLATION_DATA_FIELDS.filter((field) => Number(row[field] || 0) !== 0);
  return {
    recordCount: records.length,
    remoteTotal: row.remoteTotal === undefined ? null : Number(row.remoteTotal),
    nonZeroFieldCount: nonZeroFields.length,
    nonZeroFields,
    noRecord: Number(row.totalRecords || 0) === 0 && records.length === 0,
    selectedRangeNoRecord: row.datePreset !== "all" && records.length === 0,
    sourceRecordsFilteredOut: Math.max(0, Number(row.fetchedRecords || 0) - records.length),
    remoteTotalWithoutRecords: row.datePreset === "all" && Number(row.remoteTotal || 0) > 0 && records.length === 0
  };
}

function responseCode(response: RequestPlanResult) {
  return firstPathValue(response.data, ["code", "st", "status_code", "statusCode", "errno"]);
}

function responseMessage(response: RequestPlanResult) {
  return text(firstPathValue(response.data, ["msg", "message", "status_msg", "statusMessage"]) || response.error || "");
}

function summarizeResponses(responses: Record<string, RequestPlanResult>, adapter: DoudianAdapterConfig) {
  return Object.fromEntries(Object.entries(responses).map(([key, response]) => [key, {
    status: response.status || 0,
    success: requestPlanResponseOk(response, adapter, key, violationsDataMappings(adapter)),
    code: responseCode(response) ?? null,
    message: responseMessage(response).slice(0, 160)
  }]));
}

function summarizeFailures(summary: Record<string, { status: number; success: boolean; code: unknown; message: string }>, adapter: DoudianAdapterConfig) {
  const optionalPlans = new Set(policyArray(adapter, "violationsData.optionalPlans"));
  return Object.entries(summary)
    .filter(([, response]) => response.success !== true)
    .map(([key, response]) => ({
      key,
      optional: optionalPlans.has(key),
      status: response.status || 0,
      code: response.code,
      message: response.message || ""
    }));
}

async function reportViolationsDataRow(args: {
  store: DoudianStoreSummary;
  row: DoudianViolationsDataRow;
  detail: DoudianRunDetail;
  summary: ReturnType<typeof rowSummary>;
  responseSummary: Record<string, { status: number; success: boolean; code: unknown; message: string }>;
  pageSummary: Record<string, unknown>;
  operationId?: string;
}) {
  try {
    await requireChihuNative().logs.report({
      category: "doudian-violations-data",
      event: "row",
      operationId: args.operationId || "",
      shopId: args.store.shopId,
      shopName: args.store.shopName,
      partition: args.store.partition,
      ok: args.detail.ok,
      reason: args.detail.reason || "",
      message: args.detail.message || "",
      rowSummary: args.summary,
      dateRange: {
        datePreset: args.row.datePreset || "all",
        beginDate: args.row.beginDate || "",
        endDate: args.row.endDate || ""
      },
      metrics: {
        totalRecords: args.row.totalRecords,
        riskRecords: Number(args.row.riskRecords || 0),
        penaltyRecords: Number(args.row.penaltyRecords || 0),
        sourceTotal: args.row.sourceTotal ?? args.row.remoteTotal ?? args.row.fetchedRecords ?? 0,
        filteredTotal: args.row.filteredTotal ?? args.row.totalRecords,
        pendingCount: args.row.pendingCount,
        appealCount: args.row.appealCount,
        rectificationCount: args.row.rectificationCount,
        highRiskCount: args.row.highRiskCount,
        penaltyAmount: args.row.penaltyAmount
      },
      pageSummary: args.pageSummary,
      responses: args.responseSummary
    }).catch(() => undefined);
  } catch {
    // Diagnostics must never block syncing.
  }
}

function firstErrorMessage(responses: Record<string, RequestPlanResult>, adapter: DoudianAdapterConfig) {
  for (const [key, response] of Object.entries(responses)) {
    if (requestPlanResponseOk(response, adapter, key, violationsDataMappings(adapter))) continue;
    const message = responseMessage(response);
    if (message) return message.slice(0, 160);
    if (response.status) return `HTTP ${response.status}`;
  }
  return "";
}

function requestPlanKeys(adapter: DoudianAdapterConfig) {
  const policyPlans = policyArray(adapter, "violationsData.requestPlans");
  if (policyPlans.length) return Array.from(new Set(policyPlans));
  const operationPlans = objectRecord(adapter.operationPlans);
  const fetchPlan = objectRecord(operationPlans.fetchViolationsData);
  const actions = Array.isArray(fetchPlan.actions) ? fetchPlan.actions : [];
  return Array.from(new Set(actions.flatMap((action) => {
    const record = objectRecord(action);
    if (Array.isArray(record.requestPlans)) return record.requestPlans.map((item) => text(item)).filter(Boolean);
    return text(record.requestPlan) ? [text(record.requestPlan)] : [];
  })));
}

function fieldSchemaVersion(adapter: DoudianAdapterConfig) {
  return text(objectRecord(policy(adapter, "violationsData.fieldSchema", {})).version);
}

function productLinkageVersion(adapter: DoudianAdapterConfig) {
  const config = objectRecord(policy(adapter, "violationsData.productAssociation", {}));
  return text(config.version || policy(adapter, "violationsData.productAssociationVersion", ""));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function requestPlanHash(adapter: DoudianAdapterConfig, planKeys: string[]) {
  const textValue = stableStringify({
    adapterVersion: adapter.version || "",
    fieldSchemaVersion: fieldSchemaVersion(adapter),
    productLinkageVersion: productLinkageVersion(adapter),
    plans: planKeys.map((key) => ({ key, endpoint: adapter.endpoints?.[text(objectRecord(adapter.requestPlans?.[key]).endpointKey || key)] || "", plan: adapter.requestPlans?.[key] || {} }))
  });
  let hash = 0;
  for (let index = 0; index < textValue.length; index += 1) hash = ((hash << 5) - hash + textValue.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function associationPolicy(adapter: DoudianAdapterConfig) {
  return objectRecord(policy(adapter, "violationsData.productAssociation", {}));
}

function associationEnabled(adapter: DoudianAdapterConfig) {
  const gate = text(objectRecord(policy(adapter, "violationsData.acceptanceGates", {})).productAssociation).toLowerCase();
  return associationPolicy(adapter).enabled === true && ["passed", "accepted", "ready", "complete"].includes(gate);
}

function associationPlans(adapter: DoudianAdapterConfig) {
  const plans = associationPolicy(adapter).requestPlans;
  return Array.isArray(plans) ? plans.map((item) => text(item)).filter(Boolean) : [];
}

function associationFieldPaths(adapter: DoudianAdapterConfig, field: string) {
  const fields = objectRecord(associationPolicy(adapter).fields);
  const config = objectRecord(fields[field]);
  return Array.isArray(config.paths) ? config.paths.map((item) => text(item)).filter(Boolean) : [];
}

function associationListPaths(adapter: DoudianAdapterConfig) {
  const paths = associationPolicy(adapter).listPaths;
  return Array.isArray(paths) ? paths.map((item) => text(item)).filter(Boolean) : [];
}

function readAssociationField(value: unknown, adapter: DoudianAdapterConfig, field: string) {
  return firstPathValue(value, associationFieldPaths(adapter, field));
}

function extractAssociation(response: RequestPlanResult, adapter: DoudianAdapterConfig, productId: string, planKey: string) {
  if (!requestPlanResponseOk(response, adapter, planKey, violationsDataMappings(adapter))) return null;
  const payload = response.data;
  const directId = text(readAssociationField(payload, adapter, "productId"));
  const directStatus = normalizeProductStatus(readAssociationField(payload, adapter, "productStatus"), directId || productId);
  if (directId || directStatus !== "未查询") {
    return {
      productId: directId || productId,
      productStatus: directStatus,
      associationStatus: associationStatus(directStatus, directId || productId),
      raw: payload
    };
  }
  const items = firstArray(payload, associationListPaths(adapter));
  const matched = items.find((item) => text(readAssociationField(item, adapter, "productId")) === productId) || items[0];
  if (!matched) return { productId, productStatus: "未关联", associationStatus: "not_found", raw: payload };
  const matchedId = text(readAssociationField(matched, adapter, "productId")) || productId;
  const productStatus = normalizeProductStatus(readAssociationField(matched, adapter, "productStatus"), matchedId);
  return { productId: matchedId, productStatus, associationStatus: associationStatus(productStatus, matchedId), raw: matched };
}

function productStatusFromLifecycle(value: unknown) {
  const next = text(value).toLowerCase();
  if (["selling", "online", "on_sale"].includes(next)) return "在售";
  if (["offline", "off_sale", "sold_out"].includes(next)) return "已下架";
  if (["recycle", "recycled", "deleted"].includes(next)) return "回收站";
  if (["not_found", "missing"].includes(next)) return "未关联";
  return "未查询";
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()));
  return results;
}

async function associateProducts(payload: DoudianAdapterPayload, store: DoudianStoreSummary, records: DoudianViolationRecord[], requestContext: Record<string, unknown>, args: ViolationsDataArgs): Promise<{
  records: DoudianViolationRecord[];
  failures: Array<Record<string, unknown>>;
  responses: Record<string, unknown>;
}> {
  if (!associationEnabled(payload.adapter)) return { records, failures: [], responses: {} as Record<string, unknown> };
  const planKeys = associationPlans(payload.adapter);
  const productIds = Array.from(new Set(records.map((record) => text(record.productId)).filter(Boolean)));
  if (!productIds.length) return { records, failures: [], responses: {} as Record<string, unknown> };
  const failures: Array<Record<string, unknown>> = [];
  const responses: Record<string, unknown> = {};
  const byProductId = new Map<string, ReturnType<typeof extractAssociation>>();
  const nativeData = getNativeData();
  if (nativeData?.catalog.getProductsByIds) {
    try {
      const localRows = await nativeData.catalog.getProductsByIds({
        platform: "doudian",
        tenantId: text(store.tenantId) || "local-user",
        shopId: store.shopId,
        storeGeneration: Math.max(1, Math.trunc(Number(store.storeGeneration || 1))),
        productIds
      });
      for (const row of localRows) {
        const productStatus = productStatusFromLifecycle(row.lifecycleStatus || row.mergedFields?.lifecycleStatus);
        if (productStatus === "未查询") continue;
        byProductId.set(row.productId, {
          productId: row.productId,
          productStatus,
          associationStatus: associationStatus(productStatus, row.productId),
          raw: row
        });
      }
      responses.localCatalog = { requested: productIds.length, matched: byProductId.size };
    } catch (error) {
      failures.push({ key: "localProductCatalog", phase: "product_association", optional: true, status: 0, code: null, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const unresolvedProductIds = productIds.filter((productId) => !byProductId.has(productId));
  if (!planKeys.length || !unresolvedProductIds.length) {
    return {
      records: records.map((record) => {
        const association = byProductId.get(String(record.productId || ""));
        return association ? { ...record, productStatus: association.productStatus, associationStatus: association.associationStatus, productAssociationRaw: association.raw } : record;
      }),
      failures,
      responses
    };
  }
  const concurrency = Math.max(1, Math.min(4, Math.floor(Number(associationPolicy(payload.adapter).concurrency || 2))));
  const settled = await mapWithConcurrency(unresolvedProductIds, concurrency, async (productId) => {
    throwIfCancelled(args);
    for (const planKey of planKeys) {
      const response = await runDoudianRequestPlan(payload, {
        partition: store.partition,
        planKey,
        context: { ...requestContext, productId },
        trackWindow: args.trackWindow
      });
      responses[`${planKey}:${productId}`] = {
        status: response.status || 0,
        success: requestPlanResponseOk(response, payload.adapter, planKey, violationsDataMappings(payload.adapter)),
        code: responseCode(response),
        message: responseMessage(response)
      };
      if (!requestPlanResponseOk(response, payload.adapter, planKey, violationsDataMappings(payload.adapter))) {
        failures.push({ key: planKey, phase: "product_association", productId, optional: true, status: response.status || 0, code: responseCode(response), message: responseMessage(response) });
        continue;
      }
      const association = extractAssociation(response, payload.adapter, productId, planKey);
      if (association) byProductId.set(productId, association);
    }
  });
  settled.forEach((result, index) => {
    if (result.status === "rejected") failures.push({ key: planKeys.join(","), phase: "product_association", productId: unresolvedProductIds[index] || "", optional: true, status: 0, code: null, message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  });
  return {
    records: records.map((record) => {
      const association = byProductId.get(String(record.productId || ""));
      if (!association) return record;
      return {
        ...record,
        productStatus: association.productStatus || record.productStatus,
        associationStatus: association.associationStatus || record.associationStatus,
        productAssociationRaw: association.raw
      };
    }),
    failures,
    responses
  };
}

function latestId(shopId: string, dateContext: DateContext, adapterVersion: string, schemaVersion: string, hash: string, linkage: string) {
  return `${shopId}::${dateContext.datePreset}::${dateContext.beginDate}::${dateContext.endDate}::${adapterVersion}::${schemaVersion}::${hash}::${linkage}`;
}

let lastViolationsCacheCleanupDay = "";

async function cleanupViolationsLatestCache(adapterVersion: string, schemaVersion: string, hash: string, linkage: string, retentionDays = 35) {
  const cleanupDay = formatLocalIsoDate(new Date());
  if (lastViolationsCacheCleanupDay === cleanupDay) return;
  lastViolationsCacheCleanupDay = cleanupDay;
  const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  const records = await repositoryGetAll<ViolationsLatestRecord>("violations_latest");
  const stale = records.filter((record) => (
    record.adapterVersion !== adapterVersion ||
    record.fieldSchemaVersion !== schemaVersion ||
    record.requestPlanHash !== hash ||
    record.productLinkageVersion !== linkage ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    Date.parse(record.updatedAt) < cutoff
  ));
  await Promise.all(stale.map((record) => repositoryDelete("violations_latest", record.id).catch(() => undefined)));
}

function targetStores(stores: DoudianStoreSummary[], shopIds: string[] = []) {
  const requested = new Set(shopIds.map((item) => text(item)).filter(Boolean));
  return requested.size ? stores.filter((store) => requested.has(store.shopId)) : stores;
}

async function collectForStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, planKeys: string[], dateContext: DateContext, args: ViolationsDataArgs, index: number, total: number) {
  if (!store.partition) throw new Error("store partition missing");
  throwIfCancelled(args);
  const responses: Record<string, RequestPlanResult> = {};
  const pageSummary: Record<string, unknown> = {};
  const pageSize = Math.max(1, Math.min(200, Math.floor(Number(args.pageSize || 50))));
  const pageStart = Math.max(0, Math.floor(Number(args.page || 0)));
  const maxPages = Math.max(1, Math.min(200, Math.floor(Number(args.maxPages || policyNumber(payload.adapter, "violationsData.maxPages", 50)))));
  const pageConcurrency = Math.max(1, Math.min(8, Math.floor(policyNumber(payload.adapter, "violationsData.pageConcurrency", 4))));
  const requestContext: Record<string, unknown> = {
    ...dateContext,
    processStatus: args.processStatus || "",
    partition: store.partition,
    shopPartition: store.partition,
    shopId: store.shopId,
    shopName: store.shopName,
    sourcePlan: planKeys[0] || "",
    page: String(pageStart),
    pageSize: String(pageSize),
    page_size: String(pageSize)
  };

  for (const planKey of planKeys) {
    throwIfCancelled(args);
    let remoteTotal: number | undefined;
    let stoppedOnShortPage = false;
    let requestFailed = false;
    const pageResponses: RequestPlanResult[] = [];
    const pageRecords: Array<Record<string, unknown>> = [];

    const fetchPage = async (page: number) => {
      throwIfCancelled(args);
      const response = await runDoudianRequestPlan(payload, {
        partition: store.partition,
        planKey,
        context: { ...requestContext, page, page_size: pageSize, pageSize },
        trackWindow: args.trackWindow
      });
      const pagePayload = payloadFromResponses({ [planKey]: response });
       const pageListCount = firstArray(pagePayload, listPaths(payload.adapter, planKey)).length;
       const pageTotal = readTotal(pagePayload, payload.adapter, planKey);
      return {
        page,
        response,
        pageListCount,
        pageTotal,
        ok: requestPlanResponseOk(response, payload.adapter, planKey, violationsDataMappings(payload.adapter))
      };
    };

    const appendPage = (result: Awaited<ReturnType<typeof fetchPage>>) => {
      const key = pageResponses.length === 0 ? planKey : `${planKey}:page:${result.page}`;
      responses[key] = result.response;
      pageResponses.push(result.response);
      if (result.pageTotal !== undefined) remoteTotal = remoteTotal === undefined ? result.pageTotal : Math.max(remoteTotal, result.pageTotal);
      if (!result.ok) requestFailed = true;
      if (result.pageListCount < pageSize) stoppedOnShortPage = true;
      pageRecords.push({
        page: result.page,
        status: result.response.status || 0,
        ok: result.ok,
        code: responseCode(result.response) ?? null,
        listCount: result.pageListCount,
        total: result.pageTotal,
        message: responseMessage(result.response)
      });
    };

    const firstPage = await fetchPage(pageStart);
    appendPage(firstPage);
    if (firstPage.ok && !stoppedOnShortPage && maxPages > 1) {
      if (remoteTotal !== undefined) {
        const finalPageExclusive = Math.ceil(remoteTotal / pageSize);
        const requestedFinalPageExclusive = Math.min(finalPageExclusive, pageStart + maxPages);
        const remainingPages = Array.from({ length: Math.max(0, requestedFinalPageExclusive - pageStart - 1) }, (_, offset) => pageStart + offset + 1);
        const settledPages = await mapWithConcurrency(remainingPages, pageConcurrency, (page) => fetchPage(page));
        const fulfilledPages = settledPages
          .map((result, index) => result.status === "fulfilled" ? result.value : {
            page: remainingPages[index],
            response: { ok: false, status: 0, data: null, error: result.reason instanceof Error ? result.reason.message : String(result.reason), source: planKey } satisfies RequestPlanResult,
            pageListCount: 0,
            pageTotal: remoteTotal,
            ok: false
          })
          .sort((left, right) => left.page - right.page);
        fulfilledPages.forEach(appendPage);
      } else {
        for (let page = pageStart + 1; page < pageStart + maxPages && !stoppedOnShortPage && !requestFailed; page += 1) {
          appendPage(await fetchPage(page));
        }
      }
    }
    const fetchedPages = pageResponses.length;
    const mergedRecordCount = pageResponses.flatMap((response) => firstArray({ [planKey]: response.data }, listPaths(payload.adapter, planKey))).length;
    const { truncated, complete, coverageStatus } = paginationCoverage({ remoteTotal, mergedRecordCount, stoppedOnShortPage, requestFailed, fetchedPages, maxPages });
    if (pageResponses.length) {
      responses[planKey] = mergePagePayloads(planKey, pageResponses, payload.adapter);
      for (const key of Object.keys(responses)) {
        if (key.startsWith(`${planKey}:page:`)) delete responses[key];
      }
    }
    pageSummary[planKey] = {
      fetchedPages,
      pageSize,
      remoteTotal,
      mergedRecordCount,
      complete,
      truncated,
      coverageStatus,
      pages: pageRecords
    };
  }

  const normalizedResponses = Object.fromEntries(Object.entries(responses).map(([key, value]) => [key.split(":page:")[0], value]));
  const rawRecords = extractRecords(store, normalizedResponses, requestContext, payload.adapter);
  let records = rawRecords.filter((record) => recordInDateRange(record, dateContext));
  const dateUnknownCount = rawRecords.filter((record) => !record.violationAt && !record.createdAt).length;
  const dateCoverageIncomplete = dateContext.datePreset !== "all" && dateUnknownCount > 0;
  const associationResult = await associateProducts(payload, store, records, requestContext, args);
  records = associationResult.records;
  const planCoverages = Object.values(pageSummary).map((value) => objectRecord(value));
  const truncated = planCoverages.some((item) => item.truncated === true);
  const complete = planCoverages.length > 0 && planCoverages.every((item) => item.complete === true);
  const failedCoverage = planCoverages.some((item) => item.coverageStatus === "failed");
  const partialCoverage = planCoverages.some((item) => item.coverageStatus === "partial");
  const remoteTotals = planCoverages.map((item) => coerceNumber(item.remoteTotal)).filter((value): value is number => value !== undefined);
  const coverage: StoreCoverage = {
    coverageStatus: truncated ? "truncated" : failedCoverage ? (rawRecords.length ? "partial" : "failed") : partialCoverage || dateCoverageIncomplete ? "partial" : complete ? "complete" : "partial",
    complete: complete && !dateCoverageIncomplete,
    truncated,
    fetchedAt: nowIso(),
    ...(remoteTotals.length ? { remoteTotal: remoteTotals.reduce((sum, value) => sum + value, 0) } : {}),
    fetchedRecords: rawRecords.length
  };
  const row = buildRow(store, records, dateContext, coverage);
  const responseSummary = summarizeResponses(normalizedResponses, payload.adapter);
  const sourceFailures = [...summarizeFailures(responseSummary, payload.adapter), ...associationResult.failures];
  const blockingSourceFailures = sourceFailures.filter((failure) => !failure.optional);
  const summary = rowSummary(row, records);
  const filteredNoRecord = summary.noRecord && dateContext.datePreset !== "all" && Number(row.fetchedRecords || 0) > 0;
  const requiredPlans = policyArray(payload.adapter, "violationsData.requiredPlans");
  const successPlanKeys = Object.entries(normalizedResponses)
    .filter(([key, response]) => requestPlanResponseOk(response, payload.adapter, key, violationsDataMappings(payload.adapter)))
    .map(([key]) => key);
  const missingRequiredPlans = requiredPlans.filter((planKey) => !requestPlanResponseOk(normalizedResponses[planKey], payload.adapter, planKey, violationsDataMappings(payload.adapter)));
  const ok = requiredPlans.length ? missingRequiredPlans.length === 0 : successPlanKeys.length > 0;
  const partial = ok && (blockingSourceFailures.length > 0 || coverage.coverageStatus !== "complete");
  const message = !ok
    ? (firstErrorMessage(normalizedResponses, payload.adapter) || policyMessage(payload.adapter, "violationsData.messages.failed", "Violations data request failed"))
    : blockingSourceFailures.length || coverage.coverageStatus !== "complete"
      ? policyMessage(payload.adapter, "violationsData.messages.partialSourceStore", "Violations data synced with partial source errors")
      : summary.noRecord
        ? filteredNoRecord
          ? policyMessage(payload.adapter, "violationsData.messages.noRecordStoreFiltered", "Violations data synced with no records in the selected date range")
          : policyMessage(payload.adapter, "violationsData.messages.noRecordStore", "Violations data synced with no records")
        : policyMessage(payload.adapter, "violationsData.messages.synced", "Violations data synced");
  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (partial ? "partial" : "ok") : "failed",
    ok,
    message,
    reason: ok ? (partial ? "violations-data-partial-source-failure" : filteredNoRecord ? "violations-data-no-record-in-range" : summary.noRecord ? "violations-data-no-record" : "") : "violations-data-request-failed",
    category: ok ? (partial ? "api-partial" : "") : "api",
    diagnostic: {
      responses: responseSummary,
      okCount: successPlanKeys.length,
      successPlanKeys,
      requiredPlans,
      missingRequiredPlans,
      sourceFailureCount: sourceFailures.length,
      blockingSourceFailureCount: blockingSourceFailures.length,
      sourceFailures,
      productAssociationEnabled: associationEnabled(payload.adapter),
      productAssociationResponses: associationResult.responses,
      pageSummary,
      coverage,
      ticketTypeCounts: records.reduce((counts, record) => {
        const key = record.ticketType === "risk" ? "risk" : "penalty";
        counts[key] += 1;
        return counts;
      }, { risk: 0, penalty: 0 }),
      dateUnknownCount,
      dateMatchedCount: records.length,
      rowSummary: summary,
      datePreset: dateContext.datePreset,
      beginDate: dateContext.beginDate,
      endDate: dateContext.endDate
    },
    index,
    total
  };
  await reportViolationsDataRow({ store, row, detail, summary, responseSummary, pageSummary, operationId: args.operationId });
  dispatchDoudianProgress({
    operationId: args.operationId || "",
    taskType: "violationsData",
    status: "running",
    progress: Math.round((index / Math.max(1, total)) * 95),
    message: `${store.shopName || store.shopId} ${index}/${total}`
  });
  return { row, records, detail };
}

function adapterPayload(args: ViolationsDataArgs): DoudianAdapterPayload {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  return args.doudianAdapter;
}

async function saveLatest(args: {
  rows: DoudianViolationsDataRow[];
  records: DoudianViolationRecord[];
  details: DoudianRunDetail[];
  dateContext: DateContext;
  adapterVersion: string;
  ruleVersion: string;
  fieldSchemaVersion: string;
  requestPlanHash: string;
  productLinkageVersion: string;
  cacheRetentionDays: number;
}) {
  const detailById = new Map(args.details.map((detail) => [text(detail.shopId), detail]));
  const recordsByShop = new Map<string, DoudianViolationRecord[]>();
  for (const record of args.records) {
    const list = recordsByShop.get(record.shopId) || [];
    list.push(record);
    recordsByShop.set(record.shopId, list);
  }
  const updatedAt = nowIso();
  const latestRecords = args.rows.map((row) => {
    const detail = detailById.get(row.shopId);
    return {
      id: latestId(row.shopId, args.dateContext, args.adapterVersion, args.fieldSchemaVersion, args.requestPlanHash, args.productLinkageVersion),
      shopId: row.shopId,
      shopName: row.shopName,
      ok: detail?.ok !== false,
      message: detail?.message || "",
      row,
      records: recordsByShop.get(row.shopId) || [],
      diagnostic: detail?.diagnostic,
      datePreset: args.dateContext.datePreset,
      beginDate: args.dateContext.beginDate,
      endDate: args.dateContext.endDate,
      adapterVersion: args.adapterVersion,
      ruleVersion: args.ruleVersion,
      scriptsVersion: args.ruleVersion,
      fieldSchemaVersion: args.fieldSchemaVersion,
      requestPlanHash: args.requestPlanHash,
      productLinkageVersion: args.productLinkageVersion,
      updatedAt
    } satisfies ViolationsLatestRecord;
  });
  await repositoryPutMany<ViolationsLatestRecord>("violations_latest", latestRecords);
  void cleanupViolationsLatestCache(args.adapterVersion, args.fieldSchemaVersion, args.requestPlanHash, args.productLinkageVersion, args.cacheRetentionDays).catch(() => undefined);
}

async function deriveFilteredResultFromAllCache(input: {
  payload: DoudianAdapterPayload;
  args: ViolationsDataArgs;
  ledger: Awaited<ReturnType<typeof listStoreLedger>>;
  targets: DoudianStoreSummary[];
  dateContext: DateContext;
  adapterVersion: string;
  scriptsVersion: string;
  schemaVersion: string;
  linkageVersion: string;
  requestPlanHash: string;
  runId: string;
}): Promise<DoudianViolationsDataResult | null> {
  if (input.dateContext.datePreset === "all" || !input.targets.length) return null;
  const reuseMinutes = policyNumber(input.payload.adapter, "violationsData.allCacheReuseMinutes", 0);
  if (reuseMinutes <= 0) return null;

  const allDateContext = violationsDateContext({ datePreset: "all" }, input.payload.adapter);
  const ids = input.targets.map((store) => latestId(
    store.shopId,
    allDateContext,
    input.adapterVersion,
    input.schemaVersion,
    input.requestPlanHash,
    input.linkageVersion
  ));
  const snapshots = await repositoryGetMany<ViolationsLatestRecord>("violations_latest", ids);
  const snapshotByShop = new Map(snapshots.map((record) => [record.shopId, record]));
  const cutoff = Date.now() - reuseMinutes * 60 * 1000;
  const usable = input.targets.every((store) => {
    const record = snapshotByShop.get(store.shopId);
    const updatedAt = Date.parse(record?.updatedAt || "");
    return !!record &&
      record.ok === true &&
      record.row.complete === true &&
      record.row.truncated !== true &&
      record.ruleVersion === input.scriptsVersion &&
      Number.isFinite(updatedAt) &&
      updatedAt >= cutoff;
  });
  if (!usable) return null;

  const rows: DoudianViolationsDataRow[] = [];
  const records: DoudianViolationRecord[] = [];
  const details: DoudianRunDetail[] = [];
  for (const [index, store] of input.targets.entries()) {
    const snapshot = snapshotByShop.get(store.shopId)!;
    const sourceRecords = snapshot.records || [];
    const filteredRecords = sourceRecords.filter((record) => recordInDateRange(record, input.dateContext));
    const dateUnknownCount = sourceRecords.filter((record) => !record.violationAt && !record.createdAt).length;
    const coverage: StoreCoverage = {
      coverageStatus: dateUnknownCount ? "partial" : "complete",
      complete: dateUnknownCount === 0,
      truncated: false,
      fetchedAt: String(snapshot.row.fetchedAt || snapshot.updatedAt || nowIso()),
      remoteTotal: coerceNumber(snapshot.row.remoteTotal) ?? sourceRecords.length,
      fetchedRecords: sourceRecords.length
    };
    const row = buildRow(store, filteredRecords, input.dateContext, coverage);
    const summary = rowSummary(row, filteredRecords);
    const filteredNoRecord = summary.noRecord && sourceRecords.length > 0;
    const partial = coverage.complete !== true;
    const message = partial
      ? policyMessage(input.payload.adapter, "violationsData.messages.partialSourceStore", "Violations data synced with partial source errors")
      : filteredNoRecord
        ? policyMessage(input.payload.adapter, "violationsData.messages.noRecordStoreFiltered", "Violations data synced with no records in the selected date range")
        : summary.noRecord
          ? policyMessage(input.payload.adapter, "violationsData.messages.noRecordStore", "Violations data synced with no records")
          : policyMessage(input.payload.adapter, "violationsData.messages.synced", "Violations data synced");
    rows.push(row);
    records.push(...filteredRecords);
    details.push({
      shopId: store.shopId,
      shopName: store.shopName,
      status: partial ? "partial" : "ok",
      ok: true,
      message,
      reason: partial ? "violations-data-partial-source-failure" : filteredNoRecord ? "violations-data-no-record-in-range" : summary.noRecord ? "violations-data-no-record" : "",
      category: partial ? "cache-partial" : "",
      diagnostic: {
        cacheDerived: true,
        sourceDatePreset: "all",
        sourceUpdatedAt: snapshot.updatedAt,
        dateUnknownCount,
        dateMatchedCount: filteredRecords.length,
        rowSummary: summary,
        datePreset: input.dateContext.datePreset,
        beginDate: input.dateContext.beginDate,
        endDate: input.dateContext.endDate
      },
      index: index + 1,
      total: input.targets.length
    });
  }

  const partialSourceCount = details.filter((detail) => detail.status === "partial").length;
  const noRecordCount = rows.filter((row) => Number(row.totalRecords || 0) === 0).length;
  const successCount = details.length;
  const message = partialSourceCount
    ? policyMessage(input.payload.adapter, "violationsData.messages.partialSources", "Violations data synced; {partialSourceCount} stores have source issues", { successCount, partialSourceCount })
    : policyMessage(input.payload.adapter, "violationsData.messages.done", "Violations data synced for {successCount} stores", { successCount });
  await saveLatest({
    rows,
    records,
    details,
    dateContext: input.dateContext,
    adapterVersion: input.adapterVersion,
    ruleVersion: input.scriptsVersion,
    fieldSchemaVersion: input.schemaVersion,
    requestPlanHash: input.requestPlanHash,
    productLinkageVersion: input.linkageVersion,
    cacheRetentionDays: policyNumber(input.payload.adapter, "violationsData.cacheRetentionDays", 35)
  });

  return {
    ok: partialSourceCount === 0,
    status: partialSourceCount ? "partial" : "ok",
    message,
    runId: input.runId,
    operationId: input.args.operationId,
    rows,
    records,
    details,
    successCount,
    failureCount: 0,
    partialSourceCount,
    noRecordCount,
    coverageStatus: partialSourceCount ? "partial" : "complete",
    complete: partialSourceCount === 0,
    truncated: false,
    fetchedAt: rows.map((row) => String(row.fetchedAt || "")).filter(Boolean).sort().at(-1) || nowIso(),
    remoteTotal: rows.reduce((sum, row) => sum + Number(row.sourceTotal || 0), 0),
    dateRange: publicDateRange(input.dateContext),
    adapterVersion: input.adapterVersion,
    scriptsVersion: input.scriptsVersion,
    fieldSchemaVersion: input.schemaVersion,
    requestPlanHash: input.requestPlanHash,
    productLinkageVersion: input.linkageVersion,
    stores: input.ledger.stores || [],
    groups: input.ledger.groups || [],
    cached: true,
    cacheDerived: true,
    sourceDatePreset: "all"
  };
}

export async function fetchViolationsData(args: ViolationsDataArgs = {}): Promise<DoudianViolationsDataResult> {
  const payload = adapterPayload(args);
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds || []);
  const dateContext = violationsDateContext(args, payload.adapter);
  const planKeys = requestPlanKeys(payload.adapter);
  const adapterVersion = payload.adapter.version || "";
  const scriptsVersion = payload.scripts?.version || "";
  const schemaVersion = fieldSchemaVersion(payload.adapter);
  const linkageVersion = productLinkageVersion(payload.adapter);
  const hash = requestPlanHash(payload.adapter, planKeys);
  const runId = `violations-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (args.mockRecords?.length) {
    const records = args.mockRecords.filter((record) => recordInDateRange(record, dateContext));
    const rows = targets.map((store) => buildRow(store, records.filter((record) => record.shopId === store.shopId), dateContext));
    const details = rows.map((row, index) => ({
      shopId: row.shopId,
      shopName: row.shopName,
      status: "ok",
      ok: true,
      message: "Mock violations data synced",
      diagnostic: { rowSummary: rowSummary(row, records.filter((record) => record.shopId === row.shopId)) },
      index: index + 1,
      total: rows.length
    }));
    await saveLatest({ rows, records, details, dateContext, adapterVersion, ruleVersion: scriptsVersion, fieldSchemaVersion: schemaVersion, requestPlanHash: hash, productLinkageVersion: linkageVersion, cacheRetentionDays: policyNumber(payload.adapter, "violationsData.cacheRetentionDays", 35) });
    return {
      ok: true,
      status: "ok",
      message: `Violations data synced for ${rows.length} stores`,
      runId,
      operationId: args.operationId,
      rows,
      records,
      details,
      successCount: rows.length,
      failureCount: 0,
      partialSourceCount: 0,
      noRecordCount: rows.filter((row) => Number(row.totalRecords || 0) === 0).length,
      coverageStatus: "complete",
      complete: true,
      truncated: false,
      fetchedAt: nowIso(),
      remoteTotal: records.length,
      dateRange: publicDateRange(dateContext),
      adapterVersion,
      scriptsVersion,
      fieldSchemaVersion: schemaVersion,
      requestPlanHash: hash,
      productLinkageVersion: linkageVersion,
      stores,
      groups: ledger.groups || []
    };
  }

  const derivedFromAllCache = await deriveFilteredResultFromAllCache({
    payload,
    args,
    ledger,
    targets,
    dateContext,
    adapterVersion,
    scriptsVersion,
    schemaVersion,
    linkageVersion,
    requestPlanHash: hash,
    runId
  });
  if (derivedFromAllCache) return derivedFromAllCache;

  if (!planKeys.length) {
    return {
      ok: false,
      status: "missing-request-plans",
      message: "remote fetchViolationsData operation missing request plans",
      rows: targets.map(emptyRow),
      records: [],
      details: [],
      dateRange: publicDateRange(dateContext),
      adapterVersion,
      scriptsVersion,
      fieldSchemaVersion: schemaVersion,
      requestPlanHash: hash,
      productLinkageVersion: linkageVersion,
      stores,
      groups: ledger.groups || []
    };
  }

  const defaultConcurrency = Math.max(1, Math.min(8, Math.floor(policyNumber(payload.adapter, "violationsData.concurrency", 2))));
  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(args.concurrency || defaultConcurrency))));
  const settled = await mapWithConcurrency(targets, concurrency, async (store, index) => {
    throwIfCancelled(args);
    return collectForStore(payload, store, planKeys, dateContext, args, index + 1, targets.length);
  });
  const rows: DoudianViolationsDataRow[] = [];
  const records: DoudianViolationRecord[] = [];
  const details: DoudianRunDetail[] = [];
  settled.forEach((result, index) => {
    const store = targets[index];
    if (result.status === "fulfilled") {
      rows.push(result.value.row);
      records.push(...result.value.records);
      details.push(result.value.detail);
      return;
    }
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason || "Violations data request failed");
    const failedRow = emptyRow(store);
    failedRow.coverageStatus = "failed";
    failedRow.fetchedAt = nowIso();
    rows.push(failedRow);
    details.push({ shopId: store.shopId, shopName: store.shopName, status: "failed", ok: false, message, reason: "violations-data-request-failed", category: "api", diagnostic: { error: message }, index: index + 1, total: targets.length });
  });

  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.filter((detail) => !detail.ok).length;
  const partialSourceCount = details.filter((detail) => detail.status === "partial" || Number(objectRecord(detail.diagnostic).blockingSourceFailureCount ?? objectRecord(detail.diagnostic).sourceFailureCount ?? 0) > 0).length;
  const noRecordCount = details.filter((detail) => objectRecord(objectRecord(detail.diagnostic).rowSummary).noRecord === true).length;
  const message = failureCount
    ? policyMessage(payload.adapter, "violationsData.messages.partial", "Violations data synced with {failureCount} failures", { successCount, failureCount })
    : partialSourceCount
      ? policyMessage(payload.adapter, "violationsData.messages.partialSources", "Violations data synced; {partialSourceCount} stores have source issues", { successCount, partialSourceCount })
      : policyMessage(payload.adapter, "violationsData.messages.done", "Violations data synced for {successCount} stores", { successCount });
  const aggregateRemoteTotals = rows.map((row) => coerceNumber(row.remoteTotal)).filter((value): value is number => value !== undefined);

  await saveLatest({ rows, records, details, dateContext, adapterVersion, ruleVersion: scriptsVersion, fieldSchemaVersion: schemaVersion, requestPlanHash: hash, productLinkageVersion: linkageVersion, cacheRetentionDays: policyNumber(payload.adapter, "violationsData.cacheRetentionDays", 35) });

  return {
    ok: failureCount === 0 && partialSourceCount === 0,
    status: failureCount || partialSourceCount ? "partial" : "ok",
    message,
    runId,
    operationId: args.operationId,
    rows,
    records,
    details,
    successCount,
    failureCount,
    partialSourceCount,
    noRecordCount,
    coverageStatus: failureCount ? (successCount ? "partial" : "failed") : rows.some((row) => row.truncated === true) ? "truncated" : partialSourceCount ? "partial" : "complete",
    complete: failureCount === 0 && partialSourceCount === 0 && rows.every((row) => row.complete === true),
    truncated: rows.some((row) => row.truncated === true),
    fetchedAt: rows.map((row) => String(row.fetchedAt || "")).filter(Boolean).sort().at(-1) || nowIso(),
    ...(aggregateRemoteTotals.length ? { remoteTotal: aggregateRemoteTotals.reduce((sum, value) => sum + value, 0) } : {}),
    dateRange: publicDateRange(dateContext),
    adapterVersion,
    scriptsVersion,
    fieldSchemaVersion: schemaVersion,
    requestPlanHash: hash,
    productLinkageVersion: linkageVersion,
    stores,
    groups: ledger.groups || []
  };
}

export async function fetchViolationsDataLatest(args: ViolationsDataArgs = {}): Promise<DoudianViolationsDataResult> {
  const payload = adapterPayload(args);
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds || []);
  const targetIds = new Set(targets.map((store) => store.shopId));
  const dateContext = violationsDateContext(args, payload.adapter);
  const planKeys = requestPlanKeys(payload.adapter);
  const schemaVersion = fieldSchemaVersion(payload.adapter);
  const hash = requestPlanHash(payload.adapter, planKeys);
  const linkageVersion = productLinkageVersion(payload.adapter);
  const ids = targets.map((store) => latestId(store.shopId, dateContext, payload.adapter.version || "", schemaVersion, hash, linkageVersion));
  const rows = (await repositoryGetMany<ViolationsLatestRecord>("violations_latest", ids))
    .filter((record) => !targetIds.size || targetIds.has(record.shopId));
  void cleanupViolationsLatestCache(payload.adapter.version || "", schemaVersion, hash, linkageVersion, policyNumber(payload.adapter, "violationsData.cacheRetentionDays", 35)).catch(() => undefined);
  const details: DoudianRunDetail[] = rows.map((record, index) => ({
    shopId: record.shopId,
    shopName: record.shopName,
    status: record.ok ? (record.row.complete === true ? "ok" : "partial") : "failed",
    ok: record.ok,
    message: record.message || (record.ok ? "Cached violations data ready" : "Cached violations data failed"),
    reason: record.ok ? "" : "violations-data-cached-failure",
    category: record.ok ? "" : "api",
    diagnostic: record.diagnostic,
    index: index + 1,
    total: rows.length
  }));
  const aggregateRemoteTotals = rows.map((record) => coerceNumber(record.row.remoteTotal)).filter((value): value is number => value !== undefined);
  return {
    ok: true,
    status: rows.length ? "ready" : "empty",
    message: rows.length ? `Read ${rows.length} cached violations data rows` : "No cached violations data",
    rows: rows.map((record) => record.row),
    records: rows.flatMap((record) => record.records || []),
    details,
    coverageStatus: rows.some((record) => record.row.truncated === true) ? "truncated" : rows.some((record) => record.row.complete !== true) ? "partial" : "complete",
    complete: rows.length > 0 && rows.every((record) => record.row.complete === true),
    truncated: rows.some((record) => record.row.truncated === true),
    fetchedAt: rows.map((record) => String(record.row.fetchedAt || record.updatedAt || "")).filter(Boolean).sort().at(-1) || "",
    ...(aggregateRemoteTotals.length ? { remoteTotal: aggregateRemoteTotals.reduce((sum, value) => sum + value, 0) } : {}),
    dateRange: publicDateRange(dateContext),
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    fieldSchemaVersion: schemaVersion,
    requestPlanHash: hash,
    productLinkageVersion: linkageVersion,
    stores,
    groups: ledger.groups || [],
    cached: true,
    cachedRows: rows
  };
}

export async function runDoudianViolationsDataSelfCheck(options: { doudianAdapter?: DoudianAdapterPayload } = {}) {
  const payload = adapterPayload({ doudianAdapter: options.doudianAdapter });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopId = `violations-self-check-${suffix}`;
  const shopName = `Violations Self Check ${suffix}`;
  const checkedContexts: DateContext[] = [];
  const planKeys = requestPlanKeys(payload.adapter);
  const schemaVersion = fieldSchemaVersion(payload.adapter);
  const hash = requestPlanHash(payload.adapter, planKeys);
  const linkageVersion = productLinkageVersion(payload.adapter);

  try {
    await upsertStoreLedger({ shopId, shopName, platform: "doudian", partition: `persist:chihu-violations-self-check-${suffix}`, status: "online", groupName: "Self Check", adapterVersion: payload.adapter.version });
    const cases = [
      { datePreset: "today", dueOffset: 0 },
      { datePreset: "7d", dueOffset: 2 },
      { datePreset: "all", dueOffset: 10 }
    ];
    const results = [];
    for (const item of cases) {
      const dateContext = violationsDateContext(item, payload.adapter);
      checkedContexts.push(dateContext);
      const dueAt = formatDateTime(addDateDays(new Date(), item.dueOffset));
      const violationAt = formatDateTime(new Date());
      const records = [{
        id: `${shopId}-${item.datePreset}`,
        shopId,
        shopName,
        group: "Self Check",
        objectType: "商品",
        objectId: `product-${suffix}`,
        objectName: `Self Check Product ${item.datePreset}`,
        productId: `product-${suffix}`,
        reason: "self check",
        severity: "high",
        processStatus: item.datePreset === "today" ? "pending" : "rectifying",
        productStatus: "在售",
        associationStatus: "online",
        action: "review",
        dueAt,
        violationAt,
        createdAt: violationAt,
        penaltyAmount: 12,
        failureReason: "",
        source: "self-check"
      }];
      const fetched = await fetchViolationsData({ doudianAdapter: payload, shopIds: [shopId], datePreset: item.datePreset, mockRecords: records });
      const latest = await fetchViolationsDataLatest({ doudianAdapter: payload, shopIds: [shopId], datePreset: item.datePreset });
      results.push({
        preset: item.datePreset,
        fetchOk: fetched.ok === true && fetched.records?.length === 1 && fetched.rows?.[0]?.totalRecords === 1,
        latestOk: latest.ok === true && latest.records?.length === 1 && latest.rows?.[0]?.shopId === shopId,
        metadataOk: latest.adapterVersion === payload.adapter.version && latest.scriptsVersion === (payload.scripts?.version || "") && latest.fieldSchemaVersion === schemaVersion && latest.requestPlanHash === hash && latest.productLinkageVersion === linkageVersion,
        dateRangeOk: latest.dateRange?.beginDate === dateContext.beginDate && latest.dateRange?.endDate === dateContext.endDate
      });
    }
    const fixtureStatuses = violationsResponseFixture.tickets.map((ticket) => resolveProcessStatus(ticket, payload.adapter));
    const expectedStatuses = violationsResponseFixture.expectedStatuses;
    const statusNormalizationOk = fixtureStatuses.every((status, index) => status === expectedStatuses[index]);
    const fixtureRecords = extractRecords({ shopId, shopName, platform: "doudian", partition: "", status: "online" }, {
      violationPenaltyTicketList: {
        ok: true,
        status: 200,
        data: { code: 0, data: { tickets: violationsResponseFixture.tickets, total: violationsResponseFixture.tickets.length } },
        source: "violationPenaltyTicketList"
      }
    }, { sourcePlan: "violationPenaltyTicketList" }, payload.adapter);
    const expectedObjectTypes = ["商品", "商品", "店铺", "商品", "商品"];
    const objectTypeNormalizationOk = fixtureRecords.every((record, index) => record.objectType === expectedObjectTypes[index]) &&
      fixtureRecords[2]?.objectId === "fixture-shop-id" &&
      fixtureRecords[2]?.productId === "";
    const cacheDerived = await fetchViolationsData({ doudianAdapter: payload, shopIds: [shopId], datePreset: "7d" });
    const cacheDerivationOk = cacheDerived.cacheDerived === true && cacheDerived.sourceDatePreset === "all" && cacheDerived.records?.length === 1;
    const completedDueAt = formatDateTime(addDateDays(new Date(), -1));
    const completedRiskRow = buildRow({ shopId, shopName, platform: "doudian", partition: "", status: "online" }, [{
      id: "completed-risk-check",
      shopId,
      shopName,
      objectType: "店铺",
      objectId: shopId,
      objectName: "completed",
      productId: "",
      reason: "completed",
      severity: "low",
      processStatus: "done",
      productStatus: "无需关联",
      action: "none",
      dueAt: completedDueAt,
      violationAt: formatDateTime(new Date()),
      penaltyAmount: 0,
      failureReason: "",
      source: "self-check"
    }], violationsDateContext({ datePreset: "all" }, payload.adapter));
    const noTotalContinues = paginationCoverage({ mergedRecordCount: 50, stoppedOnShortPage: false, requestFailed: false, fetchedPages: 1, maxPages: 50 });
    const noTotalCompletes = paginationCoverage({ mergedRecordCount: 75, stoppedOnShortPage: true, requestFailed: false, fetchedPages: 2, maxPages: 50 });
    const maxPageTruncates = paginationCoverage({ mergedRecordCount: 2500, stoppedOnShortPage: false, requestFailed: false, fetchedPages: 50, maxPages: 50 });
    return {
      ok: results.every((item) => item.fetchOk && item.latestOk && item.metadataOk && item.dateRangeOk) && statusNormalizationOk && objectTypeNormalizationOk && cacheDerivationOk && completedRiskRow.overdueCount === 0 && !noTotalContinues.complete && noTotalCompletes.complete && maxPageTruncates.truncated,
      latestOk: results.every((item) => item.latestOk),
      datePresetOk: results.every((item) => item.dateRangeOk),
      metadataOk: results.every((item) => item.metadataOk),
      statusNormalizationOk,
      objectTypeNormalizationOk,
      cacheDerivationOk,
      completedRiskOk: completedRiskRow.overdueCount === 0,
      noTotalPaginationOk: !noTotalContinues.complete && !noTotalContinues.truncated && noTotalCompletes.complete,
      maxPageTruncationOk: maxPageTruncates.truncated,
      fixtureStatuses,
      fixtureObjectTypes: fixtureRecords.map((record) => record.objectType),
      cases: results
    };
  } finally {
    await deleteStoreLedger([shopId]).catch(() => undefined);
    await Promise.all(checkedContexts.map((context) => repositoryDelete("violations_latest", latestId(shopId, context, payload.adapter.version || "", schemaVersion, hash, linkageVersion)).catch(() => undefined)));
  }
}
