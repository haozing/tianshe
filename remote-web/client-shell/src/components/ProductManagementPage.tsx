import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowDownCircle,
  ArrowUpCircle,
  Check,
  Download,
  FileWarning,
  Loader2,
  PackageSearch,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  Store,
  Trash2,
  X
} from "lucide-react";
import { fetchDoudianBulkDeleteProducts, fetchDoudianFreightTemplates, listDoudianStores } from "../bridge/client";
import { toggleStoreIds } from "../domain/doudian/storeSelection";
import { cn } from "../lib/utils";
import type {
  DoudianBulkDeleteAction,
  DoudianBulkDeleteCandidate,
  DoudianBulkDeleteExecution,
  DoudianBulkDeleteFilters,
  DoudianBulkDeleteImportItem,
  DoudianBulkDeleteProductStatus,
  DoudianBulkDeleteProductStatusFilter,
  DoudianFreightTemplate,
  DoudianStoreStatus,
  DoudianStoreSummary
} from "../types";
import { GroupedStoreSelectionList } from "./GroupedStoreSelectionList";

type LoadState = "loading" | "ready" | "error";
type RunState = "idle" | "running" | "done" | "error";
type SortKey = "匹配时间" | "销量" | "价格" | "创建时间";
type PageSize = "100" | "250" | "500";

interface StoreOption {
  id: string;
  name: string;
  group: string;
  status: DoudianStoreStatus;
}

interface ProductRow {
  id: string;
  productId: string;
  title: string;
  shopId: string;
  shopName: string;
  status: DoudianBulkDeleteProductStatus;
  price?: number;
  sales?: number;
  stock?: number;
  createdAt?: string;
  listedAt?: string;
  freightTemplate: string;
  source: string;
  excludedReason: string;
  ok: boolean;
}

interface QuerySettings {
  status: DoudianBulkDeleteProductStatusFilter;
  priceMin: number;
  priceMax: number;
  salesMin: number;
  salesMax: number;
  freightTemplate: string;
  createdStart: string;
  createdEnd: string;
}

const defaultQuery: QuerySettings = {
  status: "all",
  priceMin: 0,
  priceMax: 999999,
  salesMin: 0,
  salesMax: 999999,
  freightTemplate: "all",
  createdStart: "",
  createdEnd: ""
};

const sampleStores: StoreOption[] = [
  { id: "preview-1001", name: "赤狐样例店 A", group: "华南组", status: "online" },
  { id: "preview-1002", name: "赤狐样例店 B", group: "华东组", status: "online" },
  { id: "preview-1003", name: "赤狐样例店 C", group: "待复核", status: "check_failed" }
];

const sampleProducts = [
  { title: "夏季速干防晒衣 轻薄透气", status: "selling" as const, price: 89.9, sales: 23, stock: 136, createdDays: 76, listedDays: 62 },
  { title: "儿童防滑凉鞋 清仓款", status: "offline" as const, price: 39.9, sales: 0, stock: 84, createdDays: 121, listedDays: 108 },
  { title: "厨房沥水置物架 加厚升级", status: "selling" as const, price: 29.8, sales: 18, stock: 312, createdDays: 42, listedDays: 39 },
  { title: "户外折叠露营椅 便携款", status: "selling" as const, price: 128, sales: 4, stock: 58, createdDays: 95, listedDays: 80 },
  { title: "无痕收纳挂钩 10只装", status: "offline" as const, price: 12.9, sales: 0, stock: 600, createdDays: 216, listedDays: 203 }
];

const statusCopy: Record<DoudianBulkDeleteProductStatus, { label: string; className: string }> = {
  selling: { label: "售卖中", className: "border-[#b8e8c8] bg-[#eaf8ef] text-[#087443]" },
  offline: { label: "已下架", className: "border-[#d7e0ec] bg-[#f8fafc] text-[#475467]" },
  recycle: { label: "回收站", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  rejected: { label: "审核驳回", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  unknown: { label: "未知", className: "border-[#d7e0ec] bg-white text-[#667085]" }
};

const actionOptions: Array<{
  value: DoudianBulkDeleteAction;
  label: string;
  description: string;
  icon: typeof ArrowUpCircle;
  danger?: boolean;
}> = [
  { value: "online", label: "上架", description: "将已下架商品重新上架", icon: ArrowUpCircle },
  { value: "offline", label: "下架", description: "停止售卖中的商品", icon: ArrowDownCircle },
  { value: "recycle", label: "移入回收站", description: "商品可在回收站继续处理", icon: Archive },
  { value: "delete", label: "彻底删除", description: "先移入回收站，再永久删除", icon: Trash2, danger: true }
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

function mapStore(store: DoudianStoreSummary): StoreOption {
  return {
    id: String(store.shopId || ""),
    name: store.shopName || `抖店 ${store.shopId || ""}`,
    group: store.groupName || "未分组",
    status: normalizeStoreStatus(store.status)
  };
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function formatNumber(value: number | undefined) {
  return Number.isFinite(value) ? value!.toLocaleString("zh-CN") : "未知";
}

function formatMoney(value: number | undefined) {
  return Number.isFinite(value) ? `¥${value!.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "未知";
}

function dateDaysAgo(days: number) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function splitImportLine(line: string) {
  const coarse = line.split(/[\t,，;；|]+/).map((item) => item.trim()).filter(Boolean);
  return (coarse.length > 1 ? coarse : line.split(/\s+/)).map((item) => item.trim()).filter(Boolean);
}

function normalizeImportRef(value: string) {
  return normalizeText(value).replace(/\s+/g, "");
}

function parseImportItems(value: string, stores: StoreOption[]): DoudianBulkDeleteImportItem[] {
  return value.split(/\r?\n/).flatMap((line, index) => {
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
    if (productIndex < 0) return [{ productId: "", sourceLine: index + 1, raw, validationStatus: "missing_product_id" }];
    const productId = tokens[productIndex];
    const storeRef = tokens.filter((_token, tokenIndex) => tokenIndex !== productIndex).join(" ").trim();
    const matchedStore = storeRef
      ? stores.find((store) => normalizeImportRef(store.id) === normalizeImportRef(storeRef) || normalizeImportRef(store.name) === normalizeImportRef(storeRef))
      : null;
    return [{
      productId,
      ...(matchedStore ? { shopId: matchedStore.id, shopName: matchedStore.name } : storeRef ? /^\d+$/.test(storeRef) ? { shopId: storeRef } : { shopName: storeRef } : {}),
      sourceLine: index + 1,
      raw,
      validationStatus: storeRef && !matchedStore ? "unknown_store" : "ok"
    }];
  });
}

function isProductIdQuery(value: string) {
  const lines = value.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((item) => /^\d{5,}$/.test(item));
}

function rowFromCandidate(candidate: DoudianBulkDeleteCandidate): ProductRow {
  const raw = candidate.raw && typeof candidate.raw === "object" && !Array.isArray(candidate.raw) ? candidate.raw as Record<string, unknown> : {};
  const freightTemplate = String(raw.freight_template_name || raw.freightTemplateName || raw.freight_template_id || raw.freightTemplateId || "").trim();
  return {
    id: candidate.id || `${candidate.shopId}-${candidate.productId}`,
    productId: candidate.productId,
    title: candidate.title || `商品 ${candidate.productId}`,
    shopId: candidate.shopId,
    shopName: candidate.shopName,
    status: candidate.status || "unknown",
    price: Number.isFinite(Number(candidate.price)) ? Number(candidate.price) : undefined,
    sales: Number.isFinite(Number(candidate.sales)) ? Number(candidate.sales) : undefined,
    stock: Number.isFinite(Number(candidate.stock)) ? Number(candidate.stock) : undefined,
    createdAt: candidate.createdAt,
    listedAt: candidate.listedAt,
    freightTemplate,
    source: candidate.source || "商品列表",
    excludedReason: candidate.excludedReason || "",
    ok: candidate.ok !== false && candidate.status !== "unknown" && !candidate.excludedReason
  };
}

function mergeCandidates(current: DoudianBulkDeleteCandidate[], incoming: DoudianBulkDeleteCandidate[]) {
  const merged = new Map(current.map((candidate) => [candidate.id || `${candidate.shopId}-${candidate.productId}`, candidate]));
  for (const candidate of incoming) merged.set(candidate.id || `${candidate.shopId}-${candidate.productId}`, candidate);
  return [...merged.values()];
}

function buildSampleRows(stores: StoreOption[]): ProductRow[] {
  return stores.flatMap((store, storeIndex) => sampleProducts.map((product, productIndex) => {
    const productId = `${710000 + storeIndex * 100 + productIndex}${String(productIndex + 13).padStart(2, "0")}`;
    return {
      id: `${store.id}-${productId}`,
      productId,
      title: product.title,
      shopId: store.id,
      shopName: store.name,
      status: product.status,
      price: product.price + storeIndex * 2,
      sales: product.sales + storeIndex,
      stock: product.stock + storeIndex * 12,
      createdAt: dateDaysAgo(product.createdDays),
      listedAt: dateDaysAgo(product.listedDays),
      freightTemplate: productIndex % 2 ? "通用运费模板" : "全国包邮模板",
      source: "商品列表",
      excludedReason: "",
      ok: true
    };
  }));
}

function CheckboxBox({ checked, mixed = false }: { checked: boolean; mixed?: boolean }) {
  return (
    <span className={cn("grid size-4 shrink-0 place-items-center rounded border text-white", checked || mixed ? "border-brand-fox bg-brand-fox" : "border-[#cfd8e6] bg-white")}>
      {checked ? <Check className="size-3" strokeWidth={3} /> : mixed ? <span className="h-0.5 w-2 rounded bg-white" /> : null}
    </span>
  );
}

function ProductStatusTag({ status }: { status: DoudianBulkDeleteProductStatus }) {
  const copy = statusCopy[status];
  return <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-semibold", copy.className)}>{copy.label}</span>;
}

function NumberRange({ label, min, max, unit, onChange }: { label: string; min: number; max: number; unit: string; onChange: (min: number, max: number) => void }) {
  return (
    <label className="grid min-w-0 gap-1.5 text-[12px]">
      <span className="font-semibold text-[#344054]">{label}</span>
      <span className="grid grid-cols-[minmax(72px,1fr)_auto_minmax(72px,1fr)_auto] items-center gap-2">
        <input className="h-10 min-w-0 rounded-md border border-[#dbe5f2] bg-white px-2 text-right font-semibold outline-none focus:border-brand-fox" min={0} type="number" value={min} onChange={(event) => onChange(Math.max(0, Number(event.target.value || 0)), max)} />
        <span className="text-[#98a2b3]">-</span>
        <input className="h-10 min-w-0 rounded-md border border-[#dbe5f2] bg-white px-2 text-right font-semibold outline-none focus:border-brand-fox" min={0} type="number" value={max} onChange={(event) => onChange(min, Math.max(0, Number(event.target.value || 0)))} />
        <span className="text-[#98a2b3]">{unit}</span>
      </span>
    </label>
  );
}

function exportRows(rows: ProductRow[]) {
  const lines = [
    ["店铺", "店铺ID", "商品ID", "商品标题", "状态", "售价", "销量", "库存估算", "创建时间", "上架时间", "来源"],
    ...rows.map((row) => [row.shopName, row.shopId, row.productId, row.title, statusCopy[row.status].label, row.price ?? "", row.sales ?? "", row.stock ?? "", row.createdAt || "", row.listedAt || "", row.source])
  ];
  const csv = lines.map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `赤狐商品清单_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function ProductManagementPage() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [selectedStoreIds, setSelectedStoreIds] = useState<Set<string>>(new Set());
  const [storeQuery, setStoreQuery] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadMessage, setLoadMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [productQuery, setProductQuery] = useState("");
  const [filters, setFilters] = useState<QuerySettings>(defaultQuery);
  const [sortKey, setSortKey] = useState<SortKey>("匹配时间");
  const [pageSize, setPageSize] = useState<PageSize>("100");
  const [page, setPage] = useState(0);
  const [analyzed, setAnalyzed] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewMessage, setPreviewMessage] = useState("");
  const [previewStatus, setPreviewStatus] = useState("");
  const [partialScan, setPartialScan] = useState(false);
  const [allowPartialScan, setAllowPartialScan] = useState(false);
  const [sourceRunId, setSourceRunId] = useState("");
  const [remoteCandidates, setRemoteCandidates] = useState<DoudianBulkDeleteCandidate[]>([]);
  const [freightTemplates, setFreightTemplates] = useState<DoudianFreightTemplate[]>([]);
  const [freightTemplatesBusy, setFreightTemplatesBusy] = useState(false);
  const [freightTemplatesMessage, setFreightTemplatesMessage] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [actionDialogOpen, setActionDialogOpen] = useState(false);
  const [selectedAction, setSelectedAction] = useState<DoudianBulkDeleteAction | null>(null);
  const [runState, setRunState] = useState<RunState>("idle");
  const [runProgress, setRunProgress] = useState(0);
  const [executionMessage, setExecutionMessage] = useState("");
  const [executionRows, setExecutionRows] = useState<DoudianBulkDeleteExecution[]>([]);
  const cancelExecutionRef = useRef(false);

  const previewMode = !hasNativeStoreBridge();

  useEffect(() => {
    void refreshStores();
  }, []);

  useEffect(() => {
    if (!actionDialogOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && runState !== "running") setActionDialogOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [actionDialogOpen, runState]);

  const filteredStores = useMemo(() => {
    const keyword = normalizeText(storeQuery);
    return keyword ? stores.filter((store) => normalizeText(`${store.name} ${store.id}`).includes(keyword)) : stores;
  }, [storeQuery, stores]);
  const visibleStoresSelected = filteredStores.length > 0 && filteredStores.every((store) => selectedStoreIds.has(store.id));
  const selectedVisibleStores = filteredStores.filter((store) => selectedStoreIds.has(store.id)).length;
  const someVisibleStoresSelected = selectedVisibleStores > 0 && !visibleStoresSelected;

  const sampleRows = useMemo(() => buildSampleRows(stores).filter((row) => selectedStoreIds.has(row.shopId)), [selectedStoreIds, stores]);
  const unfilteredRows = useMemo(() => previewMode ? sampleRows : remoteCandidates.map(rowFromCandidate), [previewMode, remoteCandidates, sampleRows]);
  const freightTemplateOptions = useMemo(() => Array.from(new Set([
    ...freightTemplates.map((template) => template.templateName),
    ...unfilteredRows.map((row) => row.freightTemplate)
  ].filter(Boolean))).sort(), [freightTemplates, unfilteredRows]);
  const rows = useMemo(() => {
    const keyword = normalizeText(productQuery);
    const productIds = isProductIdQuery(productQuery) ? new Set(productQuery.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean)) : null;
    const next = unfilteredRows.filter((row) => {
      if (productIds && !productIds.has(row.productId)) return false;
      if (!productIds && keyword && !normalizeText(`${row.title} ${row.productId}`).includes(keyword)) return false;
      if (filters.status !== "all" && row.status !== filters.status) return false;
      if (row.price === undefined ? filters.priceMin > 0 : row.price < filters.priceMin || row.price > filters.priceMax) return false;
      if (row.sales === undefined ? filters.salesMin > 0 : row.sales < filters.salesMin || row.sales > filters.salesMax) return false;
      if (filters.freightTemplate !== "all" && row.freightTemplate !== filters.freightTemplate) return false;
      if (filters.createdStart && (!row.createdAt || row.createdAt.slice(0, 10) < filters.createdStart)) return false;
      if (filters.createdEnd && (!row.createdAt || row.createdAt.slice(0, 10) > filters.createdEnd)) return false;
      return true;
    });
    if (sortKey === "销量") next.sort((left, right) => Number(right.sales ?? -1) - Number(left.sales ?? -1));
    else if (sortKey === "价格") next.sort((left, right) => Number(right.price ?? -1) - Number(left.price ?? -1));
    else if (sortKey === "创建时间") next.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
    return next;
  }, [filters, productQuery, sortKey, unfilteredRows]);
  const shownRows = analyzed ? rows : [];
  const executableRows = shownRows.filter((row) => row.ok);
  const pageSizeNumber = Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(shownRows.length / pageSizeNumber));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * pageSizeNumber;
  const pageEnd = Math.min(shownRows.length, pageStart + pageSizeNumber);
  const visibleRows = shownRows.slice(pageStart, pageEnd);
  const visibleExecutableIds = visibleRows.filter((row) => row.ok).map((row) => row.id);
  const selectedRows = executableRows.filter((row) => selectedProductIds.has(row.id));
  const allVisibleProductsSelected = visibleExecutableIds.length > 0 && visibleExecutableIds.every((id) => selectedProductIds.has(id));
  const selectedVisibleProductCount = visibleExecutableIds.filter((id) => selectedProductIds.has(id)).length;
  const someVisibleProductsSelected = selectedVisibleProductCount > 0 && !allVisibleProductsSelected;
  const failedRows = executionRows.filter((row) => row.ok === false);
  const submittedRows = executionRows.filter((row) => row.ok && row.status === "submitted");
  const canExecute = previewMode || (Boolean(sourceRunId) && (previewStatus === "ok" || (partialScan && allowPartialScan)));
  const canSelectRows = !previewBusy && (previewMode || previewStatus === "ok" || partialScan);

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  async function refreshStores() {
    setSyncing(true);
    setLoadState("loading");
    setLoadMessage("");
    try {
      if (!hasNativeStoreBridge()) {
        setStores(sampleStores);
        setSelectedStoreIds(new Set(sampleStores.map((store) => store.id)));
        setLoadState("ready");
        setLoadMessage("设计预览店铺");
        return;
      }
      const result = await listDoudianStores();
      if (!result.ok) throw new Error(result.message || "店铺读取失败");
      const nextStores = (result.stores || []).map(mapStore).filter((store) => store.id);
      const resolved = nextStores.length || !isDevPreviewRuntime() ? nextStores : sampleStores;
      setStores(resolved);
      setSelectedStoreIds(new Set(resolved.filter((store) => store.status !== "offline").map((store) => store.id)));
      setLoadState("ready");
      setLoadMessage(resolved === sampleStores ? "设计预览店铺" : "");
    } catch (error) {
      const fallback = isDevPreviewRuntime() ? sampleStores : [];
      setStores(fallback);
      setSelectedStoreIds(new Set(fallback.map((store) => store.id)));
      setLoadState(fallback.length ? "ready" : "error");
      setLoadMessage(fallback.length ? "已切换设计预览店铺" : error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  }

  function markQueryChanged() {
    setAnalyzed(false);
    setSelectedProductIds(new Set());
    setActionDialogOpen(false);
    setPage(0);
  }

  function setFilter<K extends keyof QuerySettings>(key: K, value: QuerySettings[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
    markQueryChanged();
  }

  function toggleStores(ids: string[]) {
    setSelectedStoreIds((current) => toggleStoreIds(current, ids));
    markQueryChanged();
  }

  function toggleProduct(id: string) {
    setSelectedProductIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        if (current.size === 0) setActionDialogOpen(true);
      }
      return next;
    });
  }

  function toggleVisibleProducts() {
    setSelectedProductIds((current) => {
      const allSelected = visibleExecutableIds.length > 0 && visibleExecutableIds.every((id) => current.has(id));
      const next = new Set(current);
      if (allSelected) visibleExecutableIds.forEach((id) => next.delete(id));
      else visibleExecutableIds.forEach((id) => next.add(id));
      if (!allSelected && current.size === 0 && visibleExecutableIds.length) setActionDialogOpen(true);
      return next;
    });
  }

  function buildFilters(sourceMode: "range" | "ids", importItems: DoudianBulkDeleteImportItem[]): DoudianBulkDeleteFilters {
    return {
      keyword: sourceMode === "range" ? productQuery.trim() : "",
      productIds: sourceMode === "ids" ? importItems.map((item) => item.productId) : [],
      importItems: sourceMode === "ids" ? importItems : [],
      status: filters.status,
      priceMin: filters.priceMin,
      priceMax: filters.priceMax,
      salesMin: filters.salesMin,
      salesMax: filters.salesMax,
      createdStart: filters.createdStart,
      createdEnd: filters.createdEnd
    };
  }

  async function fetchProducts() {
    setRunState("idle");
    setExecutionMessage("");
    setExecutionRows([]);
    setSelectedProductIds(new Set());
    setSelectedAction(null);
    setActionDialogOpen(false);
    setPage(0);
    setPreviewProgress(0);
    setRemoteCandidates([]);
    setSourceRunId("");
    setPreviewStatus("running");
    setPartialScan(false);
    setAllowPartialScan(false);
    const sourceMode = isProductIdQuery(productQuery) ? "ids" : "range";
    const parsedItems = parseImportItems(productQuery, stores);
    const importItems = parsedItems.filter((item) => item.productId && item.validationStatus === "ok");
    let streamedCandidates: DoudianBulkDeleteCandidate[] = [];
    if (sourceMode === "ids" && parsedItems.some((item) => item.validationStatus !== "ok")) {
      setAnalyzed(false);
      setPreviewMessage("商品 ID 中存在无法识别的店铺或无效内容，请检查后重试");
      return;
    }
    if (filters.priceMin > filters.priceMax || filters.salesMin > filters.salesMax || (filters.createdStart && filters.createdEnd && filters.createdStart > filters.createdEnd)) {
      setAnalyzed(false);
      setPreviewMessage("筛选区间不正确，请检查起止值");
      return;
    }
    setPreviewBusy(true);
    setAnalyzed(false);
    setPreviewMessage("正在获取商品");
    try {
      if (previewMode) {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        setPreviewProgress(100);
        setPreviewStatus("ok");
        setAnalyzed(true);
        setPreviewMessage(`已获取 ${sampleRows.length} 个商品`);
        return;
      }
      const result = await fetchDoudianBulkDeleteProducts({
        mode: "scan",
        shopIds: [...selectedStoreIds],
        sourceMode,
        filters: buildFilters(sourceMode, importItems),
        action: "recycle",
        protectMode: "includeSelling",
        onProgress: (event) => {
          setPreviewProgress((current) => Math.max(current, event.percent));
          if (!event.candidates?.length) return;
          streamedCandidates = mergeCandidates(streamedCandidates, event.candidates);
          setRemoteCandidates(streamedCandidates);
          setPreviewMessage(`已获取 ${streamedCandidates.length} 个商品，继续获取中`);
          setAnalyzed(true);
        },
        forceAdapter: true
      });
      const candidates = result.candidates || [];
      const status = result.status || (result.ok ? "ok" : "failed");
      setRemoteCandidates(candidates);
      setSourceRunId(result.sourceRunId || result.runId || "");
      setPreviewStatus(status);
      setPartialScan(status === "partial");
      setAllowPartialScan(false);
      setPreviewProgress(100);
      setAnalyzed(true);
      setPreviewMessage(result.message || `已获取 ${candidates.length} 个商品`);
    } catch (error) {
      setSourceRunId("");
      setPreviewStatus("failed");
      setPartialScan(false);
      setAnalyzed(streamedCandidates.length > 0);
      setPreviewMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function refreshFreightTemplates() {
    if (!selectedStoreIds.size) {
      setFreightTemplates([]);
      setFreightTemplatesMessage("请先选择店铺");
      return;
    }
    setFreightTemplatesBusy(true);
    setFreightTemplatesMessage("");
    try {
      if (previewMode) {
        setFreightTemplates([
          { id: "preview-freight-1", templateName: "全国包邮模板", shopId: "preview-1001", shopName: "赤狐样例店 A" },
          { id: "preview-freight-2", templateName: "通用运费模板", shopId: "preview-1001", shopName: "赤狐样例店 A" }
        ]);
        return;
      }
      const result = await fetchDoudianFreightTemplates({
        shopIds: [...selectedStoreIds],
        forceAdapter: true
      });
      setFreightTemplates(result.templates || []);
      if (!result.ok) setFreightTemplatesMessage(result.message || "运费模板获取失败");
      if (filters.freightTemplate !== "all" && !(result.templates || []).some((template) => template.templateName === filters.freightTemplate)) {
        setFilter("freightTemplate", "all");
      }
    } catch (error) {
      setFreightTemplates([]);
      setFreightTemplatesMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setFreightTemplatesBusy(false);
    }
  }

  function resetQuery() {
    setProductQuery("");
    setFilters(defaultQuery);
    setSortKey("匹配时间");
    setPageSize("100");
    setRemoteCandidates([]);
    setSourceRunId("");
    setPreviewStatus("");
    setPartialScan(false);
    setAllowPartialScan(false);
    setPreviewMessage("");
    setPreviewProgress(0);
    setAnalyzed(false);
    setSelectedProductIds(new Set());
    setActionDialogOpen(false);
    setSelectedAction(null);
    setRunState("idle");
    setExecutionRows([]);
    setExecutionMessage("");
    setPage(0);
  }

  async function executeAction() {
    if (!selectedAction || !selectedRows.length || !canExecute) return;
    setRunState("running");
    setRunProgress(0);
    setExecutionMessage("");
    setExecutionRows([]);
    cancelExecutionRef.current = false;
    if (previewMode) {
      await new Promise((resolve) => window.setTimeout(resolve, 220));
      setRunProgress(100);
      setRunState("error");
      setExecutionMessage("当前为本地设计预览，未连接店铺服务，不会提交平台请求");
      return;
    }
    try {
      const result = await fetchDoudianBulkDeleteProducts({
        mode: "execute",
        shopIds: [...selectedStoreIds],
        action: selectedAction,
        candidateIds: selectedRows.map((row) => row.id),
        sourceRunId,
        allowPartialScan,
        confirmText: "确认执行",
        onProgress: (event) => setRunProgress(event.percent),
        shouldCancel: () => cancelExecutionRef.current,
        forceAdapter: true
      });
      const nextExecutions = result.executions || [];
      const firstFailure = nextExecutions.find((row) => !row.ok);
      setExecutionRows(nextExecutions);
      if (result.status !== "cancelled") setRunProgress(100);
      setRunState(result.ok ? "done" : "error");
      setExecutionMessage(firstFailure
        ? `${result.message || "商品操作执行失败"}：${firstFailure.shopName || firstFailure.shopId} / ${firstFailure.productId}，${firstFailure.message}`
        : result.message || (result.ok ? `已提交 ${nextExecutions.length} 个商品` : "商品操作执行失败"));
    } catch (error) {
      setRunProgress(100);
      setRunState("error");
      setExecutionMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function cancelExecution() {
    cancelExecutionRef.current = true;
    setExecutionMessage("正在取消，将在当前请求结束后停止");
  }

  return (
    <section className={cn("grid h-full min-h-0 gap-3 overflow-hidden text-[#1d2939] max-[980px]:grid-cols-1 max-[980px]:overflow-auto", sidebarCollapsed ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[250px_minmax(0,1fr)]")}>
      {!sidebarCollapsed ? (
        <aside className="grid min-h-0 grid-rows-[44px_auto_minmax(0,1fr)_42px] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white">
          <div className="flex items-center justify-between border-b border-[#edf1f6] px-3.5">
            <span className="flex items-center gap-2"><Store className="size-4 text-brand-navy" /><strong className="text-[14px]">店铺选择</strong></span>
            <button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2]" type="button" title="收起店铺选择" onClick={() => setSidebarCollapsed(true)}><PanelLeftClose className="size-3.5" /></button>
          </div>
          <div className="border-b border-[#edf1f6] p-2.5">
            <label className="flex h-8 items-center gap-2 rounded-md border border-[#dbe5f2] px-2.5 text-[#98a2b3]">
              <input className="min-w-0 flex-1 bg-transparent text-[12px] text-[#1d2939] outline-none" placeholder="店铺名称 / 店铺 ID" value={storeQuery} onChange={(event) => setStoreQuery(event.target.value)} />
              <Search className="size-3.5" />
            </label>
            <button className="mt-2.5 inline-flex items-center gap-2 text-[12px] font-semibold" type="button" onClick={() => toggleStores(filteredStores.map((store) => store.id))}>
              <CheckboxBox checked={visibleStoresSelected} mixed={someVisibleStoresSelected} />全选 {selectedStoreIds.size}/{stores.length}
            </button>
          </div>
          <div className="min-h-[180px] overflow-auto">
            {loadState === "loading" ? <div className="grid h-full place-items-center text-[12px] text-[#667085]"><span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在读取店铺</span></div>
              : filteredStores.length ? <GroupedStoreSelectionList stores={filteredStores} selectedIds={selectedStoreIds} onToggleIds={toggleStores} />
                : <div className="grid h-full place-items-center px-4 text-center text-[12px] text-[#667085]">{loadState === "error" ? loadMessage || "店铺读取失败" : "暂无匹配店铺"}</div>}
          </div>
          <div className="flex items-center justify-between border-t border-[#edf1f6] px-3">
            <span className="truncate text-[11px] text-[#98a2b3]">{loadMessage || "店铺列表同步"}</span>
            <button className="inline-flex h-7 items-center gap-1 text-[12px] font-semibold disabled:opacity-50" type="button" disabled={syncing} onClick={() => void refreshStores()}><RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />刷新</button>
          </div>
        </aside>
      ) : null}

      <div className="grid min-h-0 grid-rows-[184px_minmax(0,1fr)] gap-3 overflow-hidden max-[1380px]:grid-rows-[250px_minmax(0,1fr)] max-[760px]:grid-rows-[420px_minmax(420px,1fr)]">
        <section className="grid min-h-0 grid-rows-[44px_minmax(0,1fr)] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white">
          <div className="flex items-center justify-between border-b border-[#edf1f6] px-4">
            <div className="flex items-center gap-2">
              {sidebarCollapsed ? <button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2]" type="button" title="展开店铺选择" onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen className="size-3.5" /></button> : null}
              <PackageSearch className="size-[17px] text-brand-navy" />
              <strong className="text-[15px]">商品信息</strong>
              {previewBusy ? <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-brand-navy"><Loader2 className="size-3.5 animate-spin" />获取中 {previewProgress}%</span> : null}
              {previewMessage ? <span className="max-w-[360px] truncate text-[12px] text-[#667085]">{previewMessage}</span> : null}
            </div>
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] px-3 text-[12px] font-semibold" type="button" onClick={resetQuery}><RefreshCw className="size-3.5" />重置</button>
          </div>
          <div className="grid grid-cols-[minmax(250px,1.35fr)_minmax(140px,.65fr)_minmax(220px,1fr)_minmax(220px,1fr)_minmax(220px,.9fr)] grid-rows-2 gap-x-5 gap-y-3 px-4 py-3 max-[1380px]:grid-cols-4 max-[1380px]:grid-rows-3 max-[760px]:grid-cols-2 max-[760px]:grid-rows-5 max-[760px]:gap-x-3">
            <label className="row-span-2 grid min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-1.5 text-[12px]">
              <span className="font-semibold text-[#344054]">商品标题 / ID</span>
              <span className="flex min-h-0 items-start gap-2 rounded-md border border-[#dbe5f2] px-2.5 py-2 text-[#98a2b3] focus-within:border-brand-fox">
                <Search className="mt-0.5 size-3.5 shrink-0" />
                <textarea className="h-full min-h-[70px] min-w-0 flex-1 resize-none bg-transparent text-[12px] text-[#1d2939] outline-none" placeholder="输入商品标题；也可每行输入一个商品 ID" value={productQuery} onChange={(event) => { setProductQuery(event.target.value); markQueryChanged(); }} />
              </span>
            </label>
            <label className="grid min-w-0 gap-1.5 text-[12px]"><span className="font-semibold text-[#344054]">商品选择</span><select className="h-10 rounded-md border border-[#dbe5f2] px-2 font-semibold outline-none focus:border-brand-fox" value={filters.status} onChange={(event) => setFilter("status", event.target.value as DoudianBulkDeleteProductStatusFilter)}><option value="all">全部商品</option><option value="selling">售卖中</option><option value="offline">已下架</option></select></label>
            <NumberRange label="商品价格" min={filters.priceMin} max={filters.priceMax} unit="元" onChange={(min, max) => { setFilters((current) => ({ ...current, priceMin: min, priceMax: max })); markQueryChanged(); }} />
            <NumberRange label="销量区间" min={filters.salesMin} max={filters.salesMax} unit="件" onChange={(min, max) => { setFilters((current) => ({ ...current, salesMin: min, salesMax: max })); markQueryChanged(); }} />
            <div className="grid min-w-0 gap-1.5 text-[12px]"><span className="flex min-w-0 items-center gap-1.5 font-semibold text-[#344054]"><span className="shrink-0">运费模板</span>{freightTemplatesMessage ? <span className="min-w-0 flex-1 truncate text-[10px] font-normal text-[#b54708]" title={freightTemplatesMessage}>{freightTemplatesMessage}</span> : <span className="flex-1" />}<button className="grid size-5 shrink-0 place-items-center rounded text-[#475467] hover:bg-[#f2f4f7] hover:text-brand-fox disabled:opacity-45" type="button" disabled={freightTemplatesBusy || !selectedStoreIds.size} title="刷新运费模板" aria-label="刷新运费模板" onClick={() => void refreshFreightTemplates()}><RefreshCw className={cn("size-3.5", freightTemplatesBusy && "animate-spin")} /></button></span><select className="h-10 min-w-0 rounded-md border border-[#dbe5f2] px-2 font-semibold outline-none focus:border-brand-fox" value={filters.freightTemplate} title={freightTemplatesMessage || "运费模板"} aria-label="运费模板" onChange={(event) => setFilter("freightTemplate", event.target.value)}><option value="all">全部运费模板</option>{freightTemplateOptions.map((option) => <option value={option} key={option}>{option}</option>)}</select></div>
            <div className="col-span-3 flex min-w-0 items-end gap-2 text-[12px] max-[1380px]:col-span-2">
              <span className="mb-3 whitespace-nowrap font-semibold text-[#344054]">创建时间</span>
              <input className="h-10 min-w-[138px] rounded-md border border-[#dbe5f2] px-2 outline-none focus:border-brand-fox" type="date" value={filters.createdStart} onChange={(event) => setFilter("createdStart", event.target.value)} />
              <span className="mb-3 text-[#98a2b3]">-</span>
              <input className="h-10 min-w-[138px] rounded-md border border-[#dbe5f2] px-2 outline-none focus:border-brand-fox" type="date" value={filters.createdEnd} onChange={(event) => setFilter("createdEnd", event.target.value)} />
            </div>
            <div className="flex items-end justify-end gap-2 max-[1380px]:col-span-4 max-[760px]:col-span-2">
              <button className="inline-flex h-10 min-w-[76px] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[#dbe5f2] bg-white px-3 text-[12px] font-semibold disabled:opacity-45" type="button" disabled={!shownRows.length} onClick={() => exportRows(shownRows)}><Download className="size-3.5 shrink-0" />导出</button>
              <button className="inline-flex h-10 min-w-[112px] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-brand-fox px-4 text-[12px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,.18)] disabled:opacity-45" type="button" disabled={!selectedStoreIds.size || previewBusy} onClick={() => void fetchProducts()}>{previewBusy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <PackageSearch className="size-3.5 shrink-0" />}获取商品</button>
            </div>
          </div>
        </section>

        <section className="grid min-h-0 grid-rows-[54px_minmax(0,1fr)_46px] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-[#edf1f6] px-4">
            <div className="flex min-w-0 items-center gap-2">
              <PackageSearch className="size-4 text-brand-navy" />
              <strong className="text-[15px]">商品预览</strong>
              <button className="inline-flex h-8 items-center gap-2 rounded-md border border-[#dbe5f2] px-2 text-[12px] font-semibold disabled:opacity-45" type="button" disabled={!canSelectRows} onClick={toggleVisibleProducts}><CheckboxBox checked={allVisibleProductsSelected} mixed={someVisibleProductsSelected} />本页 {selectedVisibleProductCount}/{visibleExecutableIds.length}</button>
              {selectedRows.length ? <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white" type="button" onClick={() => setActionDialogOpen(true)}><PlayCircle className="size-3.5" />执行动作</button> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-[12px]">
              <span className="rounded-md border border-[#dbe5f2] px-2 py-1.5 text-[#667085]">{shownRows.length ? `${pageStart + 1}-${pageEnd}` : "0"} / {shownRows.length}</span>
              <button className="h-8 rounded-md border border-[#dbe5f2] px-3 font-semibold disabled:opacity-40" type="button" disabled={!shownRows.length || safePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>上一页</button>
              <select className="h-8 rounded-md border border-[#dbe5f2] px-2 font-semibold" value={pageSize} onChange={(event) => { setPageSize(event.target.value as PageSize); setPage(0); }}><option value="100">100 行</option><option value="250">250 行</option><option value="500">500 行</option></select>
              <button className="h-8 rounded-md border border-[#dbe5f2] px-3 font-semibold disabled:opacity-40" type="button" disabled={!shownRows.length || safePage >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>下一页</button>
              <select className="h-8 rounded-md border border-[#dbe5f2] px-2 font-semibold" value={sortKey} onChange={(event) => { setSortKey(event.target.value as SortKey); setPage(0); }}><option>匹配时间</option><option>销量</option><option>价格</option><option>创建时间</option></select>
            </div>
          </div>
          <div className="min-h-0 overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-left text-[12px]" style={{ minWidth: 1120 }}>
              <thead className="sticky top-0 z-20 bg-[#fbfcff] text-[#344054] shadow-[inset_0_-1px_0_#e6ebf3]"><tr className="h-11"><th className="sticky left-0 z-30 w-[330px] bg-[#fbfcff] px-4 font-semibold shadow-[inset_-1px_0_0_#edf1f6]">商品 / 店铺</th><th className="px-3 font-semibold">状态</th><th className="px-3 font-semibold">售价</th><th className="px-3 font-semibold">销量</th><th className="px-3 font-semibold">库存估算</th><th className="px-3 font-semibold">创建 / 上架</th><th className="px-3 font-semibold">来源</th><th className="px-3 font-semibold">校验</th></tr></thead>
              <tbody className="divide-y divide-[#edf1f6]">
                {visibleRows.map((row) => <tr className={cn("group h-[62px] hover:bg-[#f8fbff]", !row.ok && "text-[#98a2b3]")} key={row.id}>
                  <td className="sticky left-0 z-10 w-[330px] bg-white px-4 shadow-[inset_-1px_0_0_#edf1f6] group-hover:bg-[#f8fbff]"><div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2"><button className="pt-1 disabled:opacity-40" type="button" disabled={!row.ok || !canSelectRows} aria-label="选择商品" onClick={() => toggleProduct(row.id)}><CheckboxBox checked={row.ok && selectedProductIds.has(row.id)} /></button><div className="min-w-0"><div className="truncate font-semibold text-[#1d2939]" title={row.title}>{row.title}</div><div className="mt-1 flex gap-2 text-[11px] text-[#667085]"><span className="truncate">{row.shopName}</span><span className="font-mono">{row.productId}</span></div></div></div></td>
                  <td className="whitespace-nowrap px-3"><ProductStatusTag status={row.status} /></td><td className="whitespace-nowrap px-3 font-semibold">{formatMoney(row.price)}</td><td className="whitespace-nowrap px-3">{formatNumber(row.sales)}</td><td className="whitespace-nowrap px-3">{formatNumber(row.stock)}</td><td className="whitespace-nowrap px-3 text-[#667085]"><div>{row.createdAt || "未知"}</div><div className="mt-1 text-[11px]">上架 {row.listedAt || "未知"}</div></td><td className="whitespace-nowrap px-3">{row.source}</td><td className="min-w-[150px] px-3">{row.ok ? <span className="inline-flex items-center gap-1 font-semibold text-[#087443]"><Check className="size-3.5" />可执行</span> : <span className="inline-flex items-center gap-1 font-semibold text-[#b54708]"><FileWarning className="size-3.5" />{row.excludedReason || "不可执行"}</span>}</td>
                </tr>)}
                {!shownRows.length ? <tr><td className="h-[300px] text-center" colSpan={8}><div className="mx-auto grid w-[360px] place-items-center gap-3 text-[#667085]"><span className="grid size-14 place-items-center rounded-full bg-brand-foxSoft text-brand-fox">{previewBusy ? <Loader2 className="size-7 animate-spin" /> : <PackageSearch className="size-7" />}</span><strong className="text-[14px] text-[#344054]">{previewBusy ? "正在获取首批商品" : "暂无命中商品"}</strong><span className="text-[13px] leading-6">{previewBusy ? "首批数据返回后会直接显示在这里。" : "调整店铺、商品状态、价格或销量条件后重新生成预览。"}</span></div></td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-[#edf1f6] px-4 text-[12px] text-[#667085]"><span>命中 {shownRows.length} 个商品 · 可执行 {executableRows.length} 个 · 已选 {selectedRows.length} 个 · 当前显示 {shownRows.length ? `${pageStart + 1}-${pageEnd}` : "0"}</span><div className="flex items-center gap-2"><button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] px-3 font-semibold text-[#344054] disabled:opacity-45" type="button" disabled={!shownRows.length} onClick={() => exportRows(shownRows)}><Download className="size-3.5" />导出清单</button><button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 font-semibold text-white disabled:opacity-45" type="button" disabled={!selectedRows.length} onClick={() => setActionDialogOpen(true)}><PlayCircle className="size-3.5" />执行动作</button></div></div>
        </section>
      </div>

      {actionDialogOpen ? <div className="fixed inset-0 z-[80] grid place-items-center bg-[rgba(15,23,42,.34)] p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && runState !== "running") setActionDialogOpen(false); }}>
        <section className="grid w-[min(580px,calc(100vw-32px))] gap-4 rounded-lg border border-[#e1e8f3] bg-white p-5 shadow-[0_24px_64px_rgba(15,23,42,.22)]" role="dialog" aria-modal="true" aria-labelledby="product-action-title">
          <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><ShieldAlert className="size-[18px] text-brand-fox" /><strong className="text-[16px]" id="product-action-title">选择执行动作</strong></div><p className="m-0 mt-1 text-[12px] text-[#667085]">已选择 {selectedRows.length} 个商品</p></div><button className="grid size-8 place-items-center rounded-md border border-[#dbe5f2] text-[#475467] disabled:opacity-40" type="button" disabled={runState === "running"} title="关闭" onClick={() => setActionDialogOpen(false)}><X className="size-4" /></button></div>
          <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">{actionOptions.map((option) => { const Icon = option.icon; const selected = selectedAction === option.value; return <button className={cn("grid min-h-[82px] grid-cols-[36px_minmax(0,1fr)_18px] items-center gap-3 rounded-md border px-3 text-left transition-colors", selected ? option.danger ? "border-[#fda29b] bg-[#fff1f0]" : "border-brand-fox bg-brand-foxSoft" : "border-[#dbe5f2] bg-white hover:border-[#ffb39e]")} type="button" key={option.value} onClick={() => { setSelectedAction(option.value); setRunState("idle"); setExecutionRows([]); setExecutionMessage(""); }}><span className={cn("grid size-9 place-items-center rounded-full", option.danger ? "bg-[#fff1f0] text-[#b42318]" : "bg-brand-foxSoft text-brand-fox")}><Icon className="size-[18px]" /></span><span className="min-w-0"><strong className={cn("block text-[14px]", option.danger ? "text-[#b42318]" : "text-[#1d2939]")}>{option.label}</strong><span className="mt-1 block text-[12px] text-[#667085]">{option.description}</span></span><span className={cn("grid size-[17px] place-items-center rounded-full border", selected ? "border-brand-fox bg-brand-fox text-white" : "border-[#cfd8e6]")}>{selected ? <Check className="size-3" /> : null}</span></button>; })}</div>
          {selectedAction === "delete" ? <div className="flex items-start gap-2 rounded-md border border-[#ffd1d1] bg-[#fff7f6] px-3 py-2 text-[12px] leading-5 text-[#b42318]"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" />彻底删除不可恢复。非回收站商品会先移入回收站，再从回收站永久删除。</div> : null}
          {partialScan ? <label className="flex items-start gap-2 text-[12px] leading-5 text-[#b54708]"><input className="mt-1 accent-brand-fox" type="checkbox" checked={allowPartialScan} onChange={(event) => setAllowPartialScan(event.target.checked)} />本次获取不完整，仅执行已完成店铺中的所选商品</label> : null}
          {runState !== "idle" ? <div className="grid gap-2"><div className="h-2 overflow-hidden rounded-full bg-[#eef2f7]"><div className={cn("h-full rounded-full", runState === "error" ? "bg-[#b42318]" : "bg-brand-fox")} style={{ width: `${runProgress}%` }} /></div><span className={cn("text-[12px] font-semibold", runState === "error" ? "text-[#b42318]" : "text-[#667085]")}>{runState === "running" ? `执行中 ${runProgress}%` : executionMessage || (runState === "done" ? "执行完成" : "执行失败")}</span>{executionRows.length ? <span className="text-[12px] text-[#667085]">返回 {executionRows.length} 条，成功提交 {submittedRows.length} 条，失败 {failedRows.length} 条</span> : null}</div> : null}
          <div className="flex items-center justify-between gap-3 border-t border-[#edf1f6] pt-4"><button className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#dbe5f2] px-3 text-[12px] font-semibold" type="button" onClick={() => exportRows(selectedRows)}><Download className="size-3.5" />导出所选</button><div className="flex gap-2"><button className="h-9 rounded-md border border-[#dbe5f2] px-4 text-[12px] font-semibold disabled:opacity-40" type="button" disabled={runState === "running"} onClick={() => setActionDialogOpen(false)}>取消</button><button className={cn("inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-[12px] font-semibold text-white disabled:opacity-45", runState === "running" ? "bg-[#b42318]" : "bg-brand-fox")} type="button" disabled={runState !== "running" && (!selectedAction || !selectedRows.length || !canExecute)} onClick={() => runState === "running" ? cancelExecution() : void executeAction()}>{runState === "running" ? <X className="size-3.5" /> : <PlayCircle className="size-3.5" />}{runState === "running" ? "取消执行" : "确认执行"}</button></div></div>
        </section>
      </div> : null}
    </section>
  );
}
