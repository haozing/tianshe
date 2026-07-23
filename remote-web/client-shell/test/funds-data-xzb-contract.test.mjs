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
    assert.equal(adapter.endpoints.fundAccountOpenInfo, "/ecom/merchant/queryAccountOpenInfo");
    assert.equal(adapter.requestPlans.fundAccountOpenInfo.method, "POST");
    assert.equal(adapter.requestPlans.fundAccountOpenInfo.referer, "https://fxg.jinritemai.com/ffa/ecom/merchant/payment-settings");
    assert.deepEqual(adapter.requestPlans.fundAccountOpenInfo.body, { merchant_ecom_source: "/pc/fxg", exts: {} });
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
      ["fundAccountOpenInfo"],
      ["fundPledgeCash", "fundPledgePayable"],
      ["fundShopAwardOverview", "fundCompensateStatistics", "fundBillQuery"]
    ]);
    assert.deepEqual(policy.requiredPlans, ["fundAccountList", "fundPledgeCash", "fundPledgePayable"]);
    assert.deepEqual(policy.criticalPlans, ["fundAccountList", "fundPledgeCash", "fundPledgePayable"]);
    assert.equal(policy.optionalPlans.includes("fundAccountOpenInfo"), true);
    assert.deepEqual(adapter.responseMappings.fundsData.fields.accountName.paths, [
      "fundAccountOpenInfo.opened_info.NEW_HZ.bank_settle_card.bank_account_name",
      "fundAccountOpenInfo.data.opened_info.NEW_HZ.bank_settle_card.bank_account_name"
    ]);
    assert.deepEqual(adapter.responseMappings.fundsData.fields.accountName.sourcePlans, ["fundAccountOpenInfo"]);
    assert.deepEqual(adapter.responseMappings.fundsData.fields.accountBank.paths, [
      "fundAccountOpenInfo.opened_info.NEW_HZ.bank_settle_card.bank_name",
      "fundAccountOpenInfo.data.opened_info.NEW_HZ.bank_settle_card.bank_name"
    ]);
    assert.deepEqual(adapter.responseMappings.fundsData.fields.accountBank.sourcePlans, ["fundAccountOpenInfo"]);
    assert.deepEqual(adapter.responseMappings.fundsData.fields.phone.paths, [
      "fundAccountOpenInfo.opened_info.NEW_HZ.bank_settle_card.bank_card_mobile",
      "fundAccountOpenInfo.data.opened_info.NEW_HZ.bank_settle_card.bank_card_mobile"
    ]);
    assert.deepEqual(adapter.responseMappings.fundsData.fields.phone.sourcePlans, ["fundAccountOpenInfo"]);
    assert.deepEqual(policy.fieldSchema.columns.slice(0, 3).map(({ key, label, format }) => ({ key, label, format })), [
      { key: "accountName", label: "开户名", format: "text" },
      { key: "accountBank", label: "开户银行", format: "text" },
      { key: "phone", label: "手机号", format: "text" }
    ]);
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

test("funds page does not display risk or unavailable status badges", async () => {
  const source = await readFile(fundsPageUrl, "utf8");

  assert.match(source, /key: "accountName", label: "开户名", format: "text"/);
  assert.match(source, /key: "accountBank", label: "开户银行", format: "text"/);
  assert.match(source, /key: "phone", label: "手机号", format: "text"/);
  assert.match(source, />\s*开户筛选/);
  assert.match(source, /暂无匹配开户信息的店铺/);
  assert.match(source, /format === "text"/);
  assert.doesNotMatch(source, /家存在资金事项/);
  assert.doesNotMatch(source, /家不可用/);
  assert.doesNotMatch(source, />不可用指标</);
  assert.doesNotMatch(source, />旧</);
  assert.match(source, /setFundsMessage\(`资金任务执行失败：\$\{errorMessage\}`\)/);
});

test("funds account filters are selectable options built from cached rows", async () => {
  const source = await readFile(fundsPageUrl, "utf8");
  const filterStart = source.indexOf("开户筛选");
  const filterEnd = source.indexOf("<NativeSelect", filterStart);
  const filterSource = source.slice(filterStart, filterEnd);

  assert.match(source, /function buildAccountFilterOptions\(rows: FundsRow\[\]/);
  assert.match(source, /return import\.meta\.env\.DEV === true/);
  assert.match(source, /const accountFilterRows = useMemo\([\s\S]*fundsRows\.filter\(\(row\) => selectedIds\.has\(row\.shopId\)\)/);
  assert.match(source, /\[\.\.\.new Set\(values\)\]\.sort/);
  assert.match(filterSource, /<select/);
  assert.match(filterSource, /`全部\$\{label\}`/);
  assert.match(filterSource, /disabled=\{!availableAccountFilterOptions\[key\]\.length\}/);
  assert.doesNotMatch(filterSource, /<input/);
});
