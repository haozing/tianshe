import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const artifactsDir = join(root, "artifacts");
const manifestPath = join(root, "new-remote-web", "release-manifest.json");
const packageIndexPath = join(artifactsDir, "release-packages", "index.json");

function parseArgs(argv) {
  const args = {
    env: process.env.REMOTE_DEPLOY_ENV || "local",
    config: "",
    packageManifest: process.env.REMOTE_RELEASE_PACKAGE_MANIFEST || "",
    baseUrl: process.env.REMOTE_CDN_SAMPLE_BASE_URL || "",
    timeoutMs: Number(process.env.REMOTE_CDN_SAMPLE_TIMEOUT_MS || 5000)
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--env") {
      args.env = argv[index + 1] || args.env;
      index += 1;
    } else if (value.startsWith("--env=")) {
      args.env = value.slice("--env=".length);
    } else if (value === "--config") {
      args.config = argv[index + 1] || "";
      index += 1;
    } else if (value.startsWith("--config=")) {
      args.config = value.slice("--config=".length);
    } else if (value === "--package-manifest") {
      args.packageManifest = argv[index + 1] || "";
      index += 1;
    } else if (value.startsWith("--package-manifest=")) {
      args.packageManifest = value.slice("--package-manifest=".length);
    } else if (value === "--base-url") {
      args.baseUrl = argv[index + 1] || "";
      index += 1;
    } else if (value.startsWith("--base-url=")) {
      args.baseUrl = value.slice("--base-url=".length);
    } else if (value === "--timeout-ms") {
      args.timeoutMs = Number(argv[index + 1] || args.timeoutMs);
      index += 1;
    } else if (value.startsWith("--timeout-ms=")) {
      args.timeoutMs = Number(value.slice("--timeout-ms=".length));
    } else if (!value.startsWith("-")) {
      args.env = value;
    }
  }
  return args;
}

function safeName(value) {
  return String(value || "local").replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function rel(path) {
  return relative(repoRoot, path).replace(/\\/g, "/");
}

function resolveConfigPath(args) {
  if (args.config) return resolve(repoRoot, args.config);
  return join(root, "deploy", "environments", `${safeName(args.env)}.json`);
}

function resolvePackageManifestPath(args) {
  if (args.packageManifest) return resolve(repoRoot, args.packageManifest);
  if (!existsSync(packageIndexPath)) return "";
  const index = readJson(packageIndexPath);
  const packages = Array.isArray(index.packages) ? index.packages : [];
  const current = index.current || {};
  const currentPackage = packages.find((item) => item.packageId === current.packageId) || current;
  return currentPackage.path ? resolve(repoRoot, currentPackage.path, "package-manifest.json") : "";
}

function normalizeBaseUrl(value, config) {
  const candidate = value || config.origins && config.origins.remoteAssetsBase || "";
  if (!candidate) throw new Error("missing --base-url or origins.remoteAssetsBase");
  const url = new URL(candidate);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function urlForArtifact(baseUrl, artifactPath) {
  return new URL(artifactPath.replace(/\\/g, "/").replace(/^\/+/, ""), baseUrl).toString();
}

function packageArtifactBySourcePath(packageManifest) {
  const artifacts = packageManifest && Array.isArray(packageManifest.artifacts) ? packageManifest.artifacts : [];
  return new Map(artifacts.map((artifact) => [artifact.path, artifact]));
}

function requestHead(url, timeoutMs) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? httpsRequest : request;
    const req = lib(url, {
      method: "HEAD",
      timeout: timeoutMs
    }, (res) => {
      res.resume();
      res.on("end", () => {
        resolve({
          ok: true,
          statusCode: res.statusCode || 0,
          headers: res.headers
        });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", (error) => {
      resolve({
        ok: false,
        statusCode: 0,
        headers: {},
        error: error && error.message ? error.message : String(error)
      });
    });
    req.end();
  });
}

function ruleMap(config) {
  const output = new Map();
  for (const rule of config.cdn && config.cdn.rules || []) {
    for (const type of rule.appliesTo || []) {
      output.set(type, rule);
    }
  }
  return output;
}

function headerIncludes(actual, expected) {
  const a = String(actual || "").toLowerCase();
  const parts = String(expected || "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.every((part) => a.includes(part));
}

function evaluateSample(sample, rule) {
  const expected = rule && rule.headers && rule.headers.cacheControl || "";
  if (!sample.response.ok) {
    return {
      status: "fail",
      reason: sample.response.error || "request failed"
    };
  }
  if (sample.response.statusCode < 200 || sample.response.statusCode >= 400) {
    return {
      status: "fail",
      reason: `HTTP ${sample.response.statusCode}`
    };
  }
  if (!headerIncludes(sample.cacheControl, expected)) {
    return {
      status: "fail",
      reason: `Cache-Control mismatch: expected ${expected}, got ${sample.cacheControl || "missing"}`
    };
  }
  return {
    status: "ok",
    reason: "matched"
  };
}

function mdTable(rows) {
  return [
    "| Path | Type | Status | Cache-Control | Expected | Detail |",
    "|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.path} | ${row.type} | ${row.status} | ${String(row.cacheControl || "").replace(/\|/g, "\\|")} | ${String(row.expectedCacheControl || "").replace(/\|/g, "\\|")} | ${String(row.reason || "").replace(/\|/g, "\\|")} |`)
  ].join("\n");
}

function buildMarkdown(report) {
  return [
    "# Remote Web CDN Header Sampling",
    "",
    `- environment: ${report.environment}`,
    `- status: ${report.status}`,
    `- baseUrl: ${report.baseUrl}`,
    `- generatedAt: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- samples: ${report.summary.sampleCount}`,
    `- ok: ${report.summary.ok}`,
    `- warn: ${report.summary.warnings}`,
    `- fail: ${report.summary.failed}`,
    "",
    "## Samples",
    "",
    mdTable(report.samples)
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
const configPath = resolveConfigPath(args);
if (!existsSync(configPath)) {
  throw new Error(`deploy config not found: ${configPath}`);
}
const packageManifestPath = resolvePackageManifestPath(args);

const manifest = readJson(manifestPath);
const config = readJson(configPath);
const packageManifest = packageManifestPath && existsSync(packageManifestPath) ? readJson(packageManifestPath) : null;
const packageArtifacts = packageArtifactBySourcePath(packageManifest);
const baseUrl = normalizeBaseUrl(args.baseUrl, config);
const rules = ruleMap(config);
const env = args.env;
const outputBase = join(artifactsDir, `cdn-header-sample-${safeName(env)}`);
const jsonOutputPath = `${outputBase}.json`;
const mdOutputPath = `${outputBase}.md`;

mkdirSync(artifactsDir, { recursive: true });

const artifacts = (manifest.artifacts || []).filter((artifact) => artifact.required !== false);
const samples = [];
for (const artifact of artifacts) {
  const packageArtifact = packageArtifacts.get(artifact.path);
  const samplePath = packageArtifact && packageArtifact.deployArtifactPath || artifact.path;
  const rule = rules.get(artifact.type);
  const url = urlForArtifact(baseUrl, samplePath);
  const response = await requestHead(url, args.timeoutMs);
  const cacheControl = String(response.headers && response.headers["cache-control"] || "");
  const evaluation = evaluateSample({
    response,
    cacheControl
  }, rule);
  samples.push({
    path: samplePath,
    sourcePath: artifact.path,
    type: artifact.type,
    cache: artifact.cache || "",
    url,
    statusCode: response.statusCode,
    cacheControl,
    expectedCacheControl: rule && rule.headers && rule.headers.cacheControl || "",
    status: evaluation.status,
    reason: evaluation.reason,
    headers: {
      cacheControl,
      contentType: response.headers && response.headers["content-type"] || "",
      etag: response.headers && response.headers.etag || "",
      lastModified: response.headers && response.headers["last-modified"] || "",
      cdnCacheStatus: response.headers && (response.headers["cf-cache-status"] || response.headers["x-cache"] || response.headers["x-cache-status"] || "") || ""
    }
  });
}

const failed = samples.filter((sample) => sample.status === "fail");
const warnings = samples.filter((sample) => sample.status === "warn");
const status = failed.length ? "fail" : warnings.length ? "warn" : "ok";
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: env,
  configPath: rel(configPath),
  packageManifestPath: packageManifestPath && existsSync(packageManifestPath) ? rel(packageManifestPath) : "",
  releaseId: manifest.releaseId,
  baseUrl,
  status,
  summary: {
    sampleCount: samples.length,
    failed: failed.length,
    warnings: warnings.length,
    ok: samples.filter((sample) => sample.status === "ok").length
  },
  samples,
  outputs: {
    json: rel(jsonOutputPath),
    markdown: rel(mdOutputPath)
  }
};

writeJson(jsonOutputPath, report);
writeFileSync(mdOutputPath, buildMarkdown(report), "utf8");

console.log("CDN_HEADER_SAMPLE_" + status.toUpperCase());
console.log(JSON.stringify({
  environment: report.environment,
  status: report.status,
  summary: report.summary,
  json: report.outputs.json,
  markdown: report.outputs.markdown
}, null, 2));

if (status === "fail") {
  process.exit(1);
}
