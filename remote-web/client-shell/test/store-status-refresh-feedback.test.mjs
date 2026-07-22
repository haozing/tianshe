import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(fileURLToPath(new URL("../src/components/StoreManagementPage.tsx", import.meta.url)), "utf8");

test("successful bulk login status refresh stays silent", () => {
  assert.match(source, /if \(result\.ok && failed === 0\) \{\s*setNotice\(null\);/);
  assert.doesNotMatch(source, /已刷新 \$\{result\.refreshed \|\| 0\} 家店铺，\$\{failed\} 家需关注/);
});

test("failed bulk login status refresh keeps a lightweight notice", () => {
  assert.match(source, /showOperationResult\(tone, result\.ok \? `\$\{failed\} 家店铺登录态刷新失败/);
  assert.match(source, /\$\{failed\} 家店铺登录态刷新失败，请处理后重试/);
});

test("store management does not render an in-table operation result panel", () => {
  assert.doesNotMatch(source, /RunDetailsSummary|OperationRunSummary|lastRun|setLastRun/);
  assert.doesNotMatch(source, /设置分组结果/);
});
