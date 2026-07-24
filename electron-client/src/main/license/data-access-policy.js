const PAID_TASK_TYPES = new Set([
  "opportunityReportScan",
  "opportunityReportAction",
  "opportunityPipelineSubmit",
  "opportunityAutoFavorites",
  "opportunityFavoriteRecords",
  "opportunityFavoriteCancel",
  "opportunityFavoritesClearInvalid",
  "opportunityFavoriteCategories",
  "marketingTask",
  "marketingReconcile"
]);

function dataStoreName(args = {}) {
  return String(args.storeName || args.store || args.record?.storeName || "").trim();
}

function dataAction(channel) {
  if (String(channel || "").startsWith("native:data:records:putLarge:")) return "write";
  const command = String(channel || "").split(":").pop() || "";
  if (/delete|cleanup/i.test(command)) return "delete";
  if (/put|save|record|acquire|claim|finish|cancel|report|invalidate|tombstone|upsert|heartbeat/i.test(command)) return "write";
  return "read";
}

function recordSelector(args = {}) {
  return String(args.id || args.recordId || args.record?.id || args.recordIdPrefix || args.prefix || "");
}

function recordSelectors(args = {}) {
  const values = [args.id, args.recordId, args.record?.id, args.recordIdPrefix, args.prefix];
  if (Array.isArray(args.ids)) values.push(...args.ids);
  if (Array.isArray(args.records)) values.push(...args.records.map((record) => record?.id));
  return [...new Set(values.map((value) => String(value || "")).filter(Boolean))];
}

function paidDataRequest(channel, args = {}) {
  const storeName = dataStoreName(args);
  const id = recordSelector(args);
  const scheduleRecord = id.startsWith("marketing:schedule:");
  if (channel.startsWith("native:data:opportunityAttempts:")) return true;
  if (["native:data:features:saveOpportunityRun", "native:data:features:loadOpportunityCandidates", "native:data:catalog:summarizeOpportunityRunMutations"].includes(channel)) return true;
  if (storeName.startsWith("opportunity_")) return true;
  if (storeName === "remote_feature_records_v1") return !scheduleRecord;
  if (storeName === "operations") {
    const taskType = String(args.taskType || args.record?.taskType || "");
    if (taskType) return PAID_TASK_TYPES.has(taskType);
    if (/^(marketing|opportunity)/i.test(id)) return true;
    if (/queryOperations|list|queryByPrefix|latest/.test(channel)) return true;
  }
  return false;
}

function wildcardMatch(pattern, value) {
  if (pattern === value || pattern === "*") return true;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return false;
}

function requestShopIds(args = {}) {
  const values = [args.shopId, args.record?.shopId];
  for (const key of ["shops", "stores", "records", "attempts", "mutations"]) {
    if (Array.isArray(args[key])) values.push(...args[key].map((item) => item?.shopId));
  }
  return [...new Set(values.map((value) => String(value || "")).filter(Boolean))];
}

function storeIdentityAllowed(context, channel, storeName, action, args) {
  const allowedShopIds = new Set((context.allowedStoreRefs || []).map((item) => String(item?.shopId || "")).filter(Boolean));
  if (storeName === "stores" && action !== "read") {
    if (context.taskType === "fetchDoudianStores") return true;
    const ids = recordSelectors(args);
    return ids.length === 0 || ids.every((id) => allowedShopIds.has(id));
  }
  // Opportunity attempt maintenance intentionally spans the ledger for migration and quota dedupe.
  if (!/^native:data:(?:stores|catalog|catalogJobs):/.test(channel)) return true;
  const shopIds = requestShopIds(args);
  return shopIds.length === 0 || shopIds.every((shopId) => allowedShopIds.has(shopId));
}

function runnerDataAllowed(context, channel, args) {
  const storeName = dataStoreName(args);
  const action = dataAction(channel);
  const recordIds = recordSelectors(args);
  const taskType = String(args.taskType || args.record?.taskType || "");
  const scopeAllowed = context.allowedDataScopes.some((scope) => (
    (!scope.storeName || scope.storeName === storeName) &&
    (!scope.recordIds?.length || (recordIds.length > 0 && recordIds.every((recordId) => scope.recordIds.includes(recordId)))) &&
    (!scope.recordIdPrefixes?.length || (recordIds.length > 0 && recordIds.every((recordId) => scope.recordIdPrefixes.some((prefix) => recordId.startsWith(prefix))))) &&
    (!scope.taskTypes?.length || scope.taskTypes.includes(taskType)) &&
    scope.actions.includes(action) &&
    scope.commands.some((command) => wildcardMatch(command, channel))
  ));
  return scopeAllowed && storeIdentityAllowed(context, channel, storeName, action, args);
}

module.exports = {
  dataStoreName,
  paidDataRequest,
  runnerDataAllowed
};
