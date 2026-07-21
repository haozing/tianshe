import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const remoteWebRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(remoteWebRoot);
const read = (path) => readFileSync(join(repoRoot, path), "utf8");
const publicConfig = JSON.parse(read("remote-web/client-shell/public/config/doudian-adapter.json"));
const deployedConfig = JSON.parse(read("remote-web/new-remote-web/config/doudian-adapter.json"));
const staleSource = read("remote-web/client-shell/src/domain/doudian/staleGoods.ts");
const pageSource = read("remote-web/client-shell/src/components/SlowMovingCleanupPage.tsx");
const taskRunnerSource = read("remote-web/client-shell/src/domain/doudian/taskRunner.ts");
const bridgeSource = read("remote-web/client-shell/src/bridge/client.ts");

assert.deepEqual(deployedConfig, publicConfig, "deployed adapter must match the source adapter");

const plans = publicConfig.requestPlans;
const policy = publicConfig.policies.staleGoodsCleanup;
const mappings = publicConfig.responseMappings.staleGoodsCleanup;
const writePlanKeys = ["staleGoodsBatchOffline", "staleGoodsBatchDelete", "staleGoodsCompleteDelete"];
for (const key of writePlanKeys) {
  assert.equal(plans[key].mutation, true, `${key} must be a live mutation plan`);
  assert.equal(plans[key].maxAttempts, 1, `${key} must never retry`);
  assert.equal(plans[key].retryOnHttpError, false, `${key} must not retry HTTP errors`);
  assert.equal(plans[key].retryOnBusinessFailure, false, `${key} must not retry business failures`);
  assert.equal(plans[key].prepareRetryAttempts, 0, `${key} must not retry preparation`);
  assert.deepEqual(plans[key].successCodes, [0, "0"], `${key} must require the platform success code`);
  assert.equal(plans[key].dryRunOnly, undefined, `${key} must not expose a dry-run switch`);
  assert.equal(plans[key].headers["Content-Type"], "application/x-www-form-urlencoded;charset=UTF-8");
  assert.equal(plans[key].body, "{formBody}");
}
assert.match(plans.staleGoodsCompleteDelete.referer, /\/ffa\/g\/recycle$/);
assert.equal(policy.executeBatchSize, 100);
assert.equal(policy.executePlans.delete, "staleGoodsBatchDelete");
assert.equal(policy.executePlans.completeDelete, "staleGoodsCompleteDelete");
assert.equal(policy.automaticCompassMissingRowPolicy, "zero");
assert.equal(policy.importedCompassMissingRowPolicy, "unknown");
assert.equal(policy.pageConcurrency, 4);
assert.equal(policy.maxScanAgeMs, 900000);
assert.deepEqual(policy.allowedExecutionActions, ["offline", "recycle", "delete"]);

assert.ok(mappings.listPaths.length >= 5, "product response mapping must support nested list shapes");
assert.ok(mappings.recommendListPaths.length >= 4, "recommend response mapping must support known nested shapes");
assert.equal(plans.staleGoodsCompassDownload.responseType, "base64");
assert.ok(policy.requiredPlans.includes("staleGoodsRecommendAdmit"));
assert.ok(policy.requiredPlans.includes("staleGoodsCompassDownload"));

assert.match(staleSource, /repositoryGetMany<DoudianStaleGoodsCandidate>\("stale_candidates", ids\)/);
assert.match(staleSource, /chunksOf\(importedIds, 100\)/);
assert.match(staleSource, /params\.append\("product_ids\[\]", id\)/);
assert.match(staleSource, /collected\.complete/);
assert.match(staleSource, /findArray\(payloadForPage, listPaths/);
assert.match(staleSource, /recommendThresholds/);
assert.match(staleSource, /metricAvailability/);
assert.match(staleSource, /const implicitZeroTraffic = compassZeroFillSafe && !compassMatched/);
assert.match(staleSource, /compassValue !== undefined \|\| implicitZero/);
assert.match(staleSource, /stale goods compass workbook columns missing/);
assert.match(staleSource, /importedCompassMissingRowPolicy/);
assert.match(staleSource, /stale-goods-metrics-partial/);
assert.match(staleSource, /maxScanAgeMs/);
assert.match(staleSource, /candidate\.action !== action/);
assert.match(staleSource, /saveScanCheckpoint/);
assert.match(staleSource, /partialOk/);
assert.match(staleSource, /emptyOk/);
assert.doesNotMatch(staleSource, /const complete = responseOk && rows\.length > 0/);
assert.match(taskRunnerSource, /task\.taskType === "staleGoodsScan" \|\| task\.taskType === "staleGoodsExecute"/);
assert.match(taskRunnerSource, /candidatesDeferred/);
assert.match(staleSource, /executions\.filter\(\(execution\) => !execution\.ok\)\.length/);
assert.doesNotMatch(staleSource, /dryRunOnly|dry_run|executeDryRun|dryRun/);

const bridgeStart = bridgeSource.indexOf("export async function fetchDoudianStaleGoodsCleanup");
const bridgeEnd = bridgeSource.indexOf("export async function fetchDoudianBulkDeleteProducts", bridgeStart);
const staleBridge = bridgeSource.slice(bridgeStart, bridgeEnd);
assert.ok(bridgeStart >= 0 && bridgeEnd > bridgeStart, "stale goods bridge block missing");
assert.doesNotMatch(staleBridge, /\bcandidates\?:/);
assert.doesNotMatch(staleBridge, /args\.candidates/);

assert.doesNotMatch(pageSource, /candidates:\s*executable/);
assert.doesNotMatch(pageSource, /92\s*\+/);
assert.doesNotMatch(pageSource, /selectedExecutable\.length\s*\?/);
assert.doesNotMatch(pageSource, /next\.size\s*\?\s*next/);
assert.match(pageSource, /!planRows\.length/);
assert.match(pageSource, /row\.infoQualityScore > 0/);
assert.doesNotMatch(pageSource, /dryRun|dry_run|dryRunOnly/);
assert.match(pageSource, /无罗盘明细商品按零流量处理/);
assert.match(pageSource, /不可判定/);
assert.match(pageSource, /店铺扫描诊断/);
assert.match(pageSource, /cancelDoudianStoreOperation/);
assert.match(pageSource, /label="创建时间" operator="≥"/);
assert.match(pageSource, /label="上架时间" operator="≥"/);
assert.match(pageSource, /达到设定天数后才会进行后续操作/);
assert.doesNotMatch(pageSource, /创建时间未满|上架时间未满/);

console.log("STALE_GOODS_CLEANUP_CONTRACT_OK");
