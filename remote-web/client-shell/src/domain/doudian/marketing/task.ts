import { marketingPageEnabled, marketingWriteEnabled } from "./gates";
import { runMarketingReadRequest, runMarketingWriteRequest } from "./request";
import { saveMarketingAttempts, saveMarketingFailureShards, saveMarketingRun } from "./repository";
import { assertMutationStoreActive } from "../mutationSafety";
import { assertMarketingTaskInput } from "./validation";
import { runMarketingPreflight } from "./preflight";
import { marketingAdapterSnapshotHash } from "./snapshot";
import { createConcurrencyLimiter, mapWithConcurrency } from "./concurrency";
import { marketingWriteContext } from "./writeContext";
import type { MarketingItemFailure, MarketingReadAction, MarketingStoreAttempt, MarketingTaskPayload, MarketingTaskResult, MarketingTaskStore, MarketingRun } from "./types";

const READ_ACTIONS = new Set<MarketingReadAction>(["load_products", "list", "detail"]);

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

function contextForStore(context: Record<string, unknown>, store: MarketingTaskStore, operationId: string) {
  const byShop = recordValue(context.productIdsByShop);
  const overrides = recordValue(context.storeOverrides);
  const override = recordValue(overrides[store.shopId]);
  const selected = byShop[store.shopId];
  const productIds = Array.isArray(selected) ? selected.map(String).filter(Boolean) : undefined;
  const entityByShop = recordValue(context.entityIdsByShop);
  const selectedEntities = entityByShop[store.shopId];
  const entityIds = Array.isArray(selectedEntities) ? selectedEntities.map(String).filter(Boolean) : undefined;
  const productsByShop = recordValue(context.selectedProductsByShop);
  const selectedProducts = Array.isArray(productsByShop[store.shopId]) ? productsByShop[store.shopId] : undefined;
  return {
    ...context,
    ...override,
    ...(productIds ? { productIds } : {}),
    ...(entityIds ? { entityIds } : {}),
    ...(selectedProducts ? { selectedProducts } : {}),
    shopId: store.shopId,
    operationId
  };
}

function statusForRun(args: { cancelled: boolean; unknown: number; failures: number; successes: number }) {
  if (args.unknown > 0) return "reconciling" as const;
  if (args.cancelled) return "cancelled" as const;
  if (!args.failures) return "succeeded" as const;
  return args.successes ? "partial" as const : "failed" as const;
}

function failureForStore(operationId: string, store: MarketingTaskStore, action: string, message: string, index: number, stage?: MarketingItemFailure["stage"]): MarketingItemFailure {
  return {
    id: `${operationId}:${store.shopId}:${index}`,
    operationId,
    shopId: store.shopId,
    itemType: "activity",
    itemId: `${store.shopId}:${action}`,
    stage: stage || (action === "create" ? "create" : "precheck"),
    reasonCode: action === "create" ? "write_failed" : "read_failed",
    message: message.slice(0, 500)
  };
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
  const run: MarketingRun = {
    id: `marketing:run:${operationId}`,
    operationId,
    feature: args.feature,
    action: args.action,
    status: "running",
    selectedShopIds: args.stores.map((store) => store.shopId),
    configHash: hash(args.config),
    configSummary: { version: args.config.version, feature: args.feature, action: args.action },
    adapterVersion: adapter.version || "",
    adapterSnapshotHash: marketingAdapterSnapshotHash(args.doudianAdapter),
    ruleVersion: args.doudianAdapter.scripts?.version || "",
    createdAt,
    updatedAt: createdAt
  };
  await saveMarketingRun(run);

  const attemptByShop = new Map<string, MarketingStoreAttempt>();
  const baseContext = { ...(args.context || {}) };
  const context = baseContext;
  const taskContextForStore = (store: MarketingTaskStore) => {
    const storeContext = contextForStore(baseContext, store, operationId);
    return isRead ? storeContext : marketingWriteContext(args.feature, args.action, storeContext);
  };
  const contextHash = hash(context);
  const featurePolicy = recordValue(recordValue(recordValue(adapter.policies).marketing).features)[args.feature];
  const writeContract = recordValue(recordValue(featurePolicy).writeActions)[args.action];
  const reconcilePlanKey = !isRead ? String(recordValue(writeContract).reconcilePlanKey || "") : "";
  const reconciliationPolicy = recordValue(recordValue(featurePolicy).reconciliation);
  const mutationSettleDeadlineMs = Math.max(30_000, Math.min(300_000, Number(reconciliationPolicy.mutationSettleDeadlineMs || 30_000)));
  const reconciliationRetryDelayMs = Math.max(5_000, Math.min(300_000, Number(reconciliationPolicy.retryDelayMs || 30_000)));
  const initialAttempts = args.stores.map((store, index) => {
    const attempt: MarketingStoreAttempt = {
      id: `marketing:attempt:${operationId}:${store.shopId}`,
      operationId,
      shopId: store.shopId,
      action: args.action,
      status: "prepared",
      requestHash: hash({ feature: args.feature, action: args.action, shopId: store.shopId, context: taskContextForStore(store) }),
      mutationKey: isRead ? `read:${args.feature}:${args.action}` : `${args.feature}:${args.action}:${store.shopId}:${contextHash}:${hash(taskContextForStore(store))}`,
      reconcilePlanKey: reconcilePlanKey || undefined,
      partition: store.partition,
      requestContext: taskContextForStore(store),
      feature: args.feature,
      platformEntityIds: [],
      successCount: 0,
      failureCount: 0,
      message: "prepared",
      createdAt,
      updatedAt: createdAt
    };
    attemptByShop.set(store.shopId, attempt);
    return attempt;
  });
  await saveMarketingAttempts(initialAttempts);

  const concurrencyPolicy = recordValue(recordValue(featurePolicy).concurrency);
  const configuredConcurrency = Number(concurrencyPolicy[isRead ? "read" : "write"] || 1);
  const taskConcurrency = Number.isFinite(configuredConcurrency) ? Math.max(1, Math.floor(configuredConcurrency)) : 1;
  const runReadRequest = isRead ? createConcurrencyLimiter(taskConcurrency) : undefined;
  const outcomes = await mapWithConcurrency(args.stores, taskConcurrency, async (store, storeIndex) => {
    const attempt = attemptByShop.get(store.shopId)!;
    const storeContext = taskContextForStore(store);
    if (args.isCancelled?.()) {
      attempt.status = isRead ? "cancelled" : "cancel_requested";
      attempt.message = "cancelled before request";
      await saveMarketingAttempts([attempt]);
      return { result: null, failure: null };
    }
    if (!isRead) {
      let preflight;
      try {
        preflight = await runMarketingPreflight({ doudianAdapter: args.doudianAdapter, feature: args.feature, action: args.action, store, context: storeContext, shouldCancel: args.isCancelled, trackWindow: args.trackWindow });
      } catch (error) {
        preflight = { status: "blocked" as const, message: error instanceof Error ? error.message : String(error), evidence: {} };
      }
      attempt.reconciliationEvidence = { ...(attempt.reconciliationEvidence || {}), preflight: preflight.evidence };
      if (preflight.status !== "ready") {
        const skipped = preflight.status === "skip";
        const result = { shopId: store.shopId, shopName: store.shopName, ok: skipped, status: skipped ? "accepted" as const : "failed" as const, message: preflight.message, entities: [], total: 0 };
        attempt.status = skipped ? "confirmed" : "rejected";
        attempt.successCount = skipped ? 1 : 0;
        attempt.failureCount = skipped ? 0 : 1;
        attempt.message = preflight.message;
        await saveMarketingAttempts([attempt]);
        return {
          result,
          failure: skipped ? null : failureForStore(operationId, store, args.action, preflight.message, storeIndex, "precheck")
        };
      }
    }
    attempt.status = "sending";
    attempt.sentAt = timestamp();
    attempt.reconcileAfter = isRead ? undefined : new Date(Date.now() + mutationSettleDeadlineMs).toISOString();
    attempt.message = "request started";
    await saveMarketingAttempts([attempt]);
    let result;
    try {
      result = isRead
        ? await runMarketingReadRequest({ doudianAdapter: args.doudianAdapter, feature: args.feature, action: args.action as MarketingReadAction, store, context: storeContext, shouldCancel: args.isCancelled, trackWindow: args.trackWindow, runRequest: runReadRequest })
        : await runMarketingWriteRequest({ doudianAdapter: args.doudianAdapter, feature: args.feature, action: args.action, store, context: storeContext, shouldCancel: args.isCancelled, trackWindow: args.trackWindow, beginMutation: args.beginMutation, endMutation: args.endMutation });
    } catch (error) {
      result = { shopId: store.shopId, shopName: store.shopName, ok: false, status: isRead ? "failed" as const : "unknown" as const, message: error instanceof Error ? error.message : String(error), entities: [], total: 0 };
    }
    const unknown = result.status === "unknown" || result.status === "reconciling";
    attempt.status = unknown ? "reconciling" : result.status === "cancelled" ? (isRead ? "cancelled" : "cancel_requested") : result.ok ? (isRead ? "confirmed" : "accepted") : "failed";
    attempt.platformEntityIds = result.entities.map((entity) => entity.entityId).filter(Boolean);
    attempt.successCount = result.ok ? result.entities.length || 1 : 0;
    attempt.failureCount = result.ok ? 0 : 1;
    attempt.message = result.message;
    attempt.reconcileAfter = unknown ? new Date(Date.now() + reconciliationRetryDelayMs).toISOString() : undefined;
    await saveMarketingAttempts([attempt]);
    return {
      result,
      failure: !result.ok && result.status !== "cancelled" ? failureForStore(operationId, store, args.action, result.message, storeIndex) : null
    };
  });
  const stores = outcomes.flatMap((outcome) => outcome.result ? [outcome.result] : []);
  const failures: MarketingItemFailure[] = outcomes.flatMap((outcome) => outcome.failure ? [outcome.failure] : []);

  const successCount = stores.filter((store) => store.ok).length;
  const failureCount = stores.filter((store) => !store.ok && store.status !== "cancelled").length;
  const unknownCount = stores.filter((store) => store.status === "unknown" || store.status === "reconciling").length;
  const cancelled = args.isCancelled?.() === true || stores.some((store) => store.status === "cancelled");
  const status = statusForRun({ cancelled, unknown: unknownCount, failures: failureCount, successes: successCount });
  const failureShard = failures.length ? await saveMarketingFailureShards(operationId, failures) : null;
  await saveMarketingRun({ ...run, status, failureShardIds: failureShard?.shardIds, failureCount: failures.length, updatedAt: timestamp() });
  return {
    ok: status === "succeeded",
    status: status === "reconciling" ? "reconciling" : status === "succeeded" ? "ok" : status === "cancelled" ? "cancelled" : status,
    feature: args.feature,
    action: args.action,
    message: status === "reconciling" ? "write result requires reconciliation" : `${successCount} stores succeeded, ${failureCount} failed`,
    stores,
    entities: stores.flatMap((store) => store.entities),
    successCount,
    failureCount,
    operationId
  };
}
