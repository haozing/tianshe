const { app, ipcMain } = require("electron");
const { getNativeDataService } = require("../database");

function service() {
  return getNativeDataService({ app });
}

function request(method, priority) {
  return async (_event, args = {}) => service().request(method, args || {}, { priority });
}

function registerBusinessDatabaseHandlers() {
  ipcMain.handle("native:data:maintenance:getHealth", request("maintenance.getHealth", "interactive"));
  ipcMain.handle("native:data:maintenance:quickCheck", request("maintenance.quickCheck", "maintenance"));
  ipcMain.handle("native:data:maintenance:listTables", request("maintenance.listTables", "interactive"));
  ipcMain.handle("native:data:maintenance:createBackup", request("maintenance.createBackup", "maintenance"));
  ipcMain.handle("native:data:maintenance:recoverOpenJobs", request("maintenance.recoverOpenJobs", "maintenance"));

  ipcMain.handle("native:data:stores:upsertIdentity", request("stores.upsertIdentity", "write"));
  ipcMain.handle("native:data:stores:tombstoneIdentity", request("stores.tombstoneIdentity", "write"));

  ipcMain.handle("native:data:records:put", request("records.put", "write"));
  ipcMain.handle("native:data:records:putLarge:start", request("records.putLarge.start", "write"));
  ipcMain.handle("native:data:records:putLarge:chunk", request("records.putLarge.chunk", "write"));
  ipcMain.handle("native:data:records:putLarge:commit", request("records.putLarge.commit", "write"));
  ipcMain.handle("native:data:records:putLarge:abort", request("records.putLarge.abort", "write"));
  ipcMain.handle("native:data:records:get", request("records.get", "interactive"));
  ipcMain.handle("native:data:records:list", request("records.list", "interactive"));
  ipcMain.handle("native:data:records:delete", request("records.delete", "write"));

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
