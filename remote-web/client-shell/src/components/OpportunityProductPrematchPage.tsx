import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  PackageSearch,
  Play,
  RefreshCw,
  Search,
  Send,
  Shuffle,
  Target
} from "lucide-react";
import { fetchDoudianOpportunityReport, fetchDoudianOpportunityReportLatest, listDoudianStores } from "../bridge/client";
import { cn } from "../lib/utils";
import type {
  DoudianOpportunityClueRow,
  DoudianOpportunityExecution,
  DoudianOpportunityFilters,
  DoudianOpportunityPrematchCandidate,
  DoudianOpportunityPrematchMode,
  DoudianOpportunityProductRow,
  DoudianOpportunitySubmitMode,
  DoudianOpportunityTitleMatchMode,
  DoudianOpportunityTitleUpdatePosition,
  DoudianStoreSummary
} from "../types";

interface Option<T extends string | number = string> {
  value: T;
  label: string;
}

const rankTabs: Option[] = [
  { value: "11,MATCH_DEGREE", label: "智选搜索词" },
  { value: "11,PAY_AMOUNT_RATE", label: "高增速" },
  { value: "11,DEMAND_SUPPLY_RATE", label: "高需供比" },
  { value: "11,HEAT_OF_DEMAND", label: "高热度" },
  { value: "11,ONLINE_PRODUCT_NUMSO", label: "少竞品" }
];

const reasonOptions: Option<number>[] = [
  { value: 35, label: "全网热卖" },
  { value: 14, label: "应季爆发" },
  { value: 31, label: "热度高" },
  { value: 34, label: "销量高" },
  { value: 32, label: "成交增速快" },
  { value: 33, label: "平台缺货" }
];

const benefitOptions: Option<number>[] = [
  { value: 1, label: "搜索扶持" },
  { value: 3, label: "上新扶持" },
  { value: 16, label: "新品成长激励" },
  { value: 22, label: "猜喜冷启权益" },
  { value: 23, label: "猜喜热卖权益" },
  { value: 29, label: "商品卡扶持" }
];

const recentlyOptions: Option<number>[] = [
  { value: 0, label: "全部" },
  { value: 1, label: "近1天" },
  { value: 2, label: "近7天" },
  { value: 3, label: "近30天" }
];

const defaultSubmitMode: DoudianOpportunitySubmitMode = "validate";
const defaultTitleMatchMode: DoudianOpportunityTitleMatchMode = "any";
const defaultTitleUpdatePosition: DoudianOpportunityTitleUpdatePosition = "tail";

function formatNumber(value: number | undefined) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function Metric({ label, value, detail, tone = "default" }: { label: string; value: string; detail: string; tone?: "default" | "blue" | "green" | "warn" }) {
  const toneClass = {
    default: "text-[#111827]",
    blue: "text-brand-navy",
    green: "text-[#087443]",
    warn: "text-[#b54708]"
  }[tone];
  return (
    <div className="min-w-0 rounded-lg border border-brand-line bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <span className="block truncate text-[12px] font-semibold text-brand-muted">{label}</span>
      <strong className={cn("mt-1 block truncate text-[23px] font-bold leading-7 tracking-[0]", toneClass)}>{value}</strong>
      <span className="mt-1.5 block truncate text-[12px] text-[#667085]">{detail}</span>
    </div>
  );
}

function SelectField<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="grid min-w-[132px] gap-1.5">
      <span className="text-[13px] font-semibold text-[#475467]">{label}</span>
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

function MultiChoiceField<T extends number>({ label, values, options, onToggle, onClear }: {
  label: string;
  values: T[];
  options: Array<Option<T>>;
  onToggle: (value: T) => void;
  onClear: () => void;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-[13px] font-semibold text-[#475467]">{label}</span>
      <div className="flex flex-wrap gap-2">
        <button
          className={cn("h-8 rounded-md border px-2.5 text-[12px] font-semibold", values.length === 0 ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#526a91] hover:border-brand-fox")}
          type="button"
          onClick={onClear}
        >
          不限
        </button>
        {options.map((item) => {
          const active = values.includes(item.value);
          return (
            <button
              className={cn("h-8 rounded-md border px-2.5 text-[12px] font-semibold", active ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#526a91] hover:border-brand-fox")}
              key={String(item.value)}
              type="button"
              onClick={() => onToggle(item.value)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CheckOption({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] hover:border-brand-fox">
      <input className="size-4 accent-brand-fox" checked={checked} type="checkbox" onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function scoreClass(score: number) {
  if (score >= 80) return "bg-[#eafaf0] text-[#087443]";
  if (score >= 55) return "bg-[#fff7e8] text-[#b54708]";
  return "bg-[#f6f8fc] text-[#667085]";
}

function statusText(item: DoudianOpportunityPrematchCandidate) {
  if (item.status === "ready") return item.eligible ? "可提报" : "跳过";
  if (item.status === "submitted") return "已提报";
  if (item.status === "failed") return "失败";
  if (item.status === "skipped") return "跳过";
  return item.status || "--";
}

function CandidateDetailTable({
  items,
  selectedIds,
  loading,
  message,
  onToggle,
  onToggleAll
}: {
  items: DoudianOpportunityPrematchCandidate[];
  selectedIds: Set<string>;
  loading: "" | "stores" | "latest" | "products" | "clues" | "match" | "submit";
  message: string;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  const eligibleItems = items.filter((item) => item.eligible && item.status === "ready");
  const allChecked = eligibleItems.length > 0 && eligibleItems.every((item) => selectedIds.has(item.id));

  if (!items.length) {
    return (
      <div className="grid h-full min-h-[220px] place-items-center p-6 text-center">
        <div>
          <Target className="mx-auto size-9 text-[#98a2b3]" strokeWidth={1.8} />
          <strong className="mt-3 block text-[15px] text-[#101828]">{loading === "match" ? "正在生成" : "暂无预匹配候选"}</strong>
          <span className="mt-1 block text-[12px] text-[#667085]">{message}</span>
        </div>
      </div>
    );
  }

  return (
    <table className="min-w-[1180px] w-full border-separate border-spacing-0 text-left">
      <thead className="sticky top-0 z-10 bg-[#fbfcff] text-[12px] font-semibold text-[#667085]">
        <tr>
          <th className="w-10 border-b border-[#edf1f6] px-3 py-2.5">
            <input aria-label="选择全部候选" checked={allChecked} className="size-4 accent-brand-fox" type="checkbox" onChange={onToggleAll} />
          </th>
          <th className="w-[320px] border-b border-[#edf1f6] px-3 py-2.5">商品</th>
          <th className="w-[170px] border-b border-[#edf1f6] px-3 py-2.5">店铺</th>
          <th className="w-[220px] border-b border-[#edf1f6] px-3 py-2.5">匹配商机</th>
          <th className="w-[180px] border-b border-[#edf1f6] px-3 py-2.5">命中词</th>
          <th className="w-[90px] border-b border-[#edf1f6] px-3 py-2.5 text-right">匹配分</th>
          <th className="w-[90px] border-b border-[#edf1f6] px-3 py-2.5 text-right">预计消耗</th>
          <th className="w-[140px] border-b border-[#edf1f6] px-3 py-2.5">状态</th>
        </tr>
      </thead>
      <tbody className="text-[13px]">
        {items.map((item) => {
          const selectable = item.eligible && item.status === "ready";
          return (
            <tr className="group hover:bg-[#fffaf7]" key={item.id}>
              <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                <input aria-label={`选择${item.title}`} checked={selectedIds.has(item.id)} className="size-4 accent-brand-fox disabled:opacity-40" disabled={!selectable} type="checkbox" onChange={() => onToggle(item.id)} />
              </td>
              <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                <strong className="block truncate text-[#1d2939]" title={item.title}>{item.title}</strong>
                <span className="mt-1 block truncate text-[12px] text-[#667085]">ID {item.productId} · {item.productCategory || "--"}</span>
              </td>
              <td className="border-b border-[#edf1f6] px-3 py-3 align-top">{item.shopName}</td>
              <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                <strong className="block truncate text-[#344054]" title={item.clueName}>{item.clueName}</strong>
                <span className="mt-1 block truncate text-[12px] text-[#667085]" title={item.clueCategoryName}>{item.clueCategoryName || "--"}</span>
              </td>
              <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                <div className="flex flex-wrap gap-1">
                  {item.matchedWords.slice(0, 4).map((word) => <span className="rounded-md bg-[#eafaf0] px-1.5 py-0.5 text-[11px] font-semibold text-[#087443]" key={word}>{word}</span>)}
                  {!item.matchedWords.length ? <span className="text-[12px] text-[#98a2b3]">--</span> : null}
                </div>
              </td>
              <td className="border-b border-[#edf1f6] px-3 py-3 text-right align-top">
                <span className={cn("rounded-md px-2 py-1 text-[12px] font-bold", scoreClass(item.matchScore))}>{item.matchScore}</span>
              </td>
              <td className="border-b border-[#edf1f6] px-3 py-3 text-right align-top font-semibold text-[#101828]">{item.estimatedCost}</td>
              <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                <span className={cn("inline-flex rounded-md px-2 py-1 text-[12px] font-semibold", item.eligible && item.status === "ready" ? "bg-[#eafaf0] text-[#087443]" : item.status === "submitted" ? "bg-brand-foxSoft text-brand-fox" : "bg-[#fff7e8] text-[#b54708]")}>
                  {statusText(item)}
                </span>
                {item.skipReason ? <span className="mt-1 block truncate text-[12px] text-[#b54708]" title={item.skipReason}>{item.skipReason}</span> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function OpportunityProductPrematchPage() {
  const [stores, setStores] = useState<DoudianStoreSummary[]>([]);
  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(() => new Set());
  const [products, setProducts] = useState<DoudianOpportunityProductRow[]>([]);
  const [clues, setClues] = useState<DoudianOpportunityClueRow[]>([]);
  const [candidates, setCandidates] = useState<DoudianOpportunityPrematchCandidate[]>([]);
  const [executions, setExecutions] = useState<DoudianOpportunityExecution[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(() => new Set());
  const [productRunId, setProductRunId] = useState("");
  const [clueRunId, setClueRunId] = useState("");
  const [matchRunId, setMatchRunId] = useState("");
  const [activeRank, setActiveRank] = useState("11,MATCH_DEGREE");
  const [selectedReasonIds, setSelectedReasonIds] = useState<number[]>([]);
  const [selectedBenefitIds, setSelectedBenefitIds] = useState<number[]>([]);
  const [recentlyDayType, setRecentlyDayType] = useState(3);
  const [matchMode, setMatchMode] = useState<DoudianOpportunityPrematchMode>("precise");
  const [skipSubmittedClueCategory, setSkipSubmittedClueCategory] = useState(false);
  const [skipSubmittedClue, setSkipSubmittedClue] = useState(false);
  const [skipSubmittedProductInSameClue, setSkipSubmittedProductInSameClue] = useState(true);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("等待操作");
  const [loading, setLoading] = useState<"" | "stores" | "latest" | "products" | "clues" | "match" | "submit">("");
  const actionLockRef = useRef(false);

  const filters = useMemo<DoudianOpportunityFilters>(() => ({
    activeKey: activeRank,
    tagIdList: selectedReasonIds,
    profitIdList: selectedBenefitIds,
    recentlyDayType,
    cluePage: 2
  }), [activeRank, recentlyDayType, selectedBenefitIds, selectedReasonIds]);

  const visibleCandidates = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return candidates.filter((item) => {
      if (!keyword) return true;
      return [item.title, item.productId, item.shopName, item.clueName, item.clueCategoryName, ...(item.matchedWords || [])]
        .some((value) => String(value || "").toLocaleLowerCase().includes(keyword));
    });
  }, [candidates, query]);

  const eligibleCandidates = useMemo(() => candidates.filter((item) => item.eligible && item.status === "ready"), [candidates]);
  const selectedCandidates = useMemo(() => candidates.filter((item) => selectedCandidateIds.has(item.id)), [candidates, selectedCandidateIds]);
  const estimatedCost = selectedCandidates.reduce((sum, item) => sum + Number(item.estimatedCost || 0), 0);
  const busy = Boolean(loading);

  const productCountByShop = useMemo(() => {
    const next = new Map<string, number>();
    for (const item of products) next.set(item.shopId, (next.get(item.shopId) || 0) + 1);
    return next;
  }, [products]);

  const candidateCountByShop = useMemo(() => {
    const next = new Map<string, number>();
    for (const item of candidates) next.set(item.shopId, (next.get(item.shopId) || 0) + 1);
    return next;
  }, [candidates]);

  const logLines = useMemo(() => {
    const lines = [
      `${new Date().toLocaleString("zh-CN", { hour12: false })} --- ${message}`,
      productRunId ? `商品快照：${productRunId}` : "商品快照：未同步",
      clueRunId ? `商机快照：${clueRunId}` : "商机快照：未扫描",
      matchRunId ? `预匹配批次：${matchRunId}` : "预匹配批次：未生成"
    ];
    for (const item of executions.slice(0, 40)) {
      const name = item.title || item.clueName || item.productId || item.clueId || item.id;
      lines.push(`${item.ok ? "成功" : "失败"} | ${item.shopName || "--"} | ${name} | ${item.message}`);
    }
    return lines;
  }, [clueRunId, executions, matchRunId, message, productRunId]);

  useEffect(() => {
    void refreshStores();
    void restoreLatest();
  }, []);

  async function refreshStores() {
    setLoading((current) => current || "stores");
    try {
      const result = await listDoudianStores();
      const nextStores = result.stores || [];
      setStores(nextStores);
      setSelectedShopIds((current) => current.size ? current : new Set(nextStores.map((store) => store.shopId)));
    } finally {
      setLoading("");
    }
  }

  async function restoreLatest() {
    setLoading((current) => current || "latest");
    try {
      const result = await fetchDoudianOpportunityReportLatest({ filters });
      setProducts(result.products || []);
      setClues(result.clues || []);
      setCandidates(result.prematches || []);
      setExecutions(result.executions || []);
      setProductRunId(result.productRunId || "");
      setClueRunId(result.clueRunId || "");
      setMatchRunId(result.matchRunId || "");
      setMessage(result.message || "已恢复最近数据");
      const ready = (result.prematches || []).filter((item) => item.eligible && item.status === "ready").map((item) => item.id);
      setSelectedCandidateIds(new Set(ready));
    } finally {
      setLoading("");
    }
  }

  function selectAllStores() {
    setSelectedShopIds((current) => current.size === stores.length ? new Set() : new Set(stores.map((store) => store.shopId)));
  }

  function toggleStore(shopId: string) {
    setSelectedShopIds((current) => {
      const next = new Set(current);
      if (next.has(shopId)) next.delete(shopId);
      else next.add(shopId);
      return next;
    });
  }

  function toggleNumberSelection(value: number, setter: (updater: (current: number[]) => number[]) => void) {
    setter((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function toggleCandidate(id: string) {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisibleCandidates() {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      const eligibleVisible = visibleCandidates.filter((item) => item.eligible && item.status === "ready");
      const allSelected = eligibleVisible.length > 0 && eligibleVisible.every((item) => next.has(item.id));
      for (const item of eligibleVisible) {
        if (allSelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  }

  async function syncProducts() {
    if (actionLockRef.current) return;
    if (!selectedShopIds.size) {
      setMessage("请先选择店铺");
      return;
    }
    actionLockRef.current = true;
    setLoading("products");
    setMessage("正在同步商品");
    try {
      const result = await fetchDoudianOpportunityReport({
        mode: "product-scan",
        shopIds: Array.from(selectedShopIds),
        filters,
        operationId: `opportunity-prematch-product-scan-${Date.now()}`
      });
      setProducts(result.products || []);
      setProductRunId(result.runId || "");
      setMessage(result.message || "商品同步完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      actionLockRef.current = false;
      setLoading("");
    }
  }

  async function scanClues() {
    if (actionLockRef.current) return;
    if (!selectedShopIds.size) {
      setMessage("请先选择店铺");
      return;
    }
    actionLockRef.current = true;
    setLoading("clues");
    setMessage("正在扫描商机");
    try {
      const result = await fetchDoudianOpportunityReport({
        mode: "clue-scan",
        shopIds: Array.from(selectedShopIds),
        filters,
        operationId: `opportunity-prematch-clue-scan-${Date.now()}`
      });
      setClues(result.clues || result.rows || []);
      setClueRunId(result.runId || "");
      setMessage(result.message || "商机扫描完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      actionLockRef.current = false;
      setLoading("");
    }
  }

  async function generatePrematch() {
    if (actionLockRef.current) return;
    if (!productRunId || !clueRunId) {
      setMessage("请先同步商品并扫描商机");
      return;
    }
    actionLockRef.current = true;
    setLoading("match");
    setMessage("正在生成预匹配");
    try {
      const result = await fetchDoudianOpportunityReport({
        mode: "product-prematch",
        shopIds: Array.from(selectedShopIds),
        filters,
        productRunId,
        clueRunId,
        matchMode,
        skipSubmittedClueCategory,
        skipSubmittedClue,
        skipSubmittedProductInSameClue,
        operationId: `opportunity-product-prematch-${Date.now()}`
      });
      const next = result.prematches || [];
      setCandidates(next);
      setMatchRunId(result.matchRunId || result.runId || "");
      setSelectedCandidateIds(new Set(next.filter((item) => item.eligible && item.status === "ready").map((item) => item.id)));
      setMessage(result.message || "预匹配完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      actionLockRef.current = false;
      setLoading("");
    }
  }

  async function submitPrematch() {
    if (actionLockRef.current) return;
    if (!matchRunId) {
      setMessage("请先生成预匹配");
      return;
    }
    if (!selectedCandidates.length) {
      setMessage("请先选择可提报候选");
      return;
    }
    actionLockRef.current = true;
    setLoading("submit");
    setMessage("正在执行预匹配提报");
    try {
      const result = await fetchDoudianOpportunityReport({
        mode: "prematch-submit",
        matchRunId,
        sourceRunId: matchRunId,
        candidateIds: selectedCandidates.map((item) => item.id),
        submitMode: defaultSubmitMode,
        titleMatchMode: defaultTitleMatchMode,
        titleUpdatePosition: defaultTitleUpdatePosition,
        skipSubmittedClueCategory,
        skipSubmittedClue,
        skipSubmittedProductInSameClue,
        operationId: `opportunity-prematch-submit-${Date.now()}`
      });
      const updated = new Map((result.prematches || []).map((item) => [item.id, item]));
      setCandidates((current) => current.map((item) => updated.get(item.id) || item));
      setExecutions(result.executions || []);
      setSelectedCandidateIds(new Set());
      setMessage(result.message || "预匹配提报完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      actionLockRef.current = false;
      setLoading("");
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 text-[#101828]" data-business-slot="ready">
      <div className="grid grid-cols-4 gap-3 max-[1280px]:grid-cols-2 max-[720px]:grid-cols-1">
        <Metric label="同步商品数" value={formatNumber(products.length)} detail={`${selectedShopIds.size} 家店铺`} tone="blue" />
        <Metric label="扫描商机数" value={formatNumber(clues.length)} detail={activeRank.split(",")[1] || "MATCH"} />
        <Metric label="可提报候选数" value={formatNumber(eligibleCandidates.length)} detail={matchMode === "precise" ? "精准模式" : "宽松模式"} tone="green" />
        <Metric label="已选提报数" value={formatNumber(selectedCandidates.length)} detail={`预计 ${formatNumber(estimatedCost)} 次`} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pr-1 max-[760px]:overflow-visible max-[760px]:pr-0">
        <section className="grid gap-3 rounded-lg border border-brand-line bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex items-center justify-between gap-3 border-b border-[#edf1f6] pb-3 max-[900px]:items-start max-[900px]:flex-col">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="m-0 text-[16px] font-bold tracking-[0] text-brand-navy">提报工作台</h2>
                <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] transition-colors hover:border-brand-fox hover:text-brand-fox disabled:opacity-50" type="button" onClick={restoreLatest} disabled={busy}>
                  <RefreshCw className={cn("size-[14px]", loading === "latest" && "animate-spin")} strokeWidth={2} />
                  恢复上次结果
                </button>
              </div>
              <p className="m-0 mt-1 text-[12px] font-semibold text-[#667085]">按店铺范围同步商品和商机，生成候选后再提交。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                { label: "1 同步商品", active: Boolean(productRunId) },
                { label: "2 扫描商机", active: Boolean(clueRunId) },
                { label: "3 预匹配", active: Boolean(matchRunId) },
                { label: "4 执行提报", active: executions.length > 0 }
              ].map((item) => (
                <span className={cn("rounded-md border px-2.5 py-1 text-[12px] font-semibold", item.active ? "border-[#ffdcca] bg-brand-foxSoft text-brand-fox" : "border-[#e4e7ec] bg-[#f9fafb] text-[#667085]")} key={item.label}>{item.label}</span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-[320px_minmax(0,1fr)_320px] gap-3 max-[1260px]:grid-cols-[300px_minmax(0,1fr)] max-[940px]:flex max-[940px]:flex-col">
            <section className="flex h-[390px] min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-white">
              <div className="flex min-h-[44px] items-center justify-between border-b border-[#edf1f6] bg-[#fbfcff] px-3">
                <strong className="text-[14px] text-brand-navy">店铺范围</strong>
                <div className="flex items-center gap-2">
                  <button className="inline-flex h-7 items-center gap-1 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] transition-colors hover:border-brand-fox hover:text-brand-fox disabled:opacity-50" type="button" onClick={refreshStores} disabled={busy}>
                    <RefreshCw className={cn("size-[13px]", loading === "stores" && "animate-spin")} strokeWidth={2} />
                    刷新
                  </button>
                  <label className="flex items-center gap-2 text-[12px] font-semibold text-[#475467]">
                    <input aria-label="全选店铺" checked={stores.length > 0 && selectedShopIds.size === stores.length} className="size-4 accent-brand-fox" type="checkbox" onChange={selectAllStores} />
                    全选
                  </label>
                </div>
              </div>
              <div className="grid min-h-[38px] grid-cols-[44px_minmax(0,1fr)_96px] items-center border-b border-[#edf1f6] bg-[#fbfcff] text-[12px] font-semibold text-[#667085]">
                <span className="text-center">序号</span>
                <span className="px-3">店铺名称</span>
                <span className="text-center">状态</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {stores.map((store, index) => {
                  const productCount = productCountByShop.get(store.shopId) || 0;
                  const candidateCount = candidateCountByShop.get(store.shopId) || 0;
                  const status = candidateCount ? `${candidateCount}个` : productCount ? "已同步" : "待同步";
                  return (
                    <label className="grid min-h-[42px] cursor-pointer grid-cols-[44px_minmax(0,1fr)_96px] items-center border-b border-[#edf1f6] text-[13px] text-[#344054] hover:bg-[#fffaf7]" key={store.shopId}>
                      <span className="flex items-center justify-center gap-2">
                        <input checked={selectedShopIds.has(store.shopId)} className="size-4 accent-brand-fox" type="checkbox" onChange={() => toggleStore(store.shopId)} />
                      </span>
                      <span className="min-w-0 truncate px-3 font-semibold" title={store.shopName}>{index + 1}. {store.shopName}</span>
                      <span className="px-2 text-center">
                        <span className={cn("inline-flex rounded-md px-2 py-0.5 text-[12px] font-semibold", candidateCount ? "bg-brand-foxSoft text-brand-fox" : productCount ? "bg-[#eafaf0] text-[#087443]" : "bg-[#f2f4f7] text-[#667085]")}>{status}</span>
                      </span>
                    </label>
                  );
                })}
                {!stores.length ? <div className="p-4 text-[13px] text-[#667085]">暂无店铺台账</div> : null}
              </div>
            </section>

            <section className="grid min-h-0 gap-3 rounded-lg border border-brand-line bg-[#fbfcff] p-3">
              <div className="grid gap-3 rounded-md border border-[#edf1f6] bg-white p-3">
                <div className="flex items-center justify-between gap-3">
                  <strong className="text-[14px] text-brand-navy">1. 数据准备</strong>
                  <span className="rounded-md bg-[#f2f4f7] px-2 py-1 text-[12px] font-semibold text-[#667085]">官方接口</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[13px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.14)] transition-colors hover:bg-brand-foxHover disabled:opacity-50" type="button" onClick={syncProducts} disabled={busy || !selectedShopIds.size}>
                    {loading === "products" ? <Loader2 className="size-[15px] animate-spin" strokeWidth={2} /> : <PackageSearch className="size-[15px]" strokeWidth={2} />}
                    同步商品
                  </button>
                  <button className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-3 text-[13px] font-semibold text-[#344054] transition-colors hover:border-brand-fox hover:text-brand-fox disabled:opacity-50" type="button" onClick={scanClues} disabled={busy || !selectedShopIds.size}>
                    {loading === "clues" ? <Loader2 className="size-[15px] animate-spin" strokeWidth={2} /> : <Search className="size-[15px]" strokeWidth={2} />}
                    扫描商机
                  </button>
                  <span className={cn("rounded-md px-2.5 py-1 text-[12px] font-semibold", productRunId ? "bg-[#eafaf0] text-[#087443]" : "bg-[#fff7e8] text-[#b54708]")}>
                    商品：{productRunId ? "已同步" : "未同步"}
                  </span>
                  <span className={cn("rounded-md px-2.5 py-1 text-[12px] font-semibold", clueRunId ? "bg-[#eafaf0] text-[#087443]" : "bg-[#fff7e8] text-[#b54708]")}>
                    商机：{clueRunId ? "已扫描" : "未扫描"}
                  </span>
                </div>
              </div>

              <div className="grid gap-3 rounded-md border border-[#edf1f6] bg-white p-3">
                <strong className="text-[14px] text-brand-navy">2. 筛选规则</strong>
                <div className="grid grid-cols-[150px_150px] gap-3 max-[760px]:grid-cols-1">
                  <SelectField label="店铺类目" value="all" options={[{ value: "all", label: "全部-0" }]} onChange={() => undefined} />
                  <SelectField label="上新时间" value={recentlyDayType} options={recentlyOptions} onChange={setRecentlyDayType} />
                </div>
                <div className="grid gap-2">
                  <span className="text-[13px] font-semibold text-[#475467]">匹配模式</span>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { key: "precise" as const, label: "精准模式" },
                      { key: "loose" as const, label: "宽松模式" }
                    ].map((item) => (
                      <button className={cn("h-8 rounded-md border px-3 text-[13px] font-semibold", matchMode === item.key ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#344054] hover:border-brand-fox")} key={item.key} type="button" onClick={() => setMatchMode(item.key)}>
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-[#475467]">搜索词类型</span>
                    <span className="rounded-md bg-[#f2f4f7] px-2 py-0.5 text-[12px] font-semibold text-[#667085]">消费者热搜词</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {rankTabs.map((item) => (
                      <button className={cn("h-8 rounded-md border px-2.5 text-[12px] font-semibold transition-colors", activeRank === item.value ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#526a91] hover:border-brand-fox")} key={item.value} type="button" onClick={() => setActiveRank(item.value)}>
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
                <MultiChoiceField label="推荐理由" values={selectedReasonIds} options={reasonOptions} onToggle={(value) => toggleNumberSelection(value, setSelectedReasonIds)} onClear={() => setSelectedReasonIds([])} />
                <MultiChoiceField label="权益" values={selectedBenefitIds} options={benefitOptions} onToggle={(value) => toggleNumberSelection(value, setSelectedBenefitIds)} onClear={() => setSelectedBenefitIds([])} />
                <div className="rounded-md bg-[#f8fbff] px-3 py-2 text-[12px] font-semibold text-[#526a91]">
                  {matchMode === "precise" ? "精准模式：类目需完整命中，商机词命中比例更高，候选少但通过率更高。" : "宽松模式：允许类目前缀命中，命中 1 个商机词即可进入候选，适合先扩大商品池再人工挑选。"}
                </div>
              </div>

              <div className="grid gap-3 rounded-md border border-[#edf1f6] bg-white p-3">
                <div className="flex items-center justify-between gap-3 max-[760px]:items-start max-[760px]:flex-col">
                  <strong className="text-[14px] text-brand-navy">3. 生成与提报</strong>
                  <span className="text-[12px] font-semibold text-[#667085]">已选 {formatNumber(selectedCandidates.length)} 条，预计消耗 {formatNumber(estimatedCost)} 次</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <CheckOption checked={skipSubmittedClueCategory} label="跳过已报商机类目" onChange={setSkipSubmittedClueCategory} />
                  <CheckOption checked={skipSubmittedClue} label="跳过已报商机" onChange={setSkipSubmittedClue} />
                  <CheckOption checked={skipSubmittedProductInSameClue} label="跳过已报商品（同一商机）" onChange={setSkipSubmittedProductInSameClue} />
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-[#edf1f6] pt-3">
                  <button className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-brand-fox bg-white px-4 text-[14px] font-semibold text-brand-fox transition-colors hover:bg-brand-foxSoft disabled:opacity-50" type="button" onClick={generatePrematch} disabled={busy || !productRunId || !clueRunId}>
                    {loading === "match" ? <Loader2 className="size-[16px] animate-spin" strokeWidth={2} /> : <Shuffle className="size-[16px]" strokeWidth={2} />}
                    生成预匹配
                  </button>
                  <button className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-brand-fox px-4 text-[14px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] transition-colors hover:bg-brand-foxHover disabled:opacity-50" type="button" onClick={submitPrematch} disabled={busy || !selectedCandidates.length}>
                    {loading === "submit" ? <Loader2 className="size-[16px] animate-spin" strokeWidth={2} /> : <Send className="size-[16px]" strokeWidth={2} />}
                    {loading === "submit" ? "正在提报" : "执行提报"}
                  </button>
                  <span className="text-[12px] font-semibold text-[#667085]">提报固定采用校验商机词策略，不修改商品标题。</span>
                </div>
              </div>
            </section>

            <section className="flex h-[390px] min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-white max-[1260px]:col-span-2 max-[940px]:col-span-1">
              <div className="flex min-h-[44px] items-center justify-between border-b border-[#edf1f6] bg-[#fbfcff] px-3">
                <strong className="text-[14px] text-brand-navy">运行日志</strong>
                <span className={cn("rounded-md px-2 py-1 text-[12px] font-semibold", busy ? "bg-[#fff7e8] text-[#b54708]" : "bg-[#f2f4f7] text-[#667085]")}>{message}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-[#fcfdff] p-3 font-mono text-[12px] leading-5 text-brand-navy">
                {busy ? (
                  <div className="mb-2 flex items-center gap-2 text-[#b54708]">
                    <Loader2 className="size-[15px] animate-spin" strokeWidth={2} />
                    <span>{message}</span>
                  </div>
                ) : null}
                {logLines.map((line, index) => <div className="whitespace-pre-wrap break-words" key={`${line}-${index}`}>{line}</div>)}
              </div>
            </section>
          </div>
        </section>

        <section className="flex min-h-[320px] flex-col overflow-hidden rounded-lg border border-brand-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex min-h-[48px] items-center justify-between gap-3 border-b border-[#edf1f6] px-4">
            <div className="flex min-w-0 items-center gap-2">
              <Play className="size-[16px] shrink-0 text-brand-fox" strokeWidth={2} />
              <strong className="text-[15px] text-brand-navy">预匹配候选明细</strong>
              <span className="truncate text-[12px] font-semibold text-[#667085]">已筛出 {formatNumber(visibleCandidates.length)} 条，已选 {formatNumber(selectedCandidates.length)} 条</span>
            </div>
            <div className="flex h-9 w-[300px] max-w-[40vw] items-center gap-2 rounded-md border border-[#dbe5f2] bg-white px-2.5 focus-within:border-brand-fox max-[760px]:hidden">
              <Search className="size-[15px] shrink-0 text-[#98a2b3]" strokeWidth={2} />
              <input className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[#1d2939] outline-none placeholder:text-[#98a2b3]" placeholder="商品、商机、命中词、店铺" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <CandidateDetailTable
              items={visibleCandidates}
              selectedIds={selectedCandidateIds}
              loading={loading}
              message={message}
              onToggle={toggleCandidate}
              onToggleAll={toggleAllVisibleCandidates}
            />
          </div>
        </section>
      </div>
    </section>
  );
}
