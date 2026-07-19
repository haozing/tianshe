import { getStoreLedger } from "../storeGroups";
import { firstPathValue, requestPlanResponseOk, runDoudianRequestPlan } from "../requestPlan";
import type { DoudianAdapterConfig, DoudianAdapterPayload, MarketingFeature } from "../../../types";
import type { MarketingTaskStore } from "./types";
import { marketingManagementPreflight, type MarketingPreflightResult } from "./preflightPolicy";
import { currentShopState } from "../storeResponse";
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
  const planKeys = textList(writeContract.precheckPlanKeys);
  if (!planKeys.length) return { status: "blocked", message: "marketing precheck plan is missing", evidence: { action: args.action } };
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
    const statusValue = firstPathValue(response.data, textList(preflightMapping.statusPaths));
    if (Array.isArray(statusValue)) statuses.push(...statusValue.map(String));
    else if (statusValue !== undefined && statusValue !== null && statusValue !== "") statuses.push(String(statusValue));
    const conflict = firstPathValue(response.data, textList(preflightMapping.conflictPaths));
    if (conflict === true || conflict === 1 || conflict === "1" || conflict === "true") return { status: "blocked", message: "platform precheck reported an activity conflict", evidence: { checks, conflict: true } };
    const eligible = firstPathValue(response.data, textList(preflightMapping.eligiblePaths));
    if (eligible === false || eligible === 0 || eligible === "0" || eligible === "false") return { status: "blocked", message: "platform precheck rejected the selected products", evidence: { checks, eligible: false } };
    const rejectedItems = firstPathValue(response.data, textList(preflightMapping.rejectedItemPaths));
    if (Array.isArray(rejectedItems) && rejectedItems.length > 0) return { status: "blocked", message: `platform precheck rejected ${rejectedItems.length} selected items`, evidence: { checks, rejectedItemCount: rejectedItems.length } };
  }

  if (args.action === "create") return { status: "ready", message: "create preflight passed", evidence: { checks } };
  return marketingManagementPreflight({
    action: args.action,
    statuses,
    writableStatuses: textList(writeContract.writableStatuses).length ? textList(writeContract.writableStatuses) : textList(policy.writableStatuses),
    idempotentStatuses: textList(writeContract.idempotentStatuses)
  });
}
