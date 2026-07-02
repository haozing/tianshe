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
    "db",
    "_db",
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
    "startEnumsPdd",
    "cancelEnumsPdd",
    "checkProcessRunning",
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

  function redact(value) {
    var text = typeof value === "string" ? value : JSON.stringify(value || {});
    return text
      .replace(/"?(cookie|set-cookie|authorization)"?\s*:\s*"[^"]*"/gi, "\"$1\":\"[REDACTED]\"")
      .replace(/(cookie|set-cookie|authorization):\s*[^\n\r]*/gi, "$1: [REDACTED]")
      .replace(/token=[^&\s]*/gi, "token=[REDACTED]");
  }

  function makeError(code, message, cause) {
    var error = new Error(message);
    error.code = code;
    error.cause = cause;
    return error;
  }

  function rawClient() {
    return window.client || null;
  }

  function hasMethod(name) {
    var client = rawClient();
    return !!(client && typeof client[name] === "function");
  }

  async function callRaw(name, args) {
    if (!hasMethod(name)) {
      throw makeError("CLIENT_METHOD_UNAVAILABLE", "window.client." + name + " is unavailable");
    }
    return rawClient()[name](args);
  }

  async function safeCallRaw(name, args) {
    var start = Date.now();
    try {
      var result = await callRaw(name, args);
      return {
        ok: true,
        method: name,
        durationMs: Date.now() - start,
        result: result
      };
    } catch (error) {
      return {
        ok: false,
        method: name,
        durationMs: Date.now() - start,
        error: {
          code: error && error.code || "CLIENT_CALL_FAILED",
          message: error && error.message || String(error)
        }
      };
    }
  }

  async function getAppInfo() {
    if (!hasMethod("getAppInfo")) {
      return {
        hasClient: false,
        version: "web-preview",
        platform: navigator.platform,
        userAgent: navigator.userAgent
      };
    }
    return callRaw("getAppInfo");
  }

  async function http(options) {
    return callRaw("http", options);
  }

  async function reportClientLog(payload) {
    var event = Object.assign({
      time: nowIso(),
      source: "liehuBridge"
    }, payload || {});

    event = JSON.parse(redact(event));

    if (hasMethod("reportClientLog")) {
      return callRaw("reportClientLog", event);
    }

    console.info("[liehuBridge]", event);
    return { ok: true, fallback: "console" };
  }

  window.liehuBridge = {
    version: "phase0",
    rawMethods: RAW_METHODS.slice(),
    hasClient: function () {
      return !!rawClient();
    },
    hasMethod: hasMethod,
    raw: callRaw,
    safeRaw: safeCallRaw,
    app: {
      getAppInfo: getAppInfo
    },
    http: {
      request: http
    },
    cookie: {
      get: function (args) { return callRaw("get_cookies", args); },
      set: function (args) { return callRaw("set_cookies", args); },
      clearSession: function (args) { return callRaw("clear_session", args); }
    },
    window: {
      open: function (args) { return callRaw("openWindow", args); },
      executeJavaScript: function (args) { return callRaw("executeJavaScriptBrowserWindow", args); }
    },
    db: {
      call: function (args) { return callRaw("db", args); },
      rawCall: function (args) { return callRaw("_db", args); }
    },
    diagnostics: {
      report: reportClientLog,
      redact: redact
    }
  };
})();

