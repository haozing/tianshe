function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function storeIdentity(store) {
  return {
    tenantId: String(store?.tenantId || "local-user"),
    shopId: String(store?.shopId || store?.id || ""),
    storeGeneration: Math.max(0, Number(store?.storeGeneration || 0))
  };
}

function matchingHistorySync(store, syncRecords) {
  const identity = storeIdentity(store);
  return syncRecords.find((record) =>
    String(record?.tenantId || "local-user") === identity.tenantId &&
    String(record?.shopId || "") === identity.shopId &&
    Number(record?.storeGeneration || 0) === identity.storeGeneration
  ) || null;
}

function opportunityHistoryPrewarmDueAt(store, syncRecord, options = {}) {
  const intervalMs = Math.max(60_000, Number(options.intervalMs || 6 * 60 * 60 * 1000));
  const retryMs = Math.max(30_000, Number(options.retryMs || 5 * 60 * 1000));
  const lastAttemptAt = timestamp(options.lastAttemptAt);
  if (String(store?.status || "") !== "online") return null;
  if (!syncRecord) return lastAttemptAt ? lastAttemptAt + retryMs : 0;
  if (syncRecord.initialized === true && String(syncRecord.status || "") === "complete") {
    const completedAt = timestamp(syncRecord.lastSuccessfulSyncAt || syncRecord.updatedAt);
    return Math.max(completedAt ? completedAt + intervalMs : 0, lastAttemptAt ? lastAttemptAt + retryMs : 0);
  }
  const failedAt = timestamp(syncRecord.updatedAt);
  return Math.max(failedAt ? failedAt + retryMs : 0, lastAttemptAt ? lastAttemptAt + retryMs : 0);
}

function dueOpportunityHistoryPrewarmStores(stores, syncRecords, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const lastAttemptByShopId = options.lastAttemptByShopId instanceof Map ? options.lastAttemptByShopId : new Map();
  return stores
    .map((store) => {
      const shopId = storeIdentity(store).shopId;
      const sync = matchingHistorySync(store, syncRecords);
      const dueAt = opportunityHistoryPrewarmDueAt(store, sync, {
        ...options,
        lastAttemptAt: lastAttemptByShopId.get(shopId)
      });
      return { store, sync, dueAt };
    })
    .filter((item) => item.dueAt !== null && item.dueAt <= nowMs)
    .sort((left, right) => {
      const leftInitial = left.sync?.initialized === true ? 1 : 0;
      const rightInitial = right.sync?.initialized === true ? 1 : 0;
      return leftInitial - rightInitial || left.dueAt - right.dueAt || storeIdentity(left.store).shopId.localeCompare(storeIdentity(right.store).shopId);
    })
    .map((item) => item.store);
}

function nextOpportunityHistoryPrewarmWakeAt(stores, syncRecords, options = {}) {
  const lastAttemptByShopId = options.lastAttemptByShopId instanceof Map ? options.lastAttemptByShopId : new Map();
  const wakeTimes = stores.flatMap((store) => {
    const shopId = storeIdentity(store).shopId;
    const dueAt = opportunityHistoryPrewarmDueAt(store, matchingHistorySync(store, syncRecords), {
      ...options,
      lastAttemptAt: lastAttemptByShopId.get(shopId)
    });
    return dueAt === null ? [] : [dueAt];
  });
  return wakeTimes.length ? Math.min(...wakeTimes) : null;
}

module.exports = {
  dueOpportunityHistoryPrewarmStores,
  matchingHistorySync,
  nextOpportunityHistoryPrewarmWakeAt,
  opportunityHistoryPrewarmDueAt
};
