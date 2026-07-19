import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../public/config/doudian-adapter.json", import.meta.url);
const domainUrl = new URL("../src/domain/doudian/opportunityAutoFavorites.ts", import.meta.url);
const pageUrl = new URL("../src/components/OpportunityAutoFavoritesPage.tsx", import.meta.url);
const runnerUrl = new URL("../src/domain/doudian/taskRunner.ts", import.meta.url);
const appUrl = new URL("../src/App.tsx", import.meta.url);
const featureRoutesUrl = new URL("../src/featureRoutes.tsx", import.meta.url);

async function loadContract() {
  const [config, domain, page, runner, app, featureRoutes] = await Promise.all([
    readFile(configUrl, "utf8").then(JSON.parse),
    readFile(domainUrl, "utf8"),
    readFile(pageUrl, "utf8"),
    readFile(runnerUrl, "utf8"),
    readFile(appUrl, "utf8"),
    readFile(featureRoutesUrl, "utf8")
  ]);
  return { config, domain, page, runner, app, featureRoutes };
}

test("keeps ranked favorites independent from opportunity association", async () => {
  const { domain, runner } = await loadContract();

  assert.doesNotMatch(domain, /from "\.\/opportunityReport"/);
  assert.doesNotMatch(domain, /opportunitySubmitClue|opportunityClueGoodsList|pipeline-submit/);
  assert.match(domain, /taskType: "opportunityAutoFavorites"/);
  assert.match(runner, /task\.taskType === "opportunityAutoFavorites"/);
});

test("uses the verified category, growth and trading request contract", async () => {
  const { config, domain } = await loadContract();
  const policy = config.policies.opportunityFavorites.autoCollect;

  assert.equal(policy.clueListRequestPlan, "opportunityClueRealtimeList");
  assert.equal(policy.categoryListRequestPlan, "opportunityCategoryList");
  assert.equal(policy.collectRequestPlan, "opportunityCollectClue");
  assert.equal(policy.perStoreLimit, 1000);
  assert.equal(policy.pageSize, 18);
  assert.equal(policy.collectDelayMs, 1200);
  assert.ok(policy.queryModes.some((item) => item.sortField === "TRADING_AMOUNT"));
  assert.ok(policy.queryModes.some((item) => item.id === "growth-fast" && item.sortField === "PAY_AMOUNT_RATE"));
  assert.equal(config.requestPlans.opportunityCollectClue.allowSuccessCodeOnly, true);
  assert.deepEqual(config.requestPlans.opportunityCollectClue.successPaths, []);
  assert.match(domain, /recommend_reason_list/);
  assert.match(domain, /module: "query"/);
  assert.match(domain, /categories: buildCategoryBody/);
  assert.match(domain, /autoCollectPolicyText/);
});

test("loops selected modes, deduplicates clues and stops a store at the favorite cap", async () => {
  const { domain, page } = await loadContract();

  assert.match(domain, /for \(const category of categories\)/);
  assert.match(domain, /for \(const mode of queryModes\)/);
  assert.match(domain, /new Map<string, FavoriteCandidate>/);
  assert.match(domain, /byClueId\.set\(candidate\.clueId/);
  assert.match(domain, /firstSeenOrder/);
  assert.match(domain, /hasEnoughCandidates/);
  assert.match(domain, /sourceFailures/);
  assert.match(domain, /isTerminalFavoriteFailure/);
  assert.match(domain, /isFavoriteQuotaMessage/);
  assert.match(domain, /executionRow\(store, candidate, "quota_exhausted"/);
  assert.match(page, /new Set\(queryModes\.map/);
  assert.match(page, /PAY_AMOUNT_RATE/);
  assert.match(page, /max=\{1000\}/);
  assert.match(page, /storeIdentityRef/);
});

test("exposes auto favorites and invalid cleanup as separate routes", async () => {
  const { app, featureRoutes } = await loadContract();

  assert.match(featureRoutes, /route: "\/opportunities\/favorites"/);
  assert.match(featureRoutes, /component: OpportunityAutoFavoritesPage/);
  assert.match(featureRoutes, /route: "\/opportunities\/favorites\/cleanup"/);
  assert.match(featureRoutes, /component: OpportunityFavoritesPage/);
  assert.match(app, /resolveFeatureRoutes/);
});
