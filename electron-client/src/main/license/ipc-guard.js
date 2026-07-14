const { ipcMain } = require("electron");
const { requireLicenseForIpc } = require("./device-license");

const GUARDED_EXACT_CHANNELS = new Set([
  "http",
  "get_cookies",
  "set_cookies",
  "copy_cookies",
  "clear_session",
  "uploadFile",
  "openWindow",
  "editBrowserWindow",
  "getBrowserWindowInfo",
  "getAllBrowserWindowInfos",
  "destroyBrowserWindow",
  "executeJavaScriptBrowserWindow",
  "reloadHomeUrl",
  "resetMainWindow",
  "cleanInvalidPartitions",
  "selectDirectory",
  "downloadFileToPath",
  "cancelDownloadFileToPath",
  "saveBufferToPath",
  "openPathInExplorer",
  "native:http:request",
  "native:windows:open",
  "native:windows:eval",
  "native:windows:destroy",
  "native:partitions:cleanInvalid",
  "native:text:segment"
]);

const GUARDED_PREFIXES = [
  "native:cookies:",
  "native:files:",
  "native:data:"
];

let installed = false;

function isGuardedChannel(channel) {
  if (GUARDED_EXACT_CHANNELS.has(channel)) return true;
  return GUARDED_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

function toIpcError(error) {
  const next = new Error(error.message || "请先兑换设备授权");
  next.name = "LicenseRequiredError";
  next.code = error.code || "LICENSE_REQUIRED";
  next.details = error.details || {};
  return next;
}

function installLicenseIpcGuard() {
  if (installed) return;
  installed = true;

  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (!isGuardedChannel(channel)) {
      return originalHandle(channel, listener);
    }

    return originalHandle(channel, async (event, ...args) => {
      try {
        await requireLicenseForIpc(channel);
      } catch (error) {
        throw toIpcError(error);
      }
      return listener(event, ...args);
    });
  };
}

module.exports = {
  installLicenseIpcGuard,
  isGuardedChannel
};
