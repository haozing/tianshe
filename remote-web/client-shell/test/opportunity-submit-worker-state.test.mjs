import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  activeSubmitTasksForRun,
  canSupersedeContractMismatchTask,
  hasRemainingLegacySubmitWork,
  isDeferredSubmitTaskStatus,
  isActiveSubmitTaskStatus,
  orphanedSubmitQueueStoreRuns,
  submitWorkerProgress
} from "../src/domain/doudian/opportunity/submitWorkerState.ts";

test("only settled contract-mismatch tasks can be superseded by a new run", () => {
  assert.equal(canSupersedeContractMismatchTask({
    status: "deferred_contract_mismatch",
    unknownCount: 0
  }, { pending: 0, unknown: 0 }), true);
  assert.equal(canSupersedeContractMismatchTask({
    status: "deferred_contract_mismatch",
    unknownCount: 1
  }, { pending: 0, unknown: 0 }), false);
  assert.equal(canSupersedeContractMismatchTask({
    status: "deferred_contract_mismatch",
    inFlightAttemptId: "attempt-1"
  }, { pending: 0, unknown: 0 }), false);
  assert.equal(canSupersedeContractMismatchTask({
    status: "deferred_contract_mismatch"
  }, { pending: 1, unknown: 0 }), false);
  assert.equal(canSupersedeContractMismatchTask({
    status: "manual_reconcile"
  }, { pending: 0, unknown: 0 }), false);
});

test("orphaned submit queues require both queued state and a missing task", () => {
  const storeRuns = [
    { id: "orphan", status: "queued", phase: "submit-queued" },
    { id: "attached", status: "queued", phase: "submit-queued" },
    { id: "preparing", status: "running", phase: "clue-load" },
    { id: "finished", status: "failed", phase: "finished" }
  ];
  assert.deepEqual(
    orphanedSubmitQueueStoreRuns(storeRuns, [{ storeRunId: "attached" }]).map((item) => item.id),
    ["orphan"]
  );
});

test("submit worker detects every non-terminal queue state for the requested run", () => {
  const tasks = [
    { id: "a", runId: "run-1", status: "preparing" },
    { id: "b", runId: "run-1", status: "ready" },
    { id: "c", runId: "run-1", status: "queued" },
    { id: "d", runId: "run-1", status: "running" },
    { id: "e", runId: "run-1", status: "cooling_down" },
    { id: "g", runId: "run-1", status: "cancelling" },
    { id: "h", runId: "run-1", status: "deferred" },
    { id: "i", runId: "run-1", status: "ok" },
    { id: "f", runId: "run-2", status: "ready" }
  ];

  assert.equal(isActiveSubmitTaskStatus("ready"), true);
  assert.equal(isActiveSubmitTaskStatus("failed"), false);
  assert.equal(isDeferredSubmitTaskStatus("deferred"), true);
  assert.equal(isDeferredSubmitTaskStatus("cooling_down"), false);
  assert.deepEqual(activeSubmitTasksForRun(tasks, "run-1").map((task) => task.id), ["a", "b", "c", "d", "e", "g"]);
});

test("legacy submit pacing skips the tail delay after the final sendable batch", () => {
  const candidates = [
    { id: "done", eligible: true, status: "ready" },
    { id: "terminal", eligible: false, status: "failed" }
  ];
  assert.equal(hasRemainingLegacySubmitWork(candidates, new Set(["done"])), false);
  assert.equal(hasRemainingLegacySubmitWork([
    ...candidates,
    { id: "next", eligible: true, status: "ready" }
  ], new Set(["done"])), true);
});

test("submit worker progress remains inside the worker phase", () => {
  assert.equal(submitWorkerProgress(0, 100), 83);
  assert.equal(submitWorkerProgress(50, 100), 88);
  assert.equal(submitWorkerProgress(100, 100), 94);
  assert.equal(submitWorkerProgress(200, 100), 94);
});

test("pipeline worker waits for the active worker and stale runners are not restored", async () => {
  const [domain, bridge] = await Promise.all([
    readFile(new URL("../src/domain/doudian/opportunityReport.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/bridge/client.ts", import.meta.url), "utf8")
  ]);

  assert.match(domain, /pipelineSubmitWorkerTail[\s\S]*\.then\(\(\) => executeSubmitWorker/);
  assert.doesNotMatch(domain, /pipelineSubmitWorkerRunning|reason:\s*"worker-running"/);
  assert.match(domain, /activeSubmitTasksForRun\(submitTasksAfterWorker, runId\)/);
  assert.match(domain, /shouldCancel,[\s\S]*beginMutation,[\s\S]*endMutation/);
  assert.match(domain, /beginMutation:\s*args\.beginMutation,[\s\S]*endMutation:\s*args\.endMutation/);
  assert.match(domain, /recoverCoordinatedInFlightAttempt/);
  assert.match(domain, /coordinator\.releaseReservation\([\s\S]*responseClass:\s*"worker-recovery-dispatched-unknown"/);
  assert.match(domain, /coordinated && task\.inFlightAttemptId/);
  assert.match(domain, /pipeline-submit-task-superseded/);
  assert.match(domain, /task && task\.runId !== runId/);
  assert.match(domain, /pipeline-submit-orphaned-store-run-repaired/);
  assert.match(domain, /loadPipelineSubmitTasksForRunStrict\(runId\)/);
  assert.match(domain, /orphanedSubmitQueueRepairCount/);
  assert.match(bridge, /runnerAlive === true/);
});

test("submit worker uses two store slots and isolates rate limits by store", async () => {
  const [domain, adapterText, marketingAdapterText] = await Promise.all([
    readFile(new URL("../src/domain/doudian/opportunityReport.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/config/doudian-adapter.json", import.meta.url), "utf8"),
    readFile(new URL("../public/config/doudian-adapter.marketing-pilot.json", import.meta.url), "utf8")
  ]);
  const adapters = [JSON.parse(adapterText), JSON.parse(marketingAdapterText)];

  for (const adapter of adapters) {
    const policy = adapter.policies.opportunityReport;
    const requestPlan = adapter.requestPlans.opportunitySubmitClue;
    assert.equal(policy.submitTaskConcurrency, 2);
    assert.equal(policy.submitRetryLimit, 3);
    assert.equal(policy.submitRetryDelayMs, 10_000);
    assert.equal(policy.submitPacingMode, "adaptive");
    assert.equal(policy.submitPacingInitialIntervalMs, 15_000);
    assert.equal(policy.submitDailyHttpRequestLimit, 1_000);
    assert.equal(policy.submitRetryExhaustedAutoResume, false);
    assert.equal(policy.submitThrottleRecoveryEnabled, false);
    assert.equal(policy.submitPipelineStreamingEnabled, false);
    assert.equal(policy.submitHistoryPrewarmEnabled, false);
    assert.equal(policy.stopStoreOnSubmitFrequency, true);
    assert.equal(requestPlan.retryOnHttpError, false);
    assert.equal(requestPlan.maxAttempts, 1);
  }
  assert.match(domain, /const runWorkerSlot = async \(workerSlot: number\)/);
  assert.match(domain, /Promise\.all\(Array\.from\(\{ length: slotCount \}/);
  assert.match(domain, /maxAttempts:\s*1/);
  assert.match(domain, /pipeline-submit-retry-waiting/);
  assert.match(domain, /otherStoreTasksContinue:\s*slotCount > 1/);
  assert.match(domain, /otherStoreWorkersBlocked:\s*false/);
  assert.match(domain, /rateLimitScope:\s*"store-only"/);
  assert.match(domain, /scheduleStreamingSubmitWorker\(\)/);
  assert.match(domain, /Promise\.all\(streamingWorkerRuns\)/);
  assert.match(domain, /hasRemainingLegacySubmitWork\(taskCandidates, processedCandidateIds\)/);
});
