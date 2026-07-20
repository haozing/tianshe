const MAX_PERSISTED_TASK_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_TASK_RESULT_MESSAGE_BYTES = 8 * 1024 * 1024;

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

function taskResultPersistence(result) {
  const bytes = jsonBytes(result);
  return {
    bytes,
    messageAllowed: bytes <= MAX_TASK_RESULT_MESSAGE_BYTES,
    persistResult: bytes <= MAX_PERSISTED_TASK_RESULT_BYTES
  };
}

module.exports = {
  MAX_PERSISTED_TASK_RESULT_BYTES,
  MAX_TASK_RESULT_MESSAGE_BYTES,
  taskResultPersistence,
  terminalTaskStatus
};
