const assert = require("node:assert/strict");
const test = require("node:test");

const {
  dueOpportunityHistoryPrewarmStores,
  matchingHistorySync,
  nextOpportunityHistoryPrewarmWakeAt,
  opportunityHistoryPrewarmDueAt
} = require("../src/main/tasks/opportunity-history-prewarm-scheduler");

const nowMs = Date.parse("2026-07-26T08:00:00.000Z");
const intervalMs = 6 * 60 * 60 * 1000;
const retryMs = 5 * 60 * 1000;

function store(shopId, overrides = {}) {
  return { tenantId: "tenant-1", shopId, storeGeneration: 2, status: "online", ...overrides };
}

function sync(shopId, overrides = {}) {
  return {
    tenantId: "tenant-1",
    shopId,
    storeGeneration: 2,
    initialized: true,
    status: "complete",
    lastSuccessfulSyncAt: new Date(nowMs - intervalMs - 1).toISOString(),
    updatedAt: new Date(nowMs - intervalMs - 1).toISOString(),
    ...overrides
  };
}

test("prewarm prioritizes unsynchronized online stores and excludes offline stores", () => {
  const stores = [store("ready-initial"), store("ready-incremental"), store("offline", { status: "offline" })];
  const syncRecords = [sync("ready-incremental")];
  assert.equal(matchingHistorySync(stores[1], syncRecords)?.shopId, "ready-incremental");
  assert.deepEqual(dueOpportunityHistoryPrewarmStores(stores, syncRecords, { nowMs, intervalMs, retryMs }).map((item) => item.shopId), [
    "ready-initial",
    "ready-incremental"
  ]);
});

test("fresh history cache is not scheduled until the incremental interval expires", () => {
  const current = sync("shop-1", {
    lastSuccessfulSyncAt: new Date(nowMs - 60_000).toISOString(),
    updatedAt: new Date(nowMs - 60_000).toISOString()
  });
  const dueAt = opportunityHistoryPrewarmDueAt(store("shop-1"), current, { intervalMs, retryMs });
  assert.equal(dueAt, nowMs - 60_000 + intervalMs);
  assert.deepEqual(dueOpportunityHistoryPrewarmStores([store("shop-1")], [current], { nowMs, intervalMs, retryMs }), []);
  assert.equal(nextOpportunityHistoryPrewarmWakeAt([store("shop-1")], [current], { intervalMs, retryMs }), dueAt);
});

test("failed and in-memory attempts respect retry backoff", () => {
  const failed = sync("shop-1", {
    initialized: false,
    status: "failed",
    updatedAt: new Date(nowMs - 60_000).toISOString()
  });
  const attempts = new Map([["shop-1", new Date(nowMs - 30_000).toISOString()]]);
  assert.deepEqual(dueOpportunityHistoryPrewarmStores([store("shop-1")], [failed], {
    nowMs,
    intervalMs,
    retryMs,
    lastAttemptByShopId: attempts
  }), []);
  assert.equal(nextOpportunityHistoryPrewarmWakeAt([store("shop-1")], [failed], {
    intervalMs,
    retryMs,
    lastAttemptByShopId: attempts
  }), nowMs - 30_000 + retryMs);
});
