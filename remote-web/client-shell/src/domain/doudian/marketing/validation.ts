const FEATURES = new Set(["limited_time", "new_user_bonus", "general_coupon"]);
const READ_ACTIONS = new Set(["load_products", "list", "detail"]);
const WRITE_ACTIONS = new Set(["create", "disable", "cancel", "toggle_renew", "end", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"]);
const FEATURE_WRITE_ACTIONS: Record<string, Set<string>> = {
  limited_time: new Set(["create", "disable", "end", "toggle_renew", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"]),
  new_user_bonus: new Set(["create", "disable"]),
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

function priceTierErrors(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return ["context.priceTiers must contain at least one range"];
  const errors: string[] = [];
  const ranges = value.map(objectValue).map((tier, index) => {
    const minimum = Number(tier.minPrice);
    const maximum = Number(tier.maxPrice);
    if (!Number.isFinite(minimum) || minimum < 0) errors.push(`context.priceTiers[${index}].minPrice is invalid`);
    if (!Number.isFinite(maximum) || maximum <= minimum) errors.push(`context.priceTiers[${index}].maxPrice is invalid`);
    if (!positiveNumber(tier.value)) errors.push(`context.priceTiers[${index}].value must be positive`);
    if (tier.reduction !== undefined && (!Number.isFinite(Number(tier.reduction)) || Number(tier.reduction) < 0)) errors.push(`context.priceTiers[${index}].reduction cannot be negative`);
    return { minimum, maximum };
  }).sort((left, right) => left.minimum - right.minimum);
  if (ranges[0]?.minimum !== 0) errors.push("context.priceTiers must start at 0");
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].minimum < ranges[index - 1].maximum) errors.push("context.priceTiers ranges cannot overlap");
    if (ranges[index].minimum > ranges[index - 1].maximum) errors.push("context.priceTiers ranges cannot contain gaps");
  }
  return errors;
}

function createValidationErrors(feature: string, context: Record<string, unknown>, stores: Record<string, unknown>[] = []) {
  const errors: string[] = [];
  const scope = text(context.scope);
  const discountMode = text(context.discountMode);
  const startAt = parsedTime(context.startTime);
  const endAt = parsedTime(context.endTime);
  if (!new Set(["product", "shop"]).has(scope)) errors.push("context.scope must be product or shop");
  if (!Number.isFinite(startAt)) errors.push("context.startTime is required");
  if (!Number.isFinite(endAt)) errors.push("context.endTime is required");
  if (Number.isFinite(startAt) && Number.isFinite(endAt) && endAt <= startAt) errors.push("context.endTime must be after startTime");
  const allowedDiscountModes = feature === "limited_time"
    ? new Set(["one_price_discount", "fixed_price", "discount", "reduce"])
    : new Set(["discount", "reduce", "threshold"]);
  if (!allowedDiscountModes.has(discountMode)) errors.push("context.discountMode is invalid");
  if (discountMode === "threshold" && feature !== "general_coupon") errors.push("threshold discount is only valid for general_coupon");
  if (discountMode === "threshold" && !positiveNumber(context.thresholdAmount)) errors.push("context.thresholdAmount must be positive");
  if (!positiveNumber(context.discountValue)) errors.push("context.discountValue must be positive");
  if (scope === "product" && !stringIds(context.productIds)) errors.push("context.productIds are required for product scope");
  const productIdsByShop = objectValue(context.productIdsByShop);
  if (scope === "product" && context.productIdsByShop !== undefined) {
    stores.forEach((store, index) => {
      if (!stringIds(productIdsByShop[text(store.shopId)])) errors.push(`context.productIdsByShop is missing products for stores[${index}]`);
    });
  }
  if (context.officialRenew !== undefined && typeof context.officialRenew !== "boolean") errors.push("context.officialRenew must be boolean");

  if (feature === "limited_time") {
    if (scope !== "product") errors.push("limited_time only supports product scope");
    const activityType = text(context.activityType);
    if (!new Set(["flash", "limited", "ordinary"]).has(activityType)) errors.push("context.activityType is invalid");
    if (!positiveInteger(context.productLimitPerActivity) || Number(context.productLimitPerActivity) > 200) errors.push("context.productLimitPerActivity must be between 1 and 200");
    if (!new Set(["preset", "range", "recurring"]).has(text(context.timeMode))) errors.push("context.timeMode is invalid");
    const maxSegmentMinutes = activityType === "limited" ? 30 * 24 * 60 : activityType === "ordinary" ? 365 * 24 * 60 : 4 * 24 * 60;
    if (["preset", "recurring"].includes(text(context.timeMode)) && (!positiveInteger(context.activityDurationMinutes) || Number(context.activityDurationMinutes) < 5 || Number(context.activityDurationMinutes) > maxSegmentMinutes)) errors.push(`context.activityDurationMinutes must be between 5 and ${maxSegmentMinutes}`);
    if (context.timeMode === "preset" && Number.isFinite(startAt) && Number.isFinite(endAt) && positiveInteger(context.activityDurationMinutes) && Math.abs(endAt - startAt - Number(context.activityDurationMinutes) * 60_000) > 1000) errors.push("context.endTime must match the preset activity duration");
    if (!new Set(["unlimited", "limited"]).has(text(context.stockLimitMode))) errors.push("context.stockLimitMode is invalid");
    if (activityType === "limited" && context.stockLimitMode !== "limited") errors.push("limited quantity activities must use limited stock");
    if (activityType === "ordinary" && context.stockLimitMode !== "unlimited") errors.push("ordinary promotions must use unlimited stock");
    if (context.stockLimitMode === "limited") {
      if (!new Set(["all", "percent", "fixed"]).has(text(context.stockMode))) errors.push("context.stockMode is invalid");
      if (context.stockMode === "percent" && (!positiveNumber(context.stockPercent) || Number(context.stockPercent) > 100)) errors.push("context.stockPercent must be between 1 and 100");
      if (!positiveInteger(context.stockValue)) errors.push("context.stockValue must be a positive integer");
      if (activityType === "limited" && Number(context.stockValue) > 1000) errors.push("limited quantity stock cannot exceed 1000");
    }
    if (!new Set(["unlimited", "limited"]).has(text(context.purchaseLimitMode))) errors.push("context.purchaseLimitMode is invalid");
    if (context.purchaseLimitMode === "limited" && (!positiveInteger(context.purchaseLimit) || Number(context.purchaseLimit) > 20)) errors.push("context.purchaseLimit must be between 1 and 20");
    if (context.skuMode !== undefined && !new Set(["all", "exclude_lowest", "lowest", "highest", "max_stock", "min_stock", "first", "last"]).has(text(context.skuMode))) errors.push("context.skuMode is invalid");
    if (activityType !== "ordinary" && text(context.skuMode) !== "all") errors.push("limited-time and limited-quantity activities must use all SKUs");
    if (context.lowestSkuOverride === true && !positiveNumber(context.lowestSkuValue)) errors.push("context.lowestSkuValue must be positive");
    if (context.lowestSkuOverride === true && context.lowestSkuReduction !== undefined && (!Number.isFinite(Number(context.lowestSkuReduction)) || Number(context.lowestSkuReduction) < 0)) errors.push("context.lowestSkuReduction cannot be negative");
    if (context.lowestSkuOverride === true && !new Set(["first", "last", "random", "all"]).has(text(context.lowestSkuSelection))) errors.push("context.lowestSkuSelection is invalid");
    if (!new Set(["2", "1", "0", "custom"]).has(text(context.pricePrecision))) errors.push("context.pricePrecision is invalid");
    if (context.pricePrecision === "custom" && (!Number.isSafeInteger(Number(context.priceFraction)) || Number(context.priceFraction) < 0 || Number(context.priceFraction) > 99)) errors.push("context.priceFraction must be between 0 and 99");
    if (!new Set(["random", "prefix", "prefix_random"]).has(text(context.nameMode))) errors.push("context.nameMode is invalid");
    if (context.nameMode !== "random" && (!text(context.name) || text(context.name).length > 10)) errors.push("context.name must contain 1 to 10 characters for prefix naming");
    if (![300, 900, 1800].includes(Number(context.orderExpireSeconds))) errors.push("context.orderExpireSeconds is invalid");
    if (activityType === "ordinary" && context.warmupEnabled === true) errors.push("ordinary promotions do not support warmup");
    if (context.warmupEnabled === true && ![15, 30, 60, 90, 120, 150, 180, 210, 240, 300, 360, 420, 480, 540, 600, 660, 720].includes(Number(context.warmupMinutes))) errors.push("context.warmupMinutes is invalid");
    errors.push(...priceTierErrors(context.priceTiers));
    const maximumDiscount = activityType === "ordinary" ? 9.9 : 9.5;
    if (["discount", "one_price_discount"].includes(discountMode) && Number(context.discountValue) > maximumDiscount) errors.push(`context.discountValue cannot exceed ${maximumDiscount}`);
    const tiers = Array.isArray(context.priceTiers) ? context.priceTiers.map(objectValue) : [];
    if (["discount", "one_price_discount"].includes(discountMode) && tiers.some((tier) => Number(tier.value) > maximumDiscount)) errors.push(`context.priceTiers values cannot exceed ${maximumDiscount}`);
    if (["discount", "one_price_discount"].includes(discountMode) && context.lowestSkuOverride === true && Number(context.lowestSkuValue) > maximumDiscount) errors.push(`context.lowestSkuValue cannot exceed ${maximumDiscount}`);
    if (context.purchaseLimitMode === "limited" && tiers.some((tier) => !positiveInteger(tier.purchaseLimit) || Number(tier.purchaseLimit) > 20)) errors.push("context.priceTiers purchaseLimit must be between 1 and 20");
    const segments = timeSegments(context.timeSegments);
    if (context.timeSegments !== undefined && (!segments || segments.length === 0)) errors.push("context.timeSegments must contain valid ranges");
    if (segments && segments.some((segment) => parsedTime(segment.endTime) - parsedTime(segment.startTime) < 5 * 60 * 1000)) errors.push("context.timeSegments must be at least 5 minutes");
    const maxSegmentMs = activityType === "limited" ? 30 * 24 * 60 * 60 * 1000 : activityType === "ordinary" ? 365 * 24 * 60 * 60 * 1000 : 4 * 24 * 60 * 60 * 1000;
    if (segments && segments.some((segment) => parsedTime(segment.endTime) - parsedTime(segment.startTime) > maxSegmentMs)) errors.push("context.timeSegments exceeds the activity type duration limit");
    const startHorizonDays = activityType === "ordinary" ? 30 : 7;
    if (Number.isFinite(startAt) && startAt > Date.now() + startHorizonDays * 24 * 60 * 60 * 1000) errors.push(`limited_time startTime must be within ${startHorizonDays} days`);
    const renewalSegments = segments?.length ? segments : [{ startTime: context.startTime, endTime: context.endTime }];
    if (context.officialRenew === true && (activityType === "flash" || renewalSegments.some((segment) => parsedTime(segment.endTime) - parsedTime(segment.startTime) < 7 * 24 * 60 * 60 * 1000))) errors.push("limited_time official renewal requires every non-flash activity segment to be at least 7 days");
    if (context.toolRenew === true && (activityType !== "flash" || renewalSegments.some((segment) => {
      const segmentDuration = parsedTime(segment.endTime) - parsedTime(segment.startTime);
      return segmentDuration < 24 * 60 * 60 * 1000 || segmentDuration > 4 * 24 * 60 * 60 * 1000;
    }))) errors.push("limited_time tool renewal requires every flash activity segment to be between 1 and 4 days");
  }
  if (feature === "new_user_bonus") {
    const durationPreset = text(context.newUserDurationDays);
    const nameMode = text(context.newUserNameMode || "default");
    const prefix = text(context.newUserNamePrefix);
    const maximumDiscountValue = Number(context.newUserMaximumDiscountValue);
    if (durationPreset && !new Set(["7", "30", "180"]).has(durationPreset)) errors.push("context.newUserDurationDays must be 7, 30, 180 or empty");
    if (!new Set(["default", "prefix"]).has(nameMode)) errors.push("context.newUserNameMode is invalid");
    if (nameMode === "prefix" && (!prefix || prefix.length > 10)) errors.push("context.newUserNamePrefix must contain 1 to 10 characters");
    if (context.newUserFloatingAmount !== undefined && typeof context.newUserFloatingAmount !== "boolean") errors.push("context.newUserFloatingAmount must be boolean");
    if (scope === "shop" && discountMode !== "reduce") errors.push("new_user_bonus shop scope only supports reduction");
    if (discountMode === "discount" && (Number(context.discountValue) < 0.1 || Number(context.discountValue) > 9.9)) errors.push("context.discountValue must be between 0.1 and 9.9 for new_user_bonus discount");
    if (discountMode === "reduce" && Number(context.discountValue) > 1_000_000) errors.push("context.discountValue cannot exceed 1000000 for new_user_bonus reduction");
    if (scope === "product" && (!positiveInteger(context.newUserProductsPerActivity) || Number(context.newUserProductsPerActivity) > 500)) errors.push("context.newUserProductsPerActivity must be between 1 and 500");
    if (context.newUserFloatingAmount === true) {
      if (!positiveNumber(maximumDiscountValue)) errors.push("context.newUserMaximumDiscountValue must be positive");
      if (discountMode === "reduce" && maximumDiscountValue <= Number(context.discountValue)) errors.push("context.newUserMaximumDiscountValue must exceed discountValue for reduction");
      if (discountMode === "discount" && maximumDiscountValue >= Number(context.discountValue)) errors.push("context.newUserMaximumDiscountValue must be lower than discountValue for discount");
    }
    if (scope === "product" && discountMode === "discount") {
      const selectedProducts = Array.isArray(context.selectedProducts) ? context.selectedProducts.map(objectValue) : [];
      if (selectedProducts.some((product) => !positiveNumber(product.priceFen))) errors.push("context.selectedProducts require positive priceFen for new_user_bonus discount");
    }
  }
  if (feature === "general_coupon" && context.couponType !== undefined && !new Set(["product", "shop"]).has(text(context.couponType))) errors.push("context.couponType is invalid");

  if (feature === "general_coupon") {
    if (!positiveInteger(context.issueCount) || Number(context.issueCount) > 1_000_000) errors.push("context.issueCount must be between 1 and 1000000");
    if (!positiveInteger(context.perUserLimit) || Number(context.perUserLimit) > 30) errors.push("context.perUserLimit must be between 1 and 30");
    if (positiveInteger(context.issueCount) && positiveInteger(context.perUserLimit) && Number(context.perUserLimit) > Number(context.issueCount)) errors.push("context.perUserLimit cannot exceed issueCount");
    if (discountMode === "discount" && (Number(context.discountValue) < 2 || Number(context.discountValue) > 9.9)) errors.push("context.discountValue must be between 2 and 9.9 for coupon discount");
    if (discountMode === "reduce" && Number(context.discountValue) > 1000) errors.push("context.discountValue cannot exceed 1000 for coupon reduction");
    if (discountMode === "threshold" && Number(context.discountValue) > 99999) errors.push("context.discountValue cannot exceed 99999 for threshold coupon");
    if (discountMode === "threshold" && Number(context.thresholdAmount) > 99999) errors.push("context.thresholdAmount cannot exceed 99999");
    if (discountMode === "threshold" && positiveNumber(context.thresholdAmount) && Number(context.thresholdAmount) <= Number(context.discountValue)) errors.push("context.thresholdAmount must exceed discountValue");

    const validityMode = text(context.couponValidityMode || "same");
    if (!new Set(["same", "days", "range"]).has(validityMode)) errors.push("context.couponValidityMode is invalid");
    if (validityMode === "days" && (!positiveInteger(context.couponValidDays) || Number(context.couponValidDays) > 180)) errors.push("context.couponValidDays must be between 1 and 180");
    if (validityMode === "range") {
      const useStartAt = parsedTime(context.couponUseStartTime);
      const useEndAt = parsedTime(context.couponUseEndTime);
      if (!Number.isFinite(useStartAt)) errors.push("context.couponUseStartTime is required");
      if (!Number.isFinite(useEndAt)) errors.push("context.couponUseEndTime is required");
      if (Number.isFinite(useStartAt) && Number.isFinite(useEndAt) && useEndAt <= useStartAt) errors.push("context.couponUseEndTime must be after couponUseStartTime");
      if (Number.isFinite(useEndAt) && Number.isFinite(endAt) && useEndAt < endAt) errors.push("context.couponUseEndTime cannot be before endTime");
    }

    const nameMode = text(context.couponNameMode || "default");
    if (!new Set(["default", "first_product_id", "prefix"]).has(nameMode)) errors.push("context.couponNameMode is invalid");
    if (nameMode === "first_product_id" && scope !== "product") errors.push("context.couponNameMode first_product_id requires product scope");
    if (nameMode === "prefix" && (!text(context.couponNamePrefix) || text(context.couponNamePrefix).length > 8)) errors.push("context.couponNamePrefix must contain 1 to 8 characters");
    if (scope === "product" && (!positiveInteger(context.couponProductsPerCoupon) || Number(context.couponProductsPerCoupon) > 5000)) errors.push("context.couponProductsPerCoupon must be between 1 and 5000");
  }
  if (feature === "new_user_bonus" && Number.isFinite(startAt) && Number.isFinite(endAt)) {
    const durationMs = endAt - startAt;
    if (durationMs > 180 * 24 * 60 * 60 * 1000) errors.push("new_user_bonus duration cannot exceed 180 days");
    if (context.officialRenew === true && durationMs < 7 * 24 * 60 * 60 * 1000) errors.push("new_user_bonus renewal requires at least 7 days");
    if (startAt > Date.now() + 30 * 24 * 60 * 60 * 1000) errors.push("new_user_bonus startTime must be within 30 days");
  }
  if (feature === "general_coupon" && context.officialRenew === true && Number.isFinite(startAt) && Number.isFinite(endAt)) {
    if (endAt - startAt < 30 * 24 * 60 * 60 * 1000) errors.push("general_coupon renewal requires at least 30 days");
    if (context.couponValidityMode === "range") errors.push("general_coupon renewal requires same-time or valid-days mode");
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
  if (action === "create" && FEATURES.has(feature)) errors.push(...createValidationErrors(feature, context, stores));
  if (["disable", "cancel", "toggle_renew", "end", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"].includes(action) && !stringIds(context.entityIds)) errors.push("context.entityIds are required for management actions");
  if (["revive", "copy"].includes(action)) errors.push(...createValidationErrors(feature, context).filter((error) => error.includes("startTime") || error.includes("endTime")));
  if (action === "remove_products" && !stringIds(context.productIds)) errors.push("context.productIds are required for remove_products");
  if (action === "bulk_edit" && Object.keys(objectValue(context.fields)).length === 0) errors.push("context.fields are required for bulk_edit");
  if (action === "toggle_renew" && typeof context.renewOn !== "boolean") errors.push("context.renewOn must be boolean for toggle_renew");
  if (feature === "general_coupon" && action === "toggle_renew" && Array.isArray(context.selectedEntities) && context.selectedEntities.map(objectValue).some((entity) => !text(entity.coreEntityId))) errors.push("context.selectedEntities require merchant activity ids for coupon renewal");
  if (action === "tool_renew" && !positiveInteger(context.intervalDays)) errors.push("context.intervalDays must be a positive integer");
  return errors;
}

export function assertMarketingTaskInput(input: unknown) {
  const errors = marketingTaskInputErrors(input);
  if (errors.length) throw new Error(`invalid marketing task input: ${errors.join("; ")}`);
}
