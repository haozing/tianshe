import test from "node:test";
import assert from "node:assert/strict";
import { isSuccessfulLicenseRedemption } from "../src/bridge/licenseRedemption.ts";

const activeLicense = {
  ok: true,
  configured: true,
  licensed: true,
  allowFreeFeatures: true,
  allowPaidFeatures: true,
  paidAccessGranted: true,
  paidAccessSource: "server",
  verificationPending: false,
  status: "active"
};

test("an invalid card does not count as redeemed when the device already has paid access", () => {
  const invalidCardResult = {
    ...activeLicense,
    ok: false,
    status: "redeem_error",
    reason: "CARD_KEY_INVALID",
    message: "卡密无效"
  };

  assert.equal(isSuccessfulLicenseRedemption(invalidCardResult), false);
});

test("a successful redemption closes the renewal flow", () => {
  assert.equal(isSuccessfulLicenseRedemption(activeLicense), true);
  assert.equal(isSuccessfulLicenseRedemption({
    ...activeLicense,
    paidAccessSource: "redeem",
    status: "redeemed_refresh_failed"
  }), true);
});

test("paid access alone cannot turn a failed response into a successful redemption", () => {
  assert.equal(isSuccessfulLicenseRedemption({
    ...activeLicense,
    ok: false
  }), false);
});
