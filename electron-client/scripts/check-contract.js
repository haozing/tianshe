const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const preloadPath = path.join(root, "src", "preload", "index.js");
const ipcRoot = path.join(root, "src", "main", "ipc");
const mainPath = path.join(root, "src", "main", "index.js");

const expectedClientMethods = [
  ["get_cookies", "get_cookies"],
  ["set_cookies", "set_cookies"],
  ["copy_cookies", "copy_cookies"],
  ["clear_session", "clear_session"],
  ["http", "http"],
  ["uploadFile", "uploadFile"],
  ["openWindow", "openWindow"],
  ["closeWindow", "closeWindow"],
  ["editBrowserWindow", "editBrowserWindow"],
  ["getBrowserWindowInfo", "getBrowserWindowInfo"],
  ["destroyBrowserWindow", "destroyBrowserWindow"],
  ["executeJavaScriptBrowserWindow", "executeJavaScriptBrowserWindow"],
  ["reloadHomeUrl", "reloadHomeUrl"],
  ["db", "db"],
  ["_db", "_db"],
  ["sendNotification", "send_notification"],
  ["getMainWindowInfo", "getMainWindowInfo"],
  ["resetMainWindow", "resetMainWindow"],
  ["getAllBrowserWindowInfos", "getAllBrowserWindowInfos"],
  ["getAppInfo", "app_info"],
  ["startAutoUpdate", "startAutoUpdate"],
  ["cleanInvalidPartitions", "cleanInvalidPartitions"],
  ["minimizeWindow", "minimizeWindow"],
  ["maximizeWindow", "maximizeWindow"],
  ["isWindowMaximized", "isWindowMaximized"],
  ["isWindowDestroyed", "isWindowDestroyed"],
  ["getClientVersionData", "getClientVersionData"],
  ["startEnumsPdd", "startEnumsPdd"],
  ["cancelEnumsPdd", "cancelEnumsPdd"],
  ["checkProcessRunning", "checkProcessRunning"],
  ["reportClientLog", "reportClientLog"],
  ["getCrashLogDir", "getCrashLogDir"],
  ["cleanCrashLogs", "cleanupOldCrashLogs"],
  ["selectDirectory", "selectDirectory"],
  ["downloadFileToPath", "downloadFileToPath"],
  ["cancelDownloadFileToPath", "cancelDownloadFileToPath"],
  ["saveBufferToPath", "saveBufferToPath"],
  ["openPathInExplorer", "openPathInExplorer"]
];

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function collectJs(dir) {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) files.push(...collectJs(fullPath));
    else if (fullPath.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

const preload = read(preloadPath);
const mainAndIpc = [mainPath, ...collectJs(ipcRoot)].map(read).join("\n");

const failures = [];
for (const [method, channel] of expectedClientMethods) {
  if (!preload.includes(`${method}: invoke("${channel}")`)) {
    failures.push(`preload missing ${method} -> ${channel}`);
  }
  if (!mainAndIpc.includes(`ipcMain.handle("${channel}"`)) {
    failures.push(`ipc missing ${channel}`);
  }
}

if (failures.length) {
  console.error("CONTRACT_FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`CONTRACT_OK ${expectedClientMethods.length} methods`);

