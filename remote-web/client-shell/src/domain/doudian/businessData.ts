import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianBusinessDataResult,
  DoudianBusinessDataRow,
  DoudianRunDetail,
  DoudianStoreSummary
} from "../../types";
import { requireChihuNative } from "../../native/client";
import { repositoryDelete, repositoryGetAll, repositoryGetMany, repositoryPutMany } from "./repository";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";
import { dispatchDoudianProgress } from "./progress";
import { reportDoudianDiagnostic } from "./diagnosticLog";
import businessDataResponseFixture from "./fixtures/businessDataResponse.json";

const BUSINESS_DATA_FIELDS = [
  "dealAmount",
  "orderCount",
  "refundAmount",
  "refundOrderCount",
  "platformSubsidyAmount",
  "violationPending",
  "rectificationRisk",
  "pendingShipment",
  "ship24h",
  "overdueShipment",
  "unpaidOrders",
  "afterSalePending",
  "abnormalPackage",
  "serviceOrder",
  "buyers",
  "customerPrice",
  "exposureUsers",
  "clickUsers",
  "productExposureCount",
  "productClickCount",
  "onSaleProductCount",
  "offlineProductCount",
  "experienceScore",
  "refundRate",
  "latest7dUnreadWarning",
  "couponActive",
  "directDiscountActive",
  "newUserBonusActive",
  "reputationScore",
  "logisticsScore",
  "disputeDeduction",
  "productScore",
  "serviceScore"
] as const;

type BusinessField = typeof BUSINESS_DATA_FIELDS[number];

interface BusinessDataArgs {
  doudianAdapter?: DoudianAdapterPayload;
  shopIds?: string[];
  datePreset?: string;
  beginDate?: string;
  endDate?: string;
  operationId?: string;
  concurrency?: number;
  mockRows?: DoudianBusinessDataRow[];
  isCancelled?: () => boolean;
  trackWindow?: (winId: number) => void;
}

interface BusinessLatestRecord {
  id: string;
  shopId: string;
  shopName: string;
  ok: boolean;
  quality?: "ok" | "partial" | "failed" | "empty";
  message: string;
  row: DoudianBusinessDataRow;
  diagnostic?: unknown;
  datePreset: string;
  beginDate: string;
  endDate: string;
  dateRange: DateContext;
  adapterVersion: string;
  ruleVersion: string;
  scriptsVersion: string;
  requestPlanHash: string;
  updatedAt: string;
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

interface MetricSource {
  value: number;
  source: "path" | "alias" | "derived" | "none";
  available: boolean;
  reason?: "missing-path" | "empty-value" | "blocked";
  path?: string;
  alias?: string;
  formula?: string;
  candidateCount?: number;
  nonZeroCandidateCount?: number;
  fallbackZero?: boolean;
  blockedBy?: string;
}

interface BusinessMetric {
  value: number;
  source: MetricSource;
}

interface BusinessRowSummary {
  nonZeroFieldCount: number;
  nonZeroFields: string[];
  allZero: boolean;
  availableFieldCount: number;
  availableFields: string[];
  unavailableFieldCount: number;
  unavailableFields: string[];
  allUnavailable: boolean;
}

interface SourceFailure {
  key?: string;
  status?: number;
  code?: unknown;
  message?: string;
  optional?: boolean;
  critical?: boolean;
}

interface StoreActivationResult {
  ok: boolean;
  skipped?: boolean;
  activateUrl?: string;
  currentShopId?: string;
  message?: string;
  switchResult?: unknown;
}

function nowIso() {
  return new Date().toISOString();
}

function text(value: unknown) {
  return String(value || "").trim();
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

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function policy(adapter: DoudianAdapterConfig, path: string, fallback: unknown = undefined): unknown {
  const root = adapter.policies || {};
  const value = getPathValue(root, path);
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
  const template = policyText(adapter, path, fallback);
  return template.replace(/\{([^}]+)\}/g, (_match, key) => String(values[key] ?? ""));
}

function dataPresetPolicy(adapter: DoudianAdapterConfig, scope: string, preset: string) {
  const presets = objectRecord(policy(adapter, `${scope}.datePresets`, {}));
  const direct = objectRecord(presets[preset]);
  if (Object.keys(direct).length) return direct;
  const matched = Object.values(presets).find((item) => {
    const config = objectRecord(item);
    return text(config.dateType) === preset || text(config.legacyDateType) === preset || text(config.legacyActiveKey) === preset;
  });
  return objectRecord(matched);
}

function dataPresetText(adapter: DoudianAdapterConfig, scope: string, preset: string, key: string, fallback = "") {
  const value = dataPresetPolicy(adapter, scope, preset)[key];
  return value == null ? fallback : String(value);
}

function dataPresetNumber(adapter: DoudianAdapterConfig, scope: string, preset: string, key: string, fallback: number) {
  const value = Number(dataPresetPolicy(adapter, scope, preset)[key]);
  return Number.isFinite(value) ? value : fallback;
}

function resolveDatePreset(adapter: DoudianAdapterConfig, scope: string, value = "today") {
  const key = text(value) || "today";
  const presets = objectRecord(policy(adapter, `${scope}.datePresets`, {}));
  if (presets[key]) return key;
  const matched = Object.entries(presets).find(([, item]) => {
    const config = objectRecord(item);
    return text(config.dateType) === key || text(config.legacyDateType) === key || text(config.legacyActiveKey) === key;
  });
  return matched ? matched[0] : key;
}

function dataDateContext(args: BusinessDataArgs, adapter: DoudianAdapterConfig): DateContext {
  const scope = "businessData";
  const preset = resolveDatePreset(adapter, scope, args.datePreset || "today");
  const today = new Date();
  let beginDate = validIsoDate(args.beginDate);
  let endDate = validIsoDate(args.endDate);
  const hasExplicitRange = !!(beginDate && endDate);

  if (!beginDate || !endDate) {
    const fallbackStart = preset === "yesterday" ? -1 : preset === "7d" ? -7 : preset === "30d" ? -30 : 0;
    const fallbackEnd = preset === "yesterday" || preset === "7d" || preset === "30d" ? -1 : 0;
    const startOffsetDays = dataPresetNumber(adapter, scope, preset, "startOffsetDays", fallbackStart);
    const endOffsetDays = dataPresetNumber(adapter, scope, preset, "endOffsetDays", fallbackEnd);
    beginDate = formatLocalIsoDate(addDateDays(today, startOffsetDays));
    endDate = formatLocalIsoDate(addDateDays(today, endOffsetDays));
    if (dataPresetPolicy(adapter, scope, preset).sameDay === true) endDate = beginDate;
  }

  const earlyMorningStartHour = dataPresetNumber(adapter, scope, preset, "earlyMorningStartHour", 1);
  const earlyMorningBeforeHour = dataPresetNumber(adapter, scope, preset, "earlyMorningBeforeHour", -1);
  const earlyMorningShiftDays = dataPresetNumber(adapter, scope, preset, "earlyMorningShiftDays", 0);
  if (!hasExplicitRange && earlyMorningShiftDays && earlyMorningBeforeHour >= 0 && today.getHours() >= earlyMorningStartHour && today.getHours() < earlyMorningBeforeHour) {
    beginDate = formatLocalIsoDate(addDateDays(new Date(`${beginDate}T00:00:00`), earlyMorningShiftDays));
    endDate = formatLocalIsoDate(addDateDays(new Date(`${endDate}T00:00:00`), earlyMorningShiftDays));
  }

  const dateType = dataPresetText(adapter, scope, preset, "dateType", policyText(adapter, `${scope}.datePresetMap.${preset}`, preset));
  const legacyDateType = dataPresetText(adapter, scope, preset, "legacyDateType", "999");
  const legacyActiveKey = dataPresetText(adapter, scope, preset, "legacyActiveKey", "999");

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

function responseMappings(adapter: DoudianAdapterConfig) {
  return objectRecord(adapter.responseMappings);
}

function businessDataMappings(adapter: DoudianAdapterConfig) {
  return objectRecord(responseMappings(adapter).businessData);
}

function businessFieldConfig(adapter: DoudianAdapterConfig, field: BusinessField) {
  const fields = objectRecord(businessDataMappings(adapter).fields);
  const value = fields[field];
  if (Array.isArray(value)) return { paths: value };
  return objectRecord(value);
}

function businessFieldPaths(adapter: DoudianAdapterConfig, field: BusinessField) {
  const paths = businessFieldConfig(adapter, field).paths;
  return Array.isArray(paths) ? paths.map((item) => text(item)).filter(Boolean) : [];
}

function businessFieldAliases(adapter: DoudianAdapterConfig, field: BusinessField) {
  const aliases = businessFieldConfig(adapter, field).aliases;
  return Array.isArray(aliases) ? aliases.map((item) => text(item)).filter(Boolean) : [];
}

function configuredScale(value: unknown) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : 0;
}

function businessFieldScale(adapter: DoudianAdapterConfig, field: BusinessField, path = "") {
  const scales = objectRecord(businessDataMappings(adapter).fieldScales);
  const config = businessFieldConfig(adapter, field);
  const pathScales = objectRecord(config.pathScales);
  if (path) {
    const exact = configuredScale(pathScales[path]);
    if (exact) return exact;
    for (const [prefix, scale] of Object.entries(pathScales)) {
      const normalizedPrefix = prefix.endsWith("*") ? prefix.slice(0, -1) : prefix;
      if (normalizedPrefix && path.startsWith(normalizedPrefix)) {
        const value = configuredScale(scale);
        if (value) return value;
      }
    }
  }
  const value = configuredScale(config.scale || scales[field] || 1);
  return value || 1;
}

const BUSINESS_NUMBER_VALUE_KEYS = [
  "index_value",
  "indexValue",
  "metric_value",
  "metricValue",
  "field_value",
  "fieldValue",
  "current_value",
  "currentValue",
  "origin_value",
  "originValue",
  "display_value",
  "displayValue",
  "show_value",
  "showValue",
  "metric_display",
  "metricDisplay",
  "main_value",
  "mainValue",
  "main_display",
  "mainDisplay",
  "value",
  "val",
  "amount",
  "count",
  "cnt",
  "num",
  "number",
  "score",
  "rate",
  "total",
  "text"
];

function coerceBusinessNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of BUSINESS_NUMBER_VALUE_KEYS) {
      if (record[key] !== undefined) {
        const next = coerceBusinessNumber(record[key]);
        if (next !== undefined) return next;
      }
    }
    return undefined;
  }
  const match = String(value).replace(/,/g, "").replace(/%/g, "").trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const next = Number(match[0]);
  return Number.isFinite(next) ? next : undefined;
}

function normalizeAliasKey(value: unknown) {
  return String(value || "").normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

const ALIAS_DESCRIPTOR_KEYS = [
  "key",
  "field",
  "fieldKey",
  "field_key",
  "name",
  "id",
  "title",
  "code",
  "metric",
  "metricName",
  "metric_name",
  "metricKey",
  "metric_key",
  "metricCode",
  "metric_code",
  "index",
  "indexName",
  "index_name",
  "indexKey",
  "index_key",
  "indexCode",
  "index_code",
  "indicator",
  "indicatorKey",
  "indicator_key",
  "dataIndex",
  "data_index",
  "column",
  "columnKey",
  "nameKey",
  "name_key",
  "label",
  "labelName",
  "label_name",
  "valueKey",
  "value_key",
  "bizKey",
  "biz_key",
  "itemKey",
  "item_key",
  "col",
  "type"
];

function aliasDescriptorMatch(value: unknown, aliasLookup: Map<string, string>) {
  const record = objectRecord(value);
  if (!Object.keys(record).length) return "";
  for (const key of ALIAS_DESCRIPTOR_KEYS) {
    const alias = aliasLookup.get(normalizeAliasKey(record[key]));
    if (alias) return alias;
  }
  return "";
}

function findDeepByAlias(value: unknown, aliasLookup: Map<string, string>, depth = 0): { value: unknown; alias: string } | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const next = findDeepByAlias(item, aliasLookup, depth + 1);
      if (next) return next;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const descriptorAlias = aliasDescriptorMatch(record, aliasLookup);
  if (descriptorAlias && coerceBusinessNumber(record) !== undefined) return { value: record, alias: descriptorAlias };

  for (const [key, nextValue] of Object.entries(record)) {
    const alias = aliasLookup.get(normalizeAliasKey(key));
    if (alias && coerceBusinessNumber(nextValue) !== undefined) return { value: nextValue, alias };
    if (alias) {
      const nested = findDeepByAlias(nextValue, aliasLookup, depth + 1);
      if (nested) return nested;
    }
  }
  for (const nextValue of Object.values(record)) {
    const next = findDeepByAlias(nextValue, aliasLookup, depth + 1);
    if (next) return next;
  }
  return null;
}

function fieldAliasMatchedPath(field: BusinessField, path: string, aliases: string[]) {
  const normalizedPath = normalizeAliasKey(path);
  const normalizedField = normalizeAliasKey(field);
  return normalizedPath.includes(normalizedField) || aliases.some((alias) => {
    const normalizedAlias = normalizeAliasKey(alias);
    return normalizedAlias && normalizedPath.includes(normalizedAlias);
  });
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function businessResponsePayload(responses: Record<string, RequestPlanResult>) {
  const payload: Record<string, unknown> = { responses };
  for (const [key, response] of Object.entries(responses)) payload[key] = response.data;
  return payload;
}

function fieldPlanKeys(adapter: DoudianAdapterConfig, field: BusinessField) {
  const keys = businessFieldPaths(adapter, field).map((path) => text(path.split(".")[0])).filter(Boolean);
  return Array.from(new Set(keys));
}

function aliasSearchRoots(payload: Record<string, unknown>, adapter: DoudianAdapterConfig, field: BusinessField, aliases: string[]) {
  const roots: Array<{ value: unknown; path?: string }> = [];
  const seen = new WeakSet<object>();
  const push = (value: unknown, path?: string) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    roots.push({ value, path });
  };

  for (const planKey of fieldPlanKeys(adapter, field)) {
    const planPayload = payload[planKey];
    const plan = objectRecord(adapter.requestPlans?.[planKey]);
    for (const successPath of stringArray(plan.successPaths)) {
      const rootPath = `${planKey}.${successPath}`;
      if (fieldAliasMatchedPath(field, rootPath, aliases)) push(getPathValue(planPayload, successPath), rootPath);
    }
    push(getPathValue(planPayload, "data"), `${planKey}.data`);
    push(planPayload, planKey);
  }
  if (!roots.length) push(payload, "");
  return roots;
}

function planKeyFromMetricPath(path: string) {
  return text(path.split(".")[0]);
}

function normalizeBusinessMetricValue(field: BusinessField, value: number) {
  if (["dealAmount", "refundAmount", "platformSubsidyAmount", "customerPrice"].includes(field)) {
    return Math.round(value * 100) / 100;
  }
  if (["refundRate", "experienceScore", "reputationScore", "logisticsScore", "productScore", "serviceScore"].includes(field)) {
    return Math.round(value * 100) / 100;
  }
  return value;
}

function preferredBusinessMetric(candidates: BusinessMetric[], preferNonZero = false) {
  if (!candidates.length) return null;
  const selected = preferNonZero
    ? candidates.find((candidate) => Number(candidate.value || 0) !== 0) || candidates[0]
    : candidates[0];
  const nonZeroCandidateCount = candidates.filter((candidate) => Number(candidate.value || 0) !== 0).length;
  return {
    value: selected.value,
    source: {
      ...selected.source,
      candidateCount: candidates.length,
      nonZeroCandidateCount,
      fallbackZero: nonZeroCandidateCount === 0 && candidates.length > 1
    }
  };
}

function readBusinessMetric(payload: Record<string, unknown>, adapter: DoudianAdapterConfig, field: BusinessField): BusinessMetric {
  const preferNonZero = businessFieldConfig(adapter, field).preferNonZeroCandidate === true;
  const pathCandidates = new Map<string, BusinessMetric[]>();
  const pathPlanOrder: string[] = [];
  for (const path of businessFieldPaths(adapter, field)) {
    const value = getPathValue(payload, path);
    const number = coerceBusinessNumber(value);
    if (number !== undefined) {
      const scale = businessFieldScale(adapter, field, path);
      const metricValue = normalizeBusinessMetricValue(field, number / scale);
      const planKey = planKeyFromMetricPath(path) || "path";
      if (!pathCandidates.has(planKey)) {
        pathCandidates.set(planKey, []);
        pathPlanOrder.push(planKey);
      }
      pathCandidates.get(planKey)?.push({
        value: metricValue,
        source: { value: metricValue, source: "path", path, available: true }
      });
    }
  }
  if (pathPlanOrder.length) {
    const groups = pathPlanOrder.map((planKey) => pathCandidates.get(planKey) || []).filter((group) => group.length);
    const selectedGroup = preferNonZero
      ? groups.find((group) => group.some((candidate) => Number(candidate.value || 0) !== 0)) || groups[0] || []
      : groups[0] || [];
    return preferredBusinessMetric(selectedGroup, preferNonZero) || { value: 0, source: { value: 0, source: "none", available: false, reason: "missing-path" } };
  }

  const aliases = businessFieldAliases(adapter, field);
  const candidates: BusinessMetric[] = [];
  if (aliases.length) {
    const aliasLookup = new Map<string, string>();
    for (const alias of aliases) {
      const normalized = normalizeAliasKey(alias);
      if (normalized && !aliasLookup.has(normalized)) aliasLookup.set(normalized, alias);
    }
    for (const root of aliasSearchRoots(payload, adapter, field, aliases)) {
      const match = findDeepByAlias(root.value, aliasLookup);
      const number = coerceBusinessNumber(match?.value);
      if (number !== undefined) {
        const scale = businessFieldScale(adapter, field, root.path || "");
        const metricValue = normalizeBusinessMetricValue(field, number / scale);
        candidates.push({
          value: metricValue,
          source: { value: metricValue, source: "alias", alias: match?.alias, path: root.path, available: true }
        });
      }
    }
  }

  return preferredBusinessMetric(candidates, preferNonZero) || { value: 0, source: { value: 0, source: "none", available: false, reason: "missing-path" } };
}

function emptyBusinessDataRow(store: DoudianStoreSummary): DoudianBusinessDataRow {
  const row: DoudianBusinessDataRow = {
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    status: store.status,
    dealAmount: 0,
    orderCount: 0,
    refundAmount: 0,
    refundOrderCount: 0,
    platformSubsidyAmount: 0,
    violationPending: 0,
    rectificationRisk: 0,
    pendingShipment: 0,
    ship24h: 0,
    overdueShipment: 0,
    unpaidOrders: 0,
    afterSalePending: 0,
    abnormalPackage: 0,
    serviceOrder: 0,
    buyers: 0,
    customerPrice: 0,
    exposureUsers: 0,
    clickUsers: 0,
    productExposureCount: 0,
    productClickCount: 0,
    onSaleProductCount: 0,
    offlineProductCount: 0,
    experienceScore: 0,
    refundRate: 0,
    latest7dUnreadWarning: 0,
    couponActive: 0,
    directDiscountActive: 0,
    newUserBonusActive: 0,
    reputationScore: 0,
    logisticsScore: 0,
    disputeDeduction: 0,
    productScore: 0,
    serviceScore: 0
  };
  return row;
}

function rowSummary(row: DoudianBusinessDataRow, metricSources?: Record<string, MetricSource>, expectedFields: BusinessField[] = [...BUSINESS_DATA_FIELDS]): BusinessRowSummary {
  const nonZeroFields = BUSINESS_DATA_FIELDS.filter((field) => Number(row[field] || 0) !== 0);
  const availableFields = expectedFields.filter((field) => metricSources?.[field]?.available === true);
  const availableFieldSet = new Set(availableFields);
  const unavailableFields = expectedFields.filter((field) => !availableFieldSet.has(field));
  return {
    nonZeroFieldCount: nonZeroFields.length,
    nonZeroFields,
    allZero: nonZeroFields.length === 0,
    availableFieldCount: availableFields.length,
    availableFields,
    unavailableFieldCount: unavailableFields.length,
    unavailableFields,
    allUnavailable: availableFields.length === 0
  };
}

const BUSINESS_ROW_DIAGNOSTIC_FIELDS: BusinessField[] = [
  "dealAmount",
  "orderCount",
  "refundAmount",
  "refundOrderCount",
  "platformSubsidyAmount",
  "buyers",
  "customerPrice",
  "exposureUsers",
  "clickUsers",
  "productExposureCount",
  "productClickCount",
  "onSaleProductCount",
  "offlineProductCount",
  "experienceScore",
  "refundRate"
];

function businessRowMetricSnapshot(row: DoudianBusinessDataRow) {
  return Object.fromEntries(BUSINESS_ROW_DIAGNOSTIC_FIELDS.map((field) => [field, row[field]]));
}

function businessMetricSourceSnapshot(metricSources: Record<string, MetricSource>) {
  return Object.fromEntries(BUSINESS_ROW_DIAGNOSTIC_FIELDS.map((field) => [field, metricSources[field] || { value: 0, source: "none", available: false, reason: "missing-path" }]));
}

function businessCoreShape(responses: Record<string, RequestPlanResult>, adapter: DoudianAdapterConfig) {
  const response = responses.businessCoreIndex;
  if (!response) return null;
  const plan = objectRecord(adapter.requestPlans?.businessCoreIndex);
  const metricKeys = [
    "income_amt",
    "pay_amt",
    "pay_cnt",
    "pay_ucnt",
    "per_usr_pay_amt",
    "product_show_ucnt",
    "product_click_ucnt",
    "product_show_cnt",
    "product_click_cnt",
    "refund_amt_rate",
    "refund_order_cnt",
    "rfndsuc_amt"
  ];
  const roots = stringArray(plan.successPaths)
    .map((path) => {
      const value = getPathValue(response.data, path);
      const record = objectRecord(value);
      return {
        path,
        type: Array.isArray(value) ? "array" : value && typeof value === "object" ? "object" : typeof value,
        keys: Object.keys(record).slice(0, 60),
        metricSamples: Object.fromEntries(metricKeys
          .filter((key) => record[key] !== undefined)
          .map((key) => {
            const metricValue = record[key];
            return [key, {
              number: coerceBusinessNumber(metricValue) ?? null,
              keys: Object.keys(objectRecord(metricValue)).slice(0, 30)
            }];
          }))
      };
    })
    .filter((item) => item.keys.length || item.type !== "undefined");
  return {
    status: response.status || 0,
    ok: response.ok === true,
    code: responseCode(response) ?? null,
    message: responseMessage(response).slice(0, 120),
    roots
  };
}

async function reportBusinessDataRow(args: {
  store: DoudianStoreSummary;
  row: DoudianBusinessDataRow;
  detail: DoudianRunDetail;
  summary: ReturnType<typeof rowSummary>;
  metricSources: Record<string, MetricSource>;
  responseSummary: Record<string, { status: number; success: boolean; code: unknown; message: string }>;
  responses: Record<string, RequestPlanResult>;
  adapter: DoudianAdapterConfig;
}) {
  try {
    await reportDoudianDiagnostic({
      category: "doudian-business-data",
      event: "row",
      shopId: args.store.shopId,
      shopName: args.store.shopName,
      partition: args.store.partition,
      ok: args.detail.ok === true,
      status: args.detail.status || "",
      reason: args.detail.reason || "",
      message: args.detail.message || "",
      rowSummary: args.summary,
      metrics: businessRowMetricSnapshot(args.row),
      metricSources: businessMetricSourceSnapshot(args.metricSources),
      activation: objectRecord(args.detail.diagnostic).activation || null,
      coreShape: businessCoreShape(args.responses, args.adapter),
      responses: args.responseSummary
    }, args.detail.ok !== true || args.detail.status === "partial");
  } catch {
    // Diagnostics must never block syncing.
  }
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
    success: requestPlanResponseOk(response, adapter, key, businessDataMappings(adapter)),
    code: responseCode(response) ?? null,
    message: responseMessage(response).slice(0, 160)
  }]));
}

function summarizeFailures(summary: Record<string, { status: number; success: boolean; code: unknown; message: string }>, adapter: DoudianAdapterConfig): SourceFailure[] {
  const optionalPlans = new Set(policyArray(adapter, "businessData.optionalPlans"));
  const criticalPlans = new Set(policyArray(adapter, "businessData.criticalPlans"));
  return Object.entries(summary)
    .filter(([, response]) => response.success !== true)
    .map(([key, response]) => ({
      key,
      optional: optionalPlans.has(key) && !criticalPlans.has(key),
      critical: criticalPlans.has(key),
      status: response.status || 0,
      code: response.code,
      message: response.message || ""
    }));
}

function criticalBusinessPlans(adapter: DoudianAdapterConfig, planKeys: string[]) {
  const configured = policyArray(adapter, "businessData.criticalPlans");
  const defaults = configured.length ? configured : ["businessHomepage", "businessCoreIndex"];
  return defaults.filter((key) => planKeys.includes(key));
}

function criticalBusinessFields(adapter: DoudianAdapterConfig): BusinessField[] {
  const configured = policyArray(adapter, "businessData.criticalFields") as BusinessField[];
  if (configured.length) return configured.filter((field) => BUSINESS_DATA_FIELDS.includes(field));
  return ["dealAmount", "orderCount", "buyers", "exposureUsers", "clickUsers", "onSaleProductCount"];
}

function activationSourceFailure(activation: StoreActivationResult, store: DoudianStoreSummary): SourceFailure | null {
  if (activation.ok === true) return null;
  if (activation.currentShopId && activation.currentShopId === store.shopId) return null;
  const switchResult = objectRecord(activation.switchResult);
  const switchReason = text(switchResult.reason);
  const currentShopId = text(activation.currentShopId);
  const parts = [
    activation.message || "target shop not confirmed",
    currentShopId && currentShopId !== store.shopId ? `currentShopId=${currentShopId}` : "",
    switchReason ? `switch=${switchReason}` : ""
  ].filter(Boolean);
  return {
    key: "activateStore",
    optional: false,
    status: 0,
    code: switchReason || null,
    message: parts.join("; ")
  };
}

function currentShopIdFromResponse(response: RequestPlanResult, adapter: DoudianAdapterConfig) {
  return text(firstPathValue(response.data, adapter.responseMappings?.currentShopIdPaths || []));
}

function activationLogPayload(store: DoudianStoreSummary, activation: StoreActivationResult) {
  const switchResult = objectRecord(activation.switchResult);
  return {
    category: "doudian-business-data",
    event: "activate-store",
    shopId: store.shopId,
    shopName: store.shopName,
    partition: store.partition,
    ok: activation.ok,
    skipped: activation.skipped === true,
    activateUrl: activation.activateUrl || "",
    currentShopId: activation.currentShopId || "",
    message: activation.message || "",
    switchOk: switchResult.ok === true,
    switchReason: text(switchResult.reason),
    switchHref: text(switchResult.href).slice(0, 200),
    switchTitle: text(switchResult.title).slice(0, 120)
  };
}

function switchShopEvalCode(switchFactory: string, payload: unknown, timeoutMs: number) {
  return `
    (async () => {
      const payload = ${JSON.stringify(payload)};
      const timeoutMs = ${JSON.stringify(timeoutMs)};
      const switchShop = ${switchFactory};
      const timeout = new Promise((resolve) => {
        setTimeout(() => resolve({ ok: false, reason: "switch-script-timeout", href: location.href, title: document.title }), timeoutMs);
      });
      try {
        const result = switchShop(payload);
        return await Promise.race([Promise.resolve(result), timeout]);
      } catch (error) {
        return { ok: false, reason: "switch-script-error", message: error && error.message ? error.message : String(error), href: location.href, title: document.title };
      }
    })();
  `;
}

async function activateStoreView(payload: DoudianAdapterPayload, store: DoudianStoreSummary, context: Record<string, unknown>, trackWindow?: (winId: number) => void): Promise<StoreActivationResult> {
  const native = requireChihuNative();
  const report = async (activation: StoreActivationResult) => {
    await reportDoudianDiagnostic(activationLogPayload(store, activation), activation.ok !== true);
    return activation;
  };
  const before = await runDoudianRequestPlan(payload, {
    partition: store.partition,
    planKey: "currentShop",
    context
  }).catch((error) => ({
    ok: false,
    status: 0,
    data: null,
    error: error instanceof Error ? error.message : String(error),
    source: "currentShop"
  }) as RequestPlanResult);
  const currentShopId = currentShopIdFromResponse(before, payload.adapter);
  if (currentShopId && currentShopId === store.shopId) {
    return report({
      ok: true,
      skipped: true,
      activateUrl: "",
      currentShopId,
      message: "current shop already active"
    });
  }

  const switchFactory = payload.scripts?.switchShopFactory;
  if (!switchFactory) {
    return report({
      ok: false,
      activateUrl: "",
      currentShopId,
      message: "switchShopFactory missing"
    });
  }

  let winId: number | null = null;
  const activateUrl = payload.adapter.chooseEntriesUrl || payload.adapter.homeUrl || payload.adapter.loginUrl;
  try {
    winId = await native.windows.open({
      url: activateUrl,
      partition: store.partition,
      show: false,
      waitForLoad: false,
      width: 480,
      height: 360,
      title: "Chihu Doudian Activate Store",
      nodeIntegration: false,
      contextIsolation: true
    });
    trackWindow?.(winId);
    const bootWaitMs = Math.max(0, policyNumber(payload.adapter, "businessData.activateBootWaitMs", 1200));
    if (bootWaitMs) await new Promise((resolve) => window.setTimeout(resolve, bootWaitMs));
    const switchTimeoutMs = Math.max(2000, policyNumber(payload.adapter, "businessData.activateScriptTimeoutMs", 5000));
    const switchResult = await native.windows.eval({
      winId,
      code: switchShopEvalCode(switchFactory, { adapter: payload.adapter, shop: store, context }, switchTimeoutMs),
      timeoutMs: switchTimeoutMs + 2000
    }).catch((error) => ({
      ok: false,
      reason: "switch-eval-failed",
      message: error instanceof Error ? error.message : String(error)
    }));
    const switchOk = !!(switchResult && typeof switchResult === "object" && (switchResult as { ok?: unknown }).ok === true);
    const settleWaitMs = Math.max(0, policyNumber(payload.adapter, "businessData.activateSettleWaitMs", 2200));
    if (settleWaitMs) await new Promise((resolve) => window.setTimeout(resolve, settleWaitMs));
    const after = await runDoudianRequestPlan(payload, {
      partition: store.partition,
      planKey: "currentShop",
      context
    }).catch((error) => ({
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
      source: "currentShop"
    }) as RequestPlanResult);
    const afterShopId = currentShopIdFromResponse(after, payload.adapter);
    const confirmed = afterShopId === store.shopId;
    return report({
      ok: confirmed,
      activateUrl,
      currentShopId: afterShopId || currentShopId,
      message: confirmed ? "target shop active" : switchOk ? "target shop clicked but not confirmed" : responseMessage(after) || "target shop not confirmed",
      switchResult
    });
  } catch (error) {
    return report({
      ok: false,
      activateUrl,
      currentShopId,
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (winId != null) await native.windows.destroy({ winId }).catch(() => undefined);
  }
}

function buildBusinessDataResult(store: DoudianStoreSummary, responses: Record<string, RequestPlanResult>, dateContext: DateContext, adapter: DoudianAdapterConfig) {
  const payload = businessResponsePayload(responses);
  const row = emptyBusinessDataRow(store);
  const metricSources: Record<string, MetricSource> = {};

  for (const field of BUSINESS_DATA_FIELDS) {
    const metric = readBusinessMetric(payload, adapter, field);
    row[field] = metric.value;
    metricSources[field] = metric.source;
  }
  if (!row.customerPrice && row.orderCount > 0) {
    row.customerPrice = row.dealAmount / row.orderCount;
    metricSources.customerPrice = { value: row.customerPrice, source: "derived", available: metricSources.dealAmount?.available === true && metricSources.orderCount?.available === true, formula: "dealAmount/orderCount" };
  }
  if (!row.refundRate && row.orderCount > 0 && row.refundOrderCount > 0) {
    row.refundRate = (row.refundOrderCount / row.orderCount) * 100;
    metricSources.refundRate = { value: row.refundRate, source: "derived", available: metricSources.refundOrderCount?.available === true && metricSources.orderCount?.available === true, formula: "refundOrderCount/orderCount*100" };
  }
  row.datePreset = dateContext.datePreset;
  row.beginDate = dateContext.beginDate;
  row.endDate = dateContext.endDate;
  return { row, metricSources };
}

function blockedBusinessDataResult(store: DoudianStoreSummary, dateContext: DateContext, blockedBy: string) {
  const row = emptyBusinessDataRow(store);
  const metricSources = Object.fromEntries(BUSINESS_DATA_FIELDS.map((field) => [field, {
    value: 0,
    source: "none",
    available: false,
    reason: "blocked",
    blockedBy
  }])) as Record<string, MetricSource>;
  row.datePreset = dateContext.datePreset;
  row.beginDate = dateContext.beginDate;
  row.endDate = dateContext.endDate;
  return { row, metricSources };
}

function requestPlanKeys(adapter: DoudianAdapterConfig) {
  const policyPlans = policyArray(adapter, "businessData.requestPlans");
  if (policyPlans.length) return Array.from(new Set(policyPlans));
  const operationPlans = objectRecord(adapter.operationPlans);
  const fetchPlan = objectRecord(operationPlans.fetchBusinessData);
  const actions = Array.isArray(fetchPlan.actions) ? fetchPlan.actions : [];
  return Array.from(new Set(actions.flatMap((action) => {
    const record = objectRecord(action);
    if (Array.isArray(record.requestPlans)) return record.requestPlans.map((item) => text(item)).filter(Boolean);
    return text(record.requestPlan) ? [text(record.requestPlan)] : [];
  })));
}

function fieldSchemaVersion(adapter: DoudianAdapterConfig) {
  return text(objectRecord(policy(adapter, "businessData.fieldSchema", {})).version);
}

function latestId(shopId: string, dateContext: DateContext, adapterVersion: string, schemaVersion: string, planHash: string) {
  return `${shopId}::${dateContext.datePreset}::${dateContext.beginDate}::${dateContext.endDate}::${adapterVersion}::${schemaVersion}::${planHash}`;
}

function requestPlanHash(planKeys: string[]) {
  return planKeys.join("|");
}

let lastBusinessCacheCleanupDay = "";

async function cleanupBusinessLatestCache(adapterVersion: string, schemaVersion: string, planHash: string) {
  const cleanupDay = formatLocalIsoDate(new Date());
  if (lastBusinessCacheCleanupDay === cleanupDay) return;
  lastBusinessCacheCleanupDay = cleanupDay;
  const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
  const records = await repositoryGetAll<BusinessLatestRecord>("business_latest");
  const stale = records.filter((record) => (
    record.adapterVersion !== adapterVersion ||
    text(objectRecord(record.dateRange).datePreset) !== record.datePreset ||
    record.requestPlanHash !== planHash ||
    !record.id.includes(`::${schemaVersion}::`) ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    Date.parse(record.updatedAt) < cutoff
  ));
  await Promise.all(stale.map((record) => repositoryDelete("business_latest", record.id).catch(() => undefined)));
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

async function mapStoresWithPartitionConcurrency<R>(
  stores: DoudianStoreSummary[],
  concurrency: number,
  mapper: (store: DoudianStoreSummary, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(stores.length);
  const queues = new Map<string, Array<{ store: DoudianStoreSummary; index: number }>>();
  stores.forEach((store, index) => {
    const key = store.partition || `missing:${index}`;
    const queue = queues.get(key) || [];
    queue.push({ store, index });
    queues.set(key, queue);
  });
  const partitionQueues = [...queues.values()];
  let nextQueue = 0;
  async function worker() {
    for (;;) {
      const queueIndex = nextQueue;
      nextQueue += 1;
      if (queueIndex >= partitionQueues.length) return;
      for (const item of partitionQueues[queueIndex]) {
        try {
          results[item.index] = { status: "fulfilled", value: await mapper(item.store, item.index) };
        } catch (reason) {
          results[item.index] = { status: "rejected", reason };
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, partitionQueues.length)) }, () => worker()));
  return results;
}

function configuredRequestPlanGroups(adapter: DoudianAdapterConfig, planKeys: string[]) {
  const configured = policy(adapter, "businessData.requestPlanGroups", []);
  if (!Array.isArray(configured)) return planKeys.map((key) => [key]);
  const allowed = new Set(planKeys);
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const configuredGroup of configured) {
    if (!Array.isArray(configuredGroup)) continue;
    const group = configuredGroup.map((key) => text(key)).filter((key) => allowed.has(key) && !seen.has(key));
    if (!group.length) continue;
    group.forEach((key) => seen.add(key));
    groups.push(group);
  }
  for (const key of planKeys) if (!seen.has(key)) groups.push([key]);
  return groups;
}

function throwIfCancelled(args: BusinessDataArgs) {
  if (args.isCancelled?.()) throw new Error("cancelled");
}

async function collectStoreBusinessData(payload: DoudianAdapterPayload, store: DoudianStoreSummary, planKeys: string[], dateContext: DateContext, index: number, total: number, args: BusinessDataArgs) {
  if (!store.partition) throw new Error("store partition missing");
  throwIfCancelled(args);
  const responses: Record<string, RequestPlanResult> = {};
  const context = {
    ...dateContext,
    shopId: store.shopId,
    shopName: store.shopName
  };
  const activation = policy(payload.adapter, "businessData.activateBeforeFetch", true) === false
    ? { ok: true, skipped: true, message: "disabled" }
    : await activateStoreView(payload, store, context, args.trackWindow);

  const planGroups = configuredRequestPlanGroups(payload.adapter, planKeys);
  const planGroupDelayMs = Math.max(0, policyNumber(payload.adapter, "businessData.requestPlanGroupDelayMs", 0));
  for (let groupIndex = 0; groupIndex < planGroups.length; groupIndex += 1) {
    const group = planGroups[groupIndex];
    throwIfCancelled(args);
    if (groupIndex > 0 && planGroupDelayMs) await new Promise((resolve) => window.setTimeout(resolve, planGroupDelayMs));
    const groupResponses = await Promise.all(group.map(async (planKey) => [planKey, await runDoudianRequestPlan(payload, {
      partition: store.partition,
      planKey,
      context,
      trackWindow: args.trackWindow
    })] as const));
    for (const [planKey, response] of groupResponses) responses[planKey] = response;
  }

  const responseSummary = summarizeResponses(responses, payload.adapter);
  const activationFailure = activationSourceFailure(activation, store);
  const sourceFailures = [
    ...(activationFailure ? [activationFailure] : []),
    ...summarizeFailures(responseSummary, payload.adapter)
  ];
  const trustUnconfirmedMetrics = policy(payload.adapter, "businessData.trustMetricsWhenActivationUnconfirmed", false) === true;
  const { row, metricSources } = activationFailure && !trustUnconfirmedMetrics
    ? blockedBusinessDataResult(store, dateContext, "activateStore")
    : buildBusinessDataResult(store, responses, dateContext, payload.adapter);
  const blockingSourceFailures = sourceFailures.filter((failure) => !failure.optional);
  const summary = rowSummary(row, metricSources);
  const requiredPlans = policyArray(payload.adapter, "businessData.requiredPlans");
  const criticalPlans = criticalBusinessPlans(payload.adapter, planKeys);
  const criticalFields = criticalBusinessFields(payload.adapter);
  const coreMetricPlans = policyArray(payload.adapter, "businessData.coreMetricPlans").length
    ? policyArray(payload.adapter, "businessData.coreMetricPlans")
    : ["businessCoreIndex"];
  const missingCoreMetricPlans = coreMetricPlans.filter((planKey) => !requestPlanResponseOk(responses[planKey], payload.adapter, planKey, businessDataMappings(payload.adapter)));
  const coreMetricsComplete = missingCoreMetricPlans.length === 0;
  const missingCriticalPlans = criticalPlans.filter((planKey) => !requestPlanResponseOk(responses[planKey], payload.adapter, planKey, businessDataMappings(payload.adapter)));
  const unavailableCriticalFields = criticalFields.filter((field) => metricSources[field]?.available !== true);
  const missingRequiredPlans = requiredPlans.filter((planKey) => requestPlanResponseOk(responses[planKey], payload.adapter, planKey, businessDataMappings(payload.adapter)) !== true);
  const okCount = Object.entries(responses).filter(([key, response]) => requestPlanResponseOk(response, payload.adapter, key, businessDataMappings(payload.adapter))).length;
  const ok = (requiredPlans.length ? missingRequiredPlans.length === 0 : okCount > 0) && missingCriticalPlans.length === 0;
  const partial = ok && (blockingSourceFailures.length > 0 || unavailableCriticalFields.length > 0 || summary.allUnavailable);
  const message = !ok
    ? sourceFailures.find((failure) => !failure.optional)?.message || policyMessage(payload.adapter, "businessData.messages.failed", "Business data request failed")
    : blockingSourceFailures.length
      ? policyMessage(payload.adapter, "businessData.messages.partialSourceStore", "Business data synced with partial source errors")
      : summary.allUnavailable
        ? policyMessage(payload.adapter, "businessData.messages.noMetricMatchStore", "Business data returned no readable metric fields")
        : unavailableCriticalFields.length
          ? policyMessage(payload.adapter, "businessData.messages.noMetricMatchStore", "Business data synced but critical metric fields are unavailable")
          : policyMessage(payload.adapter, "businessData.messages.synced", "Business data synced");
  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (partial ? "partial" : "ok") : "failed",
    ok,
    message,
    reason: ok ? (blockingSourceFailures.length ? "business-data-partial-source-failure" : summary.allUnavailable ? "business-data-no-readable-metrics" : unavailableCriticalFields.length ? "business-data-critical-fields-unavailable" : "") : "business-data-request-failed",
    category: ok ? (partial ? "api-partial" : "") : "api",
    diagnostic: {
      responses: responseSummary,
      okCount,
      requiredPlans,
      missingRequiredPlans,
      coreMetricPlans,
      missingCoreMetricPlans,
      coreMetricsComplete,
      criticalPlans,
      missingCriticalPlans,
      criticalFields,
      unavailableCriticalFields,
      sourceFailureCount: sourceFailures.length,
      blockingSourceFailureCount: blockingSourceFailures.length,
      sourceFailures,
      activation,
      rowSummary: summary,
      metricSources,
      datePreset: dateContext.datePreset,
      beginDate: dateContext.beginDate,
      endDate: dateContext.endDate
    },
    index,
    total
  };

  await reportBusinessDataRow({ store, row, detail, summary, metricSources, responseSummary, responses, adapter: payload.adapter });
  dispatchDoudianProgress({
    operationId: args.operationId || "",
    taskType: "businessData",
    status: "running",
    progress: Math.round((index / Math.max(1, total)) * 95),
    message: `${store.shopName || store.shopId} ${index}/${total}`
  });
  return { row, detail };
}

function targetStores(stores: DoudianStoreSummary[], shopIds: string[] = []) {
  const requested = new Set(shopIds.map((item) => text(item)).filter(Boolean));
  return requested.size ? stores.filter((store) => requested.has(store.shopId)) : stores;
}

async function saveBusinessLatestRows(args: {
  rows: DoudianBusinessDataRow[];
  details: DoudianRunDetail[];
  dateContext: DateContext;
  adapterVersion: string;
  ruleVersion: string;
  requestPlanHash: string;
  fieldSchemaVersion: string;
}) {
  const detailById = new Map(args.details.map((detail) => [text(detail.shopId), detail]));
  const updatedAt = nowIso();
  const records = args.rows.flatMap((row) => {
    const detail = detailById.get(row.shopId);
    const quality = detail?.status === "ok" ? "ok" : detail?.status === "failed" || detail?.ok === false ? "failed" : "partial";
    if (quality !== "ok") return [];
    return [{
      id: latestId(row.shopId, args.dateContext, args.adapterVersion, args.fieldSchemaVersion, args.requestPlanHash),
      shopId: row.shopId,
      shopName: row.shopName,
      ok: true,
      quality,
      message: detail?.message || "",
      row,
      diagnostic: detail?.diagnostic,
      datePreset: args.dateContext.datePreset,
      beginDate: args.dateContext.beginDate,
      endDate: args.dateContext.endDate,
      dateRange: args.dateContext,
      adapterVersion: args.adapterVersion,
      ruleVersion: args.ruleVersion,
      scriptsVersion: args.ruleVersion,
      requestPlanHash: args.requestPlanHash,
      updatedAt
    } satisfies BusinessLatestRecord];
  });
  await repositoryPutMany<BusinessLatestRecord>("business_latest", records);
  return records.length;
}

function adapterPayload(args: BusinessDataArgs): DoudianAdapterPayload {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  return args.doudianAdapter;
}

export async function fetchBusinessData(args: BusinessDataArgs = {}): Promise<DoudianBusinessDataResult> {
  const startedAtMs = Date.now();
  const payload = adapterPayload(args);
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds || []);
  const dateContext = dataDateContext(args, payload.adapter);
  const planKeys = requestPlanKeys(payload.adapter);
  const adapterVersion = payload.adapter.version || "";
  const scriptsVersion = payload.scripts?.version || "";
  const schemaVersion = fieldSchemaVersion(payload.adapter);
  const planHash = requestPlanHash(planKeys);
  const runId = `business-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (args.mockRows?.length) {
    const rows = args.mockRows;
    const details = rows.map((row, index) => {
      const metricSources = Object.fromEntries(BUSINESS_DATA_FIELDS.map((field) => [field, {
        value: Number(row[field] || 0),
        source: "path",
        available: true,
        path: "mockRows"
      }])) as Record<string, MetricSource>;
      return {
        shopId: row.shopId,
        shopName: row.shopName,
        status: "ok",
        ok: true,
        message: "Mock business data synced",
        diagnostic: { rowSummary: rowSummary(row, metricSources), metricSources },
        index: index + 1,
        total: rows.length
      };
    });
    await saveBusinessLatestRows({ rows, details, dateContext, adapterVersion, ruleVersion: scriptsVersion, fieldSchemaVersion: schemaVersion, requestPlanHash: planHash });
    return {
      ok: true,
      status: "ok",
      message: `Business data synced for ${rows.length} stores`,
      runId,
      operationId: args.operationId,
      rows,
      details,
      successCount: rows.length,
      failureCount: 0,
      partialSourceCount: 0,
      noMetricMatchCount: 0,
      coreIncompleteCount: 0,
      dateRange: publicDateRange(dateContext),
      adapterVersion,
      scriptsVersion,
      stores,
      groups: ledger.groups || []
    };
  }

  if (!planKeys.length) {
    return {
      ok: false,
      status: "missing-request-plans",
      message: "remote fetchBusinessData operation missing request plans",
      rows: targets.map(emptyBusinessDataRow),
      details: [],
      stores,
      groups: ledger.groups || [],
      dateRange: publicDateRange(dateContext),
      adapterVersion,
      scriptsVersion
    };
  }

  const activateBeforeFetch = policy(payload.adapter, "businessData.activateBeforeFetch", true) !== false;
  const defaultConcurrency = Math.max(1, Math.min(8, Math.floor(policyNumber(payload.adapter, "businessData.concurrency", activateBeforeFetch ? 1 : 3))));
  const concurrencyCap = activateBeforeFetch ? 3 : 8;
  const concurrency = Math.max(1, Math.min(concurrencyCap, Math.floor(Number(args.concurrency || defaultConcurrency))));
  const settled = await mapStoresWithPartitionConcurrency(targets, concurrency, async (store, index) => {
    throwIfCancelled(args);
    return collectStoreBusinessData(payload, store, planKeys, dateContext, index + 1, targets.length, args);
  });
  const rows: DoudianBusinessDataRow[] = [];
  const details: DoudianRunDetail[] = [];

  settled.forEach((result, index) => {
    const store = targets[index];
    if (result.status === "fulfilled") {
      rows.push(result.value.row);
      details.push(result.value.detail);
      return;
    }
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason || "Business data request failed");
    const row = emptyBusinessDataRow(store);
    rows.push(row);
    details.push({
      shopId: store.shopId,
      shopName: store.shopName,
      status: "failed",
      ok: false,
      message,
      reason: "business-data-request-failed",
      category: "api",
      diagnostic: { error: message },
      index: index + 1,
      total: targets.length
    });
  });

  const successCount = details.filter((detail) => detail.status === "ok").length;
  const failureCount = details.filter((detail) => !detail.ok).length;
  const partialCount = details.filter((detail) => detail.status === "partial").length;
  const partialSourceCount = details.filter((detail) => {
    const diagnostic = objectRecord(detail.diagnostic);
    return Number(diagnostic.blockingSourceFailureCount ?? diagnostic.sourceFailureCount ?? 0) > 0;
  }).length;
  const noMetricMatchCount = details.filter((detail) => objectRecord(objectRecord(detail.diagnostic).rowSummary).allUnavailable === true).length;
  const incompleteMetricCount = details.filter((detail) => {
    const diagnostic = objectRecord(detail.diagnostic);
    return Array.isArray(diagnostic.unavailableCriticalFields) && diagnostic.unavailableCriticalFields.length > 0;
  }).length;
  const coreIncompleteCount = details.filter((detail) => objectRecord(detail.diagnostic).coreMetricsComplete === false).length;
  const partialIssueCount = partialCount;
  const allFailed = targets.length > 0 && failureCount === targets.length;
  const resultStatus = allFailed ? "failed" : failureCount || partialIssueCount ? "partial" : "ok";
  const message = allFailed
    ? policyMessage(payload.adapter, "businessData.messages.failed", "Business data request failed")
    : failureCount
      ? policyMessage(payload.adapter, "businessData.messages.partial", "Business data synced with {failureCount} failures", { successCount, partialCount, failureCount })
    : partialIssueCount
      ? policyMessage(payload.adapter, "businessData.messages.partialMetrics", "Business data synced; {successCount} stores complete and {partialCount} stores partial", {
        successCount,
        partialCount,
        partialSourceCount,
        noMetricMatchCount,
        incompleteMetricCount
      })
      : policyMessage(payload.adapter, "businessData.messages.done", "Business data synced for {successCount} stores", { successCount });

  const cacheWriteCount = await saveBusinessLatestRows({
    rows,
    details,
    dateContext,
    adapterVersion,
    ruleVersion: scriptsVersion,
    fieldSchemaVersion: schemaVersion,
    requestPlanHash: planHash
  });
  const cacheSkippedCount = rows.length - cacheWriteCount;
  await cleanupBusinessLatestCache(adapterVersion, schemaVersion, planHash);

  const durationMs = Date.now() - startedAtMs;
  await reportDoudianDiagnostic({
    category: "doudian-business-data",
    event: "run-summary",
    runId,
    operationId: args.operationId || "",
    storeCount: targets.length,
    successCount,
    partialCount,
    failureCount,
    partialSourceCount,
    noMetricMatchCount,
    incompleteMetricCount,
    coreIncompleteCount,
    cacheWriteCount,
    cacheSkippedCount,
    dateRange: publicDateRange(dateContext),
    adapterVersion,
    fieldSchemaVersion: schemaVersion,
    durationMs
  }, true);

  return {
    ok: resultStatus === "ok",
    status: resultStatus,
    message,
    runId,
    operationId: args.operationId,
    rows,
    details,
    successCount,
    failureCount,
    partialCount,
    partialSourceCount,
    noMetricMatchCount,
    incompleteMetricCount,
    coreIncompleteCount,
    cacheWriteCount,
    cacheSkippedCount,
    durationMs,
    dateRange: publicDateRange(dateContext),
    adapterVersion,
    scriptsVersion,
    stores,
    groups: ledger.groups || []
  };
}

export async function fetchBusinessDataLatest(args: BusinessDataArgs = {}): Promise<DoudianBusinessDataResult> {
  const payload = adapterPayload(args);
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds || []);
  const targetIds = new Set(targets.map((store) => store.shopId));
  const dateContext = dataDateContext(args, payload.adapter);
  const planKeys = requestPlanKeys(payload.adapter);
  const adapterVersion = payload.adapter.version || "";
  const schemaVersion = fieldSchemaVersion(payload.adapter);
  const planHash = requestPlanHash(planKeys);
  const ids = targets.map((store) => latestId(store.shopId, dateContext, adapterVersion, schemaVersion, planHash));
  const rows = (await repositoryGetMany<BusinessLatestRecord>("business_latest", ids))
    .filter((record) => !targetIds.size || targetIds.has(record.shopId));
  void cleanupBusinessLatestCache(adapterVersion, schemaVersion, planHash).catch(() => undefined);
  const details: DoudianRunDetail[] = rows.map((record, index) => ({
    shopId: record.shopId,
    shopName: record.shopName,
    status: record.quality || (record.ok ? "ok" : "failed"),
    ok: record.ok,
    message: record.message || (record.ok ? "Cached business data ready" : "Cached business data failed"),
    reason: record.quality === "partial" ? "business-data-cached-partial" : record.ok ? "" : "business-data-cached-failure",
    category: record.quality === "partial" ? "api-partial" : record.ok ? "" : "api",
    diagnostic: record.diagnostic,
    index: index + 1,
    total: rows.length
  }));

  return {
    ok: true,
    status: rows.length ? "ready" : "empty",
    message: rows.length ? `Read ${rows.length} cached business data rows` : "No cached business data",
    rows: rows.map((record) => record.row),
    details,
    dateRange: publicDateRange(dateContext),
    adapterVersion: rows[0]?.adapterVersion || adapterVersion,
    scriptsVersion: rows[0]?.scriptsVersion || payload.scripts?.version || "",
    stores,
    groups: ledger.groups || [],
    cached: true,
    cachedRows: rows
  };
}

export function runDoudianBusinessDataFixtureSelfCheck(adapter: DoudianAdapterConfig) {
  const fixtureStore: DoudianStoreSummary = {
    shopId: "business-fixture-self-check",
    shopName: "Business Fixture Self Check",
    platform: "doudian",
    partition: "persist:chihu-business-fixture-self-check",
    status: "online",
    groupName: "Self Check"
  };
  const fixtureRequestResults = (responses: Record<string, unknown>) => Object.fromEntries(Object.entries(responses).map(([key, data]) => [key, {
    ok: true,
    status: 200,
    source: key,
    data
  } satisfies RequestPlanResult]));
  const dateContext = dataDateContext({ datePreset: "today" }, adapter);
  const fixtureParsed = buildBusinessDataResult(
    fixtureStore,
    fixtureRequestResults(businessDataResponseFixture.responses),
    dateContext,
    adapter
  );
  const fixtureCases = Object.entries(businessDataResponseFixture.expected).map(([field, expected]) => ({
    field,
    expected,
    actual: fixtureParsed.row[field],
    available: fixtureParsed.metricSources[field]?.available === true
  }));
  const explicitZeroParsed = buildBusinessDataResult(
    fixtureStore,
    fixtureRequestResults(businessDataResponseFixture.explicitZeroResponses),
    dateContext,
    adapter
  );
  const explicitZeroSummary = rowSummary(explicitZeroParsed.row, explicitZeroParsed.metricSources);
  const explicitZeroOk = explicitZeroSummary.allZero === true && explicitZeroSummary.allUnavailable === false &&
    criticalBusinessFields(adapter).every((field) => explicitZeroParsed.metricSources[field]?.available === true);
  const fixtureOk = fixtureCases.every((item) => item.actual === item.expected && item.available);
  return {
    ok: fixtureOk && explicitZeroOk,
    fixtureOk,
    explicitZeroOk,
    cases: [...fixtureCases, { field: "explicit-zero-availability", expected: true, actual: explicitZeroOk }]
  };
}

export async function runDoudianBusinessDataSelfCheck(options: { doudianAdapter?: DoudianAdapterPayload } = {}) {
  const payload = adapterPayload({ doudianAdapter: options.doudianAdapter });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopId = `business-self-check-${suffix}`;
  const shopName = `Business Self Check ${suffix}`;
  const checkedContexts: DateContext[] = [];

  try {
    await upsertStoreLedger({
      shopId,
      shopName,
      platform: "doudian",
      partition: `persist:chihu-business-self-check-${suffix}`,
      status: "online",
      groupName: "Self Check",
      adapterVersion: payload.adapter.version
    });

    const fixtureCheck = runDoudianBusinessDataFixtureSelfCheck(payload.adapter);

    const cases = [
      { datePreset: "today", dealAmount: 12345 },
      { datePreset: "yesterday", dealAmount: 23456 },
      { datePreset: "7d", dealAmount: 34567 },
      { datePreset: "custom", beginDate: "2026-07-01", endDate: "2026-07-03", dealAmount: 45678 }
    ];

    const results = [];
    for (const item of cases) {
      const dateContext = dataDateContext(item, payload.adapter);
      checkedContexts.push(dateContext);
      const row = {
        ...emptyBusinessDataRow({
          shopId,
          shopName,
          platform: "doudian",
          partition: `persist:chihu-business-self-check-${suffix}`,
          status: "online",
          groupName: "Self Check"
        }),
        dealAmount: item.dealAmount,
        orderCount: 7,
        customerPrice: item.dealAmount / 7,
        datePreset: dateContext.datePreset,
        beginDate: dateContext.beginDate,
        endDate: dateContext.endDate
      };
      const fetched = await fetchBusinessData({
        doudianAdapter: payload,
        shopIds: [shopId],
        datePreset: item.datePreset,
        beginDate: item.beginDate,
        endDate: item.endDate,
        mockRows: [row]
      });
      const latest = await fetchBusinessDataLatest({
        doudianAdapter: payload,
        shopIds: [shopId],
        datePreset: item.datePreset,
        beginDate: item.beginDate,
        endDate: item.endDate
      });
      results.push({
        preset: item.datePreset,
        fetchOk: fetched.ok === true,
        latestOk: latest.ok === true && latest.rows?.[0]?.shopId === shopId && latest.rows?.[0]?.dealAmount === item.dealAmount,
        metadataOk: latest.adapterVersion === payload.adapter.version && latest.scriptsVersion === (payload.scripts?.version || ""),
        dateRangeOk: latest.dateRange?.beginDate === dateContext.beginDate && latest.dateRange?.endDate === dateContext.endDate
      });
    }

    return {
      ok: fixtureCheck.ok && results.every((item) => item.fetchOk && item.latestOk && item.metadataOk && item.dateRangeOk),
      fixtureOk: fixtureCheck.fixtureOk,
      explicitZeroOk: fixtureCheck.explicitZeroOk,
      latestOk: results.every((item) => item.latestOk),
      datePresetOk: results.every((item) => item.dateRangeOk),
      metadataOk: results.every((item) => item.metadataOk),
      cases: [...fixtureCheck.cases, ...results]
    };
  } finally {
    await deleteStoreLedger([shopId]).catch(() => undefined);
    const planKeys = requestPlanKeys(payload.adapter);
    const adapterVersion = payload.adapter.version || "";
    const schemaVersion = fieldSchemaVersion(payload.adapter);
    const planHash = requestPlanHash(planKeys);
    await Promise.all(checkedContexts.map((context) => repositoryDelete("business_latest", latestId(shopId, context, adapterVersion, schemaVersion, planHash)).catch(() => undefined)));
  }
}
