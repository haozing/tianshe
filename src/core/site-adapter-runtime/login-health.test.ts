import { describe, expect, it } from 'vitest';
import { evaluateSiteLoginHealth } from './login-health';

const baseState = {
  profileId: 'profile-1',
  site: 'github.com',
  loginUrl: 'https://github.com/login',
  runtimeId: 'electron-webcontents',
  status: 'logged_in' as const,
  verified: true,
  lastCheckedAt: '2026-06-23T00:00:00.000Z',
  verifiedAt: '2026-06-23T00:00:00.000Z',
};

describe('site login health verifier', () => {
  it('requires manual handoff when login state is missing', () => {
    expect(
      evaluateSiteLoginHealth({
        profileId: 'profile-1',
        site: 'github.com',
      })
    ).toMatchObject({
      ok: false,
      status: 'needs_manual_login',
      reasonCode: 'missing_login_state',
      manualHandoffRequired: true,
      safeEvidence: {
        credentialValuesReturned: false,
        cookieValuesReturned: false,
        tokenValuesReturned: false,
      },
    });
  });

  it('marks verified logged-in state as ready without returning secrets', () => {
    const result = evaluateSiteLoginHealth({
      profileId: 'profile-1',
      site: 'github.com',
      requiredRuntimeId: 'electron-webcontents',
      state: baseState,
      now: new Date('2026-06-23T00:10:00.000Z'),
      maxVerifiedAgeMs: 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      reasonCode: 'verified_login_state',
      manualHandoffRequired: false,
      runtimeId: 'electron-webcontents',
      verifiedAt: '2026-06-23T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toMatch(/password|cookie_value|token_value/i);
  });

  it('blocks expired, unverified, stale, and runtime-mismatched states', () => {
    expect(
      evaluateSiteLoginHealth({
        profileId: 'profile-1',
        site: 'github.com',
        state: { ...baseState, status: 'expired' },
      })
    ).toMatchObject({
      ok: false,
      status: 'expired',
      reasonCode: 'login_state_expired',
    });
    expect(
      evaluateSiteLoginHealth({
        profileId: 'profile-1',
        site: 'github.com',
        state: { ...baseState, verified: false, verifiedAt: null },
      })
    ).toMatchObject({
      ok: false,
      status: 'unverified',
      reasonCode: 'login_state_unverified',
    });
    expect(
      evaluateSiteLoginHealth({
        profileId: 'profile-1',
        site: 'github.com',
        requiredRuntimeId: 'chromium-cloak-playwright',
        state: baseState,
      })
    ).toMatchObject({
      ok: false,
      status: 'runtime_mismatch',
      reasonCode: 'runtime_mismatch',
    });
    expect(
      evaluateSiteLoginHealth({
        profileId: 'profile-1',
        site: 'github.com',
        state: baseState,
        now: new Date('2026-06-23T02:01:00.000Z'),
        maxVerifiedAgeMs: 60 * 60 * 1000,
      })
    ).toMatchObject({
      ok: false,
      status: 'expired',
      reasonCode: 'verification_stale',
    });
  });
});
