const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NativeDataService } = require("../src/main/database");

test("deleting a store cancels active opportunity state without removing accepted attempts", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-store-delete-"));
  let service = new NativeDataService({ app: { getPath: () => userDataDir } });
  t.after(async () => {
    await service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  await service.start();

  const shopId = "shop-delete-smoke";
  const identity = { tenantId: "local-user", shopId, storeGeneration: 1 };
  const runId = "opportunity-delete-run";
  const operationId = runId;
  const storeRunId = `${runId}-local-user-${shopId}-1`;
  const taskId = `${storeRunId}-task-1`;
  const completedRunId = "opportunity-completed-history";

  const put = (storeName, record) => service.request("records.put", { storeName, record });
  const get = (storeName, id) => service.request("records.get", { storeName, id });

  const storePut = await put("stores", {
    id: shopId,
    shopId,
    shopName: "Delete Smoke Store",
    platform: "doudian",
    partition: `persist:${shopId}`,
    status: "online"
  });
  assert.equal(storePut.record.storeGeneration, 1);

  await put("operations", {
    id: operationId,
    operationId,
    taskType: "opportunityPipelineSubmit",
    status: "running",
    progress: 50,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { dedupeKey: "opportunity-pipeline-submit" }
  });
  await put("opportunity_pipeline_runs_v2", {
    id: runId,
    runId,
    operationId,
    shopIds: [shopId],
    storeRefs: [identity],
    status: "running",
    totalStoreCount: 1,
    processedStoreCount: 0,
    submittedCount: 0,
    failedCount: 0,
    summary: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await put("opportunity_pipeline_store_runs_v2", {
    id: storeRunId,
    runId,
    ...identity,
    shopName: "Delete Smoke Store",
    status: "running",
    phase: "submitting",
    submittedCount: 0,
    failedCount: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await put("opportunity_pipeline_runs_v2", {
    id: completedRunId,
    runId: completedRunId,
    operationId: completedRunId,
    shopIds: [shopId],
    storeRefs: [identity],
    status: "ok",
    totalStoreCount: 1,
    processedStoreCount: 1,
    submittedCount: 1,
    failedCount: 0,
    summary: { submittedCount: 1 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await put("opportunity_pipeline_store_runs_v2", {
    id: `${completedRunId}-local-user-${shopId}-1`,
    runId: completedRunId,
    ...identity,
    shopName: "Delete Smoke Store",
    status: "ok",
    phase: "finished",
    submittedCount: 1,
    failedCount: 0,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await put("opportunity_pipeline_submit_tasks_v2", {
    id: taskId,
    runId,
    storeRunId,
    ...identity,
    shopName: "Delete Smoke Store",
    status: "running",
    concurrencyKey: `local-user-${shopId}-1`,
    candidateIds: ["candidate-ready", "candidate-sending"],
    submittedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await put("opportunity_pipeline_candidates_v2", {
    id: "candidate-ready",
    runId,
    storeRunId,
    submitTaskId: taskId,
    ...identity,
    shopName: "Delete Smoke Store",
    productId: "product-ready",
    status: "ready",
    submitStatus: "queued",
    eligible: true
  });
  await put("opportunity_pipeline_candidates_v2", {
    id: "candidate-sending",
    runId,
    storeRunId,
    submitTaskId: taskId,
    ...identity,
    shopName: "Delete Smoke Store",
    productId: "product-sending",
    status: "submitting",
    submitStatus: "sending",
    eligible: true
  });
  await put("opportunity_store_category_ledger_v2", {
    id: `local-user-${shopId}-1-category`,
    ...identity,
    shopName: "Delete Smoke Store",
    categoryKey: "category:1"
  });
  await put("opportunity_clue_cache_v2", {
    id: "shop-clue-cache",
    ...identity,
    shopName: "Delete Smoke Store",
    cacheScope: "shop",
    clueCacheKey: "shop-clue-cache"
  });
  await put("opportunity_clue_cache_shards_v2", {
    id: "shop-clue-cache-0",
    clueCacheKey: "shop-clue-cache",
    rows: []
  });
  await put("opportunity_clue_cache_v2", {
    id: "global-clue-cache",
    ...identity,
    shopName: "Delete Smoke Store",
    cacheScope: "global"
  });
  await put("opportunity_benefit_product_indexes_v1", {
    id: `${identity.tenantId}-${shopId}-${identity.storeGeneration}-benefit-product`,
    ...identity,
    productId: "benefit-product"
  });
  await put("opportunity_submit_history_records_v1", {
    id: `${identity.tenantId}-${shopId}-${identity.storeGeneration}-history-record`,
    ...identity,
    remoteRecordId: "history-record",
    productId: "history-product",
    clueId: "history-clue"
  });
  await put("opportunity_submit_history_sync_v1", {
    id: `${identity.tenantId}-${shopId}-${identity.storeGeneration}-sync`,
    ...identity,
    initialized: true,
    updatedAt: new Date().toISOString()
  });
  await put("opportunity_submit_history_product_indexes_v1", {
    id: `${identity.tenantId}-${shopId}-${identity.storeGeneration}-history-product`,
    ...identity,
    productId: "history-product",
    associatedClueIds: ["history-clue"]
  });
  await put("opportunity_submit_rate_state_v1", {
    id: `${identity.tenantId}-${shopId}-${identity.storeGeneration}`,
    ...identity,
    mode: "cooling_down",
    intervalMs: 30000,
    updatedAt: new Date().toISOString()
  });
  await put("opportunity_submit_global_rate_state_v1", {
    id: "local-user-opportunity-submit-clue",
    tenantId: identity.tenantId,
    endpointContract: "opportunitySubmitClue",
    mode: "protective",
    intervalMs: 30000,
    rolling429Buckets: [{ windowStartedAt: "2026-07-17T00:00:00.000Z", shopIds: [shopId, "other-shop"] }],
    updatedAt: new Date().toISOString()
  });
  await put("opportunity_submit_attempt_groups_v1", {
    id: "logical-group-unresolved",
    taskId,
    orderedCandidateIds: ["candidate-sending"],
    status: "unknown",
    updatedAt: new Date().toISOString()
  });
  await put("opportunity_submit_contract_snapshots_v1", {
    id: "contract-snapshot-unresolved",
    releaseId: "release-1",
    updatedAt: new Date().toISOString()
  });
  await service.request("opportunityAttempts.putMany", {
    attempts: [{
      id: "accepted-attempt",
      attemptId: "accepted-attempt",
      attemptKey: "accepted-attempt-key",
      executeRunId: runId,
      businessDate: "2026-07-17",
      ...identity,
      clueId: "clue-1",
      productId: "product-1",
      status: "accepted",
      countsAgainstDailyLimit: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]
  });

  const deleted = await service.request("records.delete", { storeName: "stores", id: shopId, reason: "test-store-delete" });
  assert.equal(deleted.deleted, 1);
  assert.equal(deleted.opportunityCleanup.cancelledStoreRuns, 1);
  assert.equal(deleted.opportunityCleanup.cancelledSubmitTasks, 1);
  assert.equal(deleted.opportunityCleanup.cancelledCandidates, 1);
  assert.equal(deleted.opportunityCleanup.unknownCandidates, 1);
  assert.equal(deleted.opportunityCleanup.deletedRateStates, 1);
  assert.equal(deleted.opportunityCleanup.updatedGlobalRateStates, 1);
  assert.equal((await get("opportunity_pipeline_store_runs_v2", storeRunId)).status, "cancelled");
  assert.equal((await get("opportunity_pipeline_submit_tasks_v2", taskId)).status, "cancelling");
  assert.equal((await get("opportunity_pipeline_candidates_v2", "candidate-ready")).status, "cancelled");
  assert.equal((await get("opportunity_pipeline_candidates_v2", "candidate-sending")).status, "unknown");
  assert.equal(await get("opportunity_store_category_ledger_v2", `local-user-${shopId}-1-category`), null);
  assert.equal(await get("opportunity_clue_cache_v2", "shop-clue-cache"), null);
  assert.equal(await get("opportunity_clue_cache_shards_v2", "shop-clue-cache-0"), null);
  assert.equal((await get("opportunity_clue_cache_v2", "global-clue-cache")).cacheScope, "global");
  assert.equal(await get("opportunity_benefit_product_indexes_v1", `${identity.tenantId}-${shopId}-${identity.storeGeneration}-benefit-product`), null);
  assert.equal(await get("opportunity_submit_history_records_v1", `${identity.tenantId}-${shopId}-${identity.storeGeneration}-history-record`), null);
  assert.equal(await get("opportunity_submit_history_sync_v1", `${identity.tenantId}-${shopId}-${identity.storeGeneration}-sync`), null);
  assert.equal(await get("opportunity_submit_history_product_indexes_v1", `${identity.tenantId}-${shopId}-${identity.storeGeneration}-history-product`), null);
  assert.equal(await get("opportunity_submit_rate_state_v1", `${identity.tenantId}-${shopId}-${identity.storeGeneration}`), null);
  assert.deepEqual((await get("opportunity_submit_global_rate_state_v1", "local-user-opportunity-submit-clue")).rolling429Buckets[0].shopIds, ["other-shop"]);
  assert.equal((await get("opportunity_submit_attempt_groups_v1", "logical-group-unresolved")).status, "unknown");
  assert.equal((await get("opportunity_submit_contract_snapshots_v1", "contract-snapshot-unresolved")).releaseId, "release-1");
  assert.equal((await get("opportunity_pipeline_runs_v2", runId)).status, "partial");
  assert.equal((await get("opportunity_pipeline_runs_v2", completedRunId)).status, "ok");
  assert.equal((await get("operations", operationId)).status, "reconciling");
  assert.equal((await service.request("opportunityAttempts.count", { businessDate: "2026-07-17", shopId })).count, 1);

  const lateTaskId = `${storeRunId}-late-task`;
  await put("opportunity_pipeline_submit_tasks_v2", {
    id: lateTaskId,
    runId,
    storeRunId,
    ...identity,
    shopName: "Delete Smoke Store",
    status: "queued",
    concurrencyKey: `local-user-${shopId}-1`,
    candidateIds: [],
    submittedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const claim = await service.request("records.claimOpportunitySubmitTask", {
    taskId: lateTaskId,
    ownerRunId: "late-worker",
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    now: new Date().toISOString()
  });
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, "store-tombstoned");
  assert.equal(claim.task.status, "cancelled");

  await service.stop();
  service = new NativeDataService({ app: { getPath: () => userDataDir } });
  await service.start();
  assert.equal(await service.request("records.get", { storeName: "stores", id: shopId }), null);
  assert.equal((await service.request("records.get", { storeName: "opportunity_pipeline_runs_v2", id: runId })).status, "partial");
  assert.equal((await service.request("opportunityAttempts.count", { businessDate: "2026-07-17", shopId })).count, 1);
});
