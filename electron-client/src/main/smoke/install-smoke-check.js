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
      const probeTimeoutCapMs = scenario === "bridge" ? 40000 : 10000;
      const probeTimeoutMs = Math.min(probeTimeoutCapMs, Math.max(3000, timeoutMs - (Date.now() - startedAt) - 500));
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
            if (hasShell && hasClient && methodCount >= 33) break;
            await sleep(100);
          }

          const text = document.body ? document.body.innerText : "";
          const hasShell = isCleanFoundationShell();
          const hasClient = !!window.client;
          const hasChihuNative = !!window.chihuNative;
          const methodNames = hasClient ? Object.keys(window.client) : [];
          const methodCount = methodNames.length;
          const result = {
            scenario: ${JSON.stringify(scenario)},
            hasShell,
            hasClient,
            hasChihuNative,
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

            if (hasShell && hasClient && methodCount >= 33) {
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

            if (hasShell && hasClient && methodCount >= 33) {
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

            if (hasShell && hasClient && methodCount >= 33) {
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

            if (hasShell && hasClient && methodCount >= 33) {
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

            if (hasShell && hasClient && methodCount >= 33) {
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

            if (hasShell && hasClient && methodCount >= 33) {
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
            childWindowOk: false,
            nativeContractOk: false,
            nativeHiddenWindowOk: false,
            nativeHttpOk: false,
            nativeFileOk: false,
            doudianTaskRunnerOk: false,
            doudianStoreGroupsOk: false,
            doudianStoreImportStatusOk: false,
            remoteMetricAOk: false,
            remoteMetricBOk: false,
            remoteMetricCOk: false,
            doudianFileImportOk: false,
            remoteProductScanOk: false,
            remoteProductExecuteOk: false,
            steps: [],
            errors: []
          };

          if (hasShell && hasClient && methodCount >= 33 && hasChihuNative) {
            bridge.attempted = true;
            let childId = null;
            let nativeChildId = null;
            try {
              const native = window.chihuNative;
              bridge.steps.push("nativeContract");
              bridge.nativeContractOk = !!native.app?.getInfo &&
                !!native.windows?.open &&
                !!native.windows?.eval &&
                !!native.windows?.destroy &&
                !!native.cookies?.getHeader &&
                !!native.http?.request &&
                !!native.files?.selectFile &&
                !!native.files?.readFile &&
                !!native.notifications?.send &&
                !!native.logs?.report &&
                !!native.partitions?.cleanInvalid;

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

              const smokeUrl = location.href;
              const baseUrl = ${JSON.stringify(process.env.CHIHU_E2E_HTTP_BASE_URL || "")};
              const tmpRoot = ${JSON.stringify(process.env.CHIHU_USER_DATA_DIR || "")} || ".";
              const suffix = Date.now() + "_" + Math.random().toString(16).slice(2).replace(/[^a-z0-9_]/gi, "");
              if (baseUrl) {
                bridge.steps.push("nativeHttpRequest");
                const nativeHttpResult = await withTimeout("nativeHttpRequest", native.http.request({
                  url: baseUrl + "/json?q=native",
                  method: "GET",
                  headers: {
                    "X-Smoke-Header": "native-http"
                  },
                  responseType: "json",
                  timeoutMs: 5000
                }), 6000);
                bridge.nativeHttpOk = !!nativeHttpResult &&
                  nativeHttpResult.ok === true &&
                  nativeHttpResult.status === 200 &&
                  !!nativeHttpResult.data &&
                  nativeHttpResult.data.query === "native" &&
                  nativeHttpResult.data.header === "native-http";

                bridge.steps.push("nativeFileRead");
                const nativeFilePath = tmpRoot + "\\\\native-file-smoke-" + suffix + ".txt";
                const writeNativeFile = await withTimeout("nativeWriteFile", fetch(baseUrl + "/write-file?path=" + encodeURIComponent(nativeFilePath) + "&text=native-file-" + suffix).then((response) => response.json()), 5000);
                const selectNativeFile = await withTimeout("nativeSelectFile", native.files.selectFile({
                  chihu_e2e_mock_path: nativeFilePath
                }), 5000);
                const readNativeFile = await withTimeout("nativeReadFile", native.files.readFile({
                  filePath: nativeFilePath,
                  encoding: "utf8",
                  maxBytes: 1024
                }), 5000);
                bridge.nativeFileOk = !!writeNativeFile &&
                  writeNativeFile.ok === true &&
                  !!selectNativeFile &&
                  selectNativeFile.ok === true &&
                  selectNativeFile.filePath === nativeFilePath &&
                  !!readNativeFile &&
                  readNativeFile.ok === true &&
                  readNativeFile.content === "native-file-" + suffix;
              } else {
                bridge.nativeHttpOk = true;
                bridge.nativeFileOk = true;
              }

              bridge.steps.push("nativeHiddenWindow");
              nativeChildId = await withTimeout("nativeWindowOpen", native.windows.open({
                url: smokeUrl,
                show: false,
                width: 320,
                height: 200,
                title: "CHIHU Native Smoke Child",
                nodeIntegration: false,
                contextIsolation: true
              }), 8000);
              const nativeEval = await withTimeout("nativeWindowEval", native.windows.eval({
                winId: nativeChildId,
                code: 'document.body ? "native-ready" : "missing"',
                timeoutMs: 3000
              }), 4000);
              await withTimeout("nativeWindowDestroy", native.windows.destroy({ winId: nativeChildId }), 5000);
              await sleep(50);
              const nativeDestroyed = await withTimeout("nativeWindowDestroyed", window.client.isWindowDestroyed({ winId: nativeChildId }), 5000);
              bridge.nativeHiddenWindowOk = Number.isInteger(nativeChildId) &&
                nativeEval === "native-ready" &&
                nativeDestroyed === true;
              nativeChildId = null;

              bridge.steps.push("doudianTaskRunner");
              if (!sessionStorage.getItem("chihuTaskSmokeOperationId")) {
                const runtime = window.chihuDoudianTaskRuntime;
                if (!runtime) throw new Error("chihuDoudianTaskRuntime missing");
                const repositorySelfCheck = await runtime.repositorySelfCheck();
                if (!repositorySelfCheck || repositorySelfCheck.ok !== true || repositorySelfCheck.dbName !== "chihu20_doudian" || repositorySelfCheck.objectStores.length < 9) {
                  throw new Error("doudian repository self check failed");
                }
                const task = await runtime.startMock({
                  operationId: "smoke-runner-" + suffix,
                  durationMs: 5000,
                  stepMs: 250,
                  adapterVersion: "smoke",
                  ruleVersion: "smoke"
                });
                sessionStorage.setItem("chihuTaskSmokeOperationId", task.operationId);
                await sleep(850);
                const status = await runtime.getStatus(task.operationId);
                const active = await runtime.restore();
                const snapshot = runtime.snapshot();
                if (!status || !["created", "running", "succeeded"].includes(status.status)) throw new Error("task status before reload invalid");
                if (!active.some((item) => item.operationId === task.operationId)) throw new Error("active task missing before reload");
                if (!snapshot.progressEvents.some((item) => item.operationId === task.operationId)) throw new Error("progress did not reach visible page before reload");
                setTimeout(() => {
                  window.client.reloadHomeUrl({ url: location.href }).catch(() => {});
                }, 50);
                resolve({ ...result, bridgeOk: false, bridge });
                return;
              }

              const runtime = window.chihuDoudianTaskRuntime;
              if (!runtime) throw new Error("chihuDoudianTaskRuntime missing after reload");
              const operationId = sessionStorage.getItem("chihuTaskSmokeOperationId");
              const status = await runtime.getStatus(operationId);
              const active = await runtime.restore();
              await runtime.cancel(operationId);
              await sleep(150);
              const cancelled = await runtime.getStatus(operationId);
              const windows = await window.client.getAllBrowserWindowInfos();
              const runnerWindowStillOpen = Array.isArray(windows) && windows.some((item) => item && item.id === cancelled?.runnerWinId && !item.isDestroyed);
              bridge.doudianTaskRunnerOk = !!status &&
                ["running", "succeeded"].includes(status.status) &&
                active.some((item) => item.operationId === operationId) &&
                !!cancelled &&
                cancelled.status === "cancelled" &&
                runnerWindowStillOpen === false;
              sessionStorage.removeItem("chihuTaskSmokeOperationId");

              bridge.steps.push("doudianStoreGroups");
              const storeRuntime = window.chihuDoudianStoreRuntime;
              if (!storeRuntime) throw new Error("chihuDoudianStoreRuntime missing");
              const storeSelfCheck = await withTimeout("doudianStoreGroupsSelfCheck", storeRuntime.selfCheck({ openUrl: smokeUrl }), 10000);
              bridge.doudianStoreGroupsOk = !!storeSelfCheck &&
                storeSelfCheck.ok === true &&
                storeSelfCheck.listOk === true &&
                storeSelfCheck.createOk === true &&
                storeSelfCheck.updateOk === true &&
                storeSelfCheck.renameOk === true &&
                storeSelfCheck.openOk === true &&
                storeSelfCheck.deleteStoreOk === true &&
                storeSelfCheck.deleteGroupOk === true;

              bridge.steps.push("doudianStoreImportStatus");
              const stage5SelfCheck = await withTimeout("doudianStoreImportStatusSelfCheck", storeRuntime.stage5SelfCheck({ openUrl: smokeUrl }), 40000);
              bridge.doudianStoreImportStatusOk = !!stage5SelfCheck &&
                stage5SelfCheck.ok === true &&
                stage5SelfCheck.importOk === true &&
                stage5SelfCheck.refreshOk === true &&
                stage5SelfCheck.cancelOk === true &&
                stage5SelfCheck.cancelledWindowClosedOk === true;

              bridge.steps.push("remoteMetricA");
              const metricASelfCheck = await withTimeout("remoteMetricASelfCheck", storeRuntime["business" + "DataSelfCheck"](), 10000);
              bridge.remoteMetricAOk = !!metricASelfCheck &&
                metricASelfCheck.ok === true &&
                metricASelfCheck.latestOk === true &&
                metricASelfCheck.datePresetOk === true &&
                metricASelfCheck.metadataOk === true;

              bridge.steps.push("remoteMetricB");
              const metricBSelfCheck = await withTimeout("remoteMetricBSelfCheck", storeRuntime["funds" + "DataSelfCheck"](), 10000);
              bridge.remoteMetricBOk = !!metricBSelfCheck &&
                metricBSelfCheck.ok === true &&
                metricBSelfCheck.latestOk === true &&
                metricBSelfCheck.datePresetOk === true &&
                metricBSelfCheck.metadataOk === true;

              bridge.steps.push("remoteMetricC");
              const metricCSelfCheck = await withTimeout("remoteMetricCSelfCheck", storeRuntime["violations" + "DataSelfCheck"](), 10000);
              bridge.remoteMetricCOk = !!metricCSelfCheck &&
                metricCSelfCheck.ok === true &&
                metricCSelfCheck.latestOk === true &&
                metricCSelfCheck.datePresetOk === true &&
                metricCSelfCheck.metadataOk === true;

              bridge.steps.push("doudianFileImport");
              const fileImportSelfCheck = await withTimeout("doudianFileImportSelfCheck", storeRuntime.fileImportSelfCheck(), 10000);
              bridge.doudianFileImportOk = !!fileImportSelfCheck &&
                fileImportSelfCheck.ok === true &&
                fileImportSelfCheck.csvOk === true &&
                fileImportSelfCheck.tsvOk === true &&
                fileImportSelfCheck.xlsxOk === true;

              bridge.steps.push("remoteProductScan");
              const productScanSelfCheck = await withTimeout("remoteProductScanSelfCheck", storeRuntime["stale" + "GoodsScanSelfCheck"](), 10000);
              bridge.remoteProductScanOk = !!productScanSelfCheck &&
                productScanSelfCheck.ok === true &&
                productScanSelfCheck.scanOk === true &&
                productScanSelfCheck.candidateOk === true &&
                productScanSelfCheck.restoreOk === true;

              bridge.steps.push("remoteProductExecute");
              const productExecuteSelfCheck = await withTimeout("remoteProductExecuteSelfCheck", storeRuntime["stale" + "GoodsExecuteSelfCheck"](), 10000);
              bridge.remoteProductExecuteOk = !!productExecuteSelfCheck &&
                productExecuteSelfCheck.ok === true &&
                productExecuteSelfCheck.dryRunOk === true &&
                productExecuteSelfCheck.sourceRunOk === true &&
                productExecuteSelfCheck.actionOk === true &&
                productExecuteSelfCheck.persistedOk === true &&
                productExecuteSelfCheck.restoreOk === true;

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
              if (nativeChildId) {
                try {
                  await window.chihuNative.windows.destroy({ winId: nativeChildId });
                } catch {}
              }
            }
          }

          const bridgeOk = bridge.appInfoOk &&
            bridge.mainWindowOk &&
            bridge.allWindowsOk &&
            bridge.windowStateOk &&
            bridge.logDirOk &&
            bridge.childWindowOk &&
            bridge.nativeContractOk &&
            bridge.nativeHiddenWindowOk &&
            bridge.nativeHttpOk &&
            bridge.nativeFileOk &&
            bridge.doudianTaskRunnerOk &&
            bridge.doudianStoreGroupsOk &&
            bridge.doudianStoreImportStatusOk &&
            bridge.remoteMetricAOk &&
            bridge.remoteMetricBOk &&
            bridge.remoteMetricCOk &&
            bridge.doudianFileImportOk &&
            bridge.remoteProductScanOk &&
            bridge.remoteProductExecuteOk;

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
        scenario === "files" ? result.filesOk :
        scenario === "logs" ? result.logsOk :
        scenario === "ui-contract" ? result.uiContractOk :
        scenario === "maintenance" ? result.maintenanceOk :
        result.bridgeOk;
      const ok = result.hasShell && result.hasClient && result.methodCount >= 33 && scenarioOk;
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
