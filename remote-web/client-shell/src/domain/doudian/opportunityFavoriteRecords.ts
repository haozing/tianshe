import type {
  DoudianAdapterPayload,
  DoudianOpportunityFavoriteRecord,
  DoudianOpportunityFavoriteRecordsProgress,
  DoudianOpportunityFavoriteRecordsResult,
  DoudianStoreIdentityRef,
  DoudianStoreSummary
} from "../../types";
import { storeIdentityKey } from "./opportunityStoreState";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan } from "./requestPlan";
import { listStoreLedger } from "./storeGroups";
import { buildOpportunityFavoriteRecordsBody, normalizeOpportunityFavoriteRecord } from "./opportunityFavoriteRecordMapping";

const RECORDS_PLAN = "opportunityFavoriteAutoSubmitPage";
const DEFAULT_PAGE_SIZE = 24;
const DEFAULT_MAX_PAGES = 100;

interface FavoriteRecordsArgs {
  doudianAdapter: DoudianAdapterPayload;
  shopIds?: string[];
  storeRefs?: DoudianStoreIdentityRef[];
  taskStatus?: number;
  pageSize?: number;
  startPage?: number;
  maxPages?: number;
  onPage?: (detail: DoudianOpportunityFavoriteRecordsProgress) => Promise<void> | void;
  isCancelled?: () => boolean;
  trackWindow?: (winId: number) => void;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function numberValue(value: unknown) {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  return Number.isFinite(next) ? Math.max(min, Math.min(max, Math.floor(next))) : fallback;
}

function findRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  for (const path of ["data", "data.data", "list", "data.list", "records", "data.records"]) {
    const rows = getPathValue(value, path);
    if (Array.isArray(rows)) return rows;
  }
  return [];
}

function responseMessage(value: unknown) {
  return text(firstPathValue(value, ["message", "msg", "status_message", "statusMessage", "base_resp.status_message", "data.base_resp.status_message"]));
}

export async function fetchOpportunityFavoriteRecords(args: FavoriteRecordsArgs): Promise<DoudianOpportunityFavoriteRecordsResult> {
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const byIdentity = new Map(stores.map((store) => [storeIdentityKey(store), store]));
  const store = args.storeRefs?.length
    ? args.storeRefs.map((ref) => byIdentity.get(storeIdentityKey(ref))).find((item): item is DoudianStoreSummary => Boolean(item))
    : stores.find((item) => !(args.shopIds || []).length || args.shopIds?.includes(item.shopId));
  const pageSize = boundedInteger(args.pageSize, DEFAULT_PAGE_SIZE, 1, 100);
  const startPage = boundedInteger(args.startPage, 1, 1, 10000);
  const maxPages = boundedInteger(args.maxPages, DEFAULT_MAX_PAGES, 1, DEFAULT_MAX_PAGES);
  const cancelRequestPlan = text(getPathValue(args.doudianAdapter.adapter.policies, "opportunityFavorites.cancelRequestPlan"));
  if (!store) return { ...ledger, ok: false, status: "no-store", message: "请先选择可用店铺", rows: [], total: 0, totalKnown: false, current: 0, pageSize, hasMore: false, cancelSupported: Boolean(cancelRequestPlan) };

  const planKey = text(getPathValue(args.doudianAdapter.adapter.policies, "opportunityFavorites.recordsRequestPlan")) || RECORDS_PLAN;
  const records = new Map<string, DoudianOpportunityFavoriteRecord>();
  let remoteTotal = 0;
  let totalKnown = false;
  let loadedPages = 0;
  let hasMore = false;
  const endPage = startPage + maxPages - 1;
  for (let current = startPage; current <= endPage; current += 1) {
    if (args.isCancelled?.()) break;
    const body = buildOpportunityFavoriteRecordsBody(current, pageSize, args.taskStatus);
    const response = await runDoudianRequestPlan(args.doudianAdapter, {
      partition: store.partition,
      planKey,
      context: { body, bodyJson: JSON.stringify(body) },
      trackWindow: args.trackWindow,
      shouldCancel: args.isCancelled
    });
    if (!requestPlanResponseOk(response, args.doudianAdapter.adapter, planKey)) {
      return {
        ...ledger,
        ok: records.size > 0,
        status: records.size ? "partial" : "failed",
        message: responseMessage(response.data) || response.error || "已收藏商机词读取失败",
        rows: [...records.values()],
        total: remoteTotal || records.size,
        totalKnown,
        current: loadedPages,
        pageSize,
        hasMore,
        cancelSupported: Boolean(cancelRequestPlan)
      };
    }
    const rows = findRows(response.data);
    const pageRows: DoudianOpportunityFavoriteRecord[] = [];
    loadedPages = current;
    const rawTotal = firstPathValue(response.data, ["total", "data.total", "page.total", "data.page.total", "count", "data.count"]);
    if (rawTotal !== undefined && rawTotal !== null && rawTotal !== "") {
      remoteTotal = numberValue(rawTotal);
      totalKnown = true;
    }
    for (const value of rows) {
      const row = normalizeOpportunityFavoriteRecord(store, value);
      if (row) {
        records.set(`${row.taskId}:${row.clueId}`, row);
        pageRows.push(row);
      }
    }
    const loaded = (current - 1) * pageSize + pageRows.length;
    hasMore = rows.length >= pageSize && (!totalKnown || loaded < remoteTotal);
    await args.onPage?.({
      storeRef: {
        tenantId: String(store.tenantId || ""),
        shopId: store.shopId,
        storeGeneration: Number(store.storeGeneration || 0)
      },
      rows: pageRows,
      total: totalKnown ? remoteTotal : loaded,
      totalKnown,
      loaded,
      current,
      pageSize,
      hasMore,
      cancelSupported: Boolean(cancelRequestPlan)
    });
    if (!hasMore) break;
  }
  return {
    ...ledger,
    ok: true,
    status: args.isCancelled?.() ? "cancelled" : "ok",
    message: `已读取 ${records.size} 个收藏商机词`,
    rows: [...records.values()],
    total: totalKnown ? remoteTotal : (startPage - 1) * pageSize + records.size,
    totalKnown,
    current: loadedPages,
    pageSize,
    hasMore,
    cancelSupported: Boolean(cancelRequestPlan)
  };
}
