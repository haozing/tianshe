import type { MatchDiagnostics } from "../../../../types";

export function createMatchDiagnostics(overrides: Partial<MatchDiagnostics> = {}): MatchDiagnostics {
  return {
    productCount: 0,
    clueCount: 0,
    tokenCount: 0,
    titleScannedCount: 0,
    tokenHitCount: 0,
    rawPairCount: 0,
    passedThresholdCount: 0,
    persistedCandidateCount: 0,
    eligibleCandidateCount: 0,
    alternativeCandidateCount: 0,
    filteredByNoTokenCount: 0,
    filteredByWeakSingleTokenCount: 0,
    filteredByThresholdCount: 0,
    filteredByGenericOnlyCount: 0,
    droppedByTopKCount: 0,
    ...overrides
  };
}

export function mergeMatchDiagnostics(target: MatchDiagnostics, source: Partial<MatchDiagnostics> = {}) {
  for (const key of Object.keys(target) as Array<keyof MatchDiagnostics>) {
    target[key] = Number(target[key] || 0) + Number(source[key] || 0);
  }
  return target;
}

export function matchDiagnosticsSummary(diagnostics: Partial<MatchDiagnostics> = {}) {
  return {
    rawPairCount: Number(diagnostics.rawPairCount || 0),
    passedThresholdCount: Number(diagnostics.passedThresholdCount || 0),
    persistedCandidateCount: Number(diagnostics.persistedCandidateCount || 0),
    eligibleCandidateCount: Number(diagnostics.eligibleCandidateCount || 0),
    alternativeCandidateCount: Number(diagnostics.alternativeCandidateCount || 0),
    filteredByNoTokenCount: Number(diagnostics.filteredByNoTokenCount || 0),
    filteredByWeakSingleTokenCount: Number(diagnostics.filteredByWeakSingleTokenCount || 0),
    filteredByThresholdCount: Number(diagnostics.filteredByThresholdCount || 0),
    filteredByGenericOnlyCount: Number(diagnostics.filteredByGenericOnlyCount || 0),
    droppedByTopKCount: Number(diagnostics.droppedByTopKCount || 0)
  };
}
