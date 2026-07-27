import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pageSource = await readFile(fileURLToPath(new URL("../src/components/SlowMovingCleanupPage.tsx", import.meta.url)), "utf8");
const staleSource = await readFile(fileURLToPath(new URL("../src/domain/doudian/staleGoods.ts", import.meta.url)), "utf8");
const progressSource = await readFile(fileURLToPath(new URL("../src/domain/doudian/progress.ts", import.meta.url)), "utf8");
const taskRunnerSource = await readFile(fileURLToPath(new URL("../src/domain/doudian/taskRunner.ts", import.meta.url)), "utf8");
const taskClientSource = await readFile(fileURLToPath(new URL("../src/domain/doudian/taskClient.ts", import.meta.url)), "utf8");

test("stale-goods results omit the removed diagnostic and field controls", () => {
  assert.doesNotMatch(pageSource, />店铺扫描诊断</);
  assert.doesNotMatch(pageSource, />商品列表字段</);
  assert.doesNotMatch(pageSource, /value=\{actionFilter\}/);
  assert.doesNotMatch(pageSource, /value=\{riskFilter\}/);
  assert.doesNotMatch(pageSource, /value=\{sortKey\}/);
});

test("stale-goods table uses the eight requested independent business columns", () => {
  const columnsBlock = pageSource.match(/const cleanupColumns:[\s\S]+?\n\];/)?.[0] || "";
  assert.ok(columnsBlock);
  assert.equal((columnsBlock.match(/key: "/g) || []).length, 8);
  for (const key of ["status", "sales", "exposure", "clicks", "stock", "price", "createdDays", "listedAt"]) {
    assert.match(columnsBlock, new RegExp(`key: "${key}"`));
  }
  assert.doesNotMatch(columnsBlock, /key: "source"/);
  assert.doesNotMatch(columnsBlock, /key: "action"/);
  assert.doesNotMatch(columnsBlock, /key: "quality"/);
  assert.doesNotMatch(columnsBlock, /key: "traffic"/);
  assert.doesNotMatch(columnsBlock, /key: "stockPrice"/);
  assert.doesNotMatch(columnsBlock, /key: "time"/);
  const renderBlock = pageSource.match(/function renderColumn[\s\S]+?\n  const canReturnToResults/)?.[0] || "";
  assert.ok(renderBlock);
  assert.doesNotMatch(renderBlock, /周期|CTR|质量诊断|qualityIssueLabels/);
});

test("stale-goods scanning is fixed to selling products", () => {
  assert.match(pageSource, /productSource: "selling"/);
  assert.match(pageSource, /importedProductIds: \[\]/);
  assert.match(pageSource, /label="售卖中商品"/);
  assert.doesNotMatch(pageSource, /setProductSource|productSourceOptions|importedIdsMissing/);
  assert.match(staleSource, /productSource: "selling" as const/);
  assert.match(staleSource, /importedProductIds: \[\]/);
});

test("stale-goods product pages stream candidates through the task bridge", () => {
  assert.match(staleSource, /onPage\?: \(detail: ProductPageBatch\)/);
  assert.match(staleSource, /message: `已获取 \$\{detail\.fetchedCount\}/);
  assert.match(progressSource, /interface DoudianStaleGoodsProgress/);
  assert.match(progressSource, /staleGoods\?: DoudianStaleGoodsProgress/);
  assert.match(taskRunnerSource, /staleGoods: detail\.staleGoods/);
  assert.match(taskClientSource, /staleGoods: message\.staleGoods/);
  assert.match(pageSource, /event\.detail\.staleGoods\?\.candidates/);
  assert.match(pageSource, /new Map\(current\.map\(\(row\) => \[row\.id, row\]\)\)/);
});

test("stale-goods settings follow the compact reference layout", () => {
  assert.doesNotMatch(pageSource, /开始分析前，请勾选/);
  assert.match(pageSource, /所有勾选条件/);
  assert.match(pageSource, /任一勾选条件/);
  assert.match(pageSource, /grid-cols-3 gap-x-7 gap-y-2/);
  assert.match(pageSource, /function QualityConditionSelect/);
  assert.match(pageSource, /<details className="group relative">/);
  assert.match(pageSource, /function RadioOption/);
  assert.match(pageSource, /商品来源 \/ 分析的流量周期/);
  assert.doesNotMatch(pageSource, /识别方式：/);
  assert.doesNotMatch(pageSource, /综合滞销|零动销|有流无转/);
  assert.match(pageSource, /placeholder="不限"/);
  assert.match(pageSource, /place-items-center border-t[\s\S]+?开始滞销商品分析/);
  assert.doesNotMatch(pageSource, /启用条件[\s\S]+?时间条件/);
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
