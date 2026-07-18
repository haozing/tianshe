import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../public/config/doudian-adapter.json", import.meta.url);
const domainUrl = new URL("../src/domain/doudian/opportunityFavorites.ts", import.meta.url);

async function loadContract() {
  const [config, domain] = await Promise.all([
    readFile(configUrl, "utf8").then(JSON.parse),
    readFile(domainUrl, "utf8")
  ]);
  return { config, domain };
}

test("keeps invalid favorite cleanup separate from opportunity association", async () => {
  const { config } = await loadContract();

  assert.equal(config.endpoints.opportunityCollectClue, "/api/commop/business_chance_center/clue/auto_submit/open");
  assert.equal(config.endpoints.opportunityFavoriteClearInvalid, "/api/commop/business_chance_center/clue/collect/clear");
  assert.notEqual(config.requestPlans.opportunityCollectClue.endpointKey, config.requestPlans.opportunityFavoriteClearInvalid.endpointKey);
});

test("uses an unsigned stable endpoint and dynamic local signing", async () => {
  const { config } = await loadContract();
  const endpoint = config.endpoints.opportunityFavoriteClearInvalid;
  const plan = config.requestPlans.opportunityFavoriteClearInvalid;
  const url = new URL(endpoint, config.origin);

  assert.equal(url.pathname, "/api/commop/business_chance_center/clue/collect/clear");
  assert.equal(url.search, "");
  assert.equal(/[?&](verifyFp|fp|msToken|a_bogus)=/.test(endpoint), false);
  assert.equal(plan.sign, true);
  assert.equal(plan.signStrategy, "mstoken-myargs");
  assert.equal(plan.localSigner, true);
  assert.equal(plan.localSignerOnly, true);
  assert.equal(plan.signRequireMsToken, false);
  assert.equal(plan.signIncludeEmptyMsToken, true);
  assert.equal(plan.signatureParam, false);
  assert.equal(plan.signBody, "");
});

test("sends a single empty-body POST and requires the verified response contract", async () => {
  const { config, domain } = await loadContract();
  const plan = config.requestPlans.opportunityFavoriteClearInvalid;

  assert.equal(plan.method, "POST");
  assert.equal("body" in plan, false);
  assert.equal(plan.retryOnHttpError, false);
  assert.equal(plan.retryOnBusinessFailure, false);
  assert.equal(plan.maxAttempts, 1);
  assert.deepEqual(plan.successCodes, [0, "0"]);
  assert.deepEqual(plan.successPaths, ["success"]);
  assert.match(domain, /requestPlanResponseOk\(response, adapter, planKey\)\s*&&\s*successFlag === true/);
  assert.match(domain, /event: "clear-invalid-store-result"/);
  assert.match(domain, /event: "clear-invalid-run-summary"/);
  assert.match(domain, /reportDoudianDiagnostic\([\s\S]*?, true\)/);
});

test("declares the cleanup action in remote capabilities, operation plan and policy", async () => {
  const { config } = await loadContract();
  const actions = config.operationPlans.clearInvalidOpportunityFavorites.actions;

  assert.ok(config.capabilities.actions.includes("clearInvalidOpportunityFavorites"));
  assert.ok(config.capabilities.requestPlanSteps.includes("opportunityFavoriteClearInvalid"));
  assert.equal(actions[0].action, "clearInvalidOpportunityFavorites");
  assert.deepEqual(actions[0].requestPlans, ["currentShop", "opportunityFavoriteClearInvalid"]);
  assert.equal(config.policies.opportunityFavorites.clearInvalidRequestPlan, "opportunityFavoriteClearInvalid");
  assert.equal(config.policies.opportunityFavorites.concurrency, 2);
});
