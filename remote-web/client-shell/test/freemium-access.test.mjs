import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canAccessTier, paidAccessRefreshDelayMs } from "../src/access.ts";
import { deferredMarketingScheduleReason, marketingScheduleDue } from "../src/domain/doudian/marketing/schedulerPolicy.ts";

const routeSource = await readFile(fileURLToPath(new URL("../src/featureRoutes.tsx", import.meta.url)), "utf8");

test("every feature route declares an explicit access tier", () => {
  const routeRows = routeSource.split("\n").filter((line) => line.includes("route:") && line.includes("parentRoute:"));
  assert.ok(routeRows.length >= 12);
  for (const row of routeRows) assert.match(row, /accessTier: "(?:free|paid)"/);
});

test("free route whitelist and paid route families remain exact", () => {
  for (const route of ["/stores", "/stores/business-data", "/stores/funds", "/warnings", "/products/slow-moving", "/products/bulk-delete"]) {
    assert.match(routeSource, new RegExp(`route: "${route.replace(/\//g, "\\/")}"[^\n]+accessTier: "free"`));
  }
  const paidRows = routeSource.split("\n").filter((line) => /route: "\/(?:opportunities|marketing)\//.test(line));
  assert.ok(paidRows.length >= 6);
  for (const row of paidRows) assert.match(row, /accessTier: "paid"/);
  assert.match(routeSource, /SYSTEM_FREE_ROUTES = \["\/system\/diagnostics"\]/);
});

test("allowPaidFeatures is diagnostic and cannot replace paidAccessGranted", () => {
  const status = {
    configured: true,
    licensed: false,
    allowFreeFeatures: true,
    allowPaidFeatures: true,
    paidAccessGranted: false,
    paidAccessSource: "none",
    verificationPending: false
  };
  assert.equal(canAccessTier(status, "free"), true);
  assert.equal(canAccessTier(status, "paid"), false);
  assert.equal(canAccessTier({ ...status, paidAccessGranted: true }, "paid"), true);
});

test("deferred marketing schedules are not treated as due work", () => {
  assert.equal(marketingScheduleDue({ status: "deferred", nextRunAt: new Date(0).toISOString(), intervalMs: 60_000 }, Date.now()), false);
});

test("paid access refresh is scheduled before the process lease expires", () => {
  const status = {
    configured: true,
    licensed: true,
    allowFreeFeatures: true,
    paidAccessGranted: true,
    paidAccessSource: "server",
    verificationPending: false,
    paidAccessLeaseRemainingSeconds: 600
  };
  assert.equal(paidAccessRefreshDelayMs(status), 9 * 60 * 1000);
  assert.equal(paidAccessRefreshDelayMs({ ...status, paidAccessLeaseRemainingSeconds: 30 }), 25_000);
  assert.equal(paidAccessRefreshDelayMs({ ...status, paidAccessGranted: false }), null);
});

test("authorization failures defer marketing schedules", () => {
  assert.equal(deferredMarketingScheduleReason({ code: "LICENSE_REQUIRED" }), "license_required");
  assert.equal(deferredMarketingScheduleReason({ code: "AUTH_EXPIRED" }), "license_required");
  assert.equal(deferredMarketingScheduleReason({ code: "AUTH_CHECK_FAILED" }), "auth_check_failed");
  assert.equal(deferredMarketingScheduleReason(new Error("transport failed")), null);
});
