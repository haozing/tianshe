import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const artifactsDir = join(root, "artifacts");
const outputJsonPath = join(artifactsDir, "release-watch.json");
const outputMdPath = join(artifactsDir, "release-watch.md");
const packageIndexPath = join(artifactsDir, "release-packages", "index.json");

function parseArgs(argv) {
  const defaultEnv = process.env.REMOTE_DEPLOY_ENV || "local";
  const args = {
    env: defaultEnv,
    baseUrl: process.env.RELEASE_WATCH_BASE_URL || process.env.BASE_URL || "",
    port: Number(process.env.RELEASE_WATCH_PORT || 4177),
    startServer: process.env.RELEASE_WATCH_START_SERVER !== "0",
    packageRelease: process.env.RELEASE_WATCH_PACKAGE !== "0",
    sendAlert: process.env.RELEASE_MONITOR_ALERT_SEND === "1",
    webhookUrl: process.env.RELEASE_MONITOR_ALERT_WEBHOOK_URL || "",
    includeOptional: process.env.RELEASE_WATCH_INCLUDE_OPTIONAL === "1",
    includeOptionalConfigured: Object.prototype.hasOwnProperty.call(process.env, "RELEASE_WATCH_INCLUDE_OPTIONAL")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--env") {
      args.env = argv[index + 1] || args.env;
      index += 1;
    } else if (value.startsWith("--env=")) {
      args.env = value.slice("--env=".length);
    } else if (value === "--base-url") {
      args.baseUrl = argv[index + 1] || args.baseUrl;
      index += 1;
    } else if (value.startsWith("--base-url=")) {
      args.baseUrl = value.slice("--base-url=".length);
    } else if (value === "--port") {
      args.port = Number(argv[index + 1] || args.port);
      index += 1;
    } else if (value.startsWith("--port=")) {
      args.port = Number(value.slice("--port=".length));
    } else if (value === "--no-server") {
      args.startServer = false;
    } else if (value === "--no-package") {
      args.packageRelease = false;
    } else if (value === "--send-alert") {
      args.sendAlert = true;
    } else if (value === "--webhook-url") {
      args.webhookUrl = argv[index + 1] || "";
      index += 1;
    } else if (value.startsWith("--webhook-url=")) {
      args.webhookUrl = value.slice("--webhook-url=".length);
    } else if (value === "--include-optional") {
      args.includeOptional = true;
      args.includeOptionalConfigured = true;
    } else if (value === "--required-only") {
      args.includeOptional = false;
      args.includeOptionalConfigured = true;
    }
  }
  if (!args.includeOptionalConfigured && args.startServer && args.packageRelease && args.env === "local") {
    args.includeOptional = true;
  }
  if (!args.baseUrl) {
    args.baseUrl = args.env === "local"
      ? `http://127.0.0.1:${args.port}/`
      : `http://chihu-remote.localhost:${args.port}/`;
  }
  return args;
}

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeBaseUrl(value, port) {
  let candidate = value || `http://127.0.0.1:${port}/`;
  const url = new URL(candidate);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function runStep(name, commandArgs, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(options.env || {})
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    name,
    ok: options.allowFailure ? true : result.status === 0,
    status: result.status,
    allowFailure: !!options.allowFailure,
    durationMs: Date.now() - startedAt,
    command: [process.execPath, ...commandArgs].join(" "),
    stdoutTail: String(result.stdout || "").slice(-4000),
    stderrTail: String(result.stderr || "").slice(-4000)
  };
}

function currentPackagePaths() {
  if (!existsSync(packageIndexPath)) {
    return {
      deployRoot: "",
      packageManifest: ""
    };
  }
  const index = readJsonIfExists(packageIndexPath);
  const packages = index && Array.isArray(index.packages) ? index.packages : [];
  const current = index && index.current || {};
  const currentPackage = packages.find((item) => item.packageId === current.packageId) || current;
  if (!currentPackage.path) {
    return {
      deployRoot: "",
      packageManifest: ""
    };
  }
  const packageRoot = resolve(repoRoot, currentPackage.path);
  return {
    deployRoot: join(packageRoot, "deploy"),
    packageManifest: join(packageRoot, "package-manifest.json")
  };
}

function startLocalServer(port, serverPaths) {
  const child = spawn(process.execPath, [join(root, "scripts", "serve-static.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      ...(serverPaths.deployRoot ? { REMOTE_WEB_SERVE_ROOT: serverPaths.deployRoot } : {}),
      ...(serverPaths.packageManifest ? { REMOTE_RELEASE_PACKAGE_MANIFEST: serverPaths.packageManifest } : {})
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function buildMarkdown(report) {
  const rows = report.steps.map((step) => (
    `| ${step.name} | ${step.ok ? "ok" : "fail"} | ${step.status} | ${step.durationMs} | ${step.allowFailure ? "yes" : "no"} |`
  ));
  return [
    "# Remote Web Release Watch",
    "",
    `- status: ${report.status}`,
    `- environment: ${report.environment}`,
    `- baseUrl: ${report.baseUrl}`,
    `- generatedAt: ${report.generatedAt}`,
    `- durationMs: ${report.durationMs}`,
    "",
    "## Steps",
    "",
    "| Step | OK | Exit | Duration | Allow Failure |",
    "|---|---|---:|---:|---|",
    ...rows,
    "",
    "## Outputs",
    "",
    `- releaseMonitor: ${report.outputs.releaseMonitor || ""}`,
    `- releaseAlert: ${report.outputs.releaseAlert || ""}`,
    `- cdnHeaderSample: ${report.outputs.cdnHeaderSample || ""}`,
    `- json: ${report.outputs.json}`,
    `- markdown: ${report.outputs.markdown}`
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBaseUrl(args.baseUrl, args.port);
const smokeBaseUrl = baseUrl.replace(/\/+$/, "");
const startedAt = Date.now();
let server = null;
const steps = [];

mkdirSync(artifactsDir, { recursive: true });

try {
  steps.push(runStep("check-release", [join(root, "scripts", "check-release.mjs")]));

  if (args.packageRelease) {
    const packageArgs = [join(root, "scripts", "package-release.mjs")];
    if (args.includeOptional) packageArgs.push("--include-optional");
    steps.push(runStep("package-release", packageArgs));
  }

  const serverPaths = currentPackagePaths();
  if (args.startServer) {
    server = startLocalServer(args.port, serverPaths);
    await sleep(900);
  }

  steps.push(runStep("headless-smoke", [join(root, "scripts", "smoke-headless.mjs")], {
    env: {
      BASE_URL: smokeBaseUrl
    }
  }));

  steps.push(runStep("check-deploy-config", [join(root, "scripts", "check-deploy-config.mjs"), "--env", args.env], {
    allowFailure: args.env === "local"
  }));

  steps.push(runStep("sample-cdn-headers", [
    join(root, "scripts", "sample-cdn-headers.mjs"),
    "--env",
    args.env,
    "--base-url",
    baseUrl
  ]));

  steps.push(runStep("monitor-release", [join(root, "scripts", "monitor-release.mjs"), "--env", args.env]));

  const alertArgs = [join(root, "scripts", "publish-monitor-alert.mjs")];
  if (args.sendAlert) {
    alertArgs.push("--send");
    if (args.webhookUrl) {
      alertArgs.push("--webhook-url", args.webhookUrl);
    }
  } else {
    alertArgs.push("--dry-run");
  }
  steps.push(runStep("publish-monitor-alert", alertArgs, {
    allowFailure: !args.sendAlert && args.env === "local"
  }));
} finally {
  if (server && !server.killed) {
    server.kill();
  }
}

const hardFailed = steps.filter((step) => !step.ok);
const releaseMonitor = readJsonIfExists(join(artifactsDir, "release-monitor.json"));
const releaseAlert = readJsonIfExists(join(artifactsDir, "release-monitor-alert.json"));
const cdnHeaderSample = readJsonIfExists(join(artifactsDir, `cdn-header-sample-${args.env}.json`));
const status = hardFailed.length ? "fail" : releaseMonitor && releaseMonitor.status || "unknown";
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: args.env,
  baseUrl,
  status,
  durationMs: Date.now() - startedAt,
  summary: {
    stepCount: steps.length,
    failedSteps: hardFailed.length,
    warnings: releaseMonitor && releaseMonitor.summary && releaseMonitor.summary.warnings || 0,
    monitorStatus: releaseMonitor && releaseMonitor.status || "",
    alertDispatch: releaseAlert && releaseAlert.dispatch && releaseAlert.dispatch.status || "",
    cdnHeaderStatus: cdnHeaderSample && cdnHeaderSample.status || "",
    includeOptional: args.includeOptional
  },
  steps,
  outputs: {
    releaseMonitor: existsSync(join(artifactsDir, "release-monitor.json")) ? rel(join(artifactsDir, "release-monitor.json")) : "",
    releaseAlert: existsSync(join(artifactsDir, "release-monitor-alert.json")) ? rel(join(artifactsDir, "release-monitor-alert.json")) : "",
    cdnHeaderSample: existsSync(join(artifactsDir, `cdn-header-sample-${args.env}.json`)) ? rel(join(artifactsDir, `cdn-header-sample-${args.env}.json`)) : "",
    json: rel(outputJsonPath),
    markdown: rel(outputMdPath)
  }
};

writeJson(outputJsonPath, report);
writeFileSync(outputMdPath, buildMarkdown(report), "utf8");

console.log("RELEASE_WATCH_" + String(report.status || "UNKNOWN").toUpperCase().replace(/[^A-Z0-9]+/g, "_"));
console.log(JSON.stringify({
  status: report.status,
  environment: report.environment,
  durationMs: report.durationMs,
  summary: report.summary,
  json: report.outputs.json,
  markdown: report.outputs.markdown
}, null, 2));

if (hardFailed.length) {
  process.exit(1);
}
