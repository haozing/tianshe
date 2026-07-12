const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const MAX_QUEUE_DEPTH = 500;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_LARGE_RECORD_BYTES = 128 * 1024 * 1024;
const MAX_LARGE_RECORD_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_BATCH_PRODUCTS = 1000;

const PRIORITY = {
  interactive: 10,
  write: 30,
  heartbeat: 40,
  maintenance: 80
};

function createError(code, message, details = {}) {
  const error = new Error(message || code || "Native data service error");
  error.code = code || "NATIVE_DATA_ERROR";
  error.details = details;
  return error;
}

function serializeError(error) {
  if (!error) return { code: "NATIVE_DATA_ERROR", message: "Unknown native data service error" };
  return {
    code: error.code || error.name || "NATIVE_DATA_ERROR",
    message: error.message || String(error),
    details: error.details || undefined
  };
}

function estimateMessageBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return MAX_MESSAGE_BYTES + 1;
  }
}

function normalizePriority(priority) {
  if (typeof priority === "number" && Number.isFinite(priority)) return priority;
  return PRIORITY[priority] || PRIORITY.interactive;
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CATALOG_BATCH_PRODUCTS,
  MAX_LARGE_RECORD_BYTES,
  MAX_LARGE_RECORD_CHUNK_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_QUEUE_DEPTH,
  PRIORITY,
  createError,
  estimateMessageBytes,
  normalizePriority,
  serializeError
};
