import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateInputScanCoverage,
  parseOfficialBusinessStatus,
  parseOfficialGoodsPage,
  parseOfficialWordsPayload,
  selectOfficialCandidateForProduct
} from "../src/domain/doudian/opportunity/officialValidation.ts";
import { advanceSubmitHistoryThrottle, evaluateSubmitHistoryPageCoverage, isSubmitHistoryBusinessSuccess, parseSubmitHistorySnapshot, submitHistoryBusinessFacts, submitHistoryCapacityFacts, submitHistoryInitialStart, submitHistoryPageBatchRange, submitHistoryPageReachesEnd, submitHistoryRemoteUpdatedAtWatermark, submitHistoryThrottleAllowsPipeline, submitHistoryThrottleBypassesRequest, submitHistoryWindows } from "../src/domain/doudian/opportunity/submitHistory.ts";
import { isAlreadySubmittedOpportunityMessage } from "../src/domain/doudian/opportunityExecutionPolicy.ts";

const configUrl = new URL("../public/config/doudian-adapter.json", import.meta.url);
const pilotConfigUrl = new URL("../public/config/doudian-adapter.marketing-pilot.json", import.meta.url);
const fixtureUrl = (name) => new URL(`./fixtures/opportunity/${name}.json`, import.meta.url);
const opportunitySourceUrl = new URL("../src/domain/doudian/opportunityReport.ts", import.meta.url);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

test("diagnostic opportunity plans remain contracted but are excluded from automatic submit", async () => {
  const config = await readJson(configUrl);
  const wordsPlan = config.requestPlans.opportunityClueWords;
  const goodsPlan = config.requestPlans.opportunityClueGoodsList;
  const historyPlan = config.requestPlans.opportunitySubmitHistoryList;

  assert.equal(config.endpoints.opportunityClueWords, "/api/commop/business_chance_center/clue/query_participle");
  assert.equal(config.endpoints.opportunityClueGoodsList, "/api/commop/business_chance_center/product/list");
  assert.equal(config.endpoints.opportunitySubmitHistoryList, "/api/commop/business_chance_center/item_submit/common/list");
  assert.equal(wordsPlan.method, "POST");
  assert.equal(wordsPlan.body, "{bodyJson}");
  assert.equal(wordsPlan.maxAttempts, 1);
  assert.equal(goodsPlan.method, "POST");
  assert.equal(goodsPlan.body, "{bodyJson}");
  assert.equal(goodsPlan.sign, true);
  assert.equal(goodsPlan.signStrategy, "mstoken-myargs");
  assert.equal(goodsPlan.localSigner, true);
  assert.equal(historyPlan.method, "POST");
  assert.equal(historyPlan.body, "{bodyJson}");
  assert.equal(historyPlan.signStrategy, "mstoken-myargs");
  assert.equal(historyPlan.localSigner, true);
  assert.equal(historyPlan.maxAttempts, 1);
  assert.equal(historyPlan.retryOnHttpError, false);
  assert.equal(historyPlan.retryOnBusinessFailure, false);
  assert.deepEqual(historyPlan.successStatusPaths, ["base_resp.status_code", "data.base_resp.status_code"]);
  assert.equal(historyPlan.successPaths.includes("base_resp"), false);
  assert.ok(config.responseMappings.opportunityReport.clueWordPaths.includes("data.data"));
  assert.ok(config.responseMappings.opportunityReport.clueGoodsListPaths.includes("opportunityClueGoodsList.data.list"));
  assert.ok(config.responseMappings.opportunityReport.clueGoodsTotalPaths.includes("opportunityClueGoodsList.data.total"));
  assert.ok(config.responseMappings.opportunityReport.clueGoodsSuccessStatusPaths.includes("base_resp.status_code"));
  assert.ok(config.responseMappings.opportunityReport.submitHistoryListPaths.includes("opportunitySubmitHistoryList.data"));
  assert.ok(config.responseMappings.opportunityReport.submitHistoryTotalPaths.includes("opportunitySubmitHistoryList.total"));
  assert.ok(config.responseMappings.opportunityReport.fields.clueId.includes("clue_detail.clue_id"));
  const submitPlans = config.operationPlans.executeOpportunitySubmit.actions[0].requestPlans;
  assert.equal(submitPlans.includes("opportunityClueWords"), false);
  assert.equal(submitPlans.includes("opportunityClueGoodsList"), false);
  assert.equal(submitPlans.includes("opportunitySubmitHistoryList"), true);
  assert.equal(config.policies.opportunityReport.requestPlans.includes("opportunityClueWords"), false);
  assert.equal(config.policies.opportunityReport.requestPlans.includes("opportunityClueGoodsList"), false);
  assert.equal(config.policies.opportunityReport.allowPostSubmitFallback, false);
  assert.equal(config.policies.opportunityReport.submitBatchSize, 10);
});

test("official goods business status follows the verified nested base response contract", async () => {
  const config = await readJson(configUrl);
  const mappings = config.responseMappings.opportunityReport;
  assert.deepEqual(
    parseOfficialBusinessStatus({ base_resp: { status_code: 200 }, data: [] }, mappings.clueGoodsSuccessStatusPaths, mappings.clueGoodsSuccessCodes),
    { found: true, ok: true, code: "200" }
  );
  assert.deepEqual(
    parseOfficialBusinessStatus({ base_resp: { status_code: 500 }, data: [] }, mappings.clueGoodsSuccessStatusPaths, mappings.clueGoodsSuccessCodes),
    { found: true, ok: false, code: "500" }
  );
  assert.equal(parseOfficialBusinessStatus({ data: [] }, mappings.clueGoodsSuccessStatusPaths, mappings.clueGoodsSuccessCodes).found, false);
});

test("all published adapter variants use tenant-scoped shared clue cache without observation validation", async () => {
  for (const url of [configUrl, pilotConfigUrl]) {
    const config = await readJson(url);
    const policy = config.policies.opportunityReport;
    assert.ok(config.responseMappings.opportunityReport.fields.clueId.includes("clue_detail.clue_id"));
    assert.ok(config.responseMappings.opportunityReport.fields.clueId.includes("clueDetail.clueId"));
    assert.equal("officialValidationMode" in policy, false);
    assert.equal(policy.allowPostSubmitFallback, false);
    assert.equal(policy.submitBatchSize, 10);
    assert.equal(policy.pipelineCacheScope, "global");
    assert.equal(policy.enableGlobalPipelineCache, true);
    assert.equal(policy.clueCacheTtlHours, 1);
  }
});

test("clue pagination and normalization share the nested clue identity contract", async () => {
  const source = await readFile(opportunitySourceUrl, "utf8");
  assert.match(source, /const CLUE_ID_PATHS = \[/);
  assert.match(source, /"clue_detail\.clue_id"/);
  assert.match(source, /const clueId = rawClueId\(raw, adapter\)/);
  assert.match(source, /rawRows\.map\(\(row\) => rawClueId\(row, args\.payload\.adapter\)\)/);
  assert.doesNotMatch(source, /rawMappedId\(row, [^\n]+, "clueId"/);
  assert.match(source, /missingIdSample \?\?= diagnosticValueShape\(row\)/);
});

test("submission history fixtures preserve rows, totals and business failure evidence", async () => {
  const config = await readJson(configUrl);
  const mappings = config.responseMappings.opportunityReport;
  const wrap = (fixture) => ({ opportunitySubmitHistoryList: fixture });
  const page = parseOfficialGoodsPage(wrap(await readJson(fixtureUrl("submit_history__success_page_1"))), mappings.submitHistoryListPaths, mappings.submitHistoryTotalPaths);
  const empty = parseOfficialGoodsPage(wrap(await readJson(fixtureUrl("submit_history__empty_complete"))), mappings.submitHistoryListPaths, mappings.submitHistoryTotalPaths);
  const failure = await readJson(fixtureUrl("submit_history__business_failure"));

  assert.equal(page.found, true);
  assert.equal(page.rows.length, 1);
  assert.equal(page.remoteTotal, 3);
  assert.equal(empty.found, true);
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.remoteTotal, 0);
  assert.equal(isSubmitHistoryBusinessSuccess(page.found ? await readJson(fixtureUrl("submit_history__success_page_1")) : null), true);
  assert.equal(isSubmitHistoryBusinessSuccess(failure), false);
});

test("submission history parser extracts product, clue and update watermark", () => {
  const snapshot = parseSubmitHistorySnapshot({
    id: 50387930773,
    clue_id: 77867200,
    clue_name: "matched clue",
    clue_channel: "industry_selected",
    product_info: { product_id: "3832675342968029221", product_title: "sample product" },
    submit_time: 1784894774000,
    audit_time: 1784894775000,
    audit_status: 3,
    is_auto_submitted: false
  });
  assert.equal(snapshot.remoteRecordId, "50387930773");
  assert.equal(snapshot.productId, "3832675342968029221");
  assert.equal(snapshot.clueId, "77867200");
  assert.equal(snapshot.remoteUpdatedAtMs, 1784894775000);
  assert.equal(submitHistoryRemoteUpdatedAtWatermark([{ remoteUpdatedAtMs: 1784894774000 }, snapshot], 1784894773000), 1784894775000);
});

test("submission history identifies HTTP 200 business busy responses for prewarm backoff", () => {
  assert.deepEqual(submitHistoryBusinessFacts({ base_resp: { status_code: 500, status_message: "系统繁忙，请重试" } }), {
    found: true,
    ok: false,
    code: "500",
    message: "系统繁忙，请重试",
    busy: true
  });
  assert.equal(submitHistoryBusinessFacts({ base_resp: { status_code: 200 } }).ok, true);
  assert.deepEqual(submitHistoryBusinessFacts({ code: "10001010A", msg: "访问过于频繁，请稍后重试" }), {
    found: true,
    ok: false,
    code: "10001010A",
    message: "访问过于频繁，请稍后重试",
    busy: true
  });
  assert.equal(submitHistoryBusinessFacts({ base_resp: { status_code: 500, status_message: "permission denied" } }).busy, false);
  assert.equal(submitHistoryBusinessFacts({ base_resp: { status_code: 200, status_message: "system busy" } }).busy, false);
  const throttleOnly = {
    businessBusyCount: 1,
    requestFailed: true,
    schemaMismatch: false,
    schemaMismatchCount: 0,
    duplicatePage: false,
    totalZeroWithRows: false
  };
  assert.equal(submitHistoryThrottleAllowsPipeline(throttleOnly, true), true);
  assert.equal(submitHistoryThrottleAllowsPipeline({ ...throttleOnly, businessBusyCount: 0 }, true), false);
  assert.equal(submitHistoryThrottleAllowsPipeline({ ...throttleOnly, schemaMismatch: true, schemaMismatchCount: 1 }, true), false);
  assert.equal(submitHistoryThrottleAllowsPipeline(throttleOnly, false), false);
  assert.equal(submitHistoryThrottleBypassesRequest({ operationThrottled: true, busyStreak: 1, nextEligibleAtMs: 1, nowMs: 2 }, true), true);
  assert.equal(submitHistoryThrottleBypassesRequest({ operationThrottled: false, busyStreak: 1, nextEligibleAtMs: 3, nowMs: 2 }, true), true);
  assert.equal(submitHistoryThrottleBypassesRequest({ operationThrottled: false, busyStreak: 1, nextEligibleAtMs: 1, nowMs: 2 }, true), false);
  assert.equal(submitHistoryThrottleBypassesRequest({ operationThrottled: true, busyStreak: 1, nextEligibleAtMs: 3, nowMs: 2 }, false), false);
});

test("submission history throttle increases cooldown and resets after success", () => {
  const policy = { requestSpacingMs: 1500, initialCooldownMs: 60_000, maxCooldownMs: 300_000, multiplier: 1.5 };
  const first = advanceSubmitHistoryThrottle({ busyStreak: 0, nextEligibleAtMs: 0 }, "busy", 1_000, policy);
  assert.deepEqual(first, { busyStreak: 1, nextEligibleAtMs: 61_000, delayMs: 60_000 });
  const second = advanceSubmitHistoryThrottle(first, "busy", 61_000, policy);
  assert.deepEqual(second, { busyStreak: 2, nextEligibleAtMs: 151_000, delayMs: 90_000 });
  const recovered = advanceSubmitHistoryThrottle(second, "success", 151_000, policy);
  assert.deepEqual(recovered, { busyStreak: 0, nextEligibleAtMs: 152_500, delayMs: 1500 });
});

test("submission history parsing fails closed when stable identity or submit time is missing", () => {
  for (const row of [
    { clue_id: 1, product_info: { product_id: 2 }, submit_time: 3 },
    { id: 1, product_info: { product_id: 2 }, submit_time: 3 },
    { id: 1, clue_id: 2, submit_time: 3 },
    { id: 1, clue_id: 2, product_info: { product_id: 3 } }
  ]) {
    assert.equal(parseSubmitHistorySnapshot(row), null);
  }
});

test("submission history window coverage fails closed on duplicate pages and truncation", () => {
  assert.equal(evaluateSubmitHistoryPageCoverage({
    requestFailed: false,
    schemaMismatch: false,
    duplicatePage: false,
    totalZeroWithRows: false,
    endReached: true,
    fetchedPages: 6,
    maxPages: 1000
  }), "complete");
  assert.equal(evaluateSubmitHistoryPageCoverage({
    requestFailed: false,
    schemaMismatch: false,
    duplicatePage: false,
    totalZeroWithRows: false,
    endReached: false,
    fetchedPages: 1000,
    maxPages: 1000
  }), "truncated");
  assert.equal(evaluateSubmitHistoryPageCoverage({
    requestFailed: false,
    schemaMismatch: false,
    duplicatePage: true,
    totalZeroWithRows: false,
    endReached: true,
    fetchedPages: 6,
    maxPages: 1000
  }), "failed");
});

test("submission history capacity uses unique record and clue ids at the 50 boundary", () => {
  const recordIds = Array.from({ length: 50 }, (_, index) => `record-${index}`);
  const facts = submitHistoryCapacityFacts(["same-clue", "same-clue"], recordIds);
  assert.equal(facts.associatedClueCount, 1);
  assert.equal(facts.sourceRecordCount, 50);
  assert.equal(facts.remainingClueCapacity, 0);
  assert.equal(facts.saturated, true);
  assert.equal(submitHistoryCapacityFacts(["clue-1"], ["record-1"]).remainingClueCapacity, 49);
});

test("submission history uses disjoint time windows and the verified request body", async () => {
  assert.equal(submitHistoryInitialStart(40 * 86400, 30), 10 * 86400);
  assert.deepEqual(submitHistoryWindows(100, 100 + 2 * 86400, 1), [
    { startEpochSeconds: 100, endEpochSeconds: 86499 },
    { startEpochSeconds: 86500, endEpochSeconds: 172899 },
    { startEpochSeconds: 172900, endEpochSeconds: 172900 }
  ]);
  assert.deepEqual(submitHistoryWindows(200, 100, 1), []);
  assert.deepEqual(submitHistoryPageBatchRange(68, 1000, 10), { startPage: 68, endPage: 77, maxPages: 1000 });
  assert.deepEqual(submitHistoryPageBatchRange(998, 1000, 10), { startPage: 998, endPage: 1000, maxPages: 1000 });
  assert.equal(submitHistoryPageReachesEnd(309, 100, 100, 30_980), false);
  assert.equal(submitHistoryPageReachesEnd(310, 100, 80, 30_980), true);
  const source = await readFile(opportunitySourceUrl, "utf8");
  assert.match(source, /function submitHistoryListBody[\s\S]*?status_list:\s*\[0, 1, 2, 3, 4, 5, 6\]/);
  assert.match(source, /function submitHistoryResponseOk[\s\S]*?base_resp\.status_code/);
  assert.match(source, /const isInitial = !previous \|\| !previous\.initialized/);
  assert.match(source, /initialCursorStartEpochSeconds/);
  assert.match(source, /submitHistoryIncrementalOverlapSeconds/);
  const config = await readJson(configUrl);
  assert.equal(config.policies.opportunityReport.submitHistoryInitialLookbackDays, 30);
  assert.equal(config.policies.opportunityReport.submitHistoryPrewarmEnabled, false);
  assert.equal(config.policies.opportunityReport.submitHistoryContinueOnThrottleEnabled, true);
  assert.equal(config.policies.opportunityReport.submitHistoryThrottleRecoveryEnabled, true);
  assert.equal(config.policies.opportunityReport.submitHistoryRequestSpacingMs, 1500);
  assert.equal(config.policies.opportunityReport.submitHistoryThrottleInitialCooldownMs, 60_000);
  assert.equal(config.policies.opportunityReport.submitHistoryThrottleMaxCooldownMs, 300_000);
  assert.equal(config.policies.opportunityReport.submitHistoryThrottleMultiplier, 1.5);
  assert.equal(config.policies.opportunityReport.submitHistoryThrottleRecoveryBudgetMs, 1_800_000);
  assert.equal(config.policies.opportunityReport.submitHistoryCheckpointPageBatchSize, 10);
  assert.equal(config.policies.opportunityReport.submitHistoryPrewarmIntervalMs, 21_600_000);
  assert.equal(config.policies.opportunityReport.submitHistoryPrewarmRetryMs, 21_600_000);
  assert.equal(config.policies.opportunityReport.submitHistoryPrewarmIdleGraceMs, 180_000);
  assert.equal(config.policies.opportunityReport.submitHistoryPrewarmInterSliceDelayMs, 60_000);
  assert.equal(config.policies.opportunityReport.submitHistoryPrewarmWindowDays, 1);
  assert.equal(config.policies.opportunityReport.submitPacingSuccessesToDecrease, 4);
  assert.equal(config.policies.opportunityReport.submitPacingDecreaseMs, 5000);
  assert.equal(config.policies.opportunityReport.submitPacingIsolated429IncreaseMs, 5000);
  assert.equal(config.policies.opportunityReport.submitPacingIdleResetMs, 600000);
  assert.equal(config.policies.opportunityReport.submitHistoryPrewarmMaxWindowsPerRun, 1);
  assert.equal(config.policies.opportunityReport.submitHistoryPrewarmCompactionBatchSize, 500);
  assert.equal("submitHistoryInitialStartEpochSeconds" in config.policies.opportunityReport, false);
});

test("submission history schema mismatch remains blocked while explicit throttle continues silently", async () => {
  const source = await readFile(opportunitySourceUrl, "utf8");
  assert.match(source, /key:\s*"opportunitySubmitHistorySchema"/);
  assert.match(source, /event:\s*"submit-history-window"/);
  assert.match(source, /"pipeline-submit-history-incomplete"/);
  assert.match(source, /event:\s*"pipeline-submit-history-throttled"/);
  assert.match(source, /event:\s*"pipeline-submit-history-recovered"/);
  assert.match(source, /event:\s*"submit-history-progress"/);
  assert.match(source, /event:\s*"pipeline-submit-history-progress"/);
  assert.match(source, /checkpointNextPage/);
  assert.match(source, /status:\s*"cooling_down"/);
  assert.match(source, /maxAttempts:\s*1/);
  assert.match(source, /submitHistoryThrottleAllowsPipeline\(\{[\s\S]*?businessBusyCount:\s*result\.businessBusyCount[\s\S]*?schemaMismatch:\s*result\.diagnostic\.schemaMismatch/);
  assert.match(source, /function cachedSubmitHistoryResult[\s\S]*?status:\s*"complete"[\s\S]*?sourceHealth:\s*\[\]/);
  assert.match(source, /submitHistoryThrottledOperations\.add\(args\)/);
  assert.match(source, /const queuedSkip = skippedByThrottle\(\)/);
  assert.match(source, /if \(benefitScan\.status !== "complete"\) throw new Error\("submit history sync incomplete"\)/);
});

test("submission history checkpoints successful page batches before throttle recovery", async () => {
  const source = await readFile(opportunitySourceUrl, "utf8");
  assert.match(source, /startPage:\s*windowNextPage/);
  assert.match(source, /pageBatchSize:\s*checkpointPageBatchSize/);
  assert.match(source, /remoteTotal:\s*windowRemoteTotal/);
  assert.match(source, /await persistSubmitHistoryBatch\(identity, result\.records\)/);
  assert.match(source, /checkpointNextPage:\s*result\.nextPage/);
  assert.match(source, /return cachedSubmitHistoryResult\([\s\S]*?checkpointNextPage/);
});

test("contract fixtures cover duplicate pagination and already-submitted response", async () => {
  const duplicatePage = await readJson(fixtureUrl("submit_history__page_2_duplicate"));
  const alreadySubmitted = await readJson(fixtureUrl("submit__already_submitted"));
  assert.equal(duplicatePage.data[0].id, 1001);
  assert.equal(isAlreadySubmittedOpportunityMessage(alreadySubmitted.message), true);
});

test("official word fixtures distinguish values, successful empty results and schema mismatch", async () => {
  const config = await readJson(configUrl);
  const paths = config.responseMappings.opportunityReport.clueWordPaths;
  const success = parseOfficialWordsPayload(await readJson(fixtureUrl("clue_words__success")), paths);
  const empty = parseOfficialWordsPayload(await readJson(fixtureUrl("clue_words__no_terms")), paths);
  const failure = parseOfficialWordsPayload(await readJson(fixtureUrl("clue_words__failure")), paths);

  assert.equal(success.found, true);
  assert.equal(success.words.length, 2);
  assert.deepEqual(empty, { found: true, words: [] });
  assert.equal(failure.found, false);
});

test("official goods fixtures preserve total, empty completion and schema mismatch", async () => {
  const config = await readJson(configUrl);
  const listPaths = config.responseMappings.opportunityReport.clueGoodsListPaths;
  const totalPaths = config.responseMappings.opportunityReport.clueGoodsTotalPaths;
  const wrap = (fixture) => ({ opportunityClueGoodsList: fixture });
  const page = parseOfficialGoodsPage(wrap(await readJson(fixtureUrl("clue_goods__success_page_1"))), listPaths, totalPaths);
  const empty = parseOfficialGoodsPage(wrap(await readJson(fixtureUrl("clue_goods__empty_complete"))), listPaths, totalPaths);
  const mismatch = parseOfficialGoodsPage(wrap(await readJson(fixtureUrl("clue_goods__schema_mismatch"))), listPaths, totalPaths);

  assert.equal(page.found, true);
  assert.equal(page.rows.length, 1);
  assert.equal(page.remoteTotal, 2);
  assert.equal(page.remoteTotalKnown, true);
  assert.equal(empty.found, true);
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.remoteTotalKnown, true);
  assert.equal(mismatch.found, false);
});

test("page-limit fixtures are truncated when fetched rows remain below remote total", async () => {
  const fixture = await readJson(fixtureUrl("clue_goods__truncated"));
  assert.equal(evaluateInputScanCoverage({
    fetchedCount: fixture.data.list.length,
    remoteTotal: fixture.data.total,
    remoteTotalKnown: true,
    fetchedPages: 1,
    maxPages: 1,
    pageSize: 1,
    lastPageRowCount: 1
  }).status, "truncated");
});

test("candidate selection stops on unknown and budget exhaustion", () => {
  const unknown = { id: "primary", validationStatus: "unknown" };
  const laterVerified = { id: "fallback", validationStatus: "verified" };
  const budget = { id: "primary", validationStatus: "budget_exhausted" };
  const rejected = { id: "primary", validationStatus: "rejected" };

  assert.equal(selectOfficialCandidateForProduct([unknown, laterVerified])?.id, "primary");
  assert.equal(selectOfficialCandidateForProduct([budget, laterVerified])?.id, "primary");
  assert.equal(selectOfficialCandidateForProduct([rejected, laterVerified])?.id, "fallback");
});
