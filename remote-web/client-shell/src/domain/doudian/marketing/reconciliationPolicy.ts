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
  const complete = reconciliation.completeByDefault === true || completeValue === true || completeValue === 1 || completeValue === "1" || completeValue === "true";
  const rowsValue = firstValue(args.data, paths(args.mapping.listPaths));
  const rows = Array.isArray(rowsValue) ? rowsValue : rowsValue && typeof rowsValue === "object" ? [rowsValue] : [];
  const fields = objectValue(args.mapping.fields);
  const expected = new Set((args.expectedEntityIds || []).map(String).filter(Boolean));
  const candidates = rows.map((row) => ({ row, entityId: String(firstValue(row, paths(objectValue(fields.entityId).paths)) ?? "") })).filter((item) => item.entityId);
  const matches = expected.size
    ? candidates.filter((item) => expected.has(item.entityId))
    : candidates.filter((item) => matchesFingerprint(item.row, fields, objectValue(args.context)));
  const entityIds = matches.map((item) => item.entityId);

  if (directStatus) return { status: directStatus, entityIds, evidence: { direct, complete, candidateCount: candidates.length, matchCount: matches.length } };
  if (expected.size && matches.length === expected.size) return { status: "unique", entityIds, evidence: { complete, candidateCount: candidates.length, matchCount: matches.length } };
  if (!expected.size && matches.length === 1) return { status: "unique", entityIds, evidence: { complete, candidateCount: candidates.length, matchCount: 1 } };
  if (matches.length > Math.max(1, expected.size)) return { status: "conflict", entityIds, evidence: { complete, candidateCount: candidates.length, matchCount: matches.length } };
  if (complete && matches.length === 0) return { status: "not_found", entityIds: [], evidence: { complete, candidateCount: candidates.length, matchCount: 0 } };
  return { status: "unknown", entityIds, evidence: { complete, candidateCount: candidates.length, matchCount: matches.length } };
}
