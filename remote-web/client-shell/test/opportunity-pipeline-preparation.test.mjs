import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  aggregateCategoryDemands,
  mapConcurrentOrdered
} from "../src/domain/doudian/opportunity/pipelinePreparation.ts";

const pipelineSource = await readFile(new URL("../src/domain/doudian/opportunityReport.ts", import.meta.url), "utf8");

test("store preparation uses at most two slots and preserves input order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapConcurrentOrdered([40, 5, 20, 1], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return index;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 1, 2, 3]);
});

test("cancelled preparation does not allocate another store after an active slot finishes", async () => {
  let cancelled = false;
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const work = mapConcurrentOrdered(["a", "b", "c", "d"], 2, async (item) => {
    started.push(item);
    await gate;
    return item;
  }, { shouldStop: () => cancelled });

  while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  cancelled = true;
  release();

  assert.deepEqual(await work, ["a", "b"]);
  assert.deepEqual(started, ["a", "b"]);
});

test("category demand is tenant isolated and keeps the largest page budget", () => {
  const demands = aggregateCategoryDemands([
    { tenantId: "tenant-a", shopId: "shop-1", categoryKeys: ["cat-1", "cat-2"], requestedPages: 5, fullCoverage: false },
    { tenantId: "tenant-a", shopId: "shop-2", categoryKeys: ["cat-1"], requestedPages: 200, fullCoverage: true },
    { tenantId: "tenant-b", shopId: "shop-3", categoryKeys: ["cat-1"], requestedPages: 5, fullCoverage: false }
  ]);
  assert.deepEqual(demands.get("tenant-a::cat-1"), {
    requestedPages: 200,
    fullCoverage: true,
    consumerShopIds: ["shop-1", "shop-2"]
  });
  assert.deepEqual(demands.get("tenant-b::cat-1"), {
    requestedPages: 5,
    fullCoverage: false,
    consumerShopIds: ["shop-3"]
  });
});

test("pipeline integrates the two-slot pool before and after demand aggregation", () => {
  assert.equal((pipelineSource.match(/mapConcurrentOrdered\(preparedStores, storePrepareConcurrency/g) || []).length, 1);
  assert.match(pipelineSource, /mapConcurrentOrdered\(targets, storePrepareConcurrency/);
  assert.match(pipelineSource, /const storePrepareConcurrency = 2/);
  assert.match(pipelineSource, /clueCacheLoadFlights\.get\(flightKey\)/);
});

test("pipeline stops preparation and reports a coverage-gated store as skipped", () => {
  assert.match(pipelineSource, /mapConcurrentOrdered\(targets, storePrepareConcurrency,[\s\S]*?\{ shouldStop: \(\) => pipelineCancelled\(args\) \}\)/);
  assert.match(pipelineSource, /if \(!writeCoverageComplete\) skipReason = "input_coverage_not_complete"/);
  assert.match(pipelineSource, /plannedSubmitCandidateCount: persistedPlannedSubmitCandidateCount/);
});
