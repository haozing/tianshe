import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSubmitConcurrencyReadiness } from "../src/domain/doudian/opportunity/submitConcurrencyReadiness.ts";

function stableRun(runId, overrides = {}) {
  return {
    runId,
    status: "ok",
    createdAt: `2026-07-2${runId.endsWith("1") ? "4" : "5"}T00:00:00.000Z`,
    updatedAt: `2026-07-2${runId.endsWith("1") ? "4" : "5"}T00:10:00.000Z`,
    summary: {
      submitTaskConcurrency: 2,
      totalStoreCount: 3,
      httpRequestAttemptCount: 30,
      throttleCount: 1,
      globalThrottleCount: 0,
      submitPacingInitialIntervalMs: 15000,
      averageStoreIntervalMs: 16000,
      globalRateMode: 0,
      effectiveCompletionPerMinute: 12,
      ...overrides
    }
  };
}

test("two stable multi-store concurrency-2 runs become eligible for a concurrency-3 canary", () => {
  const first = stableRun("run-1");
  const second = stableRun("run-2", { effectiveCompletionPerMinute: 11.5 });
  const evaluation = evaluateSubmitConcurrencyReadiness(second, [first]);
  assert.equal(evaluation.decision, "eligible_for_canary_3");
  assert.equal(evaluation.stableRunCount, 2);
  assert.deepEqual(evaluation.evaluatedRunIds, ["run-1", "run-2"]);
});

test("unfinished or unsafe baseline work keeps concurrency at two", () => {
  const first = stableRun("run-1");
  const second = stableRun("run-2", { unknownCount: 1 });
  const evaluation = evaluateSubmitConcurrencyReadiness(second, [first]);
  assert.equal(evaluation.decision, "hold_at_2");
  assert.match(evaluation.reasons.join(" "), /unknown_results/);
});

test("a concurrency-3 canary recommends rollback when global throttling increases", () => {
  const baselines = [stableRun("run-1"), stableRun("run-2")];
  const canary = stableRun("run-3", {
    submitTaskConcurrency: 3,
    globalThrottleCount: 2,
    throttleCount: 2
  });
  const evaluation = evaluateSubmitConcurrencyReadiness(canary, baselines);
  assert.equal(evaluation.decision, "rollback_to_2");
  assert.match(evaluation.reasons.join(" "), /global_throttle_increased/);
});
