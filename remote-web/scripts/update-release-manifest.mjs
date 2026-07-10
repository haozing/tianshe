import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const manifestPath = join(root, "new-remote-web", "release-manifest.json");
const chihuConfigPath = join(root, "new-remote-web", "config", "chihu-config.json");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function argValue(name) {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return "";
}

function gitCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: resolve(root, ".."),
      encoding: "utf8",
      windowsHide: true
    }).trim();
    const status = execFileSync("git", ["status", "--short"], {
      cwd: resolve(root, ".."),
      encoding: "utf8",
      windowsHide: true
    }).trim();
    return status ? `${commit}-dirty` : commit;
  } catch {
    return "unknown";
  }
}

function assertFile(filePath, artifactPath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`artifact is missing: ${artifactPath}`);
  }
}

const manifest = readJson(manifestPath);
const chihuConfig = readJson(chihuConfigPath);
const releaseId = argValue("--release-id") || process.env.CHIHU_RELEASE_ID || manifest.releaseId;
const remoteOrigin = argValue("--remote-origin") || process.env.CHIHU_REMOTE_WEB_ORIGIN || manifest.entry?.remoteWebOrigin || "";
const buildTime = argValue("--build-time") || process.env.CHIHU_REMOTE_BUILD_TIME || new Date().toISOString();
const commit = argValue("--git-commit") || process.env.CHIHU_GIT_COMMIT || gitCommit();

if (!releaseId) throw new Error("releaseId is required");

manifest.releaseId = releaseId;
manifest.buildTime = buildTime;
manifest.entry = {
  ...(manifest.entry || {}),
  remoteWebOrigin: remoteOrigin
};

chihuConfig.version = releaseId;
chihuConfig.release = {
  ...(chihuConfig.release || {}),
  gitCommit: commit,
  buildTime
};
writeJson(chihuConfigPath, chihuConfig);

for (const artifact of manifest.artifacts || []) {
  if (!artifact || artifact.type === "release-manifest") continue;
  const artifactPath = artifact.path;
  const absolutePath = join(root, artifactPath);
  if (artifact.required !== false) assertFile(absolutePath, artifactPath);
  if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
    artifact.sha256 = sha256(absolutePath);
  } else {
    delete artifact.sha256;
  }
}

writeJson(manifestPath, manifest);

console.log("UPDATE_RELEASE_MANIFEST_OK");
console.log(JSON.stringify({
  releaseId,
  buildTime,
  gitCommit: commit,
  manifestPath: manifestPath.replace(`${dirname(root)}\\`, "").replace(/\\/g, "/"),
  chihuConfigPath: chihuConfigPath.replace(`${dirname(root)}\\`, "").replace(/\\/g, "/"),
  artifactCount: (manifest.artifacts || []).length
}, null, 2));
