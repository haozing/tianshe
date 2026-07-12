const { createHash } = require("node:crypto");

const SCOPE_NORMALIZE_VERSION = "product-catalog-scope-v2";
const SCOPE_HASH_VERSION = "product-catalog-scope-hash-v1";
const CONTRACT_HASH_VERSION = "product-catalog-contract-hash-v1";

const SCOPE_KEYS = new Set([
  "lifecycleStatuses",
  "checkStatuses",
  "timeRange",
  "keyword",
  "categoryIds",
  "productIds",
  "productTab",
  "sort"
]);

const TIME_RANGE_KEYS = new Set(["field", "startInclusive", "endExclusive"]);
const SORT_KEYS = new Set(["field", "direction"]);
const QUERY_KINDS = new Set(["range", "filtered", "targeted", "count-only"]);

function createContractError(message, details = {}) {
  const error = new Error(message);
  error.code = "NATIVE_DATA_BAD_CATALOG_CONTRACT";
  error.details = details;
  return error;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const next = value[key];
    if (next !== undefined) output[key] = canonicalize(next);
  }
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function byteCompare(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  const compared = Buffer.compare(left, right);
  return compared || String(a).localeCompare(String(b));
}

function normalizeNonEmptyString(value, fieldName) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text;
}

function normalizeStringArray(scope, fieldName) {
  const raw = scope[fieldName];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw createContractError(`${fieldName} must be an array`, { fieldName });
  }
  const values = [...new Set(raw.map((item) => normalizeNonEmptyString(item, fieldName)).filter(Boolean))];
  if (!values.length) return undefined;
  values.sort(byteCompare);
  return values;
}

function normalizeIsoBoundary(value, fieldName) {
  const text = normalizeNonEmptyString(value, fieldName);
  if (!text) return undefined;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw createContractError(`${fieldName} must include an explicit timezone`, { fieldName, value: text });
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw createContractError(`${fieldName} must be a valid ISO time`, { fieldName, value: text });
  }
  return date.toISOString();
}

function normalizeTimeRange(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw createContractError("timeRange must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!TIME_RANGE_KEYS.has(key)) throw createContractError("Unknown timeRange field", { fieldName: key });
  }
  const field = normalizeNonEmptyString(raw.field, "timeRange.field");
  if (!field) throw createContractError("timeRange.field is required when timeRange is present");
  const output = { field };
  const startInclusive = normalizeIsoBoundary(raw.startInclusive, "timeRange.startInclusive");
  const endExclusive = normalizeIsoBoundary(raw.endExclusive, "timeRange.endExclusive");
  if (startInclusive) output.startInclusive = startInclusive;
  if (endExclusive) output.endExclusive = endExclusive;
  return output;
}

function normalizeSort(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw createContractError("sort must be an array");
  const output = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw createContractError("sort item must be an object");
    }
    for (const key of Object.keys(item)) {
      if (!SORT_KEYS.has(key)) throw createContractError("Unknown sort field", { fieldName: key });
    }
    const field = normalizeNonEmptyString(item.field, "sort.field");
    const direction = normalizeNonEmptyString(item.direction, "sort.direction");
    if (!field || !direction) throw createContractError("sort item requires field and direction");
    if (direction !== "asc" && direction !== "desc") {
      throw createContractError("sort.direction must be asc or desc", { direction });
    }
    output.push({ field, direction });
  }
  return output.length ? output : undefined;
}

function normalizeProductCatalogScopeV2(scope = {}) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw createContractError("scope must be an object");
  }
  for (const key of Object.keys(scope)) {
    if (!SCOPE_KEYS.has(key)) throw createContractError("Unknown product catalog scope field", { fieldName: key });
  }

  const output = {};
  for (const fieldName of ["lifecycleStatuses", "checkStatuses", "categoryIds", "productIds"]) {
    const values = normalizeStringArray(scope, fieldName);
    if (values) output[fieldName] = values;
  }

  const timeRange = normalizeTimeRange(scope.timeRange);
  if (timeRange) output.timeRange = timeRange;

  const keyword = normalizeNonEmptyString(scope.keyword, "keyword");
  if (keyword) output.keyword = keyword;

  const productTab = normalizeNonEmptyString(scope.productTab, "productTab");
  if (productTab) output.productTab = productTab;

  const sort = normalizeSort(scope.sort);
  if (sort) output.sort = sort;

  return output;
}

function normalizeQueryKind(value) {
  const queryKind = normalizeNonEmptyString(value, "queryKind") || "range";
  if (!QUERY_KINDS.has(queryKind)) throw createContractError("Invalid product catalog query kind", { queryKind });
  return queryKind;
}

function normalizeCatalogContractHash(args = {}) {
  const explicit = normalizeNonEmptyString(args.catalogContractHash, "catalogContractHash");
  if (explicit) return explicit;
  return sha256Hex(canonicalJson({
    schemaVersion: CONTRACT_HASH_VERSION,
    platform: args.platform || "doudian",
    profile: args.profile || "unknown",
    queryKind: normalizeQueryKind(args.queryKind),
    contractVersion: args.catalogContractVersion || ""
  }));
}

function buildCoverageDescriptor(args = {}) {
  const platform = normalizeNonEmptyString(args.platform, "platform") || "doudian";
  const tenantId = normalizeNonEmptyString(args.tenantId, "tenantId");
  const shopId = normalizeNonEmptyString(args.shopId, "shopId");
  const storeGeneration = Math.trunc(Number(args.storeGeneration || args.generation || 1));
  if (!tenantId || !shopId || !Number.isInteger(storeGeneration) || storeGeneration <= 0) {
    throw createContractError("Coverage identity is incomplete", { tenantId, shopId, storeGeneration });
  }

  const queryKind = normalizeQueryKind(args.queryKind);
  const normalizedScope = normalizeProductCatalogScopeV2(args.scope || {});
  const normalizedScopeHash = sha256Hex(canonicalJson({
    schemaVersion: SCOPE_HASH_VERSION,
    normalizeVersion: SCOPE_NORMALIZE_VERSION,
    scope: normalizedScope
  }));
  const catalogContractHash = normalizeCatalogContractHash({ ...args, platform, queryKind });
  const coverageKey = [
    platform,
    tenantId,
    shopId,
    storeGeneration,
    queryKind,
    normalizedScopeHash,
    catalogContractHash
  ].join("::");

  return {
    coverageKey,
    normalizedScope,
    normalizedScopeHash,
    catalogContractHash,
    queryKind
  };
}

module.exports = {
  CONTRACT_HASH_VERSION,
  SCOPE_HASH_VERSION,
  SCOPE_NORMALIZE_VERSION,
  buildCoverageDescriptor,
  canonicalJson,
  normalizeProductCatalogScopeV2,
  normalizeQueryKind,
  sha256Hex
};
