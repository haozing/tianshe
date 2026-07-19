import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const remoteRoot = join(repoRoot, "remote-web");
const fixtureRoot = join(remoteRoot, "client-shell", "src", "domain", "doudian", "fixtures", "marketing");
const adapterPath = join(remoteRoot, "client-shell", "public", "config", "doudian-adapter.marketing-pilot.json");
const configPath = join(remoteRoot, "client-shell", "public", "config", "chihu-config.marketing-pilot.json");
const outputPath = join(remoteRoot, "artifacts", "doudian-marketing-fixture-audit.json");
const features = ["limited_time", "new_user_bonus", "general_coupon"];
const readActions = ["load_products", "list", "detail"];
const writeActionsByFeature = {
  limited_time: ["create", "disable", "end", "toggle_renew", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"],
  new_user_bonus: ["create", "disable"],
  general_coupon: ["create", "cancel", "toggle_renew"]
};
const scenarios = ["success", "failure"];
const sensitiveKeyPattern = /(^|[-_.])(authorization|cookie|set-cookie|token|csrf|session|password|secret)([-_.]|$)/i;
const sensitiveValuePattern = /(?:bearer\s+[a-z0-9._~+/=-]{8,}|(?:cookie|authorization|set-cookie|mstoken|passport_csrf|sessionid)\s*[:=]\s*[^,\s"']{4,})/i;

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  const output = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...jsonFiles(fullPath));
    else if (extname(entry.name).toLowerCase() === ".json") output.push(fullPath);
  }
  return output.sort();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function textList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function scanValue(value, path = [], findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValue(item, [...path, String(index)], findings));
    return findings;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const nextPath = [...path, key];
      if (sensitiveKeyPattern.test(key)) findings.push({ path: nextPath.join("."), reason: "sensitive key is forbidden" });
      scanValue(item, nextPath, findings);
    }
    return findings;
  }
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    findings.push({ path: path.join("."), reason: "unsafe integer must be stored as a string" });
  }
  if (typeof value === "string" && sensitiveValuePattern.test(value)) {
    findings.push({ path: path.join("."), reason: "sensitive-looking value is forbidden" });
  }
  return findings;
}

function validateFixture(filePath, fixture) {
  const issues = [];
  const request = objectValue(fixture.request);
  const response = objectValue(fixture.response);
  const expected = objectValue(fixture.expected);
  const featureActions = [...readActions, ...(writeActionsByFeature[fixture.feature] || [])];
  const phase = fixture.phase || (readActions.includes(fixture.action) ? "read" : "");
  const provenance = objectValue(fixture.provenance);
  const captureKind = String(provenance?.captureKind || "");
  if (fixture.schemaVersion !== 1) issues.push("schemaVersion must be 1");
  if (!features.includes(fixture.feature)) issues.push("feature is invalid");
  if (!featureActions.includes(fixture.action)) issues.push("action is invalid for feature");
  if (readActions.includes(fixture.action) ? phase !== "read" : !["mutation", "reconcile"].includes(phase)) issues.push("phase is invalid for action");
  if (!scenarios.includes(fixture.scenario)) issues.push("scenario must be success or failure");
  if (!objectValue(fixture.redaction) || fixture.redaction.enabled !== true) issues.push("redaction.enabled must be true");
  if (!new Set(["contract-sample", "real-session-capture"]).has(captureKind)) issues.push("provenance.captureKind is invalid");
  if (captureKind === "contract-sample") {
    if (!text(fixture.generatedAt) || !Number.isFinite(Date.parse(fixture.generatedAt))) issues.push("generatedAt must be an ISO timestamp");
    if (!text(provenance?.adapterVersion) || !text(provenance?.sourceArtifact) || !text(provenance?.entrySha256)) issues.push("contract sample provenance is incomplete");
  }
  if (captureKind === "real-session-capture") {
    if (!text(fixture.capturedAt) || !Number.isFinite(Date.parse(fixture.capturedAt))) issues.push("capturedAt must be an ISO timestamp");
    if (!text(provenance?.captureId) || !text(provenance?.sourceArtifact) || !/^[a-f0-9]{64}$/i.test(String(provenance?.captureSha256 || ""))) issues.push("real session capture provenance is incomplete");
  }
  if (!request) issues.push("request is required");
  if (request && !["GET", "POST"].includes(request.method)) issues.push("request.method must be GET or POST");
  if (request && (!text(request.path) || /^[a-z]+:\/\//i.test(request.path) || request.path.includes("?"))) issues.push("request.path must be a query-free relative path");
  if (request && !textList(request.queryKeys || [])) issues.push("request.queryKeys must contain strings");
  if (request && !textList(request.bodyKeys || [])) issues.push("request.bodyKeys must contain strings");
  if (request && !text(request.refererPath)) issues.push("request.refererPath is required");
  if (request && !text(request.signStrategy)) issues.push("request.signStrategy is required");
  if (!response) issues.push("response is required");
  if (response && (!Number.isInteger(response.httpStatus) || response.httpStatus < 100 || response.httpStatus > 599)) issues.push("response.httpStatus is invalid");
  if (response && response.body === undefined) issues.push("response.body is required");
  if (!expected || !Array.isArray(expected.entityIds) || !expected.entityIds.every((id) => typeof id === "string")) issues.push("expected.entityIds must be a string array");
  for (const finding of scanValue(fixture)) issues.push(`${finding.path}: ${finding.reason}`);
  return {
    file: rel(filePath),
    feature: String(fixture.feature || ""),
    action: String(fixture.action || ""),
    phase: String(phase || ""),
    scenario: String(fixture.scenario || ""),
    captureKind,
    entityIds: Array.isArray(expected?.entityIds) ? expected.entityIds : [],
    ok: issues.length === 0,
    issues
  };
}

const adapter = readJson(adapterPath);
const config = readJson(configPath);
const marketingCapability = adapter.capabilities?.marketing;
const forcePhase4 = process.env.MARKETING_FIXTURE_FORCE_PHASE4 === "1";
const requireRealFixtures = process.argv.includes("--require-real") || process.env.MARKETING_REQUIRE_REAL_FIXTURES === "1";
const marketingRequested = true;
const candidateWriteActions = Object.fromEntries(features.map((feature) => [feature, forcePhase4 ? writeActionsByFeature[feature] : Object.keys(adapter.policies?.marketing?.features?.[feature]?.writeActions || {})]));
const advertisedWriteActions = Object.fromEntries(features.map((feature) => [feature, marketingCapability?.features?.[feature]?.writeActions || []]));
const files = jsonFiles(fixtureRoot);
const fixtureResults = files.map((filePath) => {
  try {
    return validateFixture(filePath, readJson(filePath));
  } catch (error) {
    return { file: rel(filePath), feature: "", action: "", phase: "", scenario: "", captureKind: "", entityIds: [], ok: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
});
const caseKey = (item) => `${item.feature}:${item.action}:${item.phase}:${item.scenario}`;
const observedCases = new Set(fixtureResults.filter((item) => item.ok).map(caseKey));
const observedRealCases = new Set(fixtureResults.filter((item) => item.ok && item.captureKind === "real-session-capture").map(caseKey));
const requiredCases = marketingRequested ? [
  ...features.flatMap((feature) => readActions.flatMap((action) => scenarios.map((scenario) => `${feature}:${action}:read:${scenario}`))),
  ...features.flatMap((feature) => candidateWriteActions[feature].flatMap((action) => ["mutation", "reconcile"].flatMap((phase) => scenarios.map((scenario) => `${feature}:${action}:${phase}:${scenario}`))))
] : [];
const missingCases = requiredCases.filter((key) => !observedCases.has(key));
const missingRealCases = requiredCases.filter((key) => !observedRealCases.has(key));
const duplicateCases = [];
const caseCounts = new Map();
for (const item of fixtureResults) {
  const key = `${item.captureKind}:${caseKey(item)}`;
  caseCounts.set(key, (caseCounts.get(key) || 0) + 1);
}
for (const [key, count] of caseCounts) if (!key.endsWith(":::") && count > 1) duplicateCases.push(key);
const failedFixtures = fixtureResults.filter((item) => !item.ok);
const hasLargeStringId = fixtureResults.some((item) => item.entityIds.some((id) => typeof id === "string" && /^\d+$/.test(id) && BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER)));
const realFixtureCount = fixtureResults.filter((item) => item.ok && item.captureKind === "real-session-capture").length;
const contractSampleCount = fixtureResults.filter((item) => item.ok && item.captureKind === "contract-sample").length;
const writeGateClosed = config.features?.marketingWriteActions?.enabled === false && features.every((feature) => advertisedWriteActions[feature].length === 0);
// Contract samples gate normal builds. Real-session evidence remains an explicit
// strict audit so enabling a capability does not make release builds impossible.
const realEvidenceRequired = requireRealFixtures;
const missingEvidence = [
  ...(files.length ? [] : ["fixture_set_empty"]),
  ...(hasLargeStringId ? [] : ["large_integer_entity_id"])
];
const failed = failedFixtures.length > 0 || missingCases.length > 0 || duplicateCases.length > 0 || missingEvidence.length > 0 || (realEvidenceRequired && missingRealCases.length > 0);
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  status: failed ? "fail" : "ok",
  readiness: missingRealCases.length ? (realEvidenceRequired ? "blocked-real-fixtures" : "contract-ready-real-fixtures-unverified") : "ready",
  fixtureRoot: rel(fixtureRoot),
  fixtureCount: files.length,
  contractSampleCount,
  realFixtureCount,
  requiredCaseCount: requiredCases.length,
  candidateWriteActions,
  advertisedWriteActions,
  writeGateClosed,
  realEvidenceRequired,
  safeToEnableWrites: missingRealCases.length === 0,
  missingCases,
  missingRealCases,
  duplicateCases,
  missingEvidence,
  failedFixtureCount: failedFixtures.length,
  fixtures: fixtureResults
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
console.log(report.status === "ok" ? "DOUDIAN_MARKETING_FIXTURES_OK" : "DOUDIAN_MARKETING_FIXTURES_FAIL");
console.log(JSON.stringify({ status: report.status, readiness: report.readiness, fixtureCount: report.fixtureCount, contractSampleCount, realFixtureCount, missingCaseCount: missingCases.length, missingRealCaseCount: missingRealCases.length, missingEvidenceCount: missingEvidence.length, failedFixtureCount: failedFixtures.length, writeGateClosed, outputPath: rel(outputPath) }, null, 2));
if (failed) process.exit(1);
