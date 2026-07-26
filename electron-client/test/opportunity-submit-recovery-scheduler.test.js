const assert = require("node:assert/strict");
const test = require("node:test");
const {
  automaticOpportunitySubmitRecoveryPendingTask,
  automaticOpportunitySubmitRecoveryTask,
  dueOpportunitySubmitRecoveryTasks,
  nextOpportunitySubmitRecoveryWakeAt
} = require("../src/main/tasks/opportunity-submit-recovery-scheduler");
const { opportunitySubmitOperationState } = require("../src/main/tasks/opportunity-submit-operation-state");

const NOW = Date.parse("2026-07-25T08:00:00.000Z");

test("automatic recovery selects only safe due submit task states", () => {
  const due = [
    { id: "ready", status: "ready" },
    { id: "queued", status: "queued" },
    { id: "running", status: "running", leaseExpiresAt: "2026-07-25T07:59:00.000Z" },
    { id: "cooling", status: "cooling_down", resumeAt: "2026-07-25T07:59:00.000Z" },
    { id: "auth", status: "deferred", deferredReason: "authorization_wait", resumeAt: "2026-07-25T07:59:00.000Z" },
    { id: "login", status: "deferred", deferredReason: "login_wait", resumeAt: "2026-07-25T07:59:00.000Z" },
    { id: "budget", status: "deferred", deferredReason: "throttle_budget", resumeAt: "2026-07-25T07:59:00.000Z" }
  ];
  for (const task of due) assert.equal(automaticOpportunitySubmitRecoveryTask(task, NOW), true, task.id);
  for (const task of [
    { id: "future", status: "cooling_down", resumeAt: "2026-07-25T08:01:00.000Z" },
    { id: "future-ready", status: "ready", resumeAt: "2026-07-25T08:01:00.000Z" },
    { id: "explicit", status: "deferred", deferredReason: "throttle_budget", requiresExplicitResume: true, resumeAt: "2026-07-25T07:59:00.000Z" },
    { id: "exhausted", status: "deferred", deferredReason: "retry_exhausted", resumeAt: "2026-07-25T07:59:00.000Z" },
    { id: "contract", status: "deferred_contract_mismatch" },
    { id: "manual", status: "manual_reconcile" },
    { id: "active", status: "running", leaseExpiresAt: "2026-07-25T08:01:00.000Z" }
  ]) assert.equal(automaticOpportunitySubmitRecoveryTask(task, NOW), false, task.id);
});

test("recovery queue excludes active runs and orders oldest due work first", () => {
  const tasks = [
    { id: "task-b", runId: "run-b", status: "ready", createdAt: "2026-07-25T07:58:00.000Z" },
    { id: "task-a", runId: "run-a", status: "cooling_down", resumeAt: "2026-07-25T07:57:00.000Z", createdAt: "2026-07-25T07:50:00.000Z" },
    { id: "task-active", runId: "run-active", status: "ready", createdAt: "2026-07-25T07:40:00.000Z" }
  ];
  assert.deepEqual(dueOpportunitySubmitRecoveryTasks(tasks, { nowMs: NOW, activeRunIds: new Set(["run-active"]) }).map((task) => task.id), ["task-a", "task-b"]);
});

test("recovery scheduler wakes at the earliest future lease or resume checkpoint", () => {
  const tasks = [
    { status: "ready", resumeAt: "2026-07-25T08:01:30.000Z" },
    { status: "cooling_down", resumeAt: "2026-07-25T08:03:00.000Z" },
    { status: "running", leaseExpiresAt: "2026-07-25T08:02:00.000Z" },
    { status: "deferred", deferredReason: "retry_exhausted", resumeAt: "2026-07-25T08:01:00.000Z" }
  ];
  assert.equal(nextOpportunitySubmitRecoveryWakeAt(tasks, NOW), Date.parse("2026-07-25T08:01:30.000Z"));
});

test("future cooling work remains pending even when it is not due yet", () => {
  assert.equal(automaticOpportunitySubmitRecoveryPendingTask({
    status: "cooling_down",
    resumeAt: "2026-07-25T08:03:00.000Z"
  }), true);
  assert.equal(automaticOpportunitySubmitRecoveryPendingTask({
    status: "deferred",
    deferredReason: "retry_exhausted",
    resumeAt: "2026-07-25T08:03:00.000Z"
  }), false);
});

test("source operation stays partial while recovery is pending and converges when tasks finish", () => {
  const run = {
    id: "run-1",
    runId: "run-1",
    operationId: "run-1",
    status: "partial",
    summary: {
      plannedSubmitCandidateCount: 10,
      submittedCount: 4,
      failedCount: 0,
      retryableRemainingCount: 6
    }
  };
  const recovering = opportunitySubmitOperationState({
    run,
    tasks: [{ status: "cooling_down", resumeAt: "2026-07-25T08:03:00.000Z" }],
    currentProgress: 95
  });
  assert.equal(recovering.status, "partial");
  assert.equal(recovering.progress, 95);
  assert.equal(recovering.result.summary.automaticRecoveryPendingCount, 1);
  assert.match(recovering.resultSummary, /后台恢复中/);

  const completed = opportunitySubmitOperationState({
    run: { ...run, status: "ok", summary: { ...run.summary, submittedCount: 10, retryableRemainingCount: 0 } },
    tasks: [{ status: "ok" }]
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.progress, 100);
  assert.equal(completed.result.summary.automaticRecoveryPendingCount, 0);
});
