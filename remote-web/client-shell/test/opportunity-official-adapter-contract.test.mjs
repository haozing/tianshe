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

const configUrl = new URL("../public/config/doudian-adapter.json", import.meta.url);
const pilotConfigUrl = new URL("../public/config/doudian-adapter.marketing-pilot.json", import.meta.url);
const fixtureUrl = (name) => new URL(`./fixtures/opportunity/${name}.json`, import.meta.url);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

test("official opportunity adapter locks endpoints, POST bodies and signing strategy", async () => {
  const config = await readJson(configUrl);
  const wordsPlan = config.requestPlans.opportunityClueWords;
  const goodsPlan = config.requestPlans.opportunityClueGoodsList;

  assert.equal(config.endpoints.opportunityClueWords, "/api/commop/business_chance_center/clue/query_participle");
  assert.equal(config.endpoints.opportunityClueGoodsList, "/api/commop/business_chance_center/product/list");
  assert.equal(wordsPlan.method, "POST");
  assert.equal(wordsPlan.body, "{bodyJson}");
  assert.equal(wordsPlan.maxAttempts, 1);
  assert.equal(goodsPlan.method, "POST");
  assert.equal(goodsPlan.body, "{bodyJson}");
  assert.equal(goodsPlan.sign, true);
  assert.equal(goodsPlan.signStrategy, "mstoken-myargs");
  assert.equal(goodsPlan.localSigner, true);
  assert.ok(config.responseMappings.opportunityReport.clueWordPaths.includes("data.data"));
  assert.ok(config.responseMappings.opportunityReport.clueGoodsListPaths.includes("opportunityClueGoodsList.data.list"));
  assert.ok(config.responseMappings.opportunityReport.clueGoodsTotalPaths.includes("opportunityClueGoodsList.data.total"));
  assert.ok(config.responseMappings.opportunityReport.clueGoodsSuccessStatusPaths.includes("base_resp.status_code"));
  assert.equal(config.policies.opportunityReport.officialValidationMode, "observe");
  assert.equal(config.policies.opportunityReport.officialValidationBaselineVerified, false);
  assert.equal(config.policies.opportunityReport.officialWordsSemantics, "unknown");
  assert.equal(config.policies.opportunityReport.officialGoodsContractMode, "unknown");
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

test("all published adapter variants keep official validation fail closed", async () => {
  for (const url of [configUrl, pilotConfigUrl]) {
    const config = await readJson(url);
    const policy = config.policies.opportunityReport;
    assert.equal(policy.officialValidationMode, "observe");
    assert.equal(policy.officialValidationBaselineVerified, false);
    assert.equal(policy.officialWordsSemantics, "unknown");
    assert.equal(policy.officialGoodsContractMode, "unknown");
    assert.equal(policy.allowPostSubmitFallback, false);
    assert.equal(policy.submitBatchSize, 10);
    assert.equal(policy.pipelineCacheScope, "shop");
    assert.equal(policy.enableGlobalPipelineCache, false);
  }
});

test("official word fixtures distinguish values, successful empty results and schema mismatch", async () => {
  const config = await readJson(configUrl);
  const paths = config.responseMappings.opportunityReport.clueWordPaths;
  const success = parseOfficialWordsPayload(await readJson(fixtureUrl("clue_words__success")), paths);
  const empty = parseOfficialWordsPayload(await readJson(fixtureUrl("clue_words__no_terms")), paths);
  const failure = parseOfficialWordsPayload(await readJson(fixtureUrl("clue_words__failure")), paths);

  assert.deepEqual(success, { found: true, words: ["tcmade", "帆布鞋"] });
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
