import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Banknote,
  Check,
  ChevronDown,
  CircleDollarSign,
  CircleStop,
  Download,
  GripVertical,
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
import { cancelDoudianStoreOperation, fetchDoudianFundsData, fetchDoudianFundsDataLatest, listDoudianStores } from "../bridge/client";
import { loadDoudianAdapterPayload } from "../bridge/doudianAdapter";
import { STORAGE_KEY_FUNDS_DATA_COLUMN_ORDER, STORAGE_KEY_FUNDS_DATA_COLUMN_WIDTHS, STORAGE_KEY_FUNDS_DATA_COLUMNS, storageGet, storageSet } from "../bridge/storage";
import { addDoudianProgressListener } from "../domain/doudian";
import { toggleStoreIds } from "../domain/doudian/storeSelection";
import { GroupedStoreSelectionList } from "./GroupedStoreSelectionList";
import { cn } from "../lib/utils";
import type { DoudianFundsDataRow, DoudianRunDetail, DoudianStoreStatus, DoudianStoreSummary } from "../types";

type SortKey = string;
type LoadState = "loading" | "ready" | "error";
type FundsLoadState = "idle" | "loading" | "ready" | "error";
type MetricTone = "default" | "blue" | "green" | "warning" | "danger";
type ColumnFormat = "money" | "number";
type FundsMetricState = "fresh" | "stale" | "unavailable";
type ExportFormat = "Excel" | "CSV" | "TXT";

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
type FundsColumnWidths = Partial<Record<FundsMetricKey, number>>;

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
  metricStates: Record<FundsMetricKey, FundsMetricState>;
  metricUpdatedAt: Record<FundsMetricKey, string>;
  dataUpdatedAt?: string;
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
  { key: "marginBalance", label: "体验保证金余额", format: "money", group: "保证金", tone: (row) => row.marginBalance < 0 ? "danger" : undefined },
  { key: "depositPayable", label: "应缴体验保证金", format: "money", group: "保证金", tone: (row) => row.depositPayable > 0 ? "danger" : undefined },
  { key: "refundableMargin", label: "可退体验保证金", format: "money", group: "保证金", tone: "green" },
  { key: "baseMarginBalance", label: "基础保证金", format: "money", group: "保证金", defaultVisible: false },
  { key: "baseDepositPayable", label: "基础待缴", format: "money", group: "保证金", defaultVisible: false, tone: (row) => row.baseDepositPayable > 0 ? "danger" : undefined },
  { key: "baseRefundableMargin", label: "基础可退", format: "money", group: "保证金", defaultVisible: false, tone: "green" },
  { key: "experienceMarginBalance", label: "体验保证金", format: "money", group: "保证金", defaultVisible: false, tone: (row) => row.experienceMarginBalance < 0 ? "danger" : undefined },
  { key: "experienceDepositPayable", label: "体验待缴", format: "money", group: "保证金", defaultVisible: false, tone: (row) => row.experienceDepositPayable > 0 ? "danger" : undefined },
  { key: "experienceRefundableMargin", label: "体验可退", format: "money", group: "保证金", defaultVisible: false, tone: "green" },
  { key: "subsidyTotal", label: "累计补贴", format: "money", group: "补贴赔付" },
  { key: "commissionSubsidy", label: "佣金补贴", format: "money", group: "补贴赔付", defaultVisible: false },
  { key: "qianchuanSubsidy", label: "千川补贴", format: "money", group: "补贴赔付", defaultVisible: false },
  { key: "compensationOrderCountToday", label: "今日赔付单量", format: "number", group: "补贴赔付", tone: (row) => row.compensationOrderCountToday > 0 ? "danger" : undefined },
  { key: "compensationOrderCount7d", label: "近7日赔付单量", format: "number", group: "补贴赔付", defaultVisible: false, tone: (row) => row.compensationOrderCount7d > 0 ? "warning" : undefined },
  { key: "compensationAmountToday", label: "今日赔付动账", format: "money", group: "补贴赔付", tone: (row) => row.compensationAmountToday !== 0 ? "danger" : undefined },
  { key: "compensationAmount7d", label: "近七日赔付", format: "money", group: "补贴赔付", defaultVisible: false, tone: (row) => row.compensationAmount7d !== 0 ? "warning" : undefined },
  { key: "pendingSettleOrderAmount", label: "预结算金额", format: "money", group: "待结算订单信息", tone: "warning" },
  { key: "riskCount", label: "资金风险", format: "number", group: "账单", tone: (row) => row.riskCount > 0 ? "danger" : undefined }
];

const defaultColumnKeys = tableColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key);
const defaultSummaryMetrics: NonNullable<RemoteFundsFieldSchema["summaryMetrics"]> = [
  { key: "withdrawBalance", label: "可提现金额", format: "money", detail: "在线店铺", tone: "blue" },
  { key: "balance", label: "货款总金额", format: "money", detail: "账户中心余额" },
  { key: "pendingSettleAmount", label: "待结算金额", format: "money", detail: "货款账户", tone: "warning" },
  { key: "frozenBalance", label: "冻结金额", format: "money", detail: "资金受限", tone: "danger" },
  { key: "marginBalance", label: "体验保证金余额", format: "money", detail: "店铺保证金信息" },
  { key: "depositPayable", label: "应缴体验保证金", format: "money", detail: "店铺保证金信息", tone: "danger" },
  { key: "refundableMargin", label: "可退体验保证金", format: "money", detail: "店铺保证金信息", tone: "green" },
  { key: "riskCount", label: "资金风险", format: "number", detail: "店铺事项", tone: "danger" },
  { key: "subsidyTotal", label: "累计补贴", format: "money", detail: "佣金 + 千川", tone: "green" },
  { key: "compensationAmountToday", label: "今日赔付", format: "money", detail: "赔付单量", tone: "warning" },
  { key: "compensationAmount7d", label: "近七日赔付", format: "money", detail: "赔付动账", tone: "warning" },
  { key: "pendingSettleOrderAmount", label: "预结算金额", format: "money", detail: "待结算订单", tone: "warning" },
  { key: "pendingSettleOrders", label: "结算订单数", format: "number", detail: "待结算订单", tone: "warning" }
];
const fundsMetricKeySet = new Set<string>(fundsMetricKeys);
const CURRENT_SNAPSHOT_LABEL = "当前资金快照";
const DEFAULT_AUTO_REFRESH_TTL_MS = 5 * 60 * 1000;
const columnFormatSet = new Set<string>(["money", "number"]);
const toneSet = new Set<string>(["default", "blue", "green", "warning", "danger"]);
const defaultMetricColumnWidth = 112;
const minMetricColumnWidth = 72;
const maxMetricColumnWidth = 360;
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
  return Boolean(window.chihuNative && (window.nativeData || window.chihuNative.nativeData));
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

function emptyMetricStates(state: FundsMetricState = "unavailable"): Record<FundsMetricKey, FundsMetricState> {
  return Object.fromEntries(fundsMetricKeys.map((key) => [key, state])) as Record<FundsMetricKey, FundsMetricState>;
}

function emptyMetricUpdatedAt(value = ""): Record<FundsMetricKey, string> {
  return Object.fromEntries(fundsMetricKeys.map((key) => [key, value])) as Record<FundsMetricKey, string>;
}

function fundRiskCount(row: Record<FundsMetricKey, number>) {
  return [
    row.frozenBalance > 0,
    row.depositPayable > 0,
    row.marginBalance < 0 || row.experienceMarginBalance < 0,
    row.compensationAmountToday !== 0 || row.compensationAmount7d !== 0
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
    metricStates: emptyMetricStates(),
    metricUpdatedAt: emptyMetricUpdatedAt(),
    ...emptyMetrics()
  };
}

function fundsRowFromRemote(row: DoudianFundsDataRow, store?: StoreOption, detail?: DoudianRunDetail, previous?: FundsRow, cachedStale = false): FundsRow {
  const metrics = emptyMetrics();
  for (const key of fundsMetricKeys) metrics[key] = numberValue(row[key]);
  const diagnostic = detailDiagnostic(detail);
  const metricSources = metricSourcesObject(diagnostic.metricSources);
  const remoteMetricUpdatedAt = stringRecord(diagnostic.metricUpdatedAt);
  const hasSourceMetadata = Object.keys(metricSources).length > 0;
  const metricStates = emptyMetricStates();
  const metricUpdatedAt = emptyMetricUpdatedAt();
  const attemptedAt = detail?.attemptedAt || detail?.dataUpdatedAt || new Date().toISOString();
  for (const key of fundsMetricKeys) {
    const source = metricSources[key];
    const available = source
      ? source.available === true || (source.available === undefined && !!source.source && source.source !== "none")
      : !hasSourceMetadata && metrics[key] !== 0;
    metricStates[key] = available ? (cachedStale ? "stale" : "fresh") : "unavailable";
    metricUpdatedAt[key] = remoteMetricUpdatedAt[key] || (available ? attemptedAt : "");
    if (metricStates[key] === "unavailable" && previous && previous.metricStates[key] !== "unavailable") {
      metrics[key] = previous[key];
      metricStates[key] = "stale";
      metricUpdatedAt[key] = previous.metricUpdatedAt[key] || previous.dataUpdatedAt || "";
    }
  }
  const staleTimestamps = fundsMetricKeys
    .filter((key) => metricStates[key] === "stale")
    .map((key) => metricUpdatedAt[key])
    .filter(Boolean)
    .sort();
  const freshTimestamps = fundsMetricKeys
    .filter((key) => metricStates[key] === "fresh")
    .map((key) => metricUpdatedAt[key])
    .filter(Boolean)
    .sort();
  return {
    shopId: String(row.shopId || store?.id || ""),
    shopName: String(store?.name || row.shopName || ""),
    group: String(row.group || store?.group || "未分组"),
    status: normalizeStoreStatus(row.status || store?.status),
    lastMessage: detail?.message,
    ok: detail?.ok,
    metricStates,
    metricUpdatedAt,
    dataUpdatedAt: staleTimestamps[0] || freshTimestamps.at(-1) || previous?.dataUpdatedAt || detail?.dataUpdatedAt,
    ...metrics
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
    metricStates: emptyMetricStates("fresh"),
    metricUpdatedAt: emptyMetricUpdatedAt(new Date().toISOString()),
    dataUpdatedAt: new Date().toISOString(),
    ...metrics
  };
}

function sampleFundsRows(stores: StoreOption[]) {
  return stores.map(sampleFundsRow);
}

function staleFundsRow(previous: FundsRow | undefined, store: StoreOption, message: string): FundsRow {
  if (!previous) return { ...zeroFundsRow(store), lastMessage: message, ok: false };
  const metricStates = emptyMetricStates();
  for (const key of fundsMetricKeys) {
    metricStates[key] = previous.metricStates[key] === "unavailable" ? "unavailable" : "stale";
  }
  return {
    ...previous,
    shopName: store.name,
    group: store.group,
    status: store.status,
    lastMessage: message,
    ok: false,
    metricStates,
    metricUpdatedAt: previous.metricUpdatedAt
  };
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

function fundsColumnPreferenceStorageKey(baseKey: string, schemaVersion?: string) {
  const suffix = String(schemaVersion || "fallback").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return `${baseKey}_${suffix || "fallback"}`;
}

function fundsColumnStorageKey(schemaVersion?: string) {
  return fundsColumnPreferenceStorageKey(STORAGE_KEY_FUNDS_DATA_COLUMNS, schemaVersion);
}

function fundsColumnOrderStorageKey(schemaVersion?: string) {
  return fundsColumnPreferenceStorageKey(STORAGE_KEY_FUNDS_DATA_COLUMN_ORDER, schemaVersion);
}

function fundsColumnWidthsStorageKey(schemaVersion?: string) {
  return fundsColumnPreferenceStorageKey(STORAGE_KEY_FUNDS_DATA_COLUMN_WIDTHS, schemaVersion);
}

function visibleColumnKeySet(schemaColumns: DataColumn[], schemaVersion?: string) {
  const saved = storageGet<string[]>(fundsColumnStorageKey(schemaVersion), []);
  const valid = saved.filter((key) => fundsMetricKeySet.has(key));
  const initial = valid.length ? valid : schemaColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key);
  return new Set(initial.length ? initial : defaultColumnKeys);
}

function normalizeColumnOrder(schemaColumns: DataColumn[], preferredOrder: readonly string[]) {
  const schemaKeys = schemaColumns.map((column) => column.key);
  const schemaKeySet = new Set<FundsMetricKey>(schemaKeys);
  const seen = new Set<FundsMetricKey>();
  const orderedKeys = preferredOrder.filter((key): key is FundsMetricKey => {
    if (!fundsMetricKeySet.has(key) || !schemaKeySet.has(key as FundsMetricKey) || seen.has(key as FundsMetricKey)) return false;
    seen.add(key as FundsMetricKey);
    return true;
  });
  return [...orderedKeys, ...schemaKeys.filter((key) => !seen.has(key))];
}

function savedColumnOrder(schemaColumns: DataColumn[], schemaVersion?: string) {
  const saved = storageGet<string[]>(fundsColumnOrderStorageKey(schemaVersion), []);
  return normalizeColumnOrder(schemaColumns, Array.isArray(saved) ? saved : []);
}

function clampColumnWidth(width: number) {
  return Math.min(maxMetricColumnWidth, Math.max(minMetricColumnWidth, Math.round(width)));
}

function normalizeColumnWidths(schemaColumns: DataColumn[], widths: unknown): FundsColumnWidths {
  if (!widths || typeof widths !== "object" || Array.isArray(widths)) return {};
  const source = widths as Record<string, unknown>;
  return Object.fromEntries(schemaColumns.flatMap((column) => {
    const width = source[column.key];
    return typeof width === "number" && Number.isFinite(width) ? [[column.key, clampColumnWidth(width)]] : [];
  })) as FundsColumnWidths;
}

function savedColumnWidths(schemaColumns: DataColumn[], schemaVersion?: string) {
  return normalizeColumnWidths(schemaColumns, storageGet<unknown>(fundsColumnWidthsStorageKey(schemaVersion), {}));
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

function aggregateRows(rows: FundsRow[]) {
  const totals = emptyMetrics();
  const freshCounts = Object.fromEntries(fundsMetricKeys.map((key) => [key, 0])) as Record<FundsMetricKey, number>;
  const staleCounts = Object.fromEntries(fundsMetricKeys.map((key) => [key, 0])) as Record<FundsMetricKey, number>;
  for (const row of rows) {
    for (const key of fundsMetricKeys) {
      if (row.metricStates[key] !== "unavailable") {
        totals[key] += Number(row[key] || 0);
      }
      if (row.metricStates[key] === "fresh") {
        freshCounts[key] += 1;
      } else if (row.metricStates[key] === "stale") {
        staleCounts[key] += 1;
      }
    }
  }
  return { totals, freshCounts, staleCounts };
}

function fundsRowHasKnownMetric(row: FundsRow) {
  return fundsMetricKeys.some((key) => row.metricStates[key] !== "unavailable");
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
  return value && typeof value === "object" ? value as Record<string, { source?: string; path?: string; alias?: string; formula?: string; available?: boolean }> : {};
}

function stringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, string>;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item || "")])) as Record<string, string>;
}

function formatDataTime(value?: string) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function downloadText(content: string, fileName: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportRows(rows: FundsRow[], range: string, columns: DataColumn[], details: DoudianRunDetail[], adapterVersion: string, fieldSchemaVersion: string, preview: boolean, exportFormat: ExportFormat) {
  const detailById = new Map(details.map((detail) => [String(detail.shopId || ""), detail]));
  const exportColumns = columns.filter((column) => column.export !== false);
  const header = ["店铺名称", "店铺ID", "分组", "状态", "同步状态", "同步消息", "口径", "数据时间", "适配器版本", "字段版本", "来源异常", "未命中指标", "指标来源", "指标状态", ...exportColumns.map((column) => column.label)];
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
      row.dataUpdatedAt || "",
      adapterVersion,
      fieldSchemaVersion,
      sourceFailureText(detail),
      missingMetricText(detail),
      metricSourceText(detail, exportColumns),
      exportColumns.map((column) => `${column.key}:${row.metricStates[column.key]}`).join(" | "),
      ...exportColumns.map((column) => row.metricStates[column.key] === "unavailable" ? "" : row[column.key])
    ];
  });
  const now = new Date();
  const exportDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const rowsForExport = [header, ...body];
  if (exportFormat === "Excel") {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rowsForExport);
    XLSX.utils.book_append_sheet(workbook, sheet, "资金数据");
    XLSX.writeFile(workbook, `小尊宝_资金数据导出_${exportDate}.xlsx`);
    return;
  }
  if (exportFormat === "TXT") {
    const textContent = rowsForExport.map((line) => line.map((cell) => String(cell).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\r\n");
    downloadText(`\ufeff${textContent}`, `小尊宝_资金数据导出_${exportDate}.txt`, "text/plain;charset=utf-8");
    return;
  }
  const csv = rowsForExport.map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadText(`\ufeff${csv}`, `小尊宝_资金数据导出_${exportDate}.csv`, "text/csv;charset=utf-8");
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
  const [sortKey, setSortKey] = useState<SortKey>("可提现金额");
  const [loadState, setLoadState] = useState<LoadState>(() => previewMode ? "ready" : "loading");
  const [loadMessage, setLoadMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(() => new Date());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fundsRows, setFundsRows] = useState<FundsRow[]>(() => previewMode ? sampleFundsRows(sampleStores) : []);
  const fundsRowsRef = useRef(fundsRows);
  const requestGeneration = useRef(0);
  const activeOperationIdRef = useRef("");
  const [fundsState, setFundsState] = useState<FundsLoadState>(() => previewMode ? "ready" : "idle");
  const [fundsMessage, setFundsMessage] = useState(() => previewMode ? "设计预览数据" : "");
  const [fundsDetails, setFundsDetails] = useState<DoudianRunDetail[]>([]);
  const [fundsProgress, setFundsProgress] = useState("");
  const [activeOperationId, setActiveOperationId] = useState("");
  const [fieldSchema, setFieldSchema] = useState<RemoteFundsFieldSchema>({});
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<Set<string>>(() => visibleColumnKeySet(tableColumns));
  const [columnOrder, setColumnOrder] = useState<FundsMetricKey[]>(() => savedColumnOrder(tableColumns));
  const [columnWidths, setColumnWidths] = useState<FundsColumnWidths>(() => savedColumnWidths(tableColumns));
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const [draggedColumnKey, setDraggedColumnKey] = useState<FundsMetricKey | null>(null);
  const [dragOverColumnKey, setDragOverColumnKey] = useState<FundsMetricKey | null>(null);
  const [resizingColumnKey, setResizingColumnKey] = useState<FundsMetricKey | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [adapterVersion, setAdapterVersion] = useState("");
  const [fieldSchemaVersion, setFieldSchemaVersion] = useState("");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("Excel");
  const [autoRefreshTtlMs, setAutoRefreshTtlMs] = useState(DEFAULT_AUTO_REFRESH_TTL_MS);
  const columnResizeState = useRef<{ key: FundsMetricKey; pointerId: number; startX: number; startWidth: number } | null>(null);

  function commitFundsRows(rows: FundsRow[]) {
    fundsRowsRef.current = rows;
    setFundsRows(rows);
  }

  async function refreshStores() {
    if (previewMode) {
      setStores(sampleStores);
      commitFundsRows(sampleFundsRows(sampleStores));
      setSelectedIds(new Set(sampleStores.map((store) => store.id)));
      setLoadState("ready");
      setLastSyncAt(new Date());
      return;
    }
    if (bridgeMissing) {
      setStores([]);
      commitFundsRows([]);
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
          const nextRows = nextStores.map((store) => byId.get(store.id) || zeroFundsRow(store));
          fundsRowsRef.current = nextRows;
          return nextRows;
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

  async function refreshFundsData(ids = selectedIds, generation = ++requestGeneration.current) {
    const shopIds = [...ids];
    if (bridgeMissing) {
      if (generation !== requestGeneration.current) return;
      commitFundsRows([]);
      setFundsDetails([]);
      setFundsState("error");
      setFundsMessage("本地资金数据桥接不可用");
      return;
    }
    if (!shopIds.length) {
      if (generation !== requestGeneration.current) return;
      commitFundsRows(stores.map(zeroFundsRow));
      setFundsDetails([]);
      setFundsState("ready");
      return;
    }
    if (generation !== requestGeneration.current) return;
    setSyncing(true);
    setFundsState("loading");
    setFundsMessage("");
    setFundsProgress("");
    try {
      if (previewMode) {
        setFundsProgress("设计预览资金快照");
        await wait(260);
        if (generation !== requestGeneration.current) return;
        commitFundsRows(sampleFundsRows(stores));
        setFundsDetails([]);
        setFundsMessage("设计预览数据");
        setFundsState("ready");
        setLastSyncAt(new Date());
        return;
      }
      const result = await fetchDoudianFundsData({
        shopIds
      });
      if (generation !== requestGeneration.current) return;
      if (result.status === "cancelled") {
        setFundsState("ready");
        setFundsMessage(result.message || "已取消资金数据同步");
        return;
      }
      const detailList = Array.isArray(result.details) ? result.details : [];
      const detailById = new Map(detailList.map((detail) => [String(detail.shopId || ""), detail]));
      const storeById = new Map(stores.map((store) => [store.id, store]));
      const rowById = new Map((result.rows || []).map((row) => [String(row.shopId), row]));
      const previousById = new Map(fundsRowsRef.current.map((row) => [row.shopId, row]));
      const requestedIds = new Set(shopIds);
      const nextRows = stores.map((store) => {
        const row = rowById.get(store.id);
        const detail = detailById.get(store.id);
        const previous = previousById.get(store.id);
        return row
          ? fundsRowFromRemote(row, store, detail, previous)
          : requestedIds.has(store.id)
            ? staleFundsRow(previous, store, detail?.message || "本次未返回资金数据")
            : previous || zeroFundsRow(store);
      });
      for (const row of result.rows || []) {
        const id = String(row.shopId || "");
        if (id && !storeById.has(id)) nextRows.push(fundsRowFromRemote(row, undefined, detailById.get(id), previousById.get(id)));
      }
      commitFundsRows(nextRows);
      const refreshedDetails = detailList.map((detail) => ({
        ...detail,
        usingStaleCache: nextRows.find((row) => row.shopId === String(detail.shopId || ""))
          ? fundsMetricKeys.some((key) => nextRows.find((row) => row.shopId === String(detail.shopId || ""))?.metricStates[key] === "stale")
          : false
      }));
      setFundsDetails((current) => [
        ...current.filter((detail) => !requestedIds.has(String(detail.shopId || ""))),
        ...refreshedDetails
      ]);
      setFundsMessage(result.message || "");
      setAdapterVersion(result.adapterVersion || adapterVersion);
      setFieldSchemaVersion(result.fieldSchemaVersion || fieldSchemaVersion);
      setFundsState(result.ok || result.status === "partial" ? "ready" : "error");
      setLastSyncAt(new Date());
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const storeById = new Map(stores.map((store) => [store.id, store]));
      commitFundsRows(fundsRowsRef.current.map((row) => staleFundsRow(
        row,
        storeById.get(row.shopId) || { id: row.shopId, name: row.shopName, group: row.group, status: row.status },
        errorMessage
      )));
      setFundsDetails([]);
      setFundsState("error");
      setFundsMessage(`资金任务执行失败：${errorMessage}`);
    } finally {
      if (generation === requestGeneration.current) {
        setSyncing(false);
        setFundsProgress("");
      }
    }
  }

  async function hydrateLatestFundsData(ids = selectedIds, generation = requestGeneration.current) {
    if (previewMode || !stores.length || !ids.size) return new Set<string>();
    try {
      const result = await fetchDoudianFundsDataLatest({
        shopIds: [...ids]
      });
      if (generation !== requestGeneration.current) return new Set<string>();
      if (!result.rows?.length) return new Set(ids);
      const detailList = Array.isArray(result.details) ? result.details : [];
      const detailById = new Map(detailList.map((detail) => [String(detail.shopId || ""), detail]));
      const rowById = new Map(result.rows.map((row) => [String(row.shopId), row]));
      const now = Date.now();
      const refreshIds = new Set([...ids].filter((id) => {
        const detail = detailById.get(id);
        if (!rowById.has(id) || !detail) return true;
        const updatedAt = Date.parse(detail?.dataUpdatedAt || detail?.attemptedAt || "");
        const diagnostic = detailDiagnostic(detail);
        const summary = diagnostic.rowSummary && typeof diagnostic.rowSummary === "object" ? diagnostic.rowSummary as Record<string, unknown> : {};
        return !Number.isFinite(updatedAt) ||
          now - updatedAt > autoRefreshTtlMs ||
          detail.status === "partial" ||
          Number(diagnostic.dataSourceFailureCount || 0) > 0 ||
          Number(summary.unavailableFieldCount || 0) > 0;
      }));
      commitFundsRows(stores.map((store) => {
        const row = rowById.get(store.id);
        const detail = detailById.get(store.id);
        const updatedAt = Date.parse(detail?.dataUpdatedAt || detail?.attemptedAt || "");
        const cachedStale = !Number.isFinite(updatedAt) || now - updatedAt > autoRefreshTtlMs;
        return row ? fundsRowFromRemote(row, store, detail, undefined, cachedStale) : zeroFundsRow(store);
      }));
      setFundsDetails(detailList);
      setFundsMessage(result.message || "");
      setAdapterVersion(result.adapterVersion || adapterVersion);
      setFieldSchemaVersion(result.fieldSchemaVersion || fieldSchemaVersion);
      setFundsState("ready");
      const latestTimestamp = detailList
        .map((detail) => Date.parse(detail.dataUpdatedAt || detail.attemptedAt || ""))
        .filter(Number.isFinite)
        .sort((left, right) => right - left)[0];
      if (latestTimestamp) setLastSyncAt(new Date(latestTimestamp));
      return refreshIds;
    } catch {
      // Latest cached data is optional; an explicit sync is authoritative.
      return new Set(ids);
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
        setAdapterVersion(payload.adapter.version || "");
        setFieldSchemaVersion(schema.version || "");
        const policies = payload.adapter.policies as Record<string, unknown> | undefined;
        const fundsPolicy = policies?.fundsData && typeof policies.fundsData === "object" ? policies.fundsData as Record<string, unknown> : {};
        const cachePolicy = fundsPolicy.cachePolicy && typeof fundsPolicy.cachePolicy === "object" ? fundsPolicy.cachePolicy as Record<string, unknown> : {};
        const configuredTtl = Number(cachePolicy.autoRefreshTtlMs);
        setAutoRefreshTtlMs(Number.isFinite(configuredTtl) && configuredTtl >= 0 ? configuredTtl : DEFAULT_AUTO_REFRESH_TTL_MS);
        const nextOrder = savedColumnOrder(columns, schema.version);
        const nextWidths = savedColumnWidths(columns, schema.version);
        storageSet(fundsColumnOrderStorageKey(schema.version), nextOrder);
        storageSet(fundsColumnWidthsStorageKey(schema.version), nextWidths);
        setColumnOrder(nextOrder);
        setColumnWidths(nextWidths);
        setVisibleColumnKeys(() => {
          const next = visibleColumnKeySet(columns, schema.version);
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
    const generation = ++requestGeneration.current;
    void (async () => {
      const refreshIds = await hydrateLatestFundsData(selectedIds, generation);
      if (refreshIds.size && generation === requestGeneration.current) await refreshFundsData(refreshIds, generation);
    })();
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [previewMode, loadState, stores, autoRefreshTtlMs]);

  useEffect(() => {
    return addDoudianProgressListener((event) => {
      const detail = event.detail || {};
      if (detail.taskType !== "fundsData") return;
      const operationId = detail.operationId || "";
      if (detail.status === "running") {
        if (!activeOperationIdRef.current || detail.progress === 0 || activeOperationIdRef.current === operationId) {
          activeOperationIdRef.current = operationId;
          setActiveOperationId(operationId);
        } else {
          return;
        }
      } else if (activeOperationIdRef.current === operationId) {
        activeOperationIdRef.current = "";
        setActiveOperationId("");
      } else {
        return;
      }
      const progress = Number.isFinite(detail.progress) ? `${Math.round(detail.progress)}%` : "";
      const message = detail.message || detail.resultSummary || detail.error || "";
      setFundsProgress([progress, message].filter(Boolean).join(" · "));
    });
  }, []);

  async function cancelFundsSync() {
    const operationId = activeOperationIdRef.current || activeOperationId;
    if (!operationId) return;
    await cancelDoudianStoreOperation(operationId);
    requestGeneration.current += 1;
    activeOperationIdRef.current = "";
    setActiveOperationId("");
    setSyncing(false);
    setFundsProgress("");
    setFundsState("ready");
    setFundsMessage("已取消资金数据同步");
  }

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
  const schemaVersion = fieldSchema.version || fieldSchemaVersion;
  const columnStorageKey = fundsColumnStorageKey(schemaVersion);
  const columnOrderStorageKey = fundsColumnOrderStorageKey(schemaVersion);
  const columnWidthsStorageKey = fundsColumnWidthsStorageKey(schemaVersion);
  const orderedSchemaColumns = useMemo(() => {
    const columnByKey = new Map(schemaColumns.map((column) => [column.key, column]));
    return normalizeColumnOrder(schemaColumns, columnOrder).map((key) => columnByKey.get(key) as DataColumn);
  }, [columnOrder, schemaColumns]);
  const visibleColumns = useMemo(() => {
    const next = orderedSchemaColumns.filter((column) => visibleColumnKeys.has(column.key));
    return next.length ? next : orderedSchemaColumns;
  }, [orderedSchemaColumns, visibleColumnKeys]);
  const shopColumnWidth = 174;
  const tableMinWidth = Math.max(1120, shopColumnWidth + visibleColumns.reduce((total, column) => total + (columnWidths[column.key] || defaultMetricColumnWidth), 0));
  const summarySchema = useMemo(() => normalizeRemoteSummary(fieldSchema), [fieldSchema]);
  const aggregate = useMemo(() => aggregateRows(selectedRows), [selectedRows]);
  const { totals, freshCounts, staleCounts } = aggregate;
  const selectedVisibleCount = filteredStores.filter((store) => selectedIds.has(store.id)).length;
  const allVisibleSelected = filteredStores.length > 0 && selectedVisibleCount === filteredStores.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const onlineSelectedCount = selectedRows.filter((row) => row.status === "online").length;
  const failedDetailCount = fundsDetails.filter((detail) => detail.ok === false).length;
  const staleStoreCount = selectedRows.filter((row) => fundsMetricKeys.some((key) => row.metricStates[key] === "stale")).length;
  const globalFundsFailure = fundsState === "error" && fundsDetails.length === 0 && Boolean(fundsMessage);
  const unavailableStoreCount = globalFundsFailure
    ? 0
    : selectedRows.filter((row) => fundsMetricKeys.some((key) => row.metricStates[key] === "unavailable")).length;
  const metricLabelByKey = new Map<FundsMetricKey, string>(tableColumns.map((column) => [column.key, column.label]));
  schemaColumns.forEach((column) => metricLabelByKey.set(column.key, column.label));
  const unavailableMetricDetails = (globalFundsFailure ? [] : fundsMetricKeys).map((key) => ({
    key,
    label: metricLabelByKey.get(key) || key,
    storeCount: selectedRows.filter((row) => row.metricStates[key] === "unavailable").length
  })).filter((item) => item.storeCount > 0);
  const unavailableMetricNames = unavailableMetricDetails.map((item) => item.label);
  const unavailableMetricLead = unavailableMetricNames[0] || "未知指标";
  const unavailableWarningTitle = unavailableStoreCount
    ? `${unavailableStoreCount} 家不可用：${unavailableMetricLead}${unavailableMetricNames.length > 1 ? `等 ${unavailableMetricNames.length} 项` : ""}`
    : "";
  const unavailableWarningDetail = unavailableMetricDetails.length
    ? `不可用指标：${unavailableMetricDetails.map((item) => `${item.label}（${item.storeCount} 家）`).join("、")}。页面以 -- 显示，不计为零。`
    : "";
  const dataTimestamps = selectedRows.map((row) => Date.parse(row.dataUpdatedAt || "")).filter(Number.isFinite).sort((left, right) => left - right);
  const displayedDataAt = dataTimestamps.length ? new Date(staleStoreCount ? dataTimestamps[0] : dataTimestamps.at(-1) || dataTimestamps[0]) : null;
  const selectedRowsAllUnavailable = fundsState === "ready" && selectedRows.length > 0 && selectedRows.every((row) => !fundsRowHasKnownMetric(row));
  const riskStoreCount = selectedRows.filter((row) => row.riskCount > 0).length;
  const fundsWarningTitle = failedDetailCount
    ? `${failedDetailCount} 家同步失败`
    : staleStoreCount
      ? `${staleStoreCount} 家正在显示历史有效值`
    : selectedRowsAllUnavailable && !previewMode
      ? `${selectedRows.length} 家未命中资金指标`
      : riskStoreCount
        ? `${riskStoreCount} 家存在资金事项`
        : "";
  const fundsWarningDetail = failedDetailCount
    ? "本次同步失败，已保留最近成功数据；请确认登录态后重试。"
    : staleStoreCount
      ? "部分来源本次未取得数据，金额保留为最近成功值，数据时间见单元格提示。"
    : selectedRowsAllUnavailable && !previewMode
      ? "资金桥接或字段映射尚未返回可展示的金额。"
      : riskStoreCount
        ? "存在冻结、待缴保证金、负保证金余额或非零赔付动账，请复核平台账单。"
        : "";

  const metrics: MetricItem[] = summarySchema.map((item) => {
    const key = item.key as FundsMetricKey;
    const format = (item.format || "number") as ColumnFormat;
    let detail = item.detail || "";
    if (key === "withdrawBalance") detail = `${onlineSelectedCount} 家在线`;
    if (key === "pendingSettleAmount") detail = "货款账户";
    if (key === "marginBalance") detail = "体验保证金";
    if (key === "depositPayable") detail = "体验保证金待缴";
    if (key === "riskCount") detail = `${riskStoreCount} 家店铺`;
    if (key === "subsidyTotal") detail = "佣金 + 千川";
    if (key === "compensationAmountToday") detail = `${formatNumber(totals.compensationOrderCountToday)} 单`;
    if (key === "pendingSettleOrderAmount") detail = `${formatNumber(totals.pendingSettleOrders)} 笔待结算`;
    if (key === "pendingSettleOrders") detail = "待结算订单信息";
    if (staleCounts[key] > 0) detail = `${staleCounts[key]} 家为历史有效值`;
    else if (freshCounts[key] === 0) detail = "当前不可用";
    const conditionalAlert = (
      key === "frozenBalance" ||
      key === "depositPayable" ||
      key === "marginBalance" ||
      key === "experienceMarginBalance" ||
      key === "riskCount" ||
      key === "compensationAmountToday" ||
      key === "compensationAmount7d"
    );
    const hasAlertingValue = selectedRows.some((row) => {
      if (key === "marginBalance" || key === "experienceMarginBalance") return row[key] < 0;
      if (key === "compensationAmountToday" || key === "compensationAmount7d") return row[key] !== 0;
      return row[key] > 0;
    });
    const alertingTone = conditionalAlert ? (hasAlertingValue ? item.tone || "danger" : undefined) : item.tone;
    return {
      label: item.label || key,
      value: freshCounts[key] + staleCounts[key] > 0 ? formatColumnValue(totals[key], format) : "--",
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
      if (!next.size) orderedSchemaColumns.slice(0, 1).forEach((column) => next.add(column.key));
      storageSet(columnStorageKey, [...next]);
      return next;
    });
  }

  function updateColumnOrder(update: (current: FundsMetricKey[]) => FundsMetricKey[]) {
    setColumnOrder((current) => {
      const next = update(normalizeColumnOrder(schemaColumns, current));
      storageSet(columnOrderStorageKey, next);
      return next;
    });
  }

  function moveColumn(key: FundsMetricKey, offset: -1 | 1) {
    updateColumnOrder((current) => {
      const fromIndex = current.indexOf(key);
      const toIndex = fromIndex + offset;
      if (fromIndex < 0 || toIndex < 0 || toIndex >= current.length) return current;
      const next = [...current];
      [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
      return next;
    });
  }

  function reorderColumn(sourceKey: FundsMetricKey, targetKey: FundsMetricKey) {
    if (sourceKey === targetKey) return;
    updateColumnOrder((current) => {
      const fromIndex = current.indexOf(sourceKey);
      const toIndex = current.indexOf(targetKey);
      if (fromIndex < 0 || toIndex < 0) return current;
      const next = [...current];
      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, sourceKey);
      return next;
    });
  }

  function updateColumnWidth(key: FundsMetricKey, width: number) {
    setColumnWidths((current) => {
      const next = { ...current, [key]: clampColumnWidth(width) };
      storageSet(columnWidthsStorageKey, next);
      return next;
    });
  }

  function resetColumnWidth(key: FundsMetricKey) {
    setColumnWidths((current) => {
      const next = { ...current };
      delete next[key];
      storageSet(columnWidthsStorageKey, next);
      return next;
    });
  }

  function startColumnResize(event: React.PointerEvent<HTMLSpanElement>, key: FundsMetricKey) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    columnResizeState.current = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: columnWidths[key] || defaultMetricColumnWidth
    };
    setResizingColumnKey(key);
  }

  function resizeColumn(event: React.PointerEvent<HTMLSpanElement>) {
    const resize = columnResizeState.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    updateColumnWidth(resize.key, resize.startWidth + event.clientX - resize.startX);
  }

  function finishColumnResize(event: React.PointerEvent<HTMLSpanElement>) {
    const resize = columnResizeState.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    columnResizeState.current = null;
    setResizingColumnKey(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizeColumnByKeyboard(event: React.KeyboardEvent<HTMLSpanElement>, key: FundsMetricKey) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    updateColumnWidth(key, (columnWidths[key] || defaultMetricColumnWidth) + (event.key === "ArrowLeft" ? -8 : 8));
  }

  function resetColumns() {
    const next = new Set(schemaColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key));
    if (!next.size) schemaColumns.forEach((column) => next.add(column.key));
    const nextOrder = schemaColumns.map((column) => column.key);
    storageSet(columnStorageKey, [...next]);
    storageSet(columnOrderStorageKey, nextOrder);
    storageSet(columnWidthsStorageKey, {});
    setVisibleColumnKeys(next);
    setColumnOrder(nextOrder);
    setColumnWidths({});
  }

  function toggleStores(ids: string[]) {
    setSelectedIds((current) => toggleStoreIds(current, ids));
  }

  function toggleVisibleStores() {
    toggleStores(filteredStores.map((store) => store.id));
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
              <GroupedStoreSelectionList stores={filteredStores} selectedIds={selectedIds} onToggleIds={toggleStores} />
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
            <div className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-medium text-[#667085]">
              <Landmark className="size-[14px]" strokeWidth={2} />
              <span>{CURRENT_SNAPSHOT_LABEL}</span>
            </div>
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] disabled:opacity-50" type="button" disabled={syncing || !selectedIds.size} onClick={() => void refreshFundsData()}>
              <RefreshCw className={cn("size-[14px]", syncing ? "animate-spin" : "")} strokeWidth={2} />
              同步
            </button>
            {syncing && activeOperationId ? (
              <button className="grid size-8 place-items-center rounded-md border border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" type="button" aria-label="取消资金数据同步" title="取消资金数据同步" onClick={() => void cancelFundsSync()}>
                <CircleStop className="size-[15px]" strokeWidth={2} />
              </button>
            ) : null}
            <NativeSelect value={exportFormat} options={["Excel", "CSV", "TXT"]} onChange={(value) => setExportFormat(value as ExportFormat)} />
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] disabled:opacity-50" type="button" disabled={!selectedRows.length} onClick={() => exportRows(selectedRows, CURRENT_SNAPSHOT_LABEL, visibleColumns, fundsDetails, adapterVersion, fieldSchemaVersion, previewMode, exportFormat)}>
              <Download className="size-[14px]" strokeWidth={2} />
              批量导出
            </button>
          </div>
        </div>

        <section className="overflow-x-auto overflow-y-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="grid min-w-[1120px] grid-cols-8">
            {summaryVisibleMetrics.map((item) => <MetricCell item={item} key={item.label} />)}
          </div>
        </section>

        <section className="grid min-h-0 grid-rows-[44px_minmax(0,1fr)_38px] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="relative z-40 flex items-center justify-between gap-3 border-b border-[#edf1f6] px-3.5">
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
              {fundsState !== "loading" && unavailableStoreCount ? (
                <div className="group relative min-w-0 shrink-0">
                  <span
                    className="inline-flex h-6 max-w-[360px] items-center gap-1 rounded-md border border-[#ffdca8] bg-[#fff7e8] px-2 text-[12px] font-semibold text-[#b54708] outline-none focus-visible:ring-2 focus-visible:ring-brand-fox/30"
                    tabIndex={0}
                    aria-label={unavailableWarningDetail}
                  >
                    <ShieldAlert className="size-[13px] shrink-0" strokeWidth={2} />
                    <span className="truncate">{unavailableWarningTitle}</span>
                  </span>
                  <div className="pointer-events-none invisible absolute left-0 top-[30px] z-50 w-[min(420px,calc(100vw-32px))] rounded-md border border-[#ffdca8] bg-white p-3 text-[#344054] opacity-0 shadow-[0_12px_28px_rgba(15,23,42,0.14)] transition-opacity group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100" role="tooltip">
                    <div className="mb-2 flex items-center justify-between gap-3 text-[12px] font-semibold">
                      <span>不可用指标</span>
                      <span className="text-[#b54708]">{unavailableMetricDetails.length} 项</span>
                    </div>
                    <div className="max-h-[240px] divide-y divide-[#edf1f6] overflow-y-auto">
                      {unavailableMetricDetails.map((item) => (
                        <div className="flex min-h-8 items-center justify-between gap-4 py-1.5 text-[12px]" key={item.key}>
                          <span className="min-w-0 truncate" title={item.label}>{item.label}</span>
                          <span className="shrink-0 text-[#b54708]">{item.storeCount} 家</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
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
                <div className="grid max-h-[240px] grid-cols-5 gap-2 overflow-y-auto pr-1 max-[1600px]:grid-cols-4 max-[1180px]:grid-cols-3 max-[760px]:grid-cols-2 max-[520px]:grid-cols-1">
                  {orderedSchemaColumns.map((column, index) => (
                    <div
                      className={cn(
                        "flex h-9 min-w-0 items-center rounded-md border bg-white text-[12px] transition-colors",
                        visibleColumnKeys.has(column.key) ? "border-brand-fox bg-brand-foxSoft text-brand-navy" : "border-[#dbe5f2] text-[#667085]",
                        draggedColumnKey === column.key ? "opacity-50" : "",
                        dragOverColumnKey === column.key ? "ring-2 ring-brand-fox/30" : ""
                      )}
                      key={column.key}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        if (draggedColumnKey && draggedColumnKey !== column.key) setDragOverColumnKey(column.key);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const sourceKey = (event.dataTransfer.getData("text/plain") || draggedColumnKey) as FundsMetricKey;
                        if (fundsMetricKeySet.has(sourceKey)) reorderColumn(sourceKey, column.key);
                        setDraggedColumnKey(null);
                        setDragOverColumnKey(null);
                      }}
                    >
                      <span
                        className="grid h-full w-7 shrink-0 cursor-grab place-items-center text-[#98a2b3] active:cursor-grabbing"
                        draggable
                        title={`拖动 ${column.label}`}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", column.key);
                          setDraggedColumnKey(column.key);
                        }}
                        onDragEnd={() => {
                          setDraggedColumnKey(null);
                          setDragOverColumnKey(null);
                        }}
                      >
                        <GripVertical className="size-[14px]" strokeWidth={2} />
                      </span>
                      <button className="flex h-full min-w-0 flex-1 items-center gap-2 text-left font-medium" type="button" onClick={() => toggleColumn(column.key)}>
                        <CheckboxBox checked={visibleColumnKeys.has(column.key)} />
                        <span className="truncate">{column.label}</span>
                        {column.group ? <span className="ml-auto shrink-0 text-[11px] text-[#98a2b3]">{column.group}</span> : null}
                      </button>
                      <button className="grid size-7 shrink-0 place-items-center text-[#667085] hover:text-brand-navy disabled:cursor-not-allowed disabled:opacity-30" type="button" disabled={index === 0} aria-label={`左移 ${column.label}`} title={`左移 ${column.label}`} onClick={() => moveColumn(column.key, -1)}>
                        <ArrowLeft className="size-[13px]" strokeWidth={2} />
                      </button>
                      <button className="grid size-7 shrink-0 place-items-center text-[#667085] hover:text-brand-navy disabled:cursor-not-allowed disabled:opacity-30" type="button" disabled={index === orderedSchemaColumns.length - 1} aria-label={`右移 ${column.label}`} title={`右移 ${column.label}`} onClick={() => moveColumn(column.key, 1)}>
                        <ArrowRight className="size-[13px]" strokeWidth={2} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <table className="table-fixed border-separate border-spacing-0 text-left text-[12px]" style={{ width: tableMinWidth, minWidth: tableMinWidth }}>
              <colgroup>
                <col style={{ width: shopColumnWidth }} />
                {visibleColumns.map((column) => <col key={column.key} style={{ width: columnWidths[column.key] || defaultMetricColumnWidth }} />)}
              </colgroup>
              <thead className="sticky top-0 z-20 bg-[#fbfcff] text-[#344054] shadow-[inset_0_-1px_0_#e6ebf3]">
                <tr className="h-10">
                  <th className="sticky left-0 z-30 bg-[#fbfcff] px-3 font-semibold shadow-[inset_-1px_0_0_#edf1f6]" style={{ width: shopColumnWidth, minWidth: shopColumnWidth, maxWidth: shopColumnWidth }}>店铺名称</th>
                  {visibleColumns.map((column) => (
                    <th className="relative overflow-hidden whitespace-nowrap bg-[#fbfcff] px-3 pr-4 font-semibold" key={column.key}>
                      <span className="block overflow-hidden text-ellipsis" title={column.label}>{column.label}</span>
                      <span
                        className={cn(
                          "absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none select-none outline-none before:absolute before:inset-y-2 before:right-[3px] before:w-px before:bg-[#d0d5dd] hover:before:bg-brand-fox focus-visible:before:bg-brand-fox",
                          resizingColumnKey === column.key ? "before:w-0.5 before:bg-brand-fox" : ""
                        )}
                        role="separator"
                        aria-label={`调整 ${column.label} 列宽`}
                        aria-orientation="vertical"
                        aria-valuemin={minMetricColumnWidth}
                        aria-valuemax={maxMetricColumnWidth}
                        aria-valuenow={columnWidths[column.key] || defaultMetricColumnWidth}
                        tabIndex={0}
                        title={`调整 ${column.label} 列宽`}
                        onDoubleClick={() => resetColumnWidth(column.key)}
                        onKeyDown={(event) => resizeColumnByKeyboard(event, column.key)}
                        onPointerDown={(event) => startColumnResize(event, column.key)}
                        onPointerMove={resizeColumn}
                        onPointerUp={finishColumnResize}
                        onPointerCancel={finishColumnResize}
                      />
                    </th>
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
                      const metricState = row.metricStates[column.key];
                      const updatedAt = formatDataTime(row.metricUpdatedAt[column.key] || row.dataUpdatedAt);
                      return (
                        <td
                          className={cn("overflow-hidden text-ellipsis whitespace-nowrap px-3", toneClass(resolvedTone), resolvedTone ? "font-semibold" : "")}
                          key={column.key}
                          title={metricState === "unavailable" ? `${column.label}：本次未取得该指标` : metricState === "stale" ? `历史有效值${updatedAt ? `，数据截至 ${updatedAt}` : ""}` : updatedAt ? `数据时间 ${updatedAt}` : undefined}
                        >
                          {metricState === "unavailable" ? (
                            <span className="text-[#98a2b3]">--</span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              <span>{formatColumnValue(row[column.key], column.format)}</span>
                              {metricState === "stale" ? <span className="rounded-sm bg-[#fff1d6] px-1 text-[10px] font-semibold text-[#b54708]">旧</span> : null}
                            </span>
                          )}
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
                        <span className="text-[13px] leading-6">{fundsState === "loading" ? (fundsProgress || "正在读取资金数据") : "请从左侧选择店铺"}</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-[#edf1f6] px-4 text-[12px] text-[#667085]">
            <span className="min-w-0 truncate" title={[fundsWarningDetail, unavailableWarningDetail, fundsMessage].filter(Boolean).join(" ")}>
              共 {selectedRows.length} 家店铺，最近同步 {lastSyncAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
              {displayedDataAt ? `，数据截至 ${displayedDataAt.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}
              {fundsWarningTitle ? `，${fundsWarningTitle}` : ""}
              {unavailableWarningTitle ? `，${unavailableWarningTitle}` : ""}
            </span>
            <span className="inline-flex items-center gap-2">
              <Banknote className="size-[14px]" strokeWidth={2} />
              可提现 {formatMoney(totals.withdrawBalance)}
              <ReceiptText className="ml-2 size-[14px]" strokeWidth={2} />
              待结算 {formatMoney(totals.pendingSettleAmount)}
              <Landmark className="ml-2 size-[14px]" strokeWidth={2} />
              体验保证金 {formatMoney(totals.marginBalance)}
            </span>
          </div>
        </section>
      </div>
    </section>
  );
}
