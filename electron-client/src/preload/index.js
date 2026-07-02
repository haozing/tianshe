const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel) {
  return (message) => ipcRenderer.invoke(channel, message);
}

function installSchemeBlocker() {
  const blockedSchemes = ["bytedance:", "snssdk:", "aweme:", "sslocal:", "video:", "bitbrowser:"];
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
  db: invoke("db"),
  _db: invoke("_db"),
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
  startEnumsPdd: invoke("startEnumsPdd"),
  cancelEnumsPdd: invoke("cancelEnumsPdd"),
  checkProcessRunning: invoke("checkProcessRunning"),
  reportClientLog: invoke("reportClientLog"),
  getCrashLogDir: invoke("getCrashLogDir"),
  cleanCrashLogs: invoke("cleanupOldCrashLogs"),
  selectDirectory: invoke("selectDirectory"),
  downloadFileToPath: invoke("downloadFileToPath"),
  cancelDownloadFileToPath: invoke("cancelDownloadFileToPath"),
  saveBufferToPath: invoke("saveBufferToPath"),
  openPathInExplorer: invoke("openPathInExplorer")
};

contextBridge.exposeInMainWorld("client", client);

ipcRenderer.on("zzb-notification", (_event, args) => {
  const customEvent = new CustomEvent(args.zzb_event_name, { detail: args });
  window.dispatchEvent(customEvent);
});

