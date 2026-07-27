import type { DoudianAdapterConfig, DoudianAdapterPayload, DoudianFreightTemplate, DoudianFreightTemplateResult, DoudianRunDetail, DoudianStoreResult, DoudianStoreSummary } from "../../types";
import { requireNativeData } from "../../nativeData/client";
import { dispatchDoudianProgress } from "./progress";
import { firstPathValue, getPathValue, requestPlanResponseOk, runDoudianRequestPlan, type RequestPlanResult } from "./requestPlan";
import { deleteStoreLedger, listStoreLedger, upsertStoreLedger } from "./storeGroups";

interface ProductCatalogSyncArgs {
  doudianAdapter?: DoudianAdapterPayload;
  operationId?: string;
  shopIds?: string[];
  tenantId?: string;
  storeGeneration?: number;
  profile?: string;
  planKey?: string;
  pageSize?: number;
  maxPages?: number;
  forceRefresh?: boolean;
  mockProducts?: Array<Record<string, unknown>>;
}

interface FreightTemplateArgs {
  doudianAdapter: DoudianAdapterPayload;
  shopIds?: string[];
  operationId?: string;
  isCancelled?: () => boolean;
  trackWindow?: (winId: number) => void;
}

const DEFAULT_TENANT_ID = "local-user";

function text(value: unknown) {
  return String(value ?? "").trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function adapterPayload(args: ProductCatalogSyncArgs): DoudianAdapterPayload {
  if (!args.doudianAdapter?.adapter) throw new Error("doudian adapter payload missing");
  return args.doudianAdapter;
}

function policy(adapter: DoudianAdapterConfig, path: string, fallback: unknown = undefined): unknown {
  const value = getPathValue(adapter.policies || {}, path);
  return value === undefined ? fallback : value;
}

function policyNumber(adapter: DoudianAdapterConfig, path: string, fallback: number, min = 1, max = 1000) {
  const value = Math.floor(Number(policy(adapter, path, fallback)));
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function mappings(adapter: DoudianAdapterConfig) {
  return objectRecord(objectRecord(adapter.responseMappings).bulkDelete || objectRecord(adapter.responseMappings).staleGoodsCleanup);
}

function mappingArray(adapter: DoudianAdapterConfig, key: string, fallback: string[] = []) {
  const value = mappings(adapter)[key];
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : fallback;
}

function fieldPaths(adapter: DoudianAdapterConfig, field: string, fallback: string[] = []) {
  const fields = objectRecord(mappings(adapter).fields);
  const value = fields[field];
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  const config = objectRecord(value);
  return Array.isArray(config.paths) ? config.paths.map((item) => text(item)).filter(Boolean) : fallback;
}

function firstArray(root: unknown, paths: string[]) {
  if (Array.isArray(root)) return root.map(objectRecord);
  for (const path of paths) {
    const value = path ? getPathValue(root, path) : root;
    if (Array.isArray(value)) return value.map(objectRecord);
  }
  return [];
}

function coerceNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "val", "amount", "count", "cnt", "num", "total", "text"]) {
      const next = coerceNumber(record[key]);
      if (next !== undefined) return next;
    }
    return undefined;
  }
  const match = String(value).replace(/,/g, "").trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const next = Number(match[0]);
  return Number.isFinite(next) ? next : undefined;
}

function readField(record: unknown, adapter: DoudianAdapterConfig, field: string, fallbackPaths: string[] = []) {
  return firstPathValue(record, fieldPaths(adapter, field, fallbackPaths));
}

function readText(record: unknown, adapter: DoudianAdapterConfig, field: string, fallback = "", fallbackPaths: string[] = []) {
  return text(readField(record, adapter, field, fallbackPaths)) || fallback;
}

function normalizeDate(value: unknown) {
  if (value == null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const next = text(value);
  if (/^\d+$/.test(next)) return normalizeDate(Number(next));
  const parsed = new Date(next);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return next || undefined;
}

function normalizeLifecycleStatus(value: unknown) {
  const raw = text(value).toLowerCase();
  if (!raw) return undefined;
  if (["2", "recycle", "recycled"].includes(raw) || raw.includes("recycle") || raw.includes("\u56de\u6536")) return "recycle";
  if (["1", "offline", "off_sale", "offsale"].includes(raw) || raw.includes("offline") || raw.includes("\u4e0b\u67b6")) return "offline";
  if (["0", "selling", "onsale", "on_sale"].includes(raw) || raw.includes("selling") || raw.includes("\u5728\u552e") || raw.includes("\u4e0a\u67b6")) return "selling";
  return "unknown";
}

function fieldState(value: unknown) {
  return value === undefined || value === null || value === "" ? { state: "missing" as const } : { state: "present" as const };
}

function priceMinor(record: unknown, adapter: DoudianAdapterConfig) {
  const value = readField(record, adapter, "price", ["price", "min_price", "minPrice"]);
  const numberValue = coerceNumber(value);
  return numberValue === undefined ? undefined : String(Math.round(numberValue));
}

function normalizeProduct(record: Record<string, unknown>, adapter: DoudianAdapterConfig) {
  const productId = readText(record, adapter, "productId", "", ["product_id", "productId", "goods_id", "goodsId", "item_id", "itemId", "id"]);
  if (!productId) return null;
  const title = readText(record, adapter, "title", productId, ["title", "name", "product_name", "productName", "goods_name", "goodsName"]);
  const categoryName = readText(record, adapter, "category", "", ["category_name", "categoryName", "category", "leaf_category_name", "leafCategoryName"]);
  const statusRaw = readField(record, adapter, "status", ["status_name", "statusName", "status", "product_status", "productStatus"]);
  const lifecycleStatus = normalizeLifecycleStatus(statusRaw);
  const stock = coerceNumber(readField(record, adapter, "stock", ["stock", "stock_num", "stockNum", "inventory"]));
  const totalSales = coerceNumber(readField(record, adapter, "totalSales", ["total_sales", "totalSales", "sell_num", "sellNum", "sales"]));
  const listedAt = normalizeDate(readField(record, adapter, "listedAt", ["audit_time", "auditTime", "online_time", "onlineTime"]));
  const createdAt = normalizeDate(readField(record, adapter, "createdAt", ["create_time", "createTime", "created_at", "createdAt"]));
  const minor = priceMinor(record, adapter);
  return {
    productId,
    title,
    categoryName,
    lifecycleStatus,
    platformStatusRaw: statusRaw == null ? undefined : String(statusRaw),
    priceMinMinor: minor,
    priceMaxMinor: minor,
    currency: "CNY",
    stock,
    totalSales,
    createdAt,
    listedAt,
    fieldState: {
      productId: { state: "present" as const },
      title: fieldState(title),
      categoryName: fieldState(categoryName),
      lifecycleStatus: fieldState(lifecycleStatus),
      platformStatusRaw: fieldState(statusRaw),
      priceMinMinor: fieldState(minor),
      priceMaxMinor: fieldState(minor),
      currency: { state: "present" as const },
      stock: fieldState(stock),
      totalSales: fieldState(totalSales),
      createdAt: fieldState(createdAt),
      listedAt: fieldState(listedAt)
    },
    raw: record
  };
}

function statusContext(status: "selling" | "offline" | "all" = "selling") {
  const base = {
    productStatus: "",
    checkStatus: "",
    draftStatus: "",
    isOnline: "1",
    isOffline: "",
    offlineType: "",
    productTab: "all",
    needPayNoStockSkus: "false",
    commentPercent: "",
    orderField: "audit_time",
    sort: "desc",
    keyword: ""
  };
  if (status === "offline") return { ...base, isOnline: "", isOffline: "1", productTab: "offline", orderField: "offline_time" };
  if (status === "all") return base;
  return { ...base, productStatus: "0", checkStatus: "3", draftStatus: "0", productTab: "onSale", needPayNoStockSkus: "true" };
}

function targetStores(stores: DoudianStoreSummary[], shopIds: string[] = []) {
  const requested = new Set(shopIds.map(text).filter(Boolean));
  return requested.size ? stores.filter((store) => requested.has(store.shopId)) : stores;
}

function totalFromResponse(root: unknown, adapter: DoudianAdapterConfig) {
  return coerceNumber(firstPathValue(root, mappingArray(adapter, "totalPaths"))) || 0;
}

function responseSummary(response: RequestPlanResult | undefined) {
  return response ? { status: response.status, ok: response.ok, source: response.source, error: response.error || "" } : null;
}

async function syncStoreCatalog(payload: DoudianAdapterPayload, store: DoudianStoreSummary, args: ProductCatalogSyncArgs, index: number, total: number) {
  const nativeData = requireNativeData();
  const adapter = payload.adapter;
  const tenantId = text(args.tenantId || store.tenantId) || DEFAULT_TENANT_ID;
  const storeGeneration = Math.max(1, Math.trunc(Number(args.storeGeneration || store.storeGeneration || 1)));
  const profile = text(args.profile) || "doudian-product-catalog-selling-v1";
  const planKey = text(args.planKey) || "bulkDeleteProductList";
  const pageSize = Math.max(10, Math.min(500, Math.floor(Number(args.pageSize || policyNumber(adapter, "productCatalog.pageSize", 100, 10, 500)))));
  const maxPages = Math.max(1, Math.min(200, Math.floor(Number(args.maxPages || policyNumber(adapter, "productCatalog.maxPages", 50, 1, 200)))));
  const operationId = text(args.operationId) || `product-catalog-${Date.now()}`;
  const scope = { lifecycleStatuses: ["selling"], sort: [{ field: "audit_time", direction: "desc" as const }] };

  await nativeData.stores.upsertIdentity({
    platform: "doudian",
    tenantId,
    shopId: store.shopId,
    storeGeneration,
    identityContractVersion: "catalog-runner-v1",
    namespace: { source: "catalog-runner" }
  });
  const job = await nativeData.catalogJobs.acquire({
    platform: "doudian",
    tenantId,
    shopId: store.shopId,
    storeGeneration,
    profile,
    queryKind: "range",
    scope,
    readRequirement: { requiredFields: ["productId", "title"] },
    completeness: args.forceRefresh ? "force-refresh" : "prefer-exhausted",
    reason: "manual-catalog-sync",
    operationId,
    adapterVersion: adapter.version || "",
    catalogContractHash: `${adapter.version || "adapter"}:product-catalog-selling-v1`
  });

  const listPaths = mappingArray(adapter, "listPaths", ["bulkDeleteProductList.data", "bulkDeleteProductList.data.list", "bulkDeleteProductList.list"]);
  let fetched = 0;
  let remoteTotal = 0;
  let status: "exhausted" | "partial" | "failed" = "partial";
  let terminationReason = "page-window-exhausted";
  let lastResponse: RequestPlanResult | undefined;

  try {
    if (args.mockProducts?.length) {
      const products = args.mockProducts.map((item) => normalizeProduct(item, adapter)).filter((item): item is NonNullable<typeof item> => Boolean(item));
      await nativeData.catalogJobs.reportPage({
        jobId: job.jobId,
        runId: job.runId,
        jobGeneration: job.jobGeneration,
        ownerEpoch: job.ownerEpoch,
        commitToken: `${job.runId}:mock:1`,
        pageNo: 1,
        sourceRequestKey: `${planKey}:mock:1`,
        remoteTotal: products.length,
        products
      });
      fetched = products.length;
      status = "exhausted";
      terminationReason = "mock-products";
    } else {
      for (let page = 0; page < maxPages; page += 1) {
        const pageNo = page + 1;
        dispatchDoudianProgress({ operationId, taskType: "syncProductCatalog", status: "running", progress: Math.min(95, Math.round(((index - 1) / total) * 100 + (pageNo / maxPages) * (100 / total))), message: `catalog ${store.shopName || store.shopId} page ${pageNo}` });
        const response = await runDoudianRequestPlan(payload, {
          partition: store.partition,
          planKey,
          context: { ...statusContext("selling"), page: String(page), pageSize: String(pageSize) }
        });
        lastResponse = response;
        const wrapped = { [planKey]: response.data };
        const rows = firstArray(wrapped, listPaths);
        remoteTotal = totalFromResponse(wrapped, adapter) || remoteTotal;
        const ok = requestPlanResponseOk(response, adapter, planKey, mappings(adapter));
        if (!ok) {
          status = fetched > 0 ? "partial" : "failed";
          terminationReason = "request-failed";
          break;
        }
        const products = rows.map((row) => normalizeProduct(row, adapter)).filter((item): item is NonNullable<typeof item> => Boolean(item));
        if (products.length) {
          await nativeData.catalogJobs.reportPage({
            jobId: job.jobId,
            runId: job.runId,
            jobGeneration: job.jobGeneration,
            ownerEpoch: job.ownerEpoch,
            commitToken: `${job.runId}:${planKey}:${pageNo}`,
            pageNo,
            sourceRequestKey: `${planKey}:page:${pageNo}`,
            remoteTotal: remoteTotal || undefined,
            products
          });
          fetched += products.length;
        }
        if (!rows.length || (remoteTotal > 0 && fetched >= remoteTotal)) {
          status = "exhausted";
          terminationReason = !rows.length ? "empty-page" : "remote-total-reached";
          break;
        }
      }
    }
    const finish = await nativeData.catalogJobs.finish({
      jobId: job.jobId,
      runId: job.runId,
      jobGeneration: job.jobGeneration,
      ownerEpoch: job.ownerEpoch,
      status,
      terminationReason
    });
    return {
      ok: status !== "failed",
      detail: {
        shopId: store.shopId,
        shopName: store.shopName,
        ok: status !== "failed",
        status,
        message: `catalog sync ${status}`,
        reason: terminationReason,
        diagnostic: { tenantId, storeGeneration, profile, planKey, coverageKey: job.activeCoverageKey, runId: job.runId, fetched, remoteTotal, finish, response: responseSummary(lastResponse) },
        index,
        total
      } as DoudianRunDetail,
      coverageKey: job.activeCoverageKey,
      tenantId,
      storeGeneration,
      runId: job.runId,
      fetched,
      remoteTotal
    };
  } catch (error) {
    await nativeData.catalogJobs.finish({
      jobId: job.jobId,
      runId: job.runId,
      jobGeneration: job.jobGeneration,
      ownerEpoch: job.ownerEpoch,
      status: fetched > 0 ? "partial" : "failed",
      terminationReason: "exception"
    }).catch(() => undefined);
    throw error;
  }
}

export async function runProductCatalogSyncTask(args: ProductCatalogSyncArgs = {}): Promise<DoudianStoreResult & { coverageKeys?: string[] }> {
  const payload = adapterPayload(args);
  const ledger = await listStoreLedger();
  const stores = ledger.stores || [];
  const targets = targetStores(stores, args.shopIds || []);
  if (!targets.length) return { ...ledger, ok: false, status: "no-store", message: "No Doudian stores selected", details: [] as unknown as DoudianStoreResult["details"] };

  const details: DoudianRunDetail[] = [];
  const coverageKeys: string[] = [];
  for (const [index, store] of targets.entries()) {
    try {
      const result = await syncStoreCatalog(payload, store, args, index + 1, targets.length);
      details.push(result.detail);
      coverageKeys.push(result.coverageKey);
    } catch (error) {
      details.push({
        shopId: store.shopId,
        shopName: store.shopName,
        ok: false,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        reason: "catalog-sync-failed",
        category: "api",
        index: index + 1,
        total: targets.length
      });
    }
  }
  const successCount = details.filter((item) => item.ok).length;
  const failureCount = details.length - successCount;
  return {
    ...ledger,
    ok: failureCount === 0,
    status: failureCount ? (successCount ? "partial" : "failed") : "ok",
    message: failureCount ? "Product catalog sync finished with failures" : "Product catalog sync finished",
    operationId: args.operationId,
    details: details as unknown as DoudianStoreResult["details"],
    updated: successCount,
    failed: failureCount,
    coverageKeys
  };
}

function freightResponseMessage(value: unknown) {
  return text(firstPathValue(value, ["msg", "message", "status_msg", "statusMessage"]));
}

function freightTemplateRows(value: unknown) {
  const data = getPathValue(value, "data");
  if (Array.isArray(data)) return data.map(objectRecord);
  if (data && typeof data === "object") return Object.values(data).map(objectRecord);
  return [];
}

function freightTemplateTotal(value: unknown, fallback: number) {
  const total = Number(firstPathValue(value, ["total", "data.total"]));
  return Number.isFinite(total) && total >= 0 ? total : fallback;
}

function normalizeFreightTemplate(store: DoudianStoreSummary, row: Record<string, unknown>): DoudianFreightTemplate | null {
  const id = text(row.id || row.template_id || row.templateId);
  const templateName = text(row.template_name || row.templateName || row.name);
  if (!id && !templateName) return null;
  return {
    id: id || `${store.shopId}:${templateName}`,
    templateName: templateName || `运费模板 ${id}`,
    shopId: store.shopId,
    shopName: store.shopName,
    raw: row
  };
}

async function fetchStoreFreightTemplates(payload: DoudianAdapterPayload, store: DoudianStoreSummary, args: FreightTemplateArgs, index: number, totalStores: number) {
  const tokenResponse = await runDoudianRequestPlan(payload, {
    partition: store.partition,
    planKey: "freightTemplateToken",
    context: {
      timestamp: String(Date.now()),
      shopId: store.shopId,
      shopName: store.shopName,
      partition: store.partition
    },
    trackWindow: args.trackWindow,
    shouldCancel: args.isCancelled
  });
  const tokenOk = requestPlanResponseOk(tokenResponse, payload.adapter, "freightTemplateToken");
  const token = text(firstPathValue(tokenResponse.data, ["data.token", "data.__token", "token", "__token"]));
  if (!tokenOk || !token) {
    const message = freightResponseMessage(tokenResponse.data) || tokenResponse.error || "店铺登录令牌获取失败";
    return {
      templates: [] as DoudianFreightTemplate[],
      detail: {
        shopId: store.shopId,
        shopName: store.shopName,
        status: "failed",
        ok: false,
        message,
        reason: "freight-template-token-failed",
        category: "api",
        diagnostic: { tokenStatus: tokenResponse.status, tokenAttempts: tokenResponse.attemptCount || 0 },
        index,
        total: totalStores
      } satisfies DoudianRunDetail
    };
  }

  const pageSize = 100;
  const maxPages = 50;
  const templates: DoudianFreightTemplate[] = [];
  let remoteTotal = 0;
  let fetchedPages = 0;
  let failureMessage = "";
  for (let page = 0; page < maxPages; page += 1) {
    if (args.isCancelled?.()) {
      failureMessage = "运费模板刷新已取消";
      break;
    }
    const response = await runDoudianRequestPlan(payload, {
      partition: store.partition,
      planKey: "freightTemplateList",
      context: {
        name: "",
        page: String(page),
        pageSize: String(pageSize),
        token,
        shopId: store.shopId,
        shopName: store.shopName,
        partition: store.partition
      },
      trackWindow: args.trackWindow,
      shouldCancel: args.isCancelled
    });
    if (!requestPlanResponseOk(response, payload.adapter, "freightTemplateList")) {
      failureMessage = freightResponseMessage(response.data) || response.error || "运费模板列表获取失败";
      break;
    }
    const rows = freightTemplateRows(response.data);
    fetchedPages += 1;
    remoteTotal = Math.max(remoteTotal, freightTemplateTotal(response.data, rows.length));
    for (const row of rows) {
      const template = normalizeFreightTemplate(store, row);
      if (template) templates.push(template);
    }
    if (rows.length < pageSize || templates.length >= remoteTotal) break;
  }

  const deduped = Array.from(new Map(templates.map((template) => [template.id, template])).values());
  const truncated = !failureMessage && fetchedPages >= maxPages && remoteTotal > deduped.length;
  const ok = !failureMessage && !truncated;
  const message = failureMessage || (truncated ? "运费模板数量超过当前分页上限" : `已获取 ${deduped.length} 个运费模板`);
  return {
    templates: ok ? deduped : [],
    detail: {
      shopId: store.shopId,
      shopName: store.shopName,
      status: ok ? "ok" : "failed",
      ok,
      message,
      reason: ok ? "" : truncated ? "freight-template-truncated" : "freight-template-list-failed",
      category: ok ? "" : truncated ? "adapter-policy" : "api",
      diagnostic: { fetchedPages, fetchedCount: deduped.length, remoteTotal },
      index,
      total: totalStores
    } satisfies DoudianRunDetail
  };
}

export async function fetchFreightTemplates(args: FreightTemplateArgs): Promise<DoudianFreightTemplateResult> {
  const payload = args.doudianAdapter;
  if (!payload.adapter.requestPlans?.freightTemplateToken || !payload.adapter.requestPlans?.freightTemplateList) {
    throw new Error("运费模板请求配置缺失");
  }
  const ledger = await listStoreLedger();
  const requested = new Set((args.shopIds || []).map(text).filter(Boolean));
  const stores = (ledger.stores || []).filter((store) => !requested.size || requested.has(store.shopId));
  if (!stores.length) return { ok: false, status: "failed", message: "未选择可用店铺", templates: [], successCount: 0, failureCount: 0 };

  const templates: DoudianFreightTemplate[] = [];
  const details: DoudianRunDetail[] = [];
  for (const [index, store] of stores.entries()) {
    const result = await fetchStoreFreightTemplates(payload, store, args, index + 1, stores.length);
    templates.push(...result.templates);
    details.push(result.detail);
  }
  const successCount = details.filter((detail) => detail.ok).length;
  const failureCount = details.length - successCount;
  const status = failureCount ? (successCount ? "partial" : "failed") : "ok";
  const message = failureCount
    ? successCount
      ? `已获取 ${successCount} 家店铺，${failureCount} 家失败`
      : details[0]?.message || "运费模板获取失败"
    : `已获取 ${templates.length} 个运费模板`;
  return {
    ok: failureCount === 0,
    status,
    message,
    operationId: args.operationId,
    templates,
    details,
    successCount,
    failureCount,
    stores,
    groups: ledger.groups || []
  };
}

export async function runProductCatalogSyncSelfCheck(options: { doudianAdapter?: DoudianAdapterPayload } = {}) {
  const payload = adapterPayload({ doudianAdapter: options.doudianAdapter });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shopId = `catalog-self-check-${suffix}`;
  try {
    await upsertStoreLedger({ shopId, shopName: `Catalog Self Check ${suffix}`, platform: "doudian", partition: `persist:chihu-catalog-self-check-${suffix}`, status: "online", adapterVersion: payload.adapter.version });
    const result = await runProductCatalogSyncTask({
      doudianAdapter: payload,
      operationId: `catalog-self-check-${suffix}`,
      shopIds: [shopId],
      tenantId: DEFAULT_TENANT_ID,
      mockProducts: [{ product_id: `catalog-product-${suffix}`, title: "Catalog Self Check", status: "0", price: 1999, stock: 3, total_sales: 2 }]
    });
    return { ok: result.ok === true && !!result.coverageKeys?.[0], coverageKey: result.coverageKeys?.[0] || "", status: result.status || "" };
  } finally {
    await deleteStoreLedger([shopId]).catch(() => undefined);
  }
}
