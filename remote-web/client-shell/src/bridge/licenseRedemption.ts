const SUCCESSFUL_REDEMPTION_STATUSES = new Set(["active", "redeemed", "redeemed_refresh_failed"]);

export function isSuccessfulLicenseRedemption(status: {
  ok?: boolean;
  paidAccessGranted: boolean;
  status?: string;
}): boolean {
  return status.ok === true
    && status.paidAccessGranted === true
    && SUCCESSFUL_REDEMPTION_STATUSES.has(String(status.status || ""));
}
