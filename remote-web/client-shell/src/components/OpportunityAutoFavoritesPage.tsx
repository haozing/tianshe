import {
  AlertCircle,
  BookmarkPlus,
  Check,
  CheckCircle2,
  CircleStop,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Store
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  cancelDoudianStoreOperation,
  fetchDoudianFavoriteCategories,
  listDoudianStores,
  runDoudianOpportunityAutoFavorites
} from "../bridge/client";
import { addDoudianProgressListener } from "../domain/doudian/progress";
import { reconcileSelectedShopIds, storeIdentityRef } from "../domain/doudian/opportunityStoreState";
import { toggleStoreIds } from "../domain/doudian/storeSelection";
import { cn } from "../lib/utils";
import type {
  DoudianOpportunityAutoFavoriteRow,
  DoudianOpportunityFavoriteCategory,
  DoudianOpportunityFavoriteQueryMode,
  DoudianStoreStatus,
  DoudianStoreSummary
} from "../types";
import { GroupedStoreSelectionList, type GroupedSelectableStore } from "./GroupedStoreSelectionList";

const queryModes: DoudianOpportunityFavoriteQueryMode[] = [
  { id: "trading-high", label: "成交高", sortField: "TRADING_AMOUNT" },
  { id: "growth-fast", label: "增速快", sortField: "PAY_AMOUNT_RATE" },
  { id: "competition-low", label: "竞争小", sortField: "ONLINE_PRODUCT_NUMSO" }
];

function hasNativeStoreBridge() {
  return Boolean(window.chihuNative && (window.nativeData || window.chihuNative.nativeData));
}

function normalizeStatus(status: unknown): DoudianStoreStatus {
  return status === "online" || status === "offline" || status === "check_failed" || status === "unknown" ? status : "unknown";
}

function toStoreOption(store: DoudianStoreSummary): GroupedSelectableStore {
  return {
    id: String(store.shopId || ""),
    name: store.shopName || `抖店 ${store.shopId || ""}`,
    group: store.groupName || "未分组",
    status: normalizeStatus(store.status)
  };
}

function SelectionBox({ checked, mixed = false }: { checked: boolean; mixed?: boolean }) {
  return (
    <span className={cn(
      "grid size-4 shrink-0 place-items-center rounded border",
      checked || mixed ? "border-brand-fox bg-brand-fox text-white" : "border-[#cfd8e6] bg-white text-transparent"
    )}>
      {mixed ? <span className="h-0.5 w-2 rounded bg-current" /> : <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

function statusLabel(status: string) {
  if (status === "collected") return "已收藏";
  if (status === "skipped") return "已跳过";
  if (status === "quota_exhausted") return "达到上限";
  if (status === "cancelled") return "已取消";
  return "失败";
}

function statusClass(status: string) {
  if (status === "collected") return "bg-[#eafaf0] text-[#087443]";
  if (status === "skipped") return "bg-[#f2f4f7] text-[#667085]";
  if (status === "quota_exhausted") return "bg-[#fff7e8] text-[#b54708]";
  return "bg-[#fff1ef] text-[#b42318]";
}

export function OpportunityAutoFavoritesPage() {
  const nativeBridge = hasNativeStoreBridge();
  const [stores, setStores] = useState<DoudianStoreSummary[]>([]);
  const [selectedStoreIds, setSelectedStoreIds] = useState<Set<string>>(() => new Set());
  const [storeQuery, setStoreQuery] = useState("");
  const [categories, setCategories] = useState<DoudianOpportunityFavoriteCategory[]>([]);
  const [selectedCategoryKeys, setSelectedCategoryKeys] = useState<Set<string>>(() => new Set());
  const [categoryQuery, setCategoryQuery] = useState("");
  const [selectedModeIds, setSelectedModeIds] = useState<Set<string>>(() => new Set(queryModes.map((item) => item.id)));
  const [perStoreLimit, setPerStoreLimit] = useState(100);
  const [loadingStores, setLoadingStores] = useState(true);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [message, setMessage] = useState("");
  const [rows, setRows] = useState<DoudianOpportunityAutoFavoriteRow[]>([]);

  const storeOptions = useMemo(() => stores.map(toStoreOption).filter((store) => store.id), [stores]);
  const filteredStores = useMemo(() => {
    const keyword = storeQuery.trim().toLocaleLowerCase();
    return keyword ? storeOptions.filter((store) => store.name.toLocaleLowerCase().includes(keyword) || store.id.includes(keyword)) : storeOptions;
  }, [storeOptions, storeQuery]);
  const selectedStores = useMemo(() => stores.filter((store) => selectedStoreIds.has(store.shopId)), [selectedStoreIds, stores]);
  const allVisibleStoresSelected = filteredStores.length > 0 && filteredStores.every((store) => selectedStoreIds.has(store.id));
  const someVisibleStoresSelected = !allVisibleStoresSelected && filteredStores.some((store) => selectedStoreIds.has(store.id));

  const categoryOptions = useMemo(() => {
    const keyword = categoryQuery.trim().toLocaleLowerCase();
    const deduped = new Map<string, DoudianOpportunityFavoriteCategory>();
    for (const category of categories) deduped.set(`${category.key}:${category.id}`, category);
    return Array.from(deduped.values())
      .filter((category) => !keyword || [...(category.path || []), category.name, String(category.id)].some((item) => item.toLocaleLowerCase().includes(keyword)))
      .sort((left, right) => (left.path || [left.name]).join(">").localeCompare((right.path || [right.name]).join(">"), "zh-CN"));
  }, [categories, categoryQuery]);
  const selectedCategories = useMemo(() => categories.filter((category) => selectedCategoryKeys.has(`${category.key}:${category.id}`)), [categories, selectedCategoryKeys]);
  const selectedModes = useMemo(() => queryModes.filter((item) => selectedModeIds.has(item.id)), [selectedModeIds]);
  const processedRows = useMemo(() => rows.slice(-200).reverse(), [rows]);
  const collectedCount = rows.filter((row) => row.status === "collected").length;
  const skippedCount = rows.filter((row) => row.status === "skipped").length;
  const failureCount = rows.filter((row) => row.status === "failed").length;
  const quotaCount = rows.filter((row) => row.status === "quota_exhausted").length;

  async function refreshStores() {
    if (!nativeBridge) {
      setMessage("本地店铺桥接不可用，请在赤狐客户端内打开");
      setLoadingStores(false);
      return;
    }
    setLoadingStores(true);
    try {
      const result = await listDoudianStores();
      const nextStores = (result.stores || []).filter((store) => store.shopId);
      setStores(nextStores);
      setSelectedStoreIds((current) => reconcileSelectedShopIds(nextStores, current));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingStores(false);
    }
  }

  async function refreshCategories() {
    if (!selectedStoreIds.size || loadingCategories) return;
    setLoadingCategories(true);
      setMessage("");
    try {
      const result = await fetchDoudianFavoriteCategories({ shopIds: Array.from(selectedStoreIds), storeRefs: selectedStores.map(storeIdentityRef), forceAdapter: true });
      if (!result.ok) throw new Error(result.message || "类目读取失败");
      setCategories(result.categories || []);
      setSelectedCategoryKeys((current) => new Set(Array.from(current).filter((key) => (result.categories || []).some((category) => `${category.key}:${category.id}` === key))));
      setMessage(result.message || "类目读取完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingCategories(false);
    }
  }

  useEffect(() => {
    void refreshStores();
  }, []);

  useEffect(() => addDoudianProgressListener((event) => {
    const detail = event.detail;
    if (detail.taskType !== "opportunityAutoFavorites") return;
    if (activeOperationId && detail.operationId !== activeOperationId) return;
    setProgress(Math.max(0, Math.min(100, Math.round(Number(detail.progress || 0)))));
    setProgressMessage(detail.message || detail.resultSummary || detail.error || "");
    if (detail.status === "running") setActiveOperationId(detail.operationId);
  }), [activeOperationId]);

  function toggleStores(ids: string[]) {
    if (running) return;
    setSelectedStoreIds((current) => toggleStoreIds(current, ids));
  }

  function toggleCategory(category: DoudianOpportunityFavoriteCategory) {
    const key = `${category.key}:${category.id}`;
    setSelectedCategoryKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else if (next.size < 20) next.add(key);
      return next;
    });
  }

  function toggleMode(id: string) {
    setSelectedModeIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runAutoFavorite() {
    if (!selectedStoreIds.size) return setMessage("请先选择店铺");
    if (!selectedCategories.length) return setMessage("请至少选择一个类目");
    if (!selectedModes.length) return setMessage("请至少选择一个收藏条件");
    const operationId = `opportunity-auto-favorites-${Date.now()}`;
      const maxPagesPerQuery = Math.max(1, Math.min(60, Math.ceil(perStoreLimit / 18)));
    setRunning(true);
    setActiveOperationId(operationId);
    setProgress(0);
    setProgressMessage("正在创建自动收藏任务");
    setMessage("");
    setRows([]);
    try {
      const result = await runDoudianOpportunityAutoFavorites({
        shopIds: Array.from(selectedStoreIds),
        storeRefs: selectedStores.map(storeIdentityRef),
        operationId,
        forceAdapter: true,
        filters: {
          categories: selectedCategories,
          queryModes: selectedModes,
          sortFields: Array.from(new Set(selectedModes.map((item) => item.sortField))),
          perStoreLimit,
          pageSize: 18,
          maxPagesPerQuery
        }
      });
      setRows(result.rows || []);
      setMessage(result.message || (result.ok ? "自动收藏完成" : "自动收藏未完成"));
      if (result.status !== "cancelled") setProgress(100);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
      setActiveOperationId("");
    }
  }

  async function cancelRun() {
    if (!activeOperationId) return;
    await cancelDoudianStoreOperation(activeOperationId).catch(() => undefined);
    setRunning(false);
    setMessage("已停止后续收藏请求；已经成功收藏的商机不会撤销");
  }

  return (
    <section className="grid h-full min-h-0 grid-cols-[250px_minmax(0,1fr)] gap-3 overflow-hidden text-[#1d2939] max-[900px]:grid-cols-1 max-[900px]:overflow-auto">
      <aside className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white">
        <div className="flex h-11 items-center justify-between border-b border-[#edf1f6] px-3.5">
          <span className="inline-flex items-center gap-2"><Store className="size-4 text-brand-navy" /><strong className="text-[14px]">店铺选择</strong></span>
          <a className="text-[12px] font-semibold text-brand-fox no-underline" href="#/stores">店铺管理</a>
        </div>
        <div className="border-b border-[#edf1f6] p-2.5">
          <label className="flex h-8 items-center gap-2 rounded-md border border-[#dbe5f2] px-2.5 text-[#98a2b3]">
            <input className="min-w-0 flex-1 bg-transparent text-[12px] text-[#1d2939] outline-none" placeholder="店铺名称 / 店铺 ID" value={storeQuery} onChange={(event) => setStoreQuery(event.target.value)} />
            <Search className="size-[14px]" />
          </label>
          <button className="mt-2.5 inline-flex items-center gap-2 text-[12px] font-semibold text-[#344054]" type="button" disabled={running || !filteredStores.length} onClick={() => toggleStores(filteredStores.map((store) => store.id))}>
            <SelectionBox checked={allVisibleStoresSelected} mixed={someVisibleStoresSelected} />
            全选 {selectedStoreIds.size}/{stores.length}
          </button>
        </div>
        <div className={cn("min-h-[180px] overflow-auto", running && "pointer-events-none opacity-60")}>
          {loadingStores ? <div className="grid h-full min-h-[220px] place-items-center text-[13px] text-[#667085]"><Loader2 className="size-4 animate-spin" /></div>
            : filteredStores.length ? <GroupedStoreSelectionList stores={filteredStores} selectedIds={selectedStoreIds} onToggleIds={toggleStores} />
              : <div className="grid h-full min-h-[220px] place-items-center text-[13px] text-[#98a2b3]">暂无店铺</div>}
        </div>
        <div className="flex items-center justify-between border-t border-[#edf1f6] px-3 py-2">
          <span className="text-[12px] text-[#98a2b3]">{selectedStores.filter((store) => store.status === "online").length} 家在线</span>
          <button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2]" type="button" disabled={loadingStores || running} onClick={() => void refreshStores()} title="刷新店铺"><RefreshCw className={cn("size-[13px]", loadingStores && "animate-spin")} /></button>
        </div>
      </aside>

      <div className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 overflow-hidden">
        <section className="border-y border-[#e1e8f3] bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-[#fff2ea] text-brand-fox"><BookmarkPlus className="size-[18px]" /></span>
            <div className="min-w-[180px] flex-1">
              <h1 className="m-0 text-[15px] font-semibold text-[#101828]">自动收藏商机</h1>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-[#667085]">
                <span>{selectedStoreIds.size} 家店铺</span><span>{selectedCategories.length} 个类目</span><span>{selectedModes.length} 个条件</span><span>每店最多 {perStoreLimit} 个</span>
              </div>
            </div>
            {running ? <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#f3b7b3] px-3 text-[12px] font-semibold text-[#b42318]" type="button" onClick={() => void cancelRun()}><CircleStop className="size-[14px]" />停止</button>
              : <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white disabled:opacity-45" type="button" disabled={!nativeBridge || !selectedStoreIds.size || !selectedCategories.length || !selectedModes.length} onClick={() => void runAutoFavorite()}><BookmarkPlus className="size-[14px]" />开始自动收藏</button>}
          </div>
          {running ? <div className="mt-3"><div className="mb-1.5 flex justify-between text-[12px] text-[#667085]"><span className="truncate">{progressMessage || "正在处理"}</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden rounded bg-[#edf1f6]"><div className="h-full bg-brand-fox transition-[width]" style={{ width: `${progress}%` }} /></div></div> : null}
          {message ? <div className={cn("mt-3 flex items-center gap-2 text-[12px]", failureCount ? "text-[#b42318]" : quotaCount ? "text-[#b54708]" : "text-[#087443]")}>{failureCount || quotaCount ? <AlertCircle className="size-4" /> : <CheckCircle2 className="size-4" />}<span>{message}</span></div> : null}
        </section>

        <section className="grid grid-cols-[minmax(0,1.5fr)_minmax(260px,1fr)] gap-3 max-[760px]:grid-cols-1">
          <div className="min-w-0 rounded-lg border border-[#e1e8f3] bg-white p-3">
            <div className="mb-2 flex items-center justify-between"><strong className="text-[13px]">类目</strong><button className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#dbe5f2] px-2 text-[12px] font-semibold" type="button" disabled={!selectedStoreIds.size || loadingCategories || running} onClick={() => void refreshCategories()}><RefreshCw className={cn("size-[13px]", loadingCategories && "animate-spin")} />加载类目</button></div>
            <label className="flex h-8 items-center gap-2 rounded-md border border-[#dbe5f2] px-2.5 text-[#98a2b3]"><Search className="size-[14px]" /><input className="min-w-0 flex-1 bg-transparent text-[12px] text-[#1d2939] outline-none" placeholder="搜索类目" value={categoryQuery} onChange={(event) => setCategoryQuery(event.target.value)} /></label>
            <div className="mt-2 flex max-h-[132px] flex-wrap content-start gap-1.5 overflow-auto">
              {categoryOptions.length ? categoryOptions.slice(0, 300).map((category) => {
                const key = `${category.key}:${category.id}`;
                const active = selectedCategoryKeys.has(key);
                return <button className={cn("h-7 max-w-full truncate rounded-md border px-2 text-[11px] font-semibold", active ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] text-[#526a91]")} key={key} type="button" title={(category.path || [category.name]).join(">") } onClick={() => toggleCategory(category)}>{(category.path || [category.name]).join(">")}</button>;
              }) : <span className="px-1 py-2 text-[12px] text-[#98a2b3]">选择店铺后加载类目</span>}
            </div>
          </div>

          <div className="rounded-lg border border-[#e1e8f3] bg-white p-3">
            <div className="mb-2 flex items-center gap-2"><SlidersHorizontal className="size-4 text-brand-navy" /><strong className="text-[13px]">收藏条件</strong></div>
            <div className="grid grid-cols-3 gap-2">
              {queryModes.map((mode) => <button className={cn("h-8 rounded-md border text-[12px] font-semibold", selectedModeIds.has(mode.id) ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] text-[#526a91]")} key={mode.id} type="button" onClick={() => toggleMode(mode.id)}>{mode.label}</button>)}
            </div>
            <label className="mt-3 grid grid-cols-[1fr_90px] items-center gap-3 text-[12px] text-[#667085]"><span>每店本次收藏数量</span><input className="h-8 rounded-md border border-[#dbe5f2] px-2 text-right font-semibold text-[#1d2939] outline-none focus:border-brand-fox" type="number" min={1} max={1000} value={perStoreLimit} onChange={(event) => setPerStoreLimit(Math.max(1, Math.min(1000, Math.floor(Number(event.target.value || 1)))))} /></label>
          </div>
        </section>

        <section className="min-h-0 overflow-hidden rounded-lg border border-[#e1e8f3] bg-white">
          <div className="flex h-10 items-center justify-between border-b border-[#edf1f6] px-3.5"><strong className="text-[13px]">收藏结果</strong><span className="text-[11px] text-[#98a2b3]">{collectedCount} 成功 · {skippedCount} 跳过 · {failureCount} 失败{quotaCount ? ` · ${quotaCount} 达上限` : ""}</span></div>
          <div className="h-[calc(100%_-_40px)] min-h-[220px] overflow-auto">
            {processedRows.length ? <table className="w-full min-w-[860px] table-fixed border-collapse text-left text-[12px]"><thead className="sticky top-0 bg-[#f8fafc] text-[#667085]"><tr className="h-9 border-b"><th className="w-[190px] px-3">店铺</th><th className="w-[210px] px-3">商机</th><th className="w-[190px] px-3">类目</th><th className="w-[90px] px-3">结果</th><th className="px-3">消息</th></tr></thead><tbody className="divide-y divide-[#edf1f6]">{processedRows.map((row, index) => <tr className="h-11 hover:bg-[#fbfcfe]" key={`${row.shopId}:${row.clueId || index}:${row.attemptedAt}`}><td className="px-3"><span className="block truncate font-semibold">{row.shopName}</span><span className="text-[11px] text-[#98a2b3]">{row.shopId}</span></td><td className="px-3"><span className="block truncate" title={row.clueName}>{row.clueName || "--"}</span><span className="text-[11px] text-[#98a2b3]">{row.clueId || ""}</span></td><td className="px-3"><span className="block truncate" title={row.categoryName}>{row.categoryName || "--"}</span></td><td className="px-3"><span className={cn("inline-flex rounded px-1.5 py-0.5 font-semibold", statusClass(row.status))}>{statusLabel(row.status)}</span></td><td className="px-3"><span className="block truncate text-[#475467]" title={row.message}>{row.message}</span></td></tr>)}</tbody></table>
              : <div className="grid h-full min-h-[240px] place-items-center text-[13px] text-[#98a2b3]">暂无收藏记录</div>}
          </div>
        </section>
      </div>
    </section>
  );
}
