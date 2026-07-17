import type { DoudianAdapterConfig, DoudianAdapterPayload, DoudianStoreSummary } from "../../types";
import { getNativeData } from "../../nativeData/client";
import type { CatalogMutationStatus, CatalogMutationRecordInput } from "../../nativeData/types";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { normalizeDoudianProductStatus } from "./productStatus";

const DEFAULT_TENANT_ID = "local-user";
const LIVE_LOOKUP_CACHE_TTL_MS = 60_000;

export interface MutationCandidateInput {
  id?: string;
  candidateId?: string;
  sourceRunId?: string;
  productId: string;
  title?: string;
  action?: string;
}

export interface MutationPreparedCandidate<T extends MutationCandidateInput> extends MutationCandidateInput {
  mutationKey: string;
  lookupObservationId?: string;
  liveLifecycleStatus?: string;
  liveLookupPlanKey?: string;
  item: T;
}

export interface MutationRejectedCandidate<T extends MutationCandidateInput> {
  item: T;
  mutationKey: string;
  status: "failed" | "skipped";
  ok: boolean;
  message: string;
  reason: string;
  liveLifecycleStatus?: string;
  planKey?: string;
}

export interface MutationExecutionInput {
  mutationKey?: string;
  productId?: string;
  action?: string;
  stage?: string;
  status?: string;
  ok?: boolean;
  message?: string;
  planKey?: string;
  diagnostic?: Record<string, unknown>;
}

interface LiveLookupResult {
  ok: boolean;
  found: boolean;
  planKey: string;
  lifecycleStatus: string;
  message: string;
  raw?: Record<string, unknown>;
  response?: RequestPlanResult;
}

const liveLookupCache = new Map<string, { expiresAt: number; result?: LiveLookupResult; pending?: Promise<LiveLookupResult> }>();

function text(value: unknown) {
  return String(value ?? "").trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayText(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function identityForStore(store: DoudianStoreSummary) {
  return {
    platform: "doudian" as const,
    tenantId: text(store.tenantId) || DEFAULT_TENANT_ID,
    shopId: store.shopId,
    storeGeneration: Math.max(1, Math.trunc(Number(store.storeGeneration || 1)))
  };
}

export async function assertMutationStoreActive(store: DoudianStoreSummary) {
  const assertActive = getNativeData()?.stores.assertActiveIdentity;
  if (!assertActive) return { ok: true, compatibilityFallback: true };
  return assertActive(identityForStore(store));
}

function responseSummary(response: RequestPlanResult | undefined) {
  return response
    ? { status: response.status, ok: response.ok, source: response.source, error: response.error || "" }
    : {};
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function mutationKeyFor(args: {
  feature: string;
  runId: string;
  sourceRunId?: string;
  shopId: string;
  productId: string;
  action: string;
  stage?: string;
  extraKey?: string;
}) {
  return [
    "catalog-mutation",
    args.feature,
    args.runId,
    args.sourceRunId || "source-none",
    args.shopId,
    args.productId,
    args.action,
    args.stage || "stage-none",
    args.extraKey || "extra-none"
  ].map((part) => text(part).replace(/\s+/g, "_")).join(":");
}

function mutationRequestHash(args: { action: string; stage?: string; planKey?: string; productIds: string[] }) {
  return stableHash(JSON.stringify({ action: args.action, stage: args.stage || "", planKey: args.planKey || "", productIds: args.productIds }));
}

function fieldPaths(adapter: DoudianAdapterConfig, mapping: Record<string, unknown>, field: string, fallback: string[]) {
  const fields = objectRecord(mapping.fields);
  const value = fields[field] ?? fields[field === "status" ? "productStatus" : field];
  if (Array.isArray(value)) return arrayText(value);
  const config = objectRecord(value);
  return arrayText(config.paths).length ? arrayText(config.paths) : fallback;
}

function mappingFor(adapter: DoudianAdapterConfig) {
  const mappings = objectRecord(adapter.responseMappings);
  const bulk = objectRecord(mappings.bulkDelete);
  if (Object.keys(bulk).length) return bulk;
  const stale = objectRecord(mappings.staleGoodsCleanup);
  if (Object.keys(stale).length) return stale;
  const violations = objectRecord(mappings.violationsData);
  const association = objectRecord(violations.productAssociation);
  if (Object.keys(association).length) return association;
  return {};
}

function listPathsFor(planKey: string, mapping: Record<string, unknown>) {
  return [
    ...arrayText(mapping.listPaths),
    `${planKey}.data.data.list`,
    `${planKey}.data.data.records`,
    `${planKey}.data.data.items`,
    `${planKey}.data.list`,
    `${planKey}.data.records`,
    `${planKey}.data.items`,
    `${planKey}.data`,
    `${planKey}.list`,
    `${planKey}.records`,
    `${planKey}.items`,
    "data.data.list",
    "data.list",
    "list"
  ];
}

function firstArray(root: unknown, paths: string[]) {
  if (Array.isArray(root)) return root.map(objectRecord);
  for (const path of paths) {
    const value = path ? getPathValue(root, path) : root;
    if (Array.isArray(value)) return value.map(objectRecord);
  }
  return [];
}

function preferredStatusValue(record: unknown, paths: string[]) {
  const values = paths
    .map((path) => ({ path, value: path ? getPathValue(record, path) : record }))
    .filter(({ value }) => value !== undefined && value !== null && value !== "");
  return values.find(({ value }) => Number.isNaN(Number(value)))?.value ?? values[0]?.value;
}

function normalizeLifecycleStatus(value: unknown) {
  return normalizeDoudianProductStatus(value);
}

function liveLookupPlanKey(adapter: DoudianAdapterConfig, feature: string) {
  if (feature === "bulk-delete" && adapter.requestPlans?.bulkDeleteProductList) return "bulkDeleteProductList";
  if (feature === "stale-goods-cleanup" && adapter.requestPlans?.staleGoodsProductList) return "staleGoodsProductList";
  if (feature === "opportunity-submit" && adapter.requestPlans?.opportunityProductList) return "opportunityProductList";
  if (adapter.requestPlans?.violationProductLookup) return "violationProductLookup";
  if (adapter.requestPlans?.bulkDeleteProductList) return "bulkDeleteProductList";
  return "";
}

function liveLookupContext(productId: string) {
  return {
    productId,
    keyword: productId,
    page: "0",
    pageSize: "20",
    productStatus: "",
    checkStatus: "",
    draftStatus: "",
    isOnline: "",
    isOffline: "",
    offlineType: "",
    productTab: "all",
    needPayNoStockSkus: "false",
    commentPercent: "",
    orderField: "audit_time",
    sort: "desc"
  };
}

async function fetchLiveLookupProduct(payload: DoudianAdapterPayload, store: DoudianStoreSummary, productId: string, feature: string, shouldCancel?: () => boolean): Promise<LiveLookupResult> {
  const adapter = payload.adapter;
  const planKey = liveLookupPlanKey(adapter, feature);
  if (!planKey) {
    return { ok: false, found: false, planKey, lifecycleStatus: "unknown", message: "live lookup request plan missing" };
  }
  const response = await runDoudianRequestPlan(payload, {
    partition: store.partition,
    planKey,
    context: liveLookupContext(productId),
    shouldCancel
  });
  const mapping = mappingFor(adapter);
  const wrapped = { [planKey]: response.data };
  const rows = firstArray(wrapped, listPathsFor(planKey, mapping));
  const productIdPaths = fieldPaths(adapter, mapping, "productId", ["product_id", "productId", "goods_id", "goodsId", "item_id", "itemId", "id"]);
  const statusPaths = fieldPaths(adapter, mapping, "status", ["product_status", "productStatus", "goods_status", "goodsStatus", "status_name", "statusName", "status", "is_online", "isOnline", "is_offline", "isOffline"]);
  const match = rows.find((row) => text(firstPathValue(row, productIdPaths)) === productId) || null;
  const requestOk = requestPlanResponseOk(response, adapter, planKey, mapping);
  if (!requestOk) {
    return { ok: false, found: false, planKey, lifecycleStatus: "unknown", message: response.error || "live lookup failed", response };
  }
  if (!match) {
    return { ok: true, found: false, planKey, lifecycleStatus: "not_found", message: "live lookup did not find product", response };
  }
  return {
    ok: true,
    found: true,
    planKey,
    lifecycleStatus: normalizeLifecycleStatus(preferredStatusValue(match, statusPaths)),
    message: "",
    raw: match,
    response
  };
}

async function liveLookupProduct(payload: DoudianAdapterPayload, store: DoudianStoreSummary, productId: string, feature: string, shouldCancel?: () => boolean): Promise<LiveLookupResult> {
  const planKey = liveLookupPlanKey(payload.adapter, feature);
  const cacheKey = [store.partition, planKey, productId].map(text).join("::");
  const cached = liveLookupCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.result) return cached.result;
    if (cached.pending) return cached.pending;
  }
  const pending = fetchLiveLookupProduct(payload, store, productId, feature, shouldCancel);
  liveLookupCache.set(cacheKey, { expiresAt: Date.now() + LIVE_LOOKUP_CACHE_TTL_MS, pending });
  const result = await pending;
  if (result.ok && result.found) {
    liveLookupCache.set(cacheKey, { expiresAt: Date.now() + LIVE_LOOKUP_CACHE_TTL_MS, result });
  } else {
    liveLookupCache.delete(cacheKey);
  }
  return result;
}

function allowedStatus(action: string, stage: string | undefined, lifecycleStatus: string) {
  if (lifecycleStatus === "not_found") return { ok: true, allowed: false, reason: "live-not-found", message: "Live lookup did not find product" };
  if (lifecycleStatus === "unknown") return { ok: false, allowed: false, reason: "live-status-unknown", message: "Live lookup returned unknown product status" };
  if (action === "offline") {
    return lifecycleStatus === "selling"
      ? { ok: true, allowed: true, reason: "", message: "" }
      : { ok: true, allowed: false, reason: "not-selling", message: `Product is ${lifecycleStatus}, offline skipped` };
  }
  if (stage === "delete" || action === "delete-confirmed") {
    return lifecycleStatus === "recycle"
      ? { ok: true, allowed: true, reason: "", message: "" }
      : { ok: true, allowed: false, reason: "not-recycled", message: `Product is ${lifecycleStatus}, complete delete skipped` };
  }
  if (action === "recycle" || action === "delete" || stage === "recycle") {
    if (lifecycleStatus === "recycle") {
      return { ok: true, allowed: false, reason: "already-recycled", message: "Product is already in recycle bin" };
    }
    return lifecycleStatus === "selling" || lifecycleStatus === "offline" || lifecycleStatus === "rejected"
      ? { ok: true, allowed: true, reason: "", message: "" }
      : { ok: true, allowed: false, reason: "not-recyclable", message: `Product is ${lifecycleStatus}, recycle skipped` };
  }
  if (action === "submit" || action === "edit-title" || action === "editTitle") {
    return lifecycleStatus === "selling"
      ? { ok: true, allowed: true, reason: "", message: "" }
      : { ok: true, allowed: false, reason: "not-selling", message: `Product is ${lifecycleStatus}, submit skipped` };
  }
  return { ok: true, allowed: true, reason: "", message: "" };
}

async function catalogLatestById(store: DoudianStoreSummary, productIds: string[]) {
  const nativeData = getNativeData();
  if (!nativeData) return new Map<string, { latestObservationId?: string; lifecycleStatus?: string }>();
  const identity = identityForStore(store);
  await nativeData.stores.upsertIdentity({
    ...identity,
    identityContractVersion: "mutation-safety-v1",
    namespace: { source: "mutation-safety" }
  });
  const rows = await nativeData.catalog.getProductsByIds({ ...identity, productIds });
  return new Map(rows.map((row) => [row.productId, { latestObservationId: row.latestObservationId, lifecycleStatus: row.lifecycleStatus }]));
}

async function recordMutations(store: DoudianStoreSummary, mutations: CatalogMutationRecordInput[]) {
  const nativeData = getNativeData();
  if (!nativeData || !mutations.length) return { ok: false, skipped: true, reason: "native-data-unavailable" };
  const identity = identityForStore(store);
  await nativeData.catalog.recordMutationResults({
    ...identity,
    ensureStoreIdentity: true,
    mutations
  });
  return { ok: true, skipped: false, reason: "" };
}

export async function prepareMutationSafety<T extends MutationCandidateInput>(args: {
  payload: DoudianAdapterPayload;
  store: DoudianStoreSummary;
  candidates: T[];
  feature: string;
  runId: string;
  sourceRunId?: string;
  operationId?: string;
  action: string;
  stage?: string;
  planKey?: string;
  dryRun?: boolean;
  protectMode?: "includeSelling" | "skipSelling";
  lookupConcurrency?: number;
  confirmAttempts?: number;
  confirmDelayMs?: number;
  shouldCancel?: () => boolean;
  extraKey?: (item: T) => string;
}) {
  const productIds = Array.from(new Set(args.candidates.map((item) => text(item.productId)).filter(Boolean)));
  if (args.dryRun) {
    return {
      allowed: args.candidates.map((item) => ({
        ...item,
        item,
        mutationKey: mutationKeyFor({ ...args, shopId: args.store.shopId, productId: item.productId, extraKey: args.extraKey?.(item) })
      })) as Array<MutationPreparedCandidate<T> & T>,
      rejected: [] as Array<MutationRejectedCandidate<T>>,
      audit: { ok: true, dryRun: true, preparedCount: 0, rejectedCount: 0 }
    };
  }

  if (!getNativeData()) {
    return {
      allowed: [] as Array<MutationPreparedCandidate<T> & T>,
      rejected: args.candidates.map((item) => ({
        item,
        mutationKey: mutationKeyFor({ ...args, shopId: args.store.shopId, productId: item.productId, extraKey: args.extraKey?.(item) }),
        status: "failed" as const,
        ok: false,
        message: "Native SQLite data service is unavailable; platform write blocked",
        reason: "native-data-unavailable",
        liveLifecycleStatus: undefined,
        planKey: ""
      })),
      audit: { ok: false, dryRun: false, preparedCount: 0, rejectedCount: args.candidates.length }
    };
  }

  const latest = await catalogLatestById(args.store, productIds);
  const allowed: Array<MutationPreparedCandidate<T> & T> = [];
  const rejected: Array<MutationRejectedCandidate<T>> = [];
  const mutations: CatalogMutationRecordInput[] = [];
  const requestHash = mutationRequestHash({ action: args.action, stage: args.stage, planKey: args.planKey, productIds });

  const lookupResults = new Array<LiveLookupResult>(args.candidates.length);
  const concurrency = Math.max(1, Math.min(args.candidates.length || 1, Math.floor(Number(args.lookupConcurrency || 4))));
  const confirmAttempts = args.stage === "delete" ? Math.max(1, Math.min(10, Math.floor(Number(args.confirmAttempts || 1)))) : 1;
  const confirmDelayMs = Math.max(0, Math.min(10000, Math.floor(Number(args.confirmDelayMs || 0))));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= args.candidates.length) return;
      if (args.shouldCancel?.()) throw new Error(`${args.feature} operation cancelled`);
      const productId = text(args.candidates[index].productId);
      let live = await liveLookupProduct(args.payload, args.store, productId, args.feature, args.shouldCancel);
      for (let attempt = 1; attempt < confirmAttempts && live.ok && live.lifecycleStatus !== "recycle"; attempt += 1) {
        if (args.shouldCancel?.()) throw new Error(`${args.feature} operation cancelled`);
        if (confirmDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, confirmDelayMs));
        live = await liveLookupProduct(args.payload, args.store, productId, args.feature, args.shouldCancel);
      }
      lookupResults[index] = live;
    }
  }));

  await assertMutationStoreActive(args.store);

  for (const [index, item] of args.candidates.entries()) {
    const productId = text(item.productId);
    const mutationKey = mutationKeyFor({ ...args, shopId: args.store.shopId, productId, extraKey: args.extraKey?.(item) });
    const live = lookupResults[index];
    const latestRow = latest.get(productId);
    const statusCheck = args.protectMode === "skipSelling" && live.ok && live.lifecycleStatus === "selling" && (args.action === "recycle" || args.stage === "recycle")
      ? { ok: true, allowed: false, reason: "selling-protected", message: "Selling product is protected by the source scan policy" }
      : live.ok && live.found
      ? allowedStatus(args.action, args.stage, live.lifecycleStatus)
      : live.ok
        ? { ok: true, allowed: false, reason: "live-not-found", message: live.message }
        : { ok: false, allowed: false, reason: "live-lookup-failed", message: live.message };

    if (!statusCheck.allowed) {
      rejected.push({
        item,
        mutationKey,
        status: statusCheck.ok ? "skipped" : "failed",
        ok: statusCheck.ok,
        message: statusCheck.message,
        reason: statusCheck.reason,
        liveLifecycleStatus: live.lifecycleStatus,
        planKey: live.planKey
      });
      mutations.push({
        mutationKey,
        productId,
        action: args.action,
        status: statusCheck.ok ? "skipped" : "failed",
        requestHash,
        idempotencyKey: mutationKey,
        lookupObservationId: latestRow?.latestObservationId,
        responseSummary: { reason: statusCheck.reason, liveLifecycleStatus: live.lifecycleStatus, livePlanKey: live.planKey, liveResponse: responseSummary(live.response) }
      });
      continue;
    }

    const prepared = {
      ...item,
      item,
      mutationKey,
      lookupObservationId: latestRow?.latestObservationId,
      liveLifecycleStatus: live.lifecycleStatus,
      liveLookupPlanKey: live.planKey
    } as MutationPreparedCandidate<T> & T;
    allowed.push(prepared);
    mutations.push({
      mutationKey,
      productId,
      action: args.action,
      status: "prepared",
      requestHash,
      idempotencyKey: mutationKey,
      lookupObservationId: latestRow?.latestObservationId,
      responseSummary: { liveLifecycleStatus: live.lifecycleStatus, livePlanKey: live.planKey, liveResponse: responseSummary(live.response) }
    });
  }

  await recordMutations(args.store, mutations);
  return {
    allowed,
    rejected,
    audit: { ok: true, dryRun: false, preparedCount: allowed.length, rejectedCount: rejected.length }
  };
}

function statusFromExecution(execution: MutationExecutionInput): CatalogMutationStatus {
  const status = text(execution.status);
  const message = text(execution.message).toLowerCase();
  if (status === "dry_run") return "skipped";
  if (status === "skipped") return "skipped";
  if (status === "quota_exhausted") return "skipped";
  if (status === "unknown") return "unknown";
  if (execution.ok === true && status === "submitted") return "acknowledged";
  if (execution.ok === true) return "acknowledged";
  if (/timeout|timed out|network|socket|aborted|unknown|\u8d85\u65f6/.test(message)) return "unknown";
  return "failed";
}

export async function recordExecutionMutationResults(args: {
  store: DoudianStoreSummary;
  executions: MutationExecutionInput[];
  defaultAction: string;
}) {
  const mutations = args.executions
    .filter((item) => text(item.mutationKey) && text(item.productId))
    .map((item) => {
      const status = statusFromExecution(item);
      return {
        mutationKey: text(item.mutationKey),
        productId: text(item.productId),
        action: text(item.action) || args.defaultAction,
        status,
        responseSummary: {
          executionStatus: text(item.status),
          ok: item.ok === true,
          message: text(item.message),
          planKey: text(item.planKey),
          stage: text(item.stage),
          diagnostic: item.diagnostic
        },
        acknowledgedAt: status === "acknowledged" ? new Date().toISOString() : undefined
      };
    });
  if (!mutations.length) return { ok: true, changed: 0 };
  await recordMutations(args.store, mutations);
  return { ok: true, changed: mutations.length };
}
