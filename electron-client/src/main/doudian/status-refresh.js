const { runActionList } = require("./operation-executor");
const {
  matchesAnyCode,
  matchesPatternList,
  policyArray,
  policyMessage,
  policyText
} = require("./policies");

const REFRESH_STORE_FALLBACK_ACTIONS = [
  { action: "emitProgress" },
  { action: "getShopUserInfo" },
  { action: "classifyFailure", optional: true, onError: "continue" },
  { action: "emitProgress" }
];

function stringifySignal(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return String(value || "");
  }
}

function hasLoginExpiredSignal(shopUserInfo, message = "", adapter = null) {
  const responses = shopUserInfo?.responses || {};
  const codes = [
    responses.shopList?.code,
    responses.currentShop?.code
  ].map((code) => String(code || ""));
  const text = `${stringifySignal(responses)} ${message}`.toLowerCase();
  const signalCodes = policyArray(adapter, "refreshStatus.explicitOfflineSignals.codes", ["10008"]);
  const signalPatterns = policyArray(adapter, "refreshStatus.explicitOfflineSignals.patterns", [
    "未登录",
    "请登录",
    "登录组织",
    "login",
    "not.?login",
    "unauthorized",
    "forbidden"
  ]);
  return matchesAnyCode(signalCodes, codes) || matchesPatternList(text, signalPatterns);
}

function buildRefreshOutcome(store, next, adapter = null) {
  const now = new Date().toISOString();
  const currentShopId = next.shopUserInfo?.id ? String(next.shopUserInfo.id) : "";
  const online = !!currentShopId && currentShopId === String(store.shopId);
  const explicitOffline = !online && hasLoginExpiredSignal(next.shopUserInfo, next.message, adapter);
  const onlineStatus = policyText(adapter, "refreshStatus.statuses.online", "online");
  const offlineStatus = policyText(adapter, "refreshStatus.statuses.offline", "offline");
  const checkFailedStatus = policyText(adapter, "refreshStatus.statuses.checkFailed", "check_failed");
  const status = online ? onlineStatus : explicitOffline ? offlineStatus : checkFailedStatus;
  const offlineReason = policyText(adapter, "refreshStatus.failureReasons.offline", "login-offline");
  const checkFailedReason = policyText(adapter, "refreshStatus.failureReasons.checkFailed", "check-failed");
  const failureReason = online ? "" : next.failure?.reason || (explicitOffline ? offlineReason : checkFailedReason);
  const offlineMessage = policyMessage(adapter, "refreshStatus.messages.offline", "登录失效，请重新登录");
  const checkFailedMessage = policyMessage(adapter, "refreshStatus.messages.checkFailed", "校验失败，已保留本地店铺台账，请按需重新获取或单店修复");
  const failureMessage = online
    ? ""
    : next.failure?.message || next.message || (explicitOffline ? offlineMessage : checkFailedMessage);
  const lastResult = online
    ? policyText(adapter, "refreshStatus.results.online", "登录有效")
    : explicitOffline
      ? policyText(adapter, "refreshStatus.results.offline", "登录失效")
      : policyText(adapter, "refreshStatus.results.checkFailed", "待复核");
  const message = online
    ? policyMessage(adapter, "refreshStatus.messages.online", "登录有效")
    : explicitOffline
      ? (failureMessage || offlineMessage)
      : checkFailedMessage;

  return {
    updatedStore: {
      ...store,
      status,
      lastOnlineAt: online ? now : store.lastOnlineAt || "",
      lastCheckStatus: online ? "ok" : explicitOffline ? offlineStatus : checkFailedStatus,
      lastCheckMessage: message,
      lastResult,
      lastResultAt: now,
      lastFailureReason: failureReason,
      lastFailureMessage: failureMessage,
      lastLoginCheckAt: now
    },
    detail: {
      shopId: store.shopId,
      shopName: store.shopName,
      status,
      ok: online,
      message,
      reason: failureReason,
      category: online ? "" : next.failure?.category || (explicitOffline
        ? policyText(adapter, "refreshStatus.failureCategories.offline", "login")
        : policyText(adapter, "refreshStatus.failureCategories.checkFailed", "check")),
      index: next.index,
      total: next.total
    }
  };
}

async function refreshOneStore({
  store,
  index,
  total,
  operation,
  adapter,
  onProgress,
  getShopUserInfo,
  classifyStoreFailure,
  logStoreEvent,
  summarizeShopUserInfo,
  throwIfCancelled,
  isCancelError
}) {
  throwIfCancelled(operation);
  const context = {
    store,
    index,
    total,
    operation,
    adapter,
    shopUserInfo: null,
    online: false,
    message: "",
    failure: null,
    updatedStore: null,
    detail: null,
    progressStarted: false,
    progressDone: false
  };

  try {
    await runActionList(adapter, "refreshStore", context, {
      emitProgress: async (_action, next) => {
        if (!onProgress) return { ok: true };
        if (!next.detail) {
          if (next.progressStarted) return { ok: true, skipped: true };
          next.progressStarted = true;
          onProgress({
            phase: "refresh",
            shopId: store.shopId,
            shopName: store.shopName,
            status: "unknown",
            ok: true,
            message: policyMessage(adapter, "refreshStatus.messages.checking", "正在校验已保存登录态"),
            index,
            total
          });
          return { phase: "start" };
        }
        next.progressDone = true;
        onProgress({ phase: "refresh", ...next.detail });
        return { phase: "done" };
      },
      getShopUserInfo: async (_action, next) => {
        next.shopUserInfo = await getShopUserInfo(store.partition, operation, null, adapter);
        next.online = !!next.shopUserInfo?.id && String(next.shopUserInfo.id) === String(store.shopId);
        next.message = next.online
          ? policyMessage(adapter, "refreshStatus.messages.online", "登录有效")
          : policyMessage(adapter, "refreshStatus.messages.targetMissing", "当前分区未返回目标店铺");
        return {
          online: next.online,
          shopUserInfo: summarizeShopUserInfo(next.shopUserInfo)
        };
      },
      classifyFailure: async (_action, next) => {
        next.index = index;
        next.total = total;
        next.failure = next.online ? null : classifyStoreFailure(next.message, "check-failed", adapter);
        const outcome = buildRefreshOutcome(store, next, adapter);
        next.updatedStore = outcome.updatedStore;
        next.detail = outcome.detail;
        return {
          reason: next.failure?.reason || "",
          category: next.failure?.category || ""
        };
      }
    }, REFRESH_STORE_FALLBACK_ACTIONS);

    if (!context.shopUserInfo) {
      throw new Error("refreshStore plan did not run getShopUserInfo");
    }
    if (!context.failure && !context.online) {
      context.failure = classifyStoreFailure(context.message || "当前分区未返回目标店铺", "check-failed", adapter);
    }

    logStoreEvent("refresh.getShopUserInfo", {
      shopId: store.shopId,
      shopName: store.shopName,
      online: context.online,
      method: "doudian-get-shop-user-info",
      partition: store.partition,
      shopUserInfo: summarizeShopUserInfo(context.shopUserInfo)
    });

    if (!context.updatedStore || !context.detail) {
      context.index = index;
      context.total = total;
      const outcome = buildRefreshOutcome(store, context, adapter);
      context.updatedStore = outcome.updatedStore;
      context.detail = outcome.detail;
    }
    if (onProgress && !context.progressDone) onProgress({ phase: "refresh", ...context.detail });
    return { store: context.updatedStore, detail: context.detail };
  } catch (error) {
    if (isCancelError(error)) throw error;
    const failure = classifyStoreFailure(error, policyText(adapter, "refreshStatus.failureReasons.refreshFailed", "refresh-failed"), adapter);
    const rawErrorMessage = error?.message || String(error || "");
    const explicitOffline = hasLoginExpiredSignal(null, failure.message || rawErrorMessage, adapter);
    const status = explicitOffline
      ? policyText(adapter, "refreshStatus.statuses.offline", "offline")
      : policyText(adapter, "refreshStatus.statuses.checkFailed", "check_failed");
    const now = new Date().toISOString();
    const message = explicitOffline
      ? (failure.message || policyMessage(adapter, "refreshStatus.messages.offline", "登录失效，请重新登录"))
      : policyMessage(adapter, "refreshStatus.messages.checkFailed", "校验失败，已保留本地店铺台账，请按需重新获取或单店修复");
    const updatedStore = {
      ...store,
      status,
      lastOnlineAt: store.lastOnlineAt || "",
      lastCheckStatus: status,
      lastCheckMessage: message,
      lastResult: explicitOffline
        ? policyText(adapter, "refreshStatus.results.offline", "登录失效")
        : policyText(adapter, "refreshStatus.results.checkFailed", "待复核"),
      lastResultAt: now,
      lastFailureReason: failure.reason,
      lastFailureMessage: failure.message || message,
      lastLoginCheckAt: now
    };
    const detail = {
      shopId: store.shopId,
      shopName: store.shopName,
      status,
      ok: false,
      message,
      reason: failure.reason,
      category: failure.category,
      index,
      total
    };
    if (onProgress) onProgress({ phase: "refresh", ...detail });
    return { store: updatedStore, detail };
  }
}

module.exports = { refreshOneStore };
