const { ipcMain } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

let enumsPddDownloadPromise = null;
let startEnumsPddPromise = null;
let cancelEnumsPddFlag = false;

function isProcessRunning(keywords = [], failOpen = true) {
  return new Promise((resolve) => {
    if (!keywords.length) return resolve(false);
    execFile(
      "tasklist",
      ["/NH", "/FO", "CSV"],
      { windowsHide: true, timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(failOpen);
        const lower = stdout.toLowerCase();
        resolve(keywords.some((keyword) => lower.includes(String(keyword).toLowerCase())));
      }
    );
  });
}

function downloadFile(url, destPath, redirectCount = 0, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("下载重定向次数过多"));

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.downloading`;
    const file = fs.createWriteStream(tmpPath);

    const cleanup = () => {
      try { file.close(); } catch {}
      try { fs.unlinkSync(tmpPath); } catch {}
    };

    const req = https.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        cleanup();
        const nextUrl = new URL(res.headers.location, url).href;
        return downloadFile(nextUrl, destPath, redirectCount + 1, timeoutMs).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        cleanup();
        return reject(new Error(`下载失败: HTTP ${res.statusCode}`));
      }

      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          try {
            fs.renameSync(tmpPath, destPath);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      res.on("error", (error) => {
        cleanup();
        reject(error);
      });
    });

    req.on("error", (error) => {
      cleanup();
      reject(error);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      cleanup();
      reject(new Error(`下载超时（${timeoutMs / 1000}s），请检查网络`));
    });
  });
}

function prepareExeFromCache(cachePath) {
  const exePath = path.join(os.tmpdir(), `EnumsPdd-${process.pid}.exe`);
  if (
    fs.existsSync(exePath) &&
    fs.existsSync(cachePath) &&
    fs.statSync(exePath).size === fs.statSync(cachePath).size
  ) {
    return exePath;
  }
  fs.copyFileSync(cachePath, exePath);
  return exePath;
}

async function ensureEnumsPdd(url, cachePath, timeoutMs = 30000) {
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
    return prepareExeFromCache(cachePath);
  }

  if (enumsPddDownloadPromise) return enumsPddDownloadPromise;

  enumsPddDownloadPromise = (async () => {
    try {
      await downloadFile(url, cachePath, 0, timeoutMs);
      if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
        return prepareExeFromCache(cachePath);
      }
      return null;
    } catch (error) {
      console.error("[PDD] EnumsPdd download failed:", error.message);
      return null;
    } finally {
      enumsPddDownloadPromise = null;
    }
  })();

  return enumsPddDownloadPromise;
}

function runAsAdmin(exePath, tempPath) {
  return new Promise((resolve) => {
    const script = `Start-Process -FilePath '${exePath.replace(/'/g, "''")}' -ArgumentList '${tempPath.replace(/'/g, "''")}' -Verb RunAs`;
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true }, (error) => {
      if (error) console.error("[PDD] PowerShell start failed:", error.message);
      resolve();
    });
  });
}

function waitForFile(filePath, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cancelEnumsPddFlag) return reject(new Error("CANCELLED"));
      if (fs.existsSync(filePath)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("等待 EnumsPdd 写入结果超时"));
      setTimeout(tick, 500);
    };
    tick();
  });
}

function parsePassIds(content) {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    if (parsed) return [String(parsed)];
  } catch {
    if (content && content.trim()) return [content.trim()];
  }
  return [];
}

async function startEnumsPdd(message = {}) {
  const { url, cachePath, workbenchKeywords, downloadTimeout, waitTimeout } = message;
  if (!url || !cachePath) {
    return { success: false, reason: "invalid_params", message: "缺少 url 或 cachePath 参数" };
  }

  if (startEnumsPddPromise) return startEnumsPddPromise;

  startEnumsPddPromise = (async () => {
    cancelEnumsPddFlag = false;
    let tempPath = "";

    try {
      const running = await isProcessRunning(workbenchKeywords || []);
      if (!running) {
        return { success: false, reason: "workbench_not_running", message: "请打开拼多多工作台" };
      }

      const exePath = await ensureEnumsPdd(url, cachePath, downloadTimeout);
      if (!exePath) {
        return { success: false, reason: "not_found", message: "EnumsPdd.exe 获取失败，请检查网络" };
      }

      tempPath = path.join(os.tmpdir(), `workbench-${Date.now()}.tmp`);
      await runAsAdmin(exePath, tempPath);
      await waitForFile(tempPath, waitTimeout || 120000);

      const passIds = parsePassIds(fs.readFileSync(tempPath, "utf8"));
      if (!passIds.length) {
        return { success: false, reason: "no_passid", message: "未读取到 PASS_ID，请确认拼多多工作台已登录" };
      }

      return {
        success: true,
        auth: {
          username: null,
          password: null,
          passId: passIds.join(",")
        },
        passIds
      };
    } catch (error) {
      if (error.message === "CANCELLED") {
        return { success: false, reason: "cancelled", message: "已取消" };
      }
      return {
        success: false,
        reason: "exception",
        message: error.message || "工作台导入失败"
      };
    } finally {
      if (tempPath) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      startEnumsPddPromise = null;
    }
  })();

  return startEnumsPddPromise;
}

function registerPddHandlers() {
  ipcMain.handle("checkProcessRunning", async (_event, keywords) => {
    return isProcessRunning(keywords);
  });

  ipcMain.handle("cancelEnumsPdd", async () => {
    cancelEnumsPddFlag = true;
    execFile("taskkill", ["/F", "/IM", "EnumsPdd*.exe", "/T"], { windowsHide: true }, () => {});
    return { success: true };
  });

  ipcMain.handle("startEnumsPdd", async (_event, message) => startEnumsPdd(message));
}

module.exports = { registerPddHandlers };
