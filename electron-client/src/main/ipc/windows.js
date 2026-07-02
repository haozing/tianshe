const { app, BrowserWindow, ipcMain, session, screen } = require("electron");
const { APP_TITLE, HOME_PRELOAD, ICON_PATH } = require("../config");
const { addDevShortcuts } = require("../utils/dev-shortcuts");

function registerWindowHandlers() {
  ipcMain.handle("openWindow", async (_event, args = {}) => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const fallbackWidth = Math.round(width * 0.8);
    const fallbackHeight = Math.round(height * 0.8);

    const preload = args.preload || HOME_PRELOAD;
    let params = {
      width: args.width || fallbackWidth,
      height: args.height || fallbackHeight,
      show: !args.isNotShow,
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
        nodeIntegration: args.nodeIntegration !== undefined ? args.nodeIntegration : true,
        contextIsolation: args.contextIsolation !== undefined ? args.contextIsolation : true,
        webSecurity: args.webSecurity !== undefined ? args.webSecurity : false,
        allowRunningInsecureContent: args.allowRunningInsecureContent || false,
        spellcheck: args.spellcheck || false,
        enableRemoteModule: args.enableRemoteModule || false,
        devTools: args.devTools || false,
        webviewTag: args.webviewTag || false,
        enableBlinkFeatures: args.enableBlinkFeatures || "",
        hardwareAcceleration: args.hardwareAcceleration !== undefined ? args.hardwareAcceleration : true,
        sandbox: args.sandbox || false
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

    if (args.userAgent) {
      child.webContents.setUserAgent(String(args.userAgent));
    }
    if (args.setupRequestInterceptorInfo) {
      setupRequestInterceptor(child, args.setupRequestInterceptorInfo);
    }

    await child.loadURL(args.url);
    if (params.webPreferences && params.webPreferences.devTools) child.webContents.openDevTools();
    if (!args.isNotShow) child.show();
    addDevShortcuts(child);

    return child.id;
  });

  ipcMain.handle("executeJavaScriptBrowserWindow", async (_event, args = {}) => {
    try {
      const win = BrowserWindow.fromId(args.winId);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;

      const timeoutMs = args.timeoutMs ?? 15000;
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("executeJavaScript timeout due to window destruction")), timeoutMs);
      });
      return await Promise.race([
        win.webContents.executeJavaScript(args.jsContent),
        timeout
      ]);
    } catch (error) {
      console.error("executeJavaScriptBrowserWindow failed:", error);
      return null;
    }
  });

  ipcMain.handle("destroyBrowserWindow", async (_event, args = {}) => {
    const win = BrowserWindow.fromId(args.winId);
    if (win && !win.isDestroyed()) win.destroy();
  });

  ipcMain.handle("getBrowserWindowInfo", async (_event, args = {}) => {
    const win = BrowserWindow.fromId(args.winId);
    if (!win || win.isDestroyed()) return null;
    return { currentUrl: win.webContents.getURL() };
  });

  ipcMain.handle("editBrowserWindow", async (_event, args = {}) => {
    const win = BrowserWindow.fromId(args.winId);
    if (!win || win.isDestroyed()) return null;

    if (args.newUrl) return win.loadURL(args.newUrl);
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
    if (args.webPreferences && args.webPreferences.devTools !== undefined) {
      if (args.webPreferences.devTools) win.webContents.openDevTools();
      else win.webContents.closeDevTools();
    }
    return args.winId;
  });

  ipcMain.handle("getAllBrowserWindowInfos", async () => {
    return BrowserWindow.getAllWindows().map((win) => ({
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

