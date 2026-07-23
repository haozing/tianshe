import type { DoudianAdapterConfig, DoudianAdapterPayload, MarketingFeature } from "../types";
import { isValidMarketingContractConfig, isValidMarketingMutationActionConfig } from "./marketingContract";
import { buildDoudianScripts } from "./doudianScripts";
import {
  STORAGE_KEY_DOUDIAN_ADAPTER_STATUS,
  storageGet,
  storageSet
} from "./storage";

export const DOUDIAN_ADAPTER_URL = "./config/doudian-adapter.marketing-pilot.json";

let doudianAdapterPromise: Promise<DoudianAdapterPayload> | null = null;
let doudianAdapterPromiseUrl = "";

type AdapterSource = "remote";

interface LoadDoudianAdapterOptions {
  force?: boolean;
}

const emptyAdapterStatus = {
  ok: false,
  source: "none" as const,
  contractVersion: "",
  adapterVersion: "",
  scriptsVersion: "",
  capabilities: {
    actions: [],
    scriptKeys: [],
    requestPlanSteps: [],
    unknownActionPolicy: "fail" as const
  },
  loadedAt: "",
  lastGoodAt: "",
  lastFailureReason: ""
};

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => isString(item));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isOptionalStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isString(item));
}

function isStringRecordArray(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const fields = value as Record<string, unknown>;
  return isStringArray(fields.id) && isStringArray(fields.name);
}

function isValidCapabilities(value: unknown): boolean {
  if (value === undefined) return true;
  const capabilities = value as DoudianAdapterConfig["capabilities"];
  return !!(
    capabilities &&
    typeof capabilities === "object" &&
    isOptionalStringArray(capabilities.actions) &&
    isOptionalStringArray(capabilities.scriptKeys) &&
    isOptionalStringArray(capabilities.requestPlanSteps) &&
    (capabilities.unknownActionPolicy === undefined || ["fail", "skip", "remote-fallback"].includes(capabilities.unknownActionPolicy)) &&
    (capabilities.marketing === undefined || isPlainObject(capabilities.marketing))
  );
}

export function isValidMarketingMutationAction(config: DoudianAdapterConfig, feature: MarketingFeature, action: string) {
  return isValidMarketingMutationActionConfig(config, feature, action);
}

export function isValidMarketingContract(config: DoudianAdapterConfig) {
  return isValidMarketingContractConfig(config);
}

function isValidOperationPlans(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((plan) => {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
    const actions = (plan as { actions?: unknown }).actions;
    return Array.isArray(actions) && actions.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const action = (item as { action?: unknown }).action;
      const onError = (item as { onError?: unknown }).onError;
      return isString(action) && (onError === undefined || ["fail", "continue", "fallback"].includes(String(onError)));
    });
  });
}

function isValidResponseMappings(value: unknown): boolean {
  const mappings = value as DoudianAdapterConfig["responseMappings"];
  if (!mappings || typeof mappings !== "object") return false;
  return (
    isStringArray(mappings.shopListPaths) &&
    isStringArray(mappings.currentShopIdPaths) &&
    isStringArray(mappings.currentShopObjectPaths) &&
    isStringRecordArray(mappings.shopFields) &&
    Array.isArray(mappings.operateStatus?.normalCodes) &&
    isString(mappings.operateStatus?.normalLabel) &&
    isString(mappings.operateStatus?.abnormalLabel)
  );
}

function isValidRequestPlans(value: unknown): boolean {
  const plans = value as DoudianAdapterConfig["requestPlans"];
  if (!plans || typeof plans !== "object") return false;
  const allowedSteps = new Set(["shopList", "currentShop"]);
  const userInfoSteps = plans.getShopUserInfo?.steps;
  const validEndpointPlan = (plan: unknown) => {
    const next = plan as { endpointKey?: unknown; sign?: unknown };
    return !!next && typeof next === "object" && isString(String(next.endpointKey || "")) && typeof next.sign === "boolean";
  };
  return (
    validEndpointPlan(plans.shopList) &&
    validEndpointPlan(plans.currentShop) &&
    Array.isArray(userInfoSteps) &&
    userInfoSteps.length > 0 &&
    userInfoSteps.every((step) => allowedSteps.has(step)) &&
    (!plans.currentShop?.retryBackoff || ["fixed", "linear"].includes(plans.currentShop.retryBackoff))
  );
}

function isValidSignConfig(value: unknown): boolean {
  const sign = value as DoudianAdapterConfig["sign"];
  return !!(
    sign &&
    typeof sign === "object" &&
    isStringArray(sign.candidates) &&
    isString(sign.candidateKeyPattern) &&
    isStringArray(sign.enablePathList)
  );
}

function isValidStrategies(value: unknown): boolean {
  if (value === undefined) return true;
  const strategies = value as DoudianAdapterConfig["strategies"];
  const rules = strategies?.failureRules;
  return !!(
    strategies &&
    typeof strategies === "object" &&
    (strategies.roleListPollMs === undefined || typeof strategies.roleListPollMs === "number") &&
    (strategies.homePageConfirmAttempts === undefined || typeof strategies.homePageConfirmAttempts === "number") &&
    (strategies.shopSwitchHomePageReadyAttempts === undefined || typeof strategies.shopSwitchHomePageReadyAttempts === "number") &&
    isOptionalStringArray(strategies.homePageReadyPathHints) &&
    (rules === undefined || (
      Array.isArray(rules) &&
      rules.every((rule) => (
        isString(rule.reason) &&
        isString(rule.category) &&
        isString(rule.title) &&
        isStringArray(rule.patterns)
      ))
    ))
  );
}

function isValidPolicies(value: unknown): boolean {
  return value === undefined || (!!value && typeof value === "object" && !Array.isArray(value));
}

const FUNDS_CONTRACT_FIELDS = new Set([
  "accountName", "accountBank", "phone",
  "withdrawBalance", "balance", "frozenBalance", "pendingSettleAmount",
  "marginBalance", "depositPayable", "refundableMargin",
  "baseMarginBalance", "baseDepositPayable", "baseRefundableMargin",
  "experienceMarginBalance", "experienceDepositPayable", "experienceRefundableMargin",
  "subsidyTotal", "commissionSubsidy", "qianchuanSubsidy",
  "compensationOrderCountToday", "compensationOrderCount7d",
  "compensationAmountToday", "compensationAmount7d",
  "pendingSettleOrderAmount", "pendingSettleOrders", "riskCount"
]);

const VIOLATIONS_CONTRACT_FIELDS = new Set([
  "totalRecords", "pendingCount", "appealCount", "rectificationCount",
  "highRiskCount", "dueSoonCount", "overdueCount", "productLinkedCount",
  "productMissingCount", "offlineProductCount", "failedCount", "penaltyAmount"
]);

const BUSINESS_CONTRACT_FIELDS = new Set([
  "dealAmount", "orderCount", "refundAmount", "refundOrderCount", "platformSubsidyAmount",
  "violationPending", "rectificationRisk", "pendingShipment", "ship24h", "overdueShipment",
  "unpaidOrders", "afterSalePending", "abnormalPackage", "serviceOrder", "buyers", "customerPrice",
  "exposureUsers", "clickUsers", "productExposureCount", "productClickCount", "onSaleProductCount",
  "offlineProductCount", "experienceScore", "refundRate", "latest7dUnreadWarning", "couponActive",
  "directDiscountActive", "newUserBonusActive", "reputationScore", "logisticsScore", "disputeDeduction",
  "productScore", "serviceScore"
]);
const VIOLATION_REQUEST_PLANS = ["violationRiskTicketList", "violationPenaltyTicketList"] as const;

function isValidBusinessContract(config: DoudianAdapterConfig) {
  const responseMappings = config.responseMappings as unknown as Record<string, unknown>;
  const mappings = isPlainObject(responseMappings.businessData) ? responseMappings.businessData : null;
  const policies = config.policies as unknown as Record<string, unknown>;
  const businessPolicy = isPlainObject(policies?.businessData) ? policies.businessData : null;
  if (!mappings || !businessPolicy) return false;

  const requestPlans = businessPolicy.requestPlans;
  const requiredPlans = businessPolicy.requiredPlans;
  const optionalPlans = businessPolicy.optionalPlans;
  const criticalPlans = businessPolicy.criticalPlans;
  const coreMetricPlans = businessPolicy.coreMetricPlans;
  const criticalFields = businessPolicy.criticalFields;
  if (![requestPlans, requiredPlans, optionalPlans, criticalPlans, coreMetricPlans, criticalFields].every(isOptionalStringList)) return false;
  if (!(requestPlans as string[]).length || !(criticalPlans as string[]).length || !(criticalFields as string[]).length) return false;
  const requestPlanSet = new Set(requestPlans as string[]);
  if ([...(requiredPlans as string[]), ...(optionalPlans as string[]), ...(criticalPlans as string[]), ...(coreMetricPlans as string[])].some((key) => !requestPlanSet.has(key))) return false;
  if ((criticalPlans as string[]).some((key) => (optionalPlans as string[]).includes(key))) return false;
  if ([...requestPlanSet].some((key) => !isPlainObject(config.requestPlans?.[key]))) return false;

  const groups = businessPolicy.requestPlanGroups;
  if (!Array.isArray(groups) || !groups.every((group) => isOptionalStringList(group) && group.every((key) => requestPlanSet.has(key)))) return false;
  const groupedPlans = groups.flatMap((group) => group as string[]);
  if (new Set(groupedPlans).size !== groupedPlans.length || groupedPlans.some((key) => !requestPlanSet.has(key))) return false;
  if (groupedPlans.length !== requestPlanSet.size || [...requestPlanSet].some((key) => !groupedPlans.includes(key))) return false;

  const fields = isPlainObject(mappings.fields) ? mappings.fields : null;
  const schema = isPlainObject(businessPolicy.fieldSchema) ? businessPolicy.fieldSchema : null;
  const columns = schema && Array.isArray(schema.columns) ? schema.columns : [];
  if (!fields || !schema || !isString(schema.version) || !columns.length) return false;
  const columnKeys = columns.map((column) => isPlainObject(column) ? String(column.key || "") : "");
  if (columnKeys.some((key) => !BUSINESS_CONTRACT_FIELDS.has(key) || !isPlainObject(fields[key]))) return false;
  if ((criticalFields as string[]).some((key) => !BUSINESS_CONTRACT_FIELDS.has(key) || !columnKeys.includes(key))) return false;
  return new Set(columnKeys).size === columnKeys.length &&
    columnKeys.length === BUSINESS_CONTRACT_FIELDS.size &&
    [...BUSINESS_CONTRACT_FIELDS].every((key) => columnKeys.includes(key));
}

function isValidFundsContract(config: DoudianAdapterConfig) {
  const responseMappings = config.responseMappings as unknown as Record<string, unknown>;
  const mappings = isPlainObject(responseMappings.fundsData) ? responseMappings.fundsData : null;
  const policies = config.policies as unknown as Record<string, unknown>;
  const fundsPolicy = isPlainObject(policies?.fundsData) ? policies.fundsData : null;
  if (!mappings || !fundsPolicy || !isString(fundsPolicy.contractVersion)) return false;

  const requestPlans = fundsPolicy.requestPlans;
  const requiredPlans = fundsPolicy.requiredPlans;
  const optionalPlans = fundsPolicy.optionalPlans;
  const criticalPlans = fundsPolicy.criticalPlans;
  const diagnosticPlans = fundsPolicy.diagnosticPlans;
  if (![requestPlans, requiredPlans, optionalPlans, criticalPlans, diagnosticPlans].every(isOptionalStringList)) return false;
  if (!(requestPlans as string[]).length || !(criticalPlans as string[]).length) return false;
  const requestPlanSet = new Set(requestPlans as string[]);
  if ([...(requiredPlans as string[]), ...(optionalPlans as string[]), ...(criticalPlans as string[]), ...(diagnosticPlans as string[])].some((key) => !requestPlanSet.has(key))) return false;
  if ((criticalPlans as string[]).some((key) => (optionalPlans as string[]).includes(key) || (diagnosticPlans as string[]).includes(key))) return false;
  if ([...requestPlanSet].some((key) => !isPlainObject(config.requestPlans?.[key]))) return false;

  const groups = fundsPolicy.requestPlanGroups;
  if (!Array.isArray(groups) || !groups.every((group) => isOptionalStringList(group) && group.every((key) => requestPlanSet.has(key)))) return false;
  const groupedPlans = groups.flatMap((group) => group as string[]);
  if (new Set(groupedPlans).size !== groupedPlans.length) return false;

  const fields = isPlainObject(mappings.fields) ? mappings.fields : null;
  const scales = isPlainObject(mappings.fieldScales) ? mappings.fieldScales : null;
  if (!fields || !scales) return false;
  for (const [key, rawConfig] of Object.entries(fields)) {
    if (!FUNDS_CONTRACT_FIELDS.has(key) || !isPlainObject(rawConfig)) return false;
    if (!isOptionalStringList(rawConfig.paths) || !isOptionalStringList(rawConfig.aliases)) return false;
    if (!(rawConfig.paths.length || rawConfig.aliases.length)) return false;
    if (rawConfig.moneyText !== undefined && typeof rawConfig.moneyText !== "boolean") return false;
    if (rawConfig.valueType !== undefined && !["number", "text"].includes(String(rawConfig.valueType))) return false;
    if (rawConfig.scale !== undefined && !(Number.isFinite(Number(rawConfig.scale)) && Number(rawConfig.scale) > 0)) return false;
  }
  if (Object.entries(scales).some(([key, value]) => !FUNDS_CONTRACT_FIELDS.has(key) || !Number.isFinite(Number(value)) || Number(value) <= 0)) return false;

  const derivedFields = fundsPolicy.derivedFields;
  if (!Array.isArray(derivedFields)) return false;
  const derivedKeys = new Set<string>();
  for (const value of derivedFields) {
    if (!isPlainObject(value) || !isString(value.key) || !FUNDS_CONTRACT_FIELDS.has(value.key) || derivedKeys.has(value.key)) return false;
    if (!isOptionalStringList(value.sources) || !value.sources.length || value.sources.some((source) => !FUNDS_CONTRACT_FIELDS.has(source))) return false;
    if (!isString(value.formula) || !["sum", "subtract", "countPositive"].includes(value.formula)) return false;
    derivedKeys.add(value.key);
  }

  const schema = isPlainObject(fundsPolicy.fieldSchema) ? fundsPolicy.fieldSchema : null;
  const columns = schema && Array.isArray(schema.columns) ? schema.columns : [];
  const summaries = schema && Array.isArray(schema.summaryMetrics) ? schema.summaryMetrics : [];
  if (!schema || !isString(schema.version) || !columns.length || !summaries.length) return false;
  const columnKeys: string[] = [];
  for (const value of [...columns, ...summaries]) {
    if (!isPlainObject(value) || !isString(value.key) || !FUNDS_CONTRACT_FIELDS.has(value.key)) return false;
    if (!isPlainObject(fields[value.key]) && !derivedKeys.has(value.key)) return false;
    if (!isString(value.label) || !["money", "number", "text"].includes(String(value.format || ""))) return false;
    if (columns.includes(value)) columnKeys.push(value.key);
  }
  return new Set(columnKeys).size === columnKeys.length;
}

function isValidViolationsContract(config: DoudianAdapterConfig) {
  const responseMappings = config.responseMappings as unknown as Record<string, unknown>;
  const mappings = isPlainObject(responseMappings.violationsData) ? responseMappings.violationsData : null;
  const policies = config.policies as unknown as Record<string, unknown>;
  const violationsPolicy = isPlainObject(policies?.violationsData) ? policies.violationsData : null;
  if (!mappings || !violationsPolicy) return false;

  if (!isStringArray(mappings.listPaths) || !isOptionalStringList(mappings.totalPaths)) return false;
  const listPathsByPlan = isPlainObject(mappings.listPathsByPlan) ? mappings.listPathsByPlan : null;
  const totalPathsByPlan = isPlainObject(mappings.totalPathsByPlan) ? mappings.totalPathsByPlan : null;
  if (!listPathsByPlan || !totalPathsByPlan) return false;
  if (VIOLATION_REQUEST_PLANS.some((key) => !isStringArray(listPathsByPlan[key]) || !isStringArray(totalPathsByPlan[key]))) return false;
  const fields = isPlainObject(mappings.fields) ? mappings.fields : null;
  if (!fields) return false;
  const requiredFields = ["id", "objectType", "objectId", "productId", "violationAt", "processStatus", "penaltyStatus", "appealStatus", "rectificationStatus", "dueAt"];
  if (requiredFields.some((key) => !isPlainObject(fields[key]) || !isStringArray(fields[key].paths))) return false;
  for (const [key, value] of Object.entries(fields)) {
    if (!isPlainObject(value)) return false;
    if (key === "executionTypes") {
      if (!isStringArray(value.arrayPaths) || !isStringArray(value.itemPaths)) return false;
    } else if (!isStringArray(value.paths)) {
      return false;
    }
  }

  const requestPlans = violationsPolicy.requestPlans;
  const requiredPlans = violationsPolicy.requiredPlans;
  const optionalPlans = violationsPolicy.optionalPlans;
  const criticalPlans = violationsPolicy.criticalPlans;
  if (![requestPlans, requiredPlans, optionalPlans, criticalPlans].every(isOptionalStringList)) return false;
  if ((requestPlans as string[]).length !== VIOLATION_REQUEST_PLANS.length) return false;
  if (VIOLATION_REQUEST_PLANS.some((key) => !(requestPlans as string[]).includes(key))) return false;
  if ((requiredPlans as string[]).length || (optionalPlans as string[]).length) return false;
  if ((criticalPlans as string[]).length !== VIOLATION_REQUEST_PLANS.length || VIOLATION_REQUEST_PLANS.some((key) => !(criticalPlans as string[]).includes(key))) return false;
  const planSet = new Set(requestPlans as string[]);
  if ([...(requiredPlans as string[]), ...(optionalPlans as string[]), ...(criticalPlans as string[])].some((key) => !planSet.has(key))) return false;
  if ([...planSet].some((key) => !isPlainObject(config.requestPlans?.[key]))) return false;

  if (violationsPolicy.dateField !== "violationAt" || violationsPolicy.filterMode !== "local-after-complete-fetch") return false;
  for (const key of ["concurrency", "pageConcurrency", "maxPages", "cacheRetentionDays"]) {
    if (!Number.isFinite(Number(violationsPolicy[key])) || Number(violationsPolicy[key]) <= 0) return false;
  }

  const schema = isPlainObject(violationsPolicy.fieldSchema) ? violationsPolicy.fieldSchema : null;
  const columns = schema && Array.isArray(schema.columns) ? schema.columns : [];
  if (!schema || !isString(schema.version) || !columns.length) return false;
  const columnKeys: string[] = [];
  for (const value of columns) {
    if (!isPlainObject(value) || !isString(value.key) || !VIOLATIONS_CONTRACT_FIELDS.has(value.key) || !isString(value.label)) return false;
    columnKeys.push(value.key);
  }
  if (new Set(columnKeys).size !== columnKeys.length) return false;

  const association = isPlainObject(violationsPolicy.productAssociation) ? violationsPolicy.productAssociation : null;
  if (!association || association.enabled !== false || !isOptionalStringList(association.requestPlans) || (association.requestPlans as string[]).length) return false;
  const actions = isPlainObject(violationsPolicy.violationActions) ? violationsPolicy.violationActions : null;
  if (!actions || actions.enabled !== false || !isOptionalStringList(actions.requestPlans) || !isOptionalStringList(actions.allowedActions)) return false;
  if ((actions.requestPlans as string[]).length || (actions.allowedActions as string[]).length) return false;
  return true;
}

export function isDoudianAdapterConfig(value: unknown): value is DoudianAdapterConfig {
  const config = value as DoudianAdapterConfig;
  return !!(
    config &&
    typeof config === "object" &&
    config.schemaVersion === 1 &&
    (config.contractVersion === undefined || isString(config.contractVersion)) &&
    config.platform === "doudian" &&
    isString(config.version) &&
    isValidCapabilities(config.capabilities) &&
    isValidOperationPlans(config.operationPlans) &&
    isString(config.origin) &&
    isString(config.sourcePartition) &&
    isString(config.shopPartitionPrefix) &&
    isString(config.loginUrl) &&
    isString(config.homeUrl) &&
    isString(config.chooseEntriesUrl) &&
    isString(config.endpoints?.shopList) &&
    isString(config.endpoints?.currentShop) &&
    isValidRequestPlans(config.requestPlans) &&
    isValidResponseMappings(config.responseMappings) &&
    isString(config.selectors?.roleItem) &&
    isString(config.selectors?.roleStatus) &&
    isString(config.selectors?.roleName) &&
    isStringArray(config.selectors?.headerShopName) &&
    isString(config.labels?.workbench) &&
    isString(config.labels?.singleLogin) &&
    isString(config.cookieDomain) &&
    isStringArray(config.cookieHintNames) &&
    isOptionalStringArray(config.blockedKeywords) &&
    isStringArray(config.blockedSchemes) &&
    isValidSignConfig(config.sign) &&
    isValidStrategies(config.strategies) &&
    isValidPolicies(config.policies) &&
    isValidBusinessContract(config) &&
    isValidFundsContract(config) &&
    isValidViolationsContract(config)
    && isValidMarketingContract(config)
  );
}

function adapterPayload(adapter: DoudianAdapterConfig, source: AdapterSource, detail: Partial<DoudianAdapterPayload> = {}): DoudianAdapterPayload {
  return {
    schemaVersion: 1,
    kind: "chihu-doudian-adapter",
    loadedAt: new Date().toISOString(),
    source,
    ...detail,
    adapter,
    scripts: buildDoudianScripts(adapter)
  };
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function saveAdapterStatus(payload: DoudianAdapterPayload, lastFailureReason = "") {
  storageSet(STORAGE_KEY_DOUDIAN_ADAPTER_STATUS, {
    ok: true,
    source: payload.source || "remote",
    contractVersion: payload.adapter.contractVersion || "",
    adapterVersion: payload.adapter.version,
    scriptsVersion: payload.scripts?.version || "",
    capabilities: payload.adapter.capabilities || emptyAdapterStatus.capabilities,
    loadedAt: payload.loadedAt,
    lastGoodAt: payload.lastGoodAt || payload.loadedAt,
    lastFailureReason
  });
}

function saveAdapterFailure(reason: string) {
  const previous = getDoudianAdapterStatus();
  storageSet(STORAGE_KEY_DOUDIAN_ADAPTER_STATUS, {
    ...previous,
    ok: false,
    lastFailureReason: reason
  });
}

export function getDoudianAdapterStatus() {
  return storageGet(STORAGE_KEY_DOUDIAN_ADAPTER_STATUS, emptyAdapterStatus);
}

export async function loadDoudianAdapterPayload(options: LoadDoudianAdapterOptions = {}): Promise<DoudianAdapterPayload> {
  const query = new URLSearchParams(window.location.search);
  const smokeOverrideAllowed = window.location.hostname.endsWith(".localhost") && query.get("smoke") === "1";
  const override = smokeOverrideAllowed ? query.get("doudianAdapterUrl") : null;
  const urlValue = override || DOUDIAN_ADAPTER_URL;
  const resolvedUrl = new URL(urlValue, window.location.href);
  if (resolvedUrl.origin !== window.location.origin) throw new Error("doudian adapter override must be same-origin");
  const adapterUrl = resolvedUrl.toString();
  if (options.force || doudianAdapterPromiseUrl !== adapterUrl) doudianAdapterPromise = null;
  if (!doudianAdapterPromise) {
    doudianAdapterPromiseUrl = adapterUrl;
    const url = new URL(adapterUrl);
    if (options.force) url.searchParams.set("t", String(Date.now()));
    doudianAdapterPromise = fetch(url, { cache: options.force ? "no-store" : "no-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`doudian adapter load failed: ${response.status}`);
        const json = await response.json();
        if (!isDoudianAdapterConfig(json)) throw new Error("doudian adapter schema invalid");
        const payload = adapterPayload(json, "remote");
        saveAdapterStatus(payload);
        return payload;
      })
      .catch((error) => {
        const reason = failureMessage(error);
        saveAdapterFailure(reason);
        throw error;
      });
  }
  return doudianAdapterPromise;
}

export async function withDoudianAdapter<T extends Record<string, unknown>>(args: T, options: LoadDoudianAdapterOptions = {}): Promise<T & { doudianAdapter: DoudianAdapterPayload }> {
  const doudianAdapter = await loadDoudianAdapterPayload(options);
  return {
    ...args,
    doudianAdapter
  };
}
