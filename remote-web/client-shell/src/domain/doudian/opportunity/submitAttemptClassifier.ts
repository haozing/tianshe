export interface CoordinatedSubmitCandidate {
  candidateId: string;
  productId: string;
}

export interface CoordinatedSubmitCandidateResult {
  candidateId: string;
  status: "accepted" | "failed" | "skipped" | "retry_waiting" | "unknown";
  message?: string;
}

export interface CoordinatedSubmitClassification {
  outcome: "accepted" | "partial" | "throttled" | "failed" | "unknown";
  candidateResults?: CoordinatedSubmitCandidateResult[];
  responseClass: string;
}

export function classifyCoordinatedSubmitAttempt(args: {
  accepted: boolean;
  httpStatus: number;
  message: string;
  candidates: CoordinatedSubmitCandidate[];
  failureMessages?: Map<string, string>;
  wholeBatchStatus?: "failed" | "skipped";
  frequencyLimited?: boolean;
  manualInterventionRequired?: boolean;
  uncertain?: boolean;
}): CoordinatedSubmitClassification {
  if (args.accepted) return { outcome: "accepted", responseClass: "accepted" };

  if (args.httpStatus === 429 || (args.frequencyLimited && !args.manualInterventionRequired)) {
    return {
      outcome: "throttled",
      responseClass: args.httpStatus === 429 ? "http-429" : "business-throttle",
      candidateResults: args.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        status: "retry_waiting",
        message: args.message
      }))
    };
  }

  const failureMessages = args.failureMessages || new Map<string, string>();
  if (failureMessages.size) {
    return {
      outcome: "partial",
      responseClass: "candidate-partial-failure",
      candidateResults: args.candidates.map((candidate) => {
        const failure = failureMessages.get(candidate.productId);
        return failure
          ? { candidateId: candidate.candidateId, status: "failed", message: failure }
          : { candidateId: candidate.candidateId, status: "unknown", message: "batch response did not confirm this candidate" };
      })
    };
  }

  if (args.wholeBatchStatus === "skipped") {
    return {
      outcome: "partial",
      responseClass: "already-submitted",
      candidateResults: args.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        status: "skipped",
        message: args.message
      }))
    };
  }

  if (args.manualInterventionRequired || args.uncertain) {
    return { outcome: "unknown", responseClass: args.manualInterventionRequired ? "manual-intervention" : "transport-uncertain" };
  }

  return { outcome: "failed", responseClass: "explicit-failure" };
}
