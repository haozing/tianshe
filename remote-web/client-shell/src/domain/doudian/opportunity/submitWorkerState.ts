const ACTIVE_SUBMIT_TASK_STATUSES = new Set(["preparing", "ready", "queued", "running"]);

export function isActiveSubmitTaskStatus(status: unknown) {
  return ACTIVE_SUBMIT_TASK_STATUSES.has(String(status || "").trim().toLowerCase());
}

export function activeSubmitTasksForRun<T extends { runId?: unknown; status?: unknown }>(tasks: T[], runId: string) {
  return tasks.filter((task) => String(task.runId || "") === runId && isActiveSubmitTaskStatus(task.status));
}

export function submitWorkerProgress(completed: number, total: number) {
  const safeTotal = Math.max(1, Math.floor(Number(total) || 0));
  const safeCompleted = Math.max(0, Math.min(safeTotal, Math.floor(Number(completed) || 0)));
  return Math.min(94, 83 + Math.floor((safeCompleted / safeTotal) * 11));
}
