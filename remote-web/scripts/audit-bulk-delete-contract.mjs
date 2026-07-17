import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const remoteWebRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(remoteWebRoot);
const read = (path) => readFileSync(join(repoRoot, path), "utf8");
const publicConfig = JSON.parse(read("remote-web/client-shell/public/config/doudian-adapter.json"));
const deployedConfig = JSON.parse(read("remote-web/new-remote-web/config/doudian-adapter.json"));
const bulkSource = read("remote-web/client-shell/src/domain/doudian/bulkDelete.ts");
const safetySource = read("remote-web/client-shell/src/domain/doudian/mutationSafety.ts");
const productStatusSource = read("remote-web/client-shell/src/domain/doudian/productStatus.ts");
const repositorySource = read("remote-web/client-shell/src/domain/doudian/repository.ts");
const pageSource = read("remote-web/client-shell/src/components/BulkDeletePage.tsx");
const workerSource = read("electron-client/src/main/database/worker.js");

assert.deepEqual(deployedConfig, publicConfig, "deployed adapter must match the source adapter");

const plans = publicConfig.requestPlans;
const policy = publicConfig.policies.bulkDelete;
for (const key of ["bulkDeleteBatchDelete", "bulkDeleteCompleteDelete"]) {
  const plan = plans[key];
  assert.equal(plan.sign, true, `${key} must be signed`);
  assert.equal(plan.localSignerOnly, true, `${key} must use the local xzb-compatible signer`);
  assert.equal(plan.signQuery, "appid=1");
  assert.equal(plan.signBody, "{formBody}");
  assert.equal(plan.body, "{formBody}");
  assert.equal(plan.headers["Content-Type"], "application/x-www-form-urlencoded;charset=UTF-8");
  assert.equal(plan.allowMissingCode, false);
  assert.equal(plan.retryOnHttpError, false);
  assert.equal(plan.maxAttempts, 1);
}
assert.match(plans.bulkDeleteBatchDelete.referer, /\/ffa\/g\/list$/);
assert.match(plans.bulkDeleteCompleteDelete.referer, /\/ffa\/g\/recycle$/);
assert.equal(policy.executeBatchSize, 100);
assert.ok(policy.liveLookupConcurrency > 1);
assert.ok(policy.maxPreviewAgeMs > 0);
assert.ok(policy.maxProjectedIdLookupRequests > 0);

assert.match(bulkSource, /formBody\.append\("product_ids\[\]", productId\)/);
assert.match(bulkSource, /const id = `\$\{runId\}:\$\{store\.shopId\}:/);
assert.match(bulkSource, /Object\.values\(responses\)\.every/);
assert.match(bulkSource, /repositoryGet<ScanRunRecord>\(bulkDeleteScanStore, sourceRunId\)/);
assert.match(bulkSource, /repositoryGetMany<DoudianBulkDeleteCandidate>\(bulkDeleteCandidateStore, \[\.\.\.selectedIds\]\)/);
assert.match(bulkSource, /"bulk delete item results missing"/);
assert.match(bulkSource, /useItemRows: stage === "recycle"/);
assert.match(bulkSource, /protectMode,/);
assert.match(bulkSource, /stages: stageRows\.map/);
assert.match(bulkSource, /status === "submitted"/);
assert.match(bulkSource, /status === "unknown"/);
assert.match(bulkSource, /bulk-delete-contract\.status-fields-partial-v2/);
assert.match(bulkSource, /run\.status === "partial" && args\.allowPartialScan === true/);
assert.match(bulkSource, /objectRecord\(item\.fieldSources\?\.stock\)\.mapped === true/);

assert.match(safetySource, /feature === "bulk-delete" && adapter\.requestPlans\?\.bulkDeleteProductList/);
assert.match(safetySource, /args\.protectMode === "skipSelling"/);
assert.match(safetySource, /Array\.from\(\{ length: concurrency \}/);
assert.match(safetySource, /reason: "already-recycled"/);
assert.match(safetySource, /confirmAttempts/);
assert.match(safetySource, /normalizeDoudianProductStatus/);
assert.match(productStatusSource, /\["0", "selling", "onsale", "on_sale"\]/);
assert.match(productStatusSource, /\["1", "offline", "off_sale", "offsale"\]/);
assert.match(productStatusSource, /\["2", "recycle", "recycled"\]/);
assert.match(productStatusSource, /审核驳回/);

const objectStoresMatch = repositorySource.match(/DOUDIAN_OBJECT_STORES\s*=\s*\[([\s\S]*?)\]\s*as const/);
assert.ok(objectStoresMatch, "repository object store list must be declared as a literal array");
assert.match(objectStoresMatch[1], /"bulk_delete_candidates_v1"/);
assert.match(repositorySource, /NATIVE_BATCH_RECORD_LIMIT = 500/);
assert.match(repositorySource, /NATIVE_BATCH_PAYLOAD_LIMIT = 4 \* 1024 \* 1024/);
assert.match(repositorySource, /storeName !== "stores" && storeName !== "groups"/);
assert.doesNotMatch(workerSource, /normalizeRecordIds[\s\S]{0,240}slice\(0,\s*10000\)/);
assert.match(workerSource, /records\.deleteMany cannot bypass store\/group delete side effects/);
assert.match(workerSource, /requested: recordIds\.length/);

assert.match(pageSource, /item\.validationStatus === "ok"/);
assert.match(pageSource, /onProgress: \(event\) => setProgress\(event\.percent\)/);
assert.match(pageSource, /shouldCancel: \(\) => cancelExecutionRef\.current/);
assert.match(pageSource, /item\.status === "submitted"/);
assert.match(pageSource, /allowPartialScan/);
assert.match(pageSource, /"取消执行"/);

console.log("BULK_DELETE_CONTRACT_OK");
