import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Copy, Edit3, ListFilter, PanelLeftOpen, Plus, RefreshCcw, Search, ShieldCheck, Square, StopCircle, TicketX, TimerReset, Trash2, X } from "lucide-react";
import { listDoudianStores } from "../../bridge/client";
import { loadConfig } from "../../bridge/config";
import { loadDoudianAdapterPayload } from "../../bridge/doudianAdapter";
import { storageGet, storageSet } from "../../bridge/storage";
import { addDoudianProgressListener, cancelDoudianTask, marketingAdapterSnapshotHash, marketingPageEnabled, marketingWriteEnabled, runDoudianStoreTask, saveMarketingSchedule, splitMarketingTimeSegments, type DoudianProgressDetail, type MarketingAction, type MarketingDraft, type MarketingEntity, type MarketingTaskResult, type MarketingWriteAction } from "../../domain/doudian";
import type { ChihuConfig, DoudianAdapterPayload, MarketingFeature } from "../../types";
import { MarketingExecutionHistory } from "./MarketingExecutionHistory";
import { MarketingProductTable } from "./MarketingProductTable";
import { MarketingScopeSelector } from "./MarketingScopeSelector";
import { MarketingStoreSidebar, type MarketingSelectableStore } from "./MarketingStoreSidebar";
import { MarketingRunDialog } from "./MarketingRunDialog";

type MarketingPageCopy = { title: string; createTab: string; entityLabel: string; scopeLabels: [string, string]; draftKey: string };

const featureCopy: Record<MarketingFeature, MarketingPageCopy> = {
  limited_time: { title: "限时限量购", createTab: "创建活动", entityLabel: "活动", scopeLabels: ["限时抢购", "限量抢购"], draftKey: "chihu20_marketing_limited_time_draft" },
  new_user_bonus: { title: "新人礼金", createTab: "新建礼金", entityLabel: "礼金活动", scopeLabels: ["指定商品", "全店商品"], draftKey: "chihu20_marketing_new_user_bonus_draft" },
  general_coupon: { title: "通用优惠券", createTab: "新建优惠券", entityLabel: "优惠券", scopeLabels: ["商品券", "店铺券"], draftKey: "chihu20_marketing_coupon_draft" }
};

const defaultDraft: MarketingDraft = { scope: "product", name: "", startTime: "", endTime: "", discountMode: "discount", discountValue: "9", issueCount: "1000", perUserLimit: "1", officialRenew: false, toolRenew: false, toolRenewIntervalDays: "7", activityType: "flash", stockMode: "sku", stockValue: "100", purchaseLimit: "1", scheduleSlices: "", skuMode: "all", newUserDurationDays: "7", couponType: "product", thresholdAmount: "" };

function statusTone(status: string) {
  const value = status.toLowerCase();
  if (value.includes("active") || value.includes("进行") || value === "1") return "border-[#bff0cf] bg-[#eafaf0] text-[#087443]";
  if (value.includes("invalid") || value.includes("作废") || value.includes("结束")) return "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]";
  return "border-[#dbe5f2] bg-[#f8fafc] text-[#52627a]";
}

export function MarketingWorkspacePage({ feature }: { feature: MarketingFeature }) {
  const copy = featureCopy[feature];
  const [tab, setTab] = useState<"create" | "manage" | "history" | "renewals">("create");
  const [stores, setStores] = useState<MarketingSelectableStore[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [storeSearch, setStoreSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [storesLoading, setStoresLoading] = useState(true);
  const [config, setConfig] = useState<ChihuConfig | null>(null);
  const [adapter, setAdapter] = useState<DoudianAdapterPayload | null>(null);
  const [draft, setDraft] = useState<MarketingDraft>(() => ({ ...defaultDraft, ...storageGet<Partial<MarketingDraft>>(copy.draftKey, {}) }));
  const [products, setProducts] = useState<MarketingEntity[]>([]);
  const [productFilter, setProductFilter] = useState("");
  const [entities, setEntities] = useState<MarketingEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [detailEntity, setDetailEntity] = useState<MarketingEntity | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadedListKey, setLoadedListKey] = useState("");
  const [activeOperationId, setActiveOperationId] = useState("");
  const [progress, setProgress] = useState<DoudianProgressDetail | null>(null);
  const [selectedProductKeys, setSelectedProductKeys] = useState<Set<string>>(new Set());
  const [selectedEntityKeys, setSelectedEntityKeys] = useState<Set<string>>(new Set());
  const [storeOverrides, setStoreOverrides] = useState<Record<string, Partial<MarketingDraft>>>({});
  const [pendingAction, setPendingAction] = useState<{ action: MarketingAction; target?: MarketingEntity } | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([listDoudianStores(), loadConfig(), loadDoudianAdapterPayload()]).then(([storeResult, configResult, adapterResult]) => {
      if (!active) return;
      const rows = (storeResult.stores || []).map((store) => ({ id: store.shopId, name: store.shopName, group: store.groupName || "未分组", status: store.status, partition: store.partition, tenantId: store.tenantId, storeGeneration: store.storeGeneration }));
      setStores(rows);
      setSelectedIds(new Set(rows.filter((store) => store.status === "online").slice(0, 1).map((store) => store.id)));
      setConfig(configResult.config);
      setAdapter(adapterResult);
    }).catch((error) => setMessage(error instanceof Error ? error.message : String(error))).finally(() => setStoresLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => storageSet(copy.draftKey, draft), [copy.draftKey, draft]);
  useEffect(() => addDoudianProgressListener((event) => {
    const detail = event.detail;
    if (detail.taskType !== "marketingTask") return;
    setProgress(detail);
    if (["running", "cancelling"].includes(detail.status)) setActiveOperationId(detail.operationId);
    else setActiveOperationId((current) => current === detail.operationId ? "" : current);
  }), []);
  const selectedStores = useMemo(() => stores.filter((store) => selectedIds.has(store.id)), [stores, selectedIds]);
  const selectedStoreKey = useMemo(() => selectedStores.map((store) => store.id).sort().join(","), [selectedStores]);
  const readEnabled = !!config && !!adapter && marketingPageEnabled(config, adapter.adapter, feature);
  const writeEnabled = !!config && !!adapter && marketingWriteEnabled(config, adapter.adapter, feature, "create");
  const actionEnabled = (action: MarketingWriteAction) => !!config && !!adapter && marketingWriteEnabled(config, adapter.adapter, feature, action);
  const filteredEntities = entities.filter((entity) => {
    const matchesText = !filter || `${entity.name} ${entity.entityId} ${entity.shopName}`.toLowerCase().includes(filter.toLowerCase());
    const matchesStatus = statusFilter === "all" || entity.status === statusFilter;
    return matchesText && matchesStatus;
  });
  const managementActions: Array<{ action: MarketingWriteAction; label: string; icon: typeof StopCircle }> = feature === "limited_time"
    ? [{ action: "end", label: "结束", icon: StopCircle }, { action: "disable", label: "失效", icon: TicketX }, { action: "toggle_renew", label: "官方续期", icon: TimerReset }, { action: "revive", label: "复活", icon: TimerReset }, { action: "copy", label: "复制", icon: Copy }, { action: "bulk_edit", label: "批量编辑", icon: Edit3 }, { action: "remove_products", label: "删除单品", icon: Trash2 }, { action: "tool_renew", label: "工具续期", icon: TimerReset }]
    : feature === "general_coupon" ? [{ action: "cancel", label: "作废", icon: TicketX }, { action: "toggle_renew", label: "官方续期", icon: TimerReset }]
      : [{ action: "disable", label: "作废", icon: TicketX }, { action: "toggle_renew", label: "官方续期", icon: TimerReset }];
  const filteredProducts = products.filter((product) => !productFilter || `${product.name} ${product.entityId} ${product.shopName}`.toLowerCase().includes(productFilter.toLowerCase()));
  const productIdsByShop = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const key of selectedProductKeys) {
      const separator = key.indexOf(":");
      if (separator < 1) continue;
      const shopId = key.slice(0, separator);
      const entityId = key.slice(separator + 1);
      (result[shopId] ||= []).push(entityId);
    }
    return result;
  }, [selectedProductKeys]);
  const selectedProductsByShop = useMemo(() => {
    const result: Record<string, MarketingEntity[]> = {};
    for (const product of products) {
      if (selectedProductKeys.has(`${product.shopId}:${product.entityId}`)) (result[product.shopId] ||= []).push(product);
    }
    return result;
  }, [products, selectedProductKeys]);
  const entityIdsByShop = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const key of selectedEntityKeys) {
      const separator = key.indexOf(":");
      if (separator < 1) continue;
      const shopId = key.slice(0, separator);
      const entityId = key.slice(separator + 1);
      (result[shopId] ||= []).push(entityId);
    }
    return result;
  }, [selectedEntityKeys]);

  function toggleStores(ids: string[]) {
    setSelectedIds((current) => {
      const next = new Set(current);
      const remove = ids.every((id) => next.has(id));
      ids.forEach((id) => remove ? next.delete(id) : next.add(id));
      return next;
    });
  }

  function toggleProduct(row: MarketingEntity) {
    if (row.platformError || row.eligible === false) { setMessage("不可参与的商品不能加入活动"); return; }
    const key = `${row.shopId}:${row.entityId}`;
    setSelectedProductKeys((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  function toggleProducts(rows: MarketingEntity[]) {
    const eligibleRows = rows.filter((row) => !row.platformError && row.eligible !== false);
    setSelectedProductKeys((current) => {
      const next = new Set(current);
      const allSelected = eligibleRows.length > 0 && eligibleRows.every((row) => next.has(`${row.shopId}:${row.entityId}`));
      eligibleRows.forEach((row) => { const key = `${row.shopId}:${row.entityId}`; if (allSelected) next.delete(key); else next.add(key); });
      return next;
    });
  }

  function toggleEntity(entity: MarketingEntity) {
    const key = `${entity.shopId}:${entity.entityId}`;
    setSelectedEntityKeys((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  function requestAction(action: MarketingAction, target?: MarketingEntity) {
    if (action === "create") { setPendingAction({ action }); return; }
    if (!target && !selectedEntityKeys.size) { setMessage("请先选择活动"); return; }
    setPendingAction({ action, target });
  }

  async function runAction(action: MarketingAction, target?: MarketingEntity, options: { silent?: boolean } = {}): Promise<MarketingTaskResult | null> {
    if (!config || !adapter) return null;
    const managementAction = !["load_products", "list", "detail", "create"].includes(action);
    const actionStores = target
      ? selectedStores.filter((store) => store.id === target.shopId)
      : managementAction
        ? selectedStores.filter((store) => (entityIdsByShop[store.id] || []).length > 0)
        : selectedStores;
    if (!actionStores.length) { setMessage("请先选择店铺"); return null; }
    if (action === "detail" && !options.silent) setDetailLoading(true);
    setLoading(true);
    setMessage("");
    try {
      const result = await runDoudianStoreTask({
        taskType: "marketingTask",
        adapterVersion: adapter.adapter.version,
        ruleVersion: adapter.scripts?.version || "",
        metadata: { replaceActive: !["create", "disable", "cancel", "toggle_renew", "end", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"].includes(action), mutation: action !== "load_products" && action !== "list" && action !== "detail", adapterSnapshotHash: marketingAdapterSnapshotHash(adapter), dedupeKey: JSON.stringify({ feature, action, entityId: target?.entityId || "", shopIds: actionStores.map((store) => store.id).sort(), draft, selectedProductKeys: [...selectedProductKeys], selectedEntityKeys: [...selectedEntityKeys] }) },
        payload: {
          feature,
          action,
          stores: actionStores.map((store) => ({ shopId: store.id, shopName: store.name, partition: store.partition, tenantId: store.tenantId, storeGeneration: store.storeGeneration })),
          context: { ...draft, ...(feature === "limited_time" ? { timeSegments: splitMarketingTimeSegments(draft.startTime, draft.endTime) } : {}), ...(target ? { entityId: target.entityId, entityIds: [target.entityId] } : {}), ...(action !== "create" && !target ? { entityIds: [...selectedEntityKeys].map((key) => key.slice(key.indexOf(":") + 1)) } : {}), productIds: Object.values(productIdsByShop).flat(), productIdsByShop, selectedProductsByShop, entityIdsByShop, storeOverrides, ...(action === "remove_products" ? { productIds: [...selectedProductKeys].map((key) => key.slice(key.indexOf(":") + 1)) } : {}), ...(action === "bulk_edit" ? { fields: { startTime: draft.startTime, endTime: draft.endTime, discountValue: draft.discountValue } } : {}), ...(action === "tool_renew" ? { intervalDays: Number(draft.toolRenewIntervalDays) } : {}) },
          config,
          doudianAdapter: adapter
        }
      }, 900000) as unknown as MarketingTaskResult;
      if (action === "load_products") { setProducts(result.entities || []); const liveKeys = new Set((result.entities || []).filter((entity) => !entity.platformError && entity.eligible !== false).map((entity) => `${entity.shopId}:${entity.entityId}`)); setSelectedProductKeys((current) => new Set([...current].filter((key) => liveKeys.has(key)))); }
      else if (action === "list") setEntities(result.entities || []);
      else if (action === "detail" && !options.silent) setDetailEntity(result.entities?.[0] || { ...target!, platformError: result.message || "平台未返回详情" });
      if (action === "create" && feature === "limited_time" && draft.toolRenew && actionEnabled("tool_renew") && result.status === "ok") {
        const intervalMs = Math.max(1, Number(draft.toolRenewIntervalDays) || 7) * 24 * 60 * 60 * 1000;
        await Promise.all((result.entities || []).map((entity) => {
          const store = actionStores.find((item) => item.id === entity.shopId);
          if (!store) return Promise.resolve();
          const now = new Date().toISOString();
          return saveMarketingSchedule({ id: `marketing:schedule:limited_time:${store.id}:${entity.entityId}`, kind: "marketing-schedule", feature, action: "tool_renew", shopId: store.id, entityId: entity.entityId, partition: store.partition, tenantId: store.tenantId, storeGeneration: store.storeGeneration, adapterSnapshotHash: marketingAdapterSnapshotHash(adapter), intervalMs, nextRunAt: new Date(Date.now() + intervalMs).toISOString(), status: "active", failureCount: 0, createdAt: now, updatedAt: now });
        }));
      }
      if (action === "create" && ["ok", "partial"].includes(result.status)) { setTab("manage"); setLoadedListKey(""); }
      if (action !== "detail" && !["load_products", "list"].includes(action)) { setSelectedEntityKeys(new Set()); setPendingAction(null); }
      setMessage(result.message || "读取完成");
      return result;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setLoading(false);
      if (!options.silent) setDetailLoading(false);
    }
  }

  async function confirmPendingAction() {
    const pending = pendingAction;
    if (!pending) return;
    if (pending.action === "remove_products") {
      const targets = entities.filter((entity) => selectedEntityKeys.has(`${entity.shopId}:${entity.entityId}`));
      for (const entity of targets) {
        const detail = await runAction("detail", entity, { silent: true });
        if (!detail || !detail.stores.every((store) => store.ok)) { setMessage(`${entity.name || entity.entityId}详情校验失败，未执行删除单品`); return; }
      }
    }
    await runAction(pending.action, pending.target);
  }

  async function cancelActiveTask() {
    if (!activeOperationId) return;
    await cancelDoudianTask(activeOperationId).catch(() => undefined);
    setMessage("已请求停止任务，已发出的读取请求不会撤回");
  }

  useEffect(() => {
    if (tab !== "manage" || !readEnabled || !selectedStoreKey || loadedListKey === selectedStoreKey || loading) return;
    setLoadedListKey(selectedStoreKey);
    void runAction("list");
  }, [tab, readEnabled, selectedStoreKey, loadedListKey, loading]);

  return (
    <div className={`grid h-full min-h-[560px] overflow-hidden rounded-lg border border-[#e6ebf3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${sidebarCollapsed ? "grid-cols-[0_minmax(0,1fr)]" : "grid-cols-[236px_minmax(0,1fr)]"} max-[860px]:grid-cols-1 max-[860px]:overflow-visible`}>
      <MarketingStoreSidebar stores={stores} selectedIds={selectedIds} search={storeSearch} collapsed={sidebarCollapsed} loading={storesLoading} onSearch={setStoreSearch} onToggleIds={toggleStores} onCollapsedChange={setSidebarCollapsed} />
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex min-h-[58px] items-center justify-between gap-4 border-b border-[#e6ebf3] px-4 max-[600px]:items-start max-[600px]:flex-col max-[600px]:py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {sidebarCollapsed ? <button className="grid size-8 place-items-center rounded-md border border-[#dbe3ee] text-[#52627a]" type="button" title="展开店铺栏" onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen className="size-4" /></button> : null}
            <div><h1 className="m-0 text-[16px] font-bold text-[#002050]">{copy.title}</h1><p className="m-0 mt-0.5 text-[11px] text-[#667085]">已选 {selectedIds.size} 家店铺</p></div>
          </div>
          <div className="flex items-center gap-2">
            {message ? <span className="max-w-[320px] truncate text-[11px] text-[#667085]" title={message}>{message}</span> : null}
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#ff5020] px-3 text-[12px] font-semibold text-white hover:bg-[#e94316] disabled:cursor-not-allowed disabled:bg-[#f2b5a3]" type="button" disabled={!writeEnabled || loading} onClick={() => requestAction("create")} title={writeEnabled ? copy.createTab : "写入开关或平台合同未开放"}><Plus className="size-4" />{copy.createTab}</button>
          </div>
        </header>
        <nav className="flex h-10 shrink-0 items-end gap-5 border-b border-[#e6ebf3] px-4 text-[12px] font-semibold">
          {([['create', copy.createTab], ['manage', `${copy.entityLabel}管理`], ['history', '执行记录'], ...(feature === "limited_time" ? [["renewals", "续期记录"]] as const : [])] as const).map(([value, label]) => <button key={value} className={`relative h-10 px-1 ${tab === value ? "text-[#073b7a]" : "text-[#667085]"}`} type="button" onClick={() => setTab(value)}>{label}{tab === value ? <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[#ff5020]" /> : null}</button>)}
        </nav>
        {activeOperationId && progress?.operationId === activeOperationId ? <div className="border-b border-[#e6ebf3] bg-[#fffaf6] px-4 py-2"><div className="flex items-center justify-between gap-3 text-[11px] text-[#52627a]"><span className="min-w-0 truncate">{progress.status === "cancelling" ? "正在停止任务" : progress.message || "营销任务执行中"}</span><div className="flex shrink-0 items-center gap-2"><strong>{Math.round(Math.max(0, Math.min(100, progress.progress || 0)))}%</strong><button className="font-semibold text-[#b42318]" type="button" onClick={() => void cancelActiveTask()}>停止</button></div></div><div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#f4d8c8]"><span className="block h-full rounded-full bg-[#ff5020] transition-[width]" style={{ width: `${Math.max(0, Math.min(100, progress.progress || 0))}%` }} /></div></div> : null}
        {tab === "create" ? <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid grid-cols-4 gap-x-4 gap-y-3 px-4 py-4 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1">
            <label className="col-span-2 max-[600px]:col-span-1"><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">活动范围</span><MarketingScopeSelector value={draft.scope} labels={[{ value: "product", label: copy.scopeLabels[0] }, { value: "shop", label: copy.scopeLabels[1] }]} onChange={(scope) => setDraft({ ...draft, scope: scope as MarketingDraft["scope"] })} /></label>
            <label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">开始时间</span><input type="datetime-local" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px] outline-none focus:border-[#ff5020]" value={draft.startTime} onChange={(event) => setDraft({ ...draft, startTime: event.target.value })} /></label>
            <label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">结束时间</span><input type="datetime-local" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px] outline-none focus:border-[#ff5020]" value={draft.endTime} onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} /></label>
            <label className="col-span-2 max-[600px]:col-span-1"><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">名称</span><input className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px] outline-none focus:border-[#ff5020]" placeholder={`${copy.title}名称`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">优惠方式</span><select className="h-8 w-full rounded-md border border-[#dbe3ee] bg-white px-2 text-[12px]" value={draft.discountMode} onChange={(event) => setDraft({ ...draft, discountMode: event.target.value as MarketingDraft["discountMode"] })}><option value="discount">折扣</option><option value="reduce">立减</option>{feature === "general_coupon" ? <option value="threshold">满减</option> : null}</select></label>
            <label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">优惠值</span><input type="number" min="0" step="0.1" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px]" value={draft.discountValue} onChange={(event) => setDraft({ ...draft, discountValue: event.target.value })} /></label>
            {feature === "general_coupon" ? <><label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">发放量</span><input type="number" min="1" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px]" value={draft.issueCount} onChange={(event) => setDraft({ ...draft, issueCount: event.target.value })} /></label><label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">每人限领</span><input type="number" min="1" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px]" value={draft.perUserLimit} onChange={(event) => setDraft({ ...draft, perUserLimit: event.target.value })} /></label></> : null}
            {feature === "limited_time" ? <><label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">活动类型</span><select className="h-8 w-full rounded-md border border-[#dbe3ee] bg-white px-2 text-[12px]" value={draft.activityType} onChange={(event) => setDraft({ ...draft, activityType: event.target.value as MarketingDraft["activityType"] })}><option value="flash">限时抢购</option><option value="limited">限量抢购</option></select></label><label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">SKU 库存</span><input type="number" min="1" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px]" value={draft.stockValue} onChange={(event) => setDraft({ ...draft, stockValue: event.target.value })} /></label><label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">购买上限</span><input type="number" min="1" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px]" value={draft.purchaseLimit} onChange={(event) => setDraft({ ...draft, purchaseLimit: event.target.value })} /></label></> : null}
            {feature === "new_user_bonus" ? <label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">礼金有效天数</span><input type="number" min="1" max="180" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px]" value={draft.newUserDurationDays} onChange={(event) => setDraft({ ...draft, newUserDurationDays: event.target.value })} /></label> : null}
            <label className="flex items-end"><span className="inline-flex h-8 items-center gap-2 text-[12px] font-semibold text-[#344054]"><input type="checkbox" checked={draft.officialRenew} onChange={(event) => setDraft({ ...draft, officialRenew: event.target.checked })} />平台官方续期</span></label>
            {feature === "limited_time" ? <label className="flex items-end"><span className="inline-flex h-8 items-center gap-2 text-[12px] font-semibold text-[#344054]"><input type="checkbox" checked={draft.toolRenew} onChange={(event) => setDraft({ ...draft, toolRenew: event.target.checked })} />工具续期计划</span></label> : null}
            <div className="flex items-end justify-end"><button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe3ee] px-3 text-[12px] font-semibold text-[#344054] hover:border-[#ff5020] hover:text-[#073b7a] disabled:opacity-50" type="button" disabled={loading} onClick={() => void runAction("load_products")}><ShieldCheck className="size-4" />校验商品资格</button></div>
          </div>
          {selectedStores.length > 1 ? <div className="border-b border-[#e6ebf3] px-4 pb-3"><div className="mb-2 flex items-center justify-between text-[11px] text-[#667085]"><span className="font-semibold text-[#344054]">逐店参数覆盖</span><span>不填写则使用上方默认参数</span></div><div className="grid grid-cols-2 gap-2 max-[760px]:grid-cols-1">{selectedStores.map((store) => <label className="flex items-center gap-2 text-[11px] text-[#52627a]" key={store.id}><span className="min-w-0 flex-1 truncate" title={store.name}>{store.name}</span><input className="h-7 w-24 rounded-md border border-[#dbe3ee] px-2 text-[11px]" type="number" min="0" step="0.1" placeholder={draft.discountValue} value={storeOverrides[store.id]?.discountValue || ""} onChange={(event) => setStoreOverrides((current) => ({ ...current, [store.id]: { ...current[store.id], discountValue: event.target.value } }))} aria-label={`${store.name}优惠值`} /></label>)}</div></div> : null}
          <MarketingProductTable rows={filteredProducts} totalRows={products.length} search={productFilter} loading={loading} selectedIds={selectedProductKeys} onToggle={toggleProduct} onToggleAll={toggleProducts} onSearch={setProductFilter} onRefresh={() => void runAction("load_products")} />
        </div> : tab === "manage" ? <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-[50px] items-center gap-2 border-b border-[#e6ebf3] px-4 max-[600px]:flex-wrap max-[600px]:py-2"><label className="relative min-w-[220px] flex-1 max-w-[420px]"><Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#98a2b3]" /><input className="h-8 w-full rounded-md border border-[#dbe3ee] pl-8 pr-2 text-[12px]" placeholder={`搜索${copy.entityLabel}名称或 ID`} value={filter} onChange={(event) => setFilter(event.target.value)} /></label><label className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe3ee] px-2 text-[12px] font-semibold text-[#344054]"><ListFilter className="size-4" /><select className="bg-transparent outline-none" aria-label="按状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option>{Array.from(new Set(entities.map((entity) => entity.status).filter(Boolean))).map((status) => <option value={status} key={status}>{status}</option>)}</select></label><div className="flex items-center gap-1 max-[600px]:order-3 max-[600px]:w-full">{managementActions.map(({ action, label, icon: Icon }) => <button key={action} className="inline-flex h-8 items-center gap-1 rounded-md border border-[#dbe3ee] px-2 text-[11px] font-semibold text-[#344054] hover:border-[#ff5020] hover:text-[#073b7a] disabled:cursor-not-allowed disabled:opacity-45" type="button" disabled={!actionEnabled(action) || loading || !selectedEntityKeys.size} title={actionEnabled(action) ? label : "此动作尚未通过平台合同门禁"} onClick={() => requestAction(action)}><Icon className="size-3.5" />{label}</button>)}</div><button className="ml-auto grid size-8 place-items-center rounded-md border border-[#dbe3ee] text-[#52627a] disabled:opacity-50" type="button" title="刷新列表" aria-label="刷新列表" disabled={loading} onClick={() => void runAction("list")}><RefreshCcw className={`size-4 ${loading ? "animate-spin" : ""}`} /></button></div>
          <div className="min-h-0 flex-1 overflow-auto">{filteredEntities.length ? <table className="w-full min-w-[980px] border-collapse text-left text-[12px]"><thead><tr className="sticky top-0 border-b border-[#e6ebf3] bg-[#f8fafc] text-[#667085]"><th className="w-10 px-4 py-3" /><th className="px-2 py-3">名称 / ID</th><th className="px-3 py-3">店铺</th><th className="px-3 py-3">时间</th><th className="px-3 py-3">商品数</th><th className="px-3 py-3">状态</th><th className="px-3 py-3">操作</th></tr></thead><tbody>{filteredEntities.map((entity, index) => { const key = `${entity.shopId}:${entity.entityId}`; const selected = selectedEntityKeys.has(key); return <tr key={`${entity.shopId}-${entity.entityId}-${index}`} className={`border-b border-[#edf1f6] ${selected ? "bg-[#fffaf6]" : ""}`}><td className="px-4 py-3"><button className="grid size-6 place-items-center text-[#52627a]" type="button" title={selected ? "取消选择活动" : "选择活动"} aria-label={selected ? "取消选择活动" : "选择活动"} onClick={() => toggleEntity(entity)}>{selected ? <StopCircle className="size-4 text-[#ff5020]" /> : <Square className="size-4" />}</button></td><td className="px-2 py-3"><strong className="block max-w-[280px] truncate text-[#1d2939]">{entity.name}</strong><span className="font-mono text-[11px] text-[#98a2b3]">{entity.entityId}</span></td><td className="px-3 py-3">{entity.shopName}</td><td className="px-3 py-3 text-[#52627a]">{entity.startTime || "-"}<br />{entity.endTime || "-"}</td><td className="px-3 py-3">{entity.productCount}</td><td className="px-3 py-3"><span className={`inline-flex rounded-sm border px-2 py-0.5 text-[11px] ${statusTone(entity.status)}`}>{entity.status}</span></td><td className="px-3 py-3"><button className="text-[12px] font-semibold text-[#073b7a]" type="button" onClick={() => void runAction("detail", entity)}>详情</button></td></tr>; })}</tbody></table> : <div className="grid min-h-[300px] place-items-center text-[12px] text-[#667085]">选择店铺后刷新{copy.entityLabel}列表</div>}</div>
        </div> : <MarketingExecutionHistory feature={feature} action={tab === "renewals" ? "tool_renew" : undefined} />}
      </section>
      {pendingAction ? <MarketingRunDialog feature={feature} draft={draft} action={pendingAction.action} stores={selectedStores.map((store) => ({ shopId: store.id, shopName: store.name, productCount: pendingAction.action === "create" ? (draft.scope === "shop" ? products.filter((product) => product.shopId === store.id).length : productIdsByShop[store.id]?.length || 0) : entityIdsByShop[store.id]?.length || 0, override: storeOverrides[store.id] }))} onCancel={() => setPendingAction(null)} onConfirm={() => void confirmPendingAction()} /> : null}
      {detailEntity ? <div className="fixed inset-0 z-40 grid place-items-center bg-[#002050]/25 px-4" role="presentation" onClick={() => !detailLoading && setDetailEntity(null)}><section className="max-h-[min(680px,calc(100vh-32px))] w-full max-w-[560px] overflow-auto rounded-lg border border-[#dbe3ee] bg-white shadow-[0_18px_60px_rgba(0,32,80,0.2)]" role="dialog" aria-modal="true" aria-label={`${copy.entityLabel}详情`} onClick={(event) => event.stopPropagation()}><header className="flex items-center justify-between border-b border-[#e6ebf3] px-4 py-3"><div><h2 className="m-0 text-[15px] font-bold text-[#002050]">{copy.entityLabel}详情</h2><p className="m-0 mt-1 font-mono text-[11px] text-[#98a2b3]">{detailEntity.entityId || "-"}</p></div><button className="grid size-8 place-items-center rounded-md text-[#52627a] hover:bg-[#f8fafc]" type="button" title="关闭详情" aria-label="关闭详情" disabled={detailLoading} onClick={() => setDetailEntity(null)}><X className="size-4" /></button></header><div className="grid grid-cols-2 gap-3 px-4 py-4 text-[12px] max-[560px]:grid-cols-1"><div><span className="text-[#98a2b3]">名称</span><strong className="mt-1 block break-words text-[#1d2939]">{detailEntity.name || "-"}</strong></div><div><span className="text-[#98a2b3]">店铺</span><strong className="mt-1 block break-words text-[#1d2939]">{detailEntity.shopName || detailEntity.shopId || "-"}</strong></div><div><span className="text-[#98a2b3]">状态</span><span className={`mt-1 inline-flex rounded-sm border px-2 py-0.5 ${statusTone(detailEntity.status)}`}>{detailEntity.status || "未知"}</span></div><div><span className="text-[#98a2b3]">商品数</span><strong className="mt-1 block text-[#1d2939]">{detailEntity.productCount || 0}</strong></div><div><span className="text-[#98a2b3]">开始时间</span><strong className="mt-1 block break-words text-[#1d2939]">{detailEntity.startTime || "-"}</strong></div><div><span className="text-[#98a2b3]">结束时间</span><strong className="mt-1 block break-words text-[#1d2939]">{detailEntity.endTime || "-"}</strong></div></div>{detailEntity.platformError ? <div className="mx-4 mb-4 flex items-start gap-2 rounded-md border border-[#ffd1d1] bg-[#fff1f0] px-3 py-2 text-[12px] text-[#b42318]"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 break-words">{detailEntity.platformError}</span></div> : null}</section></div> : null}
    </div>
  );
}
