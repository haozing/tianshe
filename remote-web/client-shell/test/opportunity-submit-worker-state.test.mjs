import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  activeSubmitTasksForRun,
  isActiveSubmitTaskStatus,
  submitWorkerProgress
} from "../src/domain/doudian/opportunity/submitWorkerState.ts";

test("submit worker detects every non-terminal queue state for the requested run", () => {
  const tasks = [
    { id: "a", runId: "run-1", status: "preparing" },
    { id: "b", runId: "run-1", status: "ready" },
    { id: "c", runId: "run-1", status: "queued" },
    { id: "d", runId: "run-1", status: "running" },
    { id: "e", runId: "run-1", status: "ok" },
    { id: "f", runId: "run-2", status: "ready" }
  ];

  assert.equal(isActiveSubmitTaskStatus("ready"), true);
  assert.equal(isActiveSubmitTaskStatus("failed"), false);
  assert.deepEqual(activeSubmitTasksForRun(tasks, "run-1").map((task) => task.id), ["a", "b", "c", "d"]);
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
  assert.match(bridge, /runnerAlive === true/);
});
