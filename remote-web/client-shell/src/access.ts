import type { NativeLicenseStatus } from "./native/types";

export type AccessTier = "free" | "paid";

export function canAccessTier(status: NativeLicenseStatus, tier: AccessTier) {
  if (tier === "free") return true;
  return status.paidAccessGranted === true;
}

export function paidAccessRefreshDelayMs(status: NativeLicenseStatus) {
  if (status.paidAccessGranted !== true) return null;
  const remainingSeconds = Number(status.paidAccessLeaseRemainingSeconds);
  if (!Number.isFinite(remainingSeconds)) return 9 * 60 * 1000;
  return Math.max(1000, Math.min(9 * 60 * 1000, remainingSeconds * 1000 - 5000));
}
