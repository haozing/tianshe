const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { net } = require("electron");

const PUBLIC_KEY_PATH = path.join(__dirname, "remote-web-public-key.pem");
const DEFAULT_TIMEOUT_MS = Number(process.env.CHIHU_REMOTE_INTEGRITY_TIMEOUT_MS || 15000);
const DEFAULT_MAX_ARTIFACT_BYTES = Number(process.env.CHIHU_REMOTE_INTEGRITY_MAX_ARTIFACT_BYTES || 20 * 1024 * 1024);

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
    sha256: actual
  };
}

async function verifyRemoteWebEntry(entryUrl) {
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

  return {
    ok: true,
    skipped: false,
    entryUrl,
    manifestUrl,
    releaseId: manifest.releaseId || "",
    signature,
    artifactCount: verifiedArtifacts.length,
    totalBytes: verifiedArtifacts.reduce((sum, item) => sum + item.bytes, 0),
    artifacts: verifiedArtifacts
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
  shouldVerifyRemoteUrl,
  manifestUrlForEntry,
  verifyRemoteWebEntry,
  remoteIntegrityErrorDataUrl
};
