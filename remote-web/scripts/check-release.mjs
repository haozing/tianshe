import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const artifactsDir = join(root, "artifacts");
const manifestPath = join(root, "new-remote-web", "release-manifest.json");
const chihuConfigPath = join(root, "new-remote-web", "config", "chihu-config.json");
const doudianAdapterPath = join(root, "new-remote-web", "config", "doudian-adapter.json");
const outputPath = join(artifactsDir, "release-check.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertRelativeSafe(path) {
  assert(typeof path === "string" && path.trim(), "artifact.path must be non-empty string");
  assert(!path.includes(".."), `artifact path must not escape release root: ${path}`);
  assert(!/^[a-z]+:\/\//i.test(path), `artifact path must be relative: ${path}`);
}

function classifyCacheRisk(artifact) {
  if (artifact.cache === "no-cache") {
    return "html-config-safe";
  }
  if (artifact.cache === "immutable-after-hash-build") {
    return "requires-hash-build";
  }
  return "short-cache";
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasStringItems(value) {
  return Array.isArray(value) && value.some((item) => hasText(item));
}

function assertDoudianAdapter(adapter) {
  const missing = [];
  const requireText = (path, value) => {
    if (!hasText(value)) missing.push(path);
  };
  const requireArray = (path, value) => {
    if (!hasStringItems(value)) missing.push(path);
  };
  const requireObject = (path, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) missing.push(path);
  };

  assert(adapter && adapter.schemaVersion === 1, "doudian adapter schemaVersion must be 1");
  assert(adapter.platform === "doudian", "doudian adapter platform must be doudian");
  requireText("version", adapter.version);
  requireText("origin", adapter.origin);
  requireText("sourcePartition", adapter.sourcePartition);
  requireText("shopPartitionPrefix", adapter.shopPartitionPrefix);
  requireText("signerPartition", adapter.signerPartition);
  requireText("loginUrl", adapter.loginUrl);
  requireText("homeUrl", adapter.homeUrl);
  requireText("chooseEntriesUrl", adapter.chooseEntriesUrl);
  requireText("endpoints.shopList", adapter.endpoints && adapter.endpoints.shopList);
  requireText("endpoints.currentShop", adapter.endpoints && adapter.endpoints.currentShop);
  requireArray("selectors.headerShopName", adapter.selectors && adapter.selectors.headerShopName);
  requireText("selectors.roleItem", adapter.selectors && adapter.selectors.roleItem);
  requireText("selectors.roleStatus", adapter.selectors && adapter.selectors.roleStatus);
  requireText("selectors.roleName", adapter.selectors && adapter.selectors.roleName);
  requireText("labels.workbench", adapter.labels && adapter.labels.workbench);
  requireText("labels.singleLogin", adapter.labels && adapter.labels.singleLogin);
  requireText("cookieDomain", adapter.cookieDomain);
  requireArray("cookieHintNames", adapter.cookieHintNames);
  requireArray("blockedSchemes", adapter.blockedSchemes);
  requireArray("sign.candidates", adapter.sign && adapter.sign.candidates);
  requireText("sign.candidateKeyPattern", adapter.sign && adapter.sign.candidateKeyPattern);
  requireArray("sign.enablePathList", adapter.sign && adapter.sign.enablePathList);
  requireArray("responseMappings.shopListPaths", adapter.responseMappings && adapter.responseMappings.shopListPaths);
  requireArray("responseMappings.currentShopIdPaths", adapter.responseMappings && adapter.responseMappings.currentShopIdPaths);
  requireArray("responseMappings.currentShopObjectPaths", adapter.responseMappings && adapter.responseMappings.currentShopObjectPaths);
  requireArray("responseMappings.shopFields.id", adapter.responseMappings && adapter.responseMappings.shopFields && adapter.responseMappings.shopFields.id);
  requireArray("responseMappings.shopFields.name", adapter.responseMappings && adapter.responseMappings.shopFields && adapter.responseMappings.shopFields.name);
  requireArray("requestPlans.getShopUserInfo.steps", adapter.requestPlans && adapter.requestPlans.getShopUserInfo && adapter.requestPlans.getShopUserInfo.steps);
  requireObject("policies", adapter.policies);
  requireObject("policies.getShopUserInfo", adapter.policies && adapter.policies.getShopUserInfo);
  requireObject("policies.refreshStatus", adapter.policies && adapter.policies.refreshStatus);
  requireObject("policies.fetchStores", adapter.policies && adapter.policies.fetchStores);
  requireObject("policies.importStore", adapter.policies && adapter.policies.importStore);
  requireObject("policies.activateStore", adapter.policies && adapter.policies.activateStore);
  requireObject("policies.platformRequest", adapter.policies && adapter.policies.platformRequest);
  requireObject("policies.repository", adapter.policies && adapter.policies.repository);

  assert(missing.length === 0, `doudian adapter missing required fields: ${missing.join(", ")}`);
}

mkdirSync(artifactsDir, { recursive: true });

const manifest = readJson(manifestPath);
const chihuConfig = readJson(chihuConfigPath);
const doudianAdapter = readJson(doudianAdapterPath);

assert(manifest.schemaVersion === 1, "release manifest schemaVersion must be 1");
assert(typeof manifest.releaseId === "string" && manifest.releaseId, "releaseId is required");
assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, "release artifacts are required");
assert(manifest.rollback && manifest.rollback.config && manifest.rollback.resource && manifest.rollback.shell, "rollback matrix is incomplete");

assert(chihuConfig.assets && typeof chihuConfig.assets.manifestUrl === "string" && chihuConfig.assets.manifestUrl.endsWith("release-manifest.json"), "chihu config must reference release manifest");
assert(chihuConfig.entry && typeof chihuConfig.entry.newRemoteOrigin === "string" && chihuConfig.entry.newRemoteOrigin, "chihu config newRemoteOrigin is required");
assert(chihuConfig.release && chihuConfig.release.gitCommit, "chihu config release.gitCommit is required");
assert(chihuConfig.release && chihuConfig.release.buildTime, "chihu config release.buildTime is required");
assertDoudianAdapter(doudianAdapter);

const seen = new Set();
const checkedArtifacts = manifest.artifacts.map((artifact) => {
  assertRelativeSafe(artifact.path);
  assert(!seen.has(artifact.path), `duplicate artifact path: ${artifact.path}`);
  seen.add(artifact.path);

  const absolutePath = join(root, artifact.path);
  const exists = existsSync(absolutePath) && statSync(absolutePath).isFile();
  assert(exists || artifact.required === false, `required artifact is missing: ${artifact.path}`);
  const actualSha256 = exists ? sha256(absolutePath) : null;

  if (artifact.required !== false && artifact.type !== "release-manifest") {
    assert(isSha256(artifact.sha256), `required artifact must declare sha256: ${artifact.path}`);
    assert(artifact.sha256.toLowerCase() === actualSha256, `artifact sha256 mismatch: ${artifact.path}`);
  }
  if (artifact.type === "release-manifest") {
    assert(artifact.sha256Mode === "computed-by-release-gate", "release-manifest self hash must use sha256Mode=computed-by-release-gate");
  }

  return {
    path: artifact.path,
    type: artifact.type,
    cache: artifact.cache,
    cacheRisk: classifyCacheRisk(artifact),
    required: artifact.required !== false,
    size: exists ? statSync(absolutePath).size : 0,
    sha256: actualSha256,
    manifestSha256: artifact.sha256 || null,
    sha256Mode: artifact.sha256Mode || "declared"
  };
});

const requiredTypes = [
  "remote-html",
  "remote-js",
  "remote-css",
  "remote-asset",
  "chihu-config",
  "release-manifest"
];

const types = new Set(checkedArtifacts.map((artifact) => artifact.type));
requiredTypes.forEach((type) => {
  assert(types.has(type), `release manifest missing artifact type: ${type}`);
});

const report = {
  ok: true,
  checkedAt: new Date().toISOString(),
  releaseId: manifest.releaseId,
  manifestPath: "new-remote-web/release-manifest.json",
  artifactCount: checkedArtifacts.length,
  totalBytes: checkedArtifacts.reduce((sum, artifact) => sum + artifact.size, 0),
  entry: {
    mode: "direct-new-remote-web",
    remoteWebOrigin: manifest.entry && manifest.entry.remoteWebOrigin || "",
    newRemoteOrigin: chihuConfig.entry && chihuConfig.entry.newRemoteOrigin || ""
  },
  chihuConfig: {
    version: chihuConfig.version,
    manifestUrl: chihuConfig.assets.manifestUrl,
    buildTime: chihuConfig.release.buildTime,
    gitCommit: chihuConfig.release.gitCommit
  },
  doudianAdapter: {
    version: doudianAdapter.version,
    source: doudianAdapter.source || "",
    cache: "no-cache",
    blockedSchemes: doudianAdapter.blockedSchemes.length,
    responseMappings: Object.keys(doudianAdapter.responseMappings || {}).length
  },
  rollback: manifest.rollback,
  artifacts: checkedArtifacts
};

writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

console.log("RELEASE_CHECK_OK");
console.log(JSON.stringify({
  releaseId: report.releaseId,
  artifactCount: report.artifactCount,
  totalBytes: report.totalBytes,
  outputPath
}, null, 2));
