import { getChihuNative } from "../../native/client";
import { getPreferences } from "../../bridge/storage";
import {
  createOperation,
  getOperation,
  listActiveOperations,
  markOperationCancelled,
  markOperationError,
  markOperationFullResult,
  markOperationProgress,
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
import type { DoudianStoreResult } from "../../types";

const runnerWindows = new Map<string, number>();
let channel: BroadcastChannel | null = null;
const DEFAULT_RUNNER_PARTITION = "persist:chihu-default";
const MAX_OPERATION_RESULT_RECORD_BYTES = 4 * 1024 * 1024;
type OperationLogPhase = "started" | "succeeded" | "failed" | "cancelled";

type TaskWaiter = {
  resolve: (record: DoudianOperationRecord | null) => void;
  reject: (error: Error) => void;
  timer: number;
};

const waiters = new Map<string, TaskWaiter[]>();

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
  return {
    operationId: record.operationId,
    taskType: record.taskType,
    status: record.status,
    progress: record.progress,
    adapterVersion: record.adapterVersion || "",
    ruleVersion: record.ruleVersion || "",
    hasResult: record.result !== undefined,
    resultSummary: record.resultSummary || ""
  };
}

async function reportOperationLog(phase: OperationLogPhase, record: DoudianOperationRecord | null | undefined, detail: Record<string, unknown> = {}) {
  if (!getPreferences().autoOperationLog) return;
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

function isTerminal(record?: DoudianOperationRecord | null) {
  return !!record && ["succeeded", "failed", "cancelled"].includes(record.status);
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
      status: "running",
      progress: message.progress,
      message: message.message
    });
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
    const persistResult = message.result === undefined || shouldPersistOperationResult(message.result);
    const record = existing?.status === "cancelled"
      ? existing
      : message.resultSummary === "cancelled" || resultStatus === "cancelled"
        ? await markOperationCancelled(message.operationId)
      : message.result !== undefined
        ? persistResult
          ? await markOperationFullResult(message.operationId, message.resultSummary || "completed", message.result)
          : await markOperationResult(message.operationId, message.resultSummary || "completed")
        : await markOperationResult(message.operationId, message.resultSummary || "completed");
    const waiterRecord = record && message.result !== undefined && !persistResult
      ? { ...record, result: message.result }
      : record;
    dispatchDoudianProgress({
      operationId: message.operationId,
      taskType: record?.taskType,
      status: record?.status === "cancelled" ? "cancelled" : "succeeded",
      progress: record?.progress ?? 100,
      resultSummary: message.resultSummary
    });
    void reportOperationLog(record?.status === "cancelled" ? "cancelled" : "succeeded", record || null, {
      resultSummary: message.resultSummary || "",
      resultPersisted: persistResult
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
    const record = await markOperationError(message.operationId, message.error);
    dispatchDoudianProgress({
      operationId: message.operationId,
      taskType: record?.taskType,
      status: "failed",
      progress: record?.progress ?? 0,
      error: message.error
    });
    void reportOperationLog("failed", record || null, { error: message.error });
    await destroyRunnerWindow(message.operationId);
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
    waitForLoad: false,
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

export async function startDoudianTask(task: DoudianTaskRequest): Promise<DoudianOperationRecord> {
  const operationId = task.operationId || operationIdFor(task.taskType);
  getChannel();
  const operation = createOperation({
    operationId,
    taskType: task.taskType,
    adapterVersion: task.adapterVersion,
    ruleVersion: task.ruleVersion,
    metadata: task.metadata
  });
  await saveOperation(operation);
  const winId = await openRunnerWindow(operationId);
  const runningOperation = { ...operation, status: "running" as const, runnerWinId: winId };
  dispatchDoudianProgress({
    operationId,
    taskType: task.taskType,
    status: "running",
    progress: 0,
    message: "task started"
  });
  void reportOperationLog("started", runningOperation, {
    metadata: task.metadata || null
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

async function stopRunnerWindow(operationId: string) {
  const native = getChihuNative();
  const existing = await getOperation(operationId);
  const winId = runnerWindows.get(operationId) || existing?.runnerWinId;
  if (native?.windows.eval && winId) {
    await native.windows.eval({
      winId,
      code: `window.__chihuDoudianTaskCancel && window.__chihuDoudianTaskCancel(${JSON.stringify(operationId)})`,
      timeoutMs: 3000
    }).catch(() => null);
  }
  getChannel().postMessage({ type: "task:cancel", operationId });
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  if (native?.windows.destroy && winId) {
    await native.windows.destroy({ winId }).catch(() => null);
  }
  runnerWindows.delete(operationId);
}

export async function cancelDoudianTask(operationId: string) {
  await stopRunnerWindow(operationId);
  const record = await markOperationCancelled(operationId);
  dispatchDoudianProgress({
    operationId,
    taskType: record?.taskType,
    status: "cancelled",
    progress: record?.progress ?? 0,
    resultSummary: "cancelled"
  });
  void reportOperationLog("cancelled", record || null);
  resolveWaiters(operationId, record || null);
  return record;
}

export async function getDoudianTaskStatus(operationId: string) {
  return getOperation(operationId);
}

export async function restoreDoudianTasks() {
  const records = await listActiveOperations();
  return records;
}

export async function waitForDoudianTaskResult(operationId: string, timeoutMs = 120000): Promise<DoudianOperationRecord | null> {
  const current = await getOperation(operationId);
  if (current && ["succeeded", "failed", "cancelled"].includes(current.status)) return current;
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
    const failed = await markOperationError(operation.operationId, message);
    dispatchDoudianProgress({
      operationId: operation.operationId,
      taskType: failed?.taskType || task.taskType,
      status: "failed",
      progress: failed?.progress ?? 0,
      error: message
    });
    void reportOperationLog("failed", failed || null, { error: message, source: "wait-result" });
    await stopRunnerWindow(operation.operationId).catch(() => null);
    return failed || getOperation(operation.operationId);
  });
  if (!result) return { ok: false, status: "missing", operationId: operation.operationId, message: "task result missing", stores: [] };
  if (result.status === "failed") return { ok: false, status: "failed", operationId: operation.operationId, message: result.error || "task failed", stores: [] };
  if (result.status === "cancelled") return { ok: false, status: "cancelled", operationId: operation.operationId, message: "已取消任务", stores: [] };
  return (result.result && typeof result.result === "object")
    ? result.result as DoudianStoreResult
    : { ok: true, operationId: operation.operationId, message: result.resultSummary || "completed", stores: [] };
}
