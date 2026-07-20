const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const path = require("node:path");

const {
  APP_NAME,
  APP_TITLE,
  APP_WINDOW,
  DATA_EPOCH,
  DEFAULT_PARTITION,
  HOME_INDEX_URL,
  HOME_PRELOAD,
  ICON_PATH
} = require("./config");
const { addDevShortcuts } = require("./utils/dev-shortcuts");
const { installSchemeBlocker } = require("./window/scheme-blocker");
const { installSmokeCheck } = require("./smoke/install-smoke-check");
const { registerIpcHandlers } = require("./ipc");
const { installLicenseIpcGuard } = require("./license/ipc-guard");
const { stopNativeDataService } = require("./database");
const {
  installVerifiedReleaseProtocol,
  registerVerifiedReleaseScheme,
  verifyRemoteWebEntry,
  remoteIntegrityErrorDataUrl
} = require("./security/remote-web-integrity");
const { registerWebContentsPrincipal, revokeWebContentsPrincipal } = require("./security/web-contents-principal");

app.commandLine.appendSwitch("ignore-certificate-errors", "true");
if (process.env.CHIHU_ENABLE_GPU === "1") {
  app.commandLine.appendSwitch("ignore-gpu-blacklist");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
} else {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer", "false");
}
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
app.setName(APP_NAME);

if (process.env.CHIHU_USER_DATA_DIR) {
  app.setPath("userData", process.env.CHIHU_USER_DATA_DIR);
} else {
  app.setPath("userData", path.join(app.getPath("userData"), DATA_EPOCH));
}

let mainWindow = null;

function getMainWindow() {
  return mainWindow;
}

async function loadHomeUrl(window, url) {
  try {
    const integrity = await verifyRemoteWebEntry(url, {
      cacheRoot: path.join(app.getPath("userData"), "verified-releases")
    });
    if (integrity && !integrity.skipped) {
      console.log(`[remote-web] verified ${integrity.releaseId} ${integrity.artifactCount} artifacts ${integrity.totalBytes} bytes`);
    }
    const targetUrl = integrity.verifiedEntryUrl || url;
    if (integrity.skipped) {
      const target = new URL(targetUrl);
      const hostname = target.hostname.toLowerCase();
      const localDevelopmentEntry = app.isPackaged === false &&
        ["http:", "https:"].includes(target.protocol) &&
        (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost"));
      if (!localDevelopmentEntry) throw new Error("unverified main window entry is not allowed");
    }
    registerWebContentsPrincipal(window.webContents, {
      role: "main",
      expectedUrl: targetUrl,
      releaseId: integrity.releaseId || "development"
    });
    return window.loadURL(targetUrl);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`[remote-web] integrity check failed: ${message}`);
    revokeWebContentsPrincipal(window.webContents, "integrity_failure");
    return window.loadURL(remoteIntegrityErrorDataUrl(url, error));
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: APP_WINDOW.defaultWidth,
    height: APP_WINDOW.defaultHeight,
    minWidth: APP_WINDOW.minWidth,
    minHeight: APP_WINDOW.minHeight,
    frame: process.env.CHIHU_FRAME === "1",
    resizable: APP_WINDOW.resizable,
    title: APP_TITLE,
    icon: ICON_PATH,
    webPreferences: {
      preload: HOME_PRELOAD,
      partition: DEFAULT_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: false
    }
  });

  global.mainWindow = mainWindow;
  mainWindow.setMenu(null);
  addDevShortcuts(mainWindow);

  mainWindow.on("closed", () => {
    mainWindow = null;
    global.mainWindow = null;
  });
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(APP_TITLE);
    }
  });

  installSmokeCheck(mainWindow);
  loadHomeUrl(mainWindow, HOME_INDEX_URL).catch((error) => {
    console.error("[remote-web] load failed:", error && error.message ? error.message : error);
  });
  return mainWindow;
}

function registerMainWindowHandlers() {
  function getWindowByOptionalId(winId) {
    const id = Number(winId);
    if (Number.isInteger(id) && id > 0) {
      return BrowserWindow.fromId(id) || getMainWindow();
    }
    return getMainWindow();
  }

  ipcMain.handle("getMainWindowInfo", async () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    return {
      winId: win.id,
      title: win.getTitle(),
      winBounds: win.getBounds(),
      minSize: win.getMinimumSize(),
      windowConfig: APP_WINDOW,
      isMaximized: win.isMaximized(),
      isMinimized: win.isMinimized(),
      isFullScreen: win.isFullScreen(),
      isFocused: win.isFocused(),
      isDestroyed: win.isDestroyed(),
      isClosable: win.isClosable(),
      isModal: win.isModal(),
      isMovable: win.isMovable(),
      isResizable: win.isResizable(),
      isAlwaysOnTop: win.isAlwaysOnTop(),
      isFullScreenable: win.isFullScreenable(),
      isSimpleFullScreen: win.isSimpleFullScreen(),
      isKiosk: win.isKiosk(),
      isDocumentEdited: win.isDocumentEdited(),
      isMenuBarAutoHide: win.isMenuBarAutoHide(),
      isMenuBarVisible: win.isMenuBarVisible()
    };
  });

  ipcMain.handle("reloadHomeUrl", async (_event, args = {}) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;

    if (args.isDev && args.file) {
      return win.loadFile(path.resolve(args.file));
    }

    return loadHomeUrl(win, args.url || HOME_INDEX_URL);
  });

  ipcMain.handle("resetMainWindow", async (_event, args = {}) => {
    const nextWindow = BrowserWindow.fromId(args.winId);
    if (!nextWindow) return { error: "找不到窗口" };
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.id !== nextWindow.id) {
      mainWindow.close();
      mainWindow.destroy();
    }
    mainWindow = nextWindow;
    global.mainWindow = mainWindow;
    return { ok: true, winId: mainWindow.id };
  });

  ipcMain.handle("minimizeWindow", async (_event, args = {}) => {
    const win = getWindowByOptionalId(args.winId);
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.handle("maximizeWindow", async (_event, args = {}) => {
    const win = getWindowByOptionalId(args.winId);
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle("closeWindow", async (_event, args = {}) => {
    const win = getWindowByOptionalId(args.winId || args.closeId);
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.handle("isWindowMaximized", async (_event, args = {}) => {
    const win = getWindowByOptionalId(args.winId);
    return win && !win.isDestroyed() ? win.isMaximized() : false;
  });

  ipcMain.handle("isWindowDestroyed", async (_event, args = {}) => {
    const win = BrowserWindow.fromId(args.winId);
    return !win || win.isDestroyed();
  });
}

registerVerifiedReleaseScheme(protocol);
installSchemeBlocker(app, protocol);

if (process.platform === "win32") {
  app.setAppUserModelId(APP_TITLE);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.error(`[startup] ${APP_TITLE} is already running. Close the existing Electron window or stop the stale electron.exe process, then run npm run dev again.`);
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized() || !mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    installVerifiedReleaseProtocol(protocol);
    installLicenseIpcGuard();
    registerMainWindowHandlers();
    registerIpcHandlers({ getMainWindow });
    createMainWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopNativeDataService().catch((error) => {
    console.warn("[native-data] stop failed:", error && error.message ? error.message : error);
  });
});

