import { getChihuNative } from "../../native/client";
import { getPreferences } from "../../bridge/storage";
import {
  createOperation,
  type DoudianOperationRecord
} from "./operation";
import {
  dispatchDoudianProgress,
  type DoudianTaskMessage,
  type DoudianTaskRequest
} from "./progress";
import type { DoudianStoreResult } from "../../types";
import { isDoudianMutationTask, restartRecoveryStatus } from "./taskSafety";

const APP_SESSION_ID = `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
let removeNativeTaskListener: (() => void) | null = null;
const MAX_OPERATION_RESULT_RECORD_BYTES = 4 * 1024 * 1024;
type OperationLogPhase = "started" | "succeeded" | "partial" | "failed" | "cancelled";

type TaskWaiter = {
  resolve: (record: DoudianOperationRecord | null) => void;
  reject: (error: Error) => void;
  timer: number;
};

const waiters = new Map<string, TaskWaiter[]>();
const taskStartLocks = new Map<string, Promise<DoudianOperationRecord>>();

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
  const requiredOpportunityPipelineLog = record?.taskType === "opportunityPipelineSubmit";
  if (!requiredFundsSummary && !requiredViolationsLog && !requiredOpportunityPipelineLog && !getPreferences().autoOperationLog) return;
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
  if (taskType === "opportunityPipelineSubmit" && result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    const summary = record.summary && typeof record.summary === "object" ? record.summary as Record<string, unknown> : {};
    return {
      runId: String(record.runId || record.operationId || ""),
      status: String(record.status || ""),
      candidateCount: Number(summary.candidateCount || 0),
      plannedSubmitCandidateCount: Number(summary.plannedSubmitCandidateCount || 0),
      submittedCount: Number(summary.submittedCount || 0),
      failedCount: Number(summary.failedCount || 0),
      remoteRequestCount: Number(summary.remoteRequestCount || 0)
    };
  }
  return {};
}

function isTerminal(record?: DoudianOperationRecord | null) {
  return !!record && ["succeeded", "partial", "failed", "cancelled"].includes(record.status);
}

function isMutationOperation(record?: DoudianOperationRecord | null) {
  return isDoudianMutationTask(record);
}

type NativeManagedOperation = DoudianOperationRecord & { runnerAlive?: boolean };

async function readTaskStatus(operationId: string): Promise<NativeManagedOperation | null> {
  const native = getChihuNative();
  if (native?.tasks?.getStatus) {
    return native.tasks.getStatus({ operationId }).then((value) => value as NativeManagedOperation | null).catch(() => null);
  }
  return null;
}

async function destroyRunnerWindow(operationId: string) {
  void operationId;
}

async function requestMarketingRecovery(operationId: string) {
  const native = getChihuNative();
  if (!native?.tasks?.recover) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await native.tasks.recover({ operationId }).catch(() => null) as { ok?: boolean; recoveryActive?: boolean } | null;
    if (!response?.ok || response.recoveryActive === true) return readTaskStatus(operationId);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
  return readTaskStatus(operationId);
}

function ensureNativeTaskListener() {
  if (removeNativeTaskListener) return;
  const native = getChihuNative();
  if (!native?.tasks?.onEvent) throw new Error("native task event bridge is unavailable");
  removeNativeTaskListener = native.tasks.onEvent((message) => {
    void handleRunnerMessage(message as DoudianTaskMessage);
  });
}

async function handleRunnerMessage(message: DoudianTaskMessage) {
  if (!message || typeof message !== "object") return;
  if (message.type === "task:progress") {
    const existing = await readTaskStatus(message.operationId);
    if (isTerminal(existing)) return;
    dispatchDoudianProgress({
      operationId: message.operationId,
      taskType: existing?.taskType,
      status: existing?.status === "cancelling" ? "cancelling" : existing?.status === "reconciling" ? "reconciling" : "running",
      progress: message.progress,
      message: message.message,
      store: message.store,
      business: message.business,
      staleGoods: message.staleGoods,
      favoriteRecords: message.favoriteRecords,
      autoFavorite: message.autoFavorite
    });
    return;
  }
  if (message.type === "task:heartbeat") {
    return;
  }
  if (message.type === "task:result") {
    const record = await readTaskStatus(message.operationId);
    const persistResult = message.result === undefined || shouldPersistOperationResult(message.result);
    const waiterRecord = record && message.result !== undefined && !persistResult
      ? { ...record, result: message.result }
      : record && message.result !== undefined && record.result === undefined
        ? { ...record, result: message.result }
      : record;
    dispatchDoudianProgress({
      operationId: message.operationId,
      taskType: record?.taskType,
      status: record?.status === "reconciling" ? "reconciling" : record?.status === "cancelled" ? "cancelled" : record?.status === "partial" ? "partial" : record?.status === "failed" ? "failed" : "succeeded",
      progress: record?.progress ?? 100,
      resultSummary: message.resultSummary
    });
    if (record?.status === "reconciling" && record.taskType === "marketingTask") void requestMarketingRecovery(message.operationId);
    void reportOperationLog(record?.status === "cancelled" ? "cancelled" : record?.status === "partial" ? "partial" : record?.status === "failed" ? "failed" : "succeeded", record || null, {
      resultSummary: message.resultSummary || "",
      resultPersisted: persistResult,
      ...taskResultLogSummary(record?.taskType, message.result)
    });
    await destroyRunnerWindow(message.operationId);
    resolveWaiters(message.operationId, waiterRecord || null);
  }
  if (message.type === "task:error") {
    const record = await readTaskStatus(message.operationId);
    dispatchDoudianProgress({
      operationId: message.operationId,
      taskType: record?.taskType,
      status: record?.status === "reconciling" ? "reconciling" : "failed",
      progress: record?.progress ?? 0,
      error: message.error
    });
    void reportOperationLog("failed", record || null, { error: message.error });
    await destroyRunnerWindow(message.operationId);
    if (record?.status === "reconciling" && record.taskType === "marketingTask") void requestMarketingRecovery(message.operationId);
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

const OMITTED_TASK_PARAM_KEYS = new Set(["doudianAdapter", "config", "partition", "adapterVersion", "ruleVersion", "metadata", "mutation", "operationId"]);

function publicTaskParams(value: unknown): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function" || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.map(publicTaskParams).filter((item) => item !== undefined);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !OMITTED_TASK_PARAM_KEYS.has(key))
    .map(([key, item]) => [key, publicTaskParams(item)])
    .filter(([, item]) => item !== undefined));
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
  const native = getChihuNative();
  if (task.metadata?.replaceActive === true) {
    const active = native?.tasks?.listStatus
      ? await native.tasks.listStatus() as DoudianOperationRecord[]
      : [];
    const superseded = active.filter((record) => record.taskType === task.taskType);
    for (const record of superseded) await cancelDoudianTask(record.operationId).catch(() => null);
  }
  ensureNativeTaskListener();
  if (!native?.tasks?.startRunner) throw new Error("native task start bridge is unavailable");
  const started = await native.tasks.startRunner({
    taskType: task.taskType,
    clientRequestId: task.operationId || taskDedupeKey(task) || undefined,
    params: publicTaskParams(task.payload || {}) as Record<string, unknown>
  });
  if (!started.ok) {
    const error = new Error(started.message || "任务启动失败") as Error & { code?: string };
    error.code = started.code;
    throw error;
  }
  const operationId = started.operationId;
  const evidence = await readTaskStatus(operationId);
  const operation = {
    ...createOperation({
    operationId,
    taskType: task.taskType,
    adapterVersion: task.adapterVersion,
    ruleVersion: task.ruleVersion,
    metadata: task.metadata,
    ownerSessionId: APP_SESSION_ID,
      adapterSnapshotHash: String(task.metadata?.adapterSnapshotHash || "")
    }),
    ...(evidence || {}),
    operationId,
    id: operationId,
    metadata: task.metadata || evidence?.metadata || {}
  };
  const runningOperation = { ...operation, status: "running" as const, runnerWinId: started.runnerWinId };
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
  if (!native?.tasks?.cancelRunner) return { acknowledged: false, winId: undefined, alive: false };
  const result = await native.tasks.cancelRunner({ operationId }).catch(() => null) as { ok?: boolean; status?: string; runnerAlive?: boolean } | null;
  return { acknowledged: result?.ok === true, winId: undefined, alive: result?.runnerAlive === true || result?.status === "cancelling" };
}

export async function cancelDoudianTask(operationId: string) {
  const existing = await readTaskStatus(operationId);
  if (!existing || isTerminal(existing)) return existing;
  dispatchDoudianProgress({
    operationId,
    taskType: existing.taskType,
    status: "cancelling",
    progress: existing.progress ?? 0,
    resultSummary: "cancellation requested"
  });
  const { alive } = await requestRunnerCancellation(operationId);
  const current = await readTaskStatus(operationId);
  if (alive) return current || { ...existing, status: "cancelling" as const };
  const native = getChihuNative();
  const interrupted = native?.tasks?.interrupt
    ? await native.tasks.interrupt({ operationId, reason: "runner unavailable during cancellation" }).then((value) => value as DoudianOperationRecord | null).catch(() => null)
    : current;
  resolveWaiters(operationId, interrupted || null);
  return interrupted;
}

export async function getDoudianTaskStatus(operationId: string) {
  return readTaskStatus(operationId);
}

export async function resubscribeDoudianTasks() {
  ensureNativeTaskListener();
  const native = getChihuNative();
  const records = native?.tasks?.listStatus
    ? await native.tasks.listStatus() as DoudianOperationRecord[]
    : [];
  const output: DoudianOperationRecord[] = [];
  for (const record of records) {
    const nativeStatus = await readTaskStatus(record.operationId);
    if (nativeStatus?.runnerAlive === true) {
      output.push(nativeStatus);
      continue;
    }
    const interrupted = native?.tasks?.interrupt
      ? await native.tasks.interrupt({ operationId: record.operationId, reason: "runner missing after application restart" }).then((value) => value as DoudianOperationRecord | null).catch(() => null)
      : nativeStatus;
    if (restartRecoveryStatus(isMutationOperation(interrupted || record)) === "reconciling") {
      const resolved = record.taskType === "marketingTask" && native?.tasks?.recover
        ? await native.tasks.recover({ operationId: record.operationId }).then(() => readTaskStatus(record.operationId)).catch(() => null)
        : null;
      if (resolved) output.push(resolved);
      else if (interrupted) output.push(interrupted);
    } else if (interrupted) output.push(interrupted);
  }
  return output;
}

/** @deprecated This only re-subscribes living runners and interrupts stale operations. */
export const restoreDoudianTasks = resubscribeDoudianTasks;

export async function waitForDoudianTaskResult(operationId: string, timeoutMs = 120000): Promise<DoudianOperationRecord | null> {
  const current = await readTaskStatus(operationId);
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

export async function runDoudianStoreTask(
  task: DoudianTaskRequest,
  timeoutMs = 120000,
  onStarted?: (operationId: string) => void
): Promise<DoudianStoreResult> {
  const operation = await startDoudianTask(task);
  onStarted?.(operation.operationId);
  const result = await waitForDoudianTaskResult(operation.operationId, timeoutMs).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const mutation = isDoudianMutationTask(task);
    await requestRunnerCancellation(operation.operationId).catch(() => null);
    const native = getChihuNative();
    const persisted = native?.tasks?.interrupt
      ? await native.tasks.interrupt({ operationId: operation.operationId, reason: message }).then((value) => value as DoudianOperationRecord | null).catch(() => null)
      : await readTaskStatus(operation.operationId);
    const settled = {
      ...(persisted || operation),
      status: mutation ? "reconciling" as const : "failed" as const,
      resultSummary: mutation ? "task wait timed out; reconciliation required" : persisted?.resultSummary,
      error: mutation ? persisted?.error : message,
      updatedAt: new Date().toISOString()
    };
    if (mutation) {
      if (task.taskType === "marketingTask") void requestMarketingRecovery(operation.operationId);
      return settled;
    }
    dispatchDoudianProgress({
      operationId: operation.operationId,
      taskType: settled.taskType || task.taskType,
      status: "failed",
      progress: settled.progress ?? 0,
      error: message
    });
    void reportOperationLog("failed", settled, { error: message, source: "wait-result" });
    await destroyRunnerWindow(operation.operationId);
    return settled;
  });
  if (!result) return { ok: false, status: "missing", operationId: operation.operationId, message: "task result missing", stores: [] };
  if (result.status === "failed") {
    return (result.result && typeof result.result === "object")
      ? result.result as DoudianStoreResult
      : { ok: false, status: "failed", operationId: operation.operationId, message: result.error || "task failed", stores: [] };
  }
  if (result.status === "cancelled") return { ok: false, status: "cancelled", operationId: operation.operationId, message: "已取消任务" };
  if (result.status === "reconciling" || result.status === "interrupted") return { ok: false, status: result.status, operationId: operation.operationId, message: result.resultSummary || "任务需要对账", stores: [] };
  return (result.result && typeof result.result === "object")
    ? result.result as DoudianStoreResult
    : { ok: true, operationId: operation.operationId, message: result.resultSummary || "completed", stores: [] };
}
