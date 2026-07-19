import { marketingPageEnabled, marketingWriteEnabled } from "./gates";
import { prepareLimitedTimeSkuRows, runMarketingReadRequest, runMarketingWriteRequest } from "./request";
import { saveMarketingAttempts, saveMarketingFailureShards, saveMarketingRun } from "./repository";
import { assertMutationStoreActive } from "../mutationSafety";
import { assertMarketingTaskInput, marketingTaskInputErrors } from "./validation";
import { runMarketingPreflight } from "./preflight";
import { marketingAdapterSnapshotHash } from "./snapshot";
import { createConcurrencyLimiter, mapWithConcurrency } from "./concurrency";
import { marketingWriteContext } from "./writeContext";
import { aggregateLimitedTimeCreate, LIMITED_TIME_ACTIVITY_SKU_LIMIT, splitLimitedTimeCreateBatches } from "./limitedTime";
import { splitGeneralCouponCreateBatches } from "./generalCoupon.ts";
import { splitNewUserBonusCreateBatches } from "./newUserBonus.ts";
import { marketingStoreContext } from "./storeContext";
import type { MarketingItemFailure, MarketingReadAction, MarketingStoreAttempt, MarketingTaskPayload, MarketingTaskResult, MarketingTaskStore, MarketingRun, MarketingStoreReadResult } from "./types";

const READ_ACTIONS = new Set<MarketingReadAction>(["load_products", "list", "detail"]);

interface MarketingExecutionUnit {
  store: MarketingTaskStore;
  storeIndex: number;
  batchIndex: number;
  batchCount: number;
  productCount: number;
  context: Record<string, unknown>;
  attemptId: string;
}

interface MarketingUnitOutcome {
  unit: MarketingExecutionUnit;
  result: MarketingStoreReadResult;
  failures: MarketingItemFailure[];
}

function timestamp() {
  return new Date().toISOString();
}

function hash(value: unknown) {
  let text = "";
  try { text = JSON.stringify(value); } catch { text = String(value); }
  let result = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    result ^= text.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function aggregateStoreUnits(store: MarketingTaskStore, outcomes: MarketingUnitOutcome[]): MarketingStoreReadResult {
  if (outcomes.length === 1) return outcomes[0].result;
  const succeeded = outcomes.filter((outcome) => outcome.result.ok).length;
  const failed = outcomes.filter((outcome) => outcome.result.status === "failed").length;
  const unknown = outcomes.filter((outcome) => ["unknown", "reconciling"].includes(outcome.result.status)).length;
  const cancelled = outcomes.filter((outcome) => outcome.result.status === "cancelled").length;
  const status: MarketingStoreReadResult["status"] = unknown ? "reconciling" : failed && succeeded ? "partial" : failed ? "failed" : cancelled && succeeded ? "partial" : cancelled ? "cancelled" : "accepted";
  return {
    shopId: store.shopId,
    shopName: store.shopName,
    ok: succeeded === outcomes.length,
    status,
    message: `${succeeded}/${outcomes.length} 个批次处理成功${failed ? `，${failed} 个失败` : ""}${unknown ? `，${unknown} 个待对账` : ""}`,
    entities: outcomes.flatMap((outcome) => outcome.result.entities),
    total: outcomes.reduce((sum, outcome) => sum + outcome.result.total, 0),
    itemRejections: outcomes.flatMap((outcome) => outcome.result.itemRejections || [])
  };
}

function aggregateGeneralCouponCreate(store: MarketingTaskStore, outcomes: MarketingUnitOutcome[]): MarketingStoreReadResult {
  const base = aggregateStoreUnits(store, outcomes);
  const created = outcomes.filter((outcome) => outcome.result.ok).length;
  const unknown = outcomes.filter((outcome) => ["unknown", "reconciling"].includes(outcome.result.status)).length;
  const failed = outcomes.length - created - unknown;
  return {
    ...base,
    activityCount: outcomes.length,
    createdActivityCount: created,
    failedActivityCount: failed,
    unknownActivityCount: unknown,
    productCount: outcomes.reduce((sum, outcome) => sum + outcome.unit.productCount, 0)
  };
}

function statusForRun(args: { cancelled: boolean; unknown: number; failures: number; successes: number }) {
  if (args.unknown > 0) return "reconciling" as const;
  if (args.cancelled && !args.successes) return "cancelled" as const;
  if (!args.failures && !args.cancelled) return "succeeded" as const;
  return args.successes ? "partial" as const : "failed" as const;
}

function failureForStore(
  operationId: string,
  store: MarketingTaskStore,
  action: string,
  message: string,
  storeIndex: number,
  batchIndex = 1,
  batchCount = 1,
  stage?: MarketingItemFailure["stage"],
  reasonCode?: string
): MarketingItemFailure {
  return {
    id: `${operationId}:${store.shopId}:${storeIndex}:${batchIndex}`,
    operationId,
    shopId: store.shopId,
    itemType: "activity",
    itemId: batchCount > 1 ? `${store.shopId}:${action}:batch-${batchIndex}-of-${batchCount}` : `${store.shopId}:${action}`,
    stage: stage || (READ_ACTIONS.has(action as MarketingReadAction) ? "precheck" : action === "create" ? "create" : "manage"),
    reasonCode: reasonCode || (READ_ACTIONS.has(action as MarketingReadAction) ? "read_failed" : "write_failed"),
    message: message.slice(0, 500)
  };
}

function attemptId(operationId: string, store: MarketingTaskStore, batchIndex: number, batchCount: number) {
  return batchCount > 1
    ? `marketing:attempt:${operationId}:${store.shopId}:batch-${String(batchIndex).padStart(5, "0")}`
    : `marketing:attempt:${operationId}:${store.shopId}`;
}

function batchMessagePrefix(unit: MarketingExecutionUnit) {
  return unit.batchCount > 1 ? `第 ${unit.batchIndex}/${unit.batchCount} 批（${unit.productCount} 个商品）` : "";
}

function taskResultMessage(stores: MarketingStoreReadResult[], successCount: number) {
  const partialCount = stores.filter((store) => store.status === "partial").length;
  const reconcilingCount = stores.filter((store) => ["unknown", "reconciling"].includes(store.status)).length;
  const failedCount = stores.filter((store) => store.status === "failed").length;
  const cancelledCount = stores.filter((store) => store.status === "cancelled").length;
  const summaryParts = [`${successCount} 个店铺成功`];
  if (partialCount) summaryParts.push(`${partialCount} 个部分成功`);
  if (reconcilingCount) summaryParts.push(`${reconcilingCount} 个待对账`);
  if (failedCount) summaryParts.push(`${failedCount} 个失败`);
  if (cancelledCount) summaryParts.push(`${cancelledCount} 个已取消`);
  const summary = summaryParts.join("，");
  const noteworthy = stores.find((store) => !store.ok) || stores.find((store) => (store.activityCount || 0) > 1);
  return noteworthy ? `${summary}；${noteworthy.shopName || noteworthy.shopId}：${noteworthy.message}` : summary;
}

export async function runMarketingTask(args: MarketingTaskPayload & {
  operationId?: string;
  isCancelled?: () => boolean;
  trackWindow?: (winId: number) => void;
  beginMutation?: () => void;
  endMutation?: () => void;
}): Promise<MarketingTaskResult> {
  assertMarketingTaskInput(args);
  const adapter = args.doudianAdapter.adapter;
  if (!marketingPageEnabled(args.config, adapter, args.feature)) throw new Error("marketing feature is disabled or contract validation failed");
  const isRead = READ_ACTIONS.has(args.action as MarketingReadAction);
  if (!isRead && !marketingWriteEnabled(args.config, adapter, args.feature, args.action)) throw new Error("marketing write is disabled or contract is incomplete");
  if (!args.operationId) throw new Error("marketing operationId is required");
  if (!isRead) {
    for (const store of args.stores) {
      await assertMutationStoreActive({ ...store, platform: "doudian", status: "unknown" });
    }
  }

  const operationId = args.operationId;
  const createdAt = timestamp();
  const baseContext = { ...(args.context || {}) };
  const contextHash = hash(baseContext);
  const featurePolicy = recordValue(recordValue(recordValue(adapter.policies).marketing).features)[args.feature];
  const writeContract = recordValue(recordValue(featurePolicy).writeActions)[args.action];
  const reconcilePlanKey = !isRead ? String(recordValue(writeContract).reconcilePlanKey || "") : "";
  const reconciliationPolicy = recordValue(recordValue(featurePolicy).reconciliation);
  const mutationSettleDeadlineMs = Math.max(30_000, Math.min(300_000, Number(reconciliationPolicy.mutationSettleDeadlineMs || 30_000)));
  const reconciliationRetryDelayMs = Math.max(5_000, Math.min(300_000, Number(reconciliationPolicy.retryDelayMs || 30_000)));
  const isLimitedTimeCreate = args.feature === "limited_time" && args.action === "create";
  const isGeneralCouponCreate = args.feature === "general_coupon" && args.action === "create";
  const isNewUserBonusCreate = args.feature === "new_user_bonus" && args.action === "create";
  const isManagementWrite = !isRead && args.action !== "create";
  const plannedStoreContexts = new Map<string, Record<string, unknown>>();
  const planningErrors = new Map<string, string>();
  if (isLimitedTimeCreate) {
    const preparePlanKey = String(recordValue(writeContract).preparePlanKey || "");
    if (!preparePlanKey) throw new Error("missing limited-time SKU planning contract");
    const configuredPlanningConcurrency = Number(recordValue(recordValue(featurePolicy).concurrency).read || 2);
    const planningConcurrency = Number.isFinite(configuredPlanningConcurrency) ? Math.max(1, Math.min(4, Math.floor(configuredPlanningConcurrency))) : 2;
    await mapWithConcurrency(args.stores, planningConcurrency, async (store) => {
      const storeContext = marketingStoreContext(baseContext, store, operationId, args.action);
      try {
        const writeContext = marketingWriteContext(args.feature, args.action, storeContext);
        const identity = await runMarketingPreflight({
          doudianAdapter: args.doudianAdapter,
          feature: args.feature,
          action: args.action,
          store,
          context: writeContext,
          shouldCancel: args.isCancelled,
          trackWindow: args.trackWindow
        });
        if (identity.status !== "ready") throw new Error(identity.message);
        const prepared = await prepareLimitedTimeSkuRows({
          doudianAdapter: args.doudianAdapter,
          store,
          planKey: preparePlanKey,
          context: writeContext,
          shouldCancel: args.isCancelled,
          trackWindow: args.trackWindow
        });
        if (!prepared.ok) throw new Error(prepared.error);
        const skuCounts = new Map(prepared.rows.map((row) => {
          const value = recordValue(row);
          const skuList = Array.isArray(value.sku_list) ? value.sku_list : [];
          return [String(value.product_id || value.productId || ""), skuList.length] as const;
        }));
        const oversizedProduct = [...skuCounts].find(([, skuCount]) => skuCount > LIMITED_TIME_ACTIVITY_SKU_LIMIT);
        if (oversizedProduct) throw new Error(`商品 ${oversizedProduct[0]} 含 ${oversizedProduct[1]} 个 SKU，超过单活动 ${LIMITED_TIME_ACTIVITY_SKU_LIMIT} 个 SKU 上限`);
        const requestedProductIds = Array.isArray(storeContext.productIds) ? storeContext.productIds.map(String).filter(Boolean) : [];
        const missingSkuProduct = requestedProductIds.find((id) => !skuCounts.has(id) || Number(skuCounts.get(id)) < 1);
        if (missingSkuProduct) throw new Error(`商品 ${missingSkuProduct} 未返回可用 SKU 数据`);
        const products = Array.isArray(storeContext.selectedProducts)
          ? storeContext.selectedProducts
          : Array.isArray(storeContext.productIds)
            ? storeContext.productIds.map((entityId) => ({ entityId }))
            : [];
        const selectedProducts = products.map((product) => {
          const value = recordValue(product);
          const id = String(value.entityId || value.productId || "");
          return { ...value, skuCount: skuCounts.get(id) || 1 };
        });
        plannedStoreContexts.set(store.shopId, { ...storeContext, selectedProducts });
      } catch (error) {
        planningErrors.set(store.shopId, error instanceof Error ? error.message : String(error));
      }
    });
  }
  const executions = args.stores.map((store, storeIndex) => {
    const storeContext = plannedStoreContexts.get(store.shopId) || marketingStoreContext(baseContext, store, operationId, args.action);
    const storeValidationErrors = marketingTaskInputErrors({ feature: args.feature, action: args.action, stores: [store], context: storeContext });
    const planningError = planningErrors.get(store.shopId) || (storeValidationErrors.length ? storeValidationErrors.join("; ") : "");
    const batches = planningError
      ? [{ batchIndex: 1, batchCount: 1, productCount: Array.isArray(storeContext.productIds) ? storeContext.productIds.length : 0, context: { ...storeContext, planningError } }]
      : isLimitedTimeCreate
      ? splitLimitedTimeCreateBatches(storeContext)
      : isGeneralCouponCreate
        ? splitGeneralCouponCreateBatches(storeContext)
      : isNewUserBonusCreate
        ? splitNewUserBonusCreateBatches(storeContext)
      : isManagementWrite && Array.isArray(storeContext.entityIds)
        ? storeContext.entityIds.map((entityId, index, all) => {
          const selectedEntities = Array.isArray(storeContext.selectedEntities) ? storeContext.selectedEntities.map(recordValue) : [];
          const selectedEntity = selectedEntities.find((entity) => String(entity.entityId || "") === String(entityId));
          return { batchIndex: index + 1, batchCount: all.length, productCount: 0, context: { ...storeContext, entityId: String(entityId), entityIds: [String(entityId)], ...(selectedEntity ? { selectedEntity } : {}) } };
        })
      : [{ batchIndex: 1, batchCount: 1, productCount: Array.isArray(storeContext.productIds) ? storeContext.productIds.length : 0, context: storeContext }];
    return {
      store,
      units: batches.map((batch) => ({
        store,
        storeIndex,
        batchIndex: batch.batchIndex,
        batchCount: batch.batchCount,
        productCount: batch.productCount,
        context: isRead ? batch.context : marketingWriteContext(args.feature, args.action, batch.context),
        attemptId: attemptId(operationId, store, batch.batchIndex, batch.batchCount)
      }))
    };
  });

  const run: MarketingRun = {
    id: `marketing:run:${operationId}`,
    operationId,
    feature: args.feature,
    action: args.action,
    status: "running",
    selectedShopIds: args.stores.map((store) => store.shopId),
    configHash: hash(args.config),
    configSummary: {
      version: args.config.version,
      feature: args.feature,
      action: args.action,
      ...(isLimitedTimeCreate || isGeneralCouponCreate || isNewUserBonusCreate ? { activityCount: executions.reduce((sum, execution) => sum + execution.units.length, 0) } : {})
    },
    adapterVersion: adapter.version || "",
    adapterSnapshotHash: marketingAdapterSnapshotHash(args.doudianAdapter),
    ruleVersion: args.doudianAdapter.scripts?.version || "",
    createdAt,
    updatedAt: createdAt
  };
  await saveMarketingRun(run);

  const attemptById = new Map<string, MarketingStoreAttempt>();
  const initialAttempts = executions.flatMap(({ units }) => units.map((unit) => {
    const attempt: MarketingStoreAttempt = {
      id: unit.attemptId,
      operationId,
      shopId: unit.store.shopId,
      action: args.action,
      status: "prepared",
      requestHash: hash({ feature: args.feature, action: args.action, shopId: unit.store.shopId, context: unit.context }),
      mutationKey: isRead ? `read:${args.feature}:${args.action}` : `${args.feature}:${args.action}:${unit.store.shopId}:${contextHash}:${hash(unit.context)}`,
      reconcilePlanKey: reconcilePlanKey || undefined,
      partition: unit.store.partition,
      requestContext: unit.context,
      feature: args.feature,
      platformEntityIds: [],
      successCount: 0,
      failureCount: 0,
      message: batchMessagePrefix(unit) ? `${batchMessagePrefix(unit)}已准备` : "prepared",
      createdAt,
      updatedAt: createdAt
    };
    attemptById.set(unit.attemptId, attempt);
    return attempt;
  }));
  await saveMarketingAttempts(initialAttempts);

  const concurrencyPolicy = recordValue(recordValue(featurePolicy).concurrency);
  const configuredConcurrency = Number(concurrencyPolicy[isRead ? "read" : "write"] || 1);
  const taskConcurrency = Number.isFinite(configuredConcurrency) ? Math.max(1, Math.floor(configuredConcurrency)) : 1;
  const runReadRequest = isRead ? createConcurrencyLimiter(taskConcurrency) : undefined;

  const executeUnit = async (unit: MarketingExecutionUnit): Promise<MarketingUnitOutcome> => {
    const attempt = attemptById.get(unit.attemptId)!;
    if (args.isCancelled?.()) {
      const result: MarketingStoreReadResult = { shopId: unit.store.shopId, shopName: unit.store.shopName, ok: false, status: "cancelled", message: "request cancelled before send", entities: [], total: 0 };
      attempt.status = "cancelled";
      attempt.message = batchMessagePrefix(unit) ? `${batchMessagePrefix(unit)}发送前已取消` : result.message;
      await saveMarketingAttempts([attempt]);
      return { unit, result, failures: [] };
    }
    if (unit.context.planningError) {
      const message = `请求准备失败，未发送平台请求：${String(unit.context.planningError)}`;
      const result: MarketingStoreReadResult = { shopId: unit.store.shopId, shopName: unit.store.shopName, ok: false, status: "failed", message, entities: [], total: 0 };
      attempt.status = "rejected";
      attempt.failureCount = 1;
      attempt.message = message;
      await saveMarketingAttempts([attempt]);
      return { unit, result, failures: [failureForStore(operationId, unit.store, args.action, message, unit.storeIndex, unit.batchIndex, unit.batchCount, "precheck", "request_planning_failed")] };
    }
    let executionContext = unit.context;
    if (!isRead) {
      let preflight;
      try {
        preflight = await runMarketingPreflight({ doudianAdapter: args.doudianAdapter, feature: args.feature, action: args.action, store: unit.store, context: unit.context, shouldCancel: args.isCancelled, trackWindow: args.trackWindow });
      } catch (error) {
        preflight = { status: "blocked" as const, message: error instanceof Error ? error.message : String(error), evidence: {} };
      }
      attempt.reconciliationEvidence = { ...(attempt.reconciliationEvidence || {}), preflight: preflight.evidence };
      if (preflight.status !== "ready") {
        const skipped = preflight.status === "skip";
        const result: MarketingStoreReadResult = { shopId: unit.store.shopId, shopName: unit.store.shopName, ok: skipped, status: skipped ? "accepted" : "failed", message: preflight.message, entities: [], total: 0 };
        attempt.status = skipped ? "confirmed" : "rejected";
        attempt.successCount = skipped ? 1 : 0;
        attempt.failureCount = skipped ? 0 : 1;
        attempt.message = `${batchMessagePrefix(unit)}${batchMessagePrefix(unit) ? "：" : ""}${preflight.message}`;
        await saveMarketingAttempts([attempt]);
        return {
          unit,
          result,
          failures: skipped ? [] : [failureForStore(operationId, unit.store, args.action, preflight.message, unit.storeIndex, unit.batchIndex, unit.batchCount, "precheck", "precheck_rejected")]
        };
      }
      if (isGeneralCouponCreate || isNewUserBonusCreate) {
        const rejected = Array.isArray(preflight.evidence.rejectedItems) ? preflight.evidence.rejectedItems.map((item) => recordValue(item)) : [];
        if (rejected.length) {
          const rejectedIds = new Set(rejected.map((item) => String(item.itemId || "")).filter(Boolean));
          const remainingIds = (Array.isArray(executionContext.productIds) ? executionContext.productIds.map(String) : []).filter((id) => !rejectedIds.has(id));
          if (!remainingIds.length) {
            const message = `平台校验拒绝本批全部 ${rejected.length} 个商品，未发送创建请求`;
            const result: MarketingStoreReadResult = {
              shopId: unit.store.shopId,
              shopName: unit.store.shopName,
              ok: false,
              status: "failed",
              message,
              entities: [],
              total: 0,
              itemRejections: rejected.map((item) => ({ itemType: "product", itemId: String(item.itemId || ""), reasonCode: String(item.reasonCode || "platform_validation_rejected"), message: String(item.message || "平台校验拒绝商品") }))
            };
            attempt.status = "rejected";
            attempt.failureCount = rejected.length;
            attempt.message = message;
            await saveMarketingAttempts([attempt]);
            return {
              unit,
              result,
              failures: result.itemRejections!.map((item, index) => ({ id: `${operationId}:${unit.store.shopId}:${unit.batchIndex}:item-${index + 1}`, operationId, shopId: unit.store.shopId, itemType: item.itemType, itemId: item.itemId, stage: "precheck", reasonCode: item.reasonCode, message: item.message.slice(0, 500) }))
            };
          }
          const selectedProducts = Array.isArray(executionContext.selectedProducts) ? executionContext.selectedProducts.map(recordValue).filter((product) => remainingIds.includes(String(product.entityId || product.productId || ""))) : [];
          executionContext = marketingWriteContext(args.feature, args.action, { ...executionContext, productIds: remainingIds, selectedProducts, preflightItemRejections: rejected });
          attempt.requestContext = executionContext;
        }
      }
    }

    attempt.status = "sending";
    attempt.sentAt = timestamp();
    attempt.reconcileAfter = isRead ? undefined : new Date(Date.now() + mutationSettleDeadlineMs).toISOString();
    attempt.message = batchMessagePrefix(unit) ? `${batchMessagePrefix(unit)}请求已开始` : "request started";
    await saveMarketingAttempts([attempt]);
    let result: MarketingStoreReadResult;
    try {
      result = isRead
        ? await runMarketingReadRequest({ doudianAdapter: args.doudianAdapter, feature: args.feature, action: args.action as MarketingReadAction, store: unit.store, context: executionContext, shouldCancel: args.isCancelled, trackWindow: args.trackWindow, runRequest: runReadRequest })
        : await runMarketingWriteRequest({ doudianAdapter: args.doudianAdapter, feature: args.feature, action: args.action, store: unit.store, context: executionContext, shouldCancel: args.isCancelled, trackWindow: args.trackWindow, beginMutation: args.beginMutation, endMutation: args.endMutation });
    } catch (error) {
      result = { shopId: unit.store.shopId, shopName: unit.store.shopName, ok: false, status: isRead ? "failed" : "unknown", message: error instanceof Error ? error.message : String(error), entities: [], total: 0 };
    }
    const unknown = result.status === "unknown" || result.status === "reconciling";
    attempt.status = unknown ? "reconciling" : result.status === "cancelled" ? "cancelled" : result.ok ? (isRead ? "confirmed" : "accepted") : "failed";
    attempt.platformEntityIds = result.entities.map((entity) => entity.entityId).filter(Boolean);
    attempt.successCount = result.ok ? result.entities.length || 1 : 0;
    attempt.failureCount = result.itemRejections?.length || (result.ok ? 0 : 1);
    attempt.message = `${batchMessagePrefix(unit)}${batchMessagePrefix(unit) ? "：" : ""}${result.message}`;
    attempt.reconcileAfter = unknown ? new Date(Date.now() + reconciliationRetryDelayMs).toISOString() : undefined;
    await saveMarketingAttempts([attempt]);
    const itemFailures: MarketingItemFailure[] = (result.itemRejections || []).map((item, index) => ({
      id: `${operationId}:${unit.store.shopId}:${unit.batchIndex}:item-${index + 1}`,
      operationId,
      shopId: unit.store.shopId,
      itemType: item.itemType,
      itemId: item.itemId,
      stage: args.action === "create" ? "create" : "manage",
      reasonCode: item.reasonCode,
      message: item.message.slice(0, 500)
    }));
    const storeFailure = !result.ok && result.status !== "cancelled"
      ? failureForStore(operationId, unit.store, args.action, result.message, unit.storeIndex, unit.batchIndex, unit.batchCount)
      : null;
    return {
      unit,
      result,
      failures: [...itemFailures, ...(storeFailure ? [storeFailure] : [])]
    };
  };

  const outcomes = await mapWithConcurrency(executions, taskConcurrency, async ({ store, units }) => {
    const unitOutcomes: MarketingUnitOutcome[] = [];
    for (let index = 0; index < units.length; index += 1) {
      const outcome = await executeUnit(units[index]);
      unitOutcomes.push(outcome);
      if (!["unknown", "reconciling", "cancelled"].includes(outcome.result.status)) continue;

      const blockedByUnknown = ["unknown", "reconciling"].includes(outcome.result.status);
      for (const remaining of units.slice(index + 1)) {
        const attempt = attemptById.get(remaining.attemptId)!;
        const message = blockedByUnknown ? "前一批写入结果未知，为防止重复创建，本批未发送" : "任务已取消，本批未发送";
        attempt.status = "cancelled";
        attempt.failureCount = blockedByUnknown ? 1 : 0;
        attempt.message = `${batchMessagePrefix(remaining)}：${message}`;
        await saveMarketingAttempts([attempt]);
        const result: MarketingStoreReadResult = { shopId: store.shopId, shopName: store.shopName, ok: false, status: "cancelled", message, entities: [], total: 0 };
        unitOutcomes.push({
          unit: remaining,
          result,
          failures: blockedByUnknown
            ? [failureForStore(operationId, store, args.action, message, remaining.storeIndex, remaining.batchIndex, remaining.batchCount, "create", "not_sent_after_unknown")]
            : []
        });
      }
      break;
    }
    return {
      result: isLimitedTimeCreate ? aggregateLimitedTimeCreate(store, unitOutcomes) : isGeneralCouponCreate ? aggregateGeneralCouponCreate(store, unitOutcomes) : aggregateStoreUnits(store, unitOutcomes),
      failures: unitOutcomes.flatMap((outcome) => outcome.failures)
    };
  });

  const stores = outcomes.flatMap((outcome) => outcome.result ? [outcome.result] : []);
  const failures: MarketingItemFailure[] = outcomes.flatMap((outcome) => outcome.failures);
  const successCount = stores.filter((store) => store.ok).length;
  const partialCount = stores.filter((store) => store.status === "partial").length;
  const failureCount = stores.filter((store) => !store.ok && store.status !== "cancelled").length;
  const unknownCount = stores.filter((store) => store.status === "unknown" || store.status === "reconciling").length;
  const cancelled = args.isCancelled?.() === true || stores.some((store) => store.status === "cancelled");
  const status = statusForRun({ cancelled, unknown: unknownCount, failures: failureCount, successes: successCount + partialCount });
  const message = taskResultMessage(stores, successCount);
  const activityCount = stores.reduce((sum, store) => sum + Number(store.activityCount || 0), 0);
  const createdActivityCount = stores.reduce((sum, store) => sum + Number(store.createdActivityCount || 0), 0);
  const failedActivityCount = stores.reduce((sum, store) => sum + Number(store.failedActivityCount || 0), 0);
  const unknownActivityCount = stores.reduce((sum, store) => sum + Number(store.unknownActivityCount || 0), 0);
  const productCount = stores.reduce((sum, store) => sum + Number(store.productCount || 0), 0);
  const activityMetrics = isLimitedTimeCreate || isGeneralCouponCreate ? { activityCount, createdActivityCount, failedActivityCount, unknownActivityCount, productCount } : {};
  const failureShard = failures.length ? await saveMarketingFailureShards(operationId, failures) : null;
  await saveMarketingRun({
    ...run,
    status,
    failureShardIds: failureShard?.shardIds,
    failureCount: failures.length,
    successCount,
    message,
    ...activityMetrics,
    updatedAt: timestamp()
  });
  return {
    ok: status === "succeeded",
    status: status === "reconciling" ? "reconciling" : status === "succeeded" ? "ok" : status === "cancelled" ? "cancelled" : status,
    feature: args.feature,
    action: args.action,
    message,
    stores,
    entities: stores.flatMap((store) => store.entities),
    successCount,
    failureCount,
    ...activityMetrics,
    operationId
  };
}
