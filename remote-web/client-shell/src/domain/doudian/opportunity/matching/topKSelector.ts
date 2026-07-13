export function productCandidateKey(candidate: { shopId: string; productId: string }) {
  return `${candidate.shopId}::${candidate.productId}`;
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
