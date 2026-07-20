import { getChihuNative } from "../native/client";
import type { NativeLicenseStatus } from "../native/types";
export { canAccessTier, paidAccessRefreshDelayMs, type AccessTier } from "../access";

export type LicenseStatus = NativeLicenseStatus;

export const initialLicenseStatus: LicenseStatus = {
  ok: false,
  configured: false,
  licensed: false,
  allowFreeFeatures: true,
  allowPaidFeatures: false,
  paidAccessGranted: false,
  paidAccessSource: "none",
  verificationPending: false,
  status: "pending",
  reason: "",
  message: ""
};

function unavailableStatus(message = "当前客户端版本过低，请更新后继续使用。") {
  return {
    ...initialLicenseStatus,
    status: "unavailable",
    reason: "LICENSE_BRIDGE_UNAVAILABLE",
    message
  };
}

function normalizeLicenseStatus(status: NativeLicenseStatus | null | undefined): LicenseStatus {
  if (!status) return unavailableStatus();
  return {
    ...status,
    configured: Boolean(status.configured),
    licensed: status.paidAccessGranted === true,
    allowFreeFeatures: Boolean(status.allowFreeFeatures),
    allowPaidFeatures: Boolean(status.allowPaidFeatures),
    paidAccessGranted: status.paidAccessGranted === true,
    paidAccessSource: ["server", "redeem", "bypass"].includes(String(status.paidAccessSource)) ? status.paidAccessSource : "none",
    paidAccessLeaseRemainingSeconds: Number.isFinite(Number(status.paidAccessLeaseRemainingSeconds)) ? Math.max(0, Number(status.paidAccessLeaseRemainingSeconds)) : 0,
    verificationPending: status.verificationPending === true,
    remainingSeconds: Number.isFinite(Number(status.remainingSeconds)) ? Number(status.remainingSeconds) : 0
  };
}

export async function getLicenseStatus(args: { refresh?: boolean; scene?: string } = {}): Promise<LicenseStatus> {
  const native = getChihuNative();
  if (!native?.license?.getStatus) return unavailableStatus();
  return normalizeLicenseStatus(await native.license.getStatus(args));
}

export async function checkLicense(scene = "startup"): Promise<LicenseStatus> {
  const native = getChihuNative();
  if (!native?.license?.check) return unavailableStatus();
  return normalizeLicenseStatus(await native.license.check({ scene }));
}

export async function redeemLicense(cardKey: string): Promise<LicenseStatus> {
  const native = getChihuNative();
  if (!native?.license?.redeem) return unavailableStatus();
  return normalizeLicenseStatus(await native.license.redeem({ cardKey }));
}

export async function clearLocalLicense(): Promise<LicenseStatus> {
  const native = getChihuNative();
  if (!native?.license?.clearLocal) return unavailableStatus();
  return normalizeLicenseStatus(await native.license.clearLocal());
}
