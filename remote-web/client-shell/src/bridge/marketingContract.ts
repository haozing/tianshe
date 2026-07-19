export type MarketingContractFeature = "limited_time" | "new_user_bonus" | "general_coupon";

const FEATURES: MarketingContractFeature[] = ["limited_time", "new_user_bonus", "general_coupon"];
const REQUIRED_READ_ACTIONS: Record<MarketingContractFeature, string[]> = {
  limited_time: ["load_products", "list", "detail"],
  new_user_bonus: ["load_products", "list", "detail"],
  general_coupon: ["load_products", "list", "detail"]
};
const ALLOWED_WRITE_ACTIONS: Record<MarketingContractFeature, string[]> = {
  limited_time: ["create", "disable", "end", "toggle_renew", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"],
  new_user_bonus: ["create", "disable"],
  general_coupon: ["create", "cancel", "toggle_renew"]
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function textList(value: unknown, allowEmpty = true) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(text);
}

function configSection(config: Record<string, unknown>, key: string) {
  return objectValue(config[key]);
}

function capability(config: Record<string, unknown>, feature: MarketingContractFeature) {
  return objectValue(objectValue(objectValue(configSection(config, "capabilities")?.marketing)?.features)?.[feature]);
}

function featurePolicy(config: Record<string, unknown>, feature: MarketingContractFeature) {
  return objectValue(objectValue(objectValue(configSection(config, "policies")?.marketing)?.features)?.[feature]);
}

function featureMapping(config: Record<string, unknown>, feature: MarketingContractFeature) {
  return objectValue(objectValue(configSection(config, "responseMappings")?.marketing)?.[feature]);
}

function plan(config: Record<string, unknown>, planKey: unknown) {
  return text(planKey) ? objectValue(configSection(config, "requestPlans")?.[String(planKey)]) : null;
}

function planEndpointExists(config: Record<string, unknown>, value: Record<string, unknown> | null) {
  const endpointKey = value?.endpointKey;
  return text(endpointKey) && text(configSection(config, "endpoints")?.[String(endpointKey)]);
}

function validReadPlan(config: Record<string, unknown>, planKey: unknown) {
  const value = plan(config, planKey);
  return !!value && value.mutation !== true && planEndpointExists(config, value);
}

function validReadPlanReference(config: Record<string, unknown>, value: unknown) {
  if (text(value)) return validReadPlan(config, value);
  return textList(value, false) && (value as string[]).every((planKey) => validReadPlan(config, planKey));
}

function validMutationPlan(config: Record<string, unknown>, mutationPlanKey: unknown, reconcilePlanKey: unknown, precheckPlanKeys: unknown, deferredValidation: unknown, validationPlanKey: unknown) {
  const mutation = plan(config, mutationPlanKey);
  const reconcile = plan(config, reconcilePlanKey);
  const prechecks = Array.isArray(precheckPlanKeys) ? precheckPlanKeys : [];
  const validPrecheck = textList(prechecks) && (prechecks.length > 0 || (deferredValidation === true && validReadPlan(config, validationPlanKey)));
  const timeoutMs = Number(mutation?.timeoutMs);
  return !!mutation && !!reconcile && planEndpointExists(config, mutation) && planEndpointExists(config, reconcile) &&
    validPrecheck && prechecks.every((planKey) => validReadPlan(config, planKey)) &&
    mutation.mutation === true && Number(mutation.maxAttempts) === 1 &&
    mutation.retryOnHttpError === false && mutation.retryOnBusinessFailure === false &&
    Number(mutation.prepareRetryAttempts) === 0 && Number.isFinite(timeoutMs) && timeoutMs >= 5000 && timeoutMs <= 120000 &&
    String(mutation.reconcilePlanKey || "") === String(reconcilePlanKey || "") &&
    mutation.fallbackEndpointKey === undefined && mutation.fallbackPlanKey === undefined &&
    mutation.pageFetchOnSignFailure !== true && reconcile.mutation !== true;
}

export function isValidMarketingMutationActionConfig(input: unknown, feature: MarketingContractFeature, action: string) {
  const config = objectValue(input);
  if (!config) return false;
  const featureCapability = capability(config, feature);
  if (!textList(featureCapability?.writeActions) || !(featureCapability?.writeActions as string[]).includes(action)) return false;
  const policy = featurePolicy(config, feature);
  const contract = objectValue(objectValue(policy?.writeActions)?.[action]);
  const mapping = featureMapping(config, feature);
  const preflight = objectValue(mapping?.preflight);
  if (action === "create" && !textList(preflight?.eligiblePaths, false) && !textList(preflight?.rejectedItemPaths, false)) return false;
  if (action !== "create" && !textList(preflight?.statusPaths, false)) return false;
  if (!contract || !validMutationPlan(config, contract.mutationPlanKey, contract.reconcilePlanKey, contract.precheckPlanKeys, contract.deferredValidation, contract.validationPlanKey)) return false;
  const scopedPrechecks = objectValue(contract.precheckPlanKeysByScope);
  if (Object.values(scopedPrechecks || {}).some((value) => !textList(value, false) || !(value as string[]).every((planKey) => validReadPlan(config, planKey)))) return false;
  return true;
}

export function isValidMarketingContractConfig(input: unknown) {
  const config = objectValue(input);
  if (!config) return false;
  const marketing = objectValue(configSection(config, "capabilities")?.marketing);
  if (marketing === null) return configSection(config, "capabilities")?.marketing === undefined;
  if (!text(marketing.contractVersion) || !objectValue(marketing.features)) return false;
  for (const feature of FEATURES) {
    const featureCapability = capability(config, feature);
    const policy = featurePolicy(config, feature);
    const mapping = featureMapping(config, feature);
    const readActions = objectValue(policy?.readActions);
    if (featureCapability?.read !== true || !textList(featureCapability?.writeActions) || !(featureCapability.writeActions as string[]).every((action) => ALLOWED_WRITE_ACTIONS[feature].includes(action)) || !policy || !mapping || !readActions || !objectValue(policy.writeActions)) return false;
    if (REQUIRED_READ_ACTIONS[feature].some((action) => !validReadPlanReference(config, readActions[action]))) return false;
    if (!textList(mapping.listPaths, false)) return false;
    if ((featureCapability.writeActions as string[]).length > 0) {
      const reconciliationMapping = objectValue(mapping.reconciliation);
      if (!reconciliationMapping || (!textList(reconciliationMapping.outcomePaths, false) && !textList(reconciliationMapping.completePaths, false))) return false;
    }
    const fields = objectValue(mapping.fields);
    if (!fields) return false;
    for (const field of ["entityId", "status", "startTime", "endTime", "platformError"]) {
      if (!textList(objectValue(fields[field])?.paths, false)) return false;
    }
    const pagination = objectValue(policy.pagination);
    const concurrency = objectValue(policy.concurrency);
    const reconciliation = objectValue(policy.reconciliation);
    if (!pagination || Number(pagination.pageSize) <= 0 || Number(pagination.maxPages) <= 0) return false;
    if (!concurrency || Number(concurrency.read) <= 0 || Number(concurrency.write) <= 0 || !textList(policy.writableStatuses)) return false;
    const settleMs = Number(reconciliation?.mutationSettleDeadlineMs);
    const observationMs = Number(reconciliation?.maxObservationMs);
    if (!reconciliation || !Number.isFinite(settleMs) || settleMs < 30000 || settleMs > 300000 || !Number.isFinite(observationMs) || observationMs < settleMs) return false;
    if ((featureCapability.writeActions as string[]).some((action) => !isValidMarketingMutationActionConfig(config, feature, action))) return false;
  }
  return true;
}
