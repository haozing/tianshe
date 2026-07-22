import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(fileURLToPath(new URL("../src/components/BusinessDataPage.tsx", import.meta.url)), "utf8");

test("business data refresh starts only from the manual button or the user-enabled timer", () => {
  const refreshCalls = source.match(/refreshBusinessData\(/g) || [];
  assert.equal(refreshCalls.length, 3);
  assert.match(source, /title="手动刷新经营数据"[^>]+onClick=\{\(\) => void refreshBusinessData\(\)\}/);
  assert.match(source, /if \(!businessAutoRefresh\.enabled \|\| businessSyncing \|\| storeSyncing/);
  assert.match(source, /window\.setTimeout\(\(\) => \{\s*void refreshBusinessData\(\);\s*\}, businessAutoRefresh\.minutes \* 60_000\)/);
  assert.match(source, /enabled: saved\.enabled === true/);
  assert.match(source, /aria-label="定时刷新经营数据"/);
  assert.match(source, /aria-label="定时刷新间隔（分钟）"/);
  assert.doesNotMatch(source, /preserveSequence/);
  assert.equal((source.match(/setBusinessSyncing\(true\)/g) || []).length, 1);
  assert.match(source, /businessSyncing \? "animate-spin"/);
  assert.match(source, /\{businessSyncing \? \(\s*<span[^>]+title=\{businessProgress \|\| "正在刷新经营数据"\}/);
  assert.doesNotMatch(source, /\{businessState === "loading" \? \(\s*<span[^>]+title=\{businessProgress \|\| "正在同步经营数据"\}/);
  assert.match(source, /businessProgress \|\| "刷新中"/);
});

test("business data page tells users to refresh when no cached data exists", () => {
  assert.match(source, /暂无数据，请点击右上角“刷新数据”/);
});

test("business data renders store placeholders before cached metrics arrive", () => {
  assert.match(source, /setBusinessRows\(\(currentRows\) => businessRowsForStores\(nextStores, currentRows\)\)/);
  assert.match(source, /setBusinessRows\(\(currentRows\) => businessRowsForStores\(stores, currentRows, new Set\(stores\.map\(\(store\) => store\.id\)\)\)\)/);
  assert.match(source, /loaded: false/);
  assert.match(source, /base\.loaded = true/);
  assert.match(source, /setBusinessState\("ready"\);\s*setBusinessCacheLoading\(true\)/);
});

test("business progress ignores tasks that were not manually started by this page", () => {
  assert.match(source, /if \(!currentOperationId \|\| currentOperationId !== detail\.operationId\) return;/);
  assert.doesNotMatch(source, /if \(!currentOperationId && detail\.status !== "running"\) return;/);
});

test("changing the requested range invalidates and cancels an in-flight refresh", () => {
  assert.match(source, /const supersededOperationId = activeOperationIdRef\.current/);
  assert.match(source, /if \(supersededOperationId\) void cancelDoudianStoreOperation\(supersededOperationId\)\.catch\(\(\) => undefined\)/);
  assert.match(source, /businessRequestSeq\.current = requestSeq;[\s\S]*?updateActiveOperationId\(""\);[\s\S]*?setBusinessSyncing\(false\);[\s\S]*?setBusinessProgress\(""\);/);
});
