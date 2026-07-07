import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const artifactsDir = join(repoRoot, "remote-web", "artifacts");
const docsDir = join(repoRoot, "docs");
const jsonOutputPath = join(artifactsDir, "foundation-local-gate.json");
const mdOutputPath = join(docsDir, "\u5c0f\u5c0a\u5b9d2.0\u57fa\u7840\u5e95\u5ea7\u672c\u5730\u95e8\u7981\u62a5\u544a.md");

const steps = [
  {
    key: "electronCheck",
    label: "Electron clean foundation check",
    cwd: join(repoRoot, "electron-client"),
    command: process.platform === "win32" ? "cmd.exe" : "npm",
    args: process.platform === "win32" ? ["/d", "/s", "/c", "npm run check"] : ["run", "check"],
    reportPath: ""
  },
  {
    key: "remoteRelease",
    label: "Remote Web release gate",
    cwd: repoRoot,
    command: process.execPath,
    args: [join(repoRoot, "remote-web", "scripts", "check-release.mjs")],
    reportPath: join(repoRoot, "remote-web", "artifacts", "release-check.json")
  },
  {
    key: "deployConfig",
    label: "Local deploy config gate",
    cwd: repoRoot,
    command: process.execPath,
    args: [join(repoRoot, "remote-web", "scripts", "check-deploy-config.mjs"), "--env", "local"],
    reportPath: join(repoRoot, "remote-web", "artifacts", "deploy-config-check-local.json")
  },
  {
    key: "webStorageIsolation",
    label: "Web storage isolation audit",
    cwd: repoRoot,
    command: process.execPath,
    args: [join(repoRoot, "remote-web", "scripts", "audit-web-storage-isolation.mjs")],
    reportPath: join(repoRoot, "remote-web", "artifacts", "web-storage-isolation-audit.json")
  },
  {
    key: "bridgePermission",
    label: "Bridge permission matrix audit",
    cwd: repoRoot,
    command: process.execPath,
    args: [join(repoRoot, "remote-web", "scripts", "audit-bridge-permission-matrix.mjs")],
    reportPath: join(repoRoot, "remote-web", "artifacts", "bridge-permission-matrix-audit.json")
  },
  {
    key: "doudianLocalLeakage",
    label: "Doudian local leakage audit",
    cwd: repoRoot,
    command: process.execPath,
    args: [join(repoRoot, "remote-web", "scripts", "audit-doudian-local-leakage.mjs")],
    reportPath: join(repoRoot, "remote-web", "artifacts", "doudian-local-leakage-audit.json")
  },
  {
    key: "doudianRemoteUpdateMatrix",
    label: "Doudian remote update matrix audit",
    cwd: repoRoot,
    command: process.execPath,
    args: [join(repoRoot, "remote-web", "scripts", "audit-doudian-remote-update-matrix.mjs")],
    reportPath: join(repoRoot, "remote-web", "artifacts", "doudian-remote-update-matrix.json")
  },
  {
    key: "foundationProgress",
    label: "Foundation progress audit",
    cwd: repoRoot,
    command: process.execPath,
    args: [join(repoRoot, "remote-web", "scripts", "audit-foundation-progress.mjs")],
    reportPath: join(repoRoot, "remote-web", "artifacts", "foundation-progress-audit.json")
  },
  {
    key: "diagnosticUpload",
    label: "Diagnostic upload drill",
    cwd: repoRoot,
    command: process.execPath,
    args: [join(repoRoot, "remote-web", "scripts", "run-diagnostic-upload-drill.mjs")],
    reportPath: join(repoRoot, "remote-web", "artifacts", "diagnostic-upload-drill.json")
  },
  {
    key: "releaseWatch",
    label: "Local release watch",
    cwd: repoRoot,
    command: process.execPath,
    args: [join(repoRoot, "remote-web", "scripts", "run-release-watch.mjs"), "--env", "local", "--port", "4177"],
    reportPath: join(repoRoot, "remote-web", "artifacts", "release-watch.json")
  }
];

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function readJsonIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function runStep(step) {
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    encoding: "utf8",
    windowsHide: true,
    env: process.env
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const report = readJsonIfExists(step.reportPath);
  return {
    key: step.key,
    label: step.label,
    status: result.status === 0 ? "ok" : "fail",
    exitCode: result.status,
    reportPath: step.reportPath ? rel(step.reportPath) : "",
    summary: summarize(step.key, report, result.stdout || "")
  };
}

function summarize(key, report, stdout) {
  if (key === "electronCheck") {
    return {
      syntaxChecked: /Checked \d+ JavaScript files/.test(stdout),
      contractOk: /CONTRACT_OK/.test(stdout),
      assetsOk: /\[check-assets\] ok/.test(stdout)
    };
  }
  if (!report) return {};
  if (key === "remoteRelease") {
    return { releaseId: report.releaseId, artifactCount: report.artifactCount, totalBytes: report.totalBytes };
  }
  if (key === "deployConfig") {
    return { status: report.status, checkCount: report.summary && report.summary.checkCount, failed: report.summary && report.summary.failed };
  }
  if (key === "webStorageIsolation") {
    return {
      status: report.status,
      allowedStorageKeyCount: report.summary && report.summary.allowedStorageKeyCount,
      localStorageCallCount: report.summary && report.summary.localStorageCallCount,
      failedIssueCount: report.summary && report.summary.failedIssueCount
    };
  }
  if (key === "bridgePermission") {
    return {
      status: report.status,
      methodCount: report.summary && report.summary.presentMethodCount,
      failedCheckCount: report.summary && report.summary.failedCheckCount
    };
  }
  if (key === "doudianRemoteUpdateMatrix") {
    return {
      status: report.status,
      checkCount: report.summary && report.summary.checkCount,
      failedCount: report.summary && report.summary.failedCount
    };
  }
  if (key === "doudianLocalLeakage") {
    return {
      status: report.status,
      needleCount: report.needleCount,
      issueCount: report.issueCount
    };
  }
  if (key === "foundationProgress") {
    return {
      itemCount: report.itemCount,
      incompleteCount: report.incompleteCount,
      statusCounts: report.summary && report.summary.statusCounts
    };
  }
  if (key === "diagnosticUpload") {
    return {
      status: report.status,
      auditStatus: report.audit && report.audit.status,
      auditCount: report.audit && report.audit.count
    };
  }
  if (key === "releaseWatch") {
    return {
      status: report.status,
      failedSteps: report.summary && report.summary.failedSteps,
      cdnHeaderStatus: report.summary && report.summary.cdnHeaderStatus,
      monitorStatus: report.summary && report.summary.monitorStatus
    };
  }
  return {};
}

function mdTable(rows) {
  return [
    "| Step | Status | Exit | Report |",
    "|---|---|---:|---|",
    ...rows.map((row) => `| ${row.label} | ${row.status} | ${row.exitCode} | ${row.reportPath} |`)
  ].join("\n");
}

function renderMarkdown(report) {
  return [
    "# Xiaozuibao 2.0 Clean Foundation Local Gate Report",
    "",
    `> generatedAt: ${report.generatedAt}`,
    `> status: ${report.status}`,
    `> scope: ${report.scope}`,
    "",
    "## Summary",
    "",
    `- steps: ${report.stepCount}`,
    `- failed: ${report.failedCount}`,
    `- warnings: ${report.warningCount}`,
    "- This gate proves only the clean local foundation: Electron host, new remote Web shell, release manifest, deploy config, storage isolation, bridge contract, and progress checklist.",
    "",
    "## Steps",
    "",
    mdTable(report.steps),
    "",
    "## Outputs",
    "",
    `- JSON: ${report.outputs.json}`,
    `- Markdown: ${report.outputs.markdown}`
  ].join("\n");
}

const results = steps.map(runStep);
const failed = results.filter((step) => step.status === "fail");
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: failed.length ? "fail" : "ok",
  scope: "clean-foundation-only",
  stepCount: results.length,
  failedCount: failed.length,
  warningCount: 0,
  steps: results,
  outputs: {
    json: rel(jsonOutputPath),
    markdown: rel(mdOutputPath)
  }
};

mkdirSync(dirname(jsonOutputPath), { recursive: true });
mkdirSync(dirname(mdOutputPath), { recursive: true });
writeFileSync(jsonOutputPath, JSON.stringify(report, null, 2), "utf8");
writeFileSync(mdOutputPath, renderMarkdown(report), "utf8");

console.log(report.status === "ok" ? "FOUNDATION_LOCAL_GATE_OK" : "FOUNDATION_LOCAL_GATE_FAIL");
console.log(JSON.stringify({
  status: report.status,
  failedCount: report.failedCount,
  json: report.outputs.json,
  markdown: report.outputs.markdown
}, null, 2));

if (report.status === "fail") process.exit(1);
