(function () {
  "use strict";

  var RAW_METHODS = [
    "get_cookies",
    "set_cookies",
    "copy_cookies",
    "clear_session",
    "http",
    "uploadFile",
    "openWindow",
    "closeWindow",
    "editBrowserWindow",
    "getBrowserWindowInfo",
    "destroyBrowserWindow",
    "executeJavaScriptBrowserWindow",
    "reloadHomeUrl",
    "sendNotification",
    "getMainWindowInfo",
    "resetMainWindow",
    "getAllBrowserWindowInfos",
    "getAppInfo",
    "startAutoUpdate",
    "cleanInvalidPartitions",
    "minimizeWindow",
    "maximizeWindow",
    "isWindowMaximized",
    "isWindowDestroyed",
    "getClientVersionData",
    "reportClientLog",
    "getCrashLogDir",
    "cleanCrashLogs",
    "selectDirectory",
    "downloadFileToPath",
    "cancelDownloadFileToPath",
    "saveBufferToPath",
    "openPathInExplorer"
  ];

  function nowIso() {
    return new Date().toISOString();
  }

  function client() {
    return window.client && typeof window.client === "object" ? window.client : null;
  }

  function hasMethod(name) {
    var current = client();
    return !!(current && typeof current[name] === "function");
  }

  function availableMethods() {
    var current = client();
    if (!current) return [];
    return RAW_METHODS.filter(function (name) {
      return typeof current[name] === "function";
    });
  }

  async function callRaw(name, args) {
    if (!hasMethod(name)) {
      throw new Error("window.client method unavailable: " + name);
    }
    return window.client[name](args || {});
  }

  async function selfCheck() {
    var methods = availableMethods();
    var result = {
      checkedAt: nowIso(),
      hasClient: !!client(),
      expectedMethodCount: RAW_METHODS.length,
      methodCount: methods.length,
      missingMethods: RAW_METHODS.filter(function (name) {
        return methods.indexOf(name) === -1;
      }),
      appInfo: null,
      mainWindow: null,
      ok: false
    };

    if (hasMethod("getAppInfo")) {
      try {
        result.appInfo = await callRaw("getAppInfo");
      } catch (error) {
        result.appInfo = { err: true, message: error && error.message ? error.message : String(error) };
      }
    }

    if (hasMethod("getMainWindowInfo")) {
      try {
        result.mainWindow = await callRaw("getMainWindowInfo");
      } catch (error) {
        result.mainWindow = { err: true, message: error && error.message ? error.message : String(error) };
      }
    }

    result.ok = result.hasClient && result.missingMethods.length === 0;
    return result;
  }

  window.chihuBridge = {
    version: "clean-foundation",
    rawMethods: RAW_METHODS.slice(),
    hasClient: function () { return !!client(); },
    hasMethod: hasMethod,
    availableMethods: availableMethods,
    callRaw: callRaw,
    selfCheck: selfCheck,
    app: {
      getAppInfo: function () { return callRaw("getAppInfo"); },
      getMainWindowInfo: function () { return callRaw("getMainWindowInfo"); }
    },
    diagnostics: {
      reportClientLog: function (args) { return callRaw("reportClientLog", args); },
      getCrashLogDir: function () { return callRaw("getCrashLogDir"); }
    }
  };
})();
