import { firstPathValue, requestPlanResponseOk, runDoudianRequestPlan } from "../requestPlan";
import { isUnknownWriteResponse } from "../requestPlanSafety";
import type { DoudianAdapterConfig, DoudianAdapterPayload, MarketingFeature } from "../../../types";
import type { MarketingEntity, MarketingReadAction, MarketingStoreReadResult, MarketingTaskStore } from "./types";
import { limitedTimePromotionGoods } from "./writeContext";
import { mapWithConcurrency } from "./concurrency";

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
    shopId: store.shopId,
    shopName: store.shopName,
    name: String(mappedValue(row, fields, "name") ?? mappedValue(row, fields, "title") ?? "unnamed"),
    status: String(mappedValue(row, fields, "status") ?? "unknown"),
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
    updatedAt: String(mappedValue(row, fields, "updatedAt") ?? "") || undefined
  };
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
  const baseContext = readContext(args.feature, args.context || {});
  const planResults = await mapWithConcurrency(planKeys, planKeys.length, async (planKey) => {
    const entities: MarketingEntity[] = [];
    let planCount = 0;
    let planTotal = 0;
    let planFailed = false;
    let planError = "";
    for (let page = 1; page <= pagination.maxPages; page += 1) {
      if (args.shouldCancel?.()) break;
      const context = {
        shopId: args.store.shopId,
        ...baseContext,
        page,
        pageNo: page,
        pageIndex: page - 1,
        pageSize: pagination.pageSize,
        page_size: pagination.pageSize
      };
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
      const pageItems = Array.isArray(pageRows)
        ? pageRows.map((row) => normalizeEntity(row, fields, args.store))
        : args.action === "detail" && isObjectRecord(pageRows)
          ? [normalizeEntity(pageRows, fields, args.store)]
          : args.action === "detail" && isObjectRecord(response.data)
            ? [normalizeEntity(response.data, fields, args.store)]
            : [];
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
  if (args.feature === "limited_time" && args.action === "create") {
    const preparePlanKey = String(contract.preparePlanKey || "");
    if (!preparePlanKey) throw new Error("missing limited-time SKU preparation plan");
    const prepared = await runDoudianRequestPlan(args.doudianAdapter, {
      partition: args.store.partition,
      planKey: preparePlanKey,
      context: requestContext,
      shouldCancel: args.shouldCancel,
      trackWindow: args.trackWindow
    });
    const preparedOk = requestPlanResponseOk(prepared, adapter, preparePlanKey, featureMapping(adapter, args.feature));
    const preparedRows = firstPathValue(prepared.data, ["data", "data.data"]);
    if (!preparedOk || !Array.isArray(preparedRows)) {
      return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: prepared.error || "limited-time SKU preparation failed", entities: [], total: 0 };
    }
    const promotionGoods = limitedTimePromotionGoods(requestContext, preparedRows);
    if (!promotionGoods.length) {
      return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: "selected products have no eligible SKU data", entities: [], total: 0 };
    }
    requestContext = {
      ...requestContext,
      writeBody: { ...objectValue(requestContext.writeBody), promotion_goods: promotionGoods }
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
      if (!requestPlanResponseOk(validation, adapter, validationPlanKey, featureMapping(adapter, args.feature))) {
        return { shopId: args.store.shopId, shopName: args.store.shopName, ok: false, status: "failed", message: validation.error || String(firstPathValue(validation.data, ["msg", "message"]) || "limited-time activity validation failed"), entities: [], total: 0 };
      }
    }
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
  const entities = Array.isArray(rows)
    ? rows.map((row) => normalizeEntity(row, fields, args.store))
    : isObjectRecord(rows)
      ? [normalizeEntity(rows, fields, args.store)]
      : [];
  const platformError = firstPathValue(response.data, stringPaths(objectValue(fields.platformError).paths));
  const unknown = isUnknownWriteResponse(response);
  const cancelled = args.shouldCancel?.() === true;
  return {
    shopId: args.store.shopId,
    shopName: args.store.shopName,
    ok: ok && !cancelled && !unknown,
    status: cancelled || unknown ? "unknown" : ok ? "accepted" : "failed",
    message: cancelled || unknown ? "write result requires reconciliation" : ok ? "write accepted" : String(platformError || response.error || "platform write failed"),
    entities,
    total: entities.length
  };
}
