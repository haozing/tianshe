var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_electron = require("electron");
var import_node_path = __toESM(require("node:path"));
var import_work_server = require("./work-server/index");
var import_config = require("./config");
var import_main_tray = __toESM(require("./main_tray"));
var import_utils = require("./utils");
var import_crash_logger = require("./crash_logger");
import_electron.app.commandLine.appendSwitch("ignore-certificate-errors", "true");
import_electron.app.commandLine.appendSwitch("ignore-gpu-blacklist");
import_electron.app.commandLine.appendSwitch("disable-gpu-sandbox");
import_electron.app.commandLine.appendSwitch("no-sandbox");
import_electron.app.commandLine.appendSwitch("disable-web-security");
import_electron.app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
let mainWindow;
if (process.platform === "win32") {
  import_electron.app.setAppUserModelId(import_config.AppTitle);
}
const BLOCKED_SCHEMES = ["bytedance:", "snssdk:", "bitbrowser:"];
import_electron.protocol.registerSchemesAsPrivileged(
  BLOCKED_SCHEMES.map((s) => ({ scheme: s.replace(":", ""), privileges: { standard: true, secure: true, bypassCSP: false, stream: true, supportFetchAPI: false } }))
);
function isBlockedScheme(url) {
  if (!url || typeof url !== "string") return false;
  const lower = url.toLowerCase().trim();
  for (const scheme of BLOCKED_SCHEMES) {
    if (lower.startsWith(scheme)) return true;
  }
  try {
    const parsed = new URL(url);
    return BLOCKED_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}
import_electron.app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (isBlockedScheme(url)) {
      event.preventDefault();
    }
  });
  try {
    contents.on("will-frame-navigate", (event, url, frame) => {
      if (isBlockedScheme(url)) {
        event.preventDefault();
      }
    });
  } catch (_) {
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (isBlockedScheme(url)) {
      return { action: "deny" };
    }
    return { action: "allow" };
  });
});
function bootstrap() {
  console.log("AppTitle:", import_config.AppTitle);
  mainWindow = new import_electron.BrowserWindow({
    width: 904,
    height: 649,
    maximizable: false,
    frame: false,
    resizable: false,
    // 去掉菜单栏
    title: import_config.AppTitle,
    webPreferences: {
      preload: import_config.HomePreload,
      partition: "persist:myappzzbtool",
      // 设置 DevTools 语言为英文
      // locale: systemLocale,
      // devTools: true,
      // 禁用开发者工具的安全警告
      //  disableDevToolsSecurityWarnings: true,
      nodeIntegration: true,
      // 禁用渲染进程中的 Node.js 集成
      contextIsolation: true
      // 启用上下文隔离 contextBridge 是 Electron 提供的一个用于在预加载脚本和渲染进程之间安全通信的 API，它要求 contextIsolation 必须开启才能正常使用
    },
    icon: import_config.IconPath
  });
  global.mainWindow = mainWindow;
  (0, import_crash_logger.setMainWindowForCrashLog)(mainWindow);
  (0, import_crash_logger.attachWebContentsCrashMonitor)(mainWindow.webContents);
  mainWindow.loadURL(import_config.HomeIndexUrl);
  import_main_tray.default.DelectTray();
  import_main_tray.default.CreateTray(mainWindow);
  (0, import_utils.AddDevShortcuts)(mainWindow);
}
import_electron.ipcMain.handle("getMainWindowInfo", async (event, args) => {
  return {
    winId: mainWindow.id,
    winBounds: mainWindow.getBounds(),
    isMaximized: mainWindow.isMaximized(),
    isMinimized: mainWindow.isMinimized(),
    isFullScreen: mainWindow.isFullScreen(),
    isFocused: mainWindow.isFocused(),
    isDestroyed: mainWindow.isDestroyed(),
    isClosable: mainWindow.isClosable(),
    isModal: mainWindow.isModal(),
    isMovable: mainWindow.isMovable(),
    isResizable: mainWindow.isResizable(),
    isAlwaysOnTop: mainWindow.isAlwaysOnTop(),
    isFullScreenable: mainWindow.isFullScreenable(),
    isSimpleFullScreen: mainWindow.isSimpleFullScreen(),
    isKiosk: mainWindow.isKiosk(),
    isDocumentEdited: mainWindow.isDocumentEdited(),
    isMenuBarAutoHide: mainWindow.isMenuBarAutoHide(),
    isMenuBarVisible: mainWindow.isMenuBarVisible()
  };
});
import_electron.ipcMain.handle("reloadHomeUrl", async (event, args) => {
  if (args.isDev) {
    mainWindow.loadFile(import_node_path.default.join(process.env.VITE_PUBLIC, "index.html"));
    return;
  }
  if (!args.url) return;
  mainWindow.loadURL(args.url);
});
import_electron.ipcMain.handle("resetMainWindow", async (event, args) => {
  const window = import_electron.BrowserWindow.fromId(args.winId);
  if (!window) return { error: "\u627E\u4E0D\u5230\u7A97\u53E3" };
  if (mainWindow) {
    mainWindow.close();
    mainWindow.destroy();
    import_main_tray.default.DelectTray();
  }
  mainWindow = window;
  global.mainWindow = mainWindow;
  import_main_tray.default.CreateTray(mainWindow);
});
import_electron.ipcMain.handle("minimizeWindow", async (event, args) => {
  const window = import_electron.BrowserWindow.fromId(args.winId) || mainWindow;
  if (window) {
    window.minimize();
  }
});
import_electron.ipcMain.handle("maximizeWindow", async (event, args) => {
  const window = import_electron.BrowserWindow.fromId(args.winId) || mainWindow;
  if (window) {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  }
});
import_electron.ipcMain.handle("closeWindow", async (event, args) => {
  const window = import_electron.BrowserWindow.fromId(args.winId || args.closeId) || mainWindow;
  if (window) {
    window.close();
  }
});
import_electron.ipcMain.handle("isWindowMaximized", async (event, args) => {
  const window = import_electron.BrowserWindow.fromId(args.winId) || mainWindow;
  return window ? window.isMaximized() : false;
});
import_electron.ipcMain.handle("isWindowDestroyed", (event, args) => {
  try {
    const window = import_electron.BrowserWindow.fromId(args.winId);
    return !window || window.isDestroyed();
  } catch (error) {
    return true;
  }
});
const gotTheLock = import_electron.app.requestSingleInstanceLock();
if (!gotTheLock) {
  import_electron.app.quit();
} else {
  import_electron.app.on("second-instance", (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized() || !mainWindow.isVisible()) {
        mainWindow.show();
      } else {
        mainWindow.focus();
      }
    }
  });
  import_electron.app.whenReady().then(() => {
    (0, import_crash_logger.initCrashLogger)();
    bootstrap();
    BLOCKED_SCHEMES.forEach((s) => {
      const scheme = s.replace(":", "");
      try {
        import_electron.protocol.handle(scheme, (req) => {
          console.log("[protocol] Blocked scheme request:", req.url);
          return new Response(null, { status: 204 });
        });
        console.log("[protocol] Registered protocol client for:", scheme);
      } catch (e) {
        console.error("[protocol] Failed to register scheme:", scheme, e);
      }
    });
  });
}
import_electron.app.on("window-all-closed", function() {
  if (process.platform !== "darwin") import_electron.app.quit();
});
