const ACTIVE_SUBMIT_TASK_STATUSES = new Set(["preparing", "ready", "queued", "running", "cancelling", "cooling_down"]);
const DEFERRED_SUBMIT_TASK_STATUSES = new Set(["deferred", "deferred_contract_mismatch", "manual_reconcile"]);

export function isActiveSubmitTaskStatus(status: unknown) {
  return ACTIVE_SUBMIT_TASK_STATUSES.has(String(status || "").trim().toLowerCase());
}

export function isDeferredSubmitTaskStatus(status: unknown) {
  return DEFERRED_SUBMIT_TASK_STATUSES.has(String(status || "").trim().toLowerCase());
}

export function activeSubmitTasksForRun<T extends { runId?: unknown; status?: unknown }>(tasks: T[], runId: string) {
  return tasks.filter((task) => String(task.runId || "") === runId && isActiveSubmitTaskStatus(task.status));
}

function timestampMs(value: unknown) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareSubmitTaskFairness(
  left: { id?: unknown; createdAt?: unknown; resumeAt?: unknown; leaseExpiresAt?: unknown; lastAdmittedAt?: unknown },
  right: { id?: unknown; createdAt?: unknown; resumeAt?: unknown; leaseExpiresAt?: unknown; lastAdmittedAt?: unknown }
) {
  const leftAdmittedAt = timestampMs(left.lastAdmittedAt);
  const rightAdmittedAt = timestampMs(right.lastAdmittedAt);
  if (Boolean(leftAdmittedAt) !== Boolean(rightAdmittedAt)) return leftAdmittedAt ? 1 : -1;
  if (leftAdmittedAt !== rightAdmittedAt) return leftAdmittedAt - rightAdmittedAt;
  const leftDueAt = timestampMs(left.resumeAt) || timestampMs(left.leaseExpiresAt) || timestampMs(left.createdAt) || Number.MAX_SAFE_INTEGER;
  const rightDueAt = timestampMs(right.resumeAt) || timestampMs(right.leaseExpiresAt) || timestampMs(right.createdAt) || Number.MAX_SAFE_INTEGER;
  if (leftDueAt !== rightDueAt) return leftDueAt - rightDueAt;
  const created = String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
  return created || String(left.id || "").localeCompare(String(right.id || ""));
}

export function submitWorkerProgress(completed: number, total: number) {
  const safeTotal = Math.max(1, Math.floor(Number(total) || 0));
  const safeCompleted = Math.max(0, Math.min(safeTotal, Math.floor(Number(completed) || 0)));
  return Math.min(94, 83 + Math.floor((safeCompleted / safeTotal) * 11));
}

export function hasRemainingLegacySubmitWork<T extends { id?: unknown; eligible?: unknown; status?: unknown; submitStatus?: unknown }>(
  candidates: T[],
  processedCandidateIds: ReadonlySet<string>
) {
  return candidates.some((candidate) => {
    const candidateId = String(candidate.id || "");
    if (!candidateId || processedCandidateIds.has(candidateId) || candidate.eligible !== true) return false;
    const status = String(candidate.submitStatus || candidate.status || "").trim().toLowerCase();
    return status === "ready" || status === "fallback";
  });
}

export function canSupersedeContractMismatchTask(task: {
  status?: unknown;
  unknownCount?: unknown;
  inFlightAttemptId?: unknown;
  inFlightLogicalGroupId?: unknown;
  inFlightCandidateIds?: unknown;
}, mutationCounts?: { pending?: unknown; unknown?: unknown } | null) {
  if (String(task.status || "").trim().toLowerCase() !== "deferred_contract_mismatch") return false;
  if (Math.max(0, Number(task.unknownCount || 0)) > 0) return false;
  if (String(task.inFlightAttemptId || "").trim() || String(task.inFlightLogicalGroupId || "").trim()) return false;
  if (Array.isArray(task.inFlightCandidateIds) && task.inFlightCandidateIds.length > 0) return false;
  return Math.max(0, Number(mutationCounts?.pending || 0)) === 0
    && Math.max(0, Number(mutationCounts?.unknown || 0)) === 0;
}

export function orphanedSubmitQueueStoreRuns<
  TStoreRun extends { id?: unknown; status?: unknown; phase?: unknown },
  TTask extends { storeRunId?: unknown }
>(storeRuns: TStoreRun[], tasks: TTask[]) {
  const taskStoreRunIds = new Set(tasks.map((task) => String(task.storeRunId || "")).filter(Boolean));
  return storeRuns.filter((item) => String(item.status || "").trim().toLowerCase() === "queued"
    && String(item.phase || "").trim().toLowerCase() === "submit-queued"
    && !taskStoreRunIds.has(String(item.id || "")));
}
