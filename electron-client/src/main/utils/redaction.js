const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "token",
  "access_token",
  "refresh_token",
  "mstoken",
  "ms_token",
  "msToken",
  "a_bogus",
  "aBogus",
  "fp",
  "verifyfp",
  "verifyFp",
  "_signature",
  "signature",
  "x-bogus",
  "xBogus"
]);

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key || "").trim()) ||
    SENSITIVE_KEYS.has(String(key || "").trim().toLowerCase());
}

function redactText(value) {
  return String(value ?? "")
    .replace(/("?(cookie|set-cookie|authorization)"?\s*:\s*)"[^"]*"/gi, `$1"${REDACTED}"`)
    .replace(/("?(token|access_token|refresh_token|msToken|a_bogus|fp|verifyFp|_signature|signature|X-Bogus)"?\s*:\s*)"[^"]*"/gi, `$1"${REDACTED}"`)
    .replace(/\b(cookie|set-cookie|authorization)\s*:\s*[^\r\n]*/gi, `$1: ${REDACTED}`)
    .replace(/([?&](token|access_token|refresh_token|msToken|a_bogus|fp|verifyFp|_signature|signature|X-Bogus)=)[^&\s"']*/gi, `$1${REDACTED}`);
}

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  const output = {};
  for (const [key, next] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactValue(next, seen);
  }
  return output;
}

function safeJson(value, maxLength = 6000) {
  let normalized;
  try {
    normalized = redactValue(value);
  } catch {
    normalized = redactText(String(value));
  }
  let text;
  try {
    text = JSON.stringify(normalized);
  } catch {
    text = JSON.stringify(redactText(String(value)));
  }
  if (text === undefined) text = "null";
  if (text.length <= maxLength) return text;

  const summary = {};
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    const summaryBudget = Math.max(0, Math.floor(maxLength * 0.4));
    for (const [key, next] of Object.entries(normalized)) {
      if (next !== null && !["string", "number", "boolean"].includes(typeof next)) continue;
      const compact = typeof next === "string" && next.length > 256 ? `${next.slice(0, 256)}...` : next;
      const candidate = { ...summary, [key]: compact };
      if (JSON.stringify(candidate).length > summaryBudget) break;
      summary[key] = compact;
    }
  }

  const output = {
    ...summary,
    _logTruncation: {
      originalLength: text.length,
      preview: ""
    }
  };
  let serialized = JSON.stringify(output);
  if (serialized.length > maxLength) return JSON.stringify({ _logTruncation: { originalLength: text.length } });
  let previewLength = Math.max(0, maxLength - serialized.length - 2);
  output._logTruncation.preview = text.slice(0, previewLength);
  serialized = JSON.stringify(output);
  while (serialized.length > maxLength && previewLength > 0) {
    previewLength = Math.max(0, previewLength - (serialized.length - maxLength));
    output._logTruncation.preview = text.slice(0, previewLength);
    serialized = JSON.stringify(output);
  }
  return serialized;
}

module.exports = {
  REDACTED,
  redactValue,
  redactText,
  safeJson
};
