import type {
  DoudianAdapterPayload,
  DoudianRunDetail,
  DoudianStoreResult,
  DoudianStoreSummary,
  DoudianStoreStatus
} from "../../types";
import { listStoreLedger, upsertStoreLedgers } from "./storeGroups";
import { runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { dispatchDoudianProgress } from "./progress";
import { currentShopState, policyNumber } from "./storeResponse";
import { confirmedStoreIdentityPatch } from "./storeIdentity";

interface RefreshStatusPayload {
  operationId: string;
  doudianAdapter: DoudianAdapterPayload;
  shopIds?: string[];
  mockStatus?: DoudianStoreStatus;
}

const DEFAULT_REFRESH_STATUS_CONCURRENCY = 3;

function nowIso() {
  return new Date().toISOString();
}

function selectedStores(stores: DoudianStoreSummary[] = [], shopIds?: string[]) {
  const ids = new Set((shopIds || []).map((id) => String(id)).filter(Boolean));
  return ids.size ? stores.filter((store) => ids.has(String(store.shopId))) : stores;
}

function refreshConcurrency(args: RefreshStatusPayload) {
  const configured = policyNumber(args.doudianAdapter.adapter, "refreshStatus.concurrency", DEFAULT_REFRESH_STATUS_CONCURRENCY);
  return Math.max(1, Math.min(8, Math.floor(configured)));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) {
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

function detailForStore(store: DoudianStoreSummary, ok: boolean, message: string, index: number, total: number, diagnostic?: unknown): DoudianRunDetail {
  return {
    shopId: store.shopId,
    shopName: store.shopName,
    status: store.status,
    ok,
    message,
    reason: ok ? "" : store.lastFailureReason || "refresh-failed",
    category: ok ? "" : "check",
    diagnostic,
    index,
    total
  };
}

async function refreshOneStore(store: DoudianStoreSummary, args: RefreshStatusPayload, index: number, total: number) {
  const timestamp = nowIso();
  let ok = false;
  let status: DoudianStoreStatus = "check_failed";
  let message = "校验失败，已保留本地店铺台账，请按需重新获取或单店修复";
  let failureReason = "check-failed";
  let diagnostic: unknown;
  let identityPatch: ReturnType<typeof confirmedStoreIdentityPatch> = {};

  if (args.mockStatus) {
    status = args.mockStatus;
    ok = args.mockStatus === "online";
    message = ok ? "登录有效" : "登录失效，请重新登录";
    failureReason = ok ? "" : "login-offline";
  } else {
    const result: RequestPlanResult = await runDoudianRequestPlan(args.doudianAdapter, {
      partition: store.partition,
      planKey: "currentShop",
      context: { shopId: store.shopId, shopName: store.shopName }
    }).catch((error) => ({
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
      source: "currentShop"
    }));

    if (result.ok !== true) {
      ok = false;
      status = "offline";
      message = "登录失效，请重新登录";
      failureReason = "login-offline";
      diagnostic = {
        source: result.source,
        status: result.status,
        error: result.error,
        signFailureReason: result.signFailureReason
      };
    } else {
      const state = currentShopState(result, args.doudianAdapter.adapter, store, "refreshStatus");
      ok = state.ok;
      status = ok ? "online" : "check_failed";
      message = ok ? "登录有效" : state.message || "当前登录店铺与目标店铺不一致，已保留台账";
      failureReason = ok ? "" : state.reason || "shop-mismatch";
      if (ok) identityPatch = confirmedStoreIdentityPatch(store, state);
      diagnostic = {
        source: result.source,
        status: result.status,
        currentShopId: state.currentShopId,
        currentShopName: state.currentShopName,
        targetShopId: store.shopId,
        targetShopName: store.shopName
      };
    }
  }

  const next: DoudianStoreSummary = {
    ...store,
    ...identityPatch,
    status,
    updatedAt: timestamp,
    lastLoginCheckAt: timestamp,
    lastOnlineAt: ok ? timestamp : store.lastOnlineAt || "",
    lastCheckStatus: ok ? "ok" : status,
    lastCheckMessage: message,
    lastResult: message,
    lastResultAt: timestamp,
    lastFailureReason: failureReason,
    lastFailureMessage: ok ? "" : message,
    adapterVersion: args.doudianAdapter.adapter.version
  };

  dispatchDoudianProgress({
    operationId: args.operationId,
    taskType: "refreshDoudianStoreStatus",
    status: "running",
    progress: Math.round((index / Math.max(total, 1)) * 100),
    message: `${next.shopName}: ${message}`
  });
  return {
    store: next,
    detail: detailForStore(next, ok, message, index, total, diagnostic)
  };
}

export async function runRefreshDoudianStoreStatusTask(args: RefreshStatusPayload): Promise<DoudianStoreResult> {
  const snapshot = await listStoreLedger();
  const targets = selectedStores(snapshot.stores || [], args.shopIds);
  const refreshed: DoudianStoreSummary[] = [];
  const details: DoudianRunDetail[] = [];

  const results = await mapWithConcurrency(targets, refreshConcurrency(args), (store, index) => (
    refreshOneStore(store, args, index + 1, targets.length)
  ));
  for (const result of results) {
    refreshed.push(result.store);
    details.push(result.detail);
  }

  if (refreshed.length) await upsertStoreLedgers(refreshed);
  return {
    ...(await listStoreLedger()),
    ok: true,
    status: details.some((detail) => detail.ok === false) ? "partial" : "ok",
    operationId: args.operationId,
    refreshed: refreshed.length,
    message: `已刷新 ${refreshed.length} 家店铺登录态`,
    details
  };
}
