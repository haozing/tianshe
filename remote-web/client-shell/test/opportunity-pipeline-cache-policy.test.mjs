import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSharedCacheProbe,
  resolvePipelineCacheScope
} from "../src/domain/doudian/opportunity/pipelineCachePolicy.ts";

test("shared clue cache requires an explicit tenant and global feature gate", () => {
  assert.equal(resolvePipelineCacheScope("global", true, "tenant-a"), "global");
  assert.equal(resolvePipelineCacheScope("global", true, "local-user"), "shop");
  assert.equal(resolvePipelineCacheScope("global", false, "tenant-a"), "shop");
  assert.equal(resolvePipelineCacheScope("shop", true, "tenant-a"), "shop");
});

test("shared cache probe rejects first-page or remote-total drift", () => {
  assert.deepEqual(evaluateSharedCacheProbe({
    cachedIds: ["2", "1"],
    probeIds: ["1", "2"],
    cachedRemoteTotal: 20,
    cachedRemoteTotalKnown: true,
    probeRemoteTotal: 20
  }), { ok: true, totalMatches: true, fingerprintMatches: true });
  assert.equal(evaluateSharedCacheProbe({
    cachedIds: ["1", "2"],
    probeIds: ["1", "3"],
    cachedRemoteTotal: 20,
    cachedRemoteTotalKnown: true,
    probeRemoteTotal: 20
  }).ok, false);
  assert.equal(evaluateSharedCacheProbe({
    cachedIds: ["1", "2"],
    probeIds: ["1", "2"],
    cachedRemoteTotal: 20,
    cachedRemoteTotalKnown: true,
    probeRemoteTotal: 21
  }).ok, false);
});
