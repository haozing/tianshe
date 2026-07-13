import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Send
} from "lucide-react";
import { fetchDoudianOpportunityReport, fetchDoudianOpportunityReportLatest, listDoudianOpportunityStoreCategories, listDoudianStores } from "../bridge/client";
import { cn } from "../lib/utils";
import type {
  DoudianOpportunityClueRow,
  DoudianOpportunityExecution,
  DoudianOpportunityFilters,
  DoudianOpportunityMatchRules,
  DoudianOpportunityPrematchCandidate,
  DoudianOpportunityProductRow,
  DoudianOpportunityStoreCategoryLedger,
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

const autoSubmitPageSize = 100;

function formatNumber(value: number | undefined) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function CompactMetric({ label, value, detail, tone = "default" }: { label: string; value: string; detail: string; tone?: "default" | "blue" | "green" | "warn" }) {
  const toneClass = {
    default: "text-[#111827]",
    blue: "text-brand-navy",
    green: "text-[#087443]",
    warn: "text-[#b54708]"
  }[tone];
  return (
    <div className="min-w-[112px] rounded-md border border-[#edf1f6] bg-[#fbfcff] px-3 py-2">
      <span className="block truncate text-[11px] font-semibold text-brand-muted">{label}</span>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <strong className={cn("block truncate text-[18px] font-bold leading-6 tracking-[0]", toneClass)}>{value}</strong>
        <span className="min-w-0 truncate text-[11px] font-semibold text-[#667085]">{detail}</span>
      </div>
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

function uniqueText(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function submitStatusInfo(item: DoudianOpportunityPrematchCandidate) {
  const status = String(item.submitStatus || item.status || "");
  if (item.submittedAt || status === "submitted") return { label: "已提报", className: "bg-[#eafaf0] text-[#087443]" };
  if (status === "failed") return { label: "失败", className: "bg-[#fff1ef] text-[#b42318]" };
  if (status === "skipped") return { label: "跳过", className: "bg-[#fff7e8] text-[#b54708]" };
  if (item.eligible && status === "ready") return { label: "待提报", className: "bg-brand-foxSoft text-brand-fox" };
  return { label: status || "--", className: "bg-[#f2f4f7] text-[#667085]" };
}

export function OpportunityProductPrematchPage() {
  const [stores, setStores] = useState<DoudianStoreSummary[]>([]);
  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(() => new Set());
  const [storeCategories, setStoreCategories] = useState<DoudianOpportunityStoreCategoryLedger[]>([]);
  const [selectedStoreCategoryKeys, setSelectedStoreCategoryKeys] = useState<string[]>([]);
  const [products, setProducts] = useState<DoudianOpportunityProductRow[]>([]);
  const [clues, setClues] = useState<DoudianOpportunityClueRow[]>([]);
  const [candidates, setCandidates] = useState<DoudianOpportunityPrematchCandidate[]>([]);
  const [executions, setExecutions] = useState<DoudianOpportunityExecution[]>([]);
  const [resultSummary, setResultSummary] = useState<Record<string, number>>({});
  const [productRunId, setProductRunId] = useState("");
  const [clueRunId, setClueRunId] = useState("");
  const [matchRunId, setMatchRunId] = useState("");
  const [activeRank, setActiveRank] = useState("11,MATCH_DEGREE");
  const [selectedReasonIds, setSelectedReasonIds] = useState<number[]>([]);
  const [selectedBenefitIds, setSelectedBenefitIds] = useState<number[]>([]);
  const [recentlyDayType, setRecentlyDayType] = useState(3);
  const [minTokenHitRatio, setMinTokenHitRatio] = useState(0.33);
  const [skipSubmittedClueCategory, setSkipSubmittedClueCategory] = useState(false);
  const [skipSubmittedClue, setSkipSubmittedClue] = useState(false);
  const [skipSubmittedProductInSameClue, setSkipSubmittedProductInSameClue] = useState(true);
  const [message, setMessage] = useState("等待操作");
  const [loading, setLoading] = useState<"" | "stores" | "latest" | "products" | "clues" | "match" | "submit" | "pipeline">("");
  const [pipelineInFlight, setPipelineInFlight] = useState(false);
  const [activeTab, setActiveTab] = useState<"submit" | "autoSubmit">("submit");
  const [autoSubmitPage, setAutoSubmitPage] = useState(0);
  const actionLockRef = useRef(false);

  const filters = useMemo<DoudianOpportunityFilters>(() => ({
    activeKey: activeRank,
    tagIdList: selectedReasonIds,
    profitIdList: selectedBenefitIds,
    recentlyDayType,
    cluePage: 2
  }), [activeRank, recentlyDayType, selectedBenefitIds, selectedReasonIds]);

  const matchRules = useMemo<DoudianOpportunityMatchRules>(() => ({
    minTokenHitRatio,
    storeCategoryKeys: selectedStoreCategoryKeys
  }), [minTokenHitRatio, selectedStoreCategoryKeys]);

  const candidateSummary = useMemo(() => {
    let eligibleCount = 0;
    let submittedCount = 0;
    let estimatedCost = 0;
    for (const item of candidates) {
      if (item.eligible && item.status === "ready") eligibleCount += 1;
      if (item.submittedAt || item.status === "submitted" || item.submitStatus === "submitted") {
        submittedCount += 1;
        estimatedCost += Number(item.estimatedCost || 0);
      }
    }
    const summaryNumber = (key: string, fallback: number) => {
      const value = Number(resultSummary[key]);
      return Number.isFinite(value) ? value : fallback;
    };
    const totalCount = summaryNumber("candidateTotalCount", summaryNumber("candidateCount", candidates.length));
    const loadedCount = summaryNumber("candidateLoadedCount", candidates.length);
    const listTruncated = summaryNumber("candidateListTruncated", 0) > 0 || totalCount > loadedCount;
    return {
      eligibleCount: summaryNumber("eligibleCandidateCount", eligibleCount),
      submittedCount: summaryNumber("submittedCount", submittedCount),
      estimatedCost,
      totalCount,
      loadedCount,
      listTruncated
    };
  }, [candidates, resultSummary]);
  const autoSubmitPageCount = Math.max(1, Math.ceil(candidates.length / autoSubmitPageSize));
  const safeAutoSubmitPage = Math.min(autoSubmitPage, autoSubmitPageCount - 1);
  const autoSubmitPageStart = safeAutoSubmitPage * autoSubmitPageSize;
  const autoSubmitItems = useMemo(
    () => candidates.slice(autoSubmitPageStart, autoSubmitPageStart + autoSubmitPageSize),
    [autoSubmitPageStart, candidates]
  );
  const autoSubmitPageFrom = candidates.length ? autoSubmitPageStart + 1 : 0;
  const autoSubmitPageTo = Math.min(candidates.length, autoSubmitPageStart + autoSubmitItems.length);
  const busy = Boolean(loading);
  const pipelineBusy = pipelineInFlight || loading === "pipeline";

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

  const categoryOptions = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; productCount: number; shopCount: number; lastSeenAt: string }>();
    for (const item of storeCategories) {
      const current = byKey.get(item.categoryKey) || {
        key: item.categoryKey,
        label: item.categoryPath?.length ? item.categoryPath.join(">") : item.categoryName || item.categoryKey,
        productCount: 0,
        shopCount: 0,
        lastSeenAt: ""
      };
      current.productCount += Number(item.productCount || 0);
      current.shopCount += 1;
      if (String(item.lastSeenAt || "") > current.lastSeenAt) current.lastSeenAt = item.lastSeenAt;
      byKey.set(item.categoryKey, current);
    }
    return Array.from(byKey.values())
      .sort((left, right) => right.productCount - left.productCount)
      .slice(0, 40);
  }, [storeCategories]);

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

  useEffect(() => {
    void refreshStoreCategories();
  }, [selectedShopIds]);

  useEffect(() => {
    setAutoSubmitPage(0);
  }, [candidates.length]);

  useEffect(() => {
    setAutoSubmitPage((current) => Math.min(current, autoSubmitPageCount - 1));
  }, [autoSubmitPageCount]);

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

  async function refreshStoreCategories() {
    const shopIds = Array.from(selectedShopIds);
    const rows = await listDoudianOpportunityStoreCategories({ shopIds }).catch(() => []);
    setStoreCategories(rows);
    setSelectedStoreCategoryKeys((current) => current.filter((key) => rows.some((row) => row.categoryKey === key)));
  }

  async function restoreLatest() {
    setLoading((current) => current || "latest");
    try {
      const result = await fetchDoudianOpportunityReportLatest({ filters, matchRules });
      setProducts(result.products || []);
      setClues(result.clues || []);
      setCandidates(result.prematches || []);
      setExecutions(result.executions || []);
      setResultSummary(result.summary || {});
      setProductRunId(result.productRunId || "");
      setClueRunId(result.clueRunId || "");
      setMatchRunId(result.matchRunId || "");
      setMessage(result.message || "已恢复最近数据");
      await refreshStoreCategories();
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

  function toggleStoreCategory(key: string) {
    setSelectedStoreCategoryKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  function runPipelineSubmit() {
    if (actionLockRef.current) return;
    if (!selectedShopIds.size) {
      setMessage("请先选择店铺");
      return;
    }
    actionLockRef.current = true;
    setPipelineInFlight(true);
    const operationId = `opportunity-pipeline-submit-${Date.now()}`;
    setMatchRunId(operationId);
    setMessage("商机提报已启动，后台正在生成候选");
    const promise = fetchDoudianOpportunityReport({
      mode: "pipeline-submit",
      shopIds: Array.from(selectedShopIds),
      filters,
      matchRules,
      skipSubmittedClueCategory,
      skipSubmittedClue,
      skipSubmittedProductInSameClue,
      operationId
    });
    promise.then((result) => {
      setProducts(result.products || []);
      setClues(result.clues || result.rows || []);
      setCandidates(result.prematches || []);
      setExecutions(result.executions || []);
      setResultSummary(result.summary || {});
      setProductRunId("");
      setClueRunId("");
      setMatchRunId(result.runId || "");
      setMessage(result.message || "商机提报已启动");
    }).catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      actionLockRef.current = false;
      setPipelineInFlight(false);
    });
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden text-[#101828]" data-business-slot="ready">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-brand-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#edf1f6] p-3 max-[1180px]:flex-col max-[1180px]:items-start">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-[#dbe5f2] bg-[#f8fbff] p-1">
              {[
                { key: "submit" as const, label: "填报页面" },
                { key: "autoSubmit" as const, label: "自动提报列表" }
              ].map((item) => (
                <button
                  aria-pressed={activeTab === item.key}
                  className={cn("h-8 rounded px-3 text-[13px] font-semibold transition-colors", activeTab === item.key ? "bg-white text-brand-fox shadow-[0_1px_3px_rgba(15,23,42,0.08)]" : "text-[#526a91] hover:text-brand-fox")}
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] transition-colors hover:border-brand-fox hover:text-brand-fox disabled:opacity-50" type="button" onClick={restoreLatest} disabled={busy}>
              <RefreshCw className={cn("size-[14px]", loading === "latest" && "animate-spin")} strokeWidth={2} />
              恢复上次结果
            </button>
          </div>
          <div className="grid shrink-0 grid-cols-4 gap-2 max-[980px]:grid-cols-2 max-[560px]:grid-cols-1">
            <CompactMetric label="同步商品数" value={formatNumber(products.length)} detail={`${selectedShopIds.size} 家店铺`} tone="blue" />
            <CompactMetric label="扫描商机数" value={formatNumber(clues.length)} detail={activeRank.split(",")[1] || "MATCH"} />
            <CompactMetric
              label="可提报候选数"
              value={formatNumber(candidateSummary.eligibleCount)}
              detail={candidateSummary.listTruncated ? `已载 ${formatNumber(candidateSummary.loadedCount)}` : `有效词 ${Math.round(minTokenHitRatio * 100)}%`}
              tone="green"
            />
            <CompactMetric label="已提报商品数" value={formatNumber(candidateSummary.submittedCount)} detail={`预计 ${formatNumber(candidateSummary.estimatedCost)} 次`} />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-3">
          {activeTab === "submit" ? (
            <div className="grid h-full min-h-0 grid-cols-[320px_minmax(0,1fr)_320px] gap-3 max-[1120px]:grid-cols-1">
              <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-white">
                <div className="flex min-h-[44px] shrink-0 items-center justify-between border-b border-[#edf1f6] bg-[#fbfcff] px-3">
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
                <div className="grid min-h-[38px] shrink-0 grid-cols-[44px_minmax(0,1fr)_96px] items-center border-b border-[#edf1f6] bg-[#fbfcff] text-[12px] font-semibold text-[#667085]">
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

              <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-[#fbfcff]">
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <div className="grid gap-3">
                    <div className="grid gap-3 rounded-md border border-[#ffdcca] bg-[#fffaf7] p-3">
                      <div className="flex items-center justify-end">
                        <button className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-brand-fox px-4 text-[14px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] transition-colors hover:bg-brand-foxHover disabled:opacity-50" type="button" onClick={runPipelineSubmit} disabled={busy || pipelineBusy || !selectedShopIds.size}>
                          {pipelineBusy ? <Loader2 className="size-[16px] animate-spin" strokeWidth={2} /> : <Send className="size-[16px]" strokeWidth={2} />}
                          {pipelineBusy ? "后台运行" : "一键提报"}
                        </button>
                      </div>
                    </div>

                    <div className="grid gap-3 rounded-md border border-[#edf1f6] bg-white p-3">
                      <strong className="text-[14px] text-brand-navy">配置</strong>
                      <div className="grid grid-cols-[150px_minmax(220px,1fr)] gap-3 max-[760px]:grid-cols-1">
                        <SelectField label="上新时间" value={recentlyDayType} options={recentlyOptions} onChange={setRecentlyDayType} />
                        <label className="grid min-w-[220px] gap-2">
                          <div className="flex items-center justify-between gap-3 text-[13px] font-semibold text-[#475467]">
                            <span>有效词命中比例</span>
                            <span className="rounded-md bg-brand-foxSoft px-2 py-1 text-brand-fox">{Math.round(minTokenHitRatio * 100)}%</span>
                          </div>
                          <input
                            className="w-full accent-brand-fox"
                            max={100}
                            min={10}
                            step={1}
                            type="range"
                            value={Math.round(minTokenHitRatio * 100)}
                            onChange={(event) => setMinTokenHitRatio(Number(event.target.value) / 100)}
                          />
                        </label>
                      </div>
                      <div className="grid gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[13px] font-semibold text-[#475467]">店铺类目</span>
                          <div className="flex items-center gap-2">
                            <button className="inline-flex h-8 items-center gap-1 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#526a91] transition-colors hover:border-brand-fox hover:text-brand-fox disabled:opacity-50" type="button" onClick={refreshStoreCategories} disabled={busy}>
                              <RefreshCw className="size-[13px]" strokeWidth={2} />
                              刷新
                            </button>
                            <button className={cn("h-8 rounded-md border px-2.5 text-[12px] font-semibold", selectedStoreCategoryKeys.length === 0 ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#526a91] hover:border-brand-fox")} type="button" onClick={() => setSelectedStoreCategoryKeys([])}>
                              全部
                            </button>
                          </div>
                        </div>
                        <div className="flex max-h-[128px] flex-wrap gap-2 overflow-auto rounded-md border border-[#edf1f6] bg-[#fbfcff] p-2">
                          {categoryOptions.map((item) => {
                            const active = selectedStoreCategoryKeys.includes(item.key);
                            return (
                              <button className={cn("h-8 max-w-full truncate rounded-md border px-2.5 text-[12px] font-semibold", active ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#526a91] hover:border-brand-fox")} key={item.key} title={item.label} type="button" onClick={() => toggleStoreCategory(item.key)}>
                                {item.label}
                              </button>
                            );
                          })}
                          {!categoryOptions.length ? <span className="px-1 py-1 text-[12px] font-semibold text-[#98a2b3]">暂无店铺类目台账，运行一次一键提报后会自动沉淀</span> : null}
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
                      <div className="flex flex-wrap gap-2">
                        <CheckOption checked={skipSubmittedClueCategory} label="跳过已报商机类目" onChange={setSkipSubmittedClueCategory} />
                        <CheckOption checked={skipSubmittedClue} label="跳过已报商机" onChange={setSkipSubmittedClue} />
                        <CheckOption checked={skipSubmittedProductInSameClue} label="跳过已报商品（同一商机）" onChange={setSkipSubmittedProductInSameClue} />
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-white">
                <div className="flex min-h-[44px] shrink-0 items-center justify-between border-b border-[#edf1f6] bg-[#fbfcff] px-3">
                  <strong className="text-[14px] text-brand-navy">运行日志</strong>
                  <span className={cn("max-w-[190px] truncate rounded-md px-2 py-1 text-[12px] font-semibold", busy ? "bg-[#fff7e8] text-[#b54708]" : "bg-[#f2f4f7] text-[#667085]")}>{message}</span>
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
          ) : (
            <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-white">
              <div className="flex min-h-[48px] shrink-0 items-center justify-between gap-3 border-b border-[#edf1f6] px-4 max-[760px]:flex-col max-[760px]:items-start max-[760px]:py-2">
                <div className="min-w-0">
                  <strong className="block text-[15px] text-brand-navy">自动提报商品与商机词</strong>
                  <span className="mt-1 block truncate text-[12px] font-semibold text-[#667085]">
                    共 {formatNumber(candidateSummary.totalCount)} 条{candidateSummary.listTruncated ? `，已加载 ${formatNumber(candidateSummary.loadedCount)} 条` : ""}，当前 {formatNumber(autoSubmitPageFrom)}-{formatNumber(autoSubmitPageTo)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 max-[760px]:w-full max-[760px]:justify-start">
                  <div className="flex h-9 items-center overflow-hidden rounded-md border border-[#dbe5f2] bg-white">
                    <button
                      aria-label="上一页自动提报商品"
                      className="grid size-9 place-items-center text-[#344054] transition-colors hover:bg-[#f8fbff] disabled:text-[#c7d2e2]"
                      type="button"
                      onClick={() => setAutoSubmitPage((current) => Math.max(0, current - 1))}
                      disabled={safeAutoSubmitPage <= 0}
                    >
                      <ChevronLeft className="size-[16px]" strokeWidth={2} />
                    </button>
                    <span className="min-w-[70px] border-x border-[#dbe5f2] px-2 text-center text-[12px] font-semibold text-[#667085]">
                      {formatNumber(safeAutoSubmitPage + 1)} / {formatNumber(autoSubmitPageCount)}
                    </span>
                    <button
                      aria-label="下一页自动提报商品"
                      className="grid size-9 place-items-center text-[#344054] transition-colors hover:bg-[#f8fbff] disabled:text-[#c7d2e2]"
                      type="button"
                      onClick={() => setAutoSubmitPage((current) => Math.min(autoSubmitPageCount - 1, current + 1))}
                      disabled={safeAutoSubmitPage >= autoSubmitPageCount - 1}
                    >
                      <ChevronRight className="size-[16px]" strokeWidth={2} />
                    </button>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {autoSubmitItems.length ? (
                  <table className="min-w-[1040px] w-full border-separate border-spacing-0 text-left">
                    <thead className="sticky top-0 z-10 bg-[#fbfcff] text-[12px] font-semibold text-[#667085]">
                      <tr>
                        <th className="w-[320px] border-b border-[#edf1f6] px-3 py-2.5">商品</th>
                        <th className="w-[170px] border-b border-[#edf1f6] px-3 py-2.5">店铺</th>
                        <th className="w-[240px] border-b border-[#edf1f6] px-3 py-2.5">匹配商机</th>
                        <th className="border-b border-[#edf1f6] px-3 py-2.5">商机词 / 命中词</th>
                        <th className="w-[130px] border-b border-[#edf1f6] px-3 py-2.5">状态</th>
                      </tr>
                    </thead>
                    <tbody className="text-[13px]">
                      {autoSubmitItems.map((item) => {
                        const status = submitStatusInfo(item);
                        const clueWords = uniqueText([...(item.clueWords || []), ...(item.matchedWords || [])]).slice(0, 8);
                        return (
                          <tr className="hover:bg-[#fffaf7]" key={item.id}>
                            <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                              <strong className="block truncate text-[#1d2939]" title={item.title}>{item.title}</strong>
                              <span className="mt-1 block truncate text-[12px] text-[#667085]">ID {item.productId} · {item.productCategory || "--"}</span>
                            </td>
                            <td className="border-b border-[#edf1f6] px-3 py-3 align-top text-[#344054]">{item.shopName || "--"}</td>
                            <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                              <strong className="block truncate text-[#344054]" title={item.clueName}>{item.clueName || "--"}</strong>
                              <span className="mt-1 block truncate text-[12px] text-[#667085]" title={item.clueCategoryName}>{item.clueCategoryName || "--"}</span>
                            </td>
                            <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                              <div className="flex flex-wrap gap-1">
                                {clueWords.map((word) => <span className="rounded-md bg-[#eafaf0] px-1.5 py-0.5 text-[11px] font-semibold text-[#087443]" key={`${item.id}-${word}`}>{word}</span>)}
                                {!clueWords.length ? <span className="text-[12px] text-[#98a2b3]">--</span> : null}
                              </div>
                            </td>
                            <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                              <span className={cn("inline-flex rounded-md px-2 py-1 text-[12px] font-semibold", status.className)}>{status.label}</span>
                              {item.skipReason ? <span className="mt-1 block truncate text-[12px] text-[#b54708]" title={item.skipReason}>{item.skipReason}</span> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="grid h-full min-h-[260px] place-items-center p-6 text-center">
                    <div>
                      <strong className="block text-[15px] text-[#101828]">暂无自动提报商品</strong>
                      <span className="mt-1 block text-[12px] text-[#667085]">运行一键提报后会在这里展示商品和商机词。</span>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </section>
    </section>
  );
}
