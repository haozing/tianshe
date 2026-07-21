import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterUrls = [
  new URL("../public/config/doudian-adapter.json", import.meta.url),
  new URL("../public/config/doudian-adapter.marketing-pilot.json", import.meta.url)
];
const fundsSourceUrl = new URL("../src/domain/doudian/fundsData.ts", import.meta.url);
const fundsPageUrl = new URL("../src/components/FundsDataPage.tsx", import.meta.url);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

test("funds adapters preserve the verified XZB endpoints and preflight order", async () => {
  for (const url of adapterUrls) {
    const adapter = await readJson(url);
    const policy = adapter.policies.fundsData;

    assert.equal(adapter.endpoints.fundAccountList, "/settlement/account/getAccountList?_s=fe&req_source=dou_dian_pc");
    assert.equal(adapter.endpoints.fundPledgeCash, "/shopuser/govern/bff/api/tpledgecash/index");
    assert.equal(adapter.endpoints.fundPledgePayable, "/governance/shop/tpledgecash/payable/info_v2");
    assert.equal(adapter.requestPlans.fundShopAwardOverview.method, "POST");
    assert.deepEqual(adapter.requestPlans.fundShopAwardOverview.body, { platform_source: 2 });
    assert.equal(adapter.requestPlans.fundCompensateStatistics.method, "POST");
    assert.deepEqual(adapter.requestPlans.fundCompensateStatistics.body, { aftersale_platform_source: "fxg" });
    assert.equal(adapter.requestPlans.fundBillQuery.method, "POST");
    assert.equal(adapter.requestPlans.fundBillQuery.body.query_type, "SHOP_UNSETTLED_ORDER");
    assert.deepEqual(policy.preflightPlans, ["fundAccountList"]);
    assert.deepEqual(policy.requestPlanGroups, [
      ["fundAccountList"],
      ["fundPledgeCash", "fundPledgePayable"],
      ["fundShopAwardOverview", "fundCompensateStatistics", "fundBillQuery"]
    ]);
    assert.deepEqual(policy.requiredPlans, ["fundAccountList", "fundPledgeCash", "fundPledgePayable"]);
    assert.deepEqual(policy.criticalPlans, ["fundAccountList", "fundPledgeCash", "fundPledgePayable"]);
  }
});

test("funds cache cleanup does not require runtime metadata access", async () => {
  const source = await readFile(fundsSourceUrl, "utf8");

  assert.doesNotMatch(source, /runtime_meta|FUNDS_CACHE_MIGRATION_ID|migrateLegacyFundsCache/);
  assert.match(source, /!record\.id\.startsWith\(FUNDS_CURRENT_ID_PREFIX\)/);
  assert.match(source, /record\.adapterVersion !== contract\.adapterVersion/);
  assert.match(source, /record\.requestPlanHash !== contract\.requestPlanHash/);
  assert.match(source, /preflightFailed[\s\S]*break;/);
});

test("global funds task failures are not reported as per-store unavailable results", async () => {
  const source = await readFile(fundsPageUrl, "utf8");

  assert.match(source, /const globalFundsFailure = fundsState === "error" && fundsDetails\.length === 0/);
  assert.match(source, /const unavailableStoreCount = globalFundsFailure\s*\? 0/);
  assert.match(source, /setFundsMessage\(`资金任务执行失败：\$\{errorMessage\}`\)/);
});
