import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianFundsDataResult,
  DoudianFundsDataRow,
  DoudianRunDetail,
  DoudianStoreSummary
} from "../../types";
import { repositoryDelete, repositoryGetAll, repositoryPut } from "./repository";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";

const FUNDS_DATA_FIELDS = [
  "withdrawBalance",
  "balance",
  "frozenBalance",
  "pendingSettleAmount",
  "marginBalance",
  "depositPayable",
  "refundableMargin",
  "baseMarginBalance",
  "baseDepositPayable",
  "baseRefundableMargin",
  "experienceMarginBalance",
  "experienceDepositPayable",
  "experienceRefundableMargin",
  "subsidyTotal",
  "commissionSubsidy",
  "qianchuanSubsidy",
  "compensationOrderCountToday",
  "compensationOrderCount7d",
  "compensationAmountToday",
  "compensationAmount7d",
  "pendingSettleOrderAmount",
  "pendingSettleOrders",
  "riskCount"
] as const;

type FundsField = typeof FUNDS_DATA_FIELDS[number];

interface FundsDataArgs {
  doudianAdapter?: DoudianAdapterPayload;
  shopIds?: string[];
  datePreset?: string;
  beginDate?: string;
  endDate?: string;
  operationId?: string;
  concurrency?: number;
  mockRows?: DoudianFundsDataRow[];
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

interface FundsLatestRecord {
  id: string;
  shopId: string;
  shopName: string;
  ok: boolean;
  message: string;
  row: DoudianFundsDataRow;
  diagnostic?: unknown;
  datePreset: string;
  beginDate: string;
  endDate: string;
  dateRange: DateContext;
  adapterVersion: string;
  ruleVersion: string;
  scriptsVersion: string;
  fieldSchemaVersion: string;
  requestPlanHash: string;
  updatedAt: string;
}

interface SourceFailure {
  key?: string;
  optional?: boolean;
  critical?: boolean;
  diagnosticOnly?: boolean;
  countsAsSuccess?: boolean;
  status?: number;
  code?: unknown;
  message?: string;
}

function nowIso() {
  return new Date().toISOString();
}

function text(value: unknown) {
  return String(value || "").trim();
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

function policyArrayRaw(adapter: DoudianAdapterConfig, path: string): unknown[] {
  const value = policy(adapter, path, []);
  return Array.isArray(value) ? value : [];
}

function policyArray(adapter: DoudianAdapterConfig, path: string): string[] {
  return policyArrayRaw(adapter, path).map((item) => text(item)).filter(Boolean);
}

function policyText(adapter: DoudianAdapterConfig, path: string, fallback = "") {
  const value = policy(adapter, path, fallback);
  return value == null ? fallback : String(value);
}

function policyNumber(adapter: DoudianAdapterConfig, path: string, fallback: number) {
  const value = Number(policy(adapter, path, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function policyBool(adapter: DoudianAdapterConfig, path: string, fallback = false) {
  const value = policy(adapter, path, fallback);
  return typeof value === "boolean" ? value : fallback;
}

function policyMessage(adapter: DoudianAdapterConfig, path: string, fallback: string, values: Record<string, unknown> = {}) {
  return policyText(adapter, path, fallback).replace(/\{([^}]+)\}/g, (_match, key) => String(values[key] ?? ""));
}

function dataPresetPolicy(adapter: DoudianAdapterConfig, preset: string) {
  const presets = objectRecord(policy(adapter, "fundsData.datePresets", {}));
  const direct = objectRecord(presets[preset]);
  if (Object.keys(direct).length) return direct;
  const matched = Object.values(presets).find((item) => {
    const config = objectRecord(item);
    return text(config.dateType) === preset || text(config.legacyDateType) === preset || text(config.legacyActiveKey) === preset;
  });
  return objectRecord(matched);
}

function dataPresetText(adapter: DoudianAdapterConfig, preset: string, key: string, fallback = "") {
  const value = dataPresetPolicy(adapter, preset)[key];
  return value == null ? fallback : String(value);
}

function dataPresetNumber(adapter: DoudianAdapterConfig, preset: string, key: string, fallback: number) {
  const value = Number(dataPresetPolicy(adapter, preset)[key]);
  return Number.isFinite(value) ? value : fallback;
}

function resolveDatePreset(adapter: DoudianAdapterConfig, value = "snapshot") {
  const key = text(value) || "snapshot";
  const presets = objectRecord(policy(adapter, "fundsData.datePresets", {}));
  if (presets[key]) return key;
  const matched = Object.entries(presets).find(([, item]) => {
    const config = objectRecord(item);
    return text(config.dateType) === key || text(config.legacyDateType) === key || text(config.legacyActiveKey) === key;
  });
  return matched ? matched[0] : key;
}

function fundsDateContext(args: FundsDataArgs, adapter: DoudianAdapterConfig): DateContext {
  const preset = resolveDatePreset(adapter, args.datePreset || "snapshot");
  const today = new Date();
  let beginDate = validIsoDate(args.beginDate);
  let endDate = validIsoDate(args.endDate);
  if (!beginDate || !endDate) {
    const fallbackStart = preset === "7d" ? -6 : preset === "30d" ? -29 : 0;
    const fallbackEnd = 0;
    beginDate = formatLocalIsoDate(addDateDays(today, dataPresetNumber(adapter, preset, "startOffsetDays", fallbackStart)));
    endDate = formatLocalIsoDate(addDateDays(today, dataPresetNumber(adapter, preset, "endOffsetDays", fallbackEnd)));
    if (dataPresetPolicy(adapter, preset).sameDay === true) endDate = beginDate;
  }

  const dateType = dataPresetText(adapter, preset, "dateType", policyText(adapter, `fundsData.datePresetMap.${preset}`, preset));
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

function fundsDataMappings(adapter: DoudianAdapterConfig) {
  return objectRecord(responseMappings(adapter).fundsData);
}

function fundsFieldConfig(adapter: DoudianAdapterConfig, field: FundsField) {
  const fields = objectRecord(fundsDataMappings(adapter).fields);
  const value = fields[field];
  if (Array.isArray(value)) return { paths: value };
  return objectRecord(value);
}

function fundsFieldPaths(adapter: DoudianAdapterConfig, field: FundsField) {
  const paths = fundsFieldConfig(adapter, field).paths;
  return Array.isArray(paths) ? paths.map((item) => text(item)).filter(Boolean) : [];
}

function fundsFieldAliases(adapter: DoudianAdapterConfig, field: FundsField) {
  const aliases = fundsFieldConfig(adapter, field).aliases;
  return Array.isArray(aliases) ? aliases.map((item) => text(item)).filter(Boolean) : [];
}

function fundsFieldScale(adapter: DoudianAdapterConfig, field: FundsField) {
  const scales = objectRecord(fundsDataMappings(adapter).fieldScales);
  const config = fundsFieldConfig(adapter, field);
  const value = Number(config.scale || scales[field] || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function coerceNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "val", "amount", "count", "cnt", "num", "score", "rate", "total", "text"]) {
      if (record[key] !== undefined) {
        const next = coerceNumber(record[key]);
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
  if (descriptorAlias && coerceNumber(record) !== undefined) return { value: record, alias: descriptorAlias };
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

function fundsMetricValue(value: unknown, fieldConfig: Record<string, unknown>, scale: number) {
  const number = coerceNumber(value);
  return number !== undefined ? number / scale : undefined;
}

function readFundsMetric(payload: Record<string, unknown>, adapter: DoudianAdapterConfig, field: FundsField) {
  const config = fundsFieldConfig(adapter, field);
  const scale = fundsFieldScale(adapter, field);
  for (const path of fundsFieldPaths(adapter, field)) {
    const value = getPathValue(payload, path);
    const number = fundsMetricValue(value, config, scale);
    if (number !== undefined) return { value: number, source: { value: number, source: "path", path } };
  }
  const aliases = fundsFieldAliases(adapter, field);
  if (aliases.length) {
    const aliasLookup = new Map<string, string>();
    for (const alias of aliases) {
      const normalized = normalizeAliasKey(alias);
      if (normalized && !aliasLookup.has(normalized)) aliasLookup.set(normalized, alias);
    }
    const match = findDeepByAlias(payload, aliasLookup);
    const number = fundsMetricValue(match?.value, config, scale);
    if (number !== undefined) return { value: number, source: { value: number, source: "alias", alias: match?.alias } };
  }
  return { value: 0, source: { value: 0, source: "none" } };
}

function emptyFundsDataRow(store: DoudianStoreSummary): DoudianFundsDataRow {
  return {
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    status: store.status,
    withdrawBalance: 0,
    balance: 0,
    frozenBalance: 0,
    pendingSettleAmount: 0,
    marginBalance: 0,
    depositPayable: 0,
    refundableMargin: 0,
    baseMarginBalance: 0,
    baseDepositPayable: 0,
    baseRefundableMargin: 0,
    experienceMarginBalance: 0,
    experienceDepositPayable: 0,
    experienceRefundableMargin: 0,
    subsidyTotal: 0,
    commissionSubsidy: 0,
    qianchuanSubsidy: 0,
    compensationOrderCountToday: 0,
    compensationOrderCount7d: 0,
    compensationAmountToday: 0,
    compensationAmount7d: 0,
    pendingSettleOrderAmount: 0,
    pendingSettleOrders: 0,
    riskCount: 0
  };
}

function rowNumber(row: DoudianFundsDataRow, key: string) {
  const value = Number(row[key] || 0);
  return Number.isFinite(value) ? value : 0;
}

function derivedFieldConfigs(adapter: DoudianAdapterConfig) {
  const configs = policyArrayRaw(adapter, "fundsData.derivedFields");
  if (configs.length) {
    return configs
      .map((item) => objectRecord(item))
      .filter((config) => FUNDS_DATA_FIELDS.includes(String(config.key || "") as FundsField))
      .map((config) => ({
        key: String(config.key) as FundsField,
        formula: String(config.formula || "sum"),
        sources: Array.isArray(config.sources) ? config.sources.map((item) => text(item)).filter(Boolean) : [],
        onlyWhenZero: config.onlyWhenZero !== false
      }));
  }
  return [
    { key: "marginBalance" as FundsField, formula: "sum", sources: ["baseMarginBalance", "experienceMarginBalance"], onlyWhenZero: true },
    { key: "depositPayable" as FundsField, formula: "sum", sources: ["baseDepositPayable", "experienceDepositPayable"], onlyWhenZero: true },
    { key: "refundableMargin" as FundsField, formula: "sum", sources: ["baseRefundableMargin", "experienceRefundableMargin"], onlyWhenZero: true },
    { key: "subsidyTotal" as FundsField, formula: "sum", sources: ["commissionSubsidy", "qianchuanSubsidy"], onlyWhenZero: true },
    { key: "riskCount" as FundsField, formula: "countPositive", sources: ["frozenBalance", "depositPayable", "compensationAmountToday"], onlyWhenZero: true }
  ];
}

function applyDerivedFields(row: DoudianFundsDataRow, metricSources: Record<string, Record<string, unknown>>, adapter: DoudianAdapterConfig) {
  for (const config of derivedFieldConfigs(adapter)) {
    if (!config.sources.length) continue;
    if (config.onlyWhenZero && rowNumber(row, config.key) !== 0) continue;
    const value = config.formula === "countPositive"
      ? config.sources.filter((source) => rowNumber(row, source) > 0).length
      : config.formula === "subtract"
        ? config.sources.reduce((nextValue, source, index) => index === 0 ? rowNumber(row, source) : nextValue - rowNumber(row, source), 0)
        : config.sources.reduce((sum, source) => sum + rowNumber(row, source), 0);
    row[config.key] = value;
    metricSources[config.key] = { value, source: "derived", formula: config.formula, sources: config.sources };
  }
}

function responsePayload(responses: Record<string, RequestPlanResult>) {
  const payload: Record<string, unknown> = { responses };
  for (const [key, response] of Object.entries(responses)) payload[key] = response.data;
  return payload;
}

function buildFundsDataResult(store: DoudianStoreSummary, responses: Record<string, RequestPlanResult>, adapter: DoudianAdapterConfig) {
  const payload = responsePayload(responses);
  const row = emptyFundsDataRow(store);
  const metricSources: Record<string, Record<string, unknown>> = {};
  for (const field of FUNDS_DATA_FIELDS) {
    const metric = readFundsMetric(payload, adapter, field);
    row[field] = metric.value;
    metricSources[field] = metric.source;
  }
  applyDerivedFields(row, metricSources, adapter);
  return { row, metricSources };
}

function responseCode(response: RequestPlanResult) {
  return firstPathValue(response.data, ["code", "st", "status_code", "statusCode", "errno"]);
}

function responseMessage(response: RequestPlanResult) {
  return text(firstPathValue(response.data, ["msg", "message", "status_msg", "statusMessage"]) || response.error || "");
}

function planDiagnosticOnly(adapter: DoudianAdapterConfig, planKey: string) {
  const plan = objectRecord(adapter.requestPlans?.[planKey]);
  return plan.diagnosticOnly === true || policyArray(adapter, "fundsData.diagnosticPlans").includes(planKey);
}

function planCountsAsSuccess(adapter: DoudianAdapterConfig, planKey: string) {
  const plan = objectRecord(adapter.requestPlans?.[planKey]);
  return plan.countsAsSuccess !== false && !planDiagnosticOnly(adapter, planKey);
}

function summarizeResponses(responses: Record<string, RequestPlanResult>, adapter: DoudianAdapterConfig) {
  return Object.fromEntries(Object.entries(responses).map(([key, response]) => [key, {
    status: response.status || 0,
    success: requestPlanResponseOk(response, adapter, key, fundsDataMappings(adapter)),
    countsAsSuccess: planCountsAsSuccess(adapter, key),
    diagnosticOnly: planDiagnosticOnly(adapter, key),
    code: responseCode(response) ?? null,
    message: responseMessage(response).slice(0, 160)
  }]));
}

function summarizeFailures(summary: Record<string, { status: number; success: boolean; countsAsSuccess: boolean; diagnosticOnly: boolean; code: unknown; message: string }>, adapter: DoudianAdapterConfig): SourceFailure[] {
  const optionalPlans = new Set(policyArray(adapter, "fundsData.optionalPlans"));
  const criticalPlans = new Set(policyArray(adapter, "fundsData.criticalPlans"));
  return Object.entries(summary)
    .filter(([, response]) => response.success !== true)
    .map(([key, response]) => ({
      key,
      optional: optionalPlans.has(key),
      critical: criticalPlans.has(key),
      diagnosticOnly: response.diagnosticOnly === true,
      countsAsSuccess: response.countsAsSuccess !== false,
      status: response.status || 0,
      code: response.code,
      message: response.message || ""
    }));
}

function firstErrorMessage(responses: Record<string, RequestPlanResult>, adapter: DoudianAdapterConfig) {
  const entries = Object.entries(responses);
  const criticalPlans = new Set(policyArray(adapter, "fundsData.criticalPlans"));
  const ordered = [
    ...entries.filter(([key]) => criticalPlans.has(key)),
    ...entries.filter(([key]) => !criticalPlans.has(key) && planCountsAsSuccess(adapter, key))
  ];
  for (const [key, response] of ordered) {
    if (requestPlanResponseOk(response, adapter, key, fundsDataMappings(adapter))) continue;
    const message = responseMessage(response);
    if (message) return message.slice(0, 160);
    if (response.status) return `HTTP ${response.status}`;
  }
  return "";
}

function rowSummary(row: DoudianFundsDataRow) {
  const nonZeroFields = FUNDS_DATA_FIELDS.filter((field) => Number(row[field] || 0) !== 0);
  return {
    nonZeroFieldCount: nonZeroFields.length,
    nonZeroFields,
    allZero: nonZeroFields.length === 0
  };
}

function requestPlanKeys(adapter: DoudianAdapterConfig) {
  const policyPlans = policyArray(adapter, "fundsData.requestPlans");
  if (policyPlans.length) return Array.from(new Set(policyPlans));
  const operationPlans = objectRecord(adapter.operationPlans);
  const fetchPlan = objectRecord(operationPlans.fetchFundsData);
  const actions = Array.isArray(fetchPlan.actions) ? fetchPlan.actions : [];
  return Array.from(new Set(actions.flatMap((action) => {
    const record = objectRecord(action);
    if (Array.isArray(record.requestPlans)) return record.requestPlans.map((item) => text(item)).filter(Boolean);
    return text(record.requestPlan) ? [text(record.requestPlan)] : [];
  })));
}

function fieldSchemaVersion(adapter: DoudianAdapterConfig) {
  return text(objectRecord(policy(adapter, "fundsData.fieldSchema", {})).version);
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
    plans: planKeys.map((key) => ({ key, endpoint: adapter.endpoints?.[text(objectRecord(adapter.requestPlans?.[key]).endpointKey || key)] || "", plan: adapter.requestPlans?.[key] || {} }))
  });
  let hash = 0;
  for (let index = 0; index < textValue.length; index += 1) hash = ((hash << 5) - hash + textValue.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function latestId(shopId: string, dateContext: DateContext, adapterVersion: string, schemaVersion: string) {
  return `${shopId}::${dateContext.datePreset}::${dateContext.beginDate}::${dateContext.endDate}::${adapterVersion}::${schemaVersion}`;
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

function targetStores(stores: DoudianStoreSummary[], shopIds: string[] = []) {
  const requested = new Set(shopIds.map((item) => text(item)).filter(Boolean));
  return requested.size ? stores.filter((store) => requested.has(store.shopId)) : stores;
}

async function collectFundsDataForStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, planKeys: string[], dateContext: DateContext, index: number, total: number) {
  if (!store.partition) throw new Error("store partition missing");
  const responses: Record<string, RequestPlanResult> = {};
  const context = { ...dateContext, shopId: store.shopId, shopName: store.shopName };
  for (const planKey of planKeys) {
    responses[planKey] = await runDoudianRequestPlan(payload, {
      partition: store.partition,
      planKey,
      context
    });
  }

  const { row, metricSources } = buildFundsDataResult(store, responses, payload.adapter);
  const responseSummary = summarizeResponses(responses, payload.adapter);
  const sourceFailures = summarizeFailures(responseSummary, payload.adapter);
  const blockingSourceFailures = sourceFailures.filter((failure) => !failure.optional);
  const summary = rowSummary(row);
  const requiredPlans = policyArray(payload.adapter, "fundsData.requiredPlans");
  const criticalPlans = policyArray(payload.adapter, "fundsData.criticalPlans");
  const successPlanKeys = Object.entries(responses)
    .filter(([key, response]) => requestPlanResponseOk(response, payload.adapter, key, fundsDataMappings(payload.adapter)))
    .map(([key]) => key);
  const countedSuccessPlanKeys = Object.entries(responses)
    .filter(([key, response]) => planCountsAsSuccess(payload.adapter, key) && requestPlanResponseOk(response, payload.adapter, key, fundsDataMappings(payload.adapter)))
    .map(([key]) => key);
  const missingRequiredPlans = requiredPlans.filter((planKey) => !requestPlanResponseOk(responses[planKey], payload.adapter, planKey, fundsDataMappings(payload.adapter)));
  const missingCriticalPlans = criticalPlans.filter((planKey) => !requestPlanResponseOk(responses[planKey], payload.adapter, planKey, fundsDataMappings(payload.adapter)));
  const ok = criticalPlans.length
    ? missingCriticalPlans.length === 0
    : requiredPlans.length
      ? missingRequiredPlans.length === 0
      : countedSuccessPlanKeys.length > 0;
  const partial = ok && (blockingSourceFailures.length > 0 || summary.allZero);
  const message = !ok
    ? (firstErrorMessage(responses, payload.adapter) || policyMessage(payload.adapter, "fundsData.messages.failed", "Funds data request failed"))
    : blockingSourceFailures.length
      ? policyMessage(payload.adapter, "fundsData.messages.partialSourceStore", "Funds data synced with partial source errors")
      : summary.allZero
        ? policyMessage(payload.adapter, "fundsData.messages.noMetricMatchStore", "Funds data synced but no metric fields matched")
        : policyMessage(payload.adapter, "fundsData.messages.synced", "Funds data synced");

  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (partial ? "partial" : "ok") : "failed",
    ok,
    message,
    reason: ok ? (blockingSourceFailures.length ? "funds-data-partial-source-failure" : summary.allZero ? "funds-data-no-metric-match" : "") : "funds-data-request-failed",
    category: ok ? (partial ? "api-partial" : "") : "api",
    diagnostic: {
      responses: responseSummary,
      okCount: countedSuccessPlanKeys.length,
      successPlanKeys,
      countedSuccessPlanKeys,
      requiredPlans,
      missingRequiredPlans,
      criticalPlans,
      missingCriticalPlans,
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

function adapterPayload(args: FundsDataArgs): DoudianAdapterPayload {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  return args.doudianAdapter;
}

async function saveFundsLatestRows(args: {
  rows: DoudianFundsDataRow[];
  details: DoudianRunDetail[];
  dateContext: DateContext;
  adapterVersion: string;
  ruleVersion: string;
  fieldSchemaVersion: string;
  requestPlanHash: string;
}) {
  const detailById = new Map(args.details.map((detail) => [text(detail.shopId), detail]));
  const updatedAt = nowIso();
  for (const row of args.rows) {
    const detail = detailById.get(row.shopId);
    await repositoryPut<FundsLatestRecord>("funds_latest", {
      id: latestId(row.shopId, args.dateContext, args.adapterVersion, args.fieldSchemaVersion),
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
      fieldSchemaVersion: args.fieldSchemaVersion,
      requestPlanHash: args.requestPlanHash,
      updatedAt
    });
  }
}

export async function fetchFundsData(args: FundsDataArgs = {}): Promise<DoudianFundsDataResult> {
  const payload = adapterPayload(args);
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds || []);
  const dateContext = fundsDateContext(args, payload.adapter);
  const planKeys = requestPlanKeys(payload.adapter);
  const adapterVersion = payload.adapter.version || "";
  const scriptsVersion = payload.scripts?.version || "";
  const schemaVersion = fieldSchemaVersion(payload.adapter);
  const hash = requestPlanHash(payload.adapter, planKeys);
  const runId = `funds-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (args.mockRows?.length) {
    const rows = args.mockRows;
    const details = rows.map((row, index) => ({
      shopId: row.shopId,
      shopName: row.shopName,
      status: "ok",
      ok: true,
      message: "Mock funds data synced",
      diagnostic: { rowSummary: rowSummary(row) },
      index: index + 1,
      total: rows.length
    }));
    await saveFundsLatestRows({ rows, details, dateContext, adapterVersion, ruleVersion: scriptsVersion, fieldSchemaVersion: schemaVersion, requestPlanHash: hash });
    return {
      ok: true,
      status: "ok",
      message: `Funds data synced for ${rows.length} stores`,
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
      fieldSchemaVersion: schemaVersion,
      requestPlanHash: hash,
      stores,
      groups: ledger.groups || []
    };
  }

  if (!planKeys.length) {
    return {
      ok: false,
      status: "missing-request-plans",
      message: "remote fetchFundsData operation missing request plans",
      rows: targets.map(emptyFundsDataRow),
      details: [],
      dateRange: publicDateRange(dateContext),
      adapterVersion,
      scriptsVersion,
      fieldSchemaVersion: schemaVersion,
      requestPlanHash: hash,
      stores,
      groups: ledger.groups || []
    };
  }

  const defaultConcurrency = Math.max(1, Math.min(8, Math.floor(policyNumber(payload.adapter, "fundsData.concurrency", 2))));
  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(args.concurrency || defaultConcurrency))));
  const settled = await mapWithConcurrency(targets, concurrency, async (store, index) => collectFundsDataForStore(payload, store, planKeys, dateContext, index + 1, targets.length));
  const rows: DoudianFundsDataRow[] = [];
  const details: DoudianRunDetail[] = [];

  settled.forEach((result, index) => {
    const store = targets[index];
    if (result.status === "fulfilled") {
      rows.push(result.value.row);
      details.push(result.value.detail);
      return;
    }
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason || "Funds data request failed");
    rows.push(emptyFundsDataRow(store));
    details.push({
      shopId: store.shopId,
      shopName: store.shopName,
      status: "failed",
      ok: false,
      message,
      reason: "funds-data-request-failed",
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
    ? policyMessage(payload.adapter, "fundsData.messages.partial", "Funds data synced with {failureCount} failures", { successCount, failureCount })
    : partialIssueCount
      ? policyMessage(payload.adapter, "fundsData.messages.partialSources", "Funds data synced; {partialSourceCount} stores have source issues, {noMetricMatchCount} stores have no metric match", {
        successCount,
        partialSourceCount,
        noMetricMatchCount
      })
      : policyMessage(payload.adapter, "fundsData.messages.done", "Funds data synced for {successCount} stores", { successCount });

  const rowsToSave = policyBool(payload.adapter, "fundsData.cachePolicy.skipAllZeroWhenCriticalMissing", false)
    ? rows.filter((row) => {
      const detail = details.find((item) => text(item.shopId) === row.shopId);
      const diagnostic = objectRecord(detail?.diagnostic);
      return !(objectRecord(diagnostic.rowSummary).allZero === true && Array.isArray(diagnostic.missingCriticalPlans) && diagnostic.missingCriticalPlans.length);
    })
    : rows;
  await saveFundsLatestRows({ rows: rowsToSave, details, dateContext, adapterVersion, ruleVersion: scriptsVersion, fieldSchemaVersion: schemaVersion, requestPlanHash: hash });

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
    fieldSchemaVersion: schemaVersion,
    requestPlanHash: hash,
    stores,
    groups: ledger.groups || []
  };
}

export async function fetchFundsDataLatest(args: FundsDataArgs = {}): Promise<DoudianFundsDataResult> {
  const payload = adapterPayload(args);
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds || []);
  const targetIds = new Set(targets.map((store) => store.shopId));
  const dateContext = fundsDateContext(args, payload.adapter);
  const schemaVersion = fieldSchemaVersion(payload.adapter);
  const rows = (await repositoryGetAll<FundsLatestRecord>("funds_latest"))
    .filter((record) => record.datePreset === dateContext.datePreset && record.beginDate === dateContext.beginDate && record.endDate === dateContext.endDate)
    .filter((record) => record.adapterVersion === (payload.adapter.version || "") && record.fieldSchemaVersion === schemaVersion)
    .filter((record) => !targetIds.size || targetIds.has(record.shopId));
  const details: DoudianRunDetail[] = rows.map((record, index) => ({
    shopId: record.shopId,
    shopName: record.shopName,
    status: record.ok ? "ok" : "failed",
    ok: record.ok,
    message: record.message || (record.ok ? "Cached funds data ready" : "Cached funds data failed"),
    reason: record.ok ? "" : "funds-data-cached-failure",
    category: record.ok ? "" : "api",
    diagnostic: record.diagnostic,
    index: index + 1,
    total: rows.length
  }));
  const planKeys = requestPlanKeys(payload.adapter);
  const hash = rows[0]?.requestPlanHash || requestPlanHash(payload.adapter, planKeys);

  return {
    ok: true,
    status: rows.length ? "ready" : "empty",
    message: rows.length ? `Read ${rows.length} cached funds data rows` : "No cached funds data",
    rows: rows.map((record) => record.row),
    details,
    dateRange: publicDateRange(dateContext),
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    fieldSchemaVersion: schemaVersion,
    requestPlanHash: hash,
    stores,
    groups: ledger.groups || [],
    cached: true,
    cachedRows: rows
  };
}

export async function runDoudianFundsDataSelfCheck(options: { doudianAdapter?: DoudianAdapterPayload } = {}) {
  const payload = adapterPayload({ doudianAdapter: options.doudianAdapter });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopId = `funds-self-check-${suffix}`;
  const shopName = `Funds Self Check ${suffix}`;
  const checkedContexts: DateContext[] = [];
  const schemaVersion = fieldSchemaVersion(payload.adapter);

  try {
    await upsertStoreLedger({
      shopId,
      shopName,
      platform: "doudian",
      partition: `persist:chihu-funds-self-check-${suffix}`,
      status: "online",
      groupName: "Self Check",
      adapterVersion: payload.adapter.version
    });

    const cases = [
      { datePreset: "snapshot", withdrawBalance: 1000 },
      { datePreset: "today", withdrawBalance: 2000 },
      { datePreset: "7d", withdrawBalance: 3000 }
    ];
    const results = [];
    for (const item of cases) {
      const dateContext = fundsDateContext(item, payload.adapter);
      checkedContexts.push(dateContext);
      const row = {
        ...emptyFundsDataRow({
          shopId,
          shopName,
          platform: "doudian",
          partition: `persist:chihu-funds-self-check-${suffix}`,
          status: "online",
          groupName: "Self Check"
        }),
        withdrawBalance: item.withdrawBalance,
        balance: item.withdrawBalance + 50,
        frozenBalance: item.datePreset === "7d" ? 25 : 0,
        datePreset: dateContext.datePreset,
        beginDate: dateContext.beginDate,
        endDate: dateContext.endDate
      };
      const fetched = await fetchFundsData({
        doudianAdapter: payload,
        shopIds: [shopId],
        datePreset: item.datePreset,
        mockRows: [row]
      });
      const latest = await fetchFundsDataLatest({
        doudianAdapter: payload,
        shopIds: [shopId],
        datePreset: item.datePreset
      });
      results.push({
        preset: item.datePreset,
        fetchOk: fetched.ok === true,
        latestOk: latest.ok === true && latest.rows?.[0]?.shopId === shopId && latest.rows?.[0]?.withdrawBalance === item.withdrawBalance,
        metadataOk: latest.adapterVersion === payload.adapter.version && latest.scriptsVersion === (payload.scripts?.version || "") && latest.fieldSchemaVersion === schemaVersion,
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
    await Promise.all(checkedContexts.map((context) => repositoryDelete("funds_latest", latestId(shopId, context, payload.adapter.version || "", schemaVersion)).catch(() => undefined)));
  }
}
