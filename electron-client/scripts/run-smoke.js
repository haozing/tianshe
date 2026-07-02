const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const electronBin = require("electron");
const scenario = process.argv[2] || process.env.XZB_E2E_SMOKE_SCENARIO || "bridge";

const binaryBody = "xzb-http-smoke-binary";
const fileDownloadBody = "xzb-file-smoke-download";
const uploadExpectedText = "xzb-file-upload-payload";

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function createHttpSmokeServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (url.pathname === "/json") {
        sendJson(res, 200, {
          ok: true,
          method: req.method,
          query: url.searchParams.get("q"),
          header: req.headers["x-smoke-header"] || null
        });
        return;
      }

      if (url.pathname === "/echo") {
        const bodyText = await readBody(req);
        let parsed = null;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          parsed = null;
        }
        sendJson(res, 200, {
          ok: true,
          method: req.method,
          contentType: req.headers["content-type"] || "",
          header: req.headers["x-smoke-header"] || null,
          bodyText,
          parsed
        });
        return;
      }

      if (url.pathname === "/set-cookie") {
        const name = url.searchParams.get("name") || "xzb_http_smoke";
        const value = url.searchParams.get("value") || "ok";
        sendJson(res, 200, {
          ok: true,
          name,
          value
        }, {
          "Set-Cookie": [
            `${name}=${value}; Path=/; Max-Age=3600; HttpOnly`,
            "xzb_http_smoke_extra=extra; Path=/; Max-Age=3600"
          ]
        });
        return;
      }

      if (url.pathname === "/status/418") {
        sendJson(res, 418, {
          ok: false,
          code: "teapot"
        });
        return;
      }

      if (url.pathname === "/binary") {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store"
        });
        res.end(binaryBody);
        return;
      }

      if (url.pathname === "/download") {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store"
        });
        res.end(fileDownloadBody);
        return;
      }

      if (url.pathname === "/slow-download") {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store"
        });
        let sent = 0;
        const timer = setInterval(() => {
          sent++;
          res.write(`chunk-${sent}\n`);
          if (sent >= 100) {
            clearInterval(timer);
            res.end();
          }
        }, 50);
        req.on("close", () => clearInterval(timer));
        return;
      }

      if (url.pathname === "/upload") {
        const bodyText = await readBody(req);
        sendJson(res, 200, {
          ok: true,
          contentType: req.headers["content-type"] || "",
          hasFile: bodyText.includes(uploadExpectedText),
          hasMeta: bodyText.includes("file-smoke-meta")
        });
        return;
      }

      if (url.pathname === "/read-file") {
        const target = url.searchParams.get("path") || "";
        try {
          sendJson(res, 200, {
            ok: true,
            text: fs.readFileSync(target, "utf8"),
            exists: true
          });
        } catch (error) {
          sendJson(res, 404, {
            ok: false,
            exists: false,
            message: error.message
          });
        }
        return;
      }

      sendJson(res, 404, { ok: false, code: "not_found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    expectedBase64: Buffer.from(binaryBody).toString("base64")
  };
}

async function main() {
  const httpSmoke = ["http", "files"].includes(scenario) ? await createHttpSmokeServer() : null;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `xzb-electron-smoke-${scenario}-`));
  const env = {
    ...process.env,
    XZB_E2E_SMOKE: "1",
    XZB_E2E_SMOKE_SCENARIO: scenario,
    XZB_USER_DATA_DIR: userDataDir,
    XZB_HOME_URL: process.env.XZB_HOME_URL || "http://127.0.0.1:4173/old-entry/"
  };

  if (httpSmoke) {
    env.XZB_E2E_HTTP_BASE_URL = httpSmoke.baseUrl;
    env.XZB_E2E_HTTP_EXPECTED_BASE64 = httpSmoke.expectedBase64;
    env.XZB_E2E_FILE_DOWNLOAD_BODY = fileDownloadBody;
    env.XZB_E2E_UPLOAD_TEXT = uploadExpectedText;
  }

  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBin, ["."], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let output = "";
  const cleanup = () => {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  };

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  let exited = false;
  const finish = (code) => {
    if (exited) return;
    exited = true;

    const complete = () => {
      const match = output.match(/ELECTRON_SMOKE_RESULT (\{.*\})/);
      if (!match) {
        console.error("ELECTRON_SMOKE_MISSING_RESULT");
        cleanup();
        process.exit(code || 1);
        return;
      }

      const result = JSON.parse(match[1]);
      if (!result.ok) {
        console.error(`ELECTRON_SMOKE_FAIL scenario=${scenario}`);
        cleanup();
        process.exit(1);
        return;
      }

      console.log(`ELECTRON_SMOKE_OK scenario=${scenario}`);
      cleanup();
      process.exit(0);
    };

    if (httpSmoke) {
      httpSmoke.server.close(complete);
      return;
    }

    complete();
  };

  child.on("error", (error) => {
    console.error(error);
    finish(1);
  });

  child.on("exit", finish);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
