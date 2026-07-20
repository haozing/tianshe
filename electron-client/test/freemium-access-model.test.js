const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  accessStatusFromLease,
  canAccessTier,
  developmentBypassAllowed,
  leaseTtlMs
} = require("../src/main/license/access-model");

test("persisted paid observations never grant access without a process lease", () => {
  const persisted = { allowPaidFeatures: true, authStatus: "active" };
  const access = accessStatusFromLease(null, 100);
  assert.equal(persisted.allowPaidFeatures, true);
  assert.deepEqual(access, { licensed: false, paidAccessGranted: false, paidAccessSource: "none" });
  assert.equal(canAccessTier({ ...persisted, ...access }, "free"), true);
  assert.equal(canAccessTier({ ...persisted, ...access }, "paid"), false);
});

test("paid access follows only a live monotonic process lease", () => {
  const lease = { source: "server", expiresAtMonotonic: 500 };
  assert.equal(accessStatusFromLease(lease, 499).paidAccessGranted, true);
  assert.equal(accessStatusFromLease(lease, 500).paidAccessGranted, false);
  assert.equal(leaseTtlMs({ isPermanent: false, remainingMs: 20 * 60_000 }), 10 * 60_000);
  assert.equal(leaseTtlMs({ isPermanent: false, remainingMs: 30_000 }), 30_000);
});

test("license bypass is impossible in a packaged process", () => {
  assert.equal(developmentBypassAllowed({ isPackaged: true, explicitTestMode: true, bypassRequested: true }), false);
  assert.equal(developmentBypassAllowed({ isPackaged: false, explicitTestMode: false, bypassRequested: true }), false);
  assert.equal(developmentBypassAllowed({ isPackaged: false, explicitTestMode: true, bypassRequested: false }), false);
  assert.equal(developmentBypassAllowed({ isPackaged: false, explicitTestMode: true, bypassRequested: true }), true);
});

test("marketing smoke bypass always declares explicit test mode", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../scripts/run-smoke.js"), "utf8");
  assert.match(source, /CHIHU_EXPLICIT_TEST_MODE:\s*"1"/);
  assert.match(source, /\["marketing-read",\s*"marketing-write"\].+CHIHU_LICENSE_BYPASS:\s*"1"/s);
});
