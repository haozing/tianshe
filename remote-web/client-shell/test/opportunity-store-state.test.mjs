import assert from "node:assert/strict";
import test from "node:test";

import {
  activeStoreRefs,
  reconcileSelectedShopIds,
  restoredActiveShopIds,
  storeIdentityKey
} from "../src/domain/doudian/opportunityStoreState.ts";

function store(shopId, storeGeneration = 1) {
  return {
    tenantId: "local-user",
    shopId,
    shopName: shopId,
    storeGeneration,
    platform: "doudian",
    partition: `persist:${shopId}`,
    status: "online"
  };
}

test("deleted stores are removed from the active selection", () => {
  assert.deepEqual([...reconcileSelectedShopIds([], ["shop-a", "shop-b"])], []);
  assert.deepEqual([...reconcileSelectedShopIds([store("shop-b")], ["shop-a", "shop-b"])], ["shop-b"]);
});

test("restored selections require the same store generation", () => {
  const active = [store("shop-a", 2), store("shop-b", 1)];
  const restored = restoredActiveShopIds(active, [
    { tenantId: "local-user", shopId: "shop-a", storeGeneration: 1 },
    { tenantId: "local-user", shopId: "shop-b", storeGeneration: 1 }
  ]);
  assert.deepEqual([...restored], ["shop-b"]);
  assert.notEqual(storeIdentityKey(active[0]), storeIdentityKey({ tenantId: "local-user", shopId: "shop-a", storeGeneration: 1 }));
});

test("active store refs only include selected current stores", () => {
  assert.deepEqual(activeStoreRefs([store("shop-a", 2), store("shop-b", 1)], ["shop-a"]), [
    { tenantId: "local-user", shopId: "shop-a", storeGeneration: 2 }
  ]);
});
