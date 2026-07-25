export function productCandidateKey(candidate: { shopId: string; productId: string }) {
  return `${candidate.shopId}::${candidate.productId}`;
}

export function boundedProductCandidateLimit(configuredTopK: number, taskCandidateLimit: number) {
  const configured = Math.max(1, Math.floor(Number(configuredTopK || 1)));
  const taskLimit = Math.max(1, Math.floor(Number(taskCandidateLimit || 1)));
  return Math.min(configured, taskLimit);
}

export function compareCandidatesByEvidence<T extends {
  matchScore: number;
  matchedWeightRatio?: number;
  matchedTokenCount?: number;
  clueName?: string;
}>(left: T, right: T) {
  return Number(right.matchScore || 0) - Number(left.matchScore || 0)
    || Number(right.matchedWeightRatio || 0) - Number(left.matchedWeightRatio || 0)
    || Number(right.matchedTokenCount || 0) - Number(left.matchedTokenCount || 0)
    || String(left.clueName || "").localeCompare(String(right.clueName || ""));
}

export function keepProductTopK<T extends { shopId: string; productId: string; matchScore: number }>(
  topMatches: Map<string, T[]>,
  candidate: T,
  limit: number
) {
  const key = productCandidateKey(candidate);
  const list = topMatches.get(key) || [];
  list.push(candidate);
  list.sort(compareCandidatesByEvidence);
  topMatches.set(key, list.slice(0, Math.max(1, limit)));
}

export function flattenProductTopK<T extends { shopId: string; productId: string; matchScore: number }>(
  topMatches: Map<string, T[]>
) {
  return Array.from(topMatches.values()).flat().sort(compareCandidatesByEvidence);
}

export function rankCandidatesAfterFiltering<T extends {
  matchScore: number;
  matchedWeightRatio?: number;
  matchedTokenCount?: number;
  clueName?: string;
}>(
  candidates: T[],
  args: { limit: number; skipReason: (candidate: T) => string }
) {
  const skipped: Array<{ candidate: T; skipReason: string }> = [];
  const eligible: T[] = [];
  for (const candidate of candidates) {
    const skipReason = String(args.skipReason(candidate) || "");
    if (skipReason) skipped.push({ candidate, skipReason });
    else eligible.push(candidate);
  }
  const limit = Math.max(1, Math.floor(Number(args.limit || 1)));
  return {
    ranked: eligible
      .sort(compareCandidatesByEvidence)
      .slice(0, limit)
      .map((candidate, index) => ({ candidate, rankForProduct: index + 1 })),
    skipped
  };
}
