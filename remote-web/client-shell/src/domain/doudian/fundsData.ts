import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianFundsDataResult,
  DoudianFundsDataRow,
  DoudianRunDetail,
  DoudianStoreSummary
} from "../../types";
import {
  repositoryDelete,
  repositoryDeleteMany,
  repositoryGetAll,
  repositoryGetMany,
  repositoryPutMany
} from "./repository";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";
import { dispatchDoudianProgress } from "./progress";
import fundsResponseFixture from "./fixtures/fundsDataResponse.json";

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

const FUNDS_TEXT_FIELDS = [
  "accountName",
  "accountBank",
  "phone"
] as const;

type FundsTextField = typeof FUNDS_TEXT_FIELDS[number];
type FundsDataField = FundsField | FundsTextField;

interface FundsDataArgs {
  doudianAdapter?: DoudianAdapterPayload;
  shopIds?: string[];
  operationId?: string;
  concurrency?: number;
  includeDiagnostics?: boolean;
  mockRows?: DoudianFundsDataRow[];
  isCancelled?: () => boolean;
  trackWindow?: (winId: number) => void;
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
  status?: "ok" | "partial";
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
  metricUpdatedAt?: Partial<Record<FundsDataField, string>>;
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

interface MetricSource {
  value: number | string;
  source: "path" | "alias" | "derived" | "none";
  available: boolean;
  path?: string;
  alias?: string;
  planKey?: string;
  formula?: string;
  sources?: string[];
}

interface FundsInterfaceStat {
  requestCount: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  p95Ms: number;
}

const FUNDS_CURRENT_ID_PREFIX = "funds-current::";
let fundsCacheCleanupKey = "";
let fundsCacheCleanupPromise: Promise<void> | null = null;

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

function fundsDateContext(adapter: DoudianAdapterConfig): DateContext {
  const preset = resolveDatePreset(adapter, "snapshot");
  const today = new Date();
  const beginDate = formatLocalIsoDate(addDateDays(today, dataPresetNumber(adapter, preset, "startOffsetDays", 0)));
  const endDate = dataPresetPolicy(adapter, preset).sameDay === true
    ? beginDate
    : formatLocalIsoDate(addDateDays(today, dataPresetNumber(adapter, preset, "endOffsetDays", 0)));

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

function fundsFieldConfig(adapter: DoudianAdapterConfig, field: FundsDataField) {
  const fields = objectRecord(fundsDataMappings(adapter).fields);
  const value = fields[field];
  if (Array.isArray(value)) return { paths: value };
  return objectRecord(value);
}

function fundsFieldPaths(adapter: DoudianAdapterConfig, field: FundsDataField) {
  const paths = fundsFieldConfig(adapter, field).paths;
  return Array.isArray(paths) ? paths.map((item) => text(item)).filter(Boolean) : [];
}

function fundsFieldAliases(adapter: DoudianAdapterConfig, field: FundsDataField) {
  const aliases = fundsFieldConfig(adapter, field).aliases;
  return Array.isArray(aliases) ? aliases.map((item) => text(item)).filter(Boolean) : [];
}

function fundsFieldSourcePlans(adapter: DoudianAdapterConfig, field: FundsDataField) {
  const sourcePlans = fundsFieldConfig(adapter, field).sourcePlans;
  return Array.isArray(sourcePlans) ? sourcePlans.map((item) => text(item)).filter(Boolean) : [];
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

function moneyTextValue(value: unknown, scale: number) {
  const record = objectRecord(value);
  const structured = Object.keys(record).length > 0;
  const amount = record.amount ?? record.value ?? record.val ?? value;
  const number = coerceNumber(amount);
  if (number === undefined) return undefined;
  const unitText = `${String(amount ?? "")} ${String(record.unit ?? "")}`.replace(/\s+/g, "");
  if (unitText.includes("万")) return number * 10000;
  if (unitText.includes("分")) return number / 100;
  if (unitText.includes("角")) return number / 10;
  return structured || typeof value === "string" ? number : number / scale;
}

function fundsMetricValue(value: unknown, fieldConfig: Record<string, unknown>, scale: number) {
  if (fieldConfig.moneyText === true) return moneyTextValue(value, scale);
  const number = coerceNumber(value);
  return number !== undefined ? number / scale : undefined;
}

function readFundsMetric(payload: Record<string, unknown>, adapter: DoudianAdapterConfig, field: FundsField) {
  const config = fundsFieldConfig(adapter, field);
  const scale = fundsFieldScale(adapter, field);
  for (const path of fundsFieldPaths(adapter, field)) {
    const value = getPathValue(payload, path);
    const number = fundsMetricValue(value, config, scale);
    if (number !== undefined) return { value: number, source: { value: number, source: "path", path, available: true } satisfies MetricSource };
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
    if (number !== undefined) return { value: number, source: { value: number, source: "alias", alias: match?.alias, available: true } satisfies MetricSource };
  }
  return { value: 0, source: { value: 0, source: "none", available: false } satisfies MetricSource };
}

function readFundsText(payload: Record<string, unknown>, adapter: DoudianAdapterConfig, field: FundsTextField) {
  for (const path of fundsFieldPaths(adapter, field)) {
    const value = getPathValue(payload, path);
    if (value !== undefined && value !== null) {
      const next = text(value);
      return { value: next, source: { value: next, source: "path", path, available: true } satisfies MetricSource };
    }
  }
  const aliases = fundsFieldAliases(adapter, field);
  if (aliases.length) {
    const aliasLookup = new Map<string, string>();
    for (const alias of aliases) {
      const normalized = normalizeAliasKey(alias);
      if (normalized && !aliasLookup.has(normalized)) aliasLookup.set(normalized, alias);
    }
    const sourcePlans = fundsFieldSourcePlans(adapter, field);
    const roots = sourcePlans.length
      ? sourcePlans.map((planKey) => ({ planKey, value: payload[planKey] }))
      : [{ planKey: "", value: payload }];
    for (const root of roots) {
      const match = findDeepByAlias(root.value, aliasLookup);
      if (match?.value === undefined || match.value === null) continue;
      const next = text(match.value);
      return {
        value: next,
        source: {
          value: next,
          source: "alias",
          alias: match.alias,
          ...(root.planKey ? { planKey: root.planKey } : {}),
          available: true
        } satisfies MetricSource
      };
    }
  }
  return { value: "", source: { value: "", source: "none", available: false } satisfies MetricSource };
}

function emptyFundsDataRow(store: DoudianStoreSummary): DoudianFundsDataRow {
  return {
    shopId: store.shopId,
    shopName: store.shopName,
    group: store.groupName || "",
    status: store.status,
    accountName: "",
    accountBank: "",
    phone: "",
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

function applyDerivedFields(row: DoudianFundsDataRow, metricSources: Record<string, MetricSource>, adapter: DoudianAdapterConfig) {
  for (const config of derivedFieldConfigs(adapter)) {
    if (!config.sources.length) continue;
    if (config.onlyWhenZero && rowNumber(row, config.key) !== 0) continue;
    const value = config.formula === "countPositive" && config.key === "riskCount"
      ? fundsRiskCount(row)
      : config.formula === "countPositive"
        ? config.sources.filter((source) => rowNumber(row, source) > 0).length
      : config.formula === "subtract"
        ? config.sources.reduce((nextValue, source, index) => index === 0 ? rowNumber(row, source) : nextValue - rowNumber(row, source), 0)
        : config.sources.reduce((sum, source) => sum + rowNumber(row, source), 0);
    row[config.key] = value;
    metricSources[config.key] = {
      value,
      source: "derived",
      formula: config.formula,
      sources: config.sources,
      available: config.sources.every((source) => metricSources[source]?.available === true)
    };
  }
}

function fundsRiskCount(row: DoudianFundsDataRow) {
  return [
    rowNumber(row, "frozenBalance") > 0,
    rowNumber(row, "depositPayable") > 0,
    rowNumber(row, "marginBalance") < 0 || rowNumber(row, "experienceMarginBalance") < 0,
    rowNumber(row, "compensationAmountToday") !== 0 || rowNumber(row, "compensationAmount7d") !== 0
  ].filter(Boolean).length;
}

function applyZeroCountInferences(row: DoudianFundsDataRow, metricSources: Record<string, MetricSource>) {
  const orderCount = metricSources.pendingSettleOrders;
  const orderAmount = metricSources.pendingSettleOrderAmount;
  if (orderCount?.available !== true || row.pendingSettleOrders !== 0 || orderAmount?.available === true) return;
  row.pendingSettleOrderAmount = 0;
  metricSources.pendingSettleOrderAmount = {
    value: 0,
    source: "derived",
    formula: "zeroWhenCountZero",
    sources: ["pendingSettleOrders"],
    available: true
  };
}

function responsePayload(responses: Record<string, RequestPlanResult>) {
  const payload: Record<string, unknown> = { responses };
  for (const [key, response] of Object.entries(responses)) payload[key] = response.data;
  return payload;
}

function buildFundsDataResult(store: DoudianStoreSummary, responses: Record<string, RequestPlanResult>, adapter: DoudianAdapterConfig) {
  const payload = responsePayload(responses);
  const row = emptyFundsDataRow(store);
  const metricSources: Record<string, MetricSource> = {};
  for (const field of FUNDS_DATA_FIELDS) {
    const metric = readFundsMetric(payload, adapter, field);
    row[field] = metric.value;
    metricSources[field] = metric.source;
  }
  for (const field of FUNDS_TEXT_FIELDS) {
    const metric = readFundsText(payload, adapter, field);
    row[field] = metric.value;
    metricSources[field] = metric.source;
  }
  applyZeroCountInferences(row, metricSources);
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
    attemptCount: Math.max(1, Number(response.attemptCount || 1)),
    durationMs: Math.max(0, Number(response.durationMs || 0)),
    code: responseCode(response) ?? null,
    message: responseMessage(response).slice(0, 160)
  }]));
}

function percentile95(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 0;
}

function summarizeInterfaceStats(details: DoudianRunDetail[]) {
  const samples = new Map<string, Array<{ success: boolean; attemptCount: number; durationMs: number }>>();
  for (const detail of details) {
    const responses = objectRecord(objectRecord(detail.diagnostic).responses);
    for (const [planKey, value] of Object.entries(responses)) {
      const response = objectRecord(value);
      const list = samples.get(planKey) || [];
      list.push({
        success: response.success === true,
        attemptCount: Math.max(1, Number(response.attemptCount || 1)),
        durationMs: Math.max(0, Number(response.durationMs || 0))
      });
      samples.set(planKey, list);
    }
  }
  return Object.fromEntries([...samples.entries()].map(([planKey, list]) => [planKey, {
    requestCount: list.length,
    successCount: list.filter((item) => item.success).length,
    failureCount: list.filter((item) => !item.success).length,
    retryCount: list.reduce((sum, item) => sum + Math.max(0, item.attemptCount - 1), 0),
    p95Ms: percentile95(list.map((item) => item.durationMs))
  } satisfies FundsInterfaceStat]));
}

function fundsRunStatus(counts: { successCount: number; partialCount: number; failureCount: number; targetCount: number }) {
  const usableCount = counts.successCount + counts.partialCount;
  if (counts.targetCount > 0 && usableCount === 0) return "failed" as const;
  if (counts.partialCount > 0 || counts.failureCount > 0) return "partial" as const;
  return "ok" as const;
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

function displayMetricFields(adapter: DoudianAdapterConfig) {
  const schema = objectRecord(policy(adapter, "fundsData.fieldSchema", {}));
  const columns = Array.isArray(schema.columns) ? schema.columns : [];
  const fields = columns
    .map((column) => text(objectRecord(column).key))
    .filter((field): field is FundsField => FUNDS_DATA_FIELDS.includes(field as FundsField));
  return fields.length ? Array.from(new Set(fields)) : [...FUNDS_DATA_FIELDS];
}

function rowSummary(row: DoudianFundsDataRow, metricSources?: Record<string, MetricSource>, expectedFields: FundsField[] = [...FUNDS_DATA_FIELDS]) {
  const nonZeroFields = FUNDS_DATA_FIELDS.filter((field) => Number(row[field] || 0) !== 0);
  const availableFields = expectedFields.filter((field) => metricSources ? metricSources[field]?.available === true : true);
  const unavailableFields = expectedFields.filter((field) => !availableFields.includes(field));
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

function requestPlanKeys(adapter: DoudianAdapterConfig, includeDiagnostics = false) {
  const policyPlans = policyArray(adapter, "fundsData.requestPlans");
  if (policyPlans.length) return Array.from(new Set(policyPlans)).filter((key) => includeDiagnostics || !planDiagnosticOnly(adapter, key));
  const operationPlans = objectRecord(adapter.operationPlans);
  const fetchPlan = objectRecord(operationPlans.fetchFundsData);
  const actions = Array.isArray(fetchPlan.actions) ? fetchPlan.actions : [];
  return Array.from(new Set(actions.flatMap((action) => {
    const record = objectRecord(action);
    if (Array.isArray(record.requestPlans)) return record.requestPlans.map((item) => text(item)).filter(Boolean);
    return text(record.requestPlan) ? [text(record.requestPlan)] : [];
  }))).filter((key) => includeDiagnostics || !planDiagnosticOnly(adapter, key));
}

function requestPlanGroups(adapter: DoudianAdapterConfig, planKeys: string[]) {
  const requested = new Set(planKeys);
  const configured = policyArrayRaw(adapter, "fundsData.requestPlanGroups")
    .map((group) => Array.isArray(group) ? group.map((item) => text(item)).filter((key) => requested.has(key)) : [])
    .filter((group) => group.length);
  const grouped = new Set(configured.flat());
  const remaining = planKeys.filter((key) => !grouped.has(key));
  if (!configured.length) return planKeys.map((key) => [key]);
  return remaining.length ? [...configured, remaining] : configured;
}

function wait(ms: number) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
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

function requestPlanHash(adapter: DoudianAdapterConfig, planKeys: string[], scriptsVersion = "") {
  const textValue = stableStringify({
    adapterVersion: adapter.version || "",
    scriptsVersion,
    fieldSchemaVersion: fieldSchemaVersion(adapter),
    plans: planKeys.map((key) => ({ key, endpoint: adapter.endpoints?.[text(objectRecord(adapter.requestPlans?.[key]).endpointKey || key)] || "", plan: adapter.requestPlans?.[key] || {} })),
    mappings: fundsDataMappings(adapter),
    policies: {
      contractVersion: policyText(adapter, "fundsData.contractVersion", ""),
      requestPlans: policyArray(adapter, "fundsData.requestPlans"),
      preflightPlans: policyArray(adapter, "fundsData.preflightPlans"),
      requestPlanGroups: policyArrayRaw(adapter, "fundsData.requestPlanGroups"),
      requestPlanGroupConcurrency: policyNumber(adapter, "fundsData.requestPlanGroupConcurrency", 1),
      requestPlanGroupDelayMs: policyNumber(adapter, "fundsData.requestPlanGroupDelayMs", 0),
      requiredPlans: policyArray(adapter, "fundsData.requiredPlans"),
      optionalPlans: policyArray(adapter, "fundsData.optionalPlans"),
      criticalPlans: policyArray(adapter, "fundsData.criticalPlans"),
      derivedFields: policyArrayRaw(adapter, "fundsData.derivedFields"),
      fieldSchema: policy(adapter, "fundsData.fieldSchema", {})
    }
  });
  let hash = 0;
  for (let index = 0; index < textValue.length; index += 1) hash = ((hash << 5) - hash + textValue.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function latestId(shopId: string) {
  return `${FUNDS_CURRENT_ID_PREFIX}${shopId}`;
}

async function cleanupFundsCache(stores: DoudianStoreSummary[], contract: {
  adapterVersion: string;
  scriptsVersion: string;
  fieldSchemaVersion: string;
  requestPlanHash: string;
}) {
  const key = stableStringify({ shopIds: stores.map((store) => store.shopId).sort(), ...contract });
  if (fundsCacheCleanupKey === key) return fundsCacheCleanupPromise || Promise.resolve();
  fundsCacheCleanupKey = key;
  fundsCacheCleanupPromise = (async () => {
    const validShopIds = new Set(stores.map((store) => store.shopId));
    const records = await repositoryGetAll<FundsLatestRecord>("funds_latest");
    const obsoleteIds = records
      .filter((record) => (
        !record.id.startsWith(FUNDS_CURRENT_ID_PREFIX) ||
        !validShopIds.has(record.shopId) ||
        record.adapterVersion !== contract.adapterVersion ||
        record.scriptsVersion !== contract.scriptsVersion ||
        record.fieldSchemaVersion !== contract.fieldSchemaVersion ||
        record.requestPlanHash !== contract.requestPlanHash
      ))
      .map((record) => record.id);
    await repositoryDeleteMany("funds_latest", obsoleteIds);
  })().catch((error) => {
    fundsCacheCleanupKey = "";
    throw error;
  });
  return fundsCacheCleanupPromise;
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

function throwIfCancelled(args: FundsDataArgs) {
  if (args.isCancelled?.()) throw new Error("cancelled");
}

async function collectFundsDataForStore(payload: DoudianAdapterPayload, store: DoudianStoreSummary, planKeys: string[], dateContext: DateContext, index: number, total: number, args: FundsDataArgs) {
  if (!store.partition) throw new Error("store partition missing");
  throwIfCancelled(args);
  const responses: Record<string, RequestPlanResult> = {};
  const context = { ...dateContext, shopId: store.shopId, shopName: store.shopName };
  const groups = requestPlanGroups(payload.adapter, planKeys);
  const preflightPlans = policyArray(payload.adapter, "fundsData.preflightPlans")
    .filter((planKey) => planKeys.includes(planKey));
  const groupConcurrency = Math.max(1, Math.min(6, Math.floor(policyNumber(payload.adapter, "fundsData.requestPlanGroupConcurrency", 3))));
  const groupDelayMs = Math.max(0, Math.floor(policyNumber(payload.adapter, "fundsData.requestPlanGroupDelayMs", 0)));
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    throwIfCancelled(args);
    const group = groups[groupIndex];
    const settled = await mapWithConcurrency(group, groupConcurrency, async (planKey) => ({
      planKey,
      response: await runDoudianRequestPlan(payload, {
        partition: store.partition,
        planKey,
        context,
        trackWindow: args.trackWindow
      })
    }));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      responses[result.value.planKey] = result.value.response;
    }
    const preflightComplete = preflightPlans.length > 0 && preflightPlans.every((planKey) => (
      Object.prototype.hasOwnProperty.call(responses, planKey)
    ));
    const preflightFailed = preflightComplete && preflightPlans.some((planKey) => (
      !requestPlanResponseOk(responses[planKey], payload.adapter, planKey, fundsDataMappings(payload.adapter))
    ));
    if (preflightFailed) break;
    if (groupIndex < groups.length - 1) await wait(groupDelayMs);
  }

  const { row, metricSources } = buildFundsDataResult(store, responses, payload.adapter);
  const responseSummary = summarizeResponses(responses, payload.adapter);
  const sourceFailures = summarizeFailures(responseSummary, payload.adapter);
  const dataSourceFailures = sourceFailures.filter((failure) => !failure.diagnosticOnly);
  const blockingSourceFailures = dataSourceFailures.filter((failure) => !failure.optional);
  const summary = rowSummary(row, metricSources, displayMetricFields(payload.adapter));
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
  const partial = ok && (dataSourceFailures.length > 0 || summary.unavailableFieldCount > 0);
  const message = !ok
    ? (firstErrorMessage(responses, payload.adapter) || policyMessage(payload.adapter, "fundsData.messages.failed", "Funds data request failed"))
    : dataSourceFailures.length
      ? policyMessage(payload.adapter, "fundsData.messages.partialSourceStore", "Funds data synced with partial source errors")
      : summary.unavailableFieldCount > 0
        ? policyMessage(payload.adapter, "fundsData.messages.noMetricMatchStore", "Funds data synced but no metric fields matched")
        : policyMessage(payload.adapter, "fundsData.messages.synced", "Funds data synced");

  const detail: DoudianRunDetail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (partial ? "partial" : "ok") : "failed",
    ok,
    message,
    reason: ok ? (dataSourceFailures.length ? "funds-data-partial-source-failure" : summary.unavailableFieldCount > 0 ? "funds-data-no-metric-match" : "") : "funds-data-request-failed",
    category: ok ? (partial ? "api-partial" : "") : "api",
    attemptedAt: nowIso(),
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
      dataSourceFailureCount: dataSourceFailures.length,
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
  const records = args.rows.map((row) => {
    const detail = detailById.get(row.shopId);
    const diagnostic = objectRecord(detail?.diagnostic);
    const metricSources = objectRecord(diagnostic.metricSources);
    const metricUpdatedAt = Object.fromEntries([...FUNDS_DATA_FIELDS, ...FUNDS_TEXT_FIELDS]
      .filter((field) => objectRecord(metricSources[field]).available === true)
      .map((field) => [field, detail?.attemptedAt || updatedAt])) as Partial<Record<FundsDataField, string>>;
    return {
      id: latestId(row.shopId),
      shopId: row.shopId,
      shopName: row.shopName,
      ok: detail?.ok !== false,
      status: detail?.status === "partial" ? "partial" : "ok",
      message: detail?.message || "",
      row,
      diagnostic: { ...diagnostic, metricUpdatedAt },
      datePreset: args.dateContext.datePreset,
      beginDate: args.dateContext.beginDate,
      endDate: args.dateContext.endDate,
      dateRange: args.dateContext,
      adapterVersion: args.adapterVersion,
      ruleVersion: args.ruleVersion,
      scriptsVersion: args.ruleVersion,
      fieldSchemaVersion: args.fieldSchemaVersion,
      requestPlanHash: args.requestPlanHash,
      metricUpdatedAt,
      updatedAt
    } satisfies FundsLatestRecord;
  });
  await repositoryPutMany<FundsLatestRecord>("funds_latest", records);
}

export async function fetchFundsData(args: FundsDataArgs = {}): Promise<DoudianFundsDataResult> {
  const startedAt = Date.now();
  const payload = adapterPayload(args);
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds || []);
  const dateContext = fundsDateContext(payload.adapter);
  const planKeys = requestPlanKeys(payload.adapter, args.includeDiagnostics === true);
  const adapterVersion = payload.adapter.version || "";
  const scriptsVersion = payload.scripts?.version || "";
  const schemaVersion = fieldSchemaVersion(payload.adapter);
  const hash = requestPlanHash(payload.adapter, planKeys, scriptsVersion);
  await cleanupFundsCache(stores, {
    adapterVersion,
    scriptsVersion,
    fieldSchemaVersion: schemaVersion,
    requestPlanHash: hash
  });
  const runId = `funds-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (args.mockRows?.length) {
    const rows = args.mockRows;
    const details = rows.map((row, index) => ({
      shopId: row.shopId,
      shopName: row.shopName,
      status: "ok",
      ok: true,
      message: "Mock funds data synced",
      diagnostic: {
        rowSummary: rowSummary(row),
        metricSources: Object.fromEntries([...FUNDS_DATA_FIELDS, ...FUNDS_TEXT_FIELDS].map((field) => [field, {
          value: row[field] || (FUNDS_TEXT_FIELDS.includes(field as FundsTextField) ? "" : 0),
          source: "path",
          path: "mock",
          available: true
        }]))
      },
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
      partialCount: 0,
      failureCount: 0,
      partialSourceCount: 0,
      noMetricMatchCount: 0,
      incompleteMetricCount: 0,
      cacheWriteCount: rows.length,
      cacheSkippedCount: 0,
      durationMs: Date.now() - startedAt,
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
      successCount: 0,
      partialCount: 0,
      failureCount: targets.length,
      cacheWriteCount: 0,
      cacheSkippedCount: targets.length,
      durationMs: Date.now() - startedAt,
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
  let completedCount = 0;
  const settled = await mapWithConcurrency(targets, concurrency, async (store, index) => {
    try {
      throwIfCancelled(args);
      return await collectFundsDataForStore(payload, store, planKeys, dateContext, index + 1, targets.length, args);
    } finally {
      completedCount += 1;
      dispatchDoudianProgress({
        operationId: args.operationId || "",
        taskType: "fundsData",
        status: "running",
        progress: Math.round((completedCount / Math.max(1, targets.length)) * 95),
        message: `${store.shopName || store.shopId} ${completedCount}/${targets.length}`
      });
    }
  });
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
      attemptedAt: nowIso(),
      index: index + 1,
      total: targets.length
    });
  });

  const successCount = details.filter((detail) => detail.ok === true && detail.status === "ok").length;
  const partialCount = details.filter((detail) => detail.ok === true && detail.status === "partial").length;
  const failureCount = details.filter((detail) => detail.ok !== true || detail.status === "failed").length;
  const partialSourceCount = details.filter((detail) => {
    const diagnostic = objectRecord(detail.diagnostic);
    return Number(diagnostic.dataSourceFailureCount ?? diagnostic.blockingSourceFailureCount ?? 0) > 0;
  }).length;
  const noMetricMatchCount = details.filter((detail) => objectRecord(objectRecord(detail.diagnostic).rowSummary).allUnavailable === true).length;
  const incompleteMetricCount = details.filter((detail) => Number(objectRecord(objectRecord(detail.diagnostic).rowSummary).unavailableFieldCount || 0) > 0).length;
  const status = fundsRunStatus({ successCount, partialCount, failureCount, targetCount: targets.length });
  const messageValues = { successCount, partialCount, failureCount, partialSourceCount, noMetricMatchCount, incompleteMetricCount };
  const message = status === "failed"
    ? policyMessage(payload.adapter, "fundsData.messages.failed", "Funds data sync failed for all {failureCount} stores", messageValues)
    : failureCount
      ? policyMessage(payload.adapter, "fundsData.messages.partial", "{successCount} complete, {partialCount} partial, {failureCount} failed", messageValues)
      : partialCount
        ? policyMessage(payload.adapter, "fundsData.messages.partialSources", "{successCount} complete, {partialCount} partial; {incompleteMetricCount} have incomplete metrics", messageValues)
        : policyMessage(payload.adapter, "fundsData.messages.done", "Funds data synced for {successCount} stores", messageValues);

  const detailByShopId = new Map(details.map((detail) => [text(detail.shopId), detail]));
  const rowsToSave = rows.filter((row) => {
    const detail = detailByShopId.get(row.shopId);
    return detail?.ok === true;
  });
  await saveFundsLatestRows({ rows: rowsToSave, details, dateContext, adapterVersion, ruleVersion: scriptsVersion, fieldSchemaVersion: schemaVersion, requestPlanHash: hash });
  const interfaceStats = summarizeInterfaceStats(details);

  return {
    ok: status === "ok",
    status,
    message,
    runId,
    operationId: args.operationId,
    rows,
    details,
    successCount,
    partialCount,
    failureCount,
    partialSourceCount,
    noMetricMatchCount,
    incompleteMetricCount,
    cacheWriteCount: rowsToSave.length,
    cacheSkippedCount: rows.length - rowsToSave.length,
    durationMs: Date.now() - startedAt,
    interfaceStats,
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
  const dateContext = fundsDateContext(payload.adapter);
  const schemaVersion = fieldSchemaVersion(payload.adapter);
  const planKeys = requestPlanKeys(payload.adapter, args.includeDiagnostics === true);
  const hash = requestPlanHash(payload.adapter, planKeys, payload.scripts?.version || "");
  await cleanupFundsCache(stores, {
    adapterVersion: payload.adapter.version || "",
    scriptsVersion: payload.scripts?.version || "",
    fieldSchemaVersion: schemaVersion,
    requestPlanHash: hash
  });
  const rows = (await repositoryGetMany<FundsLatestRecord>("funds_latest", targets.map((store) => latestId(store.shopId))))
    .filter((record) => record.adapterVersion === (payload.adapter.version || "") && record.fieldSchemaVersion === schemaVersion)
    .filter((record) => record.scriptsVersion === (payload.scripts?.version || "") && record.requestPlanHash === hash);
  const details: DoudianRunDetail[] = rows.map((record, index) => ({
    shopId: record.shopId,
    shopName: record.shopName,
    status: record.ok ? (record.status === "partial" ? "partial" : "ok") : "failed",
    ok: record.ok,
    message: record.message || (record.ok ? "Cached funds data ready" : "Cached funds data failed"),
    reason: record.ok ? "" : "funds-data-cached-failure",
    category: record.ok ? "" : "api",
    diagnostic: { ...objectRecord(record.diagnostic), metricUpdatedAt: record.metricUpdatedAt || objectRecord(objectRecord(record.diagnostic).metricUpdatedAt) },
    dataUpdatedAt: record.updatedAt,
    attemptedAt: record.updatedAt,
    index: index + 1,
    total: rows.length
  }));
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

    const dateContext = fundsDateContext(payload.adapter);
    const store: DoudianStoreSummary = {
      shopId,
      shopName,
      platform: "doudian",
      partition: `persist:chihu-funds-self-check-${suffix}`,
      status: "online",
      groupName: "Self Check"
    };
    const fixtureResponses = Object.fromEntries(Object.entries(fundsResponseFixture.responses).map(([key, data]) => [key, {
      ok: true,
      status: 200,
      source: key,
      data
    } satisfies RequestPlanResult]));
    const parsed = buildFundsDataResult(store, fixtureResponses, payload.adapter);
    const expected = fundsResponseFixture.expected as Partial<Record<FundsField, number>>;
    const cases = Object.entries(expected).map(([field, value]) => ({
      field,
      expected: value,
      actual: parsed.row[field]
    }));
    const expectedText = fundsResponseFixture.expectedText as Partial<Record<FundsTextField, string>>;
    const textCases = Object.entries(expectedText).map(([field, value]) => ({
      field,
      expected: value,
      actual: parsed.row[field]
    }));
    const attemptedAt = nowIso();
    const detail: DoudianRunDetail = {
      shopId,
      shopName,
      status: "ok",
      ok: true,
      message: "Funds fixture parsed",
      attemptedAt,
      diagnostic: {
        rowSummary: rowSummary(parsed.row, parsed.metricSources, displayMetricFields(payload.adapter)),
        metricSources: parsed.metricSources
      }
    };
    const planKeys = requestPlanKeys(payload.adapter);
    const hash = requestPlanHash(payload.adapter, planKeys, payload.scripts?.version || "");
    await saveFundsLatestRows({
      rows: [parsed.row],
      details: [detail],
      dateContext,
      adapterVersion: payload.adapter.version || "",
      ruleVersion: payload.scripts?.version || "",
      fieldSchemaVersion: schemaVersion,
      requestPlanHash: hash
    });
    const latest = await fetchFundsDataLatest({ doudianAdapter: payload, shopIds: [shopId] });
    const moneyCases = [
      { value: { amount: "100", unit: "元" }, expected: 100 },
      { value: { amount: "1", unit: "万" }, expected: 10000 },
      { value: { amount: "1万", unit: "元" }, expected: 10000 },
      { value: { amount: "250", unit: "分" }, expected: 2.5 },
      { value: { amount: "15", unit: "角" }, expected: 1.5 },
      { value: 12345, expected: 123.45 }
    ].map((item) => ({
      ...item,
      actual: fundsMetricValue(item.value, { moneyText: true }, 100)
    }));
    const partialResponses = { ...fixtureResponses };
    delete partialResponses.fundShopAwardOverview;
    const partial = buildFundsDataResult(store, partialResponses, payload.adapter);
    const partialSourceOk = ["subsidyTotal", "commissionSubsidy", "qianchuanSubsidy"]
      .every((field) => partial.metricSources[field]?.available === false);
    const crossSourceResponses: Record<string, RequestPlanResult> = {
      ...fixtureResponses,
      fundAccountList: {
        ...fixtureResponses.fundAccountList,
        data: {
          ...objectRecord(fixtureResponses.fundAccountList.data),
          account_name: "Wrong account name",
          bank_name: "Wrong bank",
          bank_card_mobile: "13800000000"
        }
      }
    };
    delete crossSourceResponses.fundAccountOpenInfo;
    const crossSource = buildFundsDataResult(store, crossSourceResponses, payload.adapter);
    const accountSourceIsolationOk = FUNDS_TEXT_FIELDS.every((field) => (
      crossSource.row[field] === "" && crossSource.metricSources[field]?.available === false
    ));
    const zeroOrderResponses = {
      ...fixtureResponses,
      fundBillQuery: {
        ...fixtureResponses.fundBillQuery,
        data: { code: 0, total: 0 }
      }
    };
    const zeroOrder = buildFundsDataResult(store, zeroOrderResponses, payload.adapter);
    const zeroOrderInferenceOk = zeroOrder.row.pendingSettleOrderAmount === 0 &&
      zeroOrder.metricSources.pendingSettleOrderAmount?.available === true &&
      zeroOrder.metricSources.pendingSettleOrderAmount?.formula === "zeroWhenCountZero";
    const negativeRiskRow = emptyFundsDataRow(store);
    negativeRiskRow.marginBalance = -30.04;
    negativeRiskRow.experienceMarginBalance = -30.04;
    negativeRiskRow.compensationAmount7d = -2;
    const negativeRiskOk = fundsRiskCount(negativeRiskRow) === 2;
    const allFailedStatusOk = fundsRunStatus({ successCount: 0, partialCount: 0, failureCount: 19, targetCount: 19 }) === "failed";
    const mixedStatusOk = fundsRunStatus({ successCount: 14, partialCount: 5, failureCount: 0, targetCount: 19 }) === "partial";
    await saveFundsLatestRows({
      rows: [partial.row],
      details: [{
        ...detail,
        status: "partial",
        diagnostic: {
          rowSummary: rowSummary(partial.row, partial.metricSources, displayMetricFields(payload.adapter)),
          metricSources: partial.metricSources
        }
      }],
      dateContext,
      adapterVersion: payload.adapter.version || "",
      ruleVersion: payload.scripts?.version || "",
      fieldSchemaVersion: schemaVersion,
      requestPlanHash: hash
    });
    const partialLatest = await fetchFundsDataLatest({ doudianAdapter: payload, shopIds: [shopId] });
    const partialLatestDetails = Array.isArray(partialLatest.details) ? partialLatest.details : [];
    const partialCacheOk = partialLatest.rows?.[0]?.withdrawBalance === expected.withdrawBalance && partialLatestDetails[0]?.status === "partial";
    const fixtureOk = [...cases, ...textCases].every((item) => item.actual === item.expected);

    return {
      ok: fixtureOk && partialSourceOk && accountSourceIsolationOk && zeroOrderInferenceOk && negativeRiskOk && allFailedStatusOk && mixedStatusOk && partialCacheOk && latest.rows?.[0]?.withdrawBalance === expected.withdrawBalance && moneyCases.every((item) => item.actual === item.expected),
      latestOk: latest.ok === true && latest.rows?.[0]?.shopId === shopId,
      datePresetOk: latest.dateRange?.datePreset === "snapshot" && dateContext.beginDate === dateContext.endDate,
      metadataOk: latest.adapterVersion === payload.adapter.version && latest.scriptsVersion === (payload.scripts?.version || "") && latest.fieldSchemaVersion === schemaVersion,
      cases: [
        ...cases,
        ...textCases,
        ...moneyCases.map((item, index) => ({ field: `moneyText-${index + 1}`, expected: item.expected, actual: item.actual })),
        { field: "partial-source-availability", expected: true, actual: partialSourceOk },
        { field: "account-source-isolation", expected: true, actual: accountSourceIsolationOk },
        { field: "zero-order-amount-inference", expected: true, actual: zeroOrderInferenceOk },
        { field: "negative-risk-review", expected: true, actual: negativeRiskOk },
        { field: "all-failed-status", expected: "failed", actual: allFailedStatusOk ? "failed" : "unexpected" },
        { field: "mixed-partial-status", expected: "partial", actual: mixedStatusOk ? "partial" : "unexpected" },
        { field: "partial-cache-reload", expected: true, actual: partialCacheOk }
      ]
    };
  } finally {
    await deleteStoreLedger([shopId]).catch(() => undefined);
    await repositoryDelete("funds_latest", latestId(shopId)).catch(() => undefined);
  }
}
