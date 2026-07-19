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
      const probeTimeoutCapMs = scenario === "bridge" ? 40000 : ["marketing-read", "marketing-write"].includes(scenario) ? 240000 : 10000;
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

          if (result.scenario === "marketing-write") {
            const runtimeDeadline = Date.now() + 10000;
            while (!window.chihuMarketingReadRuntime && Date.now() < runtimeDeadline) await sleep(100);
            if (!window.chihuMarketingReadRuntime) throw new Error("chihuMarketingReadRuntime missing");
            result.marketingWrite = await withTimeout("marketingWriteProbe", window.chihuMarketingReadRuntime.writeProbe(), 220000);
            result.marketingWriteOk = result.marketingWrite.ok === true && result.marketingWrite.cleanupRequired === false;
            result.textSample = "[redacted for marketing write probe]";
            resolve(result);
            return;
          }

          if (result.scenario === "marketing-read") {
            const runtimeDeadline = Date.now() + 10000;
            while (!window.chihuMarketingReadRuntime && Date.now() < runtimeDeadline) await sleep(100);
            if (!window.chihuMarketingReadRuntime) throw new Error("chihuMarketingReadRuntime missing");
            result.marketingRead = await withTimeout("marketingReadProbe", window.chihuMarketingReadRuntime.probe(), 220000);
            const routeExpectations = [
              ["/marketing/limited-time", "限时限量购", "创建活动"],
              ["/marketing/new-user-bonus", "新人礼金", "新建礼金"],
              ["/marketing/coupons", "通用优惠券", "新建优惠券"]
            ];
            const routeChecks = [];
            for (const [route, heading, createLabel] of routeExpectations) {
              location.hash = route;
              const routeDeadline = Date.now() + 5000;
              while (Date.now() < routeDeadline && !Array.from(document.querySelectorAll("h1")).some((item) => item.textContent?.trim() === heading)) await sleep(50);
              const createButton = Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.trim() === createLabel);
              routeChecks.push({
                route,
                heading: Array.from(document.querySelectorAll("h1")).some((item) => item.textContent?.trim() === heading),
                createDisabled: createButton?.disabled === true
              });
            }

            let marketingChildId = null;
            let mobile = null;
            try {
              const mobileUrl = new URL(location.href);
              mobileUrl.hash = "/marketing/coupons";
              marketingChildId = await withTimeout("marketingMobileWindowOpen", window.client.openWindow({
                url: mobileUrl.toString(),
                isNotShow: true,
                width: 390,
                height: 844,
                title: "CHIHU Marketing Mobile Probe",
                devTools: false
              }), 10000);
              mobile = await withTimeout("marketingMobileWindowEval", window.client.executeJavaScriptBrowserWindow({
                winId: marketingChildId,
                timeoutMs: 10000,
                jsContent: '(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));const deadline=Date.now()+7000;while(Date.now()<deadline&&!Array.from(document.querySelectorAll("h1")).some(e=>e.textContent.trim()==="通用优惠券"))await sleep(50);const heading=Array.from(document.querySelectorAll("h1")).find(e=>e.textContent.trim()==="通用优惠券");const button=Array.from(document.querySelectorAll("button")).find(e=>e.textContent.trim()==="新建优惠券");const workspace=heading&&heading.closest("section")?.parentElement;const columns=workspace?getComputedStyle(workspace).gridTemplateColumns:"";const rect=button?.getBoundingClientRect();const clippedButtons=Array.from(document.querySelectorAll("button")).filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+2).length;const overflowElements=Array.from(document.querySelectorAll("*")).map(e=>({e,r:e.getBoundingClientRect()})).filter(({r})=>r.right>innerWidth+2||r.left< -2).slice(0,12).map(({e,r})=>({tag:e.tagName,className:String(e.className||"").slice(0,160),left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width)}));return{innerWidth,innerHeight,heading:!!heading,createDisabled:button?.disabled===true,createVisible:!!rect&&rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,singleColumn:columns&&!columns.includes(" "),horizontalOverflow:document.documentElement.scrollWidth>innerWidth+2,clippedButtons,overflowElements};})()'
              }), 15000);
            } finally {
              if (marketingChildId) await window.client.destroyBrowserWindow({ winId: marketingChildId }).catch(() => {});
            }
            result.marketingUi = { routeChecks, mobile };
            result.marketingUiOk = routeChecks.every((item) => item.heading && item.createDisabled) &&
              mobile?.innerWidth <= 410 && mobile?.innerHeight >= 760 && mobile?.heading === true &&
              mobile?.createDisabled === true && mobile?.createVisible === true && mobile?.singleColumn === true &&
              mobile?.horizontalOverflow === false && mobile?.clippedButtons === 0;
            result.marketingReadOk = result.marketingRead.ok === true && result.marketingRead.writeActionsEnabled === true && result.marketingUiOk === true;
            result.textSample = "[redacted for marketing read probe]";
            resolve(result);
            return;
          }

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

          if (result.scenario === "sqlite") {
            const sqlite = {
              attempted: false,
              exposedOk: false,
              healthOk: false,
              quickCheckOk: false,
              backupOk: false,
              schemaOk: false,
              recordApiOk: false,
              pipelineV2StoreOk: false,
              featureApiOk: false,
              storeIdentityOk: false,
              coverageKeyOk: false,
              jobAcquireOk: false,
              jobReuseOk: false,
              pageCommitOk: false,
              pageReplayOk: false,
              jobHeartbeatOk: false,
              finishOk: false,
              headReadOk: false,
              latestReadOk: false,
              byIdReadOk: false,
              liveObservationOk: false,
              mutationRecordOk: false,
              mutationConfirmOk: false,
              supersedeOk: false,
              oldOwnerRejectedOk: false,
              recoveryOk: false,
              recoveredOwnerRejectedOk: false,
              tombstoneOk: false,
              steps: [],
              errors: []
            };

            const nativeData = window.nativeData || (window.chihuNative && window.chihuNative.nativeData);
            if (hasShell && hasClient && methodCount >= 33 && nativeData) {
              sqlite.attempted = true;
              sqlite.exposedOk = !!nativeData.maintenance && !!nativeData.catalogJobs && !!nativeData.catalog;
              const suffix = Date.now() + "_" + Math.random().toString(16).slice(2).replace(/[^a-z0-9_]/gi, "");
              const tenantId = "tenant-smoke-" + suffix;
              const shopId = "shop-smoke-" + suffix;
              let coverageKey = "";

              try {
                sqlite.steps.push("getHealth");
                const health = await withTimeout("nativeDataHealth", nativeData.maintenance.getHealth(), 12000);
                sqlite.healthOk = !!health && health.ok === true &&
                  health.schemaVersion === 1 &&
                  Number(health.userVersion) === 1 &&
                  typeof health.sqliteVersion === "string" &&
                  health.sqliteVersion.length > 0 &&
                  typeof health.databasePath === "string" &&
                  health.databasePath.includes("chihu-business.sqlite3") &&
                  String(health.journalMode).toLowerCase() === "wal" &&
                  Number(health.foreignKeys) === 1;

                sqlite.steps.push("quickCheck");
                const quick = await withTimeout("nativeDataQuickCheck", nativeData.maintenance.quickCheck(), 8000);
                sqlite.quickCheckOk = !!quick && quick.ok === true && Array.isArray(quick.foreignKeyViolations) && quick.foreignKeyViolations.length === 0;

                sqlite.steps.push("listTables");
                const tables = await withTimeout("nativeDataListTables", nativeData.maintenance.listTables(), 5000);
                sqlite.schemaOk = Array.isArray(tables) &&
                  tables.includes("native_records") &&
                  tables.includes("catalog_jobs") &&
                  tables.includes("catalog_runs") &&
                  tables.includes("catalog_latest_fields") &&
                  tables.includes("opportunity_submit_attempts_v2");

                sqlite.steps.push("createBackup");
                const backup = await withTimeout("nativeDataCreateBackup", nativeData.maintenance.createBackup({ reason: "sqlite-smoke" }), 12000);
                sqlite.backupOk = !!backup && backup.ok === true && typeof backup.backupPath === "string" && Number(backup.sizeBytes) > 0;

                sqlite.steps.push("recordsApi");
                const recordId = "record-smoke-" + suffix;
                const putRecord = await withTimeout("nativeDataRecordPut", nativeData.records.put({
                  storeName: "runtime_meta",
                  record: { id: recordId, kind: "sqlite-smoke", updatedAt: new Date().toISOString() }
                }), 5000);
                const gotRecord = await withTimeout("nativeDataRecordGet", nativeData.records.get({ storeName: "runtime_meta", id: recordId }), 5000);
                const listedRecords = await withTimeout("nativeDataRecordList", nativeData.records.list({ storeName: "runtime_meta", limit: 5 }), 5000);
                const deletedRecord = await withTimeout("nativeDataRecordDelete", nativeData.records.delete({ storeName: "runtime_meta", id: recordId }), 5000);
                sqlite.recordApiOk = !!putRecord && putRecord.ok === true && gotRecord?.id === recordId && Array.isArray(listedRecords.items) && deletedRecord?.ok === true;

                sqlite.steps.push("pipelineV2RecordStore");
                const pipelineRecordId = "pipeline-v2-store-smoke-" + suffix;
                const putPipelineRecord = await withTimeout("nativeDataPipelineV2RecordPut", nativeData.records.put({
                  storeName: "opportunity_pipeline_runs_v2",
                  record: { id: pipelineRecordId, kind: "pipeline-v2-store-smoke", updatedAt: new Date().toISOString() }
                }), 5000);
                const listedPipelineRecords = await withTimeout("nativeDataPipelineV2RecordList", nativeData.records.list({ storeName: "opportunity_pipeline_runs_v2", limit: 5 }), 5000);
                const deletedPipelineRecord = await withTimeout("nativeDataPipelineV2RecordDelete", nativeData.records.delete({
                  storeName: "opportunity_pipeline_runs_v2",
                  id: pipelineRecordId
                }), 5000);
                sqlite.pipelineV2StoreOk = !!putPipelineRecord &&
                  putPipelineRecord.ok === true &&
                  Array.isArray(listedPipelineRecords.items) &&
                  listedPipelineRecords.items.some((item) => item && item.id === pipelineRecordId) &&
                  deletedPipelineRecord?.ok === true;

                sqlite.steps.push("largeRecordApi");
                const largeRecordId = "large-record-smoke-" + suffix;
                const largePayload = "x".repeat(6 * 1024 * 1024);
                const putLargeRecord = await withTimeout("nativeDataLargeRecordPut", nativeData.records.put({
                  storeName: "runtime_meta",
                  record: { id: largeRecordId, kind: "sqlite-large-record-smoke", payload: largePayload, updatedAt: new Date().toISOString() }
                }), 20000);
                const gotLargeRecord = await withTimeout("nativeDataLargeRecordGet", nativeData.records.get({ storeName: "runtime_meta", id: largeRecordId }), 20000);
                const deletedLargeRecord = await withTimeout("nativeDataLargeRecordDelete", nativeData.records.delete({ storeName: "runtime_meta", id: largeRecordId }), 10000);
                sqlite.largeRecordApiOk = !!putLargeRecord &&
                  putLargeRecord.ok === true &&
                  putLargeRecord.largePayload === true &&
                  Number(putLargeRecord.payloadBytes) > 6 * 1024 * 1024 &&
                  gotLargeRecord?.id === largeRecordId &&
                  gotLargeRecord?.payload?.length === largePayload.length &&
                  deletedLargeRecord?.ok === true;

                sqlite.steps.push("featureApi");
                const staleRunId = "feature-smoke-run-" + suffix;
                const staleCandidateId = "feature-smoke-candidate-" + suffix;
                await withTimeout("nativeDataFeatureSaveStaleRun", nativeData.features.saveStaleRun({
                  mode: "scan",
                  record: { id: staleRunId, runId: staleRunId, status: "ok", updatedAt: new Date().toISOString() }
                }), 5000);
                await withTimeout("nativeDataFeatureCandidatePut", nativeData.records.put({
                  storeName: "stale_candidates",
                  record: { id: staleCandidateId, candidateId: staleCandidateId, sourceRunId: staleRunId, shopId, productId: "feature-product-1" }
                }), 5000);
                const featureCandidates = await withTimeout("nativeDataFeatureLoadStaleCandidates", nativeData.features.loadStaleCandidates({ sourceRunId: staleRunId, candidateIds: [staleCandidateId] }), 5000);
                sqlite.featureApiOk = Array.isArray(featureCandidates) && featureCandidates.length === 1 && featureCandidates[0].id === staleCandidateId;

                sqlite.steps.push("upsertIdentity");
                const identity = await withTimeout("nativeDataStoreIdentity", nativeData.stores.upsertIdentity({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  identityContractVersion: "smoke-v1",
                  namespace: { scenario: "sqlite" }
                }), 5000);
                sqlite.storeIdentityOk = !!identity && identity.ok === true && identity.tenantId === tenantId && identity.shopId === shopId;

                sqlite.steps.push("acquireJob");
                const job = await withTimeout("nativeDataAcquireJob", nativeData.catalogJobs.acquire({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  profile: "sqlite-smoke",
                  queryKind: "range",
                  scope: { lifecycleStatuses: ["selling", "selling"], productIds: ["10002", "10001"], checkStatuses: [] },
                  readRequirement: { requiredFields: ["productId", "title"] },
                  completeness: "prefer-exhausted",
                  reason: "sqlite-smoke",
                  catalogContractHash: "sqlite-smoke-contract-v1"
                }), 5000);
                coverageKey = job && job.activeCoverageKey;
                sqlite.coverageKeyOk = typeof coverageKey === "string" &&
                  coverageKey.startsWith("doudian::" + tenantId + "::" + shopId + "::1::range::") &&
                  coverageKey.endsWith("::sqlite-smoke-contract-v1") &&
                  Array.isArray(job.scope?.productIds) &&
                  job.scope.productIds.join(",") === "10001,10002" &&
                  !("checkStatuses" in job.scope);
                sqlite.jobAcquireOk = !!job && typeof job.jobId === "string" && sqlite.coverageKeyOk && Number(job.jobGeneration) === 1;

                sqlite.steps.push("reuseActiveJob");
                const reused = await withTimeout("nativeDataReuseActiveJob", nativeData.catalogJobs.acquire({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  profile: "sqlite-smoke",
                  queryKind: "range",
                  scope: { productIds: ["10001", "10002"], lifecycleStatuses: ["selling"] },
                  readRequirement: { requiredFields: ["productId", "title"] },
                  completeness: "prefer-exhausted",
                  reason: "sqlite-smoke-reuse",
                  catalogContractHash: "sqlite-smoke-contract-v1"
                }), 5000);
                sqlite.jobReuseOk = !!reused && reused.reused === true && reused.jobId === job.jobId && reused.runId === job.runId;

                const commitToken = "commit-smoke-" + suffix;
                const requestStartedAt = new Date(Date.now() - 1000).toISOString();
                const observedAt = new Date().toISOString();
                const products = [
                  {
                    productId: "10001",
                    title: "Smoke Product A",
                    imageUrl: "https://example.test/a.jpg",
                    categoryId: "cat-a",
                    categoryName: "Smoke Category",
                    lifecycleStatus: "selling",
                    priceMinMinor: "1299",
                    priceMaxMinor: "1599",
                    currency: "CNY",
                    stock: 8,
                    totalSales: 21,
                    listedAt: "2026-07-10T00:00:00.000Z",
                    fieldState: {
                      title: { state: "present", sourcePath: "title" },
                      lifecycleStatus: { state: "present", sourcePath: "status" },
                      stock: { state: "present", sourcePath: "stock" },
                      totalSales: { state: "present", sourcePath: "totalSales" },
                      listedAt: { state: "present", sourcePath: "listedAt" }
                    }
                  },
                  {
                    productId: "10002",
                    title: "Smoke Product B",
                    categoryId: "cat-b",
                    categoryName: "Smoke Category",
                    lifecycleStatus: "offline",
                    priceMinMinor: "999",
                    priceMaxMinor: "999",
                    currency: "CNY",
                    stock: 0,
                    totalSales: 3,
                    listedAt: "2026-07-09T00:00:00.000Z",
                    fieldState: {
                      title: { state: "present", sourcePath: "title" },
                      lifecycleStatus: { state: "present", sourcePath: "status" },
                      stock: { state: "present", sourcePath: "stock" },
                      totalSales: { state: "present", sourcePath: "totalSales" },
                      listedAt: { state: "present", sourcePath: "listedAt" }
                    }
                  }
                ];

                sqlite.steps.push("reportPage");
                const pageCommit = await withTimeout("nativeDataReportPage", nativeData.catalogJobs.reportPage({
                  jobId: job.jobId,
                  runId: job.runId,
                  jobGeneration: job.jobGeneration,
                  ownerEpoch: job.ownerEpoch,
                  commitToken,
                  segmentIndex: 0,
                  pageNo: 1,
                  sourceRequestKey: "sqlite-smoke-page-1",
                  requestStartedAt,
                  observedAt,
                  requestFingerprint: "sqlite-smoke-fingerprint",
                  remoteTotal: 2,
                  elapsedMs: 12,
                  products
                }), 8000);
                sqlite.pageCommitOk = !!pageCommit && pageCommit.ok === true && pageCommit.firstCommit === true && pageCommit.committedCount === 2 && pageCommit.runId === job.runId;

                sqlite.steps.push("replayPage");
                const pageReplay = await withTimeout("nativeDataReplayPage", nativeData.catalogJobs.reportPage({
                  jobId: job.jobId,
                  runId: job.runId,
                  jobGeneration: job.jobGeneration,
                  ownerEpoch: job.ownerEpoch,
                  commitToken,
                  segmentIndex: 0,
                  pageNo: 1,
                  sourceRequestKey: "sqlite-smoke-page-1",
                  requestStartedAt,
                  observedAt,
                  remoteTotal: 2,
                  products
                }), 8000);
                sqlite.pageReplayOk = !!pageReplay && pageReplay.ok === true && pageReplay.firstCommit === false && pageReplay.committedCount === 2 && pageReplay.transactionId === pageCommit.transactionId;

                sqlite.steps.push("heartbeatJob");
                const heartbeat = await withTimeout("nativeDataHeartbeatJob", nativeData.catalogJobs.heartbeat({
                  jobId: job.jobId,
                  jobGeneration: job.jobGeneration,
                  ownerEpoch: job.ownerEpoch
                }), 5000);
                sqlite.jobHeartbeatOk = !!heartbeat && heartbeat.ok === true && typeof heartbeat.heartbeatAt === "string";

                sqlite.steps.push("finishJob");
                const finish = await withTimeout("nativeDataFinishJob", nativeData.catalogJobs.finish({
                  jobId: job.jobId,
                  runId: job.runId,
                  jobGeneration: job.jobGeneration,
                  ownerEpoch: job.ownerEpoch,
                  status: "exhausted",
                  terminationReason: "has-more-false"
                }), 8000);
                sqlite.finishOk = !!finish && finish.ok === true && finish.status === "exhausted" && finish.headChanged === 1;

                sqlite.steps.push("headMembers");
                const headPage = await withTimeout("nativeDataHeadMembers", nativeData.catalog.queryHeadMembersPage({ coverageKey, limit: 10 }), 5000);
                sqlite.headReadOk = !!headPage && Array.isArray(headPage.items) && headPage.items.length === 2 && headPage.hasMore === false &&
                  headPage.items.some((item) => item.productId === "10001" && item.mergedFields && item.mergedFields.title === "Smoke Product A");

                sqlite.steps.push("latestPage");
                const latestPage = await withTimeout("nativeDataLatestPage", nativeData.catalog.queryLastObservedPage({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  limit: 10
                }), 5000);
                sqlite.latestReadOk = !!latestPage && Array.isArray(latestPage.items) && latestPage.items.length === 2 &&
                  latestPage.items.every((item) => item.latestObservationId && item.latestObservedProductVersionId && item.mergedFields && item.mergedFields.title);

                sqlite.steps.push("productsByIds");
                const byIds = await withTimeout("nativeDataProductsByIds", nativeData.catalog.getProductsByIds({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  productIds: ["10001", "10002"]
                }), 5000);
                sqlite.byIdReadOk = Array.isArray(byIds) && byIds.length === 2 &&
                  byIds.some((item) => item.productId === "10002" && item.mergedFields.lifecycleStatus === "offline");

                sqlite.steps.push("recordLiveObservations");
                const liveRecord = await withTimeout("nativeDataRecordLiveObservations", nativeData.catalog.recordLiveObservations({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  profile: "sqlite-smoke-live",
                  purpose: "sqlite-smoke-live-lookup",
                  catalogContractHash: "sqlite-smoke-live-contract-v1",
                  products: [{
                    productId: "10001",
                    lifecycleStatus: "offline",
                    stock: 7,
                    fieldState: {
                      title: { state: "missing", sourcePath: "title" },
                      lifecycleStatus: { state: "present", sourcePath: "status" },
                      stock: { state: "present", sourcePath: "stock" }
                    }
                  }]
                }), 8000);
                const liveLatest = await withTimeout("nativeDataLiveLatest", nativeData.catalog.getProductsByIds({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  productIds: ["10001"]
                }), 5000);
                sqlite.liveObservationOk = !!liveRecord &&
                  liveRecord.ok === true &&
                  liveRecord.committedCount === 1 &&
                  Array.isArray(liveRecord.observations) &&
                  liveRecord.observations.length === 1 &&
                  Array.isArray(liveLatest) &&
                  liveLatest[0]?.mergedFields?.title === "Smoke Product A" &&
                  liveLatest[0]?.mergedFields?.lifecycleStatus === "offline" &&
                  liveLatest[0]?.mergedFields?.stock === 7;

                sqlite.steps.push("recordMutationResults");
                const mutationKey = "mutation-smoke-" + suffix;
                const mutationRecord = await withTimeout("nativeDataRecordMutationResults", nativeData.catalog.recordMutationResults({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  mutations: [{
                    mutationKey,
                    productId: "10001",
                    action: "offline",
                    status: "acknowledged",
                    requestHash: "request-hash-" + suffix,
                    idempotencyKey: "idempotency-" + suffix,
                    lookupObservationId: liveRecord.observations[0].observationId,
                    result: { scenario: "sqlite-smoke", acknowledged: true }
                  }]
                }), 8000);
                sqlite.mutationRecordOk = !!mutationRecord &&
                  mutationRecord.ok === true &&
                  mutationRecord.changed === 1 &&
                  mutationRecord.mutations?.[0]?.mutationKey === mutationKey &&
                  mutationRecord.mutations?.[0]?.status === "acknowledged";

                sqlite.steps.push("confirmMutations");
                const mutationConfirm = await withTimeout("nativeDataConfirmMutations", nativeData.catalog.confirmMutations({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  profile: "sqlite-smoke-confirm",
                  catalogContractHash: "sqlite-smoke-confirm-contract-v1",
                  confirmations: [{
                    mutationKey,
                    status: "confirmed",
                    observation: {
                      productId: "10001",
                      lifecycleStatus: "offline",
                      fieldState: {
                        title: { state: "missing", sourcePath: "title" },
                        lifecycleStatus: { state: "present", sourcePath: "status" }
                      }
                    },
                    result: { confirmed: true }
                  }]
                }), 8000);
                sqlite.mutationConfirmOk = !!mutationConfirm &&
                  mutationConfirm.ok === true &&
                  mutationConfirm.changed === 1 &&
                  mutationConfirm.confirmations?.[0]?.status === "confirmed" &&
                  typeof mutationConfirm.confirmations?.[0]?.confirmObservationId === "string";

                sqlite.steps.push("forceRefreshSupersede");
                const oldOwner = await withTimeout("nativeDataSupersedeOldOwner", nativeData.catalogJobs.acquire({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  profile: "sqlite-smoke",
                  queryKind: "range",
                  scope: { lifecycleStatuses: ["selling"], keyword: "supersede" },
                  readRequirement: { requiredFields: ["productId", "title"] },
                  completeness: "prefer-exhausted",
                  reason: "sqlite-smoke-supersede",
                  catalogContractHash: "sqlite-smoke-contract-v1"
                }), 5000);
                const newOwner = await withTimeout("nativeDataSupersedeNewOwner", nativeData.catalogJobs.acquire({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  profile: "sqlite-smoke",
                  queryKind: "range",
                  scope: { lifecycleStatuses: ["selling"], keyword: "supersede" },
                  readRequirement: { requiredFields: ["productId", "title"] },
                  completeness: "force-refresh",
                  reason: "sqlite-smoke-force-refresh",
                  catalogContractHash: "sqlite-smoke-contract-v1"
                }), 5000);
                const oldState = await withTimeout("nativeDataSupersededOldState", nativeData.catalogJobs.get({ jobId: oldOwner.jobId }), 5000);
                sqlite.supersedeOk = !!newOwner && !!oldState && newOwner.activeCoverageKey === oldOwner.activeCoverageKey && newOwner.jobId !== oldOwner.jobId && Number(newOwner.jobGeneration) === Number(oldOwner.jobGeneration) + 1 && oldState.status === "superseded" && oldState.runStatus === "superseded";
                let oldHeartbeatRejected = false;
                let oldPageRejected = false;
                try {
                  await withTimeout("nativeDataOldHeartbeatRejected", nativeData.catalogJobs.heartbeat({
                    jobId: oldOwner.jobId,
                    jobGeneration: oldOwner.jobGeneration,
                    ownerEpoch: oldOwner.ownerEpoch
                  }), 5000);
                } catch {
                  oldHeartbeatRejected = true;
                }
                try {
                  await withTimeout("nativeDataOldReportRejected", nativeData.catalogJobs.reportPage({
                    jobId: oldOwner.jobId,
                    runId: oldOwner.runId,
                    jobGeneration: oldOwner.jobGeneration,
                    ownerEpoch: oldOwner.ownerEpoch,
                    commitToken: "old-owner-commit-" + suffix,
                    sourceRequestKey: "old-owner-page",
                    products: [products[0]]
                  }), 5000);
                } catch {
                  oldPageRejected = true;
                }
                sqlite.oldOwnerRejectedOk = oldHeartbeatRejected && oldPageRejected;

                sqlite.steps.push("recoverOpenJobs");
                const recoverOwner = await withTimeout("nativeDataRecoverOwner", nativeData.catalogJobs.acquire({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  profile: "sqlite-smoke",
                  queryKind: "range",
                  scope: { lifecycleStatuses: ["selling"], keyword: "recover" },
                  readRequirement: { requiredFields: ["productId", "title"] },
                  completeness: "prefer-exhausted",
                  reason: "sqlite-smoke-recover",
                  catalogContractHash: "sqlite-smoke-contract-v1"
                }), 5000);
                const recovery = await withTimeout("nativeDataRecoverOpenJobs", nativeData.maintenance.recoverOpenJobs({ reason: "sqlite-smoke" }), 8000);
                const recoveredState = await withTimeout("nativeDataRecoveredState", nativeData.catalogJobs.get({ jobId: recoverOwner.jobId }), 5000);
                sqlite.recoveryOk = !!recovery && recovery.ok === true && Number(recovery.abandonedJobs) >= 1 && !!recoveredState && recoveredState.status === "abandoned" && recoveredState.runStatus === "abandoned";
                try {
                  await withTimeout("nativeDataRecoveredHeartbeatRejected", nativeData.catalogJobs.heartbeat({
                    jobId: recoverOwner.jobId,
                    jobGeneration: recoverOwner.jobGeneration,
                    ownerEpoch: recoverOwner.ownerEpoch
                  }), 5000);
                } catch {
                  sqlite.recoveredOwnerRejectedOk = true;
                }

                sqlite.steps.push("tombstoneIdentity");
                const tombstone = await withTimeout("nativeDataTombstoneIdentity", nativeData.stores.tombstoneIdentity({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  reason: "sqlite-smoke-tombstone"
                }), 8000);
                const afterTombstoneLatest = await withTimeout("nativeDataAfterTombstoneLatest", nativeData.catalog.queryLastObservedPage({
                  platform: "doudian",
                  tenantId,
                  shopId,
                  storeGeneration: 1,
                  limit: 10
                }), 5000);
                let acquireRejectedAfterTombstone = false;
                let upsertRejectedAfterTombstone = false;
                try {
                  await withTimeout("nativeDataAcquireAfterTombstone", nativeData.catalogJobs.acquire({
                    platform: "doudian",
                    tenantId,
                    shopId,
                    storeGeneration: 1,
                    profile: "sqlite-smoke-after-tombstone",
                    queryKind: "range",
                    scope: { lifecycleStatuses: ["selling"] },
                    readRequirement: { requiredFields: ["productId"] },
                    completeness: "prefer-exhausted",
                    reason: "sqlite-smoke-after-tombstone",
                    catalogContractHash: "sqlite-smoke-contract-v1"
                  }), 5000);
                } catch {
                  acquireRejectedAfterTombstone = true;
                }
                try {
                  await withTimeout("nativeDataUpsertAfterTombstone", nativeData.stores.upsertIdentity({
                    platform: "doudian",
                    tenantId,
                    shopId,
                    storeGeneration: 1,
                    identityContractVersion: "smoke-v1",
                    namespace: { scenario: "sqlite-after-tombstone" }
                  }), 5000);
                } catch {
                  upsertRejectedAfterTombstone = true;
                }
                sqlite.tombstoneOk = !!tombstone &&
                  tombstone.ok === true &&
                  tombstone.changed === 1 &&
                  tombstone.nextGeneration === 2 &&
                  Array.isArray(afterTombstoneLatest.items) &&
                  afterTombstoneLatest.items.length === 0 &&
                  afterTombstoneLatest.storeLifecycle === "tombstoned" &&
                  acquireRejectedAfterTombstone &&
                  upsertRejectedAfterTombstone;
              } catch (error) {
                sqlite.errors.push(error && error.message ? error.message : String(error));
              }
            }

            result.sqliteOk = sqlite.exposedOk &&
              sqlite.healthOk &&
              sqlite.quickCheckOk &&
              sqlite.backupOk &&
              sqlite.schemaOk &&
              sqlite.recordApiOk &&
              sqlite.pipelineV2StoreOk &&
              sqlite.largeRecordApiOk &&
              sqlite.featureApiOk &&
              sqlite.storeIdentityOk &&
              sqlite.coverageKeyOk &&
              sqlite.jobAcquireOk &&
              sqlite.jobReuseOk &&
              sqlite.pageCommitOk &&
              sqlite.pageReplayOk &&
              sqlite.jobHeartbeatOk &&
              sqlite.finishOk &&
              sqlite.headReadOk &&
              sqlite.latestReadOk &&
              sqlite.byIdReadOk &&
              sqlite.liveObservationOk &&
              sqlite.mutationRecordOk &&
              sqlite.mutationConfirmOk &&
              sqlite.supersedeOk &&
              sqlite.oldOwnerRejectedOk &&
              sqlite.recoveryOk &&
              sqlite.recoveredOwnerRejectedOk &&
              sqlite.tombstoneOk;
            result.sqlite = sqlite;
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
            nativeTextSegmentOk: false,
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
            doudianOpportunityReportOk: false,
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
                !!native.partitions?.cleanInvalid &&
                !!native.text?.segment;

              bridge.steps.push("nativeTextSegment");
              const segmentResult = await withTimeout("nativeTextSegment", native.text.segment({
                texts: ["\u8d64\u72d0\u5546\u673a\u63d0\u62a5\u5206\u8bcd smoke", "keyword match"],
                mode: "search",
                minTokenLength: 2
              }), 5000);
              bridge.nativeTextSegmentOk = !!segmentResult &&
                typeof segmentResult.tokenizerVersion === "string" &&
                segmentResult.tokenizerVersion.length > 0 &&
                segmentResult.tokenizerFallback !== true &&
                Array.isArray(segmentResult.items) &&
                segmentResult.items.length === 2 &&
                segmentResult.items.some((item) => Array.isArray(item.tokens) && item.tokens.length > 0);

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
              const runtime = window.chihuDoudianTaskRuntime;
              if (!runtime) throw new Error("chihuDoudianTaskRuntime missing");
              const smokeTaskOperationId = "smoke-runner-bridge";
              const existingSmokeTask = await runtime.getStatus(smokeTaskOperationId);
              if (!existingSmokeTask) {
                const repositorySelfCheck = await runtime.repositorySelfCheck();
                if (!repositorySelfCheck || repositorySelfCheck.ok !== true || !["chihu20_doudian", "chihu-business.sqlite3"].includes(repositorySelfCheck.dbName) || repositorySelfCheck.objectStores.length < 9) {
                  throw new Error("doudian repository self check failed");
                }
                const task = await runtime.startMock({
                  operationId: smokeTaskOperationId,
                  durationMs: 5000,
                  stepMs: 250,
                  adapterVersion: "smoke",
                  ruleVersion: "smoke"
                });
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

              if (existingSmokeTask.status === "cancelled") {
                bridge.doudianTaskRunnerOk = true;
              } else {
                const operationId = smokeTaskOperationId;
                const status = await runtime.getStatus(operationId);
                const active = await runtime.restore();
                await runtime.cancel(operationId);
                await sleep(150);
                const cancelled = await runtime.getStatus(operationId);
                const windows = await window.client.getAllBrowserWindowInfos();
                const runnerWindowStillOpen = Array.isArray(windows) && windows.some((item) => item && item.id === cancelled?.runnerWinId && !item.isDestroyed);
                bridge.doudianTaskRunnerOk = !!status &&
                  ["running", "succeeded"].includes(status.status) &&
                  (status.status === "succeeded" || active.some((item) => item.operationId === operationId)) &&
                  !!cancelled &&
                  cancelled.status === "cancelled" &&
                  runnerWindowStillOpen === false;
              }

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

              bridge.steps.push("doudianOpportunityReport");
              const opportunityReportSelfCheck = await withTimeout("doudianOpportunityReportSelfCheck", storeRuntime["opportunity" + "ReportSelfCheck"](), 20000);
              bridge.doudianOpportunityReportOk = !!opportunityReportSelfCheck &&
                opportunityReportSelfCheck.ok === true &&
                opportunityReportSelfCheck.clueScanOk === true &&
                opportunityReportSelfCheck.productScanOk === true &&
                opportunityReportSelfCheck.submitDryRunOk === true &&
                opportunityReportSelfCheck.collectDryRunOk === true &&
                opportunityReportSelfCheck.pipelineDryRunOk === true &&
                opportunityReportSelfCheck.pipelineRestoreOk === true &&
                opportunityReportSelfCheck.restoreOk === true;

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
            bridge.nativeTextSegmentOk &&
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
            bridge.doudianOpportunityReportOk &&
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
        scenario === "sqlite" ? result.sqliteOk :
        scenario === "marketing-write" ? result.marketingWriteOk :
        scenario === "marketing-read" ? result.marketingReadOk :
        result.bridgeOk;
      const ok = result.hasShell && result.hasClient && result.methodCount >= 33 && scenarioOk;
      if (ok) {
        clearTimeout(timer);
        finish(0, result);
        return;
      }

      if (["marketing-read", "marketing-write"].includes(scenario)) {
        clearTimeout(timer);
        finish(1, result);
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
