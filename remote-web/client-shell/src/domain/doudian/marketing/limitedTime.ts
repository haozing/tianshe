import type { MarketingStoreReadResult } from "./types";

export interface MarketingTimeSegment {
  startTime: string;
  endTime: string;
}

export const LIMITED_TIME_ACTIVITY_PRODUCT_LIMIT = 200;
export const LIMITED_TIME_ACTIVITY_SKU_LIMIT = 4000;

export interface LimitedTimeCreateBatch {
  batchIndex: number;
  batchCount: number;
  productCount: number;
  context: Record<string, unknown>;
}

export interface LimitedTimeCreateOutcome {
  unit: Pick<LimitedTimeCreateBatch, "batchIndex" | "batchCount" | "productCount">;
  result: MarketingStoreReadResult;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInteger(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function productId(value: unknown) {
  const product = recordValue(value);
  return String(product.entityId || product.productId || "");
}

function productSkuCount(value: unknown) {
  const product = recordValue(value);
  return positiveInteger(product.skuCount, 1);
}

function activityTypeDurationMinutes(value: unknown) {
  if (value === "limited") return 30 * 24 * 60;
  if (value === "ordinary") return 365 * 24 * 60;
  return 4 * 24 * 60;
}

function configuredTimeSegments(context: Record<string, unknown>) {
  if (!Array.isArray(context.timeSegments)) return [];
  return context.timeSegments.map(recordValue).flatMap((segment) => {
    const start = Date.parse(String(segment.startTime || ""));
    const end = Date.parse(String(segment.endTime || ""));
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? [{ startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() }]
      : [];
  });
}

function batchActivityName(context: Record<string, unknown>, batchIndex: number, batchCount: number) {
  const configured = String(context.name || "").trim();
  if (context.nameMode === "random") return "";
  const base = configured || "限时限量购";
  return batchCount > 1 ? `${base} ${batchIndex}/${batchCount}` : base;
}

function splitProductIds(context: Record<string, unknown>) {
  const limit = Math.min(LIMITED_TIME_ACTIVITY_PRODUCT_LIMIT, positiveInteger(context.productLimitPerActivity, LIMITED_TIME_ACTIVITY_PRODUCT_LIMIT));
  const ids = Array.isArray(context.productIds) ? [...new Set(context.productIds.map(String).filter(Boolean))] : [];
  const selectedProducts = Array.isArray(context.selectedProducts) ? context.selectedProducts : [];
  const productsById = new Map<string, unknown>(selectedProducts.map((product): [string, unknown] => [productId(product), product]).filter(([id]) => id));
  const chunks: string[][] = [];
  let current: string[] = [];
  let skuCount = 0;
  for (const id of ids) {
    const nextSkuCount = productSkuCount(productsById.get(id));
    if (nextSkuCount > LIMITED_TIME_ACTIVITY_SKU_LIMIT) {
      throw new Error(`商品 ${id} 含 ${nextSkuCount} 个 SKU，超过单活动 ${LIMITED_TIME_ACTIVITY_SKU_LIMIT} 个 SKU 上限`);
    }
    if (current.length && (current.length >= limit || skuCount + nextSkuCount > LIMITED_TIME_ACTIVITY_SKU_LIMIT)) {
      chunks.push(current);
      current = [];
      skuCount = 0;
    }
    current.push(id);
    skuCount += nextSkuCount;
  }
  if (current.length || !chunks.length) chunks.push(current);
  return { chunks, productsById };
}

export function splitLimitedTimeCreateBatches(context: Record<string, unknown>): LimitedTimeCreateBatch[] {
  const { chunks, productsById } = splitProductIds(context);
  const segments = configuredTimeSegments(context);
  const generatedSegments = limitedTimeActivitySegments(context);
  const activitySegments = segments.length
    ? segments
    : generatedSegments.length
      ? generatedSegments
      : [{ startTime: String(context.startTime || ""), endTime: String(context.endTime || "") }];
  const units = activitySegments.flatMap((segment) => chunks.map((ids) => ({ segment, ids })));
  const batchCount = units.length;
  return units.map(({ segment, ids }, index) => {
    const batchIndex = index + 1;
    return {
      batchIndex,
      batchCount,
      productCount: ids.length,
      context: {
        ...context,
        scope: "product",
        name: batchActivityName(context, batchIndex, batchCount),
        startTime: segment.startTime,
        endTime: segment.endTime,
        productIds: ids,
        selectedProducts: ids.flatMap((id) => productsById.has(id) ? [productsById.get(id)] : []),
        activityBatchIndex: batchIndex,
        activityBatchCount: batchCount,
        activityBatchProductCount: ids.length
      }
    };
  });
}

export function aggregateLimitedTimeCreate(
  store: { shopId: string; shopName: string },
  outcomes: LimitedTimeCreateOutcome[]
): MarketingStoreReadResult {
  const activityCount = outcomes[0]?.unit.batchCount || outcomes.length;
  const created = outcomes.filter((outcome) => outcome.result.ok).length;
  const failed = outcomes.filter((outcome) => outcome.result.status === "failed").length;
  const unknown = outcomes.filter((outcome) => ["unknown", "reconciling"].includes(outcome.result.status)).length;
  const cancelled = outcomes.filter((outcome) => outcome.result.status === "cancelled").length;
  const problem = outcomes.find((outcome) => !outcome.result.ok);
  const problemPrefix = problem ? `第 ${problem.unit.batchIndex}/${problem.unit.batchCount} 批` : "";
  const createdProductCount = outcomes.reduce((sum, outcome) => sum + (outcome.result.ok ? Number(outcome.result.productCount ?? outcome.unit.productCount) : 0), 0);
  let status: MarketingStoreReadResult["status"] = "accepted";
  if (unknown) status = "reconciling";
  else if (failed && created) status = "partial";
  else if (failed) status = "failed";
  else if (cancelled && created) status = "partial";
  else if (cancelled) status = "cancelled";

  const message = unknown
    ? `已确认创建 ${created}/${activityCount} 个活动；${problemPrefix}结果未知，已停止后续批次并进入对账`
    : failed
      ? `已创建 ${created}/${activityCount} 个活动；${problemPrefix}创建失败：${problem?.result.message || "平台拒绝创建"}`
      : cancelled
        ? `已创建 ${created}/${activityCount} 个活动；${problemPrefix}未发送或已取消`
        : `已创建 ${created} 个活动，共 ${createdProductCount} 个商品`;

  return {
    shopId: store.shopId,
    shopName: store.shopName,
    ok: created === activityCount && !failed && !unknown && !cancelled,
    status,
    message,
    entities: outcomes.flatMap((outcome) => outcome.result.entities),
    total: outcomes.reduce((sum, outcome) => sum + outcome.result.total, 0),
    activityCount,
    createdActivityCount: created,
    failedActivityCount: failed,
    unknownActivityCount: unknown,
    productCount: createdProductCount
  };
}

export function splitMarketingTimeSegments(startTime: string, endTime: string, segmentMinutes = 60): MarketingTimeSegment[] {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const step = Math.max(5, Math.floor(Number(segmentMinutes) || 60)) * 60_000;
  const result: MarketingTimeSegment[] = [];
  for (let cursor = start; cursor < end;) {
    const segmentEnd = Math.min(end, cursor + step);
    result.push({ startTime: new Date(cursor).toISOString(), endTime: new Date(segmentEnd).toISOString() });
    cursor = segmentEnd + 1000;
  }
  return result;
}

export function limitedTimeActivitySegments(context: Record<string, unknown>): MarketingTimeSegment[] {
  const maximum = activityTypeDurationMinutes(context.activityType);
  const configured = positiveInteger(context.activityDurationMinutes, maximum);
  const segmentMinutes = context.timeMode === "recurring" ? Math.min(configured, maximum) : maximum;
  return splitMarketingTimeSegments(String(context.startTime || ""), String(context.endTime || ""), segmentMinutes);
}
