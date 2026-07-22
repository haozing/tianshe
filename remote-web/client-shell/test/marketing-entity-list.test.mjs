import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildMarketingEntityShopOptions,
  marketingEntityKeys,
  toggleMarketingEntitySelection
} from "../src/lib/marketingEntityList.ts";

test("marketing activity counts include zero-count selected stores", () => {
  const stores = [{ id: "s1", name: "甲店" }, { id: "s2", name: "乙店" }];
  const entities = [
    { shopId: "s1", shopName: "甲店", entityId: "a1" },
    { shopId: "s1", shopName: "甲店", entityId: "a2" }
  ];

  const counts = Object.fromEntries(buildMarketingEntityShopOptions(entities, stores).map((store) => [store.id, store.count]));
  assert.deepEqual(counts, { s1: 2, s2: 0 });
});

test("select all toggles only the currently filtered marketing rows", () => {
  const visibleKeys = marketingEntityKeys([
    { shopId: "s1", entityId: "a1" },
    { shopId: "s1", entityId: "a2" }
  ]);
  const selected = toggleMarketingEntitySelection(new Set(["s2:b1"]), visibleKeys);
  assert.deepEqual([...selected].sort(), ["s1:a1", "s1:a2", "s2:b1"]);
  assert.deepEqual([...toggleMarketingEntitySelection(selected, visibleKeys)], ["s2:b1"]);
});

test("marketing management UI exposes store counts and filtered select-all", async () => {
  const workspace = await readFile(fileURLToPath(new URL("../src/components/marketing/MarketingWorkspacePage.tsx", import.meta.url)), "utf8");
  const couponTable = await readFile(fileURLToPath(new URL("../src/components/marketing/GeneralCouponManagementTable.tsx", import.meta.url)), "utf8");
  assert.match(workspace, /aria-label="按店铺筛选"/);
  assert.match(workspace, /当前筛选 <strong/);
  assert.match(workspace, /onClick=\{toggleFilteredEntities\}/);
  assert.match(couponTable, /onToggleAll/);
});
