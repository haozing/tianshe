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
  if (["unknown", "reconciling"].includes(businessStatus)) return "reconciling";
  if (mutation && currentStatus === "cancelling" && businessStatus === "cancelled" && resultSummary !== "cancelled before mutation") return "reconciling";
  if (resultSummary === "cancelled" || businessStatus === "cancelled") return "cancelled";
  if (businessStatus === "partial") return "partial";
  if (result && typeof result === "object" && (result.ok === false || ["failed", "error", "missing", "missing-request-plans"].includes(businessStatus))) return "failed";
  return "succeeded";
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
  if (context.taskType !== "opportunityPipelineSubmit") return false;
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
  terminalTaskStatus
};
