const { ipcMain } = require("electron");
const { requirePaidFeature } = require("./device-license");
const { requireWebContentsPrincipal } = require("../security/web-contents-principal");
const { getRunnerContextForSender, runnerCookieAllowed, runnerHttpAllowed } = require("../tasks/task-manager");
const { dataStoreName, paidDataRequest, runnerDataAllowed } = require("./data-access-policy");
const { MAIN_WINDOW_ONLY_CHANNELS, mainWindowControlDecision } = require("./window-control-policy");

const HIGH_RISK_EXACT_CHANNELS = new Set([
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
  "native:http:request",
  "native:windows:open",
  "native:windows:command",
  "native:windows:eval",
  "native:windows:destroy"
]);

const GUARDED_EXACT_CHANNELS = new Set([
  ...HIGH_RISK_EXACT_CHANNELS,
  "reloadHomeUrl",
  "resetMainWindow",
  "cleanInvalidPartitions",
  "selectDirectory",
  "downloadFileToPath",
  "cancelDownloadFileToPath",
  "saveBufferToPath",
  "openPathInExplorer",
  "native:partitions:cleanInvalid",
  "native:text:segment"
]);

for (const channel of MAIN_WINDOW_ONLY_CHANNELS) GUARDED_EXACT_CHANNELS.add(channel);

const GUARDED_PREFIXES = [
  "native:cookies:",
  "native:files:",
  "native:data:",
  "native:license:"
];

let installed = false;

function isGuardedChannel(channel) {
  if (GUARDED_EXACT_CHANNELS.has(channel)) return true;
  return GUARDED_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

function isHighRiskChannel(channel) {
  return HIGH_RISK_EXACT_CHANNELS.has(channel) || channel.startsWith("native:cookies:");
}

function toIpcError(error) {
  const next = new Error(error.message || "当前页面不能使用该能力");
  next.name = error.name || "IpcAccessError";
  next.code = error.code || "IPC_ACCESS_DENIED";
  next.details = error.details || {};
  return next;
}

function safeVisiblePlatformOpen(args = {}) {
  if (args.show === false || args.isNotShow === true || args.waitForLoad === false) return false;
  try {
    const url = new URL(String(args.url || ""));
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.searchParams.get("runner") === "1") return false;
  } catch {
    return false;
  }
  const partition = String(args.partition || "");
  return !partition || partition === "persist:chihu-doudian-shared" || partition.startsWith("persist:chihu_doudian_shop_");
}

async function authorizeIpc(event, channel, args = {}) {
  if (channel.startsWith("native:license:")) {
    requireWebContentsPrincipal(event, ["main"]);
    return;
  }
  const principal = requireWebContentsPrincipal(event, ["main", "runner"]);
  const runnerContext = principal.role === "runner" ? getRunnerContextForSender(event.sender) : null;

  const mainWindowControl = mainWindowControlDecision(principal.role, channel);
  if (mainWindowControl === true) return;
  if (mainWindowControl === false) throw toIpcError({ code: "IPC_ROLE_DENIED", message: "任务 runner 不能控制主窗口" });

  if (channel.startsWith("native:data:")) {
    if (runnerContext) {
      if (!runnerDataAllowed(runnerContext, channel, args)) throw toIpcError({ code: "DATA_SCOPE_DENIED", message: "任务数据范围不允许该操作" });
      return;
    }
    if (paidDataRequest(channel, args)) await requirePaidFeature({ channel, storeName: dataStoreName(args) });
    return;
  }

  if (["cleanInvalidPartitions", "native:partitions:cleanInvalid"].includes(channel) && runnerContext) {
    const prefixes = Array.isArray(args.prefixes) ? args.prefixes.map(String) : [];
    const partitions = Array.isArray(args.currentPartitions) ? args.currentPartitions.map(String) : [];
    const allowedPrefixes = [...runnerContext.allowedPartitionPrefixes];
    const allowed = runnerContext.taskType === "fetchDoudianStores" &&
      prefixes.length > 0 && prefixes.every((prefix) => allowedPrefixes.includes(prefix)) &&
      partitions.every((partition) => allowedPrefixes.some((prefix) => partition.startsWith(prefix)));
    if (!allowed) throw toIpcError({ code: "TASK_PARTITION_DENIED", message: "任务分区清理范围不允许该操作" });
    return;
  }

  if (isHighRiskChannel(channel)) {
    if (runnerContext) {
      if (["http", "native:http:request"].includes(channel)) {
        if (channel !== "native:http:request" || !runnerHttpAllowed(runnerContext, args)) {
          throw toIpcError({ code: "TASK_PLAN_DENIED", message: "HTTP 请求缺少匹配的一次性 request plan grant" });
        }
        return;
      }
      if (channel.startsWith("native:cookies:") || ["get_cookies", "set_cookies", "copy_cookies", "clear_session"].includes(channel)) {
        if (!runnerCookieAllowed(runnerContext, channel, args)) throw toIpcError({ code: "TASK_COOKIE_DENIED", message: "Cookie 操作不属于当前任务的 plan 和分区范围" });
        return;
      }
      if (["openWindow", "editBrowserWindow", "getBrowserWindowInfo", "getAllBrowserWindowInfos", "destroyBrowserWindow", "native:windows:open", "native:windows:command", "native:windows:destroy"].includes(channel)) return;
      throw toIpcError({ code: "IPC_ROLE_DENIED", message: "任务 runner 不能使用该通用高风险能力" });
    }
    if (["openWindow", "native:windows:open"].includes(channel) && safeVisiblePlatformOpen(args)) return;
    if (["clear_session", "native:cookies:clear"].includes(channel) && String(args.partition || "").startsWith("persist:chihu_doudian_shop_")) return;
    throw toIpcError({ code: "IPC_ROLE_DENIED", message: "主页面不能使用通用 HTTP、Cookie、隐藏窗口或脚本执行能力" });
  }

  if (principal.role === "runner" && (channel.startsWith("native:files:") || ["selectDirectory", "downloadFileToPath", "saveBufferToPath", "openPathInExplorer"].includes(channel))) {
    throw toIpcError({ code: "IPC_ROLE_DENIED", message: "任务 runner 不能访问通用文件能力" });
  }
}

function installLicenseIpcGuard() {
  if (installed) return;
  installed = true;

  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (!isGuardedChannel(channel)) return originalHandle(channel, listener);
    return originalHandle(channel, async (event, ...args) => {
      try {
        await authorizeIpc(event, channel, args[0] || {});
      } catch (error) {
        throw toIpcError(error);
      }
      return listener(event, ...args);
    });
  };
}

module.exports = {
  authorizeIpc,
  installLicenseIpcGuard,
  isGuardedChannel
};
