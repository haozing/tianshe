import {
  DOUDIAN_PROGRESS_EVENT,
  type DoudianTaskMessage,
  type DoudianProgressDetail,
  type DoudianTaskRequest
} from "./progress";
import { runFetchDoudianStoresTask } from "./storeImport";
import { runProductCatalogSyncTask } from "./productCatalog";
import { runRefreshDoudianStoreStatusTask } from "./storeStatus";
import { cancelOpportunityPipelineSubmitTask, runOpportunityPipelineSubmitTask } from "./opportunityReport";
import { cancelOpportunityFavoriteRecords, clearInvalidOpportunityFavorites } from "./opportunityFavorites";
import { runOpportunityAutoFavorites } from "./opportunityAutoFavorites";
import { fetchOpportunityFavoriteRecords } from "./opportunityFavoriteRecords";
import { fetchBusinessData } from "./businessData";
import { fetchFundsData } from "./fundsData";
import { fetchViolationsData } from "./violationsData";
import { fetchStaleGoodsCleanup } from "./staleGoods";
import { runMarketingTask } from "./marketing";
import { isDoudianMutationTask, mutationCancellationOutcome } from "./taskSafety";
import { fetchBulkDeleteProducts } from "./bulkDelete";
import { fetchOpportunityReport } from "./opportunityReport";
import { fetchOpportunityFavoriteCategories } from "./opportunityAutoFavorites";
import { reconcileMarketingOperation } from "./marketing/reconcile";
import { loadConfig } from "../../bridge/config";
import { loadDoudianAdapterPayload } from "../../bridge/doudianAdapter";
import { getChihuNative } from "../../native/client";
import type { DoudianOpportunityAutoFavoriteProgress, DoudianOpportunityFavoriteRecordsProgress } from "../../types";
import { listStoreLedger } from "./storeGroups";

interface RunningTask {
  cancelled: boolean;
  mutation: boolean;
  inFlightMutations: number;
  mutationStarted: boolean;
  terminalPosted?: boolean;
  timer?: number;
  heartbeatTimer?: number;
  cleanup?: () => Promise<void> | void;
  cancelCleanup?: () => Promise<void> | void;
  windows?: number[];
}

const runningTasks = new Map<string, RunningTask>();

type RunnerChannel = { postMessage: (message: DoudianTaskMessage) => Promise<void> };

function createRunnerChannel(): RunnerChannel {
  return {
    async postMessage(message) {
      await getChihuNative()?.tasks?.report(message);
    }
  };
}

function post(channel: RunnerChannel, message: DoudianTaskMessage) {
  return channel.postMessage(message);
}

function channelResult(task: DoudianTaskRequest, result: unknown) {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  if (task.taskType === "staleGoodsScan" || task.taskType === "bulkDeleteScan") {
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    return candidates.length ? { ...record, candidates: [], candidateCount: candidates.length, candidatesDeferred: true } : result;
  }
  if (task.taskType === "staleGoodsExecute" || task.taskType === "bulkDeleteExecute") {
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    const executions = Array.isArray(record.executions) ? record.executions : [];
    return candidates.length || executions.length
      ? { ...record, candidates: [], executions: [], candidateCount: candidates.length, executionCount: executions.length, candidatesDeferred: candidates.length > 0, executionsDeferred: executions.length > 0 }
      : result;
  }
  if (task.taskType !== "violationsData") return result;
  const records = Array.isArray(record.records) ? record.records : [];
  return records.length ? { ...record, records: [], recordCount: records.length, recordsDeferred: true } : result;
}

function installProgressForwarder(channel: RunnerChannel) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<DoudianProgressDetail>).detail;
    if (!detail?.operationId || detail.status !== "running") return;
    post(channel, {
      type: "task:progress",
      operationId: detail.operationId,
      progress: detail.progress,
      message: detail.message,
      store: detail.store,
      business: detail.business
    });
  };
  window.addEventListener(DOUDIAN_PROGRESS_EVENT, listener);
  return () => window.removeEventListener(DOUDIAN_PROGRESS_EVENT, listener);
}

function startTask(channel: RunnerChannel, message: Extract<DoudianTaskMessage, { type: "task:start" }>) {
  const operationId = message.operation.operationId;
  if (runningTasks.has(operationId)) return true;
  if (message.task.taskType === "mockLongTask") {
    runMockLongTask(channel, operationId, message.task);
  } else {
    void runDomainTask(channel, operationId, message.task);
  }
  return true;
}

function startHeartbeat(channel: RunnerChannel, operationId: string, state: RunningTask) {
  const send = () => post(channel, {
    type: "task:heartbeat",
    operationId,
    inFlightMutations: state.inFlightMutations,
    mutationStarted: state.mutationStarted
  });
  send();
  state.heartbeatTimer = window.setInterval(send, 2000);
  return send;
}

function stopHeartbeat(state: RunningTask) {
  if (state.heartbeatTimer) window.clearInterval(state.heartbeatTimer);
}

function runMockLongTask(channel: RunnerChannel, operationId: string, task: DoudianTaskRequest) {
  const state: RunningTask = { cancelled: false, mutation: false, inFlightMutations: 0, mutationStarted: false };
  runningTasks.set(operationId, state);
  startHeartbeat(channel, operationId, state);
  const durationMs = Math.max(500, Number(task.durationMs || 2500));
  const stepMs = Math.max(100, Number(task.stepMs || 250));
  const startedAt = Date.now();

  const tick = () => {
    if (state.cancelled) {
      post(channel, { type: "task:result", operationId, resultSummary: "cancelled" });
      stopHeartbeat(state);
      runningTasks.delete(operationId);
      return;
    }

    const elapsed = Date.now() - startedAt;
    const progress = Math.min(100, Math.round((elapsed / durationMs) * 100));
    post(channel, {
      type: "task:progress",
      operationId,
      progress,
      message: progress >= 100 ? "mock task completed" : `mock task ${progress}%`
    });

    if (progress >= 100) {
      post(channel, { type: "task:result", operationId, resultSummary: "mock task completed" });
      stopHeartbeat(state);
      runningTasks.delete(operationId);
      return;
    }

    state.timer = window.setTimeout(tick, stepMs);
  };

  tick();
}

async function cancelTask(operationId: string) {
  const task = runningTasks.get(operationId);
  if (!task) return;
  task.cancelled = true;
  if (task.timer) window.clearTimeout(task.timer);
  if (task.mutation) return;
  try {
    await task.cancelCleanup?.();
  } catch {
    // Best-effort cleanup; the owner page also performs cancellation cleanup.
  }
  try {
    await task.cleanup?.();
  } catch {
    // Ignore cleanup failures during cancellation.
  }
}

async function hydrateTaskPayload(payload: Record<string, unknown>) {
  const [adapterPayload, configResult, ledgerResult] = await Promise.all([
    loadDoudianAdapterPayload(),
    loadConfig(),
    listStoreLedger().catch(() => ({ stores: [] }))
  ]);
  const stores = Array.isArray((ledgerResult as { stores?: unknown[] }).stores) ? (ledgerResult as { stores: Array<Record<string, unknown>> }).stores : [];
  const byShopId = new Map(stores.map((store) => [String(store.shopId || ""), store]));
  const hydrate = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(hydrate);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const shopId = String(record.shopId || "");
    const ledger = shopId ? byShopId.get(shopId) : undefined;
    const next = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, hydrate(item)]));
    if (ledger) {
      for (const key of ["shopName", "partition", "tenantId", "storeGeneration", "status"]) {
        if (ledger[key] !== undefined) next[key] = ledger[key];
      }
    }
    return next;
  };
  return {
    ...(hydrate(payload) as Record<string, unknown>),
    doudianAdapter: adapterPayload,
    config: configResult.config
  };
}

async function runDomainTask(channel: RunnerChannel, operationId: string, task: DoudianTaskRequest) {
  const state: RunningTask = {
    cancelled: false,
    mutation: isDoudianMutationTask(task),
    inFlightMutations: 0,
    mutationStarted: false,
    windows: []
  };
  state.cleanup = async () => {
    const native = window.chihuNative;
    if (!native?.windows.destroy) return;
    await Promise.all((state.windows || []).map((winId) => native.windows.destroy({ winId }).catch(() => null)));
  };
  runningTasks.set(operationId, state);
  const reportHeartbeat = startHeartbeat(channel, operationId, state);
  try {
    const hydratedPayload = await hydrateTaskPayload(task.payload || {});
    const payload = {
      operationId,
      ...hydratedPayload,
      isCancelled: () => state.cancelled,
      beginMutation: () => {
        state.mutationStarted = true;
        state.inFlightMutations += 1;
        reportHeartbeat();
      },
      endMutation: () => {
        state.inFlightMutations = Math.max(0, state.inFlightMutations - 1);
        reportHeartbeat();
      },
      trackWindow: (winId: number) => {
        if (Number.isInteger(winId)) state.windows?.push(winId);
      }
    };
    if (state.cancelled) throw new Error("cancelled");
    let result: unknown = null;
    if (task.taskType === "fetchDoudianStores") {
      result = await runFetchDoudianStoresTask({
        ...payload
      } as unknown as Parameters<typeof runFetchDoudianStoresTask>[0]);
    } else if (task.taskType === "refreshDoudianStoreStatus") {
      result = await runRefreshDoudianStoreStatusTask({
        ...payload
      } as unknown as Parameters<typeof runRefreshDoudianStoreStatusTask>[0]);
    } else if (task.taskType === "syncProductCatalog") {
      result = await runProductCatalogSyncTask({
        ...payload
      } as unknown as Parameters<typeof runProductCatalogSyncTask>[0]);
    } else if (task.taskType === "businessData") {
      result = await fetchBusinessData({
        ...payload
      } as unknown as Parameters<typeof fetchBusinessData>[0]);
    } else if (task.taskType === "fundsData") {
      result = await fetchFundsData({
        ...payload
      } as unknown as Parameters<typeof fetchFundsData>[0]);
    } else if (task.taskType === "violationsData") {
      result = await fetchViolationsData({
        ...payload
      } as unknown as Parameters<typeof fetchViolationsData>[0]);
    } else if (task.taskType === "staleGoodsScan" || task.taskType === "staleGoodsExecute") {
      result = await fetchStaleGoodsCleanup({
        ...payload
      } as unknown as Parameters<typeof fetchStaleGoodsCleanup>[0]);
    } else if (task.taskType === "bulkDeleteScan" || task.taskType === "bulkDeleteExecute") {
      result = await fetchBulkDeleteProducts({
        ...payload,
        onProgress: (detail: unknown) => {
          const progress = detail && typeof detail === "object" ? Number((detail as { progress?: unknown }).progress || 0) : 0;
          post(channel, { type: "task:progress", operationId, progress, message: "批量删除任务执行中" });
        },
        shouldCancel: () => state.cancelled
      } as unknown as Parameters<typeof fetchBulkDeleteProducts>[0]);
    } else if (task.taskType === "opportunityReportScan" || task.taskType === "opportunityReportAction") {
      result = await fetchOpportunityReport({
        ...payload
      } as unknown as Parameters<typeof fetchOpportunityReport>[0]);
    } else if (task.taskType === "opportunityFavoriteCategories") {
      result = await fetchOpportunityFavoriteCategories({
        ...payload
      } as unknown as Parameters<typeof fetchOpportunityFavoriteCategories>[0]);
    } else if (task.taskType === "opportunityFavoriteRecords") {
      result = await fetchOpportunityFavoriteRecords({
        ...payload,
        onPage: async (detail: DoudianOpportunityFavoriteRecordsProgress) => {
          const total = Number(detail.total || 0);
          const progress = detail.totalKnown && total > 0
            ? Math.min(99, Math.max(1, Math.round((detail.loaded / total) * 100)))
            : Math.min(99, Math.max(1, detail.current));
          await post(channel, {
            type: "task:progress",
            operationId,
            progress,
            message: `已获取 ${detail.loaded} 个收藏商机词${total ? ` / 共 ${total}` : ""}`,
            favoriteRecords: detail
          });
        }
      } as unknown as Parameters<typeof fetchOpportunityFavoriteRecords>[0]);
    } else if (task.taskType === "marketingReconcile") {
      result = await reconcileMarketingOperation(operationId);
    } else if (task.taskType === "opportunityPipelineSubmit") {
      state.cancelCleanup = async () => {
        await cancelOpportunityPipelineSubmitTask({
          operationId,
          reason: "已取消商机提报任务"
        });
      };
      result = await runOpportunityPipelineSubmitTask({
        ...payload
      } as unknown as Parameters<typeof runOpportunityPipelineSubmitTask>[0]);
    } else if (task.taskType === "opportunityFavoritesClearInvalid") {
      result = await clearInvalidOpportunityFavorites({
        ...payload
      } as unknown as Parameters<typeof clearInvalidOpportunityFavorites>[0]);
    } else if (task.taskType === "opportunityFavoriteCancel") {
      result = await cancelOpportunityFavoriteRecords({
        ...payload
      } as unknown as Parameters<typeof cancelOpportunityFavoriteRecords>[0]);
    } else if (task.taskType === "opportunityAutoFavorites") {
      result = await runOpportunityAutoFavorites({
        ...payload,
        onRow: async (detail: DoudianOpportunityAutoFavoriteProgress) => {
          await post(channel, {
            type: "task:progress",
            operationId,
            progress: detail.progress,
            message: detail.message,
            autoFavorite: detail
          });
        }
      } as unknown as Parameters<typeof runOpportunityAutoFavorites>[0]);
    } else if (task.taskType === "marketingTask") {
      result = await runMarketingTask(payload as unknown as Parameters<typeof runMarketingTask>[0]);
    } else {
      throw new Error(`unsupported task type: ${task.taskType}`);
    }
    if (state.terminalPosted) {
      // Cancellation already reported immediately by the command handler.
    } else if (state.cancelled && !state.mutation) {
      post(channel, { type: "task:result", operationId, resultSummary: "cancelled", result: { ok: false, status: "cancelled", message: "已取消任务" } });
    } else if (state.cancelled) {
      const outcome = mutationCancellationOutcome({ mutation: true, mutationStarted: state.mutationStarted, result });
      post(channel, {
        type: "task:result",
        operationId,
        resultSummary: outcome.resultSummary,
        result: outcome.result
      });
    } else {
      post(channel, { type: "task:result", operationId, resultSummary: "completed", result: channelResult(task, result) });
    }
  } catch (error) {
    if (!state.terminalPosted) {
      post(channel, state.cancelled && !state.mutation
        ? { type: "task:result", operationId, resultSummary: "cancelled", result: { ok: false, status: "cancelled", message: "已取消任务" } }
        : {
            type: "task:error",
            operationId,
            error: error instanceof Error ? error.message : String(error),
            mutationStarted: state.mutationStarted,
            inFlightMutations: state.inFlightMutations
          });
    }
  } finally {
    stopHeartbeat(state);
    await state.cleanup?.();
    runningTasks.delete(operationId);
  }
}

export function installDoudianTaskRunner() {
  const channel = createRunnerChannel();
  const removeProgressForwarder = installProgressForwarder(channel);
  const runnerTaskId = new URLSearchParams(location.search).get("taskId") || "";
  const isTargetTask = (operationId: string) => !runnerTaskId || operationId === runnerTaskId;
  const handleMessage = (message: DoudianTaskMessage) => {
    if (message?.type !== "task:start") return false;
    const operationId = message.operation.operationId;
    if (!isTargetTask(operationId)) return false;
    return startTask(channel, message);
  };
  const handleCancel = async (operationId: string) => {
    if (!isTargetTask(operationId)) return false;
    const task = runningTasks.get(operationId);
    if (!task) return false;
    await cancelTask(operationId);
    if (task.mutation) return true;
    task.terminalPosted = true;
    post(channel, { type: "task:result", operationId, resultSummary: "cancelled", result: { ok: false, status: "cancelled", message: "已取消任务" } });
    stopHeartbeat(task);
    runningTasks.delete(operationId);
    return true;
  };
  const removeCommandListener = getChihuNative()?.tasks?.onCommand((message) => {
    const next = message as DoudianTaskMessage;
    if (next?.type === "task:start") handleMessage(next);
    if (next?.type === "task:cancel") void handleCancel(next.operationId);
  }) || (() => undefined);
  return { channel, dispose: () => { removeProgressForwarder(); removeCommandListener(); } };
}

export function isDoudianTaskRunnerRoute() {
  return new URLSearchParams(location.search).get("runner") === "1";
}
