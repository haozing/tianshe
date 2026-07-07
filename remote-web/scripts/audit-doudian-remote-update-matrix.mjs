import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const remoteRoot = join(repoRoot, "remote-web");
const adapterPath = join(remoteRoot, "new-remote-web", "config", "doudian-adapter.json");
const servicePath = join(repoRoot, "electron-client", "src", "main", "doudian", "service.js");
const businessDataPagePath = join(remoteRoot, "client-shell", "src", "components", "BusinessDataPage.tsx");
const outputPath = join(remoteRoot, "artifacts", "doudian-remote-update-matrix.json");
const leakageOutputPath = join(remoteRoot, "artifacts", "doudian-local-leakage-audit.json");
const leakageScriptPath = join(remoteRoot, "scripts", "audit-doudian-local-leakage.mjs");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function rel(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, "/");
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item !== "string" || hasText(item));
}

function actionNames(plan) {
  return new Set((Array.isArray(plan?.actions) ? plan.actions : []).map((action) => action?.action).filter(Boolean));
}

function hasActions(plan, required) {
  const names = actionNames(plan);
  return required.every((action) => names.has(action));
}

function hasStringItems(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => hasText(item));
}

function hasBusinessPlanEndpoint(adapter, planKey) {
  const endpointKey = adapter.requestPlans?.[planKey]?.endpointKey;
  return hasText(endpointKey) && hasText(adapter.endpoints?.[endpointKey]);
}

function collectStringIssues(value, path = [], issues = []) {
  if (typeof value === "string") {
    if (value.includes("??") || value.includes("\uFFFD") || value.includes("\u00C3")) {
      issues.push({ path: path.join("."), value });
    }
    return issues;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringIssues(item, path.concat(index), issues));
    return issues;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, next]) => collectStringIssues(next, path.concat(key), issues));
  }
  return issues;
}

function collectBusinessOperationRequestPlans(adapter) {
  const actions = Array.isArray(adapter.operationPlans?.fetchBusinessData?.actions)
    ? adapter.operationPlans.fetchBusinessData.actions
    : [];
  return actions.flatMap((action) => {
    if (action?.action !== "collectBusinessData") return [];
    if (Array.isArray(action.requestPlans)) return action.requestPlans;
    if (action.requestPlan) return [action.requestPlan];
    return [];
  }).map((item) => String(item)).filter(Boolean);
}

function sameStringSet(left = [], right = []) {
  const leftSet = new Set(left.map(String));
  const rightSet = new Set(right.map(String));
  if (leftSet.size !== rightSet.size) return false;
  return Array.from(leftSet).every((item) => rightSet.has(item));
}

function frontendSchemaCompatible(adapter) {
  const rules = adapter.strategies?.failureRules;
  return hasStringItems(adapter.responseMappings?.shopListPaths) &&
    hasStringItems(adapter.responseMappings?.currentShopIdPaths) &&
    hasStringItems(adapter.responseMappings?.currentShopObjectPaths) &&
    hasStringItems(adapter.responseMappings?.shopFields?.id) &&
    hasStringItems(adapter.responseMappings?.shopFields?.name) &&
    hasStringItems(adapter.selectors?.headerShopName) &&
    hasStringItems(adapter.cookieHintNames) &&
    hasStringItems(adapter.blockedSchemes) &&
    hasStringItems(adapter.sign?.candidates) &&
    hasStringItems(adapter.sign?.enablePathList) &&
    (rules === undefined || (
      Array.isArray(rules) &&
      rules.every((rule) => hasText(rule.reason) && hasText(rule.category) && hasText(rule.title) && hasStringItems(rule.patterns))
    ));
}

function hasPolicySections(adapter) {
  const policies = adapter.policies || {};
  return !!policies.getShopUserInfo &&
    !!policies.refreshStatus &&
    !!policies.fetchStores &&
    !!policies.businessData &&
    !!policies.importStore &&
    !!policies.activateStore &&
    !!policies.openStore &&
    !!policies.deleteStores &&
    !!policies.group &&
    !!policies.platformRequest &&
    !!policies.repository;
}

const adapter = readJson(adapterPath);
const stringIssues = collectStringIssues(adapter);
const service = existsSync(servicePath) ? readFileSync(servicePath, "utf8") : "";
const businessDataPage = existsSync(businessDataPagePath) ? readFileSync(businessDataPagePath, "utf8") : "";
const electronAdapterPath = join(repoRoot, "electron-client", "src", "main", "doudian", "adapter.js");
const electronAdapter = existsSync(electronAdapterPath) ? readFileSync(electronAdapterPath, "utf8") : "";
const leakageRun = spawnSync(process.execPath, [leakageScriptPath], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
});
const leakageReport = existsSync(leakageOutputPath) ? readJson(leakageOutputPath) : null;
const businessRequestPlanKeys = [
  "businessCoreIndex",
  "businessHomepage",
  "businessWarnTicket",
  "businessSmartActivityCoupon",
  "businessSmartActivityDirectDiscount",
  "businessSmartActivityNewUserBonus",
  "businessCreditScoreBase",
  "businessCreditScoreLevel",
  "businessOnSaleProducts",
  "businessOfflineProducts"
];
const businessDataFields = [
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
const policyBusinessRequestPlans = Array.isArray(adapter.policies?.businessData?.requestPlans)
  ? adapter.policies.businessData.requestPlans.map((item) => String(item)).filter(Boolean)
  : [];
const operationBusinessRequestPlans = collectBusinessOperationRequestPlans(adapter);
const businessFieldSchemaColumns = Array.isArray(adapter.policies?.businessData?.fieldSchema?.columns)
  ? adapter.policies.businessData.fieldSchema.columns
  : [];
const businessDatePresets = adapter.policies?.businessData?.datePresets || {};
const businessRequiredPlans = Array.isArray(adapter.policies?.businessData?.requiredPlans)
  ? adapter.policies.businessData.requiredPlans.map((item) => String(item)).filter(Boolean)
  : [];
const businessOptionalPlans = Array.isArray(adapter.policies?.businessData?.optionalPlans)
  ? adapter.policies.businessData.optionalPlans.map((item) => String(item)).filter(Boolean)
  : [];
const businessCoreIndexPlan = adapter.requestPlans?.businessCoreIndex || {};
const businessCoreIndexModulePath = "data.module_data.homepage_core_index.compass_general_multi_index_card_value.data.0";
const businessCoreIndexMetricPrefix = "businessCoreIndex.data.module_data.homepage_core_index.compass_general_multi_index_card_value.data.0.";
const businessCoreMetricFields = [
  "dealAmount",
  "orderCount",
  "refundAmount",
  "refundOrderCount",
  "platformSubsidyAmount",
  "buyers",
  "customerPrice",
  "exposureUsers",
  "clickUsers",
  "productExposureCount",
  "productClickCount",
  "refundRate"
];
const xzbHomepageFieldCoverage = [
  {
    field: "violationPending",
    paths: [
      "businessHomepage.data.data.lay_out_data[layout_id=1000].cards.0.data.todo_list_card_data.todo_list[key=violation_pending].val",
      "businessHomepage.data.data.lay_out_data[layout_id=1000].cards.0.data.todo_list_card_data.todo_list[key=col_violation_pending].val",
      "businessHomepage.data.data.violation_pending",
      "businessHomepage.data.data.col_violation_pending"
    ],
    aliases: ["col_violation_pending", "violation_pending"]
  },
  {
    field: "rectificationRisk",
    paths: [
      "businessHomepage.data.data.lay_out_data[layout_id=1000].cards.0.data.todo_list_card_data.todo_list[key=col_to_berectified_risk].val",
      "businessHomepage.data.data.col_to_berectified_risk"
    ],
    aliases: ["col_to_berectified_risk"]
  },
  {
    field: "pendingShipment",
    paths: [
      "businessHomepage.data.data.lay_out_data[layout_id=1000].cards.0.data.todo_list_card_data.todo_list[key=col_order_stock_up].val",
      "businessHomepage.data.data.col_order_stock_up"
    ],
    aliases: ["col_order_stock_up"]
  },
  {
    field: "ship24h",
    paths: [
      "businessHomepage.data.data.lay_out_data[layout_id=1000].cards.0.data.todo_list_card_data.todo_list[key=col_order_exp_ship].val",
      "businessHomepage.data.data.col_order_exp_ship"
    ],
    aliases: ["col_order_exp_ship"]
  },
  {
    field: "afterSalePending",
    paths: [
      "businessHomepage.data.data.lay_out_data[layout_id=1000].cards.0.data.todo_list_card_data.todo_list[key=col_aftersale].val",
      "businessHomepage.data.data.col_aftersale"
    ],
    aliases: ["col_aftersale"]
  }
];
function businessFieldPaths(field) {
  const paths = adapter.responseMappings?.businessData?.fields?.[field]?.paths;
  return Array.isArray(paths) ? paths.map((item) => String(item)) : [];
}
function businessFieldAliases(field) {
  const aliases = adapter.responseMappings?.businessData?.fields?.[field]?.aliases;
  return Array.isArray(aliases) ? aliases.map((item) => String(item)) : [];
}
const staleBusinessSmartActivityPresent = [
  ...(Array.isArray(adapter.capabilities?.requestPlanSteps) ? adapter.capabilities.requestPlanSteps : []),
  ...policyBusinessRequestPlans,
  ...operationBusinessRequestPlans,
  ...Object.keys(adapter.requestPlans || {})
].some((item) => item === "businessSmartActivity");
const checks = [
  {
    key: "selectorsRemote",
    ok: !!adapter.selectors && hasArray(adapter.selectors.headerShopName) && !!adapter.selectors.roleItem,
    source: rel(adapterPath)
  },
  {
    key: "endpointsRemote",
    ok: !!adapter.endpoints?.shopList && !!adapter.endpoints?.currentShop,
    source: rel(adapterPath)
  },
  {
    key: "requestPlansRemote",
    ok: !!adapter.requestPlans?.shopList && !!adapter.requestPlans?.currentShop && hasArray(adapter.requestPlans?.getShopUserInfo?.steps),
    source: rel(adapterPath)
  },
  {
    key: "businessDataEndpointsRemote",
    ok: businessRequestPlanKeys.every((key) => hasBusinessPlanEndpoint(adapter, key)),
    source: rel(adapterPath)
  },
  {
    key: "businessDataRequestPlansRemote",
    ok: businessRequestPlanKeys.every((key) => hasText(adapter.requestPlans?.[key]?.endpointKey)) &&
      hasActions(adapter.operationPlans?.fetchBusinessData, ["collectBusinessData", "recordStoreAttempts"]),
    source: rel(adapterPath)
  },
  {
    key: "businessDataRequestPlansSingleSource",
    ok: operationBusinessRequestPlans.length === 0 || sameStringSet(operationBusinessRequestPlans, policyBusinessRequestPlans),
    source: rel(adapterPath)
  },
  {
    key: "businessDataNoStaleSmartActivityPlan",
    ok: !staleBusinessSmartActivityPresent,
    source: rel(adapterPath)
  },
  {
    key: "businessCoreIndexFailureRulesRemote",
    ok: hasStringItems(businessCoreIndexPlan.failureMessages) &&
      hasStringItems(businessCoreIndexPlan.successPaths) &&
      businessCoreIndexPlan.successPaths.includes(businessCoreIndexModulePath) &&
      businessCoreIndexPlan.failureMessages.includes("日期校验失败") &&
      businessCoreIndexPlan.failureMessages.includes("参数校验失败") &&
      businessCoreIndexPlan.allowMissingCode === true,
    source: rel(adapterPath)
  },
  {
    key: "businessCoreIndexXzbRequestShapeRemote",
    ok: businessCoreIndexPlan.signStrategy === "mstoken-myargs" &&
      businessCoreIndexPlan.signatureParam === false &&
      businessCoreIndexPlan.includeEmptySignature === false &&
      hasText(businessCoreIndexPlan.signerUrl) &&
      hasText(businessCoreIndexPlan.rawQuery) &&
      businessCoreIndexPlan.rawQuery.includes("date_type={legacyDateType}") &&
      businessCoreIndexPlan.rawQuery.includes("begin_date={beginDateSlash}") &&
      businessCoreIndexPlan.rawQuery.includes("end_date={endDateSlash}") &&
      businessCoreIndexPlan.rawQuery.includes("pay_amt%2Cpay_cnt%2Cper_usr_pay_amt") &&
      businessCoreIndexPlan.pageFetchOnSignFailure === true &&
      Number.isFinite(Number(businessCoreIndexPlan.pageFetchTimeoutMs)),
    source: rel(adapterPath)
  },
  {
    key: "businessCoreIndexMetricPathsRemote",
    ok: businessCoreMetricFields.every((field) => businessFieldPaths(field).some((path) => path.startsWith(businessCoreIndexMetricPrefix))),
    source: rel(adapterPath)
  },
  {
    key: "businessHomepageXzbTodoFieldsRemote",
    ok: xzbHomepageFieldCoverage.every((coverage) => {
      const paths = businessFieldPaths(coverage.field);
      const aliases = businessFieldAliases(coverage.field);
      return coverage.paths.every((path) => paths.includes(path)) &&
        coverage.aliases.every((alias) => aliases.includes(alias));
    }),
    source: rel(adapterPath)
  },
  {
    key: "businessCoreIndexOptionalRemote",
    ok: businessRequiredPlans.includes("businessHomepage") &&
      !businessRequiredPlans.includes("businessCoreIndex") &&
      businessOptionalPlans.includes("businessCoreIndex"),
    source: rel(adapterPath)
  },
  {
    key: "adapterHasNoMojibakeMarkers",
    ok: stringIssues.length === 0,
    source: rel(adapterPath)
  },
  {
    key: "businessDataMappingsRemote",
    ok: !!adapter.responseMappings?.businessData &&
      businessDataFields.every((field) => (
        hasArray(adapter.responseMappings.businessData?.fields?.[field]?.paths) ||
        hasArray(adapter.responseMappings.businessData?.fields?.[field]?.aliases)
      )),
    source: rel(adapterPath)
  },
  {
    key: "businessDataFieldSchemaRemote",
    ok: businessDataFields.every((field) => businessFieldSchemaColumns.some((column) => (
      column?.key === field &&
      hasText(column?.label) &&
      ["money", "number", "percent", "score"].includes(String(column?.format || "")) &&
      column?.export !== false
    ))),
    source: rel(adapterPath)
  },
  {
    key: "businessDataDatePresetsRemote",
    ok: ["today", "yesterday", "7d", "30d"].every((preset) => {
      const config = businessDatePresets[preset];
      return config &&
        hasText(config.dateType) &&
        hasText(config.legacyDateType) &&
        hasText(config.legacyActiveKey) &&
        Number.isFinite(Number(config.startOffsetDays)) &&
        Number.isFinite(Number(config.endOffsetDays));
    }) &&
      Number(businessDatePresets["7d"]?.startOffsetDays) === -7 &&
      Number(businessDatePresets["7d"]?.endOffsetDays) === -1 &&
      Number(businessDatePresets["30d"]?.startOffsetDays) === -30 &&
      Number(businessDatePresets["30d"]?.endOffsetDays) === -1 &&
      ["today", "7d", "30d"].every((preset) => (
        Number(businessDatePresets[preset]?.earlyMorningStartHour) === 1 &&
        Number(businessDatePresets[preset]?.earlyMorningBeforeHour) === 9 &&
        Number(businessDatePresets[preset]?.earlyMorningShiftDays) === -1
      )) &&
      service.includes("resolveBusinessDatePreset") &&
      service.includes("earlyMorningShiftDays") &&
      !service.includes("function legacyBusinessDateType") &&
      !service.includes("function legacyBusinessActiveKey"),
    source: rel(adapterPath)
  },
  {
    key: "businessDataPageDoesNotOverrideRemoteDateRange",
    ok: !/fetchDoudianBusinessData\(\{[\s\S]*beginDate:/.test(businessDataPage) &&
      !/fetchDoudianBusinessData\(\{[\s\S]*endDate:/.test(businessDataPage) &&
      !/fetchDoudianBusinessDataLatest\(\{[\s\S]*beginDate:/.test(businessDataPage) &&
      !/fetchDoudianBusinessDataLatest\(\{[\s\S]*endDate:/.test(businessDataPage),
    source: rel(businessDataPagePath)
  },
  {
    key: "failureRulesRemote",
    ok: hasArray(adapter.strategies?.failureRules),
    source: rel(adapterPath)
  },
  {
    key: "pageScriptsRemote",
    ok: service.includes("REQUIRED_REMOTE_SCRIPT_KEYS") && service.includes("assertRemoteAdapterInput"),
    source: rel(servicePath)
  },
  {
    key: "frontendSchemaCompatible",
    ok: frontendSchemaCompatible(adapter),
    source: rel(adapterPath)
  },
  {
    key: "capabilitiesRemote",
    ok: hasArray(adapter.capabilities?.actions) && hasArray(adapter.capabilities?.scriptKeys),
    source: rel(adapterPath)
  },
  {
    key: "operationPlansRemote",
    ok: hasActions(adapter.operationPlans?.fetchStores, ["loginAndDetectStores", "importStores", "recordStoreAttempts", "upsertStores"]) &&
      hasActions(adapter.operationPlans?.importStore, ["copyCookies", "activateStore", "buildStoreRecord"]) &&
      hasActions(adapter.operationPlans?.fetchLogin, ["openWindow", "loadUrl", "waitForRoleWindow"]) &&
      hasActions(adapter.operationPlans?.activateStore, ["openWindow", "loadUrl", "selectTargetShop", "waitForTargetShop"]) &&
      hasActions(adapter.operationPlans?.refreshStatus, ["refreshStores", "updateStores", "recordStoreAttempts"]) &&
      hasActions(adapter.operationPlans?.refreshStore, ["getShopUserInfo"]) &&
      hasActions(adapter.operationPlans?.fetchBusinessData, ["collectBusinessData", "recordStoreAttempts"]) &&
      hasActions(adapter.operationPlans?.openStore, ["openWindow", "loadUrl"]),
    source: rel(adapterPath)
  },
  {
    key: "policiesRemote",
    ok: hasPolicySections(adapter),
    source: rel(adapterPath)
  },
  {
    key: "electronConsumesOperationPlans",
    ok: service.includes("requireOperationActions(adapter, \"fetchStores\"") &&
      service.includes("requireOperationActions(adapter, \"importStore\"") &&
      service.includes("requireOperationActions(adapter, \"refreshStatus\"") &&
      service.includes("requireOperationActions(adapter, \"refreshStore\"") &&
      service.includes("requireOperationActions(adapter, \"fetchBusinessData\"") &&
      service.includes("runActionList(adapter, \"fetchStores\"") &&
      service.includes("runActionList(adapter, \"refreshStatus\"") &&
      service.includes("runActionList(adapter, \"fetchBusinessData\""),
    source: rel(servicePath)
  },
  {
    key: "electronConsumesRemotePolicies",
    ok: service.includes("policyMessage(adapter") &&
      service.includes("policyText(adapter") &&
      service.includes("repository.configurePolicy") &&
      service.includes("policyNumber(adapter, \"refreshStatus.concurrency\""),
    source: rel(servicePath)
  },
  {
    key: "electronHasBusinessPageFetchFallback",
    ok: service.includes("doudianPageFetchByPlan") &&
      service.includes("pageFetchOnSignFailure") &&
      service.includes("getCachedDoudianSignerWindow(partition") &&
      service.includes("response?.data?.st"),
    source: rel(servicePath)
  },
  {
    key: "electronDefaultAdapterIsSkeleton",
    ok: !/homePageReadyPathHints:\s*\[\s*["']\//.test(electronAdapter) && !/failureRules:\s*\[\s*\{/.test(electronAdapter),
    source: rel(electronAdapterPath)
  },
  {
    key: "electronHasNoLocalDoudianRuleLeakage",
    ok: leakageRun.status === 0 && leakageReport?.status === "ok" && leakageReport?.issueCount === 0,
    source: rel(leakageOutputPath)
  }
];

const failed = checks.filter((check) => !check.ok);
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  status: failed.length ? "fail" : "ok",
  adapterPath: rel(adapterPath),
  servicePath: rel(servicePath),
  electronAdapterPath: rel(electronAdapterPath),
  checks,
  summary: {
    checkCount: checks.length,
    failedCount: failed.length,
    stringIssueCount: stringIssues.length
  },
  diagnostics: {
    policyBusinessRequestPlans,
    operationBusinessRequestPlans,
    stringIssues: stringIssues.slice(0, 50)
  }
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

console.log(report.status === "ok" ? "DOUDIAN_REMOTE_UPDATE_MATRIX_OK" : "DOUDIAN_REMOTE_UPDATE_MATRIX_FAIL");
console.log(JSON.stringify({
  status: report.status,
  failedCount: failed.length,
  outputPath: rel(outputPath)
}, null, 2));

if (failed.length) process.exit(1);
