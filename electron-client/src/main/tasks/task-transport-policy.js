const crypto = require("node:crypto");

function stableJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function interpolate(value, context) {
  return String(value ?? "").replace(/\{([^}]+)\}/g, (_match, key) => String(context?.[key] ?? ""));
}

function interpolateDeep(value, context) {
  if (typeof value === "string") {
    const exact = value.match(/^\{([^}]+)\}$/);
    if (exact) return context?.[exact[1]] ?? "";
    return interpolate(value, context);
  }
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateDeep(item, context)]));
  }
  return value;
}

function boundedTimeout(value, fallback = 15000) {
  const numeric = Number(value ?? fallback);
  return Math.max(5000, Math.min(120000, Number.isFinite(numeric) ? Math.floor(numeric) : fallback));
}

function normalizedHeaders(value) {
  const output = new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    output.set(key.toLowerCase(), item);
  }
  return output;
}

function planUrl(adapter, planKey, plan, context) {
  const endpointKey = String(plan.endpointKey || planKey);
  const endpoint = adapter?.endpoints?.[endpointKey];
  if (!endpoint) return null;
  const origin = typeof plan.origin === "string" && plan.origin ? plan.origin : adapter.origin;
  const url = new URL(interpolate(endpoint, context), origin);
  if (typeof plan.rawQuery === "string" && plan.rawQuery) {
    const params = new URLSearchParams(interpolate(plan.rawQuery, context));
    params.forEach((value, key) => url.searchParams.set(key, value));
  }
  const query = interpolateDeep(plan.query, context);
  if (query && typeof query === "object" && !Array.isArray(query)) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value ?? ""));
  }
  return url;
}

function queryContains(target, expected, allowExtra) {
  for (const key of new Set(expected.searchParams.keys())) {
    if (stableJson(target.searchParams.getAll(key)) !== stableJson(expected.searchParams.getAll(key))) return false;
  }
  if (allowExtra) return true;
  const targetKeys = [...new Set(target.searchParams.keys())].sort();
  const expectedKeys = [...new Set(expected.searchParams.keys())].sort();
  return stableJson(targetKeys) === stableJson(expectedKeys);
}

function headersMatchPlan(plan, context, transportHeaders) {
  const actual = normalizedHeaders(transportHeaders);
  if (!actual) return false;
  const expected = normalizedHeaders({ accept: "application/json, text/plain, */*", ...(plan.headers || {}) });
  if (!expected) return false;
  const expectedReferer = typeof plan.referer === "string" ? interpolate(plan.referer, context) : "";
  if (actual.has("referer") && (!expectedReferer || actual.get("referer") !== expectedReferer)) return false;
  for (const [key, value] of expected) {
    if (actual.get(key) !== value) return false;
  }
  const dynamic = new Set(["cookie"]);
  if (expectedReferer) dynamic.add("referer");
  if (plan.signStrategy === "mstoken-myargs") dynamic.add("user-agent");
  return [...actual.keys()].every((key) => expected.has(key) || dynamic.has(key));
}

function transportMatchesPlanTemplate(adapter, planKey, context, transport) {
  const plan = adapter?.requestPlans?.[planKey];
  if (!plan || typeof plan !== "object") return false;
  let target;
  let expectedUrl;
  try {
    target = new URL(String(transport?.url || ""));
    expectedUrl = planUrl(adapter, planKey, plan, context || {});
  } catch {
    return false;
  }
  if (!expectedUrl || target.origin !== expectedUrl.origin || target.pathname !== expectedUrl.pathname) return false;
  if (!queryContains(target, expectedUrl, plan.sign === true)) return false;
  const method = String(transport?.method || "GET").toUpperCase();
  if (method !== String(plan.method || "GET").toUpperCase()) return false;
  const expectedBody = method === "GET" ? undefined : interpolateDeep(plan.body, context || {});
  if (stableJson(transport?.body) !== stableJson(expectedBody)) return false;
  const responseType = ["base64", "arrayBuffer", "text", "losslessJson"].includes(plan.responseType) ? plan.responseType : "losslessJson";
  if (String(transport?.responseType || "") !== responseType) return false;
  const expectedTimeouts = new Set([
    boundedTimeout(plan.timeoutMs),
    boundedTimeout(plan.pageFetchTimeoutMs ?? plan.timeoutMs)
  ]);
  if (!expectedTimeouts.has(Number(transport?.timeoutMs))) return false;
  return headersMatchPlan(plan, context || {}, transport?.headers);
}

function httpTransportFingerprint(value = {}) {
  const transport = {
    partition: String(value.partition || ""),
    url: String(value.url || ""),
    method: String(value.method || "GET").toUpperCase(),
    headers: value.headers && typeof value.headers === "object" ? value.headers : {},
    body: value.body,
    responseType: String(value.responseType || ""),
    timeoutMs: Number(value.timeoutMs || 0),
    persistSetCookie: value.persistSetCookie !== false
  };
  return crypto.createHash("sha256").update(stableJson(transport)).digest("hex");
}

function runnerPartitionAllowed(context, partition) {
  const value = String(partition || "");
  if (!value) return false;
  if (context.allowedPartitions.has(value)) return true;
  return [...context.allowedPartitionPrefixes].some((prefix) => value.startsWith(prefix));
}

function transportMatchesPlan(grant, transport) {
  let target;
  try {
    target = new URL(String(transport?.url || ""));
  } catch {
    return false;
  }
  const method = String(transport?.method || "GET").toUpperCase();
  const pathMatches = grant.pathMode === "segment-prefix"
    ? target.pathname === grant.pathPrefix || target.pathname.startsWith(`${grant.pathPrefix.replace(/\/$/, "")}/`)
    : target.pathname === grant.pathPrefix;
  return target.origin === grant.origin && pathMatches && method === grant.method;
}

module.exports = {
  httpTransportFingerprint,
  runnerPartitionAllowed,
  transportMatchesPlan,
  transportMatchesPlanTemplate
};
