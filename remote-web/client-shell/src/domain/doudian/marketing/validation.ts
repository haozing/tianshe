const FEATURES = new Set(["limited_time", "new_user_bonus", "general_coupon"]);
const READ_ACTIONS = new Set(["load_products", "list", "detail"]);
const WRITE_ACTIONS = new Set(["create", "disable", "cancel", "toggle_renew", "end", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"]);
const FEATURE_WRITE_ACTIONS: Record<string, Set<string>> = {
  limited_time: new Set(["create", "disable", "end", "toggle_renew", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"]),
  new_user_bonus: new Set(["create", "disable", "toggle_renew"]),
  general_coupon: new Set(["create", "cancel", "toggle_renew"])
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function positiveInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0;
}

function stringIds(value: unknown) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function parsedTime(value: unknown) {
  const timestamp = Date.parse(text(value));
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function timeSegments(value: unknown) {
  if (!Array.isArray(value)) return null;
  return value.map(objectValue).filter((segment) => Number.isFinite(parsedTime(segment.startTime)) && Number.isFinite(parsedTime(segment.endTime)) && parsedTime(segment.endTime) > parsedTime(segment.startTime));
}

function createValidationErrors(feature: string, context: Record<string, unknown>) {
  const errors: string[] = [];
  const scope = text(context.scope);
  const discountMode = text(context.discountMode);
  const startAt = parsedTime(context.startTime);
  const endAt = parsedTime(context.endTime);
  if (!new Set(["product", "shop"]).has(scope)) errors.push("context.scope must be product or shop");
  if (!Number.isFinite(startAt)) errors.push("context.startTime is required");
  if (!Number.isFinite(endAt)) errors.push("context.endTime is required");
  if (Number.isFinite(startAt) && Number.isFinite(endAt) && endAt <= startAt) errors.push("context.endTime must be after startTime");
  if (!new Set(["discount", "reduce", "threshold"]).has(discountMode)) errors.push("context.discountMode is invalid");
  if (discountMode === "threshold" && feature !== "general_coupon") errors.push("threshold discount is only valid for general_coupon");
  if (discountMode === "threshold" && !positiveNumber(context.thresholdAmount)) errors.push("context.thresholdAmount must be positive");
  if (!positiveNumber(context.discountValue)) errors.push("context.discountValue must be positive");
  if (scope === "product" && !stringIds(context.productIds)) errors.push("context.productIds are required for product scope");
  if (context.officialRenew !== undefined && typeof context.officialRenew !== "boolean") errors.push("context.officialRenew must be boolean");

  if (feature === "limited_time") {
    if (!new Set(["flash", "limited"]).has(text(context.activityType))) errors.push("context.activityType is invalid");
    if (!positiveInteger(context.stockValue)) errors.push("context.stockValue must be a positive integer");
    if (!positiveInteger(context.purchaseLimit)) errors.push("context.purchaseLimit must be a positive integer");
    if (context.skuMode !== undefined && !new Set(["all", "selected"]).has(text(context.skuMode))) errors.push("context.skuMode is invalid");
    const segments = timeSegments(context.timeSegments);
    if (context.timeSegments !== undefined && (!segments || segments.length === 0)) errors.push("context.timeSegments must contain valid ranges");
    if (segments && segments.some((segment) => parsedTime(segment.endTime) - parsedTime(segment.startTime) < 5 * 60 * 1000)) errors.push("context.timeSegments must be at least 5 minutes");
  }
  if (feature === "new_user_bonus" && context.newUserDurationDays !== undefined && (!positiveInteger(context.newUserDurationDays) || Number(context.newUserDurationDays) > 180)) errors.push("context.newUserDurationDays must be between 1 and 180");
  if (feature === "general_coupon" && context.couponType !== undefined && !new Set(["product", "shop"]).has(text(context.couponType))) errors.push("context.couponType is invalid");

  if (feature === "general_coupon") {
    if (!positiveInteger(context.issueCount)) errors.push("context.issueCount must be a positive integer");
    if (!positiveInteger(context.perUserLimit)) errors.push("context.perUserLimit must be a positive integer");
    if (positiveInteger(context.issueCount) && positiveInteger(context.perUserLimit) && Number(context.perUserLimit) > Number(context.issueCount)) errors.push("context.perUserLimit cannot exceed issueCount");
  }
  if (feature === "new_user_bonus" && Number.isFinite(startAt) && Number.isFinite(endAt)) {
    const durationMs = endAt - startAt;
    if (durationMs > 180 * 24 * 60 * 60 * 1000) errors.push("new_user_bonus duration cannot exceed 180 days");
    if (context.officialRenew === true && durationMs < 7 * 24 * 60 * 60 * 1000) errors.push("new_user_bonus renewal requires at least 7 days");
  }
  if (feature === "general_coupon" && context.officialRenew === true && Number.isFinite(startAt) && Number.isFinite(endAt) && endAt - startAt < 30 * 24 * 60 * 60 * 1000) {
    errors.push("general_coupon renewal requires at least 30 days");
  }
  return errors;
}

export function marketingTaskInputErrors(input: unknown) {
  const task = objectValue(input);
  const feature = text(task.feature);
  const action = text(task.action);
  const stores = Array.isArray(task.stores) ? task.stores.map(objectValue) : [];
  const context = objectValue(task.context);
  const errors: string[] = [];
  if (!FEATURES.has(feature)) errors.push("feature is invalid");
  if (!READ_ACTIONS.has(action) && !WRITE_ACTIONS.has(action)) errors.push("action is invalid");
  if (FEATURES.has(feature) && WRITE_ACTIONS.has(action) && !FEATURE_WRITE_ACTIONS[feature]?.has(action)) errors.push(`action ${action} is not supported for ${feature}`);
  if (!stores.length) errors.push("at least one store is required");
  const storeKeys = new Set<string>();
  stores.forEach((store, index) => {
    const shopId = text(store.shopId);
    const partition = text(store.partition);
    const tenantId = text(store.tenantId) || "local-user";
    const generation = store.storeGeneration === undefined ? 1 : Number(store.storeGeneration);
    if (!shopId) errors.push(`stores[${index}].shopId is required`);
    if (!partition) errors.push(`stores[${index}].partition is required`);
    if (!Number.isSafeInteger(generation) || generation < 1) errors.push(`stores[${index}].storeGeneration is invalid`);
    const key = `${tenantId}:${shopId}:${generation}`;
    if (storeKeys.has(key)) errors.push(`stores[${index}] duplicates store identity`);
    storeKeys.add(key);
  });
  if (action === "detail" && !text(context.entityId)) errors.push("context.entityId is required for detail");
  if (action === "create" && FEATURES.has(feature)) errors.push(...createValidationErrors(feature, context));
  if (["disable", "cancel", "toggle_renew", "end", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"].includes(action) && !stringIds(context.entityIds)) errors.push("context.entityIds are required for management actions");
  if (["revive", "copy"].includes(action)) errors.push(...createValidationErrors(feature, context).filter((error) => error.includes("startTime") || error.includes("endTime")));
  if (action === "remove_products" && !stringIds(context.productIds)) errors.push("context.productIds are required for remove_products");
  if (action === "bulk_edit" && !objectValue(context.fields)) errors.push("context.fields are required for bulk_edit");
  if (action === "tool_renew" && !positiveInteger(context.intervalDays)) errors.push("context.intervalDays must be a positive integer");
  return errors;
}

export function assertMarketingTaskInput(input: unknown) {
  const errors = marketingTaskInputErrors(input);
  if (errors.length) throw new Error(`invalid marketing task input: ${errors.join("; ")}`);
}
