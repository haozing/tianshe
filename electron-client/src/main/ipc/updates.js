const { app, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

let autoUpdater = null;
let isCheckingUpdate = false;

function getAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    autoUpdater = require("electron-updater").autoUpdater;
  } catch (error) {
    console.warn("[updates] electron-updater unavailable:", error.message);
    autoUpdater = null;
  }
  return autoUpdater;
}

function cleanupUpdateListeners(updater) {
  if (!updater) return;
  isCheckingUpdate = false;
  updater.removeAllListeners("update-available");
  updater.removeAllListeners("download-progress");
  updater.removeAllListeners("update-not-available");
  updater.removeAllListeners("update-downloaded");
  updater.removeAllListeners("error");
}

function emitToMain(context, channel, payload) {
  const win = context.getMainWindow && context.getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function configureUpdater(updater) {
  updater.channel = process.env.CHIHU_UPDATE_CHANNEL || "latest";

  const useDevUpdateConfig =
    process.env.NODE_ENV === "development" ||
    !app.isPackaged ||
    Boolean(process.env.CHIHU_DEV_UPDATE_CONFIG);
  updater.forceDevUpdateConfig = useDevUpdateConfig;

  if (useDevUpdateConfig) {
    const configPath = process.env.CHIHU_DEV_UPDATE_CONFIG || path.join(__dirname, "..", "dev-update-config.json");
    if (fs.existsSync(configPath)) {
      updater.updateConfigPath = configPath;
    }
  }
}

function normalizeUpdateInfo(updater, updateInfo) {
  const currentVersion = updater && updater.currentVersion && updater.currentVersion.version
    ? updater.currentVersion.version
    : app.getVersion();
  const latestVersion = updateInfo && updateInfo.version ? updateInfo.version : currentVersion;
  const hasUpdate = updater && updater.currentVersion && typeof updater.currentVersion.compare === "function"
    ? updater.currentVersion.compare(latestVersion) < 0
    : latestVersion !== currentVersion;

  return {
    ok: true,
    status: hasUpdate ? "available" : "not-available",
    hasUpdate,
    isNewVersion: !hasUpdate,
    currentVersion,
    latestVersion,
    newVersion: latestVersion,
    releaseDate: updateInfo && updateInfo.releaseDate || "",
    releaseName: updateInfo && updateInfo.releaseName || "",
    releaseNotes: updateInfo && updateInfo.releaseNotes || ""
  };
}

async function startAutoUpdate(context, args = {}) {
  const updater = getAutoUpdater();
  if (!updater) {
    return { ok: false, reason: "electron_updater_unavailable" };
  }
  if (isCheckingUpdate) {
    return { ok: true, skipped: true, reason: "already_checking" };
  }

  isCheckingUpdate = true;
  updater.autoDownload = false;
  configureUpdater(updater);

  updater.once("update-available", (info) => {
    emitToMain(context, "update-available", info);
    if (args.autoDownload) {
      updater.downloadUpdate().catch((error) => {
        emitToMain(context, "update-error", `更新下载失败: ${error.message}`);
        cleanupUpdateListeners(updater);
      });
    } else {
      cleanupUpdateListeners(updater);
    }
  });

  updater.on("download-progress", (progress) => {
    emitToMain(context, "download-progress", progress.percent);
  });

  updater.once("update-not-available", () => {
    emitToMain(context, "update-not-available", "当前已是最新版本，没有可用更新");
    cleanupUpdateListeners(updater);
  });

  updater.once("update-downloaded", (info) => {
    emitToMain(context, "update-downloaded", info);
    if (args.quitAndInstall) {
      cleanupUpdateListeners(updater);
      updater.quitAndInstall();
    } else {
      cleanupUpdateListeners(updater);
    }
  });

  updater.once("error", (error) => {
    emitToMain(context, "update-error", `更新过程中出现错误: ${error.message}`);
    cleanupUpdateListeners(updater);
  });

  try {
    await updater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    cleanupUpdateListeners(updater);
    return { ok: false, message: error.message };
  }
}

async function getClientVersionData() {
  const updater = getAutoUpdater();
  if (!updater) {
    return {
      ok: false,
      status: "unavailable",
      reason: "electron_updater_unavailable",
      hasUpdate: false,
      isNewVersion: true,
      currentVersion: app.getVersion(),
      latestVersion: app.getVersion(),
      newVersion: app.getVersion()
    };
  }

  try {
    updater.autoDownload = false;
    configureUpdater(updater);
    const result = await updater.checkForUpdates();
    return normalizeUpdateInfo(updater, result && result.updateInfo);
  } catch (error) {
    return {
      ok: false,
      status: "error",
      hasUpdate: false,
      isNewVersion: true,
      currentVersion: app.getVersion(),
      latestVersion: app.getVersion(),
      newVersion: app.getVersion(),
      error: error.message
    };
  }
}

function registerUpdateHandlers(context) {
  ipcMain.handle("startAutoUpdate", async (_event, args = {}) => {
    return startAutoUpdate(context, args);
  });

  ipcMain.handle("getClientVersionData", async () => {
    return getClientVersionData();
  });

  ipcMain.handle("native:updates:start", async (_event, args = {}) => {
    return startAutoUpdate(context, args);
  });

  ipcMain.handle("native:updates:getVersionData", async () => {
    return getClientVersionData();
  });
}

module.exports = { registerUpdateHandlers };
