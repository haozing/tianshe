import { request } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simpleDigest } from "./diagnostic-upload-store.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const artifacts = join(root, "artifacts");
const configPath = join(artifacts, "diagnostic-upload-drill-config.json");
const uploadDir = join(artifacts, "diagnostic-upload-inbox-drill");
const uploadResultPath = join(artifacts, "diagnostic-upload-smoke-result.json");

function parseArgs(argv) {
  const result = {
    port: Number(process.env.PORT || 4181),
    clean: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      result.port = Number(argv[index + 1] || result.port);
      index += 1;
    } else if (arg.startsWith("--port=")) {
      result.port = Number(arg.slice("--port=".length));
    } else if (arg === "--no-clean") {
      result.clean = false;
    }
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function runStep(name, commandArgs, options = {}) {
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      ...(options.env || {})
    }
  });
  return {
    name,
    command: [process.execPath, ...commandArgs].join(" "),
    status: result.status,
    ok: result.status === 0,
    stdout: (result.stdout || "").split(/\r?\n/).filter(Boolean).slice(-12),
    stderr: (result.stderr || "").split(/\r?\n/).filter(Boolean).slice(-12)
  };
}

function startServer(port) {
  const child = spawn(process.execPath, [join(root, "scripts", "serve-static.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      LIEHU_DIAGNOSTIC_UPLOAD_DIR: uploadDir
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  return { child, logs };
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function buildDrillConfig(port) {
  const base = readJson(join(root, "new-remote-web", "config", "upload-config.json"));
  base.version = "2026.07.03.clean-foundation-upload-drill";
  base.diagnostics = {
    ...(base.diagnostics || {}),
    uploadUrl: `http://127.0.0.1:${port}/__chihu-smoke-upload`
  };
  return base;
}

function buildPayload(type, itemId) {
  const packageType = type === "diagnostic-ticket"
    ? "chihu-diagnostic-ticket"
    : "chihu-data-repair-ticket";
  const payload = {
    packageType,
    source: "new-remote-web",
    scope: "clean-foundation",
    generatedAt: new Date().toISOString(),
    summary: {
      status: "ok",
      itemId,
      type
    },
    redaction: {
      enabled: true,
      forbidden: ["cookie", "authorization", "token", "set-cookie"],
      nextActions: []
    },
    evidence: {
      route: "/system/diagnostics",
      bridge: "clean-foundation",
      body: "[REDACTED]"
    }
  };
  return {
    queueVersion: 1,
    source: "new-remote-web",
    scope: "clean-foundation",
    type,
    itemId,
    redaction: {
      enabled: true
    },
    payloadDigest: simpleDigest(payload),
    payload
  };
}

function postJson(url, payload, timeoutMs = 5000) {
  return new Promise((resolvePost) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const req = request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: "POST",
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Chihu-Package-Type": payload.type,
        "X-Chihu-Upload-Source": "new-remote-web"
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {}
        resolvePost({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          data,
          body: text
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", (error) => {
      resolvePost({
        ok: false,
        statusCode: 0,
        error: error && error.message ? error.message : String(error)
      });
    });
    req.end(body);
  });
}

async function uploadDrillPackages(port) {
  const uploadUrl = `http://127.0.0.1:${port}/__chihu-smoke-upload`;
  const payloads = [
    buildPayload("diagnostic-ticket", "drill-diagnostic-ticket"),
    buildPayload("data-repair-ticket", "drill-data-repair-ticket")
  ];
  const uploads = [];
  for (const payload of payloads) {
    uploads.push({
      type: payload.type,
      itemId: payload.itemId,
      result: await postJson(uploadUrl, payload)
    });
  }
  const ok = uploads.every((item) => item.result.ok && item.result.data && item.result.data.ok === true);
  writeJson(uploadResultPath, {
    version: 1,
    generatedAt: new Date().toISOString(),
    uploadUrl,
    ok,
    uploads
  });
  return {
    name: "direct diagnostic upload smoke",
    command: `POST ${uploadUrl}`,
    status: ok ? 0 : 1,
    ok,
    stdout: [`uploaded=${uploads.length}`, `ok=${ok}`],
    stderr: uploads.filter((item) => !item.result.ok).map((item) => `${item.type}: ${item.result.error || item.result.body || item.result.statusCode}`)
  };
}

function buildMarkdown(report) {
  return [
    "# Diagnostic Upload Local Drill",
    "",
    `> generatedAt: ${report.generatedAt}`,
    `> status: ${report.status}`,
    `> port: ${report.port}`,
    "",
    "## Steps",
    "",
    "| Step | Status |",
    "|---|---|",
    ...report.steps.map((step) => `| ${step.name} | ${step.ok ? "ok" : "fail"} |`),
    "",
    "## Inbox Audit",
    "",
    `- status: ${report.audit && report.audit.status || "missing"}`,
    `- upload records: ${report.audit && report.audit.count || 0}`,
    `- redacted: ${report.audit && report.audit.redactedCount || 0}/${report.audit && report.audit.count || 0}`,
    `- types: ${JSON.stringify(report.audit && report.audit.byType || {})}`,
    `- issues: ${(report.audit && report.audit.issues || []).length}`,
    "",
    "## Artifacts",
    "",
    "- drill report: remote-web/artifacts/diagnostic-upload-drill.json",
    "- upload smoke: remote-web/artifacts/diagnostic-upload-smoke-result.json",
    "- inbox audit: remote-web/artifacts/diagnostic-upload-audit.json",
    "- inbox dir: remote-web/artifacts/diagnostic-upload-inbox-drill"
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(artifacts, { recursive: true });
if (args.clean && existsSync(uploadDir)) {
  rmSync(uploadDir, { recursive: true, force: true });
}
mkdirSync(uploadDir, { recursive: true });
writeJson(configPath, buildDrillConfig(args.port));

const server = startServer(args.port);
const steps = [];
let status = "fail";
let audit = null;

try {
  await wait(900);
  steps.push(await uploadDrillPackages(args.port));
  steps.push(runStep("audit upload inbox", [join(root, "scripts", "audit-diagnostic-upload-inbox.mjs"), "--upload-dir", uploadDir]));

  if (existsSync(join(artifacts, "diagnostic-upload-audit.json"))) {
    audit = readJson(join(artifacts, "diagnostic-upload-audit.json"));
  }
  status = steps.every((step) => step.ok) && audit && audit.status !== "fail" ? "ok" : "fail";
} finally {
  server.child.kill();
}

const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  status,
  port: args.port,
  configPath,
  uploadDir,
  uploadResultPath,
  serverLogs: server.logs.join("").split(/\r?\n/).filter(Boolean).slice(-20),
  steps,
  audit
};

writeJson(join(artifacts, "diagnostic-upload-drill.json"), report);
writeFileSync(join(artifacts, "diagnostic-upload-drill.md"), buildMarkdown(report), "utf8");

console.log("DIAGNOSTIC_UPLOAD_DRILL_" + status.toUpperCase());
console.log(JSON.stringify({
  status,
  uploadDir,
  steps: steps.map((step) => ({ name: step.name, ok: step.ok, status: step.status })),
  auditStatus: audit && audit.status,
  auditCount: audit && audit.count,
  outputs: {
    json: join(artifacts, "diagnostic-upload-drill.json"),
    markdown: join(artifacts, "diagnostic-upload-drill.md")
  }
}, null, 2));

if (status === "fail") {
  process.exit(1);
}
