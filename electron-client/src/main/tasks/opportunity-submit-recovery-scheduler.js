const AUTOMATIC_DEFERRED_REASONS = new Set([
  "authorization_wait",
  "login_wait",
  "throttle_budget"
]);

function timestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function automaticOpportunitySubmitRecoveryPendingTask(task) {
  if (!task || typeof task !== "object") return false;
  const status = String(task.status || "");
  if (status === "ready" || status === "queued") return true;
  if (status === "running" || status === "cooling_down") return true;
  if (status !== "deferred" || task.requiresExplicitResume === true) return false;
  const deferredReason = String(task.deferredReason || "");
  if (deferredReason === "retry_exhausted") return false;
  return !deferredReason || AUTOMATIC_DEFERRED_REASONS.has(deferredReason);
}

function automaticOpportunitySubmitRecoveryTask(task, nowMs = Date.now()) {
  if (!automaticOpportunitySubmitRecoveryPendingTask(task)) return false;
  const status = String(task.status || "");
  if (status === "ready" || status === "queued") {
    const resumeAt = timestampMs(task.resumeAt);
    return !resumeAt || resumeAt <= nowMs;
  }
  if (status === "running") {
    const leaseExpiresAt = timestampMs(task.leaseExpiresAt);
    return !leaseExpiresAt || leaseExpiresAt <= nowMs;
  }
  if (status === "cooling_down") {
    const resumeAt = timestampMs(task.resumeAt);
    return Boolean(resumeAt && resumeAt <= nowMs);
  }
  const resumeAt = timestampMs(task.resumeAt);
  return Boolean(resumeAt && resumeAt <= nowMs);
}

function opportunitySubmitRecoverySortValue(task) {
  return timestampMs(task.resumeAt) || timestampMs(task.leaseExpiresAt) || timestampMs(task.createdAt) || Number.MAX_SAFE_INTEGER;
}

function dueOpportunitySubmitRecoveryTasks(tasks, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const activeRunIds = options.activeRunIds instanceof Set ? options.activeRunIds : new Set(options.activeRunIds || []);
  const activeTaskIds = options.activeTaskIds instanceof Set ? options.activeTaskIds : new Set(options.activeTaskIds || []);
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => automaticOpportunitySubmitRecoveryTask(task, nowMs))
    .filter((task) => !activeRunIds.has(String(task.runId || "")) && !activeTaskIds.has(String(task.id || "")))
    .sort((left, right) => {
      const due = opportunitySubmitRecoverySortValue(left) - opportunitySubmitRecoverySortValue(right);
      if (due) return due;
      const created = String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
      return created || String(left.id || "").localeCompare(String(right.id || ""));
    });
}

function nextOpportunitySubmitRecoveryWakeAt(tasks, nowMs = Date.now()) {
  let next = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = String(task?.status || "");
    if (status !== "ready" && status !== "queued" && status !== "cooling_down" && status !== "deferred" && status !== "running") continue;
    if (status === "deferred" && (task.requiresExplicitResume === true || task.deferredReason === "retry_exhausted")) continue;
    const candidate = status === "running" ? timestampMs(task.leaseExpiresAt) : timestampMs(task.resumeAt);
    if (!candidate || candidate <= nowMs) continue;
    if (!next || candidate < next) next = candidate;
  }
  return next || null;
}

module.exports = {
  AUTOMATIC_DEFERRED_REASONS,
  automaticOpportunitySubmitRecoveryPendingTask,
  automaticOpportunitySubmitRecoveryTask,
  dueOpportunitySubmitRecoveryTasks,
  nextOpportunitySubmitRecoveryWakeAt
};
