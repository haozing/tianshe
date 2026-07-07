const { BrowserWindow, session } = require("electron");
const crypto = require("node:crypto");
const { clearAllSessionData, copyCookies } = require("../ipc/cookies");
const { DOUDIAN_ADAPTER, doudianShopPartition, resolveDoudianAdapter, summarizeAdapterInput, validateDoudianAdapterContract } = require("./adapter");
const { buildStoreFailure: buildStoreFailureWithRules, classifyStoreFailure: classifyStoreFailureWithRules } = require("./failure-classifier");
const { actionList, runActionList } = require("./operation-executor");
const { doudianRequestGet: platformRequestGet } = require("./platform-request");
const { refreshOneStore } = require("./status-refresh");
const { importOneStore } = require("./store-import");
const { signMstokenMyargs } = require("./xzb-signer");
const {
  policy,
  policyArray,
  policyBool,
  policyMessage,
  policyNumber,
  policyText
} = require("./policies");
const repository = require("./repository");
const { logStoreEvent } = require("./run-logger");

const STALE_GOODS_CONFIRM_TEXT = "确认清理";
const STALE_GOODS_EXECUTE_ALLOWLIST = {
  offline: { planKey: "staleGoodsBatchOffline", method: "POST", endpoint: "/product/tproduct/batchOffline" },
  recycle: { planKey: "staleGoodsBatchDelete", method: "POST", endpoint: "/product/tproduct/batchDelete" },
  delete: { planKey: "staleGoodsCompleteDelete", method: "POST", endpoint: "/product/tproduct/completeDelete" }
};

function adapterTimeout(adapter, key) {
  const fallback = DOUDIAN_ADAPTER.timeouts?.[key];
  const value = Number(adapter?.timeouts?.[key] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function adapterFor(operation = null) {
  return operation?.doudianAdapter || DOUDIAN_ADAPTER;
}

function resolveTaskAdapter(args = {}, operation = null) {
  const input = args.doudianAdapter || args.adapter || null;
  const adapter = resolveDoudianAdapter(input);
  validateDoudianAdapterContract(adapter);
  repository.configurePolicy(adapter.policies?.repository || {});
  if (operation) {
    operation.doudianAdapter = adapter;
    operation.doudianAdapterInput = summarizeAdapterInput(input);
  }
  return adapter;
}

const REQUIRED_REMOTE_SCRIPT_KEYS = ["collectRoleShopNames", "isHomePage", "switchShopFactory", "signFactory", "probeFactory"];

function assertRemoteAdapterInput(args = {}, capability = "doudian") {
  const input = args.doudianAdapter || args.adapter || null;
  if (!input || typeof input !== "object" || input.kind !== "chihu-doudian-adapter") {
    const error = new Error(`missing remote doudian adapter for ${capability}`);
    error.code = "DOUDIAN_REMOTE_ADAPTER_REQUIRED";
    throw error;
  }
  const scripts = input.scripts || {};
  const missingScripts = REQUIRED_REMOTE_SCRIPT_KEYS.filter((key) => typeof scripts[key] !== "string" || !scripts[key].trim());
  if (missingScripts.length) {
    const error = new Error(`missing remote doudian scripts: ${missingScripts.join(", ")}`);
    error.code = "DOUDIAN_REMOTE_SCRIPT_MISSING";
    error.missingScripts = missingScripts;
    throw error;
  }
}

function adapterInputSummary(operation = null) {
  return operation?.doudianAdapterInput || summarizeAdapterInput(null);
}

function adapterStrategies(adapter = DOUDIAN_ADAPTER) {
  return adapter?.strategies || DOUDIAN_ADAPTER.strategies || {};
}

function operationId(operation = null) {
  return String(operation?.id || "");
}

function createStoreRun(type, adapter = DOUDIAN_ADAPTER, operation = null, detail = {}) {
  return repository.createRun({
    operationId: operationId(operation),
    type,
    adapterVersion: adapter.version || "",
    adapterSource: adapter.source || "",
    scriptsVersion: adapter.scripts?.version || "",
    detail
  });
}

function finishStoreRun(run, summary = {}) {
  if (!run?.runId) return null;
  return repository.finishRun(run.runId, summary);
}

function recordStoreAttempt(run, type, detail = {}, adapter = DOUDIAN_ADAPTER) {
  if (!run?.runId) return null;
  return repository.recordAttempt({
    runId: run.runId,
    type,
    adapterVersion: adapter.version || "",
    ...detail
  });
}

function recordStoreAttempts(run, type, details = [], adapter = DOUDIAN_ADAPTER) {
  for (const detail of details || []) {
    recordStoreAttempt(run, type, {
      shopId: detail.shopId || "",
      shopName: detail.shopName || "",
      status: detail.status || (detail.ok ? "ok" : "failed"),
      ok: detail.ok === true || detail.status === "online",
      reason: detail.reason || "",
      category: detail.category || "",
      message: detail.message || "",
      diagnostic: detail.diagnostic || null,
      data: {
        index: detail.index,
        total: detail.total
      }
    }, adapter);
  }
}

function platformUrl(adapter, pathOrUrl) {
  return new URL(pathOrUrl, adapter.origin).toString();
}

function signedEndpointUrl(adapter, endpoint, options = {}) {
  const url = new URL(platformUrl(adapter, endpoint));
  const signatureParam = options.sign === false || options.signatureParam === false ? "" : String(options.signatureParam || "_signature");
  if (signatureParam && options.includeEmptySignature !== false && !url.searchParams.has(signatureParam)) url.searchParams.set(signatureParam, "");
  return url.toString();
}

function remoteScript(adapter, name) {
  const value = adapter?.scripts?.[name];
  return typeof value === "string" && value.trim() ? value : "";
}

function requireRemoteScript(adapter, name) {
  const value = remoteScript(adapter, name);
  if (!value) {
    const error = new Error(`missing doudian remote script: ${name}`);
    error.code = "DOUDIAN_REMOTE_SCRIPT_MISSING";
    throw error;
  }
  return value;
}

function remoteFactoryCall(factorySource, payload) {
  return `
    (() => {
      const factory = ${factorySource};
      return factory(${JSON.stringify(payload)});
    })();
  `;
}

async function executeRemotePageScript(win, source, label, timeoutMs, logDetail = {}) {
  try {
    return await withTimeout(label, win.webContents.executeJavaScript(source, true), timeoutMs);
  } catch (error) {
    logStoreEvent("remoteScript.failed", {
      label,
      error: safeError(error),
      ...logDetail
    });
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCancelled(operation) {
  return !!operation?.cancelled;
}

function cancelError() {
  const error = new Error("operation cancelled");
  error.code = "OPERATION_CANCELLED";
  return error;
}

function throwIfCancelled(operation) {
  if (isCancelled(operation)) throw cancelError();
}

async function delayWithCancel(ms, operation) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    throwIfCancelled(operation);
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throwIfCancelled(operation);
}

function trackOperationWindow(operation, win) {
  if (!operation?.windows || !win) return;
  if (operation.windows.has(win)) return;
  operation.windows.add(win);
  win.once("closed", () => {
    operation.windows.delete(win);
  });
}

function isCancelError(error) {
  return error?.code === "OPERATION_CANCELLED" || error?.message === "operation cancelled";
}

function clipText(value, maxLength = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeError(error) {
  if (!error) return "";
  return error.message || String(error);
}

function withTimeout(label, promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

async function settleWithConcurrency(items, limit, iterator) {
  const list = Array.isArray(items) ? items : [];
  const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 1), list.length || 1));
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await iterator(list[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => worker()));
  return results;
}

function storeLedgerSnapshot() {
  return {
    stores: repository.listStores(),
    groups: repository.listGroups()
  };
}

function isBlockedExternalScheme(url, adapter = DOUDIAN_ADAPTER) {
  if (!url || typeof url !== "string") return false;
  const schemes = adapter.blockedSchemes || [];
  return schemes.some((scheme) => {
    const normalized = String(scheme || "").trim().replace(/:$/, "");
    return normalized && url.trim().toLowerCase().startsWith(`${normalized.toLowerCase()}:`);
  });
}

function setupDoudianRequestInterceptor(targetSession, adapter = DOUDIAN_ADAPTER) {
  if (!targetSession) return;
  const adapterKey = `${adapter.version || ""}:${(adapter.blockedKeywords || []).join("|")}`;
  if (targetSession.__chihuDoudianRequestInterceptor === adapterKey) return;
  targetSession.__chihuDoudianRequestInterceptor = adapterKey;
  targetSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    try {
      const url = new URL(details.url);
      const cancel = (adapter.blockedKeywords || []).some((keyword) => url.pathname.includes(keyword));
      callback({ cancel });
    } catch {
      callback({ cancel: false });
    }
  });
}

function createBrowserWindow({ partition, show, title, adapter = DOUDIAN_ADAPTER }) {
  const targetSession = session.fromPartition(partition);
  setupDoudianRequestInterceptor(targetSession, adapter);

  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    show,
    title,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      partition,
      session: targetSession,
      nodeIntegration: false,
      contextIsolation: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      sandbox: false,
      spellcheck: false,
      devTools: process.env.CHIHU_DOUDIAN_DEVTOOLS === "1"
    }
  });

  win.setMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isBlockedExternalScheme(url, adapter)) return { action: "deny" };
    return { action: "allow" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isBlockedExternalScheme(url, adapter)) event.preventDefault();
  });

  return win;
}

function loadUrl(win, url, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      clearTimeout(timer);
      win.webContents.removeListener("did-finish-load", onFinish);
      win.webContents.removeListener("did-fail-load", onFail);
    };

    const done = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onFinish = () => done({ ok: true });
    const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      done({ ok: false, errorCode, errorDescription, url: validatedURL });
    };

    timer = setTimeout(() => done({ ok: false, errorDescription: "load timeout", url }), timeoutMs);
    win.webContents.on("did-finish-load", onFinish);
    win.webContents.on("did-fail-load", onFail);
    win.loadURL(url).catch((error) => done({ ok: false, errorDescription: error.message, url }));
  });
}

function shouldStopDoudianSignRetry(result) {
  return [
    "signature-provider-missing",
    "empty-signature"
  ].includes(result?.reason);
}

function summarizeDoudianResponse(response) {
  return {
    status: response?.status || 0,
    success: !!response?.success,
    error: response?.error || null,
    code: response?.data?.code ?? response?.data?.status_code ?? response?.data?.statusCode ?? null,
    message: clipText(response?.data?.msg || response?.data?.message || response?.data?.status_msg || "", 120)
  };
}

function shopUserInfoResponseSummary(shopListResult, currentResult) {
  return {
    shopList: {
      ...summarizeDoudianResponse(shopListResult?.response),
      count: Array.isArray(shopListResult?.mallList) ? shopListResult.mallList.length : 0
    },
    currentShop: {
      ...summarizeDoudianResponse(currentResult?.response),
      currentMallId: currentResult?.currentMallId || ""
    }
  };
}

function signerLoadUrl(adapter = DOUDIAN_ADAPTER, plan = {}) {
  return String(plan.signerUrl || plan.prepareUrl || adapter.homeUrl || "");
}

function signerWaitMs(plan = {}) {
  const value = Number(plan.signerWaitMs ?? (plan.prepareBeforeSign === true ? plan.prepareWaitMs : 0) ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function waitForSignerContext(operation = null, plan = {}) {
  const waitMs = signerWaitMs(plan);
  if (waitMs > 0) await delayWithCancel(waitMs, operation);
  return waitMs;
}

async function createDoudianSignerWindow(partition, operation = null, adapter = adapterFor(operation), plan = {}) {
  const win = createBrowserWindow({
    partition,
    show: false,
    title: "赤狐管家 - 抖店签名器",
    adapter
  });
  trackOperationWindow(operation, win);
  const url = signerLoadUrl(adapter, plan);
  if (url) {
    const loadResult = await loadUrl(win, url, adapterTimeout(adapter, "signerLoadMs"));
    const waitMs = await waitForSignerContext(operation, plan);
    logStoreEvent("doudian.signer.loaded", {
      partition,
      url,
      ok: !!loadResult?.ok,
      error: loadResult?.errorDescription || "",
      waitMs
    });
  }
  return win;
}

const doudianSignerWindowPromises = new Map();

async function getCachedDoudianSignerWindow(partition, operation = null, adapter = adapterFor(operation), plan = {}) {
  const signerPartition = plan.shareSignerPartition === true
    ? (adapter.signerPartition || DOUDIAN_ADAPTER.signerPartition)
    : (partition || adapter.signerPartition || DOUDIAN_ADAPTER.signerPartition);
  const adapterKey = `${signerPartition}:${adapter.version || ""}:${signerLoadUrl(adapter, plan)}`;

  const cachedPromise = doudianSignerWindowPromises.get(adapterKey);
  if (cachedPromise) {
    try {
      const existing = await cachedPromise;
      if (existing && !existing.isDestroyed() && !existing.webContents.isDestroyed()) {
        trackOperationWindow(operation, existing);
        return existing;
      }
      doudianSignerWindowPromises.delete(adapterKey);
    } catch {
      doudianSignerWindowPromises.delete(adapterKey);
    }
  }

  const promise = createDoudianSignerWindow(signerPartition, operation, adapter, plan);
  doudianSignerWindowPromises.set(adapterKey, promise);
  try {
    const win = await promise;
    if (win && !win.isDestroyed()) {
      win.once("closed", () => {
        if (doudianSignerWindowPromises.get(adapterKey) === promise) doudianSignerWindowPromises.delete(adapterKey);
      });
    }
    return win;
  } catch (error) {
    if (doudianSignerWindowPromises.get(adapterKey) === promise) doudianSignerWindowPromises.delete(adapterKey);
    throw error;
  }
}

async function prepareSignerWindowBeforeSign(win, partition, operation = null, adapter = adapterFor(operation), plan = {}, context = {}) {
  if (plan.prepareBeforeSign !== true) return false;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  const prepareUrl = renderPlanTemplateValue(plan.prepareBeforeSignUrl || plan.signerUrl || plan.prepareUrl || "", context);
  if (!prepareUrl) return false;
  const loadResult = await loadUrl(win, prepareUrl, Math.max(1, Number(plan.prepareLoadMs || adapterTimeout(adapter, "loadMs"))));
  const waitMs = await waitForSignerContext(operation, plan);
  logStoreEvent("doudian.signer.prepared", {
    partition,
    url: prepareUrl,
    ok: !!loadResult?.ok,
    error: loadResult?.errorDescription || "",
    waitMs
  });
  return !!loadResult?.ok;
}

function renderSignPlan(plan = {}, context = {}) {
  return {
    ...plan,
    ...(typeof plan.signQuery === "string" ? { signQuery: renderPlanTemplateValue(plan.signQuery, context) } : {}),
    ...(typeof plan.signQueryString === "string" ? { signQueryString: renderPlanTemplateValue(plan.signQueryString, context) } : {}),
    ...(typeof plan.signBody === "string" ? { signBody: renderPlanTemplateValue(plan.signBody, context) } : {})
  };
}

function useLocalMstokenSigner(plan = {}) {
  return plan.localSigner === true && String(plan.signStrategy || "").toLowerCase() === "mstoken-myargs";
}

async function signUrlWithLocalMstoken(partition, targetUrl, adapter = DOUDIAN_ADAPTER, plan = {}, context = {}) {
  const signPlan = renderSignPlan(plan, context);
  return signMstokenMyargs({
    partition,
    targetUrl,
    adapter,
    plan: signPlan,
    context
  });
}

async function signUrlWithWindow(win, targetUrl, operation = null, adapter = adapterFor(operation), plan = {}, context = {}) {
  let lastResult = null;
  const attempts = Math.max(1, Math.floor(adapterTimeout(adapter, "signAttempts")));
  const signPlan = renderSignPlan(plan, context);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfCancelled(operation);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) break;
    try {
      const remoteSignScript = remoteFactoryCall(requireRemoteScript(adapter, "signFactory"), { targetUrl, adapter, plan: signPlan, context });
      lastResult = await executeRemotePageScript(
        win,
        remoteSignScript,
        "doudian sign",
        adapterTimeout(adapter, "probeMs"),
        {
          script: "signFactory",
          targetUrl
        }
      );
      if (lastResult?.ok && (lastResult.signature || lastResult.signedUrl || lastResult.query || lastResult.myargs)) return lastResult;
      if (shouldStopDoudianSignRetry(lastResult)) return lastResult;
    } catch (error) {
      lastResult = { ok: false, reason: "script-error", error: safeError(error) };
    }
    await delayWithCancel(adapterTimeout(adapter, "signPollMs"), operation);
  }
  return lastResult || { ok: false, reason: "sign-timeout" };
}

function applySignedUrlResult(targetUrl, signed, plan = {}) {
  if (!signed?.ok) return targetUrl;
  if (signed.signedUrl) return String(signed.signedUrl);
  const signedUrl = new URL(targetUrl);
  const query = signed.query || signed.myargs;
  if (query) {
    signedUrl.search = String(query).replace(/^[?&]+/, "");
    return signedUrl.toString();
  }
  if (signed.signature) {
    const signatureParam = String(plan.signatureParam || "_signature");
    if (signatureParam) signedUrl.searchParams.set(signatureParam, signed.signature);
  }
  return signedUrl.toString();
}

async function signDoudianUrl(partition, targetUrl, operation = null, signerWindow = null, adapter = adapterFor(operation), plan = {}, context = {}) {
  throwIfCancelled(operation);
  if (useLocalMstokenSigner(plan)) {
    try {
      const signed = await signUrlWithLocalMstoken(partition, targetUrl, adapter, plan, context);
      if (signed?.ok) {
        logStoreEvent("doudian.sign.local", {
          partition,
          url: targetUrl,
          source: signed.source || "",
          mode: signed.mode || "",
          fpSource: signed.fpSource || "",
          msTokenSource: signed.msTokenSource || "",
          hasMsToken: signed.hasMsToken === true
        });
        return applySignedUrlResult(targetUrl, signed, plan);
      }
      logStoreEvent("doudian.sign.local.failed", {
        partition,
        url: targetUrl,
        result: signed
      });
    } catch (error) {
      logStoreEvent("doudian.sign.local.failed", {
        partition,
        url: targetUrl,
        error: safeError(error)
      });
    }
  }

  if (signerWindow) {
    await prepareSignerWindowBeforeSign(signerWindow, partition, operation, adapter, plan, context);
    const signed = await signUrlWithWindow(signerWindow, targetUrl, operation, adapter, plan, context);
    if (signed?.ok) return applySignedUrlResult(targetUrl, signed, plan);
    logStoreEvent("doudian.sign.failed", {
      partition,
      url: targetUrl,
      result: signed
    });
    return "";
  }

  try {
    const cachedWindow = await getCachedDoudianSignerWindow(partition, operation, adapter, plan);
    await prepareSignerWindowBeforeSign(cachedWindow, partition, operation, adapter, plan, context);
    const signed = await signUrlWithWindow(cachedWindow, targetUrl, operation, adapter, plan, context);
    if (signed?.ok) return applySignedUrlResult(targetUrl, signed, plan);
    logStoreEvent("doudian.sign.cached.failed", {
      partition,
      url: targetUrl,
      result: signed
    });
  } catch (error) {
    logStoreEvent("doudian.sign.cached.failed", {
      partition,
      url: targetUrl,
      error: safeError(error)
    });
  }

  const fallbackWindow = await createDoudianSignerWindow(partition, operation, adapter, plan);
  try {
    const signed = await signUrlWithWindow(fallbackWindow, targetUrl, operation, adapter, plan, context);
    if (signed?.ok) return applySignedUrlResult(targetUrl, signed, plan);
    logStoreEvent("doudian.sign.failed", {
      partition,
      url: targetUrl,
      result: signed
    });
    return "";
  } finally {
    if (!fallbackWindow.isDestroyed()) fallbackWindow.destroy();
  }
}

async function doudianRequestGet(partition, url, operation = null, adapter = adapterFor(operation)) {
  throwIfCancelled(operation);
  return platformRequestGet({
    partition,
    url,
    adapter,
    timeoutMs: adapterTimeout(adapter, "requestMs"),
    safeError
  });
}

function renderPlanTemplateValue(value, context = {}) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((item) => renderPlanTemplateValue(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, next]) => [key, renderPlanTemplateValue(next, context)])
    );
  }
  if (typeof value !== "string") return value;
  const directMatch = value.match(/^\{([a-zA-Z0-9_.-]+)\}$/);
  if (directMatch) {
    const direct = getPath(context, directMatch[1]);
    if (direct !== undefined && direct !== null) return direct;
  }
  return value.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_match, key) => {
    const next = getPath(context, key);
    return next === undefined || next === null ? "" : String(next);
  });
}

function applyPlanRawQuery(url, plan = {}, context = {}) {
  const source = plan.rawQuery ?? plan.queryString ?? "";
  const rendered = renderPlanTemplateValue(source, context);
  const fragments = Array.isArray(rendered) ? rendered : [rendered];
  for (const fragment of fragments) {
    const text = String(fragment || "").trim().replace(/^[?&]+/, "");
    if (!text) continue;
    const params = new URLSearchParams(text);
    for (const [key, value] of params.entries()) {
      url.searchParams.append(key, value);
    }
  }
  return url;
}

function applyPlanQuery(url, plan = {}, context = {}) {
  const query = plan.query && typeof plan.query === "object" ? plan.query : {};
  for (const [key, value] of Object.entries(query)) {
    const rendered = renderPlanTemplateValue(value, context);
    if (Array.isArray(rendered)) {
      url.searchParams.delete(key);
      for (const item of rendered) {
        if (item !== undefined && item !== null && item !== "") url.searchParams.append(key, String(item));
      }
    } else if (rendered !== undefined && rendered !== null && rendered !== "") {
      url.searchParams.set(key, String(rendered));
    }
  }
  return url;
}

function requestPlanUrl(adapter, plan, context = {}) {
  const endpoint = requestPlanEndpoint(adapter, plan);
  if (!endpoint) return "";
  const url = new URL(signedEndpointUrl(adapter, endpoint, {
    signatureParam: plan.signatureParam,
    includeEmptySignature: plan.includeEmptySignature,
    sign: plan.sign
  }));
  applyPlanRawQuery(url, plan, context);
  applyPlanQuery(url, plan, context);
  return url.toString();
}

function requestPlanData(plan = {}, context = {}) {
  if (Object.prototype.hasOwnProperty.call(plan, "body")) return renderPlanTemplateValue(plan.body, context);
  if (Object.prototype.hasOwnProperty.call(plan, "data")) return renderPlanTemplateValue(plan.data, context);
  return undefined;
}

function requestPlan(adapter, key) {
  return adapter?.requestPlans?.[key] || DOUDIAN_ADAPTER.requestPlans?.[key] || {};
}

function requestPlanEndpoint(adapter, plan) {
  const endpointKey = plan.endpointKey || "";
  return adapter.endpoints?.[endpointKey] || "";
}

function requestPlanResponseMessage(response) {
  return clipText(
    response?.data?.msg ||
    response?.data?.message ||
    response?.data?.status_msg ||
    response?.error?.message ||
    "",
    240
  );
}

function requestPlanResponseMessages(response) {
  return [
    response?.data?.msg,
    response?.data?.message,
    response?.data?.status_msg,
    response?.data?.statusMessage,
    response?.error?.message
  ].map((item) => String(item || "")).filter(Boolean);
}

function requestPlanResponseMatches(response, patterns = []) {
  const messages = requestPlanResponseMessages(response);
  if (!messages.length) return false;
  return patterns.some((pattern) => {
    const needle = String(pattern || "");
    return needle && messages.some((message) => message.includes(needle));
  });
}

function requestPlanSuccessCodes(plan = {}, mappings = {}) {
  return [
    ...(Array.isArray(mappings.successCodes) ? mappings.successCodes : []),
    ...(Array.isArray(plan.successCodes) ? plan.successCodes : [])
  ].map((item) => String(item));
}

function requestPlanSuccessMessages(plan = {}) {
  return Array.isArray(plan.successMessages)
    ? plan.successMessages.map((item) => String(item || "")).filter(Boolean)
    : [];
}

function requestPlanResponseOk(response, adapter = DOUDIAN_ADAPTER, planKey = "", mappings = {}) {
  if (!response?.success) return false;
  const plan = requestPlan(adapter, planKey);
  const failureMessages = [
    ...(Array.isArray(plan.failureMessages) ? plan.failureMessages : []),
    ...(Array.isArray(plan.denyMessages) ? plan.denyMessages : [])
  ];
  if (requestPlanResponseMatches(response, failureMessages)) return false;

  const successPaths = Array.isArray(plan.successPaths) ? plan.successPaths : [];
  const code = responseBusinessCode(response);
  const successCodes = requestPlanSuccessCodes(plan, mappings);
  const codeMatches = code != null && successCodes.length && successCodes.includes(String(code));
  if (codeMatches && plan.allowSuccessCodeOnly === true) return true;
  if (successPaths.length && !responseHasPathValue(response, successPaths)) return false;
  if (code != null && successCodes.length) return codeMatches;

  const successMessages = requestPlanSuccessMessages(plan);
  if (successMessages.length && requestPlanResponseMatches(response, successMessages)) return true;
  if (successPaths.length) return responseHasPathValue(response, successPaths);
  if (code == null && successCodes.length && plan.allowMissingCode !== true) return false;
  return true;
}

function requestPlanDomain(adapter = DOUDIAN_ADAPTER, planKey = "") {
  const plan = requestPlan(adapter, planKey);
  const domain = String(plan.domain || plan.dataDomain || "");
  if (domain) return domain;
  if (policyArray(adapter, "fundsData.requestPlans", []).map(String).includes(String(planKey))) return "fundsData";
  if (policyArray(adapter, "violationsData.requestPlans", []).map(String).includes(String(planKey))) return "violationsData";
  if (policyArray(adapter, "businessData.requestPlans", []).map(String).includes(String(planKey))) return "businessData";
  if (policyArray(adapter, "staleGoodsCleanup.requestPlans", []).map(String).includes(String(planKey))) return "staleGoodsCleanup";
  const executePlans = policy(adapter, "staleGoodsCleanup.executePlans", {});
  if (executePlans && typeof executePlans === "object" && Object.values(executePlans).map(String).includes(String(planKey))) return "staleGoodsCleanup";
  return "";
}

function requestPlanDomainMappings(adapter = DOUDIAN_ADAPTER, planKey = "") {
  const domain = requestPlanDomain(adapter, planKey);
  if (domain === "fundsData") return fundsDataMappings(adapter);
  if (domain === "violationsData") return violationsDataMappings(adapter);
  if (domain === "businessData") return businessDataMappings(adapter);
  if (domain === "staleGoodsCleanup") return staleGoodsCleanupMappings(adapter);
  return {};
}

function requestPlanContractSuccess(response, adapter = DOUDIAN_ADAPTER, planKey = "") {
  const mappings = requestPlanDomainMappings(adapter, planKey);
  if (Object.keys(mappings || {}).length) return requestPlanResponseOk(response, adapter, planKey, mappings);
  return requestPlanResponseOk(response, adapter, planKey, fundsDataMappings(adapter)) ||
    requestPlanResponseOk(response, adapter, planKey, violationsDataMappings(adapter)) ||
    requestPlanResponseOk(response, adapter, planKey, businessDataMappings(adapter)) ||
    requestPlanResponseOk(response, adapter, planKey, staleGoodsCleanupMappings(adapter));
}

function summarizeRequestPlanResponse(response, adapter = DOUDIAN_ADAPTER, planKey = "", plan = requestPlan(adapter, planKey)) {
  const contractSuccess = requestPlanContractSuccess(response, adapter, planKey);
  return {
    status: response?.status || 0,
    success: !!response?.success,
    businessSuccess: contractSuccess,
    contractSuccess,
    code: responseBusinessCode(response),
    hasSuccessPath: responseHasPathValue(response, Array.isArray(plan.successPaths) ? plan.successPaths : []),
    message: clipText(
      response?.data?.msg ||
      response?.data?.message ||
      response?.data?.status_msg ||
      response?.error?.message ||
      "",
      160
    )
  };
}

async function prepareRequestPlanContext(partition, planKey, plan = {}, operation = null, adapter = adapterFor(operation), context = {}) {
  const prepareUrl = renderPlanTemplateValue(plan.prepareUrl || "", context);
  if (!prepareUrl) return false;
  const win = createBrowserWindow({
    partition,
    show: false,
    title: "赤狐管家 - 抖店数据准备",
    adapter
  });
  trackOperationWindow(operation, win);
  try {
    const loadResult = await loadUrl(win, prepareUrl, Math.max(1, Number(plan.prepareLoadMs || adapterTimeout(adapter, "loadMs"))));
    const waitMs = Math.max(0, Number(plan.prepareWaitMs || 0));
    if (waitMs) await delayWithCancel(waitMs, operation);
    logStoreEvent(`doudian.${planKey}.prepared`, {
      partition,
      url: prepareUrl,
      ok: !!loadResult?.ok,
      error: loadResult?.errorDescription || ""
    });
    return true;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function browserFetchHeaders(adapter = DOUDIAN_ADAPTER, plan = {}) {
  const requestPolicy = adapter?.policies?.platformRequest || {};
  const configuredHeaders = requestPolicy.headers && typeof requestPolicy.headers === "object"
    ? requestPolicy.headers
    : {};
  const planHeaders = plan?.headers && typeof plan.headers === "object"
    ? plan.headers
    : {};
  const forbidden = new Set(["cookie", "host", "origin", "referer", "user-agent", "content-length"]);
  const headers = {};
  for (const [key, value] of Object.entries({ ...configuredHeaders, ...planHeaders })) {
    const name = String(key || "").trim();
    if (!name || forbidden.has(name.toLowerCase()) || value === undefined || value === null) continue;
    headers[name] = String(value);
  }
  return headers;
}

async function doudianPageFetchByPlan(partition, url, planKey, operation = null, signerWindow = null, adapter = adapterFor(operation), plan = {}, context = {}) {
  throwIfCancelled(operation);
  const timeoutMs = Math.max(1, Number(plan.pageFetchTimeoutMs || plan.timeoutMs || adapterTimeout(adapter, "requestMs")));
  const data = requestPlanData(plan, context);
  const method = String(plan?.method || "GET").toUpperCase();
  const payload = {
    url,
    method,
    headers: browserFetchHeaders(adapter, plan),
    data: data !== undefined && method !== "GET" && method !== "HEAD" ? data : undefined,
    timeoutMs
  };
  const source = `
    (async (payload) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Number(payload.timeoutMs || 1)));
      try {
        const init = {
          method: payload.method || "GET",
          credentials: "include",
          headers: payload.headers || {},
          signal: controller.signal
        };
        if (payload.data !== undefined && init.method !== "GET" && init.method !== "HEAD") {
          init.body = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data);
        }
        const response = await fetch(payload.url, init);
        const text = await response.text();
        let data = text;
        try { data = JSON.parse(text); } catch {}
        return {
          success: response.status >= 200 && response.status < 300,
          status: response.status,
          url: response.url,
          data,
          error: response.status >= 400 ? { status: response.status, message: text.slice(0, 240) } : null
        };
      } catch (error) {
        return {
          success: false,
          status: 0,
          url: payload.url,
          data: null,
          error: { message: error && error.message ? error.message : String(error) }
        };
      } finally {
        clearTimeout(timer);
      }
    })(${JSON.stringify(payload)});
  `;
  let win = signerWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    win = await getCachedDoudianSignerWindow(partition, operation, adapter, plan);
  }
  const response = await executeRemotePageScript(
    win,
    source,
    "doudian page fetch",
    timeoutMs + 1000,
    { script: "pageFetch", planKey, targetUrl: url }
  );
  const businessOk = isBusinessResponseOk(response, adapter, planKey);
  logStoreEvent(`doudian.${planKey}.pageFetch`, {
    partition,
    status: response?.status || 0,
    success: !!response?.success,
    businessSuccess: businessOk,
    code: responseBusinessCode(response),
    hasSuccessPath: responseHasPathValue(response, Array.isArray(plan.successPaths) ? plan.successPaths : []),
    url: response?.url || url,
    message: clipText(
      response?.data?.msg ||
      response?.data?.message ||
      response?.data?.status_msg ||
      response?.error?.message ||
      "",
      160
    )
  });
  return response;
}

function operationPlan(adapter, key) {
  return adapter?.operationPlans?.[key] || DOUDIAN_ADAPTER.operationPlans?.[key] || {};
}

function operationPlanActions(adapter, key) {
  return actionList(adapter, key, []);
}

function requireOperationActions(adapter, key, requiredActions, fallbackActions = []) {
  const actionNames = new Set(actionList(adapter, key, fallbackActions).map((action) => action?.action).filter(Boolean));
  const missing = requiredActions.filter((action) => !actionNames.has(action));
  if (missing.length) {
    throw new Error(`remote ${key} operation plan missing actions: ${missing.join(", ")}`);
  }
}

async function doudianRequestByPlan(partition, planKey, operation = null, signerWindow = null, adapter = adapterFor(operation), context = {}) {
  const plan = requestPlan(adapter, planKey);
  const plannedUrl = requestPlanUrl(adapter, plan, context);
  if (!plannedUrl) {
    return {
      success: false,
      status: 0,
      data: null,
      error: { message: `missing endpoint for ${planKey}` }
    };
  }

  let url = plannedUrl;
  if (plan.debugPlan === true) {
    const plannedData = requestPlanData(plan, context);
    logStoreEvent(`doudian.${planKey}.planned`, {
      partition,
      method: String(plan?.method || "GET").toUpperCase(),
      endpoint: requestPlanEndpoint(adapter, plan),
      url: plannedUrl,
      hasBody: plannedData !== undefined,
      signStrategy: String(plan.signStrategy || ""),
      localSigner: plan.localSigner === true,
      adapterVersion: adapter.version || "",
      scriptsVersion: adapter.scripts?.version || ""
    });
  }
  if (plan.sign !== false) {
    const signedUrl = await signDoudianUrl(partition, url, operation, signerWindow, adapter, plan, context);
    if (signedUrl) {
      url = signedUrl;
    } else if (plan.pageFetchOnSignFailure === true || plan.requestMode === "page-fetch") {
      return doudianPageFetchByPlan(partition, plannedUrl, planKey, operation, signerWindow, adapter, plan, context);
    } else {
      return {
        success: false,
        status: 0,
        data: null,
        error: { message: "sign failed" }
      };
    }
  }

  const timeoutMs = Math.max(1, Number(plan.timeoutMs || adapterTimeout(adapter, "requestMs")));
  const data = requestPlanData(plan, context);
  const method = String(plan?.method || "GET").toUpperCase();
  const runRequest = async (attempt = 0) => {
    if (plan.requestMode === "page-fetch") {
      return doudianPageFetchByPlan(partition, url, planKey, operation, signerWindow, adapter, plan, context);
    }
    const response = await platformRequestGet({
        partition,
        url,
        adapter,
        timeoutMs,
        safeError,
        plan,
        data
      });
    logStoreEvent(`doudian.${planKey}.platform`, {
      partition,
      attempt,
      method,
      endpoint: requestPlanEndpoint(adapter, plan),
      url,
      ...summarizeRequestPlanResponse(response, adapter, planKey, plan)
    });
    return response;
  };

  let response = await runRequest();
  const prepareMessages = Array.isArray(plan.prepareOnMessages)
    ? plan.prepareOnMessages.map((item) => String(item || "")).filter(Boolean)
    : [];
  const prepareAttempts = Math.max(0, Math.min(3, Math.floor(Number(plan.prepareRetryAttempts || (prepareMessages.length ? 1 : 0)))));
  for (let attempt = 0; attempt < prepareAttempts && requestPlanResponseMatches(response, prepareMessages); attempt += 1) {
    logStoreEvent(`doudian.${planKey}.prepareRetry`, {
      partition,
      attempt: attempt + 1,
      message: requestPlanResponseMessage(response)
    });
    const delayMs = Math.max(0, Number(plan.prepareRetryDelayMs || 0)) * (plan.prepareRetryBackoff === "linear" ? attempt + 1 : 1);
    if (delayMs > 0) await delayWithCancel(delayMs, operation);
    await prepareRequestPlanContext(partition, planKey, plan, operation, adapter, context);
    response = await runRequest(`prepare-${attempt + 1}`);
  }

  const maxAttempts = Math.max(1, Math.floor(Number(plan.maxAttempts || 1)));
  if (plan.retryOnHttpError && (response?.error?.status > 0 || (response?.status >= 400))) {
    for (let attempt = 1; attempt < maxAttempts && (response?.error || (response?.status >= 400)); attempt += 1) {
      logStoreEvent(`doudian.${planKey}.retry`, {
        partition,
        attempt,
        status: response?.error?.status || response?.status || 0
      });
      const delayMs = Math.max(0, Number(plan.retryDelayMs || 1000)) * (plan.retryBackoff === "linear" ? attempt : 1);
      await delayWithCancel(delayMs, operation);
      response = await runRequest(attempt);
    }
  }

  if (plan.retryOnBusinessFailure) {
    for (let attempt = 1; attempt < maxAttempts && !requestPlanContractSuccess(response, adapter, planKey); attempt += 1) {
      logStoreEvent(`doudian.${planKey}.businessRetry`, {
        partition,
        attempt,
        message: requestPlanResponseMessage(response),
        code: responseBusinessCode(response)
      });
      const delayMs = Math.max(0, Number(plan.retryDelayMs || 1000)) * (plan.retryBackoff === "linear" ? attempt : 1);
      await delayWithCancel(delayMs, operation);
      response = await runRequest(`business-${attempt}`);
    }
  }

  return response;
}

async function doudianGetShopList(partition, operation = null, signerWindow = null, adapter = adapterFor(operation)) {
  const response = await doudianRequestByPlan(partition, "shopList", operation, signerWindow, adapter);
  let mallList = [];
  try {
    mallList = firstArray(response?.data, mappingArray(adapter, "shopListPaths"));
  } catch {}
  if (!Array.isArray(mallList)) mallList = [];
  if (!response?.success || mallList.length === 0) {
    logStoreEvent("doudian.getshoplist.result", {
      partition,
      ...summarizeDoudianResponse(response),
      count: mallList.length
    });
  }
  return { mallList, response };
}

async function doudianGetCurrentMallId(partition, operation = null, signerWindow = null, adapter = adapterFor(operation)) {
  const response = await doudianRequestByPlan(partition, "currentShop", operation, signerWindow, adapter);
  let currentMallId = "";
  try {
    currentMallId = extractCurrentShopId(response?.data, adapter);
  } catch {}
  if (!response?.success || !currentMallId) {
    logStoreEvent("doudian.getshoplevel.result", {
      partition,
      ...summarizeDoudianResponse(response),
      currentMallId: currentMallId == null ? "" : String(currentMallId)
    });
  }
  return { currentMallId: currentMallId == null ? "" : String(currentMallId), response };
}

async function getShopUserInfo(partition, operation = null, signerWindow = null, adapter = adapterFor(operation)) {
  throwIfCancelled(operation);
  const infoPlan = requestPlan(adapter, "getShopUserInfo");
  const actions = operationPlanActions(adapter, "getShopUserInfo");
  const httpActions = actions.filter((action) => action?.action === "httpRequestByPlan");
  const fallbackActions = actions.filter((action) => action?.action === "executeRemoteScript");
  const steps = httpActions.length
    ? httpActions.map((action) => action.requestPlan).filter(Boolean)
    : (Array.isArray(infoPlan.steps) && infoPlan.steps.length ? infoPlan.steps : ["shopList", "currentShop"]);
  const pageFallbackEnabled = fallbackActions.length
    ? fallbackActions.some((action) => action.scriptKey === "probeFactory" && action.onError !== "fail")
    : infoPlan.pageFallback !== false;
  let shopListResult = { mallList: [], response: null };
  let currentResult = { currentMallId: "", response: null };
  for (const step of steps) {
    throwIfCancelled(operation);
    if (step === "shopList") {
      shopListResult = await doudianGetShopList(partition, operation, signerWindow, adapter);
    } else if (step === "currentShop") {
      currentResult = await doudianGetCurrentMallId(partition, operation, signerWindow, adapter);
    }
  }
  const mallList = shopListResult.mallList || [];
  const currentMallId = currentResult.currentMallId || "";
  const normalizedMallList = extractShopList(mallList, adapter);
  const matchedShop = normalizedMallList.find((shop) => String(shop.shopId) === String(currentMallId));
  const matched = matchedShop?.rawSummary || mallList.find((shop) => {
    const item = normalizeShopItem(shop, adapter);
    return item && String(item.shopId) === String(currentMallId);
  });
  const responses = shopUserInfoResponseSummary(shopListResult, currentResult);
  const successSources = new Set(policyArray(adapter, "getShopUserInfo.successSources", ["matchedShop", "currentMallId", "pageFallback"]).map(String));

  if (matchedShop && successSources.has("matchedShop")) {
    const statusConfig = responseMappings(adapter).operateStatus || {};
    const normalCodes = new Set((statusConfig.normalCodes || []).map((item) => String(item)));
    const statusCode = matchedShop.rawSummary?.operate_status;
    return {
      shop_name: matchedShop.shopName,
      id: String(matchedShop.shopId),
      operateStatusStr: matchedShop.operateStatus || (normalCodes.has(String(statusCode)) ? statusConfig.normalLabel : statusConfig.abnormalLabel),
      isLogin: true,
      mallList,
      currentMallId,
      raw: matched,
      responses
    };
  }

  const allowCurrentMallFallback = successSources.has("currentMallId");
  const requireCurrentShopSuccess = policyBool(adapter, "getShopUserInfo.requireCurrentShopSuccessForCurrentMallFallback", true);
  if (allowCurrentMallFallback && currentMallId && (!requireCurrentShopSuccess || responses.currentShop?.success)) {
    const fallbackSource = policyText(adapter, "getShopUserInfo.currentMallFallbackSource", "current-mall-id");
    logStoreEvent("doudian.getShopUserInfo.currentMallFallback", {
      partition,
      currentMallId,
      mallListCount: Array.isArray(mallList) ? mallList.length : 0,
      responses
    });
    return {
      shop_name: "",
      id: String(currentMallId),
      operateStatusStr: "",
      isLogin: true,
      mallList,
      currentMallId,
      raw: { id: String(currentMallId), source: fallbackSource },
      responses: {
        ...responses,
        fallback: fallbackSource
      }
    };
  }

  if (signerWindow && pageFallbackEnabled && successSources.has("pageFallback")) {
    try {
      const probeResult = await probeWindow(signerWindow, adapter);
      const detected = await detectCurrentShopWithPartition(probeResult, partition, adapter);
      const fallbackShop = detected.currentShop;
      if (fallbackShop?.shopId || fallbackShop?.shopName) {
        const fallbackId = String(fallbackShop.shopId || detected.currentShopId || "");
        const fallbackName = String(fallbackShop.shopName || "");
        const fallbackMallList = detected.shopList.map((shop) => shop.rawSummary || {
          id: shop.shopId,
          shop_name: shop.shopName
        });
        logStoreEvent("doudian.getShopUserInfo.pageFallback", {
          partition,
          currentShop: summarizeShop(fallbackShop),
          detectionSource: detected.detectionSource || "",
          probe: summarizeProbe(probeResult, detected),
          responses
        });
        return {
          shop_name: fallbackName,
          id: fallbackId,
          operateStatusStr: fallbackShop.operateStatus || "",
          isLogin: !!(fallbackId || fallbackName),
          mallList: fallbackMallList,
          currentMallId: detected.currentShopId || fallbackId,
          raw: fallbackShop.rawSummary || { id: fallbackId, shop_name: fallbackName },
          responses: {
            ...responses,
            fallback: policyText(adapter, "getShopUserInfo.pageFallbackSource", "page-fetch")
          }
        };
      }
    } catch (error) {
      logStoreEvent("doudian.getShopUserInfo.pageFallback.failed", {
        partition,
        error: safeError(error),
        responses
      });
    }
  }

  return {
    isLogin: false,
    mallList,
    currentMallId,
    responses
  };
}

function selectPathArrayItem(value, selector) {
  if (!Array.isArray(value)) return undefined;
  const indexMatch = String(selector || "").match(/^\d+$/);
  if (indexMatch) return value[Number(selector)];
  const equalsIndex = String(selector || "").indexOf("=");
  if (equalsIndex <= 0) return undefined;
  const key = selector.slice(0, equalsIndex).trim();
  const expected = selector.slice(equalsIndex + 1).trim();
  return value.find((item) => String(getPath(item, key) ?? "") === expected);
}

function getPathSegment(value, segment) {
  const text = String(segment || "");
  const keyMatch = text.match(/^([^\[]*)/);
  const key = keyMatch ? keyMatch[1] : text;
  let current = key ? value?.[key] : value;
  const selectors = text.match(/\[([^\]]+)\]/g) || [];
  for (const selectorText of selectors) {
    if (current == null) return undefined;
    current = selectPathArrayItem(current, selectorText.slice(1, -1));
  }
  return current;
}

function getPath(value, path) {
  return String(path || "").split(".").reduce((current, key) => {
    if (current == null) return undefined;
    return getPathSegment(current, key);
  }, value);
}

function firstValue(value, paths) {
  for (const path of paths) {
    const next = getPath(value, path);
    if (next !== undefined && next !== null && next !== "") return next;
  }
  return undefined;
}

function firstArray(value, paths) {
  if (Array.isArray(value)) return value;
  for (const path of paths) {
    const next = path ? getPath(value, path) : value;
    if (Array.isArray(next)) return next;
  }
  return [];
}

function responseMappings(adapter = DOUDIAN_ADAPTER) {
  return adapter?.responseMappings || DOUDIAN_ADAPTER.responseMappings || {};
}

function mappingArray(adapter, key) {
  const mappings = responseMappings(adapter);
  return Array.isArray(mappings[key]) ? mappings[key] : [];
}

function shopFieldPaths(adapter, key) {
  const fields = responseMappings(adapter).shopFields || {};
  return Array.isArray(fields[key]) ? fields[key] : [];
}

function normalizeShopItem(item, adapter = DOUDIAN_ADAPTER) {
  if (!item || typeof item !== "object") return null;
  const shopId = firstValue(item, shopFieldPaths(adapter, "id"));
  const shopName = firstValue(item, shopFieldPaths(adapter, "name"));
  if (!shopId || !shopName) return null;

  return {
    shopId: String(shopId),
    shopName: String(shopName),
    operateStatus: firstValue(item, shopFieldPaths(adapter, "operateStatus")),
    rawSummary: {
      id: String(shopId),
      shop_name: String(shopName),
      sec_shop_id: firstValue(item, shopFieldPaths(adapter, "secShopId")),
      ocean_id: firstValue(item, shopFieldPaths(adapter, "oceanId")),
      toutiao_id: firstValue(item, shopFieldPaths(adapter, "toutiaoId")),
      operate_status: firstValue(item, shopFieldPaths(adapter, "operateStatusCode")),
      operate_status_readable: firstValue(item, shopFieldPaths(adapter, "operateStatusReadable"))
    }
  };
}

function extractShopList(platformResponse, adapter = DOUDIAN_ADAPTER) {
  const candidates = firstArray(platformResponse, mappingArray(adapter, "shopListPaths"));
  return candidates.map((item) => normalizeShopItem(item, adapter)).filter(Boolean);
}

function extractCurrentShopId(platformResponse, adapter = DOUDIAN_ADAPTER) {
  const value = firstValue(platformResponse, mappingArray(adapter, "currentShopIdPaths"));
  return value == null ? "" : String(value);
}

function detectCurrentShop(probeResult, adapter = DOUDIAN_ADAPTER) {
  const shopList = extractShopList(probeResult?.shopListResponse?.data, adapter);
  const currentShopId = extractCurrentShopId(probeResult?.currentShopResponse?.data, adapter);
  const currentRaw = normalizeShopItem(firstValue(probeResult?.currentShopResponse?.data, mappingArray(adapter, "currentShopObjectPaths")), adapter);

  let currentShop = currentShopId ? shopList.find((shop) => shop.shopId === currentShopId) : null;
  if (!currentShop && currentRaw) currentShop = currentRaw;
  if (!currentShop && policyBool(adapter, "getShopUserInfo.singleShopListFallback", true) && shopList.length === 1) currentShop = shopList[0];
  if (!currentShop && policyBool(adapter, "getShopUserInfo.headerShopNameFallback", true) && probeResult?.headerShopName) {
    const header = String(probeResult.headerShopName).trim();
    currentShop = shopList.find((shop) => shop.shopName === header || shop.shopName.includes(header) || header.includes(shop.shopName));
  }

  return {
    currentShop,
    currentShopId,
    shopList
  };
}

function summarizeShop(shop) {
  if (!shop) return null;
  return {
    shopId: shop.shopId,
    shopName: shop.shopName,
    operateStatus: shop.operateStatus || ""
  };
}

function uniqueShops(shops) {
  const byId = new Map();
  for (const shop of shops || []) {
    if (!shop?.shopId) continue;
    byId.set(String(shop.shopId), shop);
  }
  return Array.from(byId.values());
}

function uniqueRoleShops(shops) {
  const byKey = new Map();
  for (const shop of shops || []) {
    if (!shop) continue;
    const key = shop.shopId ? `id:${shop.shopId}` : `name:${shop.shopName || ""}`;
    if (!key || key === "name:") continue;
    byKey.set(key, shop);
  }
  return Array.from(byKey.values());
}

function normalizeCookieShopId(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 80) return "";
  if (!/^[a-zA-Z0-9_-]+$/.test(text)) return "";
  return text;
}

async function getCookieHints(partition, adapter = DOUDIAN_ADAPTER) {
  const cookieSession = session.fromPartition(partition);
  const filters = [
    { url: adapter.homeUrl },
    { url: adapter.loginUrl },
    ...(adapter.cookieDomain ? [{ domain: adapter.cookieDomain }] : []),
    {}
  ];
  const byName = new Map();
  const names = new Set();
  const errors = [];
  const hintNames = adapter.cookieHintNames || [];

  for (const filter of filters) {
    try {
      const cookies = await cookieSession.cookies.get(filter);
      for (const cookie of cookies || []) {
        if (!cookie?.name) continue;
        names.add(cookie.name);
        if (!byName.has(cookie.name)) byName.set(cookie.name, []);
        byName.get(cookie.name).push(cookie);
      }
    } catch (error) {
      errors.push(safeError(error));
    }
  }

  for (const name of hintNames) {
    const cookies = byName.get(name) || [];
    for (const cookie of cookies) {
      const shopId = normalizeCookieShopId(cookie.value);
      if (shopId) {
        return {
          shopId,
          matchedCookieName: name,
          cookieNames: Array.from(names)
            .filter((cookieName) => hintNames.includes(cookieName) || /shop|mall|ecom/i.test(cookieName))
            .slice(0, 40),
          error: errors[0] || ""
        };
      }
    }
  }

  return {
    shopId: "",
    matchedCookieName: "",
    cookieNames: Array.from(names)
      .filter((cookieName) => hintNames.includes(cookieName) || /shop|mall|ecom/i.test(cookieName))
      .slice(0, 40),
    error: errors[0] || ""
  };
}

function createCookieFallbackShop(cookieHints, probeResult, shopList) {
  const shopId = normalizeCookieShopId(cookieHints?.shopId);
  if (!shopId) return null;

  const matched = shopList.find((shop) => String(shop.shopId) === shopId);
  if (matched) return matched;

  const headerShopName = clipText(probeResult?.headerShopName, 80);
  const shopName = headerShopName || `抖店 ${shopId}`;
  return {
    shopId,
    shopName,
    operateStatus: "cookie-fallback",
    rawSummary: {
      id: shopId,
      shop_name: shopName,
      source: "cookie-hint"
    }
  };
}

async function detectCurrentShopWithPartition(probeResult, partition, adapter = DOUDIAN_ADAPTER) {
  const detected = detectCurrentShop(probeResult, adapter);
  const cookieHints = await getCookieHints(partition, adapter);
  let currentShop = detected.currentShop;
  let detectionSource = currentShop ? "platform" : "";

  if (!currentShop && policyBool(adapter, "getShopUserInfo.cookieHintFallback", true) && cookieHints.shopId) {
    currentShop = createCookieFallbackShop(cookieHints, probeResult, detected.shopList);
    detectionSource = currentShop ? "cookie-hint" : "";
  }

  return {
    ...detected,
    currentShop,
    currentShopId: detected.currentShopId || currentShop?.shopId || cookieHints.shopId || "",
    detectionSource,
    cookieHints
  };
}

function summarizeProbe(probeResult, detected = null, adapter = DOUDIAN_ADAPTER) {
  const resolvedDetected = detected || detectCurrentShop(probeResult, adapter);
  return {
    href: probeResult?.href || "",
    title: probeResult?.title || "",
    headerShopName: probeResult?.headerShopName || "",
    bodySample: clipText(probeResult?.bodySample, 240),
    currentShopId: resolvedDetected.currentShopId,
    currentShop: summarizeShop(resolvedDetected.currentShop),
    detectionSource: resolvedDetected.detectionSource || "",
    availableCount: resolvedDetected.shopList.length,
    cookieHints: resolvedDetected.cookieHints
      ? {
          shopId: resolvedDetected.cookieHints.shopId || "",
          matchedCookieName: resolvedDetected.cookieHints.matchedCookieName || "",
          cookieNames: resolvedDetected.cookieHints.cookieNames || [],
          error: resolvedDetected.cookieHints.error || ""
        }
      : null,
    requests: {
      shopList: {
        ok: !!probeResult?.shopListResponse?.ok,
        status: probeResult?.shopListResponse?.status || null,
        error: probeResult?.shopListResponse?.error || ""
      },
      currentShop: {
        ok: !!probeResult?.currentShopResponse?.ok,
        status: probeResult?.currentShopResponse?.status || null,
        error: probeResult?.currentShopResponse?.error || ""
      }
    }
  };
}

function detectedFromShopUserInfo(shopUserInfo, adapter = DOUDIAN_ADAPTER) {
  const shopList = extractShopList(shopUserInfo?.mallList || [], adapter);
  const currentShopId = shopUserInfo?.id ? String(shopUserInfo.id) : String(shopUserInfo?.currentMallId || "");
  const currentShop = shopUserInfo?.id
    ? normalizeShopItem({
        ...(shopUserInfo.raw || {}),
        id: shopUserInfo.id,
        shop_name: shopUserInfo.shop_name,
        operateStatusStr: shopUserInfo.operateStatusStr
      }, adapter)
    : null;

  return {
    currentShop,
    currentShopId,
    shopList,
    detectionSource: "doudian-get-shop-user-info",
    shopUserInfo
  };
}

function summarizeShopUserInfo(shopUserInfo) {
  if (!shopUserInfo) return null;
  return {
    id: shopUserInfo.id ? String(shopUserInfo.id) : "",
    shop_name: shopUserInfo.shop_name || "",
    isLogin: !!shopUserInfo.isLogin,
    operateStatusStr: shopUserInfo.operateStatusStr || "",
    currentMallId: shopUserInfo.currentMallId || "",
    mallListCount: Array.isArray(shopUserInfo.mallList) ? shopUserInfo.mallList.length : 0,
    responses: shopUserInfo.responses || null
  };
}

function classifyStoreFailure(errorOrMessage, fallbackReason = "unknown", adapter = DOUDIAN_ADAPTER) {
  return classifyStoreFailureWithRules(errorOrMessage, fallbackReason, adapter, { safeError, adapterStrategies });
}

function buildStoreFailure(shop, errorOrMessage, extra = {}, adapter = DOUDIAN_ADAPTER) {
  return buildStoreFailureWithRules(shop, errorOrMessage, extra, adapter, { safeError, adapterStrategies });
}

function buildStoreRecord(shop, partition, status = "online", adapter = DOUDIAN_ADAPTER) {
  const now = new Date().toISOString();
  const shopId = shop.shopId || shop.id;
  const shopName = shop.shopName || shop.shop_name || "";
  return {
    shopId: String(shopId || ""),
    shopName: String(shopName || ""),
    platform: policyText(adapter, "repository.defaultPlatform", "doudian"),
    partition,
    status,
    operateStatus: shop.operateStatus || "",
    shopInfoSummary: shop.rawSummary || shop.raw || { id: shopId, shop_name: shopName },
    createdAt: now,
    updatedAt: now,
    lastFetchAt: now,
    lastLoginCheckAt: now,
    lastFailureReason: "",
    lastFailureMessage: "",
    adapterVersion: adapter.version || ""
  };
}

function freshShopPartition(shop, adapter = DOUDIAN_ADAPTER) {
  const token = `${shop.shopId || shop.shopName || "shop"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return doudianShopPartition(token, adapter);
}

function isTargetShopDetected(detected, shopId) {
  return (
    !!detected?.currentShop &&
    detected.detectionSource !== "cookie-hint" &&
    String(detected.currentShop.shopId) === String(shopId)
  );
}

async function waitForDoudianRoleWindow(win, timeoutMs, operation = null, adapter = adapterFor(operation)) {
  const deadline = Date.now() + timeoutMs;
  let names = [];
  let isHomePage = false;
  let attempts = 0;
  const strategies = adapterStrategies(adapter);
  const roleListPollMs = Number(strategies.roleListPollMs || 1500);
  const homePageConfirmAttempts = Number(strategies.homePageConfirmAttempts || 8);

  while (Date.now() < deadline) {
    throwIfCancelled(operation);
    attempts += 1;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return {
        cancelled: true,
        newShopNameList: names,
        isHomePage
      };
    }

    await delayWithCancel(roleListPollMs, operation);
    try {
      names = await executeRemotePageScript(
        win,
        requireRemoteScript(adapter, "collectRoleShopNames"),
        "doudian collect role shops",
        adapterTimeout(adapter, "probeMs"),
        { script: "collectRoleShopNames" }
      );
      if (!Array.isArray(names)) names = [];
    } catch {
      names = [];
    }
    if (names.length > 0) {
      return {
        cancelled: false,
        newShopNameList: names,
        isHomePage: false
      };
    }

    try {
      isHomePage = !!(await executeRemotePageScript(
        win,
        requireRemoteScript(adapter, "isHomePage"),
        "doudian check home page",
        adapterTimeout(adapter, "probeMs"),
        { script: "isHomePage" }
      ));
    } catch {
      isHomePage = false;
    }
    if (attempts > homePageConfirmAttempts && isHomePage) {
      return {
        cancelled: false,
        newShopNameList: [adapter.labels?.singleLogin || ""],
        isHomePage: true
      };
    }
  }

  return {
    cancelled: false,
    timedOut: true,
    newShopNameList: names,
    isHomePage
  };
}

function shopsFromRoleNames(roleNames, shopList) {
  const normalizedNames = (roleNames || []).map((name) => String(name || "").trim()).filter(Boolean);
  const shops = [];
  const roleOnlyShops = [];
  const missing = [];
  const byName = new Map((shopList || []).map((shop) => [String(shop.shopName || "").trim(), shop]));

  for (const name of normalizedNames) {
    const exact = byName.get(name);
    const loose = exact || (shopList || []).find((shop) => {
      const shopName = String(shop.shopName || "").trim();
      return shopName && (shopName.includes(name) || name.includes(shopName));
    });
    if (loose) {
      shops.push(loose);
      roleOnlyShops.push(loose);
    } else {
      const roleOnly = {
        shopId: "",
        shopName: name,
        operateStatus: "",
        rawSummary: { shop_name: name, source: "doudian-role-list" }
      };
      roleOnlyShops.push(roleOnly);
      missing.push(name);
    }
  }

  return {
    shops: uniqueShops(shops),
    roleOnlyShops: uniqueRoleShops(roleOnlyShops),
    missing
  };
}

async function selectTargetShopInWindow(win, target, timeoutMs, operation = null, adapter = adapterFor(operation)) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  let attempts = 0;
  const strategies = adapterStrategies(adapter);
  const homePageReadyAttempts = Number(strategies.shopSwitchHomePageReadyAttempts || 8);
  const homePageReadyPathHints = Array.isArray(strategies.homePageReadyPathHints) ? strategies.homePageReadyPathHints : [];

  while (Date.now() < deadline) {
    throwIfCancelled(operation);
    attempts += 1;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return lastResult || { ok: false, reason: "window-destroyed" };
    }

    try {
      const remoteSwitchScript = remoteFactoryCall(requireRemoteScript(adapter, "switchShopFactory"), { shop: target, adapter });
      lastResult = await executeRemotePageScript(
        win,
        remoteSwitchScript,
        "doudian select shop",
        adapterTimeout(adapter, "probeMs"),
        {
          script: "switchShopFactory",
          shopId: target?.shopId || "",
          shopName: target?.shopName || ""
        }
      );
    } catch (error) {
      lastResult = { ok: false, reason: "script-error", error: safeError(error) };
    }

    if (lastResult?.ok) return lastResult;
    if (attempts > homePageReadyAttempts && homePageReadyPathHints.some((hint) => String(lastResult?.href || "").includes(String(hint)))) {
      return {
        ...lastResult,
        ok: false,
        reason: "home-page-ready"
      };
    }
    await delayWithCancel(adapterTimeout(adapter, "shopSwitchPollMs"), operation);
  }

  return lastResult || { ok: false, reason: "select-timeout" };
}

async function waitForTargetShop(win, partition, target, timeoutMs, operation = null, adapter = adapterFor(operation)) {
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / 1000));
  let lastInfo = null;
  let lastDetected = null;
  const targetShopId = String(target?.shopId || "");
  const targetShopName = String(target?.shopName || "");

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfCancelled(operation);
    lastInfo = await getShopUserInfo(partition, operation, win, adapter);
    lastDetected = detectedFromShopUserInfo(lastInfo, adapter);
    const idMatched = policyBool(adapter, "activateStore.matchById", true) && targetShopId && String(lastInfo?.id || "") === targetShopId;
    const nameMatched = policyBool(adapter, "activateStore.matchByName", true) && targetShopName && String(lastInfo?.shop_name || "") === targetShopName;
    if (lastInfo?.isLogin && (idMatched || nameMatched)) {
      return { ok: true, shopUserInfo: lastInfo, detected: lastDetected };
    }
    await delayWithCancel(1000, operation);
  }

  return { ok: false, shopUserInfo: lastInfo, detected: lastDetected };
}

async function activateDoudianStorePartition(shop, partition, operation = null, adapter = adapterFor(operation)) {
  throwIfCancelled(operation);
  const target = {
    shopId: String(shop.shopId || ""),
    shopName: String(shop.shopName || "")
  };
  logStoreEvent("activate.start", {
    shopId: target.shopId,
    shopName: target.shopName,
    partition,
    method: policyText(adapter, "activateStore.method", "doudian-home-role")
  });

  let switchResult = null;
  let win = null;
  let loadResult = null;
  let waitResult = null;

  try {
    throwIfCancelled(operation);
    logStoreEvent("activate.window.open", {
      shopId: target.shopId,
      shopName: target.shopName,
      partition,
      url: adapter.homeUrl
    });
    const activateContext = {
      partition,
      target,
      operation,
      win: null,
      loadResult: null,
      switchResult: null,
      waitResult: null
    };
    await runActionList(adapter, "activateStore", activateContext, {
      openWindow: async (_action, context) => {
        context.win = createBrowserWindow({
          partition: context.partition,
          show: false,
          title: "赤狐管家 - 抖店切店探针",
          adapter
        });
        trackOperationWindow(operation, context.win);
        return { winId: context.win.id };
      },
      loadUrl: async (_action, context) => {
        if (!context.win) throw new Error("activate loadUrl requires openWindow action");
        context.loadResult = await loadUrl(context.win, adapter.homeUrl, adapterTimeout(adapter, "loadMs"));
        logStoreEvent("activate.window.loaded", {
          shopId: target.shopId,
          shopName: target.shopName,
          partition,
          loadResult: context.loadResult,
          href: context.win.webContents.getURL()
        });
        return context.loadResult;
      },
      selectTargetShop: async (_action, context) => {
        if (!context.win) throw new Error("activate selectTargetShop requires openWindow action");
        logStoreEvent("activate.select.start", {
          shopId: target.shopId,
          shopName: target.shopName,
          partition,
          timeoutMs: adapterTimeout(adapter, "shopSelectMs")
        });
        context.switchResult = await selectTargetShopInWindow(context.win, target, adapterTimeout(adapter, "shopSelectMs"), operation, adapter);
        logStoreEvent("activate.select.done", {
          shopId: target.shopId,
          shopName: target.shopName,
          partition,
          switchResult: context.switchResult
        });
        return context.switchResult;
      },
      waitForTargetShop: async (_action, context) => {
        if (!context.win) throw new Error("activate waitForTargetShop requires openWindow action");
        logStoreEvent("activate.verify.start", {
          shopId: target.shopId,
          shopName: target.shopName,
          partition,
          timeoutMs: adapterTimeout(adapter, "shopSwitchMs")
        });
        context.waitResult = await waitForTargetShop(context.win, partition, target, adapterTimeout(adapter, "shopSwitchMs"), operation, adapter);
        return { ok: !!context.waitResult.ok };
      }
    }, [
      { action: "openWindow" },
      { action: "loadUrl" },
      { action: "selectTargetShop", optional: true, onError: "fallback" },
      { action: "waitForTargetShop" }
    ]);
    win = activateContext.win;
    loadResult = activateContext.loadResult;
    switchResult = activateContext.switchResult || { ok: false, reason: "not-run" };
    waitResult = activateContext.waitResult || { ok: false };
    const ok = !!waitResult.ok;
    logStoreEvent("activate.switch", {
      shopId: target.shopId,
      shopName: target.shopName,
      partition,
      ok,
      loadResult,
      method: policyText(adapter, "activateStore.method", "doudian-home-role"),
      switchResult,
      shopUserInfo: summarizeShopUserInfo(waitResult.shopUserInfo)
    });

    return {
      ok,
      method: switchResult?.ok
        ? policyText(adapter, "activateStore.clickMethod", "doudian-home-role-click")
        : policyText(adapter, "activateStore.probeMethod", "doudian-home-role-probe"),
      shopUserInfo: waitResult.shopUserInfo,
      detected: waitResult.detected,
      switchResult,
      message: ok
        ? policyMessage(adapter, "activateStore.messages.ok", "已切换并确认登录态")
        : policyMessage(adapter, "activateStore.messages.failed", "未能自动切到目标店铺")
    };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

async function activateFreshStorePartition(shop, sourcePartition, previousPartition = "", operation = null, adapter = adapterFor(operation)) {
  throwIfCancelled(operation);
  const partition = freshShopPartition(shop, adapter);
  const copyError = await copyCookies(sourcePartition, partition);
  if (copyError) throw new Error(copyError.message || String(copyError));

  logStoreEvent("activate.copyCookies", {
    shopId: shop.shopId,
    shopName: shop.shopName,
    sourcePartition,
    previousPartition,
    partition
  });

  const activation = await activateDoudianStorePartition(shop, partition, operation, adapter);
  return {
    partition,
    activation
  };
}

const FETCH_STORES_FALLBACK_ACTIONS = [
  { action: "emitProgress" },
  { action: "loginAndDetectStores" },
  { action: "importStores" },
  { action: "emitProgress" },
  { action: "recordStoreAttempts" },
  { action: "upsertStores" }
];

const REFRESH_STATUS_FALLBACK_ACTIONS = [
  { action: "refreshStores" },
  { action: "updateStores" },
  { action: "recordStoreAttempts" }
];

const FETCH_BUSINESS_DATA_FALLBACK_ACTIONS = [
  { action: "collectBusinessData" },
  { action: "recordStoreAttempts" }
];

const FETCH_FUNDS_DATA_FALLBACK_ACTIONS = [
  { action: "collectFundsData" },
  { action: "recordStoreAttempts" }
];

const FETCH_VIOLATIONS_DATA_FALLBACK_ACTIONS = [
  { action: "collectViolationsData" },
  { action: "recordStoreAttempts" }
];

const SCAN_STALE_GOODS_FALLBACK_ACTIONS = [
  { action: "collectStaleGoodsCandidates" },
  { action: "recordStoreAttempts" }
];

const EXECUTE_STALE_GOODS_FALLBACK_ACTIONS = [
  { action: "executeStaleGoodsCleanup" },
  { action: "recordStoreAttempts" }
];

const BUSINESS_DATA_FIELDS = [
  "dealAmount",
  "orderCount",
  "refundAmount",
  "refundOrderCount",
  "platformSubsidyAmount",
  "violationPending",
  "rectificationRisk",
  "pendingShipment",
  "ship24h",
  "overdueShipment",
  "unpaidOrders",
  "afterSalePending",
  "abnormalPackage",
  "serviceOrder",
  "buyers",
  "customerPrice",
  "exposureUsers",
  "clickUsers",
  "productExposureCount",
  "productClickCount",
  "onSaleProductCount",
  "offlineProductCount",
  "experienceScore",
  "refundRate",
  "latest7dUnreadWarning",
  "couponActive",
  "directDiscountActive",
  "newUserBonusActive",
  "reputationScore",
  "logisticsScore",
  "disputeDeduction",
  "productScore",
  "serviceScore"
];

const BUSINESS_METRIC_DIAGNOSTIC_FIELDS = BUSINESS_DATA_FIELDS;

const FUNDS_DATA_FIELDS = [
  "withdrawBalance",
  "balance",
  "frozenBalance",
  "pendingSettleAmount",
  "marginBalance",
  "depositPayable",
  "refundableMargin",
  "baseMarginBalance",
  "baseDepositPayable",
  "baseRefundableMargin",
  "experienceMarginBalance",
  "experienceDepositPayable",
  "experienceRefundableMargin",
  "subsidyTotal",
  "commissionSubsidy",
  "qianchuanSubsidy",
  "compensationOrderCountToday",
  "compensationOrderCount7d",
  "compensationAmountToday",
  "compensationAmount7d",
  "pendingSettleOrderAmount",
  "pendingSettleOrders",
  "riskCount"
];

const FUNDS_METRIC_DIAGNOSTIC_FIELDS = FUNDS_DATA_FIELDS;

const VIOLATION_DATA_FIELDS = [
  "totalRecords",
  "pendingCount",
  "appealCount",
  "rectificationCount",
  "highRiskCount",
  "dueSoonCount",
  "overdueCount",
  "productLinkedCount",
  "productMissingCount",
  "offlineProductCount",
  "failedCount",
  "penaltyAmount"
];

function validIsoDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function compactDate(value) {
  return String(value || "").replace(/-/g, "");
}

function formatLocalIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDateDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function slashDateStart(value) {
  return `${String(value || "").replace(/-/g, "/")} 00:00:00`;
}

function businessPresetPolicy(adapter, preset) {
  const presets = policy(adapter, "businessData.datePresets", {});
  if (!presets || typeof presets !== "object") return {};
  const key = String(preset || "");
  const direct = presets[key];
  if (direct && typeof direct === "object") return direct;
  const config = Object.values(presets).find((item) => item && typeof item === "object" && (
    String(item.dateType || "") === key ||
    String(item.legacyDateType || "") === key ||
    String(item.legacyActiveKey || "") === key
  ));
  return config && typeof config === "object" ? config : {};
}

function dataPolicy(adapter, scope, key, fallback = {}) {
  const next = policy(adapter, `${scope}.${key}`, fallback);
  return next && typeof next === "object" ? next : fallback;
}

function dataPresetPolicy(adapter, scope, preset) {
  const presets = dataPolicy(adapter, scope, "datePresets", {});
  if (!presets || typeof presets !== "object") return {};
  const key = String(preset || "");
  const direct = presets[key];
  if (direct && typeof direct === "object") return direct;
  const config = Object.values(presets).find((item) => item && typeof item === "object" && (
    String(item.dateType || "") === key ||
    String(item.legacyDateType || "") === key ||
    String(item.legacyActiveKey || "") === key
  ));
  return config && typeof config === "object" ? config : {};
}

function dataPresetText(adapter, scope, preset, key, fallback = "") {
  const value = dataPresetPolicy(adapter, scope, preset)[key];
  return value == null ? fallback : String(value);
}

function dataPresetNumber(adapter, scope, preset, key, fallback) {
  const value = Number(dataPresetPolicy(adapter, scope, preset)[key]);
  return Number.isFinite(value) ? value : fallback;
}

function resolveDataDatePreset(adapter = DOUDIAN_ADAPTER, scope = "businessData", value = "today") {
  const key = String(value || "today");
  const presets = dataPolicy(adapter, scope, "datePresets", {});
  if (presets && typeof presets === "object") {
    if (presets[key]) return key;
    const matched = Object.entries(presets).find(([, config]) => config && typeof config === "object" && (
      String(config.dateType || "") === key ||
      String(config.legacyDateType || "") === key ||
      String(config.legacyActiveKey || "") === key
    ));
    if (matched) return matched[0];
  }
  return key;
}

function dataDateContext(args = {}, adapter = DOUDIAN_ADAPTER, scope = "businessData", defaultPreset = "today") {
  const preset = resolveDataDatePreset(adapter, scope, args.datePreset || defaultPreset);
  const today = new Date();
  let beginDate = validIsoDate(args.beginDate);
  let endDate = validIsoDate(args.endDate);
  const hasExplicitRange = !!(beginDate && endDate);
  if (!beginDate || !endDate) {
    const fallbackStart = preset === "yesterday" ? -1 : preset === "7d" ? -7 : preset === "30d" ? -30 : 0;
    const fallbackEnd = preset === "yesterday" || preset === "7d" || preset === "30d" ? -1 : 0;
    const startOffsetDays = dataPresetNumber(adapter, scope, preset, "startOffsetDays", fallbackStart);
    const endOffsetDays = dataPresetNumber(adapter, scope, preset, "endOffsetDays", fallbackEnd);
    beginDate = formatLocalIsoDate(addDateDays(today, startOffsetDays));
    endDate = formatLocalIsoDate(addDateDays(today, endOffsetDays));
    const sameDay = dataPresetPolicy(adapter, scope, preset).sameDay === true;
    if (sameDay) endDate = beginDate;
    const earlyMorningFallbackPreset = dataPresetText(adapter, scope, preset, "earlyMorningFallbackPreset", "");
    const earlyMorningBeforeHour = dataPresetNumber(adapter, scope, preset, "earlyMorningBeforeHour", -1);
    if (!validIsoDate(args.beginDate) && !validIsoDate(args.endDate) && earlyMorningFallbackPreset && earlyMorningBeforeHour >= 0 && today.getHours() < earlyMorningBeforeHour) {
      const fallbackPolicy = dataPresetPolicy(adapter, scope, earlyMorningFallbackPreset);
      const fallbackStartOffset = Number(fallbackPolicy.startOffsetDays);
      const fallbackEndOffset = Number(fallbackPolicy.endOffsetDays);
      if (Number.isFinite(fallbackStartOffset) && Number.isFinite(fallbackEndOffset)) {
        beginDate = formatLocalIsoDate(addDateDays(today, fallbackStartOffset));
        endDate = fallbackPolicy.sameDay === true ? beginDate : formatLocalIsoDate(addDateDays(today, fallbackEndOffset));
      }
    }
  }
  const earlyMorningStartHour = dataPresetNumber(adapter, scope, preset, "earlyMorningStartHour", 1);
  const earlyMorningBeforeHour = dataPresetNumber(adapter, scope, preset, "earlyMorningBeforeHour", -1);
  const earlyMorningShiftDays = dataPresetNumber(adapter, scope, preset, "earlyMorningShiftDays", 0);
  if (!hasExplicitRange &&
    earlyMorningShiftDays &&
    earlyMorningBeforeHour >= 0 &&
    today.getHours() >= earlyMorningStartHour &&
    today.getHours() < earlyMorningBeforeHour) {
    beginDate = formatLocalIsoDate(addDateDays(new Date(`${beginDate}T00:00:00`), earlyMorningShiftDays));
    endDate = formatLocalIsoDate(addDateDays(new Date(`${endDate}T00:00:00`), earlyMorningShiftDays));
  }

  const dateType = dataPresetText(adapter, scope, preset, "dateType", policyText(adapter, `${scope}.datePresetMap.${preset}`, preset));
  const legacyDateType = dataPresetText(adapter, scope, preset, "legacyDateType", "999");
  const legacyActiveKey = dataPresetText(adapter, scope, preset, "legacyActiveKey", "999");
  return {
    datePreset: preset,
    dateType,
    legacyActiveKey,
    legacyDateType,
    beginDate,
    endDate,
    beginDateSlash: slashDateStart(beginDate),
    endDateSlash: slashDateStart(endDate),
    startDate: beginDate,
    beginDateCompact: compactDate(beginDate),
    endDateCompact: compactDate(endDate),
    startDateCompact: compactDate(beginDate)
  };
}

function businessPresetText(adapter, preset, key, fallback = "") {
  const value = businessPresetPolicy(adapter, preset)[key];
  return value == null ? fallback : String(value);
}

function businessPresetNumber(adapter, preset, key, fallback) {
  const value = Number(businessPresetPolicy(adapter, preset)[key]);
  return Number.isFinite(value) ? value : fallback;
}

function resolveBusinessDatePreset(adapter = DOUDIAN_ADAPTER, value = "today") {
  const key = String(value || "today");
  const presets = policy(adapter, "businessData.datePresets", {});
  if (presets && typeof presets === "object") {
    if (presets[key]) return key;
    const matched = Object.entries(presets).find(([, config]) => config && typeof config === "object" && (
      String(config.dateType || "") === key ||
      String(config.legacyDateType || "") === key ||
      String(config.legacyActiveKey || "") === key
    ));
    if (matched) return matched[0];
  }
  return key;
}

function businessDateContext(args = {}, adapter = DOUDIAN_ADAPTER) {
  return dataDateContext(args, adapter, "businessData", "today");
}

function businessDataMappings(adapter = DOUDIAN_ADAPTER) {
  const mappings = responseMappings(adapter).businessData;
  return mappings && typeof mappings === "object" ? mappings : {};
}

function businessFieldConfig(adapter, field) {
  const mappings = businessDataMappings(adapter);
  const fields = mappings.fields && typeof mappings.fields === "object" ? mappings.fields : {};
  const next = fields[field];
  if (Array.isArray(next)) return { paths: next };
  if (next && typeof next === "object") return next;
  return {};
}

function businessFieldPaths(adapter, field) {
  const config = businessFieldConfig(adapter, field);
  return Array.isArray(config.paths) ? config.paths : [];
}

function businessFieldAliases(adapter, field) {
  const config = businessFieldConfig(adapter, field);
  return Array.isArray(config.aliases) ? config.aliases.map((item) => String(item)) : [];
}

function businessFieldScale(adapter, field) {
  const mappings = businessDataMappings(adapter);
  const scales = mappings.fieldScales && typeof mappings.fieldScales === "object" ? mappings.fieldScales : {};
  const config = businessFieldConfig(adapter, field);
  const value = Number(config.scale || scales[field] || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function coerceBusinessNumber(value) {
  if (value == null || value === "") return undefined;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") {
    for (const key of ["value", "val", "amount", "count", "cnt", "num", "score", "rate", "total", "text"]) {
      if (value[key] !== undefined) {
        const next = coerceBusinessNumber(value[key]);
        if (next !== undefined) return next;
      }
    }
    return undefined;
  }
  const text = String(value)
    .replace(/,/g, "")
    .replace(/[%￥¥元单人分]/g, "")
    .trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const next = Number(match[0]);
  return Number.isFinite(next) ? next : undefined;
}

function coerceDisplayMoneyYuan(value) {
  if (value == null || value === "") return undefined;
  let raw = value;
  let unit = "";
  if (typeof value === "object" && !Array.isArray(value)) {
    raw = value.amount ?? value.value ?? value.val ?? value.text ?? value.total;
    unit = String(value.unit || value.suffix || "");
  }
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return undefined;
    return /万/.test(unit) ? raw * 10000 : raw;
  }
  const text = String(raw).replace(/,/g, "").trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const next = Number(match[0]);
  if (!Number.isFinite(next)) return undefined;
  return /万/.test(`${text}${unit}`) ? next * 10000 : next;
}

function normalizeAliasKey(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

const BUSINESS_ALIAS_DESCRIPTOR_KEYS = [
  "key",
  "field",
  "fieldKey",
  "field_key",
  "name",
  "id",
  "title",
  "code",
  "metric",
  "metricKey",
  "metric_key",
  "dataIndex",
  "data_index",
  "column",
  "columnKey",
  "col",
  "type"
];

function aliasDescriptorMatch(value, aliasLookup) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const key of BUSINESS_ALIAS_DESCRIPTOR_KEYS) {
    const next = value[key];
    if (next === undefined) continue;
    const alias = aliasLookup.get(normalizeAliasKey(next));
    if (alias) return alias;
  }
  return "";
}

function findDeepByAliasWithMatch(value, aliasLookup, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const next = findDeepByAliasWithMatch(item, aliasLookup, depth + 1);
      if (next) return next;
    }
    return null;
  }

  const descriptorAlias = aliasDescriptorMatch(value, aliasLookup);
  if (descriptorAlias && coerceBusinessNumber(value) !== undefined) {
    return {
      value,
      alias: descriptorAlias
    };
  }

  for (const [key, nextValue] of Object.entries(value)) {
    const alias = aliasLookup.get(normalizeAliasKey(key));
    if (alias) {
      return {
        value: nextValue,
        alias
      };
    }
  }
  for (const nextValue of Object.values(value)) {
    const next = findDeepByAliasWithMatch(nextValue, aliasLookup, depth + 1);
    if (next) return next;
  }
  return null;
}

function businessResponsePayload(responses = {}) {
  const payload = { responses };
  for (const [key, response] of Object.entries(responses)) {
    payload[key] = response?.data;
  }
  return payload;
}

function readBusinessMetricResult(payload, adapter, field) {
  const scale = businessFieldScale(adapter, field);
  for (const path of businessFieldPaths(adapter, field)) {
    const next = getPath(payload, path);
    const number = coerceBusinessNumber(next);
    if (number !== undefined) {
      return {
        value: number / scale,
        source: "path",
        path
      };
    }
  }

  const aliases = businessFieldAliases(adapter, field);
  if (aliases.length) {
    const aliasLookup = new Map();
    for (const alias of aliases) {
      const normalizedAlias = normalizeAliasKey(alias);
      if (normalizedAlias && !aliasLookup.has(normalizedAlias)) aliasLookup.set(normalizedAlias, alias);
    }
    const match = findDeepByAliasWithMatch(payload, aliasLookup);
    const number = coerceBusinessNumber(match?.value);
    if (number !== undefined) {
      return {
        value: number / scale,
        source: "alias",
        alias: match.alias
      };
    }
  }
  return {
    value: 0,
    source: "none"
  };
}

function readBusinessMetric(payload, adapter, field) {
  return readBusinessMetricResult(payload, adapter, field).value;
}

function responseBusinessCode(response) {
  return response?.data?.code ??
    response?.data?.st ??
    response?.data?.status_code ??
    response?.data?.statusCode ??
    response?.data?.errno ??
    null;
}

function responseHasPathValue(response, paths = []) {
  if (!Array.isArray(paths) || !paths.length) return false;
  return paths.some((path) => getPath(response?.data, path) !== undefined);
}

function businessPlan(adapter, planKey) {
  return planKey ? requestPlan(adapter, planKey) : {};
}

function isBusinessResponseOk(response, adapter = DOUDIAN_ADAPTER, planKey = "") {
  return requestPlanResponseOk(response, adapter, planKey, businessDataMappings(adapter));
}

function summarizeBusinessResponses(responses = {}, adapter = DOUDIAN_ADAPTER) {
  const output = {};
  for (const [key, response] of Object.entries(responses)) {
    output[key] = {
      status: response?.status || 0,
      success: isBusinessResponseOk(response, adapter, key),
      code: responseBusinessCode(response),
      message: clipText(response?.data?.msg || response?.data?.message || response?.data?.status_msg || response?.error?.message || "", 160)
    };
  }
  return output;
}

function summarizeBusinessSourceFailures(summary = {}, adapter = DOUDIAN_ADAPTER) {
  const optionalPlans = new Set(policyArray(adapter, "businessData.optionalPlans", []).map((item) => String(item)));
  return Object.entries(summary)
    .filter(([, response]) => response?.success !== true)
    .map(([key, response]) => ({
      key,
      optional: optionalPlans.has(key),
      status: response?.status || 0,
      code: response?.code ?? null,
      message: response?.message || ""
    }));
}

function firstBusinessErrorMessage(responses = {}, adapter = DOUDIAN_ADAPTER) {
  for (const [key, response] of Object.entries(responses)) {
    if (isBusinessResponseOk(response, adapter, key)) continue;
    const message = response?.data?.msg || response?.data?.message || response?.data?.status_msg || response?.error?.message || "";
    if (message) return clipText(message, 160);
    if (response?.status) return `HTTP ${response.status}`;
  }
  return "";
}

function businessRowSummary(row = {}) {
  const nonZeroFields = BUSINESS_DATA_FIELDS.filter((field) => {
    const value = Number(row[field] || 0);
    return Number.isFinite(value) && value !== 0;
  });
  return {
    nonZeroFieldCount: nonZeroFields.length,
    nonZeroFields,
    allZero: nonZeroFields.length === 0
  };
}

function summarizeBusinessMetricSources(metricSources = {}, row = {}) {
  const summary = {};
  for (const field of BUSINESS_METRIC_DIAGNOSTIC_FIELDS) {
    const metric = metricSources[field] || {};
    const value = Number(row[field] ?? metric.value ?? 0);
    summary[field] = {
      value: Number.isFinite(value) ? value : 0,
      source: metric.source || "none"
    };
    if (metric.path) summary[field].path = metric.path;
    if (metric.alias) summary[field].alias = metric.alias;
    if (metric.formula) summary[field].formula = metric.formula;
  }
  return summary;
}

function emptyBusinessDataRow(store) {
  const row = {
    shopId: String(store.shopId || ""),
    shopName: String(store.shopName || ""),
    group: String(store.groupName || ""),
    status: store.status || "unknown"
  };
  for (const field of BUSINESS_DATA_FIELDS) row[field] = 0;
  return row;
}

function buildBusinessDataResult(store, responses, args = {}, adapter = DOUDIAN_ADAPTER) {
  const payload = businessResponsePayload(responses);
  const row = emptyBusinessDataRow(store);
  const metricSources = {};
  for (const field of BUSINESS_DATA_FIELDS) {
    const metric = readBusinessMetricResult(payload, adapter, field);
    row[field] = metric.value;
    metricSources[field] = metric;
  }
  if (!row.customerPrice && row.orderCount > 0) {
    row.customerPrice = row.dealAmount / row.orderCount;
    metricSources.customerPrice = {
      value: row.customerPrice,
      source: "derived",
      formula: "dealAmount/orderCount"
    };
  }
  if (!row.refundRate && row.orderCount > 0 && row.refundOrderCount > 0) {
    row.refundRate = (row.refundOrderCount / row.orderCount) * 100;
    metricSources.refundRate = {
      value: row.refundRate,
      source: "derived",
      formula: "refundOrderCount/orderCount*100"
    };
  }
  row.datePreset = args.datePreset || "";
  row.beginDate = args.beginDate || "";
  row.endDate = args.endDate || "";
  return {
    row,
    metricSources: summarizeBusinessMetricSources(metricSources, row)
  };
}

function buildBusinessDataRow(store, responses, args = {}, adapter = DOUDIAN_ADAPTER) {
  return buildBusinessDataResult(store, responses, args, adapter).row;
}

function fundsDataMappings(adapter = DOUDIAN_ADAPTER) {
  const mappings = responseMappings(adapter).fundsData;
  return mappings && typeof mappings === "object" ? mappings : {};
}

function fundsFieldConfig(adapter, field) {
  const mappings = fundsDataMappings(adapter);
  const fields = mappings.fields && typeof mappings.fields === "object" ? mappings.fields : {};
  const next = fields[field];
  if (Array.isArray(next)) return { paths: next };
  if (next && typeof next === "object") return next;
  return {};
}

function fundsFieldPaths(adapter, field) {
  const config = fundsFieldConfig(adapter, field);
  return Array.isArray(config.paths) ? config.paths : [];
}

function fundsFieldAliases(adapter, field) {
  const config = fundsFieldConfig(adapter, field);
  return Array.isArray(config.aliases) ? config.aliases.map((item) => String(item)) : [];
}

function fundsFieldScale(adapter, field) {
  const mappings = fundsDataMappings(adapter);
  const scales = mappings.fieldScales && typeof mappings.fieldScales === "object" ? mappings.fieldScales : {};
  const config = fundsFieldConfig(adapter, field);
  const value = Number(config.scale || scales[field] || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function coerceFundsMetricValue(value, config = {}, scale = 1) {
  if (config.moneyText === true) {
    const money = coerceDisplayMoneyYuan(value);
    if (money !== undefined) return money;
  }
  const number = coerceBusinessNumber(value);
  return number !== undefined ? number / scale : undefined;
}

function readFundsMetricResult(payload, adapter, field) {
  const config = fundsFieldConfig(adapter, field);
  const scale = fundsFieldScale(adapter, field);
  for (const path of fundsFieldPaths(adapter, field)) {
    const next = getPath(payload, path);
    const number = coerceFundsMetricValue(next, config, scale);
    if (number !== undefined) {
      return {
        value: number,
        source: "path",
        path
      };
    }
  }

  const aliases = fundsFieldAliases(adapter, field);
  if (aliases.length) {
    const aliasLookup = new Map();
    for (const alias of aliases) {
      const normalizedAlias = normalizeAliasKey(alias);
      if (normalizedAlias && !aliasLookup.has(normalizedAlias)) aliasLookup.set(normalizedAlias, alias);
    }
    const match = findDeepByAliasWithMatch(payload, aliasLookup);
    const number = coerceFundsMetricValue(match?.value, config, scale);
    if (number !== undefined) {
      return {
        value: number,
        source: "alias",
        alias: match.alias
      };
    }
  }
  return {
    value: 0,
    source: "none"
  };
}

function fundsFieldSchemaVersion(adapter = DOUDIAN_ADAPTER) {
  const schema = policy(adapter, "fundsData.fieldSchema", {});
  return schema && typeof schema === "object" ? String(schema.version || "") : "";
}

function stableHashValue(value) {
  const normalize = (next) => {
    if (Array.isArray(next)) return next.map(normalize);
    if (!next || typeof next !== "object") return next;
    return Object.keys(next).sort().reduce((output, key) => {
      output[key] = normalize(next[key]);
      return output;
    }, {});
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex").slice(0, 16);
}

function fundsRequestPlanHash(adapter = DOUDIAN_ADAPTER, planKeys = []) {
  const keys = Array.from(new Set((planKeys || []).map((item) => String(item)).filter(Boolean)));
  const plans = keys.map((key) => {
    const plan = requestPlan(adapter, key);
    return {
      key,
      endpoint: requestPlanEndpoint(adapter, plan),
      plan
    };
  });
  return stableHashValue({
    adapterVersion: adapter?.version || "",
    plans
  });
}

function fundsContractMetadata(adapter = DOUDIAN_ADAPTER, planKeys = []) {
  return {
    fieldSchemaVersion: fundsFieldSchemaVersion(adapter),
    requestPlanHash: fundsRequestPlanHash(adapter, planKeys)
  };
}

function violationsFieldSchemaVersion(adapter = DOUDIAN_ADAPTER) {
  const schema = policy(adapter, "violationsData.fieldSchema", {});
  return schema && typeof schema === "object" ? String(schema.version || "") : "";
}

function violationsProductLinkageVersion(adapter = DOUDIAN_ADAPTER) {
  const linkage = policy(adapter, "violationsData.productAssociation", {});
  if (linkage && typeof linkage === "object") return String(linkage.version || "");
  return String(policy(adapter, "violationsData.productAssociationVersion", ""));
}

function violationsRequestPlanHash(adapter = DOUDIAN_ADAPTER, planKeys = []) {
  const keys = Array.from(new Set((planKeys || []).map((item) => String(item)).filter(Boolean)));
  const plans = keys.map((key) => {
    const plan = requestPlan(adapter, key);
    return {
      key,
      endpoint: requestPlanEndpoint(adapter, plan),
      plan
    };
  });
  return stableHashValue({
    adapterVersion: adapter?.version || "",
    fieldSchemaVersion: violationsFieldSchemaVersion(adapter),
    productLinkageVersion: violationsProductLinkageVersion(adapter),
    plans
  });
}

function violationsContractMetadata(adapter = DOUDIAN_ADAPTER, planKeys = []) {
  return {
    fieldSchemaVersion: violationsFieldSchemaVersion(adapter),
    requestPlanHash: violationsRequestPlanHash(adapter, planKeys),
    productLinkageVersion: violationsProductLinkageVersion(adapter)
  };
}

function fundsPlanDiagnosticOnly(adapter = DOUDIAN_ADAPTER, planKey = "") {
  const plan = businessPlan(adapter, planKey);
  const diagnosticPlans = new Set(policyArray(adapter, "fundsData.diagnosticPlans", []).map((item) => String(item)));
  return plan.diagnosticOnly === true || diagnosticPlans.has(String(planKey));
}

function fundsPlanCountsAsSuccess(adapter = DOUDIAN_ADAPTER, planKey = "") {
  const plan = businessPlan(adapter, planKey);
  if (plan.countsAsSuccess === false) return false;
  return !fundsPlanDiagnosticOnly(adapter, planKey);
}

function fundsDerivedFieldConfigs(adapter = DOUDIAN_ADAPTER) {
  const configs = policyArray(adapter, "fundsData.derivedFields", []);
  if (configs.length) {
    return configs
      .filter((config) => config && typeof config === "object" && FUNDS_DATA_FIELDS.includes(String(config.key || "")))
      .map((config) => ({
        key: String(config.key),
        formula: String(config.formula || "sum"),
        sources: Array.isArray(config.sources) ? config.sources.map((item) => String(item)).filter(Boolean) : [],
        onlyWhenZero: config.onlyWhenZero !== false
      }));
  }
  return [
    { key: "marginBalance", formula: "sum", sources: ["baseMarginBalance", "experienceMarginBalance"], onlyWhenZero: true },
    { key: "depositPayable", formula: "sum", sources: ["baseDepositPayable", "experienceDepositPayable"], onlyWhenZero: true },
    { key: "refundableMargin", formula: "sum", sources: ["baseRefundableMargin", "experienceRefundableMargin"], onlyWhenZero: true },
    { key: "subsidyTotal", formula: "sum", sources: ["commissionSubsidy", "qianchuanSubsidy"], onlyWhenZero: true },
    { key: "riskCount", formula: "countPositive", sources: ["frozenBalance", "depositPayable", "compensationAmountToday"], onlyWhenZero: true }
  ];
}

function fundsRowNumber(row = {}, key = "") {
  const value = Number(row[key] || 0);
  return Number.isFinite(value) ? value : 0;
}

function applyFundsDerivedFields(row, metricSources, adapter = DOUDIAN_ADAPTER) {
  for (const config of fundsDerivedFieldConfigs(adapter)) {
    if (!config.sources.length) continue;
    if (config.onlyWhenZero && fundsRowNumber(row, config.key) !== 0) continue;
    let value = 0;
    if (config.formula === "countPositive") {
      value = config.sources.filter((source) => fundsRowNumber(row, source) > 0).length;
    } else if (config.formula === "subtract") {
      value = config.sources.reduce((nextValue, source, index) => {
        const current = fundsRowNumber(row, source);
        return index === 0 ? current : nextValue - current;
      }, 0);
    } else {
      value = config.sources.reduce((sum, source) => sum + fundsRowNumber(row, source), 0);
    }
    row[config.key] = value;
    metricSources[config.key] = {
      value,
      source: "derived",
      formula: config.formula,
      sources: config.sources
    };
  }
}

function isFundsResponseOk(response, adapter = DOUDIAN_ADAPTER, planKey = "") {
  return requestPlanResponseOk(response, adapter, planKey, fundsDataMappings(adapter));
}

function summarizeFundsResponses(responses = {}, adapter = DOUDIAN_ADAPTER) {
  const output = {};
  for (const [key, response] of Object.entries(responses)) {
    const diagnosticOnly = fundsPlanDiagnosticOnly(adapter, key);
    const countsAsSuccess = fundsPlanCountsAsSuccess(adapter, key);
    output[key] = {
      status: response?.status || 0,
      success: isFundsResponseOk(response, adapter, key),
      countsAsSuccess,
      diagnosticOnly,
      code: responseBusinessCode(response),
      message: clipText(response?.data?.msg || response?.data?.message || response?.data?.status_msg || response?.error?.message || "", 160)
    };
  }
  return output;
}

function summarizeFundsSourceFailures(summary = {}, adapter = DOUDIAN_ADAPTER) {
  const optionalPlans = new Set(policyArray(adapter, "fundsData.optionalPlans", []).map((item) => String(item)));
  const criticalPlans = new Set(policyArray(adapter, "fundsData.criticalPlans", []).map((item) => String(item)));
  return Object.entries(summary)
    .filter(([, response]) => response?.success !== true)
    .map(([key, response]) => ({
      key,
      optional: optionalPlans.has(key),
      critical: criticalPlans.has(key),
      diagnosticOnly: response?.diagnosticOnly === true,
      countsAsSuccess: response?.countsAsSuccess !== false,
      status: response?.status || 0,
      code: response?.code ?? null,
      message: response?.message || ""
    }));
}

function firstFundsErrorMessage(responses = {}, adapter = DOUDIAN_ADAPTER) {
  const entries = Object.entries(responses);
  const criticalPlans = new Set(policyArray(adapter, "fundsData.criticalPlans", []).map((item) => String(item)));
  const ordered = [
    ...entries.filter(([key]) => criticalPlans.has(key)),
    ...entries.filter(([key]) => !criticalPlans.has(key) && fundsPlanCountsAsSuccess(adapter, key))
  ];
  for (const [key, response] of ordered) {
    if (isFundsResponseOk(response, adapter, key)) continue;
    const message = response?.data?.msg || response?.data?.message || response?.data?.status_msg || response?.error?.message || "";
    if (message) return clipText(message, 160);
    if (response?.status) return `HTTP ${response.status}`;
  }
  return "";
}

function fundsRowSummary(row = {}) {
  const nonZeroFields = FUNDS_DATA_FIELDS.filter((field) => {
    const value = Number(row[field] || 0);
    return Number.isFinite(value) && value !== 0;
  });
  return {
    nonZeroFieldCount: nonZeroFields.length,
    nonZeroFields,
    allZero: nonZeroFields.length === 0
  };
}

function summarizeFundsMetricSources(metricSources = {}, row = {}) {
  const summary = {};
  for (const field of FUNDS_METRIC_DIAGNOSTIC_FIELDS) {
    const metric = metricSources[field] || {};
    const value = Number(row[field] ?? metric.value ?? 0);
    summary[field] = {
      value: Number.isFinite(value) ? value : 0,
      source: metric.source || "none"
    };
    if (metric.path) summary[field].path = metric.path;
    if (metric.alias) summary[field].alias = metric.alias;
    if (metric.formula) summary[field].formula = metric.formula;
    if (Array.isArray(metric.sources)) summary[field].sources = metric.sources;
  }
  return summary;
}

function emptyFundsDataRow(store) {
  const row = {
    shopId: String(store.shopId || ""),
    shopName: String(store.shopName || ""),
    group: String(store.groupName || ""),
    status: store.status || "unknown"
  };
  for (const field of FUNDS_DATA_FIELDS) row[field] = 0;
  return row;
}

function buildFundsDataResult(store, responses, args = {}, adapter = DOUDIAN_ADAPTER) {
  const payload = businessResponsePayload(responses);
  const row = emptyFundsDataRow(store);
  const metricSources = {};
  for (const field of FUNDS_DATA_FIELDS) {
    const metric = readFundsMetricResult(payload, adapter, field);
    row[field] = metric.value;
    metricSources[field] = metric;
  }
  applyFundsDerivedFields(row, metricSources, adapter);
  return {
    row,
    metricSources: summarizeFundsMetricSources(metricSources, row)
  };
}

function fundsDateContext(args = {}, adapter = DOUDIAN_ADAPTER) {
  return dataDateContext(args, adapter, "fundsData", "snapshot");
}

function violationsDateContext(args = {}, adapter = DOUDIAN_ADAPTER) {
  return dataDateContext(args, adapter, "violationsData", "all");
}

function violationsDataMappings(adapter = DOUDIAN_ADAPTER) {
  const mappings = responseMappings(adapter).violationsData;
  return mappings && typeof mappings === "object" ? mappings : {};
}

function violationsFieldConfig(adapter, field) {
  const mappings = violationsDataMappings(adapter);
  const fields = mappings.fields && typeof mappings.fields === "object" ? mappings.fields : {};
  const next = fields[field];
  if (Array.isArray(next)) return { paths: next };
  if (next && typeof next === "object") return next;
  return {};
}

function violationsFieldPaths(adapter, field) {
  const config = violationsFieldConfig(adapter, field);
  return Array.isArray(config.paths) ? config.paths : [];
}

function violationsFieldScale(adapter, field) {
  const mappings = violationsDataMappings(adapter);
  const scales = mappings.fieldScales && typeof mappings.fieldScales === "object" ? mappings.fieldScales : {};
  const config = violationsFieldConfig(adapter, field);
  const value = Number(config.scale || scales[field] || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function coerceViolationText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = coerceViolationText(item);
      if (text) return text;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of ["text", "label", "name", "title", "value", "val", "desc", "description"]) {
      const text = coerceViolationText(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function readViolationField(record, adapter, field) {
  return firstValue(record, violationsFieldPaths(adapter, field));
}

function coerceViolationAmount(value, scale = 1) {
  if (value == null || value === "") return 0;
  const unitText = typeof value === "object" && !Array.isArray(value)
    ? String(value.unit || value.suffix || "")
    : "";
  const rawText = typeof value === "string" ? value : "";
  if (/[￥¥元]/.test(`${rawText}${unitText}`)) {
    const yuan = coerceDisplayMoneyYuan(value);
    return yuan !== undefined ? yuan : 0;
  }
  const number = coerceBusinessNumber(value);
  return number !== undefined ? number / scale : 0;
}

function formatLocalDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function coerceViolationDateTime(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : value;
    return formatLocalDateTime(new Date(ms));
  }
  const text = coerceViolationText(value);
  if (!text) return "";
  if (/^\d+$/.test(text)) return coerceViolationDateTime(Number(text));
  const normalized = text.replace(/\//g, "-");
  const parsed = new Date(normalized.includes("T") ? normalized : normalized.replace(" ", "T"));
  if (!Number.isNaN(parsed.getTime())) return formatLocalDateTime(parsed);
  return text.slice(0, 32);
}

function violationDueMs(value) {
  const text = coerceViolationText(value);
  if (!text) return Number.NaN;
  const parsed = new Date(text.includes("T") ? text : text.replace(" ", "T"));
  return parsed.getTime();
}

function violationDueSoon(value) {
  const ms = violationDueMs(value);
  if (!Number.isFinite(ms)) return false;
  const hours = (ms - Date.now()) / 36e5;
  return hours >= 0 && hours <= 24;
}

function violationOverdue(value) {
  const ms = violationDueMs(value);
  return Number.isFinite(ms) && ms < Date.now();
}

function normalizeViolationSeverity(value) {
  const number = coerceBusinessNumber(value);
  const text = coerceViolationText(value).toLowerCase();
  if (/(高|严重|重大|high|severe|critical)/i.test(text) || (number !== undefined && number >= 3)) return "high";
  if (/(中|一般|medium|mid)/i.test(text) || number === 2) return "medium";
  return "low";
}

function normalizeViolationProcessStatus(value) {
  const text = coerceViolationText(value).toLowerCase();
  if (/(失败|异常|error|fail)/i.test(text)) return "failed";
  if (/(申诉|appeal)/i.test(text)) return "appealing";
  if (/(整改|修复|rectif|repair)/i.test(text)) return "rectifying";
  if (/(完成|已处理|已处置|关闭|通过|done|success|finish|closed)/i.test(text)) return "done";
  return "pending";
}

function normalizeViolationProductStatus(value, productId = "") {
  if (!productId) return "无需关联";
  const text = coerceViolationText(value).toLowerCase();
  if (!text) return "未查询";
  if (/(无需|不涉及|no need)/i.test(text)) return "无需关联";
  if (/(未关联|缺失|找不到|不存在|missing|not found)/i.test(text)) return "未关联";
  if (/(回收|recycle)/i.test(text)) return "回收站";
  if (/(下架|不可售|offline|off[-_ ]?sale|sold out)/i.test(text)) return "已下架";
  if (/(在售|售卖|online|on[-_ ]?sale|selling)/i.test(text)) return "在售";
  return "未查询";
}

function violationAssociationStatus(productStatus, productId = "") {
  if (!productId || productStatus === "无需关联") return "not_required";
  if (productStatus === "未查询") return "not_checked";
  if (productStatus === "未关联") return "not_found";
  if (productStatus === "回收站") return "recycled";
  if (productStatus === "已下架") return "offline";
  if (productStatus === "在售") return "online";
  return "unknown";
}

function violationsProductAssociationPolicy(adapter = DOUDIAN_ADAPTER) {
  const config = policy(adapter, "violationsData.productAssociation", {});
  return config && typeof config === "object" ? config : {};
}

function violationsProductAssociationEnabled(adapter = DOUDIAN_ADAPTER) {
  return violationsProductAssociationPolicy(adapter).enabled === true;
}

function violationsProductAssociationPlans(adapter = DOUDIAN_ADAPTER) {
  const config = violationsProductAssociationPolicy(adapter);
  return Array.isArray(config.requestPlans)
    ? config.requestPlans.map((item) => String(item)).filter(Boolean)
    : [];
}

function violationsProductAssociationConcurrency(adapter = DOUDIAN_ADAPTER) {
  return Math.max(1, Math.min(4, Math.floor(Number(violationsProductAssociationPolicy(adapter).concurrency || 2))));
}

function violationProductAssociationFieldPaths(adapter = DOUDIAN_ADAPTER, field) {
  const config = violationsProductAssociationPolicy(adapter);
  const fields = config.fields && typeof config.fields === "object" ? config.fields : {};
  const next = fields[field];
  if (Array.isArray(next)) return next;
  if (next && typeof next === "object" && Array.isArray(next.paths)) return next.paths;
  return [];
}

function violationProductAssociationListPaths(adapter = DOUDIAN_ADAPTER) {
  const config = violationsProductAssociationPolicy(adapter);
  return Array.isArray(config.listPaths) ? config.listPaths : [];
}

function readViolationProductAssociationField(value, adapter = DOUDIAN_ADAPTER, field) {
  return firstValue(value, violationProductAssociationFieldPaths(adapter, field));
}

function extractViolationProductAssociation(response, adapter = DOUDIAN_ADAPTER, productId = "", planKey = "") {
  if (!isViolationsResponseOk(response, adapter, planKey)) return null;
  const payload = response?.data;
  const directId = coerceViolationText(readViolationProductAssociationField(payload, adapter, "productId"));
  const directStatus = normalizeViolationProductStatus(readViolationProductAssociationField(payload, adapter, "productStatus"), directId || productId);
  if (directId || directStatus !== "未查询") {
    return {
      productId: directId || String(productId || ""),
      productStatus: directStatus,
      associationStatus: violationAssociationStatus(directStatus, directId || productId),
      raw: payload
    };
  }
  const items = firstArray(payload, violationProductAssociationListPaths(adapter));
  const matched = items.find((item) => {
    const nextId = coerceViolationText(readViolationProductAssociationField(item, adapter, "productId"));
    return nextId && String(nextId) === String(productId || "");
  }) || items[0];
  if (!matched) return {
    productId: String(productId || ""),
    productStatus: "未关联",
    associationStatus: "not_found",
    raw: payload
  };
  const matchedId = coerceViolationText(readViolationProductAssociationField(matched, adapter, "productId")) || String(productId || "");
  const productStatus = normalizeViolationProductStatus(readViolationProductAssociationField(matched, adapter, "productStatus"), matchedId);
  return {
    productId: matchedId,
    productStatus,
    associationStatus: violationAssociationStatus(productStatus, matchedId),
    raw: matched
  };
}

function normalizeViolationObjectType(value, productId = "") {
  const text = coerceViolationText(value).toLowerCase();
  if (productId || /(商品|goods|product|item|sku)/i.test(text)) return "商品";
  if (/(订单|order)/i.test(text)) return "订单";
  if (/(内容|素材|content|material)/i.test(text)) return "内容";
  return "店铺";
}

function isViolationsResponseOk(response, adapter = DOUDIAN_ADAPTER, planKey = "") {
  return requestPlanResponseOk(response, adapter, planKey, violationsDataMappings(adapter));
}

function summarizeViolationsResponses(responses = {}, adapter = DOUDIAN_ADAPTER) {
  const output = {};
  for (const [key, response] of Object.entries(responses)) {
    output[key] = {
      status: response?.status || 0,
      success: isViolationsResponseOk(response, adapter, key),
      code: responseBusinessCode(response),
      message: clipText(response?.data?.msg || response?.data?.message || response?.data?.status_msg || response?.error?.message || "", 160)
    };
  }
  return output;
}

function summarizeViolationsSourceFailures(summary = {}, adapter = DOUDIAN_ADAPTER) {
  const optionalPlans = new Set(policyArray(adapter, "violationsData.optionalPlans", []).map((item) => String(item)));
  return Object.entries(summary)
    .filter(([, response]) => response?.success !== true)
    .map(([key, response]) => ({
      key,
      optional: optionalPlans.has(key),
      status: response?.status || 0,
      code: response?.code ?? null,
      message: response?.message || ""
    }));
}

function firstViolationsErrorMessage(responses = {}, adapter = DOUDIAN_ADAPTER) {
  for (const [key, response] of Object.entries(responses)) {
    if (isViolationsResponseOk(response, adapter, key)) continue;
    const message = response?.data?.msg || response?.data?.message || response?.data?.status_msg || response?.error?.message || "";
    if (message) return clipText(message, 160);
    if (response?.status) return `HTTP ${response.status}`;
  }
  return "";
}

function emptyViolationsDataRow(store) {
  const row = {
    shopId: String(store.shopId || ""),
    shopName: String(store.shopName || ""),
    group: String(store.groupName || ""),
    status: store.status || "unknown"
  };
  for (const field of VIOLATION_DATA_FIELDS) row[field] = 0;
  return row;
}

function violationsPayload(responses = {}) {
  return businessResponsePayload(responses);
}

function violationListPaths(adapter = DOUDIAN_ADAPTER) {
  const mappings = violationsDataMappings(adapter);
  return Array.isArray(mappings.listPaths) ? mappings.listPaths : [];
}

function violationTotalPaths(adapter = DOUDIAN_ADAPTER) {
  const mappings = violationsDataMappings(adapter);
  return Array.isArray(mappings.totalPaths) ? mappings.totalPaths : [];
}

function readViolationTotal(payload, adapter = DOUDIAN_ADAPTER) {
  const value = firstValue(payload, violationTotalPaths(adapter));
  const total = coerceBusinessNumber(value);
  return total !== undefined ? total : 0;
}

function extractViolationRecords(store, responses, requestContext = {}, adapter = DOUDIAN_ADAPTER) {
  const payload = violationsPayload(responses);
  const items = firstArray(payload, violationListPaths(adapter));
  return items.map((item, index) => {
    const productId = coerceViolationText(readViolationField(item, adapter, "productId"));
    const reason = coerceViolationText(readViolationField(item, adapter, "reason"));
    const dueAt = coerceViolationDateTime(readViolationField(item, adapter, "dueAt"));
    const penaltyAmount = coerceViolationAmount(
      readViolationField(item, adapter, "penaltyAmount"),
      violationsFieldScale(adapter, "penaltyAmount")
    );
    const id = coerceViolationText(readViolationField(item, adapter, "id")) || `${store.shopId || "shop"}-violation-${index + 1}`;
    const productStatus = normalizeViolationProductStatus(readViolationField(item, adapter, "productStatus"), productId);
    return {
      id,
      shopId: String(store.shopId || requestContext.shopId || ""),
      shopName: String(store.shopName || requestContext.shopName || ""),
      group: String(store.groupName || ""),
      objectType: normalizeViolationObjectType(readViolationField(item, adapter, "objectType"), productId),
      objectName: coerceViolationText(readViolationField(item, adapter, "objectName")) || reason || id,
      productId,
      reason: reason || "违规原因待确认",
      severity: normalizeViolationSeverity(readViolationField(item, adapter, "severity")),
      processStatus: normalizeViolationProcessStatus(readViolationField(item, adapter, "processStatus")),
      productStatus,
      associationStatus: violationAssociationStatus(productStatus, productId),
      action: coerceViolationText(readViolationField(item, adapter, "action")) || "待人工确认",
      dueAt,
      penaltyAmount,
      failureReason: coerceViolationText(readViolationField(item, adapter, "failureReason")),
      sourcePlan: String(requestContext.sourcePlan || "violationPenaltyList"),
      source: coerceViolationText(readViolationField(item, adapter, "source")) || "违规处罚列表"
    };
  });
}

function buildViolationsDataRowFromRecords(store, records = [], args = {}, remoteTotal = 0) {
  const row = emptyViolationsDataRow(store);
  row.totalRecords = records.length || remoteTotal;
  row.pendingCount = records.filter((record) => record.processStatus === "pending").length;
  row.appealCount = records.filter((record) => record.processStatus === "appealing").length;
  row.rectificationCount = records.filter((record) => record.processStatus === "rectifying").length;
  row.highRiskCount = records.filter((record) => record.severity === "high").length;
  row.dueSoonCount = records.filter((record) => violationDueSoon(record.dueAt)).length;
  row.overdueCount = records.filter((record) => violationOverdue(record.dueAt)).length;
  row.productLinkedCount = records.filter((record) => ["online", "offline", "recycled"].includes(String(record.associationStatus || ""))).length;
  row.productMissingCount = records.filter((record) => record.associationStatus === "not_found").length;
  row.offlineProductCount = records.filter((record) => record.productStatus === "已下架" || record.productStatus === "回收站").length;
  row.failedCount = records.filter((record) => record.processStatus === "failed" || record.failureReason).length;
  row.penaltyAmount = records.reduce((sum, record) => sum + Number(record.penaltyAmount || 0), 0);
  row.datePreset = args.datePreset || "";
  row.beginDate = args.beginDate || "";
  row.endDate = args.endDate || "";
  return { row, records };
}

function buildViolationsDataResult(store, responses, args = {}, adapter = DOUDIAN_ADAPTER) {
  const payload = violationsPayload(responses);
  const records = extractViolationRecords(store, responses, args, adapter);
  return buildViolationsDataRowFromRecords(store, records, args, readViolationTotal(payload, adapter));
}

function violationsRowSummary(row = {}, records = []) {
  const nonZeroFields = VIOLATION_DATA_FIELDS.filter((field) => {
    const value = Number(row[field] || 0);
    return Number.isFinite(value) && value !== 0;
  });
  return {
    recordCount: records.length,
    remoteTotal: Number(row.totalRecords || 0),
    nonZeroFieldCount: nonZeroFields.length,
    nonZeroFields,
    noRecord: Number(row.totalRecords || 0) === 0 && records.length === 0,
    remoteTotalWithoutRecords: Number(row.totalRecords || 0) > 0 && records.length === 0
  };
}

function staleGoodsCleanupMappings(adapter = DOUDIAN_ADAPTER) {
  const mappings = responseMappings(adapter).staleGoodsCleanup;
  return mappings && typeof mappings === "object" ? mappings : {};
}

function staleGoodsFieldConfig(adapter, field) {
  const mappings = staleGoodsCleanupMappings(adapter);
  const fields = mappings.fields && typeof mappings.fields === "object" ? mappings.fields : {};
  const next = fields[field];
  if (Array.isArray(next)) return { paths: next };
  if (next && typeof next === "object") return next;
  return {};
}

function staleGoodsFieldPaths(adapter, field) {
  const config = staleGoodsFieldConfig(adapter, field);
  return Array.isArray(config.paths) ? config.paths : [];
}

function staleGoodsFieldScale(adapter, field) {
  const mappings = staleGoodsCleanupMappings(adapter);
  const scales = mappings.fieldScales && typeof mappings.fieldScales === "object" ? mappings.fieldScales : {};
  const config = staleGoodsFieldConfig(adapter, field);
  const value = Number(config.scale || scales[field] || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function staleGoodsListPaths(adapter = DOUDIAN_ADAPTER) {
  const mappings = staleGoodsCleanupMappings(adapter);
  return Array.isArray(mappings.listPaths) ? mappings.listPaths : [];
}

function staleGoodsTotalPaths(adapter = DOUDIAN_ADAPTER) {
  const mappings = staleGoodsCleanupMappings(adapter);
  return Array.isArray(mappings.totalPaths) ? mappings.totalPaths : [];
}

function staleGoodsPayload(responses = {}) {
  return businessResponsePayload(responses);
}

function staleGoodsObjectKeysSample(value, limit = 16) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, limit);
}

function summarizeStaleGoodsResponseShape(value, depth = 0) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const sample = value.find((item) => item && typeof item === "object");
    return {
      type: "array",
      length: value.length,
      itemKeys: staleGoodsObjectKeysSample(sample)
    };
  }
  if (typeof value !== "object") return { type: typeof value };
  const keys = staleGoodsObjectKeysSample(value, 12);
  const children = {};
  if (depth < 2) {
    for (const key of keys.slice(0, 8)) {
      const next = value[key];
      if (next && typeof next === "object") children[key] = summarizeStaleGoodsResponseShape(next, depth + 1);
    }
  }
  return { type: "object", keys, children };
}

function summarizeStaleGoodsPayloadShape(payload = {}) {
  const output = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (key === "responses") continue;
    output[key] = summarizeStaleGoodsResponseShape(value);
  }
  return output;
}

function staleGoodsProductLikeScore(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return 0;
  let score = 0;
  const checks = [
    ["product_id", "productId", "goods_id", "goodsId", "item_id", "itemId", "id"],
    ["title", "name", "product_name", "productName", "goods_name", "goodsName"],
    ["price", "min_price", "minPrice", "sell_price", "sellPrice"],
    ["stock", "stock_num", "stockNum", "inventory"],
    ["create_time", "createTime", "created_at", "createdAt", "ctime"],
    ["status", "status_name", "statusName", "product_status", "productStatus"]
  ];
  for (const keys of checks) {
    if (keys.some((key) => item[key] !== undefined && item[key] !== null && item[key] !== "")) score += 1;
  }
  return score;
}

function staleGoodsArrayProductScore(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  const samples = items.filter((item) => item && typeof item === "object").slice(0, 5);
  if (!samples.length) return 0;
  return Math.max(...samples.map((item) => staleGoodsProductLikeScore(item)));
}

function findDeepStaleGoodsProductArray(value, path = "", depth = 0, seen = new Set()) {
  if (value == null || depth > 7) return null;
  if (Array.isArray(value)) {
    const score = staleGoodsArrayProductScore(value);
    return score > 0
      ? { items: value, source: "deep", path, score, firstItemKeys: staleGoodsObjectKeysSample(value.find((item) => item && typeof item === "object")) }
      : null;
  }
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const entries = Object.entries(value);
  const preferred = entries.filter(([key]) => /list|product|goods|item|rows|data/i.test(key));
  const rest = entries.filter(([key]) => !/list|product|goods|item|rows|data/i.test(key));
  for (const [key, nextValue] of [...preferred, ...rest]) {
    const childPath = path ? `${path}.${key}` : key;
    const found = findDeepStaleGoodsProductArray(nextValue, childPath, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function extractStaleGoodsProductItems(payload, adapter = DOUDIAN_ADAPTER) {
  for (const path of staleGoodsListPaths(adapter)) {
    const next = path ? getPath(payload, path) : payload;
    if (!Array.isArray(next)) continue;
    return {
      items: next,
      source: "path",
      path,
      firstItemKeys: staleGoodsObjectKeysSample(next.find((item) => item && typeof item === "object"))
    };
  }
  const found = findDeepStaleGoodsProductArray(payload);
  if (found) return found;
  return {
    items: [],
    source: "none",
    path: "",
    firstItemKeys: []
  };
}

function readStaleGoodsField(record, adapter, field) {
  return firstValue(record, staleGoodsFieldPaths(adapter, field));
}

function readStaleGoodsFieldWithSource(record, adapter, field, options = {}) {
  const forbidden = new Set((options.forbidden || []).map((item) => String(item)));
  for (const path of staleGoodsFieldPaths(adapter, field)) {
    if (!path || forbidden.has(String(path))) continue;
    const value = getPath(record, path);
    if (value !== undefined && value !== null && value !== "") return { value, path };
  }
  return { value: undefined, path: "" };
}

function staleGoodsNumber(record, adapter, field, fallback = 0) {
  const value = coerceBusinessNumber(readStaleGoodsField(record, adapter, field));
  if (value === undefined) return fallback;
  return value / staleGoodsFieldScale(adapter, field);
}

function staleGoodsText(record, adapter, field, fallback = "") {
  return coerceViolationText(readStaleGoodsField(record, adapter, field)) || fallback;
}

function staleGoodsBool(record, adapter, field) {
  const value = readStaleGoodsField(record, adapter, field);
  if (typeof value === "boolean") return value;
  const number = coerceBusinessNumber(value);
  if (number !== undefined) return number > 0;
  return /(true|yes|risk|同款|不达标|1)/i.test(coerceViolationText(value));
}

function coerceStaleGoodsDate(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : value;
    return formatLocalIsoDate(new Date(ms));
  }
  const text = coerceViolationText(value);
  if (!text) return "";
  if (/^\d+$/.test(text)) return coerceStaleGoodsDate(Number(text));
  const normalized = text.replace(/\//g, "-");
  const parsed = new Date(normalized.includes("T") ? normalized : normalized.replace(" ", "T"));
  if (!Number.isNaN(parsed.getTime())) return formatLocalIsoDate(parsed);
  const match = normalized.match(/\d{4}-\d{1,2}-\d{1,2}/);
  return match ? match[0].split("-").map((part, index) => index ? part.padStart(2, "0") : part).join("-") : "";
}

function staleGoodsDaysSince(value) {
  const text = coerceStaleGoodsDate(value);
  if (!text) return -1;
  const time = new Date(`${text}T00:00:00`).getTime();
  if (!Number.isFinite(time)) return -1;
  return Math.max(0, Math.floor((Date.now() - time) / 864e5));
}

function staleGoodsAgeInfo(row = {}) {
  const daysSinceCreated = staleGoodsDaysSince(row.createdAt);
  const daysSinceListed = staleGoodsDaysSince(row.listedAt);
  if (daysSinceCreated >= 0) {
    return {
      value: row.createdAt || "",
      source: row.createdAtSource || "createdAt",
      type: "createdAt",
      days: daysSinceCreated,
      hasCreatedAt: true,
      hasListedAt: daysSinceListed >= 0,
      daysSinceCreated,
      daysSinceListed
    };
  }
  if (daysSinceListed >= 0) {
    return {
      value: row.listedAt || "",
      source: row.listedAtSource || "listedAt",
      type: "listedAt",
      days: daysSinceListed,
      hasCreatedAt: false,
      hasListedAt: true,
      daysSinceCreated,
      daysSinceListed
    };
  }
  return {
    value: "",
    source: "",
    type: "",
    days: -1,
    hasCreatedAt: false,
    hasListedAt: false,
    daysSinceCreated,
    daysSinceListed
  };
}

function isStaleGoodsResponseOk(response, adapter = DOUDIAN_ADAPTER, planKey = "") {
  return requestPlanResponseOk(response, adapter, planKey, staleGoodsCleanupMappings(adapter));
}

function summarizeStaleGoodsResponses(responses = {}, adapter = DOUDIAN_ADAPTER) {
  const output = {};
  for (const [key, response] of Object.entries(responses)) {
    output[key] = {
      status: response?.status || 0,
      success: isStaleGoodsResponseOk(response, adapter, key),
      code: responseBusinessCode(response),
      message: clipText(response?.data?.msg || response?.data?.message || response?.data?.status_msg || response?.error?.message || "", 160)
    };
  }
  return output;
}

function summarizeStaleGoodsSourceFailures(summary = {}, adapter = DOUDIAN_ADAPTER) {
  const optionalPlans = new Set(policyArray(adapter, "staleGoodsCleanup.optionalPlans", []).map((item) => String(item)));
  return Object.entries(summary)
    .filter(([, response]) => response?.success !== true)
    .map(([key, response]) => ({
      key,
      optional: optionalPlans.has(key),
      status: response?.status || 0,
      code: response?.code ?? null,
      message: response?.message || ""
    }));
}

function staleGoodsSourceHealth(summary = {}, adapter = DOUDIAN_ADAPTER, pagination = {}) {
  const optionalPlans = new Set(policyArray(adapter, "staleGoodsCleanup.optionalPlans", []).map((item) => String(item)));
  const requiredPlans = new Set(policyArray(adapter, "staleGoodsCleanup.requiredPlans", []).map((item) => String(item)));
  return Object.entries(summary).map(([key, response]) => {
    const plan = requestPlan(adapter, key);
    const diagnosticOnly = plan.diagnosticOnly === true || String(plan.calibrationStatus || "") === "failed";
    const ok = response?.success === true;
    return {
      key,
      required: requiredPlans.has(key),
      optional: optionalPlans.has(key),
      diagnosticOnly,
      status: diagnosticOnly ? "diagnostic_only" : ok ? "ready" : optionalPlans.has(key) ? "optional_failed" : "required_failed",
      httpStatus: response?.status || 0,
      code: response?.code ?? null,
      message: response?.message || "",
      calibrationStatus: String(plan.calibrationStatus || ""),
      pagination: pagination[key] || null
    };
  });
}

function staleGoodsScanSummary(details = [], rows = [], candidates = []) {
  const summary = {
    productCount: 0,
    remoteTotal: 0,
    candidateCount: candidates.length,
    ageBlocked: 0,
    stockBlocked: 0,
    priceBlocked: 0,
    qualityBlocked: 0,
    staleTypeBlocked: 0,
    missingCreatedAt: 0,
    missingListedAt: 0,
    missingAgeDate: 0,
    sourceFailureCount: 0,
    diagnosticSourceCount: 0,
    truncatedStoreCount: 0,
    splitRequiredStoreCount: 0,
    fetchedPages: 0,
    plannedPages: 0
  };
  for (const detail of details || []) {
    const diagnostic = detail?.diagnostic || {};
    summary.productCount += Number(diagnostic.productCount || 0);
    summary.remoteTotal += Number(diagnostic.remoteTotal || 0);
    summary.sourceFailureCount += Number(diagnostic.sourceFailureCount || 0);
    summary.diagnosticSourceCount += (diagnostic.sourceHealth || []).filter((item) => item?.diagnosticOnly).length;
    const blocks = diagnostic.ruleBlocks?.blocked || {};
    summary.ageBlocked += Number(blocks.age || 0);
    summary.stockBlocked += Number(blocks.stock || 0);
    summary.priceBlocked += Number(blocks.price || 0);
    summary.qualityBlocked += Number(blocks.quality || 0);
    summary.staleTypeBlocked += Number(blocks.staleType || 0);
    summary.missingCreatedAt += Number(blocks.missingCreatedAt || 0);
    summary.missingListedAt += Number(blocks.missingListedAt || 0);
    summary.missingAgeDate += Number(blocks.missingAgeDate || 0);
    for (const page of Object.values(diagnostic.pagination || {})) {
      if (!page || typeof page !== "object") continue;
      summary.fetchedPages += Number(page.fetchedPages || 0);
      summary.plannedPages += Number(page.plannedPages || 0);
      if (page.truncated) summary.truncatedStoreCount += 1;
      if (page.splitRequired) summary.splitRequiredStoreCount += 1;
    }
  }
  if (!summary.remoteTotal) summary.remoteTotal = summary.productCount;
  return summary;
}

function firstStaleGoodsErrorMessage(responses = {}, adapter = DOUDIAN_ADAPTER) {
  for (const [key, response] of Object.entries(responses)) {
    if (isStaleGoodsResponseOk(response, adapter, key)) continue;
    const message = response?.data?.msg || response?.data?.message || response?.data?.status_msg || response?.error?.message || "";
    if (message) return clipText(message, 160);
    if (response?.status) return `HTTP ${response.status}`;
  }
  return "";
}

function normalizeStaleGoodsRules(args = {}, adapter = DOUDIAN_ADAPTER) {
  const defaults = policy(adapter, "staleGoodsCleanup.defaultRules", {}) || {};
  const input = args.rules && typeof args.rules === "object" ? args.rules : {};
  const number = (key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const value = Number(input[key] ?? defaults[key] ?? fallback);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  };
  const bool = (key, fallback = false) => Boolean(input[key] ?? defaults[key] ?? fallback);
  const trafficPeriod = ["7d", "30d", "90d"].includes(String(input.trafficPeriod || defaults.trafficPeriod))
    ? String(input.trafficPeriod || defaults.trafficPeriod)
    : "30d";
  const noSalesType = ["balanced", "strict", "trafficWaste"].includes(String(input.noSalesType || defaults.noSalesType))
    ? String(input.noSalesType || defaults.noSalesType)
    : "balanced";
  return {
    totalSalesEnabled: bool("totalSalesEnabled", true),
    totalSalesMax: number("totalSalesMax", 5),
    exposureEnabled: bool("exposureEnabled", true),
    exposureMax: number("exposureMax", 800),
    clickEnabled: bool("clickEnabled", true),
    clickMax: number("clickMax", 30),
    exposureUsersEnabled: bool("exposureUsersEnabled"),
    exposureUsersMax: number("exposureUsersMax", 0),
    clickUsersEnabled: bool("clickUsersEnabled"),
    clickUsersMax: number("clickUsersMax", 0),
    periodSalesEnabled: bool("periodSalesEnabled"),
    periodSalesMax: number("periodSalesMax", 0),
    stockRangeEnabled: bool("stockRangeEnabled"),
    stockMin: number("stockMin", 0),
    stockMax: number("stockMax", 0),
    priceRangeEnabled: bool("priceRangeEnabled"),
    minPrice: number("minPrice", 0),
    maxPrice: number("maxPrice", 99999),
    skipCreatedDaysEnabled: bool("skipCreatedDaysEnabled", true),
    noSalesDays: number("noSalesDays", 30),
    skipListedDaysEnabled: bool("skipListedDaysEnabled"),
    listedDays: number("listedDays", 0),
    trafficPeriod,
    noSalesType,
    requireLowRating: bool("requireLowRating"),
    requireLowInfo: bool("requireLowInfo"),
    requireLowImage: bool("requireLowImage"),
    requireSameStyleRisk: bool("requireSameStyleRisk"),
    requireBadTitle: bool("requireBadTitle")
  };
}

function staleGoodsQualityIssues(row) {
  return {
    lowRating: Number(row.ratingScore || 0) > 0 && Number(row.ratingScore || 0) < 4.5,
    lowInfo: Number(row.infoQualityScore || 0) < 70,
    lowImage: Number(row.mainImageScore || 0) < 70,
    sameStyleRisk: row.sameStyleRisk === true,
    badTitle: Number(row.titleQualityScore || 0) < 70
  };
}

function staleGoodsQualityLabels(row) {
  const issues = staleGoodsQualityIssues(row);
  return [
    issues.lowRating ? "综合评价未达标" : "",
    issues.lowInfo ? "信息质量未达标" : "",
    issues.lowImage ? "主图未达标" : "",
    issues.sameStyleRisk ? "同款风险未达标" : "",
    issues.badTitle ? "标题质量未达标" : ""
  ].filter(Boolean);
}

function staleGoodsScore(row) {
  const qualityIssueCount = staleGoodsQualityLabels(row).length;
  const noPeriodSales = Number(row.periodSales || 0) === 0 ? 30 : 0;
  const lowTotalSales = Number(row.totalSales || 0) <= 5 ? 18 : 0;
  const trafficWaste = Number(row.exposureCount || 0) >= 1000 && Number(row.periodSales || 0) === 0 ? 20 : 0;
  const stockPressure = Number(row.stock || 0) >= 80 ? 12 : Number(row.stock || 0) >= 30 ? 8 : 4;
  const ageDays = staleGoodsAgeInfo(row).days;
  const age = ageDays >= 90 ? 10 : ageDays >= 30 ? 6 : 0;
  const quality = Math.min(15, qualityIssueCount * 4);
  return Math.min(100, noPeriodSales + lowTotalSales + trafficWaste + stockPressure + age + quality);
}

function staleGoodsRiskFromScore(score) {
  if (score >= 72) return "high";
  if (score >= 48) return "medium";
  return "low";
}

function staleGoodsActionFromRow(row) {
  const issues = staleGoodsQualityLabels(row);
  const hasTrafficWaste = Number(row.exposureCount || 0) >= 1000 && Number(row.periodSales || 0) === 0;
  if (Number(row.totalSales || 0) <= 1 && Number(row.periodSales || 0) === 0 && issues.length >= 3) return "delete";
  if (Number(row.totalSales || 0) <= 2 && Number(row.periodSales || 0) === 0 && Number(row.stock || 0) >= 80) return "recycle";
  if (hasTrafficWaste || Number(row.stock || 0) >= 30) return "offline";
  return "optimize";
}

function staleGoodsReasons(row) {
  const reasons = [];
  if (Number(row.periodSales || 0) === 0) reasons.push("周期无成交");
  if (Number(row.totalSales || 0) <= 5) reasons.push("总销量低");
  if (Number(row.exposureCount || 0) >= 1000 && Number(row.periodSales || 0) === 0) reasons.push("有曝光无转化");
  if (Number(row.clickCount || 0) <= 30) reasons.push("点击偏低");
  if (Number(row.stock || 0) >= 80) reasons.push("库存占用");
  const ageInfo = staleGoodsAgeInfo(row);
  if (ageInfo.days >= 30) reasons.push(ageInfo.type === "listedAt" ? "上架超过30天" : "创建超过30天");
  return [...reasons, ...staleGoodsQualityLabels(row)].slice(0, 6);
}

function evaluateStaleGoodsRules(row, rules) {
  const withinSales = !rules.totalSalesEnabled || Number(row.totalSales || 0) <= rules.totalSalesMax;
  const withinPeriodSales = !rules.periodSalesEnabled || Number(row.periodSales || 0) <= rules.periodSalesMax;
  const withinExposure = !rules.exposureEnabled || Number(row.exposureCount || 0) <= rules.exposureMax;
  const withinClick = !rules.clickEnabled || Number(row.clickCount || 0) <= rules.clickMax;
  const withinExposureUsers = !rules.exposureUsersEnabled || Number(row.exposureUsers || 0) <= rules.exposureUsersMax;
  const withinClickUsers = !rules.clickUsersEnabled || Number(row.clickUsers || 0) <= rules.clickUsersMax;
  const withinTraffic = withinExposure && withinClick && withinExposureUsers && withinClickUsers;
  const enabledMetricChecks = [
    rules.totalSalesEnabled,
    rules.periodSalesEnabled,
    rules.exposureEnabled,
    rules.clickEnabled,
    rules.exposureUsersEnabled,
    rules.clickUsersEnabled
  ].some(Boolean);
  const staleMetricsMatch = enabledMetricChecks
    ? withinSales && withinPeriodSales && withinTraffic
    : true;
  const stockMax = Number(rules.stockMax || 0);
  const priceMax = Number(rules.maxPrice || 0);
  const hasStock = !rules.stockRangeEnabled || (Number(row.stock || 0) >= rules.stockMin && (!stockMax || Number(row.stock || 0) <= stockMax));
  const withinPrice = !rules.priceRangeEnabled || (Number(row.price || 0) >= rules.minPrice && (!priceMax || Number(row.price || 0) <= priceMax));
  const ageInfo = staleGoodsAgeInfo(row);
  const daysSinceListed = ageInfo.daysSinceListed;
  const daysSinceCreated = ageInfo.daysSinceCreated;
  const hasListedAt = ageInfo.hasListedAt;
  const hasCreatedAt = ageInfo.hasCreatedAt;
  const hasAgeDate = ageInfo.days >= 0;
  const createdOldEnough = !rules.skipCreatedDaysEnabled || (Number(daysSinceCreated) >= 0 && Number(daysSinceCreated) >= rules.noSalesDays);
  const listedOldEnough = !rules.skipListedDaysEnabled || (Number(daysSinceListed) >= 0 && Number(daysSinceListed) >= rules.listedDays);
  const oldEnough = createdOldEnough && listedOldEnough;
  const issues = staleGoodsQualityIssues(row);
  const selectedQualityRules = [
    rules.requireLowRating ? issues.lowRating : false,
    rules.requireLowInfo ? issues.lowInfo : false,
    rules.requireLowImage ? issues.lowImage : false,
    rules.requireSameStyleRisk ? issues.sameStyleRisk : false,
    rules.requireBadTitle ? issues.badTitle : false
  ];
  const hasSelectedQualityRule = [
    rules.requireLowRating,
    rules.requireLowInfo,
    rules.requireLowImage,
    rules.requireSameStyleRisk,
    rules.requireBadTitle
  ].some(Boolean);
  const qualityMatch = hasSelectedQualityRule ? selectedQualityRules.some(Boolean) : true;
  const baseMatch = hasStock && withinPrice && oldEnough && qualityMatch;
  const typeMatch = rules.noSalesType === "strict"
    ? Number(row.periodSales || 0) === 0 && (!rules.totalSalesEnabled || Number(row.totalSales || 0) <= rules.totalSalesMax)
    : rules.noSalesType === "trafficWaste"
      ? Number(row.exposureCount || 0) >= (rules.exposureEnabled ? rules.exposureMax : 0) && Number(row.periodSales || 0) <= rules.periodSalesMax
      : staleMetricsMatch;
  return {
    matched: baseMatch && typeMatch,
    withinSales,
    withinPeriodSales,
    withinExposure,
    withinClick,
    withinExposureUsers,
    withinClickUsers,
    withinTraffic,
    hasStock,
    withinPrice,
    oldEnough,
    createdOldEnough,
    listedOldEnough,
    qualityMatch,
    typeMatch,
    hasCreatedAt,
    hasListedAt,
    hasAgeDate,
    ageDate: ageInfo.value,
    ageDateSource: ageInfo.source,
    ageDateType: ageInfo.type,
    daysSinceCreated,
    daysSinceListed,
    daysSinceAge: ageInfo.days
  };
}

function staleGoodsMatchesRules(row, rules) {
  return evaluateStaleGoodsRules(row, rules).matched;
}

function summarizeStaleGoodsRuleBlocks(products = [], rules = {}) {
  const summary = {
    total: products.length,
    matched: 0,
    blocked: {
      stock: 0,
      price: 0,
      age: 0,
      quality: 0,
      staleType: 0,
      missingCreatedAt: 0,
      missingListedAt: 0,
      missingAgeDate: 0
    },
    samples: []
  };
  for (const row of products) {
    const checks = evaluateStaleGoodsRules(row, rules);
    if (checks.matched) {
      summary.matched += 1;
      continue;
    }
    if (!checks.hasStock) summary.blocked.stock += 1;
    if (!checks.withinPrice) summary.blocked.price += 1;
    if (!checks.hasCreatedAt) summary.blocked.missingCreatedAt += 1;
    if (!checks.hasListedAt) summary.blocked.missingListedAt += 1;
    if (!checks.hasAgeDate) summary.blocked.missingAgeDate += 1;
    if (!checks.oldEnough) summary.blocked.age += 1;
    if (!checks.qualityMatch) summary.blocked.quality += 1;
    if (!checks.typeMatch) summary.blocked.staleType += 1;
    if (summary.samples.length < 5) {
      summary.samples.push({
        productId: row.productId,
        totalSales: row.totalSales,
        periodSales: row.periodSales,
        stock: row.stock,
        price: row.price,
        createdAt: row.createdAt,
        createdAtSource: row.createdAtSource || "",
        listedAt: row.listedAt,
        listedAtSource: row.listedAtSource || "",
        createdAtMissing: row.createdAtMissing === true,
        listedAtMissing: row.listedAtMissing === true,
        ageDate: checks.ageDate,
        ageDateSource: checks.ageDateSource,
        ageDateType: checks.ageDateType,
        daysSinceCreated: checks.daysSinceCreated,
        daysSinceListed: checks.daysSinceListed,
        daysSinceAge: checks.daysSinceAge,
        checks
      });
    }
  }
  return summary;
}

function compassRowsByProductId(rows = []) {
  const output = new Map();
  if (!Array.isArray(rows)) return output;
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const productId = coerceViolationText(
      item.productId ?? item.product_id ?? item.goodsId ?? item.goods_id ?? item.itemId ?? item.item_id ?? item.id
    );
    if (productId) output.set(String(productId), item);
  }
  return output;
}

function compassMetric(compass, keys = [], fallback = undefined) {
  if (!compass || typeof compass !== "object") return fallback;
  for (const key of keys) {
    const value = compass[key];
    const number = coerceBusinessNumber(value);
    if (number !== undefined) return number;
  }
  return fallback;
}

function normalizeStaleGoodsProduct(store, item, index, adapter = DOUDIAN_ADAPTER, args = {}) {
  const productId = staleGoodsText(item, adapter, "productId", `${store.shopId || "shop"}-${index + 1}`);
  const compass = compassRowsByProductId(args.compassRows).get(String(productId));
  const createdAtField = readStaleGoodsFieldWithSource(item, adapter, "createdAt");
  const listedAtField = readStaleGoodsFieldWithSource(item, adapter, "listedAt", {
    forbidden: ["update_time", "updateTime"]
  });
  const createdAt = coerceStaleGoodsDate(createdAtField.value);
  const listedAt = coerceStaleGoodsDate(listedAtField.value);
  const daysSinceCreated = staleGoodsDaysSince(createdAt);
  const daysSinceListed = staleGoodsDaysSince(listedAt);
  const ageInfo = staleGoodsAgeInfo({
    createdAt,
    listedAt,
    createdAtSource: createdAtField.path,
    listedAtSource: listedAtField.path
  });
  const row = {
    id: `${store.shopId || "shop"}-${productId}`,
    shopId: String(store.shopId || ""),
    shopName: String(store.shopName || ""),
    group: String(store.groupName || ""),
    productId: String(productId),
    title: staleGoodsText(item, adapter, "title", `商品 ${productId}`),
    category: staleGoodsText(item, adapter, "category", "未分类"),
    status: staleGoodsText(item, adapter, "status", "在售") || "在售",
    createdAt,
    listedAt,
    createdAtSource: createdAtField.path,
    listedAtSource: listedAtField.path,
    createdAtMissing: !createdAt,
    listedAtMissing: !listedAt,
    ageDate: ageInfo.value,
    ageDateSource: ageInfo.source,
    ageDateType: ageInfo.type,
    daysSinceAge: ageInfo.days,
    daysSinceCreated,
    daysSinceListed,
    price: staleGoodsNumber(item, adapter, "price", 0),
    stock: staleGoodsNumber(item, adapter, "stock", 0),
    totalSales: staleGoodsNumber(item, adapter, "totalSales", 0),
    periodSales: staleGoodsNumber(item, adapter, "periodSales", 0),
    exposureCount: compassMetric(compass, ["exposureCount", "exposure_count", "showCount", "show_count", "曝光次数"], staleGoodsNumber(item, adapter, "exposureCount", 0)),
    clickCount: compassMetric(compass, ["clickCount", "click_count", "点击次数"], staleGoodsNumber(item, adapter, "clickCount", 0)),
    exposureUsers: compassMetric(compass, ["exposureUsers", "exposure_users", "曝光人数"], staleGoodsNumber(item, adapter, "exposureUsers", 0)),
    clickUsers: compassMetric(compass, ["clickUsers", "click_users", "点击人数"], staleGoodsNumber(item, adapter, "clickUsers", 0)),
    ratingScore: staleGoodsNumber(item, adapter, "ratingScore", 0),
    infoQualityScore: staleGoodsNumber(item, adapter, "infoQualityScore", 100),
    mainImageScore: staleGoodsNumber(item, adapter, "mainImageScore", 100),
    titleQualityScore: staleGoodsNumber(item, adapter, "titleQualityScore", 100),
    sameStyleRisk: staleGoodsBool(item, adapter, "sameStyleRisk"),
    risk: "low",
    riskScore: 0,
    action: "optimize",
    reasons: [],
    source: staleGoodsText(item, adapter, "source", compass ? "平台商品列表 + 罗盘经营版商品列表" : "平台商品列表"),
    raw: policyBool(adapter, "staleGoodsCleanup.includeRawProduct", false) ? item : undefined
  };
  row.riskScore = staleGoodsScore(row);
  row.risk = staleGoodsRiskFromScore(row.riskScore);
  row.action = staleGoodsActionFromRow(row);
  row.reasons = staleGoodsReasons(row);
  return row;
}

function extractStaleGoodsProducts(store, responses, adapter = DOUDIAN_ADAPTER, args = {}) {
  const payload = staleGoodsPayload(responses);
  const { items } = extractStaleGoodsProductItems(payload, adapter);
  return items.map((item, index) => normalizeStaleGoodsProduct(store, item, index, adapter, args));
}

function staleGoodsResponseBaseKey(key) {
  return String(key || "").replace(/:page:\d+$/, "");
}

function extractStaleGoodsProductBatches(responses = {}, adapter = DOUDIAN_ADAPTER) {
  const batches = [];
  const items = [];
  for (const [key, response] of Object.entries(responses)) {
    const baseKey = staleGoodsResponseBaseKey(key);
    const payload = staleGoodsPayload({ [baseKey]: response });
    const extraction = extractStaleGoodsProductItems(payload, adapter);
    batches.push({
      key,
      baseKey,
      source: extraction.source,
      path: extraction.path,
      rawCount: extraction.items.length,
      firstItemKeys: extraction.firstItemKeys || []
    });
    if (extraction.items.length) items.push(...extraction.items);
  }
  return {
    items,
    source: batches.some((batch) => batch.source === "path") ? "path" : batches.some((batch) => batch.source === "deep") ? "deep" : "none",
    path: batches.find((batch) => batch.rawCount > 0)?.path || "",
    firstItemKeys: batches.find((batch) => batch.firstItemKeys.length)?.firstItemKeys || [],
    batches
  };
}

function dedupeStaleGoodsProducts(products = []) {
  const output = [];
  const seen = new Set();
  for (const item of products) {
    const key = `${item.shopId || ""}:${item.productId || item.id || ""}`;
    if (key.trim() && seen.has(key)) continue;
    if (key.trim()) seen.add(key);
    output.push(item);
  }
  return output;
}

function readStaleGoodsTotal(responses, adapter = DOUDIAN_ADAPTER) {
  const payload = staleGoodsPayload(responses);
  const value = firstValue(payload, staleGoodsTotalPaths(adapter));
  const total = coerceBusinessNumber(value);
  return total !== undefined ? total : 0;
}

function readStaleGoodsTotalFromResponse(planKey, response, adapter = DOUDIAN_ADAPTER) {
  return readStaleGoodsTotal({ [planKey]: response }, adapter);
}

function emptyStaleGoodsRow(store) {
  return {
    shopId: String(store.shopId || ""),
    shopName: String(store.shopName || ""),
    group: String(store.groupName || ""),
    status: store.status || "unknown",
    totalProducts: 0,
    candidateCount: 0,
    highRiskCount: 0,
    offlineCount: 0,
    recycleCount: 0,
    deleteCount: 0,
    optimizeCount: 0,
    trafficWasteCount: 0,
    qualityIssueCount: 0,
    stockCount: 0
  };
}

function buildStaleGoodsRowFromCandidates(store, candidates = [], remoteTotal = 0) {
  const row = emptyStaleGoodsRow(store);
  row.totalProducts = remoteTotal || candidates.length;
  row.candidateCount = candidates.length;
  row.highRiskCount = candidates.filter((item) => item.risk === "high").length;
  row.offlineCount = candidates.filter((item) => item.action === "offline").length;
  row.recycleCount = candidates.filter((item) => item.action === "recycle").length;
  row.deleteCount = candidates.filter((item) => item.action === "delete").length;
  row.optimizeCount = candidates.filter((item) => item.action === "optimize").length;
  row.trafficWasteCount = candidates.filter((item) => Number(item.exposureCount || 0) >= 1000 && Number(item.periodSales || 0) === 0).length;
  row.qualityIssueCount = candidates.filter((item) => staleGoodsQualityLabels(item).length > 0).length;
  row.stockCount = candidates.reduce((sum, item) => sum + Number(item.stock || 0), 0);
  return row;
}

function staleGoodsSummary(candidates = [], rows = []) {
  return {
    candidateCount: candidates.length,
    shopCount: rows.length,
    highRiskCount: candidates.filter((item) => item.risk === "high").length,
    offlineCount: candidates.filter((item) => item.action === "offline").length,
    recycleCount: candidates.filter((item) => item.action === "recycle").length,
    deleteCount: candidates.filter((item) => item.action === "delete").length,
    optimizeCount: candidates.filter((item) => item.action === "optimize").length,
    destructiveCount: candidates.filter((item) => item.action === "recycle" || item.action === "delete").length,
    trafficWasteCount: candidates.filter((item) => Number(item.exposureCount || 0) >= 1000 && Number(item.periodSales || 0) === 0).length,
    qualityIssueCount: candidates.filter((item) => staleGoodsQualityLabels(item).length > 0).length,
    stockCount: candidates.reduce((sum, item) => sum + Number(item.stock || 0), 0)
  };
}

function staleGoodsActionPlanKey(adapter = DOUDIAN_ADAPTER, action = "") {
  const plans = policy(adapter, "staleGoodsCleanup.executePlans", {});
  if (plans && typeof plans === "object" && plans[action]) return String(plans[action]);
  if (action === "offline") return "staleGoodsBatchOffline";
  if (action === "recycle") return "staleGoodsBatchDelete";
  if (action === "delete") return "staleGoodsCompleteDelete";
  return "";
}

function validateStaleGoodsExecutePlan(adapter = DOUDIAN_ADAPTER, action = "", planKey = "") {
  const allow = STALE_GOODS_EXECUTE_ALLOWLIST[action];
  if (!allow || String(planKey) !== allow.planKey) return { ok: false, reason: "action-plan-not-allowlisted" };
  const plan = requestPlan(adapter, planKey);
  const endpoint = requestPlanEndpoint(adapter, plan);
  const method = String(plan.method || "GET").toUpperCase();
  const endpointPath = endpoint ? new URL(platformUrl(adapter, endpoint)).pathname : "";
  if (method !== allow.method) return { ok: false, reason: "method-not-allowlisted", method };
  if (endpointPath !== allow.endpoint) return { ok: false, reason: "endpoint-not-allowlisted", endpoint: endpointPath };
  return {
    ok: true,
    dryRunOnly: plan.dryRunOnly !== false,
    planKey,
    endpoint: endpointPath,
    method
  };
}

function normalizeStaleGoodsExecuteCandidates(args = {}) {
  const source = Array.isArray(args.candidates) ? args.candidates : [];
  const candidateIds = new Set((args.candidateIds || []).map((id) => String(id)));
  return source
    .filter((item) => item && typeof item === "object")
    .filter((item) => !candidateIds.size || candidateIds.has(String(item.id || `${item.shopId || ""}-${item.productId || ""}`)))
    .map((item) => ({
      id: String(item.id || `${item.shopId || ""}-${item.productId || ""}`),
      candidateId: String(item.candidateId || item.snapshotId || ""),
      sourceRunId: String(item.sourceRunId || args.sourceRunId || ""),
      shopId: String(item.shopId || ""),
      shopName: String(item.shopName || ""),
      productId: String(item.productId || ""),
      title: String(item.title || ""),
      action: String(args.action || item.action || "")
    }))
    .filter((item) => item.shopId && item.productId && ["offline", "recycle", "delete"].includes(item.action));
}

async function associateViolationProducts({ store, records, requestContext, operation, adapter }) {
  if (!violationsProductAssociationEnabled(adapter)) return { records, failures: [], responses: {} };
  const planKeys = violationsProductAssociationPlans(adapter);
  if (!planKeys.length) return { records, failures: [], responses: {} };
  const productIds = Array.from(new Set(records.map((record) => String(record.productId || "")).filter(Boolean)));
  if (!productIds.length) return { records, failures: [], responses: {} };
  const failures = [];
  const responses = {};
  const byProductId = new Map();
  const concurrency = violationsProductAssociationConcurrency(adapter);
  const settled = await settleWithConcurrency(productIds, concurrency, async (productId) => {
    const context = {
      ...requestContext,
      productId,
      shopId: store.shopId,
      shopName: store.shopName
    };
    for (const planKey of planKeys) {
      throwIfCancelled(operation);
      const response = await doudianRequestByPlan(store.partition, planKey, operation, null, adapter, context);
      responses[`${planKey}:${productId}`] = summarizeRequestPlanResponse(response, adapter, planKey);
      if (!isViolationsResponseOk(response, adapter, planKey)) {
        failures.push({
          key: planKey,
          phase: "product_association",
          productId,
          optional: true,
          status: response?.status || 0,
          code: responseBusinessCode(response),
          message: clipText(response?.data?.msg || response?.data?.message || response?.data?.status_msg || response?.error?.message || "", 160)
        });
        continue;
      }
      const association = extractViolationProductAssociation(response, adapter, productId, planKey);
      if (association) byProductId.set(productId, association);
    }
  });
  settled.forEach((result, index) => {
    if (result.status !== "rejected") return;
    failures.push({
      key: planKeys.join(","),
      phase: "product_association",
      productId: productIds[index] || "",
      optional: true,
      status: 0,
      code: null,
      message: safeError(result.reason)
    });
  });
  const associatedRecords = records.map((record) => {
    const productId = String(record.productId || "");
    const association = byProductId.get(productId);
    if (!association) return record;
    const productStatus = association.productStatus || record.productStatus;
    return {
      ...record,
      productStatus,
      associationStatus: association.associationStatus || violationAssociationStatus(productStatus, productId),
      productAssociationRaw: association.raw
    };
  });
  return { records: associatedRecords, failures, responses };
}

async function collectViolationsDataForStore({ store, index, total, planKeys, args, operation, adapter, onProgress }) {
  throwIfCancelled(operation);
  if (!store?.partition) {
    const error = new Error("store partition missing");
    error.code = "DOUDIAN_STORE_PARTITION_MISSING";
    throw error;
  }

  if (onProgress) {
    onProgress({
      phase: "violationsData",
      shopId: store.shopId,
      shopName: store.shopName,
      status: "unknown",
      ok: true,
      message: policyMessage(adapter, "violationsData.messages.syncing", "Syncing violations data"),
      index,
      total
    });
  }

  const responses = {};
  const requestContext = {
    ...violationsDateContext(args, adapter),
    processStatus: args.processStatus || "",
    partition: store.partition,
    shopPartition: store.partition,
    shopId: store.shopId,
    shopName: store.shopName,
    sourcePlan: planKeys[0] || "violationPenaltyList"
  };
  for (const planKey of planKeys) {
    throwIfCancelled(operation);
    responses[planKey] = await doudianRequestByPlan(store.partition, planKey, operation, null, adapter, requestContext);
  }

  const payload = violationsPayload(responses);
  let records = extractViolationRecords(store, responses, requestContext, adapter);
  const associationResult = await associateViolationProducts({
    store,
    records,
    requestContext,
    operation,
    adapter
  });
  records = associationResult.records;
  const { row } = buildViolationsDataRowFromRecords(store, records, requestContext, readViolationTotal(payload, adapter));
  const responseSummary = summarizeViolationsResponses(responses, adapter);
  const sourceFailures = [
    ...summarizeViolationsSourceFailures(responseSummary, adapter),
    ...associationResult.failures
  ];
  const blockingSourceFailures = sourceFailures.filter((failure) => !failure.optional);
  const rowSummary = violationsRowSummary(row, records);
  const requiredPlans = policyArray(adapter, "violationsData.requiredPlans", []).map((item) => String(item)).filter(Boolean);
  const okCount = Object.entries(responses).filter(([key, response]) => isViolationsResponseOk(response, adapter, key)).length;
  const successPlanKeys = Object.entries(responses)
    .filter(([key, response]) => isViolationsResponseOk(response, adapter, key))
    .map(([key]) => key);
  const missingRequiredPlans = requiredPlans.filter((planKey) => !isViolationsResponseOk(responses[planKey], adapter, planKey));
  const ok = requiredPlans.length ? missingRequiredPlans.length === 0 : okCount > 0;
  const partial = ok && blockingSourceFailures.length > 0;
  const message = !ok
    ? (firstViolationsErrorMessage(responses, adapter) || policyMessage(adapter, "violationsData.messages.failed", "Violations data request failed"))
    : blockingSourceFailures.length
      ? policyMessage(adapter, "violationsData.messages.partialSourceStore", "Violations data synced with partial source errors")
      : rowSummary.noRecord
        ? policyMessage(adapter, "violationsData.messages.noRecordStore", "Violations data synced with no records")
        : policyMessage(adapter, "violationsData.messages.synced", "Violations data synced");
  const detail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (partial ? "partial" : "ok") : "failed",
    ok,
    message,
    reason: ok ? (partial ? "violations-data-partial-source-failure" : rowSummary.noRecord ? "violations-data-no-record" : "") : "violations-data-request-failed",
    category: ok ? (partial ? "api-partial" : "") : "api",
    diagnostic: {
      responses: responseSummary,
      okCount,
      successPlanKeys,
      requiredPlans,
      missingRequiredPlans,
      sourceFailureCount: sourceFailures.length,
      blockingSourceFailureCount: blockingSourceFailures.length,
      sourceFailures,
      productAssociationEnabled: violationsProductAssociationEnabled(adapter),
      productAssociationResponses: associationResult.responses,
      rowSummary,
      datePreset: requestContext.datePreset,
      beginDate: requestContext.beginDate,
      endDate: requestContext.endDate
    },
    index,
    total
  };

  if (onProgress) {
    onProgress({
      phase: "violationsData",
      shopId: store.shopId,
      shopName: store.shopName,
      status: ok ? store.status : "check_failed",
      ok,
      message,
      index,
      total
    });
  }

  return { row, records, detail };
}

async function collectStaleGoodsForStore({ store, index, total, planKeys, args, operation, adapter, onProgress }) {
  throwIfCancelled(operation);
  if (!store?.partition) {
    const error = new Error("store partition missing");
    error.code = "DOUDIAN_STORE_PARTITION_MISSING";
    throw error;
  }

  if (onProgress) {
    onProgress({
      phase: "staleGoodsCleanup",
      shopId: store.shopId,
      shopName: store.shopName,
      status: "unknown",
      ok: true,
      message: policyMessage(adapter, "staleGoodsCleanup.messages.scanning", "Scanning stale goods candidates"),
      index,
      total
    });
  }

  const rules = normalizeStaleGoodsRules(args, adapter);
  const responses = {};
  const pagination = {};
  const requestContext = {
    ...dataDateContext(args, adapter, "staleGoodsCleanup", rules.trafficPeriod || "30d"),
    page: String(args.page ?? policyNumber(adapter, "staleGoodsCleanup.pageStart", 0, { min: 0, max: 1 })),
    pageSize: String(args.pageSize || policyNumber(adapter, "staleGoodsCleanup.pageSize", 100, { min: 10, max: 200 })),
    productStatus: String(args.productStatus || policyText(adapter, "staleGoodsCleanup.productStatus", "")),
    keyword: String(args.keyword || ""),
    partition: store.partition,
    shopPartition: store.partition,
    shopId: store.shopId,
    shopName: store.shopName
  };

  for (const planKey of planKeys) {
    throwIfCancelled(operation);
    const firstResponse = await doudianRequestByPlan(store.partition, planKey, operation, null, adapter, requestContext);
    responses[planKey] = firstResponse;
    if (planKey !== "staleGoodsProductList" || !isStaleGoodsResponseOk(firstResponse, adapter, planKey)) continue;

    const pageSize = Math.max(10, Math.min(200, Math.floor(Number(requestContext.pageSize) || 100)));
    const remoteTotalForPlan = readStaleGoodsTotalFromResponse(planKey, firstResponse, adapter);
    const pageStart = Math.max(0, Math.floor(Number(requestContext.page) || 0));
    const plannedPages = remoteTotalForPlan > 0 ? Math.ceil(remoteTotalForPlan / pageSize) : 1;
    const maxPages = policyNumber(adapter, "staleGoodsCleanup.maxProductListPages", Number(args.maxProductListPages || 20), { min: 1, max: 50 });
    const pageCount = Math.max(1, Math.min(plannedPages || 1, Math.floor(Number(args.maxProductListPages || maxPages) || maxPages)));
    const lastPage = pageStart + pageCount - 1;
    pagination[planKey] = {
      pageStart,
      pageSize,
      remoteTotal: remoteTotalForPlan,
      plannedPages,
      fetchedPages: 1,
      pageCount,
      lastPage,
      truncated: plannedPages > pageCount,
      splitRequired: plannedPages > pageCount,
      splitStrategy: plannedPages > pageCount ? "create_time_boundary_required" : ""
    };
    for (let page = pageStart + 1; page <= lastPage; page += 1) {
      throwIfCancelled(operation);
      const pageResponse = await doudianRequestByPlan(store.partition, planKey, operation, null, adapter, {
        ...requestContext,
        page: String(page)
      });
      responses[`${planKey}:page:${page}`] = pageResponse;
      pagination[planKey].fetchedPages += 1;
      if (!isStaleGoodsResponseOk(pageResponse, adapter, planKey)) break;
      const pagePayload = staleGoodsPayload({ [planKey]: pageResponse });
      const pageExtraction = extractStaleGoodsProductItems(pagePayload, adapter);
      if (!pageExtraction.items.length) break;
    }
  }

  const payload = staleGoodsPayload(responses);
  const productExtraction = extractStaleGoodsProductBatches(responses, adapter);
  const products = dedupeStaleGoodsProducts(
    productExtraction.items.map((item, productIndex) => normalizeStaleGoodsProduct(store, item, productIndex, adapter, args))
  );
  const candidates = products.filter((item) => staleGoodsMatchesRules(item, rules));
  const remoteTotal = readStaleGoodsTotal(responses, adapter) || products.length;
  const ruleBlocks = summarizeStaleGoodsRuleBlocks(products, rules);
  const row = buildStaleGoodsRowFromCandidates(store, candidates, remoteTotal);
  const responseSummary = summarizeStaleGoodsResponses(responses, adapter);
  const sourceFailures = summarizeStaleGoodsSourceFailures(responseSummary, adapter);
  const sourceHealth = staleGoodsSourceHealth(responseSummary, adapter, pagination);
  const blockingSourceFailures = sourceFailures.filter((failure) => !failure.optional);
  const requiredPlans = policyArray(adapter, "staleGoodsCleanup.requiredPlans", []).map((item) => String(item)).filter(Boolean);
  const successPlanKeys = Object.entries(responses)
    .filter(([key, response]) => isStaleGoodsResponseOk(response, adapter, key))
    .map(([key]) => key);
  const missingRequiredPlans = requiredPlans.filter((planKey) => !isStaleGoodsResponseOk(responses[planKey], adapter, planKey));
  const ok = requiredPlans.length ? missingRequiredPlans.length === 0 : successPlanKeys.length > 0;
  const mappingMismatch = ok && remoteTotal > 0 && products.length === 0;
  const partial = ok && (blockingSourceFailures.length > 0 || mappingMismatch);
  const message = !ok
    ? (firstStaleGoodsErrorMessage(responses, adapter) || policyMessage(adapter, "staleGoodsCleanup.messages.failed", "Stale goods request failed"))
    : partial
      ? mappingMismatch
        ? policyMessage(adapter, "staleGoodsCleanup.messages.mappingMismatchStore", "Stale goods response has products but no list field matched")
        : policyMessage(adapter, "staleGoodsCleanup.messages.partialSourceStore", "Stale goods scan completed with partial source errors")
      : candidates.length
        ? policyMessage(adapter, "staleGoodsCleanup.messages.scanned", "Stale goods candidates scanned")
        : policyMessage(adapter, "staleGoodsCleanup.messages.noCandidateStore", "No stale goods candidates matched");
  const detail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (partial ? "partial" : "ok") : "failed",
    ok,
    message,
    reason: ok
      ? (partial
        ? mappingMismatch ? "stale-goods-list-mapping-missing" : "stale-goods-partial-source-failure"
        : candidates.length ? "" : "stale-goods-no-candidate")
      : "stale-goods-request-failed",
    category: ok ? (partial ? mappingMismatch ? "mapping" : "api-partial" : "") : "api",
    diagnostic: {
      responses: responseSummary,
      successPlanKeys,
      requiredPlans,
      missingRequiredPlans,
      sourceFailureCount: sourceFailures.length,
      blockingSourceFailureCount: blockingSourceFailures.length,
      sourceFailures,
      sourceHealth,
      productCount: products.length,
      candidateCount: candidates.length,
      remoteTotal: row.totalProducts,
      productListExtraction: {
        source: productExtraction.source,
        path: productExtraction.path,
        rawCount: productExtraction.items.length,
        firstItemKeys: productExtraction.firstItemKeys || [],
        batches: productExtraction.batches || []
      },
      pagination,
      ruleBlocks,
      responseShape: summarizeStaleGoodsPayloadShape(payload),
      compassRows: Array.isArray(args.compassRows) ? args.compassRows.length : 0,
      compassFileName: args.compassFileName || "",
      rules
    },
    index,
    total
  };

  if (onProgress) {
    onProgress({
      phase: "staleGoodsCleanup",
      shopId: store.shopId,
      shopName: store.shopName,
      status: ok ? store.status : "check_failed",
      ok,
      message,
      index,
      total
    });
  }

  return { row, products, candidates, detail };
}

async function executeStaleGoodsForStore({ store, candidates, action, planKey, index, total, args, operation, adapter, onProgress }) {
  throwIfCancelled(operation);
  const productIds = candidates.map((item) => String(item.productId || "")).filter(Boolean);
  if (!productIds.length) {
    return {
      executions: [],
      detail: {
        shopId: store.shopId,
        shopName: store.shopName,
        status: "skipped",
        ok: true,
        message: "No selected products",
        reason: "stale-goods-no-selected-products",
        category: "",
        index,
        total
      }
    };
  }

  if (onProgress) {
    onProgress({
      phase: "staleGoodsCleanup",
      shopId: store.shopId,
      shopName: store.shopName,
      status: "unknown",
      ok: true,
      message: policyMessage(adapter, "staleGoodsCleanup.messages.executing", "Executing stale goods cleanup"),
      index,
      total
    });
  }

  const requestContext = {
    action,
    productIds,
    productIdsCsv: productIds.join(","),
    productIdList: productIds,
    productCount: productIds.length,
    partition: store.partition,
    shopPartition: store.partition,
    shopId: store.shopId,
    shopName: store.shopName
  };
  const executePlanGuard = validateStaleGoodsExecutePlan(adapter, action, planKey);
  if (!executePlanGuard.ok) {
    const message = `Stale goods execute plan blocked: ${executePlanGuard.reason}`;
    const executions = candidates.map((item) => ({
      id: item.id,
      shopId: store.shopId,
      shopName: store.shopName,
      productId: item.productId,
      title: item.title || "",
      action,
      status: "blocked",
      ok: false,
      message,
      planKey
    }));
    return {
      executions,
      detail: {
        shopId: store.shopId,
        shopName: store.shopName,
        status: "failed",
        ok: false,
        message,
        reason: "stale-goods-execute-plan-blocked",
        category: "local-policy",
        diagnostic: {
          planKey,
          action,
          productCount: productIds.length,
          executePlanGuard
        },
        index,
        total
      }
    };
  }
  if (executePlanGuard.dryRunOnly) {
    const message = policyMessage(adapter, "staleGoodsCleanup.messages.executeDryRun", "Stale goods cleanup dry-run only; no platform write request was submitted", { count: productIds.length });
    const executions = candidates.map((item) => ({
      id: item.id,
      shopId: store.shopId,
      shopName: store.shopName,
      productId: item.productId,
      title: item.title || "",
      action,
      status: "dry_run",
      ok: true,
      message,
      planKey
    }));
    const detail = {
      shopId: store.shopId,
      shopName: store.shopName,
      status: "dry_run",
      ok: true,
      message,
      reason: "stale-goods-execute-dry-run",
      category: "local-policy",
      diagnostic: {
        planKey,
        action,
        productCount: productIds.length,
        executePlanGuard,
        requestContext
      },
      index,
      total
    };
    if (onProgress) {
      onProgress({
        phase: "staleGoodsCleanup",
        shopId: store.shopId,
        shopName: store.shopName,
        status: store.status,
        ok: true,
        message,
        index,
        total
      });
    }
    return { executions, detail };
  }
  const response = await doudianRequestByPlan(store.partition, planKey, operation, null, adapter, requestContext);
  const ok = isStaleGoodsResponseOk(response, adapter, planKey);
  const message = ok
    ? policyMessage(adapter, "staleGoodsCleanup.messages.executedStore", "Stale goods cleanup executed", { count: productIds.length })
    : requestPlanResponseMessage(response) || policyMessage(adapter, "staleGoodsCleanup.messages.executeFailed", "Stale goods cleanup failed");
  const executions = candidates.map((item) => ({
    id: item.id,
    shopId: store.shopId,
    shopName: store.shopName,
    productId: item.productId,
    title: item.title || "",
    action,
    status: ok ? "submitted" : "failed",
    ok,
    message,
    planKey
  }));
  const detail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? "ok" : "failed",
    ok,
    message,
    reason: ok ? "" : "stale-goods-execute-request-failed",
    category: ok ? "" : "api",
    diagnostic: {
      planKey,
      productCount: productIds.length,
      response: summarizeRequestPlanResponse(response, adapter, planKey)
    },
    index,
    total
  };

  if (onProgress) {
    onProgress({
      phase: "staleGoodsCleanup",
      shopId: store.shopId,
      shopName: store.shopName,
      status: ok ? store.status : "check_failed",
      ok,
      message,
      index,
      total
    });
  }

  return { executions, detail };
}

async function collectFundsDataForStore({ store, index, total, planKeys, args, operation, adapter, onProgress }) {
  throwIfCancelled(operation);
  if (!store?.partition) {
    const error = new Error("store partition missing");
    error.code = "DOUDIAN_STORE_PARTITION_MISSING";
    throw error;
  }

  if (onProgress) {
    onProgress({
      phase: "fundsData",
      shopId: store.shopId,
      shopName: store.shopName,
      status: "unknown",
      ok: true,
      message: policyMessage(adapter, "fundsData.messages.syncing", "Syncing funds data"),
      index,
      total
    });
  }

  const responses = {};
  const requestContext = {
    ...fundsDateContext(args, adapter),
    shopId: store.shopId,
    shopName: store.shopName
  };
  for (const planKey of planKeys) {
    throwIfCancelled(operation);
    responses[planKey] = await doudianRequestByPlan(store.partition, planKey, operation, null, adapter, requestContext);
  }

  const { row, metricSources } = buildFundsDataResult(store, responses, requestContext, adapter);
  const responseSummary = summarizeFundsResponses(responses, adapter);
  const sourceFailures = summarizeFundsSourceFailures(responseSummary, adapter);
  const blockingSourceFailures = sourceFailures.filter((failure) => !failure.optional);
  const rowSummary = fundsRowSummary(row);
  const requiredPlans = policyArray(adapter, "fundsData.requiredPlans", []).map((item) => String(item)).filter(Boolean);
  const criticalPlans = policyArray(adapter, "fundsData.criticalPlans", []).map((item) => String(item)).filter(Boolean);
  const successPlanKeys = Object.entries(responses)
    .filter(([key, response]) => isFundsResponseOk(response, adapter, key))
    .map(([key]) => key);
  const countedSuccessPlanKeys = Object.entries(responses)
    .filter(([key, response]) => fundsPlanCountsAsSuccess(adapter, key) && isFundsResponseOk(response, adapter, key))
    .map(([key]) => key);
  const okCount = countedSuccessPlanKeys.length;
  const missingRequiredPlans = requiredPlans.filter((planKey) => !isFundsResponseOk(responses[planKey], adapter, planKey));
  const missingCriticalPlans = criticalPlans.filter((planKey) => !isFundsResponseOk(responses[planKey], adapter, planKey));
  const ok = criticalPlans.length
    ? missingCriticalPlans.length === 0
    : requiredPlans.length
      ? missingRequiredPlans.length === 0
      : okCount > 0;
  const partial = ok && (blockingSourceFailures.length > 0 || rowSummary.allZero);
  const message = !ok
    ? (firstFundsErrorMessage(responses, adapter) || policyMessage(adapter, "fundsData.messages.failed", "Funds data request failed"))
    : blockingSourceFailures.length
      ? policyMessage(adapter, "fundsData.messages.partialSourceStore", "Funds data synced with partial source errors")
      : rowSummary.allZero
        ? policyMessage(adapter, "fundsData.messages.noMetricMatchStore", "Funds data synced but no metric fields matched")
        : policyMessage(adapter, "fundsData.messages.synced", "Funds data synced");
  const detail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (partial ? "partial" : "ok") : "failed",
    ok,
    message,
    reason: ok ? (blockingSourceFailures.length ? "funds-data-partial-source-failure" : rowSummary.allZero ? "funds-data-no-metric-match" : "") : "funds-data-request-failed",
    category: ok ? (partial ? "api-partial" : "") : "api",
    diagnostic: {
      responses: responseSummary,
      okCount,
      successPlanKeys,
      countedSuccessPlanKeys,
      requiredPlans,
      missingRequiredPlans,
      criticalPlans,
      missingCriticalPlans,
      sourceFailureCount: sourceFailures.length,
      blockingSourceFailureCount: blockingSourceFailures.length,
      sourceFailures,
      rowSummary,
      metricSources,
      datePreset: requestContext.datePreset,
      beginDate: requestContext.beginDate,
      endDate: requestContext.endDate
    },
    index,
    total
  };

  if (onProgress) {
    onProgress({
      phase: "fundsData",
      shopId: store.shopId,
      shopName: store.shopName,
      status: ok ? store.status : "check_failed",
      ok,
      message,
      index,
      total
    });
  }

  return { row, detail };
}

async function collectBusinessDataForStore({ store, index, total, planKeys, args, operation, adapter, onProgress }) {
  throwIfCancelled(operation);
  if (!store?.partition) {
    const error = new Error("store partition missing");
    error.code = "DOUDIAN_STORE_PARTITION_MISSING";
    throw error;
  }

  if (onProgress) {
    onProgress({
      phase: "businessData",
      shopId: store.shopId,
      shopName: store.shopName,
      status: "unknown",
      ok: true,
      message: policyMessage(adapter, "businessData.messages.syncing", "Syncing business data"),
      index,
      total
    });
  }

  const responses = {};
  const requestContext = {
    ...businessDateContext(args, adapter),
    shopId: store.shopId,
    shopName: store.shopName
  };
  for (const planKey of planKeys) {
    throwIfCancelled(operation);
    responses[planKey] = await doudianRequestByPlan(store.partition, planKey, operation, null, adapter, requestContext);
  }

  const { row, metricSources } = buildBusinessDataResult(store, responses, requestContext, adapter);
  const responseSummary = summarizeBusinessResponses(responses, adapter);
  const sourceFailures = summarizeBusinessSourceFailures(responseSummary, adapter);
  const blockingSourceFailures = sourceFailures.filter((failure) => !failure.optional);
  const rowSummary = businessRowSummary(row);
  const requiredPlans = policyArray(adapter, "businessData.requiredPlans", []).map((item) => String(item)).filter(Boolean);
  const okCount = Object.entries(responses).filter(([key, response]) => isBusinessResponseOk(response, adapter, key)).length;
  const missingRequiredPlans = requiredPlans.filter((planKey) => !isBusinessResponseOk(responses[planKey], adapter, planKey));
  const ok = requiredPlans.length ? missingRequiredPlans.length === 0 : okCount > 0;
  const partial = ok && (blockingSourceFailures.length > 0 || rowSummary.allZero);
  const message = !ok
    ? (firstBusinessErrorMessage(responses, adapter) || policyMessage(adapter, "businessData.messages.failed", "Business data request failed"))
    : blockingSourceFailures.length
      ? policyMessage(adapter, "businessData.messages.partialSourceStore", "Business data synced with partial source errors")
      : rowSummary.allZero
        ? policyMessage(adapter, "businessData.messages.noMetricMatchStore", "Business data synced but no metric fields matched")
        : policyMessage(adapter, "businessData.messages.synced", "Business data synced");
  const detail = {
    shopId: store.shopId,
    shopName: store.shopName,
    status: ok ? (partial ? "partial" : "ok") : "failed",
    ok,
    message,
    reason: ok ? (blockingSourceFailures.length ? "business-data-partial-source-failure" : rowSummary.allZero ? "business-data-no-metric-match" : "") : "business-data-request-failed",
    category: ok ? (partial ? "api-partial" : "") : "api",
    diagnostic: {
      responses: responseSummary,
      okCount,
      requiredPlans,
      missingRequiredPlans,
      sourceFailureCount: sourceFailures.length,
      blockingSourceFailureCount: blockingSourceFailures.length,
      sourceFailures,
      rowSummary,
      metricSources,
      datePreset: requestContext.datePreset,
      beginDate: requestContext.beginDate,
      endDate: requestContext.endDate
    },
    index,
    total
  };

  if (onProgress) {
    onProgress({
      phase: "businessData",
      shopId: store.shopId,
      shopName: store.shopName,
      status: ok ? store.status : "check_failed",
      ok,
      message,
      index,
      total
    });
  }

  return { row, detail };
}

async function buildImportedDoudianStoreRecords(
  detected,
  sourcePartition,
  onProgress = null,
  operation = null,
  adapter = adapterFor(operation),
  options = {}
) {
  const onImportedRecord = typeof options.onImportedRecord === "function" ? options.onImportedRecord : null;
  const onImportFailure = typeof options.onImportFailure === "function" ? options.onImportFailure : null;
  const shops = detected.roleOnlyShops?.length
    ? detected.roleOnlyShops
    : uniqueShops(detected.shopList?.length ? detected.shopList : [detected.currentShop]);
  const imported = [];
  const failed = [];

  for (const [index, shop] of shops.entries()) {
    const result = await importOneStore({
      shop,
      index: index + 1,
      total: shops.length,
      sourcePartition,
      operation,
      adapter,
      onProgress,
      freshShopPartition,
      copyCookies,
      activateDoudianStorePartition,
      buildStoreFailure,
      buildStoreRecord,
      safeError,
      throwIfCancelled,
      logStoreEvent
    });
    if (result.imported) {
      imported.push(result.imported);
      if (onImportedRecord) {
        await onImportedRecord(result.imported, {
          index: index + 1,
          total: shops.length,
          imported: imported.length,
          failed: failed.length
        });
      }
    }
    if (result.failed) {
      failed.push(result.failed);
      if (onImportFailure) {
        await onImportFailure(result.failed, {
          index: index + 1,
          total: shops.length,
          imported: imported.length,
          failed: failed.length
        });
      }
    }
  }

  return { imported, failed };
}

async function probeWindow(win, adapter = DOUDIAN_ADAPTER) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return { ok: false, error: "window destroyed" };
  }
  try {
    const remoteProbeScript = remoteFactoryCall(requireRemoteScript(adapter, "probeFactory"), { adapter });
    return await executeRemotePageScript(
      win,
      remoteProbeScript,
      "doudian probe",
      adapterTimeout(adapter, "probeMs"),
      { script: "probeFactory" }
    );
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      href: win.webContents.getURL(),
      title: win.getTitle()
    };
  }
}

async function probePartition(partition, operation = null, adapter = adapterFor(operation)) {
  throwIfCancelled(operation);
  const win = createBrowserWindow({
    partition,
    show: false,
    title: "赤狐管家 - 抖店状态探测",
    adapter
  });

  trackOperationWindow(operation, win);

  try {
    throwIfCancelled(operation);
    await loadUrl(win, adapter.homeUrl, adapterTimeout(adapter, "loadMs"));
    throwIfCancelled(operation);
    return await probeWindow(win, adapter);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function waitForLoginWindow(win, timeoutMs, partition, operation = null, adapter = adapterFor(operation)) {
  const deadline = Date.now() + timeoutMs;
  let lastInfo = null;
  let lastDetected = null;

  while (Date.now() < deadline) {
    throwIfCancelled(operation);
    if (!win || win.isDestroyed()) {
      return {
        cancelled: true,
        lastShopUserInfo: lastInfo,
        detected: lastDetected
      };
    }

    lastInfo = await getShopUserInfo(partition, operation, win, adapter);
    const detected = detectedFromShopUserInfo(lastInfo, adapter);
    lastDetected = detected;
    if (lastInfo?.isLogin && detected.currentShop && detected.shopList.length > 0) {
      return {
        cancelled: false,
        shopUserInfo: lastInfo,
        detected
      };
    }

    await delayWithCancel(1000, operation);
  }

  return {
    cancelled: false,
    timedOut: true,
    lastShopUserInfo: lastInfo,
    detected: lastDetected
  };
}

function createDoudianStoreService() {
  async function listStores(args = {}) {
    if (args.doudianAdapter || args.adapter) resolveTaskAdapter(args);
    try {
      return {
        ok: true,
        ...storeLedgerSnapshot()
      };
    } catch (error) {
      logStoreEvent("stores.list.failed", {
        code: error?.code || "",
        message: safeError(error)
      });
      return {
        ok: false,
        status: "local-db-unavailable",
        message: "本地店铺数据库暂时不可用，请稍后重试或重启赤狐管家。",
        stores: [],
        groups: [],
        diagnostic: {
          code: error?.code || "",
          message: safeError(error)
        }
      };
    }
  }

  function filterDetectedShopsForRepair(detected, repairShopIds) {
    if (!repairShopIds?.size) return detected;
    const filterShop = (shop) => shop && repairShopIds.has(String(shop.shopId || ""));
    const filterByName = (shop) => {
      if (!shop) return false;
      if (repairShopIds.has(String(shop.shopId || ""))) return true;
      const existing = repository.listStores().find((store) => repairShopIds.has(String(store.shopId)) && store.shopName === shop.shopName);
      return !!existing;
    };
    const roleOnlyShops = (detected.roleOnlyShops || []).filter(filterByName);
    const shopList = (detected.shopList || []).filter(filterShop);
    return {
      ...detected,
      currentShop: roleOnlyShops[0] || shopList[0] || null,
      currentShopId: roleOnlyShops[0]?.shopId || shopList[0]?.shopId || "",
      roleOnlyShops,
      shopList
    };
  }

  async function fetchStores(args = {}, onProgress = null, operation = null) {
    assertRemoteAdapterInput(args, "fetchStores");
    const adapter = resolveTaskAdapter(args, operation);
    requireOperationActions(adapter, "fetchStores", [
      "loginAndDetectStores",
      "importStores",
      "recordStoreAttempts",
      "upsertStores"
    ], FETCH_STORES_FALLBACK_ACTIONS);
    requireOperationActions(adapter, "importStore", [
      "copyCookies",
      "activateStore",
      "buildStoreRecord"
    ]);
    throwIfCancelled(operation);
    const fetchMode = policyText(adapter, "fetchStores.mode", "doudian-login-new-shops");
    const timeoutMs = Number(args.timeoutMs || adapterTimeout(adapter, "loginMs"));
    const sourcePartition = doudianShopPartition(Date.now(), adapter);
    const repairShopIds = new Set((args.repairShopIds || []).map((id) => String(id)));
    const run = createStoreRun("fetch", adapter, operation, {
      sourcePartition,
      timeoutMs,
      repairShopIds: Array.from(repairShopIds),
      adapterInput: adapterInputSummary(operation),
      mode: fetchMode
    });

    logStoreEvent("fetch.start", {
      runId: run.runId,
      sourcePartition,
      timeoutMs,
      repairCount: repairShopIds.size,
      adapterVersion: adapter.version,
      adapterSource: adapter.source || "",
      adapterScriptsVersion: adapter.scripts?.version || "",
      adapterInput: adapterInputSummary(operation),
      mode: fetchMode
    });
    let detected = null;
    let shopUserInfo = null;
    let roleNames = [];
    let openedLoginWindow = true;
    if (onProgress) {
      onProgress({
        phase: "fetch",
        ok: true,
        message: policyMessage(adapter, "fetchStores.progressMessages.openingLogin", "正在打开抖店登录窗口")
      });
    }

    let importedRecords = [];
    let importFailures = [];
    const fetchContext = {
      run,
      sourcePartition,
      timeoutMs,
      repairShopIds,
      detected: null,
      shopUserInfo: null,
      roleNames: [],
      importedRecords,
      importFailures,
      finalResult: null,
      stop: false,
      progressDone: false
    };
    try {
      await runActionList(adapter, "fetchStores", fetchContext, {
        emitProgress: async (_action, context) => {
          if (!onProgress) return { ok: true };
          if (!context.detected) {
            onProgress({
              phase: "fetch",
              ok: true,
              message: policyMessage(adapter, "fetchStores.progressMessages.openingLogin", "正在打开抖店登录窗口")
            });
            return { phase: "start" };
          }
          if (context.progressDone) return { ok: true, skipped: true };
          context.progressDone = true;
          for (const record of context.importedRecords) {
            onProgress({
              phase: "fetch",
              shopId: record.shopId,
              shopName: record.shopName,
              status: record.status,
              ok: record.status === "online",
              message: record.status === "online"
                ? policyMessage(adapter, "fetchStores.progressMessages.importedOnline", "已导入并确认当前登录态")
                : policyMessage(adapter, "fetchStores.progressMessages.importedPending", "已导入，待逐店切换确认登录态")
            });
          }
          for (const failure of context.importFailures) {
            onProgress({
              phase: "fetch",
              shopId: failure.shopId,
              shopName: failure.shopName,
              status: "offline",
              ok: false,
              message: failure.message
            });
          }
          return {
            imported: context.importedRecords.length,
            failed: context.importFailures.length
          };
        },
        loginAndDetectStores: async (_action, context) => {
          openedLoginWindow = true;
          logStoreEvent("fetch.loginWindow.open", {
            sourcePartition,
            timeoutMs
          });
          const loginContext = {
            partition: sourcePartition,
            show: true,
            title: "赤狐管家 - 登录抖店",
            url: adapter.loginUrl,
            timeoutMs,
            loadTimeoutMs: adapterTimeout(adapter, "signerLoadMs"),
            operation,
            win: null,
            loadResult: null
          };
          await runActionList(adapter, "fetchLogin", loginContext, {
            openWindow: async (_nextAction, next) => {
              next.win = createBrowserWindow({
                partition: next.partition,
                show: next.show,
                title: next.title,
                adapter
              });
              trackOperationWindow(operation, next.win);
              if (process.env.CHIHU_DOUDIAN_DEVTOOLS === "1") next.win.webContents.openDevTools();
              return { winId: next.win.id };
            },
            loadUrl: async (_nextAction, next) => {
              if (!next.win) throw new Error("fetchStores loadUrl requires openWindow action");
              next.loadResult = await loadUrl(next.win, next.url, next.loadTimeoutMs);
              return next.loadResult;
            },
            waitForRoleWindow: async (_nextAction, next) => {
              if (!next.win) throw new Error("fetchStores waitForRoleWindow requires openWindow action");
              next.roleResult = await waitForDoudianRoleWindow(next.win, next.timeoutMs, operation, adapter);
              return {
                cancelled: !!next.roleResult.cancelled,
                timedOut: !!next.roleResult.timedOut,
                roleCount: next.roleResult.newShopNameList?.length || 0,
                isHomePage: !!next.roleResult.isHomePage
              };
            }
          }, [
            { action: "openWindow" },
            { action: "loadUrl" },
            { action: "waitForRoleWindow" }
          ]);
          const win = loginContext.win;
          const roleResult = loginContext.roleResult;
          logStoreEvent("fetch.loginWindow.loaded", {
            sourcePartition,
            loadResult: loginContext.loadResult
          });

          if (roleResult.cancelled) {
            if (win && !win.isDestroyed()) win.close();
            logStoreEvent("fetch.cancelled", {
              runId: run.runId,
              roleNames: roleResult.newShopNameList || []
            });
            finishStoreRun(run, {
              status: "cancelled",
              cancelled: true,
              message: policyMessage(adapter, "fetchStores.resultMessages.cancelled", "登录窗口已关闭，未获取到店铺。"),
              detail: {
                roleNames: roleResult.newShopNameList || []
              }
            });
            context.finalResult = {
              ok: false,
              status: "cancelled",
              message: policyMessage(adapter, "fetchStores.resultMessages.cancelled", "登录窗口已关闭，未获取到店铺。"),
              runId: run.runId,
              operationId: operationId(operation),
              roleNames: roleResult.newShopNameList || []
            };
            context.stop = true;
            return { stop: true, status: "cancelled" };
          }
          if (roleResult.timedOut) {
            if (win && !win.isDestroyed()) win.close();
            logStoreEvent("fetch.timeout", {
              runId: run.runId,
              roleNames: roleResult.newShopNameList || []
            });
            finishStoreRun(run, {
              status: "failed",
              failureCount: 1,
              message: policyMessage(adapter, "fetchStores.resultMessages.timeout", "登录等待超时，未获取到店铺。"),
              detail: {
                roleNames: roleResult.newShopNameList || []
              }
            });
            context.finalResult = {
              ok: false,
              status: "timeout",
              message: policyMessage(adapter, "fetchStores.resultMessages.timeout", "登录等待超时，未获取到店铺。"),
              runId: run.runId,
              operationId: operationId(operation),
              roleNames: roleResult.newShopNameList || []
            };
            context.stop = true;
            return { stop: true, status: "timeout" };
          }

          roleNames = roleResult.newShopNameList || [];
          context.roleNames = roleNames;
          logStoreEvent("fetch.roleList", {
            sourcePartition,
            roleNames,
            isHomePage: !!roleResult.isHomePage
          });
          if (roleResult.isHomePage) {
            shopUserInfo = await getShopUserInfo(sourcePartition, operation, win, adapter);
            detected = detectedFromShopUserInfo(shopUserInfo, adapter);
          } else {
            const allStores = repository.listStores();
            const repairStores = repairShopIds.size ? allStores.filter((store) => repairShopIds.has(String(store.shopId))) : [];
            const listForMatching = repairStores.map((store) => ({
              shopId: store.shopId,
              shopName: store.shopName,
              operateStatus: store.operateStatus || "",
              rawSummary: store.shopInfoSummary || { id: store.shopId, shop_name: store.shopName }
            }));
            const matched = shopsFromRoleNames(roleNames, listForMatching);
            detected = {
              currentShop: matched.roleOnlyShops[0] || null,
              currentShopId: matched.roleOnlyShops[0]?.shopId || "",
              shopList: matched.shops,
              roleOnlyShops: matched.roleOnlyShops,
              detectionSource: "doudian-role-list",
              roleNames,
              missingRoleNames: matched.missing,
              shopUserInfo: null
            };
          }
          detected = filterDetectedShopsForRepair(detected, repairShopIds);
          context.detected = detected;
          context.shopUserInfo = shopUserInfo;
          if (win && !win.isDestroyed()) win.close();

          if (!detected.currentShop) {
            logStoreEvent("fetch.notDetected", {
              runId: run.runId,
              shopUserInfo: summarizeShopUserInfo(shopUserInfo),
              roleNames
            });
            finishStoreRun(run, {
              status: "failed",
              failureCount: 1,
              message: policyMessage(adapter, "fetchStores.resultMessages.notDetected", "已连接抖店页面，但没有识别到当前店铺。"),
              detail: {
                shopUserInfo: summarizeShopUserInfo(shopUserInfo),
                roleNames
              }
            });
            context.finalResult = {
              ok: false,
              status: "not-detected",
              message: policyMessage(adapter, "fetchStores.resultMessages.notDetected", "已连接抖店页面，但没有识别到当前店铺。"),
              runId: run.runId,
              operationId: operationId(operation),
              shopUserInfo: summarizeShopUserInfo(shopUserInfo),
              roleNames
            };
            context.stop = true;
            return { stop: true, status: "not-detected" };
          }
          return {
            detectionSource: detected.detectionSource || "",
            roleCount: roleNames.length
          };
        },
        importStores: async (_action, context) => {
          const importResult = await buildImportedDoudianStoreRecords(context.detected, sourcePartition, onProgress, operation, adapter, {
            onImportedRecord: async (record) => {
              repository.upsertStores([record]);
              importedRecords = [
                ...importedRecords.filter((item) => String(item.shopId) !== String(record.shopId)),
                record
              ];
              context.importedRecords = importedRecords;
            },
            onImportFailure: async (failure) => {
              importFailures = [...importFailures, failure];
              context.importFailures = importFailures;
            }
          });
          context.importedRecords = importResult.imported;
          context.importFailures = importResult.failed;
          importedRecords = context.importedRecords;
          importFailures = context.importFailures;
          if (!importedRecords.length && importFailures.length) {
            throw new Error(importFailures[0].message || "店铺导入失败");
          }
          return {
            imported: importedRecords.length,
            failed: importFailures.length
          };
        },
        recordStoreAttempts: async (_action, context) => {
          recordStoreAttempts(run, "fetch", context.importedRecords.map((store, index) => ({
            shopId: store.shopId,
            shopName: store.shopName,
            status: store.status,
            ok: store.status === "online",
            message: store.status === "online"
              ? policyMessage(adapter, "fetchStores.progressMessages.importedOnline", "已导入并确认当前登录态")
              : policyMessage(adapter, "fetchStores.progressMessages.importedPending", "已导入，待逐店切换确认登录态"),
            index: index + 1,
            total: context.importedRecords.length + context.importFailures.length
          })), adapter);
          recordStoreAttempts(run, "fetch", context.importFailures, adapter);
          return {
            imported: context.importedRecords.length,
            failed: context.importFailures.length
          };
        },
        upsertStores: async (_action, context) => {
          repository.upsertStores(context.importedRecords);
          return { count: context.importedRecords.length };
        }
      }, FETCH_STORES_FALLBACK_ACTIONS);
      if (fetchContext.finalResult) return fetchContext.finalResult;
    } catch (error) {
      if (isCancelError(error)) {
        logStoreEvent("fetch.cancelled", {
          runId: run.runId,
          imported: importedRecords.length,
          failed: importFailures.length
        });
        finishStoreRun(run, {
          status: "cancelled",
          storeCount: importedRecords.length + importFailures.length,
          successCount: importedRecords.length,
          failureCount: importFailures.length,
          cancelled: true,
          message: policyMessage(adapter, "fetchStores.resultMessages.cancelledByUser", "已取消获取店铺"),
          detail: {
            imported: importedRecords.length,
            failed: importFailures.length
          }
        });
        return {
          ok: false,
          status: "cancelled",
          message: policyMessage(adapter, "fetchStores.resultMessages.cancelledByUser", "已取消获取店铺"),
          runId: run.runId,
          operationId: operationId(operation),
          imported: importedRecords.length,
          failed: importFailures.length,
          ...storeLedgerSnapshot(),
          details: {
            imported: importedRecords,
            failed: importFailures
          }
        };
      }
      logStoreEvent("fetch.importError", {
        runId: run.runId,
        error: safeError(error),
        shopUserInfo: summarizeShopUserInfo(shopUserInfo)
      });
      finishStoreRun(run, {
        status: "failed",
        storeCount: importedRecords.length + importFailures.length,
        successCount: importedRecords.length,
        failureCount: Math.max(1, importFailures.length),
        message: safeError(error),
        detail: {
          imported: importedRecords.length,
          failed: importFailures.length,
          shopUserInfo: summarizeShopUserInfo(shopUserInfo)
        }
      });
      throw error;
    }
    const snapshot = storeLedgerSnapshot();
    const currentStore = snapshot.stores.find((item) => String(item.shopId) === String(detected.currentShop.shopId)) || snapshot.stores[0] || null;
    const availableCount = detected.roleOnlyShops?.length || detected.shopList.length || importedRecords.length;
    logStoreEvent("fetch.imported", {
      runId: run.runId,
      imported: importedRecords.length,
      failed: importFailures.length,
      openedLoginWindow,
      availableCount,
      detectionSource: detected.detectionSource || "",
      shopUserInfo: summarizeShopUserInfo(shopUserInfo)
    });
    const messageData = {
      count: importedRecords.length,
      actionLabel: repairShopIds.size
        ? policyText(adapter, "fetchStores.labels.repairComplete", "修复完成")
        : policyText(adapter, "fetchStores.labels.loginSuccess", "登录成功"),
      verb: repairShopIds.size
        ? policyText(adapter, "fetchStores.labels.repairVerb", "修复")
        : policyText(adapter, "fetchStores.labels.importVerb", "导入")
    };
    const message = openedLoginWindow
      ? policyMessage(adapter, "fetchStores.resultMessages.imported", "{actionLabel}，已{verb} {count} 家店铺。", messageData)
      : policyMessage(adapter, "fetchStores.resultMessages.reusedSession", "已使用本机登录态同步 {count} 家店铺。", messageData);
    finishStoreRun(run, {
      status: importFailures.length ? "partial" : "ok",
      storeCount: importedRecords.length + importFailures.length,
      successCount: importedRecords.length,
      failureCount: importFailures.length,
      message,
      detail: {
        availableCount,
        detectionSource: detected.detectionSource || "",
        roleNames,
        missingRoleNames: detected.missingRoleNames || []
      }
    });
    return {
      ok: true,
      status: "imported",
      message,
      runId: run.runId,
      operationId: operationId(operation),
      imported: importedRecords.length,
      failed: importFailures.length,
      stores: snapshot.stores,
      groups: snapshot.groups,
      currentStore,
      availableCount,
      multiStorePending: false,
      details: {
      imported: importedRecords.map((store) => ({
          shopId: store.shopId,
          shopName: store.shopName,
          status: store.status,
          message: store.status === "online"
            ? policyMessage(adapter, "fetchStores.progressMessages.importedOnline", "已导入并确认当前登录态")
            : policyMessage(adapter, "fetchStores.progressMessages.importedPending", "已导入，待逐店切换确认登录态")
        })),
        failed: importFailures,
        roleNames,
        missingRoleNames: detected.missingRoleNames || []
      },
      shopUserInfo: summarizeShopUserInfo(shopUserInfo)
    };
  }

  async function fetchBusinessData(args = {}, onProgress = null, operation = null) {
    assertRemoteAdapterInput(args, "fetchBusinessData");
    const adapter = resolveTaskAdapter(args, operation);
    requireOperationActions(adapter, "fetchBusinessData", [
      "collectBusinessData",
      "recordStoreAttempts"
    ], FETCH_BUSINESS_DATA_FALLBACK_ACTIONS);
    throwIfCancelled(operation);

    const requestedIds = new Set((args.shopIds || []).map((id) => String(id)));
    const allStores = repository.listStores();
    const targets = requestedIds.size ? allStores.filter((store) => requestedIds.has(String(store.shopId))) : allStores;
    const defaultConcurrency = policyNumber(adapter, "businessData.concurrency", 3, { min: 1, max: 8 });
    const concurrency = Math.max(1, Math.min(8, Math.floor(Number(args.concurrency || defaultConcurrency))));
    const dateContext = businessDateContext(args, adapter);
    const rows = [];
    const details = [];
    const run = createStoreRun("businessData", adapter, operation, {
      requestedShopIds: Array.from(requestedIds),
      targetCount: targets.length,
      concurrency,
      dateContext,
      adapterInput: adapterInputSummary(operation)
    });

    logStoreEvent("businessData.start", {
      runId: run.runId,
      requestedCount: requestedIds.size,
      targetCount: targets.length,
      concurrency,
      dateContext,
      adapterVersion: adapter.version,
      adapterSource: adapter.source || "",
      adapterScriptsVersion: adapter.scripts?.version || "",
      adapterInput: adapterInputSummary(operation)
    });

    try {
      const context = {
        targets,
        rows,
        details,
        run,
        operation,
        adapter,
        args,
        requestPlanKeys: []
      };
      await runActionList(adapter, "fetchBusinessData", context, {
        collectBusinessData: async (action, next) => {
          const actionPlans = Array.isArray(action.requestPlans)
            ? action.requestPlans
            : action.requestPlan
              ? [action.requestPlan]
              : [];
          const policyPlans = policyArray(adapter, "businessData.requestPlans", []);
          const normalizedActionPlans = actionPlans.map((item) => String(item)).filter(Boolean);
          const normalizedPolicyPlans = policyPlans.map((item) => String(item)).filter(Boolean);
          if (normalizedActionPlans.length && normalizedPolicyPlans.length) {
            const actionSet = new Set(normalizedActionPlans);
            const policySet = new Set(normalizedPolicyPlans);
            const drift = actionSet.size !== policySet.size || normalizedActionPlans.some((item) => !policySet.has(item));
            if (drift) {
              const error = new Error("remote fetchBusinessData operation request plans drift from policy request plans");
              error.code = "DOUDIAN_BUSINESS_DATA_REQUEST_PLANS_DRIFT";
              throw error;
            }
          }
          const requestPlanKeys = Array.from(new Set((normalizedPolicyPlans.length ? normalizedPolicyPlans : normalizedActionPlans)));
          if (!requestPlanKeys.length) {
            const error = new Error("remote fetchBusinessData operation missing request plans");
            error.code = "DOUDIAN_BUSINESS_DATA_REQUEST_PLANS_MISSING";
            throw error;
          }
          next.requestPlanKeys = requestPlanKeys;
          const settled = await settleWithConcurrency(targets, concurrency, async (store, index) => {
            return collectBusinessDataForStore({
              store,
              index: index + 1,
              total: targets.length,
              planKeys: requestPlanKeys,
              args,
              operation,
              adapter,
              onProgress
            });
          });

          for (const [index, result] of settled.entries()) {
            if (result.status === "rejected") {
              if (isCancelError(result.reason)) throw result.reason;
              const store = targets[index];
              const failure = buildStoreFailure(store, result.reason, {
                reason: "business-data-request-failed",
                index: index + 1,
                total: targets.length
              }, adapter);
              const detail = {
                ...failure,
                status: "failed",
                ok: false
              };
              next.details.push(detail);
              next.rows.push(emptyBusinessDataRow(store));
              if (onProgress) {
                onProgress({
                  phase: "businessData",
                  shopId: store.shopId,
                  shopName: store.shopName,
                  status: "check_failed",
                  ok: false,
                  message: detail.message,
                  reason: detail.reason,
                  category: detail.category,
                  index: index + 1,
                  total: targets.length
                });
              }
              continue;
            }
            if (result.value?.row) next.rows.push(result.value.row);
            if (result.value?.detail) next.details.push(result.value.detail);
          }
          return {
            rows: next.rows.length,
            details: next.details.length,
            requestPlanKeys
          };
        },
        recordStoreAttempts: async (_action, next) => {
          recordStoreAttempts(run, "businessData", next.details, adapter);
          return { count: next.details.length };
        }
      }, FETCH_BUSINESS_DATA_FALLBACK_ACTIONS);
    } catch (error) {
      if (!isCancelError(error)) {
        finishStoreRun(run, {
          status: "failed",
          storeCount: targets.length,
          successCount: details.filter((detail) => detail.ok).length,
          failureCount: Math.max(1, details.filter((detail) => !detail.ok).length || targets.length || 1),
          message: safeError(error),
          detail: {
            details,
            dateContext
          }
        });
        throw error;
      }
      recordStoreAttempts(run, "businessData", details, adapter);
      finishStoreRun(run, {
        status: "cancelled",
        storeCount: targets.length,
        successCount: details.filter((detail) => detail.ok).length,
        failureCount: details.filter((detail) => !detail.ok).length,
        cancelled: true,
        message: policyMessage(adapter, "businessData.messages.cancelled", "Business data sync cancelled"),
        detail: {
          details,
          dateContext
        }
      });
      return {
        ok: false,
        status: "cancelled",
        message: policyMessage(adapter, "businessData.messages.cancelled", "Business data sync cancelled"),
        runId: run.runId,
        operationId: operationId(operation),
        rows,
        details,
        dateRange: dateContext,
        ...storeLedgerSnapshot()
      };
    }

    const successCount = details.filter((detail) => detail.ok).length;
    const failureCount = details.filter((detail) => !detail.ok).length;
    const partialSourceCount = details.filter((detail) => {
      const diagnostic = detail?.diagnostic || {};
      return Number(diagnostic.blockingSourceFailureCount ?? diagnostic.sourceFailureCount ?? 0) > 0;
    }).length;
    const noMetricMatchCount = details.filter((detail) => detail?.diagnostic?.rowSummary?.allZero === true).length;
    const partialIssueCount = partialSourceCount + noMetricMatchCount;
    const message = failureCount
      ? policyMessage(adapter, "businessData.messages.partial", "Business data synced with {failureCount} failures", { successCount, failureCount })
      : partialIssueCount
        ? policyMessage(adapter, "businessData.messages.partialSources", "Business data synced; {partialSourceCount} stores have source issues, {noMetricMatchCount} stores have no metric match", {
          successCount,
          partialSourceCount,
          noMetricMatchCount
        })
        : policyMessage(adapter, "businessData.messages.done", "Business data synced for {successCount} stores", { successCount });
    repository.saveBusinessDataRows({
      rows,
      details,
      dateRange: dateContext,
      runId: run.runId,
      adapterVersion: adapter.version || "",
      scriptsVersion: adapter.scripts?.version || ""
    });
    finishStoreRun(run, {
      status: failureCount || partialIssueCount ? "partial" : "ok",
      storeCount: targets.length,
      successCount,
      failureCount,
      message,
      detail: {
        details,
        dateContext,
        partialSourceCount,
        noMetricMatchCount
      }
    });
    logStoreEvent("businessData.done", {
      runId: run.runId,
      rows: rows.length,
      successCount,
      failureCount,
      partialSourceCount,
      noMetricMatchCount
    });

    return {
      ok: failureCount === 0,
      status: failureCount || partialIssueCount ? "partial" : "ok",
      message,
      runId: run.runId,
      operationId: operationId(operation),
      rows,
      details,
      successCount,
      failureCount,
      partialSourceCount,
      noMetricMatchCount,
      dateRange: dateContext,
      ...storeLedgerSnapshot()
    };
  }

  async function latestBusinessData(args = {}) {
    const adapter = resolveTaskAdapter(args, null);
    const dateContext = businessDateContext(args, adapter);
    const rows = repository.listBusinessDataRows({
      shopIds: args.shopIds || [],
      datePreset: args.datePreset || dateContext.datePreset,
      beginDate: args.beginDate || dateContext.beginDate,
      endDate: args.endDate || dateContext.endDate
    });
    const businessRows = rows.map((item) => item.row || {});
    const details = rows.map((item, index) => ({
      shopId: item.shopId,
      shopName: item.shopName,
      status: item.ok ? "ok" : "failed",
      ok: item.ok,
      message: item.message,
      reason: item.ok ? "" : "business-data-cached-failure",
      category: item.ok ? "" : "api",
      diagnostic: item.diagnostic,
      index: index + 1,
      total: rows.length
    }));
    return {
      ok: true,
      status: rows.length ? "ready" : "empty",
      message: rows.length ? `已读取 ${rows.length} 条最近经营数据` : "暂无最近经营数据",
      rows: businessRows,
      details,
      dateRange: {
        datePreset: args.datePreset || dateContext.datePreset,
        beginDate: args.beginDate || dateContext.beginDate,
        endDate: args.endDate || dateContext.endDate
      },
      adapterVersion: adapter.version || "",
      scriptsVersion: adapter.scripts?.version || "",
      cached: true,
      cachedRows: rows
    };
  }

  async function staleGoodsCleanup(args = {}, onProgress = null, operation = null) {
    assertRemoteAdapterInput(args, "staleGoodsCleanup");
    const adapter = resolveTaskAdapter(args, operation);
    const mode = String(args.mode || "scan") === "execute" ? "execute" : "scan";
    const operationPlanKey = mode === "execute" ? "executeStaleGoodsCleanup" : "scanStaleGoodsCleanup";
    const fallbackActions = mode === "execute" ? EXECUTE_STALE_GOODS_FALLBACK_ACTIONS : SCAN_STALE_GOODS_FALLBACK_ACTIONS;
    requireOperationActions(adapter, operationPlanKey, [
      mode === "execute" ? "executeStaleGoodsCleanup" : "collectStaleGoodsCandidates",
      "recordStoreAttempts"
    ], fallbackActions);
    throwIfCancelled(operation);

    const requestedIds = new Set((args.shopIds || []).map((id) => String(id)));
    const allStores = repository.listStores();
    const targets = requestedIds.size ? allStores.filter((store) => requestedIds.has(String(store.shopId))) : allStores;
    const defaultConcurrency = policyNumber(adapter, "staleGoodsCleanup.concurrency", mode === "execute" ? 1 : 2, { min: 1, max: mode === "execute" ? 2 : 6 });
    const concurrency = Math.max(1, Math.min(mode === "execute" ? 2 : 6, Math.floor(Number(args.concurrency || defaultConcurrency))));
    const rules = normalizeStaleGoodsRules(args, adapter);
    const rows = [];
    const products = [];
    const candidates = [];
    const executions = [];
    const details = [];
    const run = createStoreRun("staleGoodsCleanup", adapter, operation, {
      mode,
      requestedShopIds: Array.from(requestedIds),
      targetCount: targets.length,
      concurrency,
      rules,
      adapterInput: adapterInputSummary(operation)
    });

    logStoreEvent("staleGoodsCleanup.start", {
      runId: run.runId,
      mode,
      requestedCount: requestedIds.size,
      targetCount: targets.length,
      concurrency,
      adapterVersion: adapter.version,
      adapterSource: adapter.source || "",
      adapterScriptsVersion: adapter.scripts?.version || "",
      adapterInput: adapterInputSummary(operation)
    });

    try {
      if (mode === "scan") {
        const context = { targets, rows, products, candidates, details, run, operation, adapter, args, requestPlanKeys: [] };
        await runActionList(adapter, operationPlanKey, context, {
          collectStaleGoodsCandidates: async (action, next) => {
            const actionPlans = Array.isArray(action.requestPlans)
              ? action.requestPlans
              : action.requestPlan
                ? [action.requestPlan]
                : [];
            const policyPlans = policyArray(adapter, "staleGoodsCleanup.requestPlans", []);
            const normalizedActionPlans = actionPlans.map((item) => String(item)).filter(Boolean);
            const normalizedPolicyPlans = policyPlans.map((item) => String(item)).filter(Boolean);
            if (normalizedActionPlans.length && normalizedPolicyPlans.length) {
              const actionSet = new Set(normalizedActionPlans);
              const policySet = new Set(normalizedPolicyPlans);
              const drift = actionSet.size !== policySet.size || normalizedActionPlans.some((item) => !policySet.has(item));
              if (drift) {
                const error = new Error("remote scanStaleGoodsCleanup operation request plans drift from policy request plans");
                error.code = "DOUDIAN_STALE_GOODS_REQUEST_PLANS_DRIFT";
                throw error;
              }
            }
            const requestPlanKeys = Array.from(new Set((normalizedPolicyPlans.length ? normalizedPolicyPlans : normalizedActionPlans)));
            if (!requestPlanKeys.length) {
              const error = new Error("remote scanStaleGoodsCleanup operation missing request plans");
              error.code = "DOUDIAN_STALE_GOODS_REQUEST_PLANS_MISSING";
              throw error;
            }
            next.requestPlanKeys = requestPlanKeys;
            const settled = await settleWithConcurrency(targets, concurrency, async (store, index) => {
              return collectStaleGoodsForStore({
                store,
                index: index + 1,
                total: targets.length,
                planKeys: requestPlanKeys,
                args,
                operation,
                adapter,
                onProgress
              });
            });
            for (const [index, result] of settled.entries()) {
              const store = targets[index];
              if (result.status === "rejected") {
                if (isCancelError(result.reason)) throw result.reason;
                const failure = buildStoreFailure(store, result.reason, {
                  reason: "stale-goods-request-failed",
                  index: index + 1,
                  total: targets.length
                }, adapter);
                const detail = { ...failure, status: "failed", ok: false };
                next.details.push(detail);
                next.rows.push(emptyStaleGoodsRow(store));
                if (onProgress) {
                  onProgress({
                    phase: "staleGoodsCleanup",
                    shopId: store.shopId,
                    shopName: store.shopName,
                    status: "check_failed",
                    ok: false,
                    message: detail.message,
                    reason: detail.reason,
                    category: detail.category,
                    index: index + 1,
                    total: targets.length
                  });
                }
                continue;
              }
              if (result.value?.row) next.rows.push(result.value.row);
              if (Array.isArray(result.value?.products)) next.products.push(...result.value.products);
              if (Array.isArray(result.value?.candidates)) next.candidates.push(...result.value.candidates);
              if (result.value?.detail) next.details.push(result.value.detail);
            }
            return { rows: next.rows.length, products: next.products.length, candidates: next.candidates.length, requestPlanKeys };
          },
          recordStoreAttempts: async (_action, next) => {
            recordStoreAttempts(run, "staleGoodsCleanup", next.details, adapter);
            return { count: next.details.length };
          }
        }, fallbackActions);
      } else {
        const confirmText = STALE_GOODS_CONFIRM_TEXT;
        if (String(args.confirmText || "") !== confirmText) {
          const error = new Error("stale goods cleanup confirm text mismatch");
          error.code = "DOUDIAN_STALE_GOODS_CONFIRM_REQUIRED";
          throw error;
        }
        const selected = normalizeStaleGoodsExecuteCandidates(args);
        if (!selected.length) {
          const error = new Error("stale goods cleanup selected products missing");
          error.code = "DOUDIAN_STALE_GOODS_SELECTED_PRODUCTS_MISSING";
          throw error;
        }
        const sourceRunId = String(args.sourceRunId || selected.find((item) => item.sourceRunId)?.sourceRunId || "");
        if (sourceRunId) {
          const snapshots = repository.listStaleGoodsCandidatesByRun(sourceRunId);
          const snapshotIds = new Set(snapshots.map((item) => String(item.candidateId || "")));
          const selectedSnapshotIds = new Set(selected.map((item) => String(item.candidateId || item.id || "")).filter(Boolean));
          const invalid = selectedSnapshotIds.size
            ? Array.from(selectedSnapshotIds).filter((id) => !snapshotIds.has(id))
            : [];
          if (invalid.length) {
            const error = new Error("stale goods cleanup candidates are not from local scan snapshot");
            error.code = "DOUDIAN_STALE_GOODS_CANDIDATE_SNAPSHOT_MISMATCH";
            error.invalidCandidateIds = invalid.slice(0, 20);
            throw error;
          }
        }
        const requestedAction = String(args.action || selected[0]?.action || "");
        if (!["offline", "recycle", "delete"].includes(requestedAction)) {
          const error = new Error("unsupported stale goods cleanup action");
          error.code = "DOUDIAN_STALE_GOODS_ACTION_UNSUPPORTED";
          throw error;
        }
        const planKey = staleGoodsActionPlanKey(adapter, requestedAction);
        if (!planKey) {
          const error = new Error(`missing stale goods cleanup request plan for ${requestedAction}`);
          error.code = "DOUDIAN_STALE_GOODS_EXECUTE_PLAN_MISSING";
          throw error;
        }
        const context = { targets, executions, details, run, operation, adapter, args, planKey, action: requestedAction };
        await runActionList(adapter, operationPlanKey, context, {
          executeStaleGoodsCleanup: async (action, next) => {
            const actionPlans = Array.isArray(action.requestPlans)
              ? action.requestPlans
              : action.requestPlan
                ? [action.requestPlan]
                : [];
            if (actionPlans.length && !actionPlans.map(String).includes(planKey)) {
              const error = new Error("remote executeStaleGoodsCleanup operation request plans drift from selected action plan");
              error.code = "DOUDIAN_STALE_GOODS_EXECUTE_PLANS_DRIFT";
              throw error;
            }
            const byStore = new Map();
            for (const item of selected) {
              const store = targets.find((nextStore) => String(nextStore.shopId) === String(item.shopId));
              if (!store) continue;
              const key = String(store.shopId);
              if (!byStore.has(key)) byStore.set(key, { store, candidates: [] });
              byStore.get(key).candidates.push({ ...item, action: requestedAction });
            }
            const groups = Array.from(byStore.values());
            const settled = await settleWithConcurrency(groups, concurrency, async (group, index) => {
              return executeStaleGoodsForStore({
                store: group.store,
                candidates: group.candidates,
                action: requestedAction,
                planKey,
                index: index + 1,
                total: groups.length,
                args,
                operation,
                adapter,
                onProgress
              });
            });
            for (const [index, result] of settled.entries()) {
              const group = groups[index];
              if (result.status === "rejected") {
                if (isCancelError(result.reason)) throw result.reason;
                const failure = buildStoreFailure(group.store, result.reason, {
                  reason: "stale-goods-execute-failed",
                  index: index + 1,
                  total: groups.length
                }, adapter);
                const detail = { ...failure, status: "failed", ok: false };
                next.details.push(detail);
                next.executions.push(...group.candidates.map((item) => ({
                  id: item.id,
                  shopId: group.store.shopId,
                  shopName: group.store.shopName,
                  productId: item.productId,
                  title: item.title || "",
                  action: requestedAction,
                  status: "failed",
                  ok: false,
                  message: detail.message,
                  planKey
                })));
                continue;
              }
              if (Array.isArray(result.value?.executions)) next.executions.push(...result.value.executions);
              if (result.value?.detail) next.details.push(result.value.detail);
            }
            return { executions: next.executions.length, planKey, action: requestedAction };
          },
          recordStoreAttempts: async (_action, next) => {
            recordStoreAttempts(run, "staleGoodsCleanup", next.details, adapter);
            return { count: next.details.length };
          }
        }, fallbackActions);
      }
    } catch (error) {
      if (!isCancelError(error)) {
        finishStoreRun(run, {
          status: "failed",
          storeCount: targets.length,
          successCount: details.filter((detail) => detail.ok).length,
          failureCount: Math.max(1, details.filter((detail) => !detail.ok).length || targets.length || 1),
          message: safeError(error),
          detail: { mode, details, rules }
        });
        throw error;
      }
      recordStoreAttempts(run, "staleGoodsCleanup", details, adapter);
      finishStoreRun(run, {
        status: "cancelled",
        storeCount: targets.length,
        successCount: details.filter((detail) => detail.ok).length,
        failureCount: details.filter((detail) => !detail.ok).length,
        cancelled: true,
        message: policyMessage(adapter, "staleGoodsCleanup.messages.cancelled", "Stale goods cleanup cancelled"),
        detail: { mode, details, rules }
      });
      return {
        ok: false,
        status: "cancelled",
        message: policyMessage(adapter, "staleGoodsCleanup.messages.cancelled", "Stale goods cleanup cancelled"),
        runId: run.runId,
        operationId: operationId(operation),
        mode,
        rows,
        candidates,
        executions,
        details,
        summary: staleGoodsSummary(candidates, rows),
        rules,
        ...storeLedgerSnapshot()
      };
    }

    const successCount = details.filter((detail) => detail.ok).length;
    const failureCount = details.filter((detail) => !detail.ok).length;
    const partialCount = details.filter((detail) => detail.ok && detail.status === "partial").length;
    const summary = staleGoodsSummary(candidates, rows);
    const scanSummary = staleGoodsScanSummary(details, rows, candidates);
    const sourceHealth = details.flatMap((detail) => Array.isArray(detail?.diagnostic?.sourceHealth) ? detail.diagnostic.sourceHealth : []);
    const requestPlanHash = crypto.createHash("sha256").update(JSON.stringify({
      requestPlans: policyArray(adapter, "staleGoodsCleanup.requestPlans", []),
      executePlans: policy(adapter, "staleGoodsCleanup.executePlans", {})
    })).digest("hex").slice(0, 12);
    const cleanupRuleVersion = policyText(adapter, "staleGoodsCleanup.ruleVersion", "stale-goods-rule.v2");
    const fieldSchemaVersion = policyText(adapter, "staleGoodsCleanup.fieldSchemaVersion", "stale-goods-fields.v2");
    const message = mode === "execute"
      ? failureCount
        ? policyMessage(adapter, "staleGoodsCleanup.messages.executePartial", "Stale goods cleanup submitted with {failureCount} failures", { successCount, failureCount })
        : policyMessage(adapter, "staleGoodsCleanup.messages.executeDone", "Stale goods cleanup submitted for {count} products", { count: executions.length })
      : failureCount
        ? policyMessage(adapter, "staleGoodsCleanup.messages.partial", "Stale goods scan completed with {failureCount} failures", { successCount, failureCount })
        : partialCount
          ? policyMessage(adapter, "staleGoodsCleanup.messages.partial", "Stale goods scan completed with {failureCount} failures", { successCount, failureCount: partialCount })
          : policyMessage(adapter, "staleGoodsCleanup.messages.done", "Stale goods scan completed with {count} candidates", { count: candidates.length });
    finishStoreRun(run, {
      status: failureCount || partialCount ? "partial" : "ok",
      storeCount: targets.length,
      successCount,
      failureCount,
      message,
      detail: {
        mode,
        details,
        rules,
        summary,
        scanSummary,
        sourceHealth,
        executionCount: executions.length
      }
    });
    logStoreEvent("staleGoodsCleanup.done", {
      runId: run.runId,
      mode,
      rows: rows.length,
      products: products.length,
      candidates: candidates.length,
      executions: executions.length,
      successCount,
      failureCount,
      partialCount
    });
    let snapshot = null;
    try {
      if (mode === "scan") {
        snapshot = repository.saveStaleGoodsScanSnapshot({
          runId: run.runId,
          schemaVersion: "stale_goods.v2",
          mode,
          status: failureCount || partialCount ? "partial" : "ok",
          adapterVersion: adapter.version || "",
          fieldSchemaVersion,
          requestPlanHash,
          storeCount: targets.length,
          rows,
          products,
          candidates,
          details,
          scanSummary,
          rules,
          finishedAt: new Date().toISOString()
        });
        const byCandidateKey = new Map((snapshot.candidateSnapshotIds || []).map((id, index) => {
          const candidate = candidates[index];
          return [`${candidate?.shopId || ""}:${candidate?.productId || ""}`, id];
        }));
        for (const candidate of candidates) {
          const snapshotId = byCandidateKey.get(`${candidate.shopId || ""}:${candidate.productId || ""}`);
          if (snapshotId) candidate.candidateId = snapshotId;
          candidate.sourceRunId = run.runId;
        }
      } else {
        snapshot = repository.saveStaleGoodsExecuteSnapshot({
          executeRunId: run.runId,
          sourceRunId: String(args.sourceRunId || ""),
          action: String(args.action || ""),
          confirmText: String(args.confirmText || ""),
          status: failureCount ? "partial" : "ok",
          dryRun: executions.every((item) => item.status === "dry_run"),
          executions,
          summary
        });
      }
    } catch (error) {
      logStoreEvent("staleGoodsCleanup.snapshot.failed", {
        runId: run.runId,
        mode,
        error: safeError(error)
      });
    }

    return {
      ok: failureCount === 0,
      status: failureCount || partialCount ? "partial" : "ok",
      message,
      runId: run.runId,
      operationId: operationId(operation),
      mode,
      rows,
      candidates,
      executions,
      details,
      successCount,
      failureCount,
      partialCount,
      summary,
      scanSummary,
      sourceHealth,
      rules,
      snapshot,
      cleanupRuleVersion,
      requestPlanHash,
      fieldSchemaVersion,
      ...storeLedgerSnapshot()
    };
  }

  async function fetchViolationsData(args = {}, onProgress = null, operation = null) {
    assertRemoteAdapterInput(args, "fetchViolationsData");
    const adapter = resolveTaskAdapter(args, operation);
    requireOperationActions(adapter, "fetchViolationsData", [
      "collectViolationsData",
      "recordStoreAttempts"
    ], FETCH_VIOLATIONS_DATA_FALLBACK_ACTIONS);
    throwIfCancelled(operation);

    const requestedIds = new Set((args.shopIds || []).map((id) => String(id)));
    const allStores = repository.listStores();
    const targets = requestedIds.size ? allStores.filter((store) => requestedIds.has(String(store.shopId))) : allStores;
    const defaultConcurrency = policyNumber(adapter, "violationsData.concurrency", 2, { min: 1, max: 6 });
    const concurrency = Math.max(1, Math.min(6, Math.floor(Number(args.concurrency || defaultConcurrency))));
    const dateContext = violationsDateContext(args, adapter);
    const rows = [];
    const records = [];
    const details = [];
    let requestPlanKeysForRun = [];
    const run = createStoreRun("violationsData", adapter, operation, {
      requestedShopIds: Array.from(requestedIds),
      targetCount: targets.length,
      concurrency,
      dateContext,
      adapterInput: adapterInputSummary(operation)
    });

    logStoreEvent("violationsData.start", {
      runId: run.runId,
      requestedCount: requestedIds.size,
      targetCount: targets.length,
      concurrency,
      dateContext,
      adapterVersion: adapter.version,
      adapterSource: adapter.source || "",
      adapterScriptsVersion: adapter.scripts?.version || "",
      adapterInput: adapterInputSummary(operation)
    });

    try {
      const context = {
        targets,
        rows,
        records,
        details,
        run,
        operation,
        adapter,
        args,
        requestPlanKeys: []
      };
      await runActionList(adapter, "fetchViolationsData", context, {
        collectViolationsData: async (action, next) => {
          const actionPlans = Array.isArray(action.requestPlans)
            ? action.requestPlans
            : action.requestPlan
              ? [action.requestPlan]
              : [];
          const policyPlans = policyArray(adapter, "violationsData.requestPlans", []);
          const normalizedActionPlans = actionPlans.map((item) => String(item)).filter(Boolean);
          const normalizedPolicyPlans = policyPlans.map((item) => String(item)).filter(Boolean);
          if (normalizedActionPlans.length && normalizedPolicyPlans.length) {
            const actionSet = new Set(normalizedActionPlans);
            const policySet = new Set(normalizedPolicyPlans);
            const drift = actionSet.size !== policySet.size || normalizedActionPlans.some((item) => !policySet.has(item));
            if (drift) {
              const error = new Error("remote fetchViolationsData operation request plans drift from policy request plans");
              error.code = "DOUDIAN_VIOLATIONS_DATA_REQUEST_PLANS_DRIFT";
              throw error;
            }
          }
          const requestPlanKeys = Array.from(new Set((normalizedPolicyPlans.length ? normalizedPolicyPlans : normalizedActionPlans)));
          if (!requestPlanKeys.length) {
            const error = new Error("remote fetchViolationsData operation missing request plans");
            error.code = "DOUDIAN_VIOLATIONS_DATA_REQUEST_PLANS_MISSING";
            throw error;
          }
          next.requestPlanKeys = requestPlanKeys;
          requestPlanKeysForRun = requestPlanKeys;
          const settled = await settleWithConcurrency(targets, concurrency, async (store, index) => {
            return collectViolationsDataForStore({
              store,
              index: index + 1,
              total: targets.length,
              planKeys: requestPlanKeys,
              args,
              operation,
              adapter,
              onProgress
            });
          });

          for (const [index, result] of settled.entries()) {
            if (result.status === "rejected") {
              if (isCancelError(result.reason)) throw result.reason;
              const store = targets[index];
              const failure = buildStoreFailure(store, result.reason, {
                reason: "violations-data-request-failed",
                index: index + 1,
                total: targets.length
              }, adapter);
              const detail = {
                ...failure,
                status: "failed",
                ok: false
              };
              next.details.push(detail);
              next.rows.push(emptyViolationsDataRow(store));
              if (onProgress) {
                onProgress({
                  phase: "violationsData",
                  shopId: store.shopId,
                  shopName: store.shopName,
                  status: "check_failed",
                  ok: false,
                  message: detail.message,
                  reason: detail.reason,
                  category: detail.category,
                  index: index + 1,
                  total: targets.length
                });
              }
              continue;
            }
            if (result.value?.row) next.rows.push(result.value.row);
            if (Array.isArray(result.value?.records)) next.records.push(...result.value.records);
            if (result.value?.detail) next.details.push(result.value.detail);
          }
          return {
            rows: next.rows.length,
            records: next.records.length,
            details: next.details.length,
            requestPlanKeys
          };
        },
        recordStoreAttempts: async (_action, next) => {
          recordStoreAttempts(run, "violationsData", next.details, adapter);
          return { count: next.details.length };
        }
      }, FETCH_VIOLATIONS_DATA_FALLBACK_ACTIONS);
    } catch (error) {
      if (!isCancelError(error)) {
        finishStoreRun(run, {
          status: "failed",
          storeCount: targets.length,
          successCount: details.filter((detail) => detail.ok).length,
          failureCount: Math.max(1, details.filter((detail) => !detail.ok).length || targets.length || 1),
          message: safeError(error),
          detail: {
            details,
            dateContext
          }
        });
        throw error;
      }
      recordStoreAttempts(run, "violationsData", details, adapter);
      finishStoreRun(run, {
        status: "cancelled",
        storeCount: targets.length,
        successCount: details.filter((detail) => detail.ok).length,
        failureCount: details.filter((detail) => !detail.ok).length,
        cancelled: true,
        message: policyMessage(adapter, "violationsData.messages.cancelled", "Violations data sync cancelled"),
        detail: {
          details,
          dateContext
        }
      });
      return {
        ok: false,
        status: "cancelled",
        message: policyMessage(adapter, "violationsData.messages.cancelled", "Violations data sync cancelled"),
        runId: run.runId,
        operationId: operationId(operation),
        rows,
        records,
        details,
        dateRange: dateContext,
        ...storeLedgerSnapshot()
      };
    }

    const successCount = details.filter((detail) => detail.ok).length;
    const failureCount = details.filter((detail) => !detail.ok).length;
    const partialSourceCount = details.filter((detail) => {
      const diagnostic = detail?.diagnostic || {};
      return Number(diagnostic.blockingSourceFailureCount ?? diagnostic.sourceFailureCount ?? 0) > 0;
    }).length;
    const noRecordCount = details.filter((detail) => detail?.diagnostic?.rowSummary?.noRecord === true).length;
    const partialIssueCount = partialSourceCount;
    const message = failureCount
      ? policyMessage(adapter, "violationsData.messages.partial", "Violations data synced with {failureCount} failures", { successCount, failureCount })
      : partialIssueCount
        ? policyMessage(adapter, "violationsData.messages.partialSources", "Violations data synced; {partialSourceCount} stores have source issues", {
          successCount,
          partialSourceCount
        })
        : policyMessage(adapter, "violationsData.messages.done", "Violations data synced for {successCount} stores", { successCount });
    const violationsMetadata = violationsContractMetadata(adapter, requestPlanKeysForRun);
    repository.saveViolationsDataRows({
      rows,
      records,
      details,
      dateRange: dateContext,
      runId: run.runId,
      adapterVersion: adapter.version || "",
      scriptsVersion: adapter.scripts?.version || "",
      fieldSchemaVersion: violationsMetadata.fieldSchemaVersion,
      requestPlanHash: violationsMetadata.requestPlanHash,
      productLinkageVersion: violationsMetadata.productLinkageVersion
    });
    finishStoreRun(run, {
      status: failureCount || partialIssueCount ? "partial" : "ok",
      storeCount: targets.length,
      successCount,
      failureCount,
      message,
      detail: {
        details,
        dateContext,
        partialSourceCount,
        noRecordCount
      }
    });
    logStoreEvent("violationsData.done", {
      runId: run.runId,
      rows: rows.length,
      records: records.length,
      successCount,
      failureCount,
      partialSourceCount,
      noRecordCount
    });

    return {
      ok: failureCount === 0,
      status: failureCount || partialIssueCount ? "partial" : "ok",
      message,
      runId: run.runId,
      operationId: operationId(operation),
      rows,
      records,
      details,
      successCount,
      failureCount,
      partialSourceCount,
      noRecordCount,
      dateRange: dateContext,
      adapterVersion: adapter.version || "",
      scriptsVersion: adapter.scripts?.version || "",
      fieldSchemaVersion: violationsMetadata.fieldSchemaVersion,
      requestPlanHash: violationsMetadata.requestPlanHash,
      productLinkageVersion: violationsMetadata.productLinkageVersion,
      ...storeLedgerSnapshot()
    };
  }

  async function latestViolationsData(args = {}) {
    const adapter = resolveTaskAdapter(args, null);
    const dateContext = violationsDateContext(args, adapter);
    const policyPlans = policyArray(adapter, "violationsData.requestPlans", []).map((item) => String(item)).filter(Boolean);
    const violationsMetadata = violationsContractMetadata(adapter, policyPlans);
    const rows = repository.listViolationsDataRows({
      shopIds: args.shopIds || [],
      datePreset: args.datePreset || dateContext.datePreset,
      beginDate: args.beginDate || dateContext.beginDate,
      endDate: args.endDate || dateContext.endDate,
      adapterVersion: adapter.version || "",
      fieldSchemaVersion: violationsMetadata.fieldSchemaVersion,
      requestPlanHash: violationsMetadata.requestPlanHash,
      productLinkageVersion: violationsMetadata.productLinkageVersion
    });
    const violationRows = rows.map((item) => item.row || {});
    const records = rows.flatMap((item) => Array.isArray(item.records) ? item.records : []);
    const details = rows.map((item, index) => ({
      shopId: item.shopId,
      shopName: item.shopName,
      status: item.ok ? "ok" : "failed",
      ok: item.ok,
      message: item.message,
      reason: item.ok ? "" : "violations-data-cached-failure",
      category: item.ok ? "" : "api",
      diagnostic: item.diagnostic,
      index: index + 1,
      total: rows.length
    }));
    return {
      ok: true,
      status: rows.length ? "ready" : "empty",
      message: rows.length ? `已读取 ${rows.length} 条最近违规数据` : "暂无最近违规数据",
      rows: violationRows,
      records,
      details,
      dateRange: {
        datePreset: args.datePreset || dateContext.datePreset,
        beginDate: args.beginDate || dateContext.beginDate,
        endDate: args.endDate || dateContext.endDate
      },
      adapterVersion: adapter.version || "",
      scriptsVersion: adapter.scripts?.version || "",
      fieldSchemaVersion: violationsMetadata.fieldSchemaVersion,
      requestPlanHash: violationsMetadata.requestPlanHash,
      productLinkageVersion: violationsMetadata.productLinkageVersion,
      cached: true,
      cachedRows: rows
    };
  }

  async function fetchFundsData(args = {}, onProgress = null, operation = null) {
    assertRemoteAdapterInput(args, "fetchFundsData");
    const adapter = resolveTaskAdapter(args, operation);
    requireOperationActions(adapter, "fetchFundsData", [
      "collectFundsData",
      "recordStoreAttempts"
    ], FETCH_FUNDS_DATA_FALLBACK_ACTIONS);
    throwIfCancelled(operation);

    const requestedIds = new Set((args.shopIds || []).map((id) => String(id)));
    const allStores = repository.listStores();
    const targets = requestedIds.size ? allStores.filter((store) => requestedIds.has(String(store.shopId))) : allStores;
    const defaultConcurrency = policyNumber(adapter, "fundsData.concurrency", 2, { min: 1, max: 6 });
    const concurrency = Math.max(1, Math.min(6, Math.floor(Number(args.concurrency || defaultConcurrency))));
    const dateContext = fundsDateContext(args, adapter);
    const rows = [];
    const details = [];
    let requestPlanKeysForRun = [];
    const run = createStoreRun("fundsData", adapter, operation, {
      requestedShopIds: Array.from(requestedIds),
      targetCount: targets.length,
      concurrency,
      dateContext,
      adapterInput: adapterInputSummary(operation)
    });

    logStoreEvent("fundsData.start", {
      runId: run.runId,
      requestedCount: requestedIds.size,
      targetCount: targets.length,
      concurrency,
      dateContext,
      adapterVersion: adapter.version,
      adapterSource: adapter.source || "",
      adapterScriptsVersion: adapter.scripts?.version || "",
      adapterInput: adapterInputSummary(operation)
    });

    try {
      const context = {
        targets,
        rows,
        details,
        run,
        operation,
        adapter,
        args,
        requestPlanKeys: []
      };
      await runActionList(adapter, "fetchFundsData", context, {
        collectFundsData: async (action, next) => {
          const actionPlans = Array.isArray(action.requestPlans)
            ? action.requestPlans
            : action.requestPlan
              ? [action.requestPlan]
              : [];
          const policyPlans = policyArray(adapter, "fundsData.requestPlans", []);
          const normalizedActionPlans = actionPlans.map((item) => String(item)).filter(Boolean);
          const normalizedPolicyPlans = policyPlans.map((item) => String(item)).filter(Boolean);
          if (normalizedActionPlans.length && normalizedPolicyPlans.length) {
            const actionSet = new Set(normalizedActionPlans);
            const policySet = new Set(normalizedPolicyPlans);
            const drift = actionSet.size !== policySet.size || normalizedActionPlans.some((item) => !policySet.has(item));
            if (drift) {
              const error = new Error("remote fetchFundsData operation request plans drift from policy request plans");
              error.code = "DOUDIAN_FUNDS_DATA_REQUEST_PLANS_DRIFT";
              throw error;
            }
          }
          const requestPlanKeys = Array.from(new Set((normalizedPolicyPlans.length ? normalizedPolicyPlans : normalizedActionPlans)));
          if (!requestPlanKeys.length) {
            const error = new Error("remote fetchFundsData operation missing request plans");
            error.code = "DOUDIAN_FUNDS_DATA_REQUEST_PLANS_MISSING";
            throw error;
          }
          next.requestPlanKeys = requestPlanKeys;
          requestPlanKeysForRun = requestPlanKeys;
          const settled = await settleWithConcurrency(targets, concurrency, async (store, index) => {
            return collectFundsDataForStore({
              store,
              index: index + 1,
              total: targets.length,
              planKeys: requestPlanKeys,
              args,
              operation,
              adapter,
              onProgress
            });
          });

          for (const [index, result] of settled.entries()) {
            if (result.status === "rejected") {
              if (isCancelError(result.reason)) throw result.reason;
              const store = targets[index];
              const failure = buildStoreFailure(store, result.reason, {
                reason: "funds-data-request-failed",
                index: index + 1,
                total: targets.length
              }, adapter);
              const detail = {
                ...failure,
                status: "failed",
                ok: false
              };
              next.details.push(detail);
              next.rows.push(emptyFundsDataRow(store));
              if (onProgress) {
                onProgress({
                  phase: "fundsData",
                  shopId: store.shopId,
                  shopName: store.shopName,
                  status: "check_failed",
                  ok: false,
                  message: detail.message,
                  reason: detail.reason,
                  category: detail.category,
                  index: index + 1,
                  total: targets.length
                });
              }
              continue;
            }
            if (result.value?.row) next.rows.push(result.value.row);
            if (result.value?.detail) next.details.push(result.value.detail);
          }
          return {
            rows: next.rows.length,
            details: next.details.length,
            requestPlanKeys
          };
        },
        recordStoreAttempts: async (_action, next) => {
          recordStoreAttempts(run, "fundsData", next.details, adapter);
          return { count: next.details.length };
        }
      }, FETCH_FUNDS_DATA_FALLBACK_ACTIONS);
    } catch (error) {
      if (!isCancelError(error)) {
        finishStoreRun(run, {
          status: "failed",
          storeCount: targets.length,
          successCount: details.filter((detail) => detail.ok).length,
          failureCount: Math.max(1, details.filter((detail) => !detail.ok).length || targets.length || 1),
          message: safeError(error),
          detail: {
            details,
            dateContext
          }
        });
        throw error;
      }
      recordStoreAttempts(run, "fundsData", details, adapter);
      finishStoreRun(run, {
        status: "cancelled",
        storeCount: targets.length,
        successCount: details.filter((detail) => detail.ok).length,
        failureCount: details.filter((detail) => !detail.ok).length,
        cancelled: true,
        message: policyMessage(adapter, "fundsData.messages.cancelled", "Funds data sync cancelled"),
        detail: {
          details,
          dateContext
        }
      });
      return {
        ok: false,
        status: "cancelled",
        message: policyMessage(adapter, "fundsData.messages.cancelled", "Funds data sync cancelled"),
        runId: run.runId,
        operationId: operationId(operation),
        rows,
        details,
        dateRange: dateContext,
        ...storeLedgerSnapshot()
      };
    }

    const successCount = details.filter((detail) => detail.ok).length;
    const failureCount = details.filter((detail) => !detail.ok).length;
    const partialSourceCount = details.filter((detail) => {
      const diagnostic = detail?.diagnostic || {};
      return Number(diagnostic.blockingSourceFailureCount ?? diagnostic.sourceFailureCount ?? 0) > 0;
    }).length;
    const noMetricMatchCount = details.filter((detail) => detail?.diagnostic?.rowSummary?.allZero === true).length;
    const partialIssueCount = partialSourceCount + noMetricMatchCount;
    const message = failureCount
      ? policyMessage(adapter, "fundsData.messages.partial", "Funds data synced with {failureCount} failures", { successCount, failureCount })
      : partialIssueCount
        ? policyMessage(adapter, "fundsData.messages.partialSources", "Funds data synced; {partialSourceCount} stores have source issues, {noMetricMatchCount} stores have no metric match", {
          successCount,
          partialSourceCount,
          noMetricMatchCount
        })
        : policyMessage(adapter, "fundsData.messages.done", "Funds data synced for {successCount} stores", { successCount });
    const fundsMetadata = fundsContractMetadata(adapter, requestPlanKeysForRun);
    const rowsToSave = policyBool(adapter, "fundsData.cachePolicy.skipAllZeroWhenCriticalMissing", false)
      ? rows.filter((row) => {
        const detail = details.find((item) => String(item.shopId || "") === String(row.shopId || ""));
        const diagnostic = detail?.diagnostic || {};
        return !(diagnostic?.rowSummary?.allZero === true && Array.isArray(diagnostic.missingCriticalPlans) && diagnostic.missingCriticalPlans.length);
      })
      : rows;
    repository.saveFundsDataRows({
      rows: rowsToSave,
      details,
      dateRange: dateContext,
      runId: run.runId,
      adapterVersion: adapter.version || "",
      scriptsVersion: adapter.scripts?.version || "",
      fieldSchemaVersion: fundsMetadata.fieldSchemaVersion,
      requestPlanHash: fundsMetadata.requestPlanHash
    });
    finishStoreRun(run, {
      status: failureCount || partialIssueCount ? "partial" : "ok",
      storeCount: targets.length,
      successCount,
      failureCount,
      message,
      detail: {
        details,
        dateContext,
        partialSourceCount,
        noMetricMatchCount
      }
    });
    logStoreEvent("fundsData.done", {
      runId: run.runId,
      rows: rows.length,
      successCount,
      failureCount,
      partialSourceCount,
      noMetricMatchCount
    });

    return {
      ok: failureCount === 0,
      status: failureCount || partialIssueCount ? "partial" : "ok",
      message,
      runId: run.runId,
      operationId: operationId(operation),
      rows,
      details,
      successCount,
      failureCount,
      partialSourceCount,
      noMetricMatchCount,
      dateRange: dateContext,
      adapterVersion: adapter.version || "",
      scriptsVersion: adapter.scripts?.version || "",
      fieldSchemaVersion: fundsMetadata.fieldSchemaVersion,
      requestPlanHash: fundsMetadata.requestPlanHash,
      ...storeLedgerSnapshot()
    };
  }

  async function latestFundsData(args = {}) {
    const adapter = resolveTaskAdapter(args, null);
    const dateContext = fundsDateContext(args, adapter);
    const policyPlans = policyArray(adapter, "fundsData.requestPlans", []).map((item) => String(item)).filter(Boolean);
    const fundsMetadata = fundsContractMetadata(adapter, policyPlans);
    const rows = repository.listFundsDataRows({
      shopIds: args.shopIds || [],
      datePreset: args.datePreset || dateContext.datePreset,
      beginDate: args.beginDate || dateContext.beginDate,
      endDate: args.endDate || dateContext.endDate,
      adapterVersion: adapter.version || "",
      fieldSchemaVersion: fundsMetadata.fieldSchemaVersion
    });
    const fundsRows = rows.map((item) => item.row || {});
    const details = rows.map((item, index) => ({
      shopId: item.shopId,
      shopName: item.shopName,
      status: item.ok ? "ok" : "failed",
      ok: item.ok,
      message: item.message,
      reason: item.ok ? "" : "funds-data-cached-failure",
      category: item.ok ? "" : "api",
      diagnostic: item.diagnostic,
      index: index + 1,
      total: rows.length
    }));
    return {
      ok: true,
      status: rows.length ? "ready" : "empty",
      message: rows.length ? `已读取 ${rows.length} 条最近资金数据` : "暂无最近资金数据",
      rows: fundsRows,
      details,
      dateRange: {
        datePreset: args.datePreset || dateContext.datePreset,
        beginDate: args.beginDate || dateContext.beginDate,
        endDate: args.endDate || dateContext.endDate
      },
      adapterVersion: adapter.version || "",
      scriptsVersion: adapter.scripts?.version || "",
      fieldSchemaVersion: fundsMetadata.fieldSchemaVersion,
      requestPlanHash: fundsMetadata.requestPlanHash,
      cached: true,
      cachedRows: rows
    };
  }

  async function refreshStatus(args = {}, onProgress = null, operation = null) {
    assertRemoteAdapterInput(args, "refreshStatus");
    const adapter = resolveTaskAdapter(args, operation);
    requireOperationActions(adapter, "refreshStatus", [
      "refreshStores",
      "updateStores",
      "recordStoreAttempts"
    ], REFRESH_STATUS_FALLBACK_ACTIONS);
    requireOperationActions(adapter, "refreshStore", [
      "getShopUserInfo"
    ]);
    const ids = new Set((args.shopIds || []).map((id) => String(id)));
    const defaultRefreshConcurrency = policyNumber(adapter, "refreshStatus.concurrency", 3, { min: 1, max: 12 });
    const refreshConcurrency = Math.max(1, Math.min(12, Math.floor(Number(args.concurrency || defaultRefreshConcurrency))));
    const stores = repository.listStores();
    const targets = ids.size ? stores.filter((store) => ids.has(String(store.shopId))) : stores;
    const refreshed = [];
    const details = [];
    const run = createStoreRun("refresh", adapter, operation, {
      requestedShopIds: Array.from(ids),
      targetCount: targets.length,
      refreshConcurrency,
      adapterInput: adapterInputSummary(operation),
      mode: "doudian-get-shop-user-info"
    });

    logStoreEvent("refresh.start", {
      runId: run.runId,
      requestedCount: ids.size,
      targetCount: targets.length,
      refreshConcurrency,
      adapterVersion: adapter.version,
      adapterSource: adapter.source || "",
      adapterScriptsVersion: adapter.scripts?.version || "",
      adapterInput: adapterInputSummary(operation),
      mode: "doudian-get-shop-user-info"
    });

    try {
      const refreshContext = {
        targets,
        refreshed,
        details,
        run,
        operation,
        adapter
      };
      await runActionList(adapter, "refreshStatus", refreshContext, {
        refreshStores: async (_action, context) => {
          const settled = await settleWithConcurrency(targets, refreshConcurrency, async (store, index) => {
            return refreshOneStore({
              store,
              index: index + 1,
              total: targets.length,
              operation,
              adapter,
              onProgress,
              getShopUserInfo,
              classifyStoreFailure,
              logStoreEvent,
              summarizeShopUserInfo,
              throwIfCancelled,
              isCancelError
            });
          });

          for (const result of settled) {
            if (result.status === "rejected") {
              if (isCancelError(result.reason)) throw result.reason;
              continue;
            }
            if (result.value?.store) context.refreshed.push(result.value.store);
            if (result.value?.detail) context.details.push(result.value.detail);
          }
          return {
            refreshed: context.refreshed.length,
            details: context.details.length
          };
        },
        updateStores: async (_action, context) => {
          if (context.refreshed.length) repository.updateStores(context.refreshed);
          return { count: context.refreshed.length };
        },
        recordStoreAttempts: async (_action, context) => {
          recordStoreAttempts(run, "refresh", context.details, adapter);
          return { count: context.details.length };
        }
      }, REFRESH_STATUS_FALLBACK_ACTIONS);
    } catch (error) {
      if (!isCancelError(error)) throw error;
      if (refreshed.length) repository.updateStores(refreshed);
      recordStoreAttempts(run, "refresh", details, adapter);
      logStoreEvent("refresh.cancelled", {
        runId: run.runId,
        refreshed: refreshed.length,
        targetCount: targets.length
      });
      finishStoreRun(run, {
        status: "cancelled",
        storeCount: targets.length,
        successCount: details.filter((detail) => detail.ok).length,
        failureCount: details.filter((detail) => !detail.ok).length,
        cancelled: true,
        message: "已取消刷新登录态",
        detail: { details }
      });
      return {
        ok: false,
        status: "cancelled",
        message: "已取消刷新登录态",
        runId: run.runId,
        operationId: operationId(operation),
        refreshed: refreshed.length,
        details,
        ...storeLedgerSnapshot()
      };
    }

    logStoreEvent("refresh.done", {
      runId: run.runId,
      refreshed: refreshed.length
    });
    finishStoreRun(run, {
      status: details.some((detail) => !detail.ok) ? "partial" : "ok",
      storeCount: targets.length,
      successCount: details.filter((detail) => detail.ok).length,
      failureCount: details.filter((detail) => !detail.ok).length,
      message: `已刷新 ${refreshed.length} 家店铺登录态`,
      detail: { details }
    });

    return {
      ok: true,
      runId: run.runId,
      operationId: operationId(operation),
      refreshed: refreshed.length,
      details,
      ...storeLedgerSnapshot()
    };
  }

  async function openStore(args = {}) {
    assertRemoteAdapterInput(args, "openStore");
    const adapter = resolveTaskAdapter(args);
    const shopId = String(args.shopId || "");
    const store = repository.listStores().find((item) => String(item.shopId) === shopId);
    if (!store) return { ok: false, message: "找不到店铺" };

    const context = {
      partition: store.partition,
      show: true,
      title: policyMessage(adapter, "openStore.titleTemplate", "{shopName} - 抖店后台", { shopName: store.shopName }),
      url: adapter.homeUrl,
      loadTimeoutMs: adapterTimeout(adapter, "loadMs"),
      win: null,
      loadResult: null
    };
    await runActionList(adapter, "openStore", context, {
      openWindow: async (_action, next) => {
        next.win = createBrowserWindow({
          partition: next.partition,
          show: next.show,
          title: next.title,
          adapter
        });
        return { winId: next.win.id };
      },
      loadUrl: async (_action, next) => {
        if (!next.win) throw new Error("openStore loadUrl requires openWindow action");
        next.loadResult = await loadUrl(next.win, next.url, next.loadTimeoutMs);
        return next.loadResult;
      }
    }, [
      { action: "openWindow" },
      { action: "loadUrl" }
    ]);
    return { ok: true, winId: context.win.id };
  }

  async function deleteStores(args = {}) {
    const adapter = args.doudianAdapter || args.adapter ? resolveTaskAdapter(args) : DOUDIAN_ADAPTER;
    const run = createStoreRun("delete", adapter, null, {
      shopIds: args.shopIds || []
    });
    const deleted = repository.deleteStores(args.shopIds || []);
    if (policyBool(adapter, "deleteStores.clearPartition", true)) {
      for (const store of deleted) {
        if (store.partition) await clearAllSessionData(store.partition);
      }
    }
    recordStoreAttempts(run, "delete", deleted.map((store, index) => ({
      shopId: store.shopId,
      shopName: store.shopName,
      status: policyText(adapter, "deleteStores.attemptStatus", "deleted"),
      ok: true,
      message: policyMessage(adapter, "deleteStores.attemptMessage", "已删除店铺"),
      index: index + 1,
      total: deleted.length
    })), adapter);
    finishStoreRun(run, {
      status: "ok",
      storeCount: deleted.length,
      successCount: deleted.length,
      failureCount: 0,
      message: policyMessage(adapter, "deleteStores.runMessage", "已删除 {count} 家店铺", { count: deleted.length }),
      detail: {
        deleted: deleted.map((store) => ({ shopId: store.shopId, shopName: store.shopName }))
      }
    });
    return {
      ok: true,
      runId: run.runId,
      deleted: deleted.length,
      ...storeLedgerSnapshot()
    };
  }

  async function updateGroup(args = {}) {
    const adapter = args.doudianAdapter || args.adapter ? resolveTaskAdapter(args) : DOUDIAN_ADAPTER;
    const run = createStoreRun("group", adapter, null, {
      action: args.action || "update",
      shopIds: args.shopIds || [],
      groupName: args.groupName || "",
      oldGroupName: args.oldGroupName || ""
    });

    if (args.action === "create") {
      const result = repository.createGroup(args.groupName, args.groupId || args.groupName);
      finishStoreRun(run, {
        status: result.created ? "ok" : "blocked",
        storeCount: 0,
        successCount: result.created ? 1 : 0,
        failureCount: result.created ? 0 : 1,
        message: result.created
          ? policyMessage(adapter, "group.messages.createOk", "已创建分组")
          : policyMessage(adapter, "group.messages.createBlocked", "该分组不能创建"),
        detail: { groupName: args.groupName || "", reason: result.reason }
      });
      return {
        ok: result.created,
        runId: run.runId,
        status: result.created ? "created" : result.reason,
        message: result.created
          ? policyMessage(adapter, "group.messages.createOk", "已创建分组")
          : policyMessage(adapter, "group.messages.createBlocked", "该分组不能创建"),
        updated: 0,
        ...storeLedgerSnapshot()
      };
    }

    if (args.action === "rename") {
      const changed = repository.renameGroup(args.oldGroupName, args.groupName);
      recordStoreAttempts(run, "group", changed.map((store, index) => ({
        shopId: store.shopId,
        shopName: store.shopName,
        status: "renamed",
        ok: true,
        message: policyMessage(adapter, "group.messages.renameAttempt", "已重命名分组"),
        index: index + 1,
        total: changed.length
      })), adapter);
      finishStoreRun(run, {
        status: "ok",
        storeCount: changed.length,
        successCount: changed.length,
        failureCount: 0,
        message: policyMessage(adapter, "group.messages.renameRun", "已重命名 {count} 家店铺的分组", { count: changed.length }),
        detail: { oldGroupName: args.oldGroupName || "", groupName: args.groupName || "" }
      });
      return {
        ok: true,
        runId: run.runId,
        updated: changed.length,
        ...storeLedgerSnapshot()
      };
    }
    if (args.action === "deleteEmpty") {
      const result = repository.deleteEmptyGroup(args.groupName);
      finishStoreRun(run, {
        status: result.deleted ? "ok" : "blocked",
        storeCount: 0,
        successCount: result.deleted ? 1 : 0,
        failureCount: result.deleted ? 0 : 1,
        message: result.deleted
          ? policyMessage(adapter, "group.messages.deleteEmptyOk", "已删除空分组")
          : result.reason === "not-empty"
            ? policyMessage(adapter, "group.messages.deleteEmptyNotEmpty", "该分组下仍有店铺，不能删除空分组")
            : policyMessage(adapter, "group.messages.deleteEmptyBlocked", "该分组不能删除"),
        detail: { groupName: args.groupName || "", reason: result.reason }
      });
      return {
        ok: result.deleted,
        runId: run.runId,
        status: result.deleted ? "deleted" : result.reason,
        message: result.deleted
          ? policyMessage(adapter, "group.messages.deleteEmptyOk", "已删除空分组")
          : result.reason === "not-empty"
            ? policyMessage(adapter, "group.messages.deleteEmptyNotEmpty", "该分组下仍有店铺，不能删除空分组")
            : policyMessage(adapter, "group.messages.deleteEmptyBlocked", "该分组不能删除"),
        updated: 0,
        ...storeLedgerSnapshot()
      };
    }
    const shopIds = args.shopIds || [];
    const groupName = String(args.groupName || "").trim() || policyText(adapter, "group.defaultGroupName", "未分组");
    const groupId = String(args.groupId || groupName);
    const changed = repository.updateStoreGroup(shopIds, groupName, groupId);
    recordStoreAttempts(run, "group", changed.map((store, index) => ({
      shopId: store.shopId,
      shopName: store.shopName,
      status: "updated",
      ok: true,
      message: policyMessage(adapter, "group.messages.updateAttempt", "已更新店铺分组"),
      index: index + 1,
      total: changed.length
    })), adapter);
    finishStoreRun(run, {
      status: "ok",
      storeCount: changed.length,
      successCount: changed.length,
      failureCount: 0,
      message: policyMessage(adapter, "group.messages.updateRun", "已更新 {count} 家店铺分组", { count: changed.length }),
      detail: { groupName, groupId, shopIds }
    });
    return {
      ok: true,
      runId: run.runId,
      updated: changed.length,
      ...storeLedgerSnapshot()
    };
  }

  return {
    deleteStores,
    fetchBusinessData,
    fetchFundsData,
    staleGoodsCleanup,
    fetchViolationsData,
    fetchStores,
    latestBusinessData,
    latestFundsData,
    latestViolationsData,
    listStores,
    openStore,
    refreshStatus,
    updateGroup
  };
}

module.exports = {
  createDoudianStoreService
};

