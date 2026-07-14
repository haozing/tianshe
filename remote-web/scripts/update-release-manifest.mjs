import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "..");
const manifestPath = join(root, "new-remote-web", "release-manifest.json");
const chihuConfigPath = join(root, "new-remote-web", "config", "chihu-config.json");
const indexPath = join(root, "new-remote-web", "index.html");
const signingKeyPath = join(root, "signing-key.local.pem");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha384Sri(filePath) {
  return `sha384-${createHash("sha384").update(readFileSync(filePath)).digest("base64")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function unsignedManifestForSigning(manifest) {
  const unsigned = JSON.parse(JSON.stringify(manifest));
  delete unsigned.signature;
  return unsigned;
}

function withHtmlAttribute(tag, name, value) {
  const attribute = `${name}="${value}"`;
  const pattern = new RegExp(`\\s${name}(?:="[^"]*")?`, "gi");
  return tag.replace(pattern, "").replace(/\s*>$/, ` ${attribute}>`);
}

function applyIntegrityToTag(html, attrName, assetName, integrity) {
  const pattern = new RegExp(`<[^>]+\\s${attrName}="\\./${assetName}(?:\\?[^"]*)?"[^>]*>`, "i");
  return html.replace(pattern, (tag) => {
    let next = withHtmlAttribute(tag, "integrity", integrity);
    next = withHtmlAttribute(next, "crossorigin", "anonymous");
    return next;
  });
}

function applySubresourceIntegrity() {
  if (!existsSync(indexPath)) return;
  const appPath = join(root, "new-remote-web", "app.js");
  const stylesPath = join(root, "new-remote-web", "styles.css");
  const bridgePath = join(root, "new-remote-web", "bridge.js");
  let html = readFileSync(indexPath, "utf8");
  html = applyIntegrityToTag(html, "src", "app\\.js", sha384Sri(appPath));
  html = applyIntegrityToTag(html, "href", "styles\\.css", sha384Sri(stylesPath));
  html = applyIntegrityToTag(html, "src", "bridge\\.js", sha384Sri(bridgePath));
  writeFileSync(indexPath, html, "utf8");
}

function readSigningKey() {
  const inline = process.env.CHIHU_REMOTE_MANIFEST_PRIVATE_KEY;
  if (inline && inline.trim()) return inline.replace(/\\n/g, "\n");
  if (existsSync(signingKeyPath)) return readFileSync(signingKeyPath, "utf8");
  return "";
}

function signManifest(manifest) {
  if (process.env.CHIHU_REMOTE_MANIFEST_UNSIGNED === "1") {
    delete manifest.signature;
    return false;
  }

  const keyPem = readSigningKey();
  if (!keyPem) {
    throw new Error(
      "Remote manifest signing key is missing. Set CHIHU_REMOTE_MANIFEST_PRIVATE_KEY or create remote-web/signing-key.local.pem."
    );
  }

  const payload = canonicalJson(unsignedManifestForSigning(manifest));
  const signature = sign(null, Buffer.from(payload, "utf8"), createPrivateKey(keyPem));
  manifest.signature = {
    schemaVersion: 1,
    algorithm: "ed25519",
    keyId: process.env.CHIHU_REMOTE_MANIFEST_KEY_ID || "chihu-remote-web-ed25519-2026-07",
    payloadSha256: sha256Text(payload),
    value: signature.toString("base64")
  };
  return true;
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
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true
    }).trim();
    const status = execFileSync("git", ["status", "--short"], {
      cwd: repoRoot,
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
applySubresourceIntegrity();

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

const signed = signManifest(manifest);
writeJson(manifestPath, manifest);

console.log("UPDATE_RELEASE_MANIFEST_OK");
console.log(JSON.stringify({
  releaseId,
  buildTime,
  gitCommit: commit,
  manifestPath: manifestPath.replace(`${dirname(root)}\\`, "").replace(/\\/g, "/"),
  chihuConfigPath: chihuConfigPath.replace(`${dirname(root)}\\`, "").replace(/\\/g, "/"),
  signed,
  artifactCount: (manifest.artifacts || []).length
}, null, 2));
