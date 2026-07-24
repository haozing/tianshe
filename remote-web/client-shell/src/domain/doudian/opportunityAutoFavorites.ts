import type {
  DoudianAdapterConfig,
  DoudianAdapterPayload,
  DoudianOpportunityAutoFavoriteFilters,
  DoudianOpportunityAutoFavoriteProgress,
  DoudianOpportunityAutoFavoriteRow,
  DoudianOpportunityAutoFavoritesResult,
  DoudianOpportunityFavoriteCategory,
  DoudianOpportunityFavoriteQueryMode,
  DoudianOpportunityFavoriteSortField,
  DoudianRunDetail,
  DoudianStoreIdentityRef,
  DoudianStoreSummary
} from "../../types";
import { listStoreLedger } from "./storeGroups";
import { assertMutationStoreActive } from "./mutationSafety";
import { storeIdentityKey } from "./opportunityStoreState";
import { dispatchDoudianProgress } from "./progress";
import { getPathValue, firstPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";

const CLUE_LIST_PLAN = "opportunityClueRealtimeList";
const COLLECT_PLAN = "opportunityCollectClue";
const CATEGORY_PLAN = "opportunityCategoryList";
const DEFAULT_PAGE_SIZE = 18;
const DEFAULT_MAX_PAGES = 60;
const DEFAULT_PER_STORE_LIMIT = 1000;
const DEFAULT_COLLECT_DELAY_MS = 1200;
const CATEGORY_KEYS = ["first_cid", "second_cid", "third_cid", "fourth_cid"] as const;

interface AutoFavoriteArgs {
  doudianAdapter?: DoudianAdapterPayload;
  shopIds?: string[];
  storeRefs?: DoudianStoreIdentityRef[];
  filters?: DoudianOpportunityAutoFavoriteFilters;
  storeFilters?: Record<string, DoudianOpportunityAutoFavoriteFilters>;
  operationId?: string;
  dryRun?: boolean;
  onRow?: (detail: DoudianOpportunityAutoFavoriteProgress) => Promise<void> | void;
  isCancelled?: () => boolean;
  trackWindow?: (winId: number) => void;
}

interface FavoriteCandidate {
  clueId: string;
  clueName: string;
  categoryName: string;
  autoSubmitId: string;
  payAmount: number;
  growthRate: number;
  onlineProductCount: number;
  demandSupplyRate: number;
  searchCount: number;
  bestRemoteRank: number;
  firstSeenOrder: number;
  sourceSortFields: Set<string>;
  sourceCategories: Set<string>;
  raw: Record<string, unknown>;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object") {
    const record = objectRecord(value);
    for (const key of ["value", "val", "amount", "count", "cnt", "num", "score", "rate", "total", "text"]) {
      const next: number = numberValue(record[key]);
      if (next) return next;
    }
    return 0;
  }
  const source = text(value).replace(/,/g, "").replace(/万|w/gi, "");
  const match = source.match(/-?\d+(?:\.\d+)?/);
  const parsed = match ? Number(match[0]) : 0;
  return Number.isFinite(parsed) ? parsed * (/万|w/i.test(text(value)) ? 10000 : 1) : 0;
}

function percentValue(value: unknown) {
  const next = numberValue(value);
  return Math.abs(next) > 0 && Math.abs(next) <= 1 ? next * 100 : next;
}

function findArray(root: unknown, paths: string[]) {
  if (Array.isArray(root)) return root;
  for (const path of paths) {
    const value = getPathValue(root, path);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function arrayText(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function responseMessage(response: RequestPlanResult | undefined) {
  if (!response) return "";
  return text(firstPathValue(response.data, ["message", "msg", "status_message", "statusMessage", "error", "data.message", "data.msg", "data.data.message", "data.data.msg"])) || text(response.error);
}

function mappingPaths(adapter: DoudianAdapterConfig, key: string, fallback: string[], planKey = CLUE_LIST_PLAN) {
  const mappings = objectRecord(objectRecord(adapter.responseMappings).opportunityReport);
  const configured = arrayText(mappings[key]);
  const prefixes = Array.from(new Set([planKey, CLUE_LIST_PLAN].filter(Boolean)));
  return configured.length
    ? configured.map((path) => {
      const prefix = prefixes.find((item) => path.startsWith(`${item}.`));
      return prefix ? path.slice(prefix.length + 1) : path;
    })
    : fallback;
}

function autoCollectPolicyText(adapter: DoudianAdapterConfig, key: string, fallback: string) {
  const value = text(getPathValue(adapter.policies, `opportunityFavorites.autoCollect.${key}`));
  return value || fallback;
}

function autoCollectPolicyModes(adapter: DoudianAdapterConfig) {
  const value = getPathValue(adapter.policies, "opportunityFavorites.autoCollect.queryModes");
  if (!Array.isArray(value)) return [] as DoudianOpportunityFavoriteQueryMode[];
  return value
    .map((item) => objectRecord(item))
    .filter((item) => text(item.sortField))
    .map((item) => ({
      id: text(item.id) || text(item.sortField),
      label: text(item.label),
      sortField: text(item.sortField),
      recommendReasons: Array.isArray(item.recommendReasons) ? item.recommendReasons as DoudianOpportunityFavoriteQueryMode["recommendReasons"] : undefined
    }));
}

function autoCollectPolicyNumber(adapter: DoudianAdapterConfig, key: string, fallback: number) {
  const value = Number(getPathValue(adapter.policies, `opportunityFavorites.autoCollect.${key}`));
  return Number.isFinite(value) ? value : fallback;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  return Number.isFinite(next) ? Math.max(min, Math.min(max, Math.floor(next))) : fallback;
}

function categoryKey(level: number) {
  return CATEGORY_KEYS[Math.max(0, Math.min(CATEGORY_KEYS.length - 1, level - 1))];
}

function categoryIdOf(record: Record<string, unknown>, key: string) {
  return text(record[key] || record[key.replace("_cid", "Cid")] || record.cate_id || record.cateId || record.id || record.value);
}

function categoryNameOf(record: Record<string, unknown>) {
  return text(record.cate_name || record.cateName || record.category_name || record.categoryName || record.name || record.label || record.title);
}

function flattenCategories(value: unknown, parentPath: string[] = [], level = 1): DoudianOpportunityFavoriteCategory[] {
  if (!Array.isArray(value)) return [];
  const rows: DoudianOpportunityFavoriteCategory[] = [];
  for (const item of value) {
    if (Array.isArray(item)) {
      rows.push(...flattenCategories(item, parentPath, level));
      continue;
    }
    const record = objectRecord(item);
    const currentLevel = Math.max(1, Math.min(4, Number(record.level || record.levelNo || level)));
    const id = categoryIdOf(record, categoryKey(currentLevel));
    const name = categoryNameOf(record);
    const path = name ? [...parentPath, name] : parentPath;
    if (id && name) {
      rows.push({ id, key: categoryKey(currentLevel), name, level: currentLevel, path });
    }
    const children = record.children || record.child || record.sub_category || record.subCategory || record.items;
    rows.push(...flattenCategories(children, path, currentLevel + 1));
  }
  return rows;
}

function buildCategoryBody(category: DoudianOpportunityFavoriteCategory | undefined) {
  if (!category?.id) return undefined;
  return [{ [category.key || categoryKey(category.level || 3)]: numberValue(category.id) }];
}

function buildClueSearchBody(args: {
  category?: DoudianOpportunityFavoriteCategory;
  sortField: DoudianOpportunityFavoriteSortField;
  recommendReasons: DoudianOpportunityAutoFavoriteFilters["recommendReasons"];
  benefitIds: DoudianOpportunityAutoFavoriteFilters["benefitIds"];
  page: number;
  pageSize: number;
}) {
  const condition: Record<string, unknown> = {
    hit_clue_label_ext: true,
    show_new_supply_link: true,
    include_hot_sales_products: true,
    sort: { sort_direction: 1, sort_field: args.sortField },
    tag_id_list: (args.recommendReasons || []).map((item) => Number(item.id)).filter(Number.isFinite),
    profit_id_list: (args.benefitIds || []).map(Number).filter(Number.isFinite),
    benefit_crowd_group: [],
    benefit_content_type: [],
    ...(args.recommendReasons?.length ? {
      recommend_reason_list: args.recommendReasons.map((item) => ({ id: text(item.id), type: Number(item.type || 1) }))
    } : {}),
    ...(buildCategoryBody(args.category) ? { categories: buildCategoryBody(args.category) } : {})
  };
  return {
    condition,
    clue_type: "",
    clue_type_new: 11,
    page: { current: args.page, page_size: args.pageSize },
    terminal_type: 0,
    source: "business_center",
    _lid: `${Date.now()}${Math.floor(Math.random() * 1000000)}`
  };
}

function normalizeCandidate(rawValue: unknown, sortField: string, category: DoudianOpportunityFavoriteCategory | undefined, remoteRank: number, firstSeenOrder: number): FavoriteCandidate | null {
  const raw = objectRecord(rawValue);
  const detail = objectRecord(raw.clue_detail || raw.clueDetail || raw.detail || raw);
  const indicator = objectRecord(raw.clue_indicator || raw.clueIndicator || raw.indicator);
  const autoSubmit = objectRecord(raw.auto_submit_task || raw.autoSubmitTask);
  const clueId = text(detail.clue_id || detail.clueId || raw.clue_id || raw.clueId || detail.id);
  if (!clueId) return null;
  const categoryPath = Array.isArray(detail.category_path || detail.categoryPath)
    ? (detail.category_path || detail.categoryPath) as unknown[]
    : [];
  const categoryName = categoryPath.map((item) => typeof item === "string" || typeof item === "number" ? text(item) : categoryNameOf(objectRecord(item))).filter(Boolean).join(">") || text(detail.category_name || detail.categoryName || category?.path?.join(">"));
  const payAmount = numberValue(indicator.pay_amount_ind || indicator.payAmountInd || indicator.pay_amount_ind_range || indicator.payAmountIndRange);
  return {
    clueId,
    clueName: text(detail.name || detail.clue_name || detail.clueName || detail.title) || clueId,
    categoryName,
    autoSubmitId: text(autoSubmit.auto_submit_task_id || autoSubmit.autoSubmitTaskId),
    payAmount,
    growthRate: percentValue(indicator.pay_amount_ind_30d_rate || indicator.payAmountInd30dRate),
    onlineProductCount: numberValue(indicator.online_prod_cnt || indicator.onlineProdCnt || indicator.online_prod_cnt_range || indicator.onlineProdCntRange),
    demandSupplyRate: numberValue(indicator.demand_supply_rate || indicator.demandSupplyRate),
    searchCount: numberValue(indicator.search_pv_cnt || indicator.searchPvCnt || indicator.search_pv_cnt_range || indicator.searchPvCntRange),
    bestRemoteRank: remoteRank,
    firstSeenOrder,
    sourceSortFields: new Set([sortField]),
    sourceCategories: new Set([category ? `${category.key}:${category.id}` : "all"]),
    raw
  };
}

function mergeCandidate(current: FavoriteCandidate | undefined, next: FavoriteCandidate) {
  if (!current) return next;
  current.autoSubmitId ||= next.autoSubmitId;
  current.categoryName ||= next.categoryName;
  current.payAmount = Math.max(current.payAmount, next.payAmount);
  current.growthRate = Math.max(current.growthRate, next.growthRate);
  current.onlineProductCount = current.onlineProductCount || next.onlineProductCount;
  current.demandSupplyRate = Math.max(current.demandSupplyRate, next.demandSupplyRate);
  current.searchCount = Math.max(current.searchCount, next.searchCount);
  current.bestRemoteRank = Math.min(current.bestRemoteRank, next.bestRemoteRank);
  next.sourceSortFields.forEach((value) => current.sourceSortFields.add(value));
  next.sourceCategories.forEach((value) => current.sourceCategories.add(value));
  return current;
}

function rankCandidates(candidates: FavoriteCandidate[]) {
  return [...candidates].sort((left, right) => left.firstSeenOrder - right.firstSeenOrder || left.bestRemoteRank - right.bestRemoteRank || left.clueId.localeCompare(right.clueId));
}

function isFavoriteQuotaMessage(message: string) {
  return /1000|收藏.{0,8}(上限|已满|最大)|已达.{0,8}(上限|最大)/.test(message);
}

function isTerminalFavoriteFailure(message: string) {
  return /未登录|请登录|环境存在风险|访问过于频繁|操作太频繁|风控|滑块|验证|签名失败/.test(message);
}

function progress(args: AutoFavoriteArgs, value: number, message: string) {
  dispatchDoudianProgress({
    operationId: args.operationId || "",
    taskType: "opportunityAutoFavorites",
    status: "running",
    progress: Math.max(0, Math.min(100, Math.round(value))),
    message
  });
}

async function waitBetweenCollects(args: AutoFavoriteArgs, delayMs = DEFAULT_COLLECT_DELAY_MS) {
  const endAt = Date.now() + Math.max(0, delayMs);
  while (Date.now() < endAt && !args.isCancelled?.()) {
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(200, endAt - Date.now())));
  }
}

async function loadStoreCandidates(args: AutoFavoriteArgs, store: DoudianStoreSummary, filters: DoudianOpportunityAutoFavoriteFilters, storeIndex: number, storeCount: number) {
  const categories = filters.categoryPlans?.length
    ? filters.categoryPlans.map((item) => item.category)
    : filters.categories?.length ? filters.categories : [undefined];
  const sortFields = Array.from(new Set((filters.sortFields || ["TRADING_AMOUNT"]).map(text).filter(Boolean)));
  const configuredModes = autoCollectPolicyModes(args.doudianAdapter!.adapter);
  const queryModes = filters.queryModes?.length
    ? filters.queryModes
    : configuredModes.length
      ? configuredModes
      : sortFields.map((sortField) => ({ id: sortField, sortField, recommendReasons: filters.recommendReasons || [] }));
  const configuredPageSize = boundedInteger(autoCollectPolicyNumber(args.doudianAdapter!.adapter, "pageSize", DEFAULT_PAGE_SIZE), DEFAULT_PAGE_SIZE, 1, 100);
  const configuredMaxPages = boundedInteger(autoCollectPolicyNumber(args.doudianAdapter!.adapter, "maxPagesPerQuery", DEFAULT_MAX_PAGES), DEFAULT_MAX_PAGES, 1, 100);
  const pageSize = boundedInteger(filters.pageSize, configuredPageSize, 1, 100);
  const maxPages = boundedInteger(filters.maxPagesPerQuery, configuredMaxPages, 1, 100);
  const targetCandidateCount = boundedInteger(filters.perStoreLimit, DEFAULT_PER_STORE_LIMIT, 1, DEFAULT_PER_STORE_LIMIT);
  const categoryLimits = new Map((filters.categoryPlans || []).map((item) => [
    `${item.category.key}:${item.category.id}`,
    boundedInteger(item.limit, targetCandidateCount, 1, DEFAULT_PER_STORE_LIMIT)
  ]));
  const byClueId = new Map<string, FavoriteCandidate>();
  const sourceFailures: Array<{ message: string; status: number; terminal: boolean }> = [];
  let firstSeenOrder = 0;
  let queryCount = 0;
  const totalQueries = Math.max(1, categories.length * queryModes.length);
  const hasEnoughCandidates = (category: DoudianOpportunityFavoriteCategory | undefined) => {
    const key = category ? `${category.key}:${category.id}` : "all";
    const target = categoryLimits.get(key) || targetCandidateCount;
    return Array.from(byClueId.values()).filter((candidate) => !candidate.autoSubmitId && candidate.sourceCategories.has(key)).length >= target;
  };
  outer: for (const category of categories) {
    for (const mode of queryModes) {
      queryCount += 1;
      let remoteTotal = 0;
      for (let page = 1; page <= maxPages; page += 1) {
        if (args.isCancelled?.()) return { candidates: [...byClueId.values()], cancelled: true, sourceFailures };
        const body = buildClueSearchBody({ category, sortField: mode.sortField, recommendReasons: mode.recommendReasons || filters.recommendReasons, benefitIds: filters.benefitIds, page, pageSize });
        const response = await runDoudianRequestPlan(args.doudianAdapter!, {
          partition: store.partition,
          planKey: autoCollectPolicyText(args.doudianAdapter!.adapter, "clueListRequestPlan", CLUE_LIST_PLAN),
          context: { body, bodyJson: JSON.stringify(body) },
          trackWindow: args.trackWindow,
          shouldCancel: args.isCancelled
        });
        const clueListPlan = autoCollectPolicyText(args.doudianAdapter!.adapter, "clueListRequestPlan", CLUE_LIST_PLAN);
        if (!requestPlanResponseOk(response, args.doudianAdapter!.adapter, clueListPlan)) {
          const message = responseMessage(response) || "商机候选查询失败";
          const terminal = isTerminalFavoriteFailure(message);
          sourceFailures.push({ message, status: response.status, terminal });
          if (terminal) break outer;
          break;
        }
        const rows = findArray(response.data, mappingPaths(args.doudianAdapter!.adapter, "clueListPaths", ["data", "data.data", "list", "data.list"], clueListPlan));
        remoteTotal = numberValue(firstPathValue(response.data, mappingPaths(args.doudianAdapter!.adapter, "clueTotalPaths", ["total", "data.total", "data.data.total"], clueListPlan))) || remoteTotal;
        rows.forEach((row, rowIndex) => {
          const candidate = normalizeCandidate(row, mode.sortField, category, (page - 1) * pageSize + rowIndex, firstSeenOrder++);
          if (candidate) byClueId.set(candidate.clueId, mergeCandidate(byClueId.get(candidate.clueId), candidate));
        });
        progress(args, ((storeIndex + (queryCount - 1 + page / Math.max(1, maxPages)) / totalQueries) / storeCount) * 55, `${store.shopName}: 正在获取商机候选`);
        if (hasEnoughCandidates(category) || !rows.length || (remoteTotal > 0 && page * pageSize >= remoteTotal)) break;
      }
      if (hasEnoughCandidates(category)) break;
    }
  }
  return { candidates: [...byClueId.values()], cancelled: false, sourceFailures };
}

function normalizeFavoriteFilters(input: DoudianOpportunityAutoFavoriteFilters | undefined, configuredLimit: number): DoudianOpportunityAutoFavoriteFilters {
  const categoryPlans = (input?.categoryPlans || [])
    .filter((item) => item?.category?.id)
    .map((item) => ({ category: item.category, limit: boundedInteger(item.limit, 100, 1, configuredLimit) }));
  const categories = categoryPlans.length ? categoryPlans.map((item) => item.category) : input?.categories || [];
  const requestedLimit = categoryPlans.length
    ? categoryPlans.reduce((sum, item) => sum + item.limit, 0)
    : input?.perStoreLimit;
  return {
    categories,
    categoryPlans,
    sortFields: Array.from(new Set((input?.sortFields || ["TRADING_AMOUNT"]).map(text).filter(Boolean))),
    queryModes: input?.queryModes || [],
    recommendReasons: input?.recommendReasons || [],
    benefitIds: Array.from(new Set((input?.benefitIds || []).map(Number).filter(Number.isFinite))),
    perStoreLimit: boundedInteger(requestedLimit, configuredLimit, 1, configuredLimit),
    pageSize: input?.pageSize,
    maxPagesPerQuery: input?.maxPagesPerQuery
  };
}

function selectCandidatesByCategoryPlans(candidates: FavoriteCandidate[], filters: DoudianOpportunityAutoFavoriteFilters) {
  const available = candidates.filter((candidate) => !candidate.autoSubmitId);
  if (!filters.categoryPlans?.length) return available.slice(0, filters.perStoreLimit);
  const selected = new Map<string, FavoriteCandidate>();
  for (const plan of filters.categoryPlans) {
    const categoryKey = `${plan.category.key}:${plan.category.id}`;
    let count = 0;
    for (const candidate of available) {
      if (selected.has(candidate.clueId) || !candidate.sourceCategories.has(categoryKey)) continue;
      selected.set(candidate.clueId, candidate);
      count += 1;
      if (count >= plan.limit || selected.size >= Number(filters.perStoreLimit || DEFAULT_PER_STORE_LIMIT)) break;
    }
    if (selected.size >= Number(filters.perStoreLimit || DEFAULT_PER_STORE_LIMIT)) break;
  }
  return [...selected.values()];
}

function executionRow(store: DoudianStoreSummary, candidate: FavoriteCandidate | undefined, status: DoudianOpportunityAutoFavoriteRow["status"], ok: boolean, message: string, response?: RequestPlanResult, diagnostic: Record<string, unknown> = {}, planKey = COLLECT_PLAN): DoudianOpportunityAutoFavoriteRow {
  return {
    tenantId: store.tenantId,
    shopId: store.shopId,
    shopName: store.shopName,
    storeGeneration: store.storeGeneration,
    clueId: candidate?.clueId,
    clueName: candidate?.clueName,
    categoryName: candidate?.categoryName,
    status,
    ok,
    message,
    httpStatus: response?.status,
    planKey: response ? planKey : undefined,
    attemptedAt: new Date().toISOString(),
    diagnostic
  };
}

async function appendExecutionRow(args: AutoFavoriteArgs, rows: DoudianOpportunityAutoFavoriteRow[], row: DoudianOpportunityAutoFavoriteRow, progressValue: number, message?: string) {
  rows.push(row);
  const normalizedProgress = Math.max(0, Math.min(100, Math.round(progressValue)));
  await args.onRow?.({
    row,
    completed: rows.length,
    progress: normalizedProgress,
    message: message || `${row.shopName}: ${row.clueName || row.message}`
  });
}

export async function fetchOpportunityFavoriteCategories(args: { doudianAdapter: DoudianAdapterPayload; shopIds?: string[]; storeRefs?: DoudianStoreIdentityRef[] }) {
  const ledger = await listStoreLedger();
  const byIdentity = new Map((ledger.stores || []).map((store) => [storeIdentityKey(store), store]));
  const store = args.storeRefs?.length
    ? args.storeRefs.map((ref) => byIdentity.get(storeIdentityKey(ref))).find((item): item is DoudianStoreSummary => Boolean(item))
    : (ledger.stores || []).find((item) => !(args.shopIds || []).length || args.shopIds?.includes(item.shopId));
  if (!store) return { ok: false, status: "no-store", message: "请先选择可用店铺", categories: [] as DoudianOpportunityFavoriteCategory[] };
  const categoryPlan = autoCollectPolicyText(args.doudianAdapter.adapter, "categoryListRequestPlan", CATEGORY_PLAN);
  const response = await runDoudianRequestPlan(args.doudianAdapter, {
    partition: store.partition,
    planKey: categoryPlan,
    context: { shopId: store.shopId, shopName: store.shopName }
  });
  if (!requestPlanResponseOk(response, args.doudianAdapter.adapter, categoryPlan)) {
    return { ok: false, status: "failed", message: responseMessage(response) || "类目读取失败", categories: [] as DoudianOpportunityFavoriteCategory[] };
  }
  const root = firstPathValue(response.data, ["data", "data.data", "list"]) || response.data;
  const categories = flattenCategories(root);
  return { ok: true, status: "ok", message: `已加载 ${categories.length} 个类目`, categories };
}

export async function runOpportunityAutoFavorites(args: AutoFavoriteArgs): Promise<DoudianOpportunityAutoFavoritesResult> {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  const ledger = await listStoreLedger();
  const byIdentity = new Map((ledger.stores || []).map((store) => [storeIdentityKey(store), store]));
  const requestedRefs = Array.from(new Map((args.storeRefs || []).map((ref) => [storeIdentityKey(ref), ref])).values());
  const stores = requestedRefs.length
    ? requestedRefs.map((ref) => byIdentity.get(storeIdentityKey(ref))).filter((store): store is DoudianStoreSummary => Boolean(store))
    : (ledger.stores || []).filter((store) => !(args.shopIds || []).length || args.shopIds?.includes(store.shopId));
  const missingRefs = requestedRefs.filter((ref) => !byIdentity.has(storeIdentityKey(ref)));
  const configuredLimit = boundedInteger(autoCollectPolicyNumber(args.doudianAdapter.adapter, "perStoreLimit", DEFAULT_PER_STORE_LIMIT), DEFAULT_PER_STORE_LIMIT, 1, DEFAULT_PER_STORE_LIMIT);
  const filters = normalizeFavoriteFilters(args.filters, configuredLimit);
  if (!stores.length && !missingRefs.length) return { ...ledger, ok: false, status: "no-store", message: "请先选择店铺", rows: [], filters };
  const rows: DoudianOpportunityAutoFavoriteRow[] = [];
  const details: DoudianRunDetail[] = [];
  for (const ref of missingRefs) {
    await appendExecutionRow(args, rows, { tenantId: ref.tenantId, shopId: ref.shopId, shopName: ref.shopId, storeGeneration: ref.storeGeneration, status: "failed", ok: false, message: "店铺已被删除或重新登录，请刷新店铺列表后重试", attemptedAt: new Date().toISOString(), diagnostic: { reason: "store-identity-missing" } }, 0);
  }
  let candidateCount = 0;
  for (const [storeIndex, store] of stores.entries()) {
    if (args.isCancelled?.()) break;
    const startedAt = Date.now();
    const storeBaseProgress = 55 + (storeIndex / Math.max(1, stores.length)) * 45;
    const active = await assertMutationStoreActive(store);
    if (active.ok === false) {
      await appendExecutionRow(args, rows, executionRow(store, undefined, "failed", false, "店铺状态已变化，已停止收藏", undefined, { reason: "store-inactive" }), storeBaseProgress);
      details.push({ shopId: store.shopId, shopName: store.shopName, status: "failed", ok: false, message: "店铺状态已变化，已停止收藏", reason: "store-inactive", diagnostic: { candidateCount: 0 } });
      continue;
    }
    const storeFilters = normalizeFavoriteFilters(args.storeFilters?.[storeIdentityKey(store)] || filters, configuredLimit);
    if (!storeFilters.categoryPlans?.length && !storeFilters.categories.length) {
      await appendExecutionRow(args, rows, executionRow(store, undefined, "failed", false, "该店铺尚未添加收藏类目", undefined, { reason: "store-category-plan-missing" }), storeBaseProgress);
      details.push({ shopId: store.shopId, shopName: store.shopName, status: "failed", ok: false, message: "该店铺尚未添加收藏类目", reason: "store-category-plan-missing", diagnostic: { candidateCount: 0 } });
      continue;
    }
    const candidateResult = await loadStoreCandidates(args, store, storeFilters, storeIndex, stores.length);
    const allRanked = rankCandidates(candidateResult.candidates);
    const alreadyCollectedCount = allRanked.filter((candidate) => candidate.autoSubmitId).length;
    const ranked = selectCandidatesByCategoryPlans(allRanked, storeFilters);
    candidateCount += allRanked.length;
    let collected = 0;
    let skipped = 0;
    let failed = 0;
    let quotaExhausted = false;
    for (const failure of candidateResult.sourceFailures) {
      await appendExecutionRow(args, rows, executionRow(store, undefined, "failed", false, failure.message, undefined, { reason: "candidate-query-failed", terminal: failure.terminal, httpStatus: failure.status }), storeBaseProgress);
    }
    if (candidateResult.cancelled) {
      await appendExecutionRow(args, rows, executionRow(store, undefined, "cancelled", false, "任务已取消"), storeBaseProgress);
      details.push({ shopId: store.shopId, shopName: store.shopName, status: "cancelled", ok: false, message: "任务已取消", reason: "cancelled", diagnostic: { candidateCount: ranked.length } });
      break;
    }
    if (candidateResult.sourceFailures.some((failure) => failure.terminal)) {
      details.push({ shopId: store.shopId, shopName: store.shopName, status: "failed", ok: false, message: "商机候选查询被终止，请检查店铺登录态或风控状态", reason: "candidate-query-terminal-failure", diagnostic: { candidateCount: ranked.length, sourceFailures: candidateResult.sourceFailures } });
      continue;
    }
    const collectPlan = autoCollectPolicyText(args.doudianAdapter.adapter, "collectRequestPlan", COLLECT_PLAN);
    let terminalFailure = false;
    const publishCandidateRow = async (row: DoudianOpportunityAutoFavoriteRow, processed: number) => {
      const progressValue = 55 + ((storeIndex + processed / Math.max(1, ranked.length)) / stores.length) * 45;
      const progressMessage = `${store.shopName}: 已处理 ${processed}/${ranked.length} · ${row.clueName || row.message}`;
      await appendExecutionRow(args, rows, row, progressValue, progressMessage);
      progress(args, progressValue, progressMessage);
    };
    for (const candidate of ranked) {
      if (args.isCancelled?.()) {
        await publishCandidateRow(executionRow(store, candidate, "cancelled", false, "任务已取消"), collected + skipped + failed);
        break;
      }
      if (candidate.autoSubmitId) {
        skipped += 1;
        await publishCandidateRow(executionRow(store, candidate, "skipped", true, "该店铺已收藏该商机", undefined, { alreadyCollected: true }), collected + skipped + failed);
        continue;
      }
      if (args.dryRun) {
        skipped += 1;
        await publishCandidateRow(executionRow(store, candidate, "skipped", true, "dry-run：未提交收藏请求", undefined, { dryRun: true }), collected + skipped + failed);
        continue;
      }
      const body = {
        is_cate_type: false,
        clue_id: numberValue(candidate.clueId),
        terminal_type: 0,
        source: "business_center",
        module: "query",
        scene: ""
      };
      const response = await runDoudianRequestPlan(args.doudianAdapter, {
          partition: store.partition,
          planKey: collectPlan,
          context: { body, bodyJson: JSON.stringify(body) },
        trackWindow: args.trackWindow,
        shouldCancel: args.isCancelled
      });
      const requestOk = requestPlanResponseOk(response, args.doudianAdapter.adapter, collectPlan);
      const message = responseMessage(response) || (requestOk ? "商机已加入收藏" : "商机收藏失败");
      if (isFavoriteQuotaMessage(message)) {
        quotaExhausted = true;
        await publishCandidateRow(executionRow(store, candidate, "quota_exhausted", true, "该店铺已达到收藏商机上限", response, { favoriteQuotaReached: true }, collectPlan), collected + skipped + failed + 1);
        break;
      } else if (requestOk) {
        collected += 1;
        await publishCandidateRow(executionRow(store, candidate, "collected", true, "商机已加入收藏", response, {}, collectPlan), collected + skipped + failed);
      } else {
        failed += 1;
        await publishCandidateRow(executionRow(store, candidate, "failed", false, message, response, {}, collectPlan), collected + skipped + failed);
        terminalFailure = isTerminalFavoriteFailure(message);
      }
      if (terminalFailure) break;
      if (!args.isCancelled?.() && collected + skipped + failed < ranked.length) {
        await waitBetweenCollects(args, autoCollectPolicyNumber(args.doudianAdapter.adapter, "collectDelayMs", DEFAULT_COLLECT_DELAY_MS));
      }
    }
    details.push({
      shopId: store.shopId,
      shopName: store.shopName,
      status: quotaExhausted || failed || candidateResult.sourceFailures.length ? (collected || skipped ? "partial" : "failed") : "ok",
      ok: failed === 0 && candidateResult.sourceFailures.length === 0 && !terminalFailure,
      message: quotaExhausted ? "已达到该店铺收藏上限" : terminalFailure ? "收藏请求被终止，请检查店铺登录态或风控状态" : candidateResult.sourceFailures.length ? "商机候选查询部分失败" : failed ? "商机收藏部分失败" : "商机收藏已处理",
      reason: quotaExhausted ? "favorite-quota-exhausted" : terminalFailure ? "opportunity-auto-favorite-terminal-failure" : candidateResult.sourceFailures.length ? "opportunity-auto-favorite-query-partial" : failed ? "opportunity-auto-favorite-partial" : "",
      diagnostic: { candidateCount: allRanked.length, readyCandidateCount: ranked.length, alreadyCollectedCount, collected, skipped, failed, quotaExhausted, sourceFailures: candidateResult.sourceFailures, durationMs: Date.now() - startedAt }
    });
  }
  const successCount = rows.filter((row) => row.status === "collected").length;
  const skippedCount = rows.filter((row) => row.status === "skipped").length;
  const failureCount = rows.filter((row) => row.status === "failed").length;
  const quotaExhaustedCount = rows.filter((row) => row.status === "quota_exhausted").length;
  const cancelled = rows.some((row) => row.status === "cancelled") || Boolean(args.isCancelled?.());
  const status = cancelled ? "cancelled" : failureCount && !successCount ? "failed" : failureCount || quotaExhaustedCount ? "partial" : "ok";
  progress(args, 100, status === "cancelled" ? "自动收藏已取消" : "自动收藏处理完成");
  return {
    ...ledger,
    ok: status === "ok" || status === "partial",
    status,
    message: status === "cancelled" ? "自动收藏已取消" : status === "ok" ? `自动收藏完成，共收藏 ${successCount} 个商机` : `自动收藏完成，收藏 ${successCount} 个，失败 ${failureCount} 个${quotaExhaustedCount ? `，${quotaExhaustedCount} 家店铺达到上限` : ""}`,
    operationId: args.operationId,
    rows,
    details,
    successCount,
    skippedCount,
    failureCount,
    quotaExhaustedCount,
    candidateCount,
    filters
  };
}
