import assert from "node:assert/strict";
import test from "node:test";
import { confirmedStoreIdentityPatch } from "../src/domain/doudian/storeIdentity.ts";

test("updates a renamed store when the stable shop id matches", () => {
  const patch = confirmedStoreIdentityPatch({
    shopId: "1001",
    shopName: "旧店名",
    shopInfoSummary: { id: "1001", shop_name: "旧店名", category: "旗舰店" }
  }, {
    currentShopId: "1001",
    currentShopName: "新店名"
  });

  assert.deepEqual(patch, {
    shopName: "新店名",
    shopInfoSummary: { id: "1001", shop_name: "新店名", category: "旗舰店" }
  });
});

test("does not update a name returned for a different shop id", () => {
  const patch = confirmedStoreIdentityPatch({
    shopId: "1001",
    shopName: "店铺 A"
  }, {
    currentShopId: "2002",
    currentShopName: "店铺 B"
  });

  assert.deepEqual(patch, {});
});

test("does not erase the local name when the platform omits it", () => {
  const patch = confirmedStoreIdentityPatch({
    shopId: "1001",
    shopName: "现有店名"
  }, {
    currentShopId: "1001",
    currentShopName: ""
  });

  assert.deepEqual(patch, {});
});
