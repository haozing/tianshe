import {
  DOUDIAN_PROGRESS_EVENT,
  createTaskChannel,
  type DoudianTaskMessage,
  type DoudianProgressDetail,
  type DoudianTaskRequest
} from "./progress";
import { runFetchDoudianStoresTask } from "./storeImport";
import { runRefreshDoudianStoreStatusTask } from "./storeStatus";

interface RunningTask {
  cancelled: boolean;
  timer?: number;
  cleanup?: () => Promise<void> | void;
  windows?: number[];
}

const runningTasks = new Map<string, RunningTask>();

function post(channel: BroadcastChannel, message: DoudianTaskMessage) {
  channel.postMessage(message);
}

function installProgressForwarder(channel: BroadcastChannel) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<DoudianProgressDetail>).detail;
    if (!detail?.operationId || detail.status !== "running") return;
    post(channel, {
      type: "task:progress",
      operationId: detail.operationId,
      progress: detail.progress,
      message: detail.message
    });
  };
  window.addEventListener(DOUDIAN_PROGRESS_EVENT, listener);
  return () => window.removeEventListener(DOUDIAN_PROGRESS_EVENT, listener);
}

function startTask(channel: BroadcastChannel, message: Extract<DoudianTaskMessage, { type: "task:start" }>) {
  const operationId = message.operation.operationId;
  if (runningTasks.has(operationId)) return true;
  if (message.task.taskType === "mockLongTask") {
    runMockLongTask(channel, operationId, message.task);
  } else {
    void runDomainTask(channel, operationId, message.task);
  }
  return true;
}

function runMockLongTask(channel: BroadcastChannel, operationId: string, task: DoudianTaskRequest) {
  const state: RunningTask = { cancelled: false };
  runningTasks.set(operationId, state);
  const durationMs = Math.max(500, Number(task.durationMs || 2500));
  const stepMs = Math.max(100, Number(task.stepMs || 250));
  const startedAt = Date.now();

  const tick = () => {
    if (state.cancelled) {
      post(channel, { type: "task:result", operationId, resultSummary: "cancelled" });
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
      runningTasks.delete(operationId);
      return;
    }

    state.timer = window.setTimeout(tick, stepMs);
  };

  tick();
}

function cancelTask(operationId: string) {
  const task = runningTasks.get(operationId);
  if (!task) return;
  task.cancelled = true;
  if (task.timer) window.clearTimeout(task.timer);
  void task.cleanup?.();
}

async function runDomainTask(channel: BroadcastChannel, operationId: string, task: DoudianTaskRequest) {
  const state: RunningTask = { cancelled: false, windows: [] };
  state.cleanup = async () => {
    const native = window.chihuNative;
    if (!native?.windows.destroy) return;
    await Promise.all((state.windows || []).map((winId) => native.windows.destroy({ winId }).catch(() => null)));
  };
  const payload = {
    ...(task.payload || {}),
    isCancelled: () => state.cancelled,
    trackWindow: (winId: number) => {
      if (Number.isInteger(winId)) state.windows?.push(winId);
    }
  };
  runningTasks.set(operationId, state);
  try {
    let result: unknown = null;
    if (task.taskType === "fetchDoudianStores") {
      result = await runFetchDoudianStoresTask({
        operationId,
        ...payload
      } as unknown as Parameters<typeof runFetchDoudianStoresTask>[0]);
    } else if (task.taskType === "refreshDoudianStoreStatus") {
      result = await runRefreshDoudianStoreStatusTask({
        operationId,
        ...payload
      } as unknown as Parameters<typeof runRefreshDoudianStoreStatusTask>[0]);
    } else {
      throw new Error(`unsupported task type: ${task.taskType}`);
    }
    if (state.cancelled) {
      post(channel, { type: "task:result", operationId, resultSummary: "cancelled", result: { ok: false, status: "cancelled", message: "已取消任务" } });
    } else {
      post(channel, { type: "task:result", operationId, resultSummary: "completed", result });
    }
  } catch (error) {
    post(channel, { type: "task:error", operationId, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await state.cleanup?.();
    runningTasks.delete(operationId);
  }
}

export function installDoudianTaskRunner() {
  const channel = createTaskChannel();
  const removeProgressForwarder = installProgressForwarder(channel);
  const runnerTaskId = new URLSearchParams(location.search).get("taskId") || "";
  const isTargetTask = (operationId: string) => !runnerTaskId || operationId === runnerTaskId;
  const runnerWindow = window as typeof window & {
    __chihuDoudianTaskStart?: (message: DoudianTaskMessage) => boolean;
    __chihuDoudianTaskCancel?: (operationId: string) => boolean;
  };
  runnerWindow.__chihuDoudianTaskStart = (message) => {
    if (message?.type !== "task:start") return false;
    const operationId = message.operation.operationId;
    if (!isTargetTask(operationId)) return false;
    return startTask(channel, message);
  };
  runnerWindow.__chihuDoudianTaskCancel = (operationId) => {
    if (!isTargetTask(operationId)) return false;
    cancelTask(operationId);
    post(channel, { type: "task:result", operationId, resultSummary: "cancelled", result: { ok: false, status: "cancelled", message: "已取消任务" } });
    runningTasks.delete(operationId);
    return true;
  };
  channel.postMessage({ type: "task:ready", href: location.href } satisfies DoudianTaskMessage);
  channel.addEventListener("message", (event: MessageEvent<DoudianTaskMessage>) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "task:start") {
      runnerWindow.__chihuDoudianTaskStart?.(message);
    }
    if (message.type === "task:cancel") {
      runnerWindow.__chihuDoudianTaskCancel?.(message.operationId);
    }
  });
  return { channel, dispose: removeProgressForwarder };
}

export function isDoudianTaskRunnerRoute() {
  return new URLSearchParams(location.search).get("runner") === "1";
}
