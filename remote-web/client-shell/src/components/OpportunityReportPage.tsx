import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FileClock,
  Loader2,
  Megaphone,
  PackageSearch,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Star,
  Store,
  Wand2
} from "lucide-react";
import { fetchDoudianOpportunityReport, fetchDoudianOpportunityReportLatest, listDoudianStores } from "../bridge/client";
import { toggleStoreIds } from "../domain/doudian/storeSelection";
import { cn } from "../lib/utils";
import { remoteAsset } from "../lib/assets";
import { GroupedStoreSelectionList } from "./GroupedStoreSelectionList";
import type {
  DoudianOpportunityClueRow,
  DoudianOpportunityExecution,
  DoudianOpportunityFilters,
  DoudianOpportunityGoodsMatchType,
  DoudianOpportunityProductRow,
  DoudianOpportunitySubmitMode,
  DoudianOpportunityTitleMatchMode,
  DoudianOpportunityTitleUpdatePosition,
  DoudianStoreSummary
} from "../types";

type OpportunityTab = "clue" | "product";

interface Option<T extends string | number = string> {
  value: T;
  label: string;
}

interface MetricItem {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "blue" | "green" | "warning" | "danger";
}

const modeTabs: Array<{ id: OpportunityTab; label: string; icon: typeof Megaphone }> = [
  { id: "clue", label: "调试：按商机", icon: Megaphone },
  { id: "product", label: "调试：按商品", icon: PackageSearch }
];

const rankTabs: Option[] = [
  { value: "11,MATCH_DEGREE", label: "智选搜索词" },
  { value: "11,PAY_AMOUNT_RATE", label: "高增速搜索词" },
  { value: "11,DEMAND_SUPPLY_RATE", label: "高需供比搜索词" },
  { value: "11,HEAT_OF_DEMAND", label: "高热度搜索词" },
  { value: "11,ONLINE_PRODUCT_NUMSO", label: "少竞品搜索词" }
];

const reasonOptions: Option<number | "">[] = [
  { value: "", label: "全部推荐" },
  { value: 35, label: "全网热卖" },
  { value: 14, label: "应季爆发" },
  { value: 31, label: "热度高" },
  { value: 34, label: "销量高" },
  { value: 32, label: "成交增速快" },
  { value: 33, label: "平台缺货" }
];

const benefitOptions: Option<number | "">[] = [
  { value: "", label: "全部权益" },
  { value: 1, label: "搜索扶持" },
  { value: 3, label: "上新扶持" },
  { value: 16, label: "新品成长激励" },
  { value: 22, label: "猜喜冷启权益" },
  { value: 23, label: "猜喜热卖权益" },
  { value: 24, label: "新奇好物标签" },
  { value: 26, label: "新潮新品扶持" },
  { value: 29, label: "商品卡扶持" }
];

const brandOptions: Array<Option<"all" | "known" | "unknown">> = [
  { value: "all", label: "全部品牌" },
  { value: "known", label: "知名品牌" },
  { value: "unknown", label: "非知名品牌" }
];

const recentlyOptions: Option<number>[] = [
  { value: 0, label: "全部时间" },
  { value: 1, label: "近1天" },
  { value: 2, label: "近7天" },
  { value: 3, label: "近30天" }
];

const cluePageOptions: Option<number>[] = [
  { value: 2, label: "144条" },
  { value: 3, label: "216条" },
  { value: 4, label: "288条" },
  { value: 5, label: "360条" }
];

const contentTypeOptions: Option<string>[] = [
  { value: "video", label: "短视频" },
  { value: "live", label: "直播" },
  { value: "product_card", label: "商品卡" }
];

function formatNumber(value: number | undefined) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function formatMoney(value: number | string | undefined) {
  const numberValue = typeof value === "number" ? value : Number(String(value || "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(numberValue) || numberValue <= 0) return String(value || "--");
  if (numberValue >= 10000) return `¥${(numberValue / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}万`;
  return `¥${numberValue.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

function formatPercent(value: number | undefined) {
  const next = Number(value || 0);
  return `${next > 0 ? "+" : ""}${next.toFixed(1)}%`;
}

function csvCell(value: unknown) {
  const textValue = String(value ?? "");
  return /[",\r\n]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
}

function downloadTextFile(filename: string, content: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function selectedLabel<T extends string | number>(options: Option<T>[], value: T | "") {
  return options.find((item) => item.value === value)?.label || "";
}

function statusCopy(status: string | undefined) {
  if (status === "collected") return { label: "已收藏", className: "border-[#bdd2ef] bg-[#f0f6ff] text-brand-navy" };
  if (status === "submitted") return { label: "已提报", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" };
  if (status === "failed") return { label: "失败", className: "border-[#ffd1cc] bg-[#fff1ef] text-[#b42318]" };
  if (status === "partial") return { label: "部分成功", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" };
  return { label: "可提报", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" };
}

function productStatusCopy(status: string | undefined) {
  if (status === "matched") return { label: "已匹配", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" };
  if (status === "blocked" || status === "failed") return { label: "待复核", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" };
  if (status === "submitted") return { label: "已提报", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" };
  return { label: "待匹配", className: "border-[#dbe5f2] bg-white text-[#667085]" };
}

function rowVisualClass(index: number) {
  return [
    "bg-[linear-gradient(135deg,#fff1e8,#ffd9c7_48%,#ffe9a8)] text-[#a43d16]",
    "bg-[linear-gradient(135deg,#eef6ff,#c7ddff_48%,#d7f8ee)] text-[#175cd3]",
    "bg-[linear-gradient(135deg,#f2fbf4,#c9f0d7_48%,#fff1c6)] text-[#087443]",
    "bg-[linear-gradient(135deg,#fff8e8,#ffe1b6_48%,#f7d6ff)] text-[#b54708]",
    "bg-[linear-gradient(135deg,#edf5ff,#cfe6ff_48%,#ffded1)] text-brand-navy"
  ][index % 5];
}

function MetricCard({ item }: { item: MetricItem }) {
  const toneClass = {
    default: "text-brand-navy",
    blue: "text-[#175cd3]",
    green: "text-[#087443]",
    warning: "text-[#b54708]",
    danger: "text-[#b42318]"
  }[item.tone || "default"];

  return (
    <article className="min-w-0 rounded-lg border border-brand-line bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <span className="block truncate text-[12px] font-semibold text-brand-muted">{item.label}</span>
      <strong className={cn("mt-1 block truncate text-[23px] font-bold leading-7 tracking-[0]", toneClass)}>{item.value}</strong>
      <span className="mt-1.5 block truncate text-[12px] text-[#667085]">{item.detail}</span>
    </article>
  );
}

function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="grid min-w-[145px] gap-1.5">
      <span className="text-[12px] font-semibold text-[#667085]">{label}</span>
      <select
        className="h-9 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[13px] font-medium text-[#1d2939] outline-none transition-colors focus:border-brand-fox"
        value={String(value)}
        onChange={(event) => {
          const option = options.find((item) => String(item.value) === event.target.value);
          if (option) onChange(option.value);
        }}
      >
        {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ContentTypeField({
  value,
  onChange
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const selected = new Set(value);
  const toggle = (next: string) => {
    const updated = new Set(selected);
    if (updated.has(next)) updated.delete(next);
    else updated.add(next);
    onChange(Array.from(updated));
  };
  return (
    <div className="grid min-w-[210px] gap-1.5">
      <span className="text-[12px] font-semibold text-[#667085]">体裁</span>
      <div className="grid h-9 grid-cols-3 gap-1">
        {contentTypeOptions.map((option) => {
          const active = selected.has(option.value);
          return (
            <button
              aria-pressed={active}
              className={cn(
                "min-w-0 truncate rounded-md border px-2 text-[12px] font-semibold transition-colors",
                active ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#526a91] hover:border-brand-fox"
              )}
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status?: string }) {
  const copy = statusCopy(status);
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-[12px] font-semibold", copy.className)}>
      {copy.label}
    </span>
  );
}

function ProductStatusPill({ status }: { status?: string }) {
  const copy = productStatusCopy(status);
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-[12px] font-semibold", copy.className)}>
      {copy.label}
    </span>
  );
}

function EmptyState({ activeTab, loading }: { activeTab: OpportunityTab; loading: boolean }) {
  return (
    <div className="grid min-h-[260px] place-items-center px-4 text-center">
      <div className="grid justify-items-center gap-2">
        {loading ? <Loader2 className="size-8 animate-spin text-brand-fox" strokeWidth={2.2} /> : activeTab === "clue" ? <Megaphone className="size-8 text-[#98a2b3]" strokeWidth={2} /> : <PackageSearch className="size-8 text-[#98a2b3]" strokeWidth={2} />}
        <strong className="text-[15px] text-brand-navy">{loading ? "正在加载" : activeTab === "clue" ? "暂无商机数据" : "暂无商品数据"}</strong>
        <span className="max-w-[280px] text-[12px] leading-5 text-[#667085]">{loading ? "请稍候" : "选择店铺后点击加载，数据会进入本地缓存并保留远程来源。"}</span>
      </div>
    </div>
  );
}

export function OpportunityReportPage() {
  const [activeTab, setActiveTab] = useState<OpportunityTab>("clue");
  const [activeRank, setActiveRank] = useState(rankTabs[0].value);
  const [reason, setReason] = useState<number | "">("");
  const [benefit, setBenefit] = useState<number | "">("");
  const [brand, setBrand] = useState<"all" | "known" | "unknown">("all");
  const [recentlyDayType, setRecentlyDayType] = useState(3);
  const [cluePage, setCluePage] = useState(2);
  const [contentTypes, setContentTypes] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [matchSource, setMatchSource] = useState<DoudianOpportunityGoodsMatchType>("new");
  const [submitMode, setSubmitMode] = useState<DoudianOpportunitySubmitMode>("validate");
  const [titleMatchMode, setTitleMatchMode] = useState<DoudianOpportunityTitleMatchMode>("any");
  const [titleUpdatePosition, setTitleUpdatePosition] = useState<DoudianOpportunityTitleUpdatePosition>("tail");
  const [stores, setStores] = useState<DoudianStoreSummary[]>([]);
  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(() => new Set());
  const [clueRows, setClueRows] = useState<DoudianOpportunityClueRow[]>([]);
  const [productRows, setProductRows] = useState<DoudianOpportunityProductRow[]>([]);
  const [executions, setExecutions] = useState<DoudianOpportunityExecution[]>([]);
  const [sourceRunId, setSourceRunId] = useState("");
  const [selectedOpportunityIds, setSelectedOpportunityIds] = useState<Set<string>>(() => new Set());
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<"" | "stores" | "scan" | "submit" | "collect" | "latest">("");
  const [message, setMessage] = useState("");

  const selectedStores = useMemo(
    () => stores.filter((store) => selectedShopIds.has(store.shopId)),
    [selectedShopIds, stores]
  );
  const selectableStores = useMemo(() => stores.map((store) => ({
    id: store.shopId,
    name: store.shopName || `抖店 ${store.shopId}`,
    group: store.groupName || "未分组",
    status: store.status
  })), [stores]);

  const filters = useMemo<DoudianOpportunityFilters>(() => ({
    keyword: query.trim(),
    activeKey: activeRank,
    tagIdList: reason === "" ? [] : [Number(reason)],
    profitIdList: benefit === "" ? [] : [Number(benefit)],
    clueBrandExists: brand === "all" ? null : brand === "known",
    recentlyDayType,
    benefitContentType: contentTypes,
    clueCoveragePages: cluePage
  }), [activeRank, benefit, brand, cluePage, contentTypes, query, reason, recentlyDayType]);

  async function refreshStores() {
    setLoading((current) => current || "stores");
    try {
      const result = await listDoudianStores();
      const nextStores = result.stores || [];
      setStores(nextStores);
      setSelectedShopIds((current) => {
        const existing = new Set(Array.from(current).filter((id) => nextStores.some((store) => store.shopId === id)));
        if (existing.size) return existing;
        return new Set(nextStores.map((store) => store.shopId));
      });
      if (result.message) setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading((current) => current === "stores" ? "" : current);
    }
  }

  async function restoreLatest() {
    setLoading((current) => current || "latest");
    try {
      const result = await fetchDoudianOpportunityReportLatest({ filters });
      setClueRows(result.clues || result.rows || []);
      setProductRows(result.products || []);
      setExecutions(result.executions || []);
      setSourceRunId(result.sourceRunId || result.runId || "");
      if (result.message) setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading((current) => current === "latest" ? "" : current);
    }
  }

  useEffect(() => {
    refreshStores();
    restoreLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleClues = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const reasonLabel = reason === "" ? "" : selectedLabel(reasonOptions, reason);
    const benefitLabel = benefit === "" ? "" : selectedLabel(benefitOptions, benefit);
    const rows = clueRows.filter((row) => {
      const matchesKeyword = !keyword || [
        row.name,
        row.shortName,
        row.categoryName,
        row.payMoney,
        ...(row.recommendList || []),
        ...(row.profitInfoList || []),
        ...(row.clueWords || [])
      ].some((item) => String(item || "").toLowerCase().includes(keyword));
      const matchesReason = !reasonLabel || (row.recommendList || []).includes(reasonLabel);
      const matchesBenefit = !benefitLabel || (row.profitInfoList || []).includes(benefitLabel);
      return matchesKeyword && matchesReason && matchesBenefit;
    });
    return [...rows].sort((left, right) => {
      if (activeRank.includes("PAY_AMOUNT_RATE")) return Number(right.growthRate || 0) - Number(left.growthRate || 0);
      if (activeRank.includes("DEMAND_SUPPLY_RATE")) return Number(right.demandSupplyRate || 0) - Number(left.demandSupplyRate || 0);
      if (activeRank.includes("HEAT_OF_DEMAND")) return Number(right.hotCountSort || right.searchCount || 0) - Number(left.hotCountSort || left.searchCount || 0);
      if (activeRank.includes("ONLINE_PRODUCT_NUMSO")) return Number(left.onlineGoodsNumSort || 0) - Number(right.onlineGoodsNumSort || 0);
      return Number(right.searchCount || 0) - Number(left.searchCount || 0);
    });
  }, [activeRank, benefit, clueRows, query, reason]);

  const visibleProducts = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return productRows.filter((row) => !keyword || [row.title, row.category, row.shopName, row.productId, row.matchedClueName].some((item) => String(item || "").toLowerCase().includes(keyword)));
  }, [productRows, query]);

  const selectedOpportunityRows = useMemo(
    () => clueRows.filter((row) => selectedOpportunityIds.has(row.id)),
    [clueRows, selectedOpportunityIds]
  );

  const selectedProductRows = useMemo(
    () => productRows.filter((row) => selectedProductIds.has(row.id)),
    [productRows, selectedProductIds]
  );

  const selectedCount = activeTab === "clue" ? selectedOpportunityRows.length : selectedProductRows.length;
  const selectedProductCount = activeTab === "clue"
    ? selectedOpportunityRows.reduce((sum, row) => sum + Number(row.productCount || row.onlineGoodsNumSort || 0), 0)
    : selectedProductRows.length;
  const selectedStoreCount = selectedStores.length;
  const successExecutionCount = executions.filter((item) => item.ok).length;
  const failedExecutionCount = executions.filter((item) => item.ok === false).length;
  const failedExecutions = useMemo(() => executions.filter((item) => item.ok === false), [executions]);

  const metrics: MetricItem[] = [
    { label: activeTab === "clue" ? "已加载商机" : "已加载商品", value: formatNumber(activeTab === "clue" ? visibleClues.length : visibleProducts.length), detail: `${selectedStoreCount} 家店铺参与`, tone: "blue" },
    { label: activeTab === "clue" ? "已选商机" : "已选商品", value: formatNumber(selectedCount), detail: sourceRunId ? `来源 ${sourceRunId.slice(0, 18)}` : "等待远程扫描", tone: "default" },
    { label: activeTab === "clue" ? "预计适配商品" : "待匹配商机", value: formatNumber(selectedProductCount), detail: matchSource === "new" ? "近30天新品" : "官方范围", tone: "green" },
    { label: "执行结果", value: `${successExecutionCount}/${executions.length || 0}`, detail: failedExecutionCount ? `${failedExecutionCount} 项待复核` : "最近一次队列", tone: failedExecutionCount ? "warning" : "default" }
  ];

  function toggleStores(shopIds: string[]) {
    setSelectedShopIds((current) => toggleStoreIds(current, shopIds));
  }

  function selectAllStores() {
    toggleStores(selectableStores.map((store) => store.id));
  }

  function toggleOpportunity(id: string) {
    setSelectedOpportunityIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleProduct(id: string) {
    setSelectedProductIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllOpportunities() {
    setSelectedOpportunityIds((current) => {
      const next = new Set(current);
      const allVisibleSelected = visibleClues.length > 0 && visibleClues.every((row) => next.has(row.id));
      for (const row of visibleClues) {
        if (allVisibleSelected) next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });
  }

  function toggleAllProducts() {
    setSelectedProductIds((current) => {
      const next = new Set(current);
      const allVisibleSelected = visibleProducts.length > 0 && visibleProducts.every((row) => next.has(row.id));
      for (const row of visibleProducts) {
        if (allVisibleSelected) next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });
  }

  function exportFailedExecutions() {
    if (!failedExecutions.length) return;
    const headers = ["店铺ID", "店铺名称", "商机ID", "商机名称", "商品ID", "商品标题", "动作", "阶段", "状态", "消息", "计划"];
    const rows = failedExecutions.map((item) => [
      item.shopId,
      item.shopName,
      item.clueId || "",
      item.clueName || "",
      item.productId || "",
      item.title || "",
      item.action,
      item.stage || "",
      item.status,
      item.message,
      item.planKey || ""
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadTextFile(`opportunity-failures-${Date.now()}.csv`, csv);
  }

  async function runScan() {
    if (!selectedShopIds.size) {
      setMessage("请先选择店铺");
      return;
    }
    setLoading("scan");
    setMessage(activeTab === "clue" ? "正在加载商机" : "正在加载商品");
    try {
      const result = await fetchDoudianOpportunityReport({
        mode: activeTab === "clue" ? "clue-scan" : "product-scan",
        shopIds: Array.from(selectedShopIds),
        filters,
        operationId: `opportunity-${activeTab}-scan-${Date.now()}`
      });
      if (activeTab === "clue") {
        setClueRows(result.clues || result.rows || []);
        setSelectedOpportunityIds(new Set());
      } else {
        setProductRows(result.products || []);
        setSelectedProductIds(new Set());
      }
      setExecutions(result.executions || []);
      setSourceRunId(result.runId || "");
      setMessage(result.message || (result.ok ? "加载完成" : "加载失败"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading("");
    }
  }

  async function runSubmit() {
    if (!selectedCount) {
      setMessage("请先选择要提报的项目");
      return;
    }
    if (!sourceRunId) {
      setMessage("请先完成扫描或恢复商机提报缓存");
      return;
    }
    setLoading("submit");
    setMessage("正在执行提报队列");
    try {
      const result = await fetchDoudianOpportunityReport({
        mode: activeTab === "clue" ? "clue-submit" : "product-submit",
        shopIds: Array.from(selectedShopIds),
        filters,
        submitMode,
        goodsMatchType: matchSource,
        titleMatchMode,
        titleUpdatePosition,
        sourceRunId,
        clueIds: selectedOpportunityRows.map((row) => row.id),
        productIds: selectedProductRows.map((row) => row.id),
        operationId: `opportunity-submit-${Date.now()}`
      });
      setExecutions(result.executions || []);
      setMessage(result.message || (result.ok ? "提报完成" : "提报失败"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading("");
    }
  }

  async function runCollect() {
    if (!selectedOpportunityRows.length) {
      setMessage("请先选择要收藏的商机");
      return;
    }
    if (!sourceRunId) {
      setMessage("请先完成扫描或恢复商机提报缓存");
      return;
    }
    setLoading("collect");
    setMessage("正在收藏商机");
    try {
      const result = await fetchDoudianOpportunityReport({
        mode: "collect",
        shopIds: Array.from(selectedShopIds),
        filters,
        sourceRunId,
        clueIds: selectedOpportunityRows.map((row) => row.id),
        operationId: `opportunity-collect-${Date.now()}`
      });
      setExecutions(result.executions || []);
      setMessage(result.message || (result.ok ? "收藏完成" : "收藏失败"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading("");
    }
  }

  const busy = Boolean(loading);

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 text-[#101828]" data-business-slot="ready">
      <div className="flex min-h-[82px] items-center justify-between gap-4 rounded-lg border border-brand-line bg-white px-5 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)] max-[760px]:items-start max-[760px]:flex-col">
        <div className="flex min-w-0 items-center gap-3">
          <img
            alt="赤狐管家"
            className="size-11 shrink-0 rounded-lg object-contain shadow-[0_10px_22px_rgba(255,80,32,0.14)]"
            src={remoteAsset("assets/chihu-logo-mark.png")}
          />
          <div className="min-w-0">
            <span className="mb-1 inline-flex items-center gap-1 text-[12px] font-bold text-brand-fox">
              <Sparkles className="size-[14px]" strokeWidth={2} />
              商机中心
            </span>
            <h1 className="m-0 truncate text-[24px] font-extrabold leading-8 tracking-[0] text-brand-navy max-[760px]:text-[21px]">商机调试工具</h1>
            <span className="mt-1 block truncate text-[12px] font-semibold text-[#667085]">正式批量提报请使用“商机提报”。</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 max-[760px]:w-full max-[760px]:justify-start">
          <button className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-3 text-[13px] font-semibold text-[#344054] transition-colors hover:bg-[#f8fbff] disabled:opacity-50" type="button" onClick={refreshStores} disabled={busy}>
            <RefreshCw className={cn("size-[15px]", loading === "stores" && "animate-spin")} strokeWidth={2} />
            刷新店铺
          </button>
          <button className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-3 text-[13px] font-semibold text-[#344054] transition-colors hover:bg-[#f8fbff] disabled:opacity-50" type="button" onClick={runScan} disabled={busy || !selectedShopIds.size}>
            {loading === "scan" ? <Loader2 className="size-[15px] animate-spin" strokeWidth={2} /> : <Search className="size-[15px]" strokeWidth={2} />}
            {activeTab === "clue" ? "加载商机" : "加载商品"}
          </button>
          <button className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[13px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] transition-colors hover:bg-brand-foxHover disabled:opacity-50" type="button" onClick={runSubmit} disabled={busy || !selectedCount}>
            {loading === "submit" ? <Loader2 className="size-[15px] animate-spin" strokeWidth={2} /> : <Send className="size-[15px]" strokeWidth={2} />}
            调试提报
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 max-[980px]:grid-cols-2 max-[560px]:grid-cols-1">
        {metrics.map((item) => <MetricCard item={item} key={item.label} />)}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_310px] gap-3 overflow-hidden max-[1120px]:flex max-[1120px]:min-h-0 max-[1120px]:flex-col">
        <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
          <section className="rounded-lg border border-brand-line bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid min-w-[260px] flex-1 gap-1.5">
                <span className="text-[12px] font-semibold text-[#667085]">搜索</span>
                <div className="flex h-9 items-center gap-2 rounded-md border border-[#dbe5f2] bg-white px-2.5 focus-within:border-brand-fox">
                  <Search className="size-[15px] shrink-0 text-[#98a2b3]" strokeWidth={2} />
                  <input
                    className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[#1d2939] outline-none placeholder:text-[#98a2b3]"
                    placeholder={activeTab === "clue" ? "商机词、类目、权益" : "商品标题、ID、店铺"}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              </div>
              <SelectField label="推荐理由" value={reason} options={reasonOptions} onChange={setReason} />
              <SelectField label="权益" value={benefit} options={benefitOptions} onChange={setBenefit} />
              <SelectField label="品牌" value={brand} options={brandOptions} onChange={setBrand} />
              <SelectField label="时间" value={recentlyDayType} options={recentlyOptions} onChange={setRecentlyDayType} />
              <SelectField label="加载量" value={cluePage} options={cluePageOptions} onChange={setCluePage} />
              <ContentTypeField value={contentTypes} onChange={setContentTypes} />
            </div>
          </section>

          <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-line bg-white px-3 py-2 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="inline-grid min-w-0 grid-cols-2 gap-2 max-[560px]:w-full max-[560px]:grid-cols-1">
              {modeTabs.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className={cn(
                      "inline-flex h-9 min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border px-3 text-[13px] font-semibold transition-colors",
                      activeTab === item.id ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#344054] hover:border-brand-fox"
                    )}
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTab(item.id)}
                  >
                    <Icon className="size-[15px]" strokeWidth={2} />
                    <span className="min-w-0 truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="grid w-full grid-cols-2 gap-2 min-[760px]:flex min-[760px]:w-auto min-[760px]:flex-wrap min-[760px]:items-center">
              {rankTabs.map((item) => (
                <button
                  className={cn(
                    "h-8 w-full truncate rounded-md border px-2.5 text-[12px] font-semibold transition-colors min-[760px]:w-auto",
                    activeRank === item.value ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#526a91] hover:border-brand-fox"
                  )}
                  key={item.value}
                  type="button"
                  onClick={() => setActiveRank(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </section>

          {activeTab === "clue" ? (
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-brand-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
              <div className="min-h-0 flex-1 overflow-auto">
                {visibleClues.length ? (
                  <table className="min-w-[1120px] w-full border-separate border-spacing-0 text-left">
                    <thead className="sticky top-0 z-10 bg-[#fbfcff] text-[12px] font-semibold text-[#667085]">
                      <tr>
                        <th className="w-10 border-b border-[#edf1f6] px-3 py-2.5">
                          <input
                            aria-label="选择全部商机"
                            checked={visibleClues.length > 0 && visibleClues.every((row) => selectedOpportunityIds.has(row.id))}
                            className="size-4 accent-brand-fox"
                            type="checkbox"
                            onChange={toggleAllOpportunities}
                          />
                        </th>
                        <th className="w-[290px] border-b border-[#edf1f6] px-3 py-2.5">商机信息</th>
                        <th className="w-[170px] border-b border-[#edf1f6] px-3 py-2.5">权益</th>
                        <th className="w-[185px] border-b border-[#edf1f6] px-3 py-2.5">可提报店铺</th>
                        <th className="w-[175px] border-b border-[#edf1f6] px-3 py-2.5">类目</th>
                        <th className="w-[116px] border-b border-[#edf1f6] px-3 py-2.5 text-right">搜索次数</th>
                        <th className="w-[108px] border-b border-[#edf1f6] px-3 py-2.5 text-right">成交增速</th>
                        <th className="w-[95px] border-b border-[#edf1f6] px-3 py-2.5 text-right">需供比</th>
                        <th className="w-[130px] border-b border-[#edf1f6] px-3 py-2.5">在线商品</th>
                        <th className="w-[90px] border-b border-[#edf1f6] px-3 py-2.5">状态</th>
                      </tr>
                    </thead>
                    <tbody className="text-[13px]">
                      {visibleClues.map((row, index) => (
                        <tr className="group hover:bg-[#fffaf7]" key={row.id}>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <input
                              aria-label={`选择${row.name}`}
                              checked={selectedOpportunityIds.has(row.id)}
                              className="size-4 accent-brand-fox"
                              type="checkbox"
                              onChange={() => toggleOpportunity(row.id)}
                            />
                          </td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <div className="flex min-w-0 gap-3">
                              <span className={cn("grid size-12 shrink-0 place-items-center rounded-lg text-[16px] font-extrabold", rowVisualClass(index))}>
                                {String(index + 1).padStart(2, "0")}
                              </span>
                              <div className="min-w-0">
                                <div className="flex min-w-0 items-center gap-2">
                                  <strong className="truncate text-[14px] text-[#1d2939]" title={row.name}>{row.name}</strong>
                                  <StatusPill status={row.status} />
                                </div>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {(row.recommendList || []).slice(0, 3).map((item) => (
                                    <span className="rounded-md bg-[#f6f8fc] px-1.5 py-0.5 text-[11px] font-semibold text-[#526a91]" key={item}>{item}</span>
                                  ))}
                                </div>
                                <p className="m-0 mt-1 truncate text-[12px] text-[#667085]" title={row.shortName}>{row.shortName || row.name}</p>
                              </div>
                            </div>
                          </td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <div className="flex flex-wrap gap-1">
                              {(row.profitInfoList || []).slice(0, 3).map((item) => (
                                <span className="rounded-md border border-[#ffdcca] bg-[#fff7f2] px-1.5 py-0.5 text-[11px] font-semibold text-brand-fox" key={item}>{item}</span>
                              ))}
                              {!row.profitInfoList?.length ? <span className="text-[12px] text-[#98a2b3]">--</span> : null}
                            </div>
                          </td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <div className="grid gap-1">
                              {row.shopList.slice(0, 2).map((shop) => (
                                <span className="inline-flex min-w-0 items-center gap-1 text-[#344054]" key={shop.shopId}>
                                  <Store className="size-[13px] shrink-0 text-[#98a2b3]" strokeWidth={2} />
                                  <span className="truncate">{shop.shopName}</span>
                                </span>
                              ))}
                              {row.shopList.length > 2 ? <span className="text-[12px] font-semibold text-brand-fox">+{row.shopList.length - 2} 家</span> : null}
                            </div>
                          </td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <span className="line-clamp-2 text-[#344054]" title={row.categoryName}>{row.categoryName || "--"}</span>
                          </td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 text-right align-top font-semibold text-brand-navy">{formatNumber(row.searchCount)}</td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 text-right align-top font-semibold text-[#087443]">{formatPercent(row.growthRate)}</td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 text-right align-top font-semibold text-[#b54708]">{Number(row.demandSupplyRate || 0).toFixed(1)}</td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <span className="block font-semibold text-[#344054]">{row.onlineGoodsNum || "--"}</span>
                            <span className="mt-1 block text-[12px] text-[#667085]">{row.hotCount || "--"}热度 · {formatMoney(row.payMoneySort || row.payMoney)}</span>
                          </td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <StatusPill status={row.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <EmptyState activeTab={activeTab} loading={loading === "scan" || loading === "latest"} />}
              </div>
            </section>
          ) : (
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-brand-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
              <div className="min-h-0 flex-1 overflow-auto">
                {visibleProducts.length ? (
                  <table className="min-w-[980px] w-full border-separate border-spacing-0 text-left">
                    <thead className="sticky top-0 z-10 bg-[#fbfcff] text-[12px] font-semibold text-[#667085]">
                      <tr>
                        <th className="w-10 border-b border-[#edf1f6] px-3 py-2.5">
                          <input
                            aria-label="选择全部商品"
                            checked={visibleProducts.length > 0 && visibleProducts.every((row) => selectedProductIds.has(row.id))}
                            className="size-4 accent-brand-fox"
                            type="checkbox"
                            onChange={toggleAllProducts}
                          />
                        </th>
                        <th className="w-[300px] border-b border-[#edf1f6] px-3 py-2.5">商品信息</th>
                        <th className="w-[155px] border-b border-[#edf1f6] px-3 py-2.5">所属店铺</th>
                        <th className="w-[180px] border-b border-[#edf1f6] px-3 py-2.5">商品类目</th>
                        <th className="w-[100px] border-b border-[#edf1f6] px-3 py-2.5 text-right">价格</th>
                        <th className="w-[90px] border-b border-[#edf1f6] px-3 py-2.5 text-right">销量</th>
                        <th className="w-[90px] border-b border-[#edf1f6] px-3 py-2.5 text-right">库存</th>
                        <th className="w-[145px] border-b border-[#edf1f6] px-3 py-2.5">匹配商机</th>
                        <th className="w-[100px] border-b border-[#edf1f6] px-3 py-2.5">状态</th>
                      </tr>
                    </thead>
                    <tbody className="text-[13px]">
                      {visibleProducts.map((row, index) => (
                        <tr className="group hover:bg-[#fffaf7]" key={row.id}>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <input
                              aria-label={`选择${row.title}`}
                              checked={selectedProductIds.has(row.id)}
                              className="size-4 accent-brand-fox"
                              type="checkbox"
                              onChange={() => toggleProduct(row.id)}
                            />
                          </td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <div className="flex min-w-0 gap-3">
                              <span className={cn("grid size-11 shrink-0 place-items-center rounded-lg text-[15px] font-extrabold", rowVisualClass(index + 1))}>
                                {index + 1}
                              </span>
                              <div className="min-w-0">
                                <strong className="block truncate text-[14px] text-[#1d2939]" title={row.title}>{row.title}</strong>
                                <span className="mt-1 block truncate text-[12px] text-[#667085]">ID {row.productId} · {row.listedAt || row.createdAt || "--"}</span>
                              </div>
                            </div>
                          </td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">{row.shopName}</td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">{row.category || "--"}</td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 text-right align-top font-semibold text-brand-navy">¥{Number(row.price || 0).toFixed(2)}</td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 text-right align-top">{formatNumber(row.sales)}</td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 text-right align-top">{formatNumber(row.stock)}</td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <span className="rounded-md border border-[#dbe5f2] bg-[#f8fbff] px-2 py-1 text-[12px] font-semibold text-[#344054]">{row.matchedClueName || "待匹配"}</span>
                          </td>
                          <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                            <ProductStatusPill status={row.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <EmptyState activeTab={activeTab} loading={loading === "scan" || loading === "latest"} />}
              </div>
            </section>
          )}
        </div>

        <aside className="flex min-h-0 flex-col gap-3 max-[1120px]:grid max-[1120px]:grid-cols-2 max-[760px]:flex max-[760px]:grid-cols-1">
          <section className="rounded-lg border border-brand-line bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <strong className="block text-[15px] text-brand-navy">店铺范围</strong>
                <span className="block text-[12px] text-[#667085]">已选 {selectedStoreCount} / {stores.length} 家</span>
              </div>
              <button className="h-7 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] hover:border-brand-fox hover:text-brand-fox" type="button" onClick={selectAllStores}>
                {selectedShopIds.size === stores.length ? "清空" : "全选"}
              </button>
            </div>
            <div className="max-h-[240px] overflow-auto rounded-md border border-[#edf1f6]">
              {stores.length ? (
                <GroupedStoreSelectionList stores={selectableStores} selectedIds={selectedShopIds} onToggleIds={toggleStores} />
              ) : (
                <div className="rounded-lg border border-[#edf1f6] bg-[#fbfcff] p-3 text-[12px] text-[#667085]">暂无店铺台账</div>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-brand-line bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <strong className="block text-[15px] text-brand-navy">提报设置</strong>
                <span className="block text-[12px] text-[#667085]">已选 {selectedCount} 项</span>
              </div>
              <Wand2 className="size-5 text-brand-fox" strokeWidth={2} />
            </div>
            <div className="grid gap-3">
              <div className="grid gap-2">
                <span className="text-[12px] font-semibold text-[#667085]">商品范围</span>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { key: "new" as const, label: "新品" },
                    { key: "official" as const, label: "官方范围" }
                  ].map((item) => (
                    <button
                      className={cn(
                        "h-9 rounded-md border text-[13px] font-semibold transition-colors",
                        matchSource === item.key ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#344054] hover:border-brand-fox"
                      )}
                      key={item.key}
                      type="button"
                      onClick={() => setMatchSource(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-2">
                <span className="text-[12px] font-semibold text-[#667085]">提报模式</span>
                <div className="grid gap-2">
                  {[
                    { key: "validate" as const, label: "校验商机词", detail: "不改标题" },
                    { key: "updateTitle" as const, label: "添加商机词", detail: "改标题" }
                  ].map((item) => (
                    <button
                      className={cn(
                        "flex min-h-10 items-center justify-between rounded-md border px-3 text-left transition-colors",
                        submitMode === item.key ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#344054] hover:border-brand-fox"
                      )}
                      key={item.key}
                      type="button"
                      onClick={() => setSubmitMode(item.key)}
                    >
                      <span className="text-[13px] font-semibold">{item.label}</span>
                      <span className="text-[12px] font-semibold opacity-80">{item.detail}</span>
                    </button>
                  ))}
                </div>
              </div>

              {submitMode === "validate" ? (
                <div className="grid gap-2">
                  <span className="text-[12px] font-semibold text-[#667085]">商机词校验</span>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: "any" as const, label: "包含一个词" },
                      { key: "all" as const, label: "包含全部词" }
                    ].map((item) => (
                      <button
                        className={cn(
                          "h-9 rounded-md border text-[13px] font-semibold transition-colors",
                          titleMatchMode === item.key ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#344054] hover:border-brand-fox"
                        )}
                        key={item.key}
                        type="button"
                        onClick={() => setTitleMatchMode(item.key)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid gap-2">
                  <span className="text-[12px] font-semibold text-[#667085]">商机词位置</span>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: "tail" as const, label: "标题尾部" },
                      { key: "head" as const, label: "标题头部" }
                    ].map((item) => (
                      <button
                        className={cn(
                          "h-9 rounded-md border text-[13px] font-semibold transition-colors",
                          titleUpdatePosition === item.key ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#344054] hover:border-brand-fox"
                        )}
                        key={item.key}
                        type="button"
                        onClick={() => setTitleUpdatePosition(item.key)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2 rounded-md border border-[#ffdca8] bg-[#fff8eb] px-3 py-2 text-[12px] leading-5 text-[#8a4b08]">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" strokeWidth={2} />
                    <span>改标题前请确认商机词与商品属性相关，标题与商品不符可能触发商品违规。</span>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-3 text-[13px] font-semibold text-[#344054] transition-colors hover:border-brand-fox hover:text-brand-fox disabled:opacity-50"
                  type="button"
                  onClick={runCollect}
                  disabled={busy || !selectedOpportunityRows.length || activeTab !== "clue"}
                >
                  {loading === "collect" ? <Loader2 className="size-[15px] animate-spin" strokeWidth={2} /> : <Star className="size-[15px]" strokeWidth={2} />}
                  收藏商机
                </button>
                <button
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-brand-fox px-3 text-[13px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] transition-colors hover:bg-brand-foxHover disabled:opacity-50"
                  type="button"
                  onClick={runSubmit}
                  disabled={busy || !selectedCount}
                >
                  {loading === "submit" ? <Loader2 className="size-[15px] animate-spin" strokeWidth={2} /> : <Send className="size-[15px]" strokeWidth={2} />}
                  执行提报
                </button>
              </div>
            </div>
          </section>

          <section className="flex min-h-0 flex-col rounded-lg border border-brand-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] max-[1120px]:col-span-2 max-[760px]:col-span-1">
            <div className="flex min-h-[46px] items-center justify-between gap-3 border-b border-[#edf1f6] px-4 py-2">
              <div>
                <strong className="block text-[15px] text-brand-navy">提报记录</strong>
                <span className="block text-[12px] text-[#667085]">{message || "等待操作"}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] transition-colors hover:border-brand-fox hover:text-brand-fox disabled:opacity-50"
                  type="button"
                  onClick={exportFailedExecutions}
                  disabled={!failedExecutions.length}
                  title="导出失败记录"
                >
                  <Download className="size-[14px]" strokeWidth={2} />
                  失败
                </button>
                <FileClock className="size-5 text-[#526a91]" strokeWidth={2} />
              </div>
            </div>
            <div className="grid max-h-[260px] gap-2 overflow-auto p-3">
              {busy ? (
                <div className="flex items-start gap-2 rounded-lg border border-[#bdd2ef] bg-[#f0f6ff] p-3 text-brand-navy">
                  <Loader2 className="mt-0.5 size-[16px] shrink-0 animate-spin" strokeWidth={2.2} />
                  <div className="min-w-0">
                    <strong className="block truncate text-[13px]">队列处理中</strong>
                    <span className="mt-0.5 block text-[12px] opacity-80">{message || "正在同步远程数据"}</span>
                  </div>
                </div>
              ) : null}
              {executions.slice(0, 20).map((item) => (
                <article className="rounded-lg border border-[#edf1f6] bg-[#fbfcff] p-3" key={item.id}>
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <strong className="block truncate text-[13px] text-[#1d2939]" title={item.title || item.clueName}>{item.title || item.clueName || item.productId || item.clueId}</strong>
                      <span className="mt-1 block truncate text-[12px] text-[#667085]" title={item.shopName}>{item.shopName}</span>
                    </div>
                    <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold", item.ok ? "bg-[#eafaf0] text-[#087443]" : "bg-[#fff1ef] text-[#b42318]")}>{item.status}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-[12px] font-semibold text-[#667085]">
                    {item.ok ? <Check className="size-[14px] text-[#087443]" strokeWidth={2} /> : <AlertTriangle className="size-[14px] text-[#b54708]" strokeWidth={2} />}
                    <span className="truncate">{item.message}</span>
                  </div>
                </article>
              ))}
              {!busy && !executions.length ? (
                <div className="rounded-lg border border-[#edf1f6] bg-[#fbfcff] p-3 text-[12px] leading-5 text-[#667085]">
                  暂无执行记录
                </div>
              ) : null}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
