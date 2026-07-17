import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  Download,
  Gauge,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  CircleStop,
  SlidersHorizontal,
  Store,
  Truck,
  Users
} from "lucide-react";
import { cancelDoudianStoreOperation, fetchDoudianBusinessData, fetchDoudianBusinessDataLatest, listDoudianStores } from "../bridge/client";
import { loadDoudianAdapterPayload } from "../bridge/doudianAdapter";
import { STORAGE_KEY_BUSINESS_DATA_COLUMNS, storageGet, storageSet } from "../bridge/storage";
import { addDoudianProgressListener } from "../domain/doudian";
import { cn } from "../lib/utils";
import type { DoudianBusinessDataRow, DoudianRunDetail, DoudianStoreStatus, DoudianStoreSummary } from "../types";

type DatePreset = "today" | "yesterday" | "7d" | "30d" | "custom";
type SortKey = "成交金额" | "成交订单数" | "待发货" | "近7日预警" | "体验分";
type LoadState = "loading" | "ready" | "error";
type BusinessLoadState = "idle" | "loading" | "ready" | "error";
type MetricTone = "default" | "blue" | "green" | "warning" | "danger";
type ColumnFormat = "money" | "number" | "percent" | "score";

const businessMetricKeys = [
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

type BusinessMetricKey = typeof businessMetricKeys[number];
type ScoreMetricKey = "experienceScore" | "reputationScore" | "logisticsScore" | "productScore" | "serviceScore";

interface StoreOption {
  id: string;
  name: string;
  group: string;
  status: DoudianStoreStatus;
}

type BusinessRow = {
  shopId: string;
  shopName: string;
  group: string;
  status: DoudianStoreStatus;
  lastMessage?: string;
  ok?: boolean;
  metricAvailability: Partial<Record<BusinessMetricKey, boolean>>;
} & Record<BusinessMetricKey, number>;

interface BusinessDetailDiagnostic {
  sourceFailureCount?: number;
  blockingSourceFailureCount?: number;
  sourceFailures?: Array<{ key?: string; status?: number; message?: string; optional?: boolean }>;
  coreMetricsComplete?: boolean;
  missingCoreMetricPlans?: string[];
  rowSummary?: {
    allZero?: boolean;
    allUnavailable?: boolean;
    nonZeroFieldCount?: number;
    nonZeroFields?: string[];
    availableFieldCount?: number;
    availableFields?: string[];
    unavailableFieldCount?: number;
    unavailableFields?: string[];
  };
  metricSources?: Partial<Record<BusinessMetricKey, { available?: boolean; source?: string; reason?: string }>>;
  unavailableCriticalFields?: string[];
}

interface MetricItem {
  label: string;
  value: string;
  detail: string;
  tone?: MetricTone;
}

interface DataColumn {
  key: BusinessMetricKey;
  label: string;
  format: ColumnFormat;
  group?: string;
  defaultVisible?: boolean;
  export?: boolean;
  tone?: MetricTone | ((row: BusinessRow) => MetricTone | undefined);
}

interface RemoteBusinessFieldSchema {
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
}

const datePresets: Array<{ key: DatePreset; label: string }> = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "7d", label: "近7天" },
  { key: "30d", label: "近30天" },
  { key: "custom", label: "自定义" }
];

const statusCopy: Record<DoudianStoreStatus, { label: string; className: string }> = {
  online: { label: "在线", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" },
  offline: { label: "离线", className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  check_failed: { label: "待复核", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  unknown: { label: "未知", className: "border-[#dbe5f2] bg-white text-[#667085]" }
};

const tableColumns: DataColumn[] = [
  { key: "dealAmount", label: "成交金额", format: "money", tone: "blue" },
  { key: "orderCount", label: "成交订单数", format: "number" },
  { key: "refundAmount", label: "退款金额", format: "money", tone: "warning" },
  { key: "refundOrderCount", label: "退款订单数", format: "number" },
  { key: "platformSubsidyAmount", label: "平台补贴金额", format: "money" },
  { key: "violationPending", label: "待处理违规", format: "number", tone: (row) => row.violationPending > 0 ? "danger" : undefined },
  { key: "rectificationRisk", label: "待整改风险", format: "number", tone: (row) => row.rectificationRisk > 0 ? "danger" : undefined },
  { key: "pendingShipment", label: "待发货", format: "number", tone: (row) => row.pendingShipment > 0 ? "warning" : undefined },
  { key: "ship24h", label: "24h需发货", format: "number" },
  { key: "overdueShipment", label: "超时未发货", format: "number", tone: (row) => row.overdueShipment > 0 ? "danger" : undefined },
  { key: "unpaidOrders", label: "待付款", format: "number" },
  { key: "afterSalePending", label: "待处理售后", format: "number", tone: (row) => row.afterSalePending > 0 ? "warning" : undefined },
  { key: "abnormalPackage", label: "异常包裹", format: "number", tone: (row) => row.abnormalPackage > 0 ? "danger" : undefined },
  { key: "serviceOrder", label: "服务单", format: "number" },
  { key: "buyers", label: "成交人数", format: "number" },
  { key: "customerPrice", label: "客单价", format: "money" },
  { key: "exposureUsers", label: "商品曝光人数", format: "number" },
  { key: "clickUsers", label: "商品点击人数", format: "number" },
  { key: "productExposureCount", label: "商品曝光次数", format: "number" },
  { key: "productClickCount", label: "商品点击次数", format: "number" },
  { key: "onSaleProductCount", label: "售卖中商品", format: "number" },
  { key: "offlineProductCount", label: "已下架商品", format: "number", tone: (row) => row.offlineProductCount > 0 ? "warning" : undefined },
  { key: "experienceScore", label: "体验分", format: "score", tone: "green" },
  { key: "refundRate", label: "退款率", format: "percent" },
  { key: "latest7dUnreadWarning", label: "近7日未读预警", format: "number", tone: (row) => row.latest7dUnreadWarning > 0 ? "danger" : undefined },
  { key: "couponActive", label: "优惠券", format: "number" },
  { key: "directDiscountActive", label: "单品直降", format: "number" },
  { key: "newUserBonusActive", label: "新人礼金", format: "number" },
  { key: "reputationScore", label: "口碑分", format: "score", tone: "green" },
  { key: "logisticsScore", label: "物流体验得分", format: "score" },
  { key: "disputeDeduction", label: "差评扣分", format: "number", tone: (row) => row.disputeDeduction > 0 ? "danger" : undefined },
  { key: "productScore", label: "商品体验得分", format: "score" },
  { key: "serviceScore", label: "服务体验得分", format: "score" }
];

const defaultColumnKeys = tableColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key);
const defaultSummaryMetrics: NonNullable<RemoteBusinessFieldSchema["summaryMetrics"]> = [
  { key: "dealAmount", label: "成交金额", format: "money", detail: "在线店铺", tone: "blue" },
  { key: "orderCount", label: "成交订单数", format: "number", detail: "支付成功订单" },
  { key: "refundAmount", label: "退款金额", format: "money", detail: "退款订单", tone: "warning" },
  { key: "platformSubsidyAmount", label: "平台补贴金额", format: "money", detail: "电商平台补贴" },
  { key: "violationPending", label: "待处理违规", format: "number", detail: "治理侧待办", tone: "danger" },
  { key: "rectificationRisk", label: "待整改风险", format: "number", detail: "首页待办风险", tone: "danger" },
  { key: "pendingShipment", label: "待发货", format: "number", detail: "24h内需发货", tone: "warning" },
  { key: "overdueShipment", label: "超时未发货", format: "number", detail: "发货履约风险", tone: "danger" },
  { key: "buyers", label: "成交人数", format: "number", detail: "去重买家" },
  { key: "customerPrice", label: "平均客单价", format: "money", detail: "成交金额 / 订单" },
  { key: "exposureUsers", label: "商品曝光人数", format: "number", detail: "曝光次数" },
  { key: "clickUsers", label: "商品点击人数", format: "number", detail: "点击率" },
  { key: "onSaleProductCount", label: "售卖中商品", format: "number", detail: "已下架商品" },
  { key: "couponActive", label: "营销活动", format: "number", detail: "券 / 直降 / 礼金" },
  { key: "latest7dUnreadWarning", label: "近7日未读预警", format: "number", detail: "治理预警", tone: "danger" },
  { key: "experienceScore", label: "平均体验分", format: "score", detail: "口碑分", tone: "green" }
];

const businessMetricKeySet = new Set<string>(businessMetricKeys);
const columnFormatSet = new Set<string>(["money", "number", "percent", "score"]);
const toneSet = new Set<string>(["default", "blue", "green", "warning", "danger"]);

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

function emptyMetrics(): Record<BusinessMetricKey, number> {
  return Object.fromEntries(businessMetricKeys.map((key) => [key, 0])) as Record<BusinessMetricKey, number>;
}

function zeroBusinessRow(store: StoreOption): BusinessRow {
  return {
    shopId: store.id,
    shopName: store.name,
    group: store.group,
    status: store.status,
    metricAvailability: Object.fromEntries(businessMetricKeys.map((key) => [key, false])),
    ...emptyMetrics()
  };
}

function numberValue(value: unknown) {
  const next = typeof value === "number" ? value : Number(value || 0);
  return Number.isFinite(next) ? next : 0;
}

function businessDetailDiagnostic(detail?: DoudianRunDetail): BusinessDetailDiagnostic {
  const diagnostic = detail?.diagnostic;
  return diagnostic && typeof diagnostic === "object" ? diagnostic as BusinessDetailDiagnostic : {};
}

function blockingSourceCount(detail?: DoudianRunDetail) {
  const diagnostic = businessDetailDiagnostic(detail);
  return Number(diagnostic.blockingSourceFailureCount ?? diagnostic.sourceFailureCount ?? 0);
}

function metricAvailable(row: BusinessRow, key: BusinessMetricKey) {
  return row.metricAvailability[key] === true;
}

function businessRowHasAvailableMetric(row: BusinessRow) {
  return businessMetricKeys.some((key) => metricAvailable(row, key));
}

function businessRowFromRemote(row: DoudianBusinessDataRow, store?: StoreOption, detail?: DoudianRunDetail): BusinessRow {
  const base = zeroBusinessRow({
    id: String(row.shopId || store?.id || ""),
    name: String(row.shopName || store?.name || ""),
    group: String(row.group || store?.group || "未分组"),
    status: normalizeStoreStatus(row.status || store?.status)
  });
  for (const key of businessMetricKeys) {
    base[key] = numberValue(row[key]);
  }
  const metricSources = businessDetailDiagnostic(detail).metricSources || {};
  base.metricAvailability = Object.fromEntries(businessMetricKeys.map((key) => [key, metricSources[key]?.available === true]));
  base.lastMessage = detail?.message;
  base.ok = detail?.ok;
  return base;
}

function normalizeRemoteColumns(schema?: RemoteBusinessFieldSchema): DataColumn[] {
  const remoteColumns = Array.isArray(schema?.columns) ? schema.columns : [];
  const columns = remoteColumns
    .filter((column) => businessMetricKeySet.has(String(column.key || "")) && columnFormatSet.has(String(column.format || "")) && column.label)
    .map((column) => ({
      key: column.key as BusinessMetricKey,
      label: String(column.label),
      format: column.format as ColumnFormat,
      group: column.group ? String(column.group) : undefined,
      defaultVisible: column.defaultVisible !== false,
      export: column.export !== false,
      tone: toneSet.has(String(column.tone || "")) ? column.tone : undefined
    }));
  return columns.length ? columns : tableColumns;
}

function normalizeRemoteSummary(schema?: RemoteBusinessFieldSchema) {
  const remoteMetrics = Array.isArray(schema?.summaryMetrics) ? schema.summaryMetrics : [];
  const metrics = remoteMetrics.filter((item) => (
    businessMetricKeySet.has(String(item.key || "")) &&
    columnFormatSet.has(String(item.format || "")) &&
    item.label
  ));
  return metrics.length ? metrics : defaultSummaryMetrics;
}

function getBusinessFieldSchema(adapter: unknown): RemoteBusinessFieldSchema {
  const policies = adapter && typeof adapter === "object" ? (adapter as { policies?: Record<string, unknown> }).policies : undefined;
  const businessData = policies?.businessData;
  if (!businessData || typeof businessData !== "object") return {};
  const schema = (businessData as { fieldSchema?: unknown }).fieldSchema;
  return schema && typeof schema === "object" ? schema as RemoteBusinessFieldSchema : {};
}

function visibleColumnKeySet(schemaColumns: DataColumn[]) {
  const saved = storageGet<string[]>(STORAGE_KEY_BUSINESS_DATA_COLUMNS, []);
  const valid = saved.filter((key) => businessMetricKeySet.has(key));
  const initial = valid.length ? valid : schemaColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key);
  return new Set(initial.length ? initial : defaultColumnKeys);
}

function formatMoney(value: number) {
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(value: number) {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatPercent(value: number) {
  return `${value.toFixed(2)}%`;
}

function scoreText(value: number) {
  return value > 0 ? value.toFixed(2) : "-";
}

function formatColumnValue(value: number, format: ColumnFormat, available = true) {
  if (!available) return "--";
  if (format === "money") return formatMoney(value);
  if (format === "percent") return formatPercent(value);
  if (format === "score") return scoreText(value);
  return formatNumber(value);
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dateRangeForPreset(preset: DatePreset) {
  const today = new Date();
  if (preset === "custom") {
    const value = formatDate(today);
    return { beginDate: value, endDate: value, label: `${value} - ${value}` };
  }
  if (preset === "today") {
    const value = formatDate(today);
    return { beginDate: value, endDate: value, label: `${value} - ${value}` };
  }
  if (preset === "yesterday") {
    const value = formatDate(addDays(today, -1));
    return { beginDate: value, endDate: value, label: `${value} - ${value}` };
  }
  const days = preset === "7d" ? 7 : 30;
  const beginDate = formatDate(addDays(today, -days));
  const endDate = formatDate(addDays(today, -1));
  return { beginDate, endDate, label: `${beginDate} - ${endDate}` };
}

function weightedAverage(rows: BusinessRow[], field: ScoreMetricKey) {
  const scored = rows.filter((row) => metricAvailable(row, field) && row[field] > 0);
  if (!scored.length) return 0;
  return scored.reduce((sum, row) => sum + row[field], 0) / scored.length;
}

function aggregateRows(rows: BusinessRow[]) {
  const totals = emptyMetrics();
  const availableCounts = Object.fromEntries(businessMetricKeys.map((key) => [key, 0])) as Record<BusinessMetricKey, number>;
  for (const row of rows) {
    for (const key of businessMetricKeys) {
      if (!metricAvailable(row, key)) continue;
      totals[key] += Number(row[key] || 0);
      availableCounts[key] += 1;
    }
  }
  totals.customerPrice = totals.orderCount ? totals.dealAmount / totals.orderCount : 0;
  totals.refundRate = totals.orderCount ? (totals.refundOrderCount / totals.orderCount) * 100 : totals.refundRate;
  totals.experienceScore = weightedAverage(rows, "experienceScore");
  totals.reputationScore = weightedAverage(rows, "reputationScore");
  totals.logisticsScore = weightedAverage(rows, "logisticsScore");
  totals.productScore = weightedAverage(rows, "productScore");
  totals.serviceScore = weightedAverage(rows, "serviceScore");
  return { values: totals, availableCounts };
}

function sourceFailureText(detail?: DoudianRunDetail) {
  const failures = businessDetailDiagnostic(detail).sourceFailures || [];
  if (!failures.length) return "";
  return failures.map((failure) => {
    const optional = failure.optional ? "optional" : "required";
    return [failure.key, optional, failure.status ? `HTTP ${failure.status}` : "", failure.message].filter(Boolean).join(" ");
  }).join(" | ");
}

function exportRows(rows: BusinessRow[], range: string, columns: DataColumn[], details: DoudianRunDetail[], adapterVersion: string) {
  const detailById = new Map(details.map((detail) => [String(detail.shopId || ""), detail]));
  const exportColumns = columns.filter((column) => column.export !== false);
  const header = ["店铺名称", "店铺ID", "分组", "状态", "同步状态", "同步消息", "来源异常", "适配器版本", ...exportColumns.map((column) => column.label)];
  const body = rows.map((row) => [
    row.shopName,
    row.shopId,
    row.group,
    statusCopy[row.status]?.label || statusCopy.unknown.label,
    detailById.get(row.shopId)?.ok === false ? "失败" : detailById.get(row.shopId)?.status || "成功",
    detailById.get(row.shopId)?.message || row.lastMessage || "",
    sourceFailureText(detailById.get(row.shopId)),
    adapterVersion,
    ...exportColumns.map((column) => formatColumnValue(row[column.key], column.format, metricAvailable(row, column.key)))
  ]);
  const csv = [header, ...body].map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `business-data-${range.replace(/[^\d]/g, "")}.csv`;
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

export function BusinessDataPage() {
  const nativeBridge = hasNativeStoreBridge();
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [customBeginDate, setCustomBeginDate] = useState(() => formatDate(new Date()));
  const [customEndDate, setCustomEndDate] = useState(() => formatDate(new Date()));
  const [actualDateRange, setActualDateRange] = useState<{ beginDate: string; endDate: string } | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("成交金额");
  const [loadState, setLoadState] = useState<LoadState>(() => nativeBridge ? "loading" : "error");
  const [loadMessage, setLoadMessage] = useState(() => nativeBridge ? "" : "本地店铺桥接不可用，请在赤狐客户端内打开");
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(() => new Date());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [businessRows, setBusinessRows] = useState<BusinessRow[]>([]);
  const [businessState, setBusinessState] = useState<BusinessLoadState>("idle");
  const [businessMessage, setBusinessMessage] = useState("");
  const [businessDetails, setBusinessDetails] = useState<DoudianRunDetail[]>([]);
  const [businessProgress, setBusinessProgress] = useState("");
  const [activeOperationId, setActiveOperationId] = useState("");
  const [fieldSchema, setFieldSchema] = useState<RemoteBusinessFieldSchema>({});
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<Set<string>>(() => visibleColumnKeySet(tableColumns));
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [adapterVersion, setAdapterVersion] = useState("");
  const businessRequestSeq = useRef(0);

  const requestedRange = datePreset === "custom"
    ? { beginDate: customBeginDate, endDate: customEndDate, label: `${customBeginDate} - ${customEndDate}` }
    : dateRangeForPreset(datePreset);
  const customRangeValid = datePreset !== "custom" || (!!customBeginDate && !!customEndDate && customBeginDate <= customEndDate);

  function applyBusinessResult(result: Awaited<ReturnType<typeof fetchDoudianBusinessData>>, requestedShopIds: string[]) {
    const detailList = Array.isArray(result.details) ? result.details : [];
    const detailById = new Map(detailList.map((detail) => [String(detail.shopId || ""), detail]));
    const storeById = new Map(stores.map((store) => [store.id, store]));
    setBusinessRows((currentRows) => {
      const byId = new Map(currentRows.map((row) => [row.shopId, row]));
      for (const row of result.rows || []) {
        const id = String(row.shopId || "");
        if (!id) continue;
        byId.set(id, businessRowFromRemote(row, storeById.get(id), detailById.get(id)));
      }
      return [...byId.values()].filter((row) => storeById.has(row.shopId) || requestedShopIds.includes(row.shopId));
    });
    setBusinessDetails((currentDetails) => {
      const byId = new Map(currentDetails.map((detail) => [String(detail.shopId || ""), detail]));
      detailList.forEach((detail) => byId.set(String(detail.shopId || ""), detail));
      return [...byId.values()];
    });
    if (result.dateRange?.beginDate && result.dateRange?.endDate) {
      setActualDateRange({ beginDate: result.dateRange.beginDate, endDate: result.dateRange.endDate });
    }
    setBusinessMessage(result.message || "");
    setAdapterVersion(result.adapterVersion || adapterVersion);
  }

  async function refreshStores() {
    if (!nativeBridge) {
      setLoadState("error");
      setLoadMessage("本地店铺桥接不可用，请在赤狐客户端内打开");
      return;
    }
    setSyncing(true);
    setLoadMessage("");
    try {
      const result = await listDoudianStores();
      if (result.ok) {
        const nextStores = (result.stores || []).map(mapStoreToOption).filter((store) => store.id);
        setStores(nextStores);
        setBusinessRows((currentRows) => {
          const validIds = new Set(nextStores.map((store) => store.id));
          return currentRows.filter((row) => validIds.has(row.shopId));
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

  async function refreshBusinessData(ids = selectedIds, options: { preserveSequence?: boolean } = {}) {
    const requestSeq = options.preserveSequence ? businessRequestSeq.current : businessRequestSeq.current + 1;
    if (!options.preserveSequence) businessRequestSeq.current = requestSeq;
    if (!nativeBridge) {
      setBusinessState("error");
      setBusinessMessage("本地经营数据桥接不可用");
      return;
    }
    if (!customRangeValid) {
      setBusinessState("error");
      setBusinessMessage("自定义日期的开始日期不能晚于结束日期");
      return;
    }
    const shopIds = [...ids];
    if (!shopIds.length) {
      if (requestSeq !== businessRequestSeq.current) return;
      setBusinessState("ready");
      return;
    }
    setSyncing(true);
    setBusinessState("loading");
    setBusinessMessage("");
    setBusinessProgress("");
    try {
      const result = await fetchDoudianBusinessData({
        shopIds,
        datePreset,
        ...(datePreset === "custom" ? { beginDate: customBeginDate, endDate: customEndDate } : {}),
        forceAdapter: true
      });
      if (requestSeq !== businessRequestSeq.current) return;
      applyBusinessResult(result, shopIds);
      if (result.status === "cancelled") {
        setBusinessState("ready");
        setBusinessMessage(result.message || "已取消经营数据同步");
      } else {
        setBusinessState(result.ok || result.status === "partial" ? "ready" : "error");
      }
      setLastSyncAt(new Date());
    } catch (error) {
      if (requestSeq !== businessRequestSeq.current) return;
      setBusinessState("error");
      setBusinessMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestSeq === businessRequestSeq.current) {
        setSyncing(false);
        setBusinessProgress("");
      }
    }
  }

  async function hydrateLatestBusinessData(ids = selectedIds, requestSeq = businessRequestSeq.current) {
    if (!nativeBridge || !stores.length || !ids.size) return [];
    try {
      const result = await fetchDoudianBusinessDataLatest({
        shopIds: [...ids],
        datePreset,
        ...(datePreset === "custom" ? { beginDate: customBeginDate, endDate: customEndDate } : {}),
        forceAdapter: true
      });
      if (!result.rows?.length) return [];
      if (requestSeq !== businessRequestSeq.current) return [];
      applyBusinessResult(result, [...ids]);
      return result.rows.map((row) => String(row.shopId || "")).filter(Boolean);
    } catch {
      // Latest cached data is a convenience layer; remote refresh remains authoritative.
      return [];
    }
  }

  const storeIdKey = stores.map((store) => store.id).sort().join("|");

  useEffect(() => {
    void refreshStores();
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadDoudianAdapterPayload()
      .then((payload) => {
        if (cancelled) return;
        const schema = getBusinessFieldSchema(payload.adapter);
        const columns = normalizeRemoteColumns(schema);
        setFieldSchema(schema);
        setAdapterVersion(payload.adapter.version || "");
        setVisibleColumnKeys((current) => {
          const currentValid = [...current].filter((key) => columns.some((column) => column.key === key));
          const next = currentValid.length ? new Set(currentValid) : visibleColumnKeySet(columns);
          storageSet(STORAGE_KEY_BUSINESS_DATA_COLUMNS, [...next]);
          return next;
        });
      })
      .catch((error) => {
        if (!cancelled) setBusinessMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!nativeBridge || loadState !== "ready" || !stores.length) return;
    if (!customRangeValid) {
      setBusinessState("error");
      setBusinessMessage("自定义日期的开始日期不能晚于结束日期");
      return;
    }
    const ids = new Set(selectedIds);
    const requestSeq = businessRequestSeq.current + 1;
    businessRequestSeq.current = requestSeq;
    setBusinessRows([]);
    setBusinessDetails([]);
    setActualDateRange(null);
    setBusinessState("loading");
    void (async () => {
      await hydrateLatestBusinessData(ids, requestSeq);
      if (requestSeq !== businessRequestSeq.current) return;
      await refreshBusinessData(ids, { preserveSequence: true });
    })();
  }, [nativeBridge, loadState, storeIdKey, datePreset, customBeginDate, customEndDate]);

  const selectedIdKey = [...selectedIds].sort().join("|");
  const loadedIdKey = businessRows.map((row) => row.shopId).sort().join("|");

  useEffect(() => {
    if (businessState === "loading" || loadState !== "ready") return;
    const loadedIds = new Set(businessRows.map((row) => row.shopId));
    const missingIds = [...selectedIds].filter((id) => !loadedIds.has(id));
    if (!missingIds.length) return;
    void (async () => {
      const ids = new Set(missingIds);
      const requestSeq = businessRequestSeq.current + 1;
      businessRequestSeq.current = requestSeq;
      await hydrateLatestBusinessData(ids, requestSeq);
      if (requestSeq !== businessRequestSeq.current) return;
      await refreshBusinessData(ids, { preserveSequence: true });
    })();
  }, [selectedIdKey, loadedIdKey, businessState, loadState]);

  useEffect(() => {
    return addDoudianProgressListener((event) => {
      const detail = event.detail || {};
      if (detail.taskType !== "businessData") return;
      if (detail.status === "running") setActiveOperationId(detail.operationId || "");
      else setActiveOperationId((current) => current === detail.operationId ? "" : current);
      const progress = Number.isFinite(detail.progress) ? `${Math.round(detail.progress)}%` : "";
      const message = detail.message || detail.resultSummary || detail.error || "";
      setBusinessProgress([progress, message].filter(Boolean).join(" · "));
    });
  }, []);

  async function cancelBusinessSync() {
    if (!activeOperationId) return;
    await cancelDoudianStoreOperation(activeOperationId);
    businessRequestSeq.current += 1;
    setActiveOperationId("");
    setSyncing(false);
    setBusinessProgress("");
    setBusinessState("ready");
    setBusinessMessage("已取消经营数据同步");
  }

  const filteredStores = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return stores;
    return stores.filter((store) => store.name.toLowerCase().includes(keyword) || store.id.toLowerCase().includes(keyword));
  }, [query, stores]);

  const selectedRows = useMemo(() => {
    const rows = businessRows.filter((row) => selectedIds.has(row.shopId));
    return rows.sort((left, right) => {
      if (sortKey === "成交订单数") return right.orderCount - left.orderCount;
      if (sortKey === "待发货") return right.pendingShipment - left.pendingShipment;
      if (sortKey === "近7日预警") return right.latest7dUnreadWarning - left.latest7dUnreadWarning;
      if (sortKey === "体验分") return right.experienceScore - left.experienceScore;
      return right.dealAmount - left.dealAmount;
    });
  }, [businessRows, selectedIds, sortKey]);

  const schemaColumns = useMemo(() => normalizeRemoteColumns(fieldSchema), [fieldSchema]);
  const visibleColumns = useMemo(() => {
    const next = schemaColumns.filter((column) => visibleColumnKeys.has(column.key));
    return next.length ? next : schemaColumns;
  }, [schemaColumns, visibleColumnKeys]);
  const shopColumnWidth = 174;
  const tableMinWidth = Math.max(1040, shopColumnWidth + visibleColumns.length * 92);
  const summarySchema = useMemo(() => normalizeRemoteSummary(fieldSchema), [fieldSchema]);
  const aggregated = useMemo(() => aggregateRows(selectedRows), [selectedRows]);
  const totals = aggregated.values;
  const totalAvailableCounts = aggregated.availableCounts;
  const range = requestedRange;
  const actualRangeLabel = actualDateRange ? `${actualDateRange.beginDate} - ${actualDateRange.endDate}` : "";
  const rangeTitle = actualRangeLabel && actualRangeLabel !== range.label
    ? `选择范围：${range.label}；平台实际查询：${actualRangeLabel}`
    : `查询范围：${actualRangeLabel || range.label}`;
  const selectedVisibleCount = filteredStores.filter((store) => selectedIds.has(store.id)).length;
  const allVisibleSelected = filteredStores.length > 0 && selectedVisibleCount === filteredStores.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const onlineSelectedCount = selectedRows.filter((row) => row.status === "online").length;
  const failedDetailCount = businessDetails.filter((detail) => detail.ok === false).length;
  const partialSourceCount = businessDetails.filter((detail) => blockingSourceCount(detail) > 0).length;
  const coreIncompleteCount = businessDetails.filter((detail) => businessDetailDiagnostic(detail).coreMetricsComplete === false).length;
  const missingSelectedCount = Math.max(0, selectedIds.size - selectedRows.length);
  const noMetricMatchCount = businessDetails.filter((detail) => businessDetailDiagnostic(detail).rowSummary?.allUnavailable === true).length;
  const incompleteMetricCount = businessDetails.filter((detail) => (businessDetailDiagnostic(detail).unavailableCriticalFields || []).length > 0).length;
  const selectedRowsAllUnavailable = businessState === "ready" && selectedRows.length > 0 && selectedRows.every((row) => !businessRowHasAvailableMetric(row));
  const metricMissCount = noMetricMatchCount || (selectedRowsAllUnavailable ? selectedRows.length : 0);
  const businessWarningParts = [
    missingSelectedCount ? `${missingSelectedCount} 家正在加载` : "",
    coreIncompleteCount ? `${coreIncompleteCount} 家核心交易指标不完整` : "",
    incompleteMetricCount ? `${incompleteMetricCount} 家核心字段不可用` : "",
    partialSourceCount ? `${partialSourceCount} 家关键来源异常` : "",
    metricMissCount ? `${metricMissCount} 家未命中经营指标` : ""
  ].filter(Boolean);
  const businessWarningTitle = failedDetailCount ? `${failedDetailCount} 家同步失败` : businessWarningParts.join("，");
  const businessWarningDetail = failedDetailCount
    ? "请到店铺管理确认登录态，或重新同步经营数据。"
    : businessWarningParts.length
      ? [
        missingSelectedCount ? "新增选择的店铺尚未返回数据，不会用全零值代替。" : "",
        coreIncompleteCount ? "核心交易接口未完整返回，当前仍保留评分、营销和商品等可用数据。" : "",
        incompleteMetricCount ? "核心接口成功但部分关键字段不可读，未知值以 -- 展示且不计入汇总。" : "",
        partialSourceCount ? "关键来源未返回有效数据，辅助营销和商品来源不会再污染总状态。" : "",
        metricMissCount ? "远程接口有返回，但当前映射没有读到可展示的经营指标。" : ""
      ].filter(Boolean).join(" ")
      : "";

  const metrics: MetricItem[] = summarySchema.map((item) => {
    const key = item.key as BusinessMetricKey;
    const format = (item.format || "number") as ColumnFormat;
    let detail = item.detail || "";
    if (key === "dealAmount") detail = `${onlineSelectedCount} 家在线`;
    if (key === "refundAmount") detail = totalAvailableCounts.refundOrderCount > 0 ? `${formatNumber(totals.refundOrderCount)} 笔退款` : "退款笔数 --";
    if (key === "pendingShipment") detail = totalAvailableCounts.ship24h > 0 ? `${formatNumber(totals.ship24h)} 单 24h 内` : "24h 内 --";
    if (key === "exposureUsers") detail = totalAvailableCounts.productExposureCount > 0 ? `${formatNumber(totals.productExposureCount)} 次曝光` : "曝光次数 --";
    if (key === "clickUsers") detail = totalAvailableCounts.exposureUsers > 0 && totalAvailableCounts.clickUsers > 0 && totals.exposureUsers ? `点击率 ${formatPercent((totals.clickUsers / totals.exposureUsers) * 100)}` : "点击率 --";
    if (key === "onSaleProductCount") detail = totalAvailableCounts.offlineProductCount > 0 ? `${formatNumber(totals.offlineProductCount)} 个已下架` : "已下架 --";
    if (key === "couponActive") return {
      label: item.label || "营销活动",
      value: ["couponActive", "directDiscountActive", "newUserBonusActive"].some((field) => totalAvailableCounts[field as BusinessMetricKey] > 0)
        ? formatNumber(totals.couponActive + totals.directDiscountActive + totals.newUserBonusActive)
        : "--",
      detail: item.detail || "券 / 直降 / 礼金",
      tone: item.tone
    };
    if (key === "experienceScore") detail = `口碑分 ${scoreText(totals.reputationScore)}`;
    return {
      label: item.label || key,
      value: formatColumnValue(totals[key], format, totalAvailableCounts[key] > 0),
      detail,
      tone: item.tone
    };
  });
  const summaryVisibleMetrics = summaryExpanded ? metrics : metrics.slice(0, 8);
  const summaryHiddenCount = Math.max(0, metrics.length - 8);

  function toggleColumn(key: BusinessMetricKey) {
    setVisibleColumnKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (!next.size) schemaColumns.slice(0, 1).forEach((column) => next.add(column.key));
      storageSet(STORAGE_KEY_BUSINESS_DATA_COLUMNS, [...next]);
      return next;
    });
  }

  function resetColumns() {
    const next = new Set(schemaColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key));
    if (!next.size) schemaColumns.forEach((column) => next.add(column.key));
    storageSet(STORAGE_KEY_BUSINESS_DATA_COLUMNS, [...next]);
    setVisibleColumnKeys(next);
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
    <section className={cn("grid h-full min-h-0 gap-3 overflow-hidden text-[#1d2939] max-[980px]:grid-cols-1 max-[980px]:overflow-auto", sidebarCollapsed ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[250px_minmax(0,1fr)]")}>
      {!sidebarCollapsed ? (
        <aside className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
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
            <span className="truncate text-[12px] text-[#98a2b3]">店铺列表同步</span>
            <button className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={syncing} onClick={() => void refreshStores()}>
              <RefreshCw className={cn("size-[13px]", syncing ? "animate-spin" : "")} strokeWidth={2} />
              刷新
            </button>
          </div>
        </aside>
      ) : null}

      <div className="grid min-h-0 grid-rows-[42px_auto_minmax(0,1fr)] gap-3 overflow-hidden">
        <div className="scrollbar-none flex h-[42px] items-center gap-2 overflow-x-auto overflow-y-hidden">
          <div className="flex shrink-0 items-center gap-2">
            {sidebarCollapsed ? (
              <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" onClick={() => setSidebarCollapsed(false)}>
                <PanelLeftOpen className="size-[14px]" strokeWidth={2} />
                展开店铺
              </button>
            ) : null}
            <BarChart3 className="size-[18px] text-brand-navy" strokeWidth={2.2} />
            <strong className="text-[15px] font-semibold text-[#101828]">数据总览</strong>
            <span className="rounded-md border border-[#dbe5f2] bg-white px-2 py-1 text-[12px] font-medium text-[#667085]">已选 {selectedIds.size} 家</span>
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
            {datePreset === "custom" ? (
              <div className="inline-flex h-8 items-center gap-1 rounded-md border border-[#dbe5f2] bg-white px-1.5 text-[12px] text-[#344054]">
                <input className="w-[112px] bg-transparent outline-none" type="date" value={customBeginDate} max={customEndDate || undefined} onChange={(event) => setCustomBeginDate(event.target.value)} />
                <span className="text-[#98a2b3]">至</span>
                <input className="w-[112px] bg-transparent outline-none" type="date" value={customEndDate} min={customBeginDate || undefined} onChange={(event) => setCustomEndDate(event.target.value)} />
              </div>
            ) : null}
            <div className="inline-flex h-8 max-w-[330px] items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-medium text-[#667085]" title={rangeTitle}>
              <CalendarDays className="size-[14px]" strokeWidth={2} />
              <span className="truncate">{actualRangeLabel && actualRangeLabel !== range.label ? `平台 ${actualRangeLabel}` : range.label}</span>
            </div>
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] disabled:opacity-50" type="button" disabled={syncing || !selectedIds.size || !customRangeValid} onClick={() => void refreshBusinessData()}>
              <RefreshCw className={cn("size-[14px]", syncing ? "animate-spin" : "")} strokeWidth={2} />
              刷新
            </button>
            {syncing && activeOperationId ? (
              <button className="grid size-8 place-items-center rounded-md border border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" type="button" aria-label="取消经营数据同步" title="取消经营数据同步" onClick={() => void cancelBusinessSync()}>
                <CircleStop className="size-[15px]" strokeWidth={2} />
              </button>
            ) : null}
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] disabled:opacity-50" type="button" disabled={!selectedRows.length} onClick={() => exportRows(selectedRows, range.label, visibleColumns, businessDetails, adapterVersion)}>
              <Download className="size-[14px]" strokeWidth={2} />
              批量导出
            </button>
          </div>
        </div>

        <section className="overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="grid grid-cols-8">
            {summaryVisibleMetrics.map((item) => <MetricCell item={item} key={item.label} />)}
          </div>
        </section>

        <section className="grid min-h-0 grid-rows-[44px_minmax(0,1fr)_38px] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex items-center justify-between gap-3 border-b border-[#edf1f6] px-3.5">
            <div className="flex min-w-0 items-center gap-2">
              <Gauge className="size-[16px] text-brand-navy" strokeWidth={2.2} />
              <strong className="text-[15px] font-semibold text-[#101828]">店铺明细</strong>
              {totals.overdueShipment || totals.violationPending || totals.rectificationRisk ? (
                <span className="inline-flex h-6 items-center gap-1 rounded-md border border-[#ffdca8] bg-[#fff7e8] px-2 text-[12px] font-semibold text-[#b54708]">
                  <AlertTriangle className="size-[13px]" strokeWidth={2} />
                  {formatNumber(totals.overdueShipment + totals.violationPending + totals.rectificationRisk)} 项待处理
                </span>
              ) : null}
              {businessState === "loading" ? (
                <span className="inline-flex h-6 max-w-[360px] items-center gap-1 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#667085]" title={businessProgress || "正在同步经营数据"}>
                  <Loader2 className="size-[13px] animate-spin" strokeWidth={2} />
                  <span className="truncate">{businessProgress || "同步中"}</span>
                </span>
              ) : businessState === "error" ? (
                <span className="inline-flex h-6 max-w-[360px] items-center gap-1 rounded-md border border-[#ffd1d1] bg-[#fff1f0] px-2 text-[12px] font-semibold text-[#b42318]" title={businessMessage}>
                  <AlertTriangle className="size-[13px] shrink-0" strokeWidth={2} />
                  <span className="truncate">{businessMessage || "经营数据同步失败"}</span>
                </span>
              ) : businessWarningTitle ? (
                <span className="inline-flex h-6 max-w-[440px] items-center gap-1 rounded-md border border-[#ffdca8] bg-[#fff7e8] px-2 text-[12px] font-semibold text-[#b54708]" title={businessWarningDetail}>
                  <AlertTriangle className="size-[13px]" strokeWidth={2} />
                  <span className="truncate">{businessWarningTitle}</span>
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <NativeSelect value={sortKey} options={["成交金额", "成交订单数", "待发货", "近7日预警", "体验分"]} onChange={setSortKey} />
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
                          {formatColumnValue(row[column.key], column.format, metricAvailable(row, column.key))}
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
                          {businessState === "loading" ? <Loader2 className="size-7 animate-spin" strokeWidth={2.2} /> : <BarChart3 className="size-7" strokeWidth={2.2} />}
                        </span>
                        <strong className="text-[14px] text-[#344054]">{businessState === "loading" ? "正在同步" : "暂无数据"}</strong>
                        <span className="text-[13px] leading-6">{businessState === "loading" ? (businessProgress || "正在读取经营数据") : "请选择左侧店铺或调整时间范围"}</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-[#edf1f6] px-4 text-[12px] text-[#667085]">
            <span className="min-w-0 truncate" title={businessWarningDetail || businessMessage}>
              共 {selectedRows.length} 家店铺，最近同步 {lastSyncAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
              {businessWarningTitle ? `，${businessWarningTitle}` : ""}
            </span>
            <span className="inline-flex items-center gap-2">
              <Truck className="size-[14px]" strokeWidth={2} />
              待发货 {totalAvailableCounts.pendingShipment > 0 ? formatNumber(totals.pendingShipment) : "--"}
              <Users className="ml-2 size-[14px]" strokeWidth={2} />
              成交人数 {totalAvailableCounts.buyers > 0 ? formatNumber(totals.buyers) : "--"}
              <Gauge className="ml-2 size-[14px]" strokeWidth={2} />
              平均体验 {totalAvailableCounts.experienceScore > 0 ? scoreText(totals.experienceScore) : "--"}
            </span>
          </div>
        </section>
      </div>
    </section>
  );
}
