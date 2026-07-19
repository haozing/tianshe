import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { isValidMarketingContractConfig } from "../src/bridge/marketingContract.ts";
import { marketingPageAccessEnabled, marketingWriteAccessEnabled } from "../src/domain/doudian/marketing/access.ts";
import { clampRequestTimeoutMs, isUnknownWriteResponse, mutationRequestAttemptLimit, mutationRequestPlanSafetyError } from "../src/domain/doudian/requestPlanSafety.ts";
import { isDoudianMutationTask, mutationCancellationOutcome, restartRecoveryStatus } from "../src/domain/doudian/taskSafety.ts";
import { marketingTaskInputErrors } from "../src/domain/doudian/marketing/validation.ts";
import { marketingFailuresCsv } from "../src/domain/doudian/marketing/export.ts";
import { marketingScheduleDue } from "../src/domain/doudian/marketing/schedulerPolicy.ts";
import { splitMarketingTimeSegments } from "../src/domain/doudian/marketing/limitedTime.ts";
import { marketingManagementPreflight } from "../src/domain/doudian/marketing/preflightPolicy.ts";
import { marketingReconciliationCompletionStatus, marketingReconciliationDecision } from "../src/domain/doudian/marketing/reconciliationPolicy.ts";
import { marketingAdapterSnapshotHash } from "../src/domain/doudian/marketing/snapshot.ts";
import { createConcurrencyLimiter, mapWithConcurrency } from "../src/domain/doudian/marketing/concurrency.ts";
import { marketingWriteContext } from "../src/domain/doudian/marketing/writeContext.ts";

const baseAdapter = JSON.parse(fs.readFileSync(new URL("../public/config/doudian-adapter.json", import.meta.url), "utf8"));
const pilotAdapter = JSON.parse(fs.readFileSync(new URL("../public/config/doudian-adapter.marketing-pilot.json", import.meta.url), "utf8"));
const features = ["limited_time", "new_user_bonus", "general_coupon"];

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
    new_user_bonus: ["create", "disable", "toggle_renew"],
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

test("marketing pilot validates reads and advertises one safe create contract per page", () => {
  assert.equal(isValidMarketingContractConfig(pilotAdapter), true);
  for (const feature of features) {
    assert.deepEqual(pilotAdapter.capabilities.marketing.features[feature].writeActions, ["create"]);
    assert.ok(pilotAdapter.policies.marketing.features[feature].writeActions.create.mutationPlanKey);
  }
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
  assert.equal(marketingWriteAccessEnabled(config, adapter, "general_coupon", "marketingGeneralCoupon", "create", true, true), true);
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
      officialRenew: true
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
});

test("phase 2-4 actions are feature-scoped and require their own context", () => {
  const store = { shopId: "shop-1", partition: "persist:shop-1", storeGeneration: 1 };
  assert.ok(marketingTaskInputErrors({ feature: "new_user_bonus", action: "cancel", stores: [store], context: { entityIds: ["bonus-1"] } }).some((error) => error.includes("not supported")));
  assert.ok(marketingTaskInputErrors({ feature: "limited_time", action: "remove_products", stores: [store], context: { entityIds: ["activity-1"] } }).includes("context.productIds are required for remove_products"));
  assert.ok(marketingTaskInputErrors({ feature: "limited_time", action: "tool_renew", stores: [store], context: { entityIds: ["activity-1"], intervalDays: 0 } }).includes("context.intervalDays must be a positive integer"));
  assert.deepEqual(marketingTaskInputErrors({ feature: "limited_time", action: "bulk_edit", stores: [store], context: { entityIds: ["activity-1"], fields: { endTime: "2026-08-02T00:00:00.000Z" } } }), []);
});

test("limited-time create validates SKU inventory and split ranges", () => {
  const store = { shopId: "shop-1", partition: "persist:shop-1", storeGeneration: 1 };
  const context = { scope: "product", productIds: ["90071992547409930"], startTime: "2026-08-01T00:00:00.000Z", endTime: "2026-08-01T02:00:00.000Z", discountMode: "discount", discountValue: "9", activityType: "flash", stockValue: "100", purchaseLimit: "1", skuMode: "all", timeSegments: splitMarketingTimeSegments("2026-08-01T00:00:00.000Z", "2026-08-01T02:00:00.000Z", 60) };
  assert.deepEqual(marketingTaskInputErrors({ feature: "limited_time", action: "create", stores: [store], context }), []);
  assert.ok(marketingTaskInputErrors({ feature: "limited_time", action: "create", stores: [store], context: { ...context, stockValue: 0 } }).includes("context.stockValue must be a positive integer"));
});

test("limited-time segmentation and failure export preserve structured values", () => {
  const segments = splitMarketingTimeSegments("2026-08-01T00:00:00.000Z", "2026-08-01T02:00:00.000Z", 60);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].endTime, "2026-08-01T01:00:00.000Z");
  const csv = marketingFailuresCsv([{ id: "f1", operationId: "op", shopId: "s1", itemType: "product", itemId: "90071992547409930", stage: "create", reasonCode: "bad,request", message: "line\nmessage" }]);
  assert.match(csv, /90071992547409930/);
  assert.match(csv, /"bad,request"/);
  assert.match(csv, /line message/);
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
  const mapping = { listPaths: ["data.list"], reconciliation: { completePaths: ["data.complete"] }, fields: { entityId: { paths: ["id"] }, name: { paths: ["name"] }, startTime: { paths: ["start"] }, endTime: { paths: ["end"] } } };
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: true, list: [{ id: "a1" }] } }, mapping, expectedEntityIds: ["a1"] }).status, "unique");
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: false, list: [] } }, mapping, expectedEntityIds: ["a1"] }).status, "unknown");
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: true, list: [] } }, mapping, expectedEntityIds: ["a1"] }).status, "not_found");
  assert.equal(marketingReconciliationDecision({ data: { data: { complete: true, list: [{ id: "a1", name: "sale" }, { id: "a2", name: "sale" }] } }, mapping, context: { name: "sale" } }).status, "conflict");
});

test("reconciliation never succeeds without attempt evidence", () => {
  assert.equal(marketingReconciliationCompletionStatus({ attemptCount: 0, unresolved: 0, failed: 0, confirmed: 0 }), "reconciling");
  assert.equal(marketingReconciliationCompletionStatus({ attemptCount: 1, unresolved: 0, failed: 0, confirmed: 1 }), "succeeded");
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

test("fixture and smoke gates cannot pass without real detail evidence", () => {
  const auditSource = fs.readFileSync(new URL("../../scripts/audit-doudian-marketing-fixtures.mjs", import.meta.url), "utf8");
  const appSource = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(auditSource, /doudian-adapter\.marketing-pilot\.json/);
  assert.match(auditSource, /fixture_set_empty/);
  assert.match(appSource, /ok: false, status: "not-run-empty-list"/);
  assert.match(packageJson.scripts["build:release"], /test:marketing-fixtures/);
});

test("adapter snapshot hash is canonical and changes with the remote contract", () => {
  const adapter = marketingAdapter();
  const first = marketingAdapterSnapshotHash({ adapter });
  const reordered = reorderedObject(adapter);
  assert.equal(first, marketingAdapterSnapshotHash({ adapter: reordered }));
  adapter.version = `${adapter.version}-changed`;
  assert.notEqual(first, marketingAdapterSnapshotHash({ adapter }));
});
