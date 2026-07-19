import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { isValidMarketingContractConfig, isValidMarketingMutationActionConfig } from "../src/bridge/marketingContract.ts";
import { marketingPageAccessEnabled, marketingWriteAccessEnabled } from "../src/domain/doudian/marketing/access.ts";
import { clampRequestTimeoutMs, isUnknownWriteResponse, mutationRequestAttemptLimit, mutationRequestPlanSafetyError } from "../src/domain/doudian/requestPlanSafety.ts";
import { isDoudianMutationTask, mutationCancellationOutcome, restartRecoveryStatus } from "../src/domain/doudian/taskSafety.ts";
import { marketingTaskInputErrors } from "../src/domain/doudian/marketing/validation.ts";
import { marketingFailuresCsv } from "../src/domain/doudian/marketing/export.ts";
import { marketingScheduleDue } from "../src/domain/doudian/marketing/schedulerPolicy.ts";
import { aggregateLimitedTimeCreate, LIMITED_TIME_ACTIVITY_PRODUCT_LIMIT, LIMITED_TIME_ACTIVITY_SKU_LIMIT, limitedTimeActivitySegments, splitLimitedTimeCreateBatches, splitMarketingTimeSegments } from "../src/domain/doudian/marketing/limitedTime.ts";
import { marketingManagementPreflight } from "../src/domain/doudian/marketing/preflightPolicy.ts";
import { marketingReconciledRun, marketingReconciliationCompletionStatus, marketingReconciliationDecision } from "../src/domain/doudian/marketing/reconciliationPolicy.ts";
import { marketingAdapterSnapshotHash } from "../src/domain/doudian/marketing/snapshot.ts";
import { createConcurrencyLimiter, mapWithConcurrency } from "../src/domain/doudian/marketing/concurrency.ts";
import { buildLimitedTimePromotionGoods, marketingWriteContext } from "../src/domain/doudian/marketing/writeContext.ts";
import { platformFailureMessage } from "../src/domain/doudian/marketing/platformError.ts";
import { generalCouponDiscountType, generalCouponFavouredType, generalCouponProductQueryBody, generalCouponProductValidationBody, generalCouponRejectedItems, generalCouponValidityBody, splitGeneralCouponCreateBatches } from "../src/domain/doudian/marketing/generalCoupon.ts";
import { NEW_USER_BONUS_ACTIVITY_ID, newUserBonusName, newUserBonusPreflightBody, splitNewUserBonusCreateBatches } from "../src/domain/doudian/marketing/newUserBonus.ts";
import { marketingStoreContext } from "../src/domain/doudian/marketing/storeContext.ts";

const baseAdapter = JSON.parse(fs.readFileSync(new URL("../public/config/doudian-adapter.json", import.meta.url), "utf8"));
const pilotAdapter = JSON.parse(fs.readFileSync(new URL("../public/config/doudian-adapter.marketing-pilot.json", import.meta.url), "utf8"));
const features = ["limited_time", "new_user_bonus", "general_coupon"];

function limitedCreateContext(overrides = {}) {
  const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const endTime = new Date(Date.parse(startTime) + 2 * 60 * 60 * 1000).toISOString();
  return {
    scope: "product", productIds: ["90071992547409930"], startTime, endTime,
    discountMode: "discount", discountValue: "9", activityType: "flash", timeMode: "range", activityDurationMinutes: "1440",
    productLimitPerActivity: "200", stockLimitMode: "limited", stockMode: "fixed", stockPercent: "50", stockValue: "100",
    purchaseLimitMode: "limited", purchaseLimit: "1", skuMode: "all", lowestSkuOverride: false,
    priceTiers: [{ minPrice: "0", maxPrice: "999999999", value: "9", purchaseLimit: "1" }], pricePrecision: "2",
    autoMinPrice15: false, nameMode: "random", name: "", orderExpireSeconds: "1800", warmupEnabled: false, warmupMinutes: "15",
    officialRenew: false, toolRenew: false,
    ...overrides
  };
}

function reorderedObject(value) {
  if (Array.isArray(value)) return value.map(reorderedObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorderedObject(item)]));
  return value;
}

function marketingAdapter() {
  const adapter = structuredClone(baseAdapter);
  adapter.capabilities.marketing = {
    contractVersion: "marketing.v1",
    features: Object.fromEntries(features.map((feature) => [feature, { read: true, writeActions: ["create"] }]))
  };
  adapter.responseMappings.marketing = {};
  adapter.policies.marketing = { features: {} };
  for (const feature of features) {
    const requiredReads = ["load_products", "list", "detail"];
    const readActions = {};
    for (const action of requiredReads) {
      const planKey = `marketing_${feature}_${action}`;
      const endpointKey = `${planKey}_endpoint`;
      adapter.endpoints[endpointKey] = `/read/${feature}/${action}`;
      adapter.requestPlans[planKey] = { endpointKey, method: "POST", sign: false, mutation: false, maxAttempts: 1 };
      readActions[action] = planKey;
    }
    const mutationPlanKey = `marketing_${feature}_create`;
    const reconcilePlanKey = `marketing_${feature}_reconcile`;
    const precheckPlanKey = `marketing_${feature}_precheck`;
    adapter.endpoints[`${mutationPlanKey}_endpoint`] = `/write/${feature}/create`;
    adapter.endpoints[`${reconcilePlanKey}_endpoint`] = `/read/${feature}/reconcile`;
    adapter.endpoints[`${precheckPlanKey}_endpoint`] = `/read/${feature}/precheck`;
    adapter.requestPlans[mutationPlanKey] = {
      endpointKey: `${mutationPlanKey}_endpoint`, method: "POST", sign: false, mutation: true,
      maxAttempts: 1, retryOnHttpError: false, retryOnBusinessFailure: false,
      prepareRetryAttempts: 0, timeoutMs: 30000, reconcilePlanKey
    };
    adapter.requestPlans[reconcilePlanKey] = { endpointKey: `${reconcilePlanKey}_endpoint`, method: "POST", sign: false, mutation: false, maxAttempts: 1 };
    adapter.requestPlans[precheckPlanKey] = { endpointKey: `${precheckPlanKey}_endpoint`, method: "POST", sign: false, mutation: false, maxAttempts: 1 };
    adapter.responseMappings.marketing[feature] = {
      listPaths: ["data.list"], totalPaths: ["data.total"],
      preflight: { statusPaths: ["data.status"], conflictPaths: ["data.conflict"], eligiblePaths: ["data.eligible"], rejectedItemPaths: ["data.rejected_items"] },
      reconciliation: { outcomePaths: ["data.outcome"], completePaths: ["data.complete"], outcomeValues: { unique: ["unique"], not_found: ["not_found"], conflict: ["conflict"], unknown: ["unknown"] } },
      fields: Object.fromEntries(["entityId", "status", "startTime", "endTime", "platformError"].map((field) => [field, { paths: [field] }]))
    };
    adapter.policies.marketing.features[feature] = {
      readActions,
      writeActions: { create: { mutationPlanKey, reconcilePlanKey, precheckPlanKeys: [precheckPlanKey] } },
      pagination: { pageSize: 50, maxPages: 100 },
      concurrency: { read: 4, write: 3 },
      writableStatuses: ["active"],
      reconciliation: { mutationSettleDeadlineMs: 30000, maxObservationMs: 600000 }
    };
  }
  return adapter;
}

function advertiseWriteAction(adapter, feature, action) {
  const mutationPlanKey = `marketing_${feature}_${action}`;
  const reconcilePlanKey = `${mutationPlanKey}_reconcile`;
  const precheckPlanKey = `${mutationPlanKey}_precheck`;
  for (const [planKey, mutation] of [[mutationPlanKey, true], [reconcilePlanKey, false], [precheckPlanKey, false]]) {
    const endpointKey = `${planKey}_endpoint`;
    adapter.endpoints[endpointKey] = `/${mutation ? "write" : "read"}/${feature}/${action}/${mutation ? "mutation" : planKey.endsWith("precheck") ? "precheck" : "reconcile"}`;
    adapter.requestPlans[planKey] = mutation
      ? { endpointKey, method: "POST", sign: false, mutation: true, maxAttempts: 1, retryOnHttpError: false, retryOnBusinessFailure: false, prepareRetryAttempts: 0, timeoutMs: 30000, reconcilePlanKey }
      : { endpointKey, method: "POST", sign: false, mutation: false, maxAttempts: 1 };
  }
  adapter.capabilities.marketing.features[feature].writeActions = [action];
  adapter.policies.marketing.features[feature].writeActions = { [action]: { mutationPlanKey, reconcilePlanKey, precheckPlanKeys: [precheckPlanKey], writableStatuses: ["active"], idempotentStatuses: ["cancelled", "ended", "disabled"] } };
}

test("marketing adapter contract is conditional and rejects every automatic mutation resend path", () => {
  assert.equal(isValidMarketingContractConfig(baseAdapter), true);
  const adapter = marketingAdapter();
  assert.equal(isValidMarketingContractConfig(adapter), true);
  adapter.requestPlans.marketing_general_coupon_create.retryOnHttpError = true;
  assert.equal(isValidMarketingContractConfig(adapter), false);
});

test("marketing mutation contracts require a read-only precheck and reconciliation completeness mapping", () => {
  const adapter = marketingAdapter();
  delete adapter.policies.marketing.features.general_coupon.writeActions.create.precheckPlanKeys;
  assert.equal(isValidMarketingContractConfig(adapter), false);
  const withoutCompleteness = marketingAdapter();
  delete withoutCompleteness.responseMappings.marketing.general_coupon.reconciliation;
  assert.equal(isValidMarketingContractConfig(withoutCompleteness), false);
});

test("every phase 2-4 write action has an independently valid contract slot", () => {
  const actions = {
    limited_time: ["create", "disable", "end", "toggle_renew", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"],
    new_user_bonus: ["create", "disable"],
    general_coupon: ["create", "cancel", "toggle_renew"]
  };
  for (const [feature, featureActions] of Object.entries(actions)) {
    for (const action of featureActions) {
      const adapter = marketingAdapter();
      advertiseWriteAction(adapter, feature, action);
      assert.equal(isValidMarketingContractConfig(adapter), true, `${feature}.${action}`);
    }
  }
});

test("read-only marketing contracts require detail for every feature and keep writes closed", () => {
  const adapter = marketingAdapter();
  for (const feature of features) {
    adapter.capabilities.marketing.features[feature].writeActions = [];
    adapter.policies.marketing.features[feature].writeActions = {};
  }
  assert.equal(isValidMarketingContractConfig(adapter), true);
  adapter.requestPlans.marketing_new_user_bonus_detail = undefined;
  assert.equal(isValidMarketingContractConfig(adapter), false);
});

test("marketing adapter advertises the complete audited write matrix", () => {
  assert.equal(isValidMarketingContractConfig(pilotAdapter), true);
  assert.deepEqual(pilotAdapter.capabilities.marketing.features.limited_time.writeActions, ["create", "disable", "end", "toggle_renew", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"]);
  assert.deepEqual(pilotAdapter.capabilities.marketing.features.new_user_bonus.writeActions, ["create", "disable"]);
  assert.deepEqual(pilotAdapter.capabilities.marketing.features.general_coupon.writeActions, ["create", "cancel", "toggle_renew"]);
  assert.deepEqual(Object.keys(pilotAdapter.policies.marketing.features.general_coupon.writeActions).sort(), ["cancel", "create", "toggle_renew"]);
  assert.deepEqual(Object.keys(pilotAdapter.policies.marketing.features.new_user_bonus.writeActions).sort(), ["create", "disable"]);
  for (const action of ["create", "disable", "end", "toggle_renew", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"]) assert.ok(pilotAdapter.policies.marketing.features.limited_time.writeActions[action].mutationPlanKey, action);
  assert.equal(pilotAdapter.responseMappings.marketing.limited_time.reconciliation.completeByDefault, false);
  assert.deepEqual(pilotAdapter.policies.marketing.features.general_coupon.readActions.list, [
    "marketingGeneralCouponListProduct",
    "marketingGeneralCouponListShop",
    "marketingGeneralCouponListOwned"
  ]);
  assert.deepEqual(pilotAdapter.requestPlans.marketingGeneralCouponListProduct.query, {
    coupon_info: "", coupon_biz_type: 1, favoured_type: 0, status: 0,
    page: "{page}", size: "{pageSize}", sort_by_stock: false
  });
  assert.equal(pilotAdapter.policies.marketing.features.general_coupon.pagination.pageSize, 100);
  assert.equal(pilotAdapter.requestPlans.marketingNewUserBonusList.query.page_size, 1800);
  for (const [feature, capability] of Object.entries(pilotAdapter.capabilities.marketing.features)) {
    for (const action of capability.writeActions) assert.equal(isValidMarketingMutationActionConfig(pilotAdapter, feature, action), true, `${feature}.${action}`);
  }
  const incomplete = structuredClone(pilotAdapter);
  delete incomplete.requestPlans.marketingGeneralCouponListOwned;
  assert.equal(isValidMarketingContractConfig(incomplete), false);
});

test("feature flags and adapter capabilities form a fail-closed read/write gate", () => {
  const adapter = marketingAdapter();
  const config = {
    schemaVersion: 1, version: "test", configTtlSeconds: 300,
    entry: { newRemoteOrigin: "./" }, shell: { mode: "foundation", enabled: true, shellVersion: "test" },
    features: {
      marketingMenu: { enabled: true }, marketingLimitedTime: { enabled: true },
      marketingNewUserBonus: { enabled: true }, marketingGeneralCoupon: { enabled: true }, marketingWriteActions: { enabled: false }
    },
    assets: { shellEntry: "./app.js", cssEntry: "./styles.css", manifestUrl: "./release-manifest.json" },
    diagnostics: { enabled: true, sampleRate: 1 }, release: { gitCommit: "test", buildTime: "test" }
  };
  assert.equal(marketingPageAccessEnabled(config, adapter, "general_coupon", "marketingGeneralCoupon", true), true);
  assert.equal(marketingWriteAccessEnabled(config, adapter, "general_coupon", "marketingGeneralCoupon", "create", true, true), false);
  config.features.marketingWriteActions.enabled = true;
  assert.equal(marketingWriteAccessEnabled(config, adapter, "general_coupon", "marketingGeneralCoupon", "create", true, true), true);
  config.features.marketingMenu.enabled = false;
  assert.equal(marketingPageAccessEnabled(config, adapter, "general_coupon", "marketingGeneralCoupon", true), false);
  assert.equal(marketingWriteAccessEnabled(config, adapter, "general_coupon", "marketingGeneralCoupon", "create", true, true), false);
});

test("mutation request plans allow one call and use the bounded plan timeout", () => {
  const adapter = marketingAdapter();
  const plan = adapter.requestPlans.marketing_general_coupon_create;
  assert.equal(mutationRequestPlanSafetyError(plan), "");
  assert.equal(mutationRequestAttemptLimit(plan), 1);
  plan.retryOnBusinessFailure = true;
  assert.notEqual(mutationRequestPlanSafetyError(plan), "");
  assert.equal(mutationRequestAttemptLimit(plan), 0);
  assert.equal(clampRequestTimeoutMs(100), 5000);
  assert.equal(clampRequestTimeoutMs(500000), 120000);
});

test("mutation cancellation never reports an in-flight or unknown write as cancelled", () => {
  assert.equal(mutationCancellationOutcome({ mutation: true, mutationStarted: false, result: null }).result.status, "cancelled");
  assert.equal(mutationCancellationOutcome({ mutation: true, mutationStarted: true, result: { status: "sending" } }).result.status, "reconciling");
  assert.equal(mutationCancellationOutcome({ mutation: true, mutationStarted: true, result: { status: "accepted", entityId: "90071992547409930" } }).result.status, "accepted");
  assert.equal(mutationCancellationOutcome({ mutation: true, mutationStarted: true, result: { status: "unknown" } }).result.status, "reconciling");
  assert.equal(mutationCancellationOutcome({ mutation: true, mutationStarted: true, result: { status: "timeout" } }).result.status, "reconciling");
  assert.equal(restartRecoveryStatus(true), "reconciling");
  assert.equal(restartRecoveryStatus(false), "failed");
});

test("known write task types recover as mutations even without legacy metadata", () => {
  assert.equal(isDoudianMutationTask({ taskType: "staleGoodsExecute", metadata: {} }), true);
  assert.equal(isDoudianMutationTask({ taskType: "opportunityPipelineSubmit", metadata: {} }), true);
  assert.equal(isDoudianMutationTask({ taskType: "marketingTask", payload: { action: "create" } }), true);
  assert.equal(isDoudianMutationTask({ taskType: "marketingTask", payload: { action: "list" } }), false);
  assert.equal(isDoudianMutationTask({ taskType: "businessData", metadata: {} }), false);
});

test("native timeout and server failure enter reconciliation, while explicit platform rejection stays failed", () => {
  assert.equal(isUnknownWriteResponse({ ok: false, status: 0 }), true);
  assert.equal(isUnknownWriteResponse({ ok: false, status: 503 }), true);
  assert.equal(isUnknownWriteResponse({ ok: false, status: 400 }), false);
  assert.equal(isUnknownWriteResponse({ ok: true, status: 200 }), false);
});

test("marketing task validation rejects ambiguous store identities and incomplete detail reads", () => {
  const store = { shopId: "shop-1", shopName: "store", partition: "persist:shop-1", tenantId: "tenant-1", storeGeneration: 2 };
  assert.deepEqual(marketingTaskInputErrors({ feature: "general_coupon", action: "detail", stores: [store], context: { entityId: "90071992547409930" } }), []);
  const errors = marketingTaskInputErrors({ feature: "general_coupon", action: "detail", stores: [store, store], context: {} });
  assert.ok(errors.some((error) => error.includes("duplicates store identity")));
  assert.ok(errors.includes("context.entityId is required for detail"));
  assert.ok(marketingTaskInputErrors({ feature: "general_coupon", action: "list", stores: [] }).includes("at least one store is required"));
});

test("marketing create validation keeps product scope, time and renewal rules fail closed", () => {
  const store = { shopId: "shop-1", partition: "persist:shop-1", storeGeneration: 1 };
  const validCoupon = {
    feature: "general_coupon",
    action: "create",
    stores: [store],
    context: {
      scope: "product",
      productIds: ["90071992547409930"],
      startTime: "2026-08-01T00:00:00.000Z",
      endTime: "2026-09-01T00:00:00.000Z",
      discountMode: "threshold",
      discountValue: "10",
      thresholdAmount: "100",
      issueCount: "1000",
      perUserLimit: "1",
      officialRenew: true,
      couponValidityMode: "days",
      couponValidDays: "5",
      couponNameMode: "default",
      couponProductsPerCoupon: "200"
    }
  };
  assert.deepEqual(marketingTaskInputErrors(validCoupon), []);
  const invalid = structuredClone(validCoupon);
  invalid.context.productIds = [];
  invalid.context.endTime = invalid.context.startTime;
  invalid.context.perUserLimit = "1001";
  const errors = marketingTaskInputErrors(invalid);
  assert.ok(errors.includes("context.productIds are required for product scope"));
  assert.ok(errors.includes("context.endTime must be after startTime"));
  assert.ok(errors.includes("context.perUserLimit cannot exceed issueCount"));
  assert.ok(marketingTaskInputErrors({ ...validCoupon, feature: "new_user_bonus" }).includes("threshold discount is only valid for general_coupon"));
  const missingStoreProducts = structuredClone(validCoupon);
  missingStoreProducts.context.productIdsByShop = { "another-shop": ["90071992547409930"] };
  assert.ok(marketingTaskInputErrors(missingStoreProducts).includes("context.productIdsByShop is missing products for stores[0]"));
});

test("phase 2-4 actions are feature-scoped and require their own context", () => {
  const store = { shopId: "shop-1", partition: "persist:shop-1", storeGeneration: 1 };
  assert.ok(marketingTaskInputErrors({ feature: "new_user_bonus", action: "cancel", stores: [store], context: { entityIds: ["bonus-1"] } }).some((error) => error.includes("not supported")));
  assert.ok(marketingTaskInputErrors({ feature: "limited_time", action: "remove_products", stores: [store], context: { entityIds: ["activity-1"] } }).includes("context.productIds are required for remove_products"));
  assert.ok(marketingTaskInputErrors({ feature: "limited_time", action: "tool_renew", stores: [store], context: { entityIds: ["activity-1"], intervalDays: 0 } }).includes("context.intervalDays must be a positive integer"));
  assert.deepEqual(marketingTaskInputErrors({ feature: "limited_time", action: "bulk_edit", stores: [store], context: { entityIds: ["activity-1"], fields: { endTime: "2026-08-02T00:00:00.000Z" } } }), []);
});

test("general coupon platform codes, validity modes and product batches match XZB", () => {
  assert.equal(generalCouponDiscountType("discount"), 4);
  assert.equal(generalCouponDiscountType("reduce"), 1);
  assert.equal(generalCouponDiscountType("threshold"), 3);
  assert.equal(generalCouponFavouredType("product", "discount"), 41);
  assert.equal(generalCouponFavouredType("product", "reduce"), 42);
  assert.equal(generalCouponFavouredType("shop", "discount"), 21);
  assert.equal(generalCouponFavouredType("shop", "reduce"), 22);
  assert.deepEqual(generalCouponValidityBody({ couponValidityMode: "days", couponValidDays: "5" }), { period_type: 2, valid_period: "5" });

  const productIds = Array.from({ length: 1201 }, (_, index) => String(900000 + index));
  const batches = splitGeneralCouponCreateBatches({ scope: "product", couponProductsPerCoupon: "500", productIds });
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.productCount), [500, 500, 201]);
  assert.equal(batches[2].context.couponBatchIndex, 3);

  const couponContext = marketingWriteContext("general_coupon", "create", {
    operationId: "op-coupon", scope: "shop", startTime: "2026-08-01T00:00:00.000Z", endTime: "2026-09-01T00:00:00.000Z",
    couponValidityMode: "same", couponNameMode: "default", discountMode: "discount", discountValue: "8", issueCount: "1000", perUserLimit: "1", officialRenew: false
  });
  assert.equal(couponContext.preflightBody.activity_tool_discount_type, 4);
  assert.equal(couponContext.preflightBody.support_type, 5);
  assert.equal(couponContext.writeBody.favoured_type, 21);
  assert.equal(couponContext.writeBody.support_type, 5);
  assert.equal(couponContext.couponBizTypeCode, 5);

  const productQuery = generalCouponProductQueryBody({ page: 1, pageSize: 100, discountMode: "reduce", discountType: 1, startTimestamp: 1, endTimestamp: 2, discountTenths: 80, creditFen: 200, thresholdFen: 500 });
  assert.equal(productQuery.credit, 200);
  assert.equal("discount" in productQuery, false);
  assert.equal("threshold" in productQuery, false);
  assert.deepEqual(generalCouponProductValidationBody({ discountMode: "discount", discountValue: "8", startTimestamp: 1, endTimestamp: 2 }, ["p1"]), { activity_tool_type: 7, activity_tool_discount_type: 4, support_type: 1, validate_type: 1, start_time: 1, end_time: 2, product_infos: [{ product_id: "p1", channel_type: 0, channel_id: "0" }], participate_type: 1, discount: 80 });
  assert.deepEqual(generalCouponRejectedItems({ "90071992547409930_0_0": { simplified_reject_reason: "不满足活动要求" } }), [{ itemId: "90071992547409930", reasonCode: "platform_validation_rejected", message: "不满足活动要求" }]);

  const selectedEntity = { entityId: "coupon-1", coreEntityId: "merchant-1", name: "券", couponType: "全店优惠券" };
  const cancelContext = marketingWriteContext("general_coupon", "cancel", { entityId: "coupon-1", selectedEntity });
  assert.deepEqual(cancelContext.writeBody, { action: 1 });
  assert.deepEqual(cancelContext.reconcileExpectedRawStatuses, ["2"]);
  const renewContext = marketingWriteContext("general_coupon", "toggle_renew", { entityId: "coupon-1", selectedEntity, renewOn: true });
  assert.deepEqual(renewContext.writeBody, { source_merchant_activity_id: "merchant-1", source_core_activity_id: "coupon-1", operation_type: "switch_on_renew" });
  assert.equal(renewContext.reconcileExpectedAutoRenew, true);
});

test("new-user bonus prechecks, write payloads and product batching match XZB", () => {
  const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const endTime = new Date(Date.parse(startTime) + 30 * 24 * 60 * 60 * 1000).toISOString();
  const base = {
    operationId: "op-bonus",
    scope: "product",
    productIds: ["p1"],
    selectedProducts: [{ entityId: "p1", name: "商品一", imageUrl: "https://example.test/p1.png", priceFen: 10000 }],
    startTime,
    endTime,
    discountMode: "reduce",
    discountValue: "2",
    newUserFloatingAmount: true,
    newUserMaximumDiscountValue: "3",
    newUserNameMode: "prefix",
    newUserNamePrefix: "测试礼金",
    officialRenew: true
  };

  assert.deepEqual(newUserBonusPreflightBody(base, 2), {
    activity_tool_type: 4,
    activity_tool_discount_type: 1,
    start_time: Math.floor(Date.parse(startTime) / 1000),
    end_time: Math.floor(Date.parse(endTime) / 1000),
    participate_type: 1,
    validate_type: 2,
    product_infos: [{ product_id: "p1", credit: 200 }]
  });
  assert.equal(newUserBonusPreflightBody({ ...base, discountMode: "discount", discountValue: "9" }, 2).product_infos[0].credit, 1000);
  assert.deepEqual(newUserBonusPreflightBody({ ...base, scope: "shop", productIds: [] }, 1), {
    activity_tool_type: 4,
    activity_tool_discount_type: 1,
    start_time: Math.floor(Date.parse(startTime) / 1000),
    end_time: Math.floor(Date.parse(endTime) / 1000),
    participate_type: 2,
    validate_type: 1
  });
  assert.equal(newUserBonusPreflightBody({ ...base, scope: "shop", productIds: [] }, 2).credit, 200);

  const writeContext = marketingWriteContext("new_user_bonus", "create", base);
  assert.equal(writeContext.writeBody.activity_id, NEW_USER_BONUS_ACTIVITY_ID);
  assert.equal(writeContext.writeBody.deduction_discount_type, 1);
  assert.deepEqual(writeContext.writeBody.product_deductions, [{
    product_id: "p1",
    name: "商品一",
    img: "https://example.test/p1.png",
    shop_deduction_credit: 200,
    max_shop_deduction_credit: 300
  }]);
  assert.equal(writeContext.preflightExclusiveBody.validate_type, 1);
  assert.ok(newUserBonusName(base).startsWith("测试礼金 "));

  const fixedContext = marketingWriteContext("new_user_bonus", "create", { ...base, newUserFloatingAmount: false });
  assert.equal(fixedContext.writeBody.deduction_discount_type, 0);
  assert.equal("max_shop_deduction_credit" in fixedContext.writeBody.product_deductions[0], false);

  const productIds = Array.from({ length: 1201 }, (_, index) => String(900000 + index));
  const batches = splitNewUserBonusCreateBatches({ ...base, productIds, selectedProducts: productIds.map((entityId) => ({ entityId })), newUserProductsPerActivity: "500" });
  assert.deepEqual(batches.map((batch) => batch.productCount), [500, 500, 201]);
  assert.equal(batches[2].context.newUserBatchIndex, 3);
  assert.equal(batches[2].context.newUserBatchCount, 3);

  const disableContext = marketingWriteContext("new_user_bonus", "disable", { entityId: "bonus-1", selectedEntity: { entityId: "bonus-1", name: "新人礼金" } });
  assert.deepEqual(disableContext.writeBody, { activity_id: NEW_USER_BONUS_ACTIVITY_ID, apply_id: "bonus-1" });
  assert.deepEqual(disableContext.reconcileExpectedRawStatuses, ["5"]);
});

test("new-user bonus validation and adapter lifecycle fail closed", () => {
  const store = { shopId: "shop-1", partition: "persist:shop-1", storeGeneration: 1 };
  const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const valid = {
    feature: "new_user_bonus",
    action: "create",
    stores: [store],
    context: {
      scope: "product",
      productIds: ["p1"],
      selectedProducts: [{ entityId: "p1", priceFen: 10000 }],
      startTime,
      endTime: new Date(Date.parse(startTime) + 30 * 24 * 60 * 60 * 1000).toISOString(),
      discountMode: "reduce",
      discountValue: "2",
      newUserDurationDays: "30",
      newUserNameMode: "default",
      newUserFloatingAmount: true,
      newUserMaximumDiscountValue: "3",
      newUserProductsPerActivity: "500",
      officialRenew: true
    }
  };
  assert.deepEqual(marketingTaskInputErrors(valid), []);

  const invalidMaximum = structuredClone(valid);
  invalidMaximum.context.newUserMaximumDiscountValue = "1";
  assert.ok(marketingTaskInputErrors(invalidMaximum).includes("context.newUserMaximumDiscountValue must exceed discountValue for reduction"));
  const invalidShop = structuredClone(valid);
  Object.assign(invalidShop.context, { scope: "shop", productIds: [], discountMode: "discount", discountValue: "9", newUserMaximumDiscountValue: "8" });
  assert.ok(marketingTaskInputErrors(invalidShop).includes("new_user_bonus shop scope only supports reduction"));
  const invalidHorizon = structuredClone(valid);
  invalidHorizon.context.startTime = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
  invalidHorizon.context.endTime = new Date(Date.parse(invalidHorizon.context.startTime) + 30 * 24 * 60 * 60 * 1000).toISOString();
  assert.ok(marketingTaskInputErrors(invalidHorizon).includes("new_user_bonus startTime must be within 30 days"));

  const plans = pilotAdapter.requestPlans;
  assert.equal(pilotAdapter.endpoints.marketingNewUserBonusDisable, "/marketing/union_allowance/v1/disable_apply");
  assert.equal(plans.marketingNewUserBonusDisable.sign, true);
  assert.equal(plans.marketingNewUserBonusDisable.maxAttempts, 1);
  assert.equal(plans.marketingNewUserBonusDisable.retryOnHttpError, false);
  assert.equal(plans.marketingNewUserBonusDisable.reconcilePlanKey, "marketingNewUserBonusDetail");
  assert.deepEqual(pilotAdapter.policies.marketing.features.new_user_bonus.writeActions.create.precheckPlanKeysByScope.shop, ["marketingNewUserBonusCreateExclusivePrecheck", "marketingNewUserBonusCreatePrecheck"]);
  assert.ok(pilotAdapter.responseMappings.marketing.new_user_bonus.preflight.rejectedItemPaths.includes("data.goodsCheckInfos"));
  assert.ok(pilotAdapter.responseMappings.marketing.new_user_bonus.preflight.statusPaths.includes("data.records.0.status"));
});

test("general coupon adapter maps verified lifecycle values and management contracts", () => {
  const feature = pilotAdapter.responseMappings.marketing.general_coupon;
  assert.deepEqual(feature.fields.status.valueMap, { 2: "已作废", 3: "生效中", 4: "已过期", 12: "创建中", 13: "未开始" });
  assert.deepEqual(feature.fields.coreEntityId.paths, ["merchant_activity_id"]);
  assert.equal(pilotAdapter.requestPlans.marketingGeneralCouponCreate.reconcilePlanKey, "marketingGeneralCouponReconcileList");
  assert.equal(pilotAdapter.requestPlans.marketingGeneralCouponCancel.reconcilePlanKey, "marketingGeneralCouponDetail");
  assert.equal(pilotAdapter.requestPlans.marketingGeneralCouponToggleRenew.reconcilePlanKey, "marketingGeneralCouponDetail");
});

test("limited-time create validates SKU inventory and split ranges", () => {
  const store = { shopId: "shop-1", partition: "persist:shop-1", storeGeneration: 1 };
  const base = limitedCreateContext();
  const context = { ...base, timeSegments: splitMarketingTimeSegments(base.startTime, base.endTime, 60) };
  assert.deepEqual(marketingTaskInputErrors({ feature: "limited_time", action: "create", stores: [store], context }), []);
  assert.ok(marketingTaskInputErrors({ feature: "limited_time", action: "create", stores: [store], context: { ...context, stockValue: 0 } }).includes("context.stockValue must be a positive integer"));
  assert.ok(marketingTaskInputErrors({ feature: "limited_time", action: "create", stores: [store], context: { ...context, scope: "shop" } }).includes("limited_time only supports product scope"));
  assert.ok(marketingTaskInputErrors({ feature: "limited_time", action: "create", stores: [store], context: { ...context, activityType: "limited", stockLimitMode: "unlimited" } }).includes("limited quantity activities must use limited stock"));
  assert.ok(marketingTaskInputErrors({ feature: "limited_time", action: "create", stores: [store], context: { ...context, skuMode: "lowest" } }).includes("limited-time and limited-quantity activities must use all SKUs"));
});

test("limited-time pricing sends direct-reduction amount instead of the final sale price", () => {
  const context = limitedCreateContext({ discountMode: "reduce", discountValue: "10", priceTiers: [{ minPrice: "0", maxPrice: "999999", value: "10", purchaseLimit: "2" }], selectedProducts: [{ entityId: "p1", name: "product" }], productIds: ["p1"] });
  const built = buildLimitedTimePromotionGoods(context, [{ product_id: "p1", name: "product", stock_num: 500, sku_list: [{ sku_id: "s1", origin_price: 19900, origin_stock: 500 }] }]);
  assert.equal(built.rejected.length, 0);
  assert.equal(built.promotionGoods[0].promotion_skus[0].shop_svalue, "1000");
  assert.equal(built.promotionGoods[0].promotion_skus[0].user_limit, "2");
  assert.equal(built.promotionGoods[0].activity_limit_num, 100);
});

test("limited-time pricing rejects under-discounted prices instead of silently lowering them", () => {
  const base = limitedCreateContext({ selectedProducts: [{ entityId: "p1", name: "product" }], productIds: ["p1"] });
  const rows = [{ product_id: "p1", name: "product", stock_num: 500, sku_list: [{ sku_id: "s1", origin_price: 19900, origin_stock: 500 }] }];
  const reduce = buildLimitedTimePromotionGoods({ ...base, discountMode: "reduce", priceTiers: [{ minPrice: "0", maxPrice: "999999", value: "1", purchaseLimit: "1" }] }, rows);
  const fixed = buildLimitedTimePromotionGoods({ ...base, discountMode: "fixed_price", priceTiers: [{ minPrice: "0", maxPrice: "999999", value: "198", purchaseLimit: "1" }] }, rows);
  assert.equal(reduce.promotionGoods.length, 0);
  assert.match(reduce.rejected[0].reason, /至少优惠5%/);
  assert.equal(fixed.promotionGoods.length, 0);
  assert.match(fixed.rejected[0].reason, /至少优惠5%/);
});

test("limited-time price modes, stock modes and SKU selectors map to platform fields", () => {
  const rows = [{ product_id: "p1", name: "product", stock_num: 500, sku_list: [{ sku_id: "low", origin_price: 10000, origin_stock: 5 }, { sku_id: "high", origin_price: 20000, origin_stock: 50 }] }];
  const base = limitedCreateContext({ selectedProducts: [{ entityId: "p1" }], productIds: ["p1"], autoMinPrice15: true, stockMode: "percent", stockPercent: "50", skuMode: "highest", priceTiers: [{ minPrice: "0", maxPrice: "999999", value: "9", purchaseLimit: "1" }] });
  const discount = buildLimitedTimePromotionGoods(base, rows);
  assert.deepEqual(discount.promotionGoods[0].promotion_skus.map((sku) => sku.id), ["high"]);
  assert.equal(discount.promotionGoods[0].promotion_skus[0].shop_svalue, "90");
  assert.equal(discount.promotionGoods[0].activity_limit_num, 250);
  const fixed = buildLimitedTimePromotionGoods({ ...base, discountMode: "fixed_price", priceTiers: [{ minPrice: "0", maxPrice: "999999", value: "88", purchaseLimit: "1" }] }, rows);
  assert.equal(fixed.promotionGoods[0].promotion_skus[0].price, "8800");
  const onePriceDiscount = buildLimitedTimePromotionGoods({ ...base, discountMode: "one_price_discount", priceTiers: [{ minPrice: "0", maxPrice: "999999", value: "9", reduction: "10", purchaseLimit: "1" }] }, rows);
  assert.equal(onePriceDiscount.promotionGoods[0].promotion_skus[0].price, "17000");
  const first = buildLimitedTimePromotionGoods({ ...base, activityType: "ordinary", stockLimitMode: "unlimited", skuMode: "first" }, rows);
  assert.deepEqual(first.promotionGoods[0].promotion_skus.map((sku) => sku.id), ["low"]);
});

test("limited-time range splitting applies activity duration and SKU limits", () => {
  const startTime = "2026-07-20T00:00:00.000Z";
  const endTime = "2026-07-27T00:00:00.000Z";
  const segments = limitedTimeActivitySegments({ activityType: "flash", timeMode: "range", startTime, endTime });
  assert.equal(segments.length, 2);
  const products = [
    { entityId: "p1", skuCount: 3000 },
    { entityId: "p2", skuCount: 1500 }
  ];
  const batches = splitLimitedTimeCreateBatches({ activityType: "flash", timeMode: "range", startTime, endTime, productIds: ["p1", "p2"], selectedProducts: products, productLimitPerActivity: "200", timeSegments: segments });
  assert.equal(LIMITED_TIME_ACTIVITY_SKU_LIMIT, 4000);
  assert.equal(batches.length, 4);
  assert.deepEqual(batches.map((batch) => batch.productCount), [1, 1, 1, 1]);
});

test("limited-time adapter mapping matches verified XZB response fields", () => {
  const mapping = pilotAdapter.responseMappings.marketing.limited_time;
  assert.ok(mapping.fields.entityId.paths.includes("campagin_id"));
  assert.ok(mapping.fields.startTime.paths.includes("begin_time"));
  assert.ok(mapping.fields.productCount.paths.includes("product_total"));
  assert.ok(mapping.fields.failureReason.paths.includes("reject_msg"));
  assert.equal(mapping.fields.status.valueMap[3], "已失效");
  assert.equal(mapping.fields.status.valueMap[4], "已结束");
  assert.equal(mapping.fields.status.valueMap[6], "处理中");
  assert.deepEqual(mapping.listPaths, ["data.flash_list", "data.data.flash_list"]);
});

test("limited-time segmentation and failure export preserve structured values", () => {
  const segments = splitMarketingTimeSegments("2026-08-01T00:00:00.000Z", "2026-08-01T02:00:00.000Z", 60);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].endTime, "2026-08-01T01:00:00.000Z");
  assert.equal(segments[1].startTime, "2026-08-01T01:00:01.000Z");
  const csv = marketingFailuresCsv([{ id: "f1", operationId: "op", shopId: "s1", itemType: "product", itemId: "90071992547409930", stage: "create", reasonCode: "bad,request", message: "line\nmessage" }]);
  assert.match(csv, /90071992547409930/);
  assert.match(csv, /"bad,request"/);
  assert.match(csv, /line message/);
});

test("limited-time create splits platform-sized activities and keeps product metadata aligned", () => {
  const productIds = Array.from({ length: 424 }, (_, index) => String(90071992547400000n + BigInt(index)));
  const selectedProducts = productIds.map((entityId, index) => ({ entityId, name: `product-${index}` }));
  const batches = splitLimitedTimeCreateBatches({
    operationId: "marketingTask-1784421658974-n530z5",
    name: "暑期活动",
    nameMode: "prefix",
    productIds,
    selectedProducts,
    startTime: "2026-08-01T00:00:00.000Z",
    endTime: "2026-08-01T02:00:00.000Z",
    discountMode: "discount",
    discountValue: "9",
    activityType: "flash"
  });

  assert.equal(LIMITED_TIME_ACTIVITY_PRODUCT_LIMIT, 200);
  assert.deepEqual(batches.map((batch) => batch.productCount), [200, 200, 24]);
  assert.deepEqual(batches.map((batch) => batch.context.name), ["暑期活动 1/3", "暑期活动 2/3", "暑期活动 3/3"]);
  assert.deepEqual(batches.flatMap((batch) => batch.context.productIds), productIds);
  assert.deepEqual(batches.flatMap((batch) => batch.context.selectedProducts).map((product) => product.entityId), productIds);
  for (const batch of batches) {
    const writeContext = marketingWriteContext("limited_time", "create", batch.context);
    assert.equal(writeContext.preflightBody.product_infos.length, batch.productCount);
    assert.equal(writeContext.limitedTimeSkuQueryBody.channel_products.length, batch.productCount);
    assert.ok(writeContext.preflightBody.product_infos.length <= LIMITED_TIME_ACTIVITY_PRODUCT_LIMIT);
    assert.match(writeContext.writeBody.title, /^暑期活动/);
  }
});

test("limited-time create keeps a single activity unchanged at the platform limit", () => {
  const productIds = Array.from({ length: LIMITED_TIME_ACTIVITY_PRODUCT_LIMIT }, (_, index) => String(index + 1));
  const batches = splitLimitedTimeCreateBatches({ name: "单批活动", productIds });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].context.name, "单批活动");
  assert.deepEqual(batches[0].context.productIds, productIds);
});

test("limited-time batch aggregation distinguishes success, partial failure and unknown writes", () => {
  const store = { shopId: "shop-1", shopName: "测试店铺" };
  const outcome = (batchIndex, status, ok, message = "write accepted") => ({
    unit: { batchIndex, batchCount: 3, productCount: batchIndex === 3 ? 24 : 200 },
    result: { shopId: store.shopId, shopName: store.shopName, ok, status, message, entities: [], total: 0 }
  });

  const succeeded = aggregateLimitedTimeCreate(store, [outcome(1, "accepted", true), outcome(2, "accepted", true), outcome(3, "accepted", true)]);
  assert.equal(succeeded.status, "accepted");
  assert.equal(succeeded.createdActivityCount, 3);
  assert.equal(succeeded.productCount, 424);
  assert.match(succeeded.message, /已创建 3 个活动，共 424 个商品/);

  const partial = aggregateLimitedTimeCreate(store, [outcome(1, "accepted", true), outcome(2, "failed", false, "520100001: 平台拒绝"), outcome(3, "accepted", true)]);
  assert.equal(partial.status, "partial");
  assert.equal(partial.createdActivityCount, 2);
  assert.equal(partial.failedActivityCount, 1);
  assert.equal(partial.productCount, 224);
  assert.match(partial.message, /第 2\/3 批创建失败：520100001: 平台拒绝/);

  const unknown = aggregateLimitedTimeCreate(store, [outcome(1, "accepted", true), outcome(2, "unknown", false), outcome(3, "cancelled", false)]);
  assert.equal(unknown.status, "reconciling");
  assert.equal(unknown.createdActivityCount, 1);
  assert.equal(unknown.unknownActivityCount, 1);
  assert.match(unknown.message, /停止后续批次并进入对账/);
});

test("marketing platform failures preserve the business code and specific rejection", () => {
  assert.equal(
    platformFailureMessage({ code: 520100001, msg: "单个活动最多支持200个商品，已达到数量限制" }, "generic failure", "fallback"),
    "520100001: 单个活动最多支持200个商品，已达到数量限制"
  );
});

test("tool-renew schedule due check is fail closed for paused and leased records", () => {
  const base = { id: "marketing:schedule:limited_time:s1:a1", kind: "marketing-schedule", feature: "limited_time", action: "tool_renew", shopId: "s1", entityId: "a1", partition: "persist:s1", adapterSnapshotHash: "snapshot-1", intervalMs: 86400000, nextRunAt: "2026-08-01T00:00:00.000Z", status: "active", failureCount: 0, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" };
  assert.equal(marketingScheduleDue(base, Date.parse("2026-08-02T00:00:00.000Z")), true);
  assert.equal(marketingScheduleDue({ ...base, status: "paused" }, Date.parse("2026-08-02T00:00:00.000Z")), false);
  assert.equal(marketingScheduleDue({ ...base, leaseUntil: "2026-08-03T00:00:00.000Z" }, Date.parse("2026-08-02T00:00:00.000Z")), false);
  assert.equal(marketingScheduleDue({ ...base, status: "running", leaseUntil: "2026-08-01T12:00:00.000Z" }, Date.parse("2026-08-02T00:00:00.000Z")), true);
  assert.equal(marketingScheduleDue({ ...base, status: "running", leaseUntil: "2026-08-03T00:00:00.000Z" }, Date.parse("2026-08-02T00:00:00.000Z")), false);
});

test("declared marketing concurrency bounds active store work and preserves result order", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 4, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
  const limit = createConcurrencyLimiter(4);
  active = 0;
  peak = 0;
  await Promise.all(Array.from({ length: 12 }, () => limit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  })));
  assert.equal(peak, 4);
});

test("management preflight blocks unknown states and skips idempotent terminal states", () => {
  assert.equal(marketingManagementPreflight({ action: "cancel", statuses: [], writableStatuses: ["active"], idempotentStatuses: ["cancelled"] }).status, "blocked");
  assert.equal(marketingManagementPreflight({ action: "cancel", statuses: ["cancelled"], writableStatuses: ["active"], idempotentStatuses: ["cancelled"] }).status, "skip");
  assert.equal(marketingManagementPreflight({ action: "cancel", statuses: ["active"], writableStatuses: ["active"], idempotentStatuses: ["cancelled"] }).status, "ready");
  assert.equal(marketingManagementPreflight({ action: "cancel", statuses: ["expired"], writableStatuses: ["active"], idempotentStatuses: ["cancelled"] }).status, "blocked");
});

test("reconciliation only confirms unique evidence and requires completeness for not-found", () => {
  const mapping = { listPaths: ["data.list"], totalPaths: ["data.total"], reconciliation: { completePaths: ["data.complete"] }, fields: { entityId: { paths: ["id"] }, name: { paths: ["name"] }, status: { paths: ["status"] }, autoRenew: { paths: ["autoRenew"] }, startTime: { paths: ["start"] }, endTime: { paths: ["end"] } } };
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: true, list: [{ id: "a1" }] } }, mapping, expectedEntityIds: ["a1"] }).status, "unique");
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: false, list: [] } }, mapping, expectedEntityIds: ["a1"] }).status, "unknown");
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: true, list: [] } }, mapping, expectedEntityIds: ["a1"] }).status, "not_found");
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: true, list: [{ id: "a1", name: "sale" }, { id: "a2", name: "sale" }] } }, mapping, context: { name: "sale" } }).status, "conflict");
  assert.equal(marketingReconciliationDecision({ data: { data: { total: 2, list: [] } }, mapping, expectedEntityIds: ["a1"] }).status, "unknown");
  assert.equal(marketingReconciliationDecision({ data: { data: { total: 0, list: [] } }, mapping, expectedEntityIds: ["a1"] }).status, "not_found");
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: true, list: [{ id: "a1", status: 3 }] } }, mapping, expectedEntityIds: ["a1"], context: { reconcileExpectedRawStatuses: ["2"] } }).status, "unknown");
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: true, list: [{ id: "a1", status: 2 }] } }, mapping, expectedEntityIds: ["a1"], context: { reconcileExpectedRawStatuses: ["2"] } }).status, "unique");
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: true, list: [{ id: "a1", autoRenew: false }] } }, mapping, expectedEntityIds: ["a1"], context: { reconcileExpectedAutoRenew: true } }).status, "unknown");
});

test("reconciliation never succeeds without attempt evidence", () => {
  assert.equal(marketingReconciliationCompletionStatus({ attemptCount: 0, unresolved: 0, failed: 0, confirmed: 0 }), "reconciling");
  assert.equal(marketingReconciliationCompletionStatus({ attemptCount: 1, unresolved: 0, failed: 0, confirmed: 1 }), "succeeded");
});

test("limited-time reconciliation refreshes persisted activity counts", () => {
  const run = {
    id: "marketing:run:op-1", operationId: "op-1", feature: "limited_time", action: "create", status: "reconciling",
    selectedShopIds: ["shop-1"], configHash: "c", configSummary: {}, adapterVersion: "a", adapterSnapshotHash: "s", ruleVersion: "r",
    activityCount: 3, createdActivityCount: 1, failedActivityCount: 0, unknownActivityCount: 1,
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z"
  };
  const reconciled = marketingReconciledRun(run, 3, "partial", { confirmed: 2, failed: 1, unresolved: 0 }, "2026-07-19T00:10:00.000Z");
  assert.equal(reconciled.createdActivityCount, 2);
  assert.equal(reconciled.failedActivityCount, 1);
  assert.equal(reconciled.unknownActivityCount, 0);
  assert.match(reconciled.message, /已确认创建 2\/3 个活动，1 个未创建/);
});

test("default create contexts produce platform preflight and mutation bodies", () => {
  const base = { operationId: "op-1", name: "campaign", scope: "product", productIds: ["90071992547409930"], selectedProducts: [{ entityId: "90071992547409930", name: "product", priceFen: 10000 }], startTime: "2026-08-01T00:00:00.000Z", endTime: "2026-09-01T00:00:00.000Z", discountMode: "discount", discountValue: "9", issueCount: "100", perUserLimit: "1", officialRenew: true, activityType: "flash" };
  for (const feature of features) {
    const context = marketingWriteContext(feature, "create", base);
    assert.ok(context.preflightBody);
    assert.ok(context.writeBody);
    assert.ok(context.reconciliationFingerprint);
  }
});

test("management contexts preserve removal product ids and reconciliation targets", () => {
  const store = { shopId: "shop-1", shopName: "shop", partition: "persist:shop-1" };
  const removal = marketingStoreContext({ productIds: ["p1", "p2"], productIdsByShop: {} }, store, "op-1", "remove_products");
  assert.deepEqual(removal.productIds, ["p1", "p2"]);
  const create = marketingStoreContext({ productIds: ["wrong"], productIdsByShop: { "shop-1": ["right"] } }, store, "op-1", "create");
  assert.deepEqual(create.productIds, ["right"]);

  const disabled = marketingWriteContext("limited_time", "disable", { entityId: "a1" });
  assert.deepEqual(disabled.reconcileExpectedRawStatuses, ["3"]);
  const renewed = marketingWriteContext("limited_time", "toggle_renew", { entityId: "a1", renewOn: true, selectedEntity: { entityId: "a1", coreEntityId: "c1" } });
  assert.equal(renewed.reconcileExpectedAutoRenew, true);
});

test("normal fixture builds use contract samples while strict evidence remains available", () => {
  const auditSource = fs.readFileSync(new URL("../../scripts/audit-doudian-marketing-fixtures.mjs", import.meta.url), "utf8");
  const appSource = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(auditSource, /doudian-adapter\.marketing-pilot\.json/);
  assert.match(auditSource, /fixture_set_empty/);
  assert.match(auditSource, /real-session-capture/);
  assert.match(auditSource, /missingRealCases/);
  assert.match(auditSource, /const realEvidenceRequired = requireRealFixtures/);
  assert.match(appSource, /ok: false, status: "not-run-empty-list"/);
  assert.match(packageJson.scripts["build:release"], /test:marketing-fixtures/);
  assert.match(packageJson.scripts["test:marketing-real-fixtures"], /--require-real/);
});

test("adapter snapshot hash is canonical and changes with the remote contract", () => {
  const adapter = marketingAdapter();
  const first = marketingAdapterSnapshotHash({ adapter });
  const reordered = reorderedObject(adapter);
  assert.equal(first, marketingAdapterSnapshotHash({ adapter: reordered }));
  adapter.version = `${adapter.version}-changed`;
  assert.notEqual(first, marketingAdapterSnapshotHash({ adapter }));
});
