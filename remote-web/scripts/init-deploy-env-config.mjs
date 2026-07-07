import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const deployEnvDir = join(root, "deploy", "environments");
const manifestPath = join(root, "new-remote-web", "release-manifest.json");

const FORBIDDEN_PLACEHOLDER_ORIGIN = ["https://www", "chihu", "com"].join(".");
const FORBIDDEN_PLACEHOLDER_HOST_PATTERN = new RegExp(["www", "chihu", "com"].join("\\."), "i");
const ENVIRONMENTS = ["test", "staging", "production"];

function parseArgs(argv) {
  const args = {
    env: "",
    mode: "",
    output: "",
    force: false,
    print: false,
    newOrigin: "",
    remoteConfigUrl: "",
    assetsBase: "",
    diagnosticsUploadUrl: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--env") {
      args.env = next || "";
      index += 1;
    } else if (value.startsWith("--env=")) {
      args.env = value.slice("--env=".length);
    } else if (value === "--sample") {
      args.mode = "sample";
    } else if (value === "--real") {
      args.mode = "real";
    } else if (value === "--output") {
      args.output = next || "";
      index += 1;
    } else if (value.startsWith("--output=")) {
      args.output = value.slice("--output=".length);
    } else if (value === "--force") {
      args.force = true;
    } else if (value === "--print") {
      args.print = true;
    } else if (value === "--new-origin") {
      args.newOrigin = next || "";
      index += 1;
    } else if (value.startsWith("--new-origin=")) {
      args.newOrigin = value.slice("--new-origin=".length);
    } else if (value === "--remote-config-url") {
      args.remoteConfigUrl = next || "";
      index += 1;
    } else if (value.startsWith("--remote-config-url=")) {
      args.remoteConfigUrl = value.slice("--remote-config-url=".length);
    } else if (value === "--assets-base") {
      args.assetsBase = next || "";
      index += 1;
    } else if (value.startsWith("--assets-base=")) {
      args.assetsBase = value.slice("--assets-base=".length);
    } else if (value === "--diagnostics-upload-url") {
      args.diagnosticsUploadUrl = next || "";
      index += 1;
    } else if (value.startsWith("--diagnostics-upload-url=")) {
      args.diagnosticsUploadUrl = value.slice("--diagnostics-upload-url=".length);
    }
  }

  args.env = safeName(args.env || "production");
  if (!args.mode) args.mode = "sample";
  return args;
}

function safeName(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_.-]+/g, "_").toLowerCase();
}

function rel(filePath) {
  return relative(repoRoot, resolve(filePath)).replace(/\\/g, "/");
}

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function joinUrl(origin, pathname) {
  return new URL(String(pathname || "").replace(/^\/+/, ""), normalizeOrigin(origin)).toString();
}

function hasPlaceholder(value) {
  const text = String(value || "");
  return /(__REPLACE|NEW_REMOTE|OLD_REMOTE|REMOTE_CONFIG|REMOTE_ASSETS|DIAGNOSTICS_UPLOAD|example\.com|\{|\})/i.test(text) ||
    FORBIDDEN_PLACEHOLDER_HOST_PATTERN.test(text);
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function cdnRulesFromBase() {
  const basePath = join(deployEnvDir, "production.sample.json");
  if (existsSync(basePath)) {
    const base = readJson(basePath);
    return base.cdn || null;
  }
  return {
    rules: [
      {
        name: "html-config-no-cache",
        artifactCache: "no-cache",
        appliesTo: [
          "remote-html",
          "chihu-config",
          "chihu-config-smoke",
          "release-manifest"
        ],
        headers: {
          cacheControl: "no-cache, no-store, must-revalidate",
          maxAgeSeconds: 0
        }
      },
      {
        name: "short-js-css",
        artifactCache: "short",
        appliesTo: [
          "remote-js",
          "remote-css"
        ],
        headers: {
          cacheControl: "public, max-age=300, must-revalidate",
          maxAgeSeconds: 300
        }
      },
      {
        name: "hashed-assets",
        artifactCache: "immutable-after-hash-build",
        appliesTo: [
          "remote-asset"
        ],
        headers: {
          cacheControl: "public, max-age=31536000, immutable",
          maxAgeSeconds: 31536000
        },
        requiresHashOrCoexistence: true
      }
    ]
  };
}

function samplePlaceholder(env, name) {
  return `https://__REPLACE_WITH_${name}_${env.toUpperCase()}__/`;
}

function buildConfig(args) {
  const manifest = readJson(manifestPath);
  const cdn = cdnRulesFromBase();
  const retention = {
    minimumRetainedPackages: 2,
    rollbackTtlHours: 48
  };

  if (args.mode === "sample") {
    const newOrigin = samplePlaceholder(args.env, "NEW_REMOTE_WEB_ORIGIN");
    return {
      schemaVersion: 1,
      environment: args.env,
      releaseId: manifest.releaseId,
      origins: {
        newRemoteWebOrigin: newOrigin,
        remoteConfigUrl: `${newOrigin.replace(/\/+$/, "")}/new-remote-web/config/chihu-config.json`,
        remoteAssetsBase: newOrigin,
        diagnosticsUploadUrl: samplePlaceholder(args.env, "DIAGNOSTICS_UPLOAD_URL")
      },
      cdn,
      retention
    };
  }

  const newOrigin = args.newOrigin ? normalizeOrigin(args.newOrigin) : "";
  const assetsBase = args.assetsBase ? normalizeOrigin(args.assetsBase) : newOrigin;
  const remoteConfigUrl = args.remoteConfigUrl || (newOrigin ? joinUrl(newOrigin, "new-remote-web/config/chihu-config.json") : "");

  return {
    schemaVersion: 1,
    environment: args.env,
    releaseId: manifest.releaseId,
    origins: {
      newRemoteWebOrigin: newOrigin,
      remoteConfigUrl,
      remoteAssetsBase: assetsBase,
      diagnosticsUploadUrl: args.diagnosticsUploadUrl
    },
    cdn,
    retention
  };
}

function validateConfig(config, mode) {
  const failures = [];
  const origins = config.origins || {};
  const requiredKeys = [
    "newRemoteWebOrigin",
    "remoteConfigUrl",
    "remoteAssetsBase",
    "diagnosticsUploadUrl"
  ];
  const missing = requiredKeys.filter((key) => !origins[key]);
  if (missing.length) failures.push(`missing origins: ${missing.join(", ")}`);

  if (mode === "real") {
    const nonHttps = requiredKeys.filter((key) => origins[key] && !isHttpsUrl(origins[key]));
    const placeholders = requiredKeys.filter((key) => hasPlaceholder(origins[key]));
    const forbidden = requiredKeys.filter((key) => String(origins[key] || "").includes(FORBIDDEN_PLACEHOLDER_ORIGIN));
    if (nonHttps.length) failures.push(`non-HTTPS origins: ${nonHttps.join(", ")}`);
    if (placeholders.length) failures.push(`placeholder values: ${placeholders.join(", ")}`);
    if (forbidden.length) failures.push(`forbidden placeholder origin: ${forbidden.join(", ")}`);
  }

  return failures;
}

function defaultOutputPath(args) {
  const suffix = args.mode === "sample" ? ".sample.json" : ".json";
  return join(deployEnvDir, `${args.env}${suffix}`);
}

const args = parseArgs(process.argv.slice(2));
if (!ENVIRONMENTS.includes(args.env)) {
  throw new Error(`--env must be one of ${ENVIRONMENTS.join(", ")}`);
}

const outputPath = args.output ? resolve(repoRoot, args.output) : defaultOutputPath(args);
const config = buildConfig(args);
const failures = validateConfig(config, args.mode);
const payload = JSON.stringify(config, null, 2) + "\n";

if (args.print) {
  process.stdout.write(payload);
}

if (failures.length) {
  console.error("DEPLOY_ENV_CONFIG_INVALID");
  console.error(JSON.stringify({
    env: args.env,
    mode: args.mode,
    output: rel(outputPath),
    failures
  }, null, 2));
  process.exit(1);
}

if (!args.print) {
  if (existsSync(outputPath) && !args.force) {
    throw new Error(`output exists; pass --force to overwrite: ${rel(outputPath)}`);
  }
  ensureDir(outputPath);
  writeFileSync(outputPath, payload, "utf8");
}

console.log(args.mode === "real" ? "DEPLOY_ENV_CONFIG_READY" : "DEPLOY_ENV_SAMPLE_READY");
console.log(JSON.stringify({
  env: args.env,
  mode: args.mode,
  wrote: !args.print,
  output: rel(outputPath),
  releaseId: config.releaseId
}, null, 2));
