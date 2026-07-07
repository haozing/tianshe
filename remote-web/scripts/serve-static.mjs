import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { storeDiagnosticUpload } from "./diagnostic-upload-store.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const defaultRoot = resolve(__dirname, "..");
const root = process.env.REMOTE_WEB_SERVE_ROOT
  ? resolve(process.env.REMOTE_WEB_SERVE_ROOT)
  : defaultRoot;
const port = Number(process.env.PORT || 4173);
const manifestPath = process.env.REMOTE_RELEASE_MANIFEST
  ? resolve(process.env.REMOTE_RELEASE_MANIFEST)
  : join(defaultRoot, "new-remote-web", "release-manifest.json");
const packageManifestPath = process.env.REMOTE_RELEASE_PACKAGE_MANIFEST
  ? resolve(process.env.REMOTE_RELEASE_PACKAGE_MANIFEST)
  : "";
const deployConfigPath = process.env.REMOTE_DEPLOY_CONFIG
  ? resolve(process.env.REMOTE_DEPLOY_CONFIG)
  : join(defaultRoot, "deploy", "environments", "local.json");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const releaseManifest = readJsonSafe(manifestPath);
const packageManifest = packageManifestPath ? readJsonSafe(packageManifestPath) : null;
const deployConfig = readJsonSafe(deployConfigPath);
const artifactByPath = new Map();
for (const artifact of ((releaseManifest && releaseManifest.artifacts) || [])) {
  artifactByPath.set(normalize(artifact.path).replace(/\\/g, "/"), artifact);
}
for (const artifact of ((packageManifest && packageManifest.artifacts) || [])) {
  if (artifact.deployArtifactPath) {
    artifactByPath.set(normalize(artifact.deployArtifactPath).replace(/\\/g, "/"), artifact);
  }
}
const cacheRuleByType = new Map();
for (const rule of ((deployConfig && deployConfig.cdn && deployConfig.cdn.rules) || [])) {
  for (const type of rule.appliesTo || []) {
    cacheRuleByType.set(type, rule);
  }
}

function cacheControlForFile(filePath) {
  const artifactPath = relative(root, filePath).replace(/\\/g, "/");
  const artifact = artifactByPath.get(artifactPath);
  if (!artifact) return "no-store";
  const rule = cacheRuleByType.get(artifact.type);
  return rule && rule.headers && rule.headers.cacheControl || "no-store";
}

async function readLimitedBody(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function resolveRequestPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded.replace(/^\/+/, "");
  if (relative.startsWith("__chihu-artifacts/")) {
    const artifactRelative = relative.replace(/^__chihu-artifacts\/+/, "");
    const artifactPath = normalize(join(defaultRoot, "artifacts", artifactRelative));
    if (!artifactPath.startsWith(join(defaultRoot, "artifacts"))) {
      return null;
    }
    return artifactPath;
  }
  const requested = normalize(join(root, relative));

  if (!requested.startsWith(root)) {
    return null;
  }

  if (existsSync(requested) && statSync(requested).isDirectory()) {
    return join(requested, "index.html");
  }

  return requested;
}

createServer(async (req, res) => {
  if (!req.url) {
    send(res, 400, "Bad request");
    return;
  }

  if (req.method === "OPTIONS" && req.url.startsWith("/__chihu-smoke-upload")) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Chihu-Package-Type, X-Chihu-Upload-Source",
      "Cache-Control": "no-store"
    });
    res.end();
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/__chihu-smoke-upload")) {
    try {
      const body = await readLimitedBody(req);
      const payload = JSON.parse(body);
      const stored = storeDiagnosticUpload(payload, {
        bodyText: body,
        headers: req.headers
      });
      sendJson(res, 200, {
        ok: stored.ok,
        smoke: true,
        itemId: payload.itemId || "",
        type: payload.type || req.headers["x-chihu-package-type"] || "",
        digest: payload.payloadDigest || "",
        bytes: body.length,
        redacted: stored.record.redacted,
        inboxFile: relative(root, stored.filePath).replace(/\\/g, "/"),
        issueCount: stored.record.validation.issues.length,
        warningCount: stored.record.validation.warnings.length
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        smoke: true,
        message: error && error.message ? error.message : String(error)
      });
    }
    return;
  }

  if (req.url === "/") {
    res.writeHead(302, { Location: "/new-remote-web/" });
    res.end();
    return;
  }

  const filePath = resolveRequestPath(req.url);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    send(res, 404, "Not found");
    return;
  }

  const type = contentTypes[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": cacheControlForFile(filePath)
  });
  createReadStream(filePath).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`Serving ${root} at http://chihu-remote.localhost:${port}/`);
});
