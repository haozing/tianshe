import { loadDoudianAdapterPayload } from "../../../bridge/doudianAdapter";
import { getOperation, markOperationFullResult, markOperationReconciling, type DoudianOperationRecord } from "../operation";
import { firstPathValue, requestPlanResponseOk, runDoudianRequestPlan } from "../requestPlan";
import { isUnknownWriteResponse } from "../requestPlanSafety";
import { getMarketingRun, queryMarketingAttempts, saveMarketingAttempts, saveMarketingRun } from "./repository";
import type { MarketingStoreAttempt, MarketingRun } from "./types";
import { marketingReconciledRun, marketingReconciliationCompletionStatus, marketingReconciliationDecision } from "./reconciliationPolicy";
import { marketingAdapterSnapshotHash } from "./snapshot";

const reconcileLocks = new Map<string, Promise<DoudianOperationRecord | null>>();
const reconcileTimers = new Map<string, number>();

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function paths(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function mappedValue(row: unknown, fields: Record<string, unknown>, key: string) {
  return firstPathValue(row, paths(objectValue(fields[key]).paths));
}

export function reconciliationEntityIds(data: unknown, mapping: Record<string, unknown>) {
  const direct = firstPathValue(data, paths(mapping.entityIdPaths));
  if (Array.isArray(direct)) return direct.map(String).filter(Boolean);
  if (direct != null && direct !== "") return [String(direct)];
  const rows = firstPathValue(data, paths(mapping.listPaths));
  const fields = objectValue(mapping.fields);
  if (Array.isArray(rows)) return rows.map((row) => mappedValue(row, fields, "entityId")).filter((value) => value != null && value !== "").map(String);
  if (rows && typeof rows === "object") {
    const value = mappedValue(rows, fields, "entityId");
    return value == null || value === "" ? [] : [String(value)];
  }
  return [];
}

function featureMapping(adapter: Record<string, unknown>, feature: string) {
  return objectValue(objectValue(adapter.responseMappings).marketing && objectValue(objectValue(adapter.responseMappings).marketing)[feature]);
}

function featurePolicy(adapter: Record<string, unknown>, feature: string) {
  return objectValue(objectValue(objectValue(adapter.policies).marketing).features)[feature] as Record<string, unknown>;
}

function pending(status: string) {
  return ["prepared", "sending", "cancel_requested", "unknown", "reconciling"].includes(status);
}

async function reconcileMarketingOperationInternal(operationId: string, input: { adapterPayload?: Awaited<ReturnType<typeof loadDoudianAdapterPayload>> } = {}) {
  const operation = await getOperation(operationId);
  if (!operation || operation.taskType !== "marketingTask") return operation;
  if (["succeeded", "partial", "failed", "cancelled"].includes(operation.status)) return operation;
  const attempts: MarketingStoreAttempt[] = [];
  let attemptCursor = null;
  for (;;) {
    const page = await queryMarketingAttempts(operationId, { cursor: attemptCursor, pageSize: 500 });
    attempts.push(...page.items);
    if (!page.hasMore || !page.nextCursor) break;
    attemptCursor = page.nextCursor;
  }
  const run = await getMarketingRun(operationId) as MarketingRun | null;
  if (!attempts.length) {
    const currentTimer = reconcileTimers.get(operationId);
    if (currentTimer) window.clearTimeout(currentTimer);
    reconcileTimers.delete(operationId);
    if (run) await saveMarketingRun({ ...run, status: "reconciling", updatedAt: new Date().toISOString() });
    return markOperationReconciling(operationId, "no mutation attempt evidence; manual reconciliation required");
  }
  const adapterPayload = input.adapterPayload || await loadDoudianAdapterPayload();
  const expectedSnapshotHash = operation.adapterSnapshotHash || run?.adapterSnapshotHash || "";
  const actualSnapshotHash = marketingAdapterSnapshotHash(adapterPayload);
  if (!expectedSnapshotHash || expectedSnapshotHash !== actualSnapshotHash) {
    for (const attempt of attempts.filter((item) => pending(item.status))) {
      attempt.status = "reconciling";
      attempt.reconcileAfter = undefined;
      attempt.message = "adapter snapshot is unavailable or changed; manual reconciliation required";
      attempt.reconciliationEvidence = { ...(attempt.reconciliationEvidence || {}), expectedSnapshotHash, actualSnapshotHash, snapshotMismatch: true, checkedAt: new Date().toISOString() };
    }
    if (attempts.length) await saveMarketingAttempts(attempts);
    if (run) await saveMarketingRun({ ...run, status: "reconciling", updatedAt: new Date().toISOString() });
    return markOperationReconciling(operationId, "adapter snapshot changed; manual reconciliation required");
  }
  let unresolved = 0;
  let retryableUnresolved = 0;
  let nextRetryAt = Number.POSITIVE_INFINITY;
  let confirmed = 0;
  let failed = 0;

  for (const attempt of attempts) {
    if (!pending(attempt.status)) {
      if (["accepted", "confirmed"].includes(attempt.status)) confirmed += 1;
      if (["failed", "rejected", "cancelled"].includes(attempt.status)) failed += 1;
      continue;
    }
    const planKey = String(attempt.reconcilePlanKey || "");
    if (!planKey || !attempt.partition || !attempt.feature) {
      unresolved += 1;
      continue;
    }
    const reconcileAfter = Date.parse(attempt.reconcileAfter || "");
    if (Number.isFinite(reconcileAfter) && reconcileAfter > Date.now()) {
      unresolved += 1;
      retryableUnresolved += 1;
      nextRetryAt = Math.min(nextRetryAt, reconcileAfter);
      continue;
    }
    const response = await runDoudianRequestPlan(adapterPayload, {
      partition: attempt.partition,
      planKey,
      context: { shopId: attempt.shopId, ...(attempt.requestContext || {}), operationId },
    }).catch((error) => ({ ok: false, status: 0, data: null, source: planKey, error: error instanceof Error ? error.message : String(error) }));
    const mapping = featureMapping(adapterPayload.adapter as unknown as Record<string, unknown>, attempt.feature);
    const policy = featurePolicy(adapterPayload.adapter as unknown as Record<string, unknown>, attempt.feature);
    const reconciliationPolicy = objectValue(policy.reconciliation);
    const maxObservationMs = Math.max(30_000, Number(reconciliationPolicy.maxObservationMs || 600_000));
    const retryDelayMs = Math.max(5_000, Math.min(300_000, Number(reconciliationPolicy.retryDelayMs || 30_000)));
    const observationStartedAt = Date.parse(attempt.sentAt || attempt.createdAt);
    const observationExpired = Number.isFinite(observationStartedAt) && Date.now() - observationStartedAt >= maxObservationMs;
    const contractOk = requestPlanResponseOk(response, adapterPayload.adapter, planKey, mapping);
    const networkUnknown = isUnknownWriteResponse(response);
    if (networkUnknown || !contractOk) {
      unresolved += 1;
      if (!observationExpired) retryableUnresolved += 1;
      attempt.status = "reconciling";
      attempt.message = observationExpired ? "reconciliation observation window exhausted; manual review required" : response.error || "reconciliation request did not complete";
      attempt.reconciliationEvidence = { ...(attempt.reconciliationEvidence || {}), checkedAt: new Date().toISOString(), status: response.status, source: response.source, observationExpired };
      attempt.reconcileAfter = observationExpired ? undefined : new Date(Date.now() + retryDelayMs).toISOString();
      if (!observationExpired) nextRetryAt = Math.min(nextRetryAt, Date.now() + retryDelayMs);
      await saveMarketingAttempts([attempt]);
      continue;
    }
    const requestContext = objectValue(attempt.requestContext);
    const expectedEntityIds = attempt.platformEntityIds.length ? attempt.platformEntityIds : Array.isArray(requestContext.entityIds) ? requestContext.entityIds.map(String).filter(Boolean) : [];
    const decision = marketingReconciliationDecision({ data: response.data, mapping, expectedEntityIds, context: requestContext });
    if (decision.status === "unique") {
      attempt.platformEntityIds = decision.entityIds.length ? decision.entityIds : attempt.platformEntityIds;
      attempt.status = "confirmed";
      attempt.successCount = Math.max(1, attempt.successCount);
      attempt.failureCount = 0;
      attempt.message = "reconciliation confirmed";
      attempt.reconciliationEvidence = { checkedAt: new Date().toISOString(), status: response.status, source: response.source, decision: decision.status, ...decision.evidence };
      attempt.reconcileAfter = undefined;
      confirmed += 1;
    } else if (decision.status === "not_found") {
      attempt.status = "failed";
      attempt.failureCount = Math.max(1, attempt.failureCount);
      attempt.message = "reconciliation confirmed that the mutation did not take effect";
      attempt.reconciliationEvidence = { checkedAt: new Date().toISOString(), status: response.status, source: response.source, decision: decision.status, ...decision.evidence };
      failed += 1;
    } else {
      unresolved += 1;
      if (!observationExpired) retryableUnresolved += 1;
      attempt.status = "reconciling";
      attempt.message = observationExpired ? `${decision.status} reconciliation requires manual review` : `${decision.status} reconciliation is still pending`;
      attempt.reconciliationEvidence = { checkedAt: new Date().toISOString(), status: response.status, source: response.source, decision: decision.status, observationExpired, ...decision.evidence };
      attempt.reconcileAfter = observationExpired ? undefined : new Date(Date.now() + retryDelayMs).toISOString();
      if (!observationExpired) nextRetryAt = Math.min(nextRetryAt, Date.now() + retryDelayMs);
    }
    await saveMarketingAttempts([attempt]);
  }

  const nextStatus = marketingReconciliationCompletionStatus({ attemptCount: attempts.length, unresolved, failed, confirmed });
  if (run) await saveMarketingRun(marketingReconciledRun(run, attempts.length, nextStatus, { unresolved, failed, confirmed }));
  if (unresolved > 0) {
    const currentTimer = reconcileTimers.get(operationId);
    if (currentTimer) window.clearTimeout(currentTimer);
    const retryInMs = Number.isFinite(nextRetryAt) ? Math.max(5_000, Math.min(300_000, nextRetryAt - Date.now())) : 30_000;
    if (retryableUnresolved > 0) reconcileTimers.set(operationId, window.setTimeout(() => {
        reconcileTimers.delete(operationId);
        void reconcileMarketingOperation(operationId).catch(() => null);
      }, retryInMs));
    return markOperationReconciling(operationId, "reconciliation is still pending");
  }
  const currentTimer = reconcileTimers.get(operationId);
  if (currentTimer) window.clearTimeout(currentTimer);
  reconcileTimers.delete(operationId);
  const result = { ok: nextStatus === "succeeded", status: nextStatus, operationId, confirmed, failed, unresolved: 0 };
  return markOperationFullResult(operationId, "reconciliation completed", result, nextStatus as "succeeded" | "partial" | "failed");
}

export function reconcileMarketingOperation(operationId: string, input: { adapterPayload?: Awaited<ReturnType<typeof loadDoudianAdapterPayload>> } = {}) {
  const existing = reconcileLocks.get(operationId);
  if (existing) return existing;
  const pending = reconcileMarketingOperationInternal(operationId, input).finally(() => {
    if (reconcileLocks.get(operationId) === pending) reconcileLocks.delete(operationId);
  });
  reconcileLocks.set(operationId, pending);
  return pending;
}

export async function reconcileActiveMarketingOperations(records: DoudianOperationRecord[]) {
  const results: DoudianOperationRecord[] = [];
  for (const record of records) {
    if (record.taskType !== "marketingTask" || record.status !== "reconciling") continue;
    const next = await reconcileMarketingOperation(record.operationId).catch(() => null);
    if (next) results.push(next);
  }
  return results;
}
