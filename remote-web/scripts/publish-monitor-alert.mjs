import { createHash } from "node:crypto";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const artifactsDir = join(root, "artifacts");
const monitorPath = join(artifactsDir, "release-monitor.json");
const alertJsonPath = join(artifactsDir, "release-monitor-alert.json");
const alertMdPath = join(artifactsDir, "release-monitor-alert.md");

function parseArgs(argv) {
  const args = {
    webhookUrl: process.env.RELEASE_MONITOR_ALERT_WEBHOOK_URL || "",
    send: process.env.RELEASE_MONITOR_ALERT_SEND === "1"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--webhook-url") {
      args.webhookUrl = argv[index + 1] || "";
      index += 1;
    } else if (value.startsWith("--webhook-url=")) {
      args.webhookUrl = value.slice("--webhook-url=".length);
    } else if (value === "--send") {
      args.send = true;
    } else if (value === "--dry-run") {
      args.send = false;
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function redactUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function severityForStatus(status) {
  if (status === "fail") return "critical";
  if (status === "warn") return "warning";
  return "ok";
}

function buildPayload(monitor, args) {
  const failedChecks = (monitor.checks || []).filter((check) => check.status === "fail");
  const warningChecks = (monitor.checks || []).filter((check) => check.status === "warn");
  const topChecks = failedChecks.concat(warningChecks).slice(0, 12).map((check) => ({
    category: check.category,
    name: check.name,
    status: check.status,
    detail: check.detail,
    evidence: check.evidence
  }));
  const payload = {
    schemaVersion: 1,
    packageType: "chihu-release-monitor-alert",
    source: "remote-web-release-monitor",
    generatedAt: new Date().toISOString(),
    releaseId: monitor.releaseId || "",
    status: monitor.status || "unknown",
    severity: severityForStatus(monitor.status),
    dryRun: !args.send,
    notification: {
      title: `[${severityForStatus(monitor.status).toUpperCase()}] remote web release ${monitor.releaseId || "unknown"}`,
      summary: `status=${monitor.status || "unknown"} failed=${monitor.summary && monitor.summary.failed || 0} warnings=${monitor.summary && monitor.summary.warnings || 0}`,
      route: "remote-web-release-monitor",
      recommendedAction: monitor.status === "fail"
        ? "Fix failed checks before rollout."
        : monitor.status === "warn"
          ? "Review warnings before production rollout."
          : "No release monitor action required."
    },
    summary: {
      checkCount: monitor.summary && monitor.summary.checkCount || 0,
      failed: monitor.summary && monitor.summary.failed || 0,
      warnings: monitor.summary && monitor.summary.warnings || 0,
      ok: monitor.summary && monitor.summary.ok || 0,
      artifactCount: monitor.summary && monitor.summary.artifactCount || 0,
      packageCount: monitor.summary && monitor.summary.packageCount || 0,
      deployConfigStatus: monitor.summary && monitor.summary.deployConfigStatus || "",
      cdnHeaderStatus: monitor.summary && monitor.summary.cdnHeaderStatus || "",
      smokePassed: monitor.summary && monitor.summary.smokePassed || 0,
      smokeCount: monitor.summary && monitor.summary.smokeCount || 0
    },
    checks: {
      failed: failedChecks.length,
      warnings: warningChecks.length,
      top: topChecks
    },
    evidence: {
      monitorJson: rel(monitorPath),
      monitorMarkdown: monitor.outputs && monitor.outputs.markdown || "remote-web/artifacts/release-monitor.md",
      releaseCheck: monitor.outputs && monitor.outputs.releaseCheck || "",
      deployConfigCheck: monitor.outputs && monitor.outputs.deployConfigCheck || "",
      cdnHeaderSample: monitor.outputs && monitor.outputs.cdnHeaderSample || "",
      packageIndex: monitor.outputs && monitor.outputs.packageIndex || "",
      smokeResult: monitor.outputs && monitor.outputs.smokeResult || ""
    },
    nextActions: Array.isArray(monitor.nextActions) ? monitor.nextActions : [],
    redaction: {
      enabled: true,
      webhookUrl: args.webhookUrl ? redactUrl(args.webhookUrl) : "",
      forbidden: ["Cookie", "Authorization", "token", "full response body", "full request headers"]
    }
  };
  payload.redaction.audit = auditPayloadRedaction(payload);
  payload.payloadDigest = digest(payload);
  return payload;
}

function auditPayloadRedaction(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  if (clone.redaction) {
    clone.redaction.forbidden = [];
  }
  const text = JSON.stringify(clone);
  const patterns = [
    { name: "cookie", pattern: /(?:^|[^a-z])cookie\s*[:=]/i },
    { name: "authorization", pattern: /authorization\s*[:=]/i },
    { name: "bearer", pattern: /bearer\s+[a-z0-9._-]+/i },
    { name: "token", pattern: /(?:^|[^a-z])token\s*[:=]/i },
    { name: "set-cookie", pattern: /set-cookie/i }
  ];
  const matches = patterns.filter((item) => item.pattern.test(text)).map((item) => item.name);
  return {
    ok: matches.length === 0,
    scannedBytes: Buffer.byteLength(text),
    matches
  };
}

function postJson(url, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? httpsRequest : request;
    const req = lib(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "X-Chihu-Package-Type": payload.packageType,
        "X-Chihu-Upload-Source": payload.source
      },
      timeout: 10000
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode || 0,
          responseBytes: Buffer.byteLength(text),
          responseDigest: createHash("sha256").update(text).digest("hex").slice(0, 16)
        });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout after 10000ms"));
    });
    req.on("error", (error) => {
      resolve({
        ok: false,
        statusCode: 0,
        error: error && error.message ? error.message : String(error)
      });
    });
    req.end(body);
  });
}

function buildMarkdown(report) {
  const payload = report.payload;
  const rows = payload.checks.top.map((check) => (
    `| ${check.category} | ${check.name} | ${check.status} | ${String(check.detail || "").replace(/\|/g, "\\|")} | ${check.evidence || ""} |`
  ));
  return [
    "# Release Monitor Alert",
    "",
    `- status: ${payload.status}`,
    `- severity: ${payload.severity}`,
    `- releaseId: ${payload.releaseId}`,
    `- dryRun: ${payload.dryRun}`,
    `- dispatch: ${report.dispatch.status}`,
    `- digest: ${payload.payloadDigest}`,
    "",
    "## Summary",
    "",
    `- checks: ${payload.summary.checkCount}`,
    `- failed: ${payload.summary.failed}`,
    `- warnings: ${payload.summary.warnings}`,
    `- cdnHeaderStatus: ${payload.summary.cdnHeaderStatus || "missing"}`,
    `- smoke: ${payload.summary.smokePassed}/${payload.summary.smokeCount}`,
    "",
    "## Top Checks",
    "",
    rows.length
      ? ["| Category | Check | Status | Detail | Evidence |", "|---|---|---|---|---|", ...rows].join("\n")
      : "No failed or warning checks.",
    "",
    "## Evidence",
    "",
    `- monitorJson: ${payload.evidence.monitorJson}`,
    `- monitorMarkdown: ${payload.evidence.monitorMarkdown}`,
    `- alertJson: ${report.outputs.json}`
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (!existsSync(monitorPath)) {
  throw new Error("release-monitor.json not found; run node remote-web/scripts/monitor-release.mjs first");
}

const monitor = readJson(monitorPath);
const payload = buildPayload(monitor, args);
let dispatch = {
  status: "dry-run",
  sent: false,
  webhookConfigured: !!args.webhookUrl,
  webhookUrl: args.webhookUrl ? redactUrl(args.webhookUrl) : "",
  response: null
};

if (args.send) {
  if (!args.webhookUrl) {
    dispatch = {
      status: "not-sent",
      sent: false,
      webhookConfigured: false,
      reason: "missing webhook url",
      response: null
    };
  } else {
    const response = await postJson(args.webhookUrl, payload);
    dispatch = {
      status: response.ok ? "sent" : "failed",
      sent: response.ok,
      webhookConfigured: true,
      webhookUrl: redactUrl(args.webhookUrl),
      response
    };
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: payload.status,
  severity: payload.severity,
  releaseId: payload.releaseId,
  payload,
  dispatch,
  outputs: {
    json: rel(alertJsonPath),
    markdown: rel(alertMdPath)
  }
};

writeJson(alertJsonPath, report);
writeFileSync(alertMdPath, buildMarkdown(report), "utf8");

console.log("RELEASE_MONITOR_ALERT_" + (dispatch.status || "DRY_RUN").toUpperCase().replace(/[^A-Z0-9]+/g, "_"));
console.log(JSON.stringify({
  status: report.status,
  severity: report.severity,
  dryRun: payload.dryRun,
  dispatch: dispatch.status,
  failed: payload.summary.failed,
  warnings: payload.summary.warnings,
  digest: payload.payloadDigest,
  json: report.outputs.json,
  markdown: report.outputs.markdown
}, null, 2));

if (dispatch.status === "failed") {
  process.exit(1);
}
