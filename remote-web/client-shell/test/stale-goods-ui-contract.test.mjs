import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pageSource = await readFile(fileURLToPath(new URL("../src/components/SlowMovingCleanupPage.tsx", import.meta.url)), "utf8");

test("stale-goods results omit the removed diagnostic and field controls", () => {
  assert.doesNotMatch(pageSource, />店铺扫描诊断</);
  assert.doesNotMatch(pageSource, />商品列表字段</);
  assert.doesNotMatch(pageSource, /value=\{actionFilter\}/);
  assert.doesNotMatch(pageSource, /value=\{riskFilter\}/);
  assert.doesNotMatch(pageSource, /value=\{sortKey\}/);
});

test("stale-goods table keeps only the six required business columns", () => {
  const columnsBlock = pageSource.match(/const cleanupColumns:[\s\S]+?\n\];/)?.[0] || "";
  assert.ok(columnsBlock);
  assert.equal((columnsBlock.match(/key: "/g) || []).length, 6);
  assert.doesNotMatch(columnsBlock, /key: "source"/);
  assert.doesNotMatch(columnsBlock, /key: "action"/);
});

test("stale-goods result actions use the requested labels and order", () => {
  assert.match(pageSource, /修改过滤条件[\s\S]+?>\s*执行清理\s*<[\s\S]+?>\s*导出清单\s*</);
  assert.doesNotMatch(pageSource, />\s*修改规则\s*</);
  assert.match(pageSource, /bg-brand-fox[^\n]+onClick=\{openSettings\}[\s\S]+?修改过滤条件/);
});

test("stale-goods confirmation is centered and does not require typed text", () => {
  assert.match(pageSource, /fixed inset-0[^\n]+place-items-center/);
  assert.match(pageSource, /aria-modal="true"/);
  assert.match(pageSource, />\s*确认执行\s*</);
  assert.doesNotMatch(pageSource, /confirmInput/);
  assert.doesNotMatch(pageSource, /placeholder="输入确认清理后才能提交"/);
  assert.match(pageSource, /confirmText: "确认清理"/);
});
