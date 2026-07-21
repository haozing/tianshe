import { normalizeEvidenceText } from "./matching/evidenceGrouping.ts";

export type OfficialWordsSemantics = "alternative_terms" | "conjunctive_parts" | "unknown";
export type OfficialGoodsContractMode = "exhaustive" | "positive_only" | "unknown";
export type OfficialValidationStatus = "not_started" | "pending" | "verified" | "rejected" | "unknown" | "budget_exhausted";

export interface OfficialClueWordsResult {
  status: "complete" | "no_terms" | "failed" | "schema_mismatch";
  words: string[];
  source: "remote" | "cache";
  semantics: OfficialWordsSemantics;
  clueId: string;
  requestCount: number;
  cacheHit: boolean;
  requestHash: string;
  responseHash: string;
  contractVersion: string;
  message?: string;
}

export interface OfficialClueGoodsResult {
  status: "complete" | "failed" | "truncated" | "schema_mismatch";
  contractMode: OfficialGoodsContractMode;
  shopId: string;
  clueId: string;
  productIds: string[];
  remoteTotal: number;
  remoteTotalKnown: boolean;
  fetchedRowCount: number;
  matchedRowCount: number;
  fetchedPages: number;
  requestCount: number;
  cacheHit: boolean;
  requestHash: string;
  responseHash: string;
  contractVersion: string;
  message?: string;
}

export interface OfficialValidationPolicy {
  version: string;
  goodsContractMode: OfficialGoodsContractMode;
  goodsMembershipSufficientForSubmit: boolean;
  wordsRequiredForSubmit: boolean;
  absenceIsHardRejection: boolean;
  anchorEnforcementMode: "observe" | "enforce_high_confidence";
}

export function officialEnforcementReady(args: {
  baselineVerified: boolean;
  wordsSemantics: OfficialWordsSemantics;
  goodsContractMode: OfficialGoodsContractMode;
  anchorEnforcementMode: OfficialValidationPolicy["anchorEnforcementMode"];
}) {
  return args.baselineVerified
    && args.wordsSemantics !== "unknown"
    && args.goodsContractMode !== "unknown"
    && args.anchorEnforcementMode === "enforce_high_confidence";
}

export function officialWriteAllowed(mode: "disabled" | "observe" | "enforce" | "legacy", inputCoverageStatus?: "complete" | "partial_coverage" | "failed") {
  return (mode === "enforce" || mode === "legacy") && inputCoverageStatus === "complete";
}

export interface OfficialCandidateDecision {
  status: Exclude<OfficialValidationStatus, "not_started" | "pending">;
  reason: string;
  officialGoodsMatched: boolean;
  missingAnchorWords: string[];
}

export interface InputScanFacts {
  requestFailed?: boolean;
  schemaMismatch?: boolean;
  fetchedCount: number;
  remoteTotal?: number;
  remoteTotalKnown: boolean;
  fetchedPages: number;
  maxPages: number;
  pageSize: number;
  lastPageRowCount?: number;
  explicitLastPage?: boolean;
  limitReached?: boolean;
}

export interface InputScanCoverage {
  status: "complete" | "truncated" | "failed";
  nextPage?: number;
}

function uniqueNormalized(values: string[]) {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeEvidenceText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(String(value).trim());
  }
  return output;
}

function pathValue(root: unknown, path: string) {
  if (!path) return root;
  let current = root;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

export function parseOfficialWordsPayload(payload: unknown, paths: string[]) {
  const direct = Array.isArray(payload) ? payload : undefined;
  const mapped = direct || paths.map((path) => pathValue(payload, path)).find(Array.isArray);
  if (!mapped) return { found: false, words: [] as string[] };
  const words = uniqueNormalized(mapped.map((item) => {
    if (typeof item === "string" || typeof item === "number") return String(item);
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const record = item as Record<string, unknown>;
    return String(record.word || record.name || record.clue_word || record.clueWord || record.keyword || record.title || "");
  }));
  return { found: true, words };
}

export function parseOfficialGoodsPage(payload: unknown, listPaths: string[], totalPaths: string[]) {
  const direct = Array.isArray(payload) ? payload : undefined;
  const mapped = direct || listPaths.map((path) => pathValue(payload, path)).find(Array.isArray);
  let remoteTotal: number | undefined;
  for (const path of totalPaths) {
    remoteTotal = optionalNumber(pathValue(payload, path));
    if (remoteTotal !== undefined) break;
  }
  return {
    found: Boolean(mapped),
    rows: (mapped || []) as unknown[],
    remoteTotal: remoteTotal || 0,
    remoteTotalKnown: remoteTotal !== undefined
  };
}

export function parseOfficialBusinessStatus(payload: unknown, statusPaths: string[], successCodes: Array<string | number>) {
  const expected = new Set(successCodes.map((value) => String(value)));
  for (const path of statusPaths) {
    const value = pathValue(payload, path);
    if (value === undefined || value === null || value === "") continue;
    return { found: true, ok: expected.has(String(value)), code: String(value) };
  }
  return { found: false, ok: false, code: "" };
}

export function evaluateInputScanCoverage(facts: InputScanFacts): InputScanCoverage {
  if (facts.requestFailed || facts.schemaMismatch) return { status: "failed" };
  const totalComplete = facts.remoteTotalKnown
    && facts.remoteTotal !== undefined
    && facts.fetchedCount >= Math.max(0, facts.remoteTotal);
  const shortPageComplete = facts.fetchedPages > 0
    && facts.lastPageRowCount !== undefined
    && facts.lastPageRowCount < facts.pageSize;
  const declaredLastPage = Boolean(facts.explicitLastPage || shortPageComplete);
  const totalContradictsLastPage = facts.remoteTotalKnown
    && facts.remoteTotal !== undefined
    && facts.fetchedCount < Math.max(0, facts.remoteTotal)
    && declaredLastPage;
  if (totalContradictsLastPage) return { status: "failed" };
  if (totalComplete || (!facts.remoteTotalKnown && declaredLastPage)) return { status: "complete" };
  if (facts.limitReached || facts.fetchedPages >= facts.maxPages) return { status: "truncated", nextPage: facts.fetchedPages + 1 };
  return { status: "failed" };
}

export function validateOfficialCandidate(args: {
  title: string;
  clueName: string;
  productId: string;
  anchorWords?: string[];
  anchorConfidence?: "high" | "medium" | "none";
  words: OfficialClueWordsResult;
  goods: OfficialClueGoodsResult;
  policy: OfficialValidationPolicy;
}): OfficialCandidateDecision {
  const productId = String(args.productId || "").trim();
  const goodsMatched = args.goods.productIds.some((item) => String(item) === productId);
  const goodsMode = args.goods.contractMode || args.policy.goodsContractMode;
  if (args.goods.status === "complete" && !goodsMatched && goodsMode === "exhaustive" && args.policy.absenceIsHardRejection) {
    return { status: "rejected", reason: "official_goods_absent", officialGoodsMatched: false, missingAnchorWords: [] };
  }
  if (args.goods.status !== "complete") {
    return { status: "unknown", reason: `official_goods_${args.goods.status}`, officialGoodsMatched: false, missingAnchorWords: [] };
  }
  if (!goodsMatched) {
    return { status: "unknown", reason: "official_goods_contract_not_exhaustive", officialGoodsMatched: false, missingAnchorWords: [] };
  }

  const title = normalizeEvidenceText(args.title);
  const clueName = normalizeEvidenceText(args.clueName);
  const anchors = uniqueNormalized(args.anchorWords || []);
  const missingAnchors = anchors.filter((word) => !title.includes(normalizeEvidenceText(word)));
  const fullNameMatched = Boolean(clueName && title.includes(clueName));
  const anchorPolicyEnforced = args.policy.anchorEnforcementMode === "enforce_high_confidence";
  const hardAnchorRule = anchorPolicyEnforced && args.anchorConfidence === "high" && anchors.length > 0;
  if (missingAnchors.length && hardAnchorRule) {
    return { status: "rejected", reason: "title_anchor_missing", officialGoodsMatched: true, missingAnchorWords: missingAnchors };
  }
  if (anchorPolicyEnforced && !fullNameMatched && !hardAnchorRule) {
    return { status: "unknown", reason: "high_confidence_anchor_unavailable", officialGoodsMatched: true, missingAnchorWords: missingAnchors };
  }

  if (args.words.status === "failed" || args.words.status === "schema_mismatch") {
    return { status: "unknown", reason: `official_words_${args.words.status}`, officialGoodsMatched: true, missingAnchorWords: missingAnchors };
  }
  if (args.words.status === "no_terms") {
    if (args.policy.goodsMembershipSufficientForSubmit && !args.policy.wordsRequiredForSubmit) {
      return { status: "verified", reason: "official_goods_membership", officialGoodsMatched: true, missingAnchorWords: missingAnchors };
    }
    return { status: "unknown", reason: "official_words_no_terms", officialGoodsMatched: true, missingAnchorWords: missingAnchors };
  }

  const normalizedWords = uniqueNormalized(args.words.words).map(normalizeEvidenceText);
  const allAnchorsMatched = anchors.length > 0 && missingAnchors.length === 0;
  const alternativeMatched = normalizedWords.some((word) => title.includes(word));
  const conjunctiveMatched = normalizedWords.length > 0 && normalizedWords.every((word) => title.includes(word));
  const confirmedWordsPassed = args.words.semantics === "alternative_terms"
    ? alternativeMatched
    : args.words.semantics === "conjunctive_parts"
      ? conjunctiveMatched
      : false;
  if (fullNameMatched || allAnchorsMatched || confirmedWordsPassed) {
    return { status: "verified", reason: fullNameMatched ? "full_clue_name_matched" : allAnchorsMatched ? "required_anchors_matched" : "official_words_matched", officialGoodsMatched: true, missingAnchorWords: [] };
  }
  if (args.words.semantics === "unknown") {
    return { status: "unknown", reason: "official_words_semantics_unknown", officialGoodsMatched: true, missingAnchorWords: missingAnchors };
  }
  if (args.policy.wordsRequiredForSubmit && args.policy.anchorEnforcementMode === "enforce_high_confidence") {
    return { status: "rejected", reason: "official_words_not_matched", officialGoodsMatched: true, missingAnchorWords: missingAnchors };
  }
  return { status: "unknown", reason: "official_words_not_confirmed", officialGoodsMatched: true, missingAnchorWords: missingAnchors };
}

export function selectOfficialCandidateForProduct<T extends { validationStatus?: OfficialValidationStatus }>(candidates: T[]) {
  for (const candidate of candidates) {
    if (candidate.validationStatus === "verified") return candidate;
    if (candidate.validationStatus === "unknown" || candidate.validationStatus === "budget_exhausted") return candidate;
    if (candidate.validationStatus !== "rejected") return null;
  }
  return null;
}
