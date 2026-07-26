import assert from "node:assert/strict";
import test from "node:test";

import { classifyCoordinatedSubmitAttempt } from "../src/domain/doudian/opportunity/submitAttemptClassifier.ts";

const candidates = [
  { candidateId: "candidate-1", productId: "product-1" },
  { candidateId: "candidate-2", productId: "product-2" }
];

test("coordinated submit classifies 429 as a retryable logical group", () => {
  const result = classifyCoordinatedSubmitAttempt({ accepted: false, httpStatus: 429, message: "rate limited", candidates });
  assert.equal(result.outcome, "throttled");
  assert.deepEqual(result.candidateResults?.map((item) => item.status), ["retry_waiting", "retry_waiting"]);
});

test("coordinated submit preserves partial candidate failures without assuming success", () => {
  const result = classifyCoordinatedSubmitAttempt({
    accepted: false,
    httpStatus: 200,
    message: "[product-1] rejected",
    candidates,
    failureMessages: new Map([["product-1", "rejected"]])
  });
  assert.equal(result.outcome, "partial");
  assert.deepEqual(result.candidateResults, [
    { candidateId: "candidate-1", status: "failed", message: "rejected" },
    { candidateId: "candidate-2", status: "unknown", message: "batch response did not confirm this candidate" }
  ]);
});

test("risk verification is manual reconciliation rather than short throttle recovery", () => {
  const result = classifyCoordinatedSubmitAttempt({
    accepted: false,
    httpStatus: 200,
    message: "environment verification required",
    candidates,
    frequencyLimited: true,
    manualInterventionRequired: true
  });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.responseClass, "manual-intervention");
});
