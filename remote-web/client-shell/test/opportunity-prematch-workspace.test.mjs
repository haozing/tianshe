import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(fileURLToPath(new URL("../src/components/OpportunityProductPrematchPage.tsx", import.meta.url)), "utf8");
const domainSource = await readFile(fileURLToPath(new URL("../src/domain/doudian/opportunityReport.ts", import.meta.url)), "utf8");

test("prematch store rows show groups instead of per-store failure counts", () => {
  assert.match(source, /groupName: store\.groupName \|\| "未分组"/);
  assert.match(source, /<span className="px-2">分组名<\/span>/);
  assert.doesNotMatch(source, /失败提报/);
});

test("prematch uses the product-plus-clue dedupe rule without exposing legacy skip toggles", () => {
  assert.match(source, /skipSubmittedProductInSameClue: true/);
  assert.doesNotMatch(source, /跳过已报商机类目|跳过已报商机|跳过已报商品（同一商机）/);
  assert.match(domainSource, /function relationKey[\s\S]*?\[value\.shopId, value\.clueId, value\.productId\]/);
  assert.match(domainSource, /index\.relationKeys\.has\(relationKey\(value\)\)/);
});

test("prematch categories default to all and open in a selection dialog", () => {
  assert.match(source, /reconcileStoreCategorySelection\(availableKeys, current\)/);
  assert.match(source, /if \(selectedKeys === null\) return \[\.\.\.availableKeys\]/);
  assert.match(source, /选择店铺类目/);
  assert.match(source, /categoryDialogOpen/);
  assert.match(source, /grid-cols-\[180px_minmax\(0,1fr\)\]/);
});

test("prematch keeps the submit action and live event stream in the open workspace", () => {
  assert.match(source, /opportunity-live-panel/);
  assert.match(source, /opportunity-live-rail/);
  assert.match(source, /pipelineLogs\.map/);
  assert.match(source, /opportunity-submit-button/);
  assert.match(source, /ref=\{pipelineLogViewportRef\}/);
});

test("a new workspace session starts with fresh run counters", () => {
  const initializePage = source.match(/async function initializePage\(\) \{[\s\S]*?\n  \}\n\n  async function refreshStores/)?.[0] || "";
  assert.ok(initializePage);
  assert.doesNotMatch(initializePage, /restoreLatest\(/);
  assert.match(initializePage, /restoreDoudianOpportunityPipelineTask\(\)/);
  assert.match(initializePage, /refreshStoreCategories\(activeStores\)/);
  assert.match(source, /onClick=\{\(\) => void restoreLatest\(\)\}/);
});

test("a new submit clears the prior workspace while completion restores and reports the persisted run", () => {
  const submit = source.match(/function runPipelineSubmit\(\) \{[\s\S]*?\n  \}\n\n  return \(/)?.[0] || "";
  assert.ok(submit);
  assert.match(submit, /setProducts\(\[\]\)/);
  assert.match(submit, /setClues\(\[\]\)/);
  assert.match(submit, /setCandidates\(\[\]\)/);
  assert.match(submit, /setExecutions\(\[\]\)/);
  assert.match(submit, /setPipelineLogs\(\[\]\)/);
  assert.match(source, /restorePipelineRun\(runId, \{ updatePipelineLog: true \}\)/);
  assert.match(source, /detail\.status === "succeeded" \|\| detail\.status === "failed"/);
  assert.match(domainSource, /const persistedResult = result\.runId[\s\S]*?fetchOpportunityPipelineRun/);
});

test("prematch overview uses concise animated business counters", () => {
  assert.match(source, /label="商品数"/);
  assert.match(source, /label="商机数"/);
  assert.match(source, /label="报名商品"/);
  assert.match(source, /label="报名记录"/);
  assert.match(source, /label="满额商品"/);
  assert.match(source, /selectedShopIds\.has\(row\.shopId\)/);
  assert.match(source, /value === null/);
  assert.match(source, /pipelineBusy \? "计算中" : "数据不完整"/);
  assert.match(source, /label="提报数"/);
  assert.match(source, /function AnimatedNumber/);
  assert.match(source, /opportunity-counter-ring/);
  assert.match(source, /<CompactMetric label="提报数" value=\{candidateSummary\.submittedCount\} tone="green" \/>/);
});

test("prematch times the next submission and increments after the success effect", () => {
  assert.match(source, /<span className="px-2 text-right">提报数<\/span>/);
  assert.match(source, /function SubmissionCount/);
  assert.match(source, /等待下一条已计时/);
  assert.match(source, /phase === "success"/);
  assert.match(source, /opportunity-submit-success/);
  assert.match(source, /displayedRef\.current \+ 1/);
  assert.match(source, /waitingForNextSubmission/);
  assert.doesNotMatch(source, /倒计时/);
  assert.doesNotMatch(source, /接口受理/);
});

test("auto submit list only loads requested candidates and hides status", () => {
  assert.match(source, /onlyRequested: true/);
  assert.match(domainSource, /requestedCandidates = candidates\.filter\(\(candidate\) => Boolean\(text\(candidate\.submitAttemptId\)\)\)/);
  assert.match(source, /已请求提报商品与商机词/);
  assert.doesNotMatch(source, /<th[^>]*>状态<\/th>/);
});

test("live stream formats screenshot-style timestamped operation strings", () => {
  assert.match(source, /getFullYear\(\)/);
  assert.match(source, /item\.time\}---/);
  assert.match(source, /获取商品名称/);
  assert.match(source, /提报商机/);
});

test("prematch moves processing stores first and keeps the category selection visible", () => {
  assert.match(source, /function storeRunPriority/);
  assert.match(source, /storeRunPriority\(left\.status, left\.phase\)/);
  assert.match(source, /data-processing=\{processing \? "true" : "false"\}/);
  assert.match(source, /border-\[#ffb08e\].*shadow-\[0_0_0_2px/);
});

test("stale category requests cannot overwrite the latest store selection", () => {
  assert.match(source, /const categoryRequestSeqRef = useRef\(0\)/);
  assert.match(source, /const requestSeq = \+\+categoryRequestSeqRef\.current/);
  assert.ok((source.match(/if \(requestSeq !== categoryRequestSeqRef\.current\) return false;/g) || []).length >= 3);
});
