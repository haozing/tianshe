const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { app } = require("electron");
const { ROOT } = require("../config");
const { nativeHttpRequest } = require("../ipc/http");

const STATE_VERSION = 1;
const AUTH_OBJECT_TYPE = "device_code";
const RECENT_CHECK_MS = 10 * 60 * 1000;

let activeLicenseCache = null;

function readPackageMetadata() {
  try {
    return require(path.join(ROOT, "package.json"));
  } catch {
    return {};
  }
}

function readJsonFile(filePath) {
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function licenseConfigPaths() {
  const paths = [];
  const explicitPath = String(process.env.CHIHU_LICENSE_CONFIG_PATH || "").trim();
  if (explicitPath) paths.push(path.resolve(explicitPath));

  paths.push(path.join(ROOT, "license-config.local.json"));

  if (process.resourcesPath) {
    paths.push(path.join(process.resourcesPath, "license-config.local.json"));
  }

  try {
    paths.push(path.join(path.dirname(app.getPath("exe")), "license-config.local.json"));
  } catch {}

  return [...new Set(paths)];
}

function readFileLicenseConfig() {
  for (const filePath of licenseConfigPaths()) {
    const config = readJsonFile(filePath);
    if (Object.keys(config).length) return config;
  }
  return {};
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function boolEnv(name) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function getLicenseConfig() {
  const packageMetadata = readPackageMetadata();
  const packageLicense = packageMetadata.chihuLicense || {};
  const fileLicense = readFileLicenseConfig();
  const apiBaseUrl = normalizeBaseUrl(process.env.CHIHU_LICENSE_API_BASE_URL || fileLicense.apiBaseUrl || packageLicense.apiBaseUrl || "");
  const appId = String(process.env.CHIHU_LICENSE_APP_ID || fileLicense.appId || packageLicense.appId || "").trim();
  const appSecret = String(process.env.CHIHU_LICENSE_APP_SECRET || fileLicense.appSecret || packageLicense.appSecret || "").trim();
  const platform = String(process.env.CHIHU_LICENSE_PLATFORM || fileLicense.platform || packageLicense.platform || "windows").trim() || "windows";
  const bypass = boolEnv("CHIHU_LICENSE_BYPASS");

  return {
    apiBaseUrl,
    appId,
    appSecret,
    platform,
    configured: Boolean(apiBaseUrl && appId && appSecret),
    bypass
  };
}

function stateFilePath() {
  return path.join(app.getPath("userData"), "license", "device-license-state.json");
}

let stateCache = null;
let stateWriteQueue = Promise.resolve();
let licenseRefreshPromise = null;

async function readState() {
  if (stateCache) return stateCache;
  try {
    const raw = await fs.readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    stateCache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    stateCache = {};
  }
  return stateCache;
}

async function writeState(patch) {
  const write = async () => {
    const current = await readState();
    const next = {
      ...current,
      ...patch,
      stateVersion: STATE_VERSION,
      updatedAt: new Date().toISOString()
    };
    const filePath = stateFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
    stateCache = next;
    return next;
  };
  const pending = stateWriteQueue.then(write, write);
  stateWriteQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function clearLocalLicenseState() {
  stateCache = {};
  activeLicenseCache = null;
  try {
    await fs.rm(stateFilePath(), { force: true });
  } catch {}
  return getStoredLicenseStatus({ status: "local_cleared", message: "local license cache cleared" });
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function safeUserName() {
  try {
    return os.userInfo().username || "";
  } catch {
    return "";
  }
}

function environmentValue(name) {
  return String(process.env[name] || "").trim();
}

async function ensureIdentityState() {
  const config = getLicenseConfig();
  let state = await readState();
  const installId = state.installId || crypto.randomUUID();

  const fingerprintMaterial = [
    "chihu-device-license-v1",
    config.appId,
    installId,
    os.platform(),
    os.arch(),
    os.hostname(),
    safeUserName(),
    app.getPath("userData"),
    environmentValue("COMPUTERNAME"),
    environmentValue("USERDOMAIN"),
    environmentValue("PROCESSOR_IDENTIFIER")
  ].join("\n");
  const deviceFingerprint = sha256(fingerprintMaterial);

  const patch = {};
  if (!state.installId) patch.installId = installId;
  if (state.deviceFingerprint !== deviceFingerprint) {
    patch.deviceFingerprint = deviceFingerprint;
    patch.deviceNo = "";
    patch.deviceSignature = "";
    patch.auth = null;
    patch.authSignature = "";
  }

  if (Object.keys(patch).length) {
    state = await writeState(patch);
  }

  return {
    state,
    installId,
    deviceFingerprint
  };
}

function normalizedClientVersion() {
  const version = String(app.getVersion() || "");
  const match = version.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : "1.0.0";
}

function nonce() {
  return `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomBytes(8).toString("hex")}`;
}

function signRequest(secret, endpointPath, timestamp, requestNonce, data) {
  const compactData = JSON.stringify(data || {}).replace(/\s+/g, "");
  const canonical = [
    "POST",
    endpointPath,
    String(timestamp),
    requestNonce,
    compactData
  ].join("\n");
  return crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

async function buildClientRequest(endpointPath, data) {
  const config = getLicenseConfig();
  const identity = await ensureIdentityState();
  const timestamp = Math.floor(Date.now() / 1000);
  const requestNonce = nonce();
  const payload = data || {};
  const signature = signRequest(config.appSecret, endpointPath, timestamp, requestNonce, payload);

  return {
    app_id: config.appId,
    client_version: normalizedClientVersion(),
    platform: config.platform,
    client_instance_id: identity.installId,
    timestamp,
    nonce: requestNonce,
    signature,
    data: payload
  };
}

function licenseError(code, message, details = {}) {
  const error = new Error(message || code || "license error");
  error.name = "LicenseError";
  error.code = code || "LICENSE_ERROR";
  error.details = details;
  return error;
}

function parseResponseData(data) {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return { success: false, code: "LICENSE_RESPONSE_INVALID", message: data };
  }
}

function responseMessage(payload, fallback) {
  if (payload && typeof payload === "object") {
    return payload.message || payload.error || fallback;
  }
  return fallback;
}

async function postClient(endpointPath, data, timeoutMs = 15000) {
  const config = getLicenseConfig();
  if (!config.configured) {
    throw licenseError("LICENSE_CONFIG_MISSING", "授权中心未配置");
  }

  const body = await buildClientRequest(endpointPath, data);
  const response = await nativeHttpRequest({
    url: `${config.apiBaseUrl}${endpointPath}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body,
    timeoutMs,
    persistSetCookie: false
  });
  const payload = parseResponseData(response.data);

  if (!response.ok || !payload || payload.success === false) {
    const code = payload?.code || (response.status ? `HTTP_${response.status}` : "LICENSE_NETWORK_ERROR");
    const message = responseMessage(payload, response.error?.message || "授权中心请求失败");
    throw licenseError(code, message, { status: response.status, payload });
  }

  return payload;
}

function pick(source, snakeKey, camelKey) {
  if (!source || typeof source !== "object") return undefined;
  if (source[snakeKey] !== undefined) return source[snakeKey];
  return source[camelKey];
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function deviceCacheSignature(deviceNo, state) {
  const config = getLicenseConfig();
  if (!config.appSecret || !deviceNo) return "";
  const material = [
    "chihu-device-cache-v1",
    state.installId || "",
    state.deviceFingerprint || "",
    deviceNo
  ].join("\n");
  return crypto.createHmac("sha256", config.appSecret).update(material, "utf8").digest("hex");
}

function authCacheSignature(auth, state) {
  const config = getLicenseConfig();
  if (!config.appSecret || !auth || typeof auth !== "object") return "";
  const material = [
    "chihu-auth-cache-v1",
    state.installId || "",
    state.deviceFingerprint || "",
    state.deviceNo || "",
    stableStringify(auth)
  ].join("\n");
  return crypto.createHmac("sha256", config.appSecret).update(material, "utf8").digest("hex");
}

function timingSafeEqualText(first, second) {
  const firstBuffer = Buffer.from(String(first || ""), "utf8");
  const secondBuffer = Buffer.from(String(second || ""), "utf8");
  return firstBuffer.length === secondBuffer.length && crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function hasValidAuthCache(state) {
  if (!hasValidDeviceCache(state)) return false;
  if (!state?.auth || !state.authSignature) return false;
  const expected = authCacheSignature(state.auth, state);
  return Boolean(expected && timingSafeEqualText(expected, state.authSignature));
}

function hasValidDeviceCache(state) {
  if (!state?.deviceNo || !state.deviceSignature) return false;
  const expected = deviceCacheSignature(state.deviceNo, state);
  return Boolean(expected && timingSafeEqualText(expected, state.deviceSignature));
}

async function writeDeviceState(deviceNo, patch = {}) {
  const current = await readState();
  const signingState = {
    ...current,
    ...patch,
    deviceNo
  };
  return writeState({
    ...patch,
    deviceNo,
    deviceSignature: deviceCacheSignature(deviceNo, signingState),
    deviceSyncedAt: new Date().toISOString()
  });
}

async function writeAuthState(deviceNo, auth, patch = {}) {
  const current = await readState();
  const signingState = {
    ...current,
    ...patch,
    deviceNo,
    auth
  };
  return writeState({
    ...patch,
    deviceNo,
    auth,
    authSignature: authCacheSignature(auth, signingState)
  });
}

function isActiveAuthorization(auth) {
  if (!auth) return false;
  if (auth.isPermanent === true) return auth.allowPaidFeatures !== false;
  if (auth.allowPaidFeatures === true) return true;
  const remainingSeconds = numberOrZero(auth.remainingSeconds);
  const status = String(auth.authStatus || auth.status || "").toLowerCase();
  return remainingSeconds > 0 && (status === "active" || status === "valid");
}

function normalizeAuthPayload(payload, data, extra = {}) {
  const authStatus = pick(data, "auth_status", "authStatus") || extra.authStatus || "";
  const allowPaidFeatures = pick(data, "allow_paid_features", "allowPaidFeatures");
  const remainingSeconds = numberOrZero(pick(data, "remaining_seconds", "remainingSeconds"));
  const isPermanent = Boolean(pick(data, "is_permanent", "isPermanent"));
  const status = {
    status: "checked",
    authStatus,
    allowFreeFeatures: Boolean(pick(data, "allow_free_features", "allowFreeFeatures")),
    allowPaidFeatures: allowPaidFeatures === undefined ? undefined : Boolean(allowPaidFeatures),
    expireAt: pick(data, "expire_at", "expireAt") || null,
    remainingSeconds,
    isPermanent,
    needRedeemOrRenew: Boolean(pick(data, "need_redeem_or_renew", "needRedeemOrRenew")),
    contact: pick(data, "contact", "contact") || "",
    requestId: pick(payload, "request_id", "requestId") || "",
    serverTime: pick(payload, "server_time", "serverTime") || "",
    lastCheckedAt: new Date().toISOString(),
    ...extra
  };
  status.licensed = isActiveAuthorization(status);
  return status;
}

function buildStoredStatus(state, patch = {}) {
  const config = getLicenseConfig();
  const hasDevice = hasValidDeviceCache(state);
  const auth = hasValidAuthCache(state) ? state.auth : {};
  const status = {
    ok: patch.ok ?? true,
    configured: config.configured,
    bypass: config.bypass,
    licensed: false,
    status: auth.status || "unknown",
    reason: patch.reason || "",
    message: patch.message || "",
    deviceNo: hasDevice ? state?.deviceNo || "" : "",
    clientInstanceId: state?.installId || "",
    authStatus: auth.authStatus || "",
    allowPaidFeatures: Boolean(auth.allowPaidFeatures),
    expireAt: auth.expireAt || null,
    remainingSeconds: numberOrZero(auth.remainingSeconds),
    isPermanent: Boolean(auth.isPermanent),
    needRedeemOrRenew: Boolean(auth.needRedeemOrRenew),
    contact: auth.contact || "",
    requestId: auth.requestId || "",
    serverTime: auth.serverTime || "",
    lastCheckedAt: auth.lastCheckedAt || "",
    ...patch
  };

  if (config.bypass) {
    return {
      ...status,
      ok: true,
      configured: true,
      licensed: true,
      status: "bypass",
      authStatus: "active",
      allowPaidFeatures: true,
      message: "development license bypass enabled"
    };
  }

  status.licensed = config.configured && isActiveAuthorization({
    ...auth,
    allowPaidFeatures: status.allowPaidFeatures,
    remainingSeconds: status.remainingSeconds,
    isPermanent: status.isPermanent,
    authStatus: status.authStatus
  });

  if (!config.configured) {
    status.ok = false;
    status.status = "config_missing";
    status.reason = "LICENSE_CONFIG_MISSING";
    status.message = "授权中心未配置";
    status.licensed = false;
    status.allowPaidFeatures = false;
  }

  return status;
}

async function getStoredLicenseStatus(patch = {}) {
  await ensureIdentityState();
  const state = await readState();
  return buildStoredStatus(state, patch);
}

function monotonicNow() {
  return performance.now();
}

function cacheLicenseForIpc(status) {
  if (!status?.licensed) {
    activeLicenseCache = null;
    return;
  }
  const remainingMs = status.isPermanent ? RECENT_CHECK_MS : Math.max(0, Number(status.remainingSeconds || 0) * 1000);
  const ttlMs = Math.min(RECENT_CHECK_MS, remainingMs || 0);
  if (ttlMs <= 0) {
    activeLicenseCache = null;
    return;
  }
  activeLicenseCache = {
    status,
    expiresAt: monotonicNow() + ttlMs
  };
}

function getCachedActiveLicense() {
  if (!activeLicenseCache) return null;
  if (activeLicenseCache.expiresAt <= monotonicNow()) {
    activeLicenseCache = null;
    return null;
  }
  return activeLicenseCache.status;
}

async function ensureDeviceSynced(options = {}) {
  const config = getLicenseConfig();
  if (config.bypass) {
    const identity = await ensureIdentityState();
    const deviceNo = "DEV-BYPASS";
    await writeDeviceState(deviceNo, { installId: identity.installId });
    return { deviceNo, bypass: true };
  }
  if (!config.configured) {
    throw licenseError("LICENSE_CONFIG_MISSING", "授权中心未配置");
  }

  const identity = await ensureIdentityState();
  const state = await readState();
  if (!options.force && hasValidDeviceCache(state)) {
    return { deviceNo: state.deviceNo, isNewDevice: false };
  }

  const payload = await postClient("/client/device/sync", {
    device_fingerprint: identity.deviceFingerprint,
    system_type: config.platform,
    plugin_install_id: identity.installId
  });
  const data = payload.data || {};
  const deviceNo = pick(data, "device_no", "deviceNo");
  if (!deviceNo) {
    throw licenseError("DEVICE_SYNC_INVALID", "设备同步未返回设备编号", { payload });
  }

  const devicePatch = {};
  if (state.deviceNo && state.deviceNo !== deviceNo) {
    devicePatch.auth = null;
    devicePatch.authSignature = "";
    activeLicenseCache = null;
  }
  await writeDeviceState(deviceNo, devicePatch);
  return {
    deviceNo,
    isNewDevice: Boolean(pick(data, "is_new_device", "isNewDevice")),
    requestId: pick(payload, "request_id", "requestId") || "",
    serverTime: pick(payload, "server_time", "serverTime") || ""
  };
}

async function refreshLicenseStatusInternal(args = {}) {
  const config = getLicenseConfig();
  if (config.bypass) return getStoredLicenseStatus({ status: "bypass" });
  const device = await ensureDeviceSynced({ force: true });
  const payload = await postClient("/client/auth/check", {
    auth_object_type: AUTH_OBJECT_TYPE,
    check_scene: args.scene || "startup",
    device_no: device.deviceNo
  });
  const auth = normalizeAuthPayload(payload, payload.data || {});
  await writeAuthState(device.deviceNo, auth);
  const status = await getStoredLicenseStatus({
    ok: true,
    status: auth.licensed ? "active" : auth.authStatus || "unauthorized",
    message: payload.message || ""
  });
  cacheLicenseForIpc(status);
  return status;
}

async function refreshLicenseStatus(args = {}) {
  if (licenseRefreshPromise) return licenseRefreshPromise;
  const pending = refreshLicenseStatusInternal(args);
  licenseRefreshPromise = pending;
  try {
    return await pending;
  } finally {
    if (licenseRefreshPromise === pending) licenseRefreshPromise = null;
  }
}

async function checkLicense(args = {}) {
  try {
    return await refreshLicenseStatus({ scene: args.scene || "startup" });
  } catch (error) {
    const status = await getStoredLicenseStatus({
      ok: false,
      status: "error",
      reason: error.code || "LICENSE_CHECK_FAILED",
      message: error.message || String(error)
    });
    return {
      ...status,
      licensed: false,
      allowPaidFeatures: false
    };
  }
}

async function getLicenseStatus(args = {}) {
  if (args && args.refresh) return checkLicense({ scene: args.scene || "status_refresh" });
  return getStoredLicenseStatus();
}

async function redeemLicense(args = {}) {
  const cardKey = String(args.cardKey || args.card_key || "").trim();
  if (!cardKey) {
    return getStoredLicenseStatus({
      ok: false,
      status: "redeem_error",
      reason: "CARD_KEY_REQUIRED",
      message: "请输入卡密"
    });
  }

  try {
    const device = await ensureDeviceSynced({ force: true });
    const payload = await postClient("/client/card/redeem", {
      card_key: cardKey,
      auth_object_type: AUTH_OBJECT_TYPE,
      device_no: device.deviceNo
    });
    const redeemAuth = normalizeAuthPayload(payload, payload.data || {}, { status: "redeemed" });
    await writeAuthState(device.deviceNo, redeemAuth, { lastRedeemedAt: new Date().toISOString() });
    const redeemedStatus = await getStoredLicenseStatus({
      ok: true,
      status: "redeemed",
      message: "卡密兑换成功，已绑定当前设备。"
    });
    cacheLicenseForIpc(redeemedStatus);
    try {
      return await refreshLicenseStatus({ scene: "after_redeem" });
    } catch (refreshError) {
      return {
        ...redeemedStatus,
        ok: true,
        status: "redeemed_refresh_failed",
        message: `卡密兑换成功，但刷新授权状态失败：${refreshError.message || String(refreshError)}`
      };
    }
  } catch (error) {
    const status = await getStoredLicenseStatus({
      ok: false,
      status: "redeem_error",
      reason: error.code || "CARD_REDEEM_FAILED",
      message: error.message || String(error)
    });
    return {
      ...status,
      licensed: false,
      allowPaidFeatures: false
    };
  }
}

async function requireLicenseForIpc(channel) {
  const config = getLicenseConfig();
  if (config.bypass) return getStoredLicenseStatus({ status: "bypass" });

  const cached = getCachedActiveLicense();
  if (cached) return cached;

  let checked;
  try {
    checked = await refreshLicenseStatus({ scene: "paid_feature" });
  } catch (error) {
    throw licenseError(error.code || "LICENSE_REQUIRED", error.message || "请先兑换设备授权", { channel });
  }

  if (!checked.licensed) {
    throw licenseError(checked.reason || checked.authStatus || "LICENSE_REQUIRED", checked.message || "请先兑换设备授权", { channel, status: checked });
  }

  return checked;
}

module.exports = {
  AUTH_OBJECT_TYPE,
  clearLocalLicenseState,
  ensureDeviceSynced,
  getLicenseConfig,
  getLicenseStatus,
  checkLicense,
  redeemLicense,
  requireLicenseForIpc
};
