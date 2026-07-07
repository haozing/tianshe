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
    config: ""
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
    } else if (!value.startsWith("-")) {
      args.env = value;
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

function safeName(value) {
  return String(value || "local").replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function resolveConfigPath(args) {
  if (!args.config) {
    return join(root, "deploy", "environments", `${safeName(args.env)}.json`);
  }
  return resolve(repoRoot, args.config);
}

function addCheck(checks, category, name, status, detail, evidence) {
  checks.push({ category, name, status, detail, evidence });
}

function isLocalEnvironment(env) {
  return ["local", "dev", "development"].includes(String(env || "").toLowerCase());
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function hasPlaceholder(value) {
  return /(__REPLACE|NEW_REMOTE|OLD_REMOTE|REMOTE_CONFIG|REMOTE_ASSETS|DIAGNOSTICS_UPLOAD|example\.com|www\.chihu\.com|\{|\})/i.test(String(value || ""));
}

function validateOrigins(checks, config, env) {
  const origins = config.origins || {};
  const required = [
    "newRemoteWebOrigin",
    "remoteConfigUrl",
    "remoteAssetsBase",
    "diagnosticsUploadUrl"
  ];
  const missing = required.filter((key) => !origins[key]);
  addCheck(
    checks,
    "environment",
    "required origin variables",
    missing.length ? "fail" : "ok",
    missing.length ? `缺少 ${missing.join(", ")}` : `${required.length} 个环境变量均已配置`,
    "deploy/environments/*.json"
  );

  const invalidUrls = required.filter((key) => origins[key] && !isValidUrl(origins[key]));
  addCheck(
    checks,
    "environment",
    "origin URL shape",
    invalidUrls.length ? "fail" : "ok",
    invalidUrls.length ? `URL 格式无效: ${invalidUrls.join(", ")}` : "新远程 Web、配置、资源和诊断端点均为 http(s) URL",
    "deploy/environments/*.json"
  );

  const placeholderKeys = required.filter((key) => hasPlaceholder(origins[key]));
  addCheck(
    checks,
    "environment",
    "placeholder guard",
    placeholderKeys.length ? "fail" : "ok",
    placeholderKeys.length
      ? `仍有占位符或禁用占位域名: ${placeholderKeys.join(", ")}`
      : "未发现 NEW_REMOTE/OLD_REMOTE/REPLACE/www.chihu.com 等占位符",
    "deploy/environments/*.json"
  );

  const nonHttps = required.filter((key) => origins[key] && new URL(origins[key]).protocol !== "https:");
  addCheck(
    checks,
    "environment",
    "production HTTPS",
    !isLocalEnvironment(env) && nonHttps.length ? "fail" : "ok",
    isLocalEnvironment(env)
      ? "local 环境允许 http://chihu-remote.localhost"
      : nonHttps.length
        ? `非本地环境必须使用 HTTPS: ${nonHttps.join(", ")}`
        : "非本地环境均使用 HTTPS",
    "deploy/environments/*.json"
  );
}

function validateCacheRules(checks, config, manifest) {
  const rules = config.cdn && Array.isArray(config.cdn.rules) ? config.cdn.rules : [];
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts.filter((artifact) => artifact.required !== false) : [];
  const cacheTypes = [...new Set(artifacts.map((artifact) => artifact.cache || "short"))];
  const ruleByCache = new Map(rules.map((rule) => [rule.artifactCache, rule]));
  const missingCacheRules = cacheTypes.filter((cache) => !ruleByCache.has(cache));

  addCheck(
    checks,
    "cache",
    "cache rule coverage",
    missingCacheRules.length ? "fail" : "ok",
    missingCacheRules.length ? `缺少缓存策略: ${missingCacheRules.join(", ")}` : `${cacheTypes.length} 类 manifest 缓存策略均有规则`,
    "deploy/environments/*.json"
  );

  const missingTypeRules = artifacts.filter((artifact) => {
    const rule = ruleByCache.get(artifact.cache || "short");
    return !rule || !Array.isArray(rule.appliesTo) || !rule.appliesTo.includes(artifact.type);
  }).map((artifact) => `${artifact.type}:${artifact.path}`);
  addCheck(
    checks,
    "cache",
    "artifact type cache mapping",
    missingTypeRules.length ? "fail" : "ok",
    missingTypeRules.length ? `发布物类型未覆盖: ${missingTypeRules.join(", ")}` : `${artifacts.length} 个必需发布物均映射到缓存规则`,
    "new-remote-web/release-manifest.json"
  );

  const noCacheRule = ruleByCache.get("no-cache");
  const shortRule = ruleByCache.get("short");
  const immutableRule = ruleByCache.get("immutable-after-hash-build");

  const noCacheHeader = String(noCacheRule && noCacheRule.headers && noCacheRule.headers.cacheControl || "");
  const noCacheMaxAge = Number(noCacheRule && noCacheRule.headers && noCacheRule.headers.maxAgeSeconds);
  addCheck(
    checks,
    "cache",
    "html config no-cache headers",
    /no-cache|no-store|must-revalidate/i.test(noCacheHeader) && noCacheMaxAge <= 60 ? "ok" : "fail",
    `Cache-Control=${noCacheHeader || "missing"}, maxAge=${Number.isFinite(noCacheMaxAge) ? noCacheMaxAge : "missing"}`,
    "deploy/environments/*.json"
  );

  const shortMaxAge = Number(shortRule && shortRule.headers && shortRule.headers.maxAgeSeconds);
  addCheck(
    checks,
    "cache",
    "short asset cache headers",
    Number.isFinite(shortMaxAge) && shortMaxAge > 0 && shortMaxAge <= 600 ? "ok" : "fail",
    `short maxAge=${Number.isFinite(shortMaxAge) ? shortMaxAge : "missing"}`,
    "deploy/environments/*.json"
  );

  const immutableHeader = String(immutableRule && immutableRule.headers && immutableRule.headers.cacheControl || "");
  const immutableMaxAge = Number(immutableRule && immutableRule.headers && immutableRule.headers.maxAgeSeconds);
  const immutableOk = /immutable/i.test(immutableHeader) &&
    Number.isFinite(immutableMaxAge) &&
    immutableMaxAge >= 86400 &&
    immutableRule &&
    immutableRule.requiresHashOrCoexistence === true;
  addCheck(
    checks,
    "cache",
    "immutable asset cache headers",
    immutableOk ? "ok" : "fail",
    `Cache-Control=${immutableHeader || "missing"}, maxAge=${Number.isFinite(immutableMaxAge) ? immutableMaxAge : "missing"}, coexistence=${!!(immutableRule && immutableRule.requiresHashOrCoexistence)}`,
    "deploy/environments/*.json"
  );
}

function validateReleaseAndRetention(checks, config, manifest, env) {
  addCheck(
    checks,
    "release",
    "release id matches manifest",
    config.releaseId === manifest.releaseId ? "ok" : "fail",
    `config=${config.releaseId || ""}, manifest=${manifest.releaseId || ""}`,
    "deploy/environments/*.json"
  );

  const minimumRetained = Number(config.retention && config.retention.minimumRetainedPackages || 0);
  const rollbackTtlHours = Number(config.retention && config.retention.rollbackTtlHours || 0);
  const packageIndex = existsSync(packageIndexPath) ? readJson(packageIndexPath) : null;
  const packages = packageIndex && Array.isArray(packageIndex.packages) ? packageIndex.packages : [];
  const retentionStatus = packages.length >= minimumRetained ? "ok" : isLocalEnvironment(env) ? "warn" : "fail";

  addCheck(
    checks,
    "rollback",
    "package retention",
    retentionStatus,
    packages.length >= minimumRetained
      ? `已保留 ${packages.length}/${minimumRetained} 个发布包`
      : `当前 ${packages.length}/${minimumRetained} 个发布包；生产前必须至少保留当前和上一版本`,
    existsSync(packageIndexPath) ? rel(packageIndexPath) : "node remote-web/scripts/package-release.mjs"
  );
  addCheck(
    checks,
    "rollback",
    "rollback ttl",
    rollbackTtlHours >= 24 ? "ok" : "fail",
    `rollbackTtlHours=${Number.isFinite(rollbackTtlHours) ? rollbackTtlHours : "missing"}`,
    "deploy/environments/*.json"
  );
}

function mdTable(rows) {
  return [
    "| Category | Check | Status | Detail | Evidence |",
    "|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.category} | ${row.name} | ${row.status} | ${String(row.detail).replace(/\|/g, "\\|")} | ${row.evidence} |`)
  ].join("\n");
}

function buildMarkdown(report) {
  return [
    "# Remote Web Deploy Config Check",
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
    mdTable(report.checks)
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
const configPath = resolveConfigPath(args);
const env = args.env;
const outputBase = join(artifactsDir, `deploy-config-check-${safeName(env)}`);
const jsonOutputPath = `${outputBase}.json`;
const mdOutputPath = `${outputBase}.md`;

mkdirSync(artifactsDir, { recursive: true });

if (!existsSync(configPath)) {
  throw new Error(`deploy config not found: ${configPath}`);
}

const manifest = readJson(manifestPath);
const config = readJson(configPath);
const checks = [];

addCheck(
  checks,
  "environment",
  "schema version",
  config.schemaVersion === 1 ? "ok" : "fail",
  `schemaVersion=${config.schemaVersion || ""}`,
  rel(configPath)
);
addCheck(
  checks,
  "environment",
  "environment name",
  config.environment === env ? "ok" : "fail",
  `config=${config.environment || ""}, expected=${env}`,
  rel(configPath)
);

validateOrigins(checks, config, env);
validateCacheRules(checks, config, manifest);
validateReleaseAndRetention(checks, config, manifest, env);

const failed = checks.filter((check) => check.status === "fail");
const warnings = checks.filter((check) => check.status === "warn");
const status = failed.length ? "fail" : warnings.length ? "warn" : "ok";
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: env,
  configPath: rel(configPath),
  releaseId: manifest.releaseId,
  status,
  summary: {
    checkCount: checks.length,
    failed: failed.length,
    warnings: warnings.length,
    ok: checks.filter((check) => check.status === "ok").length
  },
  origins: config.origins,
  retention: config.retention,
  checks,
  outputs: {
    json: rel(jsonOutputPath),
    markdown: rel(mdOutputPath)
  }
};

writeJson(jsonOutputPath, report);
writeFileSync(mdOutputPath, buildMarkdown(report), "utf8");

console.log("DEPLOY_CONFIG_" + status.toUpperCase());
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
