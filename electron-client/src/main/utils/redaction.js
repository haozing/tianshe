const REDACTED = "[REDACTED]";

function redactText(value) {
  return String(value ?? "")
    .replace(/("?(cookie|set-cookie|authorization)"?\s*:\s*)"[^"]*"/gi, `$1"${REDACTED}"`)
    .replace(/\b(cookie|set-cookie|authorization)\s*:\s*[^\r\n]*/gi, `$1: ${REDACTED}`)
    .replace(/([?&](token|access_token|refresh_token|code)=)[^&\s]*/gi, `$1${REDACTED}`);
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
  redactText,
  safeJson
};

