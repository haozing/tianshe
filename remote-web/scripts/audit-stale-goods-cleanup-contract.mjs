import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const remoteWebRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(remoteWebRoot);
const read = (path) => readFileSync(join(repoRoot, path), "utf8");
const publicConfig = JSON.parse(read("remote-web/client-shell/public/config/doudian-adapter.json"));
const deployedConfig = JSON.parse(read("remote-web/new-remote-web/config/doudian-adapter.json"));
const publicPilotConfig = JSON.parse(read("remote-web/client-shell/public/config/doudian-adapter.marketing-pilot.json"));
const deployedPilotConfig = JSON.parse(read("remote-web/new-remote-web/config/doudian-adapter.marketing-pilot.json"));
const staleSource = read("remote-web/client-shell/src/domain/doudian/staleGoods.ts");
const pageSource = read("remote-web/client-shell/src/components/SlowMovingCleanupPage.tsx");
const taskRunnerSource = read("remote-web/client-shell/src/domain/doudian/taskRunner.ts");
const bridgeSource = read("remote-web/client-shell/src/bridge/client.ts");

assert.deepEqual(deployedConfig, publicConfig, "deployed adapter must match the source adapter");
assert.deepEqual(deployedPilotConfig, publicPilotConfig, "deployed marketing pilot adapter must match the source adapter");

const plans = publicConfig.requestPlans;
const policy = publicConfig.policies.staleGoodsCleanup;
const mappings = publicConfig.responseMappings.staleGoodsCleanup;
const writePlanKeys = ["staleGoodsBatchOffline", "staleGoodsBatchDelete", "staleGoodsCompleteDelete"];
for (const [label, config] of [["default", publicConfig], ["marketing-pilot", publicPilotConfig]]) {
  const candidatePlans = config.requestPlans;
  assert.equal(candidatePlans.staleGoodsProductList.query.id_name_code, "{idNameCode}", `${label} product lookup must support id_name_code`);
  for (const key of writePlanKeys) {
    assert.equal(candidatePlans[key].mutation, true, `${label} ${key} must be a live mutation plan`);
    assert.equal(candidatePlans[key].sign, true, `${label} ${key} must sign the live request`);
    assert.equal(candidatePlans[key].signStrategy, "mstoken-myargs", `${label} ${key} must use the verified mstoken signer`);
    assert.equal(candidatePlans[key].localSignerOnly, true, `${label} ${key} must use the local verified signer`);
    assert.equal(candidatePlans[key].signQuery, "appid=1", `${label} ${key} must sign with appid=1`);
    assert.equal(candidatePlans[key].signBody, "{formBody}", `${label} ${key} must sign the submitted form body`);
    assert.equal(candidatePlans[key].signUseMsToken, true, `${label} ${key} must include msToken in signing`);
    assert.equal(candidatePlans[key].signRequireMsToken, false, `${label} ${key} must tolerate an absent msToken`);
    assert.equal(candidatePlans[key].signIncludeEmptyMsToken, true, `${label} ${key} must preserve empty msToken signing`);
    assert.equal(candidatePlans[key].maxAttempts, 1, `${label} ${key} must never retry`);
    assert.equal(candidatePlans[key].retryOnHttpError, false, `${label} ${key} must not retry HTTP errors`);
    assert.equal(candidatePlans[key].retryOnBusinessFailure, false, `${label} ${key} must not retry business failures`);
    assert.equal(candidatePlans[key].prepareRetryAttempts, 0, `${label} ${key} must not retry preparation`);
    assert.deepEqual(candidatePlans[key].successCodes, [0, "0"], `${label} ${key} must require the platform success code`);
    assert.equal(candidatePlans[key].dryRunOnly, undefined, `${label} ${key} must not expose a dry-run switch`);
    assert.equal(candidatePlans[key].headers["Content-Type"], "application/x-www-form-urlencoded;charset=UTF-8");
    assert.equal(candidatePlans[key].body, "{formBody}");
  }
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
assert.doesNotMatch(staleSource, /candidate\.action !== action/);
assert.match(staleSource, /group\.candidates\.push\(\{ \.\.\.candidate, sourceRunId, action \}\)/);
assert.match(staleSource, /snapshotIds\.size > 0 \? !snapshotIds\.has\(candidate\.id\) : candidate\.sourceRunId !== sourceRunId/);
assert.match(staleSource, /saveScanCheckpoint/);
assert.match(staleSource, /partialOk/);
assert.match(staleSource, /emptyOk/);
assert.match(staleSource, /feature:\s*"stale-goods-cleanup"/);
assert.match(staleSource, /idNameCode: source === "importedIds"/);
assert.match(staleSource, /execution\.ok && execution\.status === "submitted"/);
assert.match(staleSource, /execution\.status !== "submitted"/);
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
