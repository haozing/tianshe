export const LOCAL_MATCH_VERSION = "opportunity-local-match-v2";
export const ANCHOR_RULE_VERSION = "opportunity-anchor-rule-v1";

export interface EvidenceGroup {
  id: string;
  representative: string;
  normalizedRepresentative: string;
  members: string[];
  normalizedMembers: string[];
}

export interface AnchorEvidence {
  words: string[];
  confidence: "high" | "medium" | "none";
  version: string;
}

export function normalizeEvidenceText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u3000]+/gu, "")
    .trim();
}

function stableUniqueTerms(terms: string[]) {
  const byNormalized = new Map<string, string>();
  for (const term of terms) {
    const original = String(term || "").trim();
    const normalized = normalizeEvidenceText(original);
    if (!normalized || byNormalized.has(normalized)) continue;
    byNormalized.set(normalized, original);
  }
  return Array.from(byNormalized.entries())
    .map(([normalized, original]) => ({ normalized, original }))
    .sort((left, right) => Array.from(right.normalized).length - Array.from(left.normalized).length
      || left.normalized.localeCompare(right.normalized));
}

export function groupEvidenceTerms(terms: string[]): EvidenceGroup[] {
  const groups: EvidenceGroup[] = [];
  for (const term of stableUniqueTerms(terms)) {
    const containing = groups.find((group) => group.normalizedRepresentative.includes(term.normalized));
    if (containing) {
      containing.members.push(term.original);
      containing.normalizedMembers.push(term.normalized);
      continue;
    }
    groups.push({
      id: term.normalized,
      representative: term.original,
      normalizedRepresentative: term.normalized,
      members: [term.original],
      normalizedMembers: [term.normalized]
    });
  }
  return groups;
}

export function matchedEvidenceGroups(groups: EvidenceGroup[], matchedTerms: string[]) {
  const matched = new Set(matchedTerms.map(normalizeEvidenceText).filter(Boolean));
  return groups.filter((group) => group.normalizedMembers.some((term) => matched.has(term)));
}

function highConfidenceShape(value: string) {
  const normalized = normalizeEvidenceText(value);
  return /[a-z]/u.test(normalized) || /\d/u.test(normalized);
}

export function deriveAnchorEvidence(args: {
  groups: EvidenceGroup[];
  structuredWords?: string[];
  validatedRuleWords?: string[];
}): AnchorEvidence {
  const structured = stableUniqueTerms(args.structuredWords || []).map((item) => item.original);
  const validated = stableUniqueTerms(args.validatedRuleWords || []).map((item) => item.original);
  const shaped = args.groups
    .map((group) => group.representative)
    .filter(highConfidenceShape);
  const words = stableUniqueTerms([...structured, ...validated, ...shaped]).map((item) => item.original);
  return {
    words,
    confidence: words.length ? "high" : args.groups.length > 1 ? "medium" : "none",
    version: ANCHOR_RULE_VERSION
  };
}
