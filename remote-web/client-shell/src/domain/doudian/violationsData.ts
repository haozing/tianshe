import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianRunDetail,
  DoudianStoreSummary,
  DoudianViolationRecord,
  DoudianViolationsDataResult,
  DoudianViolationsDataRow
} from "../../types";
import { repositoryDelete, repositoryGetAll, repositoryPut } from "./repository";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";

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
  if (/(失败|异常|error|fail)/i.test(next)) return "failed";
  if (/(申诉|appeal)/i.test(next)) return "appealing";
  if (/(整改|修复|rectif|repair)/i.test(next)) return "rectifying";
  if (/(完成|已处理|已处置|关闭|通过|done|success|finish|closed)/i.test(next)) return "done";
  return "pending";
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

function normalizeObjectType(value: unknown, productId = "") {
  const next = text(value).toLowerCase();
  if (productId || /(商品|goods|product|item|sku)/i.test(next)) return "商品";
  if (/(订单|order)/i.test(next)) return "订单";
  if (/(内容|素材|content|material)/i.test(next)) return "内容";
  return "店铺";
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

function listPaths(adapter: DoudianAdapterConfig) {
  const paths = violationsDataMappings(adapter).listPaths;
  return Array.isArray(paths) ? paths.map((item) => text(item)).filter(Boolean) : [];
}

function totalPaths(adapter: DoudianAdapterConfig) {
  const paths = violationsDataMappings(adapter).totalPaths;
  return Array.isArray(paths) ? paths.map((item) => text(item)).filter(Boolean) : [];
}

function readTotal(payload: unknown, adapter: DoudianAdapterConfig) {
  const total = coerceNumber(firstPathValue(payload, totalPaths(adapter)));
  return total !== undefined ? total : 0;
}

function extractRecords(store: DoudianStoreSummary, responses: Record<string, RequestPlanResult>, requestContext: Record<string, unknown>, adapter: DoudianAdapterConfig): DoudianViolationRecord[] {
  const payload = payloadFromResponses(responses);
  const items = firstArray(payload, listPaths(adapter));
  return items.map((item, index) => {
    const productId = text(readViolationField(item, adapter, "productId"));
    const reason = text(readViolationField(item, adapter, "reason"));
    const dueAt = normalizeDateTime(readViolationField(item, adapter, "dueAt"));
    const id = text(readViolationField(item, adapter, "id")) || `${store.shopId || "shop"}-violation-${index + 1}`;
    const productStatus = normalizeProductStatus(readViolationField(item, adapter, "productStatus"), productId);
    return {
      id,
      shopId: store.shopId,
      shopName: store.shopName,
      group: store.groupName || "",
      objectType: normalizeObjectType(readViolationField(item, adapter, "objectType"), productId),
      objectName: text(readViolationField(item, adapter, "objectName")) || reason || id,
      productId,
      reason: reason || "违规原因待确认",
      severity: normalizeSeverity(readViolationField(item, adapter, "severity")),
      processStatus: normalizeProcessStatus(readViolationField(item, adapter, "processStatus")),
      productStatus,
      associationStatus: associationStatus(productStatus, productId),
      action: text(readViolationField(item, adapter, "action")) || "待人工确认",
      dueAt,
      penaltyAmount: amount(readViolationField(item, adapter, "penaltyAmount"), fieldScale(adapter, "penaltyAmount")),
      failureReason: text(readViolationField(item, adapter, "failureReason")),
      sourcePlan: String(requestContext.sourcePlan || "violationPenaltyList"),
      source: text(readViolationField(item, adapter, "source")) || "违规处罚列表"
    };
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
    penaltyAmount: 0
  };
}

function buildRow(store: DoudianStoreSummary, records: DoudianViolationRecord[], dateContext: DateContext, remoteTotal = 0) {
  const row = emptyRow(store);
  row.totalRecords = records.length || remoteTotal;
  row.pendingCount = records.filter((record) => record.processStatus === "pending").length;
  row.appealCount = records.filter((record) => record.processStatus === "appealing").length;
  row.rectificationCount = records.filter((record) => record.processStatus === "rectifying").length;
  row.highRiskCount = records.filter((record) => record.severity === "high").length;
  row.dueSoonCount = records.filter((record) => dueSoon(String(record.dueAt || ""))).length;
  row.overdueCount = records.filter((record) => overdue(String(record.dueAt || ""))).length;
  row.productLinkedCount = records.filter((record) => ["online", "offline", "recycled"].includes(String(record.associationStatus || ""))).length;
  row.productMissingCount = records.filter((record) => record.associationStatus === "not_found").length;
  row.offlineProductCount = records.filter((record) => record.productStatus === "已下架" || record.productStatus === "回收站").length;
  row.failedCount = records.filter((record) => record.processStatus === "failed" || record.failureReason).length;
  row.penaltyAmount = records.reduce((sum, record) => sum + Number(record.penaltyAmount || 0), 0);
  row.datePreset = dateContext.datePreset;
  row.beginDate = dateContext.beginDate;
  row.endDate = dateContext.endDate;
  return row;
}

function rowSummary(row: DoudianViolationsDataRow, records: DoudianViolationRecord[]) {
  const nonZeroFields = VIOLATION_DATA_FIELDS.filter((field) => Number(row[field] || 0) !== 0);
  return {
    recordCount: records.length,
    remoteTotal: Number(row.totalRecords || 0),
    nonZeroFieldCount: nonZeroFields.length,
    nonZeroFields,
    noRecord: Number(row.totalRecords || 0) === 0 && records.length === 0,
    remoteTotalWithoutRecords: Number(row.totalRecords || 0) > 0 && records.length === 0
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
  return associationPolicy(adapter).enabled === true;
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

async function associateProducts(payload: DoudianAdapterPayload, store: DoudianStoreSummary, records: DoudianViolationRecord[], requestContext: Record<string, unknown>): Promise<{
  records: DoudianViolationRecord[];
  failures: Array<Record<string, unknown>>;
  responses: Record<string, unknown>;
}> {
  if (!associationEnabled(payload.adapter)) return { records, failures: [], responses: {} as Record<string, unknown> };
  const planKeys = associationPlans(payload.adapter);
  const productIds = Array.from(new Set(records.map((record) => text(record.productId)).filter(Boolean)));
  if (!planKeys.length || !productIds.length) return { records, failures: [], responses: {} as Record<string, unknown> };
  const failures: Array<Record<string, unknown>> = [];
  const responses: Record<string, unknown> = {};
  const byProductId = new Map<string, ReturnType<typeof extractAssociation>>();
  const concurrency = Math.max(1, Math.min(4, Math.floor(Number(associationPolicy(payload.adapter).concurrency || 2))));
  const settled = await mapWithConcurrency(productIds, concurrency, async (productId) => {
    for (const planKey of planKeys) {
      const response = await runDoudianRequestPlan(payload, {
        partition: store.partition,
        planKey,
        context: { ...requestContext, productId }
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
    if (result.status === "rejected") failures.push({ key: planKeys.join(","), phase: "product_association", productId: productIds[index] || "", optional: true, status: 0, code: null, message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
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

function targetStores(stores: DoudianStoreSummary[], shopIds: string[] = []) {
  const requested = new Set(shopIds.map((item) => text(item)).filter(Boolean));
  return requested.size ? stores.filter((store) => requested.has(store.shopId)) : stores;
}

async function collectForStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, planKeys: string[], dateContext: DateContext, args: ViolationsDataArgs, index: number, total: number) {
  if (!store.partition) throw new Error("store partition missing");
  const responses: Record<string, RequestPlanResult> = {};
  const pageSize = Math.max(1, Math.min(200, Math.floor(Number(args.pageSize || 50))));
  const pageStart = Math.max(0, Math.floor(Number(args.page || 0)));
  const maxPages = Math.max(1, Math.min(20, Math.floor(Number(args.maxPages || 1))));
  const requestContext: Record<string, unknown> = {
    ...dateContext,
    processStatus: args.processStatus || "",
    partition: store.partition,
    shopPartition: store.partition,
    shopId: store.shopId,
    shopName: store.shopName,
    sourcePlan: planKeys[0] || "violationPenaltyList",
    page: String(pageStart),
    pageSize: String(pageSize),
    page_size: String(pageSize)
  };

  for (const planKey of planKeys) {
    let page = pageStart;
    let fetchedPages = 0;
    let remoteTotal = 0;
    do {
      const key = fetchedPages === 0 ? planKey : `${planKey}:page:${page}`;
      const response = await runDoudianRequestPlan(payload, {
        partition: store.partition,
        planKey,
        context: { ...requestContext, page: String(page), page_size: String(pageSize), pageSize: String(pageSize) }
      });
      responses[key] = response;
      const pagePayload = payloadFromResponses({ [planKey]: response });
      remoteTotal = readTotal(pagePayload, payload.adapter) || remoteTotal;
      fetchedPages += 1;
      page += 1;
      if (!requestPlanResponseOk(response, payload.adapter, planKey, violationsDataMappings(payload.adapter))) break;
      if (!remoteTotal || fetchedPages >= Math.ceil(remoteTotal / pageSize)) break;
    } while (fetchedPages < maxPages);
  }

  const normalizedResponses = Object.fromEntries(Object.entries(responses).map(([key, value]) => [key.split(":page:")[0], value]));
  let records = extractRecords(store, normalizedResponses, requestContext, payload.adapter);
  const associationResult = await associateProducts(payload, store, records, requestContext);
  records = associationResult.records;
  const responsePayload = payloadFromResponses(normalizedResponses);
  const row = buildRow(store, records, dateContext, readTotal(responsePayload, payload.adapter));
  const responseSummary = summarizeResponses(normalizedResponses, payload.adapter);
  const sourceFailures = [...summarizeFailures(responseSummary, payload.adapter), ...associationResult.failures];
  const blockingSourceFailures = sourceFailures.filter((failure) => !failure.optional);
  const summary = rowSummary(row, records);
  const requiredPlans = policyArray(payload.adapter, "violationsData.requiredPlans");
  const successPlanKeys = Object.entries(normalizedResponses)
    .filter(([key, response]) => requestPlanResponseOk(response, payload.adapter, key, violationsDataMappings(payload.adapter)))
    .map(([key]) => key);
  const missingRequiredPlans = requiredPlans.filter((planKey) => !requestPlanResponseOk(normalizedResponses[planKey], payload.adapter, planKey, violationsDataMappings(payload.adapter)));
  const ok = requiredPlans.length ? missingRequiredPlans.length === 0 : successPlanKeys.length > 0;
  const partial = ok && blockingSourceFailures.length > 0;
  const message = !ok
    ? (firstErrorMessage(normalizedResponses, payload.adapter) || policyMessage(payload.adapter, "violationsData.messages.failed", "Violations data request failed"))
    : blockingSourceFailures.length
      ? policyMessage(payload.adapter, "violationsData.messages.partialSourceStore", "Violations data synced with partial source errors")
      : summary.noRecord
        ? policyMessage(payload.adapter, "violationsData.messages.noRecordStore", "Violations data synced with no records")
        : policyMessage(payload.adapter, "violationsData.messages.synced", "Violations data synced");
  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (partial ? "partial" : "ok") : "failed",
    ok,
    message,
    reason: ok ? (partial ? "violations-data-partial-source-failure" : summary.noRecord ? "violations-data-no-record" : "") : "violations-data-request-failed",
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
      rowSummary: summary,
      datePreset: dateContext.datePreset,
      beginDate: dateContext.beginDate,
      endDate: dateContext.endDate
    },
    index,
    total
  };
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
}) {
  const detailById = new Map(args.details.map((detail) => [text(detail.shopId), detail]));
  const recordsByShop = new Map<string, DoudianViolationRecord[]>();
  for (const record of args.records) {
    const list = recordsByShop.get(record.shopId) || [];
    list.push(record);
    recordsByShop.set(record.shopId, list);
  }
  const updatedAt = nowIso();
  for (const row of args.rows) {
    const detail = detailById.get(row.shopId);
    await repositoryPut<ViolationsLatestRecord>("violations_latest", {
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
    });
  }
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
    const records = args.mockRecords;
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
    await saveLatest({ rows, records, details, dateContext, adapterVersion, ruleVersion: scriptsVersion, fieldSchemaVersion: schemaVersion, requestPlanHash: hash, productLinkageVersion: linkageVersion });
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
  const settled = await mapWithConcurrency(targets, concurrency, async (store, index) => collectForStore(payload, store, planKeys, dateContext, args, index + 1, targets.length));
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
    rows.push(emptyRow(store));
    details.push({ shopId: store.shopId, shopName: store.shopName, status: "failed", ok: false, message, reason: "violations-data-request-failed", category: "api", diagnostic: { error: message }, index: index + 1, total: targets.length });
  });

  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.filter((detail) => !detail.ok).length;
  const partialSourceCount = details.filter((detail) => Number(objectRecord(detail.diagnostic).blockingSourceFailureCount ?? objectRecord(detail.diagnostic).sourceFailureCount ?? 0) > 0).length;
  const noRecordCount = details.filter((detail) => objectRecord(objectRecord(detail.diagnostic).rowSummary).noRecord === true).length;
  const message = failureCount
    ? policyMessage(payload.adapter, "violationsData.messages.partial", "Violations data synced with {failureCount} failures", { successCount, failureCount })
    : partialSourceCount
      ? policyMessage(payload.adapter, "violationsData.messages.partialSources", "Violations data synced; {partialSourceCount} stores have source issues", { successCount, partialSourceCount })
      : policyMessage(payload.adapter, "violationsData.messages.done", "Violations data synced for {successCount} stores", { successCount });

  await saveLatest({ rows, records, details, dateContext, adapterVersion, ruleVersion: scriptsVersion, fieldSchemaVersion: schemaVersion, requestPlanHash: hash, productLinkageVersion: linkageVersion });

  return {
    ok: failureCount === 0,
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
  const rows = (await repositoryGetAll<ViolationsLatestRecord>("violations_latest"))
    .filter((record) => record.datePreset === dateContext.datePreset && record.beginDate === dateContext.beginDate && record.endDate === dateContext.endDate)
    .filter((record) => record.adapterVersion === (payload.adapter.version || "") && record.fieldSchemaVersion === schemaVersion && record.requestPlanHash === hash && record.productLinkageVersion === linkageVersion)
    .filter((record) => !targetIds.size || targetIds.has(record.shopId));
  const details: DoudianRunDetail[] = rows.map((record, index) => ({
    shopId: record.shopId,
    shopName: record.shopName,
    status: record.ok ? "ok" : "failed",
    ok: record.ok,
    message: record.message || (record.ok ? "Cached violations data ready" : "Cached violations data failed"),
    reason: record.ok ? "" : "violations-data-cached-failure",
    category: record.ok ? "" : "api",
    diagnostic: record.diagnostic,
    index: index + 1,
    total: rows.length
  }));
  return {
    ok: true,
    status: rows.length ? "ready" : "empty",
    message: rows.length ? `Read ${rows.length} cached violations data rows` : "No cached violations data",
    rows: rows.map((record) => record.row),
    records: rows.flatMap((record) => record.records || []),
    details,
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
      const records = [{
        id: `${shopId}-${item.datePreset}`,
        shopId,
        shopName,
        group: "Self Check",
        objectType: "商品",
        objectName: `Self Check Product ${item.datePreset}`,
        productId: `product-${suffix}`,
        reason: "self check",
        severity: "high",
        processStatus: item.datePreset === "today" ? "pending" : "rectifying",
        productStatus: "在售",
        associationStatus: "online",
        action: "review",
        dueAt,
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
    return {
      ok: results.every((item) => item.fetchOk && item.latestOk && item.metadataOk && item.dateRangeOk),
      latestOk: results.every((item) => item.latestOk),
      datePresetOk: results.every((item) => item.dateRangeOk),
      metadataOk: results.every((item) => item.metadataOk),
      cases: results
    };
  } finally {
    await deleteStoreLedger([shopId]).catch(() => undefined);
    await Promise.all(checkedContexts.map((context) => repositoryDelete("violations_latest", latestId(shopId, context, payload.adapter.version || "", schemaVersion, hash, linkageVersion)).catch(() => undefined)));
  }
}
