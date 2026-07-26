const { app, ipcMain } = require("electron");
const { getNativeDataService } = require("../database");
const { notifyOpportunityHistoryPrewarm, nudgeOpportunitySubmitRecovery } = require("../tasks/task-manager");

function service() {
  return getNativeDataService({ app });
}

function request(method, priority) {
  return async (_event, args = {}) => service().request(method, args || {}, { priority });
}

function storeWriteRequest(method) {
  return async (_event, args = {}) => {
    const result = await service().request(method, args || {}, { priority: "write" });
    if (String(args.storeName || args.store || "") !== "stores") return result;
    const records = method === "records.putMany" ? args.records : [args.record];
    const shopIds = [...new Set((Array.isArray(records) ? records : [])
      .filter((record) => record && record.status === "online")
      .map((record) => String(record.shopId || record.id || ""))
      .filter(Boolean))];
    if (shopIds.length) {
      await nudgeOpportunitySubmitRecovery(["login_wait"], {
        shopIds,
        recoverySource: "store-login-restored"
      });
      notifyOpportunityHistoryPrewarm("store-login-restored");
    }
    return result;
  };
}

function registerBusinessDatabaseHandlers() {
  ipcMain.handle("native:data:maintenance:getHealth", request("maintenance.getHealth", "interactive"));
  ipcMain.handle("native:data:maintenance:quickCheck", request("maintenance.quickCheck", "maintenance"));
  ipcMain.handle("native:data:maintenance:listTables", request("maintenance.listTables", "interactive"));
  ipcMain.handle("native:data:maintenance:createBackup", request("maintenance.createBackup", "maintenance"));
  ipcMain.handle("native:data:maintenance:recoverOpenJobs", request("maintenance.recoverOpenJobs", "maintenance"));

  ipcMain.handle("native:data:stores:upsertIdentity", request("stores.upsertIdentity", "write"));
  ipcMain.handle("native:data:stores:assertActiveIdentity", request("stores.assertActiveIdentity", "interactive"));
  ipcMain.handle("native:data:stores:tombstoneIdentity", request("stores.tombstoneIdentity", "write"));

  ipcMain.handle("native:data:records:put", storeWriteRequest("records.put"));
  ipcMain.handle("native:data:records:putMany", storeWriteRequest("records.putMany"));
  ipcMain.handle("native:data:records:acquireOperation", request("records.acquireOperation", "write"));
  ipcMain.handle("native:data:records:claimOpportunitySubmitTask", request("records.claimOpportunitySubmitTask", "write"));
  ipcMain.handle("native:data:records:putLarge:start", request("records.putLarge.start", "write"));
  ipcMain.handle("native:data:records:putLarge:chunk", request("records.putLarge.chunk", "write"));
  ipcMain.handle("native:data:records:putLarge:commit", request("records.putLarge.commit", "write"));
  ipcMain.handle("native:data:records:putLarge:abort", request("records.putLarge.abort", "write"));
  ipcMain.handle("native:data:records:get", request("records.get", "interactive"));
  ipcMain.handle("native:data:records:getMany", request("records.getMany", "interactive"));
  ipcMain.handle("native:data:records:list", request("records.list", "interactive"));
  ipcMain.handle("native:data:records:queryByPrefix", request("records.queryByPrefix", "interactive"));
  ipcMain.handle("native:data:records:latest", request("records.latest", "interactive"));
  ipcMain.handle("native:data:records:queryOperations", request("records.queryOperations", "interactive"));
  ipcMain.handle("native:data:records:cleanupOperations", request("records.cleanupOperations", "write"));
  ipcMain.handle("native:data:records:delete", request("records.delete", "write"));
  ipcMain.handle("native:data:records:deleteMany", request("records.deleteMany", "write"));

  ipcMain.handle("native:data:opportunitySubmit:claimSchedulerLease", request("opportunitySubmit.claimSchedulerLease", "write"));
  ipcMain.handle("native:data:opportunitySubmit:releaseSchedulerLease", request("opportunitySubmit.releaseSchedulerLease", "write"));
  ipcMain.handle("native:data:opportunitySubmit:admit", request("opportunitySubmit.admit", "write"));
  ipcMain.handle("native:data:opportunitySubmit:consumeHttpGrant", request("opportunitySubmit.consumeHttpGrant", "write"));
  ipcMain.handle("native:data:opportunitySubmit:resolve", request("opportunitySubmit.resolve", "write"));
  ipcMain.handle("native:data:opportunitySubmit:releaseReservation", request("opportunitySubmit.releaseReservation", "write"));
  ipcMain.handle("native:data:opportunitySubmit:getQuotaUsage", request("opportunitySubmit.getQuotaUsage", "interactive"));
  ipcMain.handle("native:data:opportunitySubmit:summarizeRun", request("opportunitySubmit.summarizeRun", "interactive"));

  ipcMain.handle("native:data:opportunityAttempts:putMany", request("opportunityAttempts.putMany", "write"));
  ipcMain.handle("native:data:opportunityAttempts:count", request("opportunityAttempts.count", "interactive"));
  ipcMain.handle("native:data:opportunityAttempts:listDedupeKeys", request("opportunityAttempts.listDedupeKeys", "interactive"));
  ipcMain.handle("native:data:opportunityAttempts:findDedupeKeys", request("opportunityAttempts.findDedupeKeys", "interactive"));
  ipcMain.handle("native:data:opportunityAttempts:cleanup", request("opportunityAttempts.cleanup", "write"));

  ipcMain.handle("native:data:catalogJobs:acquire", request("catalogJobs.acquire", "write"));
  ipcMain.handle("native:data:catalogJobs:reportPage", request("catalogJobs.reportPage", "write"));
  ipcMain.handle("native:data:catalogJobs:finish", request("catalogJobs.finish", "write"));
  ipcMain.handle("native:data:catalogJobs:cancel", request("catalogJobs.cancel", "write"));
  ipcMain.handle("native:data:catalogJobs:get", request("catalogJobs.get", "interactive"));
  ipcMain.handle("native:data:catalogJobs:heartbeat", request("catalogJobs.heartbeat", "heartbeat"));

  ipcMain.handle("native:data:catalog:queryHeadMembersPage", request("catalog.queryHeadMembersPage", "interactive"));
  ipcMain.handle("native:data:catalog:queryLastObservedPage", request("catalog.queryLastObservedPage", "interactive"));
  ipcMain.handle("native:data:catalog:getProductsByIds", request("catalog.getProductsByIds", "interactive"));
  ipcMain.handle("native:data:catalog:recordLiveObservations", request("catalog.recordLiveObservations", "write"));
  ipcMain.handle("native:data:catalog:recordMutationResults", request("catalog.recordMutationResults", "write"));
  ipcMain.handle("native:data:catalog:summarizeOpportunityRunMutations", request("catalog.summarizeOpportunityRunMutations", "interactive"));
  ipcMain.handle("native:data:catalog:confirmMutations", request("catalog.confirmMutations", "write"));
  ipcMain.handle("native:data:catalog:invalidateCoverage", request("catalog.invalidateCoverage", "write"));

  ipcMain.handle("native:data:features:saveStaleRun", request("features.saveStaleRun", "write"));
  ipcMain.handle("native:data:features:loadStaleCandidates", request("features.loadStaleCandidates", "interactive"));
  ipcMain.handle("native:data:features:saveBulkRun", request("features.saveBulkRun", "write"));
  ipcMain.handle("native:data:features:loadBulkCandidates", request("features.loadBulkCandidates", "interactive"));
  ipcMain.handle("native:data:features:saveOpportunityRun", request("features.saveOpportunityRun", "write"));
  ipcMain.handle("native:data:features:loadOpportunityCandidates", request("features.loadOpportunityCandidates", "interactive"));
}

module.exports = { registerBusinessDatabaseHandlers };
