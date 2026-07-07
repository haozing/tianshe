const { app } = require("electron");

function installSmokeCheck(win) {
  if (process.env.CHIHU_E2E_SMOKE !== "1") return;

  const scenario = process.env.CHIHU_E2E_SMOKE_SCENARIO || "bridge";
  const timeoutMs = Number(process.env.CHIHU_E2E_TIMEOUT_MS || 15000);
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
          const isCleanFoundationShell = () => {
            const shell = document.querySelector('[data-foundation-shell="ready"]');
            const clientShell = document.querySelector('[data-client-shell="ready"]');
            const text = document.body ? document.body.innerText : "";
            return Boolean(shell) && (
              (text.includes("New Remote Web") && text.includes("Bridge")) ||
              Boolean(clientShell)
            );
          };

          while (Date.now() < deadline) {
            const hasShell = isCleanFoundationShell();
            const hasClient = !!window.client;
            const methodCount = hasClient ? Object.keys(window.client).length : 0;
            if (hasShell && hasClient && methodCount >= 30) break;
            await sleep(100);
          }

          const text = document.body ? document.body.innerText : "";
          const hasShell = isCleanFoundationShell();
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
              const sourcePartition = "persist:chihu-smoke-cookie-source-" + suffix;
              const targetPartition = "persist:chihu-smoke-cookie-target-" + suffix;
              const name = "chihu_smoke_cookie_" + suffix.replace(/[^a-z0-9]/gi, "_");
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
              const baseUrl = ${JSON.stringify(process.env.CHIHU_E2E_HTTP_BASE_URL || "")};
              const expectedBase64 = ${JSON.stringify(process.env.CHIHU_E2E_HTTP_EXPECTED_BASE64 || "")};
              const suffix = Date.now() + "-" + Math.random().toString(16).slice(2);
              const partition = "persist:chihu-smoke-http-" + suffix;
              const cookieName = "chihu_http_smoke_" + suffix.replace(/[^a-z0-9]/gi, "_");
              const cookieValue = "cookie-" + suffix;

              try {
                if (!baseUrl) throw new Error("missing CHIHU_E2E_HTTP_BASE_URL");

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
              const nedbName = "chihu_smoke_nedb_" + suffix;
              const sqliteName = "chihu_smoke_sqlite_" + suffix;
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
              const baseUrl = ${JSON.stringify(process.env.CHIHU_E2E_HTTP_BASE_URL || "")};
              const downloadBody = ${JSON.stringify(process.env.CHIHU_E2E_FILE_DOWNLOAD_BODY || "")};
              const uploadText = ${JSON.stringify(process.env.CHIHU_E2E_UPLOAD_TEXT || "")};
              const suffix = Date.now() + "_" + Math.random().toString(16).slice(2).replace(/[^a-z0-9_]/gi, "");
              const tmpRoot = ${JSON.stringify(process.env.CHIHU_USER_DATA_DIR || "")} || ".";
              const savePath = tmpRoot + "\\\\file-smoke-save-" + suffix + ".txt";
              const downloadPath = tmpRoot + "\\\\file-smoke-download-" + suffix + ".txt";
              const cancelPath = tmpRoot + "\\\\file-smoke-cancel-" + suffix + ".txt";

              try {
                if (!baseUrl) throw new Error("missing CHIHU_E2E_HTTP_BASE_URL");

                files.steps.push("saveBufferToPath");
                const saveResult = await withTimeout("saveBufferToPath", window.client.saveBufferToPath({
                  destPath: savePath,
                  buffer: "chihu-file-save-" + suffix
                }), 5000);
                const savedRead = await withTimeout("readSavedText", fetch(baseUrl + "/read-file?path=" + encodeURIComponent(savePath)).then((response) => response.json()), 5000);
                files.saveBufferOk = !!saveResult &&
                  saveResult.isSuccess === true &&
                  !!savedRead &&
                  savedRead.text === "chihu-file-save-" + suffix;

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

          if (result.scenario === "logs") {
            const logs = {
              attempted: false,
              notificationOk: false,
              reportOk: false,
              readLogOk: false,
              cleanupKeepTodayOk: false,
              cleanupRemoveTodayOk: false,
              steps: [],
              errors: []
            };

            if (hasShell && hasClient && methodCount >= 30) {
              logs.attempted = true;
              const baseUrl = ${JSON.stringify(process.env.CHIHU_E2E_HTTP_BASE_URL || "")};
              const suffix = Date.now() + "_" + Math.random().toString(16).slice(2).replace(/[^a-z0-9_]/gi, "");
              const eventName = "chihu_smoke_notification_" + suffix;

              try {
                if (!baseUrl) throw new Error("missing CHIHU_E2E_HTTP_BASE_URL");

                logs.steps.push("sendNotification");
                const notificationPromise = new Promise((resolve) => {
                  const timer = setTimeout(() => resolve(null), 3000);
                  window.addEventListener(eventName, (event) => {
                    clearTimeout(timer);
                    resolve(event.detail || null);
                  }, { once: true });
                });
                const notificationResult = await withTimeout("sendNotification", window.client.sendNotification({
                  title: "Smoke Notification",
                  body: "logs smoke",
                  chihu_event_name: eventName,
                  smokeId: suffix,
                  chihu_e2e_auto_emit: true,
                  chihu_e2e_skip_show: true
                }), 5000);
                const notificationDetail = await withTimeout("notificationEvent", notificationPromise, 5000);
                logs.notificationOk = !!notificationResult &&
                  notificationResult.ok === true &&
                  !!notificationDetail &&
                  notificationDetail.smokeId === suffix &&
                  notificationDetail.chihu_event_name === eventName;

                logs.steps.push("reportClientLog");
                const logPayload = {
                  smokeId: suffix,
                  nested: { ok: true },
                  token: "secret-token-should-redact"
                };
                const reportResult = await withTimeout("reportClientLog", window.client.reportClientLog(logPayload), 5000);
                logs.reportOk = !!reportResult &&
                  reportResult.ok === true &&
                  typeof reportResult.logDir === "string" &&
                  reportResult.logDir.length > 0;

                logs.steps.push("getCrashLogDir");
                const logDir = await withTimeout("getCrashLogDir", window.client.getCrashLogDir(), 5000);
                const today = new Date();
                const todayName = "crash-" + today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0") + ".log";
                const todayPath = logDir + "\\\\" + todayName;
                const todayRead = await withTimeout("readTodayLog", fetch(baseUrl + "/read-file?path=" + encodeURIComponent(todayPath)).then((response) => response.json()), 5000);
                logs.readLogOk = !!todayRead &&
                  todayRead.ok === true &&
                  typeof todayRead.text === "string" &&
                  todayRead.text.includes(suffix) &&
                  todayRead.text.includes("[RENDERER]");

                logs.steps.push("cleanupKeepToday");
                const oldPath = logDir + "\\\\crash-2000-01-01.log";
                const oldWrite = await withTimeout("writeOldLog", fetch(baseUrl + "/write-file?path=" + encodeURIComponent(oldPath) + "&text=old").then((response) => response.json()), 5000);
                const cleanupKeep = await withTimeout("cleanCrashLogsKeepToday", window.client.cleanCrashLogs(true), 5000);
                const listedAfterKeep = await withTimeout("listLogsAfterKeep", fetch(baseUrl + "/list-dir?path=" + encodeURIComponent(logDir)).then((response) => response.json()), 5000);
                logs.cleanupKeepTodayOk = !!oldWrite &&
                  oldWrite.ok === true &&
                  !!cleanupKeep &&
                  cleanupKeep.removed >= 1 &&
                  !!listedAfterKeep &&
                  Array.isArray(listedAfterKeep.entries) &&
                  listedAfterKeep.entries.includes(todayName) &&
                  !listedAfterKeep.entries.includes("crash-2000-01-01.log");

                logs.steps.push("cleanupRemoveToday");
                const cleanupAll = await withTimeout("cleanCrashLogsAll", window.client.cleanCrashLogs(false), 5000);
                const listedAfterAll = await withTimeout("listLogsAfterAll", fetch(baseUrl + "/list-dir?path=" + encodeURIComponent(logDir)).then((response) => response.json()), 5000);
                logs.cleanupRemoveTodayOk = !!cleanupAll &&
                  cleanupAll.removed >= 1 &&
                  !!listedAfterAll &&
                  Array.isArray(listedAfterAll.entries) &&
                  !listedAfterAll.entries.includes(todayName);
              } catch (error) {
                logs.errors.push(error && error.message ? error.message : String(error));
              }
            }

            result.logsOk = logs.notificationOk &&
              logs.reportOk &&
              logs.readLogOk &&
              logs.cleanupKeepTodayOk &&
              logs.cleanupRemoveTodayOk;
            result.logs = logs;
            resolve(result);
            return;
          }

          if (result.scenario === "ui-contract") {
            const ui = {
              attempted: false,
              selectDirectoryOk: false,
              openExistingDirectoryOk: false,
              openExistingFileOk: false,
              notificationContractOk: false,
              steps: [],
              errors: []
            };

            if (hasShell && hasClient && methodCount >= 30) {
              ui.attempted = true;
              const baseUrl = ${JSON.stringify(process.env.CHIHU_E2E_HTTP_BASE_URL || "")};
              const suffix = Date.now() + "_" + Math.random().toString(16).slice(2).replace(/[^a-z0-9_]/gi, "");
              const tmpRoot = ${JSON.stringify(process.env.CHIHU_USER_DATA_DIR || "")} || ".";
              const selectedPath = tmpRoot + "\\\\selected-" + suffix;
              const existingDir = tmpRoot + "\\\\explorer-dir-" + suffix;
              const existingFile = existingDir + "\\\\explorer-file.txt";
              const eventName = "chihu_ui_contract_notification_" + suffix;

              try {
                if (!baseUrl) throw new Error("missing CHIHU_E2E_HTTP_BASE_URL");

                ui.steps.push("selectDirectoryMock");
                const selected = await withTimeout("selectDirectoryMock", window.client.selectDirectory({
                  chihu_e2e_mock_path: selectedPath
                }), 5000);
                ui.selectDirectoryOk = !!selected &&
                  selected.canceled === false &&
                  selected.path === selectedPath &&
                  selected.e2e === true;

                ui.steps.push("prepareExistingPaths");
                const writeExisting = await withTimeout("writeExistingFile", fetch(baseUrl + "/write-file?path=" + encodeURIComponent(existingFile) + "&text=ui-contract").then((response) => response.json()), 5000);
                if (!writeExisting || writeExisting.ok !== true) throw new Error("failed to prepare existing file");

                ui.steps.push("openPathInExplorerDirectoryDryRun");
                const openDir = await withTimeout("openPathInExplorerDirectoryDryRun", window.client.openPathInExplorer({
                  path: existingDir,
                  chihu_e2e_dry_run: true
                }), 5000);
                ui.openExistingDirectoryOk = !!openDir &&
                  openDir.isSuccess === true &&
                  openDir.e2e === true &&
                  openDir.targetType === "directory";

                ui.steps.push("openPathInExplorerFileDryRun");
                const openFile = await withTimeout("openPathInExplorerFileDryRun", window.client.openPathInExplorer({
                  path: existingFile,
                  chihu_e2e_dry_run: true
                }), 5000);
                ui.openExistingFileOk = !!openFile &&
                  openFile.isSuccess === true &&
                  openFile.e2e === true &&
                  openFile.targetType === "file";

                ui.steps.push("notificationContract");
                const notificationPromise = new Promise((resolve) => {
                  const timer = setTimeout(() => resolve(null), 3000);
                  window.addEventListener(eventName, (event) => {
                    clearTimeout(timer);
                    resolve(event.detail || null);
                  }, { once: true });
                });
                const notificationResult = await withTimeout("notificationContractResult", window.client.sendNotification({
                  title: "UI Contract Notification",
                  body: "ui contract smoke",
                  subtitle: "contract",
                  urgency: "normal",
                  timeoutType: "default",
                  chihu_event_name: eventName,
                  smokeId: suffix,
                  chihu_e2e_auto_emit: true,
                  chihu_e2e_skip_show: true
                }), 5000);
                const notificationDetail = await withTimeout("notificationContractEvent", notificationPromise, 5000);
                ui.notificationContractOk = !!notificationResult &&
                  notificationResult.ok === true &&
                  notificationResult.e2e === true &&
                  !!notificationDetail &&
                  notificationDetail.smokeId === suffix &&
                  notificationDetail.chihu_event_name === eventName &&
                  notificationDetail.subtitle === "contract";
              } catch (error) {
                ui.errors.push(error && error.message ? error.message : String(error));
              }
            }

            result.uiContractOk = ui.selectDirectoryOk &&
              ui.openExistingDirectoryOk &&
              ui.openExistingFileOk &&
              ui.notificationContractOk;
            result.uiContract = ui;
            resolve(result);
            return;
          }

          if (result.scenario === "maintenance") {
            const maintenance = {
              attempted: false,
              partitionsSetupOk: false,
              cleanInvalidPartitionsOk: false,
              versionInfoOk: false,
              steps: [],
              errors: []
            };

            if (hasShell && hasClient && methodCount >= 30) {
              maintenance.attempted = true;
              const baseUrl = ${JSON.stringify(process.env.CHIHU_E2E_HTTP_BASE_URL || "")};
              const tmpRoot = ${JSON.stringify(process.env.CHIHU_USER_DATA_DIR || "")} || ".";
              const suffix = Date.now() + "_" + Math.random().toString(16).slice(2).replace(/[^a-z0-9_]/gi, "");
              const validPartition = "chihu-maint-valid-" + suffix;
              const invalidPartition = "chihu-maint-invalid-" + suffix;
              const ignoredPartition = "other-maint-ignored-" + suffix;
              const partitionsRoot = tmpRoot + "\\\\Partitions";

              try {
                if (!baseUrl) throw new Error("missing CHIHU_E2E_HTTP_BASE_URL");

                maintenance.steps.push("setupPartitions");
                const writeValid = await withTimeout("writeValidPartition", fetch(baseUrl + "/write-file?path=" + encodeURIComponent(partitionsRoot + "\\\\" + validPartition + "\\\\marker.txt") + "&text=valid").then((response) => response.json()), 5000);
                const writeInvalid = await withTimeout("writeInvalidPartition", fetch(baseUrl + "/write-file?path=" + encodeURIComponent(partitionsRoot + "\\\\" + invalidPartition + "\\\\marker.txt") + "&text=invalid").then((response) => response.json()), 5000);
                const writeIgnored = await withTimeout("writeIgnoredPartition", fetch(baseUrl + "/write-file?path=" + encodeURIComponent(partitionsRoot + "\\\\" + ignoredPartition + "\\\\marker.txt") + "&text=ignored").then((response) => response.json()), 5000);
                maintenance.partitionsSetupOk = !!writeValid && writeValid.ok === true &&
                  !!writeInvalid && writeInvalid.ok === true &&
                  !!writeIgnored && writeIgnored.ok === true;

                maintenance.steps.push("cleanInvalidPartitions");
                const cleanResult = await withTimeout("cleanInvalidPartitions", window.client.cleanInvalidPartitions({
                  currentPartitons: ["persist:" + validPartition],
                  prefixes: ["chihu-maint-"]
                }), 8000);
                const listedPartitions = await withTimeout("listPartitions", fetch(baseUrl + "/list-dir?path=" + encodeURIComponent(partitionsRoot)).then((response) => response.json()), 5000);
                maintenance.cleanInvalidPartitionsOk = !!cleanResult &&
                  Array.isArray(cleanResult.deleted) &&
                  cleanResult.deleted.includes(invalidPartition) &&
                  !cleanResult.deleted.includes(validPartition) &&
                  !!listedPartitions &&
                  Array.isArray(listedPartitions.entries) &&
                  listedPartitions.entries.includes(validPartition) &&
                  listedPartitions.entries.includes(ignoredPartition) &&
                  !listedPartitions.entries.includes(invalidPartition);

                maintenance.steps.push("getClientVersionData");
                const versionData = await withTimeout("getClientVersionData", window.client.getClientVersionData(), 10000);
                maintenance.versionInfoOk = !!versionData &&
                  typeof versionData.isNewVersion === "boolean" &&
                  typeof versionData.currentVersion === "string" &&
                  versionData.currentVersion.length > 0 &&
                  typeof versionData.newVersion === "string" &&
                  versionData.newVersion.length > 0;
              } catch (error) {
                maintenance.errors.push(error && error.message ? error.message : String(error));
              }
            }

            result.maintenanceOk = maintenance.partitionsSetupOk &&
              maintenance.cleanInvalidPartitionsOk &&
              maintenance.versionInfoOk;
            result.maintenance = maintenance;
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
            storesListOk: false,
            childWindowOk: false,
            chihuDataMirrorOk: true,
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
                appInfo.index.length > 0 &&
                typeof appInfo.title === "string" &&
                appInfo.title.length > 0 &&
                (appInfo.appName === "赤狐管家" || appInfo.name === "赤狐管家") &&
                appInfo.windowConfig &&
                appInfo.windowConfig.defaultWidth >= 1280 &&
                appInfo.windowConfig.defaultHeight >= 800 &&
                appInfo.windowConfig.resizable === true;

              bridge.steps.push("getMainWindowInfo");
              const mainInfo = await withTimeout("getMainWindowInfo", window.client.getMainWindowInfo());
              bridge.mainWindowOk = !!mainInfo &&
                Number.isInteger(mainInfo.winId) &&
                typeof mainInfo.title === "string" &&
                mainInfo.title.length > 0 &&
                !!mainInfo.winBounds &&
                mainInfo.winBounds.width >= 1280 &&
                mainInfo.winBounds.height >= 800 &&
                Array.isArray(mainInfo.minSize) &&
                mainInfo.minSize[0] >= 1024 &&
                mainInfo.minSize[1] >= 680 &&
                mainInfo.isResizable === true;

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

              bridge.steps.push("storesList");
              const storesResult = await withTimeout("storesList", window.client.storesList());
              bridge.storesListOk = !!storesResult &&
                storesResult.ok === true &&
                Array.isArray(storesResult.stores);

              if (window.chihuBridge && window.chihuBridge.chihuData) {
                bridge.steps.push("chihuDataMirror");
                await sleep(500);
                const mirrorResult = await withTimeout("chihuDataMirrorInspect", window.chihuBridge.chihuData.inspect([
                  "chihu20_meta",
                  "chihu20_preferences",
                  "chihu20_config_cache",
                  "chihu20_diagnostics"
                ]), 5000);
                const mirroredRows = await withTimeout("chihuDataMirrorRows", window.client._db({
                  dbName: "chihu20_runtime",
                  cmd: "findLimit",
                  query: { source: "new-remote-web" },
                  sort: { updatedAt: -1 },
                  skip: 0,
                  limit: 20
                }), 5000);
                const mirroredKeys = Array.isArray(mirroredRows) ? mirroredRows.map((row) => row && row.id).filter(Boolean) : [];
                bridge.chihuDataMirrorOk = !!mirrorResult &&
                  mirrorResult.ok === true &&
                  mirrorResult.dbName === "chihu20_runtime" &&
                  ["chihu20_meta", "chihu20_preferences", "chihu20_config_cache", "chihu20_diagnostics"].every((key) => mirroredKeys.includes(key));
                bridge.chihuDataMirror = {
                  status: mirrorResult && mirrorResult.status,
                  presentKeys: mirrorResult && mirrorResult.presentKeys || [],
                  missingKeys: mirrorResult && mirrorResult.missingKeys || [],
                  rowCount: Array.isArray(mirroredRows) ? mirroredRows.length : 0
                };
              }

              const smokeUrl = location.href;
              bridge.steps.push("openWindow");
              childId = await withTimeout("openWindow", window.client.openWindow({
                url: smokeUrl,
                isNotShow: true,
                width: 320,
                height: 200,
                title: "CHIHU Smoke Child",
                devTools: false
              }), 8000);
              bridge.steps.push("getBrowserWindowInfo");
              const childInfo = await withTimeout("getBrowserWindowInfo", window.client.getBrowserWindowInfo({ winId: childId }));
              bridge.steps.push("executeJavaScriptBrowserWindow");
              const childEval = await withTimeout("executeJavaScriptBrowserWindow", window.client.executeJavaScriptBrowserWindow({
                winId: childId,
                jsContent: 'document.body ? "ready" : "missing"',
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
                childInfo.currentUrl.includes("/new-remote-web/") &&
                childEval === "ready" &&
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
            bridge.storesListOk &&
            bridge.childWindowOk &&
            bridge.chihuDataMirrorOk;

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
        scenario === "logs" ? result.logsOk :
        scenario === "ui-contract" ? result.uiContractOk :
        scenario === "maintenance" ? result.maintenanceOk :
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


module.exports = { installSmokeCheck };
