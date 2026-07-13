import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outputPath = join(repoRoot, "remote-web", "artifacts", "product-catalog-release-gate.json");

const steps = [
  {
    key: "electronCheck",
    label: "Electron syntax/contract/assets",
    cwd: join(repoRoot, "electron-client"),
    command: process.platform === "win32" ? "cmd.exe" : "npm",
    args: process.platform === "win32" ? ["/d", "/s", "/c", "npm run check"] : ["run", "check"]
  },
  {
    key: "remoteTypecheck",
    label: "Remote Web typecheck",
    cwd: join(repoRoot, "remote-web", "client-shell"),
    command: process.platform === "win32" ? "cmd.exe" : "npm",
    args: process.platform === "win32" ? ["/d", "/s", "/c", "npm run typecheck"] : ["run", "typecheck"]
  },
  {
    key: "remoteBuild",
    label: "Remote Web release build",
    cwd: join(repoRoot, "remote-web", "client-shell"),
    command: process.platform === "win32" ? "cmd.exe" : "npm",
    args: process.platform === "win32" ? ["/d", "/s", "/c", "npm run build:release"] : ["run", "build:release"]
  },
  {
    key: "remoteReleaseCheck",
    label: "Remote Web release manifest check",
    cwd: repoRoot,
    command: process.execPath,
    args: [join(repoRoot, "remote-web", "scripts", "check-release.mjs")]
  },
  {
    key: "sqliteSmoke",
    label: "Electron SQLite smoke",
    cwd: join(repoRoot, "electron-client"),
    command: process.platform === "win32" ? "cmd.exe" : "npm",
    args: process.platform === "win32" ? ["/d", "/s", "/c", "npm run smoke:sqlite"] : ["run", "smoke:sqlite"]
  }
];

const sourceRoots = [
  join(repoRoot, "electron-client", "src"),
  join(repoRoot, "remote-web", "client-shell", "src")
];

const forbiddenPatterns = [
  { pattern: /window\.indexedDB|indexedDB\.open/g, reason: "IndexedDB business persistence must be disabled" },
  { pattern: /NATIVE_DATA_NOT_IMPLEMENTED|notImplemented\(/g, reason: "Native Data release APIs must not expose phase stubs" }
];

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function collectFiles(root) {
  const output = [];
  for (const name of readdirSync(root)) {
    const fullPath = join(root, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) output.push(...collectFiles(fullPath));
    else if (/\.(js|jsx|ts|tsx|sql)$/.test(name)) output.push(fullPath);
  }
  return output;
}

function runStep(step) {
  const startedAt = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    key: step.key,
    label: step.label,
    status: result.status === 0 ? "ok" : "fail",
    exitCode: result.status,
    durationMs: Date.now() - startedAt,
    stdoutTail: String(result.stdout || "").slice(-4000),
    stderrTail: String(result.stderr || "").slice(-4000)
  };
}

function scanForbiddenPatterns() {
  const hits = [];
  const files = sourceRoots.flatMap((root) => collectFiles(root));
  for (const filePath of files) {
    const text = readFileSync(filePath, "utf8");
    for (const item of forbiddenPatterns) {
      item.pattern.lastIndex = 0;
      let match = item.pattern.exec(text);
      while (match) {
        const before = text.slice(0, match.index);
        const line = before.split(/\r?\n/).length;
        hits.push({ file: rel(filePath), line, match: match[0], reason: item.reason });
        match = item.pattern.exec(text);
      }
    }
  }
  return hits;
}

function verifyReleaseArtifacts() {
  const files = [
    "remote-web/new-remote-web/index.html",
    "remote-web/new-remote-web/app.js",
    "remote-web/new-remote-web/styles.css",
    "remote-web/new-remote-web/release-manifest.json",
    "remote-web/new-remote-web/config/chihu-config.json",
    "remote-web/new-remote-web/config/doudian-adapter.json"
  ];
  return files.map((file) => {
    const fullPath = join(repoRoot, file);
    return { file, exists: existsSync(fullPath), sizeBytes: existsSync(fullPath) ? statSync(fullPath).size : 0 };
  });
}

function verifySchema() {
  const schema = readFileSync(join(repoRoot, "electron-client", "src", "main", "database", "schema-v1.sql"), "utf8");
  const worker = readFileSync(join(repoRoot, "electron-client", "src", "main", "database", "worker.js"), "utf8");
  return {
    nativeRecords: schema.includes("CREATE TABLE IF NOT EXISTS native_records"),
    catalogJobs: schema.includes("CREATE TABLE IF NOT EXISTS catalog_jobs"),
    catalogLatestFields: schema.includes("CREATE TABLE IF NOT EXISTS catalog_latest_fields"),
    mutationConfirmStatuses: schema.includes("confirm-timeout") && schema.includes("conflict"),
    backupApi: worker.includes("VACUUM INTO") && worker.includes("maintenance.createBackup"),
    corruptionRecovery: worker.includes("quarantineDatabaseFiles") && worker.includes("NATIVE_DATA_CORRUPT"),
    recordApi: worker.includes("records.put") && worker.includes("records.list"),
    featureApi: worker.includes("features.saveStaleRun") && worker.includes("features.loadOpportunityCandidates"),
    opportunityPipelineStores: worker.includes("opportunity_pipeline_runs_v2") &&
      worker.includes("opportunity_pipeline_submit_tasks_v2") &&
      worker.includes("opportunity_clue_word_cache_shards_v2")
  };
}

function verifyBusinessSafety() {
  const mutationSafety = readFileSync(join(repoRoot, "remote-web", "client-shell", "src", "domain", "doudian", "mutationSafety.ts"), "utf8");
  const staleGoods = readFileSync(join(repoRoot, "remote-web", "client-shell", "src", "domain", "doudian", "staleGoods.ts"), "utf8");
  const bulkDelete = readFileSync(join(repoRoot, "remote-web", "client-shell", "src", "domain", "doudian", "bulkDelete.ts"), "utf8");
  const opportunity = readFileSync(join(repoRoot, "remote-web", "client-shell", "src", "domain", "doudian", "opportunityReport.ts"), "utf8");
  return {
    mutationSafetyHelper: mutationSafety.includes("prepareMutationSafety") && mutationSafety.includes("recordExecutionMutationResults"),
    liveLookupBeforeMutation: mutationSafety.includes("liveLookupProduct") && mutationSafety.includes("allowedStatus"),
    staleMutationSafety: staleGoods.includes("prepareMutationSafety") && staleGoods.includes("recordExecutionMutationResults"),
    bulkMutationSafety: bulkDelete.includes("prepareMutationSafety") && bulkDelete.includes("recordExecutionMutationResults"),
    opportunityMutationSafety: opportunity.includes("prepareMutationSafety") && opportunity.includes("recordExecutionMutationResults"),
    opportunityPipelineMode: opportunity.includes("pipeline-submit") && opportunity.includes("fetchPipelineSubmit"),
    opportunityPipelineCache: opportunity.includes("loadCluesByCategoryWithCache") && opportunity.includes("tokenizeCluesWithCache"),
    opportunityPipelineWorker: opportunity.includes("runSubmitWorker") && opportunity.includes("validatedByPipeline")
  };
}

function sha512Base64(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("base64");
}

function verifyDesktopArtifacts() {
  const releaseDir = join(repoRoot, "electron-client", "release");
  const electronPackage = JSON.parse(readFileSync(join(repoRoot, "electron-client", "package.json"), "utf8"));
  const version = electronPackage.version;
  const setupPath = join(releaseDir, `chihu-guanjia-${version}-setup.exe`);
  const portablePath = join(releaseDir, `chihu-guanjia-${version}-portable.exe`);
  const blockmapPath = join(releaseDir, `chihu-guanjia-${version}-setup.exe.blockmap`);
  const latestPath = join(releaseDir, "latest.yml");
  const phasePath = join(releaseDir, "phase2.yml");
  const publishScript = readFileSync(join(repoRoot, "scripts", "publish-oss.mjs"), "utf8");
  const setupExists = existsSync(setupPath) && statSync(setupPath).isFile();
  const setupSize = setupExists ? statSync(setupPath).size : 0;
  const setupSha512 = setupExists ? sha512Base64(setupPath) : "";
  const latestText = existsSync(latestPath) ? readFileSync(latestPath, "utf8") : "";
  const phaseText = existsSync(phasePath) ? readFileSync(phasePath, "utf8") : "";
  return {
    setupExists,
    portableExists: existsSync(portablePath) && statSync(portablePath).isFile(),
    blockmapExists: existsSync(blockmapPath) && statSync(blockmapPath).isFile(),
    latestExists: existsSync(latestPath) && statSync(latestPath).isFile(),
    phaseExists: existsSync(phasePath) && statSync(phasePath).isFile(),
    latestMatchesSetupSize: setupSize > 0 && latestText.includes(`size: ${setupSize}`),
    latestMatchesSetupSha512: !!setupSha512 && latestText.includes(setupSha512),
    phaseMatchesSetupSha512: !!setupSha512 && phaseText.includes(setupSha512),
    publishRegeneratesLatest: !publishScript.includes("if (existsSync(latestPath)) return latestPath")
  };
}

const stepResults = steps.map(runStep);
const forbiddenHits = scanForbiddenPatterns();
const artifacts = verifyReleaseArtifacts();
const schema = verifySchema();
const businessSafety = verifyBusinessSafety();
const desktopArtifacts = verifyDesktopArtifacts();
const failedChecks = [
  ...stepResults.filter((step) => step.status !== "ok").map((step) => ({ key: step.key, reason: "command failed" })),
  ...forbiddenHits.map((hit) => ({ key: "forbiddenPattern", reason: `${hit.reason}: ${hit.file}:${hit.line}` })),
  ...artifacts.filter((artifact) => !artifact.exists || artifact.sizeBytes <= 0).map((artifact) => ({ key: "artifact", reason: `${artifact.file} missing or empty` })),
  ...Object.entries(schema).filter(([, ok]) => ok !== true).map(([key]) => ({ key: "schema", reason: `${key} is not satisfied` })),
  ...Object.entries(businessSafety).filter(([, ok]) => ok !== true).map(([key]) => ({ key: "businessSafety", reason: `${key} is not satisfied` })),
  ...Object.entries(desktopArtifacts).filter(([, ok]) => ok !== true).map(([key]) => ({ key: "desktopArtifacts", reason: `${key} is not satisfied` }))
];

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: failedChecks.length ? "fail" : "ok",
  scope: "product-catalog-sqlite-release-gate",
  steps: stepResults,
  forbiddenHits,
  artifacts,
  schema,
  businessSafety,
  desktopArtifacts,
  failedChecks
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

console.log(report.status === "ok" ? "PRODUCT_CATALOG_RELEASE_GATE_OK" : "PRODUCT_CATALOG_RELEASE_GATE_FAIL");
console.log(JSON.stringify({ status: report.status, failedChecks: report.failedChecks.length, outputPath: rel(outputPath) }, null, 2));

if (report.status !== "ok") process.exit(1);
