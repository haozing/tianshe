import assert from "node:assert/strict";
import test from "node:test";

import { groupStoresByName, toggleStoreIds } from "../src/domain/doudian/storeSelection.ts";

test("groups stores with ungrouped stores first", () => {
  const groups = groupStoresByName([
    { id: "3", group: "华南组" },
    { id: "1", group: "" },
    { id: "2", group: "华东组" },
    { id: "4", group: "  " }
  ]);

  assert.deepEqual(groups.map((group) => group.name), ["未分组", "华东组", "华南组"]);
  assert.deepEqual(groups[0].stores.map((store) => store.id), ["1", "4"]);
});

test("selects every store when a group is partially selected", () => {
  const current = new Set(["shop-a"]);
  const next = toggleStoreIds(current, ["shop-a", "shop-b"]);

  assert.deepEqual([...next].sort(), ["shop-a", "shop-b"]);
  assert.deepEqual([...current], ["shop-a"]);
});

test("clears a group when every store is selected", () => {
  const next = toggleStoreIds(new Set(["shop-a", "shop-b", "shop-c"]), ["shop-a", "shop-b"]);

  assert.deepEqual([...next], ["shop-c"]);
});
