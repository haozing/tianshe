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

const pendingLogLines = new Map();
let logFlushTimer = null;
let logWriteQueue = Promise.resolve();

function flushPendingLogs() {
  logFlushTimer = null;
  const batches = [...pendingLogLines.entries()];
  pendingLogLines.clear();
  if (!batches.length) return;
  logWriteQueue = logWriteQueue.then(async () => {
    for (const [file, lines] of batches) await fs.promises.appendFile(file, lines.join(""), "utf8");
  }).catch((error) => {
    console.error("[logs] append failed", error);
  });
}

function writeLog(tag, payload) {
  const line = `[${new Date().toISOString()}] [${tag}] ${safeJson(payload)}\n`;
  const file = getLogFile();
  const lines = pendingLogLines.get(file) || [];
  lines.push(line);
  pendingLogLines.set(file, lines);
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushPendingLogs, 40);
    logFlushTimer.unref?.();
  }
}

function rendererLogPayload(event, payload) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return {
    ...(payload && typeof payload === "object" ? payload : { rawPayload: payload }),
    browserWindowId: win ? win.id : null,
    senderUrl: event.sender.getURL()
  };
}

async function drainLogWrites() {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    flushPendingLogs();
  }
  await logWriteQueue;
}

async function cleanupOldCrashLogs(keepToday = true) {
  await drainLogWrites();
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
    writeLog("RENDERER", rendererLogPayload(event, payload));
    return { ok: true, logDir: getLogDir() };
  });

  ipcMain.handle("getCrashLogDir", async () => getLogDir());
  ipcMain.handle("cleanupOldCrashLogs", async (_event, payload) => {
    return await cleanupOldCrashLogs(payload);
  });
  ipcMain.handle("native:logs:report", async (event, payload) => {
    writeLog("RENDERER", rendererLogPayload(event, payload));
    return { ok: true, logDir: getLogDir() };
  });
  ipcMain.handle("native:logs:getDir", async () => getLogDir());
  ipcMain.handle("native:logs:clean", async (_event, payload) => {
    return await cleanupOldCrashLogs(payload);
  });
}

module.exports = { registerLogHandlers };
