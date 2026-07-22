import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(fileURLToPath(new URL("../src/components/FundsDataPage.tsx", import.meta.url)), "utf8");

test("fresh funds data is fetched only from the manual action", () => {
  const fetchCalls = source.match(/fetchFundsDataManually\(/g) || [];
  assert.equal(fetchCalls.length, 2);
  assert.match(source, /title="手动获取资金数据"[^>]+onClick=\{\(\) => void fetchFundsDataManually\(\)\}/);
  assert.match(source, /void hydrateLatestFundsData\(selectedIds, generation\);/);
  assert.doesNotMatch(source, /await fetchFundsDataManually\(/);
  assert.doesNotMatch(source, /refreshIds/);
});

test("funds page labels the user-triggered action as fetching", () => {
  assert.match(source, />\s*获取资金数据\s*</);
  assert.match(source, /fundsProgress \|\| "获取中"/);
  assert.match(source, /最近获取/);
});
