import { firstPathValue, requestPlanResponseOk, runDoudianRequestPlan } from "../requestPlan";
import { isUnknownWriteResponse } from "../requestPlanSafety";
import type { DoudianAdapterConfig, DoudianAdapterPayload, MarketingFeature } from "../../../types";
import type { MarketingEntity, MarketingReadAction, MarketingStoreReadResult, MarketingTaskStore } from "./types";
import { buildLimitedTimePromotionGoods } from "./writeContext";
import { LIMITED_TIME_ACTIVITY_SKU_LIMIT } from "./limitedTime";
import { mapWithConcurrency } from "./concurrency";
import { platformFailureMessage } from "./platformError";
import { generalCouponProductQueryBody, generalCouponProductValidationBody, generalCouponRejectedItems } from "./generalCoupon.ts";
import { newUserBonusPreflightBody, newUserBonusProductQueryBody } from "./newUserBonus.ts";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringPaths(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function featurePolicy(adapter: DoudianAdapterConfig, feature: MarketingFeature) {
  return objectValue(objectValue(objectValue(adapter.policies).marketing).features)[feature] as Record<string, unknown>;
}

function featureMapping(adapter: DoudianAdapterConfig, feature: MarketingFeature) {
  return objectValue(objectValue(adapter.responseMappings?.marketing)[feature]);
}

function mappedValue(row: unknown, fields: Record<string, unknown>, key: string) {
  const definition = objectValue(fields[key]);
  const value = firstPathValue(row, stringPaths(definition.paths));
  const valueMap = objectValue(definition.valueMap);
  return valueMap[String(value)] ?? value;
}

function rawMappedValue(row: unknown, fields: Record<string, unknown>, key: string) {
  return firstPathValue(row, stringPaths(objectValue(fields[key]).paths));
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function optionalBoolean(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

function displayTime(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date.toLocaleString("zh-CN", { hour12: false });
  }
  return String(value);
}

function epochSeconds(value: unknown, fallback: number) {
  const timestamp = Date.parse(String(value || ""));
  return Math.floor((Number.isFinite(timestamp) ? timestamp : fallback) / 1000);
}

function readContext(feature: MarketingFeature, context: Record<string, unknown>) {
  const now = Date.now();
  const startTimestamp = epochSeconds(context.startTime, now);
  const endTimestamp = epochSeconds(context.endTime, now + 30 * 24 * 60 * 60 * 1000);
  const discountMode = String(context.discountMode || "discount");
  const discountType = discountMode === "reduce" ? 1 : discountMode === "threshold" ? 3 : 4;
  const discountValue = Math.max(0, Number(context.discountValue || 0));
  const thresholdAmount = Math.max(0, Number(context.thresholdAmount || 0));
  return {
    ...context,
    startTimestamp,
    endTimestamp,
    discountType,
    discountTenths: Math.round(discountValue * 10),
    creditFen: Math.round(discountValue * 100),
    thresholdFen: Math.round(thresholdAmount * 100),
    activityToolType: feature === "limited_time" ? 26 : feature === "new_user_bonus" ? 4 : 7
    ,businessCode: context.activityType === "limited" ? "LimitQuantity" : context.activityType === "ordinary" ? "OrdinaryTimeBuy" : "LimitTime"
  };
}

function readPlanKeys(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const key = String(value || "");
  return key ? [key] : [];
}

function actionPaths(mapping: Record<string, unknown>, action: MarketingReadAction) {
  const configured = objectValue(mapping.actionListPaths)[action];
  if (configured) return stringPaths(configured);
  return stringPaths(action === "detail" ? (mapping.detailPaths || mapping.listPaths) : mapping.listPaths);
}

function normalizeEntity(row: unknown, fields: Record<string, unknown>, store: MarketingTaskStore): MarketingEntity {
  return {
    entityId: String(mappedValue(row, fields, "entityId") ?? ""),
    coreEntityId: String(mappedValue(row, fields, "coreEntityId") ?? "") || undefined,
    shopId: store.shopId,
    shopName: store.shopName,
    name: String(mappedValue(row, fields, "name") ?? mappedValue(row, fields, "title") ?? "unnamed"),
    status: String(mappedValue(row, fields, "status") ?? "unknown"),
    rawStatus: String(rawMappedValue(row, fields, "status") ?? "") || undefined,
    activityType: String(mappedValue(row, fields, "activityType") ?? "") || undefined,
    discountType: String(mappedValue(row, fields, "discountType") ?? "") || undefined,
    startTime: displayTime(mappedValue(row, fields, "startTime")),
    endTime: displayTime(mappedValue(row, fields, "endTime")),
    platformError: String(mappedValue(row, fields, "platformError") ?? ""),
    productCount: Number(mappedValue(row, fields, "productCount") ?? 0),
    amountFen: optionalNumber(mappedValue(row, fields, "amountFen")),
    priceFen: optionalNumber(mappedValue(row, fields, "priceFen")),
    inventory: optionalNumber(mappedValue(row, fields, "inventory")),
    skuCount: optionalNumber(mappedValue(row, fields, "skuCount")),
    eligible: optionalBoolean(mappedValue(row, fields, "eligible")),
    failureReason: String(mappedValue(row, fields, "failureReason") ?? "") || undefined,
    autoRenew: optionalBoolean(mappedValue(row, fields, "autoRenew")),
    toolRenew: optionalBoolean(mappedValue(row, fields, "toolRenew")),
    limitStockType: String(mappedValue(row, fields, "limitStockType") ?? "") || undefined,
    updatedAt: String(mappedValue(row, fields, "updatedAt") ?? "") || undefined,
    couponType: String(mappedValue(row, fields, "couponType") ?? mappedValue(row, fields, "activityType") ?? "") || undefined,
    favouredType: optionalNumber(rawMappedValue(row, fields, "discountType")),
    discountTenths: optionalNumber(mappedValue(row, fields, "discountTenths")),
    creditFen: optionalNumber(mappedValue(row, fields, "creditFen")),
    thresholdFen: optionalNumber(mappedValue(row, fields, "thresholdFen")),
    totalAmount: optionalNumber(mappedValue(row, fields, "totalAmount")),
    unlimitedStock: optionalBoolean(mappedValue(row, fields, "unlimitedStock")),
    leftAmount: optionalNumber(mappedValue(row, fields, "leftAmount")),
    usedAmount: optionalNumber(mappedValue(row, fields, "usedAmount")),
    validPeriodDays: optionalNumber(mappedValue(row, fields, "validPeriodDays")),
    useStartTime: displayTime(mappedValue(row, fields, "useStartTime")) || undefined,
    useEndTime: displayTime(mappedValue(row, fields, "useEndTime")) || undefined
  };
}

function firstArrayValue(root: unknown, paths: string[]) {
  for (const path of paths) {
    const value = firstPathValue(root, [path]);
    if (Array.isArray(value)) return value;
  }
  return null;
}

function firstObjectValue(root: unknown, paths: string[]) {
  for (const path of paths) {
    const value = firstPathValue(root, [path]);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return null;
}

function platformTime(value: unknown) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return String(value || "");
  const date = new Date(timestamp);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const LIMITED_TIME_BODY_FIELDS = [
  "stype", "activity_type", "order_expire_time", "shop_stype", "time_set_type", "sold_out_type", "business_code",
  "limit_stock_type", "need_live", "from_page", "limit_num_type", "user_limit_type", "renew_switch_on", "title",
  "begin_time", "end_time", "pre_begin_time", "promotion_goods"
];

function limitedTimeBodyFromDetail(detail: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  for (const field of LIMITED_TIME_BODY_FIELDS) if (detail[field] !== undefined) body[field] = detail[field];
  body.stype ||= "7";
  body.activity_type ||= "26";
  body.from_page ??= "";
  return body;
}

function updatePromotionDiscount(body: Record<string, unknown>, context: Record<string, unknown>) {
  const fields = objectValue(context.fields);
  const value = Number(fields.discountValue);
  if (!Number.isFinite(value) || value <= 0) return;
  const shopType = String(body.shop_stype || "");
  const goods = Array.isArray(body.promotion_goods) ? body.promotion_goods.map(objectValue) : [];
  body.promotion_goods = goods.map((goodsItem) => ({
    ...goodsItem,
    promotion_skus: (Array.isArray(goodsItem.promotion_skus) ? goodsItem.promotion_skus.map(objectValue) : []).map((sku) => ({
      ...sku,
      ...(shopType === "1" ? { price: String(Math.round(value * 100)) } : { shop_svalue: String(Math.round(value * (shopType === "3" ? 10 : 100))) })
    }))
  }));
}

function prepareLimitedTimeManagementBody(action: string, context: Record<string, unknown>, detail: Record<string, unknown>) {
  const body = limitedTimeBodyFromDetail(detail);
  const fields = objectValue(context.fields);
  if (action === "bulk_edit") {
    if (fields.startTime) body.begin_time = platformTime(fields.startTime);
    if (fields.endTime) body.end_time = platformTime(fields.endTime);
    if (fields.startTime) body.pre_begin_time = platformTime(fields.startTime);
    updatePromotionDiscount(body, context);
  }
  if (action === "remove_products") {
    const removed = new Set(Array.isArray(context.productIds) ? context.productIds.map(String) : []);
    body.promotion_goods = (Array.isArray(body.promotion_goods) ? body.promotion_goods.map(objectValue) : []).filter((goods) => !removed.has(String(goods.product_id || "")));
  }
  if (["copy", "revive", "tool_renew"].includes(action)) {
    const originalStart = Date.parse(String(detail.begin_time || ""));
    const originalEnd = Date.parse(String(detail.end_time || ""));
    const duration = Number.isFinite(originalStart) && Number.isFinite(originalEnd) && originalEnd > originalStart ? originalEnd - originalStart : 24 * 60 * 60 * 1000;
    const requestedStart = action === "tool_renew" ? originalEnd + 1000 : Date.parse(String(context.startTime || ""));
    const requestedEnd = action === "tool_renew" ? requestedStart + duration : Date.parse(String(context.endTime || ""));
    body.begin_time = platformTime(new Date(requestedStart).toISOString());
    body.end_time = platformTime(new Date(requestedEnd).toISOString());
    body.pre_begin_time = body.begin_time;
    const suffix = String(context.operationId || "").replace(/[^a-z0-9]/gi, "").slice(-6) || "copy";
    body.title = `${String(context.name || detail.title || "限时限量购").slice(0, 20)}${suffix}`;
    body.renew_switch_on = false;
  }
  return body;
}

function rejectedProducts(root: unknown) {
  const value = firstPathValue(root, [
    "data.campaign_check_res",
    "data.data.campaign_check_res",
    "data.product_check_infos",
    "data.data.product_check_infos"
  ]);
  if (Array.isArray(value)) {
    return value.map(objectValue).map((item) => ({
      itemType: "product" as const,
      itemId: String(item.product_id || item.productId || ""),
      reasonCode: String(item.reason_code || item.reasonCode || "platform_validation_rejected"),
      message: String(item.msg || item.reject_msg || item.reason || item.message || "平台校验拒绝商品")
    })).filter((item) => item.itemId);
  }
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([itemId, raw]) => {
    const item = objectValue(raw);
    return {
      itemType: "product" as const,
      itemId,
      reasonCode: String(item.reason_code || item.reasonCode || "platform_validation_rejected"),
      message: String(item.msg || item.reject_msg || item.reason || item.message || raw || "平台校验拒绝商品")
    };
  }).filter((item) => item.itemId);
  return [];
}

function rejectedProductIds(root: unknown) {
  return new Set(rejectedProducts(root).map((item) => item.itemId));
}

const LIMITED_TIME_SKU_QUERY_PRODUCT_LIMIT = 50;

export async function prepareLimitedTimeSkuRows(args: {
  doudianAdapter: DoudianAdapterPayload;
  store: MarketingTaskStore;
  planKey: string;
  context: Record<string, unknown>;
  shouldCancel?: () => boolean;
  trackWindow?: (winId: number) => void;
}) {
  const queryBody = objectValue(args.context.limitedTimeSkuQueryBody);
  const products = Array.isArray(queryBody.channel_products) ? queryBody.channel_products.map(objectValue) : [];
  const chunks: Record<string, unknown>[][] = [];
  for (let index = 0; index < products.length; index += LIMITED_TIME_SKU_QUERY_PRODUCT_LIMIT) {
    chunks.push(products.slice(index, index + LIMITED_TIME_SKU_QUERY_PRODUCT_LIMIT));
  }
  if (!chunks.length) return { ok: false, rows: [] as unknown[], error: "limited-time SKU preparation has no products" };
  const rows: unknown[] = [];
  for (const channelProducts of chunks) {
    const prepared = await runDoudianRequestPlan(args.doudianAdapter, {
      partition: args.store.partition,
      planKey: args.planKey,
      context: { ...args.context, limitedTimeSkuQueryBody: { ...queryBody, channel_products: channelProducts } },
      shouldCancel: args.shouldCancel,
      trackWindow: args.trackWindow
    });
    const preparedRows = firstArrayValue(prepared.data, ["data", "data.data", "data.data.data"]);
    if (!requestPlanResponseOk(prepared, args.doudianAdapter.adapter, args.planKey, featureMapping(args.doudianAdapter.adapter, "limited_time")) || !preparedRows) {
      return { ok: false, rows, error: prepared.error || "limited-time SKU preparation failed" };
    }
    rows.push(...preparedRows);
  }
  return { ok: true, rows, error: "" };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function paginationPolicy(adapter: DoudianAdapterConfig, feature: MarketingFeature) {
  const pagination = objectValue(featurePolicy(adapter, feature).pagination);
  return {
    pageSize: Math.max(1, Math.min(1000, Math.floor(Number(pagination.pageSize || 100)))),
    maxPages: Math.max(1, Math.min(200, Math.floor(Number(pagination.maxPages || 1))))
  };
}

export async function runMarketingReadRequest(args: {
  doudianAdapter: DoudianAdapterPayload;
  feature: MarketingFeature;
  action: MarketingReadAction;
  store: MarketingTaskStore;
  context?: Record<string, unknown>;
  shouldCancel?: () => boolean;
  trackWindow?: (winId: number) => void;
  runRequest?: <T>(work: () => Promise<T>) => Promise<T>;
}): Promise<MarketingStoreReadResult> {
  if (args.shouldCancel?.()) return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "cancelled", message: "read cancelled", entities: [], total: 0 };
  const adapter = args.doudianAdapter.adapter;
  const policy = featurePolicy(adapter, args.feature);
  const planKeys = readPlanKeys(objectValue(policy.readActions)[args.action]);
  if (!planKeys.length) throw new Error(`missing marketing read plan: ${args.feature}.${args.action}`);
  const mapping = featureMapping(adapter, args.feature);
  const fields = objectValue(mapping.fields);
  const pagination = paginationPolicy(adapter, args.feature);
  const baseContext: Record<string, unknown> = readContext(args.feature, args.context || {});
  const planResults = await mapWithConcurrency(planKeys, planKeys.length, async (planKey) => {
    const entities: MarketingEntity[] = [];
    let planCount = 0;
    let planTotal = 0;
    let planFailed = false;
    let planError = "";
    const importedProductIds = ["general_coupon", "new_user_bonus"].includes(args.feature) && args.action === "load_products" && Array.isArray(baseContext.importProductIds)
      ? baseContext.importProductIds.map(String).filter(Boolean)
      : [];
    const importChunkCount = importedProductIds.length ? Math.ceil(importedProductIds.length / 100) : 0;
    const requestedMaxPages = baseContext.productLoadMode === "quick" ? Math.min(10, pagination.maxPages) : pagination.maxPages;
    const pageLimit = importChunkCount || requestedMaxPages;
    for (let page = 1; page <= pageLimit; page += 1) {
      if (args.shouldCancel?.()) break;
      const context: Record<string, unknown> = {
        shopId: args.store.shopId,
        ...baseContext,
        page: importChunkCount ? 1 : page,
        pageNo: importChunkCount ? 1 : page,
        pageIndex: importChunkCount ? 0 : page - 1,
        pageSize: pagination.pageSize,
        page_size: pagination.pageSize,
        ...(importChunkCount ? { importProductIds: importedProductIds.slice((page - 1) * 100, page * 100) } : {})
      };
      if (args.feature === "general_coupon" && args.action === "load_products") {
        context.couponProductQueryBody = generalCouponProductQueryBody(context);
      }
      if (args.feature === "new_user_bonus" && args.action === "load_products") {
        context.newUserProductQueryBody = newUserBonusProductQueryBody(context);
      }
      const execute = () => runDoudianRequestPlan(args.doudianAdapter, {
          partition: args.store.partition,
          planKey,
          context,
          shouldCancel: args.shouldCancel,
          trackWindow: args.trackWindow
        });
      const response = args.runRequest ? await args.runRequest(execute) : await execute();
      const ok = requestPlanResponseOk(response, adapter, planKey, mapping);
      const pageRows = firstPathValue(response.data, actionPaths(mapping, args.action));
      let pageItems = Array.isArray(pageRows)
        ? pageRows.map((row) => normalizeEntity(row, fields, args.store))
        : args.action === "detail" && isObjectRecord(pageRows)
          ? [normalizeEntity(pageRows, fields, args.store)]
          : args.action === "detail" && isObjectRecord(response.data)
            ? [normalizeEntity(response.data, fields, args.store)]
            : [];
      if (["general_coupon", "new_user_bonus"].includes(args.feature) && args.action === "load_products" && pageItems.length) {
        const validationPlanKey = String(policy.productValidationPlanKey || "");
        if (validationPlanKey) {
          const productIds = pageItems.map((item) => item.entityId).filter(Boolean);
          const productValidationBody = args.feature === "general_coupon"
            ? generalCouponProductValidationBody(context, productIds)
            : newUserBonusPreflightBody({ ...context, productIds, selectedProducts: pageItems }, 2);
          const validation = await runDoudianRequestPlan(args.doudianAdapter, {
            partition: args.store.partition,
            planKey: validationPlanKey,
            context: { ...context, productValidationBody },
            shouldCancel: args.shouldCancel,
            trackWindow: args.trackWindow
          });
          if (requestPlanResponseOk(validation, adapter, validationPlanKey, mapping)) {
            const rejectedValue = firstPathValue(validation.data, stringPaths(objectValue(mapping.preflight).rejectedItemPaths));
            const rejected = new Map(generalCouponRejectedItems(rejectedValue).map((item) => [item.itemId, item]));
            pageItems = pageItems.map((item) => {
              const failure = rejected.get(item.entityId);
              return failure ? { ...item, eligible: false, platformError: failure.message, failureReason: failure.message } : item;
            });
          } else {
            const message = validation.error || "商品资格二次校验失败";
            pageItems = pageItems.map((item) => ({ ...item, eligible: false, platformError: message, failureReason: message }));
          }
        }
      }
      entities.push(...pageItems);
      planCount += pageItems.length;
      const pageTotal = Number(firstPathValue(response.data, stringPaths(mapping.totalPaths)) ?? 0);
      if (pageTotal > 0) planTotal = pageTotal;
      if (!ok) {
        const platformError = firstPathValue(response.data, stringPaths(objectValue(fields.platformError).paths));
        planError = `${planKey}: ${String(platformError || response.error || "request failed")}`;
        planFailed = true;
        break;
      }
      if (importChunkCount) {
        if (page >= importChunkCount) break;
        continue;
      }
      if (args.action === "detail" || !pageItems.length || pageItems.length < pagination.pageSize || (planTotal > 0 && planCount >= planTotal)) break;
    }
    return { entities, total: planTotal || planCount, ok: !planFailed, error: planError };
  });
  const entities = planResults.flatMap((result) => result.entities);
  const total = planResults.reduce((sum, result) => sum + result.total, 0);
  const successfulPlans = planResults.filter((result) => result.ok).length;
  const planErrors = planResults.map((result) => result.error).filter(Boolean);
  const uniqueEntities = [...new Map(entities.map((entity) => [`${entity.shopId}:${entity.entityId}`, entity])).values()];
  const cancelled = args.shouldCancel?.() === true;
  if (!cancelled && successfulPlans === 0) {
    return {
      shopId: args.store.shopId,
      shopName: args.store.shopName,
      ok: false,
      status: "failed",
      message: planErrors[0] || "all marketing read sources failed",
      entities: uniqueEntities,
      total: total || uniqueEntities.length
    };
  }
  return {
    shopId: args.store.shopId,
    shopName: args.store.shopName,
    ok: !cancelled,
    status: cancelled ? "cancelled" : "ok",
    message: cancelled ? "read cancelled" : `read ${uniqueEntities.length} items${planErrors.length ? `; ${planErrors.length} source(s) unavailable` : ""}`,
    entities: uniqueEntities,
    total: total || uniqueEntities.length
  };
}

export async function runMarketingWriteRequest(args: {
  doudianAdapter: DoudianAdapterPayload;
  feature: MarketingFeature;
  action: string;
  store: MarketingTaskStore;
  context?: Record<string, unknown>;
  shouldCancel?: () => boolean;
  trackWindow?: (winId: number) => void;
  beginMutation?: () => void;
  endMutation?: () => void;
}): Promise<MarketingStoreReadResult> {
  if (args.shouldCancel?.()) return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "cancelled", message: "write cancelled", entities: [], total: 0 };
  const adapter = args.doudianAdapter.adapter;
  const policy = featurePolicy(adapter, args.feature);
  const contract = objectValue(objectValue(policy.writeActions)[args.action]);
  const planKey = String(contract.mutationPlanKey || "");
  if (!planKey) throw new Error(`missing marketing mutation plan: ${args.feature}.${args.action}`);
  let requestContext = { ...(args.context || {}) };
  let acceptedProductCount: number | undefined;
  const itemRejections: NonNullable<MarketingStoreReadResult["itemRejections"]> = Array.isArray(args.context?.preflightItemRejections)
    ? args.context.preflightItemRejections.map(objectValue).map((item) => ({
      itemType: "product" as const,
      itemId: String(item.itemId || ""),
      reasonCode: String(item.reasonCode || "platform_validation_rejected"),
      message: String(item.message || "平台校验拒绝商品")
    })).filter((item) => item.itemId)
    : [];
  if (args.feature === "limited_time" && args.action !== "create" && String(contract.preparePlanKey || "")) {
    const preparePlanKey = String(contract.preparePlanKey);
    const prepared = await runDoudianRequestPlan(args.doudianAdapter, {
      partition: args.store.partition,
      planKey: preparePlanKey,
      context: requestContext,
      shouldCancel: args.shouldCancel,
      trackWindow: args.trackWindow
    });
    const detail = firstObjectValue(prepared.data, ["data.data", "data"]);
    if (!requestPlanResponseOk(prepared, adapter, preparePlanKey, featureMapping(adapter, args.feature)) || !detail) {
      return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: prepared.error || "limited-time activity detail preparation failed", entities: [], total: 0 };
    }
    const writeBody = prepareLimitedTimeManagementBody(args.action, requestContext, detail);
    if (args.action === "remove_products" && (!Array.isArray(writeBody.promotion_goods) || writeBody.promotion_goods.length === 0)) {
      return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: "removing the selected products would leave the activity empty", entities: [], total: 0 };
    }
    requestContext = {
      ...requestContext,
      writeBody,
      ...( ["copy", "revive", "tool_renew"].includes(args.action) ? {
        queryTitle: String(writeBody.title || ""),
        reconciliationFingerprint: { name: writeBody.title, startTime: writeBody.begin_time, endTime: writeBody.end_time }
      } : {})
    };
    const validationPlanKey = String(contract.validationPlanKey || "");
    if (validationPlanKey) {
      const validation = await runDoudianRequestPlan(args.doudianAdapter, {
        partition: args.store.partition,
        planKey: validationPlanKey,
        context: requestContext,
        shouldCancel: args.shouldCancel,
        trackWindow: args.trackWindow
      });
      if (!requestPlanResponseOk(validation, adapter, validationPlanKey, featureMapping(adapter, args.feature)) || rejectedProductIds(validation.data).size) {
        return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: platformFailureMessage(validation.data, validation.error, "limited-time management validation failed"), entities: [], total: 0 };
      }
    }
  }
  if (args.feature === "limited_time" && args.action === "create") {
    const preparePlanKey = String(contract.preparePlanKey || "");
    if (!preparePlanKey) throw new Error("missing limited-time SKU preparation plan");
    const prepared = await prepareLimitedTimeSkuRows({
      doudianAdapter: args.doudianAdapter,
      store: args.store,
      planKey: preparePlanKey,
      context: requestContext,
      shouldCancel: args.shouldCancel,
      trackWindow: args.trackWindow
    });
    if (!prepared.ok) {
      return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: prepared.error, entities: [], total: 0 };
    }
    const built = buildLimitedTimePromotionGoods(requestContext, prepared.rows);
    itemRejections.push(...built.rejected.map((item) => ({ itemType: "product" as const, itemId: item.productId, reasonCode: "local_price_or_sku_rejected", message: item.reason })));
    const promotionGoods = built.promotionGoods;
    if (!promotionGoods.length) {
      return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: built.rejected[0]?.reason || "selected products have no eligible SKU data", entities: [], total: 0, itemRejections };
    }
    if (built.skuCount > LIMITED_TIME_ACTIVITY_SKU_LIMIT) {
      return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: `single activity contains ${built.skuCount} SKUs; maximum is ${LIMITED_TIME_ACTIVITY_SKU_LIMIT}`, entities: [], total: 0 };
    }
    requestContext = {
      ...requestContext,
      writeBody: { ...objectValue(requestContext.writeBody), promotion_goods: promotionGoods }
    };
    const validationPlanKey = String(contract.validationPlanKey || "");
    if (validationPlanKey) {
      let validation = await runDoudianRequestPlan(args.doudianAdapter, {
        partition: args.store.partition,
        planKey: validationPlanKey,
        context: requestContext,
        shouldCancel: args.shouldCancel,
        trackWindow: args.trackWindow
      });
      if (!requestPlanResponseOk(validation, adapter, validationPlanKey, featureMapping(adapter, args.feature))) {
        itemRejections.push(...rejectedProducts(validation.data));
        return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: platformFailureMessage(validation.data, validation.error, "limited-time activity validation failed"), entities: [], total: 0, itemRejections };
      }
      const platformRejections = rejectedProducts(validation.data);
      const rejectedIds = new Set(platformRejections.map((item) => item.itemId));
      if (rejectedIds.size) {
        itemRejections.push(...platformRejections);
        const eligibleGoods = promotionGoods.filter((goods) => !rejectedIds.has(String(goods.product_id || "")));
        if (!eligibleGoods.length) {
          return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: `platform validation rejected ${rejectedIds.size} selected products`, entities: [], total: 0, itemRejections };
        }
        requestContext = { ...requestContext, writeBody: { ...objectValue(requestContext.writeBody), promotion_goods: eligibleGoods } };
        validation = await runDoudianRequestPlan(args.doudianAdapter, {
          partition: args.store.partition,
          planKey: validationPlanKey,
          context: requestContext,
          shouldCancel: args.shouldCancel,
          trackWindow: args.trackWindow
        });
        const remainingRejections = rejectedProducts(validation.data);
        if (!requestPlanResponseOk(validation, adapter, validationPlanKey, featureMapping(adapter, args.feature)) || remainingRejections.length) {
          itemRejections.push(...remainingRejections);
          return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: platformFailureMessage(validation.data, validation.error, "limited-time activity validation failed after removing rejected products"), entities: [], total: 0, itemRejections };
        }
      }
    }
    acceptedProductCount = (Array.isArray(objectValue(requestContext.writeBody).promotion_goods) ? objectValue(requestContext.writeBody).promotion_goods as unknown[] : []).length;
  }
  if (acceptedProductCount === undefined && args.action === "create" && Array.isArray(requestContext.productIds)) {
    acceptedProductCount = requestContext.productIds.map(String).filter(Boolean).length;
  }
  const response = await runDoudianRequestPlan(args.doudianAdapter, {
    partition: args.store.partition,
    planKey,
    context: { shopId: args.store.shopId, ...requestContext },
    shouldCancel: args.shouldCancel,
    trackWindow: args.trackWindow,
    beginMutation: args.beginMutation,
    endMutation: args.endMutation
  });
  const mapping = featureMapping(adapter, args.feature);
  const ok = requestPlanResponseOk(response, adapter, planKey, mapping);
  const rows = firstPathValue(response.data, stringPaths(mapping.mutationResultPaths || mapping.listPaths));
  const fields = objectValue(mapping.fields);
  let entities = Array.isArray(rows)
    ? rows.map((row) => normalizeEntity(row, fields, args.store))
    : isObjectRecord(rows)
      ? [normalizeEntity(rows, fields, args.store)]
      : [];
  if (args.feature === "limited_time" && ["create", "copy", "revive", "tool_renew"].includes(args.action)) {
    const fingerprint = objectValue(requestContext.reconciliationFingerprint);
    entities = entities.map((entity) => ({
      ...entity,
      name: entity.name === "unnamed" ? String(fingerprint.name || "限时限量购") : entity.name,
      startTime: entity.startTime || displayTime(fingerprint.startTime),
      endTime: entity.endTime || displayTime(fingerprint.endTime),
      activityType: entity.activityType || String(requestContext.activityType || "")
    }));
  }
  const platformError = firstPathValue(response.data, stringPaths(objectValue(fields.platformError).paths));
  const failureMessage = platformFailureMessage(response.data, String(platformError || response.error || ""), "platform write failed");
  const unknown = isUnknownWriteResponse(response);
  const cancelled = args.shouldCancel?.() === true;
  const uniqueItemRejections = [...new Map(itemRejections.map((item) => [`${item.itemType}:${item.itemId}`, item])).values()];
  return {
    shopId: args.store.shopId,
    shopName: args.store.shopName,
    ok: ok && !cancelled && !unknown,
    status: cancelled || unknown ? "unknown" : ok ? "accepted" : "failed",
    message: cancelled || unknown ? "write result requires reconciliation" : ok ? `write accepted${uniqueItemRejections.length ? `; ${uniqueItemRejections.length} item(s) excluded` : ""}` : failureMessage,
    entities,
    total: entities.length,
    ...(acceptedProductCount === undefined ? {} : { productCount: acceptedProductCount }),
    itemRejections: uniqueItemRejections
  };
}
