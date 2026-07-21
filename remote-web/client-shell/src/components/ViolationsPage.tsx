import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CircleStop,
  Download,
  ExternalLink,
  FileWarning,
  Filter,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Store,
  Workflow
} from "lucide-react";
import { cancelDoudianStoreOperation, fetchDoudianViolationsData, fetchDoudianViolationsDataLatest, listDoudianStores, openDoudianStore } from "../bridge/client";
import { loadDoudianAdapterPayload } from "../bridge/doudianAdapter";
import { STORAGE_KEY_VIOLATIONS_COLUMNS, storageGet, storageSet } from "../bridge/storage";
import { addDoudianProgressListener } from "../domain/doudian";
import { toggleStoreIds } from "../domain/doudian/storeSelection";
import { cn } from "../lib/utils";
import type { DoudianRunDetail, DoudianStoreStatus, DoudianStoreSummary, DoudianViolationRecord, DoudianViolationsDataResult, DoudianViolationsDataRow } from "../types";
import { GroupedStoreSelectionList } from "./GroupedStoreSelectionList";

type LoadState = "loading" | "ready" | "error";
type ViolationLoadState = "idle" | "loading" | "ready" | "partial" | "error";
type MetricTone = "default" | "blue" | "green" | "warning" | "danger";
type ColumnFormat = "number" | "money" | "text" | "date";
type SeverityFilter = "all" | "high" | "medium" | "low";
type ProcessFilter = "all" | "pending" | "appealing" | "rectifying" | "done" | "failed" | "unknown";
type TicketTypeFilter = "all" | "risk" | "penalty";
type SortKey = string;

const violationMetricKeys = [
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

type ViolationMetricKey = typeof violationMetricKeys[number];

interface StoreOption {
  id: string;
  name: string;
  group: string;
  status: DoudianStoreStatus;
}

interface ViolationRecord {
  id: string;
  shopId: string;
  shopName: string;
  group: string;
  objectType: string;
  objectId: string;
  objectName: string;
  ticketType?: "risk" | "penalty" | string;
  ticketTypeLabel?: string;
  productId: string;
  reason: string;
  violationDetail?: string;
  severity: "high" | "medium" | "low";
  severityCode?: string;
  severityLabel?: string;
  processStatus: "pending" | "appealing" | "rectifying" | "done" | "failed" | "unknown";
  processStatusCode?: string;
  processStatusLabel?: string;
  productStatus: "在售" | "已下架" | "回收站" | "未关联" | "未查询" | "无需关联";
  associationStatus?: string;
  action: string;
  executionTypes?: string[];
  dueAt: string;
  violationAt?: string;
  createdAt?: string;
  penaltyAmount: number;
  failureReason: string;
  source: "违规预警列表" | "违规处罚列表" | "商品库关联" | "处理结果";
}

type ViolationRow = {
  shopId: string;
  shopName: string;
  group: string;
  status: DoudianStoreStatus;
  lastMessage?: string;
  ok?: boolean;
  coverageStatus?: string;
  complete?: boolean;
  truncated?: boolean;
  fetchedAt?: string;
  remoteTotal?: number;
  sourceTotal?: number;
  filteredTotal?: number;
} & Record<ViolationMetricKey, number>;

interface ViolationsCapabilities {
  productAssociation: boolean;
  platformNavigation: boolean;
  platformUrl: string;
  governanceActions: boolean;
}

interface MetricItem {
  label: string;
  value: string;
  detail: string;
  tone?: MetricTone;
}

interface DataColumn {
  key: ViolationMetricKey;
  label: string;
  format: ColumnFormat;
  group?: string;
  defaultVisible?: boolean;
  export?: boolean;
  tone?: MetricTone | ((row: ViolationRow) => MetricTone | undefined);
}

interface RemoteViolationsFieldSchema {
  version?: string;
  unavailableMetrics?: string[];
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

const severityCopy: Record<ViolationRecord["severity"], { label: string; className: string }> = {
  high: { label: "高危", className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  medium: { label: "中危", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  low: { label: "低危", className: "border-[#dbe5f2] bg-white text-[#667085]" }
};

const processCopy: Record<ViolationRecord["processStatus"], { label: string; className: string }> = {
  pending: { label: "待处理", className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  appealing: { label: "申诉中", className: "border-[#bdd2ef] bg-[#f0f6ff] text-brand-navy" },
  rectifying: { label: "整改中", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  done: { label: "已处理", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" },
  failed: { label: "处理失败", className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  unknown: { label: "状态未知", className: "border-[#dbe5f2] bg-white text-[#667085]" }
};

const productStatusClass: Record<ViolationRecord["productStatus"], string> = {
  "在售": "text-[#b42318]",
  "已下架": "text-[#b54708]",
  "回收站": "text-[#667085]",
  "未关联": "text-[#b42318]",
  "未查询": "text-[#667085]",
  "无需关联": "text-[#087443]"
};

const datePresets = ["全部", "今天", "近7天", "近30天"] as const;
type DatePreset = typeof datePresets[number];
const severityFilterOptions: Array<{ value: SeverityFilter; label: string }> = [
  { value: "all", label: "全部风险" },
  { value: "high", label: "高危" },
  { value: "medium", label: "中危" },
  { value: "low", label: "低危" }
];
const processFilterOptions: Array<{ value: ProcessFilter; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "pending", label: "待处理" },
  { value: "appealing", label: "申诉中" },
  { value: "rectifying", label: "整改中" },
  { value: "done", label: "已处理" },
  { value: "failed", label: "处理失败" },
  { value: "unknown", label: "状态未知" }
];
const ticketTypeFilterOptions: Array<{ value: TicketTypeFilter; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "risk", label: "预警" },
  { value: "penalty", label: "处罚" }
];

const productMetricKeys = new Set<ViolationMetricKey>(["productLinkedCount", "productMissingCount", "offlineProductCount"]);
const DETAIL_PAGE_SIZE = 100;

const tableColumns: DataColumn[] = [
  { key: "totalRecords", label: "违规记录", format: "number", group: "处罚列表", tone: "blue" },
  { key: "pendingCount", label: "待处理", format: "number", group: "处理状态", tone: (row) => row.pendingCount > 0 ? "danger" : undefined },
  { key: "appealCount", label: "申诉中", format: "number", group: "处理状态", tone: "blue" },
  { key: "rectificationCount", label: "整改中", format: "number", group: "处理状态", tone: (row) => row.rectificationCount > 0 ? "warning" : undefined },
  { key: "highRiskCount", label: "高危违规", format: "number", group: "风险", tone: (row) => row.highRiskCount > 0 ? "danger" : undefined },
  { key: "dueSoonCount", label: "即将超时", format: "number", group: "时限", tone: (row) => row.dueSoonCount > 0 ? "warning" : undefined },
  { key: "overdueCount", label: "已超时", format: "number", group: "时限", tone: (row) => row.overdueCount > 0 ? "danger" : undefined },
  { key: "productLinkedCount", label: "已关联商品", format: "number", group: "商品联动" },
  { key: "productMissingCount", label: "未关联商品", format: "number", group: "商品联动", tone: (row) => row.productMissingCount > 0 ? "danger" : undefined },
  { key: "offlineProductCount", label: "已下架/回收", format: "number", group: "商品联动", tone: (row) => row.offlineProductCount > 0 ? "warning" : undefined },
  { key: "failedCount", label: "失败日志", format: "number", group: "执行结果", tone: (row) => row.failedCount > 0 ? "danger" : undefined },
  { key: "penaltyAmount", label: "处罚金额", format: "money", group: "处罚列表", tone: (row) => row.penaltyAmount > 0 ? "warning" : undefined }
];

const defaultColumnKeys = tableColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key);
const violationMetricKeySet = new Set<string>(violationMetricKeys);
const columnFormatSet = new Set<string>(["number", "money", "text", "date"]);
const toneSet = new Set<string>(["default", "blue", "green", "warning", "danger"]);
const defaultSummaryMetrics: NonNullable<RemoteViolationsFieldSchema["summaryMetrics"]> = [
  { key: "totalRecords", label: "违规记录", format: "number", detail: "店铺违规列表", tone: "blue" },
  { key: "pendingCount", label: "待处理", format: "number", detail: "需人工确认", tone: "danger" },
  { key: "appealCount", label: "申诉中", format: "number", detail: "等待平台结果", tone: "blue" },
  { key: "rectificationCount", label: "整改中", format: "number", detail: "商品/资质修复", tone: "warning" },
  { key: "highRiskCount", label: "高危违规", format: "number", detail: "优先处置", tone: "danger" },
  { key: "dueSoonCount", label: "即将超时", format: "number", detail: "24 小时内到期", tone: "warning" },
  { key: "overdueCount", label: "已超时", format: "number", detail: "需复盘失败原因", tone: "danger" },
  { key: "failedCount", label: "失败日志", format: "number", detail: "列表/商品/处理异常", tone: "danger" },
  { key: "productLinkedCount", label: "已关联商品", format: "number", detail: "可执行商品动作", tone: "green" },
  { key: "productMissingCount", label: "未关联商品", format: "number", detail: "需重新查商品库", tone: "danger" },
  { key: "offlineProductCount", label: "已下架/回收", format: "number", detail: "治理动作已发生", tone: "warning" },
  { key: "penaltyAmount", label: "处罚金额", format: "money", detail: "处罚列表口径", tone: "warning" }
];
const defaultSortOptions = [
  { key: "pendingCount", label: "待处理优先", direction: "desc" },
  { key: "dueSoonCount", label: "剩余时限", direction: "desc" },
  { key: "penaltyAmount", label: "处罚金额", direction: "desc" },
  { key: "failedCount", label: "失败原因", direction: "desc" }
] as Array<{ key: ViolationMetricKey; label: string; direction: "asc" | "desc" }>;

const sampleStores: StoreOption[] = [
  { id: "preview-1001", name: "赤狐样例店 A", group: "华南组", status: "online" },
  { id: "preview-1002", name: "赤狐样例店 B", group: "华东组", status: "online" },
  { id: "preview-1003", name: "赤狐样例店 C", group: "待复核", status: "check_failed" }
];

const sampleRecords: ViolationRecord[] = [
  {
    id: "V-202607-001",
    shopId: "preview-1001",
    shopName: "赤狐样例店 A",
    group: "华南组",
    objectType: "商品",
    objectId: "371900024815",
    objectName: "夏季速干防晒衣",
    productId: "371900024815",
    reason: "商品信息不一致",
    severity: "high",
    processStatus: "pending",
    productStatus: "在售",
    action: "先下架商品，再补充资质后申诉",
    dueAt: "2026-07-08 18:00",
    penaltyAmount: 200,
    failureReason: "",
    source: "违规处罚列表"
  },
  {
    id: "V-202607-002",
    shopId: "preview-1001",
    shopName: "赤狐样例店 A",
    group: "华南组",
    objectType: "商品",
    objectId: "371900024822",
    objectName: "儿童运动鞋",
    productId: "371900024822",
    reason: "夸大宣传",
    severity: "medium",
    processStatus: "rectifying",
    productStatus: "已下架",
    action: "修改标题与详情页描述",
    dueAt: "2026-07-10 12:00",
    penaltyAmount: 0,
    failureReason: "",
    source: "商品库关联"
  },
  {
    id: "V-202607-003",
    shopId: "preview-1002",
    shopName: "赤狐样例店 B",
    group: "华东组",
    objectType: "店铺",
    objectId: "preview-1002",
    objectName: "售后服务体验",
    productId: "",
    reason: "发货履约异常",
    severity: "high",
    processStatus: "appealing",
    productStatus: "无需关联",
    action: "补充物流凭证并跟进申诉",
    dueAt: "2026-07-07 20:00",
    penaltyAmount: 500,
    failureReason: "",
    source: "违规处罚列表"
  },
  {
    id: "V-202607-004",
    shopId: "preview-1002",
    shopName: "赤狐样例店 B",
    group: "华东组",
    objectType: "商品",
    objectId: "371900024866",
    objectName: "厨房收纳架",
    productId: "371900024866",
    reason: "类目错放",
    severity: "low",
    processStatus: "done",
    productStatus: "已下架",
    action: "已调整类目并提交复核",
    dueAt: "2026-07-13 10:00",
    penaltyAmount: 0,
    failureReason: "",
    source: "处理结果"
  },
  {
    id: "V-202607-005",
    shopId: "preview-1003",
    shopName: "赤狐样例店 C",
    group: "待复核",
    objectType: "商品",
    objectId: "371900024899",
    objectName: "美妆套装",
    productId: "371900024899",
    reason: "资质材料缺失",
    severity: "high",
    processStatus: "failed",
    productStatus: "未关联",
    action: "重新关联商品库后导出失败日志",
    dueAt: "2026-07-06 23:00",
    penaltyAmount: 1000,
    failureReason: "商品查询异常，未命中商品状态",
    source: "商品库关联"
  }
];

function hasNativeStoreBridge() {
  return Boolean(window.chihuNative && (window.nativeData || window.chihuNative.nativeData));
}

function hasNativeViolationsBridge() {
  return Boolean(window.chihuNative && (window.nativeData || window.chihuNative.nativeData));
}

function isDevPreviewRuntime() {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } };
  return meta.env?.DEV === true;
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

function emptyMetrics(): Record<ViolationMetricKey, number> {
  return Object.fromEntries(violationMetricKeys.map((key) => [key, 0])) as Record<ViolationMetricKey, number>;
}

function zeroViolationRow(store: StoreOption): ViolationRow {
  return {
    shopId: store.id,
    shopName: store.name,
    group: store.group,
    status: store.status,
    ...emptyMetrics()
  };
}

function visibleColumnKeySet() {
  const saved = storageGet<string[]>(STORAGE_KEY_VIOLATIONS_COLUMNS, []);
  const valid = saved.filter((key) => violationMetricKeys.includes(key as ViolationMetricKey));
  return new Set(valid.length ? valid : defaultColumnKeys);
}

function normalizeRemoteColumns(schema?: RemoteViolationsFieldSchema): DataColumn[] {
  const remoteColumns = Array.isArray(schema?.columns) ? schema.columns : [];
  const columns = remoteColumns
    .filter((column) => violationMetricKeySet.has(String(column.key || "")) && columnFormatSet.has(String(column.format || "")) && column.label)
    .map((column) => {
      const fallback = tableColumns.find((item) => item.key === column.key);
      return {
        key: column.key as ViolationMetricKey,
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

function normalizeRemoteSummary(schema?: RemoteViolationsFieldSchema) {
  const remoteMetrics = Array.isArray(schema?.summaryMetrics) ? schema.summaryMetrics : [];
  const metrics = remoteMetrics.filter((item) => (
    violationMetricKeySet.has(String(item.key || "")) &&
    columnFormatSet.has(String(item.format || "")) &&
    item.label
  ));
  return metrics.length ? metrics : defaultSummaryMetrics;
}

function normalizeRemoteSortOptions(schema?: RemoteViolationsFieldSchema) {
  const remoteOptions = Array.isArray(schema?.sortOptions) ? schema.sortOptions : [];
  const options = remoteOptions
    .filter((item) => violationMetricKeySet.has(String(item.key || "")) && item.label)
    .map((item) => ({
      key: item.key as ViolationMetricKey,
      label: String(item.label),
      direction: item.direction === "asc" ? "asc" as const : "desc" as const
    }));
  return options.length ? options : defaultSortOptions;
}

function getViolationsFieldSchema(adapter: unknown): RemoteViolationsFieldSchema {
  const policies = adapter && typeof adapter === "object" ? (adapter as { policies?: Record<string, unknown> }).policies : undefined;
  const violationsData = policies?.violationsData;
  if (!violationsData || typeof violationsData !== "object") return {};
  const schema = (violationsData as { fieldSchema?: unknown }).fieldSchema;
  return schema && typeof schema === "object" ? schema as RemoteViolationsFieldSchema : {};
}

function acceptedGate(value: unknown) {
  return ["passed", "accepted", "ready", "complete"].includes(String(value || "").toLowerCase());
}

function getViolationsCapabilities(adapter: unknown): ViolationsCapabilities {
  const policies = adapter && typeof adapter === "object" ? (adapter as { policies?: Record<string, unknown> }).policies : undefined;
  const violationsData = policies?.violationsData && typeof policies.violationsData === "object" ? policies.violationsData as Record<string, unknown> : {};
  const gates = violationsData.acceptanceGates && typeof violationsData.acceptanceGates === "object" ? violationsData.acceptanceGates as Record<string, unknown> : {};
  const association = violationsData.productAssociation && typeof violationsData.productAssociation === "object" ? violationsData.productAssociation as Record<string, unknown> : {};
  const actions = violationsData.violationActions && typeof violationsData.violationActions === "object" ? violationsData.violationActions as Record<string, unknown> : {};
  const platformLinks = Array.isArray(violationsData.platformLinks) ? violationsData.platformLinks : [];
  const platformUrl = String((platformLinks.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).key === "penaltyCenter") as Record<string, unknown> | undefined)?.url || "");
  const productAssociation = association.enabled === true && acceptedGate(gates.productAssociation);
  const platformNavigation = acceptedGate(gates.realLoginSampling) && Boolean(platformUrl);
  const governanceActions = actions.enabled === true && acceptedGate(gates.writePreviewConfirm) && Array.isArray(actions.requestPlans) && actions.requestPlans.length > 0;
  return { productAssociation, platformNavigation, platformUrl, governanceActions };
}

function violationsColumnStorageKey(schemaVersion?: string) {
  const suffix = String(schemaVersion || "fallback").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return `${STORAGE_KEY_VIOLATIONS_COLUMNS}_${suffix || "fallback"}`;
}

function visibleColumnKeySetForSchema(schemaColumns: DataColumn[], schemaVersion?: string) {
  const saved = storageGet<string[]>(violationsColumnStorageKey(schemaVersion), []);
  const valid = saved.filter((key) => violationMetricKeySet.has(key));
  const initial = valid.length ? valid : schemaColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key);
  return new Set(initial.length ? initial : defaultColumnKeys);
}

function toDate(value: string) {
  if (!value) return new Date(Number.NaN);
  return new Date(value.replace(" ", "T"));
}

function hoursUntil(value: string) {
  const time = toDate(value).getTime();
  return Number.isFinite(time) ? (time - Date.now()) / 36e5 : Number.NaN;
}

function isDueSoon(value: string) {
  const hours = hoursUntil(value);
  return Number.isFinite(hours) && hours >= 0 && hours <= 24;
}

function isOverdue(value: string) {
  const hours = hoursUntil(value);
  return Number.isFinite(hours) && hours < 0;
}

function datePresetKey(preset: DatePreset) {
  if (preset === "今天") return "today";
  if (preset === "近7天") return "7d";
  if (preset === "近30天") return "30d";
  return "all";
}

function formatDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dateRangeForPreset(preset: DatePreset) {
  const today = new Date();
  if (preset === "全部") return {};
  if (preset === "今天") {
    const value = formatDate(today);
    return { beginDate: value, endDate: value };
  }
  const days = preset === "近7天" ? 7 : 30;
  return {
    beginDate: formatDate(addDays(today, -days + 1)),
    endDate: formatDate(today)
  };
}

function rowsFromRecords(stores: StoreOption[], records: ViolationRecord[]) {
  return stores.map((store) => {
    const row = zeroViolationRow(store);
    const matched = records.filter((record) => record.shopId === store.id);
    row.totalRecords = matched.length;
    row.pendingCount = matched.filter((record) => record.processStatus === "pending").length;
    row.appealCount = matched.filter((record) => record.processStatus === "appealing").length;
    row.rectificationCount = matched.filter((record) => record.processStatus === "rectifying").length;
    row.highRiskCount = matched.filter((record) => record.severity === "high").length;
    row.dueSoonCount = matched.filter((record) => record.processStatus !== "done" && isDueSoon(record.dueAt)).length;
    row.overdueCount = matched.filter((record) => record.processStatus !== "done" && isOverdue(record.dueAt)).length;
    row.productLinkedCount = matched.filter((record) => ["online", "offline", "recycled"].includes(String(record.associationStatus || "")) || (record.productStatus !== "未关联" && record.productStatus !== "未查询" && record.productStatus !== "无需关联")).length;
    row.productMissingCount = matched.filter((record) => record.productStatus === "未关联").length;
    row.offlineProductCount = matched.filter((record) => record.productStatus === "已下架" || record.productStatus === "回收站").length;
    row.failedCount = matched.filter((record) => record.processStatus === "failed" || record.failureReason).length;
    row.penaltyAmount = matched.reduce((sum, record) => sum + record.penaltyAmount, 0);
    row.ok = row.failedCount === 0;
    row.lastMessage = matched.length ? `${matched.length} 条违规记录` : "暂无违规记录";
    return row;
  });
}

function normalizeSeverity(value: unknown): ViolationRecord["severity"] {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function normalizeProcessStatus(value: unknown): ViolationRecord["processStatus"] {
  return value === "pending" || value === "appealing" || value === "rectifying" || value === "done" || value === "failed" || value === "unknown" ? value : "unknown";
}

function normalizeObjectType(value: unknown): ViolationRecord["objectType"] {
  const next = String(value || "").trim();
  return next || "未知";
}

function normalizeProductStatus(value: unknown): ViolationRecord["productStatus"] {
  return value === "在售" || value === "已下架" || value === "回收站" || value === "未关联" || value === "未查询" || value === "无需关联" ? value : "未查询";
}

function numberValue(value: unknown) {
  const next = Number(value || 0);
  return Number.isFinite(next) ? next : 0;
}

function rowFromRemote(row: DoudianViolationsDataRow, store?: StoreOption, detail?: { ok?: boolean; message?: string }): ViolationRow {
  const next: ViolationRow = {
    shopId: String(row.shopId || store?.id || ""),
    shopName: String(store?.name || row.shopName || row.shopId || ""),
    group: String(row.group || store?.group || "未分组"),
    status: normalizeStoreStatus(row.status || store?.status),
    ok: detail?.ok ?? true,
    lastMessage: detail?.message || "",
    coverageStatus: String(row.coverageStatus || "not_queried"),
    complete: row.complete === true,
    truncated: row.truncated === true,
    fetchedAt: String(row.fetchedAt || ""),
    remoteTotal: row.remoteTotal === undefined ? undefined : numberValue(row.remoteTotal),
    sourceTotal: row.sourceTotal === undefined ? undefined : numberValue(row.sourceTotal),
    filteredTotal: row.filteredTotal === undefined ? undefined : numberValue(row.filteredTotal),
    ...emptyMetrics()
  };
  for (const key of violationMetricKeys) next[key] = numberValue(row[key]);
  return next;
}

function recordFromRemote(record: DoudianViolationRecord, store?: StoreOption): ViolationRecord {
  const fallbackId = [
    record.shopId || "shop",
    record.objectId || record.productId || "no-object",
    record.reason || record.objectName || "violation",
    record.dueAt || "no-due"
  ].map((item) => String(item).replace(/\s+/g, "_").slice(0, 48)).join("-");
  return {
    id: String(record.id || fallbackId),
    shopId: String(record.shopId || ""),
    shopName: String(store?.name || record.shopName || ""),
    group: String(record.group || "未分组"),
    objectType: normalizeObjectType(record.objectType),
    objectId: String(record.objectId || record.productId || ""),
    objectName: String(record.objectName || "-"),
    ticketType: String(record.ticketType || "penalty"),
    ticketTypeLabel: String(record.ticketTypeLabel || (record.ticketType === "risk" ? "预警" : "处罚")),
    productId: String(record.productId || ""),
    reason: String(record.reason || "违规原因待确认"),
    violationDetail: String(record.violationDetail || ""),
    severity: normalizeSeverity(record.severity),
    severityCode: String(record.severityCode ?? ""),
    severityLabel: String(record.severityLabel || ""),
    processStatus: normalizeProcessStatus(record.processStatus),
    processStatusCode: String(record.processStatusCode ?? ""),
    processStatusLabel: String(record.processStatusLabel || ""),
    productStatus: normalizeProductStatus(record.productStatus),
    associationStatus: String(record.associationStatus || ""),
    action: String(record.action || "待人工确认"),
    executionTypes: Array.isArray(record.executionTypes) ? record.executionTypes.map(String) : [],
    dueAt: String(record.dueAt || ""),
    violationAt: String(record.violationAt || ""),
    createdAt: String(record.createdAt || ""),
    penaltyAmount: numberValue(record.penaltyAmount),
    failureReason: String(record.failureReason || ""),
    source: String(record.source || "违规处罚列表") as ViolationRecord["source"]
  };
}

function detailArray(details: unknown) {
  return Array.isArray(details) ? details as Array<{ shopId?: unknown; ok?: boolean; message?: string }> : [];
}

function aggregateRows(rows: ViolationRow[]) {
  const totals = emptyMetrics();
  for (const row of rows) {
    for (const key of violationMetricKeys) totals[key] += Number(row[key] || 0);
  }
  return totals;
}

function formatNumber(value: number) {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatMoney(value: number) {
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatColumnValue(value: number, format: ColumnFormat) {
  if (format === "money") return formatMoney(value);
  if (format === "date") return String(value);
  if (format === "text") return String(value);
  return formatNumber(value);
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

function CompactTag({ label, className }: { label: string; className: string }) {
  return <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-semibold", className)}>{label}</span>;
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
  onChange,
  width = 122
}: {
  value: T;
  options: Array<T | { value: T; label: string }>;
  onChange: (value: T) => void;
  width?: number;
}) {
  return (
    <span className="relative inline-flex h-8 shrink-0 items-center rounded-md border border-[#dbe5f2] bg-white text-[12px] text-[#1d2939]" style={{ width }}>
      <select
        className="app-no-drag h-full w-full appearance-none rounded-md bg-transparent px-2.5 pr-7 outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => {
          const item = typeof option === "string" ? { value: option, label: option } : option;
          return <option key={item.value} value={item.value}>{item.label}</option>;
        })}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 size-[13px] text-[#667085]" strokeWidth={2} />
    </span>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function exportRows(
  rows: ViolationRow[],
  records: ViolationRecord[],
  columns: DataColumn[],
  details: DoudianRunDetail[],
  meta: { adapterVersion: string; fieldSchemaVersion: string; requestPlanHash: string; productLinkageVersion: string; preview: boolean; productAssociation: boolean; unavailableMetrics: ReadonlySet<ViolationMetricKey> }
) {
  const exportColumns = columns.filter((column) => column.export !== false);
  const detailById = new Map(details.map((detail) => [String(detail.shopId || ""), detail]));
  const header = ["店铺名称", "店铺ID", "分组", "状态", "同步状态", "覆盖状态", "完整", "已截断", "源记录总数", "筛选后记录数", "抓取时间", "同步消息", "adapterVersion", "fieldSchemaVersion", "requestPlanHash", "productLinkageVersion", ...exportColumns.map((column) => column.label)];
  const rowBody = rows.map((row) => [
    row.shopName,
    row.shopId,
    row.group,
    statusCopy[row.status]?.label || statusCopy.unknown.label,
    meta.preview ? "设计预览" : row.ok === false ? "有失败项" : detailById.get(row.shopId)?.status || "成功",
    row.coverageStatus || "not_queried",
    row.complete === true ? "是" : "否",
    row.truncated === true ? "是" : "否",
    row.sourceTotal ?? row.remoteTotal ?? "",
    row.filteredTotal ?? row.totalRecords,
    row.fetchedAt || "",
    detailById.get(row.shopId)?.message || row.lastMessage || "",
    meta.adapterVersion,
    meta.fieldSchemaVersion,
    meta.requestPlanHash,
    meta.productLinkageVersion,
    ...exportColumns.map((column) => meta.unavailableMetrics.has(column.key) ? "暂不可用" : formatColumnValue(row[column.key], column.format))
  ]);
  const detailHeader = ["违规ID", "店铺名称", "违规类型", "处罚对象", "处罚对象ID", "商品ID", "违规原因", "详细违规点", "违规时间", "创建时间", "风险等级", "风险代码", "处罚状态", "状态代码", ...(meta.productAssociation ? ["商品状态", "关联状态"] : []), "处罚方式", "处罚金额", "失败原因", "adapterVersion", "fieldSchemaVersion", "requestPlanHash", "productLinkageVersion"];
  const detailBody = records.map((record) => [
    record.id,
    record.shopName,
    record.ticketTypeLabel || (record.ticketType === "risk" ? "预警" : "处罚"),
    `${record.objectType} / ${record.objectName}`,
    record.objectId || "-",
    record.productId || "-",
    record.reason,
    record.violationDetail || "",
    record.violationAt || "",
    record.createdAt || "",
    record.severityLabel || severityCopy[record.severity].label,
    record.severityCode || "",
    record.processStatusLabel || processCopy[record.processStatus].label,
    record.processStatusCode || "",
    ...(meta.productAssociation ? [record.productStatus, record.associationStatus || ""] : []),
    record.action,
    meta.unavailableMetrics.has("penaltyAmount") ? "暂不可用" : formatMoney(record.penaltyAmount),
    record.failureReason,
    meta.adapterVersion,
    meta.fieldSchemaVersion,
    meta.requestPlanHash,
    meta.productLinkageVersion
  ]);
  const csv = [
    ["店铺汇总"],
    header,
    ...rowBody,
    [],
    ["违规明细"],
    detailHeader,
    ...detailBody
  ].map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `violations-${meta.preview ? "preview" : "export"}-${Date.now()}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ViolationsPage() {
  const nativeBridge = hasNativeStoreBridge();
  const previewMode = isDevPreviewRuntime() && !nativeBridge;
  const bridgeMissing = !nativeBridge && !previewMode;
  const violationsBridgeMissing = !hasNativeViolationsBridge() && !previewMode;
  const [stores, setStores] = useState<StoreOption[]>(() => previewMode ? sampleStores : []);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(previewMode ? sampleStores.map((store) => store.id) : []));
  const [query, setQuery] = useState("");
  const [datePreset, setDatePreset] = useState<typeof datePresets[number]>("全部");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [processFilter, setProcessFilter] = useState<ProcessFilter>("all");
  const [ticketTypeFilter, setTicketTypeFilter] = useState<TicketTypeFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("待处理优先");
  const [loadState, setLoadState] = useState<LoadState>(() => previewMode ? "ready" : "loading");
  const [loadMessage, setLoadMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(() => new Date());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [violationState, setViolationState] = useState<ViolationLoadState>(() => previewMode ? "ready" : "idle");
  const [violationMessage, setViolationMessage] = useState(() => previewMode ? "设计预览数据" : "");
  const [violationProgress, setViolationProgress] = useState("");
  const [activeOperationId, setActiveOperationId] = useState("");
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<Set<string>>(() => visibleColumnKeySet());
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [records, setRecords] = useState<ViolationRecord[]>(() => previewMode ? sampleRecords : []);
  const [storeRows, setStoreRows] = useState<ViolationRow[]>(() => previewMode ? rowsFromRecords(sampleStores, sampleRecords) : []);
  const [violationDetails, setViolationDetails] = useState<DoudianRunDetail[]>([]);
  const [fieldSchema, setFieldSchema] = useState<RemoteViolationsFieldSchema>({});
  const [adapterVersion, setAdapterVersion] = useState("");
  const [fieldSchemaVersion, setFieldSchemaVersion] = useState("");
  const [requestPlanHash, setRequestPlanHash] = useState("");
  const [productLinkageVersion, setProductLinkageVersion] = useState("");
  const [capabilities, setCapabilities] = useState<ViolationsCapabilities>({ productAssociation: false, platformNavigation: false, platformUrl: "", governanceActions: false });
  const [detailPage, setDetailPage] = useState(1);

  function applyViolationsResult(result: DoudianViolationsDataResult, baseStores = stores) {
    const details = detailArray(result.details);
    const detailById = new Map(details.map((detail) => [String(detail.shopId || ""), detail]));
    const rowById = new Map((result.rows || []).map((row) => [String(row.shopId || ""), row]));
    const storeById = new Map(baseStores.map((store) => [store.id, store]));
    const nextRows = baseStores.map((store) => {
      const row = rowById.get(store.id);
      return row ? rowFromRemote(row, store, detailById.get(store.id)) : zeroViolationRow(store);
    });
    const nextRecords = (result.records || []).map((record) => recordFromRemote(record, storeById.get(String(record.shopId || ""))));
    window.chihuNative?.logs?.report({
      category: "doudian-violations-page",
      event: "apply-result",
      ok: result.ok,
      status: result.status,
      message: result.message || "",
      baseStoreCount: baseStores.length,
      resultRowCount: result.rows?.length || 0,
      resultRecordCount: result.records?.length || 0,
      visibleRowCount: nextRows.length,
      visibleRecordCount: nextRecords.length,
      totalRecords: nextRows.reduce((sum, row) => sum + Number(row.totalRecords || 0), 0),
      selectedCount: selectedIds.size,
      datePreset,
      severityFilter,
      processFilter,
      ticketTypeFilter
    }).catch(() => undefined);
    setStoreRows(nextRows);
    setRecords(nextRecords);
    setViolationDetails(details as DoudianRunDetail[]);
    setAdapterVersion(result.adapterVersion || adapterVersion);
    setFieldSchemaVersion(result.fieldSchemaVersion || fieldSchemaVersion);
    setRequestPlanHash(result.requestPlanHash || requestPlanHash);
    setProductLinkageVersion(result.productLinkageVersion || productLinkageVersion);
    const hasUsableData = nextRows.some((row) => row.totalRecords > 0) || nextRecords.length > 0;
    const partial = result.status === "partial" || result.complete === false || result.truncated === true || details.some((detail) => detail.ok === false);
    setViolationState(partial && (result.ok || hasUsableData) ? "partial" : result.ok || hasUsableData ? "ready" : "error");
    setViolationMessage(result.message || "");
  }

  async function refreshStores() {
    if (previewMode) {
      setStores(sampleStores);
      setRecords(sampleRecords);
      setStoreRows(rowsFromRecords(sampleStores, sampleRecords));
      setSelectedIds(new Set(sampleStores.map((store) => store.id)));
      setLoadState("ready");
      setLoadMessage("");
      setLastSyncAt(new Date());
      return;
    }
    if (bridgeMissing) {
      setStores([]);
      setRecords([]);
      setStoreRows([]);
      setLoadState("error");
      setLoadMessage("本地店铺桥接不可用");
      return;
    }
    setSyncing(true);
    setLoadState("loading");
    try {
      const result = await listDoudianStores();
      const nextStores = (result.stores || []).map(mapStoreToOption).filter((store) => store.id);
      setStores(nextStores);
      setSelectedIds(new Set(nextStores.map((store) => store.id)));
      setRecords([]);
      setStoreRows(nextStores.map(zeroViolationRow));
      setLoadState(result.ok ? "ready" : "error");
      setLoadMessage(result.message || "");
      setViolationMessage(nextStores.length ? "可查询违规处罚列表" : "暂无本地店铺");
    } catch (error) {
      setLoadState("error");
      setLoadMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
      setLastSyncAt(new Date());
    }
  }

  async function refreshViolations() {
    const shopIds = [...selectedIds];
    if (violationsBridgeMissing) {
      setViolationState("error");
      setViolationMessage("本地违规管理桥接待接入");
      return;
    }
    if (!shopIds.length) {
      setViolationState("idle");
      setViolationMessage("请先选择店铺");
      return;
    }
    setSyncing(true);
    setViolationState("loading");
    setViolationProgress("正在查询违规处罚列表");
    try {
      await wait(260);
      if (previewMode) {
        setViolationProgress("正在关联商品库状态");
        await wait(220);
        const nextRecords = sampleRecords.filter((record) => shopIds.includes(record.shopId));
        setRecords(nextRecords);
        setStoreRows(rowsFromRecords(sampleStores, nextRecords));
        setViolationState("ready");
        setViolationMessage("设计预览数据");
        return;
      }
      const range = dateRangeForPreset(datePreset);
      const result = await fetchDoudianViolationsData({
        shopIds,
        datePreset: datePresetKey(datePreset),
        beginDate: range.beginDate,
        endDate: range.endDate,
        forceAdapter: true
      });
      if (result.status === "cancelled") {
        setViolationState("ready");
        setViolationMessage(result.message || "已取消违规数据同步");
        return;
      }
      applyViolationsResult(result);
    } catch (error) {
      setViolationState("error");
      setViolationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
      setViolationProgress("");
      setLastSyncAt(new Date());
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
        const schema = getViolationsFieldSchema(payload.adapter);
        const nextCapabilities = getViolationsCapabilities(payload.adapter);
        const columns = normalizeRemoteColumns(schema);
        setFieldSchema(schema);
        setCapabilities(nextCapabilities);
        setAdapterVersion(payload.adapter.version || "");
        setFieldSchemaVersion(schema.version || "");
        setVisibleColumnKeys((current) => {
          const currentValid = [...current].filter((key) => columns.some((column) => column.key === key));
          const next = currentValid.length ? new Set(currentValid) : visibleColumnKeySetForSchema(columns, schema.version);
          storageSet(violationsColumnStorageKey(schema.version), [...next]);
          return next;
        });
        const options = normalizeRemoteSortOptions(schema);
        const defaultSort = options.find((option) => option.key === schema.defaultSort) || options[0];
        setSortKey((current) => options.some((option) => option.label === current) ? current : defaultSort.label);
      })
      .catch((error) => {
        if (!cancelled) setViolationMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function hydrateLatestViolationsData(ids = selectedIds) {
    if (previewMode || violationsBridgeMissing || !stores.length || !ids.size) return;
    try {
      const range = dateRangeForPreset(datePreset);
      const result = await fetchDoudianViolationsDataLatest({
        shopIds: [...ids],
        datePreset: datePresetKey(datePreset),
        beginDate: range.beginDate,
        endDate: range.endDate,
        forceAdapter: true
      });
      if (!result.rows?.length && !result.records?.length) return;
      applyViolationsResult(result);
      setLastSyncAt(new Date());
    } catch {
      // Cached data is optional; explicit query remains authoritative.
    }
  }

  useEffect(() => {
    if (previewMode || violationsBridgeMissing) return;
    if (loadState !== "ready" || !stores.length) return;
    setRecords([]);
    setStoreRows([]);
    setViolationDetails([]);
    setViolationState("idle");
    setViolationMessage("");
    void hydrateLatestViolationsData();
  }, [previewMode, violationsBridgeMissing, loadState, stores.length, datePreset]);

  useEffect(() => {
    return addDoudianProgressListener((event) => {
      const detail = event.detail || {};
      if (detail.taskType !== "violationsData") return;
      if (detail.status === "running") setActiveOperationId(detail.operationId || "");
      else setActiveOperationId((current) => current === detail.operationId ? "" : current);
      const progress = Number.isFinite(detail.progress) ? `${Math.round(detail.progress)}%` : "";
      const message = detail.message || detail.resultSummary || detail.error || "";
      setViolationProgress([progress, message].filter(Boolean).join(" · "));
    });
  }, []);

  async function cancelViolationsSync() {
    if (!activeOperationId) return;
    await cancelDoudianStoreOperation(activeOperationId);
    setActiveOperationId("");
    setSyncing(false);
    setViolationProgress("");
    setViolationState("ready");
    setViolationMessage("已取消违规数据同步");
  }

  const filteredStores = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return stores;
    return stores.filter((store) => [store.name, store.id, store.group].some((value) => value.toLowerCase().includes(keyword)));
  }, [query, stores]);

  const allVisibleSelected = filteredStores.length > 0 && filteredStores.every((store) => selectedIds.has(store.id));
  const someVisibleSelected = filteredStores.some((store) => selectedIds.has(store.id)) && !allVisibleSelected;
  const onlineSelectedCount = stores.filter((store) => selectedIds.has(store.id) && store.status === "online").length;

  const filteredRecords = useMemo(() => {
    const selected = new Set(selectedIds);
    return records.filter((record) => {
      if (!selected.has(record.shopId)) return false;
      if (ticketTypeFilter !== "all" && record.ticketType !== ticketTypeFilter) return false;
      if (severityFilter !== "all" && record.severity !== severityFilter) return false;
      if (processFilter !== "all" && record.processStatus !== processFilter) return false;
      return true;
    });
  }, [processFilter, records, selectedIds, severityFilter, ticketTypeFilter]);

  const unavailableMetrics = useMemo(() => new Set(
    (Array.isArray(fieldSchema.unavailableMetrics) ? fieldSchema.unavailableMetrics : [])
      .filter((key): key is ViolationMetricKey => violationMetricKeySet.has(key))
  ), [fieldSchema]);
  const schemaColumns = useMemo(() => normalizeRemoteColumns(fieldSchema).filter((column) => capabilities.productAssociation || !productMetricKeys.has(column.key)), [capabilities.productAssociation, fieldSchema]);
  const columnStorageKey = violationsColumnStorageKey(fieldSchema.version || fieldSchemaVersion);
  const visibleColumns = useMemo(() => {
    const next = schemaColumns.filter((column) => visibleColumnKeys.has(column.key));
    return next.length ? next : schemaColumns;
  }, [schemaColumns, visibleColumnKeys]);
  const sortOptions = useMemo(() => normalizeRemoteSortOptions(fieldSchema).filter((option) => !unavailableMetrics.has(option.key)), [fieldSchema, unavailableMetrics]);
  const selectedSort = sortOptions.find((option) => option.label === sortKey) || sortOptions[0];

  const sortedRecords = useMemo(() => {
    return [...filteredRecords].sort((first, second) => {
      const direction = selectedSort?.direction === "asc" ? 1 : -1;
      if (selectedSort?.key === "dueSoonCount") return (toDate(first.dueAt).getTime() - toDate(second.dueAt).getTime()) * (selectedSort.direction === "asc" ? 1 : -1);
      if (selectedSort?.key === "penaltyAmount") return (first.penaltyAmount - second.penaltyAmount) * direction;
      if (selectedSort?.key === "failedCount") return (Number(Boolean(first.failureReason)) - Number(Boolean(second.failureReason))) * direction;
      const priority: Record<ViolationRecord["processStatus"], number> = { pending: 6, failed: 5, rectifying: 4, appealing: 3, unknown: 2, done: 1 };
      return (priority[first.processStatus] - priority[second.processStatus]) * direction || (Number(first.severity === "high") - Number(second.severity === "high")) * direction;
    });
  }, [filteredRecords, selectedSort?.direction, selectedSort?.key]);

  const selectedStores = stores.filter((store) => selectedIds.has(store.id));
  const rows = useMemo(() => {
    const rowById = new Map(storeRows.map((row) => [row.shopId, row]));
    const calculated = rowsFromRecords(selectedStores, filteredRecords).map((row) => {
      const remote = rowById.get(row.shopId);
      return remote ? {
        ...row,
        status: remote.status,
        ok: remote.ok,
        lastMessage: remote.lastMessage,
        coverageStatus: remote.coverageStatus,
        complete: remote.complete,
        truncated: remote.truncated,
        fetchedAt: remote.fetchedAt,
        remoteTotal: remote.remoteTotal,
        sourceTotal: remote.sourceTotal,
        filteredTotal: remote.filteredTotal
      } : row;
    });
    const direction = selectedSort?.direction === "asc" ? 1 : -1;
    return calculated.sort((left, right) => ((left[selectedSort?.key || "pendingCount"] || 0) - (right[selectedSort?.key || "pendingCount"] || 0)) * direction || left.shopName.localeCompare(right.shopName, "zh-CN"));
  }, [filteredRecords, selectedSort?.direction, selectedSort?.key, selectedStores, storeRows]);
  const totals = aggregateRows(rows);
  const sourceRecordTotal = rows.reduce((sum, row) => sum + Number(row.sourceTotal ?? row.remoteTotal ?? row.totalRecords), 0);
  const dateFilteredRecordTotal = rows.reduce((sum, row) => sum + Number(row.filteredTotal ?? row.totalRecords), 0);
  const failedStoreCount = rows.filter((row) => row.ok === false).length;
  const truncatedStoreCount = rows.filter((row) => row.truncated === true).length;
  const detailPageCount = Math.max(1, Math.ceil(sortedRecords.length / DETAIL_PAGE_SIZE));
  const pagedRecords = useMemo(() => sortedRecords.slice((detailPage - 1) * DETAIL_PAGE_SIZE, detailPage * DETAIL_PAGE_SIZE), [detailPage, sortedRecords]);
  useEffect(() => {
    setDetailPage((current) => Math.min(current, detailPageCount));
  }, [detailPageCount]);
  useEffect(() => {
    setDetailPage(1);
  }, [datePreset, processFilter, selectedIds, severityFilter, sortKey, ticketTypeFilter]);
  const tableMinWidth = Math.max(980, 260 + visibleColumns.length * 112);
  const shopColumnWidth = 260;
  const riskStoreCount = rows.filter((row) => row.pendingCount || row.highRiskCount || row.overdueCount || row.failedCount).length;
  const selectedDateRangeEmpty = rows.length > 0 && dateFilteredRecordTotal === 0;
  const riskRecordCount = filteredRecords.filter((record) => record.ticketType === "risk").length;
  const penaltyRecordCount = filteredRecords.length - riskRecordCount;
  const showOperationColumn = capabilities.platformNavigation;
  const detailColSpan = 9 + Number(capabilities.productAssociation) + Number(showOperationColumn);
  const summarySchema = useMemo(() => normalizeRemoteSummary(fieldSchema).filter((item) => capabilities.productAssociation || !productMetricKeys.has(item.key as ViolationMetricKey)), [capabilities.productAssociation, fieldSchema]);
  const metrics: MetricItem[] = summarySchema.map((item) => {
    const key = item.key as ViolationMetricKey;
    const format = (item.format || "number") as ColumnFormat;
    let detail = item.detail || "";
    if (key === "totalRecords") detail = `${rows.length} 家店铺`;
    if (key === "dueSoonCount") detail = "24 小时内到期";
    const unavailable = unavailableMetrics.has(key);
    if (unavailable) detail = "当前数据源未覆盖";
    const alertingTone = unavailable ? undefined : totals[key] > 0 ? item.tone : item.tone === "danger" || item.tone === "warning" ? undefined : item.tone;
    return {
      label: item.label || key,
      value: unavailable ? "暂不可用" : formatColumnValue(totals[key], format),
      detail,
      tone: alertingTone
    };
  });
  const summaryVisibleMetrics = summaryExpanded ? metrics : metrics.slice(0, 8);
  const summaryHiddenCount = Math.max(0, metrics.length - 8);
  const warningTitle = violationState === "error"
    ? violationMessage || "违规列表同步失败"
    : failedStoreCount
      ? `${formatNumber(failedStoreCount)} 家店铺查询失败`
      : truncatedStoreCount
        ? `${formatNumber(truncatedStoreCount)} 家店铺数据已截断`
        : violationState === "partial"
          ? violationMessage || "部分店铺数据不完整"
      : totals.overdueCount
      ? `${formatNumber(totals.overdueCount)} 条已超时`
      : totals.failedCount
        ? `${formatNumber(totals.failedCount)} 条失败日志`
        : totals.pendingCount
          ? `${formatNumber(totals.pendingCount)} 条待处理`
          : selectedDateRangeEmpty && violationState === "ready" && !previewMode
            ? datePreset === "全部" ? "暂无违规记录" : "所选时间范围内暂无违规记录"
            : "";
  const warningDetail = failedStoreCount || truncatedStoreCount
    ? violationMessage || "部分店铺未完成全量抓取，请重试后再据此执行治理动作。"
    : totals.overdueCount
    ? "请先处理已超时和高危违规，再处理普通整改项。"
    : totals.failedCount
      ? "违规列表失败、商品查询异常、商品处理失败会进入失败日志。"
      : totals.pendingCount
        ? "按小尊宝旧逻辑，待处理项需要结合商品状态判断治理动作。"
        : selectedDateRangeEmpty && datePreset !== "全部"
          ? `已获取 ${formatNumber(sourceRecordTotal)} 条源记录，所选时间范围内 ${formatNumber(dateFilteredRecordTotal)} 条。`
          : violationMessage;

  function toggleColumn(key: ViolationMetricKey) {
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
            <ShieldAlert className="size-[18px] text-brand-navy" strokeWidth={2.2} />
            <strong className="text-[15px] font-semibold text-[#101828]">违规总览</strong>
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
                  className={cn("h-full px-2.5 text-[12px] font-semibold transition-colors", datePreset === preset ? "bg-brand-fox text-white" : "text-[#667085] hover:bg-brand-foxSoft hover:text-brand-navy")}
                  key={preset}
                  type="button"
                  onClick={() => setDatePreset(preset)}
                >
                  {preset}
                </button>
              ))}
            </div>
            <NativeSelect value={ticketTypeFilter} options={ticketTypeFilterOptions} onChange={setTicketTypeFilter} width={102} />
            <NativeSelect value={severityFilter} options={severityFilterOptions} onChange={setSeverityFilter} width={102} />
            <NativeSelect value={processFilter} options={processFilterOptions} onChange={setProcessFilter} width={112} />
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] disabled:opacity-50" type="button" disabled={syncing || !selectedIds.size} onClick={() => void refreshViolations()}>
              <RefreshCw className={cn("size-[14px]", syncing ? "animate-spin" : "")} strokeWidth={2} />
              查询
            </button>
            {syncing && activeOperationId ? (
              <button className="grid size-8 place-items-center rounded-md border border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" type="button" aria-label="取消违规数据同步" title="取消违规数据同步" onClick={() => void cancelViolationsSync()}>
                <CircleStop className="size-[15px]" strokeWidth={2} />
              </button>
            ) : null}
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] disabled:opacity-50" type="button" disabled={!rows.length} onClick={() => exportRows(rows, sortedRecords, visibleColumns, violationDetails, { adapterVersion, fieldSchemaVersion, requestPlanHash, productLinkageVersion, preview: previewMode, productAssociation: capabilities.productAssociation, unavailableMetrics })}>
              <Download className="size-[14px]" strokeWidth={2} />
              导出日志
            </button>
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
              <Workflow className="size-[16px] text-brand-navy" strokeWidth={2.2} />
              <strong className="text-[15px] font-semibold text-[#101828]">店铺违规明细</strong>
              {violationState === "loading" ? (
                <span className="inline-flex h-6 max-w-[360px] items-center gap-1 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#667085]" title={violationProgress || "正在同步违规数据"}>
                  <Loader2 className="size-[13px] animate-spin" strokeWidth={2} />
                  <span className="truncate">{violationProgress || "同步中"}</span>
                </span>
              ) : warningTitle ? (
                <span className={cn("inline-flex h-6 max-w-[440px] items-center gap-1 rounded-md border px-2 text-[12px] font-semibold", violationState === "error" || failedStoreCount || totals.failedCount || totals.overdueCount ? "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" : "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]")} title={warningDetail}>
                  <AlertTriangle className="size-[13px] shrink-0" strokeWidth={2} />
                  <span className="truncate">{warningTitle}</span>
                </span>
              ) : violationState === "ready" ? (
                <span className="inline-flex h-6 items-center rounded-md border border-[#bff0cf] bg-[#eafaf0] px-2 text-[12px] font-semibold text-[#087443]">
                  预警 {formatNumber(riskRecordCount)} · 处罚 {formatNumber(penaltyRecordCount)}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <NativeSelect value={sortKey} options={sortOptions.map((option) => ({ value: option.label, label: option.label }))} onChange={setSortKey} width={116} />
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
                  <div className="text-[12px] font-semibold text-[#344054]">店铺汇总指标</div>
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

            <div className="border-b border-[#edf1f6] bg-white">
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
                  {rows.map((row) => (
                    <tr className="group h-[44px] hover:bg-[#f8fbff]" key={row.shopId}>
                      <td className="sticky left-0 z-10 bg-white px-3 shadow-[inset_-1px_0_0_#edf1f6] group-hover:bg-[#f8fbff]" style={{ width: shopColumnWidth, minWidth: shopColumnWidth, maxWidth: shopColumnWidth }}>
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-[#1d2939]" title={row.shopName}>{row.shopName}</div>
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-mono text-[12px] text-[#667085]">{row.shopId}</span>
                            {row.ok === false ? <span className="shrink-0 text-[11px] font-semibold text-[#b42318]">查询失败</span> : row.truncated ? <span className="shrink-0 text-[11px] font-semibold text-[#b54708]">已截断</span> : row.complete === false ? <span className="shrink-0 text-[11px] font-semibold text-[#b54708]">数据不完整</span> : null}
                          </div>
                        </div>
                      </td>
                      {visibleColumns.map((column) => {
                        const unavailable = unavailableMetrics.has(column.key);
                        const resolvedTone = unavailable ? undefined : typeof column.tone === "function" ? column.tone(row) : column.tone;
                        return (
                          <td className={cn("whitespace-nowrap px-3", toneClass(resolvedTone), resolvedTone ? "font-semibold" : "")} key={column.key}>
                            {unavailable ? "暂不可用" : formatColumnValue(row[column.key], column.format)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {!rows.length ? (
                    <tr>
                      <td className="h-[180px] text-center" colSpan={visibleColumns.length + 1}>
                        <div className="mx-auto grid w-[300px] place-items-center gap-3 text-[#667085]">
                          <span className="grid size-12 place-items-center rounded-full bg-brand-foxSoft text-brand-fox">
                            {violationState === "loading" ? <Loader2 className="size-6 animate-spin" strokeWidth={2.2} /> : <ShieldAlert className="size-6" strokeWidth={2.2} />}
                          </span>
                          <strong className="text-[14px] text-[#344054]">{violationState === "loading" ? "正在同步" : "暂无店铺汇总"}</strong>
                          <span className="text-[13px] leading-6">{violationState === "loading" ? (violationProgress || "正在读取违规数据") : "请选择左侧店铺，或点击查询违规列表。"}</span>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="min-w-[1120px]">
              <div className="flex h-10 items-center gap-2 bg-[#fbfcff] px-3.5 text-[12px] font-semibold text-[#344054] shadow-[inset_0_-1px_0_#e6ebf3]">
                <FileWarning className="size-[15px] text-brand-navy" strokeWidth={2.2} />
                违规处罚记录
                <span className="rounded-md border border-[#dbe5f2] bg-white px-2 py-1 text-[11px] text-[#667085]">{sortedRecords.length} 条</span>
                {sortedRecords.length ? <span className="text-[11px] font-normal text-[#98a2b3]">当前 {Math.min(sortedRecords.length, (detailPage - 1) * DETAIL_PAGE_SIZE + 1)}-{Math.min(sortedRecords.length, detailPage * DETAIL_PAGE_SIZE)}</span> : null}
              </div>
              <table className="w-full border-separate border-spacing-0 text-left text-[12px]">
                <thead className="bg-[#fbfcff] text-[#344054] shadow-[inset_0_-1px_0_#e6ebf3]">
                   <tr className="h-10">
                     <th className="px-3 font-semibold">店铺 / 违规ID</th>
                     <th className="px-3 font-semibold">类型</th>
                     <th className="px-3 font-semibold">处罚对象</th>
                     <th className="px-3 font-semibold">违规原因</th>
                     <th className="px-3 font-semibold">风险</th>
                     <th className="px-3 font-semibold">处罚状态</th>
                     {capabilities.productAssociation ? <th className="px-3 font-semibold">商品状态</th> : null}
                     <th className="px-3 font-semibold">违规时间</th>
                     <th className="px-3 font-semibold">处罚方式</th>
                     <th className="px-3 font-semibold">失败原因</th>
                    {showOperationColumn ? <th className="px-3 font-semibold">操作</th> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#edf1f6]">
                  {pagedRecords.map((record) => (
                    <tr className="group h-[54px] hover:bg-[#f8fbff]" key={record.id}>
                       <td className="px-3">
                         <div className="font-semibold text-[#1d2939]">{record.shopName}</div>
                         <div className="font-mono text-[11px] text-[#667085]">{record.id}</div>
                       </td>
                       <td className="px-3">
                         <CompactTag
                           label={record.ticketTypeLabel || (record.ticketType === "risk" ? "预警" : "处罚")}
                           className={record.ticketType === "risk" ? "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" : "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]"}
                         />
                       </td>
                      <td className="px-3">
                        <div className="max-w-[180px] truncate font-semibold text-[#1d2939]" title={record.objectName}>{record.objectType}：{record.objectName}</div>
                        <div className="font-mono text-[11px] text-[#667085]">{record.objectId || record.productId || "-"}</div>
                      </td>
                       <td className="max-w-[220px] px-3 font-medium text-[#344054]" title={[record.reason, record.violationDetail].filter(Boolean).join("\n")}>
                         <div className="truncate">{record.reason}</div>
                         {record.violationDetail ? <div className="truncate text-[11px] font-normal text-[#98a2b3]">{record.violationDetail}</div> : null}
                       </td>
                       <td className="px-3"><CompactTag label={record.severityLabel || severityCopy[record.severity].label} className={severityCopy[record.severity].className} /></td>
                       <td className="px-3"><CompactTag label={record.processStatusLabel || processCopy[record.processStatus].label} className={processCopy[record.processStatus].className} /></td>
                       {capabilities.productAssociation ? <td className={cn("whitespace-nowrap px-3 font-semibold", productStatusClass[record.productStatus])}>{record.productStatus}</td> : null}
                       <td className="whitespace-nowrap px-3 font-mono text-[11px] text-[#344054]">{record.violationAt || "-"}</td>
                      <td className="max-w-[220px] truncate px-3 text-[#344054]" title={record.action}>{record.action}</td>
                      <td className={cn("max-w-[180px] truncate px-3", record.failureReason ? "font-semibold text-[#b42318]" : "text-[#98a2b3]")} title={record.failureReason}>{record.failureReason || "-"}</td>
                      {showOperationColumn ? <td className="px-3">
                        <div className="flex items-center gap-1.5">
                          {capabilities.platformNavigation ? <button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2] bg-white text-[#344054] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" aria-label="打开平台处理页" title="打开平台处理页" onClick={() => void openDoudianStore(record.shopId, capabilities.platformUrl)}>
                            <ExternalLink className="size-[14px]" strokeWidth={2} />
                          </button> : null}
                        </div>
                      </td> : null}
                    </tr>
                  ))}
                  {!sortedRecords.length ? (
                    <tr>
                      <td className="h-[220px] text-center" colSpan={detailColSpan}>
                        <div className="mx-auto grid w-[320px] place-items-center gap-3 text-[#667085]">
                          <span className="grid size-12 place-items-center rounded-full bg-brand-foxSoft text-brand-fox">
                            <Filter className="size-6" strokeWidth={2.2} />
                          </span>
                          <strong className="text-[14px] text-[#344054]">{selectedDateRangeEmpty && datePreset !== "全部" ? "所选时间范围内暂无违规记录" : "暂无符合条件的违规记录"}</strong>
                          <span className="text-[13px] leading-6">可调整店铺、风险等级、处理状态或时间范围后重新查询。</span>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {detailPageCount > 1 ? (
                <div className="flex h-11 items-center justify-end gap-2 border-t border-[#edf1f6] px-3">
                  <button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2] bg-white text-[#344054] disabled:opacity-40" type="button" aria-label="上一页" title="上一页" disabled={detailPage <= 1} onClick={() => setDetailPage((page) => Math.max(1, page - 1))}>
                    <ChevronLeft className="size-4" strokeWidth={2} />
                  </button>
                  <span className="min-w-[76px] text-center text-[12px] font-semibold text-[#667085]">{detailPage} / {detailPageCount}</span>
                  <button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2] bg-white text-[#344054] disabled:opacity-40" type="button" aria-label="下一页" title="下一页" disabled={detailPage >= detailPageCount} onClick={() => setDetailPage((page) => Math.min(detailPageCount, page + 1))}>
                    <ChevronRight className="size-4" strokeWidth={2} />
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-[#edf1f6] px-4 text-[12px] text-[#667085]">
            <span className="min-w-0 truncate" title={warningDetail || violationMessage}>
              共 {rows.length} 家店铺，最近同步 {lastSyncAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
              {warningTitle ? `，${warningTitle}` : ""}
            </span>
            <span className="inline-flex items-center gap-2">
              <Clock3 className="size-[14px]" strokeWidth={2} />
              即将超时 {unavailableMetrics.has("dueSoonCount") ? "暂不可用" : formatNumber(totals.dueSoonCount)}
              <AlertTriangle className="ml-2 size-[14px]" strokeWidth={2} />
              高危 {formatNumber(totals.highRiskCount)}
              <FileWarning className="ml-2 size-[14px]" strokeWidth={2} />
              失败 {formatNumber(totals.failedCount)}
              <span className="ml-2 rounded-md border border-[#dbe5f2] bg-white px-2 py-1 text-[11px] font-semibold text-[#667085]">{riskStoreCount} 家风险店铺</span>
            </span>
          </div>
        </section>
      </div>
    </section>
  );
}
