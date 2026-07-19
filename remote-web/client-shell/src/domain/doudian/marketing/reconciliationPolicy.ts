import type { MarketingRun } from "./types";

export type MarketingReconciliationStatus = "unique" | "not_found" | "conflict" | "unknown";

export interface MarketingReconciliationDecision {
  status: MarketingReconciliationStatus;
  entityIds: string[];
  evidence: Record<string, unknown>;
}

export function marketingReconciliationCompletionStatus(args: {
  attemptCount: number;
  unresolved: number;
  failed: number;
  confirmed: number;
}) {
  if (args.attemptCount < 1 || args.unresolved > 0) return "reconciling" as const;
  if (args.failed > 0 && args.confirmed > 0) return "partial" as const;
  if (args.failed > 0) return "failed" as const;
  return "succeeded" as const;
}

export function marketingReconciledRun(
  run: MarketingRun,
  attemptCount: number,
  status: MarketingRun["status"],
  counts: { unresolved: number; failed: number; confirmed: number },
  updatedAt = new Date().toISOString()
): MarketingRun {
  if (run.feature !== "limited_time" || run.action !== "create") return { ...run, status, updatedAt };
  const activityCount = Number(run.activityCount || attemptCount);
  const message = counts.unresolved
    ? `对账中：已确认创建 ${counts.confirmed}/${activityCount} 个活动，${counts.unresolved} 个结果待确认，${counts.failed} 个未创建`
    : `对账完成：已确认创建 ${counts.confirmed}/${activityCount} 个活动，${counts.failed} 个未创建`;
  return {
    ...run,
    status,
    message,
    activityCount,
    createdActivityCount: counts.confirmed,
    failedActivityCount: counts.failed,
    unknownActivityCount: counts.unresolved,
    updatedAt
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function paths(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function getPath(root: unknown, path: string) {
  return path.split(".").filter(Boolean).reduce<unknown>((current, key) => objectValue(current)[key], root);
}

function firstValue(root: unknown, candidates: string[]) {
  for (const path of candidates) {
    const value = getPath(root, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function stringIds(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : value === undefined || value === null || value === "" ? [] : [String(value)];
}

function booleanValue(value: unknown) {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

function matchesFingerprint(row: unknown, fields: Record<string, unknown>, context: Record<string, unknown>) {
  const comparisons: Array<[string, string]> = [["name", "name"], ["startTime", "startTime"], ["endTime", "endTime"]];
  const fingerprint = objectValue(context.reconciliationFingerprint);
  let compared = 0;
  for (const [field, contextKey] of comparisons) {
    const expected = normalized(fingerprint[contextKey] ?? context[contextKey]);
    if (!expected) continue;
    compared += 1;
    const actual = normalized(firstValue(row, paths(objectValue(fields[field]).paths)));
    if (!actual || actual !== expected) return false;
  }
  return compared > 0;
}

export function marketingReconciliationDecision(args: { data: unknown; mapping: Record<string, unknown>; expectedEntityIds?: string[]; context?: Record<string, unknown> }): MarketingReconciliationDecision {
  const reconciliation = objectValue(args.mapping.reconciliation);
  const values = objectValue(reconciliation.outcomeValues);
  const direct = normalized(firstValue(args.data, paths(reconciliation.outcomePaths)));
  const directStatus = (["unique", "not_found", "conflict", "unknown"] as const).find((status) => paths(values[status]).map(normalized).includes(direct));
  const completeValue = firstValue(args.data, paths(reconciliation.completePaths));
  const rowsValue = firstValue(args.data, paths(args.mapping.listPaths));
  const rows = Array.isArray(rowsValue) ? rowsValue : rowsValue && typeof rowsValue === "object" ? [rowsValue] : [];
  const totalValue = firstValue(args.data, paths(args.mapping.totalPaths));
  const total = Number(totalValue);
  const explicitlyComplete = completeValue === true || completeValue === 1 || completeValue === "1" || completeValue === "true";
  const countComplete = Number.isSafeInteger(total) && total >= 0 && rows.length >= total;
  const complete = explicitlyComplete || countComplete || reconciliation.completeByDefault === true;
  const fields = objectValue(args.mapping.fields);
  const expected = new Set((args.expectedEntityIds || []).map(String).filter(Boolean));
  const candidates = rows.map((row) => ({ row, entityId: String(firstValue(row, paths(objectValue(fields.entityId).paths)) ?? "") })).filter((item) => item.entityId);
  const identityMatches = expected.size
    ? candidates.filter((item) => expected.has(item.entityId))
    : candidates.filter((item) => matchesFingerprint(item.row, fields, objectValue(args.context)));
  const context = objectValue(args.context);
  const expectedStatuses = new Set(stringIds(context.reconcileExpectedRawStatuses));
  const expectsAutoRenew = typeof context.reconcileExpectedAutoRenew === "boolean";
  const matches = identityMatches.filter((item) => {
    if (expectedStatuses.size) {
      const status = String(firstValue(item.row, paths(objectValue(fields.status).paths)) ?? "");
      if (!expectedStatuses.has(status)) return false;
    }
    if (expectsAutoRenew) {
      const autoRenew = booleanValue(firstValue(item.row, paths(objectValue(fields.autoRenew).paths)));
      if (autoRenew !== context.reconcileExpectedAutoRenew) return false;
    }
    return true;
  });
  const entityIds = matches.map((item) => item.entityId);
  const expectedAbsent = context.reconcileExpectedAbsent === true;
  const stateExpectation = expectedStatuses.size > 0 || expectsAutoRenew;

  if (directStatus) return { status: directStatus, entityIds, evidence: { direct, complete, total: Number.isFinite(total) ? total : undefined, candidateCount: candidates.length, matchCount: matches.length } };
  if (expectedAbsent && complete && matches.length === 0) return { status: "unique", entityIds: [], evidence: { complete, expectedAbsent: true, candidateCount: candidates.length, matchCount: 0 } };
  if (expectedAbsent && matches.length > 0) return { status: "unknown", entityIds, evidence: { complete, expectedAbsent: true, candidateCount: candidates.length, matchCount: matches.length } };
  if (stateExpectation && identityMatches.length > 0 && matches.length === 0) return { status: "unknown", entityIds: identityMatches.map((item) => item.entityId), evidence: { complete, stateExpectation: true, candidateCount: candidates.length, identityMatchCount: identityMatches.length, matchCount: 0 } };
  if (expected.size && matches.length === expected.size) return { status: "unique", entityIds, evidence: { complete, candidateCount: candidates.length, matchCount: matches.length } };
  if (!expected.size && matches.length === 1) return { status: "unique", entityIds, evidence: { complete, candidateCount: candidates.length, matchCount: 1 } };
  if (matches.length > Math.max(1, expected.size)) return { status: "conflict", entityIds, evidence: { complete, candidateCount: candidates.length, matchCount: matches.length } };
  if (complete && matches.length === 0) return { status: "not_found", entityIds: [], evidence: { complete, candidateCount: candidates.length, matchCount: 0 } };
  return { status: "unknown", entityIds, evidence: { complete, candidateCount: candidates.length, matchCount: matches.length } };
}
