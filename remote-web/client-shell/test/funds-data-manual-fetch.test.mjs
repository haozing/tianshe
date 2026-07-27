import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(fileURLToPath(new URL("../src/components/FundsDataPage.tsx", import.meta.url)), "utf8");
const domainSource = await readFile(fileURLToPath(new URL("../src/domain/doudian/fundsData.ts", import.meta.url)), "utf8");

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

test("funds progress hides store identity and the header shows the data update time", () => {
  assert.match(domainSource, /message: `已获取 \$\{completedCount\}\/\$\{targets\.length\}`/);
  assert.doesNotMatch(domainSource, /message: `\$\{store\.shopName \|\| store\.shopId\}/);
  assert.doesNotMatch(source, /家正在显示历史有效值/);
  assert.match(source, /店铺资金明细[\s\S]*?数据更新时间 \{displayedDataAt/);
  assert.doesNotMatch(source, /，数据截至 \$\{displayedDataAt/);
});
