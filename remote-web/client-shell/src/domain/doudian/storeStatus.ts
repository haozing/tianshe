import type {
  DoudianAdapterPayload,
  DoudianRunDetail,
  DoudianStoreResult,
  DoudianStoreSummary,
  DoudianStoreStatus
} from "../../types";
import { listStoreLedger, upsertStoreLedgers } from "./storeGroups";
import { runDoudianRequestPlan } from "./requestPlan";
import { dispatchDoudianProgress } from "./progress";

interface RefreshStatusPayload {
  operationId: string;
  doudianAdapter: DoudianAdapterPayload;
  shopIds?: string[];
  mockStatus?: DoudianStoreStatus;
}

function nowIso() {
  return new Date().toISOString();
}

function selectedStores(stores: DoudianStoreSummary[] = [], shopIds?: string[]) {
  const ids = new Set((shopIds || []).map((id) => String(id)).filter(Boolean));
  return ids.size ? stores.filter((store) => ids.has(String(store.shopId))) : stores;
}

function detailForStore(store: DoudianStoreSummary, ok: boolean, message: string, index: number, total: number): DoudianRunDetail {
  return {
    shopId: store.shopId,
    shopName: store.shopName,
    status: store.status,
    ok,
    message,
    reason: ok ? "" : store.lastFailureReason || "refresh-failed",
    category: ok ? "" : "check",
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

  if (args.mockStatus) {
    status = args.mockStatus;
    ok = args.mockStatus === "online";
    message = ok ? "登录有效" : "登录失效，请重新登录";
    failureReason = ok ? "" : "login-offline";
  } else {
    const result = await runDoudianRequestPlan(args.doudianAdapter, {
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
    ok = result.ok === true;
    status = ok ? "online" : "offline";
    message = ok ? "登录有效" : "登录失效，请重新登录";
    failureReason = ok ? "" : "login-offline";
  }

  const next: DoudianStoreSummary = {
    ...store,
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
    message: `${store.shopName}: ${message}`
  });
  return {
    store: next,
    detail: detailForStore(next, ok, message, index, total)
  };
}

export async function runRefreshDoudianStoreStatusTask(args: RefreshStatusPayload): Promise<DoudianStoreResult> {
  const snapshot = await listStoreLedger();
  const targets = selectedStores(snapshot.stores || [], args.shopIds);
  const refreshed: DoudianStoreSummary[] = [];
  const details: DoudianRunDetail[] = [];

  for (const [index, store] of targets.entries()) {
    const result = await refreshOneStore(store, args, index + 1, targets.length);
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
