import assert from "node:assert/strict";
import test from "node:test";

import { validateStaleGoodsMutationResponse } from "../src/domain/doudian/staleGoodsMutationResponse.ts";

const perProduct = (productIds) => ({
  planKey: "staleGoodsBatchDelete",
  responseContract: "per-product-code",
  productIds
});

test("stale cleanup requires an explicit top-level success code", () => {
  const result = validateStaleGoodsMutationResponse({ ok: true, data: { data: [] } }, perProduct(["p1"]));
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.message, /missing success code/);
});

test("stale cleanup maps product results by product id and accepts only item code zero", () => {
  const result = validateStaleGoodsMutationResponse({
    ok: true,
    data: {
      code: 0,
      data: [
        { product_id: "p2", code: 0, msg: "ok" },
        { product_id: "p1", code: 0, msg: "ok" }
      ]
    }
  }, perProduct(["p1", "p2"]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.productId), ["p1", "p2"]);
  assert.equal(result.failures.length, 0);
});

test("stale cleanup preserves per-product platform failures", () => {
  const result = validateStaleGoodsMutationResponse({
    ok: true,
    data: {
      code: 0,
      data: [
        { product_id: "p1", code: 0, msg: "ok" },
        { product_id: "p2", code: 1007, msg: "product cannot be recycled" }
      ]
    }
  }, perProduct(["p1", "p2"]));
  assert.equal(result.ok, false);
  assert.equal(result.items[0].ok, true);
  assert.equal(result.items[1].ok, false);
  assert.equal(result.failures[0].productId, "p2");
  assert.equal(result.failures[0].message, "product cannot be recycled");
});

test("stale cleanup rejects a missing per-product result", () => {
  const result = validateStaleGoodsMutationResponse({
    ok: true,
    data: { code: 0, data: [{ product_id: "p1", code: 0 }] }
  }, perProduct(["p1", "p2"]));
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].productId, "p2");
  assert.match(result.failures[0].message, /missing this product result/);
});

test("complete delete uses the verified top-level response contract", () => {
  const result = validateStaleGoodsMutationResponse({ ok: true, data: { code: 0, msg: "success" } }, {
    planKey: "staleGoodsCompleteDelete",
    responseContract: "top-level-code",
    productIds: ["p1", "p2"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.responseItemShape, "top-level");
});
