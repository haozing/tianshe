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
import { evaluateSubmitHistoryPageCoverage, isSubmitHistoryBusinessSuccess, parseSubmitHistorySnapshot, submitHistoryCapacityFacts, submitHistoryInitialStart, submitHistoryRemoteUpdatedAtWatermark, submitHistoryWindows } from "../src/domain/doudian/opportunity/submitHistory.ts";
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
  const source = await readFile(opportunitySourceUrl, "utf8");
  assert.match(source, /function submitHistoryListBody[\s\S]*?status_list:\s*\[0, 1, 2, 3, 4, 5, 6\]/);
  assert.match(source, /function submitHistoryResponseOk[\s\S]*?base_resp\.status_code/);
  assert.match(source, /initialCursorStartEpochSeconds/);
  assert.match(source, /submitHistoryIncrementalOverlapSeconds/);
  const config = await readJson(configUrl);
  assert.equal(config.policies.opportunityReport.submitHistoryInitialLookbackDays, 30);
  assert.equal("submitHistoryInitialStartEpochSeconds" in config.policies.opportunityReport, false);
});

test("submission history schema mismatch remains blocked and emits diagnostics", async () => {
  const source = await readFile(opportunitySourceUrl, "utf8");
  assert.match(source, /key:\s*"opportunitySubmitHistorySchema"/);
  assert.match(source, /event:\s*"submit-history-window"/);
  assert.match(source, /event:\s*"pipeline-submit-history-incomplete"/);
  assert.match(source, /if \(benefitScan\.status !== "complete"\) throw new Error\("submit history sync incomplete"\)/);
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
