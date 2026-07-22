import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateInputScanCoverage,
  officialDecisionAllowsWrite,
  officialEnforcementReady,
  officialWriteAllowed,
  validateOfficialCandidate
} from "../src/domain/doudian/opportunity/officialValidation.ts";
import {
  groupEvidenceTerms,
  matchedEvidenceGroups,
  normalizeEvidenceText
} from "../src/domain/doudian/opportunity/matching/evidenceGrouping.ts";

const policy = {
  version: "test-policy-v1",
  goodsContractMode: "positive_only",
  goodsMembershipSufficientForSubmit: false,
  wordsRequiredForSubmit: true,
  absenceIsHardRejection: false,
  anchorEnforcementMode: "enforce_high_confidence"
};

test("enforce remains closed until contracts and high-confidence anchors are enabled", () => {
  const ready = {
    baselineVerified: true,
    wordsSemantics: "alternative_terms",
    goodsContractMode: "positive_only",
    anchorEnforcementMode: "enforce_high_confidence"
  };
  assert.equal(officialEnforcementReady(ready), true);
  assert.equal(officialEnforcementReady({ ...ready, baselineVerified: false }), false);
  assert.equal(officialEnforcementReady({ ...ready, wordsSemantics: "unknown" }), false);
  assert.equal(officialEnforcementReady({ ...ready, goodsContractMode: "unknown" }), false);
  assert.equal(officialEnforcementReady({ ...ready, anchorEnforcementMode: "observe" }), false);
  assert.equal(officialWriteAllowed("enforce", "complete"), true);
  assert.equal(officialWriteAllowed("enforce", "partial_coverage"), false);
  assert.equal(officialWriteAllowed("enforce", "failed"), false);
  assert.equal(officialWriteAllowed("observe", "complete"), true);
  assert.equal(officialWriteAllowed("observe", "partial_coverage", "report"), true);
  assert.equal(officialWriteAllowed("observe", "failed", "report"), false);
  assert.equal(officialWriteAllowed("disabled", "complete", "report"), false);
});

test("observe records official decisions without blocking locally ready candidates", () => {
  assert.equal(officialDecisionAllowsWrite({
    mode: "observe",
    writeEnabled: true,
    locallyEligible: true,
    localStatus: "ready",
    validationStatus: "unknown"
  }), true);
  assert.equal(officialDecisionAllowsWrite({
    mode: "observe",
    writeEnabled: true,
    locallyEligible: false,
    localStatus: "alternative",
    validationStatus: "verified"
  }), false);
  assert.equal(officialDecisionAllowsWrite({
    mode: "enforce",
    writeEnabled: true,
    locallyEligible: true,
    localStatus: "ready",
    validationStatus: "unknown"
  }), false);
  assert.equal(officialDecisionAllowsWrite({
    mode: "enforce",
    writeEnabled: true,
    locallyEligible: true,
    localStatus: "ready",
    validationStatus: "verified"
  }), true);
});

function words(overrides = {}) {
  return {
    status: "complete",
    words: ["帆布鞋"],
    source: "remote",
    semantics: "alternative_terms",
    clueId: "clue-1",
    requestCount: 1,
    cacheHit: false,
    requestHash: "request",
    responseHash: "response",
    contractVersion: "words-v1",
    ...overrides
  };
}

function goods(overrides = {}) {
  return {
    status: "complete",
    contractMode: "positive_only",
    shopId: "shop-1",
    clueId: "clue-1",
    productIds: ["product-1"],
    remoteTotal: 1,
    remoteTotalKnown: true,
    fetchedRowCount: 1,
    matchedRowCount: 1,
    fetchedPages: 1,
    requestCount: 1,
    cacheHit: false,
    requestHash: "request",
    responseHash: "response",
    contractVersion: "goods-v1",
    ...overrides
  };
}

test("overlapping clue terms form one evidence group", () => {
  const groups = groupEvidenceTerms(["帆布", "布鞋", "帆布鞋"]);
  assert.equal(groups.length, 1);
  assert.deepEqual(new Set(groups[0].normalizedMembers), new Set(["帆布", "布鞋", "帆布鞋"]));
  assert.equal(matchedEvidenceGroups(groups, ["帆布", "布鞋", "帆布鞋"]).length, 1);
});

test("normalization handles case, whitespace and full-width text", () => {
  assert.equal(normalizeEvidenceText(" ＴＣＭＡＤＥ\u3000帆布鞋 "), "tcmade帆布鞋");
});

test("missing high-confidence brand anchor is rejected", () => {
  const decision = validateOfficialCandidate({
    title: "春季透气帆布鞋",
    clueName: "tcmade帆布鞋",
    productId: "product-1",
    anchorWords: ["tcmade"],
    anchorConfidence: "high",
    words: words(),
    goods: goods(),
    policy
  });
  assert.equal(decision.status, "rejected");
  assert.equal(decision.reason, "title_anchor_missing");
});

test("missing validated Chinese qualifier anchor is rejected", () => {
  const decision = validateOfficialCandidate({
    title: "耐磨帆布鞋",
    clueName: "钢钉帆布鞋",
    productId: "product-1",
    anchorWords: ["钢钉"],
    anchorConfidence: "high",
    words: words({ words: ["钢钉", "帆布鞋"], semantics: "conjunctive_parts" }),
    goods: goods(),
    policy
  });
  assert.equal(decision.status, "rejected");
  assert.equal(decision.reason, "title_anchor_missing");
});

test("missing high-confidence anchor evidence remains unknown instead of accepting one alternative term", () => {
  const decision = validateOfficialCandidate({
    title: "耐磨帆布鞋",
    clueName: "钢钉帆布鞋",
    productId: "product-1",
    anchorWords: [],
    anchorConfidence: "medium",
    words: words({ words: ["钢钉", "帆布鞋"], semantics: "alternative_terms" }),
    goods: goods(),
    policy
  });
  assert.equal(decision.status, "unknown");
  assert.equal(decision.reason, "high_confidence_anchor_unavailable");
});

test("alternative and conjunctive word contracts are evaluated differently", () => {
  const base = {
    title: "透气帆布鞋",
    clueName: "夏季帆布鞋",
    productId: "product-1",
    words: words({ words: ["帆布鞋", "夏季"] }),
    goods: goods(),
    policy: { ...policy, anchorEnforcementMode: "observe" }
  };
  assert.equal(validateOfficialCandidate({ ...base, words: words({ words: ["帆布鞋", "夏季"], semantics: "alternative_terms" }) }).status, "verified");
  assert.equal(validateOfficialCandidate({ ...base, words: words({ words: ["帆布鞋", "夏季"], semantics: "conjunctive_parts" }) }).status, "unknown");
  assert.equal(validateOfficialCandidate({ ...base, words: words({ words: ["帆布鞋", "夏季"], semantics: "unknown" }) }).status, "unknown");
});

test("no official terms fail closed unless goods-only policy is explicit", () => {
  const input = {
    title: "透气帆布鞋",
    clueName: "帆布鞋",
    productId: "product-1",
    words: words({ status: "no_terms", words: [] }),
    goods: goods(),
    policy
  };
  assert.equal(validateOfficialCandidate(input).status, "unknown");
  assert.equal(validateOfficialCandidate({
    ...input,
    policy: { ...policy, wordsRequiredForSubmit: false, goodsMembershipSufficientForSubmit: true }
  }).status, "verified");
});

test("goods membership is positive evidence while absence needs an exhaustive contract", () => {
  const input = {
    title: "透气帆布鞋",
    clueName: "帆布鞋",
    productId: "product-1",
    words: words(),
    goods: goods({ productIds: [] }),
    policy
  };
  assert.equal(validateOfficialCandidate(input).status, "unknown");
  assert.equal(validateOfficialCandidate({
    ...input,
    goods: goods({ productIds: [], contractMode: "exhaustive" }),
    policy: { ...policy, goodsContractMode: "exhaustive", absenceIsHardRejection: true }
  }).status, "rejected");
});

test("failed and truncated official goods reads remain unknown", () => {
  for (const status of ["failed", "truncated", "schema_mismatch"]) {
    const decision = validateOfficialCandidate({
      title: "透气帆布鞋",
      clueName: "帆布鞋",
      productId: "product-1",
      words: words(),
      goods: goods({ status }),
      policy
    });
    assert.equal(decision.status, "unknown");
  }
});

test("scan coverage does not treat an unknown total at the page limit as complete", () => {
  assert.deepEqual(evaluateInputScanCoverage({
    fetchedCount: 1000,
    remoteTotalKnown: false,
    fetchedPages: 10,
    maxPages: 10,
    pageSize: 100,
    lastPageRowCount: 100
  }), { status: "truncated", nextPage: 11 });
  assert.equal(evaluateInputScanCoverage({
    fetchedCount: 1000,
    remoteTotal: 2436,
    remoteTotalKnown: true,
    fetchedPages: 10,
    maxPages: 10,
    pageSize: 100,
    lastPageRowCount: 100
  }).status, "truncated");
  assert.equal(evaluateInputScanCoverage({
    fetchedCount: 87,
    remoteTotalKnown: false,
    fetchedPages: 1,
    maxPages: 10,
    pageSize: 100,
    lastPageRowCount: 87
  }).status, "complete");
  assert.equal(evaluateInputScanCoverage({
    fetchedCount: 87,
    remoteTotal: 2436,
    remoteTotalKnown: true,
    fetchedPages: 1,
    maxPages: 10,
    pageSize: 100,
    lastPageRowCount: 87
  }).status, "failed");
});
