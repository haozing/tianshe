import test from "node:test";
import assert from "node:assert/strict";
import { showStoreOperationToast, storeImportFeedback } from "../src/lib/storeImportFeedback.ts";

test("successful store import does not show a result notice", () => {
  assert.equal(storeImportFeedback({ ok: true, status: "succeeded", failedCount: 0 }), "hidden");
  assert.equal(showStoreOperationToast("fetchDoudianStores"), false);
  assert.equal(showStoreOperationToast("refreshDoudianStoreStatus"), true);
});

test("partial and failed store imports keep a lightweight notice", () => {
  assert.equal(storeImportFeedback({ ok: true, status: "partial", failedCount: 1 }), "notice");
  assert.equal(storeImportFeedback({ ok: true, status: "partial", failedCount: 0 }), "notice");
  assert.equal(storeImportFeedback({ ok: false, status: "failed", failedCount: 0 }), "notice");
});
