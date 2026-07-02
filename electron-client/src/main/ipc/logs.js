const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { safeJson } = require("../utils/redaction");

function getLogDir() {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getLogFile() {
  return path.join(getLogDir(), `crash-${dayString()}.log`);
}

function writeLog(tag, payload) {
  const line = `[${new Date().toISOString()}] [${tag}] ${safeJson(payload)}\n`;
  fs.appendFileSync(getLogFile(), line, "utf8");
}

function cleanupOldCrashLogs(keepToday = true) {
  const dir = getLogDir();
  const keepName = keepToday ? `crash-${dayString()}.log` : "";
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^crash-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    if (keepToday && name === keepName) continue;
    fs.unlinkSync(path.join(dir, name));
    removed++;
  }
  return { removed, logDir: dir };
}

function registerLogHandlers() {
  ipcMain.handle("reportClientLog", async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    writeLog("RENDERER", {
      ...(payload && typeof payload === "object" ? payload : { rawPayload: payload }),
      browserWindowId: win ? win.id : null,
      url: event.sender.getURL()
    });
    return { ok: true, logDir: getLogDir() };
  });

  ipcMain.handle("getCrashLogDir", async () => getLogDir());
  ipcMain.handle("cleanupOldCrashLogs", async (_event, payload) => {
    return cleanupOldCrashLogs(payload);
  });
}

module.exports = { registerLogHandlers };

