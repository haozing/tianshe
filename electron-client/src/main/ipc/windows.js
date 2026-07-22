const { app, BrowserWindow, ipcMain, session, screen } = require("electron");
const { APP_TITLE, HOME_PRELOAD, ICON_PATH } = require("../config");
const { addDevShortcuts } = require("../utils/dev-shortcuts");
const { registerWebContentsPrincipal } = require("../security/web-contents-principal");
const { markRunnerWindowProgrammaticClose, registerTaskChildWindow, runnerOwnsWindow, runnerWindowCommand, taskChildTarget } = require("../tasks/task-manager");
const { lockBrowserWindowTitle } = require("../window/window-title");

const ENABLE_GPU = process.env.CHIHU_ENABLE_GPU === "1";

function registerWindowHandlers() {
  const openWindow = async (event, args = {}) => {
    if (args.windowParams) throw new Error("windowParams are not accepted by the controlled window boundary");
    const runnerTarget = taskChildTarget(event, args.url, args.partition);
    if (runnerTarget && !args.partition) throw new Error("runner platform windows require an authorized partition");
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const defaultWidth = Math.round(width * 0.8);
    const defaultHeight = Math.round(height * 0.8);

    const preload = !app.isPackaged && args.preload ? args.preload : undefined;
    let params = {
      width: args.width || defaultWidth,
      height: args.height || defaultHeight,
      show: args.show !== undefined ? !!args.show : !args.isNotShow,
      fullscreen: args.fullscreen,
      frame: args.frame !== undefined ? args.frame : true,
      resizable: args.resizable !== undefined ? args.resizable : true,
      transparent: args.transparent,
      minimizable: args.minimizable !== undefined ? args.minimizable : true,
      alwaysOnTop: args.alwaysOnTop || false,
      maximizable: args.maximizable !== undefined ? args.maximizable : true,
      title: args.title || APP_TITLE,
      x: args.x,
      y: args.y,
      center: args.center || false,
      icon: args.icon || ICON_PATH,
      backgroundColor: args.backgroundColor || "#ffffff",
      modal: args.modal || false,
      webPreferences: {
        preload,
        partition: args.partition,
        session: args.partition ? session.fromPartition(args.partition) : undefined,
        nodeIntegration: false,
        contextIsolation: args.contextIsolation !== undefined ? args.contextIsolation : true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: args.spellcheck || false,
        enableRemoteModule: args.enableRemoteModule || false,
        devTools: !app.isPackaged && args.devTools === true,
        webviewTag: args.webviewTag || false,
        enableBlinkFeatures: args.enableBlinkFeatures || "",
        hardwareAcceleration: args.hardwareAcceleration !== undefined ? args.hardwareAcceleration : ENABLE_GPU,
        sandbox: true
      }
    };

    if (args.windowParams) {
      params = args.windowParams;
      params.icon = params.icon || ICON_PATH;
      params.title = params.title || APP_TITLE;
      params.webPreferences = params.webPreferences || {};
      if (args.windowParams.needSession && params.webPreferences.partition) {
        params.webPreferences.session = session.fromPartition(params.webPreferences.partition);
      }
      if (args.windowParams.needPreload) {
        params.webPreferences.preload = preload;
      }
    }

    const child = new BrowserWindow(params);
    child.setMenu(null);
    if (args.lockTitle) lockBrowserWindowTitle(child, args.title);
    const taskContext = runnerTarget ? registerTaskChildWindow(event, child, args.url, args.partition) : null;
    if (!taskContext) {
      const target = new URL(args.url);
      registerWebContentsPrincipal(child.webContents, {
        role: "platform-child",
        expectedUrl: target.toString(),
        allowedPlatformOrigins: [target.origin]
      });
    }

    if (args.userAgent) {
      child.webContents.setUserAgent(String(args.userAgent));
    }
    if (args.setupRequestInterceptorInfo) {
      setupRequestInterceptor(child, args.setupRequestInterceptorInfo);
    }

    const loadPromise = child.loadURL(args.url);
    if (args.waitForLoad === false) {
      loadPromise.catch((error) => {
        if (!child.isDestroyed()) console.warn(`[windows] async loadURL failed: ${error.message}`);
      });
      if (params.show) child.show();
      addDevShortcuts(child);
      return child.id;
    }

    await loadPromise;
    if (params.webPreferences && params.webPreferences.devTools) child.webContents.openDevTools();
    if (params.show) child.show();
    addDevShortcuts(child);

    return child.id;
  };

  const commandWindow = async (event, args = {}) => {
    const authorized = runnerWindowCommand(event, args);
    const win = BrowserWindow.fromId(args.winId);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const destroyed = win.isDestroyed() || win.webContents.isDestroyed();
        const currentUrl = !destroyed ? win.webContents.getURL() : "";
        reject(new Error(destroyed
          ? "window command cancelled because window was destroyed"
          : `window command timeout after ${authorized.timeoutMs}ms (winId=${args.winId}, command=${String(args.command || "")}, url=${currentUrl})`));
      }, authorized.timeoutMs);
    });
    try {
      return await Promise.race([win.webContents.executeJavaScript(authorized.script), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const destroyWindow = async (event, args = {}) => {
    if (!runnerOwnsWindow(event, args.winId)) throw new Error("runner does not own target window");
    const win = BrowserWindow.fromId(args.winId);
    if (win && !win.isDestroyed()) {
      markRunnerWindowProgrammaticClose(event, args.winId);
      win.destroy();
    }
    return { ok: true };
  };

  ipcMain.handle("openWindow", async (event, args = {}) => openWindow(event, args));

  ipcMain.handle("native:windows:open", async (event, args = {}) => openWindow(event, args));

  ipcMain.handle("executeJavaScriptBrowserWindow", async () => {
    throw new Error("arbitrary platform window scripts are disabled");
  });

  ipcMain.handle("native:windows:eval", async () => {
    throw new Error("arbitrary platform window scripts are disabled");
  });

  ipcMain.handle("native:windows:command", async (event, args = {}) => commandWindow(event, args));

  ipcMain.handle("destroyBrowserWindow", async (event, args = {}) => {
    await destroyWindow(event, args);
  });

  ipcMain.handle("native:windows:destroy", async (event, args = {}) => {
    return destroyWindow(event, args);
  });

  ipcMain.handle("getBrowserWindowInfo", async (event, args = {}) => {
    if (!runnerOwnsWindow(event, args.winId)) return null;
    const win = BrowserWindow.fromId(args.winId);
    if (!win || win.isDestroyed()) return null;
    return { currentUrl: win.webContents.getURL() };
  });

  ipcMain.handle("editBrowserWindow", async (event, args = {}) => {
    if (!runnerOwnsWindow(event, args.winId)) return null;
    const win = BrowserWindow.fromId(args.winId);
    if (!win || win.isDestroyed()) return null;

    if (args.newUrl) {
      taskChildTarget(event, args.newUrl);
      return win.loadURL(args.newUrl);
    }
    if (args.width) win.setSize(args.width, win.getSize()[1]);
    if (args.height) win.setSize(win.getSize()[0], args.height);
    if (args.isCenten) win.center();
    if (args.x !== undefined && args.y !== undefined) win.setPosition(args.x, args.y);
    if (args.show !== undefined) args.show ? win.show() : win.hide();
    if (args.fullscreen !== undefined) win.setFullScreen(args.fullscreen);
    if (args.minimize) win.minimize();
    if (args.maximize) win.maximize();
    if (args.restore) win.restore();
    if (args.close) {
      win.close();
      return null;
    }
    if (args.resizable !== undefined) win.setResizable(args.resizable);
    if (args.alwaysOnTop !== undefined) win.setAlwaysOnTop(args.alwaysOnTop);
    if (args.title) win.setTitle(args.title);
    if (args.webPreferences?.devTools === false) win.webContents.closeDevTools();
    return args.winId;
  });

  ipcMain.handle("getAllBrowserWindowInfos", async (event) => {
    return BrowserWindow.getAllWindows().filter((win) => runnerOwnsWindow(event, win.id)).map((win) => ({
      id: win.id,
      title: win.getTitle(),
      url: win.webContents.getURL(),
      partition: win.webContents.session.partition,
      bounds: win.getBounds(),
      isVisible: win.isVisible(),
      isFocused: win.isFocused(),
      isDevToolsOpened: win.webContents.isDevToolsOpened(),
      isDestroyed: win.isDestroyed(),
      isMaximized: win.isMaximized(),
      isMinimized: win.isMinimized(),
      isFullScreen: win.isFullScreen(),
      isModal: win.isModal(),
      isAlwaysOnTop: win.isAlwaysOnTop(),
      isClosable: win.isClosable(),
      isResizable: win.isResizable(),
      isMovable: win.isMovable(),
      isMenuBarAutoHide: win.isMenuBarAutoHide(),
      isMenuBarVisible: win.isMenuBarVisible()
    }));
  });
}

function setupRequestInterceptor(win, info = {}) {
  const ses = win.webContents.session;
  ses.webRequest.onBeforeRequest(null);
  ses.webRequest.onBeforeRequest({ urls: info.urls || [] }, (details, callback) => {
    try {
      const url = new URL(details.url);
      const blockedKeywords = info.blockedKeywords || [];
      const blockedRegexes = info.blockedRegexes || [];
      const byKeyword = blockedKeywords.some((keyword) => url.pathname.includes(keyword));
      const byRegex = blockedRegexes.some((pattern) => new RegExp(pattern, "i").test(url.pathname));
      callback({ cancel: byKeyword || byRegex });
    } catch {
      callback({ cancel: false });
    }
  });
}

module.exports = { registerWindowHandlers };
