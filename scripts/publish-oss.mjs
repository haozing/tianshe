import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const COS = require("cos-nodejs-sdk-v5");

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const remoteShellRoot = join(repoRoot, "remote-web", "client-shell");
const remoteRoot = join(repoRoot, "remote-web");
const remoteBuildRoot = join(remoteRoot, "new-remote-web");
const remoteManifestPath = join(remoteBuildRoot, "release-manifest.json");
const remotePackagesRoot = join(remoteRoot, "artifacts", "release-packages");
const electronRoot = join(repoRoot, "electron-client");
const electronReleaseRoot = join(electronRoot, "release");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const defaultEnvFiles = [".env.oss.local", ".env.oss", ".env"];

function parseArgs(argv) {
  const args = {
    remote: false,
    desktop: false,
    beta: false,
    skipBuild: false,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--all") {
      args.remote = true;
      args.desktop = true;
    } else if (value === "--remote") {
      args.remote = true;
    } else if (value === "--desktop") {
      args.desktop = true;
    } else if (value === "--beta") {
      args.beta = true;
    } else if (value === "--skip-build") {
      args.skipBuild = true;
    } else if (value === "--dry-run") {
      args.dryRun = true;
    }
  }

  if (!args.remote && !args.desktop) {
    args.remote = true;
    args.desktop = true;
  }

  return args;
}

function loadEnvFiles() {
  for (const name of defaultEnvFiles) {
    const filePath = join(repoRoot, name);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function isPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized.includes("replace") || normalized.includes("accesskey") || normalized.includes("secret-id") || normalized.includes("secret-key");
}

function envValue(names, fallback = "") {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const value = process.env[name];
    if (!isPlaceholder(value)) return value;
  }
  return fallback;
}

function requiredEnv(names, dryRun) {
  const value = envValue(names, "");
  if (value) return value;
  const label = Array.isArray(names) ? names.join(" or ") : names;
  if (dryRun) return "";
  throw new Error(`Missing ${label}. Copy .env.oss.example to .env.oss.local and fill it first.`);
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha512Base64(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("base64");
}

function assertInside(child, parent, label) {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  const boundary = resolvedParent.endsWith(sep) ? resolvedParent : `${resolvedParent}${sep}`;
  if (resolvedChild !== resolvedParent && !resolvedChild.startsWith(boundary)) {
    throw new Error(`${label} must stay inside ${resolvedParent}: ${resolvedChild}`);
  }
}

function run(command, args, options = {}) {
  const label = [command, ...args].join(" ");
  const useShell = process.platform === "win32" && /\.cmd$/i.test(command);
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    shell: useShell,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function listFilesRecursive(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function contentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json" || ext === ".map") return "application/json; charset=utf-8";
  if (ext === ".yml" || ext === ".yaml") return "text/yaml; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function contentDisposition(filePath) {
  void filePath;
  return "";
}

function remoteCacheControl(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (
    normalized.endsWith("index.html") ||
    normalized.endsWith("release-manifest.json") ||
    normalized.startsWith("new-remote-web/config/")
  ) {
    return "no-cache, no-store, must-revalidate";
  }
  if (
    normalized.endsWith("app.js") ||
    normalized.endsWith("styles.css") ||
    normalized.endsWith("bridge.js")
  ) {
    return "public, max-age=300, must-revalidate";
  }
  if (normalized.startsWith("new-remote-web/assets/")) {
    const filename = basename(normalized);
    return /\.[a-f0-9]{12}\.[^.]+$/i.test(filename)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300, must-revalidate";
  }
  return "public, max-age=31536000, immutable";
}

function desktopCacheControl(filePath) {
  const name = basename(filePath).toLowerCase();
  if (/\.ya?ml$/.test(name)) return "no-cache, no-store, must-revalidate";
  return "public, max-age=300, must-revalidate";
}

function desktopCompatibilityChannels() {
  const raw = envValue(["CHIHU_DESKTOP_COMPAT_CHANNELS", "DESKTOP_COMPAT_CHANNELS"], "phase0,phase1");
  return raw
    .split(",")
    .map((channel) => channel.trim())
    .filter(Boolean)
    .filter((channel) => /^[A-Za-z0-9._-]+$/.test(channel));
}

function buildUploadItem({ localPath, objectKey, cacheControl }) {
  const disposition = contentDisposition(localPath);
  return {
    localPath,
    objectKey: objectKey.replace(/\\/g, "/").replace(/^\/+/, ""),
    size: statSync(localPath).size,
    sha256: sha256(localPath),
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": contentType(localPath),
      ...(disposition ? { "Content-Disposition": disposition } : {})
    }
  };
}

function createClient(config, dryRun) {
  if (dryRun) return null;
  return new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey
  });
}

function putCosObject(client, config, item) {
  const params = {
    Bucket: config.bucket,
    Region: config.region,
    Key: item.objectKey,
    Body: createReadStream(item.localPath),
    ContentLength: item.size,
    ContentType: item.headers["Content-Type"],
    CacheControl: item.headers["Cache-Control"]
  };
  if (item.headers["Content-Disposition"]) {
    params.ContentDisposition = item.headers["Content-Disposition"];
  }

  return new Promise((resolvePromise, rejectPromise) => {
    client.putObject(params, (error, data) => {
      if (error) rejectPromise(error);
      else resolvePromise(data);
    });
  });
}

async function uploadItems(client, config, items, dryRun) {
  for (const item of items) {
    const sizeKb = (item.size / 1024).toFixed(1);
    if (dryRun) {
      console.log(`[dry-run] ${item.objectKey}  ${sizeKb} KB  ${item.headers["Cache-Control"]}`);
      continue;
    }
    console.log(`[upload] ${item.objectKey}  ${sizeKb} KB`);
    await putCosObject(client, config, item);
  }
}

function publicUrl(baseUrl, objectKey) {
  return `${trimTrailingSlash(baseUrl)}/${objectKey.replace(/^\/+/, "")}`;
}

function getConfig(args) {
  loadEnvFiles();
  const region = envValue(["TENCENT_COS_REGION", "COS_REGION"], "ap-shanghai");
  const bucket = envValue(["TENCENT_COS_BUCKET", "COS_BUCKET"], "chihu-1434132228");
  const remotePrefix = args.beta
    ? envValue(["TENCENT_COS_BETA_REMOTE_PREFIX", "COS_BETA_REMOTE_PREFIX"], "remote-web/beta/current")
    : envValue(["TENCENT_COS_REMOTE_PREFIX", "COS_REMOTE_PREFIX", "ALI_OSS_REMOTE_PREFIX"], "remote-web/current");
  const remoteReleasesPrefix = args.beta
    ? envValue(["TENCENT_COS_BETA_REMOTE_RELEASES_PREFIX", "COS_BETA_REMOTE_RELEASES_PREFIX"], "remote-web/beta/releases")
    : envValue(["TENCENT_COS_REMOTE_RELEASES_PREFIX", "COS_REMOTE_RELEASES_PREFIX", "ALI_OSS_REMOTE_RELEASES_PREFIX"], "remote-web/releases");
  const accessBaseUrl = trimTrailingSlash(envValue(
    ["TENCENT_COS_ACCESS_BASE_URL", "COS_ACCESS_BASE_URL"],
    `https://${bucket}.cos.${region}.myqcloud.com`
  ));
  const websiteBaseUrl = trimTrailingSlash(envValue(
    ["TENCENT_COS_WEBSITE_BASE_URL", "COS_WEBSITE_BASE_URL", "TENCENT_COS_PUBLIC_BASE_URL", "COS_PUBLIC_BASE_URL"],
    `https://${bucket}.cos-website.${region}.myqcloud.com`
  ));

  return {
    provider: "tencent-cos",
    region,
    bucket,
    remoteBaseUrl: websiteBaseUrl,
    desktopBaseUrl: trimTrailingSlash(envValue(["TENCENT_COS_DESKTOP_BASE_URL", "COS_DESKTOP_BASE_URL"], accessBaseUrl)),
    secretId: requiredEnv(["TENCENT_COS_SECRET_ID", "COS_SECRET_ID"], args.dryRun),
    secretKey: requiredEnv(["TENCENT_COS_SECRET_KEY", "COS_SECRET_KEY"], args.dryRun),
    remotePrefix: trimSlashes(remotePrefix),
    remoteReleasesPrefix: trimSlashes(remoteReleasesPrefix),
    desktopPrefix: trimSlashes(envValue(["TENCENT_COS_DESKTOP_PREFIX", "COS_DESKTOP_PREFIX", "ALI_OSS_DESKTOP_PREFIX"], "desktop/win"))
  };
}

function buildRemote(config, skipBuild, beta) {
  if (skipBuild) return;
  const remoteOrigin = `${config.remoteBaseUrl}/${config.remotePrefix}/new-remote-web/`;
  const buildEnv = {
    ...process.env,
    CHIHU_REMOTE_BASE: "./",
    CHIHU_REMOTE_WEB_ORIGIN: remoteOrigin
  };
  run(npmCommand, ["run", "build:release"], { cwd: remoteShellRoot, env: buildEnv });
  run(process.execPath, [
    join(remoteRoot, "scripts", "apply-release-channel-policy.mjs"),
    "--channel", beta ? "beta" : "stable",
    "--build-root", remoteBuildRoot
  ], { cwd: repoRoot, env: buildEnv });
  run(process.execPath, [
    "--experimental-strip-types",
    join(remoteRoot, "scripts", "export-doudian-window-commands.mjs"),
    "--adapter", join(remoteBuildRoot, "config", "doudian-adapter.marketing-pilot.json"),
    "--output", join(remoteBuildRoot, "config", "doudian-window-commands.json")
  ], { cwd: repoRoot, env: buildEnv });
  run(process.execPath, [join(remoteRoot, "scripts", "update-release-manifest.mjs")], { cwd: repoRoot, env: buildEnv });
  run(process.execPath, [join(remoteRoot, "scripts", "check-release.mjs")], { cwd: repoRoot });
  run(process.execPath, [join(remoteRoot, "scripts", "package-release.mjs")], { cwd: repoRoot });
}

function assertRemoteChannelBuild(config, beta) {
  const adapterPath = join(remoteBuildRoot, "config", "doudian-adapter.marketing-pilot.json");
  const commandsPath = join(remoteBuildRoot, "config", "doudian-window-commands.json");
  if (!existsSync(remoteManifestPath) || !existsSync(adapterPath) || !existsSync(commandsPath)) {
    throw new Error("Remote channel build is incomplete");
  }
  const manifest = readJson(remoteManifestPath);
  const adapter = readJson(adapterPath);
  const commands = readJson(commandsPath);
  const expectedOrigin = `${config.remoteBaseUrl}/${config.remotePrefix}/new-remote-web/`;
  const actualOrigin = String(manifest.entry?.remoteWebOrigin || "");
  const recoveryEnabled = adapter.policies?.opportunityReport?.submitThrottleRecoveryEnabled === true;
  const historyPrewarmEnabled = adapter.policies?.opportunityReport?.submitHistoryPrewarmEnabled === true;
  const streamingEnabled = adapter.policies?.opportunityReport?.submitPipelineStreamingEnabled === true;
  if (actualOrigin !== expectedOrigin) {
    throw new Error(`Remote channel origin mismatch: expected ${expectedOrigin}, received ${actualOrigin || "empty"}`);
  }
  if (recoveryEnabled !== beta) {
    throw new Error(`Remote channel recovery policy mismatch: channel=${beta ? "beta" : "stable"}, enabled=${recoveryEnabled}`);
  }
  if (historyPrewarmEnabled || streamingEnabled !== beta) {
    throw new Error(`Remote channel throughput policy mismatch: channel=${beta ? "beta" : "stable"}, prewarm=${historyPrewarmEnabled}, streaming=${streamingEnabled}`);
  }
  if (commands.adapterSha256 !== sha256(adapterPath)) {
    throw new Error("Remote channel adapter and window command hashes do not match");
  }
}

function collectRemoteItems(config) {
  if (!existsSync(remoteManifestPath)) throw new Error(`Remote manifest not found: ${remoteManifestPath}`);
  const manifest = readJson(remoteManifestPath);
  const releaseId = manifest.releaseId;
  if (!releaseId) throw new Error("release-manifest releaseId is empty");

  const deployDir = join(remotePackagesRoot, releaseId, "deploy");
  assertInside(deployDir, remotePackagesRoot, "remote deploy directory");
  if (!existsSync(deployDir)) {
    throw new Error(`Remote deploy package not found: ${deployDir}. Run without --skip-build first.`);
  }

  const items = [];
  for (const filePath of listFilesRecursive(deployDir)) {
    const relPath = relative(deployDir, filePath).replace(/\\/g, "/");
    const cacheControl = remoteCacheControl(relPath);
    items.push(buildUploadItem({
      localPath: filePath,
      objectKey: `${config.remotePrefix}/${relPath}`,
      cacheControl
    }));
    items.push(buildUploadItem({
      localPath: filePath,
      objectKey: `${config.remoteReleasesPrefix}/${releaseId}/${relPath}`,
      cacheControl
    }));
  }

  return {
    releaseId,
    items,
    currentUrl: `${config.remoteBaseUrl}/${config.remotePrefix}/new-remote-web/index.html`,
    releaseUrl: `${config.remoteBaseUrl}/${config.remoteReleasesPrefix}/${releaseId}/new-remote-web/index.html`
  };
}

function buildDesktop(skipBuild, beta) {
  if (skipBuild) return;
  assertInside(electronReleaseRoot, electronRoot, "electron release directory");
  rmSync(electronReleaseRoot, { recursive: true, force: true });
  mkdirSync(dirname(electronReleaseRoot), { recursive: true });
  run(npmCommand, ["run", beta ? "dist:win:beta" : "dist:win"], { cwd: electronRoot });
}

function ensureDesktopChannelYml(beta) {
  const channel = beta ? "beta" : "latest";
  const channelPath = join(electronReleaseRoot, `${channel}.yml`);

  const setupFiles = readdirSync(electronReleaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /-setup\.exe$/i.test(entry.name))
    .map((entry) => join(electronReleaseRoot, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (!setupFiles.length) throw new Error(`No setup exe was generated; cannot create ${channel}.yml.`);

  const setupPath = setupFiles[0];
  const packageJson = readJson(join(electronRoot, "package.json"));
  const setupName = basename(setupPath);
  const setupSize = statSync(setupPath).size;
  const setupSha512 = sha512Base64(setupPath);
  const releaseDate = new Date().toISOString();
  const channelYml = [
    `version: ${packageJson.version}`,
    "files:",
    `  - url: ${JSON.stringify(setupName)}`,
    `    sha512: ${setupSha512}`,
    `    size: ${setupSize}`,
    `path: ${JSON.stringify(setupName)}`,
    `sha512: ${setupSha512}`,
    `releaseDate: ${JSON.stringify(releaseDate)}`,
    ""
  ].join("\n");

  writeFileSync(channelPath, channelYml, "utf8");
  console.log(`[${channel}] generated ${relative(repoRoot, channelPath).replace(/\\/g, "/")}`);
  return channelPath;
}

function collectDesktopItems(config, beta) {
  if (!existsSync(electronReleaseRoot)) {
    throw new Error(`Electron release directory not found: ${electronReleaseRoot}`);
  }
  const channel = beta ? "beta" : "latest";
  const channelPath = ensureDesktopChannelYml(beta);
  const files = readdirSync(electronReleaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(electronReleaseRoot, entry.name))
    .filter((filePath) => /\.(exe|blockmap|ya?ml)$/i.test(filePath))
    .filter((filePath) => !beta || !/\.ya?ml$/i.test(filePath) || basename(filePath).toLowerCase() === "beta.yml")
    .sort((a, b) => basename(a).localeCompare(basename(b)));

  if (!files.includes(channelPath)) throw new Error(`${channel}.yml was not generated.`);

  const items = files.map((filePath) => buildUploadItem({
    localPath: filePath,
    objectKey: `${config.desktopPrefix}/${basename(filePath)}`,
    cacheControl: desktopCacheControl(filePath)
  }));

  if (!beta) {
    const itemKeys = new Set(items.map((item) => item.objectKey));
    for (const compatibilityChannel of desktopCompatibilityChannels()) {
      const objectKey = `${config.desktopPrefix}/${compatibilityChannel}.yml`;
      if (itemKeys.has(objectKey)) continue;
      items.push(buildUploadItem({
        localPath: channelPath,
        objectKey,
        cacheControl: desktopCacheControl(channelPath)
      }));
      itemKeys.add(objectKey);
    }
  }

  return {
    items,
    channel,
    channelUrl: publicUrl(config.desktopBaseUrl, `${config.desktopPrefix}/${channel}.yml`)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getConfig(args);
  const client = createClient(config, args.dryRun);
  const results = {};

  console.log(JSON.stringify({
    provider: config.provider,
    channel: args.beta ? "beta" : "stable",
    dryRun: args.dryRun,
    skipBuild: args.skipBuild,
    bucket: config.bucket,
    region: config.region,
    remoteBaseUrl: args.remote ? config.remoteBaseUrl : null,
    desktopBaseUrl: args.desktop ? config.desktopBaseUrl : null,
    remotePrefix: args.remote ? config.remotePrefix : null,
    remoteReleasesPrefix: args.remote ? config.remoteReleasesPrefix : null,
    desktopPrefix: args.desktop ? config.desktopPrefix : null
  }, null, 2));

  if (args.remote) {
    buildRemote(config, args.skipBuild, args.beta);
    assertRemoteChannelBuild(config, args.beta);
    const remote = collectRemoteItems(config);
    await uploadItems(client, config, remote.items, args.dryRun);
    results.remote = {
      releaseId: remote.releaseId,
      objectCount: remote.items.length,
      currentUrl: remote.currentUrl,
      releaseUrl: remote.releaseUrl
    };
  }

  if (args.desktop) {
    buildDesktop(args.skipBuild, args.beta);
    const desktop = collectDesktopItems(config, args.beta);
    await uploadItems(client, config, desktop.items, args.dryRun);
    results.desktop = {
      objectCount: desktop.items.length,
      channel: desktop.channel,
      channelUrl: desktop.channelUrl
    };
  }

  console.log("\nCOS_PUBLISH_OK");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error("\nCOS_PUBLISH_FAILED");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
