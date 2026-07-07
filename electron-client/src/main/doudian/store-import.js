const { runActionList } = require("./operation-executor");
const { policyMessage, policyText } = require("./policies");

const IMPORT_STORE_FALLBACK_ACTIONS = [
  { action: "emitProgress" },
  { action: "copyCookies" },
  { action: "activateStore" },
  { action: "buildStoreRecord" },
  { action: "emitProgress" }
];

async function importOneStore({
  shop,
  index,
  total,
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
}) {
  throwIfCancelled(operation);
  const progressShopId = String(shop.shopId || shop.shopName || "");
  const progressShopName = String(shop.shopName || "");
  const context = {
    shop,
    index,
    total,
    sourcePartition,
    operation,
    adapter,
    partition: "",
    activation: null,
    record: null,
    progressStarted: false,
    progressDone: false
  };

  try {
    await runActionList(adapter, "importStore", context, {
      emitProgress: async (_action, next) => {
        if (!onProgress) return { ok: true };
        if (!next.record) {
          if (next.progressStarted) return { ok: true, skipped: true };
          next.progressStarted = true;
          onProgress({
            phase: "fetch",
            shopId: progressShopId,
            shopName: progressShopName,
            status: "unknown",
            ok: true,
            message: policyMessage(adapter, "importStore.progressMessages.copying", "正在复制登录态"),
            index,
            total
          });
          return { phase: "start" };
        }
        next.progressDone = true;
        onProgress({
          phase: "fetch",
          shopId: next.record.shopId,
          shopName: next.record.shopName,
          status: "online",
          ok: true,
          message: policyMessage(adapter, "importStore.progressMessages.importedOnline", "已复制登录态并确认目标店铺"),
          index,
          total
        });
        return { phase: "done" };
      },
      copyCookies: async (_action, next) => {
        if (!freshShopPartition || !copyCookies) {
          throw new Error("importStore copyCookies action is not available");
        }
        next.partition = freshShopPartition(next.shop, adapter);
        const copyError = await copyCookies(sourcePartition, next.partition);
        if (copyError) throw new Error(copyError.message || String(copyError));
        if (logStoreEvent) {
          logStoreEvent("activate.copyCookies", {
            shopId: next.shop.shopId,
            shopName: next.shop.shopName,
            sourcePartition,
            partition: next.partition
          });
        }
        return { partition: next.partition };
      },
      activateStore: async (_action, next) => {
        if (!activateDoudianStorePartition) {
          throw new Error("importStore activateStore action is not available");
        }
        if (!next.partition) throw new Error("importStore activateStore requires copyCookies action");
        next.activation = await activateDoudianStorePartition(next.shop, next.partition, operation, adapter);
        if (!next.activation.ok) {
          throw new Error(
            next.activation.message ||
              next.activation.switchResult?.reason ||
              "未能自动切换到目标店铺"
          );
        }
        return { ok: true };
      },
      buildStoreRecord: async (_action, next) => {
        if (!next.partition || !next.activation) {
          throw new Error("importStore buildStoreRecord requires activation result");
        }
        const confirmedShop = next.activation.detected?.currentShop || {
          shopId: next.activation.shopUserInfo?.id || next.shop.shopId,
          shopName: next.activation.shopUserInfo?.shop_name || next.shop.shopName,
          operateStatus: next.activation.shopUserInfo?.operateStatusStr || next.shop.operateStatus || "",
          rawSummary: next.activation.shopUserInfo?.raw || next.shop.rawSummary
        };
        const record = buildStoreRecord(confirmedShop, next.partition, policyText(adapter, "importStore.recordStatus", "online"), adapter);
        if (next.activation.shopUserInfo?.raw) {
          record.shopInfoSummary = next.activation.shopUserInfo.raw;
          record.operateStatus = next.activation.shopUserInfo.operateStatusStr || record.operateStatus;
        }
        next.record = record;
        return { shopId: record.shopId, shopName: record.shopName };
      }
    }, IMPORT_STORE_FALLBACK_ACTIONS);

    if (!context.record) throw new Error("店铺导入计划未生成店铺记录");
    if (onProgress && !context.progressDone) {
      onProgress({
        phase: "fetch",
        shopId: context.record.shopId,
        shopName: context.record.shopName,
        status: "online",
        ok: true,
        message: policyMessage(adapter, "importStore.progressMessages.importedOnline", "已复制登录态并确认目标店铺"),
        index,
        total
      });
    }
    return { imported: context.record, failed: null };
  } catch (error) {
    const failure = buildStoreFailure(shop, error, {
      index,
      total,
      diagnostic: {
        source: policyText(adapter, "importStore.failureDiagnosticSource", "doudian-import"),
        roleName: shop.shopName || "",
        raw: safeError(error)
      }
    }, adapter);
    if (onProgress) {
      onProgress({
        phase: "fetch",
        shopId: failure.shopId,
        shopName: failure.shopName,
        status: "offline",
        ok: false,
        message: failure.message,
        reason: failure.reason,
        category: failure.category,
        index: failure.index,
        total: failure.total
      });
    }
    return { imported: null, failed: failure };
  }
}

module.exports = { importOneStore };
