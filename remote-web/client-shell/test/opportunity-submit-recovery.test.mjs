import assert from "node:assert/strict";
import test from "node:test";

import {
  isUnresolvedSubmitState,
  logicalSubmitAttemptId,
  recoverUnresolvedSubmitCandidate
} from "../src/domain/doudian/opportunity/submitRecovery.ts";

test("sending recovery preserves a stable attempt id and becomes unknown", () => {
  const candidate = { id: "candidate-1", productId: "product-1", status: "submitting", submitStatus: "sending" };
  const attemptId = logicalSubmitAttemptId("run-1", candidate);
  const recovered = recoverUnresolvedSubmitCandidate(candidate, {
    runId: "run-1",
    reason: "submit_result_unresolved_after_worker_recovery",
    updatedAt: "2026-07-21T00:00:00.000Z"
  });

  assert.equal(isUnresolvedSubmitState(candidate), true);
  assert.equal(isUnresolvedSubmitState({ status: "accepted" }), false);
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.submitStatus, "unknown");
  assert.equal(recovered.submitAttemptId, attemptId);
  assert.equal(recovered.eligible, false);
});

test("sending recovery never replaces an already persisted attempt id", () => {
  const recovered = recoverUnresolvedSubmitCandidate({
    id: "candidate-1",
    productId: "product-1",
    submitAttemptId: "persisted-attempt"
  }, {
    runId: "run-1",
    reason: "recovered",
    updatedAt: "2026-07-21T00:00:00.000Z"
  });
  assert.equal(recovered.submitAttemptId, "persisted-attempt");
});
