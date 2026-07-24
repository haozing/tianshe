import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  BookmarkPlus,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Copy,
  Filter,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Store,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cancelDoudianStoreOperation,
  cancelDoudianOpportunityFavorites,
  clearDoudianInvalidOpportunityFavorites,
  fetchDoudianFavoriteCategories,
  fetchDoudianOpportunityFavoriteRecords,
  listDoudianStores,
  runDoudianOpportunityAutoFavorites
} from "../bridge/client";
import { STORAGE_KEY_OPPORTUNITY_FAVORITE_SETTINGS, storageGet, storageSet } from "../bridge/storage";
import { addDoudianProgressListener } from "../domain/doudian/progress";
import { reconcileSelectedShopIds, storeIdentityKey, storeIdentityRef } from "../domain/doudian/opportunityStoreState";
import { toggleStoreIds } from "../domain/doudian/storeSelection";
import { cn } from "../lib/utils";
import type {
  DoudianOpportunityAutoFavoriteFilters,
  DoudianOpportunityAutoFavoriteRow,
  DoudianOpportunityFavoriteCategory,
  DoudianOpportunityFavoriteCategoryPlan,
  DoudianOpportunityFavoriteQueryMode,
  DoudianOpportunityFavoriteRecord,
  DoudianStoreSummary
} from "../types";

interface Choice<T extends string | number = number> {
  value: T;
  label: string;
}

interface StoreFavoriteConfig {
  categoryPlans: DoudianOpportunityFavoriteCategoryPlan[];
  modeIds: string[];
  reasonIds: number[];
  benefitIds: number[];
}

interface FavoriteRecordState {
  rows: DoudianOpportunityFavoriteRecord[];
  total: number;
  totalKnown: boolean;
  cancelSupported: boolean;
  fetched: boolean;
  complete: boolean;
  lastPage: number;
  hasMore: boolean;
  message: string;
}

const FAVORITE_RECORD_PAGE_SIZE = 24;

const queryModes: DoudianOpportunityFavoriteQueryMode[] = [
  { id: "smart", label: "智选搜索词", sortField: "MATCH_DEGREE" },
  { id: "trading-high", label: "成交高", sortField: "TRADING_AMOUNT" },
  { id: "growth-fast", label: "高增速", sortField: "PAY_AMOUNT_RATE" },
  { id: "supply-high", label: "高需供比", sortField: "DEMAND_SUPPLY_RATE" },
  { id: "heat-high", label: "高热度", sortField: "HEAT_OF_DEMAND" },
  { id: "competition-low", label: "少竞品", sortField: "ONLINE_PRODUCT_NUMSO" }
];

const reasonOptions: Choice[] = [
  { value: 35, label: "全网热卖" },
  { value: 14, label: "应季爆发" },
  { value: 31, label: "热度高" },
  { value: 34, label: "销量高" },
  { value: 32, label: "成交增速快" },
  { value: 33, label: "平台缺货" }
];

const benefitOptions: Choice[] = [
  { value: 1, label: "搜索扶持" },
  { value: 3, label: "上新扶持" },
  { value: 16, label: "新品成长激励" },
  { value: 22, label: "猜喜冷启权益" },
  { value: 23, label: "猜喜热卖权益" },
  { value: 24, label: "新奇好物标签" },
  { value: 26, label: "新潮新品扶持" },
  { value: 29, label: "商品卡扶持" }
];

function defaultStoreConfig(): StoreFavoriteConfig {
  return { categoryPlans: [], modeIds: queryModes.map((item) => item.id), reasonIds: [], benefitIds: [] };
}

function normalizeStoredSettings(value: unknown): Record<string, StoreFavoriteConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const rows: Record<string, StoreFavoriteConfig> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) continue;
    const raw = rawValue as Partial<StoreFavoriteConfig>;
    rows[key] = {
      categoryPlans: Array.isArray(raw.categoryPlans) ? raw.categoryPlans.filter((item) => item?.category?.id).map((item) => ({ category: item.category, limit: Math.max(1, Math.min(1000, Math.floor(Number(item.limit) || 100))) })) : [],
      modeIds: Array.isArray(raw.modeIds) ? raw.modeIds.map(String).filter((id) => queryModes.some((item) => item.id === id)) : queryModes.map((item) => item.id),
      reasonIds: Array.isArray(raw.reasonIds) ? raw.reasonIds.map(Number).filter(Number.isFinite) : [],
      benefitIds: Array.isArray(raw.benefitIds) ? raw.benefitIds.map(Number).filter(Number.isFinite) : []
    };
  }
  return rows;
}

function hasNativeStoreBridge() {
  return Boolean(window.chihuNative && (window.nativeData || window.chihuNative.nativeData));
}

function categoryKey(category: DoudianOpportunityFavoriteCategory) {
  return `${category.key}:${category.id}`;
}

function recordKey(row: DoudianOpportunityFavoriteRecord) {
  return `${row.taskId}:${row.clueId}`;
}

function autoFavoriteRowKey(row: DoudianOpportunityAutoFavoriteRow) {
  return `${row.shopId}:${row.clueId || ""}:${row.status}:${row.attemptedAt}:${row.message}`;
}

function SelectionBox({ checked, mixed = false }: { checked: boolean; mixed?: boolean }) {
  return (
    <span className={cn("grid size-4 shrink-0 place-items-center rounded border", checked || mixed ? "border-brand-fox bg-brand-fox text-white" : "border-[#cfd8e6] bg-white text-transparent")}>
      {mixed ? <span className="h-0.5 w-2 rounded bg-current" /> : <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

function ChoiceChips<T extends string | number>({ options, values, disabled, onToggle }: { options: Choice<T>[]; values: readonly T[]; disabled?: boolean; onToggle: (value: T) => void }) {
  const selected = new Set(values);
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button className={cn("h-7 rounded-md border px-2.5 text-[12px] transition-colors", selected.has(option.value) ? "border-[#ff8a45] bg-[#fff4ed] font-semibold text-[#c2410c]" : "border-[#dbe5f2] bg-white text-[#475467] hover:border-[#aebdd0]")} type="button" key={option.value} disabled={disabled} onClick={() => onToggle(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function taskStatusLabel(status: string) {
  if (status === "collected") return "已收藏";
  if (status === "skipped") return "已跳过";
  if (status === "quota_exhausted") return "达到上限";
  if (status === "cancelled") return "已取消";
  return "失败";
}

function taskStatusClass(status: string) {
  if (status === "collected") return "bg-[#eafaf0] text-[#087443]";
  if (status === "skipped") return "bg-[#f2f4f7] text-[#667085]";
  if (status === "quota_exhausted") return "bg-[#fff7e8] text-[#b54708]";
  return "bg-[#fff1ef] text-[#b42318]";
}

function clueStatusLabel(status: number) {
  if (status === 1) return "进行中";
  if (status === 2) return "已结束";
  if (status === 3) return "已失效";
  if (status === 4) return "已提报";
  return status ? `状态 ${status}` : "未知";
}

export function OpportunityAutoFavoritesPage() {
  const nativeBridge = hasNativeStoreBridge();
  const [stores, setStores] = useState<DoudianStoreSummary[]>([]);
  const [activeStoreId, setActiveStoreId] = useState("");
  const [selectedStoreIds, setSelectedStoreIds] = useState<Set<string>>(() => new Set());
  const [storeQuery, setStoreQuery] = useState("");
  const [settings, setSettings] = useState<Record<string, StoreFavoriteConfig>>(() => normalizeStoredSettings(storageGet(STORAGE_KEY_OPPORTUNITY_FAVORITE_SETTINGS, {})));
  const [categoriesByStore, setCategoriesByStore] = useState<Record<string, DoudianOpportunityFavoriteCategory[]>>({});
  const [loadingCategoryKeys, setLoadingCategoryKeys] = useState<Set<string>>(() => new Set());
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryDraftKeys, setCategoryDraftKeys] = useState<Set<string>>(() => new Set());
  const [categoryApplying, setCategoryApplying] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncTargetIds, setSyncTargetIds] = useState<Set<string>>(() => new Set());
  const [syncRunning, setSyncRunning] = useState(false);
  const [loadingStores, setLoadingStores] = useState(true);
  const [running, setRunning] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [taskRows, setTaskRows] = useState<DoudianOpportunityAutoFavoriteRow[]>([]);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupConfirmOpen, setCleanupConfirmOpen] = useState(false);
  const [cleanupOperationId, setCleanupOperationId] = useState("");
  const [cleanupProgress, setCleanupProgress] = useState(0);
  const [cleanupProgressMessage, setCleanupProgressMessage] = useState("");
  const [cleanupMessage, setCleanupMessage] = useState("");
  const [cleanupHasFailures, setCleanupHasFailures] = useState(false);
  const [message, setMessage] = useState("");
  const [resultTab, setResultTab] = useState<"favorites" | "task">("favorites");
  const [recordsByStore, setRecordsByStore] = useState<Record<string, FavoriteRecordState>>({});
  const [loadingRecordKeys, setLoadingRecordKeys] = useState<Set<string>>(() => new Set());
  const favoriteRecordRequestRef = useRef<{ operationId: string; storeKey: string } | null>(null);
  const activeStoreKeyRef = useRef("");
  const [recordQuery, setRecordQuery] = useState("");
  const [recordCategory, setRecordCategory] = useState("");
  const [recordBenefit, setRecordBenefit] = useState("");
  const [recordStatus, setRecordStatus] = useState("");
  const [recordPage, setRecordPage] = useState(1);
  const [selectedRecordKeys, setSelectedRecordKeys] = useState<Set<string>>(() => new Set());
  const [cancelRecordsRunning, setCancelRecordsRunning] = useState(false);
  const [cancelRecordsOperationId, setCancelRecordsOperationId] = useState("");
  const [cancelRecordsProgress, setCancelRecordsProgress] = useState(0);
  const [cancelRecordsProgressMessage, setCancelRecordsProgressMessage] = useState("");
  const busy = running || cleanupRunning || syncRunning || categoryApplying || cancelRecordsRunning;

  const filteredStores = useMemo(() => {
    const keyword = storeQuery.trim().toLocaleLowerCase();
    return stores.filter((store) => !keyword || store.shopName.toLocaleLowerCase().includes(keyword) || store.shopId.includes(keyword));
  }, [stores, storeQuery]);
  const activeStore = useMemo(() => stores.find((store) => store.shopId === activeStoreId), [activeStoreId, stores]);
  const activeKey = activeStore ? storeIdentityKey(activeStore) : "";
  activeStoreKeyRef.current = activeKey;
  const activeConfig = useMemo(() => settings[activeKey] || defaultStoreConfig(), [activeKey, settings]);
  const activeCategories = categoriesByStore[activeKey] || [];
  const activeRecords = recordsByStore[activeKey] || { rows: [], total: 0, totalKnown: false, cancelSupported: false, fetched: false, complete: false, lastPage: 0, hasMore: false, message: "" };
  const remainingRecordCount = activeRecords.totalKnown ? Math.max(0, activeRecords.total - activeRecords.rows.length) : 0;
  const recordFiltersActive = Boolean(recordQuery.trim() || recordCategory || recordBenefit || recordStatus);
  const selectedStores = stores.filter((store) => selectedStoreIds.has(store.shopId));
  const activeStoreSelected = Boolean(activeStore && selectedStoreIds.has(activeStore.shopId));
  const sharedConfig = useMemo(() => {
    if (!selectedStores.length) return defaultStoreConfig();
    const configs = selectedStores.map((store) => settings[storeIdentityKey(store)] || defaultStoreConfig());
    return {
      categoryPlans: activeConfig.categoryPlans,
      modeIds: queryModes.map((item) => item.id).filter((id) => configs.every((config) => config.modeIds.includes(id))),
      reasonIds: reasonOptions.map((item) => item.value).filter((id) => configs.every((config) => config.reasonIds.includes(id))),
      benefitIds: benefitOptions.map((item) => item.value).filter((id) => configs.every((config) => config.benefitIds.includes(id)))
    };
  }, [activeConfig.categoryPlans, selectedStores, settings]);
  const allVisibleSelected = filteredStores.length > 0 && filteredStores.every((store) => selectedStoreIds.has(store.shopId));
  const someVisibleSelected = !allVisibleSelected && filteredStores.some((store) => selectedStoreIds.has(store.shopId));
  const loadingCategories = Boolean(activeKey && loadingCategoryKeys.has(activeKey));
  const loadingRecords = Boolean(activeKey && loadingRecordKeys.has(activeKey));

  const categoryOptions = useMemo(() => {
    const keyword = categoryQuery.trim().toLocaleLowerCase();
    const deduped = new Map(activeCategories.map((category) => [categoryKey(category), category]));
    return [...deduped.values()].filter((category) => !keyword || [...(category.path || []), category.name, String(category.id)].some((item) => item.toLocaleLowerCase().includes(keyword))).sort((left, right) => (left.path || [left.name]).join(">").localeCompare((right.path || [right.name]).join(">"), "zh-CN"));
  }, [activeCategories, categoryQuery]);

  const recordCategoryOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const row of activeRecords.rows) values.set(row.categoryId || row.categoryName, row.categoryName || row.categoryId || "未分类");
    return [...values.entries()].sort((left, right) => left[1].localeCompare(right[1], "zh-CN"));
  }, [activeRecords.rows]);
  const recordBenefitOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const row of activeRecords.rows) row.benefits.forEach((item) => values.set(String(item.id), item.name));
    return [...values.entries()].sort((left, right) => left[1].localeCompare(right[1], "zh-CN"));
  }, [activeRecords.rows]);
  const recordStatusOptions = useMemo(() => [...new Set(activeRecords.rows.map((row) => row.clueStatus))].sort((a, b) => a - b), [activeRecords.rows]);
  const filteredRecords = useMemo(() => {
    const keyword = recordQuery.trim().toLocaleLowerCase();
    return activeRecords.rows.filter((row) => {
      if (keyword && ![row.clueName, row.clueId, row.categoryName].some((item) => item.toLocaleLowerCase().includes(keyword))) return false;
      if (recordCategory && (row.categoryId || row.categoryName) !== recordCategory) return false;
      if (recordBenefit && !row.benefits.some((item) => String(item.id) === recordBenefit)) return false;
      if (recordStatus && String(row.clueStatus) !== recordStatus) return false;
      return true;
    });
  }, [activeRecords.rows, recordBenefit, recordCategory, recordQuery, recordStatus]);
  const recordPageCount = Math.max(1, Math.ceil(filteredRecords.length / FAVORITE_RECORD_PAGE_SIZE));
  const pagedRecords = useMemo(() => filteredRecords.slice((recordPage - 1) * FAVORITE_RECORD_PAGE_SIZE, recordPage * FAVORITE_RECORD_PAGE_SIZE), [filteredRecords, recordPage]);
  const allVisibleRecordsSelected = pagedRecords.length > 0 && pagedRecords.every((row) => selectedRecordKeys.has(recordKey(row)));
  const syncTargets = useMemo(() => stores.filter((store) => store.shopId !== activeStoreId), [activeStoreId, stores]);
  const allSyncTargetsSelected = syncTargets.length > 0 && syncTargets.every((store) => syncTargetIds.has(store.shopId));
  const someSyncTargetsSelected = !allSyncTargetsSelected && syncTargets.some((store) => syncTargetIds.has(store.shopId));

  function saveSettings(next: Record<string, StoreFavoriteConfig>) {
    storageSet(STORAGE_KEY_OPPORTUNITY_FAVORITE_SETTINGS, next);
    return next;
  }

  function updateScopedConfigs(updater: (current: StoreFavoriteConfig, store: DoudianStoreSummary) => StoreFavoriteConfig) {
    if (!selectedStores.length || busy) return;
    setSettings((current) => {
      const next = { ...current };
      for (const store of selectedStores) {
        const key = storeIdentityKey(store);
        next[key] = updater(current[key] || defaultStoreConfig(), store);
      }
      return saveSettings(next);
    });
  }

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
      setActiveStoreId((current) => nextStores.some((store) => store.shopId === current) ? current : nextStores[0]?.shopId || "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingStores(false);
    }
  }

  async function loadCategories(store: DoudianStoreSummary, force = false) {
    const key = storeIdentityKey(store);
    if (!force && categoriesByStore[key]) return categoriesByStore[key];
    setLoadingCategoryKeys((current) => new Set(current).add(key));
    try {
      const result = await fetchDoudianFavoriteCategories({ shopIds: [store.shopId], storeRefs: [storeIdentityRef(store)], forceAdapter: true });
      if (!result.ok) throw new Error(result.message || "类目读取失败");
      const categories = result.categories || [];
      setCategoriesByStore((current) => ({ ...current, [key]: categories }));
      return categories;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return [];
    } finally {
      setLoadingCategoryKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  function pauseFavoriteRecordRequest(request: { operationId: string; storeKey: string }) {
    if (favoriteRecordRequestRef.current?.operationId === request.operationId) favoriteRecordRequestRef.current = null;
    void cancelDoudianStoreOperation(request.operationId).catch(() => undefined);
    setRecordsByStore((current) => {
      const previous = current[request.storeKey];
      if (!previous) return current;
      return {
        ...current,
        [request.storeKey]: {
          ...previous,
          complete: false,
          message: `已切换店铺，暂停获取；已保留 ${previous.rows.length} 条`
        }
      };
    });
  }

  async function refreshFavoriteRecords(store = activeStore, options: { reset?: boolean; startPage?: number; maxPages?: number } = {}) {
    if (!store || !nativeBridge) return;
    const key = storeIdentityKey(store);
    const reset = options.reset !== false;
    const startPage = Math.max(1, Math.floor(options.startPage || 1));
    const maxPages = Math.max(1, Math.floor(options.maxPages || 1));
    const existingRequest = favoriteRecordRequestRef.current;
    if (existingRequest && existingRequest.storeKey !== key) pauseFavoriteRecordRequest(existingRequest);
    setRecordPage(1);
    const loadingMessage = startPage === 1 && maxPages === 1 ? `正在加载 ${store.shopName} 的第一页预览` : `正在继续获取 ${store.shopName} 的剩余收藏`;
    setMessage(loadingMessage);
    setRecordsByStore((current) => {
      const previous = current[key] || { rows: [], total: 0, totalKnown: false, cancelSupported: false, fetched: false, complete: false, lastPage: 0, hasMore: false, message: "" };
      return {
        ...current,
        [key]: {
          ...previous,
          rows: reset ? [] : previous.rows,
          total: reset ? 0 : previous.total,
          totalKnown: reset ? false : previous.totalKnown,
          fetched: true,
          complete: false,
          lastPage: reset ? 0 : previous.lastPage,
          hasMore: reset ? false : previous.hasMore,
          message: loadingMessage
        }
      };
    });
    setLoadingRecordKeys((current) => new Set(current).add(key));
    let operationId = "";
    try {
      const result = await fetchDoudianOpportunityFavoriteRecords({
        storeRefs: [storeIdentityRef(store)],
        taskStatus: 1,
        pageSize: FAVORITE_RECORD_PAGE_SIZE,
        startPage,
        maxPages,
        onStarted: (nextOperationId) => {
          operationId = nextOperationId;
          const request = { operationId: nextOperationId, storeKey: key };
          if (activeStoreKeyRef.current !== key) pauseFavoriteRecordRequest(request);
          else favoriteRecordRequestRef.current = request;
        },
        forceAdapter: true
      });
      if (result.status !== "cancelled") {
        setRecordsByStore((current) => {
          const previous = current[key] || { rows: [], total: 0, totalKnown: false, cancelSupported: false, fetched: true, complete: false, lastPage: 0, hasMore: false, message: "" };
          const rows = new Map((reset ? [] : previous.rows).map((row) => [recordKey(row), row]));
          (result.rows || []).forEach((row) => rows.set(recordKey(row), row));
          const rowCount = rows.size;
          const incomplete = !result.ok || result.status === "partial" || result.status === "failed";
          const message = incomplete
            ? result.message || "已收藏商机词读取失败"
            : result.hasMore
              ? result.totalKnown ? `预览数据：已加载 ${rowCount} / 共 ${result.total} 条` : `已加载 ${rowCount} 条，平台仍有更多数据`
              : result.totalKnown && result.total === 0 ? `${store.shopName} 获取完成，平台返回 0 条收藏`
                : `已加载全部 ${result.totalKnown ? result.total : rowCount} 条收藏`;
          return {
            ...current,
            [key]: {
              rows: [...rows.values()],
              total: result.totalKnown ? result.total : Math.max(previous.total, rowCount),
              totalKnown: result.totalKnown || previous.totalKnown,
              cancelSupported: result.cancelSupported,
              fetched: true,
              complete: !result.hasMore,
              lastPage: result.current || previous.lastPage,
              hasMore: result.hasMore,
              message
            }
          };
        });
        setMessage(result.hasMore
          ? result.totalKnown ? `第一页预览已加载，平台共 ${result.total} 条` : "第一页预览已加载，平台仍有更多数据"
          : result.totalKnown && result.total === 0 ? `${store.shopName} 平台返回 0 条收藏` : "平台收藏已全部加载");
      }
      if (!result.ok) setMessage(result.message || "已收藏商机词读取失败");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setRecordsByStore((current) => current[key] ? { ...current, [key]: { ...current[key], complete: true, message: errorMessage } } : current);
      setMessage(errorMessage);
    } finally {
      setLoadingRecordKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      if (favoriteRecordRequestRef.current?.operationId === operationId) favoriteRecordRequestRef.current = null;
    }
  }

  useEffect(() => {
    void refreshStores();
  }, []);

  useEffect(() => {
    if (!activeStore) return;
    setSelectedRecordKeys(new Set());
    setRecordCategory("");
    setRecordBenefit("");
    setRecordStatus("");
    setRecordPage(1);
    void loadCategories(activeStore);
  }, [activeStoreId]);

  useEffect(() => {
    const request = favoriteRecordRequestRef.current;
    if (request && request.storeKey !== activeKey) pauseFavoriteRecordRequest(request);
  }, [activeKey]);

  useEffect(() => addDoudianProgressListener((event) => {
    const detail = event.detail;
    const page = detail.favoriteRecords;
    if (detail.taskType !== "opportunityFavoriteRecords" || !page) return;
    if (favoriteRecordRequestRef.current?.operationId !== detail.operationId) return;
    const key = storeIdentityKey(page.storeRef);
    setRecordsByStore((current) => {
      const previous = current[key] || { rows: [], total: 0, totalKnown: false, cancelSupported: page.cancelSupported, fetched: true, complete: false, lastPage: 0, hasMore: false, message: "" };
      const rows = new Map(previous.rows.map((row) => [recordKey(row), row]));
      page.rows.forEach((row) => rows.set(recordKey(row), row));
      return {
        ...current,
        [key]: {
          rows: [...rows.values()],
          total: page.totalKnown ? page.total : Math.max(previous.total, rows.size),
          totalKnown: page.totalKnown || previous.totalKnown,
          cancelSupported: page.cancelSupported,
          fetched: true,
          complete: !page.hasMore,
          lastPage: page.current,
          hasMore: page.hasMore,
          message: page.hasMore
            ? page.totalKnown ? `预览数据：已加载 ${rows.size} / 共 ${page.total} 条` : `已加载 ${rows.size} 条，平台仍有更多数据`
            : `已加载全部 ${page.totalKnown ? page.total : rows.size} 条收藏`
        }
      };
    });
  }), []);

  useEffect(() => {
    setRecordPage((current) => Math.min(current, recordPageCount));
  }, [recordPageCount]);

  useEffect(() => addDoudianProgressListener((event) => {
    const detail = event.detail;
    if (detail.taskType !== "opportunityAutoFavorites") return;
    if (activeOperationId && detail.operationId !== activeOperationId) return;
    setProgress(Math.max(0, Math.min(100, Math.round(Number(detail.progress || 0)))));
    setProgressMessage(detail.message || detail.resultSummary || detail.error || "");
    if (detail.autoFavorite?.row) {
      setTaskRows((current) => {
        const key = autoFavoriteRowKey(detail.autoFavorite!.row);
        return current.some((row) => autoFavoriteRowKey(row) === key) ? current : [...current, detail.autoFavorite!.row];
      });
    }
    if (detail.status === "running") setActiveOperationId(detail.operationId);
  }), [activeOperationId]);

  useEffect(() => addDoudianProgressListener((event) => {
    const detail = event.detail;
    if (detail.taskType !== "opportunityFavoritesClearInvalid") return;
    if (cleanupOperationId && detail.operationId !== cleanupOperationId) return;
    setCleanupProgress(Math.max(0, Math.min(100, Math.round(Number(detail.progress || 0)))));
    setCleanupProgressMessage(detail.message || detail.resultSummary || detail.error || "");
    if (detail.status === "running") setCleanupOperationId(detail.operationId);
  }), [cleanupOperationId]);

  useEffect(() => addDoudianProgressListener((event) => {
    const detail = event.detail;
    if (detail.taskType !== "opportunityFavoriteCancel") return;
    if (cancelRecordsOperationId && detail.operationId !== cancelRecordsOperationId) return;
    setCancelRecordsProgress(Math.max(0, Math.min(100, Math.round(Number(detail.progress || 0)))));
    setCancelRecordsProgressMessage(detail.message || detail.resultSummary || detail.error || "");
    if (detail.status === "running") setCancelRecordsOperationId(detail.operationId);
  }), [cancelRecordsOperationId]);

  function toggleStores(ids: string[]) {
    if (busy) return;
    setSelectedStoreIds((current) => toggleStoreIds(current, ids));
  }

  function toggleStoreSelection(store: DoudianStoreSummary) {
    if (busy) return;
    setSelectedStoreIds((current) => {
      const next = toggleStoreIds(current, [store.shopId]);
      const nextActiveId = next.has(store.shopId) ? store.shopId : stores.find((item) => next.has(item.shopId))?.shopId || store.shopId;
      setActiveStoreId(nextActiveId);
      return next;
    });
  }

  function focusStore(store: DoudianStoreSummary) {
    if (busy) return;
    const key = storeIdentityKey(store);
    activeStoreKeyRef.current = key;
    const request = favoriteRecordRequestRef.current;
    if (request && request.storeKey !== key) pauseFavoriteRecordRequest(request);
    setActiveStoreId(store.shopId);
    setSelectedStoreIds((current) => current.has(store.shopId) ? current : new Set([store.shopId]));
    if (!recordsByStore[key]?.fetched && !loadingRecordKeys.has(key)) {
      void refreshFavoriteRecords(store, { reset: true, startPage: 1, maxPages: 1 });
    }
  }

  function toggleConfigValue(key: "modeIds" | "reasonIds" | "benefitIds", value: string | number) {
    const removeFromAll = selectedStores.length > 0 && selectedStores.every((store) => (settings[storeIdentityKey(store)] || defaultStoreConfig())[key].includes(value as never));
    updateScopedConfigs((current) => {
      const values = new Set(current[key] as Array<string | number>);
      if (removeFromAll) values.delete(value);
      else values.add(value);
      return { ...current, [key]: [...values] } as StoreFavoriteConfig;
    });
  }

  async function openCategoryPicker() {
    if (!activeStore || !activeStoreSelected || busy) return;
    await loadCategories(activeStore);
    setCategoryDraftKeys(new Set(activeConfig.categoryPlans.map((item) => categoryKey(item.category))));
    setCategoryPickerOpen(true);
  }

  async function applyCategoryDraft() {
    if (!activeStore || !activeStoreSelected || !selectedStores.length || categoryApplying) return;
    setCategoryApplying(true);
    let matchedCategories = 0;
    let skippedCategories = 0;
    const sourcePlans = activeCategories.filter((category) => categoryDraftKeys.has(categoryKey(category))).map((category) => ({ category, limit: activeConfig.categoryPlans.find((item) => categoryKey(item.category) === categoryKey(category))?.limit || 100 })).slice(0, 20);
    const updates: Record<string, StoreFavoriteConfig> = {};
    try {
      for (const store of selectedStores) {
        const key = storeIdentityKey(store);
        const categories = store.shopId === activeStore.shopId ? activeCategories : await loadCategories(store, true);
        const available = new Map(categories.map((category) => [categoryKey(category), category]));
        const current = settings[key] || defaultStoreConfig();
        const existingLimits = new Map(current.categoryPlans.map((item) => [categoryKey(item.category), item.limit]));
        const categoryPlans = sourcePlans.flatMap((plan) => {
          const category = available.get(categoryKey(plan.category));
          if (!category) {
            skippedCategories += 1;
            return [];
          }
          matchedCategories += 1;
          return [{ category, limit: existingLimits.get(categoryKey(plan.category)) || plan.limit }];
        });
        updates[key] = { ...current, categoryPlans };
      }
      setSettings((current) => saveSettings({ ...current, ...updates }));
      setMessage(`已为 ${selectedStores.length} 家店铺保存类目设置，匹配 ${matchedCategories} 个类目${skippedCategories ? `，跳过 ${skippedCategories} 个不存在的类目` : ""}`);
      setCategoryPickerOpen(false);
    } finally {
      setCategoryApplying(false);
    }
  }

  function updateCategoryLimit(key: string, value: number) {
    updateScopedConfigs((current) => ({ ...current, categoryPlans: current.categoryPlans.map((item) => categoryKey(item.category) === key ? { ...item, limit: Math.max(1, Math.min(1000, Math.floor(value) || 1)) } : item) }));
  }

  async function synchronizeSettings() {
    if (!activeStore || !syncTargetIds.size || syncRunning) return;
    setSyncRunning(true);
    let matchedCategories = 0;
    let skippedCategories = 0;
    const updates: Record<string, StoreFavoriteConfig> = {};
    for (const target of stores.filter((store) => syncTargetIds.has(store.shopId))) {
      const targetCategories = await loadCategories(target, true);
      const available = new Map(targetCategories.map((category) => [categoryKey(category), category]));
      const categoryPlans = activeConfig.categoryPlans.flatMap((plan) => {
        const category = available.get(categoryKey(plan.category));
        if (!category) {
          skippedCategories += 1;
          return [];
        }
        matchedCategories += 1;
        return [{ category, limit: plan.limit }];
      });
      updates[storeIdentityKey(target)] = { ...activeConfig, categoryPlans };
    }
    setSettings((current) => saveSettings({ ...current, ...updates }));
    setSelectedStoreIds((current) => new Set([...current, activeStore.shopId, ...syncTargetIds]));
    setMessage(`已同步 ${Object.keys(updates).length} 家店铺，匹配 ${matchedCategories} 个类目${skippedCategories ? `，跳过 ${skippedCategories} 个不匹配类目` : ""}`);
    setSyncRunning(false);
    setSyncOpen(false);
  }

  function domainFilters(config: StoreFavoriteConfig): DoudianOpportunityAutoFavoriteFilters {
    const modes = queryModes.filter((item) => config.modeIds.includes(item.id));
    const totalLimit = Math.min(1000, config.categoryPlans.reduce((sum, item) => sum + item.limit, 0));
    const maxCategoryLimit = Math.max(1, ...config.categoryPlans.map((item) => item.limit));
    return {
      categories: config.categoryPlans.map((item) => item.category),
      categoryPlans: config.categoryPlans,
      queryModes: modes,
      sortFields: [...new Set(modes.map((item) => item.sortField))],
      recommendReasons: reasonOptions.filter((item) => config.reasonIds.includes(item.value)).map((item) => ({ id: item.value, type: 1, label: item.label })),
      benefitIds: config.benefitIds,
      perStoreLimit: totalLimit,
      pageSize: 18,
      maxPagesPerQuery: Math.max(1, Math.min(60, Math.ceil(maxCategoryLimit / 18)))
    };
  }

  async function runAutoFavorite() {
    if (busy) return;
    if (!selectedStores.length) return setMessage("请勾选本次要运行的店铺");
    const missingCategoryStores = selectedStores.filter((store) => !(settings[storeIdentityKey(store)]?.categoryPlans.length));
    if (missingCategoryStores.length) return setMessage(`${missingCategoryStores.map((store) => store.shopName).join("、")} 尚未添加收藏类目`);
    const missingModeStores = selectedStores.filter((store) => !(settings[storeIdentityKey(store)]?.modeIds.length));
    if (missingModeStores.length) return setMessage(`${missingModeStores.map((store) => store.shopName).join("、")} 尚未选择排序条件`);
    const storeFilters = Object.fromEntries(selectedStores.map((store) => [storeIdentityKey(store), domainFilters(settings[storeIdentityKey(store)])]));
    const clientRequestId = `opportunity-auto-favorites-${Date.now()}`;
    setRunning(true);
    setResultTab("task");
    setActiveOperationId("");
    setProgress(0);
    setProgressMessage("正在创建自动收藏任务");
    setMessage("");
    setTaskRows([]);
    try {
      const result = await runDoudianOpportunityAutoFavorites({
        shopIds: selectedStores.map((store) => store.shopId),
        storeRefs: selectedStores.map(storeIdentityRef),
        operationId: clientRequestId,
        onStarted: (operationId) => setActiveOperationId(operationId),
        forceAdapter: true,
        filters: Object.values(storeFilters)[0],
        storeFilters
      });
      setTaskRows(result.rows || []);
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

  async function runCleanup() {
    if (!selectedStores.length || busy) return;
    const operationId = `opportunity-favorites-clear-${Date.now()}`;
    setCleanupConfirmOpen(false);
    setCleanupRunning(true);
    setCleanupOperationId(operationId);
    setCleanupProgress(0);
    setCleanupProgressMessage("正在创建清理任务");
    setCleanupMessage("");
    setCleanupHasFailures(false);
    try {
      const result = await clearDoudianInvalidOpportunityFavorites({ storeRefs: selectedStores.map(storeIdentityRef), operationId, forceAdapter: true });
      setCleanupHasFailures(Boolean(result.failureCount));
      setCleanupMessage(result.status === "cancelled" ? "已停止后续店铺；停止前提交的清理请求不会撤销" : result.message || (result.ok ? "清理完成" : "清理未完成"));
      if (result.status !== "cancelled") setCleanupProgress(100);
    } catch (error) {
      setCleanupHasFailures(true);
      setCleanupMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCleanupRunning(false);
      setCleanupOperationId("");
      setCleanupProgressMessage("");
    }
  }

  async function cancelCleanup() {
    if (!cleanupOperationId) return;
    await cancelDoudianStoreOperation(cleanupOperationId).catch(() => undefined);
    setCleanupRunning(false);
    setCleanupMessage("已停止后续店铺；停止前提交的清理请求不会撤销");
    setCleanupOperationId("");
    setCleanupProgressMessage("");
  }

  async function cancelSelectedFavorites() {
    if (!activeStore || !selectedRecordKeys.size || cancelRecordsRunning || !activeRecords.cancelSupported) return;
    const taskIds = activeRecords.rows.filter((row) => selectedRecordKeys.has(recordKey(row))).map((row) => row.taskId);
    if (!taskIds.length) return;
    const operationId = `opportunity-favorites-cancel-${Date.now()}`;
    setCancelRecordsRunning(true);
    setCancelRecordsOperationId(operationId);
    setCancelRecordsProgress(0);
    setCancelRecordsProgressMessage("正在创建取消收藏任务");
    setMessage("");
    try {
      const result = await cancelDoudianOpportunityFavorites({
        storeRefs: [storeIdentityRef(activeStore)],
        taskIds,
        operationId,
        forceAdapter: true
      });
      setMessage(result.message || (result.ok ? "取消收藏完成" : "取消收藏未完成"));
      const retryTaskIds = new Set((result.rows || []).filter((row) => row.status !== "success").map((row) => row.taskId));
      setSelectedRecordKeys(new Set(activeRecords.rows.filter((row) => retryTaskIds.has(row.taskId)).map(recordKey)));
      if (result.status !== "cancelled") {
        const successfulTaskIds = new Set((result.rows || []).filter((row) => row.status === "success").map((row) => row.taskId));
        setRecordsByStore((current) => {
          const key = storeIdentityKey(activeStore);
          const previous = current[key];
          if (!previous) return current;
          const rows = previous.rows.filter((row) => !successfulTaskIds.has(row.taskId));
          return { ...current, [key]: { ...previous, rows, total: Math.max(0, previous.total - (previous.rows.length - rows.length)) } };
        });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelRecordsRunning(false);
      setCancelRecordsOperationId("");
      setCancelRecordsProgressMessage("");
    }
  }

  function toggleVisibleRecords() {
    setSelectedRecordKeys((current) => {
      const next = new Set(current);
      if (allVisibleRecordsSelected) pagedRecords.forEach((row) => next.delete(recordKey(row)));
      else pagedRecords.forEach((row) => next.add(recordKey(row)));
      return next;
    });
  }

  return (
    <section className="grid h-full min-h-0 grid-cols-[270px_minmax(0,1fr)] gap-3 overflow-hidden text-[#1d2939] max-[900px]:grid-cols-1 max-[900px]:overflow-auto">
      <aside className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white max-[900px]:max-h-[360px]">
        <div className="flex h-11 items-center justify-between border-b border-[#edf1f6] px-3.5">
          <span className="inline-flex items-center gap-2"><Store className="size-4 text-brand-navy" /><strong className="text-[14px]">店铺配置</strong></span>
          <a className="text-[12px] font-semibold text-brand-fox no-underline" href="#/stores">店铺管理</a>
        </div>
        <div className="border-b border-[#edf1f6] p-2.5">
          <label className="flex h-8 items-center gap-2 rounded-md border border-[#dbe5f2] px-2.5 text-[#98a2b3]">
            <input className="min-w-0 flex-1 bg-transparent text-[12px] text-[#1d2939] outline-none" placeholder="店铺名称 / 店铺 ID" value={storeQuery} onChange={(event) => setStoreQuery(event.target.value)} />
            <Search className="size-[14px]" />
          </label>
          <button className="mt-2.5 inline-flex items-center gap-2 text-[12px] font-semibold text-[#344054]" type="button" disabled={busy || !filteredStores.length} onClick={() => toggleStores(filteredStores.map((store) => store.shopId))}>
            <SelectionBox checked={allVisibleSelected} mixed={someVisibleSelected} />
            设置与运行范围 {selectedStoreIds.size}/{stores.length}
          </button>
        </div>
        <div className={cn("min-h-[180px] overflow-auto divide-y divide-[#edf1f6]", busy && "pointer-events-none opacity-60")}>
          {loadingStores ? <div className="grid h-full min-h-[220px] place-items-center text-[#667085]"><Loader2 className="size-4 animate-spin" /></div> : filteredStores.length ? filteredStores.map((store) => {
            const key = storeIdentityKey(store);
            const configuredCount = settings[key]?.categoryPlans.length || 0;
            const active = store.shopId === activeStoreId;
            return (
              <button className={cn("grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5 text-left hover:bg-[#f8fbff]", active && "bg-[#fff7f1]")} key={key} type="button" onClick={() => focusStore(store)}>
                <span onClick={(event) => { event.stopPropagation(); toggleStoreSelection(store); }}><SelectionBox checked={selectedStoreIds.has(store.shopId)} /></span>
                <span className="min-w-0"><span className="block truncate text-[12px] font-semibold text-[#1d2939]">{store.shopName}</span><span className="mt-1 block truncate text-[11px] text-[#98a2b3]">ID: {store.shopId}</span></span>
                <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px]", configuredCount ? "bg-[#eafaf0] text-[#087443]" : "bg-[#f2f4f7] text-[#667085]")}>{configuredCount ? `${configuredCount} 类目` : "未设置"}</span>
              </button>
            );
          }) : <div className="grid h-full min-h-[220px] place-items-center text-[13px] text-[#98a2b3]">暂无店铺</div>}
        </div>
        <div className="flex items-center justify-between border-t border-[#edf1f6] px-3 py-2"><span className="text-[12px] text-[#98a2b3]">勾选一家设置一家，多选可批量设置</span><button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2]" type="button" disabled={loadingStores || busy} onClick={() => void refreshStores()} title="刷新店铺"><RefreshCw className={cn("size-[13px]", loadingStores && "animate-spin")} /></button></div>
      </aside>

      <div className="min-h-0 overflow-auto">
        <section className="border-y border-[#e1e8f3] bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-[#fff2ea] text-brand-fox"><BookmarkPlus className="size-[18px]" /></span>
            <div className="min-w-[180px] flex-1"><h1 className="m-0 text-[15px] font-semibold text-[#101828]">商机收藏</h1><div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-[#667085]"><span>当前：{activeStore?.shopName || "未选择"}</span><span>{activeConfig.categoryPlans.length} 个类目</span><span>本次运行 {selectedStores.length} 家</span></div></div>
            {running ? <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#f3b7b3] px-3 text-[12px] font-semibold text-[#b42318]" type="button" onClick={() => void cancelRun()}><CircleStop className="size-[14px]" />停止</button> : <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white disabled:opacity-45" type="button" disabled={!nativeBridge || busy || !selectedStores.length} onClick={() => void runAutoFavorite()}><BookmarkPlus className="size-[14px]" />开始自动收藏</button>}
            {cleanupRunning ? <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#f3b7b3] px-3 text-[12px] font-semibold text-[#b42318]" type="button" onClick={() => void cancelCleanup()}><CircleStop className="size-[14px]" />停止清理</button> : <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#f3b7b3] px-3 text-[12px] font-semibold text-[#b42318] disabled:opacity-45" type="button" disabled={!nativeBridge || busy || !selectedStores.length} onClick={() => setCleanupConfirmOpen(true)}><Trash2 className="size-[14px]" />清理失效收藏</button>}
          </div>
          {running ? <div className="mt-3"><div className="mb-1.5 flex justify-between text-[12px] text-[#667085]"><span className="truncate">{progressMessage || "正在处理"}</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#edf1f6]"><div className="h-full bg-brand-fox transition-[width]" style={{ width: `${progress}%` }} /></div></div> : null}
          {cleanupRunning ? <div className="mt-3"><div className="mb-1.5 flex justify-between text-[12px] text-[#667085]"><span className="truncate">{cleanupProgressMessage || "正在清理"}</span><span>{cleanupProgress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#edf1f6]"><div className="h-full bg-[#d92d20] transition-[width]" style={{ width: `${cleanupProgress}%` }} /></div></div> : null}
          {cancelRecordsRunning ? <div className="mt-3"><div className="mb-1.5 flex justify-between text-[12px] text-[#667085]"><span className="truncate">{cancelRecordsProgressMessage || "正在取消收藏"}</span><span>{cancelRecordsProgress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#edf1f6]"><div className="h-full bg-[#667085] transition-[width]" style={{ width: `${cancelRecordsProgress}%` }} /></div></div> : null}
          {message ? <div className="mt-2 text-[12px] text-[#475467]">{message}</div> : null}
          {cleanupMessage ? <div className={cn("mt-2 inline-flex items-center gap-1.5 text-[12px]", cleanupHasFailures ? "text-[#b42318]" : "text-[#087443]")}>{cleanupHasFailures ? <AlertCircle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}{cleanupMessage}</div> : null}
        </section>

        <section className="mt-3 border-y border-[#e1e8f3] bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="m-0 text-[14px] font-semibold text-[#101828]">{selectedStores.length > 1 ? `批量收藏设置（${selectedStores.length} 家）` : "单店收藏设置"}</h2><p className="m-0 mt-1 text-[12px] text-[#667085]">{selectedStores.length ? `每家店铺独立保存 · 当前类目模板：${activeStore?.shopName || selectedStores[0].shopName}` : "请从左侧勾选要设置的店铺"}</p></div><button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] px-3 text-[12px] font-semibold text-[#344054] disabled:opacity-45" type="button" disabled={!activeStoreSelected || busy || !activeConfig.categoryPlans.length} onClick={() => { setSyncTargetIds(new Set()); setSyncOpen(true); }}><Copy className="size-[14px]" />同步到其他店铺</button></div>
          {selectedStores.length ? <div className="mt-3 flex flex-wrap items-center gap-1.5 border-y border-[#edf1f6] bg-[#f8fafc] px-2.5 py-2"><span className="mr-1 text-[11px] font-semibold text-[#667085]">设置范围</span>{selectedStores.slice(0, 8).map((store) => <span className="max-w-[150px] truncate rounded-sm border border-[#dbe5f2] bg-white px-2 py-1 text-[11px] text-[#344054]" key={storeIdentityKey(store)} title={`${store.shopName} · ${store.shopId}`}>{store.shopName}</span>)}{selectedStores.length > 8 ? <span className="text-[11px] text-[#667085]">另 {selectedStores.length - 8} 家</span> : null}</div> : null}
          <div className="mt-3 border-t border-[#edf1f6] pt-3">
            <div className="mb-2 flex items-center justify-between"><strong className="text-[12px] text-[#344054]">类目及收藏数量{selectedStores.length > 1 ? "（按各店实际类目匹配）" : ""}</strong><button className="inline-flex h-7 items-center gap-1 rounded-md border border-[#ffb084] px-2.5 text-[12px] font-semibold text-[#c2410c] disabled:opacity-45" type="button" disabled={!activeStoreSelected || !selectedStores.length || busy || loadingCategories} onClick={() => void openCategoryPicker()}>{loadingCategories ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}添加类目</button></div>
            {activeConfig.categoryPlans.length ? <div className="divide-y divide-[#edf1f6] border-y border-[#edf1f6]">{activeConfig.categoryPlans.map((plan) => <div className="grid grid-cols-[minmax(0,1fr)_120px_32px] items-center gap-3 py-2" key={categoryKey(plan.category)}><div className="min-w-0"><div className="truncate text-[12px] font-semibold text-[#344054]">{(plan.category.path || [plan.category.name]).join(" > ")}</div><div className="mt-0.5 text-[11px] text-[#98a2b3]">{plan.category.key}: {plan.category.id}</div></div><label className="flex h-8 items-center rounded-md border border-[#dbe5f2] px-2"><input className="w-full bg-transparent text-right text-[12px] outline-none" type="number" min={1} max={1000} value={plan.limit} disabled={busy} onChange={(event) => updateCategoryLimit(categoryKey(plan.category), Number(event.target.value))} /><span className="ml-1 text-[11px] text-[#98a2b3]">个</span></label><button className="grid size-7 place-items-center rounded-md text-[#98a2b3] hover:bg-[#fff1ef] hover:text-[#b42318]" type="button" disabled={busy} title="移除类目" onClick={() => updateScopedConfigs((current) => ({ ...current, categoryPlans: current.categoryPlans.filter((item) => categoryKey(item.category) !== categoryKey(plan.category)) }))}><X className="size-4" /></button></div>)}</div> : <div className="grid h-20 place-items-center border-y border-dashed border-[#dbe5f2] text-[12px] text-[#98a2b3]">{selectedStores.length ? "尚未添加类目" : "请先勾选店铺"}</div>}
          </div>
          <div className="mt-3 grid gap-3 border-t border-[#edf1f6] pt-3">
            <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-3 max-[700px]:grid-cols-1"><span className="pt-1 text-[12px] font-semibold text-[#344054]">排序条件</span><ChoiceChips options={queryModes.map((item) => ({ value: item.id, label: item.label || item.id }))} values={sharedConfig.modeIds} disabled={!selectedStores.length || busy} onToggle={(value) => toggleConfigValue("modeIds", value)} /></div>
            <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-3 max-[700px]:grid-cols-1"><span className="pt-1 text-[12px] font-semibold text-[#344054]">推荐理由</span><ChoiceChips options={reasonOptions} values={sharedConfig.reasonIds} disabled={!selectedStores.length || busy} onToggle={(value) => toggleConfigValue("reasonIds", value)} /></div>
            <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-3 max-[700px]:grid-cols-1"><span className="pt-1 text-[12px] font-semibold text-[#344054]">权益</span><ChoiceChips options={benefitOptions} values={sharedConfig.benefitIds} disabled={!selectedStores.length || busy} onToggle={(value) => toggleConfigValue("benefitIds", value)} /></div>
          </div>
        </section>

        <section className="mt-3 min-h-[300px] border-y border-[#e1e8f3] bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#edf1f6] px-4 py-2.5"><div className="inline-flex h-8 rounded-md border border-[#dbe5f2] bg-[#f8fafc] p-0.5"><button className={cn("rounded px-3 text-[12px]", resultTab === "favorites" && "bg-white font-semibold text-[#101828] shadow-sm")} type="button" onClick={() => setResultTab("favorites")}>平台已收藏 {activeRecords.fetched ? activeRecords.totalKnown ? `共 ${activeRecords.total}` : `已加载 ${activeRecords.rows.length}` : ""}</button><button className={cn("rounded px-3 text-[12px]", resultTab === "task" && "bg-white font-semibold text-[#101828] shadow-sm")} type="button" onClick={() => setResultTab("task")}>本次执行 {taskRows.length}</button></div>{resultTab === "favorites" ? <div className="flex flex-wrap items-center gap-2"><span className="max-w-[220px] truncate text-[11px] text-[#98a2b3]" title={activeStore?.shopName || ""}>当前店铺：{activeStore?.shopName || "未选择"}</span><button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] px-3 text-[12px] font-semibold text-[#344054] disabled:opacity-45" type="button" disabled={!activeStore || loadingRecords} onClick={() => activeStore && void refreshFavoriteRecords(activeStore, activeRecords.hasMore ? { reset: false, startPage: activeRecords.lastPage + 1, maxPages: 100 } : { reset: true, startPage: 1, maxPages: 1 })} title={activeRecords.hasMore ? "继续获取剩余平台收藏" : "重新获取第一页预览"}><RefreshCw className={cn("size-3.5", loadingRecords && "animate-spin")} />{loadingRecords ? "正在获取" : activeRecords.hasMore ? activeRecords.totalKnown ? `获取剩余 ${remainingRecordCount} 条` : "获取剩余" : activeRecords.fetched ? "刷新预览" : "获取第一页"}</button></div> : null}</div>
          {resultTab === "favorites" ? <>
            {activeRecords.fetched && activeRecords.hasMore ? <div className="flex items-center gap-2 border-b border-[#fed7aa] bg-[#fff7ed] px-4 py-2 text-[12px] text-[#9a3412]"><AlertCircle className="size-3.5 shrink-0" /><span>{activeRecords.totalKnown ? `预览数据：已加载 ${activeRecords.rows.length} / 共 ${activeRecords.total} 条` : `已加载 ${activeRecords.rows.length} 条，平台仍有更多数据`} · 当前筛选仅覆盖已加载数据</span></div> : null}
            <div className="flex flex-wrap items-center gap-2 border-b border-[#edf1f6] px-4 py-2.5">
              <Filter className="size-3.5 text-[#667085]" />
              <label className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-md border border-[#dbe5f2] px-2.5 text-[#98a2b3]"><Search className="size-3.5" /><input className="min-w-0 flex-1 bg-transparent text-[12px] text-[#344054] outline-none" placeholder="商机词 / 商机 ID" value={recordQuery} onChange={(event) => { setRecordQuery(event.target.value); setRecordPage(1); }} /></label>
              <select className="h-8 min-w-[140px] rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] text-[#344054]" value={recordCategory} onChange={(event) => { setRecordCategory(event.target.value); setRecordPage(1); }}><option value="">全部类目</option>{recordCategoryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              <select className="h-8 min-w-[130px] rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] text-[#344054]" value={recordBenefit} onChange={(event) => { setRecordBenefit(event.target.value); setRecordPage(1); }}><option value="">全部权益</option>{recordBenefitOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              <select className="h-8 min-w-[120px] rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] text-[#344054]" value={recordStatus} onChange={(event) => { setRecordStatus(event.target.value); setRecordPage(1); }}><option value="">全部状态</option>{recordStatusOptions.map((value) => <option key={value} value={value}>{clueStatusLabel(value)}</option>)}</select>
              <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] px-3 text-[12px] font-semibold text-[#b42318] disabled:opacity-45" type="button" disabled={!activeStore || !selectedRecordKeys.size || loadingRecords || cancelRecordsRunning || !activeRecords.cancelSupported} title={!activeRecords.cancelSupported ? "当前适配器未配置取消收藏接口" : "取消选中的平台收藏"} onClick={() => void cancelSelectedFavorites()}>{cancelRecordsRunning ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}批量取消收藏 {selectedRecordKeys.size ? `(${selectedRecordKeys.size})` : ""}</button>
            </div>
            <div className="overflow-auto">
              <table className="w-full min-w-[920px] border-collapse text-left text-[12px]"><thead className="sticky top-0 bg-[#f8fafc] text-[#667085]"><tr><th className="w-10 px-3 py-2"><button type="button" onClick={toggleVisibleRecords}><SelectionBox checked={allVisibleRecordsSelected} mixed={!allVisibleRecordsSelected && pagedRecords.some((row) => selectedRecordKeys.has(recordKey(row)))} /></button></th><th className="px-3 py-2 font-medium">商机词</th><th className="px-3 py-2 font-medium">类目</th><th className="px-3 py-2 font-medium">推荐理由</th><th className="px-3 py-2 font-medium">权益</th><th className="px-3 py-2 font-medium">商机状态</th><th className="px-3 py-2 font-medium">已提报商品</th></tr></thead><tbody className="divide-y divide-[#edf1f6]">{pagedRecords.length ? pagedRecords.map((row) => <tr key={recordKey(row)}><td className="px-3 py-2"><button type="button" onClick={() => setSelectedRecordKeys((current) => { const next = new Set(current); const key = recordKey(row); if (next.has(key)) next.delete(key); else next.add(key); return next; })}><SelectionBox checked={selectedRecordKeys.has(recordKey(row))} /></button></td><td className="max-w-[240px] px-3 py-2"><div className="truncate font-semibold text-[#344054]" title={row.clueName}>{row.clueName}</div><div className="mt-1 text-[11px] text-[#98a2b3]">ID: {row.clueId}</div></td><td className="max-w-[240px] px-3 py-2 text-[#475467]"><div className="line-clamp-2" title={row.categoryName}>{row.categoryName || "-"}</div></td><td className="px-3 py-2"><div className="flex max-w-[220px] flex-wrap gap-1">{row.labels.length ? row.labels.map((item) => <span className="rounded-sm bg-[#eef4ff] px-1.5 py-0.5 text-[11px] text-[#3538cd]" key={`${item.id}:${item.name}`}>{item.name}</span>) : "-"}</div></td><td className="px-3 py-2"><div className="flex max-w-[220px] flex-wrap gap-1">{row.benefits.length ? row.benefits.map((item) => <span className="rounded-sm bg-[#ecfdf3] px-1.5 py-0.5 text-[11px] text-[#087443]" key={`${item.id}:${item.name}`}>{item.name}</span>) : "-"}</div></td><td className="px-3 py-2"><span className="rounded-sm bg-[#f2f4f7] px-1.5 py-0.5 text-[#475467]">{clueStatusLabel(row.clueStatus)}</span></td><td className="px-3 py-2 text-[#475467]">{row.submittedProductCount}</td></tr>) : <tr><td className="py-12 text-center text-[#98a2b3]" colSpan={7}>{loadingRecords ? "正在获取，已先展示已获取的收藏" : activeRecords.fetched ? recordFiltersActive ? activeRecords.hasMore ? "已加载数据中暂无匹配，获取剩余数据后结果可能增加" : "当前筛选没有匹配的收藏商机词" : `${activeStore?.shopName || "当前店铺"} 获取完成，平台返回 0 条收藏` : "点击左侧店铺可自动加载第一页预览"}</td></tr>}</tbody></table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#edf1f6] px-4 py-2.5 text-[12px] text-[#667085]"><span>{activeRecords.message || (loadingRecords ? `正在获取，已展示 ${activeRecords.rows.length} 条` : activeRecords.fetched ? `已获取 ${activeRecords.rows.length}${activeRecords.totalKnown ? ` / 共 ${activeRecords.total}` : ""} 条` : "尚未获取平台收藏")}{filteredRecords.length !== activeRecords.rows.length ? ` · 当前筛选 ${filteredRecords.length} 条` : ""}</span><div className="flex items-center gap-2"><button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2] disabled:opacity-40" type="button" disabled={recordPage <= 1} onClick={() => setRecordPage((current) => Math.max(1, current - 1))} title="上一页"><ChevronLeft className="size-3.5" /></button><span>第 {Math.min(recordPage, recordPageCount)} / {recordPageCount} 个已加载页</span><button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2] disabled:opacity-40" type="button" disabled={recordPage >= recordPageCount} onClick={() => setRecordPage((current) => Math.min(recordPageCount, current + 1))} title="下一页"><ChevronRight className="size-3.5" /></button></div></div>
          </> : <div className="overflow-auto"><table className="w-full min-w-[760px] border-collapse text-left text-[12px]"><thead className="bg-[#f8fafc] text-[#667085]"><tr><th className="px-4 py-2 font-medium">店铺</th><th className="px-4 py-2 font-medium">商机词</th><th className="px-4 py-2 font-medium">类目</th><th className="px-4 py-2 font-medium">状态</th><th className="px-4 py-2 font-medium">说明</th></tr></thead><tbody className="divide-y divide-[#edf1f6]">{taskRows.length ? taskRows.slice().reverse().map((row, index) => <tr key={`${row.shopId}:${row.clueId || index}:${row.attemptedAt}`}><td className="px-4 py-2"><div className="font-semibold text-[#344054]">{row.shopName}</div><div className="text-[11px] text-[#98a2b3]">{row.shopId}</div></td><td className="max-w-[220px] px-4 py-2"><div className="truncate">{row.clueName || "-"}</div><div className="text-[11px] text-[#98a2b3]">{row.clueId || ""}</div></td><td className="max-w-[220px] truncate px-4 py-2 text-[#475467]">{row.categoryName || "-"}</td><td className="px-4 py-2"><span className={cn("rounded-sm px-1.5 py-0.5", taskStatusClass(row.status))}>{taskStatusLabel(row.status)}</span></td><td className="px-4 py-2 text-[#667085]">{row.message}</td></tr>) : <tr><td className="py-12 text-center text-[#98a2b3]" colSpan={5}>暂无本次执行结果</td></tr>}</tbody></table></div>}
        </section>
      </div>

      <Dialog.Root open={categoryPickerOpen} onOpenChange={(open) => !busy && setCategoryPickerOpen(open)}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-[#101828]/35" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 grid max-h-[78vh] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg bg-white shadow-xl"><div className="flex items-center justify-between border-b border-[#edf1f6] px-4 py-3"><Dialog.Title className="m-0 text-[15px] font-semibold">添加类目{selectedStores.length > 1 ? `（批量设置 ${selectedStores.length} 家）` : ""}</Dialog.Title><Dialog.Close className="grid size-7 place-items-center"><X className="size-4" /></Dialog.Close></div><div className="p-3"><label className="flex h-8 items-center gap-2 rounded-md border border-[#dbe5f2] px-2.5"><Search className="size-3.5 text-[#98a2b3]" /><input className="min-w-0 flex-1 text-[12px] outline-none" placeholder="搜索类目名称或 ID" value={categoryQuery} onChange={(event) => setCategoryQuery(event.target.value)} /></label></div><div className="min-h-[240px] overflow-auto border-y border-[#edf1f6]">{loadingCategories ? <div className="grid h-48 place-items-center"><Loader2 className="size-4 animate-spin" /></div> : categoryOptions.map((category) => { const key = categoryKey(category); const selected = categoryDraftKeys.has(key); return <button className={cn("flex w-full items-center gap-3 border-b border-[#edf1f6] px-4 py-2.5 text-left hover:bg-[#f8fafc]", selected && "bg-[#fff7f1]")} type="button" key={key} onClick={() => setCategoryDraftKeys((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else if (next.size < 20) next.add(key); return next; })}><SelectionBox checked={selected} /><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-semibold text-[#344054]">{(category.path || [category.name]).join(" > ")}</span><span className="mt-0.5 block text-[11px] text-[#98a2b3]">{category.key}: {category.id}</span></span></button>; })}</div><div className="flex items-center justify-between px-4 py-3"><span className="text-[12px] text-[#667085]">已选择 {categoryDraftKeys.size}/20</span><div className="flex gap-2"><Dialog.Close className="h-8 rounded-md border border-[#dbe5f2] px-3 text-[12px]">取消</Dialog.Close><button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white disabled:opacity-45" type="button" disabled={categoryApplying} onClick={() => void applyCategoryDraft()}>{categoryApplying ? <Loader2 className="size-3.5 animate-spin" /> : null}确定</button></div></div></Dialog.Content></Dialog.Portal></Dialog.Root>

      <Dialog.Root open={syncOpen} onOpenChange={(open) => !syncRunning && setSyncOpen(open)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[#101828]/35" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 grid max-h-[76vh] w-[min(520px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-[#edf1f6] px-4 py-3">
              <div><Dialog.Title className="m-0 text-[15px] font-semibold">同步单店设置</Dialog.Title><Dialog.Description className="mt-1 text-[12px] text-[#667085]">目标店铺只接收本店存在的匹配类目</Dialog.Description></div>
              <Dialog.Close className="grid size-7 place-items-center"><X className="size-4" /></Dialog.Close>
            </div>
            <button className="flex items-center gap-3 border-b border-[#edf1f6] bg-[#f8fafc] px-4 py-2.5 text-left text-[12px] font-semibold text-[#344054] disabled:opacity-45" type="button" disabled={!syncTargets.length || syncRunning} onClick={() => setSyncTargetIds(allSyncTargetsSelected ? new Set() : new Set(syncTargets.map((store) => store.shopId)))}>
              <SelectionBox checked={allSyncTargetsSelected} mixed={someSyncTargetsSelected} />
              <span>全选目标店铺</span>
              <span className="ml-auto text-[11px] font-normal text-[#98a2b3]">{syncTargets.length} 家</span>
            </button>
            <div className="min-h-[220px] overflow-auto divide-y divide-[#edf1f6]">{syncTargets.map((store) => <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[#f8fafc]" type="button" key={storeIdentityKey(store)} onClick={() => setSyncTargetIds((current) => { const next = new Set(current); if (next.has(store.shopId)) next.delete(store.shopId); else next.add(store.shopId); return next; })}><SelectionBox checked={syncTargetIds.has(store.shopId)} /><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-semibold">{store.shopName}</span><span className="mt-0.5 block text-[11px] text-[#98a2b3]">{store.shopId}</span></span></button>)}</div>
            <div className="flex items-center justify-between border-t border-[#edf1f6] px-4 py-3"><span className="text-[12px] text-[#667085]">已选择 {syncTargetIds.size} 家</span><div className="flex gap-2"><Dialog.Close className="h-8 rounded-md border border-[#dbe5f2] px-3 text-[12px]">取消</Dialog.Close><button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white disabled:opacity-45" type="button" disabled={!syncTargetIds.size || syncRunning} onClick={() => void synchronizeSettings()}>{syncRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Copy className="size-3.5" />}同步</button></div></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={cleanupConfirmOpen} onOpenChange={(open) => !busy && setCleanupConfirmOpen(open)}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-[#101828]/35" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(430px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl"><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#fff1ef] text-[#b42318]"><Trash2 className="size-4" /></span><div><Dialog.Title className="m-0 text-[15px] font-semibold text-[#101828]">清理失效收藏</Dialog.Title><Dialog.Description className="mt-1.5 text-[12px] leading-5 text-[#667085]">将清理本次勾选的 {selectedStores.length} 家店铺中的失效收藏，平台已经接受的清理请求无法撤销。</Dialog.Description></div></div><div className="mt-5 flex justify-end gap-2"><Dialog.Close className="h-8 rounded-md border border-[#dbe5f2] px-3 text-[12px]">取消</Dialog.Close><button className="h-8 rounded-md bg-[#d92d20] px-3 text-[12px] font-semibold text-white" type="button" onClick={() => void runCleanup()}>确认清理</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    </section>
  );
}
