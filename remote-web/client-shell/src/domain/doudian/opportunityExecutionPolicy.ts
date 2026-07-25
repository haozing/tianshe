export interface OpportunityExecutionEvidence {
  stage?: string;
  planKey?: string;
  status?: string;
  ok?: boolean;
  message?: string;
  diagnostic?: Record<string, unknown>;
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function diagnostic(value: OpportunityExecutionEvidence) {
  return value.diagnostic && typeof value.diagnostic === "object" ? value.diagnostic : {};
}

export function isRemoteSubmittedExecution(value: OpportunityExecutionEvidence) {
  const evidence = diagnostic(value);
  const responseCode = normalized(evidence.remoteResponseCode);
  return value.stage === "submit" &&
    value.planKey === "opportunitySubmitClue" &&
    normalized(value.status) === "submitted" &&
    value.ok === true &&
    evidence.remoteSubmitAttempt === true &&
    evidence.remoteAccepted === true &&
    (responseCode === "0" || responseCode === "200");
}

export function isFinalRateLimitedExecution(value: OpportunityExecutionEvidence) {
  const evidence = diagnostic(value);
  return Number(evidence.remoteHttpStatus || 0) === 429 && evidence.remoteAccepted !== true;
}

export function candidateExecutionState(executions: OpportunityExecutionEvidence[]) {
  const failedExecution = executions.find((item) => item.ok === false);
  const unknownExecution = executions.find((item) => normalized(item.status) === "unknown");
  const submitted = executions.some(isRemoteSubmittedExecution);
  const safetySkipped = executions.some((item) => {
    const evidence = diagnostic(item);
    return normalized(item.status) === "skipped" && evidence.safetySkipped === true;
  });
  const quotaExhausted = executions.some((item) => {
    const evidence = diagnostic(item);
    return normalized(item.status) === "quota_exhausted" || evidence.quotaExhausted === true;
  });
  const skipped = !submitted && !failedExecution && executions.length > 0 && executions.every((item) => {
    const status = normalized(item.status);
    return status === "skipped" || status === "dry_run" || status === "quota_exhausted";
  });
  return {
    failed: Boolean(failedExecution),
    unknown: Boolean(unknownExecution),
    skipped,
    safetySkipped,
    quotaExhausted,
    failureMessage: failedExecution?.message || unknownExecution?.message || "",
    submitted
  };
}

export function unresolvedBatchProductStatus(batchAccepted: boolean, explicitlyFailed: boolean) {
  if (batchAccepted) return "submitted" as const;
  if (explicitlyFailed) return "failed" as const;
  return "unknown" as const;
}

export function isStoreDailyQuotaMessage(message: unknown) {
  const value = String(message ?? "").trim();
  if (!value) return false;
  return value.includes("单天最多") ||
    value.includes("今日上限") ||
    value.includes("今日已达上限") ||
    value.includes("已达今日上限") ||
    /每天最多[^，。!！]*线索/.test(value) ||
    /今日[^，。!！]*(?:最多|上限)[^，。!！]*线索/.test(value);
}

export function isProductClueLimitMessage(message: unknown) {
  const value = String(message ?? "").trim();
  if (!value || isStoreDailyQuotaMessage(value)) return false;
  return value.includes("最多支持关联") || value.includes("最多可关联") || value.includes("50个线索");
}

export function isAlreadySubmittedOpportunityMessage(message: unknown) {
  const value = String(message ?? "").trim();
  if (!value) return false;
  return /already\s*(?:submitted|joined|registered|enrolled)/i.test(value)
    || value.includes("\u5df2\u62a5\u540d")
    || value.includes("\u5df2\u5173\u8054")
    || value.includes("\u91cd\u590d\u63d0\u62a5");
}

export function preserveCancelledStatus(currentStatus: unknown, nextStatus: string) {
  return normalized(currentStatus) === "cancelled" ? "cancelled" : nextStatus;
}

export function reconcileOpportunityRecordCounts(args: {
  attemptStatuses: string[];
  candidateStatuses: string[];
  mutationStatuses: string[];
}) {
  const accepted = args.attemptStatuses.filter((status) => normalized(status) === "accepted").length;
  const submitted = args.candidateStatuses.filter((status) => normalized(status) === "submitted").length;
  const acknowledged = args.mutationStatuses.filter((status) => normalized(status) === "acknowledged").length;
  return {
    ok: accepted === submitted && submitted === acknowledged,
    accepted,
    submitted,
    acknowledged
  };
}
