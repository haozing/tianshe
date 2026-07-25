const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const { Worker } = require("node:worker_threads");

async function main() {
  const executionPolicy = await import(pathToFileURL(path.join(__dirname, "../../remote-web/client-shell/src/domain/doudian/opportunityExecutionPolicy.ts")).href);
  const retryPolicy = await import(pathToFileURL(path.join(__dirname, "../../remote-web/client-shell/src/domain/doudian/requestRetryPolicy.ts")).href);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-opportunity-check-"));
  const databasePath = path.join(tempDir, "opportunity.sqlite3");
  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE opportunity_submit_attempts_v2 (
      attempt_id TEXT PRIMARY KEY,
      attempt_key TEXT NOT NULL UNIQUE,
      execute_run_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'sending', 'accepted', 'rejected', 'unknown', 'confirmed', 'failed', 'cancelled')),
      counts_against_daily_limit INTEGER NOT NULL DEFAULT 0 CHECK (counts_against_daily_limit IN (0, 1)),
      request_hash TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      resolved_at TEXT
    );
    PRAGMA user_version = 1;
  `);
  legacyDatabase.close();
  const worker = new Worker(path.join(__dirname, "../src/main/database/worker.js"), {
    workerData: { databasePath }
  });
  let nextId = 1;
  const pending = new Map();
  worker.on("message", (message) => {
    if (!message || message.type !== "response") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(Object.assign(new Error(message.error && message.error.message || "worker request failed"), message.error));
  });
  const request = (method, args = {}) => new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: "request", id, method, args });
  });

  try {
    await request("initialize", { databasePath });
    const timestamp = "2026-07-15T12:00:00.000Z";
    const operation = (operationId) => ({
      id: operationId,
      operationId,
      taskType: "opportunityPipelineSubmit",
      status: "created",
      createdAt: timestamp,
      updatedAt: timestamp,
      progress: 0,
      metadata: { dedupeKey: "opportunity-pipeline-submit" }
    });
    const firstOperation = await request("records.acquireOperation", {
      operation: operation("operation-1"),
      updatedAfter: "2026-07-15T00:00:00.000Z"
    });
    const duplicateOperation = await request("records.acquireOperation", {
      operation: operation("operation-2"),
      updatedAfter: "2026-07-15T00:00:00.000Z"
    });
    assert.equal(firstOperation.acquired, true);
    assert.equal(duplicateOperation.acquired, false);
    assert.equal(duplicateOperation.operation.operationId, "operation-1");

    const submitTasks = ["task-1", "task-2"].map((id, index) => ({
      id,
      runId: `run-${index + 1}`,
      storeRunId: `run-${index + 1}-shop-1`,
      shopId: "shop-1",
      status: "queued",
      concurrencyKey: "local-user-shop-1-1",
      candidateIds: [],
      candidateCount: 0,
      submittedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    }));
    await request("records.putMany", { storeName: "opportunity_pipeline_submit_tasks_v2", records: submitTasks, omitRecords: true });
    const firstClaim = await request("records.claimOpportunitySubmitTask", {
      taskId: "task-1",
      ownerRunId: "worker-1",
      now: timestamp,
      leaseExpiresAt: "2026-07-15T12:30:00.000Z"
    });
    const competingClaim = await request("records.claimOpportunitySubmitTask", {
      taskId: "task-2",
      ownerRunId: "worker-2",
      now: timestamp,
      leaseExpiresAt: "2026-07-15T12:30:00.000Z"
    });
    assert.equal(firstClaim.claimed, true);
    assert.equal(competingClaim.claimed, false);
    assert.equal(competingClaim.reason, "concurrency-active");

    const candidates = Array.from({ length: 1000 }, (_, index) => ({
      id: `run-1-candidate-${String(index).padStart(4, "0")}`,
      pipelineRunId: "run-1",
      productId: String(index),
      status: "ready"
    }));
    const candidateWrite = await request("records.putMany", {
      storeName: "opportunity_pipeline_candidates_v2",
      records: candidates,
      omitRecords: true
    });
    const candidatePage = await request("records.list", { storeName: "opportunity_pipeline_candidates_v2", limit: 1000 });
    assert.equal(candidateWrite.count, 1000);
    assert.equal(candidatePage.items.length, 1000);

    await request("opportunityAttempts.putMany", {
      attempts: [
        {
          attemptId: "attempt-accepted",
          attemptKey: "attempt-accepted",
          businessDate: "2026-07-15",
          shopId: "shop-1",
          clueId: "clue-1",
          productId: "product-1",
          relationKey: "shop-1::clue-1::product-1",
          clueKey: "shop-1::clue-1",
          clueCategoryKey: "shop-1::category-1",
          status: "accepted",
          countsAgainstDailyLimit: true,
          createdAt: timestamp,
          updatedAt: timestamp
        },
        {
          attemptId: "attempt-failed",
          attemptKey: "attempt-failed",
          businessDate: "2026-07-15",
          shopId: "shop-1",
          clueId: "clue-2",
          productId: "product-2",
          relationKey: "shop-1::clue-2::product-2",
          clueKey: "shop-1::clue-2",
          status: "failed",
          countsAgainstDailyLimit: true,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z"
        }
      ]
    });
    const count = await request("opportunityAttempts.count", { businessDate: "2026-07-15", shopId: "shop-1" });
    const dedupe = await request("opportunityAttempts.listDedupeKeys");
    const shopDedupe = await request("opportunityAttempts.listDedupeKeys", { shopIds: ["shop-1"] });
    const otherShopDedupe = await request("opportunityAttempts.listDedupeKeys", { shopIds: ["shop-2"] });
    const matchedDedupe = await request("opportunityAttempts.findDedupeKeys", {
      relationKeys: ["shop-1::clue-1::product-1", "shop-1::clue-2::product-2"]
    });
    assert.equal(count.count, 2);
    assert.deepEqual(dedupe.relationKeys, ["shop-1::clue-1::product-1"]);
    assert.deepEqual(shopDedupe.relationKeys, ["shop-1::clue-1::product-1"]);
    assert.deepEqual(otherShopDedupe.relationKeys, []);
    assert.deepEqual(matchedDedupe.relationKeys, ["shop-1::clue-1::product-1"]);
    await request("stores.upsertIdentity", { platform: "doudian", tenantId: "local-user", shopId: "shop-1", storeGeneration: 1, identityContractVersion: "opportunity-check" });
    await request("catalog.recordMutationResults", {
      platform: "doudian",
      tenantId: "local-user",
      shopId: "shop-1",
      storeGeneration: 1,
      mutations: [
        { mutationKey: "catalog-mutation:opportunity-submit:summary-run:accepted", productId: "product-1", action: "submit", status: "acknowledged", responseSummary: { executionStatus: "submitted", ok: true } },
        { mutationKey: "catalog-mutation:opportunity-submit:summary-run:skipped", productId: "product-2", action: "submit", status: "skipped", responseSummary: { executionStatus: "skipped", ok: true, message: "live lookup did not find product" } },
        { mutationKey: "catalog-mutation:opportunity-submit:summary-run:failed", productId: "product-3", action: "submit", status: "failed", responseSummary: { executionStatus: "failed", ok: false } }
      ]
    });
    const mutationSummary = await request("catalog.summarizeOpportunityRunMutations", { runId: "summary-run" });
    assert.deepEqual({
      acknowledged: mutationSummary.acknowledged,
      failed: mutationSummary.failed,
      skipped: mutationSummary.skipped,
      safetySkipped: mutationSummary.safetySkipped,
      total: mutationSummary.total
    }, { acknowledged: 1, failed: 1, skipped: 1, safetySkipped: 1, total: 3 });
    const cleanup = await request("opportunityAttempts.cleanup", { failedRetentionDays: 90 });
    assert.equal(cleanup.deleted, 1);

    const safetySkipped = {
      stage: "submit",
      planKey: "opportunityProductList",
      status: "skipped",
      ok: true,
      message: "live lookup did not find product",
      diagnostic: { safetySkipped: true, safetyReason: "live-not-found" }
    };
    assert.equal(executionPolicy.isRemoteSubmittedExecution(safetySkipped), false);
    assert.deepEqual(executionPolicy.candidateExecutionState([safetySkipped]), {
      failed: false,
      unknown: false,
      skipped: true,
      safetySkipped: true,
      quotaExhausted: false,
      failureMessage: "",
      submitted: false
    });
    assert.equal(executionPolicy.isRemoteSubmittedExecution({
      stage: "submit",
      planKey: "opportunitySubmitClue",
      status: "submitted",
      ok: true,
      diagnostic: { remoteSubmitAttempt: true }
    }), false);
    assert.equal(executionPolicy.isRemoteSubmittedExecution({
      stage: "submit",
      planKey: "opportunitySubmitClue",
      status: "submitted",
      ok: true,
      diagnostic: { remoteSubmitAttempt: true, remoteAccepted: true, remoteResponseCode: "0" }
    }), true);
    assert.equal(executionPolicy.isFinalRateLimitedExecution({
      status: "unknown",
      ok: false,
      diagnostic: { remoteSubmitAttempt: true, remoteAccepted: false, remoteHttpStatus: 429, submitAttemptCount: 3 }
    }), true);
    assert.equal(executionPolicy.unresolvedBatchProductStatus(false, false), "unknown");
    assert.equal(executionPolicy.isStoreDailyQuotaMessage("单天最多可关联1000个线索，已达今日上限！"), true);
    assert.equal(executionPolicy.isProductClueLimitMessage("单天最多可关联1000个线索，已达今日上限！"), false);
    assert.equal(executionPolicy.isProductClueLimitMessage("单个商品最多可关联50个线索"), true);
    assert.equal(executionPolicy.preserveCancelledStatus("cancelled", "partial"), "cancelled");
    assert.deepEqual(executionPolicy.reconcileOpportunityRecordCounts({
      attemptStatuses: ["accepted", "failed"],
      candidateStatuses: ["submitted", "failed"],
      mutationStatuses: ["acknowledged", "failed"]
    }), { ok: true, accepted: 1, submitted: 1, acknowledged: 1 });
    assert.equal(executionPolicy.reconcileOpportunityRecordCounts({
      attemptStatuses: ["accepted"],
      candidateStatuses: ["submitted", "submitted"],
      mutationStatuses: ["acknowledged"]
    }).ok, false);
    assert.equal(retryPolicy.requestRetryDelayMs({ retryDelayMs: 1200, retryBackoff: "exponential" }, 3, "retryDelayMs", "retryBackoff", 1000, undefined, () => 0), 4800);
    assert.equal(retryPolicy.requestRetryDelayMs({ retryDelayMs: 1200, retryBackoff: "exponential", retryJitterMs: 1000 }, 1, "retryDelayMs", "retryBackoff", 1000, { headers: { "retry-after": "5" } }, () => 0), 5000);

    await request("maintenance.close");
    console.log("OPPORTUNITY_DATA_OK atomic dedupe, task claim, business status classification, quota fuse, cancellation fence, retry policy, reconciliation, batch writes, attempts and cleanup");
  } finally {
    await worker.terminate().catch(() => undefined);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
