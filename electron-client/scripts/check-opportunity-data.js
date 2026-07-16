const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Worker } = require("node:worker_threads");

async function main() {
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
    const matchedDedupe = await request("opportunityAttempts.findDedupeKeys", {
      relationKeys: ["shop-1::clue-1::product-1", "shop-1::clue-2::product-2"]
    });
    assert.equal(count.count, 2);
    assert.deepEqual(dedupe.relationKeys, ["shop-1::clue-1::product-1"]);
    assert.deepEqual(matchedDedupe.relationKeys, ["shop-1::clue-1::product-1"]);
    const cleanup = await request("opportunityAttempts.cleanup", { failedRetentionDays: 90 });
    assert.equal(cleanup.deleted, 1);

    await request("maintenance.close");
    console.log("OPPORTUNITY_DATA_OK atomic dedupe, task claim, batch writes, attempts and cleanup");
  } finally {
    await worker.terminate().catch(() => undefined);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
