const MAX_LEASE_MS = 10 * 60 * 1000;

function developmentBypassAllowed({ isPackaged, explicitTestMode, bypassRequested }) {
  return isPackaged === false && explicitTestMode === true && bypassRequested === true;
}

function leaseTtlMs({ isPermanent, remainingMs, maxLeaseMs = MAX_LEASE_MS }) {
  const maximum = Math.max(0, Number(maxLeaseMs || 0));
  if (isPermanent === true) return maximum;
  const remaining = Math.max(0, Number(remainingMs || 0));
  return Math.min(maximum, remaining);
}

function leaseIsActive(lease, monotonicNow) {
  return Boolean(lease && Number(lease.expiresAtMonotonic) > Number(monotonicNow));
}

function accessStatusFromLease(lease, monotonicNow) {
  const active = leaseIsActive(lease, monotonicNow);
  return {
    licensed: active,
    paidAccessGranted: active,
    paidAccessSource: active ? lease.source : "none"
  };
}

function canAccessTier(status, tier) {
  return tier === "free" || status?.paidAccessGranted === true;
}

module.exports = {
  MAX_LEASE_MS,
  accessStatusFromLease,
  canAccessTier,
  developmentBypassAllowed,
  leaseIsActive,
  leaseTtlMs
};
