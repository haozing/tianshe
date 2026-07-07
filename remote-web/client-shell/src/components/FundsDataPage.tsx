import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Banknote,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDollarSign,
  Download,
  ExternalLink,
  Landmark,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  ReceiptText,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Store,
  WalletCards
} from "lucide-react";
import { fetchDoudianFundsData, fetchDoudianFundsDataLatest, listDoudianStores, openPlatformWindow } from "../bridge/client";
import { loadDoudianAdapterPayload } from "../bridge/doudianAdapter";
import { STORAGE_KEY_FUNDS_DATA_COLUMNS, storageGet, storageSet } from "../bridge/storage";
import { cn } from "../lib/utils";
import type { DoudianFundsDataRow, DoudianRunDetail, DoudianStoreStatus, DoudianStoreSummary } from "../types";

type DatePreset = "snapshot" | "today" | "7d" | "30d";
type SortKey = string;
type LoadState = "loading" | "ready" | "error";
type FundsLoadState = "idle" | "loading" | "ready" | "error";
type MetricTone = "default" | "blue" | "green" | "warning" | "danger";
type ColumnFormat = "money" | "number";

const fundsMetricKeys = [
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

type FundsMetricKey = typeof fundsMetricKeys[number];

interface StoreOption {
  id: string;
  name: string;
  group: string;
  status: DoudianStoreStatus;
}

type FundsRow = {
  shopId: string;
  shopName: string;
  group: string;
  status: DoudianStoreStatus;
  lastMessage?: string;
  ok?: boolean;
} & Record<FundsMetricKey, number>;

interface MetricItem {
  label: string;
  value: string;
  detail: string;
  tone?: MetricTone;
}

interface DataColumn {
  key: FundsMetricKey;
  label: string;
  format: ColumnFormat;
  group?: string;
  defaultVisible?: boolean;
  export?: boolean;
  tone?: MetricTone | ((row: FundsRow) => MetricTone | undefined);
}

interface RemoteFundsFieldSchema {
  version?: string;
  columns?: Array<{
    key?: string;
    label?: string;
    format?: string;
    group?: string;
    defaultVisible?: boolean;
    export?: boolean;
    tone?: MetricTone;
  }>;
  summaryMetrics?: Array<{
    key?: string;
    label?: string;
    format?: string;
    detail?: string;
    tone?: MetricTone;
  }>;
  defaultSort?: string;
  sortOptions?: Array<{
    key?: string;
    label?: string;
    direction?: "asc" | "desc";
  }>;
}

interface FundsPlatformLink {
  key: string;
  label: string;
  url: string;
  validation?: string;
}

interface FundsAdapterRuntime {
  origin: string;
  sourcePartition: string;
  shopPartitionPrefix: string;
  platformLinks: FundsPlatformLink[];
}

const datePresets: Array<{ key: DatePreset; label: string }> = [
  { key: "snapshot", label: "当前" },
  { key: "today", label: "今天" },
  { key: "7d", label: "近7天" },
  { key: "30d", label: "近30天" }
];

const statusCopy: Record<DoudianStoreStatus, { label: string; className: string }> = {
  online: { label: "在线", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" },
  offline: { label: "离线", className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  check_failed: { label: "待复核", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  unknown: { label: "未知", className: "border-[#dbe5f2] bg-white text-[#667085]" }
};

const tableColumns: DataColumn[] = [
  { key: "withdrawBalance", label: "可提现金额", format: "money", group: "账户", tone: "blue" },
  { key: "balance", label: "货款总金额", format: "money", group: "账户" },
  { key: "frozenBalance", label: "应冻结金额", format: "money", group: "账户", tone: (row) => row.frozenBalance > 0 ? "danger" : undefined },
  { key: "pendingSettleAmount", label: "待结算金额", format: "money", group: "账户", tone: "warning" },
  { key: "pendingSettleOrders", label: "结算订单数", format: "number", group: "待结算订单信息", tone: (row) => row.pendingSettleOrders > 0 ? "warning" : undefined },
  { key: "marginBalance", label: "保证金余额", format: "money", group: "保证金" },
  { key: "depositPayable", label: "应缴保证金", format: "money", group: "保证金", tone: (row) => row.depositPayable > 0 ? "danger" : undefined },
  { key: "refundableMargin", label: "可退保证金", format: "money", group: "保证金", tone: "green" },
  { key: "baseMarginBalance", label: "基础保证金", format: "money", group: "保证金", defaultVisible: false },
  { key: "baseDepositPayable", label: "基础待缴", format: "money", group: "保证金", defaultVisible: false, tone: (row) => row.baseDepositPayable > 0 ? "danger" : undefined },
  { key: "baseRefundableMargin", label: "基础可退", format: "money", group: "保证金", defaultVisible: false, tone: "green" },
  { key: "experienceMarginBalance", label: "体验保证金", format: "money", group: "保证金", defaultVisible: false },
  { key: "experienceDepositPayable", label: "体验待缴", format: "money", group: "保证金", defaultVisible: false, tone: (row) => row.experienceDepositPayable > 0 ? "danger" : undefined },
  { key: "experienceRefundableMargin", label: "体验可退", format: "money", group: "保证金", defaultVisible: false, tone: "green" },
  { key: "subsidyTotal", label: "累计补贴", format: "money", group: "补贴赔付" },
  { key: "commissionSubsidy", label: "佣金补贴", format: "money", group: "补贴赔付", defaultVisible: false },
  { key: "qianchuanSubsidy", label: "千川补贴", format: "money", group: "补贴赔付", defaultVisible: false },
  { key: "compensationOrderCountToday", label: "今日赔付单量", format: "number", group: "补贴赔付", tone: (row) => row.compensationOrderCountToday > 0 ? "danger" : undefined },
  { key: "compensationOrderCount7d", label: "近7日赔付单量", format: "number", group: "补贴赔付", defaultVisible: false, tone: (row) => row.compensationOrderCount7d > 0 ? "warning" : undefined },
  { key: "compensationAmountToday", label: "今日赔付动账", format: "money", group: "补贴赔付", tone: (row) => row.compensationAmountToday > 0 ? "danger" : undefined },
  { key: "compensationAmount7d", label: "近七日赔付", format: "money", group: "补贴赔付", defaultVisible: false, tone: (row) => row.compensationAmount7d > 0 ? "warning" : undefined },
  { key: "pendingSettleOrderAmount", label: "预结算金额", format: "money", group: "待结算订单信息", tone: "warning" },
  { key: "riskCount", label: "资金风险", format: "number", group: "账单", tone: (row) => row.riskCount > 0 ? "danger" : undefined }
];

const defaultColumnKeys = tableColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key);
const defaultSummaryMetrics: NonNullable<RemoteFundsFieldSchema["summaryMetrics"]> = [
  { key: "withdrawBalance", label: "可提现金额", format: "money", detail: "在线店铺", tone: "blue" },
  { key: "balance", label: "货款总金额", format: "money", detail: "账户中心余额" },
  { key: "pendingSettleAmount", label: "待结算金额", format: "money", detail: "货款账户", tone: "warning" },
  { key: "frozenBalance", label: "冻结金额", format: "money", detail: "资金受限", tone: "danger" },
  { key: "marginBalance", label: "保证金余额", format: "money", detail: "基础 + 体验" },
  { key: "depositPayable", label: "待缴保证金", format: "money", detail: "基础 / 体验待缴", tone: "danger" },
  { key: "refundableMargin", label: "可退保证金", format: "money", detail: "可退额度", tone: "green" },
  { key: "riskCount", label: "资金风险", format: "number", detail: "店铺事项", tone: "danger" },
  { key: "subsidyTotal", label: "累计补贴", format: "money", detail: "佣金 + 千川", tone: "green" },
  { key: "compensationAmountToday", label: "今日赔付", format: "money", detail: "赔付单量", tone: "warning" },
  { key: "compensationAmount7d", label: "近七日赔付", format: "money", detail: "赔付动账", tone: "warning" },
  { key: "pendingSettleOrderAmount", label: "预结算金额", format: "money", detail: "待结算订单", tone: "warning" },
  { key: "pendingSettleOrders", label: "结算订单数", format: "number", detail: "待结算订单", tone: "warning" }
];
const fundsMetricKeySet = new Set<string>(fundsMetricKeys);
const columnFormatSet = new Set<string>(["money", "number"]);
const toneSet = new Set<string>(["default", "blue", "green", "warning", "danger"]);
const defaultSortOptions = [
  { key: "withdrawBalance", label: "可提现金额", direction: "desc" },
  { key: "pendingSettleAmount", label: "待结算金额", direction: "desc" },
  { key: "frozenBalance", label: "冻结金额", direction: "desc" },
  { key: "depositPayable", label: "待缴保证金", direction: "desc" },
  { key: "riskCount", label: "资金风险", direction: "desc" }
] as Array<{ key: FundsMetricKey; label: string; direction: "asc" | "desc" }>;

const sampleStores: StoreOption[] = [
  { id: "preview-1001", name: "赤狐样例店 A", group: "华南组", status: "online" },
  { id: "preview-1002", name: "赤狐样例店 B", group: "华东组", status: "online" },
  { id: "preview-1003", name: "赤狐样例店 C", group: "待复核", status: "check_failed" }
];

function hasNativeStoreBridge() {
  return Boolean(window.chihu?.stores?.list || window.client?.storesList);
}

function normalizeStoreStatus(status: unknown): DoudianStoreStatus {
  return status === "online" || status === "offline" || status === "check_failed" || status === "unknown" ? status : "unknown";
}

function mapStoreToOption(store: DoudianStoreSummary): StoreOption {
  return {
    id: String(store.shopId || ""),
    name: store.shopName || `抖店 ${store.shopId || ""}`,
    group: store.groupName || "未分组",
    status: normalizeStoreStatus(store.status)
  };
}

function numberValue(value: unknown) {
  const next = typeof value === "number" ? value : Number(value || 0);
  return Number.isFinite(next) ? next : 0;
}

function emptyMetrics(): Record<FundsMetricKey, number> {
  return Object.fromEntries(fundsMetricKeys.map((key) => [key, 0])) as Record<FundsMetricKey, number>;
}

function fundRiskCount(row: Record<FundsMetricKey, number>) {
  return [
    row.frozenBalance > 0,
    row.depositPayable > 0,
    row.compensationAmountToday > 0
  ].filter(Boolean).length;
}

function deriveFundsMetrics(metrics: Record<FundsMetricKey, number>) {
  const next = { ...metrics };
  if (!next.baseRefundableMargin && next.baseMarginBalance) next.baseRefundableMargin = next.baseMarginBalance - next.baseDepositPayable;
  if (!next.subsidyTotal) next.subsidyTotal = next.commissionSubsidy + next.qianchuanSubsidy;
  if (!next.riskCount) next.riskCount = fundRiskCount(next);
  return next;
}

function zeroFundsRow(store: StoreOption): FundsRow {
  return {
    shopId: store.id,
    shopName: store.name,
    group: store.group,
    status: store.status,
    ...emptyMetrics()
  };
}

function fundsRowFromRemote(row: DoudianFundsDataRow, store?: StoreOption, detail?: DoudianRunDetail): FundsRow {
  const metrics = emptyMetrics();
  for (const key of fundsMetricKeys) metrics[key] = numberValue(row[key]);
  return {
    shopId: String(row.shopId || store?.id || ""),
    shopName: String(row.shopName || store?.name || ""),
    group: String(row.group || store?.group || "未分组"),
    status: normalizeStoreStatus(row.status || store?.status),
    lastMessage: detail?.message,
    ok: detail?.ok,
    ...deriveFundsMetrics(metrics)
  };
}

function sampleFundsRow(store: StoreOption, index: number): FundsRow {
  const factor = index + 1;
  const metrics = deriveFundsMetrics({
    ...emptyMetrics(),
    withdrawBalance: 12860.35 * factor,
    balance: 24680.72 * factor,
    frozenBalance: index === 1 ? 960.5 : 0,
    pendingSettleAmount: 4580.2 * factor,
    baseMarginBalance: 5000 * factor,
    baseDepositPayable: index === 2 ? 1200 : 0,
    baseRefundableMargin: index === 0 ? 800 : 0,
    experienceMarginBalance: 2600 * factor,
    experienceDepositPayable: index === 1 ? 300 : 0,
    experienceRefundableMargin: index === 2 ? 420 : 0,
    commissionSubsidy: 320.25 * factor,
    qianchuanSubsidy: 180.8 * factor,
    compensationOrderCountToday: index === 0 ? 0 : factor,
    compensationOrderCount7d: index === 0 ? 0 : factor * 3,
    compensationAmountToday: index === 0 ? 0 : 38.6 * factor,
    compensationAmount7d: 116.4 * factor,
    pendingSettleOrderAmount: 980.5 * factor,
    pendingSettleOrders: 8 * factor
  });
  return {
    shopId: store.id,
    shopName: store.name,
    group: store.group,
    status: store.status,
    lastMessage: "设计预览数据",
    ok: true,
    ...metrics
  };
}

function sampleFundsRows(stores: StoreOption[]) {
  return stores.map(sampleFundsRow);
}

function normalizeRemoteColumns(schema?: RemoteFundsFieldSchema): DataColumn[] {
  const remoteColumns = Array.isArray(schema?.columns) ? schema.columns : [];
  const columns = remoteColumns
    .filter((column) => fundsMetricKeySet.has(String(column.key || "")) && columnFormatSet.has(String(column.format || "")) && column.label)
    .map((column) => {
      const fallback = tableColumns.find((item) => item.key === column.key);
      return {
        key: column.key as FundsMetricKey,
        label: String(column.label),
        format: column.format as ColumnFormat,
        group: column.group ? String(column.group) : undefined,
        defaultVisible: column.defaultVisible !== false,
        export: column.export !== false,
        tone: toneSet.has(String(column.tone || "")) ? column.tone : fallback?.tone
      };
    });
  return columns.length ? columns : tableColumns;
}

function normalizeRemoteSummary(schema?: RemoteFundsFieldSchema) {
  const remoteMetrics = Array.isArray(schema?.summaryMetrics) ? schema.summaryMetrics : [];
  const metrics = remoteMetrics.filter((item) => (
    fundsMetricKeySet.has(String(item.key || "")) &&
    columnFormatSet.has(String(item.format || "")) &&
    item.label
  ));
  return metrics.length ? metrics : defaultSummaryMetrics;
}

function normalizeRemoteSortOptions(schema?: RemoteFundsFieldSchema) {
  const remoteOptions = Array.isArray(schema?.sortOptions) ? schema.sortOptions : [];
  const options = remoteOptions
    .filter((item) => fundsMetricKeySet.has(String(item.key || "")) && item.label)
    .map((item) => ({
      key: item.key as FundsMetricKey,
      label: String(item.label),
      direction: item.direction === "asc" ? "asc" as const : "desc" as const
    }));
  return options.length ? options : defaultSortOptions;
}

function getFundsFieldSchema(adapter: unknown): RemoteFundsFieldSchema {
  const policies = adapter && typeof adapter === "object" ? (adapter as { policies?: Record<string, unknown> }).policies : undefined;
  const fundsData = policies?.fundsData;
  if (!fundsData || typeof fundsData !== "object") return {};
  const schema = (fundsData as { fieldSchema?: unknown }).fieldSchema;
  return schema && typeof schema === "object" ? schema as RemoteFundsFieldSchema : {};
}

function fallbackPlatformLabel(key: string, label: string) {
  const trimmed = label.trim();
  if (trimmed && !/^\?+$/.test(trimmed)) return trimmed;
  const fallback: Record<string, string> = {
    accountCenter: "货款提现",
    shopDeposit: "管理保证金",
    afterSaleFundPay: "商家赔付信息",
    unsettledBill: "待结算订单信息",
    merchantRights: "商家补贴信息"
  };
  return fallback[key] || key;
}

function resolvePlatformUrl(origin: string, url: string) {
  try {
    return new URL(url, origin).toString();
  } catch {
    return "";
  }
}

function getFundsAdapterRuntime(adapter: unknown): FundsAdapterRuntime {
  const next = adapter && typeof adapter === "object" ? adapter as {
    origin?: unknown;
    sourcePartition?: unknown;
    shopPartitionPrefix?: unknown;
    endpoints?: Record<string, unknown>;
    policies?: Record<string, unknown>;
  } : {};
  const origin = String(next.origin || "https://fxg.jinritemai.com");
  const sourcePartition = String(next.sourcePartition || "persist:chihu_doudian_source");
  const shopPartitionPrefix = String(next.shopPartitionPrefix || "persist:chihu_doudian_shop_");
  const fundsData = next.policies?.fundsData && typeof next.policies.fundsData === "object"
    ? next.policies.fundsData as { platformLinks?: unknown }
    : {};
  const rawLinks = Array.isArray(fundsData.platformLinks) ? fundsData.platformLinks : [];
  const platformLinks = rawLinks.map((item) => {
    if (!item || typeof item !== "object") return null;
    const link = item as { key?: unknown; label?: unknown; endpointKey?: unknown; url?: unknown; validation?: unknown };
    const key = String(link.key || "");
    const endpointKey = String(link.endpointKey || "");
    const configuredUrl = String(link.url || (endpointKey ? next.endpoints?.[endpointKey] || "" : ""));
    const url = resolvePlatformUrl(origin, configuredUrl);
    if (!key || !url) return null;
    return {
      key,
      label: fallbackPlatformLabel(key, String(link.label || "")),
      url,
      validation: String(link.validation || "")
    };
  }).filter(Boolean) as FundsPlatformLink[];
  return {
    origin,
    sourcePartition,
    shopPartitionPrefix,
    platformLinks
  };
}

function fundsColumnStorageKey(schemaVersion?: string) {
  const suffix = String(schemaVersion || "fallback").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return `${STORAGE_KEY_FUNDS_DATA_COLUMNS}_${suffix || "fallback"}`;
}

function visibleColumnKeySet(schemaColumns: DataColumn[], schemaVersion?: string) {
  const saved = storageGet<string[]>(fundsColumnStorageKey(schemaVersion), []);
  const valid = saved.filter((key) => fundsMetricKeySet.has(key));
  const initial = valid.length ? valid : schemaColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key);
  return new Set(initial.length ? initial : defaultColumnKeys);
}

function formatMoney(value: number) {
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(value: number) {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatColumnValue(value: number, format: ColumnFormat) {
  return format === "money" ? formatMoney(value) : formatNumber(value);
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dateRangeForPreset(preset: DatePreset) {
  const today = new Date();
  if (preset === "snapshot") return { label: "当前资金快照" };
  if (preset === "today") {
    const value = formatDate(today);
    return { beginDate: value, endDate: value, label: `${value} - ${value}` };
  }
  const days = preset === "7d" ? 7 : 30;
  const beginDate = formatDate(addDays(today, -days + 1));
  const endDate = formatDate(today);
  return { beginDate, endDate, label: `${beginDate} - ${endDate}` };
}

function aggregateRows(rows: FundsRow[]) {
  const totals = emptyMetrics();
  for (const row of rows) {
    for (const key of fundsMetricKeys) totals[key] += Number(row[key] || 0);
  }
  return deriveFundsMetrics(totals);
}

function fundsRowHasMetric(row: FundsRow) {
  return fundsMetricKeys.some((key) => Number(row[key] || 0) !== 0);
}

function detailDiagnostic(detail?: DoudianRunDetail) {
  return detail?.diagnostic && typeof detail.diagnostic === "object" ? detail.diagnostic as Record<string, unknown> : {};
}

function diagnosticList(diagnostic: Record<string, unknown>, key: string) {
  const value = diagnostic[key];
  return Array.isArray(value) ? value : [];
}

function sourceFailureText(detail?: DoudianRunDetail) {
  const failures = diagnosticList(detailDiagnostic(detail), "sourceFailures");
  return failures.map((item) => {
    if (!item || typeof item !== "object") return "";
    const failure = item as { key?: unknown; critical?: unknown; optional?: unknown; message?: unknown; status?: unknown; code?: unknown };
    const flags = [
      failure.critical ? "critical" : "",
      failure.optional ? "optional" : ""
    ].filter(Boolean).join("/");
    const reason = failure.message || failure.code || failure.status || "";
    return [failure.key, flags, reason].filter(Boolean).join(":");
  }).filter(Boolean).join(" | ");
}

function missingMetricText(detail?: DoudianRunDetail) {
  const diagnostic = detailDiagnostic(detail);
  const rowSummary = diagnostic.rowSummary && typeof diagnostic.rowSummary === "object" ? diagnostic.rowSummary as { allZero?: unknown; nonZeroFieldCount?: unknown } : {};
  const missingCriticalPlans = diagnosticList(diagnostic, "missingCriticalPlans").join("|");
  if (rowSummary.allZero === true && missingCriticalPlans) return `all-zero; missing critical: ${missingCriticalPlans}`;
  if (rowSummary.allZero === true) return "all-zero";
  return missingCriticalPlans ? `missing critical: ${missingCriticalPlans}` : "";
}

function metricSourceText(detail: DoudianRunDetail | undefined, columns: DataColumn[]) {
  const diagnostic = detailDiagnostic(detail);
  const metricSources = diagnostic.metricSources && typeof diagnostic.metricSources === "object" ? metricSourcesObject(diagnostic.metricSources) : {};
  return columns.map((column) => {
    const metric = metricSources[column.key] || {};
    const source = metric.source || "none";
    const via = metric.path || metric.alias || metric.formula || "";
    return `${column.key}:${[source, via].filter(Boolean).join("/")}`;
  }).join(" | ");
}

function metricSourcesObject(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, { source?: string; path?: string; alias?: string; formula?: string }> : {};
}

function exportRows(rows: FundsRow[], range: string, columns: DataColumn[], details: DoudianRunDetail[], adapterVersion: string, fieldSchemaVersion: string, preview: boolean) {
  const detailById = new Map(details.map((detail) => [String(detail.shopId || ""), detail]));
  const exportColumns = columns.filter((column) => column.export !== false);
  const header = ["店铺名称", "店铺ID", "分组", "状态", "同步状态", "同步消息", "口径", "适配器版本", "字段版本", "来源异常", "未命中指标", "指标来源", ...exportColumns.map((column) => column.label)];
  const body = rows.map((row) => {
    const detail = detailById.get(row.shopId);
    return [
      row.shopName,
      row.shopId,
      row.group,
      statusCopy[row.status]?.label || statusCopy.unknown.label,
      preview ? "设计预览" : detail?.ok === false ? "失败" : detail?.status || "成功",
      detail?.message || row.lastMessage || "",
      range,
      adapterVersion,
      fieldSchemaVersion,
      sourceFailureText(detail),
      missingMetricText(detail),
      metricSourceText(detail, exportColumns),
      ...exportColumns.map((column) => formatColumnValue(row[column.key], column.format))
    ];
  });
  const csv = [header, ...body].map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const now = new Date();
  const exportDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  anchor.download = `小尊宝_资金数据导出_${exportDate}csv下载.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toneClass(tone?: MetricTone) {
  if (tone === "green") return "text-[#087443]";
  if (tone === "warning") return "text-[#b54708]";
  if (tone === "danger") return "text-[#b42318]";
  if (tone === "blue") return "text-brand-navy";
  return "text-[#101828]";
}

function StatusTag({ status }: { status: DoudianStoreStatus }) {
  const copy = statusCopy[status] || statusCopy.unknown;
  return <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-semibold", copy.className)}>{copy.label}</span>;
}

function CheckboxBox({ checked, mixed = false }: { checked: boolean; mixed?: boolean }) {
  return (
    <span className={cn("grid size-4 place-items-center rounded border", checked || mixed ? "border-brand-fox bg-brand-fox text-white" : "border-[#cbd5e1] bg-white")}>
      {mixed ? <span className="h-[2px] w-2 rounded-full bg-white" /> : checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

function MetricCell({ item }: { item: MetricItem }) {
  return (
    <div className="min-w-0 border-r border-b border-[#edf1f6] px-4 py-2.5 last:border-r-0 [&:nth-child(8n)]:border-r-0">
      <div className={cn("truncate text-[16px] font-bold leading-6 tracking-[0]", toneClass(item.tone))}>{item.value}</div>
      <div className="mt-0.5 truncate text-[12px] font-medium text-[#667085]">{item.label}</div>
      <div className="mt-0.5 truncate text-[11px] text-[#98a2b3]">{item.detail}</div>
    </div>
  );
}

function NativeSelect<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  options: T[];
  onChange: (value: T) => void;
}) {
  return (
    <span className="relative inline-flex h-8 w-[122px] shrink-0 items-center rounded-md border border-[#dbe5f2] bg-white text-[12px] text-[#1d2939]">
      <select
        className="app-no-drag h-full w-full appearance-none rounded-md bg-transparent px-2.5 pr-7 outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 size-[13px] text-[#667085]" strokeWidth={2} />
    </span>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isDevPreviewRuntime() {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } };
  return meta.env?.DEV === true;
}

export function FundsDataPage() {
  const nativeBridge = hasNativeStoreBridge();
  const previewMode = isDevPreviewRuntime() && !nativeBridge;
  const bridgeMissing = !nativeBridge && !previewMode;
  const [stores, setStores] = useState<StoreOption[]>(() => previewMode ? sampleStores : []);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(previewMode ? sampleStores.map((store) => store.id) : []));
  const [query, setQuery] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("snapshot");
  const [sortKey, setSortKey] = useState<SortKey>("可提现金额");
  const [loadState, setLoadState] = useState<LoadState>(() => previewMode ? "ready" : "loading");
  const [loadMessage, setLoadMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(() => new Date());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fundsRows, setFundsRows] = useState<FundsRow[]>(() => previewMode ? sampleFundsRows(sampleStores) : []);
  const [fundsState, setFundsState] = useState<FundsLoadState>(() => previewMode ? "ready" : "idle");
  const [fundsMessage, setFundsMessage] = useState(() => previewMode ? "设计预览数据" : "");
  const [fundsDetails, setFundsDetails] = useState<DoudianRunDetail[]>([]);
  const [fundsProgress, setFundsProgress] = useState("");
  const [fieldSchema, setFieldSchema] = useState<RemoteFundsFieldSchema>({});
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<Set<string>>(() => visibleColumnKeySet(tableColumns));
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [adapterVersion, setAdapterVersion] = useState("");
  const [fieldSchemaVersion, setFieldSchemaVersion] = useState("");
  const [adapterRuntime, setAdapterRuntime] = useState<FundsAdapterRuntime>(() => getFundsAdapterRuntime(null));

  async function refreshStores() {
    if (previewMode) {
      setStores(sampleStores);
      setFundsRows(sampleFundsRows(sampleStores));
      setSelectedIds(new Set(sampleStores.map((store) => store.id)));
      setLoadState("ready");
      setLastSyncAt(new Date());
      return;
    }
    if (bridgeMissing) {
      setStores([]);
      setFundsRows([]);
      setSelectedIds(new Set());
      setLoadState("error");
      setLoadMessage("生产环境未检测到本地店铺桥接，资金数据不会使用演示数据");
      return;
    }
    setSyncing(true);
    setLoadMessage("");
    try {
      const result = await listDoudianStores();
      if (result.ok) {
        const nextStores = (result.stores || []).map(mapStoreToOption).filter((store) => store.id);
        setStores(nextStores);
        setFundsRows((currentRows) => {
          const byId = new Map(currentRows.map((row) => [row.shopId, row]));
          return nextStores.map((store) => byId.get(store.id) || zeroFundsRow(store));
        });
        setSelectedIds((current) => {
          const validIds = new Set(nextStores.map((store) => store.id));
          const next = new Set([...current].filter((id) => validIds.has(id)));
          if (!next.size) nextStores.forEach((store) => next.add(store.id));
          return next;
        });
        setLoadState("ready");
        setLastSyncAt(new Date());
      } else {
        setLoadState("error");
        setLoadMessage(result.message || "店铺列表读取失败");
      }
    } catch (error) {
      setLoadState("error");
      setLoadMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  }

  async function refreshFundsData(ids = selectedIds) {
    const shopIds = [...ids];
    if (bridgeMissing) {
      setFundsRows([]);
      setFundsDetails([]);
      setFundsState("error");
      setFundsMessage("本地资金数据桥接不可用");
      return;
    }
    if (!shopIds.length) {
      setFundsRows(stores.map(zeroFundsRow));
      setFundsDetails([]);
      setFundsState("ready");
      return;
    }
    setSyncing(true);
    setFundsState("loading");
    setFundsMessage("");
    setFundsProgress("");
    try {
      if (previewMode) {
        setFundsProgress("设计预览资金快照");
        await wait(260);
        setFundsRows(sampleFundsRows(stores));
        setFundsDetails([]);
        setFundsMessage("设计预览数据");
        setFundsState("ready");
        setLastSyncAt(new Date());
        return;
      }
      const range = dateRangeForPreset(datePreset);
      const result = await fetchDoudianFundsData({
        shopIds,
        datePreset,
        beginDate: range.beginDate,
        endDate: range.endDate,
        forceAdapter: true
      });
      const detailList = Array.isArray(result.details) ? result.details : [];
      const detailById = new Map(detailList.map((detail) => [String(detail.shopId || ""), detail]));
      const storeById = new Map(stores.map((store) => [store.id, store]));
      const rowById = new Map((result.rows || []).map((row) => [String(row.shopId), row]));
      const nextRows = stores.map((store) => {
        const row = rowById.get(store.id);
        return row ? fundsRowFromRemote(row, store, detailById.get(store.id)) : zeroFundsRow(store);
      });
      for (const row of result.rows || []) {
        const id = String(row.shopId || "");
        if (id && !storeById.has(id)) nextRows.push(fundsRowFromRemote(row, undefined, detailById.get(id)));
      }
      setFundsRows(nextRows);
      setFundsDetails(detailList);
      setFundsMessage(result.message || "");
      setAdapterVersion(result.adapterVersion || adapterVersion);
      setFieldSchemaVersion(result.fieldSchemaVersion || fieldSchemaVersion);
      setFundsState(result.ok || result.status === "partial" ? "ready" : "error");
      setLastSyncAt(new Date());
    } catch (error) {
      setFundsState("error");
      setFundsMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
      setFundsProgress("");
    }
  }

  async function hydrateLatestFundsData(ids = selectedIds) {
    if (previewMode || !stores.length || !ids.size) return;
    try {
      const range = dateRangeForPreset(datePreset);
      const result = await fetchDoudianFundsDataLatest({
        shopIds: [...ids],
        datePreset,
        beginDate: range.beginDate,
        endDate: range.endDate,
        forceAdapter: true
      });
      if (!result.rows?.length) return;
      const detailList = Array.isArray(result.details) ? result.details : [];
      const detailById = new Map(detailList.map((detail) => [String(detail.shopId || ""), detail]));
      const rowById = new Map(result.rows.map((row) => [String(row.shopId), row]));
      setFundsRows(stores.map((store) => {
        const row = rowById.get(store.id);
        return row ? fundsRowFromRemote(row, store, detailById.get(store.id)) : zeroFundsRow(store);
      }));
      setFundsDetails(detailList);
      setFundsMessage(result.message || "");
      setAdapterVersion(result.adapterVersion || adapterVersion);
      setFieldSchemaVersion(result.fieldSchemaVersion || fieldSchemaVersion);
      setFundsState("ready");
    } catch {
      // Latest cached data is optional; an explicit sync is authoritative.
    }
  }

  useEffect(() => {
    void refreshStores();
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadDoudianAdapterPayload()
      .then((payload) => {
        if (cancelled) return;
        const schema = getFundsFieldSchema(payload.adapter);
        const columns = normalizeRemoteColumns(schema);
        setFieldSchema(schema);
        setAdapterRuntime(getFundsAdapterRuntime(payload.adapter));
        setAdapterVersion(payload.adapter.version || "");
        setFieldSchemaVersion(schema.version || "");
        setVisibleColumnKeys((current) => {
          const currentValid = [...current].filter((key) => columns.some((column) => column.key === key));
          const next = currentValid.length ? new Set(currentValid) : visibleColumnKeySet(columns, schema.version);
          storageSet(fundsColumnStorageKey(schema.version), [...next]);
          return next;
        });
        const options = normalizeRemoteSortOptions(schema);
        const defaultSort = options.find((option) => option.key === schema.defaultSort) || options[0];
        setSortKey((current) => options.some((option) => option.label === current) ? current : defaultSort.label);
      })
      .catch((error) => {
        if (!cancelled) setFundsMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (previewMode) return;
    if (loadState !== "ready" || !stores.length) return;
    void hydrateLatestFundsData();
    void refreshFundsData();
  }, [previewMode, loadState, stores.length, datePreset]);

  useEffect(() => {
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.phase !== "fundsData") return;
      const index = detail.index && detail.total ? `${detail.index}/${detail.total}` : "";
      const shopName = detail.shopName ? String(detail.shopName) : "";
      const message = detail.message ? String(detail.message) : "";
      setFundsProgress([index, shopName, message].filter(Boolean).join(" · "));
    };
    window.addEventListener("chihu-stores-progress", onProgress);
    return () => window.removeEventListener("chihu-stores-progress", onProgress);
  }, []);

  const filteredStores = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return stores;
    return stores.filter((store) => store.name.toLowerCase().includes(keyword) || store.id.toLowerCase().includes(keyword));
  }, [query, stores]);

  const sortOptions = useMemo(() => normalizeRemoteSortOptions(fieldSchema), [fieldSchema]);
  const selectedSort = sortOptions.find((option) => option.label === sortKey) || sortOptions[0];
  const selectedRows = useMemo(() => {
    const rows = fundsRows.filter((row) => selectedIds.has(row.shopId));
    const key = selectedSort?.key || "withdrawBalance";
    const direction = selectedSort?.direction === "asc" ? 1 : -1;
    return rows.sort((left, right) => {
      const leftValue = Number(left[key] || 0);
      const rightValue = Number(right[key] || 0);
      return (leftValue - rightValue) * direction;
    });
  }, [fundsRows, selectedIds, selectedSort?.direction, selectedSort?.key]);

  const schemaColumns = useMemo(() => normalizeRemoteColumns(fieldSchema), [fieldSchema]);
  const columnStorageKey = fundsColumnStorageKey(fieldSchema.version || fieldSchemaVersion);
  const visibleColumns = useMemo(() => {
    const next = schemaColumns.filter((column) => visibleColumnKeys.has(column.key));
    return next.length ? next : schemaColumns;
  }, [schemaColumns, visibleColumnKeys]);
  const shopColumnWidth = 174;
  const tableMinWidth = Math.max(1120, shopColumnWidth + visibleColumns.length * 104);
  const summarySchema = useMemo(() => normalizeRemoteSummary(fieldSchema), [fieldSchema]);
  const totals = useMemo(() => aggregateRows(selectedRows), [selectedRows]);
  const range = dateRangeForPreset(datePreset);
  const selectedVisibleCount = filteredStores.filter((store) => selectedIds.has(store.id)).length;
  const allVisibleSelected = filteredStores.length > 0 && selectedVisibleCount === filteredStores.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const onlineSelectedCount = selectedRows.filter((row) => row.status === "online").length;
  const failedDetailCount = fundsDetails.filter((detail) => detail.ok === false).length;
  const selectedRowsAllZero = fundsState === "ready" && selectedRows.length > 0 && selectedRows.every((row) => !fundsRowHasMetric(row));
  const riskStoreCount = selectedRows.filter((row) => row.riskCount > 0).length;
  const fundsWarningTitle = failedDetailCount
    ? `${failedDetailCount} 家同步失败`
    : selectedRowsAllZero && !previewMode
      ? `${selectedRows.length} 家未命中资金指标`
      : riskStoreCount
        ? `${riskStoreCount} 家存在资金事项`
        : "";
  const fundsWarningDetail = failedDetailCount
    ? "请到店铺管理确认登录态，或重新同步资金数据。"
    : selectedRowsAllZero && !previewMode
      ? "资金桥接或字段映射尚未返回可展示的金额。"
      : riskStoreCount
        ? "存在冻结、待缴保证金或赔付动账。"
        : "";

  const metrics: MetricItem[] = summarySchema.map((item) => {
    const key = item.key as FundsMetricKey;
    const format = (item.format || "number") as ColumnFormat;
    let detail = item.detail || "";
    if (key === "withdrawBalance") detail = `${onlineSelectedCount} 家在线`;
    if (key === "pendingSettleAmount") detail = "货款账户";
    if (key === "marginBalance") detail = "基础 + 体验";
    if (key === "depositPayable") detail = "基础 / 体验待缴";
    if (key === "riskCount") detail = `${riskStoreCount} 家店铺`;
    if (key === "subsidyTotal") detail = "佣金 + 千川";
    if (key === "compensationAmountToday") detail = `${formatNumber(totals.compensationOrderCountToday)} 单`;
    if (key === "pendingSettleOrderAmount") detail = `${formatNumber(totals.pendingSettleOrders)} 笔待结算`;
    if (key === "pendingSettleOrders") detail = "待结算订单信息";
    const alertingTone = (
      key === "frozenBalance" ||
      key === "depositPayable" ||
      key === "riskCount" ||
      key === "compensationAmountToday" ||
      key === "compensationAmount7d"
    ) && totals[key] > 0 ? item.tone || "danger" : item.tone;
    return {
      label: item.label || key,
      value: formatColumnValue(totals[key], format),
      detail,
      tone: alertingTone
    };
  });
  const summaryVisibleMetrics = summaryExpanded ? metrics : metrics.slice(0, 8);
  const summaryHiddenCount = Math.max(0, metrics.length - 8);

  function toggleColumn(key: FundsMetricKey) {
    setVisibleColumnKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (!next.size) schemaColumns.slice(0, 1).forEach((column) => next.add(column.key));
      storageSet(columnStorageKey, [...next]);
      return next;
    });
  }

  function resetColumns() {
    const next = new Set(schemaColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key));
    if (!next.size) schemaColumns.forEach((column) => next.add(column.key));
    storageSet(columnStorageKey, [...next]);
    setVisibleColumnKeys(next);
  }

  async function openFundsPlatformLink(link: FundsPlatformLink) {
    if (bridgeMissing) {
      setFundsState("error");
      setFundsMessage("本地窗口桥接不可用");
      return;
    }
    const selected = [...selectedIds];
    const partition = selected.length === 1
      ? `${adapterRuntime.shopPartitionPrefix}${selected[0].replace(/[^a-zA-Z0-9_-]/g, "_")}`
      : adapterRuntime.sourcePartition;
    const result = await openPlatformWindow({
      url: link.url,
      title: `赤狐管家 - ${link.label}`,
      partition
    });
    if (!result.ok) {
      setFundsState("error");
      setFundsMessage(result.message || "平台页面打开失败");
    }
  }

  function toggleStore(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisibleStores() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) filteredStores.forEach((store) => next.delete(store.id));
      else filteredStores.forEach((store) => next.add(store.id));
      return next;
    });
  }

  return (
    <section className={cn("grid h-full min-w-0 min-h-0 gap-3 overflow-hidden text-[#1d2939] max-[980px]:grid-cols-1 max-[980px]:overflow-auto", sidebarCollapsed ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[250px_minmax(0,1fr)]")}>
      {!sidebarCollapsed ? (
        <aside className="grid min-w-0 min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex h-11 items-center justify-between border-b border-[#edf1f6] px-3.5">
            <div className="flex items-center gap-2">
              <Store className="size-[16px] text-brand-navy" strokeWidth={2.2} />
              <strong className="text-[14px] font-semibold text-[#101828]">店铺选择</strong>
            </div>
            <div className="flex items-center gap-1">
              <a className="text-[12px] font-semibold text-brand-fox no-underline" href="#/stores">店铺管理</a>
              <button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2] bg-white text-[#344054] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" aria-label="收起店铺选择" title="收起店铺选择" onClick={() => setSidebarCollapsed(true)}>
                <PanelLeftClose className="size-[14px]" strokeWidth={2} />
              </button>
            </div>
          </div>
          <div className="border-b border-[#edf1f6] p-2.5">
            <label className="flex h-8 items-center gap-2 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[#98a2b3]">
              <input
                className="min-w-0 flex-1 bg-transparent text-[12px] text-[#1d2939] outline-none placeholder:text-[#98a2b3]"
                placeholder="店铺名称 / 店铺 ID"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Search className="size-[14px]" strokeWidth={2} />
            </label>
            <div className="mt-2.5 flex items-center justify-between text-[12px] text-[#667085]">
              <button className="inline-flex items-center gap-2 font-semibold text-[#344054]" type="button" onClick={toggleVisibleStores}>
                <CheckboxBox checked={allVisibleSelected} mixed={someVisibleSelected} />
                全选 {selectedIds.size}/{stores.length}
              </button>
              <span>{onlineSelectedCount} 家在线</span>
            </div>
          </div>
          <div className="min-h-[180px] overflow-auto">
            {loadState === "loading" ? (
              <div className="grid h-full min-h-[220px] place-items-center text-[13px] text-[#667085]">
                <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在读取店铺</span>
              </div>
            ) : filteredStores.length ? (
              <div className="divide-y divide-[#edf1f6]">
                {filteredStores.map((store) => (
                  <button
                    className={cn("grid w-full grid-cols-[20px_minmax(0,1fr)] gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[#f8fbff]", selectedIds.has(store.id) ? "bg-[#fffaf7]" : "bg-white")}
                    key={store.id}
                    type="button"
                    onClick={() => toggleStore(store.id)}
                  >
                    <span className="pt-1"><CheckboxBox checked={selectedIds.has(store.id)} /></span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-semibold text-[#1d2939]">{store.name}</span>
                      <span className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-[#667085]">
                        <span className="truncate">ID: {store.id}</span>
                        <StatusTag status={store.status} />
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid h-full min-h-[220px] place-items-center px-4 text-center text-[13px] leading-6 text-[#667085]">
                {loadState === "error" ? loadMessage || "店铺读取失败" : "暂无匹配店铺"}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-[#edf1f6] px-3 py-2">
            <span className="truncate text-[12px] text-[#98a2b3]">{previewMode ? "设计样例店铺" : "店铺列表同步"}</span>
            <button className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={syncing} onClick={() => void refreshStores()}>
              <RefreshCw className={cn("size-[13px]", syncing ? "animate-spin" : "")} strokeWidth={2} />
              刷新
            </button>
          </div>
        </aside>
      ) : null}

      <div className="grid min-w-0 min-h-0 grid-rows-[42px_auto_minmax(0,1fr)] gap-3 overflow-hidden">
        <div className="scrollbar-none flex h-[42px] items-center gap-2 overflow-x-auto overflow-y-hidden">
          <div className="flex shrink-0 items-center gap-2">
            {sidebarCollapsed ? (
              <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" onClick={() => setSidebarCollapsed(false)}>
                <PanelLeftOpen className="size-[14px]" strokeWidth={2} />
                展开店铺
              </button>
            ) : null}
            <CircleDollarSign className="size-[18px] text-brand-navy" strokeWidth={2.2} />
            <strong className="text-[15px] font-semibold text-[#101828]">资金总览</strong>
            <span className="rounded-md border border-[#dbe5f2] bg-white px-2 py-1 text-[12px] font-medium text-[#667085]">已选 {selectedIds.size} 家</span>
            {previewMode ? <span className="rounded-md border border-[#ffdca8] bg-[#fff7e8] px-2 py-1 text-[12px] font-semibold text-[#b54708]">设计预览</span> : null}
            {summaryHiddenCount ? (
              <button className="inline-flex h-7 items-center gap-1 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" onClick={() => setSummaryExpanded((open) => !open)}>
                <ChevronDown className={cn("size-[13px] transition-transform", summaryExpanded ? "rotate-180" : "")} strokeWidth={2} />
                {summaryExpanded ? "收起" : `展开 ${summaryHiddenCount} 项`}
              </button>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="inline-flex h-8 items-center overflow-hidden rounded-md border border-[#dbe5f2] bg-white">
              {datePresets.map((preset) => (
                <button
                  className={cn("h-full px-2.5 text-[12px] font-semibold transition-colors", datePreset === preset.key ? "bg-brand-fox text-white" : "text-[#667085] hover:bg-brand-foxSoft hover:text-brand-navy")}
                  key={preset.key}
                  type="button"
                  onClick={() => setDatePreset(preset.key)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-medium text-[#667085]">
              <CalendarDays className="size-[14px]" strokeWidth={2} />
              <span>{range.label}</span>
            </div>
            {adapterRuntime.platformLinks.map((link) => (
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] disabled:opacity-50"
                disabled={previewMode || bridgeMissing}
                key={link.key}
                title={link.validation ? `${link.label} · ${link.validation}` : link.label}
                type="button"
                onClick={() => void openFundsPlatformLink(link)}
              >
                <ExternalLink className="size-[14px]" strokeWidth={2} />
                {link.label}
              </button>
            ))}
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] disabled:opacity-50" type="button" disabled={syncing || !selectedIds.size} onClick={() => void refreshFundsData()}>
              <RefreshCw className={cn("size-[14px]", syncing ? "animate-spin" : "")} strokeWidth={2} />
              同步
            </button>
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] disabled:opacity-50" type="button" disabled={!selectedRows.length} onClick={() => exportRows(selectedRows, range.label, visibleColumns, fundsDetails, adapterVersion, fieldSchemaVersion, previewMode)}>
              <Download className="size-[14px]" strokeWidth={2} />
              批量导出
            </button>
            <span className="rounded-md border border-[#ffdca8] bg-[#fff7e8] px-2 py-1 text-[12px] font-semibold text-[#b54708]" title="小尊宝资金模块存在平台下载/导出信号；当前按钮为本地 CSV 导出，平台导出仍需真实验收">
              平台导出待验收
            </span>
          </div>
        </div>

        <section className="overflow-x-auto overflow-y-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="grid min-w-[1120px] grid-cols-8">
            {summaryVisibleMetrics.map((item) => <MetricCell item={item} key={item.label} />)}
          </div>
        </section>

        <section className="grid min-h-0 grid-rows-[44px_minmax(0,1fr)_38px] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex items-center justify-between gap-3 border-b border-[#edf1f6] px-3.5">
            <div className="flex min-w-0 items-center gap-2">
              <WalletCards className="size-[16px] text-brand-navy" strokeWidth={2.2} />
              <strong className="text-[15px] font-semibold text-[#101828]">店铺资金明细</strong>
              {fundsState === "loading" ? (
                <span className="inline-flex h-6 max-w-[360px] items-center gap-1 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#667085]" title={fundsProgress || "正在同步资金数据"}>
                  <Loader2 className="size-[13px] animate-spin" strokeWidth={2} />
                  <span className="truncate">{fundsProgress || "同步中"}</span>
                </span>
              ) : fundsState === "error" ? (
                <span className="inline-flex h-6 max-w-[380px] items-center gap-1 rounded-md border border-[#ffd1d1] bg-[#fff1f0] px-2 text-[12px] font-semibold text-[#b42318]" title={fundsMessage}>
                  <AlertTriangle className="size-[13px] shrink-0" strokeWidth={2} />
                  <span className="truncate">{fundsMessage || "资金数据同步失败"}</span>
                </span>
              ) : fundsWarningTitle ? (
                <span className="inline-flex h-6 max-w-[440px] items-center gap-1 rounded-md border border-[#ffdca8] bg-[#fff7e8] px-2 text-[12px] font-semibold text-[#b54708]" title={fundsWarningDetail}>
                  <ShieldAlert className="size-[13px]" strokeWidth={2} />
                  <span className="truncate">{fundsWarningTitle}</span>
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <NativeSelect value={sortKey} options={sortOptions.map((option) => option.label)} onChange={setSortKey} />
              <button className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054]", columnPanelOpen ? "bg-brand-foxSoft text-brand-navy" : "")} type="button" onClick={() => setColumnPanelOpen((open) => !open)}>
                <SlidersHorizontal className="size-[14px]" strokeWidth={2} />
                指标
              </button>
            </div>
          </div>

          <div className="min-h-0 overflow-auto">
            {columnPanelOpen ? (
              <div className="sticky left-0 z-30 border-b border-[#edf1f6] bg-white px-3.5 py-3 shadow-[0_8px_18px_rgba(15,23,42,0.05)]">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[12px] font-semibold text-[#344054]">指标列</div>
                  <button className="h-7 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054]" type="button" onClick={resetColumns}>恢复默认</button>
                </div>
                <div className="grid grid-cols-6 gap-2 max-[1600px]:grid-cols-4 max-[1180px]:grid-cols-3 max-[760px]:grid-cols-2">
                  {schemaColumns.map((column) => (
                    <button
                      className={cn("flex h-8 min-w-0 items-center gap-2 rounded-md border px-2 text-left text-[12px] font-medium", visibleColumnKeys.has(column.key) ? "border-brand-fox bg-brand-foxSoft text-brand-navy" : "border-[#dbe5f2] bg-white text-[#667085]")}
                      key={column.key}
                      type="button"
                      onClick={() => toggleColumn(column.key)}
                    >
                      <CheckboxBox checked={visibleColumnKeys.has(column.key)} />
                      <span className="truncate">{column.label}</span>
                      {column.group ? <span className="ml-auto shrink-0 text-[11px] text-[#98a2b3]">{column.group}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <table className="w-full border-separate border-spacing-0 text-left text-[12px]" style={{ minWidth: tableMinWidth }}>
              <thead className="sticky top-0 z-20 bg-[#fbfcff] text-[#344054] shadow-[inset_0_-1px_0_#e6ebf3]">
                <tr className="h-10">
                  <th className="sticky left-0 z-30 bg-[#fbfcff] px-3 font-semibold shadow-[inset_-1px_0_0_#edf1f6]" style={{ width: shopColumnWidth, minWidth: shopColumnWidth, maxWidth: shopColumnWidth }}>店铺名称</th>
                  {visibleColumns.map((column) => (
                    <th className="whitespace-nowrap bg-[#fbfcff] px-3 font-semibold" key={column.key}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#edf1f6]">
                {selectedRows.map((row) => (
                  <tr className="group h-[44px] hover:bg-[#f8fbff]" key={row.shopId}>
                    <td className="sticky left-0 z-10 bg-white px-3 shadow-[inset_-1px_0_0_#edf1f6] group-hover:bg-[#f8fbff]" style={{ width: shopColumnWidth, minWidth: shopColumnWidth, maxWidth: shopColumnWidth }}>
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-[#1d2939]" title={row.shopName}>{row.shopName}</div>
                        <div className="truncate font-mono text-[12px] text-[#667085]">{row.shopId}</div>
                      </div>
                    </td>
                    {visibleColumns.map((column) => {
                      const resolvedTone = typeof column.tone === "function" ? column.tone(row) : column.tone;
                      return (
                        <td className={cn("whitespace-nowrap px-3", toneClass(resolvedTone), resolvedTone ? "font-semibold" : "")} key={column.key}>
                          {formatColumnValue(row[column.key], column.format)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {!selectedRows.length ? (
                  <tr>
                    <td className="h-[360px] text-center" colSpan={visibleColumns.length + 1}>
                      <div className="mx-auto grid w-[280px] place-items-center gap-3 text-[#667085]">
                        <span className="grid size-14 place-items-center rounded-full bg-brand-foxSoft text-brand-fox">
                          {fundsState === "loading" ? <Loader2 className="size-7 animate-spin" strokeWidth={2.2} /> : <CircleDollarSign className="size-7" strokeWidth={2.2} />}
                        </span>
                        <strong className="text-[14px] text-[#344054]">{fundsState === "loading" ? "正在同步" : "暂无数据"}</strong>
                        <span className="text-[13px] leading-6">{fundsState === "loading" ? (fundsProgress || "正在读取资金数据") : "请选择左侧店铺或调整资金口径"}</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-[#edf1f6] px-4 text-[12px] text-[#667085]">
            <span className="min-w-0 truncate" title={fundsWarningDetail || fundsMessage}>
              共 {selectedRows.length} 家店铺，最近同步 {lastSyncAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
              {fundsWarningTitle ? `，${fundsWarningTitle}` : ""}
            </span>
            <span className="inline-flex items-center gap-2">
              <Banknote className="size-[14px]" strokeWidth={2} />
              可提现 {formatMoney(totals.withdrawBalance)}
              <ReceiptText className="ml-2 size-[14px]" strokeWidth={2} />
              待结算 {formatMoney(totals.pendingSettleAmount)}
              <Landmark className="ml-2 size-[14px]" strokeWidth={2} />
              保证金 {formatMoney(totals.marginBalance)}
            </span>
          </div>
        </section>
      </div>
    </section>
  );
}
