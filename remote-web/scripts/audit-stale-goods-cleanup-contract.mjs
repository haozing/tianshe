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
const bridgeSource = read("remote-web/client-shell/src/bridge/client.ts");

assert.deepEqual(deployedConfig, publicConfig, "deployed adapter must match the source adapter");

const plans = publicConfig.requestPlans;
const policy = publicConfig.policies.staleGoodsCleanup;
const mappings = publicConfig.responseMappings.staleGoodsCleanup;
const writePlanKeys = ["staleGoodsBatchOffline", "staleGoodsBatchDelete", "staleGoodsCompleteDelete"];
for (const key of writePlanKeys) {
  assert.equal(plans[key].dryRunOnly, true, `${key} must remain dry-run only`);
  assert.equal(plans[key].headers["Content-Type"], "application/x-www-form-urlencoded;charset=UTF-8");
  assert.equal(plans[key].body, "{formBody}");
}
assert.match(plans.staleGoodsCompleteDelete.referer, /\/ffa\/g\/recycle$/);
assert.equal(policy.executeBatchSize, 100);
assert.equal(policy.executePlans.delete, "staleGoodsBatchDelete");
assert.equal(policy.executePlans.completeDelete, "staleGoodsCompleteDelete");

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
assert.match(staleSource, /executions\.filter\(\(execution\) => !execution\.ok\)\.length/);

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

console.log("STALE_GOODS_CLEANUP_CONTRACT_OK");
