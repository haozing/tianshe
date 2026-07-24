import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../public/config/doudian-adapter.json", import.meta.url);
const pilotConfigUrl = new URL("../public/config/doudian-adapter.marketing-pilot.json", import.meta.url);
const domainUrl = new URL("../src/domain/doudian/opportunityAutoFavorites.ts", import.meta.url);
const favoritesDomainUrl = new URL("../src/domain/doudian/opportunityFavorites.ts", import.meta.url);
const recordsDomainUrl = new URL("../src/domain/doudian/opportunityFavoriteRecords.ts", import.meta.url);
const recordMappingUrl = new URL("../src/domain/doudian/opportunityFavoriteRecordMapping.ts", import.meta.url);
const pageUrl = new URL("../src/components/OpportunityAutoFavoritesPage.tsx", import.meta.url);
const runnerUrl = new URL("../src/domain/doudian/taskRunner.ts", import.meta.url);
const appUrl = new URL("../src/App.tsx", import.meta.url);
const featureRoutesUrl = new URL("../src/featureRoutes.tsx", import.meta.url);

async function loadContract() {
  const [config, pilotConfig, domain, favoritesDomain, recordsDomain, recordMapping, page, runner, app, featureRoutes] = await Promise.all([
    readFile(configUrl, "utf8").then(JSON.parse),
    readFile(pilotConfigUrl, "utf8").then(JSON.parse),
    readFile(domainUrl, "utf8"),
    readFile(favoritesDomainUrl, "utf8"),
    readFile(recordsDomainUrl, "utf8"),
    readFile(recordMappingUrl, "utf8"),
    readFile(pageUrl, "utf8"),
    readFile(runnerUrl, "utf8"),
    readFile(appUrl, "utf8"),
    readFile(featureRoutesUrl, "utf8")
  ]);
  return { config, pilotConfig, domain, favoritesDomain, recordsDomain, recordMapping, page, runner, app, featureRoutes };
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
  assert.match(page, /STORAGE_KEY_OPPORTUNITY_FAVORITE_SETTINGS/);
  assert.match(page, /storeFilters/);
  assert.match(page, /categoryPlans/);
  assert.match(page, /同步到其他店铺/);
  assert.match(page, /全选目标店铺/);
  assert.match(page, /allSyncTargetsSelected/);
  assert.match(page, /批量收藏设置/);
  assert.match(page, /updateScopedConfigs/);
  assert.match(page, /每家店铺独立保存/);
  assert.match(page, /available\.get\(categoryKey\(plan\.category\)\)/);
  assert.match(page, /PAY_AMOUNT_RATE/);
  assert.match(page, /max=\{1000\}/);
  assert.match(page, /storeIdentityRef/);
  assert.match(page, /pauseFavoriteRecordRequest/);
  assert.match(page, /onStarted: \(nextOperationId\)/);
});

test("reads all platform favorites with the supplied auto-submit page contract", async () => {
  const { config, pilotConfig, domain, recordsDomain, recordMapping, page, runner } = await loadContract();

  for (const adapter of [config, pilotConfig]) {
    assert.equal(adapter.endpoints.opportunityFavoriteAutoSubmitPage, "/api/commop/business_chance_center/clue/auto_submit/page");
    assert.equal(adapter.policies.opportunityFavorites.recordsRequestPlan, "opportunityFavoriteAutoSubmitPage");
    assert.equal(adapter.requestPlans.opportunityFavoriteAutoSubmitPage.method, "POST");
    assert.equal(adapter.requestPlans.opportunityFavoriteAutoSubmitPage.signBody, "{bodyJson}");
  }
  assert.match(recordMapping, /task_status/);
  assert.match(recordMapping, /clue_label_list/);
  assert.match(recordMapping, /profit_info_list/);
  assert.match(runner, /task\.taskType === "opportunityFavoriteRecords"/);
  assert.match(recordsDomain, /onPage\?\./);
  assert.match(runner, /favoriteRecords: detail/);
  assert.match(page, /fetchDoudianOpportunityFavoriteRecords/);
  assert.match(page, /detail\.favoriteRecords/);
  assert.match(page, /平台已收藏/);
  assert.match(page, /获取第一页/);
  assert.match(page, /获取剩余/);
  assert.match(page, /当前筛选仅覆盖已加载数据/);
  assert.match(recordsDomain, /startPage/);
  assert.match(recordsDomain, /totalKnown/);
  assert.match(page, /pagedRecords/);
  assert.doesNotMatch(page, /void refreshFavoriteRecords\(activeStore\)/);
  assert.match(page, /批量取消收藏/);
  assert.match(domain, /profit_id_list/);
  assert.match(domain, /tag_id_list/);
});

test("streams each auto-favorite result and binds progress to the native operation id", async () => {
  const { domain, page, runner } = await loadContract();

  assert.match(domain, /onRow\?:/);
  assert.match(domain, /appendExecutionRow/);
  assert.match(runner, /autoFavorite: detail/);
  assert.match(page, /detail\.autoFavorite/);
  assert.match(page, /onStarted: \(operationId\) => setActiveOperationId\(operationId\)/);
  assert.match(page, /setTaskRows\(\(current\)/);
});

test("uses the verified auto-submit close contract for batch cancellation", async () => {
  const { config, pilotConfig, favoritesDomain, page, runner } = await loadContract();
  for (const adapter of [config, pilotConfig]) {
    assert.equal(adapter.endpoints.opportunityFavoriteCancel, "/api/commop/business_chance_center/clue/auto_submit/close");
    assert.equal(adapter.policies.opportunityFavorites.cancelRequestPlan, "opportunityFavoriteCancel");
    assert.equal(adapter.requestPlans.opportunityFavoriteCancel.method, "POST");
    assert.equal(adapter.requestPlans.opportunityFavoriteCancel.mutation, true);
    assert.equal(adapter.requestPlans.opportunityFavoriteCancel.signBody, "{bodyJson}");
  }
  assert.match(page, /cancelDoudianOpportunityFavorites/);
  assert.match(favoritesDomain, /auto_submit_task_id/);
  assert.match(runner, /task\.taskType === "opportunityFavoriteCancel"/);
});

test("combines auto favorites and invalid cleanup in one route", async () => {
  const { app, page, featureRoutes } = await loadContract();

  assert.match(featureRoutes, /route: "\/opportunities\/favorites"/);
  assert.match(featureRoutes, /component: OpportunityAutoFavoritesPage/);
  assert.doesNotMatch(featureRoutes, /\/opportunities\/favorites\/cleanup/);
  assert.doesNotMatch(featureRoutes, /OpportunityFavoritesPage/);
  assert.match(page, /clearDoudianInvalidOpportunityFavorites/);
  assert.match(page, /清理失效收藏/);
  assert.doesNotMatch(page, /清理记录/);
  assert.match(app, /resolveFeatureRoutes/);
});
