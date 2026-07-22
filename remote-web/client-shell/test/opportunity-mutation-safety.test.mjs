import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { opportunityLiveLookupContext } from "../src/domain/doudian/opportunity/mutationSafetyContract.ts";

const adapterUrls = [
  new URL("../public/config/doudian-adapter.json", import.meta.url),
  new URL("../public/config/doudian-adapter.marketing-pilot.json", import.meta.url)
];

test("opportunity live lookup sends the exact product id in id_name_code", () => {
  const context = opportunityLiveLookupContext("3832480162683945019");

  assert.equal(context.idNameCode, "3832480162683945019");
  assert.equal(context.keyword, "");
  assert.equal(context.page, "0");
  assert.equal(context.pageSize, "20");
  assert.equal(context.isOnline, "");
  assert.equal(context.isOffline, "");
});

test("all opportunity adapters bind id_name_code to the exact-id context", () => {
  for (const url of adapterUrls) {
    const adapter = JSON.parse(fs.readFileSync(url, "utf8"));
    assert.equal(adapter.requestPlans.opportunityProductList.query.id_name_code, "{idNameCode}");
  }
});
