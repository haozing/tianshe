const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel) {
  return (message) => ipcRenderer.invoke(channel, message);
}

function configuredBlockedSchemes() {
  return String(process.env.CHIHU_BLOCKED_EXTERNAL_SCHEMES || "")
    .split(",")
    .map((scheme) => scheme.trim().toLowerCase().replace(/:$/, ""))
    .filter(Boolean)
    .map((scheme) => `${scheme}:`);
}

function installSchemeBlocker() {
  const blockedSchemes = configuredBlockedSchemes();
  if (!blockedSchemes.length) return;

  const isBlockedScheme = (url) => {
    if (!url || typeof url !== "string") return false;
    const lower = url.toLowerCase().trim();
    return blockedSchemes.some((scheme) => lower.startsWith(scheme));
  };

  try {
    const originalOpen = window.open;
    window.open = function (url, ...args) {
      if (isBlockedScheme(url)) return null;
      return originalOpen.call(window, url, ...args);
    };

    const originalCreateElement = document.createElement.bind(document);
    document.createElement = function (tagName) {
      const element = originalCreateElement(tagName);
      if (String(tagName).toLowerCase() !== "a") return element;

      const originalSetAttribute = element.setAttribute.bind(element);
      element.setAttribute = function (name, value) {
        if (String(name).toLowerCase() === "href" && isBlockedScheme(value)) return;
        return originalSetAttribute(name, value);
      };

      return element;
    };
  } catch (error) {
    console.warn("[preload] scheme blocker failed:", error);
  }
}

installSchemeBlocker();

const client = {
  get_cookies: invoke("get_cookies"),
  set_cookies: invoke("set_cookies"),
  copy_cookies: invoke("copy_cookies"),
  clear_session: invoke("clear_session"),
  http: invoke("http"),
  uploadFile: invoke("uploadFile"),
  openWindow: invoke("openWindow"),
  closeWindow: invoke("closeWindow"),
  editBrowserWindow: invoke("editBrowserWindow"),
  getBrowserWindowInfo: invoke("getBrowserWindowInfo"),
  destroyBrowserWindow: invoke("destroyBrowserWindow"),
  executeJavaScriptBrowserWindow: invoke("executeJavaScriptBrowserWindow"),
  reloadHomeUrl: invoke("reloadHomeUrl"),
  sendNotification: invoke("send_notification"),
  getMainWindowInfo: invoke("getMainWindowInfo"),
  resetMainWindow: invoke("resetMainWindow"),
  getAllBrowserWindowInfos: invoke("getAllBrowserWindowInfos"),
  getAppInfo: invoke("app_info"),
  startAutoUpdate: invoke("startAutoUpdate"),
  cleanInvalidPartitions: invoke("cleanInvalidPartitions"),
  minimizeWindow: invoke("minimizeWindow"),
  maximizeWindow: invoke("maximizeWindow"),
  isWindowMaximized: invoke("isWindowMaximized"),
  isWindowDestroyed: invoke("isWindowDestroyed"),
  getClientVersionData: invoke("getClientVersionData"),
  reportClientLog: invoke("reportClientLog"),
  getCrashLogDir: invoke("getCrashLogDir"),
  cleanCrashLogs: invoke("cleanupOldCrashLogs"),
  selectDirectory: invoke("selectDirectory"),
  downloadFileToPath: invoke("downloadFileToPath"),
  cancelDownloadFileToPath: invoke("cancelDownloadFileToPath"),
  saveBufferToPath: invoke("saveBufferToPath"),
  openPathInExplorer: invoke("openPathInExplorer")
};

const chihuNative = {
  app: {
    getInfo: invoke("native:app:getInfo")
  },
  windows: {
    open: invoke("native:windows:open"),
    eval: invoke("native:windows:eval"),
    destroy: invoke("native:windows:destroy"),
    getInfo: client.getBrowserWindowInfo,
    getAll: client.getAllBrowserWindowInfos,
    getMainInfo: client.getMainWindowInfo,
    resetMain: client.resetMainWindow,
    reloadHome: client.reloadHomeUrl,
    minimize: client.minimizeWindow,
    maximize: client.maximizeWindow,
    close: client.closeWindow,
    isMaximized: client.isWindowMaximized,
    isDestroyed: client.isWindowDestroyed
  },
  cookies: {
    get: invoke("native:cookies:get"),
    set: invoke("native:cookies:set"),
    copy: invoke("native:cookies:copy"),
    getHeader: invoke("native:cookies:getHeader"),
    clear: invoke("native:cookies:clear")
  },
  http: {
    request: invoke("native:http:request")
  },
  files: {
    selectFile: invoke("native:files:selectFile"),
    readFile: invoke("native:files:readFile"),
    download: invoke("native:files:download"),
    selectDirectory: client.selectDirectory,
    saveBufferToPath: client.saveBufferToPath,
    openPathInExplorer: client.openPathInExplorer,
    cancelDownload: client.cancelDownloadFileToPath
  },
  notifications: {
    send: invoke("native:notifications:send")
  },
  updates: {
    start: invoke("native:updates:start"),
    getVersionData: invoke("native:updates:getVersionData")
  },
  logs: {
    report: invoke("native:logs:report"),
    getDir: invoke("native:logs:getDir"),
    clean: invoke("native:logs:clean")
  },
  partitions: {
    cleanInvalid: invoke("native:partitions:cleanInvalid")
  }
};

contextBridge.exposeInMainWorld("client", client);
contextBridge.exposeInMainWorld("chihuNative", chihuNative);

ipcRenderer.on("chihu-notification", (_event, args) => {
  const customEvent = new CustomEvent(args.chihu_event_name, { detail: args });
  window.dispatchEvent(customEvent);
});
