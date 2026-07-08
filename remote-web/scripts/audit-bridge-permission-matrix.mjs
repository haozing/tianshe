import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const artifactsDir = join(root, "artifacts");
const docsDir = join(repoRoot, "docs");
const jsonOutputPath = join(artifactsDir, "bridge-permission-matrix-audit.json");
const mdOutputPath = join(docsDir, "bridge-permission-matrix.md");
const bridgePath = join(root, "new-remote-web", "bridge.js");

const REQUIRED_METHODS = [
  "get_cookies",
  "set_cookies",
  "copy_cookies",
  "clear_session",
  "http",
  "uploadFile",
  "openWindow",
  "closeWindow",
  "editBrowserWindow",
  "getBrowserWindowInfo",
  "destroyBrowserWindow",
  "executeJavaScriptBrowserWindow",
  "reloadHomeUrl",
  "sendNotification",
  "getMainWindowInfo",
  "resetMainWindow",
  "getAllBrowserWindowInfos",
  "getAppInfo",
  "startAutoUpdate",
  "cleanInvalidPartitions",
  "minimizeWindow",
  "maximizeWindow",
  "isWindowMaximized",
  "isWindowDestroyed",
  "getClientVersionData",
  "reportClientLog",
  "getCrashLogDir",
  "cleanCrashLogs",
  "selectDirectory",
  "downloadFileToPath",
  "cancelDownloadFileToPath",
  "saveBufferToPath",
  "openPathInExplorer"
];

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function renderMarkdown(report) {
  return [
    "# Bridge Permission Matrix",
    "",
    `> status: ${report.status}`,
    `> generatedAt: ${report.generatedAt}`,
    "",
    "## Scope",
    "",
    "This audit covers only the clean foundation bridge. Historical platform-specific probes are archived under `archive/reference-backup/`.",
    "",
    "## Methods",
    "",
    "| Method | Status |",
    "|---|---|",
    ...report.methods.map((item) => `| ${item.method} | ${item.status} |`),
    "",
    "## Summary",
    "",
    `- expected: ${report.summary.expectedMethodCount}`,
    `- present: ${report.summary.presentMethodCount}`,
    `- missing: ${report.summary.missingMethodCount}`
  ].join("\n");
}

if (!existsSync(bridgePath)) {
  throw new Error(`bridge not found: ${bridgePath}`);
}

const source = readFileSync(bridgePath, "utf8");
const methods = REQUIRED_METHODS.map((method) => ({
  method,
  status: source.includes(`"${method}"`) ? "present" : "missing"
}));
const missing = methods.filter((item) => item.status === "missing");
const forbidden = [];
const status = missing.length || forbidden.length ? "fail" : "ok";

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status,
  source: rel(bridgePath),
  methods,
  forbiddenTokens: forbidden,
  summary: {
    expectedMethodCount: REQUIRED_METHODS.length,
    presentMethodCount: methods.length - missing.length,
    missingMethodCount: missing.length,
    forbiddenTokenCount: forbidden.length,
    failedCheckCount: missing.length + forbidden.length
  },
  outputs: {
    json: rel(jsonOutputPath),
    markdown: rel(mdOutputPath)
  }
};

ensureDir(jsonOutputPath);
ensureDir(mdOutputPath);
writeFileSync(jsonOutputPath, JSON.stringify(report, null, 2), "utf8");
writeFileSync(mdOutputPath, renderMarkdown(report), "utf8");

console.log("BRIDGE_PERMISSION_MATRIX_AUDIT_" + status.toUpperCase());
console.log(JSON.stringify({
  status: report.status,
  expectedMethodCount: report.summary.expectedMethodCount,
  presentMethodCount: report.summary.presentMethodCount,
  failedCheckCount: report.summary.failedCheckCount,
  json: report.outputs.json,
  markdown: report.outputs.markdown
}, null, 2));

if (status === "fail") process.exit(1);
