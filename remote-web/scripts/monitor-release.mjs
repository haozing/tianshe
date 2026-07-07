import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const artifactsDir = join(root, "artifacts");
const releaseCheckPath = join(artifactsDir, "release-check.json");
const smokeResultPath = join(artifactsDir, "headless-result.json");
const packageIndexPath = join(artifactsDir, "release-packages", "index.json");
const jsonOutputPath = join(artifactsDir, "release-monitor.json");
const mdOutputPath = join(artifactsDir, "release-monitor.md");

function parseArgs(argv) {
  const args = { env: process.env.REMOTE_DEPLOY_ENV || "local" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--env") {
      args.env = argv[index + 1] || args.env;
      index += 1;
    } else if (value.startsWith("--env=")) {
      args.env = value.slice("--env=".length);
    } else if (!value.startsWith("-")) {
      args.env = value;
    }
  }
  return args;
}

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function readJsonIfExists(filePath, defaultValue) {
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : defaultValue;
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status === 0;
}

function addCheck(checks, category, name, status, detail, evidence) {
  checks.push({ category, name, status, detail, evidence });
}

function mdTable(rows) {
  return [
    "| Category | Check | Status | Detail | Evidence |",
    "|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.category} | ${row.name} | ${row.status} | ${String(row.detail).replace(/\|/g, "\\|")} | ${row.evidence} |`)
  ].join("\n");
}

function renderMarkdown(report) {
  return [
    "# Remote Web Release Monitor",
    "",
    `- environment: ${report.environment}`,
    `- status: ${report.status}`,
    `- releaseId: ${report.releaseId}`,
    `- generatedAt: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- checks: ${report.summary.checkCount}`,
    `- ok: ${report.summary.ok}`,
    `- warn: ${report.summary.warnings}`,
    `- fail: ${report.summary.failed}`,
    "",
    "## Checks",
    "",
    mdTable(report.checks),
    "",
    "## Next Actions",
    "",
    ...report.nextActions.map((item) => `- ${item}`)
  ].join("\n");
}

mkdirSync(artifactsDir, { recursive: true });

const args = parseArgs(process.argv.slice(2));
const env = args.env;
const envSafe = String(env || "local").replace(/[^a-zA-Z0-9_.-]+/g, "_");
const deployConfigCheckPath = join(artifactsDir, `deploy-config-check-${envSafe}.json`);
const cdnHeaderSamplePath = join(artifactsDir, `cdn-header-sample-${envSafe}.json`);

const releaseGateOk = runNode([join(root, "scripts", "check-release.mjs")]);
const deployGateOk = runNode([join(root, "scripts", "check-deploy-config.mjs"), "--env", env]);

const releaseCheck = readJsonIfExists(releaseCheckPath, null);
const deployCheck = readJsonIfExists(deployConfigCheckPath, null);
const smoke = readJsonIfExists(smokeResultPath, []);
const packageIndex = readJsonIfExists(packageIndexPath, null);
const cdnHeaderSample = readJsonIfExists(cdnHeaderSamplePath, null);

const checks = [];
addCheck(
  checks,
  "release",
  "release gate",
  releaseGateOk && releaseCheck && releaseCheck.ok ? "ok" : "fail",
  releaseGateOk ? "check-release.mjs passed" : "check-release.mjs failed",
  rel(releaseCheckPath)
);

addCheck(
  checks,
  "entry",
  "single clean entry",
  releaseCheck && releaseCheck.entry && releaseCheck.entry.newRemoteOrigin === "/new-remote-web/" ? "ok" : "fail",
  `newRemoteOrigin=${releaseCheck && releaseCheck.entry ? releaseCheck.entry.newRemoteOrigin : ""}`,
  "new-remote-web/config/chihu-config.json"
);

const requiredArtifactTypes = ["remote-html", "remote-js", "remote-css", "remote-asset", "chihu-config", "release-manifest"];
const artifactTypes = new Set((releaseCheck && releaseCheck.artifacts || []).map((item) => item.type));
const missingTypes = requiredArtifactTypes.filter((type) => !artifactTypes.has(type));
addCheck(
  checks,
  "release",
  "required artifact types",
  missingTypes.length ? "fail" : "ok",
  missingTypes.length ? `missing ${missingTypes.join(", ")}` : `${requiredArtifactTypes.length} clean artifact types present`,
  rel(releaseCheckPath)
);

addCheck(
  checks,
  "deploy",
  "deploy config gate",
  deployGateOk && deployCheck && deployCheck.status !== "fail" ? deployCheck.status : "fail",
  deployCheck ? `failed=${deployCheck.summary.failed}, warnings=${deployCheck.summary.warnings}` : "deploy config report missing",
  rel(deployConfigCheckPath)
);

const smokeFailed = Array.isArray(smoke) ? smoke.filter((item) => !item.ok) : [];
addCheck(
  checks,
  "smoke",
  "foundation smoke",
  Array.isArray(smoke) && smoke.length >= 5 && smokeFailed.length === 0 ? "ok" : "fail",
  Array.isArray(smoke) ? `${smoke.length}/5 checks, failed=${smokeFailed.length}` : "smoke report missing",
  rel(smokeResultPath)
);

const packageCount = packageIndex && Array.isArray(packageIndex.packages) ? packageIndex.packages.length : 0;
addCheck(
  checks,
  "package",
  "release package index",
  packageIndex && packageCount >= 1 ? "ok" : "warn",
  packageIndex ? `packages=${packageCount}` : "package index missing",
  rel(packageIndexPath)
);

addCheck(
  checks,
  "cdn",
  "cdn header sample",
  cdnHeaderSample ? cdnHeaderSample.status : "warn",
  cdnHeaderSample ? `samples=${cdnHeaderSample.summary.sampleCount}, failed=${cdnHeaderSample.summary.failed}` : "header sample not run",
  rel(cdnHeaderSamplePath)
);

const failed = checks.filter((check) => check.status === "fail");
const warnings = checks.filter((check) => check.status === "warn");
const status = failed.length ? "fail" : warnings.length ? "warn" : "ok";
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: env,
  status,
  releaseId: releaseCheck && releaseCheck.releaseId || "",
  summary: {
    checkCount: checks.length,
    failed: failed.length,
    warnings: warnings.length,
    ok: checks.filter((check) => check.status === "ok").length
  },
  checks,
  nextActions: status === "ok"
    ? ["Clean foundation is ready for the next environment."]
    : ["Fix failed clean-foundation checks before adding business code."],
  outputs: {
    json: rel(jsonOutputPath),
    markdown: rel(mdOutputPath)
  }
};

writeFileSync(jsonOutputPath, JSON.stringify(report, null, 2), "utf8");
writeFileSync(mdOutputPath, renderMarkdown(report), "utf8");

console.log("RELEASE_MONITOR_" + status.toUpperCase());
console.log(JSON.stringify({
  status: report.status,
  checkCount: report.summary.checkCount,
  failed: report.summary.failed,
  warnings: report.summary.warnings,
  json: report.outputs.json,
  markdown: report.outputs.markdown
}, null, 2));

if (status === "fail") process.exit(1);
