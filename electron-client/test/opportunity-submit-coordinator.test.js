const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NativeDataService } = require("../src/main/database");

const POLICY = {
  policyVersion: "opportunity-submit-adaptive-v1",
  initialIntervalMs: 15000,
  minIntervalMs: 10000,
  maxIntervalMs: 60000,
  jitterMs: 0,
  successesToDecrease: 4,
  decreaseMs: 5000,
  isolated429IncreaseMs: 5000,
  multiplier429: 1.5,
  maxCooldownMs: 120000,
  idleResetMs: 600000,
  globalBurstSpacingMs: 500,
  globalInitialMs: 15000,
  globalMaxMs: 60000,
  globalMultiplier429: 1.5,
  globalDecreaseMs: 5000,
  global429WindowMs: 120000,
  globalDistinctStores: 2,
  globalStableWindowsToExit: 2,
  retryLimit: 3
};

const CONTRACT = {
  releaseId: "release-submit-v1",
  releaseManifestHash: "manifest-hash-v1",
  runnerArtifactHash: "runner-hash-v1",
  adapterVersion: "adapter-v1",
  scriptsVersion: "scripts-v1",
  requestPlanHash: "request-plan-v1",
  submitContractVersion: "opportunity-submit-contract-v1",
  pacingPolicyHash: "pacing-policy-v1",
  adapterSnapshotHash: "adapter-snapshot-v1"
};

function at(base, seconds) {
  return new Date(Date.parse(base) + seconds * 1000).toISOString();
}

async function createStore(service, shopId) {
  const result = await service.request("records.put", {
    storeName: "stores",
    record: {
      id: shopId,
      shopId,
      shopName: `Store ${shopId}`,
      platform: "doudian",
      partition: `persist:${shopId}`,
      status: "online"
    }
  });
  return {
    tenantId: "local-user",
    shopId,
    shopName: `Store ${shopId}`,
    storeGeneration: result.record.storeGeneration
  };
}

async function createTask(service, identity, suffix, createdAt, candidateCount = 2) {
  const runId = `run-${suffix}`;
  const storeRunId = `${runId}-${identity.tenantId}-${identity.shopId}-${identity.storeGeneration}`;
  const taskId = `${storeRunId}-task-1`;
  const candidateIds = Array.from({ length: candidateCount }, (_, index) => `${taskId}-candidate-${index + 1}`);
  await service.request("records.put", {
    storeName: "opportunity_pipeline_submit_tasks_v2",
    record: {
      id: taskId,
      runId,
      storeRunId,
      ...identity,
      ...CONTRACT,
      status: "queued",
      concurrencyKey: `${identity.tenantId}-${identity.shopId}-${identity.storeGeneration}`,
      candidateIds,
      candidateCount: candidateIds.length,
      submittedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      submitThrottleRecoveryEnabled: true,
      createdAt,
      updatedAt: createdAt
    }
  });
  await service.request("records.putMany", {
    storeName: "opportunity_pipeline_candidates_v2",
    records: candidateIds.map((id, index) => ({
      id,
      runId,
      storeRunId,
      submitTaskId: taskId,
      ...identity,
      clueId: `clue-${suffix}`,
      productId: `product-${suffix}-${index + 1}`,
      relationKey: `${identity.shopId}::clue-${suffix}::product-${suffix}-${index + 1}`,
      clueKey: `${identity.shopId}::clue-${suffix}`,
      clueCategoryKey: `${identity.shopId}::category-${suffix}`,
      status: "ready",
      submitStatus: "queued",
      eligible: true,
      estimatedCost: 1,
      createdAt,
      updatedAt: createdAt
    })),
    omitRecords: true
  });
  return { runId, storeRunId, taskId, candidateIds, clueId: `clue-${suffix}` };
}

async function claimScheduler(service, ownerId, now, leaseSeconds = 3600) {
  const result = await service.request("opportunitySubmit.claimSchedulerLease", {
    tenantId: "local-user",
    endpointContract: "opportunitySubmitClue",
    ownerId,
    now,
    leaseExpiresAt: at(now, leaseSeconds)
  });
  assert.equal(result.claimed, true);
  return result.lease;
}

async function claimTask(service, taskId, ownerRunId, now, leaseSeconds = 600) {
  const result = await service.request("records.claimOpportunitySubmitTask", {
    taskId,
    ownerRunId,
    now,
    leaseExpiresAt: at(now, leaseSeconds)
  });
  assert.equal(result.claimed, true, result.reason);
  return result.task;
}

function coordinatorFence(task, scheduler) {
  return {
    ownerRunId: task.ownerRunId,
    fencingToken: task.fencingToken,
    schedulerOwnerId: scheduler.ownerId,
    schedulerFencingToken: scheduler.fencingToken
  };
}

function requestBody(task, clueId) {
  return {
    clue_id: clueId,
    products: task.candidateIds.map((candidateId) => ({ product_id: candidateId }))
  };
}

test("scheduler lease release preserves monotonic fencing and allows immediate takeover", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-scheduler-release-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T00:00:00.000Z";
  const first = await claimScheduler(service, "scheduler-a", base);
  const released = await service.request("opportunitySubmit.releaseSchedulerLease", {
    tenantId: "local-user",
    endpointContract: "opportunitySubmitClue",
    ownerId: first.ownerId,
    fencingToken: first.fencingToken,
    now: at(base, 1)
  });
  assert.equal(released.released, true);

  const second = await claimScheduler(service, "scheduler-b", at(base, 2));
  assert.equal(second.fencingToken, first.fencingToken + 1);
  const staleRelease = await service.request("opportunitySubmit.releaseSchedulerLease", {
    tenantId: "local-user",
    endpointContract: "opportunitySubmitClue",
    ownerId: first.ownerId,
    fencingToken: first.fencingToken,
    now: at(base, 3)
  });
  assert.equal(staleRelease.released, false);
  assert.equal(staleRelease.reason, "stale-fence");
});

test("submit coordinator persists pacing, quota, retry groups, and fencing across claims", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-coordinator-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T00:00:00.000Z";
  const scheduler = await claimScheduler(service, "scheduler-a", base);
  const identityA = await createStore(service, "shop-a");
  const taskARef = await createTask(service, identityA, "a", base);
  let taskA = await claimTask(service, taskARef.taskId, "worker-a-1", at(base, 1));
  const firstAdmission = await service.request("opportunitySubmit.admit", {
    taskId: taskA.id,
    ...coordinatorFence(taskA, scheduler),
    now: at(base, 2),
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    clueId: taskARef.clueId,
    candidateIds: taskARef.candidateIds,
    requestBody: requestBody(taskA, taskARef.clueId),
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  assert.equal(firstAdmission.admitted, true);
  assert.equal(firstAdmission.attempt.attemptOrdinal, 1);

  const reservedUsage = await service.request("opportunitySubmit.getQuotaUsage", {
    businessDate: "2026-07-25",
    tenantId: "local-user",
    shopId: identityA.shopId,
    endpointContract: "opportunitySubmitClue"
  });
  assert.deepEqual({ candidateReserved: reservedUsage.candidateReserved, candidateDispatched: reservedUsage.candidateDispatched, httpReserved: reservedUsage.httpReserved, httpDispatched: reservedUsage.httpDispatched }, {
    candidateReserved: 2,
    candidateDispatched: 0,
    httpReserved: 1,
    httpDispatched: 0
  });

  const firstDispatch = await service.request("opportunitySubmit.consumeHttpGrant", {
    taskId: taskA.id,
    attemptId: firstAdmission.attempt.attemptId,
    httpGrantId: firstAdmission.attempt.httpGrantId,
    ...coordinatorFence(taskA, scheduler),
    now: at(base, 3)
  });
  assert.equal(firstDispatch.task.candidateMutationAttemptCount, 2);
  assert.equal(firstDispatch.task.httpRequestAttemptCount, 1);
  assert.equal(firstDispatch.quota.candidateDispatched, 2);
  assert.equal(firstDispatch.quota.httpDispatched, 1);
  await assert.rejects(() => service.request("opportunitySubmit.consumeHttpGrant", {
    taskId: taskA.id,
    attemptId: firstAdmission.attempt.attemptId,
    httpGrantId: firstAdmission.attempt.httpGrantId,
    ...coordinatorFence(taskA, scheduler),
    now: at(base, 4)
  }), /already consumed|missing, stale/);

  const dispatchedUsage = await service.request("opportunitySubmit.getQuotaUsage", {
    businessDate: "2026-07-25",
    tenantId: "local-user",
    shopId: identityA.shopId,
    endpointContract: "opportunitySubmitClue"
  });
  assert.deepEqual({ candidateReserved: dispatchedUsage.candidateReserved, candidateDispatched: dispatchedUsage.candidateDispatched, httpReserved: dispatchedUsage.httpReserved, httpDispatched: dispatchedUsage.httpDispatched }, {
    candidateReserved: 0,
    candidateDispatched: 2,
    httpReserved: 0,
    httpDispatched: 1
  });

  const throttled = await service.request("opportunitySubmit.resolve", {
    taskId: taskA.id,
    attemptId: firstAdmission.attempt.attemptId,
    ...coordinatorFence(taskA, scheduler),
    now: at(base, 5),
    outcome: "throttled",
    httpStatus: 429,
    responseClass: "http_429",
    message: "rate limited",
    retryAfterMs: 30000,
    policy: POLICY
  });
  assert.equal(throttled.task.status, "cooling_down");
  assert.equal(throttled.group.status, "retry_waiting");
  assert.equal(throttled.rate.store.intervalMs, 20000);
  assert.equal(throttled.rate.global.mode, "inactive");
  assert.equal((await service.request("records.get", { storeName: "opportunity_pipeline_candidates_v2", id: taskARef.candidateIds[0] })).submitStatus, "retry_waiting");
  const throttledCandidate = await service.request("records.get", {
    storeName: "opportunity_pipeline_candidates_v2",
    id: taskARef.candidateIds[0]
  });
  await service.request("records.put", {
    storeName: "opportunity_pipeline_candidates_v2",
    record: { ...throttledCandidate, skipReason: "stale parser error" }
  });

  const earlyClaim = await service.request("records.claimOpportunitySubmitTask", {
    taskId: taskA.id,
    ownerRunId: "worker-a-early",
    now: at(base, 20),
    leaseExpiresAt: at(base, 200)
  });
  assert.equal(earlyClaim.claimed, false);
  assert.equal(earlyClaim.reason, "not-claimable");

  taskA = await claimTask(service, taskA.id, "worker-a-2", throttled.resumeAt);
  const retryAdmission = await service.request("opportunitySubmit.admit", {
    taskId: taskA.id,
    ...coordinatorFence(taskA, scheduler),
    now: throttled.resumeAt,
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    logicalGroupId: firstAdmission.group.id,
    clueId: taskARef.clueId,
    candidateIds: taskARef.candidateIds,
    requestBody: requestBody(taskA, taskARef.clueId),
    requestBodyHash: firstAdmission.group.requestBodyHash,
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  assert.equal(retryAdmission.admitted, true);
  assert.equal(retryAdmission.group.id, firstAdmission.group.id);
  assert.equal(retryAdmission.attempt.attemptOrdinal, 2);
  await service.request("opportunitySubmit.consumeHttpGrant", {
    taskId: taskA.id,
    attemptId: retryAdmission.attempt.attemptId,
    httpGrantId: retryAdmission.attempt.httpGrantId,
    ...coordinatorFence(taskA, scheduler),
    now: at(throttled.resumeAt, 1)
  });
  const accepted = await service.request("opportunitySubmit.resolve", {
    taskId: taskA.id,
    attemptId: retryAdmission.attempt.attemptId,
    ...coordinatorFence(taskA, scheduler),
    now: at(throttled.resumeAt, 2),
    outcome: "accepted",
    httpStatus: 200,
    responseClass: "accepted",
    policy: POLICY
  });
  assert.equal(accepted.task.status, "ok");
  assert.equal(accepted.task.submittedCount, 2);
  assert.equal(accepted.task.remoteRequestCount, 2);
  assert.equal(accepted.task.candidateMutationAttemptCount, 4);
  assert.equal(accepted.task.httpRequestAttemptCount, 2);
  assert.equal(accepted.rate.store.intervalMs, 20000);
  assert.equal(accepted.rate.store.consecutiveSuccesses, 1);
  const acceptedCandidate = await service.request("records.get", {
    storeName: "opportunity_pipeline_candidates_v2",
    id: taskARef.candidateIds[0]
  });
  assert.equal(acceptedCandidate.skipReason, undefined);

  const runSummary = await service.request("opportunitySubmit.summarizeRun", {
    runId: taskARef.runId,
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  assert.equal(runSummary.throttleCount, 1);
  assert.equal(runSummary.recoveredAfterThrottleCount, 1);
  assert.equal(runSummary.candidateMutationAttemptCount, 4);
  assert.equal(runSummary.httpRequestAttemptCount, 2);
  assert.equal(runSummary.maxStoreIntervalMs, 20000);
  assert.equal(runSummary.averageStoreIntervalMs, 20000);
  assert.equal(runSummary.globalRateMode, "inactive");
  assert.equal(runSummary.dailyCandidateMutationRemaining, 996);
  assert.equal(runSummary.dailyHttpRequestRemaining, 998);

  const identityB = await createStore(service, "shop-b");
  const taskBRef = await createTask(service, identityB, "b", at(base, 40), 1);
  const taskB = await claimTask(service, taskBRef.taskId, "worker-b-1", at(base, 45));
  const admissionB = await service.request("opportunitySubmit.admit", {
    taskId: taskB.id,
    ...coordinatorFence(taskB, scheduler),
    now: at(base, 60),
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    clueId: taskBRef.clueId,
    candidateIds: taskBRef.candidateIds,
    requestBody: requestBody(taskB, taskBRef.clueId),
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  await service.request("opportunitySubmit.consumeHttpGrant", {
    taskId: taskB.id,
    attemptId: admissionB.attempt.attemptId,
    httpGrantId: admissionB.attempt.httpGrantId,
    ...coordinatorFence(taskB, scheduler),
    now: at(base, 61)
  });
  const throttledB = await service.request("opportunitySubmit.resolve", {
    taskId: taskB.id,
    attemptId: admissionB.attempt.attemptId,
    ...coordinatorFence(taskB, scheduler),
    now: at(base, 62),
    outcome: "throttled",
    httpStatus: 429,
    responseClass: "http_429",
    policy: POLICY
  });
  assert.equal(throttledB.rate.global.mode, "protective");
  assert.deepEqual(throttledB.rate.global.rolling429Buckets[0].shopIds.sort(), ["shop-a", "shop-b"]);
});

test("submit coordinator protects old non-terminal tasks and releases unused reservations", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-reservation-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T02:00:00.000Z";
  const identity = await createStore(service, "shop-reservation");
  const oldTaskRef = await createTask(service, identity, "old", base, 1);
  await service.request("records.put", {
    storeName: "opportunity_pipeline_submit_tasks_v2",
    record: {
      ...(await service.request("records.get", { storeName: "opportunity_pipeline_submit_tasks_v2", id: oldTaskRef.taskId })),
      status: "deferred",
      deferredReason: "authorization_wait",
      resumeAt: at(base, 3600),
      updatedAt: at(base, 1)
    }
  });
  const newTaskRef = await createTask(service, identity, "new", at(base, 2), 1);
  const blocked = await service.request("records.claimOpportunitySubmitTask", {
    taskId: newTaskRef.taskId,
    ownerRunId: "new-worker",
    now: at(base, 3),
    leaseExpiresAt: at(base, 600)
  });
  assert.equal(blocked.claimed, false);
  assert.equal(blocked.reason, "concurrency-nonterminal");
  assert.equal(blocked.task.id, oldTaskRef.taskId);

  await service.request("records.put", {
    storeName: "opportunity_pipeline_submit_tasks_v2",
    record: {
      ...(await service.request("records.get", { storeName: "opportunity_pipeline_submit_tasks_v2", id: oldTaskRef.taskId })),
      status: "cancelled",
      finishedAt: at(base, 4),
      updatedAt: at(base, 4)
    }
  });
  const scheduler = await claimScheduler(service, "scheduler-release", at(base, 5));
  const task = await claimTask(service, newTaskRef.taskId, "release-worker", at(base, 6), 5);
  const admission = await service.request("opportunitySubmit.admit", {
    taskId: task.id,
    ...coordinatorFence(task, scheduler),
    now: at(base, 7),
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    clueId: newTaskRef.clueId,
    candidateIds: newTaskRef.candidateIds,
    requestBody: requestBody(task, newTaskRef.clueId),
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  assert.equal(admission.admitted, true);
  const beforeRelease = await service.request("opportunitySubmit.getQuotaUsage", {
    businessDate: "2026-07-25",
    tenantId: "local-user",
    shopId: identity.shopId,
    endpointContract: "opportunitySubmitClue"
  });
  assert.equal(beforeRelease.candidateReserved, 1);
  assert.equal(beforeRelease.httpReserved, 1);
  const recoveredTask = await claimTask(service, newTaskRef.taskId, "recovery-worker", at(base, 12));
  assert.equal(recoveredTask.fencingToken, task.fencingToken + 1);
  await assert.rejects(() => service.request("opportunitySubmit.releaseReservation", {
    taskId: task.id,
    attemptId: admission.attempt.attemptId,
    ...coordinatorFence(task, scheduler),
    now: at(base, 13)
  }), /fence is stale/);
  const released = await service.request("opportunitySubmit.releaseReservation", {
    taskId: recoveredTask.id,
    attemptId: admission.attempt.attemptId,
    ...coordinatorFence(recoveredTask, scheduler),
    now: at(base, 14)
  });
  assert.equal(released.task.status, "ready");
  assert.equal(released.group.status, "ready");
  const afterRelease = await service.request("opportunitySubmit.getQuotaUsage", {
    businessDate: "2026-07-25",
    tenantId: "local-user",
    shopId: identity.shopId,
    endpointContract: "opportunitySubmitClue"
  });
  assert.deepEqual({ candidateReserved: afterRelease.candidateReserved, candidateDispatched: afterRelease.candidateDispatched, httpReserved: afterRelease.httpReserved, httpDispatched: afterRelease.httpDispatched }, {
    candidateReserved: 0,
    candidateDispatched: 0,
    httpReserved: 0,
    httpDispatched: 0
  });
  const candidate = await service.request("records.get", { storeName: "opportunity_pipeline_candidates_v2", id: newTaskRef.candidateIds[0] });
  assert.equal(candidate.submitStatus, "ready");
  assert.equal(candidate.eligible, true);
});

test("store throttle budget yields a resumable deferred task without exhausting the logical group", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-throttle-budget-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T02:30:00.000Z";
  const identity = await createStore(service, "shop-throttle-budget");
  const taskRef = await createTask(service, identity, "throttle-budget", base, 1);
  const scheduler = await claimScheduler(service, "scheduler-throttle-budget", base);
  const task = await claimTask(service, taskRef.taskId, "worker-throttle-budget", at(base, 1));
  const budgetPolicy = { ...POLICY, storeThrottleBudgetMs: 1000 };
  const admission = await service.request("opportunitySubmit.admit", {
    taskId: task.id,
    ...coordinatorFence(task, scheduler),
    now: at(base, 2),
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    clueId: taskRef.clueId,
    candidateIds: taskRef.candidateIds,
    requestBody: requestBody(task, taskRef.clueId),
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: budgetPolicy
  });
  await service.request("opportunitySubmit.consumeHttpGrant", {
    taskId: task.id,
    attemptId: admission.attempt.attemptId,
    httpGrantId: admission.attempt.httpGrantId,
    ...coordinatorFence(task, scheduler),
    now: at(base, 3)
  });
  const throttled = await service.request("opportunitySubmit.resolve", {
    taskId: task.id,
    attemptId: admission.attempt.attemptId,
    ...coordinatorFence(task, scheduler),
    now: at(base, 4),
    outcome: "throttled",
    responseClass: "http_429",
    retryAfterMs: 2000,
    policy: budgetPolicy
  });
  assert.equal(throttled.throttleBudgetExceeded, true);
  assert.equal(throttled.retryExhausted, false);
  assert.equal(throttled.task.status, "deferred");
  assert.equal(throttled.task.deferredReason, "throttle_budget");
  assert.equal(throttled.task.requiresExplicitResume, false);
  assert.equal(throttled.group.status, "retry_waiting");
  assert.equal(throttled.task.resumeAt, throttled.resumeAt);
});

test("recovery scheduler defers and nudges tasks only through atomic coordinator commands", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-deferred-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T03:00:00.000Z";
  const identity = await createStore(service, "shop-deferred");
  const taskRef = await createTask(service, identity, "deferred", base, 1);
  const authorizationWait = await service.request("opportunitySubmit.deferTask", {
    taskId: taskRef.taskId,
    deferredReason: "authorization_wait",
    resumeAt: at(base, 300),
    now: at(base, 1),
    message: "paid authorization is unavailable"
  });
  assert.equal(authorizationWait.deferred, true);
  assert.equal(authorizationWait.task.status, "deferred");
  assert.equal(authorizationWait.task.resumeAt, at(base, 300));

  const nudged = await service.request("opportunitySubmit.nudgeDeferredTasks", {
    deferredReasons: ["authorization_wait"],
    taskIds: [taskRef.taskId],
    now: at(base, 2),
    recoverySource: "license-restored"
  });
  assert.equal(nudged.nudged, 1);
  assert.equal(nudged.tasks[0].resumeAt, at(base, 2));
  assert.equal(nudged.tasks[0].recoverySource, "license-restored");

  const claimed = await claimTask(service, taskRef.taskId, "active-worker", at(base, 3), 60);
  const activeLease = await service.request("opportunitySubmit.deferTask", {
    taskId: taskRef.taskId,
    deferredReason: "login_wait",
    now: at(base, 4)
  });
  assert.equal(activeLease.deferred, false);
  assert.equal(activeLease.reason, "active-lease");
  assert.equal(activeLease.task.fencingToken, claimed.fencingToken);

  const contractMismatch = await service.request("opportunitySubmit.deferTask", {
    taskId: taskRef.taskId,
    deferredReason: "contract_mismatch",
    now: at(base, 70),
    message: "trusted release snapshot is unavailable"
  });
  assert.equal(contractMismatch.deferred, true);
  assert.equal(contractMismatch.task.status, "deferred_contract_mismatch");
  assert.equal(contractMismatch.task.requiresExplicitResume, true);
  assert.equal(contractMismatch.task.resumeAt, undefined);
});

test("late submit results cannot cross a reclaimed task fencing token", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-fence-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T04:00:00.000Z";
  const identity = await createStore(service, "shop-fence");
  const taskRef = await createTask(service, identity, "fence", base, 1);
  const scheduler = await claimScheduler(service, "scheduler-fence", base);
  const firstOwnerTask = await claimTask(service, taskRef.taskId, "worker-fence-1", at(base, 1), 5);
  const admission = await service.request("opportunitySubmit.admit", {
    taskId: firstOwnerTask.id,
    ...coordinatorFence(firstOwnerTask, scheduler),
    now: at(base, 2),
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    clueId: taskRef.clueId,
    candidateIds: taskRef.candidateIds,
    requestBody: requestBody(firstOwnerTask, taskRef.clueId),
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  await service.request("opportunitySubmit.consumeHttpGrant", {
    taskId: firstOwnerTask.id,
    attemptId: admission.attempt.attemptId,
    httpGrantId: admission.attempt.httpGrantId,
    ...coordinatorFence(firstOwnerTask, scheduler),
    now: at(base, 3)
  });

  const secondOwnerTask = await claimTask(service, taskRef.taskId, "worker-fence-2", at(base, 10), 60);
  assert.equal(secondOwnerTask.fencingToken, firstOwnerTask.fencingToken + 1);
  await assert.rejects(() => service.request("opportunitySubmit.resolve", {
    taskId: firstOwnerTask.id,
    attemptId: admission.attempt.attemptId,
    ...coordinatorFence(firstOwnerTask, scheduler),
    now: at(base, 11),
    outcome: "accepted",
    policy: POLICY
  }), /fence is stale/);
  const reconciled = await service.request("opportunitySubmit.resolve", {
    taskId: secondOwnerTask.id,
    attemptId: admission.attempt.attemptId,
    ...coordinatorFence(secondOwnerTask, scheduler),
    now: at(base, 12),
    outcome: "unknown",
    responseClass: "worker_reclaimed_after_dispatch",
    policy: POLICY
  });
  assert.equal(reconciled.task.status, "manual_reconcile");
});

test("mutation summary keeps prepared and sending records out of failure and unknown counts", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-mutation-summary-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const identity = await createStore(service, "shop-mutation-summary");
  const runId = "run-mutation-summary";
  const statuses = ["prepared", "sending", "unknown", "failed", "acknowledged"];
  await service.request("catalog.recordMutationResults", {
    ...identity,
    platform: "doudian",
    mutations: statuses.map((status, index) => ({
      mutationKey: `catalog-mutation:opportunity-submit:${runId}:${index}`,
      productId: `product-${index}`,
      action: "opportunity-submit",
      status
    }))
  });
  const summary = await service.request("catalog.summarizeOpportunityRunMutations", { runId });
  assert.equal(summary.total, 5);
  assert.equal(summary.pending, 2);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.acknowledged, 1);
  assert.equal(summary.byShop[identity.shopId].pending, 2);
});

test("coordinator persists the effective pacing time instead of waking at the shorter cooldown", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-effective-resume-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T00:00:00.000Z";
  const policy = { ...POLICY, initialIntervalMs: 60000, minIntervalMs: 60000 };
  const scheduler = await claimScheduler(service, "scheduler-effective-resume", base);
  const identity = await createStore(service, "shop-effective-resume");
  const taskRef = await createTask(service, identity, "effective-resume", base, 1);
  const task = await claimTask(service, taskRef.taskId, "worker-effective-resume", at(base, 1));
  const admission = await service.request("opportunitySubmit.admit", {
    taskId: task.id,
    ...coordinatorFence(task, scheduler),
    now: at(base, 2),
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    clueId: taskRef.clueId,
    candidateIds: taskRef.candidateIds,
    requestBody: requestBody(task, taskRef.clueId),
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy
  });
  await service.request("opportunitySubmit.consumeHttpGrant", {
    taskId: task.id,
    attemptId: admission.attempt.attemptId,
    httpGrantId: admission.attempt.httpGrantId,
    ...coordinatorFence(task, scheduler),
    now: at(base, 3)
  });
  const throttled = await service.request("opportunitySubmit.resolve", {
    taskId: task.id,
    attemptId: admission.attempt.attemptId,
    ...coordinatorFence(task, scheduler),
    now: at(base, 5),
    outcome: "throttled",
    httpStatus: 429,
    responseClass: "http_429",
    retryAfterMs: 30000,
    policy
  });

  assert.equal(throttled.rate.store.cooldownUntil, at(base, 35));
  assert.equal(throttled.resumeAt, at(base, 62));
  assert.equal(throttled.task.resumeAt, at(base, 62));
});

test("isolated 429 uses an additive increase while consecutive 429 still escalates", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-isolated-throttle-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T00:00:00.000Z";
  const scheduler = await claimScheduler(service, "scheduler-isolated-throttle", base);
  const identity = await createStore(service, "shop-isolated-throttle");
  const taskRef = await createTask(service, identity, "isolated-throttle", base, 1);
  let task = await claimTask(service, taskRef.taskId, "worker-isolated-throttle-1", at(base, 1));
  const first = await service.request("opportunitySubmit.admit", {
    taskId: task.id,
    ...coordinatorFence(task, scheduler),
    now: at(base, 2),
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    clueId: taskRef.clueId,
    candidateIds: taskRef.candidateIds,
    requestBody: requestBody(task, taskRef.clueId),
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  await service.request("opportunitySubmit.consumeHttpGrant", {
    taskId: task.id,
    attemptId: first.attempt.attemptId,
    httpGrantId: first.attempt.httpGrantId,
    ...coordinatorFence(task, scheduler),
    now: at(base, 3)
  });
  const isolated = await service.request("opportunitySubmit.resolve", {
    taskId: task.id,
    attemptId: first.attempt.attemptId,
    ...coordinatorFence(task, scheduler),
    now: at(base, 4),
    outcome: "throttled",
    httpStatus: 429,
    responseClass: "http_429",
    policy: POLICY
  });
  assert.equal(isolated.rate.store.intervalMs, 20000);

  task = await claimTask(service, task.id, "worker-isolated-throttle-2", isolated.resumeAt);
  const second = await service.request("opportunitySubmit.admit", {
    taskId: task.id,
    ...coordinatorFence(task, scheduler),
    now: isolated.resumeAt,
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    logicalGroupId: first.group.id,
    clueId: taskRef.clueId,
    candidateIds: taskRef.candidateIds,
    requestBody: requestBody(task, taskRef.clueId),
    requestBodyHash: first.group.requestBodyHash,
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  await service.request("opportunitySubmit.consumeHttpGrant", {
    taskId: task.id,
    attemptId: second.attempt.attemptId,
    httpGrantId: second.attempt.httpGrantId,
    ...coordinatorFence(task, scheduler),
    now: at(isolated.resumeAt, 1)
  });
  const consecutive = await service.request("opportunitySubmit.resolve", {
    taskId: task.id,
    attemptId: second.attempt.attemptId,
    ...coordinatorFence(task, scheduler),
    now: at(isolated.resumeAt, 2),
    outcome: "throttled",
    httpStatus: 429,
    responseClass: "http_429",
    policy: POLICY
  });
  assert.equal(consecutive.rate.store.intervalMs, 30000);
});

test("idle pacing state resets to the initial interval before a new admission", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-idle-rate-reset-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T00:00:00.000Z";
  const now = at(base, 601);
  const scheduler = await claimScheduler(service, "scheduler-idle-rate-reset", now);
  const identity = await createStore(service, "shop-idle-rate-reset");
  const taskRef = await createTask(service, identity, "idle-rate-reset", now, 1);
  await service.request("records.put", {
    storeName: "opportunity_submit_rate_state_v1",
    record: {
      id: `local-user-${identity.shopId}-${identity.storeGeneration}`,
      ...identity,
      mode: "normal",
      policyVersion: POLICY.policyVersion,
      intervalMs: 60000,
      consecutiveSuccesses: 0,
      consecutive429: 0,
      lastAdmittedAt: base,
      last429At: base,
      updatedAt: base
    }
  });
  const task = await claimTask(service, taskRef.taskId, "worker-idle-rate-reset", at(now, 1));
  const admission = await service.request("opportunitySubmit.admit", {
    taskId: task.id,
    ...coordinatorFence(task, scheduler),
    now: at(now, 2),
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    clueId: taskRef.clueId,
    candidateIds: taskRef.candidateIds,
    requestBody: requestBody(task, taskRef.clueId),
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  assert.equal(admission.admitted, true);
  assert.equal(admission.rate.store.intervalMs, POLICY.initialIntervalMs);
  assert.equal(admission.rate.store.idleResetAt, at(now, 2));
});

test("idle pacing state does not reset for an active legacy task without run markers", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-active-rate-preserved-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T00:00:00.000Z";
  const now = at(base, 611);
  const scheduler = await claimScheduler(service, "scheduler-active-rate-preserved", now);
  const identity = await createStore(service, "shop-active-rate-preserved");
  const taskRef = await createTask(service, identity, "active-rate-preserved", base, 1);
  await service.request("records.put", {
    storeName: "opportunity_submit_rate_state_v1",
    record: {
      id: `local-user-${identity.shopId}-${identity.storeGeneration}`,
      ...identity,
      mode: "normal",
      policyVersion: POLICY.policyVersion,
      intervalMs: 60000,
      consecutiveSuccesses: 0,
      consecutive429: 0,
      lastAdmittedAt: at(base, 10),
      updatedAt: at(base, 10)
    }
  });
  const task = await claimTask(service, taskRef.taskId, "worker-active-rate-preserved", at(now, 1));
  const admission = await service.request("opportunitySubmit.admit", {
    taskId: task.id,
    ...coordinatorFence(task, scheduler),
    now: at(now, 2),
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    clueId: taskRef.clueId,
    candidateIds: taskRef.candidateIds,
    requestBody: requestBody(task, taskRef.clueId),
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  assert.equal(admission.admitted, true);
  assert.equal(admission.rate.store.intervalMs, 60000);
  assert.equal(admission.rate.store.idleResetAt, undefined);
  assert.equal(admission.rate.store.lastAdmittedRunId, taskRef.runId);
});

test("a global pacing grant postpones peer tasks before another worker is launched", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-peer-pacing-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T00:00:00.000Z";
  const scheduler = await claimScheduler(service, "scheduler-peer-pacing", base);
  const identityA = await createStore(service, "shop-peer-pacing-a");
  const identityB = await createStore(service, "shop-peer-pacing-b");
  const taskRefA = await createTask(service, identityA, "peer-pacing-a", base, 1);
  const taskRefB = await createTask(service, identityB, "peer-pacing-b", base, 1);
  const taskA = await claimTask(service, taskRefA.taskId, "worker-peer-pacing-a", at(base, 1));
  const admission = await service.request("opportunitySubmit.admit", {
    taskId: taskA.id,
    ...coordinatorFence(taskA, scheduler),
    now: at(base, 2),
    businessDate: "2026-07-25",
    endpointContract: "opportunitySubmitClue",
    clueId: taskRefA.clueId,
    candidateIds: taskRefA.candidateIds,
    requestBody: requestBody(taskA, taskRefA.clueId),
    contractSnapshot: CONTRACT,
    dailyCandidateMutationLimit: 1000,
    dailyHttpRequestLimit: 1000,
    policy: POLICY
  });
  assert.equal(admission.admitted, true);
  assert.equal(admission.task.lastAdmittedAt, at(base, 2));
  const peerTask = await service.request("records.get", {
    storeName: "opportunity_pipeline_submit_tasks_v2",
    id: taskRefB.taskId
  });
  assert.equal(peerTask.status, "queued");
  assert.equal(peerTask.resumeAt, at(base, 2.5));
});

test("ready tasks with a future resume time cannot be claimed early", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-submit-ready-resume-"));
  const service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const base = "2026-07-25T00:00:00.000Z";
  const identity = await createStore(service, "shop-ready-resume");
  const taskRef = await createTask(service, identity, "ready-resume", base, 1);
  const original = await service.request("records.get", { storeName: "opportunity_pipeline_submit_tasks_v2", id: taskRef.taskId });
  await service.request("records.put", {
    storeName: "opportunity_pipeline_submit_tasks_v2",
    record: { ...original, status: "ready", resumeAt: at(base, 60), updatedAt: base }
  });
  const early = await service.request("records.claimOpportunitySubmitTask", {
    taskId: taskRef.taskId,
    ownerRunId: "worker-ready-early",
    now: at(base, 30),
    leaseExpiresAt: at(base, 90)
  });
  assert.equal(early.claimed, false);
  assert.equal(early.reason, "not-claimable");
  const due = await service.request("records.claimOpportunitySubmitTask", {
    taskId: taskRef.taskId,
    ownerRunId: "worker-ready-due",
    now: at(base, 60),
    leaseExpiresAt: at(base, 120)
  });
  assert.equal(due.claimed, true);
});
