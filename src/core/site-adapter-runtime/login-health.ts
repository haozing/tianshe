import type { ProfileLoginStateStatus } from '../../types/profile';

export type SiteLoginHealthStatus =
  | 'ready'
  | 'needs_manual_login'
  | 'captcha'
  | 'two_factor'
  | 'blocked'
  | 'expired'
  | 'unverified'
  | 'runtime_mismatch'
  | 'unknown';

export type SiteLoginHealthReason =
  | 'missing_login_state'
  | 'verified_login_state'
  | 'status_not_logged_in'
  | 'login_state_unverified'
  | 'login_state_expired'
  | 'runtime_mismatch'
  | 'verification_stale'
  | 'unknown_login_state';

export interface SiteLoginHealthState {
  profileId: string;
  site: string;
  loginUrl?: string | null;
  runtimeId?: string | null;
  runtimeIdSnapshot?: string | null;
  profileRevision?: number | null;
  status: ProfileLoginStateStatus;
  verified: boolean;
  lastCheckedAt?: string | Date | null;
  verifiedAt?: string | Date | null;
  reason?: string | null;
}

export interface SiteLoginHealthInput {
  profileId: string;
  site: string;
  state?: SiteLoginHealthState | null;
  requiredRuntimeId?: string | null;
  currentProfileRevision?: number | null;
  maxVerifiedAgeMs?: number;
  now?: Date;
}

export interface SiteLoginHealthResult {
  ok: boolean;
  status: SiteLoginHealthStatus;
  reasonCode: SiteLoginHealthReason;
  manualHandoffRequired: boolean;
  profileId: string;
  site: string;
  loginUrl: string | null;
  runtimeId: string | null;
  profileRevision: number | null;
  currentProfileRevision: number | null;
  requiredRuntimeId: string | null;
  verified: boolean;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  safeEvidence: {
    credentialValuesReturned: false;
    cookieValuesReturned: false;
    tokenValuesReturned: false;
  };
}

const toIsoOrNull = (value: string | Date | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const staleVerification = (
  verifiedAt: string | Date | null | undefined,
  maxVerifiedAgeMs: number | undefined,
  now: Date
): boolean => {
  if (!maxVerifiedAgeMs || maxVerifiedAgeMs <= 0 || !verifiedAt) {
    return false;
  }
  const date = verifiedAt instanceof Date ? verifiedAt : new Date(verifiedAt);
  return Number.isNaN(date.getTime()) ? true : now.getTime() - date.getTime() > maxVerifiedAgeMs;
};

const normalizeBlockedStatus = (
  status: ProfileLoginStateStatus
): Extract<SiteLoginHealthStatus, 'needs_manual_login' | 'captcha' | 'two_factor' | 'blocked' | 'expired' | 'unknown'> => {
  if (
    status === 'needs_manual_login' ||
    status === 'captcha' ||
    status === 'two_factor' ||
    status === 'blocked' ||
    status === 'expired'
  ) {
    return status;
  }
  return 'unknown';
};

export function evaluateSiteLoginHealth(input: SiteLoginHealthInput): SiteLoginHealthResult {
  const state = input.state || null;
  const now = input.now || new Date();
  const requiredRuntimeId = input.requiredRuntimeId?.trim() || null;
  const currentProfileRevision =
    typeof input.currentProfileRevision === 'number' && Number.isFinite(input.currentProfileRevision)
      ? Math.trunc(input.currentProfileRevision)
      : null;
  const profileRevision =
    typeof state?.profileRevision === 'number' && Number.isFinite(state.profileRevision)
      ? Math.trunc(state.profileRevision)
      : null;
  const base = {
    profileId: input.profileId,
    site: input.site,
    loginUrl: state?.loginUrl?.trim() || null,
    runtimeId: state?.runtimeIdSnapshot?.trim() || state?.runtimeId?.trim() || null,
    profileRevision,
    currentProfileRevision,
    requiredRuntimeId,
    verified: state?.verified === true,
    lastCheckedAt: toIsoOrNull(state?.lastCheckedAt),
    verifiedAt: toIsoOrNull(state?.verifiedAt),
    safeEvidence: {
      credentialValuesReturned: false,
      cookieValuesReturned: false,
      tokenValuesReturned: false,
    },
  } satisfies Omit<
    SiteLoginHealthResult,
    'ok' | 'status' | 'reasonCode' | 'manualHandoffRequired'
  >;

  if (!state) {
    return {
      ...base,
      ok: false,
      status: 'needs_manual_login',
      reasonCode: 'missing_login_state',
      manualHandoffRequired: true,
    };
  }

  if (
    requiredRuntimeId &&
    (state.runtimeIdSnapshot || state.runtimeId) &&
    (state.runtimeIdSnapshot || state.runtimeId || '').trim() &&
    (state.runtimeIdSnapshot || state.runtimeId || '').trim() !== requiredRuntimeId
  ) {
    return {
      ...base,
      ok: false,
      status: 'runtime_mismatch',
      reasonCode: 'runtime_mismatch',
      manualHandoffRequired: true,
    };
  }

  if (
    currentProfileRevision !== null &&
    profileRevision !== null &&
    profileRevision !== currentProfileRevision
  ) {
    return {
      ...base,
      ok: false,
      status: 'expired',
      reasonCode: 'login_state_expired',
      manualHandoffRequired: true,
    };
  }

  if (state.status === 'expired') {
    return {
      ...base,
      ok: false,
      status: 'expired',
      reasonCode: 'login_state_expired',
      manualHandoffRequired: true,
    };
  }

  if (state.status !== 'logged_in') {
    return {
      ...base,
      ok: false,
      status: normalizeBlockedStatus(state.status),
      reasonCode: state.status === 'unknown' ? 'unknown_login_state' : 'status_not_logged_in',
      manualHandoffRequired: true,
    };
  }

  if (state.verified !== true || !state.verifiedAt) {
    return {
      ...base,
      ok: false,
      status: 'unverified',
      reasonCode: 'login_state_unverified',
      manualHandoffRequired: true,
    };
  }

  if (staleVerification(state.verifiedAt, input.maxVerifiedAgeMs, now)) {
    return {
      ...base,
      ok: false,
      status: 'expired',
      reasonCode: 'verification_stale',
      manualHandoffRequired: true,
    };
  }

  return {
    ...base,
    ok: true,
    status: 'ready',
    reasonCode: 'verified_login_state',
    manualHandoffRequired: false,
  };
}
