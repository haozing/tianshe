import { getStoreLedger } from "../storeGroups";
import { firstPathValue, requestPlanResponseOk, runDoudianRequestPlan } from "../requestPlan";
import type { DoudianAdapterConfig, DoudianAdapterPayload, MarketingFeature } from "../../../types";
import type { MarketingTaskStore } from "./types";
import { marketingManagementPreflight, type MarketingPreflightResult } from "./preflightPolicy";
import { currentShopState } from "../storeResponse";
import { generalCouponRejectedItems } from "./generalCoupon.ts";
export { marketingManagementPreflight } from "./preflightPolicy";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textList(value: unknown) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function featurePolicy(adapter: DoudianAdapterConfig, feature: MarketingFeature) {
  return objectValue(objectValue(objectValue(adapter.policies).marketing).features)[feature] as Record<string, unknown>;
}

function featureMapping(adapter: DoudianAdapterConfig, feature: MarketingFeature) {
  return objectValue(objectValue(adapter.responseMappings?.marketing)[feature]);
}

export async function runMarketingPreflight(args: {
  doudianAdapter: DoudianAdapterPayload;
  feature: MarketingFeature;
  action: string;
  store: MarketingTaskStore;
  context: Record<string, unknown>;
  shouldCancel?: () => boolean;
  trackWindow?: (winId: number) => void;
}): Promise<MarketingPreflightResult> {
  const ledger = await getStoreLedger(args.store.shopId);
  if (!ledger || ledger.status !== "online") return { status: "blocked", message: "store is not confirmed online", evidence: { shopId: args.store.shopId, ledgerStatus: ledger?.status || "missing" } };

  const adapter = args.doudianAdapter.adapter;
  const onlineResponse = await runDoudianRequestPlan(args.doudianAdapter, {
    partition: args.store.partition,
    planKey: "currentShop",
    context: { shopId: args.store.shopId, shopName: args.store.shopName },
    shouldCancel: args.shouldCancel,
    trackWindow: args.trackWindow
  });
  const onlineState = currentShopState(onlineResponse, adapter, ledger, "marketingPreflight");
  if (!onlineState.ok) return { status: "blocked", message: onlineState.message || "store login or identity check failed", evidence: { shopId: args.store.shopId, reason: onlineState.reason, responseStatus: onlineResponse.status } };
  const policy = featurePolicy(adapter, args.feature);
  const writeContract = objectValue(objectValue(policy.writeActions)[args.action]);
  const scopedPlanKeys = textList(objectValue(writeContract.precheckPlanKeysByScope)[String(args.context.scope || "")]);
  const planKeys = scopedPlanKeys.length ? scopedPlanKeys : textList(writeContract.precheckPlanKeys);
  if (!planKeys.length && !(args.action === "create" && writeContract.deferredValidation === true && String(writeContract.validationPlanKey || ""))) {
    return { status: "blocked", message: "marketing precheck plan is missing", evidence: { action: args.action } };
  }
  const mapping = featureMapping(adapter, args.feature);
  const preflightMapping = objectValue(mapping.preflight);
  const statuses: string[] = [];
  const checks: Array<Record<string, unknown>> = [];

  for (const planKey of planKeys) {
    if (args.shouldCancel?.()) return { status: "blocked", message: "preflight cancelled", evidence: { checks } };
    const response = await runDoudianRequestPlan(args.doudianAdapter, {
      partition: args.store.partition,
      planKey,
      context: { shopId: args.store.shopId, ...args.context },
      shouldCancel: args.shouldCancel,
      trackWindow: args.trackWindow
    });
    const ok = requestPlanResponseOk(response, adapter, planKey, mapping);
    checks.push({ planKey, ok, status: response.status, source: response.source });
    if (!ok) return { status: "blocked", message: response.error || `marketing precheck failed: ${planKey}`, evidence: { checks } };
    const failureReason = firstPathValue(response.data, textList(preflightMapping.failureReasonPaths));
    if (failureReason !== undefined && failureReason !== null && String(failureReason).trim()) {
      return { status: "blocked", message: String(failureReason), evidence: { checks, failureReason: String(failureReason) } };
    }
    const statusValue = firstPathValue(response.data, textList(preflightMapping.statusPaths));
    if (Array.isArray(statusValue)) statuses.push(...statusValue.map(String));
    else if (statusValue !== undefined && statusValue !== null && statusValue !== "") statuses.push(String(statusValue));
    const conflict = firstPathValue(response.data, textList(preflightMapping.conflictPaths));
    if (conflict === true || conflict === 1 || conflict === "1" || conflict === "true") return { status: "blocked", message: "platform precheck reported an activity conflict", evidence: { checks, conflict: true } };
    const eligible = firstPathValue(response.data, textList(preflightMapping.eligiblePaths));
    if (eligible === false || eligible === 0 || eligible === "0" || eligible === "false") return { status: "blocked", message: "platform precheck rejected the selected products", evidence: { checks, eligible: false } };
    const rejectedValue = firstPathValue(response.data, textList(preflightMapping.rejectedItemPaths));
    const rejected = generalCouponRejectedItems(rejectedValue);
    if (rejected.length > 0) {
      if (["general_coupon", "new_user_bonus"].includes(args.feature) && args.action === "create") {
        return { status: "ready", message: `platform precheck excluded ${rejected.length} selected items`, evidence: { checks, rejectedItems: rejected, rejectedItemCount: rejected.length } };
      }
      return { status: "blocked", message: `platform precheck rejected ${rejected.length} selected items`, evidence: { checks, rejectedItems: rejected, rejectedItemCount: rejected.length } };
    }
  }

  if (args.action === "create") return { status: "ready", message: writeContract.deferredValidation === true ? "create identity preflight passed; payload validation is deferred until SKU preparation" : "create preflight passed", evidence: { checks, deferredValidation: writeContract.deferredValidation === true } };
  const management = marketingManagementPreflight({
    action: args.action,
    statuses,
    writableStatuses: textList(writeContract.writableStatuses).length ? textList(writeContract.writableStatuses) : textList(policy.writableStatuses),
    idempotentStatuses: textList(writeContract.idempotentStatuses)
  });
  if (management.status !== "ready") return management;
  if (args.feature === "limited_time" && args.action === "toggle_renew" && args.context.renewOn === true) {
    const entity = objectValue(args.context.selectedEntity);
    const activityType = String(entity.activityType || "");
    const start = Date.parse(String(entity.startTime || ""));
    const end = Date.parse(String(entity.endTime || ""));
    if (["flash", "LimitTime", "限时抢购"].includes(activityType)) return { status: "blocked", message: "限时抢购不支持平台官方续期", evidence: { checks, activityType } };
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 7 * 24 * 60 * 60 * 1000) return { status: "blocked", message: "活动时间小于7天，不支持平台官方续期", evidence: { checks } };
    if (["", "0", "false"].includes(String(entity.limitStockType ?? "").toLowerCase())) return { status: "blocked", message: "未设置活动库存的活动不支持平台官方续期", evidence: { checks } };
    if (Date.now() >= end - 24 * 60 * 60 * 1000) return { status: "blocked", message: "活动结束前24小时不可开启平台官方续期", evidence: { checks } };
  }
  if (args.feature === "general_coupon" && args.action === "toggle_renew" && args.context.renewOn === true) {
    const entity = objectValue(args.context.selectedEntity);
    const start = Date.parse(String(entity.startTime || ""));
    const end = Date.parse(String(entity.endTime || ""));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 30 * 24 * 60 * 60 * 1000) return { status: "blocked", message: "领取时间小于30天，不支持官方续期", evidence: { checks } };
    if (!entity.validPeriodDays && entity.useStartTime && entity.useEndTime && (Date.parse(String(entity.useStartTime)) !== start || Date.parse(String(entity.useEndTime)) !== end)) {
      return { status: "blocked", message: "领取时间与使用时间不同，不支持官方续期", evidence: { checks } };
    }
  }
  return management;
}
