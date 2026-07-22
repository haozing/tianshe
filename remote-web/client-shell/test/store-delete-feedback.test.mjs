import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(fileURLToPath(new URL("../src/components/StoreManagementPage.tsx", import.meta.url)), "utf8");

test("successful store deletion stays quiet while failures remain actionable", () => {
  assert.doesNotMatch(source, /showOperationResult\("success",[^\n]*删除店铺/);
  assert.match(source, /if \(result\.ok\) \{\s*setSelectedIds\(new Set\(\)\);\s*setNotice\(null\);\s*setPendingOperation\(null\);\s*\} else \{\s*showOperationResult\("error", result\.message \|\| "删除店铺失败，请稍后重试。"\);/);
});

test("thrown store deletion errors keep the dialog available for retry", () => {
  assert.match(source, /catch \(error\) \{\s*const message[^;]+;\s*if \(pendingOperation === "deleteStores"\) \{\s*showOperationResult\("error", message \|\| "删除店铺失败，请稍后重试。"\);/);
  assert.doesNotMatch(source, /if \(pendingOperation === "deleteStores"\) \{\s*setNotice\(null\);\s*setPendingOperation\(null\);/);
});
