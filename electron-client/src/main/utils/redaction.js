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
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = redactText(text);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

module.exports = {
  REDACTED,
  redactValue,
  redactText,
  safeJson
};
