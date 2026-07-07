function getPath(value, path) {
  return String(path || "").split(".").reduce((current, key) => {
    if (!key) return current;
    if (current == null || typeof current !== "object") return undefined;
    return current[key];
  }, value);
}

function policy(adapter, path, fallback) {
  const value = getPath(adapter?.policies || {}, path);
  return value === undefined ? fallback : value;
}

function policyBool(adapter, path, fallback = false) {
  const value = policy(adapter, path, fallback);
  return typeof value === "boolean" ? value : !!fallback;
}

function policyText(adapter, path, fallback = "") {
  const value = policy(adapter, path, fallback);
  return value == null ? fallback : String(value);
}

function policyArray(adapter, path, fallback = []) {
  const value = policy(adapter, path, fallback);
  return Array.isArray(value) ? value : fallback;
}

function policyNumber(adapter, path, fallback, options = {}) {
  const value = Number(policy(adapter, path, fallback));
  const min = Number.isFinite(options.min) ? options.min : Number.NEGATIVE_INFINITY;
  const max = Number.isFinite(options.max) ? options.max : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function formatPolicyMessage(template, data = {}) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => {
    const value = data[key];
    return value == null ? "" : String(value);
  });
}

function policyMessage(adapter, path, fallback, data = {}) {
  return formatPolicyMessage(policyText(adapter, path, fallback), data);
}

function matchesPatternList(value, patterns = []) {
  const text = String(value || "").toLowerCase();
  return patterns.some((pattern) => {
    const source = String(pattern || "");
    if (!source) return false;
    try {
      return new RegExp(source, "i").test(text);
    } catch {
      return text.includes(source.toLowerCase());
    }
  });
}

function matchesAnyCode(codes = [], values = []) {
  const codeSet = new Set((codes || []).map((code) => String(code)));
  return (values || []).some((value) => codeSet.has(String(value || "")));
}

module.exports = {
  formatPolicyMessage,
  matchesAnyCode,
  matchesPatternList,
  policy,
  policyArray,
  policyBool,
  policyMessage,
  policyNumber,
  policyText
};
