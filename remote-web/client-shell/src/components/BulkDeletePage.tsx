import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Check,
  Download,
  FileWarning,
  Loader2,
  PackageSearch,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Store,
  Trash2,
  Upload,
  XCircle
} from "lucide-react";
import { fetchDoudianBulkDeleteProducts, listDoudianStores } from "../bridge/client";
import { toggleStoreIds } from "../domain/doudian/storeSelection";
import { cn } from "../lib/utils";
import { GroupedStoreSelectionList } from "./GroupedStoreSelectionList";
import type {
  DoudianBulkDeleteAction,
  DoudianBulkDeleteCandidate,
  DoudianBulkDeleteExecution,
  DoudianBulkDeleteFilters,
  DoudianBulkDeleteImportItem,
  DoudianBulkDeleteProductStatus,
  DoudianBulkDeleteProductStatusFilter,
  DoudianBulkDeleteProtectMode,
  DoudianBulkDeleteSourceMode,
  DoudianStoreStatus,
  DoudianStoreSummary
} from "../types";

type LoadState = "loading" | "ready" | "error";
type SourceMode = DoudianBulkDeleteSourceMode;
type DeleteMode = "recycle" | "final";
type ProtectMode = DoudianBulkDeleteProtectMode;
type ProductStatus = DoudianBulkDeleteProductStatus;
type ProductStatusFilter = DoudianBulkDeleteProductStatusFilter;
type SortKey = "匹配时间" | "销量" | "价格" | "创建时间";
type PreviewPageSize = "100" | "250" | "500";
type RunState = "idle" | "running" | "done" | "error";
type MetricTone = "default" | "blue" | "green" | "warning" | "danger";

interface StoreOption {
  id: string;
  name: string;
  group: string;
  status: DoudianStoreStatus;
}

interface FilterSettings {
  status: ProductStatusFilter;
  priceMin: number;
  priceMax: number;
  salesMin: number;
  salesMax: number;
  createdDaysMin: number;
  listedDaysMin: number;
  perStoreLimit: number;
}

interface ProductRow {
  id: string;
  productId: string;
  title: string;
  shopId: string;
  shopName: string;
  group: string;
  status: ProductStatus;
  price?: number;
  sales?: number;
  stock?: number;
  createdDays: number;
  listedDays: number;
  exposure?: number;
  lastUpdated: string;
  source: string;
}

interface PreviewRow extends ProductRow {
  targetAction: string;
  excludedReason: string;
  warning: string;
  ok?: boolean;
  remote?: DoudianBulkDeleteCandidate;
}

interface MetricItem {
  label: string;
  value: string;
  detail: string;
  tone?: MetricTone;
}

const defaultFilters: FilterSettings = {
  status: "all",
  priceMin: 0,
  priceMax: 999999999,
  salesMin: 0,
  salesMax: 999999999,
  createdDaysMin: 0,
  listedDaysMin: 0,
  perStoreLimit: 0
};

const statusCopy: Record<DoudianStoreStatus, { label: string; className: string }> = {
  online: { label: "在线", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" },
  offline: { label: "离线", className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  check_failed: { label: "待复核", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  unknown: { label: "未知", className: "border-[#dbe5f2] bg-white text-[#667085]" }
};

const productStatusCopy: Record<ProductStatus, { label: string; className: string }> = {
  selling: { label: "售卖中", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" },
  offline: { label: "已下架", className: "border-[#dbe5f2] bg-white text-[#667085]" },
  recycle: { label: "回收站", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  rejected: { label: "审核驳回", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  unknown: { label: "未知", className: "border-[#dbe5f2] bg-white text-[#667085]" }
};

const productStatusOptions: Array<{ value: ProductStatusFilter; label: string }> = [
  { value: "all", label: "全部商品" },
  { value: "selling", label: "售卖中" },
  { value: "offline", label: "已下架" }
];

const sortOptions: SortKey[] = ["匹配时间", "销量", "价格", "创建时间"];
const previewPageSizeOptions: Array<{ value: PreviewPageSize; label: string }> = [
  { value: "100", label: "100 行" },
  { value: "250", label: "250 行" },
  { value: "500", label: "500 行" }
];

const sampleStores: StoreOption[] = [
  { id: "preview-1001", name: "赤狐样例店 A", group: "华南组", status: "online" },
  { id: "preview-1002", name: "赤狐样例店 B", group: "华东组", status: "online" },
  { id: "preview-1003", name: "赤狐样例店 C", group: "待复核", status: "check_failed" }
];

const sampleProductTemplates = [
  { title: "夏季速干防晒衣 轻薄透气", status: "selling" as const, price: 89.9, sales: 2, stock: 136, createdDays: 76, listedDays: 62, exposure: 1840 },
  { title: "儿童防滑凉鞋 清仓款", status: "offline" as const, price: 39.9, sales: 0, stock: 84, createdDays: 121, listedDays: 108, exposure: 420 },
  { title: "厨房沥水置物架 加厚升级", status: "selling" as const, price: 29.8, sales: 18, stock: 312, createdDays: 42, listedDays: 39, exposure: 5200 },
  { title: "北欧陶瓷马克杯 单只装", status: "recycle" as const, price: 16.9, sales: 1, stock: 27, createdDays: 188, listedDays: 156, exposure: 260 },
  { title: "户外折叠露营椅 便携款", status: "selling" as const, price: 128, sales: 4, stock: 58, createdDays: 95, listedDays: 80, exposure: 1260 },
  { title: "无痕收纳挂钩 10只装", status: "offline" as const, price: 12.9, sales: 0, stock: 600, createdDays: 216, listedDays: 203, exposure: 350 },
  { title: "运动冰丝袖套 防晒男女款", status: "selling" as const, price: 19.9, sales: 7, stock: 240, createdDays: 68, listedDays: 66, exposure: 2980 },
  { title: "宠物自动饮水器 替换滤芯", status: "offline" as const, price: 24.9, sales: 3, stock: 144, createdDays: 137, listedDays: 119, exposure: 710 }
];

function hasNativeStoreBridge() {
  return Boolean(window.chihuNative && (window.nativeData || window.chihuNative.nativeData));
}

function isDevPreviewRuntime() {
  return ["localhost", "127.0.0.1", ""].includes(window.location.hostname) || window.location.protocol === "file:";
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

function formatNumber(value: number | undefined) {
  return Number.isFinite(value) ? value!.toLocaleString("zh-CN") : "未知";
}

function formatMoney(value: number | undefined) {
  return Number.isFinite(value) ? `¥${value!.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "未知";
}

function clampNumber(value: number, min = 0) {
  return Number.isFinite(value) ? Math.max(min, value) : min;
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function normalizeImportRef(value: string) {
  return normalizeText(value).replace(/\s+/g, "");
}

function splitImportLine(line: string) {
  const coarse = line.split(/[\t,，;；|]+/).map((item) => item.trim()).filter(Boolean);
  return (coarse.length > 1 ? coarse : line.split(/\s+/)).map((item) => item.trim()).filter(Boolean);
}

function resolveImportStore(ref: string, stores: StoreOption[]) {
  const normalized = normalizeImportRef(ref);
  if (!normalized) return null;
  return stores.find((store) => normalizeImportRef(store.id) === normalized || normalizeImportRef(store.name) === normalized) || null;
}

function parseProductImportItems(text: string, stores: StoreOption[] = []): DoudianBulkDeleteImportItem[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const raw = line.trim();
    if (!raw) return [];
    const tokens = splitImportLine(raw);
    let productIndex = -1;
    for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex -= 1) {
      if (/^\d{5,}$/.test(tokens[tokenIndex])) {
        productIndex = tokenIndex;
        break;
      }
    }
    if (productIndex < 0) {
      return [{ productId: "", sourceLine: index + 1, raw, validationStatus: "missing_product_id" }];
    }
    const productId = tokens[productIndex];
    const storeRef = tokens.filter((_token, tokenIndex) => tokenIndex !== productIndex).join(" ").trim();
    const matchedStore = storeRef ? resolveImportStore(storeRef, stores) : null;
    return [{
      productId,
      ...(matchedStore ? { shopId: matchedStore.id, shopName: matchedStore.name } : storeRef ? /^\d+$/.test(storeRef) ? { shopId: storeRef } : { shopName: storeRef } : {}),
      sourceLine: index + 1,
      raw,
      validationStatus: storeRef && !matchedStore ? "unknown_store" : "ok"
    }];
  });
}

function parseProductIds(text: string) {
  return Array.from(new Set(parseProductImportItems(text).map((item) => item.productId).filter(Boolean)));
}

function importItemMatchesPreviewRow(item: DoudianBulkDeleteImportItem, row: ProductRow) {
  if (!item.shopId && !item.shopName) return true;
  if (item.shopId && normalizeImportRef(item.shopId) === normalizeImportRef(row.shopId)) return true;
  return Boolean(item.shopName && normalizeImportRef(item.shopName) === normalizeImportRef(row.shopName));
}

function defaultIdText() {
  return hasNativeStoreBridge() ? "" : "71000113\n71000214\n71000517";
}

function looksLikeProductIdImport(text: string) {
  const ids = parseProductIds(text);
  return ids.length > 1 && ids.every((id) => /^\d{5,}$/.test(id));
}

function daysAgoText(days: number) {
  if (!Number.isFinite(days) || days < 0) return "未知";
  return `${formatNumber(days)} 天`;
}

function buildSampleProducts(stores: StoreOption[]): ProductRow[] {
  return stores.flatMap((store, storeIndex) => sampleProductTemplates.map((template, templateIndex) => {
    const productIndex = storeIndex * 100 + templateIndex + 1;
    const productId = `${710000 + productIndex}${String(templateIndex + 13).padStart(2, "0")}`;
    return {
      id: `${store.id}-${productId}`,
      productId,
      title: template.title,
      shopId: store.id,
      shopName: store.name,
      group: store.group,
      status: template.status,
      price: Number((template.price + storeIndex * 3 + templateIndex * 0.2).toFixed(2)),
      sales: template.sales + storeIndex * (templateIndex % 3),
      stock: template.stock + storeIndex * 18,
      createdDays: template.createdDays + storeIndex * 8,
      listedDays: template.listedDays + storeIndex * 6,
      exposure: template.exposure + storeIndex * 340,
      lastUpdated: `${String(9 + ((storeIndex + templateIndex) % 9)).padStart(2, "0")}:${String((templateIndex * 7) % 60).padStart(2, "0")}`,
      source: "范围筛选"
    };
  }));
}

function decoratePreviewRow(row: ProductRow, deleteMode: DeleteMode, protectMode: ProtectMode): PreviewRow {
  const targetAction = deleteMode === "final" ? "彻底删除" : "加入回收站";
  const skipSelling = protectMode === "skipSelling" && row.status === "selling";
  const finalFromSelling = deleteMode === "final" && row.status === "selling";
  return {
    ...row,
    targetAction,
    excludedReason: skipSelling ? "已保护售卖中商品" : "",
    warning: finalFromSelling ? "需先移入回收站后彻底删除" : ""
  };
}

function toRemoteAction(deleteMode: DeleteMode): DoudianBulkDeleteAction {
  return deleteMode === "final" ? "delete" : "recycle";
}

function toPreviewNumber(value: unknown, fallback?: number) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function sortPreviewRows(rows: PreviewRow[], sortKey: SortKey) {
  const compareNumbers = (left: number | undefined, right: number | undefined) => {
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return right - left;
  };
  return [...rows].sort((left, right) => {
    if (sortKey === "销量") return compareNumbers(left.sales, right.sales);
    if (sortKey === "价格") return compareNumbers(left.price, right.price);
    if (sortKey === "创建时间") return right.createdDays - left.createdDays;
    return left.id.localeCompare(right.id);
  });
}

function candidateToPreviewRow(candidate: DoudianBulkDeleteCandidate): PreviewRow {
  const createdDays = toPreviewNumber(candidate.daysSinceCreated, -1) ?? -1;
  const listedDays = toPreviewNumber(candidate.daysSinceListed, -1) ?? -1;
  return {
    id: candidate.id || `${candidate.shopId}-${candidate.productId}`,
    productId: candidate.productId,
    title: candidate.title || `商品 ${candidate.productId}`,
    shopId: candidate.shopId,
    shopName: candidate.shopName,
    group: candidate.group || "",
    status: candidate.status || "unknown",
    price: toPreviewNumber(candidate.price),
    sales: toPreviewNumber(candidate.sales),
    stock: toPreviewNumber(candidate.stock),
    createdDays,
    listedDays,
    exposure: toPreviewNumber(candidate.exposure),
    lastUpdated: "",
    source: candidate.source || "范围筛选",
    targetAction: candidate.targetAction || (candidate.action === "delete" ? "彻底删除" : "加入回收站"),
    excludedReason: candidate.excludedReason || "",
    warning: candidate.warning || "",
    ok: candidate.ok !== false,
    remote: candidate
  };
}

function exportRows(rows: PreviewRow[]) {
  const header = ["店铺", "店铺ID", "商品ID", "商品标题", "状态", "售价", "销量", "库存估算", "创建天数", "上架天数", "目标动作", "排除原因"];
  const lines = [
    header,
    ...rows.map((row) => [
      row.shopName,
      row.shopId,
      row.productId,
      row.title,
      productStatusCopy[row.status].label,
      row.price === undefined ? "" : String(row.price),
      row.sales === undefined ? "" : String(row.sales),
      row.stock === undefined ? "" : String(row.stock),
      String(row.createdDays),
      String(row.listedDays),
      row.targetAction,
      row.excludedReason
    ])
  ];
  const csv = lines.map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `赤狐批量删除预览_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportExecutionFailures(executions: DoudianBulkDeleteExecution[]) {
  const failed = executions.filter((item) => item.ok === false);
  const header = ["店铺", "店铺ID", "商品ID", "商品标题", "动作", "阶段", "状态", "失败原因", "请求计划"];
  const lines = [
    header,
    ...failed.map((item) => [
      item.shopName,
      item.shopId,
      item.productId,
      item.title || "",
      item.action,
      item.stage || "",
      item.status,
      item.message,
      item.planKey || ""
    ])
  ];
  const csv = lines.map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `赤狐批量删除失败明细_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function StatusTag({ status }: { status: DoudianStoreStatus }) {
  const copy = statusCopy[status];
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded border px-1.5 text-[11px] font-semibold", copy.className)}>{copy.label}</span>;
}

function ProductStatusTag({ status }: { status: ProductStatus }) {
  const copy = productStatusCopy[status];
  return <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-semibold", copy.className)}>{copy.label}</span>;
}

function CompactTag({ label, className }: { label: string; className: string }) {
  return <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-semibold", className)}>{label}</span>;
}

function CheckboxBox({ checked, mixed = false }: { checked: boolean; mixed?: boolean }) {
  return (
    <span className={cn("grid size-4 shrink-0 place-items-center rounded border text-white", checked || mixed ? "border-brand-fox bg-brand-fox" : "border-[#cfd8e6] bg-white")}>
      {checked ? <Check className="size-3" strokeWidth={3} /> : mixed ? <span className="h-0.5 w-2 rounded bg-white" /> : null}
    </span>
  );
}

function MetricCell({ item }: { item: MetricItem }) {
  const toneClass = item.tone === "danger"
    ? "text-[#b42318]"
    : item.tone === "warning"
      ? "text-[#b54708]"
      : item.tone === "green"
        ? "text-[#087443]"
        : item.tone === "blue"
          ? "text-[#073b7a]"
          : "text-[#101828]";
  return (
    <article className="grid min-h-[84px] content-center gap-1 border-r border-[#edf1f6] bg-white px-3 py-2 last:border-r-0">
      <span className="truncate text-[12px] font-medium text-[#667085]">{item.label}</span>
      <strong className={cn("truncate text-[22px] font-bold leading-7", toneClass)}>{item.value}</strong>
      <span className="truncate text-[11px] text-[#98a2b3]">{item.detail}</span>
    </article>
  );
}

function SegmentButtonGroup<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex h-8 items-center overflow-hidden rounded-md border border-[#dbe5f2] bg-white">
      {options.map((option) => (
        <button
          className={cn("h-full px-3 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45", value === option.value ? "bg-brand-fox text-white" : "text-[#667085] hover:bg-brand-foxSoft hover:text-brand-navy")}
          disabled={option.disabled}
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function NativeSelect<T extends string>({
  value,
  options,
  onChange,
  width = 118
}: {
  value: T;
  options: T[] | Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  width?: number;
}) {
  return (
    <select
      className="h-8 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] outline-none focus:border-brand-fox"
      style={{ width }}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => {
        const valueOption = typeof option === "string" ? option : option.value;
        const label = typeof option === "string" ? option : option.label;
        return <option key={valueOption} value={valueOption}>{label}</option>;
      })}
    </select>
  );
}

function NumberRange({
  label,
  min,
  max,
  unit,
  onMinChange,
  onMaxChange
}: {
  label: string;
  min: number;
  max: number;
  unit?: string;
  onMinChange: (value: number) => void;
  onMaxChange: (value: number) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1.5 text-[12px] text-[#667085]">
      <span className="truncate font-semibold text-[#344054]">{label}</span>
      <span className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2">
        <input
          className="h-8 min-w-0 rounded-md border border-[#dbe5f2] bg-white px-2 text-right text-[12px] font-semibold text-[#1d2939] outline-none focus:border-brand-fox"
          min={0}
          type="number"
          value={min}
          onChange={(event) => onMinChange(clampNumber(Number(event.target.value || 0)))}
        />
        <span className="text-[#98a2b3]">-</span>
        <input
          className="h-8 min-w-0 rounded-md border border-[#dbe5f2] bg-white px-2 text-right text-[12px] font-semibold text-[#1d2939] outline-none focus:border-brand-fox"
          min={0}
          type="number"
          value={max}
          onChange={(event) => onMaxChange(clampNumber(Number(event.target.value || 0)))}
        />
        <span className="min-w-4 text-[#98a2b3]">{unit || ""}</span>
      </span>
    </label>
  );
}

function StepBar({ analyzed, runState }: { analyzed: boolean; runState: RunState }) {
  const steps = [
    { label: "商品选择", active: true, done: analyzed || runState !== "idle" },
    { label: "删除设置", active: true, done: analyzed || runState !== "idle" },
    { label: "预览执行", active: analyzed || runState !== "idle", done: runState === "done" }
  ];
  return (
    <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-[#e1e8f3] bg-white">
      {steps.map((step, index) => (
        <div className="flex h-12 items-center gap-2 border-r border-[#edf1f6] px-3 last:border-r-0" key={step.label}>
          <span className={cn("grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold", step.done ? "bg-[#eafaf0] text-[#087443]" : step.active ? "bg-brand-fox text-white" : "bg-[#eef2f7] text-[#667085]")}>
            {step.done ? <Check className="size-[14px]" strokeWidth={2.5} /> : index + 1}
          </span>
          <span className={cn("truncate text-[13px] font-semibold", step.active ? "text-[#101828]" : "text-[#98a2b3]")}>{step.label}</span>
        </div>
      ))}
    </div>
  );
}

export function BulkDeletePage() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadMessage, setLoadMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>("range");
  const [idText, setIdText] = useState(defaultIdText);
  const [filters, setFilters] = useState<FilterSettings>(defaultFilters);
  const [deleteMode, setDeleteMode] = useState<DeleteMode>("recycle");
  const [protectMode, setProtectMode] = useState<ProtectMode>("skipSelling");
  const [sortKey, setSortKey] = useState<SortKey>("匹配时间");
  const [analyzed, setAnalyzed] = useState(false);
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [lastPreviewAt, setLastPreviewAt] = useState<Date | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const [progress, setProgress] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [remoteCandidates, setRemoteCandidates] = useState<DoudianBulkDeleteCandidate[]>([]);
  const [sourceRunId, setSourceRunId] = useState("");
  const [previewStatus, setPreviewStatus] = useState("");
  const [partialScan, setPartialScan] = useState(false);
  const [allowPartialScan, setAllowPartialScan] = useState(false);
  const [previewMessage, setPreviewMessage] = useState("");
  const [executionMessage, setExecutionMessage] = useState("");
  const [executionRows, setExecutionRows] = useState<DoudianBulkDeleteExecution[]>([]);
  const [previewPage, setPreviewPage] = useState(0);
  const [previewPageSize, setPreviewPageSize] = useState<PreviewPageSize>("100");
  const cancelExecutionRef = useRef(false);

  const previewMode = !hasNativeStoreBridge();

  useEffect(() => {
    void refreshStores();
  }, []);

  useEffect(() => {
    if (filters.status !== "selling") return;
    setDeleteMode("recycle");
    setProtectMode("includeSelling");
  }, [filters.status]);

  const filteredStores = useMemo(() => {
    const keyword = normalizeText(query);
    if (!keyword) return stores;
    return stores.filter((store) => normalizeText(store.name).includes(keyword) || normalizeText(store.id).includes(keyword));
  }, [query, stores]);

  const allVisibleSelected = filteredStores.length > 0 && filteredStores.every((store) => selectedIds.has(store.id));
  const selectedVisibleCount = filteredStores.filter((store) => selectedIds.has(store.id)).length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const onlineSelectedCount = stores.filter((store) => selectedIds.has(store.id) && store.status === "online").length;

  const allProducts = useMemo(() => buildSampleProducts(stores), [stores]);
  const productImportItems = useMemo(() => parseProductImportItems(idText, stores), [idText, stores]);
  const usableProductImportItems = useMemo(() => productImportItems.filter((item) => item.productId && item.validationStatus === "ok"), [productImportItems]);
  const invalidProductImportCount = productImportItems.length - usableProductImportItems.length;
  const scopedProductImportCount = usableProductImportItems.filter((item) => item.shopId || item.shopName).length;

  const samplePreviewRows = useMemo(() => {
    const keyword = normalizeText(idText);
    const rows = allProducts.filter((row) => {
      if (!selectedIds.has(row.shopId)) return false;
      if (sourceMode === "ids" && !usableProductImportItems.length) return false;
      if (sourceMode === "ids" && usableProductImportItems.length && !usableProductImportItems.some((item) => item.productId === row.productId && importItemMatchesPreviewRow(item, row))) return false;
      if (sourceMode === "range" && keyword && !normalizeText(row.title + row.productId).includes(keyword)) return false;
      if (filters.status !== "all" && row.status !== filters.status) return false;
      if (row.price === undefined ? filters.priceMin > 0 || filters.priceMax < 999999999 : row.price < filters.priceMin || row.price > filters.priceMax) return false;
      if (row.sales === undefined ? filters.salesMin > 0 || filters.salesMax < 999999999 : row.sales < filters.salesMin || row.sales > filters.salesMax) return false;
      if (row.createdDays < filters.createdDaysMin) return false;
      if (row.listedDays < filters.listedDaysMin) return false;
      return true;
    });
    const limitedRows = filters.perStoreLimit > 0
      ? rows.filter((row) => rows.filter((item) => item.shopId === row.shopId).indexOf(row) < filters.perStoreLimit)
      : rows;
    return sortPreviewRows(
      limitedRows.map((row) => decoratePreviewRow({ ...row, source: sourceMode === "ids" ? "商品ID导入" : "范围筛选" }, deleteMode, protectMode)),
      sortKey
    );
  }, [allProducts, deleteMode, filters, idText, protectMode, selectedIds, sortKey, sourceMode, usableProductImportItems]);

  const remotePreviewRows = useMemo(() => sortPreviewRows(remoteCandidates.map(candidateToPreviewRow), sortKey), [remoteCandidates, sortKey]);
  const previewRows = previewMode ? samplePreviewRows : analyzed ? remotePreviewRows : [];

  const executableRows = useMemo(() => previewRows.filter((row) => row.ok === true && row.status !== "unknown" && !row.excludedReason), [previewRows]);
  const excludedRows = useMemo(() => previewRows.filter((row) => row.excludedReason), [previewRows]);
  const finalRows = useMemo(() => previewRows.filter((row) => row.targetAction === "彻底删除" && !row.excludedReason), [previewRows]);
  const selectedExecutableRows = useMemo(() => executableRows.filter((row) => selectedProductIds.has(row.id)), [executableRows, selectedProductIds]);
  const sellingRows = useMemo(() => previewRows.filter((row) => row.status === "selling"), [previewRows]);
  const previewPageSizeNumber = Number(previewPageSize);
  const previewPageCount = Math.max(1, Math.ceil(previewRows.length / previewPageSizeNumber));
  const safePreviewPage = Math.min(previewPage, previewPageCount - 1);
  const previewPageStartIndex = safePreviewPage * previewPageSizeNumber;
  const previewPageEndIndex = Math.min(previewRows.length, previewPageStartIndex + previewPageSizeNumber);
  const previewRangeText = previewRows.length ? `${formatNumber(previewPageStartIndex + 1)}-${formatNumber(previewPageEndIndex)}` : "0";
  const visiblePreviewRows = useMemo(() => previewRows.slice(previewPageStartIndex, previewPageEndIndex), [previewRows, previewPageEndIndex, previewPageStartIndex]);
  const visibleExecutableRows = useMemo(() => visiblePreviewRows.filter((row) => row.ok === true && row.status !== "unknown" && !row.excludedReason), [visiblePreviewRows]);
  const visibleProductIds = useMemo(() => visibleExecutableRows.map((row) => row.id), [visibleExecutableRows]);
  const allVisibleProductsSelected = visibleProductIds.length > 0 && visibleProductIds.every((id) => selectedProductIds.has(id));
  const selectedVisibleProductsCount = visibleProductIds.filter((id) => selectedProductIds.has(id)).length;
  const someVisibleProductsSelected = selectedVisibleProductsCount > 0 && !allVisibleProductsSelected;

  useEffect(() => {
    setPreviewPage((current) => current >= previewPageCount ? previewPageCount - 1 : current);
  }, [previewPageCount]);

  useEffect(() => {
    setPreviewPage(0);
  }, [filters, idText, previewPageSize, sortKey, sourceMode]);

  const metrics: MetricItem[] = [
    { label: "命中商品", value: formatNumber(previewRows.length), detail: `${selectedIds.size} 家店铺`, tone: "blue" },
    { label: "待执行", value: formatNumber(executableRows.length), detail: `${excludedRows.length} 个已排除`, tone: "green" },
    { label: "彻底删除", value: formatNumber(finalRows.length), detail: deleteMode === "final" ? "高风险动作" : "当前未启用", tone: finalRows.length ? "danger" : "default" },
    { label: "售卖中", value: formatNumber(sellingRows.length), detail: protectMode === "skipSelling" ? "默认保护" : "参与删除", tone: protectMode === "skipSelling" ? "warning" : "danger" },
    { label: sourceMode === "ids" ? "导入行" : "扫描来源", value: sourceMode === "ids" ? formatNumber(usableProductImportItems.length) : "范围", detail: sourceMode === "ids" ? `${scopedProductImportCount} 条绑定店铺` : "远程列表", tone: "default" },
    { label: "已选执行", value: formatNumber(selectedExecutableRows.length), detail: analyzed ? "预览清单" : "待生成预览", tone: "blue" }
  ];

  function setFilter<K extends keyof FilterSettings>(key: K, value: FilterSettings[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPreviewPage(0);
    setAnalyzed(false);
  }

  async function refreshStores() {
    setSyncing(true);
    setLoadState("loading");
    setLoadMessage("");
    try {
      if (!hasNativeStoreBridge()) {
        setStores(sampleStores);
        setSelectedIds(new Set(sampleStores.filter((store) => store.status !== "offline").map((store) => store.id)));
        setLoadState("ready");
        setLoadMessage("设计预览店铺");
        return;
      }
      const result = await listDoudianStores();
      if (!result.ok) throw new Error(result.message || "店铺读取失败");
      const nextStores = (result.stores || []).map(mapStoreToOption).filter((store) => store.id);
      const safeStores = nextStores.length || isDevPreviewRuntime() ? nextStores.length ? nextStores : sampleStores : [];
      setStores(safeStores);
      setSelectedIds(new Set(safeStores.filter((store) => store.status !== "offline").map((store) => store.id)));
      setLoadState("ready");
      setLoadMessage(safeStores === sampleStores ? "设计预览店铺" : "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextStores = isDevPreviewRuntime() ? sampleStores : [];
      setStores(nextStores);
      setSelectedIds(new Set(nextStores.filter((store) => store.status !== "offline").map((store) => store.id)));
      setLoadState(nextStores.length ? "ready" : "error");
      setLoadMessage(nextStores.length ? "已切换设计预览店铺" : message);
    } finally {
      setSyncing(false);
    }
  }

  function toggleStores(ids: string[]) {
    setSelectedIds((current) => toggleStoreIds(current, ids));
    setPreviewPage(0);
    setAnalyzed(false);
  }

  function toggleVisibleStores() {
    toggleStores(filteredStores.map((store) => store.id));
  }

  function toggleProduct(id: string) {
    setSelectedProductIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisibleProducts() {
    setSelectedProductIds((current) => {
      const allSelected = visibleProductIds.length > 0 && visibleProductIds.every((id) => current.has(id));
      const next = new Set(current);
      if (allSelected) visibleProductIds.forEach((id) => next.delete(id));
      else visibleProductIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function buildRemoteFilters(): DoudianBulkDeleteFilters {
    const rangeKeyword = sourceMode === "range" && !looksLikeProductIdImport(idText) ? idText.trim() : "";
    return {
      keyword: rangeKeyword,
      productIds: sourceMode === "ids" ? usableProductImportItems.map((item) => item.productId) : [],
      importItems: sourceMode === "ids" ? usableProductImportItems : [],
      status: filters.status,
      priceMin: filters.priceMin,
      priceMax: filters.priceMax,
      salesMin: filters.salesMin,
      salesMax: filters.salesMax,
      createdDaysMin: filters.createdDaysMin,
      listedDaysMin: filters.listedDaysMin,
      perStoreLimit: filters.perStoreLimit
    };
  }

  async function buildPreview() {
    setRunState("idle");
    setProgress(0);
    setPreviewPage(0);
    setConfirmInput("");
    setExecutionMessage("");
    setExecutionRows([]);
    if (previewMode) {
      setAnalyzed(true);
      setLastPreviewAt(new Date());
      setPreviewMessage("本地设计预览，不提交平台请求");
      setSelectedProductIds(new Set(executableRows.map((row) => row.id)));
      return;
    }
    if (sourceMode === "range" && looksLikeProductIdImport(idText)) {
      setAnalyzed(false);
      setRemoteCandidates([]);
      setSourceRunId("");
      setSelectedProductIds(new Set());
      setPreviewMessage("检测到多商品 ID，请切换到“商品ID导入”后再生成预览");
      return;
    }
    if (sourceMode === "ids" && invalidProductImportCount > 0) {
      setAnalyzed(false);
      setRemoteCandidates([]);
      setSourceRunId("");
      setSelectedProductIds(new Set());
      setPreviewMessage(`导入内容有 ${invalidProductImportCount} 行缺少商品 ID 或无法匹配店铺，请修正后重试`);
      return;
    }
    if (sourceMode === "ids" && !usableProductImportItems.length) {
      setAnalyzed(false);
      setPreviewMessage("请先导入有效的商品 ID");
      return;
    }

    setPreviewBusy(true);
    setAnalyzed(false);
    setRemoteCandidates([]);
    setSourceRunId("");
    setPreviewStatus("");
    setPartialScan(false);
    setAllowPartialScan(false);
    setSelectedProductIds(new Set());
    setPreviewMessage("正在扫描商品");
    try {
      const result = await fetchDoudianBulkDeleteProducts({
        mode: "scan",
        shopIds: [...selectedIds],
        sourceMode,
        filters: buildRemoteFilters(),
        action: toRemoteAction(deleteMode),
        protectMode,
        forceAdapter: true
      });
      const nextCandidates = result.candidates || [];
      const nextSourceRunId = result.sourceRunId || result.runId || "";
      setRemoteCandidates(nextCandidates);
      setSourceRunId(nextSourceRunId);
      const nextStatus = result.status || (result.ok ? "ok" : "failed");
      const nextPartialScan = nextStatus === "partial";
      setPreviewStatus(nextStatus);
      setPartialScan(nextPartialScan);
      setAllowPartialScan(false);
      setAnalyzed(true);
      setLastPreviewAt(new Date());
      setPreviewMessage(result.message || (result.ok ? `命中 ${nextCandidates.length} 个商品` : "扫描完成但存在异常"));
      setSelectedProductIds(new Set(nextCandidates.filter((item) => item.ok === true && item.status !== "unknown" && !item.excludedReason).map((item) => item.id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPreviewMessage(message || "生成预览失败");
      setAnalyzed(false);
      setRemoteCandidates([]);
      setSourceRunId("");
      setPreviewStatus("");
      setPartialScan(false);
      setAllowPartialScan(false);
    } finally {
      setPreviewBusy(false);
    }
  }

  function resetSettings() {
    setFilters(defaultFilters);
    setSourceMode("range");
    setIdText(defaultIdText());
    setDeleteMode("recycle");
    setProtectMode("skipSelling");
    setSortKey("匹配时间");
    setAnalyzed(false);
    setRunState("idle");
    setProgress(0);
    setPreviewMessage("");
    setExecutionMessage("");
    setExecutionRows([]);
    setRemoteCandidates([]);
    setSourceRunId("");
    setPreviewStatus("");
    setPartialScan(false);
    setAllowPartialScan(false);
    setSelectedProductIds(new Set());
    setPreviewPage(0);
    setPreviewPageSize("100");
  }

  async function executePreview() {
    if (!selectedExecutableRows.length || confirmInput !== "确认删除") return;
    setRunState("running");
    cancelExecutionRef.current = false;
    setProgress(0);
    setExecutionMessage("");
    setExecutionRows([]);
    if (previewMode) {
      await new Promise((resolve) => window.setTimeout(resolve, 260));
      setProgress(100);
      setRunState("error");
      setExecutionMessage("当前为本地设计预览，未连接店铺 native bridge，不会提交平台请求");
      return;
    }
    if (!sourceRunId) {
      setProgress(100);
      setRunState("error");
      setExecutionMessage("请先生成真实预览后再执行");
      return;
    }
    const candidateIds = selectedExecutableRows.map((row) => row.id).filter(Boolean);
    if (!candidateIds.length) {
      setProgress(100);
      setRunState("error");
      setExecutionMessage("执行清单缺少本地候选 ID，请重新生成预览");
      return;
    }
    try {
      const result = await fetchDoudianBulkDeleteProducts({
        mode: "execute",
        shopIds: [...selectedIds],
        action: toRemoteAction(deleteMode),
        candidateIds,
        sourceRunId,
        allowPartialScan,
        confirmText: "确认删除",
        onProgress: (event) => setProgress(event.percent),
        shouldCancel: () => cancelExecutionRef.current,
        forceAdapter: true
      });
      const nextExecutions = result.executions || [];
      const failedCount = nextExecutions.filter((item) => item.ok === false).length;
      const submittedCount = nextExecutions.filter((item) => item.ok && item.status === "submitted").length;
      setExecutionRows(nextExecutions);
      if (result.status !== "cancelled") setProgress(100);
      setRunState(result.ok ? "done" : "error");
      setExecutionMessage(result.message || (result.ok ? `批量删除请求已提交 ${submittedCount} 个` : `批量删除执行失败，失败 ${failedCount} 个`));
    } catch (error) {
      setProgress(100);
      setRunState("error");
      setExecutionRows([]);
      setExecutionMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function cancelExecution() {
    cancelExecutionRef.current = true;
    setExecutionMessage("正在取消，将在当前请求完成后停止");
  }

  const tableMinWidth = 1160;
  const canExecute = previewMode
    ? analyzed
    : analyzed && Boolean(sourceRunId) && (previewStatus === "ok" || (partialScan && allowPartialScan));
  const failedExecutionRows = executionRows.filter((item) => item.ok === false);
  const submittedExecutionCount = executionRows.filter((item) => item.ok && item.status === "submitted").length;

  return (
    <section className={cn("grid h-full min-h-0 gap-3 overflow-hidden text-[#1d2939] max-[980px]:grid-cols-1 max-[980px]:overflow-auto", sidebarCollapsed ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[250px_minmax(0,1fr)]")}>
      {!sidebarCollapsed ? (
        <aside className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex h-11 items-center justify-between border-b border-[#edf1f6] px-3.5">
            <div className="flex items-center gap-2">
              <Store className="size-[16px] text-brand-navy" strokeWidth={2.2} />
              <strong className="text-[14px] font-semibold text-[#101828]">店铺选择</strong>
            </div>
            <button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2] bg-white text-[#344054] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" aria-label="收起店铺选择" title="收起店铺选择" onClick={() => setSidebarCollapsed(true)}>
              <PanelLeftClose className="size-[14px]" strokeWidth={2} />
            </button>
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
            <span className="truncate text-[12px] text-[#98a2b3]">{loadMessage || "店铺列表同步"}</span>
            <button className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={syncing} onClick={() => void refreshStores()}>
              <RefreshCw className={cn("size-[13px]", syncing ? "animate-spin" : "")} strokeWidth={2} />
              刷新
            </button>
          </div>
        </aside>
      ) : null}

      <div className="grid min-h-0 grid-rows-[42px_84px_auto_minmax(0,1fr)] gap-3 overflow-hidden">
        <div className="scrollbar-none flex h-[42px] items-center gap-2 overflow-x-auto overflow-y-hidden">
          <div className="flex shrink-0 items-center gap-2">
            {sidebarCollapsed ? (
              <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" onClick={() => setSidebarCollapsed(false)}>
                <PanelLeftOpen className="size-[14px]" strokeWidth={2} />
                展开店铺
              </button>
            ) : null}
            <Trash2 className="size-[18px] text-brand-navy" strokeWidth={2.2} />
            <strong className="text-[15px] font-semibold text-[#101828]">批量删除</strong>
            {previewMode ? <CompactTag label="设计预览" className="border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" /> : null}
            {!previewMode && previewBusy ? <CompactTag label="扫描中" className="border-[#bfd7ff] bg-[#eef5ff] text-[#073b7a]" /> : null}
            {lastPreviewAt ? <span className="rounded-md border border-[#dbe5f2] bg-white px-2 py-1 text-[12px] font-medium text-[#667085]">预览 {lastPreviewAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</span> : null}
            {previewMessage ? <span className="max-w-[360px] truncate rounded-md border border-[#dbe5f2] bg-white px-2 py-1 text-[12px] font-medium text-[#667085]">{previewMessage}</span> : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054]" type="button" onClick={resetSettings}>
              <RotateCcw className="size-[14px]" strokeWidth={2} />
              重置
            </button>
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] disabled:opacity-50" type="button" disabled={!previewRows.length} onClick={() => exportRows(previewRows)}>
              <Download className="size-[14px]" strokeWidth={2} />
              导出
            </button>
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] disabled:opacity-50" type="button" disabled={!selectedIds.size || previewBusy} onClick={() => void buildPreview()}>
              {previewBusy ? <Loader2 className="size-[14px] animate-spin" strokeWidth={2.2} /> : <PackageSearch className="size-[14px]" strokeWidth={2} />}
              {previewBusy ? "扫描中" : "生成预览"}
            </button>
          </div>
        </div>

        <section className="overflow-x-auto overflow-y-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="grid min-w-[920px] grid-cols-6">
            {metrics.map((item) => <MetricCell item={item} key={item.label} />)}
          </div>
        </section>

        <section className="grid gap-3 rounded-lg border border-[#e1e8f3] bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex flex-wrap items-center gap-3">
            <StepBar analyzed={analyzed} runState={runState} />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <SegmentButtonGroup
                value={sourceMode}
                options={[
                  { value: "range", label: "按范围修改" },
                  { value: "ids", label: "商品ID导入" }
                ]}
                onChange={(value) => {
                  setSourceMode(value);
                  setPreviewPage(0);
                  setAnalyzed(false);
                }}
              />
              <SegmentButtonGroup
                value={deleteMode}
                options={[
                  { value: "recycle", label: "加入回收站" },
                  { value: "final", label: "彻底删除", disabled: filters.status === "selling" }
                ]}
                onChange={(value) => {
                  setDeleteMode(value);
                  setPreviewPage(0);
                  setAnalyzed(false);
                }}
              />
              <SegmentButtonGroup
                value={protectMode}
                options={[
                  { value: "skipSelling", label: "不删除售卖中", disabled: filters.status === "selling" },
                  { value: "includeSelling", label: "售卖中一并删除" }
                ]}
                onChange={(value) => {
                  setProtectMode(value);
                  setPreviewPage(0);
                  setAnalyzed(false);
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-[minmax(240px,1.4fr)_repeat(4,minmax(150px,1fr))_120px] gap-3 max-[1280px]:grid-cols-3 max-[760px]:grid-cols-1">
            {sourceMode === "ids" ? (
              <label className="grid min-w-0 gap-1.5 text-[12px] text-[#667085]">
                <span className="truncate font-semibold text-[#344054]">商品ID</span>
                <textarea
                  className="h-20 min-w-0 resize-none rounded-md border border-[#dbe5f2] bg-white px-2 py-1.5 text-[12px] font-medium text-[#1d2939] outline-none placeholder:text-[#98a2b3] focus:border-brand-fox"
                  placeholder="商品ID；或 店铺ID/店铺名 商品ID"
                  value={idText}
                  onChange={(event) => {
                    setIdText(event.target.value);
                    setPreviewPage(0);
                    setAnalyzed(false);
                  }}
                />
              </label>
            ) : (
              <label className="grid min-w-0 gap-1.5 text-[12px] text-[#667085]">
                <span className="truncate font-semibold text-[#344054]">商品信息</span>
                <span className="flex h-8 items-center gap-2 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[#98a2b3]">
                  <Search className="size-[14px]" strokeWidth={2} />
                  <input
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-[#1d2939] outline-none placeholder:text-[#98a2b3]"
                    placeholder="商品标题 / ID"
                    value={idText}
                    onChange={(event) => {
                      setIdText(event.target.value);
                      setPreviewPage(0);
                      setAnalyzed(false);
                    }}
                  />
                </span>
              </label>
            )}
            <label className="grid min-w-0 gap-1.5 text-[12px] text-[#667085]">
              <span className="truncate font-semibold text-[#344054]">商品选择</span>
              <NativeSelect value={filters.status} options={productStatusOptions} width={150} onChange={(value) => setFilter("status", value)} />
            </label>
            <NumberRange label="商品价格" min={filters.priceMin} max={filters.priceMax} unit="元" onMinChange={(value) => setFilter("priceMin", value)} onMaxChange={(value) => setFilter("priceMax", value)} />
            <NumberRange label="销量区间" min={filters.salesMin} max={filters.salesMax} unit="件" onMinChange={(value) => setFilter("salesMin", value)} onMaxChange={(value) => setFilter("salesMax", value)} />
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <label className="grid min-w-0 gap-1.5 text-[12px] text-[#667085]">
                <span className="truncate font-semibold text-[#344054]">创建时间</span>
                <input className="h-8 min-w-0 rounded-md border border-[#dbe5f2] bg-white px-2 text-right text-[12px] font-semibold text-[#1d2939] outline-none focus:border-brand-fox" min={0} type="number" value={filters.createdDaysMin} onChange={(event) => setFilter("createdDaysMin", clampNumber(Number(event.target.value || 0)))} />
              </label>
              <label className="grid min-w-0 gap-1.5 text-[12px] text-[#667085]">
                <span className="truncate font-semibold text-[#344054]">上架时间</span>
                <input className="h-8 min-w-0 rounded-md border border-[#dbe5f2] bg-white px-2 text-right text-[12px] font-semibold text-[#1d2939] outline-none focus:border-brand-fox" min={0} type="number" value={filters.listedDaysMin} onChange={(event) => setFilter("listedDaysMin", clampNumber(Number(event.target.value || 0)))} />
              </label>
            </div>
            <label className="grid min-w-0 gap-1.5 text-[12px] text-[#667085]">
              <span className="truncate font-semibold text-[#344054]">每店上限</span>
              <input className="h-8 min-w-0 rounded-md border border-[#dbe5f2] bg-white px-2 text-right text-[12px] font-semibold text-[#1d2939] outline-none focus:border-brand-fox" min={0} type="number" value={filters.perStoreLimit} onChange={(event) => setFilter("perStoreLimit", clampNumber(Number(event.target.value || 0)))} />
            </label>
          </div>
        </section>

        <section className="grid min-h-0 grid-rows-[44px_minmax(0,1fr)_48px] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex items-center justify-between gap-3 border-b border-[#edf1f6] px-3.5">
            <div className="flex min-w-0 items-center gap-2">
              <PackageSearch className="size-[16px] text-brand-navy" strokeWidth={2.2} />
              <strong className="text-[15px] font-semibold text-[#101828]">商品预览</strong>
              <button className="inline-flex h-7 items-center gap-2 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054]" type="button" onClick={toggleVisibleProducts}>
                <CheckboxBox checked={allVisibleProductsSelected} mixed={someVisibleProductsSelected} />
                本页 {selectedVisibleProductsCount}/{visibleProductIds.length}
              </button>
              {excludedRows.length ? (
                <span className="inline-flex h-6 max-w-[320px] items-center gap-1 rounded-md border border-[#ffdca8] bg-[#fff7e8] px-2 text-[12px] font-semibold text-[#b54708]">
                  <AlertTriangle className="size-[13px] shrink-0" strokeWidth={2} />
                  <span className="truncate">{excludedRows.length} 个商品已按保护策略排除</span>
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="whitespace-nowrap rounded-md border border-[#dbe5f2] bg-white px-2 py-1 text-[12px] font-medium text-[#667085]">{previewRangeText} / {formatNumber(previewRows.length)}</span>
              <button className="inline-flex h-8 items-center rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] disabled:cursor-not-allowed disabled:opacity-45" type="button" disabled={!previewRows.length || safePreviewPage <= 0} onClick={() => setPreviewPage((page) => Math.max(0, page - 1))}>
                上一页
              </button>
              <NativeSelect
                value={previewPageSize}
                options={previewPageSizeOptions}
                width={88}
                onChange={(value) => {
                  setPreviewPageSize(value);
                  setPreviewPage(0);
                }}
              />
              <button className="inline-flex h-8 items-center rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] disabled:cursor-not-allowed disabled:opacity-45" type="button" disabled={!previewRows.length || safePreviewPage >= previewPageCount - 1} onClick={() => setPreviewPage((page) => Math.min(previewPageCount - 1, page + 1))}>
                下一页
              </button>
              <NativeSelect
                value={sortKey}
                options={sortOptions}
                width={116}
                onChange={(value) => {
                  setSortKey(value);
                  setPreviewPage(0);
                }}
              />
            </div>
          </div>

          <div className="min-h-0 overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-left text-[12px]" style={{ minWidth: tableMinWidth }}>
              <thead className="sticky top-0 z-20 bg-[#fbfcff] text-[#344054] shadow-[inset_0_-1px_0_#e6ebf3]">
                <tr className="h-10">
                  <th className="sticky left-0 z-30 bg-[#fbfcff] px-3 font-semibold shadow-[inset_-1px_0_0_#edf1f6]" style={{ width: 330, minWidth: 330, maxWidth: 330 }}>商品 / 店铺</th>
                  <th className="whitespace-nowrap px-3 font-semibold">状态</th>
                  <th className="whitespace-nowrap px-3 font-semibold">售价</th>
                  <th className="whitespace-nowrap px-3 font-semibold">销量</th>
                  <th className="whitespace-nowrap px-3 font-semibold">库存估算</th>
                  <th className="whitespace-nowrap px-3 font-semibold">创建 / 上架</th>
                  <th className="whitespace-nowrap px-3 font-semibold">来源</th>
                  <th className="whitespace-nowrap px-3 font-semibold">删除预览</th>
                  <th className="whitespace-nowrap px-3 font-semibold">校验</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#edf1f6]">
                {visiblePreviewRows.map((row) => {
                  const disabled = Boolean(row.excludedReason);
                  return (
                    <tr className={cn("group h-[58px] hover:bg-[#f8fbff]", disabled ? "text-[#98a2b3]" : "text-[#1d2939]")} key={row.id}>
                      <td className="sticky left-0 z-10 bg-white px-3 shadow-[inset_-1px_0_0_#edf1f6] group-hover:bg-[#f8fbff]" style={{ width: 330, minWidth: 330, maxWidth: 330 }}>
                        <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
                          <button className="pt-1 disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={disabled} onClick={() => toggleProduct(row.id)} aria-label="选择商品">
                            <CheckboxBox checked={!disabled && selectedProductIds.has(row.id)} />
                          </button>
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-[#1d2939]" title={row.title}>{row.title}</div>
                            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-[#667085]">
                              <span className="truncate">{row.shopName}</span>
                              <span className="font-mono">{row.productId}</span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3"><ProductStatusTag status={row.status} /></td>
                      <td className="whitespace-nowrap px-3 font-semibold">{formatMoney(row.price)}</td>
                      <td className="whitespace-nowrap px-3">{formatNumber(row.sales)}</td>
                      <td className="whitespace-nowrap px-3">{formatNumber(row.stock)}</td>
                      <td className="whitespace-nowrap px-3 text-[#667085]">{daysAgoText(row.createdDays)} / {daysAgoText(row.listedDays)}</td>
                      <td className="whitespace-nowrap px-3">{row.source}</td>
                      <td className="whitespace-nowrap px-3">
                        <span className={cn("inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[12px] font-semibold", row.targetAction === "彻底删除" ? "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" : "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]")}>
                          {row.targetAction === "彻底删除" ? <Trash2 className="size-[12px]" strokeWidth={2.2} /> : <Archive className="size-[12px]" strokeWidth={2.2} />}
                          {row.targetAction}
                        </span>
                      </td>
                      <td className="min-w-[190px] px-3">
                        {row.excludedReason ? (
                          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#b54708]"><FileWarning className="size-[13px]" strokeWidth={2} />{row.excludedReason}</span>
                        ) : row.warning ? (
                          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#b42318]"><ShieldAlert className="size-[13px]" strokeWidth={2} />{row.warning}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#087443]"><Check className="size-[13px]" strokeWidth={2.2} />可执行</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!previewRows.length ? (
                  <tr>
                    <td className="h-[260px] text-center" colSpan={9}>
                      <div className="mx-auto grid w-[330px] place-items-center gap-3 text-[#667085]">
                        <span className="grid size-14 place-items-center rounded-full bg-brand-foxSoft text-brand-fox">
                          <PackageSearch className="size-7" strokeWidth={2.2} />
                        </span>
                        <strong className="text-[14px] text-[#344054]">暂无命中商品</strong>
                        <span className="text-[13px] leading-6">调整店铺、商品状态、价格或销量条件后重新生成预览。</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-[#edf1f6] px-4 text-[12px] text-[#667085]">
            <span className="min-w-0 truncate">命中 {previewRows.length} 个商品 · 可执行 {executableRows.length} 个 · 排除 {excludedRows.length} 个 · 当前显示 {previewRangeText}</span>
            <span className="inline-flex items-center gap-2">
              <Archive className="size-[14px]" strokeWidth={2} />
              回收站 {deleteMode === "recycle" ? formatNumber(executableRows.length) : "0"}
              <Trash2 className="ml-2 size-[14px]" strokeWidth={2} />
              彻底删除 {formatNumber(finalRows.length)}
            </span>
          </div>
        </section>
      </div>

      {analyzed ? (
        <div className="fixed bottom-4 right-4 z-40 grid w-[min(520px,calc(100vw-32px))] gap-3 rounded-lg border border-[#ffdca8] bg-white p-4 shadow-[0_18px_42px_rgba(15,23,42,0.18)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ShieldAlert className="size-[17px] text-[#b54708]" strokeWidth={2.2} />
                <strong className="text-[14px] text-[#101828]">执行确认</strong>
                {previewMode ? <CompactTag label="本地设计预览" className="border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" /> : null}
              </div>
              <p className="m-0 mt-1 text-[12px] leading-5 text-[#667085]">
                已选 {selectedExecutableRows.length} 个商品，动作：{deleteMode === "final" ? "彻底删除" : "加入回收站"}。
                {!previewMode && sourceRunId ? <span className="ml-1">来源：{sourceRunId}</span> : null}
              </p>
              {!previewMode && partialScan ? (
                <label className="mt-2 flex items-start gap-2 text-[12px] leading-5 text-[#b54708]">
                  <input
                    className="mt-1 size-3.5 accent-[#b54708]"
                    type="checkbox"
                    checked={allowPartialScan}
                    onChange={(event) => setAllowPartialScan(event.target.checked)}
                  />
                  <span>本次扫描不完整，仅执行已完成店铺的候选商品</span>
                </label>
              ) : null}
            </div>
            <button className="grid size-7 shrink-0 place-items-center rounded-md border border-[#dbe5f2] bg-white text-[#344054]" type="button" aria-label="关闭执行确认" onClick={() => setAnalyzed(false)}>
              <XCircle className="size-[14px]" strokeWidth={2} />
            </button>
          </div>
          {runState === "running" || runState === "done" || runState === "error" ? (
            <div className="grid gap-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-[#eef2f7]">
                <div className={cn("h-full rounded-full", runState === "error" ? "bg-[#b54708]" : "bg-brand-fox")} style={{ width: `${progress}%` }} />
              </div>
              <span className={cn("text-[12px] font-semibold", runState === "error" ? "text-[#b54708]" : "text-[#667085]")}>
                {runState === "running" ? `执行中 ${progress}%` : runState === "done" ? executionMessage || "执行完成" : executionMessage || "执行失败"}
              </span>
              {executionRows.length ? (
                <span className="text-[12px] text-[#667085]">
                  已返回 {executionRows.length} 条执行记录，已提交 {submittedExecutionCount} 条，失败 {failedExecutionRows.length} 条。
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              className="h-9 rounded-md border border-[#dbe5f2] bg-white px-3 text-[13px] text-[#1d2939] outline-none placeholder:text-[#98a2b3] focus:border-brand-fox"
              placeholder="输入“确认删除”"
              value={confirmInput}
              onChange={(event) => setConfirmInput(event.target.value)}
            />
            <button className={cn("inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold text-white disabled:opacity-50", runState === "running" ? "bg-[#b42318]" : "bg-brand-fox")} type="button" disabled={runState !== "running" && (!canExecute || !selectedExecutableRows.length || confirmInput !== "确认删除")} onClick={() => runState === "running" ? cancelExecution() : void executePreview()}>
              {runState === "running" ? <XCircle className="size-[14px]" strokeWidth={2.2} /> : <PlayCircle className="size-[14px]" strokeWidth={2.2} />}
              {runState === "running" ? "取消执行" : "确认执行"}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
            <button className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054]" type="button" onClick={() => exportRows(selectedExecutableRows)}>
              <Upload className="size-[14px]" strokeWidth={2} />
              导出执行清单
            </button>
            <button className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#ffd1d1] bg-white px-2.5 text-[12px] font-semibold text-[#b42318] disabled:opacity-50" type="button" disabled={!failedExecutionRows.length} onClick={() => exportExecutionFailures(executionRows)}>
              <FileWarning className="size-[14px]" strokeWidth={2} />
              导出失败明细
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
