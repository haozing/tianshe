import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  bisectBulkDeleteDateSegment,
  bulkDeleteCreatedDate,
  bulkDeleteExecutionSucceeded,
  bulkDeleteLiveLookupContext
} from "../src/domain/doudian/bulkDeleteContract.ts";

test("bulk delete live lookup batches exact product ids in id_name_code", () => {
  const productIds = Array.from({ length: 50 }, (_, index) => `product-${index + 1}`);
  const context = bulkDeleteLiveLookupContext(productIds, "offline");

  assert.equal(context.idNameCode, productIds.join(","));
  assert.equal(context.keyword, "");
  assert.equal(context.page, "0");
  assert.equal(context.pageSize, "50");
  assert.equal(context.isOnline, "");
  assert.equal(context.isOffline, "1");
  assert.equal(context.productTab, "offline");
});

test("complete delete confirmation queries the recycle-bin lifecycle view", () => {
  const context = bulkDeleteLiveLookupContext(["product-1", "product-2"], "recycle");

  assert.equal(context.idNameCode, "product-1,product-2");
  assert.equal(context.productStatus, "2");
  assert.equal(context.isOnline, "");
  assert.equal(context.isOffline, "");
  assert.equal(context.productTab, "deleted");
});

test("bulk delete adapter exposes the verified exact-id lookup contract", () => {
  const adapter = JSON.parse(fs.readFileSync(new URL("../public/config/doudian-adapter.json", import.meta.url), "utf8"));
  const plan = adapter.requestPlans.bulkDeleteProductList;
  const policy = adapter.policies.bulkDelete;

  assert.equal(plan.query.id_name_code, "{idNameCode}");
  assert.equal(plan.query.start_time, "{startTime}");
  assert.equal(plan.query.end_time, "{endTime}");
  assert.equal(policy.liveLookupBatchSize, 50);
  assert.equal(policy.liveLookupConcurrency, 1);
  assert.equal(policy.maxTimeSegments, 64);
  assert.match(policy.messages.executePartial, /\{failureCount\} 个商品未成功/);
});

test("bulk delete date segmentation uses China business dates and disjoint ranges", () => {
  assert.equal(bulkDeleteCreatedDate("2026/07/22 09:30:00"), "2026-07-22");
  assert.equal(bulkDeleteCreatedDate(1784678400), "2026-07-22");
  assert.deepEqual(bisectBulkDeleteDateSegment({ startDate: "2026-07-01", endDate: "2026-07-10", depth: 0 }), [
    { startDate: "2026-07-01", endDate: "2026-07-05", depth: 1 },
    { startDate: "2026-07-06", endDate: "2026-07-10", depth: 1 }
  ]);
  assert.deepEqual(bisectBulkDeleteDateSegment({ startDate: "2026-07-01", endDate: "2026-07-01", depth: 0 }), []);
});

test("skipped safety results are not reported as successful submissions", () => {
  const base = {
    shopId: "shop-1",
    shopName: "Shop 1",
    productId: "product-1",
    action: "recycle",
    message: "",
    stage: "recycle"
  };

  assert.equal(bulkDeleteExecutionSucceeded({ ...base, status: "submitted", ok: true }), true);
  assert.equal(bulkDeleteExecutionSucceeded({ ...base, status: "skipped", ok: true, liveLifecycleStatus: "offline" }), false);
  assert.equal(bulkDeleteExecutionSucceeded({ ...base, status: "skipped", ok: true, liveLifecycleStatus: "recycle" }), true);
  assert.equal(bulkDeleteExecutionSucceeded({ ...base, status: "failed", ok: false }), false);
});
