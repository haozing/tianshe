import type {
  DoudianAdapterPayload,
  DoudianOpportunityFavoriteCleanupRow,
  DoudianOpportunityFavoriteCancelResult,
  DoudianOpportunityFavoriteCancelRow,
  DoudianOpportunityFavoritesResult,
  DoudianRunDetail,
  DoudianStoreIdentityRef,
  DoudianStoreSummary
} from "../../types";
import { assertMutationStoreActive } from "./mutationSafety";
import { reportDoudianDiagnostic } from "./diagnosticLog";
import { storeIdentityKey, storeIdentityRef } from "./opportunityStoreState";
import { dispatchDoudianProgress } from "./progress";
import { firstPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { listStoreLedger } from "./storeGroups";
import { currentShopState, policy, policyNumber, text } from "./storeResponse";

const TASK_TYPE = "opportunityFavoritesClearInvalid";
const DEFAULT_REQUEST_PLAN = "opportunityFavoriteClearInvalid";

interface OpportunityFavoritesArgs {
  operationId: string;
  doudianAdapter: DoudianAdapterPayload;
  shopIds?: string[];
  storeRefs?: DoudianStoreIdentityRef[];
  isCancelled?: () => boolean;
  trackWindow?: (winId: number) => void;
}

interface TargetResolution {
  targets: DoudianStoreSummary[];
  missing: DoudianOpportunityFavoriteCleanupRow[];
}

function nowIso() {
  return new Date().toISOString();
}

function policyText(adapter: OpportunityFavoritesArgs["doudianAdapter"]["adapter"], path: string, fallback: string) {
  const value = text(policy(adapter, path, fallback));
  return value || fallback;
}

function policyMessage(
  adapter: OpportunityFavoritesArgs["doudianAdapter"]["adapter"],
  path: string,
  fallback: string,
  values: Record<string, number> = {}
) {
  return policyText(adapter, path, fallback).replace(/\{([^}]+)\}/g, (_match, key) => String(values[key] ?? ""));
}

function failedRow(ref: Partial<DoudianStoreIdentityRef>, shopName: string, message: string): DoudianOpportunityFavoriteCleanupRow {
  return {
    tenantId: text(ref.tenantId) || "local-user",
    shopId: text(ref.shopId),
    shopName: text(shopName) || text(ref.shopId) || "未知店铺",
    storeGeneration: Math.max(1, Math.trunc(Number(ref.storeGeneration || 1))),
    status: "failed",
    ok: false,
    message,
    httpStatus: 0,
    attemptedAt: nowIso()
  };
}

function resolveTargets(stores: DoudianStoreSummary[], args: OpportunityFavoritesArgs): TargetResolution {
  const byIdentity = new Map(stores.map((store) => [storeIdentityKey(store), store]));
  if (args.storeRefs?.length) {
    const targets: DoudianStoreSummary[] = [];
    const missing: DoudianOpportunityFavoriteCleanupRow[] = [];
    const seen = new Set<string>();
    for (const ref of args.storeRefs) {
      const key = storeIdentityKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      const store = byIdentity.get(key);
      if (store) targets.push(store);
      else missing.push(failedRow(ref, "", "店铺已被删除或重新登录，请刷新店铺列表后重试"));
    }
    return { targets, missing };
  }

  const requestedIds = Array.from(new Set((args.shopIds || []).map(text).filter(Boolean)));
  const byShopId = new Map(stores.map((store) => [store.shopId, store]));
  return {
    targets: requestedIds.map((shopId) => byShopId.get(shopId)).filter((store): store is DoudianStoreSummary => Boolean(store)),
    missing: requestedIds.filter((shopId) => !byShopId.has(shopId)).map((shopId) => failedRow({ shopId }, "", "未找到目标店铺"))
  };
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

function responseMessage(response: RequestPlanResult | undefined) {
  return text(firstPathValue(response?.data, ["message", "msg", "error_message", "errorMessage", "base_resp.status_message", "data.base_resp.status_message"])) || text(response?.error);
}

function auditMessage(value: unknown) {
  return text(value).replace(/https?:\/\/\S+/gi, "[url]").slice(0, 240);
}

function rowForStore(
  store: DoudianStoreSummary,
  status: DoudianOpportunityFavoriteCleanupRow["status"],
  message: string,
  httpStatus = 0
): DoudianOpportunityFavoriteCleanupRow {
  const identity = storeIdentityRef(store);
  return {
    ...identity,
    shopName: store.shopName,
    status,
    ok: status === "success",
    message,
    httpStatus,
    attemptedAt: nowIso()
  };
}

function rowDetail(row: DoudianOpportunityFavoriteCleanupRow, index: number, total: number): DoudianRunDetail {
  return {
    tenantId: row.tenantId,
    shopId: row.shopId,
    shopName: row.shopName,
    storeGeneration: row.storeGeneration,
    status: row.status,
    ok: row.ok,
    message: row.message,
    reason: row.ok ? "" : row.status === "cancelled" ? "cancelled" : "opportunity-favorites-clear-failed",
    category: row.ok ? "" : "api",
    attemptedAt: row.attemptedAt,
    diagnostic: { httpStatus: row.httpStatus },
    index,
    total
  };
}

async function clearStore(
  store: DoudianStoreSummary,
  args: OpportunityFavoritesArgs,
  planKey: string,
  currentProgress: () => number
): Promise<DoudianOpportunityFavoriteCleanupRow> {
  const adapter = args.doudianAdapter.adapter;
  const cancelledMessage = policyText(adapter, "opportunityFavorites.messages.cancelled", "清理任务已取消");
  const identity = storeIdentityRef(store);
  const finish = async (row: DoudianOpportunityFavoriteCleanupRow, diagnostic: Record<string, unknown> = {}) => {
    await reportDoudianDiagnostic({
      category: "opportunity-favorites",
      event: "clear-invalid-store-result",
      operationId: args.operationId,
      ...identity,
      shopName: store.shopName,
      status: row.status,
      ok: row.ok,
      message: auditMessage(row.message),
      httpStatus: row.httpStatus,
      adapterVersion: adapter.version,
      ...diagnostic
    }, true);
    return row;
  };
  if (args.isCancelled?.()) return finish(rowForStore(store, "cancelled", cancelledMessage));

  dispatchDoudianProgress({
    operationId: args.operationId,
    taskType: TASK_TYPE,
    status: "running",
    progress: currentProgress(),
    message: `${store.shopName}: ${policyText(adapter, "opportunityFavorites.messages.checking", "正在校验店铺登录态")}`
  });

  try {
    await assertMutationStoreActive(store);
    const currentShop = await runDoudianRequestPlan(args.doudianAdapter, {
      partition: store.partition,
      planKey: "currentShop",
      context: { shopId: store.shopId, shopName: store.shopName },
      trackWindow: args.trackWindow,
      shouldCancel: args.isCancelled
    });
    if (!currentShop.ok) {
      return finish(rowForStore(store, "failed", responseMessage(currentShop) || "店铺登录态校验失败", currentShop.status), {
        stage: "current-shop",
        source: currentShop.source,
        attemptCount: currentShop.attemptCount || 1,
        signFailureReason: currentShop.signFailureReason || ""
      });
    }
    const activeShop = currentShopState(currentShop, adapter, store, "opportunityFavorites");
    if (!activeShop.ok) {
      return finish(rowForStore(store, "failed", activeShop.message || "当前抖店与目标店铺不一致", currentShop.status), {
        stage: "current-shop-match",
        currentShopId: activeShop.currentShopId,
        currentShopName: activeShop.currentShopName,
        reason: activeShop.reason || "shop-mismatch"
      });
    }
    if (args.isCancelled?.()) return finish(rowForStore(store, "cancelled", cancelledMessage), { stage: "before-submit" });

    await assertMutationStoreActive(store);
    dispatchDoudianProgress({
      operationId: args.operationId,
      taskType: TASK_TYPE,
      status: "running",
      progress: currentProgress(),
      message: `${store.shopName}: ${policyText(adapter, "opportunityFavorites.messages.clearing", "正在清理失效商机")}`
    });
    const response = await runDoudianRequestPlan(args.doudianAdapter, {
      partition: store.partition,
      planKey,
      context: { shopId: store.shopId, shopName: store.shopName },
      trackWindow: args.trackWindow,
      shouldCancel: args.isCancelled
    });
    const successFlag = firstPathValue(response.data, ["success"]);
    const responseOk = requestPlanResponseOk(response, adapter, planKey) && successFlag === true;
    if (!responseOk) {
      return finish(rowForStore(
        store,
        "failed",
        responseMessage(response) || policyText(adapter, "opportunityFavorites.messages.storeFailed", "失效商机清理失败"),
        response.status
      ), {
        stage: "clear-invalid",
        planKey,
        source: response.source,
        responseCode: firstPathValue(response.data, ["code", "status_code", "statusCode", "errno"]),
        successFlag,
        attemptCount: response.attemptCount || 1,
        signFailureReason: response.signFailureReason || ""
      });
    }
    return finish(rowForStore(
      store,
      "success",
      policyText(adapter, "opportunityFavorites.messages.storeDone", "失效商机清理请求成功"),
      response.status
    ), {
      stage: "clear-invalid",
      planKey,
      source: response.source,
      responseCode: firstPathValue(response.data, ["code", "status_code", "statusCode", "errno"]),
      successFlag,
      attemptCount: response.attemptCount || 1
    });
  } catch (error) {
    return finish(rowForStore(store, "failed", error instanceof Error ? error.message : String(error)), {
      stage: "exception",
      error: auditMessage(error instanceof Error ? error.message : error)
    });
  }
}

export async function clearInvalidOpportunityFavorites(args: OpportunityFavoritesArgs): Promise<DoudianOpportunityFavoritesResult> {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  const ledger = await listStoreLedger();
  const resolution = resolveTargets(ledger.stores || [], args);
  const adapter = args.doudianAdapter.adapter;
  const planKey = policyText(adapter, "opportunityFavorites.clearInvalidRequestPlan", DEFAULT_REQUEST_PLAN);
  const concurrency = Math.max(1, Math.min(4, Math.floor(policyNumber(adapter, "opportunityFavorites.concurrency", 2))));
  let completedCount = 0;
  const processed = await mapWithConcurrency(resolution.targets, concurrency, async (store) => {
    const row = await clearStore(
      store,
      args,
      planKey,
      () => Math.round((completedCount / Math.max(resolution.targets.length, 1)) * 100)
    );
    completedCount += 1;
    dispatchDoudianProgress({
      operationId: args.operationId,
      taskType: TASK_TYPE,
      status: "running",
      progress: Math.round((completedCount / Math.max(resolution.targets.length, 1)) * 100),
      message: `${store.shopName}: ${row.message}`
    });
    return row;
  });
  const rows = [...resolution.missing, ...processed];
  const successCount = rows.filter((row) => row.status === "success").length;
  const failureCount = rows.filter((row) => row.status === "failed").length;
  const cancelledCount = rows.filter((row) => row.status === "cancelled").length;
  const total = rows.length;
  const status = !total || (!successCount && failureCount) ? "failed" : !successCount && cancelledCount === total ? "cancelled" : failureCount || cancelledCount ? "partial" : "ok";
  const message = !total
    ? "请选择要清理的店铺"
    : status === "cancelled"
      ? policyMessage(adapter, "opportunityFavorites.messages.cancelled", "已停止后续店铺；停止前提交的清理请求不会撤销", { successCount, failureCount, cancelledCount })
      : status === "failed"
      ? policyMessage(adapter, "opportunityFavorites.messages.failed", "所选店铺均未清理成功", { successCount, failureCount, cancelledCount })
      : status === "partial"
        ? policyMessage(adapter, "opportunityFavorites.messages.partial", "已完成 {successCount} 家，{failureCount} 家失败", { successCount, failureCount, cancelledCount })
        : policyMessage(adapter, "opportunityFavorites.messages.done", "已完成 {successCount} 家店铺", { successCount, failureCount, cancelledCount });
  const details = rows.map((row, index) => rowDetail(row, index + 1, total));

  await reportDoudianDiagnostic({
    category: "opportunity-favorites",
    event: "clear-invalid-run-summary",
    operationId: args.operationId,
    status,
    successCount,
    failureCount,
    cancelledCount,
    storeCount: total,
    adapterVersion: adapter.version
  }, true);

  return {
    ok: status === "ok",
    status,
    message,
    operationId: args.operationId,
    adapterVersion: adapter.version,
    scriptsVersion: args.doudianAdapter.scripts?.version || "",
    rows,
    details,
    successCount,
    failureCount,
    cancelledCount,
    stores: ledger.stores || [],
    groups: ledger.groups || []
  };
}

interface OpportunityFavoriteCancelArgs extends OpportunityFavoritesArgs {
  taskIds?: Array<string | number>;
  beginMutation?: () => void;
  endMutation?: () => void;
}

function cancelRow(store: DoudianStoreSummary, taskId: string, status: DoudianOpportunityFavoriteCancelRow["status"], message: string, httpStatus?: number): DoudianOpportunityFavoriteCancelRow {
  return {
    ...storeIdentityRef(store),
    shopName: store.shopName,
    taskId,
    status,
    ok: status === "success",
    message,
    httpStatus,
    attemptedAt: nowIso()
  };
}

export async function cancelOpportunityFavoriteRecords(args: OpportunityFavoriteCancelArgs): Promise<DoudianOpportunityFavoriteCancelResult> {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  const taskIds = Array.from(new Set((args.taskIds || []).map((value) => text(value)).filter(Boolean)));
  const ledger = await listStoreLedger();
  const store = args.storeRefs?.length
    ? args.storeRefs.map((ref) => (ledger.stores || []).find((item) => storeIdentityKey(item) === storeIdentityKey(ref))).find((item): item is DoudianStoreSummary => Boolean(item))
    : (ledger.stores || []).find((item) => !(args.shopIds || []).length || (args.shopIds || []).includes(item.shopId));
  if (!store) return { ...ledger, ok: false, status: "no-store", message: "请先选择可用店铺", rows: [], successCount: 0, failureCount: 0, cancelledCount: 0 };
  if (!taskIds.length) return { ...ledger, ok: false, status: "no-selection", message: "请先选择要取消的收藏", rows: [], successCount: 0, failureCount: 0, cancelledCount: 0 };

  const adapter = args.doudianAdapter.adapter;
  const planKey = policyText(adapter, "opportunityFavorites.cancelRequestPlan", "opportunityFavoriteCancel");
  const rows: DoudianOpportunityFavoriteCancelRow[] = [];
  try {
    await assertMutationStoreActive(store);
    const currentShop = await runDoudianRequestPlan(args.doudianAdapter, {
      partition: store.partition,
      planKey: "currentShop",
      context: { shopId: store.shopId, shopName: store.shopName },
      trackWindow: args.trackWindow,
      shouldCancel: args.isCancelled
    });
    if (!currentShop.ok) throw new Error(responseMessage(currentShop) || "店铺登录态校验失败");
    const activeShop = currentShopState(currentShop, adapter, store, "opportunityFavorites");
    if (!activeShop.ok) throw new Error(activeShop.message || "当前抖店与目标店铺不一致");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...ledger, ok: false, status: "failed", message, rows: taskIds.map((taskId) => cancelRow(store, taskId, "failed", message)), successCount: 0, failureCount: taskIds.length, cancelledCount: 0 };
  }

  for (const [index, taskId] of taskIds.entries()) {
    if (args.isCancelled?.()) {
      rows.push(...taskIds.slice(index).map((pending) => cancelRow(store, pending, "cancelled", "取消任务已停止")));
      break;
    }
    const numericTaskId = Number(taskId);
    const body = { auto_submit_task_id: Number.isSafeInteger(numericTaskId) ? numericTaskId : taskId };
    dispatchDoudianProgress({ operationId: args.operationId, taskType: "opportunityFavoriteCancel", status: "running", progress: Math.round((index / taskIds.length) * 100), message: `${store.shopName}: 正在取消收藏 ${index + 1}/${taskIds.length}` });
    let response: RequestPlanResult | undefined;
    try {
      args.beginMutation?.();
      response = await runDoudianRequestPlan(args.doudianAdapter, {
        partition: store.partition,
        planKey,
        context: { body, bodyJson: JSON.stringify(body) },
        trackWindow: args.trackWindow,
        shouldCancel: args.isCancelled
      });
      const ok = requestPlanResponseOk(response, adapter, planKey);
      rows.push(cancelRow(store, taskId, ok ? "success" : "failed", responseMessage(response) || (ok ? "收藏已取消" : "取消收藏失败"), response.status));
    } catch (error) {
      rows.push(cancelRow(store, taskId, "failed", error instanceof Error ? error.message : String(error), response?.status));
    } finally {
      args.endMutation?.();
    }
    if (index + 1 < taskIds.length && !args.isCancelled?.()) await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  const successCount = rows.filter((row) => row.status === "success").length;
  const failureCount = rows.filter((row) => row.status === "failed").length;
  const cancelledCount = rows.filter((row) => row.status === "cancelled").length;
  const status = successCount === taskIds.length ? "ok" : successCount ? "partial" : cancelledCount === taskIds.length ? "cancelled" : "failed";
  dispatchDoudianProgress({ operationId: args.operationId, taskType: "opportunityFavoriteCancel", status: status === "ok" ? "succeeded" : status === "cancelled" ? "cancelled" : status === "partial" ? "partial" : "failed", progress: 100, message: `已取消 ${successCount} 个收藏` });
  return {
    ...ledger,
    ok: status === "ok",
    status,
    message: status === "ok" ? `已取消 ${successCount} 个收藏` : `已取消 ${successCount} 个，失败 ${failureCount} 个${cancelledCount ? `，停止 ${cancelledCount} 个` : ""}`,
    operationId: args.operationId,
    rows,
    successCount,
    failureCount,
    cancelledCount
  };
}
