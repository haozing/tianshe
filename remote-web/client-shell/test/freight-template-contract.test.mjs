import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const adapter = JSON.parse(fs.readFileSync(new URL("../public/config/doudian-adapter.json", import.meta.url), "utf8"));
const domain = fs.readFileSync(new URL("../src/domain/doudian/productCatalog.ts", import.meta.url), "utf8");

test("freight templates use the verified token and signed paged-list endpoints", () => {
  assert.equal(adapter.endpoints.freightTemplateToken, "/common/index/index");
  assert.equal(adapter.endpoints.freightTemplateList, "/freight/template/getShopFreightTemplate");
  assert.deepEqual(adapter.requestPlans.freightTemplateToken.query, { _: "{timestamp}", appid: "1" });
  assert.deepEqual(adapter.requestPlans.freightTemplateList.query, {
    name: "{name}",
    page: "{page}",
    pageSize: "{pageSize}",
    appid: "1",
    _bid: "ffa_order",
    __token: "{token}"
  });
  assert.equal(adapter.requestPlans.freightTemplateList.signStrategy, "mstoken-myargs");
  assert.equal(adapter.requestPlans.freightTemplateList.referer, "https://fxg.jinritemai.com/ffa/morder/logistics/freight-list");
});

test("freight template loading is bounded, paged, and preserves per-store failures", () => {
  assert.match(domain, /const pageSize = 100/);
  assert.match(domain, /const maxPages = 50/);
  assert.match(domain, /for \(let page = 0; page < maxPages; page \+= 1\)/);
  assert.match(domain, /template_name/);
  assert.match(domain, /failureCount/);
});
