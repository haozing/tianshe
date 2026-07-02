const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const path = require("node:path");

const {
  APP_TITLE,
  DEFAULT_PARTITION,
  HOME_INDEX_URL,
  HOME_PRELOAD,
  ICON_PATH
} = require("./config");
const { addDevShortcuts } = require("./utils/dev-shortcuts");
const { installSchemeBlocker } = require("./window/scheme-blocker");
const { registerIpcHandlers } = require("./ipc");

app.commandLine.appendSwitch("ignore-certificate-errors", "true");
app.commandLine.appendSwitch("ignore-gpu-blacklist");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-web-security");
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

if (process.env.XZB_USER_DATA_DIR) {
  app.setPath("userData", process.env.XZB_USER_DATA_DIR);
}

let mainWindow = null;

function getMainWindow() {
  return mainWindow;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: Number(process.env.XZB_WINDOW_WIDTH || 1200),
    height: Number(process.env.XZB_WINDOW_HEIGHT || 760),
    minWidth: 904,
    minHeight: 649,
    frame: process.env.XZB_FRAME === "1",
    resizable: true,
    title: APP_TITLE,
    icon: ICON_PATH,
    webPreferences: {
      preload: HOME_PRELOAD,
      partition: DEFAULT_PARTITION,
      nodeIntegration: true,
      contextIsolation: true,
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  });

  global.mainWindow = mainWindow;
  mainWindow.setMenu(null);
  addDevShortcuts(mainWindow);

  mainWindow.on("closed", () => {
    mainWindow = null;
    global.mainWindow = null;
  });

  installSmokeCheck(mainWindow);
  mainWindow.loadURL(HOME_INDEX_URL);
  return mainWindow;
}

function installSmokeCheck(win) {
  if (process.env.XZB_E2E_SMOKE !== "1") return;

  const scenario = process.env.XZB_E2E_SMOKE_SCENARIO || "bridge";
  const timeoutMs = Number(process.env.XZB_E2E_TIMEOUT_MS || 15000);
  const startedAt = Date.now();
  let finished = false;
  let probing = false;
  let retryTimer = null;
  let lastProbeError = null;
  let lastProbeResult = null;

  const finish = (code, payload) => {
    if (finished) return;
    finished = true;
    clearTimeout(retryTimer);
    const result = {
      ok: code === 0,
      durationMs: Date.now() - startedAt,
      ...payload
    };
    console.log(`ELECTRON_SMOKE_RESULT ${JSON.stringify(result)}`);
    app.exit(code);
  };

  const timer = setTimeout(() => {
    finish(1, {
      reason: "timeout",
      url: win.webContents.getURL(),
      lastProbeError,
      lastProbeResult
    });
  }, timeoutMs);

  const scheduleProbe = (delay = 0) => {
    if (finished) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(runProbe, delay);
  };

  const runProbe = async () => {
    if (finished || probing || win.isDestroyed() || win.webContents.isDestroyed()) return;
    if (win.webContents.isLoadingMainFrame()) {
      scheduleProbe(200);
      return;
    }

    probing = true;
    try {
      const probeTimeoutMs = Math.min(10000, Math.max(3000, timeoutMs - (Date.now() - startedAt) - 500));
      const result = await Promise.race([
        win.webContents.executeJavaScript(`
        (() => new Promise(async (resolve) => {
          const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
          const withTimeout = (label, promise, ms = 2500) => Promise.race([
            promise,
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error(label + " timeout after " + ms + "ms")), ms);
            })
          ]);
          const deadline = Date.now() + 5000;

          while (Date.now() < deadline) {
            const text = document.body ? document.body.innerText : "";
            const hasShell = text.includes("新远程 Web") && text.includes("Bridge");
            const hasClient = !!window.client;
            const methodCount = hasClient ? Object.keys(window.client).length : 0;
            if (hasShell && hasClient && methodCount >= 30) break;
            await sleep(100);
          }

          const text = document.body ? document.body.innerText : "";
          const hasShell = text.includes("新远程 Web") && text.includes("Bridge");
          const hasClient = !!window.client;
          const methodNames = hasClient ? Object.keys(window.client) : [];
          const methodCount = methodNames.length;
          const result = {
            scenario: ${JSON.stringify(scenario)},
            hasShell,
            hasClient,
            methodCount,
            title: document.title,
            href: location.href,
            textSample: text.slice(0, 240)
          };

          if (result.scenario === "cookie") {
            const cookie = {
              attempted: false,
              sourceSetOk: false,
              sourceReadOk: false,
              copyOk: false,
              targetReadOk: false,
              sourceClearOk: false,
              targetClearOk: false,
              isolationOk: false,
              steps: [],
              errors: []
            };

            if (hasShell && hasClient && methodCount >= 30) {
              cookie.attempted = true;
              const suffix = Date.now() + "-" + Math.random().toString(16).slice(2);
              const sourcePartition = "persist:xzb-smoke-cookie-source-" + suffix;
              const targetPartition = "persist:xzb-smoke-cookie-target-" + suffix;
              const name = "xzb_smoke_cookie_" + suffix.replace(/[^a-z0-9]/gi, "_");
              const value = "value-" + suffix;
              const url = "http://localhost/";

              try {
                cookie.steps.push("clearSourceBefore");
                await withTimeout("clearSourceBefore", window.client.clear_session({ partition: sourcePartition }));
                cookie.steps.push("clearTargetBefore");
                await withTimeout("clearTargetBefore", window.client.clear_session({ partition: targetPartition }));

                cookie.steps.push("set_cookies");
                const setResult = await withTimeout("set_cookies", window.client.set_cookies({
                  partition: sourcePartition,
                  cookies: [{
                    name,
                    value,
                    path: "/",
                    secure: false,
                    httpOnly: false,
                    expirationDate: Math.floor(Date.now() / 1000) + 3600
                  }]
                }));
                cookie.sourceSetOk = !!setResult && !setResult.err;

                cookie.steps.push("get_cookies_source");
                const sourceCookies = await withTimeout("get_cookies_source", window.client.get_cookies({
                  partition: sourcePartition,
                  url
                }));
                cookie.sourceReadOk = Array.isArray(sourceCookies) &&
                  sourceCookies.some((item) => item.name === name && item.value === value);

                cookie.steps.push("copy_cookies");
                const copyResult = await withTimeout("copy_cookies", window.client.copy_cookies({
                  oldPartition: sourcePartition,
                  newPartition: targetPartition
                }));
                cookie.copyOk = !!copyResult && !copyResult.err;

                cookie.steps.push("get_cookies_target");
                const targetCookies = await withTimeout("get_cookies_target", window.client.get_cookies({
                  partition: targetPartition,
                  url
                }));
                cookie.targetReadOk = Array.isArray(targetCookies) &&
                  targetCookies.some((item) => item.name === name && item.value === value);

                cookie.steps.push("clearSourceAfter");
                const sourceClear = await withTimeout("clearSourceAfter", window.client.clear_session({ partition: sourcePartition }));
                cookie.sourceClearOk = !!sourceClear && !sourceClear.err;

                cookie.steps.push("clearTargetAfter");
                const targetClear = await withTimeout("clearTargetAfter", window.client.clear_session({ partition: targetPartition }));
                cookie.targetClearOk = !!targetClear && !targetClear.err;

                cookie.steps.push("verifyCleared");
                const clearedSource = await withTimeout("verifyClearedSource", window.client.get_cookies({
                  partition: sourcePartition,
                  url
                }));
                const clearedTarget = await withTimeout("verifyClearedTarget", window.client.get_cookies({
                  partition: targetPartition,
                  url
                }));
                cookie.isolationOk = Array.isArray(clearedSource) &&
                  Array.isArray(clearedTarget) &&
                  !clearedSource.some((item) => item.name === name) &&
                  !clearedTarget.some((item) => item.name === name);
              } catch (error) {
                cookie.errors.push(error && error.message ? error.message : String(error));
              }
            }

            result.cookieOk = cookie.sourceSetOk &&
              cookie.sourceReadOk &&
              cookie.copyOk &&
              cookie.targetReadOk &&
              cookie.sourceClearOk &&
              cookie.targetClearOk &&
              cookie.isolationOk;
            result.cookie = cookie;
            resolve(result);
            return;
          }

          if (result.scenario === "http") {
            const http = {
              attempted: false,
              getOk: false,
              postOk: false,
              errorOk: false,
              base64Ok: false,
              setCookieOk: false,
              cleanupOk: false,
              steps: [],
              errors: []
            };

            if (hasShell && hasClient && methodCount >= 30) {
              http.attempted = true;
              const baseUrl = ${JSON.stringify(process.env.XZB_E2E_HTTP_BASE_URL || "")};
              const expectedBase64 = ${JSON.stringify(process.env.XZB_E2E_HTTP_EXPECTED_BASE64 || "")};
              const suffix = Date.now() + "-" + Math.random().toString(16).slice(2);
              const partition = "persist:xzb-smoke-http-" + suffix;
              const cookieName = "xzb_http_smoke_" + suffix.replace(/[^a-z0-9]/gi, "_");
              const cookieValue = "cookie-" + suffix;

              try {
                if (!baseUrl) throw new Error("missing XZB_E2E_HTTP_BASE_URL");

                http.steps.push("clearBefore");
                await withTimeout("httpClearBefore", window.client.clear_session({ partition }));

                http.steps.push("getJson");
                const getResult = await withTimeout("httpGetJson", window.client.http({
                  axiosParmars: {
                    method: "GET",
                    url: baseUrl + "/json?q=hello",
                    headers: {
                      "X-Smoke-Header": "bridge-get"
                    }
                  },
                  axiosParamsTimeout: 5000
                }), 6000);
                http.getOk = !!getResult &&
                  !getResult.error &&
                  !!getResult.data &&
                  getResult.data.ok === true &&
                  getResult.data.method === "GET" &&
                  getResult.data.query === "hello" &&
                  getResult.data.header === "bridge-get";

                http.steps.push("postEcho");
                const postResult = await withTimeout("httpPostEcho", window.client.http({
                  axiosParmars: {
                    method: "POST",
                    url: baseUrl + "/echo",
                    headers: {
                      "Content-Type": "application/json",
                      "X-Smoke-Header": "bridge-post"
                    },
                    data: {
                      hello: "world",
                      count: 2
                    }
                  },
                  axiosParamsTimeout: 5000
                }), 6000);
                http.postOk = !!postResult &&
                  !postResult.error &&
                  !!postResult.data &&
                  postResult.data.ok === true &&
                  postResult.data.method === "POST" &&
                  postResult.data.header === "bridge-post" &&
                  postResult.data.parsed &&
                  postResult.data.parsed.hello === "world" &&
                  postResult.data.parsed.count === 2;

                http.steps.push("errorResponse");
                const errorResult = await withTimeout("httpErrorResponse", window.client.http({
                  axiosParmars: {
                    method: "GET",
                    url: baseUrl + "/status/418"
                  },
                  axiosParamsTimeout: 5000
                }), 6000);
                http.errorOk = !!errorResult &&
                  !!errorResult.error &&
                  errorResult.error.status === 418 &&
                  !!errorResult.data &&
                  errorResult.data.code === "teapot";

                http.steps.push("getBase64");
                const base64Result = await withTimeout("httpGetBase64", window.client.http({
                  getBase64: true,
                  url: baseUrl + "/binary"
                }), 6000);
                http.base64Ok = !!base64Result &&
                  base64Result.data === expectedBase64;

                http.steps.push("setCookie");
                const setCookieResult = await withTimeout("httpSetCookie", window.client.http({
                  partition,
                  axiosParmars: {
                    method: "GET",
                    url: baseUrl + "/set-cookie?name=" + encodeURIComponent(cookieName) + "&value=" + encodeURIComponent(cookieValue)
                  },
                  axiosParamsTimeout: 5000
                }), 6000);
                const storedCookies = await withTimeout("httpGetStoredCookies", window.client.get_cookies({
                  partition,
                  url: baseUrl + "/"
                }));
                http.setCookieOk = !!setCookieResult &&
                  !setCookieResult.error &&
                  Array.isArray(storedCookies) &&
                  storedCookies.some((item) => item.name === cookieName && item.value === cookieValue);

                http.steps.push("clearAfter");
                const cleanup = await withTimeout("httpClearAfter", window.client.clear_session({ partition }));
                const afterCleanup = await withTimeout("httpVerifyCleanup", window.client.get_cookies({
                  partition,
                  url: baseUrl + "/"
                }));
                http.cleanupOk = !!cleanup &&
                  !cleanup.err &&
                  Array.isArray(afterCleanup) &&
                  !afterCleanup.some((item) => item.name === cookieName);
              } catch (error) {
                http.errors.push(error && error.message ? error.message : String(error));
              }
            }

            result.httpOk = http.getOk &&
              http.postOk &&
              http.errorOk &&
              http.base64Ok &&
              http.setCookieOk &&
              http.cleanupOk;
            result.http = http;
            resolve(result);
            return;
          }

          if (result.scenario === "db") {
            const db = {
              attempted: false,
              nedbInsertOk: false,
              nedbFindOk: false,
              nedbUpdateOk: false,
              nedbCountOk: false,
              nedbLimitOk: false,
              nedbDeleteOk: false,
              sqliteInsertOk: false,
              sqliteFindOk: false,
              sqliteUpdateOk: false,
              sqliteCountOk: false,
              sqliteSelfSqlOk: false,
              sqliteDeleteOk: false,
              steps: [],
              errors: []
            };

            if (hasShell && hasClient && methodCount >= 30) {
              db.attempted = true;
              const suffix = Date.now() + "_" + Math.random().toString(16).slice(2).replace(/[^a-z0-9_]/gi, "");
              const nedbName = "xzb_smoke_nedb_" + suffix;
              const sqliteName = "xzb_smoke_sqlite_" + suffix;
              const rowA = { id: "row_a_" + suffix, type: "smoke", score: 1, updatedAt: "2026-01-01T00:00:00.000Z" };
              const rowB = { id: "row_b_" + suffix, type: "smoke", score: 2, updatedAt: "2026-01-02T00:00:00.000Z" };

              try {
                db.steps.push("nedb.insertMany");
                const nedbInserted = await withTimeout("nedb.insertMany", window.client.db({
                  dbName: nedbName,
                  cmd: "insertMany",
                  rows: [rowA, rowB]
                }), 5000);
                db.nedbInsertOk = Array.isArray(nedbInserted) && nedbInserted.length === 2;

                db.steps.push("nedb.findById");
                const nedbFound = await withTimeout("nedb.findById", window.client.db({
                  dbName: nedbName,
                  cmd: "findById",
                  id: rowA.id
                }), 5000);
                db.nedbFindOk = !!nedbFound && nedbFound.id === rowA.id && nedbFound.score === 1;

                db.steps.push("nedb.update");
                const nedbUpdated = await withTimeout("nedb.update", window.client.db({
                  dbName: nedbName,
                  cmd: "update",
                  row: { ...nedbFound, score: 3, updatedAt: "2026-01-03T00:00:00.000Z" }
                }), 5000);
                const nedbAfterUpdate = await withTimeout("nedb.findAfterUpdate", window.client.db({
                  dbName: nedbName,
                  cmd: "findById",
                  id: rowA.id
                }), 5000);
                db.nedbUpdateOk = nedbUpdated === 1 && !!nedbAfterUpdate && nedbAfterUpdate.score === 3;

                db.steps.push("nedb.count");
                const nedbCount = await withTimeout("nedb.count", window.client.db({
                  dbName: nedbName,
                  cmd: "count",
                  query: { type: "smoke" }
                }), 5000);
                db.nedbCountOk = nedbCount === 2;

                db.steps.push("nedb.findLimit");
                const nedbLimited = await withTimeout("nedb.findLimit", window.client.db({
                  dbName: nedbName,
                  cmd: "findLimit",
                  query: { type: "smoke" },
                  sort: { score: -1 },
                  skip: 0,
                  limit: 1
                }), 5000);
                db.nedbLimitOk = Array.isArray(nedbLimited) && nedbLimited.length === 1 && nedbLimited[0].score === 3;

                db.steps.push("nedb.delete");
                const nedbDeleted = await withTimeout("nedb.delete", window.client.db({
                  dbName: nedbName,
                  cmd: "batchDelete",
                  query: { type: "smoke" },
                  isNotClearLogs: true
                }), 5000);
                const nedbAfterDelete = await withTimeout("nedb.afterDelete", window.client.db({
                  dbName: nedbName,
                  cmd: "count",
                  query: { type: "smoke" }
                }), 5000);
                db.nedbDeleteOk = nedbDeleted === 2 && nedbAfterDelete === 0;

                db.steps.push("sqlite.insertMany");
                const sqliteInserted = await withTimeout("sqlite.insertMany", window.client._db({
                  dbName: sqliteName,
                  cmd: "insertMany",
                  rows: [rowA, rowB]
                }), 5000);
                db.sqliteInsertOk = Array.isArray(sqliteInserted) && sqliteInserted.length === 2;

                db.steps.push("sqlite.findById");
                const sqliteFound = await withTimeout("sqlite.findById", window.client._db({
                  dbName: sqliteName,
                  cmd: "findById",
                  id: rowB.id
                }), 5000);
                db.sqliteFindOk = !!sqliteFound && sqliteFound.id === rowB.id && sqliteFound.score === 2;

                db.steps.push("sqlite.update");
                const sqliteUpdated = await withTimeout("sqlite.update", window.client._db({
                  dbName: sqliteName,
                  cmd: "update",
                  row: { ...sqliteFound, score: 5 }
                }), 5000);
                const sqliteAfterUpdate = await withTimeout("sqlite.findAfterUpdate", window.client._db({
                  dbName: sqliteName,
                  cmd: "findById",
                  id: rowB.id
                }), 5000);
                db.sqliteUpdateOk = sqliteUpdated === 1 && !!sqliteAfterUpdate && sqliteAfterUpdate.score === 5;

                db.steps.push("sqlite.count");
                const sqliteCount = await withTimeout("sqlite.count", window.client._db({
                  dbName: sqliteName,
                  cmd: "count",
                  query: { type: "smoke" }
                }), 5000);
                db.sqliteCountOk = sqliteCount === 2;

                db.steps.push("sqlite.selfSql");
                const sqliteSelfSql = await withTimeout("sqlite.selfSql", window.client._db({
                  dbName: sqliteName,
                  cmd: "selfSql",
                  sql: "SELECT COUNT(*) as count FROM " + sqliteName + " WHERE json_extract(data, '$.type') = ?",
                  sqlParams: ["smoke"]
                }), 5000);
                db.sqliteSelfSqlOk = !!sqliteSelfSql && sqliteSelfSql.count === 2;

                db.steps.push("sqlite.delete");
                const sqliteDeleted = await withTimeout("sqlite.delete", window.client._db({
                  dbName: sqliteName,
                  cmd: "batchDelete",
                  query: { type: "smoke" }
                }), 5000);
                const sqliteAfterDelete = await withTimeout("sqlite.afterDelete", window.client._db({
                  dbName: sqliteName,
                  cmd: "count",
                  query: { type: "smoke" }
                }), 5000);
                db.sqliteDeleteOk = sqliteDeleted === 2 && sqliteAfterDelete === 0;
              } catch (error) {
                db.errors.push(error && error.message ? error.message : String(error));
              }
            }

            result.dbOk = db.nedbInsertOk &&
              db.nedbFindOk &&
              db.nedbUpdateOk &&
              db.nedbCountOk &&
              db.nedbLimitOk &&
              db.nedbDeleteOk &&
              db.sqliteInsertOk &&
              db.sqliteFindOk &&
              db.sqliteUpdateOk &&
              db.sqliteCountOk &&
              db.sqliteSelfSqlOk &&
              db.sqliteDeleteOk;
            result.db = db;
            resolve(result);
            return;
          }

          if (result.scenario === "files") {
            const files = {
              attempted: false,
              saveBufferOk: false,
              downloadOk: false,
              cancelOk: false,
              uploadOk: false,
              missingExplorerOk: false,
              steps: [],
              errors: []
            };

            if (hasShell && hasClient && methodCount >= 30) {
              files.attempted = true;
              const baseUrl = ${JSON.stringify(process.env.XZB_E2E_HTTP_BASE_URL || "")};
              const downloadBody = ${JSON.stringify(process.env.XZB_E2E_FILE_DOWNLOAD_BODY || "")};
              const uploadText = ${JSON.stringify(process.env.XZB_E2E_UPLOAD_TEXT || "")};
              const suffix = Date.now() + "_" + Math.random().toString(16).slice(2).replace(/[^a-z0-9_]/gi, "");
              const tmpRoot = ${JSON.stringify(process.env.XZB_USER_DATA_DIR || "")} || ".";
              const savePath = tmpRoot + "\\\\file-smoke-save-" + suffix + ".txt";
              const downloadPath = tmpRoot + "\\\\file-smoke-download-" + suffix + ".txt";
              const cancelPath = tmpRoot + "\\\\file-smoke-cancel-" + suffix + ".txt";

              try {
                if (!baseUrl) throw new Error("missing XZB_E2E_HTTP_BASE_URL");

                files.steps.push("saveBufferToPath");
                const saveResult = await withTimeout("saveBufferToPath", window.client.saveBufferToPath({
                  destPath: savePath,
                  buffer: "xzb-file-save-" + suffix
                }), 5000);
                const savedRead = await withTimeout("readSavedText", fetch(baseUrl + "/read-file?path=" + encodeURIComponent(savePath)).then((response) => response.json()), 5000);
                files.saveBufferOk = !!saveResult &&
                  saveResult.isSuccess === true &&
                  !!savedRead &&
                  savedRead.text === "xzb-file-save-" + suffix;

                files.steps.push("downloadFileToPath");
                const downloadResult = await withTimeout("downloadFileToPath", window.client.downloadFileToPath({
                  url: baseUrl + "/download",
                  destPath: downloadPath,
                  taskId: "download-" + suffix,
                  downloadTimeout: 5000
                }), 8000);
                const downloadedRead = await withTimeout("readDownloadedText", fetch(baseUrl + "/read-file?path=" + encodeURIComponent(downloadPath)).then((response) => response.json()), 5000);
                files.downloadOk = !!downloadResult &&
                  downloadResult.isSuccess === true &&
                  !!downloadedRead &&
                  downloadedRead.text === downloadBody;

                files.steps.push("cancelDownloadFileToPath");
                const cancelTaskId = "cancel-" + suffix;
                const pendingDownload = window.client.downloadFileToPath({
                  url: baseUrl + "/slow-download",
                  destPath: cancelPath,
                  taskId: cancelTaskId,
                  downloadTimeout: 20000
                });
                await sleep(150);
                const cancelResult = await withTimeout("cancelDownloadFileToPath", window.client.cancelDownloadFileToPath({
                  taskId: cancelTaskId
                }), 5000);
                const cancelledDownload = await withTimeout("cancelledDownload", pendingDownload, 8000);
                files.cancelOk = !!cancelResult &&
                  cancelResult.isSuccess === true &&
                  !!cancelledDownload &&
                  cancelledDownload.isSuccess === false &&
                  cancelledDownload.message === "cancelled";

                files.steps.push("uploadFile");
                const uploadBase64 = btoa(uploadText);
                const uploadResult = await withTimeout("uploadFile", window.client.uploadFile({
                  url: baseUrl + "/upload",
                  base64Img: uploadBase64,
                  fileName: "file-smoke.txt",
                  formFileName: "file",
                  data: {
                    meta: "file-smoke-meta"
                  },
                  headers: {},
                  axiosParamsTimeout: 5000
                }), 8000);
                files.uploadOk = !!uploadResult &&
                  !uploadResult.error &&
                  !!uploadResult.data &&
                  uploadResult.data.ok === true &&
                  uploadResult.data.hasFile === true &&
                  uploadResult.data.hasMeta === true;

                files.steps.push("openPathInExplorerMissing");
                const missingExplorer = await withTimeout("openPathInExplorerMissing", window.client.openPathInExplorer({
                  path: tmpRoot + "\\\\missing-" + suffix
                }), 5000);
                files.missingExplorerOk = !!missingExplorer &&
                  missingExplorer.isSuccess === false &&
                  typeof missingExplorer.message === "string";
              } catch (error) {
                files.errors.push(error && error.message ? error.message : String(error));
              }
            }

            result.filesOk = files.saveBufferOk &&
              files.downloadOk &&
              files.cancelOk &&
              files.uploadOk &&
              files.missingExplorerOk;
            result.files = files;
            resolve(result);
            return;
          }

          const bridge = {
            attempted: false,
            appInfoOk: false,
            mainWindowOk: false,
            allWindowsOk: false,
            windowStateOk: false,
            logDirOk: false,
            childWindowOk: false,
            steps: [],
            errors: []
          };

          if (hasShell && hasClient && methodCount >= 30) {
            bridge.attempted = true;
            let childId = null;
            try {
              bridge.steps.push("getAppInfo");
              const appInfo = await withTimeout("getAppInfo", window.client.getAppInfo());
              bridge.appInfoOk = !!appInfo &&
                typeof appInfo.version === "string" &&
                typeof appInfo.index === "string" &&
                appInfo.index.length > 0;

              bridge.steps.push("getMainWindowInfo");
              const mainInfo = await withTimeout("getMainWindowInfo", window.client.getMainWindowInfo());
              bridge.mainWindowOk = !!mainInfo &&
                Number.isInteger(mainInfo.winId) &&
                !!mainInfo.winBounds;

              bridge.steps.push("getAllBrowserWindowInfos");
              const allWindows = await withTimeout("getAllBrowserWindowInfos", window.client.getAllBrowserWindowInfos());
              bridge.allWindowsOk = Array.isArray(allWindows) &&
                allWindows.some((item) => item && item.id === mainInfo.winId);

              bridge.steps.push("windowState");
              const maximized = await withTimeout("isWindowMaximized", window.client.isWindowMaximized({ winId: mainInfo.winId }));
              const missingDestroyed = await withTimeout("isWindowDestroyed", window.client.isWindowDestroyed({ winId: -999999 }));
              bridge.windowStateOk = typeof maximized === "boolean" && missingDestroyed === true;

              bridge.steps.push("getCrashLogDir");
              const logDir = await withTimeout("getCrashLogDir", window.client.getCrashLogDir());
              bridge.logDirOk = typeof logDir === "string" && logDir.length > 0;

              const smokeUrl = "data:text/html;charset=utf-8," + encodeURIComponent(
                '<!doctype html><html><head><title>xzb smoke child</title></head><body><main id="ok">child</main></body></html>'
              );
              bridge.steps.push("openWindow");
              childId = await withTimeout("openWindow", window.client.openWindow({
                url: smokeUrl,
                isNotShow: true,
                width: 320,
                height: 200,
                title: "XZB Smoke Child",
                devTools: false
              }), 4000);
              bridge.steps.push("getBrowserWindowInfo");
              const childInfo = await withTimeout("getBrowserWindowInfo", window.client.getBrowserWindowInfo({ winId: childId }));
              bridge.steps.push("executeJavaScriptBrowserWindow");
              const childEval = await withTimeout("executeJavaScriptBrowserWindow", window.client.executeJavaScriptBrowserWindow({
                winId: childId,
                jsContent: 'document.title + ":" + document.getElementById("ok").textContent',
                timeoutMs: 3000
              }), 4000);
              bridge.steps.push("destroyBrowserWindow");
              await withTimeout("destroyBrowserWindow", window.client.destroyBrowserWindow({ winId: childId }));
              await sleep(50);
              bridge.steps.push("childDestroyed");
              const childDestroyed = await withTimeout("childDestroyed", window.client.isWindowDestroyed({ winId: childId }));
              bridge.childWindowOk = Number.isInteger(childId) &&
                !!childInfo &&
                typeof childInfo.currentUrl === "string" &&
                childInfo.currentUrl.startsWith("data:text/html") &&
                childEval === "xzb smoke child:child" &&
                childDestroyed === true;
            } catch (error) {
              bridge.errors.push(error && error.message ? error.message : String(error));
            } finally {
              if (childId && !bridge.childWindowOk) {
                try {
                  await window.client.destroyBrowserWindow({ winId: childId });
                } catch {}
              }
            }
          }

          const bridgeOk = bridge.appInfoOk &&
            bridge.mainWindowOk &&
            bridge.allWindowsOk &&
            bridge.windowStateOk &&
            bridge.logDirOk &&
            bridge.childWindowOk;

          resolve({
            ...result,
            bridgeOk,
            bridge
          });
        }))()
      `),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("smoke probe executeJavaScript timeout")), probeTimeoutMs);
        })
      ]);

      lastProbeResult = result;
      const scenarioOk =
        scenario === "cookie" ? result.cookieOk :
        scenario === "http" ? result.httpOk :
        scenario === "db" ? result.dbOk :
        scenario === "files" ? result.filesOk :
        result.bridgeOk;
      const ok = result.hasShell && result.hasClient && result.methodCount >= 30 && scenarioOk;
      if (ok) {
        clearTimeout(timer);
        finish(0, result);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearTimeout(timer);
        finish(1, result);
        return;
      }
    } catch (error) {
      lastProbeError = error && error.message ? error.message : String(error);
      if (Date.now() - startedAt >= timeoutMs) {
        clearTimeout(timer);
        finish(1, {
          reason: "executeJavaScript failed",
          message: lastProbeError,
          url: win.webContents.getURL()
        });
        return;
      }
    } finally {
      probing = false;
    }

    scheduleProbe(200);
  };

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return;
    clearTimeout(timer);
    finish(1, { reason: "did-fail-load", errorCode, errorDescription, url: validatedURL });
  });

  win.webContents.on("did-finish-load", () => scheduleProbe(50));
  win.webContents.on("did-navigate", () => scheduleProbe(50));
  win.webContents.on("did-navigate-in-page", () => scheduleProbe(50));
  scheduleProbe(200);
}

function registerMainWindowHandlers() {
  ipcMain.handle("getMainWindowInfo", async () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    return {
      winId: win.id,
      winBounds: win.getBounds(),
      isMaximized: win.isMaximized(),
      isMinimized: win.isMinimized(),
      isFullScreen: win.isFullScreen(),
      isFocused: win.isFocused(),
      isDestroyed: win.isDestroyed(),
      isClosable: win.isClosable(),
      isModal: win.isModal(),
      isMovable: win.isMovable(),
      isResizable: win.isResizable(),
      isAlwaysOnTop: win.isAlwaysOnTop(),
      isFullScreenable: win.isFullScreenable(),
      isSimpleFullScreen: win.isSimpleFullScreen(),
      isKiosk: win.isKiosk(),
      isDocumentEdited: win.isDocumentEdited(),
      isMenuBarAutoHide: win.isMenuBarAutoHide(),
      isMenuBarVisible: win.isMenuBarVisible()
    };
  });

  ipcMain.handle("reloadHomeUrl", async (_event, args = {}) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;

    if (args.isDev && args.file) {
      return win.loadFile(path.resolve(args.file));
    }

    return win.loadURL(args.url || HOME_INDEX_URL);
  });

  ipcMain.handle("resetMainWindow", async (_event, args = {}) => {
    const nextWindow = BrowserWindow.fromId(args.winId);
    if (!nextWindow) return { error: "找不到窗口" };
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.id !== nextWindow.id) {
      mainWindow.close();
      mainWindow.destroy();
    }
    mainWindow = nextWindow;
    global.mainWindow = mainWindow;
    return { ok: true, winId: mainWindow.id };
  });

  ipcMain.handle("minimizeWindow", async (_event, args = {}) => {
    const win = BrowserWindow.fromId(args.winId) || getMainWindow();
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.handle("maximizeWindow", async (_event, args = {}) => {
    const win = BrowserWindow.fromId(args.winId) || getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle("closeWindow", async (_event, args = {}) => {
    const win = BrowserWindow.fromId(args.winId || args.closeId) || getMainWindow();
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.handle("isWindowMaximized", async (_event, args = {}) => {
    const win = BrowserWindow.fromId(args.winId) || getMainWindow();
    return win && !win.isDestroyed() ? win.isMaximized() : false;
  });

  ipcMain.handle("isWindowDestroyed", async (_event, args = {}) => {
    const win = BrowserWindow.fromId(args.winId);
    return !win || win.isDestroyed();
  });
}

installSchemeBlocker(app, protocol);

if (process.platform === "win32") {
  app.setAppUserModelId(APP_TITLE);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized() || !mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerMainWindowHandlers();
    registerIpcHandlers({ getMainWindow });
    createMainWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
