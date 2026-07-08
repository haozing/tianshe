import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianBusinessDataResult,
  DoudianBusinessDataRow,
  DoudianRunDetail,
  DoudianStoreSummary
} from "../../types";
import { repositoryDelete, repositoryGetAll, repositoryPut } from "./repository";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";

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
}

interface BusinessLatestRecord {
  id: string;
  shopId: string;
  shopName: string;
  ok: boolean;
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
  path?: string;
  alias?: string;
  formula?: string;
}

interface BusinessMetric {
  value: number;
  source: MetricSource;
}

interface SourceFailure {
  key?: string;
  status?: number;
  code?: unknown;
  message?: string;
  optional?: boolean;
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

function businessFieldScale(adapter: DoudianAdapterConfig, field: BusinessField) {
  const scales = objectRecord(businessDataMappings(adapter).fieldScales);
  const config = businessFieldConfig(adapter, field);
  const value = Number(config.scale || scales[field] || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function coerceBusinessNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "val", "amount", "count", "cnt", "num", "score", "rate", "total", "text"]) {
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
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
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
  "metricKey",
  "metric_key",
  "dataIndex",
  "data_index",
  "column",
  "columnKey",
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
    if (alias) return { value: nextValue, alias };
  }
  for (const nextValue of Object.values(record)) {
    const next = findDeepByAlias(nextValue, aliasLookup, depth + 1);
    if (next) return next;
  }
  return null;
}

function businessResponsePayload(responses: Record<string, RequestPlanResult>) {
  const payload: Record<string, unknown> = { responses };
  for (const [key, response] of Object.entries(responses)) payload[key] = response.data;
  return payload;
}

function readBusinessMetric(payload: Record<string, unknown>, adapter: DoudianAdapterConfig, field: BusinessField): BusinessMetric {
  const scale = businessFieldScale(adapter, field);
  for (const path of businessFieldPaths(adapter, field)) {
    const value = getPathValue(payload, path);
    const number = coerceBusinessNumber(value);
    if (number !== undefined) {
      return {
        value: number / scale,
        source: { value: number / scale, source: "path", path }
      };
    }
  }

  const aliases = businessFieldAliases(adapter, field);
  if (aliases.length) {
    const aliasLookup = new Map<string, string>();
    for (const alias of aliases) {
      const normalized = normalizeAliasKey(alias);
      if (normalized && !aliasLookup.has(normalized)) aliasLookup.set(normalized, alias);
    }
    const match = findDeepByAlias(payload, aliasLookup);
    const number = coerceBusinessNumber(match?.value);
    if (number !== undefined) {
      return {
        value: number / scale,
        source: { value: number / scale, source: "alias", alias: match?.alias }
      };
    }
  }

  return { value: 0, source: { value: 0, source: "none" } };
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

function rowSummary(row: DoudianBusinessDataRow) {
  const nonZeroFields = BUSINESS_DATA_FIELDS.filter((field) => Number(row[field] || 0) !== 0);
  return {
    nonZeroFieldCount: nonZeroFields.length,
    nonZeroFields,
    allZero: nonZeroFields.length === 0
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
    success: requestPlanResponseOk(response, adapter, key, businessDataMappings(adapter)),
    code: responseCode(response) ?? null,
    message: responseMessage(response).slice(0, 160)
  }]));
}

function summarizeFailures(summary: Record<string, { status: number; success: boolean; code: unknown; message: string }>, adapter: DoudianAdapterConfig): SourceFailure[] {
  const optionalPlans = new Set(policyArray(adapter, "businessData.optionalPlans"));
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
    metricSources.customerPrice = { value: row.customerPrice, source: "derived", formula: "dealAmount/orderCount" };
  }
  if (!row.refundRate && row.orderCount > 0 && row.refundOrderCount > 0) {
    row.refundRate = (row.refundOrderCount / row.orderCount) * 100;
    metricSources.refundRate = { value: row.refundRate, source: "derived", formula: "refundOrderCount/orderCount*100" };
  }
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

function latestId(shopId: string, dateContext: DateContext) {
  return `${shopId}::${dateContext.datePreset}::${dateContext.beginDate}::${dateContext.endDate}`;
}

function requestPlanHash(planKeys: string[]) {
  return planKeys.join("|");
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

async function collectStoreBusinessData(payload: DoudianAdapterPayload, store: DoudianStoreSummary, planKeys: string[], dateContext: DateContext, index: number, total: number) {
  if (!store.partition) throw new Error("store partition missing");
  const responses: Record<string, RequestPlanResult> = {};
  const context = {
    ...dateContext,
    shopId: store.shopId,
    shopName: store.shopName
  };

  for (const planKey of planKeys) {
    responses[planKey] = await runDoudianRequestPlan(payload, {
      partition: store.partition,
      planKey,
      context
    });
  }

  const { row, metricSources } = buildBusinessDataResult(store, responses, dateContext, payload.adapter);
  const responseSummary = summarizeResponses(responses, payload.adapter);
  const sourceFailures = summarizeFailures(responseSummary, payload.adapter);
  const blockingSourceFailures = sourceFailures.filter((failure) => !failure.optional);
  const summary = rowSummary(row);
  const requiredPlans = policyArray(payload.adapter, "businessData.requiredPlans");
  const missingRequiredPlans = requiredPlans.filter((planKey) => requestPlanResponseOk(responses[planKey], payload.adapter, planKey, businessDataMappings(payload.adapter)) !== true);
  const okCount = Object.entries(responses).filter(([key, response]) => requestPlanResponseOk(response, payload.adapter, key, businessDataMappings(payload.adapter))).length;
  const ok = requiredPlans.length ? missingRequiredPlans.length === 0 : okCount > 0;
  const partial = ok && (blockingSourceFailures.length > 0 || summary.allZero);
  const message = !ok
    ? sourceFailures.find((failure) => !failure.optional)?.message || policyMessage(payload.adapter, "businessData.messages.failed", "Business data request failed")
    : blockingSourceFailures.length
      ? policyMessage(payload.adapter, "businessData.messages.partialSourceStore", "Business data synced with partial source errors")
      : summary.allZero
        ? policyMessage(payload.adapter, "businessData.messages.noMetricMatchStore", "Business data synced but no metric fields matched")
        : policyMessage(payload.adapter, "businessData.messages.synced", "Business data synced");
  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (partial ? "partial" : "ok") : "failed",
    ok,
    message,
    reason: ok ? (blockingSourceFailures.length ? "business-data-partial-source-failure" : summary.allZero ? "business-data-no-metric-match" : "") : "business-data-request-failed",
    category: ok ? (partial ? "api-partial" : "") : "api",
    diagnostic: {
      responses: responseSummary,
      okCount,
      requiredPlans,
      missingRequiredPlans,
      sourceFailureCount: sourceFailures.length,
      blockingSourceFailureCount: blockingSourceFailures.length,
      sourceFailures,
      rowSummary: summary,
      metricSources,
      datePreset: dateContext.datePreset,
      beginDate: dateContext.beginDate,
      endDate: dateContext.endDate
    },
    index,
    total
  };

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
}) {
  const detailById = new Map(args.details.map((detail) => [text(detail.shopId), detail]));
  const updatedAt = nowIso();
  for (const row of args.rows) {
    const detail = detailById.get(row.shopId);
    await repositoryPut<BusinessLatestRecord>("business_latest", {
      id: latestId(row.shopId, args.dateContext),
      shopId: row.shopId,
      shopName: row.shopName,
      ok: detail?.ok !== false,
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
    });
  }
}

function adapterPayload(args: BusinessDataArgs): DoudianAdapterPayload {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  return args.doudianAdapter;
}

export async function fetchBusinessData(args: BusinessDataArgs = {}): Promise<DoudianBusinessDataResult> {
  const payload = adapterPayload(args);
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds || []);
  const dateContext = dataDateContext(args, payload.adapter);
  const planKeys = requestPlanKeys(payload.adapter);
  const adapterVersion = payload.adapter.version || "";
  const scriptsVersion = payload.scripts?.version || "";
  const runId = `business-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (args.mockRows?.length) {
    const rows = args.mockRows;
    const details = rows.map((row, index) => ({
      shopId: row.shopId,
      shopName: row.shopName,
      status: "ok",
      ok: true,
      message: "Mock business data synced",
      diagnostic: { rowSummary: rowSummary(row) },
      index: index + 1,
      total: rows.length
    }));
    await saveBusinessLatestRows({ rows, details, dateContext, adapterVersion, ruleVersion: scriptsVersion, requestPlanHash: "mock" });
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

  const defaultConcurrency = Math.max(1, Math.min(8, Math.floor(policyNumber(payload.adapter, "businessData.concurrency", 3))));
  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(args.concurrency || defaultConcurrency))));
  const settled = await mapWithConcurrency(targets, concurrency, async (store, index) => collectStoreBusinessData(payload, store, planKeys, dateContext, index + 1, targets.length));
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

  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.filter((detail) => !detail.ok).length;
  const partialSourceCount = details.filter((detail) => {
    const diagnostic = objectRecord(detail.diagnostic);
    return Number(diagnostic.blockingSourceFailureCount ?? diagnostic.sourceFailureCount ?? 0) > 0;
  }).length;
  const noMetricMatchCount = details.filter((detail) => objectRecord(objectRecord(detail.diagnostic).rowSummary).allZero === true).length;
  const partialIssueCount = partialSourceCount + noMetricMatchCount;
  const message = failureCount
    ? policyMessage(payload.adapter, "businessData.messages.partial", "Business data synced with {failureCount} failures", { successCount, failureCount })
    : partialIssueCount
      ? policyMessage(payload.adapter, "businessData.messages.partialSources", "Business data synced; {partialSourceCount} stores have source issues, {noMetricMatchCount} stores have no metric match", {
        successCount,
        partialSourceCount,
        noMetricMatchCount
      })
      : policyMessage(payload.adapter, "businessData.messages.done", "Business data synced for {successCount} stores", { successCount });

  await saveBusinessLatestRows({
    rows,
    details,
    dateContext,
    adapterVersion,
    ruleVersion: scriptsVersion,
    requestPlanHash: requestPlanHash(planKeys)
  });

  return {
    ok: failureCount === 0,
    status: failureCount || partialIssueCount ? "partial" : "ok",
    message,
    runId,
    operationId: args.operationId,
    rows,
    details,
    successCount,
    failureCount,
    partialSourceCount,
    noMetricMatchCount,
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
  const rows = (await repositoryGetAll<BusinessLatestRecord>("business_latest"))
    .filter((record) => record.datePreset === dateContext.datePreset && record.beginDate === dateContext.beginDate && record.endDate === dateContext.endDate)
    .filter((record) => !targetIds.size || targetIds.has(record.shopId));
  const details: DoudianRunDetail[] = rows.map((record, index) => ({
    shopId: record.shopId,
    shopName: record.shopName,
    status: record.ok ? "ok" : "failed",
    ok: record.ok,
    message: record.message || (record.ok ? "Cached business data ready" : "Cached business data failed"),
    reason: record.ok ? "" : "business-data-cached-failure",
    category: record.ok ? "" : "api",
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
    adapterVersion: rows[0]?.adapterVersion || payload.adapter.version || "",
    scriptsVersion: rows[0]?.scriptsVersion || payload.scripts?.version || "",
    stores,
    groups: ledger.groups || [],
    cached: true,
    cachedRows: rows
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
      ok: results.every((item) => item.fetchOk && item.latestOk && item.metadataOk && item.dateRangeOk),
      latestOk: results.every((item) => item.latestOk),
      datePresetOk: results.every((item) => item.dateRangeOk),
      metadataOk: results.every((item) => item.metadataOk),
      cases: results
    };
  } finally {
    await deleteStoreLedger([shopId]).catch(() => undefined);
    await Promise.all(checkedContexts.map((context) => repositoryDelete("business_latest", latestId(shopId, context)).catch(() => undefined)));
  }
}
