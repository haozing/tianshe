import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckSquare, Copy, Edit3, ListFilter, PanelLeftOpen, Plus, RefreshCcw, Search, ShieldCheck, Square, SquareMinus, StopCircle, TicketX, TimerReset, Trash2, X } from "lucide-react";
import { listDoudianStores } from "../../bridge/client";
import { loadConfig } from "../../bridge/config";
import { loadDoudianAdapterPayload } from "../../bridge/doudianAdapter";
import { storageGet, storageSet } from "../../bridge/storage";
import { addDoudianProgressListener, cancelDoudianTask, generalCouponDiscountSummary, generalCouponInitialTimes, generalCouponUseTimeSummary, limitedTimeActivitySegments, marketingAdapterSnapshotHash, marketingPageEnabled, marketingTaskInputErrors, marketingWriteEnabled, newUserBonusInitialTimes, queryMarketingSchedules, runDoudianStoreTask, saveMarketingSchedule, splitGeneralCouponCreateBatches, splitLimitedTimeCreateBatches, splitNewUserBonusCreateBatches, type DoudianProgressDetail, type MarketingAction, type MarketingDraft, type MarketingEntity, type MarketingSchedule, type MarketingTaskResult, type MarketingWriteAction } from "../../domain/doudian";
import type { ChihuConfig, DoudianAdapterPayload, MarketingFeature } from "../../types";
import { buildMarketingEntityShopOptions, marketingEntityKeys, toggleMarketingEntitySelection } from "../../lib/marketingEntityList";
import { MarketingExecutionHistory } from "./MarketingExecutionHistory";
import { LimitedTimeCreateFields, limitedTimePresetEndTime } from "./LimitedTimeCreateFields";
import { MarketingProductTable } from "./MarketingProductTable";
import { MarketingScopeSelector } from "./MarketingScopeSelector";
import { MarketingStoreSidebar, type MarketingSelectableStore } from "./MarketingStoreSidebar";
import { MarketingRunDialog } from "./MarketingRunDialog";
import { GeneralCouponCreateFields, GeneralCouponStoreOverrides } from "./GeneralCouponCreateFields";
import { GeneralCouponManagementTable } from "./GeneralCouponManagementTable";
import { NewUserBonusCreateFields, NewUserBonusStoreOverrides } from "./NewUserBonusCreateFields";

type MarketingPageCopy = { title: string; createTab: string; entityLabel: string; scopeLabels: [string, string]; draftKey: string };

const featureCopy: Record<MarketingFeature, MarketingPageCopy> = {
  limited_time: { title: "限时限量购", createTab: "创建活动", entityLabel: "活动", scopeLabels: ["指定商品", ""], draftKey: "chihu20_marketing_limited_time_draft" },
  new_user_bonus: { title: "新人礼金", createTab: "新建礼金", entityLabel: "礼金活动", scopeLabels: ["指定商品", "全店商品"], draftKey: "chihu20_marketing_new_user_bonus_draft" },
  general_coupon: { title: "通用优惠券", createTab: "新建优惠券", entityLabel: "优惠券", scopeLabels: ["商品券", "店铺券"], draftKey: "chihu20_marketing_coupon_draft" }
};

const defaultDraft: MarketingDraft = {
  scope: "product", name: "", startTime: "", endTime: "", discountMode: "discount", discountValue: "9",
  issueCount: "1000", perUserLimit: "1", officialRenew: false, toolRenew: false, toolRenewIntervalDays: "4",
  activityType: "flash", timeMode: "range", activityDurationMinutes: "1440", productLimitPerActivity: "200",
  stockLimitMode: "limited", stockMode: "percent", stockPercent: "50", stockValue: "100",
  purchaseLimitMode: "limited", purchaseLimit: "20", skuMode: "all",
  lowestSkuOverride: false, lowestSkuValue: "9", lowestSkuReduction: "0", lowestSkuSelection: "first",
  priceTiers: [{ minPrice: "0", maxPrice: "999999999", value: "9", reduction: "0", purchaseLimit: "20" }],
  pricePrecision: "2", priceFraction: "", autoMinPrice15: false, nameMode: "random",
  orderExpireSeconds: "1800", warmupEnabled: false, warmupMinutes: "15",
  newUserDurationDays: "30", newUserNameMode: "default", newUserNamePrefix: "", newUserFloatingAmount: true,
  newUserReductionAmount: "2", newUserMaximumReductionAmount: "3", newUserAverageDiscount: "9", newUserMaximumDiscount: "8.9",
  newUserMaximumDiscountValue: "3", newUserProductsPerActivity: "200", couponType: "product", thresholdAmount: "",
  couponValidityMode: "same", couponValidDays: "5", couponUseStartTime: "", couponUseEndTime: "",
  couponNameMode: "default", couponNamePrefix: "", couponProductsPerCoupon: "200"
};

function initialDraft(feature: MarketingFeature, stored: Partial<MarketingDraft>) {
  if (feature === "general_coupon") {
    const times = generalCouponInitialTimes();
    return {
      ...defaultDraft,
      discountValue: "8",
      issueCount: "5",
      perUserLimit: "1",
      ...stored,
      startTime: stored.startTime || times.startTime,
      endTime: stored.endTime || times.endTime,
      couponUseStartTime: stored.couponUseStartTime || times.couponUseStartTime,
      couponUseEndTime: stored.couponUseEndTime || times.couponUseEndTime
    };
  }
  if (feature === "new_user_bonus") {
    const times = newUserBonusInitialTimes(Number(stored.newUserDurationDays || 30));
    const value = {
      ...defaultDraft,
      discountMode: "reduce" as const,
      discountValue: "2",
      ...stored,
      startTime: stored.startTime || times.startTime,
      endTime: stored.endTime || times.endTime
    };
    if (value.discountMode === "discount") {
      if (stored.newUserAverageDiscount === undefined) value.newUserAverageDiscount = value.discountValue;
      if (stored.newUserMaximumDiscount === undefined) value.newUserMaximumDiscount = value.newUserMaximumDiscountValue;
    } else {
      if (stored.newUserReductionAmount === undefined) value.newUserReductionAmount = value.discountValue;
      if (stored.newUserMaximumReductionAmount === undefined) value.newUserMaximumReductionAmount = value.newUserMaximumDiscountValue;
    }
    return value;
  }
  return { ...defaultDraft, ...stored, ...(feature === "limited_time" ? { scope: "product" as const } : {}) };
}

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
  const [draft, setDraft] = useState<MarketingDraft>(() => {
    const stored = storageGet<Partial<MarketingDraft>>(copy.draftKey, {});
    return initialDraft(feature, stored);
  });
  const [products, setProducts] = useState<MarketingEntity[]>([]);
  const [productFilter, setProductFilter] = useState("");
  const [entities, setEntities] = useState<MarketingEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("");
  const [shopFilter, setShopFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [activityTypeFilter, setActivityTypeFilter] = useState("all");
  const [discountTypeFilter, setDiscountTypeFilter] = useState("all");
  const [minimumProductCount, setMinimumProductCount] = useState("");
  const [maximumProductCount, setMaximumProductCount] = useState("");
  const [activityStartFilter, setActivityStartFilter] = useState("");
  const [activityEndFilter, setActivityEndFilter] = useState("");
  const [detailEntity, setDetailEntity] = useState<MarketingEntity | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadedListKey, setLoadedListKey] = useState("");
  const [activeOperationId, setActiveOperationId] = useState("");
  const [progress, setProgress] = useState<DoudianProgressDetail | null>(null);
  const [selectedProductKeys, setSelectedProductKeys] = useState<Set<string>>(new Set());
  const [selectedEntityKeys, setSelectedEntityKeys] = useState<Set<string>>(new Set());
  const [storeOverrides, setStoreOverrides] = useState<Record<string, Partial<MarketingDraft>>>({});
  const [pendingAction, setPendingAction] = useState<{ action: MarketingAction; target?: MarketingEntity } | null>(null);
  const [managementProductIds, setManagementProductIds] = useState("");
  const [productImportIds, setProductImportIds] = useState("");

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
  const productSelectionVisible = feature === "limited_time" || draft.scope === "product";
  const entityShopOptions = useMemo(() => buildMarketingEntityShopOptions(entities, selectedStores), [entities, selectedStores]);
  useEffect(() => {
    if (shopFilter !== "all" && !entityShopOptions.some((store) => store.id === shopFilter)) setShopFilter("all");
  }, [entityShopOptions, shopFilter]);
  const filteredEntities = entities.filter((entity) => {
    const matchesText = !filter || `${entity.name} ${entity.entityId} ${entity.shopName}`.toLowerCase().includes(filter.toLowerCase());
    const matchesShop = shopFilter === "all" || entity.shopId === shopFilter;
    const matchesStatus = statusFilter === "all" || entity.status === statusFilter;
    const matchesActivityType = activityTypeFilter === "all" || entity.activityType === activityTypeFilter;
    const matchesDiscountType = discountTypeFilter === "all" || entity.discountType === discountTypeFilter;
    const matchesMinimum = !minimumProductCount || entity.productCount >= Number(minimumProductCount);
    const matchesMaximum = !maximumProductCount || entity.productCount <= Number(maximumProductCount);
    const startsAfter = !activityStartFilter || Date.parse(entity.startTime) >= Date.parse(activityStartFilter);
    const endsBefore = !activityEndFilter || Date.parse(entity.endTime) <= Date.parse(activityEndFilter);
    return matchesText && matchesShop && matchesStatus && matchesActivityType && matchesDiscountType && matchesMinimum && matchesMaximum && startsAfter && endsBefore;
  });
  const filteredEntityKeys = marketingEntityKeys(filteredEntities);
  const selectedFilteredCount = filteredEntityKeys.filter((key) => selectedEntityKeys.has(key)).length;
  const allFilteredSelected = filteredEntityKeys.length > 0 && selectedFilteredCount === filteredEntityKeys.length;
  const someFilteredSelected = selectedFilteredCount > 0 && !allFilteredSelected;
  const selectedEntityRows = entities.filter((entity) => selectedEntityKeys.has(`${entity.shopId}:${entity.entityId}`));
  const turnOfficialRenewOn = !selectedEntityRows.length || !selectedEntityRows.every((entity) => entity.autoRenew);
  const turnToolRenewOn = !selectedEntityRows.length || !selectedEntityRows.every((entity) => entity.toolRenew);
  const managementActions: Array<{ action: MarketingWriteAction; label: string; icon: typeof StopCircle }> = feature === "limited_time"
    ? [{ action: "disable", label: "失效", icon: TicketX }, { action: "end", label: "删除", icon: Trash2 }, { action: "toggle_renew", label: turnOfficialRenewOn ? "开启官方续期" : "关闭官方续期", icon: TimerReset }, { action: "revive", label: "复活", icon: TimerReset }, { action: "copy", label: "复制", icon: Copy }, { action: "bulk_edit", label: "批量编辑", icon: Edit3 }, { action: "remove_products", label: "删除单品", icon: Trash2 }, { action: "tool_renew", label: turnToolRenewOn ? "开启工具续期" : "关闭工具续期", icon: TimerReset }]
    : feature === "general_coupon" ? [{ action: "cancel", label: "作废", icon: TicketX }, { action: "toggle_renew", label: turnOfficialRenewOn ? "开启官方续期" : "关闭官方续期", icon: TimerReset }]
      : [{ action: "disable", label: "作废", icon: TicketX }];
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
  const selectedEntitiesByShop = useMemo(() => {
    const output: Record<string, MarketingEntity[]> = {};
    for (const entity of entities) {
      if (!selectedEntityKeys.has(`${entity.shopId}:${entity.entityId}`)) continue;
      (output[entity.shopId] ||= []).push(entity);
    }
    return output;
  }, [entities, selectedEntityKeys]);
  const createErrors = selectedStores.flatMap((store) => marketingTaskInputErrors({
    feature,
    action: "create",
    stores: [{ shopId: store.id, shopName: store.name, partition: store.partition, tenantId: store.tenantId, storeGeneration: store.storeGeneration }],
    context: {
      ...draft,
      ...storeOverrides[store.id],
      productIds: productIdsByShop[store.id] || [],
      productIdsByShop: { [store.id]: productIdsByShop[store.id] || [] },
      selectedProducts: selectedProductsByShop[store.id] || []
    }
  }));
  const createReady = selectedStores.length > 0 && createErrors.length === 0;

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

  function updateNewUserDraft(next: MarketingDraft) {
    const eligibilityChanged = (["scope", "startTime", "endTime", "discountMode", "discountValue"] as const)
      .some((key) => draft[key] !== next[key]);
    setDraft(next);
    if (!eligibilityChanged) return;
    if (products.length) setMessage("活动时间或优惠已更新，请重新加载商品资格");
    setProducts([]);
    setSelectedProductKeys(new Set());
  }

  function toggleEntity(entity: MarketingEntity) {
    const key = `${entity.shopId}:${entity.entityId}`;
    setSelectedEntityKeys((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  function toggleFilteredEntities() {
    setSelectedEntityKeys((current) => toggleMarketingEntitySelection(current, filteredEntityKeys));
  }

  function requestAction(action: MarketingAction, target?: MarketingEntity) {
    if (action === "create") {
      if (draft.scope === "product") {
        const missingStore = selectedStores.find((store) => !(productIdsByShop[store.id] || []).length);
        if (missingStore) { setMessage(`请先为店铺“${missingStore.name}”选择商品`); return; }
      }
      setPendingAction({ action });
      return;
    }
    if (!target && !selectedEntityKeys.size) { setMessage("请先选择活动"); return; }
    setPendingAction({ action, target });
  }

  async function attachToolRenewFlags(rows: MarketingEntity[]) {
    if (feature !== "limited_time" || !rows.length) return rows;
    const activeIds = new Set<string>();
    let cursor = null;
    for (;;) {
      const page = await queryMarketingSchedules({ cursor, pageSize: 500 });
      page.items.forEach((schedule) => {
        if (["active", "running"].includes(schedule.status)) activeIds.add(`${schedule.shopId}:${schedule.entityId}`);
      });
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return rows.map((row) => ({ ...row, toolRenew: activeIds.has(`${row.shopId}:${row.entityId}`) }));
  }

  async function toggleToolRenewSchedules() {
    if (!adapter) return;
    const targets = entities.filter((entity) => selectedEntityKeys.has(`${entity.shopId}:${entity.entityId}`));
    const schedules: MarketingSchedule[] = [];
    let cursor = null;
    for (;;) {
      const page = await queryMarketingSchedules({ cursor, pageSize: 500 });
      schedules.push(...page.items);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const existing = targets.map((entity) => schedules.find((schedule) => schedule.shopId === entity.shopId && schedule.entityId === entity.entityId) || null);
    const enable = !existing.every((schedule) => schedule && ["active", "running"].includes(schedule.status));
    const now = Date.now();
    let changed = 0;
    const changedKeys = new Set<string>();
    for (let index = 0; index < targets.length; index += 1) {
      const entity = targets[index];
      const store = stores.find((item) => item.id === entity.shopId);
      if (!store) continue;
      const start = Date.parse(entity.startTime);
      const end = Date.parse(entity.endTime);
      const duration = end - start;
      const flash = ["flash", "LimitTime", "限时抢购"].includes(entity.activityType || "");
      if (enable && (!flash || !Number.isFinite(duration) || duration < 24 * 60 * 60 * 1000 || duration > 4 * 24 * 60 * 60 * 1000 || now >= end - 24 * 60 * 60 * 1000)) continue;
      const previous = existing[index];
      const timestamp = new Date().toISOString();
      await saveMarketingSchedule({
        id: previous?.id || `marketing:schedule:limited_time:${store.id}:${entity.entityId}`,
        kind: "marketing-schedule", feature: "limited_time", action: "tool_renew", shopId: store.id, entityId: entity.entityId,
        partition: store.partition, tenantId: store.tenantId, storeGeneration: store.storeGeneration,
        adapterSnapshotHash: marketingAdapterSnapshotHash(adapter), intervalMs: Math.max(24 * 60 * 60 * 1000, duration),
        nextRunAt: new Date(Math.max(now, end - 24 * 60 * 60 * 1000)).toISOString(), status: enable ? "active" : "paused",
        failureCount: previous?.failureCount || 0, createdAt: previous?.createdAt || timestamp, updatedAt: timestamp
      });
      changed += 1;
      changedKeys.add(`${entity.shopId}:${entity.entityId}`);
    }
    setEntities((current) => current.map((entity) => changedKeys.has(`${entity.shopId}:${entity.entityId}`) ? { ...entity, toolRenew: enable } : entity));
    setSelectedEntityKeys(new Set());
    setPendingAction(null);
    const skipped = targets.length - changed;
    setMessage(`${enable ? "已开启" : "已关闭"} ${changed} 个工具续期计划${skipped ? `，${skipped} 个活动不满足条件` : ""}`);
  }

  async function runAction(action: MarketingAction, target?: MarketingEntity, options: { silent?: boolean; context?: Record<string, unknown> } = {}): Promise<MarketingTaskResult | null> {
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
          context: { ...draft, ...(feature === "limited_time" ? { scope: "product", timeSegments: limitedTimeActivitySegments(draft as unknown as Record<string, unknown>) } : {}), ...(target ? { entityId: target.entityId, entityIds: [target.entityId], selectedEntity: target } : {}), ...(action !== "create" && !target ? { entityIds: [...selectedEntityKeys].map((key) => key.slice(key.indexOf(":") + 1)) } : {}), productIds: Object.values(productIdsByShop).flat(), productIdsByShop, selectedProductsByShop, entityIdsByShop, selectedEntitiesByShop, storeOverrides, ...(action === "remove_products" ? { productIds: [...new Set(managementProductIds.split(/[\s,，]+/).map((value) => value.trim()).filter(Boolean))].slice(0, 100) } : {}), ...(action === "bulk_edit" ? { fields: { startTime: draft.startTime, endTime: draft.endTime, discountValue: draft.discountValue } } : {}), ...(action === "toggle_renew" ? { renewOn: turnOfficialRenewOn } : {}), ...(action === "tool_renew" ? { intervalDays: Number(draft.toolRenewIntervalDays) } : {}), ...(options.context || {}) },
          config,
          doudianAdapter: adapter
        }
      }, 900000) as unknown as MarketingTaskResult;
      if (action === "load_products") { setProducts(result.entities || []); const liveKeys = new Set((result.entities || []).filter((entity) => !entity.platformError && entity.eligible !== false).map((entity) => `${entity.shopId}:${entity.entityId}`)); setSelectedProductKeys((current) => new Set([...current].filter((key) => liveKeys.has(key)))); }
      else if (action === "list") setEntities(await attachToolRenewFlags(result.entities || []));
      else if (action === "detail" && !options.silent) setDetailEntity(result.entities?.[0] || { ...target!, platformError: result.message || "平台未返回详情" });
      if (action === "create" && feature === "limited_time" && draft.toolRenew && actionEnabled("tool_renew") && ["ok", "partial"].includes(result.status)) {
        await Promise.all((result.entities || []).map((entity) => {
          const store = actionStores.find((item) => item.id === entity.shopId);
          if (!store) return Promise.resolve();
          const start = Date.parse(entity.startTime);
          const end = Date.parse(entity.endTime);
          const intervalMs = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 4 * 24 * 60 * 60 * 1000;
          const now = new Date().toISOString();
          return saveMarketingSchedule({ id: `marketing:schedule:limited_time:${store.id}:${entity.entityId}`, kind: "marketing-schedule", feature, action: "tool_renew", shopId: store.id, entityId: entity.entityId, partition: store.partition, tenantId: store.tenantId, storeGeneration: store.storeGeneration, adapterSnapshotHash: marketingAdapterSnapshotHash(adapter), intervalMs, nextRunAt: new Date(Math.max(Date.now(), end - 24 * 60 * 60 * 1000)).toISOString(), status: "active", failureCount: 0, createdAt: now, updatedAt: now });
        }));
      }
      if (action === "create" && ["ok", "partial"].includes(result.status)) { setTab("manage"); setLoadedListKey(""); }
      if (managementAction && ["ok", "partial"].includes(result.status)) setLoadedListKey("");
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
    if (pending.action === "tool_renew") { await toggleToolRenewSchedules(); return; }
    if (pending.action === "remove_products") {
      if (!managementProductIds.trim()) { setMessage("请输入待移除商品ID"); return; }
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
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#ff5020] px-3 text-[12px] font-semibold text-white hover:bg-[#e94316] disabled:cursor-not-allowed disabled:bg-[#f2b5a3]" type="button" disabled={!writeEnabled || !createReady || loading} onClick={() => requestAction("create")} title={!writeEnabled ? "写入开关或平台合同未开放" : !createReady ? createErrors[0] || "请完成活动配置" : copy.createTab}><Plus className="size-4" />{copy.createTab}</button>
          </div>
        </header>
        <nav className="flex h-10 shrink-0 items-end gap-5 border-b border-[#e6ebf3] px-4 text-[12px] font-semibold">
          {([['create', copy.createTab], ['manage', `${copy.entityLabel}管理`], ['history', '执行记录'], ...(feature === "limited_time" ? [["renewals", "续期记录"]] as const : [])] as const).map(([value, label]) => <button key={value} className={`relative h-10 px-1 ${tab === value ? "text-[#073b7a]" : "text-[#667085]"}`} type="button" onClick={() => setTab(value)}>{label}{tab === value ? <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[#ff5020]" /> : null}</button>)}
        </nav>
        {activeOperationId && progress?.operationId === activeOperationId ? <div className="border-b border-[#e6ebf3] bg-[#fffaf6] px-4 py-2"><div className="flex items-center justify-between gap-3 text-[11px] text-[#52627a]"><span className="min-w-0 truncate">{progress.status === "cancelling" ? "正在停止任务" : progress.message || "营销任务执行中"}</span><div className="flex shrink-0 items-center gap-2"><strong>{Math.round(Math.max(0, Math.min(100, progress.progress || 0)))}%</strong><button className="font-semibold text-[#b42318]" type="button" onClick={() => void cancelActiveTask()}>停止</button></div></div><div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#f4d8c8]"><span className="block h-full rounded-full bg-[#ff5020] transition-[width]" style={{ width: `${Math.max(0, Math.min(100, progress.progress || 0))}%` }} /></div></div> : null}
        {tab === "create" ? <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid grid-cols-4 gap-x-4 gap-y-3 px-4 py-4 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1">
            {feature === "general_coupon" ? <GeneralCouponCreateFields draft={draft} onChange={setDraft} /> : feature === "new_user_bonus" ? <NewUserBonusCreateFields draft={draft} onChange={updateNewUserDraft} /> : <>
              {feature !== "limited_time" ? <label className="col-span-2 max-[600px]:col-span-1"><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">活动范围</span><MarketingScopeSelector value={draft.scope} labels={[{ value: "product", label: copy.scopeLabels[0] }, { value: "shop", label: copy.scopeLabels[1] }]} onChange={(scope) => setDraft({ ...draft, scope: scope as MarketingDraft["scope"] })} /></label> : null}
              <label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">开始时间</span><input type="datetime-local" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px] outline-none focus:border-[#ff5020]" value={draft.startTime} onChange={(event) => { const startTime = event.target.value; setDraft({ ...draft, startTime, ...(feature === "limited_time" && draft.timeMode === "preset" ? { endTime: limitedTimePresetEndTime(startTime, draft.activityDurationMinutes) } : {}) }); }} /></label>
              <label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">结束时间</span><input type="datetime-local" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px] outline-none focus:border-[#ff5020] disabled:bg-[#f5f7fa] disabled:text-[#667085]" value={draft.endTime} disabled={feature === "limited_time" && draft.timeMode === "preset"} onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} /></label>
              {feature !== "limited_time" ? <><label className="col-span-2 max-[600px]:col-span-1"><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">名称</span><input className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px] outline-none focus:border-[#ff5020]" placeholder={`${copy.title}名称`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">优惠方式</span><select className="h-8 w-full rounded-md border border-[#dbe3ee] bg-white px-2 text-[12px]" value={draft.discountMode} onChange={(event) => setDraft({ ...draft, discountMode: event.target.value as MarketingDraft["discountMode"] })}><option value="discount">折扣</option><option value="reduce">立减</option></select></label><label><span className="mb-1.5 block text-[12px] font-semibold text-[#344054]">优惠值</span><input type="number" min="0" step="0.1" className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px]" value={draft.discountValue} onChange={(event) => setDraft({ ...draft, discountValue: event.target.value })} /></label></> : <LimitedTimeCreateFields draft={draft} onChange={setDraft} />}
              {feature !== "limited_time" ? <label className="flex items-end"><span className="inline-flex h-8 items-center gap-2 text-[12px] font-semibold text-[#344054]"><input type="checkbox" checked={draft.officialRenew} onChange={(event) => setDraft({ ...draft, officialRenew: event.target.checked })} />平台官方续期</span></label> : null}
            </>}
            {productSelectionVisible ? <div className="flex items-end justify-end"><button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe3ee] px-3 text-[12px] font-semibold text-[#344054] hover:border-[#ff5020] hover:text-[#073b7a] disabled:opacity-50" type="button" disabled={loading} onClick={() => void runAction("load_products", undefined, feature === "general_coupon" ? { context: { productLoadMode: "full" } } : {})}><ShieldCheck className="size-4" />校验商品资格</button></div> : null}
          </div>
          {feature === "general_coupon" && draft.scope === "shop" ? <GeneralCouponStoreOverrides draft={draft} stores={selectedStores} overrides={storeOverrides} onChange={setStoreOverrides} /> : feature === "new_user_bonus" && draft.scope === "shop" ? <NewUserBonusStoreOverrides draft={draft} stores={selectedStores} overrides={storeOverrides} onChange={setStoreOverrides} /> : selectedStores.length > 1 && feature === "limited_time" ? <div className="border-b border-[#e6ebf3] px-4 pb-3"><div className="mb-2 flex items-center justify-between text-[11px] text-[#667085]"><span className="font-semibold text-[#344054]">逐店参数覆盖</span><span>不填写则使用上方默认参数</span></div><div className="grid grid-cols-2 gap-2 max-[760px]:grid-cols-1">{selectedStores.map((store) => <label className="flex items-center gap-2 text-[11px] text-[#52627a]" key={store.id}><span className="min-w-0 flex-1 truncate" title={store.name}>{store.name}</span><input className="h-7 w-24 rounded-md border border-[#dbe3ee] px-2 text-[11px]" type="number" min="0" step="0.1" placeholder={draft.discountValue} value={storeOverrides[store.id]?.discountValue || ""} onChange={(event) => setStoreOverrides((current) => ({ ...current, [store.id]: { ...current[store.id], discountValue: event.target.value } }))} aria-label={`${store.name}优惠值`} /></label>)}</div></div> : null}
          {productSelectionVisible ? <MarketingProductTable rows={filteredProducts} totalRows={products.length} search={productFilter} loading={loading} selectedIds={selectedProductKeys} importValue={productImportIds} onToggle={toggleProduct} onToggleAll={toggleProducts} onSearch={setProductFilter} onRefresh={() => void runAction("load_products", undefined, { context: { productLoadMode: "full" } })} onQuickLoad={feature !== "limited_time" ? () => void runAction("load_products", undefined, { context: { productLoadMode: "quick" } }) : undefined} onImportValueChange={feature !== "limited_time" ? setProductImportIds : undefined} onImport={feature !== "limited_time" ? () => { const importProductIds = [...new Set(productImportIds.split(/[\s,，]+/).map((value) => value.trim()).filter(Boolean))]; void runAction("load_products", undefined, { context: { productLoadMode: "import", importProductIds } }); } : undefined} /> : null}
        </div> : tab === "manage" ? <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-[50px] items-center gap-2 border-b border-[#e6ebf3] px-4 max-[600px]:flex-wrap max-[600px]:py-2">
            <label className="relative min-w-[220px] flex-1 max-w-[420px]"><Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#98a2b3]" /><input className="h-8 w-full rounded-md border border-[#dbe3ee] pl-8 pr-2 text-[12px]" placeholder={`搜索${copy.entityLabel}名称或 ID`} value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
            <label className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe3ee] px-2 text-[12px] font-semibold text-[#344054]"><ListFilter className="size-4" /><select className="bg-transparent outline-none" aria-label="按状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option>{Array.from(new Set(entities.map((entity) => entity.status).filter(Boolean))).map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
            <div className="flex items-center gap-1 max-[600px]:order-3 max-[600px]:w-full">{managementActions.map(({ action, label, icon: Icon }) => <button key={action} className="inline-flex h-8 items-center gap-1 rounded-md border border-[#dbe3ee] px-2 text-[11px] font-semibold text-[#344054] hover:border-[#ff5020] hover:text-[#073b7a] disabled:cursor-not-allowed disabled:opacity-45" type="button" disabled={!actionEnabled(action) || loading || !selectedEntityKeys.size} title={actionEnabled(action) ? label : "此动作尚未通过平台合同门禁"} onClick={() => requestAction(action)}><Icon className="size-3.5" />{label}</button>)}</div>
            <button className="ml-auto grid size-8 place-items-center rounded-md border border-[#dbe3ee] text-[#52627a] disabled:opacity-50" type="button" title="刷新列表" aria-label="刷新列表" disabled={loading} onClick={() => void runAction("list")}><RefreshCcw className={`size-4 ${loading ? "animate-spin" : ""}`} /></button>
          </div>
          <div className="flex min-h-9 items-center gap-3 border-b border-[#e6ebf3] bg-white px-4 text-[11px] text-[#667085] max-[600px]:flex-wrap max-[600px]:py-1.5">
            <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#dbe3ee] bg-[#f8fafc] px-2 font-semibold text-[#344054]"><ListFilter className="size-3.5" /><select className="max-w-[220px] bg-transparent outline-none" aria-label="按店铺筛选" value={shopFilter} onChange={(event) => setShopFilter(event.target.value)}><option value="all">全部店铺（{entities.length} 条）</option>{entityShopOptions.map((store) => <option value={store.id} key={store.id}>{store.name}（{store.count} 条）</option>)}</select></label>
            <span>共 <strong className="text-[#1d2939]">{entities.length}</strong> 条</span>
            <span>当前筛选 <strong className="text-[#1d2939]">{filteredEntities.length}</strong> 条</span>
            <span>已选 <strong className="text-brand-fox">{selectedEntityKeys.size}</strong> 条</span>
            {shopFilter !== "all" ? <span className="truncate">{entityShopOptions.find((store) => store.id === shopFilter)?.name || shopFilter}</span> : null}
          </div>
          {feature === "general_coupon" ? <div className="grid grid-cols-4 gap-2 border-b border-[#e6ebf3] bg-[#f8fafc] px-4 py-2 max-[760px]:grid-cols-2"><select className="h-7 rounded-md border border-[#dbe3ee] bg-white px-2 text-[11px]" aria-label="按优惠券类型筛选" value={activityTypeFilter} onChange={(event) => setActivityTypeFilter(event.target.value)}><option value="all">全部优惠券类型</option>{Array.from(new Set(entities.map((entity) => entity.activityType).filter(Boolean))).map((value) => <option key={value} value={value}>{value}</option>)}</select><select className="h-7 rounded-md border border-[#dbe3ee] bg-white px-2 text-[11px]" aria-label="按优惠方式筛选" value={discountTypeFilter} onChange={(event) => setDiscountTypeFilter(event.target.value)}><option value="all">全部优惠方式</option>{Array.from(new Set(entities.map((entity) => entity.discountType).filter(Boolean))).map((value) => <option key={value} value={value}>{value}</option>)}</select><input className="h-7 rounded-md border border-[#dbe3ee] px-2 text-[11px]" type="datetime-local" aria-label="领取开始筛选" value={activityStartFilter} onChange={(event) => setActivityStartFilter(event.target.value)} /><input className="h-7 rounded-md border border-[#dbe3ee] px-2 text-[11px]" type="datetime-local" aria-label="领取结束筛选" value={activityEndFilter} onChange={(event) => setActivityEndFilter(event.target.value)} /></div> : feature === "limited_time" ? <div className="grid grid-cols-6 gap-2 border-b border-[#e6ebf3] bg-[#f8fafc] px-4 py-2 max-[980px]:grid-cols-3 max-[600px]:grid-cols-2"><select className="h-7 rounded-md border border-[#dbe3ee] bg-white px-2 text-[11px]" aria-label="按活动类型筛选" value={activityTypeFilter} onChange={(event) => setActivityTypeFilter(event.target.value)}><option value="all">全部活动类型</option>{Array.from(new Set(entities.map((entity) => entity.activityType).filter(Boolean))).map((value) => <option key={value} value={value}>{value}</option>)}</select><select className="h-7 rounded-md border border-[#dbe3ee] bg-white px-2 text-[11px]" aria-label="按优惠类型筛选" value={discountTypeFilter} onChange={(event) => setDiscountTypeFilter(event.target.value)}><option value="all">全部优惠类型</option>{Array.from(new Set(entities.map((entity) => entity.discountType).filter(Boolean))).map((value) => <option key={value} value={value}>{value}</option>)}</select><input className="h-7 rounded-md border border-[#dbe3ee] px-2 text-[11px]" type="number" min="0" placeholder="最少商品数" value={minimumProductCount} onChange={(event) => setMinimumProductCount(event.target.value)} /><input className="h-7 rounded-md border border-[#dbe3ee] px-2 text-[11px]" type="number" min="0" placeholder="最多商品数" value={maximumProductCount} onChange={(event) => setMaximumProductCount(event.target.value)} /><input className="h-7 rounded-md border border-[#dbe3ee] px-2 text-[11px]" type="datetime-local" aria-label="活动开始筛选" value={activityStartFilter} onChange={(event) => setActivityStartFilter(event.target.value)} /><input className="h-7 rounded-md border border-[#dbe3ee] px-2 text-[11px]" type="datetime-local" aria-label="活动结束筛选" value={activityEndFilter} onChange={(event) => setActivityEndFilter(event.target.value)} /></div> : <div className="grid grid-cols-2 gap-2 border-b border-[#e6ebf3] bg-[#f8fafc] px-4 py-2 max-[600px]:grid-cols-1"><input className="h-7 rounded-md border border-[#dbe3ee] px-2 text-[11px]" type="datetime-local" aria-label="活动开始筛选" value={activityStartFilter} onChange={(event) => setActivityStartFilter(event.target.value)} /><input className="h-7 rounded-md border border-[#dbe3ee] px-2 text-[11px]" type="datetime-local" aria-label="活动结束筛选" value={activityEndFilter} onChange={(event) => setActivityEndFilter(event.target.value)} /></div>}
          <div className="min-h-0 flex-1 overflow-auto">{feature === "general_coupon" ? <GeneralCouponManagementTable rows={filteredEntities} selectedKeys={selectedEntityKeys} onToggle={toggleEntity} onToggleAll={() => toggleFilteredEntities()} onDetail={(entity) => void runAction("detail", entity)} /> : filteredEntities.length ? <table className="w-full min-w-[1200px] border-collapse text-left text-[12px]"><thead><tr className="sticky top-0 border-b border-[#e6ebf3] bg-[#f8fafc] text-[#667085]"><th className="w-10 px-4 py-3"><button className="grid size-6 place-items-center text-[#52627a]" type="button" title={allFilteredSelected ? "取消选择当前筛选结果" : "选择当前筛选结果"} aria-label={allFilteredSelected ? "取消选择当前筛选结果" : "选择当前筛选结果"} onClick={toggleFilteredEntities}>{allFilteredSelected ? <CheckSquare className="size-4 text-[#ff5020]" /> : someFilteredSelected ? <SquareMinus className="size-4 text-[#ff5020]" /> : <Square className="size-4" />}</button></th><th className="px-2 py-3">名称 / ID</th><th className="px-3 py-3">店铺</th><th className="px-3 py-3">时间</th><th className="px-3 py-3">商品数</th>{feature === "limited_time" ? <><th className="px-3 py-3">活动类型</th><th className="px-3 py-3">优惠类型</th><th className="px-3 py-3">续期</th></> : <><th className="px-3 py-3">范围</th><th className="px-3 py-3">续期</th></>}<th className="px-3 py-3">状态</th><th className="px-3 py-3">操作</th></tr></thead><tbody>{filteredEntities.map((entity, index) => { const key = `${entity.shopId}:${entity.entityId}`; const selected = selectedEntityKeys.has(key); const canDisable = ["2", "3"].includes(entity.rawStatus || ""); return <tr key={`${entity.shopId}-${entity.entityId}-${index}`} className={`border-b border-[#edf1f6] ${selected ? "bg-[#fffaf6]" : ""}`}><td className="px-4 py-3"><button className="grid size-6 place-items-center text-[#52627a]" type="button" title={selected ? "取消选择活动" : "选择活动"} aria-label={selected ? "取消选择活动" : "选择活动"} onClick={() => toggleEntity(entity)}>{selected ? <CheckSquare className="size-4 text-[#ff5020]" /> : <Square className="size-4" />}</button></td><td className="px-2 py-3"><strong className="block max-w-[280px] truncate text-[#1d2939]">{entity.name}</strong><span className="font-mono text-[11px] text-[#98a2b3]">{entity.entityId}</span></td><td className="px-3 py-3">{entity.shopName}</td><td className="px-3 py-3 text-[#52627a]">{entity.startTime || "-"}<br />{entity.endTime || "-"}</td><td className="px-3 py-3">{entity.productCount}</td>{feature === "limited_time" ? <><td className="px-3 py-3">{entity.activityType || "-"}</td><td className="px-3 py-3">{entity.discountType || "-"}</td><td className="px-3 py-3 text-[11px] text-[#52627a]">{entity.autoRenew ? "官方" : ""}{entity.autoRenew && entity.toolRenew ? " / " : ""}{entity.toolRenew ? "工具" : ""}{!entity.autoRenew && !entity.toolRenew ? "-" : ""}</td></> : <><td className="px-3 py-3">{entity.activityType || "-"}</td><td className="px-3 py-3">{entity.autoRenew ? "已开启" : "-"}</td></>}<td className="px-3 py-3"><span className={`inline-flex rounded-sm border px-2 py-0.5 text-[11px] ${statusTone(entity.status)}`}>{entity.status}</span></td><td className="px-3 py-3"><div className="flex items-center gap-3"><button className="text-[12px] font-semibold text-[#073b7a]" type="button" onClick={() => void runAction("detail", entity)}>详情</button>{feature === "new_user_bonus" && canDisable ? <button className="text-[12px] font-semibold text-[#b42318] disabled:opacity-45" type="button" disabled={!actionEnabled("disable") || loading} onClick={() => requestAction("disable", entity)}>快速失效</button> : null}</div></td></tr>; })}</tbody></table> : <div className="grid min-h-[300px] place-items-center text-[12px] text-[#667085]">当前筛选条件下暂无{copy.entityLabel}</div>}</div>
        </div> : <MarketingExecutionHistory feature={feature} action={tab === "renewals" ? "tool_renew" : undefined} />}
      </section>
      {pendingAction ? <MarketingRunDialog feature={feature} draft={draft} action={pendingAction.action} productIdsText={managementProductIds} onDraftChange={setDraft} onProductIdsChange={setManagementProductIds} stores={selectedStores.map((store) => { const productCount = pendingAction.action === "create" ? (draft.scope === "shop" ? 0 : productIdsByShop[store.id]?.length || 0) : entityIdsByShop[store.id]?.length || 0; const activityCount = pendingAction.action !== "create" ? undefined : feature === "limited_time" ? splitLimitedTimeCreateBatches({ ...draft, productIds: productIdsByShop[store.id] || [], selectedProducts: selectedProductsByShop[store.id] || [], timeSegments: limitedTimeActivitySegments(draft as unknown as Record<string, unknown>) }).length : feature === "general_coupon" ? splitGeneralCouponCreateBatches({ ...draft, ...storeOverrides[store.id], productIds: productIdsByShop[store.id] || [], selectedProducts: selectedProductsByShop[store.id] || [] }).length : splitNewUserBonusCreateBatches({ ...draft, ...storeOverrides[store.id], productIds: productIdsByShop[store.id] || [], selectedProducts: selectedProductsByShop[store.id] || [] }).length; return { shopId: store.id, shopName: store.name, productCount, activityCount, override: storeOverrides[store.id] }; })} onCancel={() => setPendingAction(null)} onConfirm={() => void confirmPendingAction()} /> : null}
      {detailEntity ? <div className="fixed inset-0 z-40 grid place-items-center bg-[#002050]/25 px-4" role="presentation" onClick={() => !detailLoading && setDetailEntity(null)}><section className="max-h-[min(680px,calc(100vh-32px))] w-full max-w-[560px] overflow-auto rounded-lg border border-[#dbe3ee] bg-white shadow-[0_18px_60px_rgba(0,32,80,0.2)]" role="dialog" aria-modal="true" aria-label={`${copy.entityLabel}详情`} onClick={(event) => event.stopPropagation()}><header className="flex items-center justify-between border-b border-[#e6ebf3] px-4 py-3"><div><h2 className="m-0 text-[15px] font-bold text-[#002050]">{copy.entityLabel}详情</h2><p className="m-0 mt-1 font-mono text-[11px] text-[#98a2b3]">{detailEntity.entityId || "-"}</p></div><button className="grid size-8 place-items-center rounded-md text-[#52627a] hover:bg-[#f8fafc]" type="button" title="关闭详情" aria-label="关闭详情" disabled={detailLoading} onClick={() => setDetailEntity(null)}><X className="size-4" /></button></header><div className="grid grid-cols-2 gap-3 px-4 py-4 text-[12px] max-[560px]:grid-cols-1"><div><span className="text-[#98a2b3]">名称</span><strong className="mt-1 block break-words text-[#1d2939]">{detailEntity.name || "-"}</strong></div><div><span className="text-[#98a2b3]">店铺</span><strong className="mt-1 block break-words text-[#1d2939]">{detailEntity.shopName || detailEntity.shopId || "-"}</strong></div><div><span className="text-[#98a2b3]">状态</span><span className={`mt-1 inline-flex rounded-sm border px-2 py-0.5 ${statusTone(detailEntity.status)}`}>{detailEntity.status || "未知"}</span></div><div><span className="text-[#98a2b3]">商品数</span><strong className="mt-1 block text-[#1d2939]">{detailEntity.productCount || 0}</strong></div><div><span className="text-[#98a2b3]">开始时间</span><strong className="mt-1 block break-words text-[#1d2939]">{detailEntity.startTime || "-"}</strong></div><div><span className="text-[#98a2b3]">结束时间</span><strong className="mt-1 block break-words text-[#1d2939]">{detailEntity.endTime || "-"}</strong></div>{feature === "general_coupon" ? <><div><span className="text-[#98a2b3]">优惠内容</span><strong className="mt-1 block text-[#073b7a]">{generalCouponDiscountSummary(detailEntity)}</strong></div><div><span className="text-[#98a2b3]">优惠券类型</span><strong className="mt-1 block text-[#1d2939]">{detailEntity.couponType || detailEntity.activityType || "-"}</strong></div><div><span className="text-[#98a2b3]">使用时间</span><strong className="mt-1 block break-words text-[#1d2939]">{generalCouponUseTimeSummary(detailEntity)}</strong></div><div><span className="text-[#98a2b3]">领取 / 发放 / 核销</span><strong className="mt-1 block text-[#1d2939]">{detailEntity.totalAmount != null && detailEntity.leftAmount != null ? detailEntity.totalAmount - detailEntity.leftAmount : "-"} / {detailEntity.unlimitedStock ? "不限" : detailEntity.totalAmount ?? "-"} / {detailEntity.usedAmount ?? 0}</strong></div><div><span className="text-[#98a2b3]">官方续期</span><strong className="mt-1 block text-[#1d2939]">{detailEntity.autoRenew ? "已开启" : "未开启"}</strong></div></> : null}</div>{detailEntity.platformError ? <div className="mx-4 mb-4 flex items-start gap-2 rounded-md border border-[#ffd1d1] bg-[#fff1f0] px-3 py-2 text-[12px] text-[#b42318]"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 break-words">{detailEntity.platformError}</span></div> : null}</section></div> : null}
    </div>
  );
}
