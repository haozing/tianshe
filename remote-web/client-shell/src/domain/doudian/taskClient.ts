import { getChihuNative } from "../../native/client";
import { getPreferences } from "../../bridge/storage";
import {
  acquireOperation,
  createOperation,
  getOperation,
  listActiveOperations,
  markOperationCancelling,
  markOperationCancelled,
  markOperationError,
  markOperationFullResult,
  markOperationProgress,
  markOperationHeartbeat,
  markOperationInterrupted,
  markOperationReconciling,
  markOperationResult,
  markOperationRunning,
  saveOperation,
  type DoudianOperationRecord
} from "./operation";
import {
  createTaskChannel,
  dispatchDoudianProgress,
  type DoudianTaskMessage,
  type DoudianTaskRequest
} from "./progress";
import { cancelOpportunityPipelineSubmitTask } from "./opportunityReport";
import type { DoudianStoreResult } from "../../types";
import { isDoudianMutationTask, restartRecoveryStatus } from "./taskSafety";
import { reconcileMarketingOperation } from "./marketing/reconcile";

const runnerWindows = new Map<string, number>();
const APP_SESSION_ID = `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
let channel: BroadcastChannel | null = null;
const DEFAULT_RUNNER_PARTITION = "persist:chihu-default";
const MAX_OPERATION_RESULT_RECORD_BYTES = 4 * 1024 * 1024;
type OperationLogPhase = "started" | "succeeded" | "partial" | "failed" | "cancelled";

type TaskWaiter = {
  resolve: (record: DoudianOperationRecord | null) => void;
  reject: (error: Error) => void;
  timer: number;
};

const waiters = new Map<string, TaskWaiter[]>();
const taskStartLocks = new Map<string, Promise<DoudianOperationRecord>>();
const ACTIVE_TASK_DEDUPE_MAX_AGE_MS = 30 * 60 * 1000;

function estimateJsonBytes(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function shouldPersistOperationResult(value: unknown) {
  return estimateJsonBytes(value) <= MAX_OPERATION_RESULT_RECORD_BYTES;
}

function operationLogPayload(record: DoudianOperationRecord | null | undefined) {
  if (!record) return {};
  const createdAt = Date.parse(record.createdAt || "");
  const updatedAt = Date.parse(record.updatedAt || "");
  return {
    operationId: record.operationId,
    taskType: record.taskType,
    status: record.status,
    progress: record.progress,
    adapterVersion: record.adapterVersion || "",
    ruleVersion: record.ruleVersion || "",
    hasResult: record.result !== undefined,
    resultSummary: record.resultSummary || "",
    durationMs: Number.isFinite(createdAt) && Number.isFinite(updatedAt) ? Math.max(0, updatedAt - createdAt) : 0
  };
}

async function reportOperationLog(phase: OperationLogPhase, record: DoudianOperationRecord | null | undefined, detail: Record<string, unknown> = {}) {
  const requiredFundsSummary = record?.taskType === "fundsData" && phase !== "started";
  const requiredViolationsLog = record?.taskType === "violationsData";
  if (!requiredFundsSummary && !requiredViolationsLog && !getPreferences().autoOperationLog) return;
  const native = getChihuNative();
  if (!native?.logs?.report) return;
  await native.logs.report({
    category: "doudian-task",
    event: `operation-${phase}`,
    phase,
    ...operationLogPayload(record),
    detail
  }).catch(() => undefined);
}

function fundsResultLogSummary(result: unknown) {
  if (!result || typeof result !== "object") return {};
  const record = result as Record<string, unknown>;
  const rawStats = record.interfaceStats && typeof record.interfaceStats === "object"
    ? record.interfaceStats as Record<string, unknown>
    : {};
  const interfaceStats = Object.fromEntries(Object.entries(rawStats).map(([planKey, value]) => {
    const stat = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return [planKey, {
      requestCount: Number(stat.requestCount || 0),
      successCount: Number(stat.successCount || 0),
      failureCount: Number(stat.failureCount || 0),
      retryCount: Number(stat.retryCount || 0),
      p95Ms: Number(stat.p95Ms || 0)
    }];
  }));
  return {
    status: String(record.status || ""),
    recordCount: Number(record.recordCount ?? (Array.isArray(record.records) ? record.records.length : 0)),
    successCount: Number(record.successCount || 0),
    partialCount: Number(record.partialCount || 0),
    failureCount: Number(record.failureCount || 0),
    incompleteMetricCount: Number(record.incompleteMetricCount || 0),
    cacheWriteCount: Number(record.cacheWriteCount || 0),
    cacheSkippedCount: Number(record.cacheSkippedCount || 0),
    durationMs: Number(record.durationMs || 0),
    interfaceStats
  };
}

function violationsResultLogSummary(result: unknown) {
  if (!result || typeof result !== "object") return {};
  const record = result as Record<string, unknown>;
  const rows = Array.isArray(record.rows) ? record.rows : [];
  const rowRecords = rows.map((row) => row && typeof row === "object" ? row as Record<string, unknown> : {});
  const dateRange = record.dateRange && typeof record.dateRange === "object"
    ? record.dateRange as Record<string, unknown>
    : {};
  return {
    runId: String(record.runId || ""),
    status: String(record.status || ""),
    dateRange: {
      datePreset: String(dateRange.datePreset || ""),
      beginDate: String(dateRange.beginDate || ""),
      endDate: String(dateRange.endDate || "")
    },
    sourceTotal: Number(record.remoteTotal ?? rowRecords.reduce((sum, row) => sum + Number(row.sourceTotal ?? row.remoteTotal ?? row.fetchedRecords ?? 0), 0)),
    filteredTotal: Number(record.recordCount ?? rowRecords.reduce((sum, row) => sum + Number(row.filteredTotal ?? row.totalRecords ?? 0), 0)),
    successCount: Number(record.successCount || 0),
    failureCount: Number(record.failureCount || 0),
    partialSourceCount: Number(record.partialSourceCount || 0),
    truncatedCount: rowRecords.filter((row) => row.truncated === true).length,
    cached: record.cached === true,
    cacheDerived: record.cacheDerived === true,
    sourceDatePreset: String(record.sourceDatePreset || "")
  };
}

function taskResultLogSummary(taskType: string | undefined, result: unknown) {
  if (taskType === "fundsData") return fundsResultLogSummary(result);
  if (taskType === "violationsData") return violationsResultLogSummary(result);
  return {};
}

function isTerminal(record?: DoudianOperationRecord | null) {
  return !!record && ["succeeded", "partial", "failed", "cancelled"].includes(record.status);
}

function isMutationOperation(record?: DoudianOperationRecord | null) {
  return isDoudianMutationTask(record);
}

function resultOperationStatus(result: unknown): "succeeded" | "partial" | "failed" {
  if (!result || typeof result !== "object") return "succeeded";
  const record = result as { ok?: unknown; status?: unknown };
  const status = String(record.status || "").toLowerCase();
  if (status === "partial") return "partial";
  if (record.ok === false || ["failed", "error", "missing", "missing-request-plans"].includes(status)) return "failed";
  return "succeeded";
}

async function destroyRunnerWindow(operationId: string) {
  const native = getChihuNative();
  const existing = await getOperation(operationId);
  const winId = runnerWindows.get(operationId) || existing?.runnerWinId;
  if (native?.windows.destroy && winId) {
    await native.windows.destroy({ winId }).catch(() => null);
  }
  runnerWindows.delete(operationId);
}

function operationIdFor(taskType: string) {
  return `${taskType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getChannel() {
  if (channel) return channel;
  channel = createTaskChannel();
  channel.addEventListener("message", (event: MessageEvent<DoudianTaskMessage>) => {
    void handleRunnerMessage(event.data);
  });
  return channel;
}

async function handleRunnerMessage(message: DoudianTaskMessage) {
  if (!message || typeof message !== "object") return;
  if (message.type === "task:ready") {
    return;
  }
  if (message.type === "task:progress") {
    const existing = await getOperation(message.operationId);
    if (isTerminal(existing)) return;
    const record = await markOperationProgress(message.operationId, message.progress);
      dispatchDoudianProgress({
      operationId: message.operationId,
      taskType: record?.taskType,
      status: record?.status === "cancelling" ? "cancelling" : record?.status === "reconciling" ? "reconciling" : "running",
      progress: message.progress,
      message: message.message
    });
  }
  if (message.type === "task:heartbeat") {
    const existing = await getOperation(message.operationId);
    if (!isTerminal(existing)) await markOperationHeartbeat(message.operationId);
  }
  if (message.type === "task:result") {
    const existing = await getOperation(message.operationId);
    if (isTerminal(existing)) {
      resolveWaiters(message.operationId, existing);
      return;
    }
    const resultStatus = message.result && typeof message.result === "object"
      ? String((message.result as { status?: unknown }).status || "")
      : "";
    const needsReconciliation = ["unknown", "reconciling"].includes(resultStatus) ||
      (message.resultSummary !== "cancelled before mutation" && existing?.status === "cancelling" && isMutationOperation(existing) && resultStatus === "cancelled");
    const operationStatus = resultOperationStatus(message.result);
    const persistResult = message.result === undefined || shouldPersistOperationResult(message.result);
    const record = existing?.status === "cancelled"
      ? existing
      : needsReconciliation
        ? await markOperationReconciling(message.operationId, message.resultSummary || "reconciliation required")
      : message.resultSummary === "cancelled" || resultStatus === "cancelled"
        ? await markOperationCancelled(message.operationId)
      : message.result !== undefined
        ? persistResult
          ? await markOperationFullResult(message.operationId, message.resultSummary || "completed", message.result, operationStatus)
          : await markOperationResult(message.operationId, message.resultSummary || "completed", operationStatus)
        : await markOperationResult(message.operationId, message.resultSummary || "completed", operationStatus);
    const waiterRecord = record && message.result !== undefined && !persistResult
      ? { ...record, result: message.result }
      : record;
    dispatchDoudianProgress({
      operationId: message.operationId,
      taskType: record?.taskType,
      status: record?.status === "reconciling" ? "reconciling" : record?.status === "cancelled" ? "cancelled" : record?.status === "partial" ? "partial" : record?.status === "failed" ? "failed" : "succeeded",
      progress: record?.progress ?? 100,
      resultSummary: message.resultSummary
      });
      if (record?.status === "reconciling" && record.taskType === "marketingTask") void reconcileMarketingOperation(message.operationId).catch(() => null);
      void reportOperationLog(record?.status === "cancelled" ? "cancelled" : record?.status === "partial" ? "partial" : record?.status === "failed" ? "failed" : "succeeded", record || null, {
      resultSummary: message.resultSummary || "",
      resultPersisted: persistResult,
      ...taskResultLogSummary(record?.taskType, message.result)
    });
    await destroyRunnerWindow(message.operationId);
    resolveWaiters(message.operationId, waiterRecord || null);
  }
  if (message.type === "task:error") {
    const existing = await getOperation(message.operationId);
    if (isTerminal(existing)) {
      resolveWaiters(message.operationId, existing);
      return;
    }
    const record = existing?.status === "cancelling" && isMutationOperation(existing)
      ? await markOperationReconciling(message.operationId, "mutation failed without a definitive response")
      : await markOperationError(message.operationId, message.error);
    dispatchDoudianProgress({
      operationId: message.operationId,
      taskType: record?.taskType,
      status: record?.status === "reconciling" ? "reconciling" : "failed",
      progress: record?.progress ?? 0,
      error: message.error
    });
    void reportOperationLog("failed", record || null, { error: message.error });
    await destroyRunnerWindow(message.operationId);
    if (record?.status === "reconciling" && record.taskType === "marketingTask") void reconcileMarketingOperation(message.operationId).catch(() => null);
    resolveWaiters(message.operationId, record || null);
  }
}

function resolveWaiters(operationId: string, record: DoudianOperationRecord | null) {
  const list = waiters.get(operationId);
  if (!list?.length) return;
  waiters.delete(operationId);
  for (const waiter of list) {
    window.clearTimeout(waiter.timer);
    waiter.resolve(record);
  }
}

async function openRunnerWindow(operationId: string) {
  const native = getChihuNative();
  if (!native?.windows.open) throw new Error("chihuNative.windows.open is unavailable");
  const url = new URL(location.href);
  url.searchParams.set("runner", "1");
  url.searchParams.set("taskId", operationId);
  const winId = await native.windows.open({
    url: url.toString(),
    title: "Chihu Doudian Task Runner",
    partition: DEFAULT_RUNNER_PARTITION,
    show: false,
    waitForLoad: true,
    width: 480,
    height: 360,
    nodeIntegration: false,
    contextIsolation: true
  });
  runnerWindows.set(operationId, winId);
  await markOperationRunning(operationId, winId);
  return winId;
}

async function evalRunnerStart(winId: number, message: DoudianTaskMessage) {
  const native = getChihuNative();
  if (!native?.windows.eval) return;
  const code = `window.__chihuDoudianTaskStart ? (window.__chihuDoudianTaskStart(${JSON.stringify(message)}), true) : false`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const started = await native.windows.eval({ winId, code, timeoutMs: 1000 }).catch(() => false);
    if (started === true) return;
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  }
}

function taskDedupeKey(task: DoudianTaskRequest) {
  const value = task.metadata?.dedupeKey;
  return typeof value === "string" ? value.trim() : "";
}

async function startDoudianTaskInternal(task: DoudianTaskRequest): Promise<DoudianOperationRecord> {
  task = {
    ...task,
    metadata: {
      ...(task.metadata || {}),
      mutation: isDoudianMutationTask(task)
    }
  };
  if (task.metadata?.replaceActive === true) {
    const active = await listActiveOperations();
    const superseded = active.filter((record) => record.taskType === task.taskType);
    for (const record of superseded) await cancelDoudianTask(record.operationId).catch(() => null);
  }
  const operationId = task.operationId || operationIdFor(task.taskType);
  getChannel();
  const operation = createOperation({
    operationId,
    taskType: task.taskType,
    adapterVersion: task.adapterVersion,
    ruleVersion: task.ruleVersion,
    metadata: task.metadata,
    ownerSessionId: APP_SESSION_ID,
    adapterSnapshotHash: String(task.metadata?.adapterSnapshotHash || "")
  });
  const dedupeKey = taskDedupeKey(task);
  if (dedupeKey) {
    const acquired = await acquireOperation(operation, ACTIVE_TASK_DEDUPE_MAX_AGE_MS);
    if (!acquired.acquired) {
      getChannel();
      return acquired.operation;
    }
  } else {
    await saveOperation(operation);
  }
  let winId: number;
  try {
    winId = await openRunnerWindow(operationId);
  } catch (error) {
    await markOperationError(operationId, error instanceof Error ? error.message : String(error)).catch(() => null);
    throw error;
  }
  const runningOperation = { ...operation, status: "running" as const, runnerWinId: winId };
  dispatchDoudianProgress({
    operationId,
    taskType: task.taskType,
    status: "running",
    progress: 0,
    message: "task started"
  });
  void reportOperationLog("started", runningOperation, {
    metadata: task.metadata || null,
    ...(task.taskType === "violationsData" ? {
      dateRange: {
        datePreset: String(task.payload?.datePreset || "all"),
        beginDate: String(task.payload?.beginDate || ""),
        endDate: String(task.payload?.endDate || "")
      },
      shopCount: Array.isArray(task.payload?.shopIds) ? task.payload.shopIds.length : 0
    } : {})
  });
  const startMessage: DoudianTaskMessage = {
    type: "task:start",
    operation: runningOperation,
    task: { ...task, operationId }
  };
  void evalRunnerStart(winId, startMessage);
  getChannel().postMessage(startMessage);
  return runningOperation;
}

export async function startDoudianTask(task: DoudianTaskRequest): Promise<DoudianOperationRecord> {
  const dedupeKey = taskDedupeKey(task);
  if (!dedupeKey) return startDoudianTaskInternal(task);
  const lockKey = task.metadata?.replaceActive === true ? task.taskType : `${task.taskType}:${dedupeKey}`;
  const existing = taskStartLocks.get(lockKey);
  if (existing) {
    const started = await existing;
    if (started.metadata?.dedupeKey === dedupeKey) return started;
    if (taskStartLocks.get(lockKey) === existing) taskStartLocks.delete(lockKey);
    return startDoudianTask(task);
  }
  const pending = startDoudianTaskInternal(task);
  taskStartLocks.set(lockKey, pending);
  try {
    return await pending;
  } finally {
    if (taskStartLocks.get(lockKey) === pending) taskStartLocks.delete(lockKey);
  }
}

async function requestRunnerCancellation(operationId: string) {
  const native = getChihuNative();
  const existing = await getOperation(operationId);
  const winId = runnerWindows.get(operationId) || existing?.runnerWinId;
  let acknowledged = false;
  if (native?.windows.eval && winId) {
    acknowledged = await native.windows.eval({
      winId,
      code: `window.__chihuDoudianTaskCancel && window.__chihuDoudianTaskCancel(${JSON.stringify(operationId)})`,
      timeoutMs: 3000
    }).catch(() => false) === true;
  }
  getChannel().postMessage({ type: "task:cancel", operationId });
  const info = native?.windows.getInfo && winId ? await native.windows.getInfo({ winId }).catch(() => null) : null;
  return { acknowledged, winId, alive: acknowledged || info !== null };
}

async function cleanupCancelledDoudianTask(record: DoudianOperationRecord | null | undefined) {
  if (record?.taskType !== "opportunityPipelineSubmit") return;
  await cancelOpportunityPipelineSubmitTask({
    operationId: record.operationId,
    reason: "已取消商机提报任务"
  }).catch(() => undefined);
}

export async function cancelDoudianTask(operationId: string) {
  const existing = await getOperation(operationId);
  if (!existing || isTerminal(existing)) return existing;
  const cancelling = await markOperationCancelling(operationId);
  dispatchDoudianProgress({
    operationId,
    taskType: cancelling?.taskType,
    status: "cancelling",
    progress: cancelling?.progress ?? 0,
    resultSummary: "cancellation requested"
  });
  const { alive } = await requestRunnerCancellation(operationId);
  if (alive) return cancelling;
  if (isMutationOperation(existing)) {
    await markOperationInterrupted(operationId, "mutation runner is unavailable");
    return markOperationReconciling(operationId, "runner unavailable; reconciliation required");
  }
  await cleanupCancelledDoudianTask(existing);
  const cancelled = await markOperationCancelled(operationId);
  resolveWaiters(operationId, cancelled || null);
  return cancelled;
}

export async function getDoudianTaskStatus(operationId: string) {
  return getOperation(operationId);
}

export async function resubscribeDoudianTasks() {
  getChannel();
  const records = await listActiveOperations();
  const native = getChihuNative();
  const rawWindows = native?.windows.getAll ? await native.windows.getAll().catch(() => []) : [];
  const windowIds = new Set((Array.isArray(rawWindows) ? rawWindows : []).map((item) => Number((item as { id?: unknown }).id)).filter(Number.isInteger));
  const output: DoudianOperationRecord[] = [];
  for (const record of records) {
    if (record.runnerWinId && windowIds.has(record.runnerWinId) && record.status !== "reconciling") {
      runnerWindows.set(record.operationId, record.runnerWinId);
      output.push(record);
      continue;
    }
    await markOperationInterrupted(record.operationId, "runner missing after application restart");
    if (restartRecoveryStatus(isMutationOperation(record)) === "reconciling") {
      const reconciling = await markOperationReconciling(record.operationId, "application restarted; reconciliation required");
      const resolved = record.taskType === "marketingTask"
        ? await reconcileMarketingOperation(record.operationId).catch(() => null)
        : null;
      if (resolved) output.push(resolved);
      else if (reconciling) output.push(reconciling);
    } else {
      await markOperationError(record.operationId, "read task interrupted; start a new query");
    }
  }
  return output;
}

/** @deprecated This only re-subscribes living runners and interrupts stale operations. */
export const restoreDoudianTasks = resubscribeDoudianTasks;

export async function waitForDoudianTaskResult(operationId: string, timeoutMs = 120000): Promise<DoudianOperationRecord | null> {
  const current = await getOperation(operationId);
  if (current && ["succeeded", "partial", "failed", "cancelled"].includes(current.status)) return current;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const list = waiters.get(operationId) || [];
      waiters.set(operationId, list.filter((item) => item.timer !== timer));
      reject(new Error(`doudian task ${operationId} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const list = waiters.get(operationId) || [];
    list.push({ resolve, reject, timer });
    waiters.set(operationId, list);
  });
}

export async function startMockLongDoudianTask(options: Omit<DoudianTaskRequest, "taskType"> = {}) {
  return startDoudianTask({ ...options, taskType: "mockLongTask" });
}

export async function runDoudianStoreTask(task: DoudianTaskRequest, timeoutMs = 120000): Promise<DoudianStoreResult> {
  const operation = await startDoudianTask(task);
  const result = await waitForDoudianTaskResult(operation.operationId, timeoutMs).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isDoudianMutationTask(task)) {
      await markOperationInterrupted(operation.operationId, message);
      const reconciling = await markOperationReconciling(operation.operationId, "task wait timed out; reconciliation required");
      await requestRunnerCancellation(operation.operationId).catch(() => null);
      if (task.taskType === "marketingTask") void reconcileMarketingOperation(operation.operationId).catch(() => null);
      return reconciling;
    }
    const failed = await markOperationError(operation.operationId, message);
    dispatchDoudianProgress({
      operationId: operation.operationId,
      taskType: failed?.taskType || task.taskType,
      status: "failed",
      progress: failed?.progress ?? 0,
      error: message
    });
    void reportOperationLog("failed", failed || null, { error: message, source: "wait-result" });
    await requestRunnerCancellation(operation.operationId).catch(() => null);
    await destroyRunnerWindow(operation.operationId);
    return failed || getOperation(operation.operationId);
  });
  if (!result) return { ok: false, status: "missing", operationId: operation.operationId, message: "task result missing", stores: [] };
  if (result.status === "failed") {
    return (result.result && typeof result.result === "object")
      ? result.result as DoudianStoreResult
      : { ok: false, status: "failed", operationId: operation.operationId, message: result.error || "task failed", stores: [] };
  }
  if (result.status === "cancelled") return { ok: false, status: "cancelled", operationId: operation.operationId, message: "已取消任务", stores: [] };
  if (result.status === "reconciling" || result.status === "interrupted") return { ok: false, status: result.status, operationId: operation.operationId, message: result.resultSummary || "任务需要对账", stores: [] };
  return (result.result && typeof result.result === "object")
    ? result.result as DoudianStoreResult
    : { ok: true, operationId: operation.operationId, message: result.resultSummary || "completed", stores: [] };
}
