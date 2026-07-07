import type { DoudianAdapterConfig, DoudianAdapterPayload } from "../types";
import { buildDoudianScripts } from "./doudianScripts";
import {
  STORAGE_KEY_DOUDIAN_ADAPTER_LKG,
  STORAGE_KEY_DOUDIAN_ADAPTER_STATUS,
  storageGet,
  storageSet
} from "./storage";

export const DOUDIAN_ADAPTER_URL = "./config/doudian-adapter.json";

let doudianAdapterPromise: Promise<DoudianAdapterPayload> | null = null;

type AdapterSource = "remote" | "last-known-good";

interface LoadDoudianAdapterOptions {
  force?: boolean;
}

interface StoredAdapterPayload {
  schemaVersion: 1;
  savedAt: string;
  adapter: DoudianAdapterConfig;
  scriptsVersion: string;
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
    (capabilities.unknownActionPolicy === undefined || ["fail", "skip", "remote-fallback"].includes(capabilities.unknownActionPolicy))
  );
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
    isValidPolicies(config.policies)
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

function saveLastKnownGood(payload: DoudianAdapterPayload) {
  storageSet<StoredAdapterPayload>(STORAGE_KEY_DOUDIAN_ADAPTER_LKG, {
    schemaVersion: 1,
    savedAt: payload.loadedAt,
    adapter: payload.adapter,
    scriptsVersion: payload.scripts?.version || ""
  });
}

function loadLastKnownGoodAdapter(reason: string): DoudianAdapterPayload | null {
  const stored = storageGet<StoredAdapterPayload | null>(STORAGE_KEY_DOUDIAN_ADAPTER_LKG, null);
  if (!stored || stored.schemaVersion !== 1 || !isDoudianAdapterConfig(stored.adapter)) return null;
  const payload = adapterPayload(stored.adapter, "last-known-good", {
    lastGoodAt: stored.savedAt,
    lastFailureReason: reason
  });
  saveAdapterStatus(payload, reason);
  return payload;
}

export function getDoudianAdapterStatus() {
  return storageGet(STORAGE_KEY_DOUDIAN_ADAPTER_STATUS, emptyAdapterStatus);
}

export async function loadDoudianAdapterPayload(options: LoadDoudianAdapterOptions = {}): Promise<DoudianAdapterPayload> {
  if (options.force) doudianAdapterPromise = null;
  if (!doudianAdapterPromise) {
    const url = options.force ? `${DOUDIAN_ADAPTER_URL}?t=${Date.now()}` : DOUDIAN_ADAPTER_URL;
    doudianAdapterPromise = fetch(url, { cache: options.force ? "no-store" : "no-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`doudian adapter load failed: ${response.status}`);
        const json = await response.json();
        if (!isDoudianAdapterConfig(json)) throw new Error("doudian adapter schema invalid");
        const payload = adapterPayload(json, "remote");
        saveLastKnownGood(payload);
        saveAdapterStatus(payload);
        return payload;
      })
      .catch((error) => {
        const reason = failureMessage(error);
        saveAdapterFailure(reason);
        const fallback = loadLastKnownGoodAdapter(reason);
        if (fallback) return fallback;
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
