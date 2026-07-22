const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  TASK_DEFINITIONS,
  allowedPlanKeys,
  materializeDataScopes,
  platformOrigins,
  recoveryPlanKeys,
  validateTaskParams
} = require("../src/main/tasks/task-registry");

const adapter = require("../../remote-web/client-shell/public/config/doudian-adapter.marketing-pilot.json");
const { paidDataRequest, runnerDataAllowed } = require("../src/main/license/data-access-policy");
const { interruptedTaskStatus, opportunitySubmitProgressStalled, taskResultPersistence, terminalTaskStatus } = require("../src/main/tasks/task-result-policy");
const { httpTransportFingerprint, runnerPartitionAllowed, transportMatchesPlan, transportMatchesPlanTemplate } = require("../src/main/tasks/task-transport-policy");
const { taskWindowCommandScript } = require("../src/main/tasks/task-window-commands");
const { urlMatchesPrincipal } = require("../src/main/security/web-contents-principal");
const { MAIN_WINDOW_ONLY_CHANNELS, mainWindowControlDecision } = require("../src/main/license/window-control-policy");
const { parseVerifiedReleaseUrl, verifiedReleaseEntryUrl } = require("../src/main/security/remote-web-integrity");

test("task registry contains the audited free and paid boundary", () => {
  for (const taskType of ["fetchDoudianStores", "businessData", "fundsData", "violationsData", "staleGoodsScan", "staleGoodsExecute", "bulkDeleteScan", "bulkDeleteExecute"]) {
    assert.equal(TASK_DEFINITIONS[taskType]?.accessTier, "free", taskType);
  }
  for (const taskType of ["opportunityReportScan", "opportunityReportAction", "opportunityFavoriteCategories", "opportunityPipelineSubmit", "opportunityAutoFavorites", "opportunityFavoritesClearInvalid", "marketingTask"]) {
    assert.equal(TASK_DEFINITIONS[taskType]?.accessTier, "paid", taskType);
  }
  assert.equal(TASK_DEFINITIONS.marketingReconcile.accessTier, "recovery");
  assert.equal(TASK_DEFINITIONS.mockLongTask.accessTier, "internal");
});

test("task params reject renderer-controlled transport and policy fields", () => {
  for (const params of [
    { doudianAdapter: {} },
    { nested: { url: "https://example.test" } },
    { stores: [{ shopId: "1", partition: "persist:forged" }] },
    { headers: { authorization: "secret" } },
    { mutation: false },
    { script: "fetch('https://example.test')" }
  ]) {
    assert.throws(() => validateTaskParams("businessData", params), (error) => error.code === "TASK_PARAMS_INVALID");
  }
});

test("task-specific modes fail closed", () => {
  assert.deepEqual(validateTaskParams("fetchDoudianStores", { mode: "discover" }), { mode: "discover" });
  assert.deepEqual(validateTaskParams("fetchDoudianStores", {
    mode: "login_selected",
    repairShopIds: ["1001"],
    repairShopNames: ["测试店铺"],
    sourceOperationId: "store-1720000000000-abc123"
  }), {
    mode: "login_selected",
    repairShopIds: ["1001"],
    repairShopNames: ["测试店铺"],
    sourceOperationId: "store-1720000000000-abc123"
  });
  assert.throws(() => validateTaskParams("fetchDoudianStores", { mode: "login_all" }), /mode is invalid/);
  assert.throws(() => validateTaskParams("fetchDoudianStores", { mode: "login_selected", repairShopIds: ["1001"] }), /sourceOperationId is invalid/);
  assert.deepEqual(validateTaskParams("bulkDeleteScan", { mode: "scan", shopIds: ["1"] }), { mode: "scan", shopIds: ["1"] });
  assert.throws(() => validateTaskParams("bulkDeleteExecute", { mode: "scan" }), /mode must be execute/);
  assert.throws(() => validateTaskParams("opportunityReportScan", { mode: "collect" }), /mode is invalid/);
  assert.throws(() => validateTaskParams("notRegistered", {}), (error) => error.code === "TASK_TYPE_DENIED");
});

test("task params use a per-task top-level schema", () => {
  assert.throws(() => validateTaskParams("businessData", { shopIds: ["1"], action: "delete" }), /not allowed for businessData/);
  assert.throws(() => validateTaskParams("fetchDoudianStores", { timeoutMs: 60 * 60_000 }), /outside the allowed range/);
  assert.throws(() => validateTaskParams("marketingTask", { feature: "limited_time", action: "forged", stores: [{ shopId: "1" }], context: {} }), /not enabled/);
  assert.doesNotThrow(() => validateTaskParams("marketingTask", { feature: "limited_time", action: "list", stores: [{ shopId: "1" }], context: {} }));
});

test("each task receives only its audited request plans", () => {
  assert.deepEqual(allowedPlanKeys(TASK_DEFINITIONS.fetchDoudianStores, adapter).sort(), ["currentShop", "shopList"]);
  assert.deepEqual(allowedPlanKeys(TASK_DEFINITIONS.bulkDeleteExecute, adapter).sort(), ["bulkDeleteBatchDelete", "bulkDeleteCompleteDelete", "bulkDeleteProductList"]);
  assert.deepEqual(allowedPlanKeys(TASK_DEFINITIONS.violationsData, adapter).sort(), ["violationPenaltyTicketList", "violationRiskTicketList"]);
  const businessPlans = allowedPlanKeys(TASK_DEFINITIONS.businessData, adapter);
  assert.equal(businessPlans.includes("businessHomepage"), true);
  assert.equal(businessPlans.some((key) => key.startsWith("marketing") || key.startsWith("opportunity")), false);

  const marketingRead = { feature: "general_coupon", action: "list" };
  assert.deepEqual(allowedPlanKeys(TASK_DEFINITIONS.marketingTask, adapter, marketingRead).sort(), [
    "marketingGeneralCouponListOwned",
    "marketingGeneralCouponListProduct",
    "marketingGeneralCouponListShop"
  ]);
  const marketingWrite = { feature: "limited_time", action: "create" };
  assert.equal(allowedPlanKeys(TASK_DEFINITIONS.marketingTask, adapter, marketingWrite).includes("marketingLimitedTimeCreate"), true);
  assert.deepEqual(recoveryPlanKeys(TASK_DEFINITIONS.marketingTask, adapter, marketingWrite), ["marketingLimitedTimeList"]);
});

test("runner platform origins come only from the verified adapter", () => {
  assert.deepEqual(platformOrigins(adapter).sort(), ["https://compass.jinritemai.com", "https://fxg.jinritemai.com"]);
  assert.equal(platformOrigins(adapter).includes("https://example.test"), false);
});

test("verified release principals are bound to protocol, host, release, and runner role", () => {
  const principal = {
    role: "runner",
    releaseId: "release-a",
    expectedProtocol: "chihu-release:",
    expectedHost: "verified",
    expectedOrigin: "null",
    expectedPathPrefix: "/release-a/new-remote-web/index.html"
  };
  assert.equal(urlMatchesPrincipal(principal, "chihu-release://verified/release-a/new-remote-web/index.html?runner=1"), true);
  assert.equal(urlMatchesPrincipal(principal, "chihu-release://verified/release-b/new-remote-web/index.html?runner=1"), false);
  assert.equal(urlMatchesPrincipal(principal, "chihu-release://forged/release-a/new-remote-web/index.html?runner=1"), false);
  assert.equal(urlMatchesPrincipal(principal, "chihu-release://verified/release-a/new-remote-web/index.html.evil?runner=1"), false);
  assert.equal(urlMatchesPrincipal(principal, "chihu-release://verified/release-a/new-remote-web/index.html"), false);
});

test("verified release URLs preserve the release namespace for every artifact", () => {
  const entryA = verifiedReleaseEntryUrl("release-a", "new-remote-web/index.html");
  const entryB = verifiedReleaseEntryUrl("release-b", "new-remote-web/index.html");
  assert.notEqual(entryA, entryB);
  assert.deepEqual(parseVerifiedReleaseUrl(entryA), { releaseId: "release-a", artifactPath: "new-remote-web/index.html" });
  assert.deepEqual(parseVerifiedReleaseUrl(new URL("./assets/app.js", entryA).toString()), { releaseId: "release-a", artifactPath: "new-remote-web/assets/app.js" });
  assert.equal(parseVerifiedReleaseUrl("chihu-release://forged/release-a/new-remote-web/index.html"), null);
  assert.throws(() => verifiedReleaseEntryUrl("../release", "new-remote-web/index.html"), /unsafe/);
});

test("task runners cannot invoke main-window controls", () => {
  for (const channel of ["getMainWindowInfo", "reloadHomeUrl", "resetMainWindow", "minimizeWindow", "maximizeWindow", "closeWindow", "isWindowMaximized"]) {
    assert.equal(MAIN_WINDOW_ONLY_CHANNELS.has(channel), true, channel);
    assert.equal(mainWindowControlDecision("runner", channel), false, channel);
    assert.equal(mainWindowControlDecision("main", channel), true, channel);
  }
  assert.equal(mainWindowControlDecision("runner", "isWindowDestroyed"), null);
});

test("mixed local stores keep only the audited schedule prefix free", () => {
  const channel = "native:data:records:queryByPrefix";
  assert.equal(paidDataRequest(channel, { storeName: "remote_feature_records_v1", prefix: "marketing:schedule:" }), false);
  assert.equal(paidDataRequest(channel, { storeName: "remote_feature_records_v1", prefix: "marketing:run:" }), true);
  assert.equal(paidDataRequest("native:data:records:put", { storeName: "remote_feature_records_v1", record: { id: "marketing:schedule:limited_time:1" } }), false);
  assert.equal(paidDataRequest("native:data:records:get", { storeName: "operations", taskType: "marketingTask", id: "operation-1" }), true);
  assert.equal(paidDataRequest("native:data:opportunityAttempts:count", { businessDate: "2026-07-20" }), true);
  assert.equal(paidDataRequest("native:data:features:loadOpportunityCandidates", { runId: "run-1" }), true);
  assert.equal(paidDataRequest("native:data:catalog:summarizeOpportunityRunMutations", { runId: "run-1" }), true);
});

test("runner data scopes are task-specific and marketing records are operation-owned", () => {
  const operationId = "marketingTask-123";
  const marketingContext = {
    allowedDataScopes: materializeDataScopes(TASK_DEFINITIONS.marketingTask.allowedDataScopes, operationId)
  };
  const putChannel = "native:data:records:put";
  const putManyChannel = "native:data:records:putMany";
  assert.equal(runnerDataAllowed(marketingContext, "native:data:records:get", { storeName: "remote_feature_records_v1", id: `marketing:run:${operationId}` }), true);
  assert.equal(runnerDataAllowed(marketingContext, "native:data:records:list", { storeName: "stores" }), true);
  assert.equal(runnerDataAllowed(marketingContext, putChannel, { storeName: "remote_feature_records_v1", record: { id: `marketing:run:${operationId}` } }), true);
  for (const phase of ["start", "chunk", "commit", "abort"]) {
    assert.equal(runnerDataAllowed(marketingContext, `native:data:records:putLarge:${phase}`, {
      storeName: "remote_feature_records_v1",
      recordId: `marketing:run:${operationId}`,
      sessionId: "large-record-session"
    }), true, phase);
  }
  assert.equal(runnerDataAllowed(marketingContext, "native:data:records:putLarge:chunk", {
    storeName: "remote_feature_records_v1",
    recordId: "marketing:run:other-operation",
    sessionId: "large-record-session"
  }), false);
  assert.equal(runnerDataAllowed(marketingContext, putChannel, { storeName: "remote_feature_records_v1", record: { id: "marketing:run:other-operation" } }), false);
  assert.equal(runnerDataAllowed(marketingContext, putManyChannel, { storeName: "remote_feature_records_v1", records: [
    { id: `marketing:attempt:${operationId}:1` },
    { id: `marketing:failure-shard:${operationId}:00001` }
  ] }), true);
  assert.equal(runnerDataAllowed(marketingContext, putManyChannel, { storeName: "remote_feature_records_v1", records: [
    { id: `marketing:attempt:${operationId}:1` },
    { id: "marketing:attempt:other-operation:1" }
  ] }), false);
  assert.equal(runnerDataAllowed(marketingContext, putChannel, { storeName: "operations", record: { id: operationId } }), false);

  const opportunityContext = {
    taskType: "opportunityPipelineSubmit",
    allowedStoreRefs: [{ shopId: "shop-1", tenantId: "tenant-1", storeGeneration: 2 }],
    allowedDataScopes: materializeDataScopes(TASK_DEFINITIONS.opportunityPipelineSubmit.allowedDataScopes, "opportunity-1")
  };
  assert.equal(runnerDataAllowed(opportunityContext, "native:data:records:claimOpportunitySubmitTask", {
    storeName: "opportunity_pipeline_submit_tasks_v2",
    taskId: "opportunity-1-tenant-1-shop-1-2-task-1"
  }), true);
  assert.equal(runnerDataAllowed(opportunityContext, "native:data:records:claimOpportunitySubmitTask", {
    taskId: "opportunity-1-tenant-1-shop-1-2-task-1"
  }), false);

  const recoveryContext = {
    allowedDataScopes: materializeDataScopes(TASK_DEFINITIONS.marketingReconcile.allowedDataScopes, operationId)
  };
  assert.equal(runnerDataAllowed(recoveryContext, putChannel, { storeName: "operations", record: { id: operationId } }), true);
  assert.equal(runnerDataAllowed(recoveryContext, putChannel, { storeName: "operations", record: { id: "other-operation" } }), false);

  const businessScopes = TASK_DEFINITIONS.businessData.allowedDataScopes;
  assert.equal(businessScopes.some((scope) => scope.storeName === "funds_latest" && scope.actions.includes("write")), false);
  assert.equal(businessScopes.some((scope) => scope.storeName?.startsWith("opportunity_")), false);

  const fundsContext = {
    taskType: "fundsData",
    allowedStoreRefs: [],
    allowedDataScopes: materializeDataScopes(TASK_DEFINITIONS.fundsData.allowedDataScopes, "funds-1")
  };
  assert.equal(runnerDataAllowed(fundsContext, "native:data:records:get", { storeName: "funds_latest", id: "funds-current::shop-1" }), true);
  assert.equal(runnerDataAllowed(fundsContext, "native:data:records:put", { storeName: "funds_latest", record: { id: "funds-current::shop-1" } }), true);
  assert.equal(runnerDataAllowed(fundsContext, "native:data:records:get", { storeName: "runtime_meta", id: "funds-cache-current-v1" }), false);
  assert.equal(runnerDataAllowed(fundsContext, "native:data:records:put", { storeName: "runtime_meta", record: { id: "funds-cache-current-v1" } }), false);

  const violationsContext = {
    taskType: "violationsData",
    allowedStoreRefs: [],
    allowedDataScopes: materializeDataScopes(TASK_DEFINITIONS.violationsData.allowedDataScopes, "violations-1")
  };
  assert.equal(runnerDataAllowed(violationsContext, "native:data:catalog:getProductsByIds", { shopId: "shop-1", productIds: ["1"] }), false);

  for (const definition of Object.values(TASK_DEFINITIONS)) {
    assert.equal(definition.allowedDataScopes.some((scope) => scope.commands.includes("native:data:maintenance:*")), false);
  }

  const staleContext = {
    taskType: "staleGoodsExecute",
    allowedStoreRefs: [{ shopId: "shop-1", tenantId: "tenant-1", storeGeneration: 2 }],
    allowedDataScopes: materializeDataScopes(TASK_DEFINITIONS.staleGoodsExecute.allowedDataScopes, "stale-1")
  };
  assert.equal(runnerDataAllowed(staleContext, putChannel, { storeName: "stores", record: { id: "shop-1", shopId: "shop-1" } }), true);
  assert.equal(runnerDataAllowed(staleContext, putChannel, { storeName: "stores", record: { id: "shop-2", shopId: "shop-2" } }), false);
  assert.equal(runnerDataAllowed(staleContext, "native:data:catalog:getProductsByIds", { shopId: "shop-1", productIds: ["1"] }), true);
  assert.equal(runnerDataAllowed(staleContext, "native:data:catalog:getProductsByIds", { shopId: "shop-2", productIds: ["1"] }), false);

  const bulkDeleteContext = {
    taskType: "bulkDeleteExecute",
    allowedStoreRefs: [{ shopId: "shop-1", tenantId: "tenant-1", storeGeneration: 2 }],
    allowedDataScopes: materializeDataScopes(TASK_DEFINITIONS.bulkDeleteExecute.allowedDataScopes, "bulk-delete-1")
  };
  assert.equal(runnerDataAllowed(bulkDeleteContext, putManyChannel, {
    storeName: "bulk_delete_execute_runs_v1",
    records: [{ id: "bulk-delete-1:00000000" }]
  }), true);
  assert.equal(runnerDataAllowed(staleContext, putManyChannel, {
    storeName: "bulk_delete_execute_runs_v1",
    records: [{ id: "bulk-delete-1:00000000" }]
  }), false);

  const importContext = {
    taskType: "fetchDoudianStores",
    allowedStoreRefs: [],
    allowedDataScopes: materializeDataScopes(TASK_DEFINITIONS.fetchDoudianStores.allowedDataScopes, "import-1")
  };
  assert.equal(runnerDataAllowed(importContext, putChannel, { storeName: "stores", record: { id: "new-shop", shopId: "new-shop" } }), true);
});

test("main process derives and bounds runner terminal evidence", () => {
  assert.equal(terminalTaskStatus({ result: { ok: true, status: "ok" } }), "succeeded");
  assert.equal(terminalTaskStatus({ result: { ok: true, status: "partial" } }), "partial");
  assert.equal(terminalTaskStatus({ result: { ok: false, status: "failed" } }), "failed");
  assert.equal(terminalTaskStatus({ result: { ok: false, status: "unknown" }, mutation: true }), "reconciling");
  assert.equal(terminalTaskStatus({ result: { status: "cancelled" }, resultSummary: "cancelled", currentStatus: "cancelling" }), "cancelled");
  assert.equal(terminalTaskStatus({ result: { status: "cancelled" }, mutation: true, currentStatus: "cancelling" }), "reconciling");
  assert.equal(interruptedTaskStatus({ currentStatus: "cancelling" }), "cancelled");
  assert.equal(interruptedTaskStatus({ cancellationRequested: true }), "cancelled");
  assert.equal(interruptedTaskStatus({ currentStatus: "running" }), "failed");
  assert.equal(interruptedTaskStatus({ mutation: true, currentStatus: "cancelling" }), "reconciling");
  assert.equal(interruptedTaskStatus({ mutation: true, mutationStarted: false, inFlightMutations: 0 }), "failed");
  assert.equal(interruptedTaskStatus({ mutation: true, mutationStarted: true, inFlightMutations: 0 }), "reconciling");
  assert.equal(interruptedTaskStatus({ mutation: true, mutationStarted: false, inFlightMutations: 1 }), "reconciling");
  assert.equal(interruptedTaskStatus({ mutation: true, mutationStarted: false, cancellationRequested: true }), "cancelled");
  assert.deepEqual(taskResultPersistence(undefined), { bytes: 0, messageAllowed: true, persistResult: true });
  assert.equal(taskResultPersistence({ value: "x".repeat(4 * 1024 * 1024) }).persistResult, false);
});

test("opportunity submit runner fails closed when worker progress stalls", () => {
  const now = Date.now();
  assert.equal(opportunitySubmitProgressStalled({ taskType: "businessData", lastProgress: 82, lastProgressAt: 0 }, now), false);
  assert.equal(opportunitySubmitProgressStalled({ taskType: "opportunityPipelineSubmit", lastProgress: 81, lastProgressAt: 0 }, now), false);
  assert.equal(opportunitySubmitProgressStalled({ taskType: "opportunityPipelineSubmit", lastProgress: 82, lastProgressAt: now - 60_000 }, now), false);
  assert.equal(opportunitySubmitProgressStalled({ taskType: "opportunityPipelineSubmit", lastProgress: 82, lastProgressAt: now - 301_000 }, now), true);
  assert.equal(opportunitySubmitProgressStalled({ taskType: "opportunityPipelineSubmit", lastProgress: 95, lastProgressAt: now - 301_000 }, now), false);
});

test("HTTP transport grants bind the complete request and task partition", () => {
  const transport = {
    partition: "persist:chihu_doudian_shop_1",
    url: "https://fxg.jinritemai.com/api/items?page=1",
    method: "POST",
    headers: { cookie: "session=secret", "content-type": "application/json" },
    body: { page: 1 },
    responseType: "losslessJson",
    timeoutMs: 30000
  };
  const fingerprint = httpTransportFingerprint(transport);
  assert.equal(httpTransportFingerprint({ ...transport, body: { page: 2 } }) === fingerprint, false);
  assert.equal(httpTransportFingerprint({ ...transport, headers: { ...transport.headers, cookie: "session=forged" } }) === fingerprint, false);
  assert.equal(httpTransportFingerprint({ ...transport, partition: "persist:other" }) === fingerprint, false);
  const exactPlan = { origin: "https://fxg.jinritemai.com", pathPrefix: "/api/items", pathMode: "exact", method: "POST" };
  assert.equal(transportMatchesPlan(exactPlan, transport), true);
  assert.equal(transportMatchesPlan(exactPlan, { ...transport, url: "https://fxg.jinritemai.com/api/items-forged" }), false);
  assert.equal(transportMatchesPlan({ ...exactPlan, pathMode: "segment-prefix" }, { ...transport, url: "https://fxg.jinritemai.com/api/items/123" }), true);
  assert.equal(transportMatchesPlan({ origin: "https://fxg.jinritemai.com", pathPrefix: "/api/items", pathMode: "exact", method: "GET" }, transport), false);
  const context = { allowedPartitions: new Set([transport.partition]), allowedPartitionPrefixes: new Set() };
  assert.equal(runnerPartitionAllowed(context, transport.partition), true);
  assert.equal(runnerPartitionAllowed(context, "persist:chihu_doudian_shop_2"), false);
  assert.equal(runnerPartitionAllowed(context, ""), false);
});

test("HTTP transport must be the verified plan template expansion", () => {
  const planKey = "marketingLimitedTimeDisable";
  const plan = adapter.requestPlans[planKey];
  const context = { entityId: "activity-123" };
  const url = new URL(adapter.endpoints[plan.endpointKey], adapter.origin);
  url.searchParams.set("a_bogus", "signed-value");
  const transport = {
    partition: "persist:chihu_doudian_shop_1",
    url: url.toString(),
    method: "POST",
    headers: { accept: "application/json, text/plain, */*", ...plan.headers, referer: plan.referer, cookie: "session=secret", "user-agent": "verified-signer" },
    body: { activity_id: "activity-123", status: 2 },
    responseType: "losslessJson",
    timeoutMs: 30000
  };
  assert.equal(transportMatchesPlanTemplate(adapter, planKey, context, transport), true);
  assert.equal(transportMatchesPlanTemplate(adapter, planKey, context, { ...transport, body: { activity_id: "activity-123", status: 3 } }), false);
  assert.equal(transportMatchesPlanTemplate(adapter, planKey, context, { ...transport, headers: { ...transport.headers, authorization: "forged" } }), false);
  assert.equal(transportMatchesPlanTemplate(adapter, planKey, { entityId: "activity-456" }, transport), false);

  const listKey = "marketingLimitedTimeList";
  const listPlan = adapter.requestPlans[listKey];
  const listContext = { page: 1, pageSize: 20, queryTitle: "", queryProductId: "", queryStatus: "", queryActivityType: "", queryDiscountType: "" };
  const listUrl = new URL(adapter.endpoints[listPlan.endpointKey], adapter.origin);
  for (const [key, value] of Object.entries(listPlan.query)) listUrl.searchParams.set(key, String(listContext[String(value).slice(1, -1)] ?? value));
  listUrl.searchParams.set("a_bogus", "signed-value");
  const listTransport = {
    partition: transport.partition,
    url: listUrl.toString(),
    method: "GET",
    headers: { accept: "application/json, text/plain, */*", ...listPlan.headers, referer: listPlan.referer, cookie: "session=secret", "user-agent": "verified-signer" },
    responseType: "losslessJson",
    timeoutMs: 30000
  };
  assert.equal(transportMatchesPlanTemplate(adapter, listKey, listContext, listTransport), true);
  listUrl.searchParams.delete("pageSize");
  assert.equal(transportMatchesPlanTemplate(adapter, listKey, listContext, { ...listTransport, url: listUrl.toString() }), false);

  const fallbackKey = "businessCoreIndex";
  const fallbackPlan = adapter.requestPlans[fallbackKey];
  const fallbackContext = { legacyDateType: 2, beginDateSlash: "2026/07/01", endDateSlash: "2026/07/20" };
  const fallbackUrl = new URL(adapter.endpoints[fallbackPlan.endpointKey], fallbackPlan.origin || adapter.origin);
  new URLSearchParams(fallbackPlan.rawQuery.replace(/\{([^}]+)\}/g, (_match, key) => String(fallbackContext[key] ?? ""))).forEach((value, key) => fallbackUrl.searchParams.set(key, value));
  fallbackUrl.searchParams.set("a_bogus", "signed-value");
  assert.equal(transportMatchesPlanTemplate(adapter, fallbackKey, fallbackContext, {
    partition: transport.partition,
    url: fallbackUrl.toString(),
    method: "GET",
    headers: { accept: "application/json, text/plain, */*", ...fallbackPlan.headers },
    responseType: "losslessJson",
    timeoutMs: fallbackPlan.pageFetchTimeoutMs || fallbackPlan.timeoutMs
  }), true);
});

test("every adapter request plan can produce a template-valid transport", () => {
  const interpolate = (value) => String(value ?? "").replace(/\{[^}]+\}/g, "");
  const expand = (value) => {
    if (typeof value === "string") return /^\{[^}]+\}$/.test(value) ? "" : interpolate(value);
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    return value;
  };
  const clamp = (value) => Math.max(5000, Math.min(120000, Number.isFinite(Number(value ?? 15000)) ? Math.floor(Number(value ?? 15000)) : 15000));
  for (const [planKey, plan] of Object.entries(adapter.requestPlans)) {
    const endpoint = adapter.endpoints[plan.endpointKey || planKey];
    if (!endpoint) continue;
    const url = new URL(interpolate(endpoint), plan.origin || adapter.origin);
    if (plan.rawQuery) new URLSearchParams(interpolate(plan.rawQuery)).forEach((value, key) => url.searchParams.set(key, value));
    const query = expand(plan.query);
    if (query && typeof query === "object" && !Array.isArray(query)) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value ?? ""));
    }
    if (plan.sign === true) url.searchParams.set("a_bogus", "signed-value");
    const method = String(plan.method || "GET").toUpperCase();
    const headers = { accept: "application/json, text/plain, */*", ...(plan.headers || {}) };
    if (typeof plan.referer === "string") headers.referer = interpolate(plan.referer);
    if (plan.signStrategy === "mstoken-myargs") headers["user-agent"] = "verified-signer";
    const transport = {
      partition: "persist:chihu_doudian_shop_1",
      url: url.toString(),
      method,
      headers,
      ...(method === "GET" ? {} : { body: expand(plan.body) }),
      responseType: ["base64", "arrayBuffer", "text", "losslessJson"].includes(plan.responseType) ? plan.responseType : "losslessJson",
      timeoutMs: clamp(plan.requestMode === "page-fetch" ? plan.pageFetchTimeoutMs ?? plan.timeoutMs : plan.timeoutMs)
    };
    assert.equal(transportMatchesPlanTemplate(adapter, planKey, {}, transport), true, planKey);
  }
});

test("window commands come from the signed adapter snapshot and arbitrary eval is absent", () => {
  const configRoot = path.resolve(__dirname, "../../remote-web/client-shell/public/config");
  const adapterBuffer = fs.readFileSync(path.join(configRoot, "doudian-adapter.marketing-pilot.json"));
  const commands = JSON.parse(fs.readFileSync(path.join(configRoot, "doudian-window-commands.json"), "utf8"));
  assert.equal(commands.schemaVersion, 1);
  assert.equal(commands.adapterSha256, crypto.createHash("sha256").update(adapterBuffer).digest("hex"));
  for (const key of ["collectRoleShopNames", "isHomePage", "signFactory", "switchShopFactory"]) {
    assert.equal(typeof commands.commands[key], "string", key);
    assert.equal(commands.commands[key].length > 20, true, key);
  }
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../remote-web/client-shell/public/release-manifest.json"), "utf8"));
  const commandArtifact = manifest.artifacts.find((item) => item.type === "doudian-window-commands");
  assert.equal(commandArtifact?.path, "new-remote-web/config/doudian-window-commands.json");
  assert.equal(commandArtifact?.required, true);
  const snapshot = { adapter, windowCommands: commands };
  assert.match(taskWindowCommandScript(snapshot, "collect-role-shop-names"), /document/);
  assert.match(taskWindowCommandScript(snapshot, "page-fetch", { transport: { url: "https://fxg.jinritemai.com/api/items", method: "GET" } }), /AbortController/);
  assert.throws(() => taskWindowCommandScript(snapshot, "arbitrary-eval", { code: "fetch('https://example.test')" }), /not registered/);

  const preload = fs.readFileSync(path.resolve(__dirname, "../src/preload/index.js"), "utf8");
  assert.equal(preload.includes('invoke("native:windows:eval")'), false);
  assert.equal(preload.includes('invoke("executeJavaScriptBrowserWindow")'), false);
  assert.equal(preload.includes('command: invoke("native:windows:command")'), true);

  const domainRoot = path.resolve(__dirname, "../../remote-web/client-shell/src/domain");
  const sourceFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.tsx?$/.test(entry.name)) sourceFiles.push(target);
    }
  };
  visit(domainRoot);
  for (const file of sourceFiles) assert.equal(fs.readFileSync(file, "utf8").includes("windows.eval("), false, file);
});
