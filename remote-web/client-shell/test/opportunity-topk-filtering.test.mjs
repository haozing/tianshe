import assert from "node:assert/strict";
import test from "node:test";

import { boundedProductCandidateLimit, rankCandidatesAfterFiltering } from "../src/domain/doudian/opportunity/matching/topKSelector.ts";

test("per-product candidates are bounded independently from the store quota", () => {
  assert.equal(boundedProductCandidateLimit(10, 5), 5);
  assert.equal(boundedProductCandidateLimit(2, 5), 2);
  assert.equal(boundedProductCandidateLimit(1000, 20), 20);
});

test("filters submitted associations before final Top-K ranking", () => {
  const candidates = [
    { id: "submitted", matchScore: 99, clueName: "already submitted" },
    { id: "promoted", matchScore: 90, clueName: "next eligible" },
    { id: "alternative", matchScore: 80, clueName: "later eligible" }
  ];
  const result = rankCandidatesAfterFiltering(candidates, {
    limit: 2,
    skipReason: (candidate) => candidate.id === "submitted" ? "already_submitted" : ""
  });

  assert.deepEqual(result.ranked.map((item) => [item.candidate.id, item.rankForProduct]), [
    ["promoted", 1],
    ["alternative", 2]
  ]);
  assert.deepEqual(result.skipped.map((item) => item.candidate.id), ["submitted"]);
});
