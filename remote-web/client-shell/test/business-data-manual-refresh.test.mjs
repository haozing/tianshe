import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(fileURLToPath(new URL("../src/components/BusinessDataPage.tsx", import.meta.url)), "utf8");

test("business data refresh is only started by the manual refresh button", () => {
  const refreshCalls = source.match(/refreshBusinessData\(/g) || [];
  assert.equal(refreshCalls.length, 2);
  assert.match(source, /title="手动刷新经营数据"[^>]+onClick=\{\(\) => void refreshBusinessData\(\)\}/);
  assert.doesNotMatch(source, /preserveSequence/);
  assert.equal((source.match(/setBusinessSyncing\(true\)/g) || []).length, 1);
  assert.match(source, /businessSyncing \? "animate-spin"/);
});

test("business data page tells users to refresh when no cached data exists", () => {
  assert.match(source, /暂无数据，请点击右上角“刷新数据”/);
});
