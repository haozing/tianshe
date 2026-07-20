const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { net } = require("electron");

const PUBLIC_KEY_PATH = path.join(__dirname, "remote-web-public-key.pem");
const DEFAULT_TIMEOUT_MS = Number(process.env.CHIHU_REMOTE_INTEGRITY_TIMEOUT_MS || 15000);
const DEFAULT_MAX_ARTIFACT_BYTES = Number(process.env.CHIHU_REMOTE_INTEGRITY_MAX_ARTIFACT_BYTES || 20 * 1024 * 1024);
const VERIFIED_RELEASE_SCHEME = "chihu-release";
let currentVerifiedRelease = null;
const verifiedReleases = new Map();
let releaseProtocolRegistered = false;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
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

function isLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function shouldVerifyRemoteUrl(entryUrl) {
  if (process.env.CHIHU_REMOTE_INTEGRITY === "0") return false;
  try {
    const url = new URL(entryUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (isLocalHost(url.hostname)) return process.env.CHIHU_REMOTE_INTEGRITY === "1";
    return true;
  } catch {
    return false;
  }
}

function manifestUrlForEntry(entryUrl) {
  const url = new URL(entryUrl);
  url.search = "";
  url.hash = "";
  if (url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}release-manifest.json`;
  } else {
    url.pathname = url.pathname.replace(/[^/]*$/, "release-manifest.json");
  }
  return url.toString();
}

function releaseRootUrlForManifest(manifestUrl) {
  const url = new URL(manifestUrl);
  url.search = "";
  url.hash = "";
  const suffix = "new-remote-web/release-manifest.json";
  if (url.pathname.endsWith(suffix)) {
    url.pathname = url.pathname.slice(0, -suffix.length);
  } else {
    url.pathname = url.pathname.replace(/[^/]*$/, "");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function assertSafeArtifactPath(artifactPath) {
  if (!artifactPath || typeof artifactPath !== "string") {
    throw new Error("artifact path is empty");
  }
  if (artifactPath.includes("..") || /^[a-z]+:\/\//i.test(artifactPath) || path.isAbsolute(artifactPath)) {
    throw new Error(`artifact path is unsafe: ${artifactPath}`);
  }
}

function artifactUrlForManifest(manifestUrl, artifactPath) {
  assertSafeArtifactPath(artifactPath);
  const releaseRoot = releaseRootUrlForManifest(manifestUrl);
  return new URL(artifactPath.replace(/^\/+/, ""), releaseRoot).toString();
}

function parseBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("manifest signature value is not base64");
  }
  return Buffer.from(value, "base64");
}

function verifyManifestSignature(manifest) {
  if (!fs.existsSync(PUBLIC_KEY_PATH)) {
    throw new Error(`remote web public key is missing: ${PUBLIC_KEY_PATH}`);
  }
  const signature = manifest && manifest.signature;
  if (!signature || signature.schemaVersion !== 1) {
    throw new Error("manifest signature is missing");
  }
  if (signature.algorithm !== "ed25519") {
    throw new Error(`unsupported manifest signature algorithm: ${signature.algorithm || ""}`);
  }

  const payload = canonicalJson(unsignedManifestForSigning(manifest));
  const payloadSha256 = sha256Text(payload);
  if (signature.payloadSha256 && signature.payloadSha256 !== payloadSha256) {
    throw new Error("manifest signature payloadSha256 mismatch");
  }

  const ok = crypto.verify(
    null,
    Buffer.from(payload, "utf8"),
    crypto.createPublicKey(fs.readFileSync(PUBLIC_KEY_PATH, "utf8")),
    parseBase64(signature.value)
  );
  if (!ok) throw new Error("manifest signature verification failed");
  return {
    keyId: signature.keyId || "",
    algorithm: signature.algorithm,
    payloadSha256
  };
}

async function withTimeout(promise, label, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchBuffer(url) {
  const fetchImpl = net && typeof net.fetch === "function" ? net.fetch.bind(net) : global.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable in main process");
  const response = await withTimeout(fetchImpl(url, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  }), `fetch ${url}`);
  if (!response || !response.ok) {
    throw new Error(`${url} http ${response ? response.status : "unknown"}`);
  }
  return Buffer.from(await withTimeout(response.arrayBuffer(), `read ${url}`));
}

function requiredArtifacts(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) {
    throw new Error("release manifest is invalid");
  }
  return manifest.artifacts.filter((artifact) => (
    artifact &&
    artifact.required !== false &&
    artifact.type !== "release-manifest"
  ));
}

async function verifyArtifact(manifestUrl, artifact) {
  if (!artifact.sha256 || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new Error(`artifact sha256 is missing: ${artifact.path}`);
  }
  const url = artifactUrlForManifest(manifestUrl, artifact.path);
  const buffer = await fetchBuffer(url);
  if (buffer.length > DEFAULT_MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact is too large: ${artifact.path}`);
  }
  const actual = sha256(buffer);
  if (actual !== artifact.sha256.toLowerCase()) {
    throw new Error(`artifact sha256 mismatch: ${artifact.path}`);
  }
  return {
    path: artifact.path,
    type: artifact.type || "",
    bytes: buffer.length,
    sha256: actual,
    buffer
  };
}

function safeReleaseDirectoryName(value) {
  return String(value || "release").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "release";
}

async function persistVerifiedRelease(cacheRoot, releaseId, artifacts) {
  if (!cacheRoot) return "";
  const fsPromises = require("node:fs/promises");
  const releaseRoot = path.join(cacheRoot, safeReleaseDirectoryName(releaseId));
  const stagingRoot = `${releaseRoot}.staging-${process.pid}-${Date.now()}`;
  await fsPromises.rm(stagingRoot, { recursive: true, force: true });
  for (const artifact of artifacts) {
    assertSafeArtifactPath(artifact.path);
    const outputPath = path.join(stagingRoot, ...artifact.path.split("/"));
    await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
    await fsPromises.writeFile(outputPath, artifact.buffer, { mode: 0o444 });
  }
  await fsPromises.rm(releaseRoot, { recursive: true, force: true });
  await fsPromises.rename(stagingRoot, releaseRoot);
  return releaseRoot;
}

function contentTypeForPath(value) {
  const extension = path.extname(value).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function verifiedReleaseEntryUrl(releaseId, artifactPath) {
  assertSafeArtifactPath(artifactPath);
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(String(releaseId || ""))) throw new Error("releaseId is unsafe");
  return `${VERIFIED_RELEASE_SCHEME}://verified/${encodeURIComponent(releaseId)}/${artifactPath.replace(/^\/+/, "")}`;
}

function parseVerifiedReleaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== `${VERIFIED_RELEASE_SCHEME}:` || url.hostname !== "verified") return null;
    const segments = url.pathname.replace(/^\/+/, "").split("/");
    const releaseId = decodeURIComponent(segments.shift() || "");
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(releaseId)) return null;
    const artifactPath = segments.map((segment) => decodeURIComponent(segment)).join("/");
    assertSafeArtifactPath(artifactPath);
    return { releaseId, artifactPath };
  } catch {
    return null;
  }
}

function registerVerifiedReleaseScheme(protocol) {
  if (releaseProtocolRegistered) return;
  releaseProtocolRegistered = true;
  protocol.registerSchemesAsPrivileged([{
    scheme: VERIFIED_RELEASE_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true }
  }]);
}

function installVerifiedReleaseProtocol(protocol) {
  protocol.handle(VERIFIED_RELEASE_SCHEME, (request) => {
    const parsed = parseVerifiedReleaseUrl(request.url);
    const release = parsed ? verifiedReleases.get(parsed.releaseId) : null;
    const artifact = parsed ? release?.artifactMap.get(parsed.artifactPath) : null;
    if (!artifact) return new Response("verified release artifact not found", { status: 404 });
    return new Response(artifact.buffer, {
      status: 200,
      headers: {
        "Content-Type": contentTypeForPath(parsed.artifactPath),
        "Cache-Control": "no-store",
        "X-Chihu-Release-Id": release.releaseId,
        "X-Content-Type-Options": "nosniff"
      }
    });
  });
}

function getVerifiedReleaseSnapshot(releaseId = "") {
  const release = releaseId ? verifiedReleases.get(String(releaseId)) : currentVerifiedRelease;
  if (!release) return null;
  return {
    releaseId: release.releaseId,
    manifestUrl: release.manifestUrl,
    entryUrl: release.entryUrl,
    adapterSnapshotHash: release.adapterSnapshotHash,
    adapter: release.adapter,
    windowCommands: release.windowCommands,
    config: release.config,
    cacheRoot: release.cacheRoot
  };
}

async function verifyRemoteWebEntry(entryUrl, options = {}) {
  if (!shouldVerifyRemoteUrl(entryUrl)) {
    return { ok: true, skipped: true, reason: "local-or-disabled", entryUrl };
  }

  const manifestUrl = manifestUrlForEntry(entryUrl);
  const manifestBuffer = await fetchBuffer(manifestUrl);
  const manifest = JSON.parse(manifestBuffer.toString("utf8"));
  const signature = verifyManifestSignature(manifest);
  const artifacts = requiredArtifacts(manifest);
  const verifiedArtifacts = [];

  for (const artifact of artifacts) {
    verifiedArtifacts.push(await verifyArtifact(manifestUrl, artifact));
  }

  const manifestPath = "new-remote-web/release-manifest.json";
  verifiedArtifacts.push({
    path: manifestPath,
    type: "release-manifest",
    bytes: manifestBuffer.length,
    sha256: sha256(manifestBuffer),
    buffer: manifestBuffer
  });
  const releaseId = String(manifest.releaseId || "");
  if (!releaseId) throw new Error("release manifest releaseId is missing");
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(releaseId)) throw new Error("release manifest releaseId is unsafe");
  const artifactMap = new Map(verifiedArtifacts.map((artifact) => [artifact.path.replace(/^\/+/, ""), artifact]));
  const entryArtifact = verifiedArtifacts.find((artifact) => artifact.type === "remote-html");
  if (!entryArtifact) throw new Error("verified release entry artifact is missing");
  const adapterArtifact = verifiedArtifacts.find((artifact) => artifact.path.endsWith("doudian-adapter.marketing-pilot.json")) || verifiedArtifacts.find((artifact) => artifact.type === "doudian-adapter");
  const windowCommandsArtifact = verifiedArtifacts.find((artifact) => artifact.type === "doudian-window-commands");
  const configArtifact = verifiedArtifacts.find((artifact) => artifact.path.endsWith("chihu-config.json")) || verifiedArtifacts.find((artifact) => artifact.type === "chihu-config");
  if (!adapterArtifact || !windowCommandsArtifact || !configArtifact) throw new Error("verified release configuration snapshot is incomplete");
  const windowCommands = JSON.parse(windowCommandsArtifact.buffer.toString("utf8"));
  if (windowCommands.schemaVersion !== 1 || windowCommands.adapterSha256 !== adapterArtifact.sha256 || !windowCommands.commands) {
    throw new Error("verified window command snapshot does not match the adapter");
  }
  const manifestSha256 = sha256(manifestBuffer);
  const existingRelease = verifiedReleases.get(releaseId);
  if (existingRelease && existingRelease.manifestSha256 !== manifestSha256) {
    throw new Error(`releaseId ${releaseId} is already bound to a different verified manifest`);
  }
  const cacheRoot = await persistVerifiedRelease(options.cacheRoot, releaseId, verifiedArtifacts);
  const verifiedRelease = {
    releaseId,
    manifestSha256,
    manifestUrl,
    entryUrl: verifiedReleaseEntryUrl(releaseId, entryArtifact.path),
    adapterSnapshotHash: sha256(Buffer.concat([adapterArtifact.buffer, windowCommandsArtifact.buffer])),
    adapter: JSON.parse(adapterArtifact.buffer.toString("utf8")),
    windowCommands,
    config: JSON.parse(configArtifact.buffer.toString("utf8")),
    artifactMap,
    cacheRoot
  };
  verifiedReleases.set(releaseId, verifiedRelease);
  currentVerifiedRelease = verifiedRelease;

  return {
    ok: true,
    skipped: false,
    entryUrl,
    manifestUrl,
    releaseId,
    verifiedEntryUrl: currentVerifiedRelease.entryUrl,
    signature,
    artifactCount: verifiedArtifacts.length,
    totalBytes: verifiedArtifacts.reduce((sum, item) => sum + item.bytes, 0),
    artifacts: verifiedArtifacts.map(({ buffer, ...artifact }) => artifact)
  };
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function remoteIntegrityErrorDataUrl(entryUrl, error) {
  const message = error && error.message ? error.message : String(error || "unknown error");
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>远程资源校验失败</title>
    <style>
      body{margin:0;font-family:"Microsoft YaHei",Arial,sans-serif;background:#f5f7fb;color:#101828}
      main{min-height:100vh;display:grid;place-items:center;padding:32px}
      section{width:min(640px,100%);border:1px solid #d9e2ef;background:#fff;border-radius:10px;padding:28px;box-shadow:0 18px 60px rgba(16,24,40,.12)}
      h1{margin:0 0 10px;font-size:24px;line-height:1.35}
      p{margin:0 0 14px;color:#475467;font-size:14px;line-height:1.7}
      code{display:block;overflow-wrap:anywhere;border:1px solid #e4e7ec;background:#f8fafc;border-radius:8px;padding:10px 12px;color:#344054}
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>远程资源校验失败</h1>
        <p>客户端已停止加载远程页面，防止发布包被篡改或网络缓存异常。</p>
        <p>请检查网络后重启软件；如果仍然出现，请更新客户端或联系管理员。</p>
        <code>${escapeHtml(message)}</code>
        <p style="margin-top:14px">入口地址：${escapeHtml(entryUrl)}</p>
      </section>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = {
  VERIFIED_RELEASE_SCHEME,
  getVerifiedReleaseSnapshot,
  installVerifiedReleaseProtocol,
  registerVerifiedReleaseScheme,
  shouldVerifyRemoteUrl,
  manifestUrlForEntry,
  parseVerifiedReleaseUrl,
  verifyRemoteWebEntry,
  verifiedReleaseEntryUrl,
  remoteIntegrityErrorDataUrl
};
