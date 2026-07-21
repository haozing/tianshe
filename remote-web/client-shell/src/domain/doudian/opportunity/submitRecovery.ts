export function isUnresolvedSubmitState(candidate: { submitStatus?: unknown; status?: unknown }) {
  const state = String(candidate.submitStatus || candidate.status || "").trim().toLocaleLowerCase();
  return state === "sending" || state === "submitting";
}

export function logicalSubmitAttemptId(runId: string, candidate: { id: string; productId: string }) {
  return `${runId}-${candidate.id}-${candidate.productId}-submission`;
}

export function recoverUnresolvedSubmitCandidate<T extends {
  id: string;
  productId: string;
  submitAttemptId?: string;
}>(candidate: T, args: { runId: string; reason: string; updatedAt: string }) {
  return {
    ...candidate,
    eligible: false,
    estimatedCost: 0,
    status: "unknown" as const,
    submitStatus: "unknown" as const,
    submitAttemptId: candidate.submitAttemptId || logicalSubmitAttemptId(args.runId, candidate),
    skipReason: args.reason,
    updatedAt: args.updatedAt
  };
}
