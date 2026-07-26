const MAX_PERSISTED_TASK_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_TASK_RESULT_MESSAGE_BYTES = 8 * 1024 * 1024;
const OPPORTUNITY_SUBMIT_PROGRESS_STALL_MS = 5 * 60 * 1000;

function jsonBytes(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function resultBusinessStatus(result) {
  if (!result || typeof result !== "object") return "";
  return String(result.status || "").toLowerCase();
}

function terminalTaskStatus({ result, resultSummary = "", mutation = false, currentStatus = "running" }) {
  const businessStatus = resultBusinessStatus(result);
  if (["unknown", "reconciling", "manual_reconcile", "cancelling"].includes(businessStatus)) return "reconciling";
  if (mutation && currentStatus === "cancelling" && businessStatus === "cancelled" && resultSummary !== "cancelled before mutation") return "reconciling";
  if (resultSummary === "cancelled" || businessStatus === "cancelled") return "cancelled";
  if (["preparing", "ready", "queued", "running", "partial", "cooling_down", "deferred", "deferred_contract_mismatch"].includes(businessStatus)) return "partial";
  if (result && typeof result === "object" && (result.ok === false || ["failed", "error", "missing", "missing-request-plans"].includes(businessStatus))) return "failed";
  return "succeeded";
}

function terminalTaskProgress({ taskType = "", terminalStatus = "succeeded", currentProgress = 0 }) {
  const progress = Math.max(0, Math.min(100, Number(currentProgress || 0)));
  if (terminalStatus === "reconciling") return progress;
  if (taskType === "opportunityPipelineSubmit" && terminalStatus === "partial") return progress;
  return 100;
}

function interruptedTaskStatus({ mutation = false, mutationStarted, inFlightMutations = 0, currentStatus = "running", cancellationRequested = false }) {
  if (mutation && (mutationStarted !== false || Number(inFlightMutations || 0) > 0)) return "reconciling";
  if (mutation && (cancellationRequested || currentStatus === "cancelling")) return "cancelled";
  if (mutation) return "failed";
  if (cancellationRequested || currentStatus === "cancelling") return "cancelled";
  return "failed";
}

function taskResultPersistence(result) {
  const bytes = jsonBytes(result);
  return {
    bytes,
    messageAllowed: bytes <= MAX_TASK_RESULT_MESSAGE_BYTES,
    persistResult: bytes <= MAX_PERSISTED_TASK_RESULT_BYTES
  };
}

function opportunitySubmitProgressStalled(context, now = Date.now()) {
  if (!["opportunityPipelineSubmit", "opportunitySubmitContinuation"].includes(context.taskType)) return false;
  const persistedStatus = String(context.persistedSubmitTaskStatus || "");
  const resumeAtMs = Date.parse(String(context.persistedSubmitResumeAt || ""));
  if (persistedStatus === "cancelling") return false;
  if (persistedStatus === "cooling_down" && Number.isFinite(resumeAtMs) && resumeAtMs > now) return false;
  if (["deferred", "deferred_contract_mismatch", "manual_reconcile"].includes(persistedStatus)) return false;
  const progress = Number(context.lastProgress || 0);
  if (progress < 82 || progress >= 95) return false;
  return now - Number(context.lastProgressAt || context.createdAtMs || now) > OPPORTUNITY_SUBMIT_PROGRESS_STALL_MS;
}

module.exports = {
  MAX_PERSISTED_TASK_RESULT_BYTES,
  MAX_TASK_RESULT_MESSAGE_BYTES,
  opportunitySubmitProgressStalled,
  taskResultPersistence,
  interruptedTaskStatus,
  terminalTaskProgress,
  terminalTaskStatus
};
