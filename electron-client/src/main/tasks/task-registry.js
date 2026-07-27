const FORBIDDEN_PARAM_KEYS = new Set([
  "accessTier",
  "adapter",
  "adapterVersion",
  "allowedDataScopes",
  "allowedPlanKeys",
  "config",
  "cookie",
  "cookies",
  "doudianAdapter",
  "headers",
  "method",
  "mutation",
  "origin",
  "partition",
  "preload",
  "requestPlan",
  "requestPlans",
  "ruleVersion",
  "script",
  "scripts",
  "url"
]);

function scopes(storeNames, actions = ["read", "write"]) {
  return storeNames.map((storeName) => ({ commands: ["native:data:records:*"], storeName, actions }));
}

function commandScope(commands, actions = ["read", "write", "delete", "reconcile"]) {
  return { commands, actions };
}

const STORE_LEDGER_READ_SCOPES = scopes(["stores", "groups"], ["read"]);
const STORE_LEDGER_WRITE_SCOPES = scopes(["stores", "groups"], ["read", "write", "delete"]);
const STORE_DELETE_CACHE_SCOPES = scopes(["business_latest", "funds_latest", "violations_latest"], ["read", "delete"]);
const CATALOG_IDENTITY_SCOPES = [commandScope(["native:data:stores:upsertIdentity", "native:data:stores:assertActiveIdentity", "native:data:catalog:*"])];
const STORE_ASSERT_SCOPE = [commandScope(["native:data:stores:assertActiveIdentity"], ["read"] )];
const CATALOG_JOB_SCOPES = [commandScope(["native:data:stores:upsertIdentity", "native:data:catalogJobs:*"], ["read", "write"] )];
const OPPORTUNITY_ATTEMPT_SCOPES = [commandScope(["native:data:opportunityAttempts:*"])];
const OPPORTUNITY_SUBMIT_COORDINATION_SCOPES = [commandScope(["native:data:opportunitySubmit:*"])];
const OPPORTUNITY_RUNTIME_SCOPES = [{
  commands: ["native:data:records:*"],
  storeName: "runtime_meta",
  recordIds: ["opportunity-submit-attempts-v2-migration", "opportunity-retention-v1"],
  actions: ["read", "write"]
}];
const OPPORTUNITY_DATA_STORES = ["opportunity_clue_scan_runs_v1", "opportunity_clue_candidates_v1", "opportunity_product_scan_runs_v1", "opportunity_product_candidates_v1", "opportunity_prematch_runs_v1", "opportunity_prematch_candidates_v1", "opportunity_execute_runs_v1", "opportunity_submit_attempts_v1", "opportunity_pipeline_runs_v2", "opportunity_pipeline_store_runs_v2", "opportunity_store_category_snapshots_v2", "opportunity_store_category_ledger_v2", "opportunity_clue_cache_v2", "opportunity_clue_cache_shards_v2", "opportunity_clue_word_cache_v2", "opportunity_clue_word_cache_shards_v2", "opportunity_official_clue_words_cache_v1", "opportunity_official_clue_goods_cache_v1", "opportunity_official_clue_goods_cache_shards_v1", "opportunity_benefit_product_indexes_v1", "opportunity_submit_history_records_v1", "opportunity_submit_history_sync_v1", "opportunity_submit_history_product_indexes_v1", "opportunity_pipeline_candidates_v2", "opportunity_pipeline_submit_tasks_v2", "opportunity_pipeline_operation_events_v2"];
const OPPORTUNITY_COORDINATOR_STORES = ["opportunity_submit_rate_state_v1", "opportunity_submit_global_rate_state_v1", "opportunity_submit_attempt_groups_v1", "opportunity_submit_contract_snapshots_v1"];
const OPPORTUNITY_CONTINUATION_STORES = ["opportunity_pipeline_runs_v2", "opportunity_pipeline_store_runs_v2", "opportunity_pipeline_candidates_v2", "opportunity_pipeline_submit_tasks_v2", "opportunity_pipeline_operation_events_v2", "opportunity_submit_history_records_v1", "opportunity_submit_history_sync_v1", "opportunity_submit_history_product_indexes_v1"];
const OPPORTUNITY_PREWARM_STORES = ["opportunity_submit_history_records_v1", "opportunity_submit_history_sync_v1", "opportunity_submit_history_product_indexes_v1", "opportunity_pipeline_operation_events_v2"];

function marketingRecordScopes(actions) {
  return [
    {
      commands: ["native:data:records:*"],
      storeName: "remote_feature_records_v1",
      recordIds: ["marketing:run:{operationId}"],
      actions
    },
    {
      commands: ["native:data:records:*"],
      storeName: "remote_feature_records_v1",
      recordIdPrefixes: ["marketing:attempt:{operationId}:", "marketing:failure-shard:{operationId}:"],
      actions
    }
  ];
}

function recoveryOperationScopes() {
  return [{
    commands: ["native:data:records:*"],
    storeName: "operations",
    recordIds: ["{operationId}"],
    actions: ["read", "write"]
  }];
}

const BUSINESS_PLANS = [
  "currentShop",
  "businessCoreIndex",
  "businessHomepage",
  "businessExperienceOverview",
  "businessWarnTicket",
  "businessSmartActivityCoupon",
  "businessSmartActivityDirectDiscount",
  "businessSmartActivityNewUserBonus",
  "businessCreditScoreBase",
  "businessCreditScoreLevel",
  "businessOnSaleProducts",
  "businessOfflineProducts"
];
const FUNDS_PLANS = ["fundAccountList", "fundAccountOpenInfo", "fundPledgeCash", "fundPledgePayable", "fundShopAwardOverview", "fundCompensateStatistics", "fundBillQuery", "fundAccountCenter", "fundShopDepositPage"];
const VIOLATION_PLANS = ["violationRiskTicketList", "violationPenaltyTicketList"];
const STALE_SCAN_PLANS = ["staleGoodsProductList", "staleGoodsRecommendAdmit", "staleGoodsCompassDownload"];
const STALE_EXECUTE_PLANS = [...STALE_SCAN_PLANS, "staleGoodsBatchOffline", "staleGoodsBatchDelete", "staleGoodsCompleteDelete"];
const BULK_DELETE_PLANS = ["bulkDeleteProductList", "bulkDeleteBatchOnline", "bulkDeleteBatchOffline", "bulkDeleteBatchDelete", "bulkDeleteCompleteDelete"];
const FREIGHT_TEMPLATE_PLANS = ["freightTemplateToken", "freightTemplateList"];
const OPPORTUNITY_SUBMIT_PLANS = ["opportunityClueRealtimeList", "opportunitySubmitHistoryList", "opportunityProductList", "opportunityEditGoodsTitle", "opportunitySubmitClue"];

const MARKETING_PLAN_POLICY = Object.freeze({
  limited_time: Object.freeze({
    load_products: policy(["marketingLimitedTimeProducts"]),
    list: policy(["marketingLimitedTimeList"]),
    detail: policy(["marketingLimitedTimeDetail"]),
    create: policy(["marketingLimitedTimeCreate", "marketingLimitedTimeList", "marketingLimitedTimeSkuDetail", "marketingLimitedTimeCreateValidation"], ["marketingLimitedTimeList"]),
    disable: policy(["marketingLimitedTimeDetail", "marketingLimitedTimeDisable", "marketingLimitedTimeList"], ["marketingLimitedTimeList"]),
    end: policy(["marketingLimitedTimeDetail", "marketingLimitedTimeEnd", "marketingLimitedTimeList"], ["marketingLimitedTimeList"]),
    toggle_renew: policy(["marketingLimitedTimeDetail", "marketingLimitedTimeToggleRenew", "marketingLimitedTimeList"], ["marketingLimitedTimeList"]),
    revive: policy(["marketingLimitedTimeDetail", "marketingLimitedTimeCreate", "marketingLimitedTimeList", "marketingLimitedTimeCreateValidation"], ["marketingLimitedTimeList"]),
    copy: policy(["marketingLimitedTimeDetail", "marketingLimitedTimeCreate", "marketingLimitedTimeList", "marketingLimitedTimeCreateValidation"], ["marketingLimitedTimeList"]),
    bulk_edit: policy(["marketingLimitedTimeDetail", "marketingLimitedTimeEdit", "marketingLimitedTimeList"], ["marketingLimitedTimeList"]),
    remove_products: policy(["marketingLimitedTimeDetail", "marketingLimitedTimeEdit", "marketingLimitedTimeList"], ["marketingLimitedTimeList"]),
    tool_renew: policy(["marketingLimitedTimeDetail", "marketingLimitedTimeCreate", "marketingLimitedTimeList", "marketingLimitedTimeCreateValidation"], ["marketingLimitedTimeList"])
  }),
  new_user_bonus: Object.freeze({
    load_products: policy(["marketingNewUserBonusProducts"]),
    list: policy(["marketingNewUserBonusList"]),
    detail: policy(["marketingNewUserBonusDetail"]),
    create: policy(["marketingNewUserBonusCreatePrecheck", "marketingNewUserBonusCreateExclusivePrecheck", "marketingNewUserBonusProductsValidation", "marketingNewUserBonusCreate", "marketingNewUserBonusList"], ["marketingNewUserBonusList"]),
    disable: policy(["marketingNewUserBonusDetail", "marketingNewUserBonusDisable"], ["marketingNewUserBonusDetail"])
  }),
  general_coupon: Object.freeze({
    load_products: policy(["marketingGeneralCouponProducts"]),
    list: policy(["marketingGeneralCouponListProduct", "marketingGeneralCouponListShop", "marketingGeneralCouponListOwned"]),
    detail: policy(["marketingGeneralCouponDetail"]),
    create: policy(["marketingGeneralCouponCreatePrecheck", "marketingGeneralCouponProductsValidation", "marketingGeneralCouponCreate", "marketingGeneralCouponReconcileList"], ["marketingGeneralCouponReconcileList"]),
    cancel: policy(["marketingGeneralCouponDetail", "marketingGeneralCouponCancel"], ["marketingGeneralCouponDetail"]),
    toggle_renew: policy(["marketingGeneralCouponDetail", "marketingGeneralCouponToggleRenew"], ["marketingGeneralCouponDetail"])
  })
});

const TASK_PARAM_KEYS = Object.freeze({
  fetchDoudianStores: keys("mode", "repairShopIds", "repairShopNames", "sourceOperationId", "timeoutMs"),
  refreshDoudianStoreStatus: keys("shopIds"),
  syncProductCatalog: keys("shopIds", "tenantId", "storeGeneration", "forceRefresh"),
  productFreightTemplates: keys("shopIds"),
  businessData: keys("shopIds", "datePreset", "beginDate", "endDate"),
  fundsData: keys("shopIds", "includeDiagnostics"),
  violationsData: keys("shopIds", "datePreset", "beginDate", "endDate", "processStatus"),
  staleGoodsScan: keys("mode", "shopIds", "rules", "action", "candidateIds", "sourceRunId", "confirmText", "compassFileName", "compassRows", "compassPeriod"),
  staleGoodsExecute: keys("mode", "shopIds", "rules", "action", "candidateIds", "sourceRunId", "confirmText", "compassFileName", "compassRows", "compassPeriod"),
  bulkDeleteScan: keys("mode", "shopIds", "sourceMode", "filters", "action", "protectMode", "candidateIds", "sourceRunId", "allowPartialScan", "confirmText"),
  bulkDeleteExecute: keys("mode", "shopIds", "sourceMode", "filters", "action", "protectMode", "candidateIds", "sourceRunId", "allowPartialScan", "confirmText"),
  opportunityReportScan: keys("mode", "shopIds", "filters", "matchRules", "submitMode", "goodsMatchType", "matchMode", "titleMatchMode", "titleUpdatePosition", "clueIds", "productIds", "candidateIds", "sourceRunId", "productRunId", "clueRunId", "matchRunId", "dailyAttemptLimit", "skipSubmittedClueCategory", "skipSubmittedClue", "skipSubmittedProductInSameClue", "dryRun", "pageSize", "maxPages", "includeCandidates"),
  opportunityReportAction: keys("mode", "shopIds", "filters", "matchRules", "submitMode", "goodsMatchType", "matchMode", "titleMatchMode", "titleUpdatePosition", "clueIds", "productIds", "candidateIds", "sourceRunId", "productRunId", "clueRunId", "matchRunId", "dailyAttemptLimit", "skipSubmittedClueCategory", "skipSubmittedClue", "skipSubmittedProductInSameClue", "dryRun", "pageSize", "maxPages", "includeCandidates"),
  opportunityFavoriteCategories: keys("mode", "shopIds", "storeRefs"),
  opportunityPipelineSubmit: keys("mode", "shopIds", "filters", "matchRules", "submitMode", "goodsMatchType", "matchMode", "titleMatchMode", "titleUpdatePosition", "skipSubmittedClueCategory", "skipSubmittedClue", "skipSubmittedProductInSameClue"),
  opportunitySubmitContinuation: keys("mode", "taskId", "reason"),
  opportunityHistoryPrewarm: keys("mode", "shopIds", "reason"),
  opportunityAutoFavorites: keys("mode", "shopIds", "storeRefs", "favoriteFilters", "filters", "storeFilters", "dryRun"),
  opportunityFavoriteRecords: keys("shopIds", "storeRefs", "taskStatus", "pageSize", "startPage", "maxPages"),
  opportunityFavoriteCancel: keys("shopIds", "storeRefs", "taskIds"),
  opportunityFavoritesClearInvalid: keys("shopIds", "storeRefs"),
  marketingTask: keys("feature", "action", "stores", "context"),
  marketingReconcile: keys("sourceOperationId"),
  mockLongTask: keys("durationMs", "stepMs")
});

const TASK_DEFINITIONS = Object.freeze({
  fetchDoudianStores: definition("free", false, ["shopList", "currentShop"], STORE_LEDGER_WRITE_SCOPES),
  refreshDoudianStoreStatus: definition("free", false, ["currentShop"], STORE_LEDGER_WRITE_SCOPES),
  syncProductCatalog: definition("free", false, ["bulkDeleteProductList"], [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...CATALOG_JOB_SCOPES]),
  productFreightTemplates: definition("free", false, FREIGHT_TEMPLATE_PLANS, STORE_LEDGER_READ_SCOPES),
  businessData: definition("free", false, BUSINESS_PLANS, [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...scopes(["business_latest"])]),
  fundsData: definition("free", false, FUNDS_PLANS, [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...scopes(["funds_latest"])]),
  violationsData: definition("free", false, VIOLATION_PLANS, [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...scopes(["violations_latest"])]),
  staleGoodsScan: definition("free", false, STALE_SCAN_PLANS, [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...scopes(["stale_scan_runs", "stale_candidates", "stale_execute_runs"], ["read", "write", "delete"]), ...CATALOG_IDENTITY_SCOPES]),
  staleGoodsExecute: definition("free", true, STALE_EXECUTE_PLANS, [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...scopes(["stale_scan_runs", "stale_candidates", "stale_execute_runs"], ["read", "write", "delete"]), ...CATALOG_IDENTITY_SCOPES]),
  bulkDeleteScan: definition("free", false, ["bulkDeleteProductList"], [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...scopes(["bulk_delete_scan_runs_v1", "bulk_delete_candidates_v1", "bulk_delete_execute_runs_v1", "bulk_delete_operation_events_v1"], ["read", "write", "delete"]), ...CATALOG_IDENTITY_SCOPES]),
  bulkDeleteExecute: definition("free", true, BULK_DELETE_PLANS, [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...scopes(["bulk_delete_scan_runs_v1", "bulk_delete_candidates_v1", "bulk_delete_execute_runs_v1", "bulk_delete_operation_events_v1"], ["read", "write", "delete"]), ...CATALOG_IDENTITY_SCOPES]),
  opportunityReportScan: definition("paid", false, ["opportunityClueRealtimeList", "opportunitySubmitHistoryList", "opportunityProductList"], [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...scopes(OPPORTUNITY_DATA_STORES, ["read", "write", "delete"]), ...OPPORTUNITY_RUNTIME_SCOPES, ...CATALOG_IDENTITY_SCOPES, ...OPPORTUNITY_ATTEMPT_SCOPES]),
  opportunityReportAction: definition("paid", true, ["opportunityCollectClue"], [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...scopes(OPPORTUNITY_DATA_STORES, ["read", "write", "delete"]), ...OPPORTUNITY_RUNTIME_SCOPES, ...CATALOG_IDENTITY_SCOPES, ...OPPORTUNITY_ATTEMPT_SCOPES]),
  opportunityFavoriteCategories: definition("paid", false, ["opportunityCategoryList"], STORE_LEDGER_READ_SCOPES),
  opportunityPipelineSubmit: definition("paid", true, OPPORTUNITY_SUBMIT_PLANS, [...STORE_LEDGER_WRITE_SCOPES, ...STORE_DELETE_CACHE_SCOPES, ...scopes(OPPORTUNITY_DATA_STORES, ["read", "write", "delete"]), ...scopes(OPPORTUNITY_COORDINATOR_STORES, ["read"]), ...OPPORTUNITY_RUNTIME_SCOPES, ...CATALOG_IDENTITY_SCOPES, ...OPPORTUNITY_ATTEMPT_SCOPES, ...OPPORTUNITY_SUBMIT_COORDINATION_SCOPES]),
  opportunitySubmitContinuation: definition("recovery", true, ["opportunitySubmitHistoryList", "opportunityProductList", "opportunitySubmitClue"], [...STORE_LEDGER_READ_SCOPES, ...STORE_ASSERT_SCOPE, ...scopes(OPPORTUNITY_CONTINUATION_STORES, ["read", "write"]), ...scopes(OPPORTUNITY_COORDINATOR_STORES, ["read"]), ...CATALOG_IDENTITY_SCOPES, ...OPPORTUNITY_ATTEMPT_SCOPES, ...OPPORTUNITY_SUBMIT_COORDINATION_SCOPES]),
  opportunityHistoryPrewarm: definition("paid", false, ["opportunitySubmitHistoryList"], [...STORE_LEDGER_READ_SCOPES, ...STORE_ASSERT_SCOPE, ...scopes(OPPORTUNITY_PREWARM_STORES, ["read", "write"])]),
  opportunityAutoFavorites: definition("paid", true, ["opportunityClueRealtimeList", "opportunityCategoryList", "opportunityCollectClue"], [...STORE_LEDGER_READ_SCOPES, ...STORE_ASSERT_SCOPE]),
  opportunityFavoriteRecords: definition("paid", false, ["opportunityFavoriteAutoSubmitPage"], STORE_LEDGER_READ_SCOPES),
  opportunityFavoriteCancel: definition("paid", true, ["opportunityFavoriteCancel"], [...STORE_LEDGER_READ_SCOPES, ...STORE_ASSERT_SCOPE]),
  opportunityFavoritesClearInvalid: definition("paid", true, ["currentShop", "opportunityFavoriteClearInvalid"], [...STORE_LEDGER_READ_SCOPES, ...STORE_ASSERT_SCOPE]),
  marketingTask: definition("paid", "dynamic", (params) => marketingPolicy(params).plans, [
    ...marketingRecordScopes(["read", "write"]),
    ...STORE_LEDGER_READ_SCOPES,
    ...STORE_ASSERT_SCOPE
  ]),
  marketingReconcile: definition("recovery", false, allMarketingRecoveryPlans(), [
    ...marketingRecordScopes(["read", "write", "reconcile"]),
    ...recoveryOperationScopes(),
    ...STORE_LEDGER_READ_SCOPES
  ]),
  mockLongTask: definition("internal", false, [], [])
});

function keys(...values) {
  return new Set(values);
}

function policy(plans, recoveryPlans = []) {
  return Object.freeze({ plans: Object.freeze([...new Set(plans)]), recoveryPlans: Object.freeze([...new Set(recoveryPlans)]) });
}

function marketingPolicy(params) {
  const feature = String(params?.feature || "");
  const action = String(params?.action || "");
  const selected = MARKETING_PLAN_POLICY[feature]?.[action];
  if (!selected) throw paramsError("marketingTask feature/action is not enabled by the task registry");
  return selected;
}

function allMarketingRecoveryPlans() {
  return [...new Set(Object.values(MARKETING_PLAN_POLICY).flatMap((feature) => Object.values(feature).flatMap((entry) => entry.recoveryPlans)))];
}

function definition(accessTier, mutation, planKeys, allowedDataScopes) {
  return Object.freeze({ accessTier, mutation, planKeys, allowedDataScopes: Object.freeze(allowedDataScopes) });
}

function materializeDataScopes(allowedDataScopes, operationId) {
  const replace = (value) => String(value).replaceAll("{operationId}", operationId);
  return allowedDataScopes.map((scope) => ({
    ...scope,
    commands: [...scope.commands],
    actions: [...scope.actions],
    ...(scope.recordIds ? { recordIds: scope.recordIds.map(replace) } : {}),
    ...(scope.recordIdPrefixes ? { recordIdPrefixes: scope.recordIdPrefixes.map(replace) } : {}),
    ...(scope.taskTypes ? { taskTypes: [...scope.taskTypes] } : {})
  }));
}

function paramsError(message) {
  const error = new Error(message);
  error.code = "TASK_PARAMS_INVALID";
  return error;
}

function validateValue(value, path = "params", depth = 0) {
  if (depth > 12) throw paramsError(`${path} exceeds maximum nesting depth`);
  if (value == null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 1_000_000) throw paramsError(`${path} is too large`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw paramsError(`${path} must be finite`);
    return;
  }
  if (typeof value !== "object") throw paramsError(`${path} contains an unsupported value`);
  if (Array.isArray(value)) {
    if (value.length > 50_000) throw paramsError(`${path} contains too many items`);
    value.forEach((item, index) => validateValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > 500) throw paramsError(`${path} contains too many fields`);
  for (const [key, item] of entries) {
    if (FORBIDDEN_PARAM_KEYS.has(key)) throw paramsError(`${path}.${key} is controlled by the main process`);
    if (/javascript|function|eval|code/i.test(key)) throw paramsError(`${path}.${key} is not an allowed business parameter`);
    validateValue(item, `${path}.${key}`, depth + 1);
  }
}

function validateStringArray(params, key, maxItems = 1000) {
  if (params[key] === undefined) return;
  if (!Array.isArray(params[key]) || params[key].length > maxItems || params[key].some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
    throw paramsError(`${key} must be a bounded string array`);
  }
}

function validateTaskParams(taskType, value) {
  const taskDefinition = TASK_DEFINITIONS[taskType];
  if (!taskDefinition) {
    const error = new Error(`unknown task type: ${taskType}`);
    error.code = "TASK_TYPE_DENIED";
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw paramsError("params must be an object");
  validateValue(value);
  const allowedKeys = TASK_PARAM_KEYS[taskType];
  for (const key of Object.keys(value)) {
    if (!allowedKeys?.has(key)) throw paramsError(`params.${key} is not allowed for ${taskType}`);
  }
  const params = structuredClone(value);
  for (const key of ["shopIds", "repairShopIds", "repairShopNames", "candidateIds", "clueIds", "productIds", "taskIds"]) validateStringArray(params, key);
  const mode = String(params.mode || "");
  if (taskType === "fetchDoudianStores" && mode && !["import", "discover", "login_selected", "discard_discovery"].includes(mode)) throw paramsError("fetchDoudianStores mode is invalid");
  if (taskType === "fetchDoudianStores" && ["login_selected", "discard_discovery"].includes(mode) && !/^[A-Za-z0-9._:-]{1,200}$/.test(String(params.sourceOperationId || ""))) throw paramsError("fetchDoudianStores sourceOperationId is invalid");
  if (taskType === "bulkDeleteScan" && mode && mode !== "scan") throw paramsError("bulkDeleteScan mode must be scan");
  if (taskType === "bulkDeleteExecute" && mode !== "execute") throw paramsError("bulkDeleteExecute mode must be execute");
  if (taskType === "staleGoodsScan" && mode && mode !== "scan") throw paramsError("staleGoodsScan mode must be scan");
  if (taskType === "staleGoodsExecute" && mode !== "execute") throw paramsError("staleGoodsExecute mode must be execute");
  if (taskType === "opportunityReportScan" && !["clue-scan", "product-scan", "product-prematch"].includes(mode)) throw paramsError("opportunityReportScan mode is invalid");
  if (taskType === "opportunityReportAction" && mode !== "collect") throw paramsError("opportunityReportAction mode is invalid");
  if (taskType === "opportunityPipelineSubmit" && mode !== "pipeline-submit") throw paramsError("opportunityPipelineSubmit mode is invalid");
  if (taskType === "opportunitySubmitContinuation" && mode !== "submit-continuation") throw paramsError("opportunitySubmitContinuation mode is invalid");
  if (taskType === "opportunitySubmitContinuation" && !/^[A-Za-z0-9._:-]{1,300}$/.test(String(params.taskId || ""))) throw paramsError("opportunitySubmitContinuation taskId is invalid");
  if (taskType === "opportunityHistoryPrewarm" && mode !== "history-prewarm") throw paramsError("opportunityHistoryPrewarm mode is invalid");
  if (taskType === "marketingTask") {
    marketingPolicy(params);
    if (!Array.isArray(params.stores) || params.stores.length === 0 || params.stores.length > 100) throw paramsError("marketingTask requires a bounded stores array");
  }
  if (params.timeoutMs !== undefined) {
    const timeoutMs = Number(params.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15 * 60_000) throw paramsError("timeoutMs is outside the allowed range");
  }
  return params;
}

function taskMutation(taskDefinition, params) {
  if (taskDefinition.mutation !== "dynamic") return taskDefinition.mutation;
  return !["load_products", "list", "detail"].includes(String(params.action || ""));
}

function declaredPlanKeys(taskDefinition, params) {
  const value = typeof taskDefinition.planKeys === "function" ? taskDefinition.planKeys(params) : taskDefinition.planKeys;
  return Array.isArray(value) ? value : [];
}

function allowedPlanKeys(taskDefinition, adapter, params = {}) {
  const plans = adapter?.requestPlans || {};
  return declaredPlanKeys(taskDefinition, params).filter((key) => Object.prototype.hasOwnProperty.call(plans, key));
}

function recoveryPlanKeys(taskDefinition, adapter, params = {}) {
  if (taskDefinition !== TASK_DEFINITIONS.marketingTask) return [];
  const plans = adapter?.requestPlans || {};
  return marketingPolicy(params).recoveryPlans.filter((key) => Object.prototype.hasOwnProperty.call(plans, key));
}

function platformOrigins(adapter) {
  const origins = new Set();
  const base = String(adapter?.origin || adapter?.homeUrl || "");
  const add = (value) => {
    if (typeof value !== "string" || !value.trim()) return;
    try {
      const url = new URL(value, base || undefined);
      if (["http:", "https:"].includes(url.protocol)) origins.add(url.origin);
    } catch {}
  };
  add(adapter?.origin);
  add(adapter?.loginUrl);
  add(adapter?.homeUrl);
  add(adapter?.chooseEntriesUrl);
  for (const endpoint of Object.values(adapter?.endpoints || {})) add(endpoint);
  return [...origins];
}

function publicTaskCatalog() {
  return Object.fromEntries(Object.entries(TASK_DEFINITIONS).map(([taskType, value]) => [taskType, {
    taskType,
    accessTier: value.accessTier,
    mutation: value.mutation
  }]));
}

module.exports = {
  FORBIDDEN_PARAM_KEYS,
  MARKETING_PLAN_POLICY,
  TASK_DEFINITIONS,
  allowedPlanKeys,
  materializeDataScopes,
  platformOrigins,
  publicTaskCatalog,
  recoveryPlanKeys,
  taskMutation,
  validateTaskParams
};
