import { describe, expect, it } from 'vitest';
import type { Account, BrowserProfile } from '../../../../../types/profile';
import { getDefaultFingerprint } from '../../../../../constants/fingerprint-defaults';
import {
  buildSuggestedAutoProfileName,
  getRecommendedProfileBinding,
  getReusableProfileIdsForPlatform,
} from '../accountManagementShared';

function buildAccount(patch: Partial<Account>): Account {
  return {
    id: 'account-1',
    profileId: 'profile-1',
    platformId: 'site-1',
    name: '账号-1',
    loginUrl: 'https://example.com/login',
    tags: [],
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    ...patch,
  };
}

function buildProfile(patch: Partial<BrowserProfile>): BrowserProfile {
  return {
    id: 'profile-1',
    name: '环境-1',
    engine: 'electron',
    groupId: null,
    partition: 'persist:profile-1',
    proxy: null,
    fingerprint: getDefaultFingerprint(),
    notes: null,
    tags: [],
    color: null,
    status: 'idle',
    lastError: null,
    lastActiveAt: null,
    totalUses: 0,
    quota: 1,
    idleTimeoutMs: 60000,
    lockTimeoutMs: 30000,
    isSystem: false,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    ...patch,
  };
}

describe('accountManagementShared', () => {
  it('prefers the first reusable profile that is not occupied by the selected platform', () => {
    const result = getRecommendedProfileBinding({
      platformId: 'site-1',
      accounts: [
        buildAccount({
          profileId: 'profile-1',
        }),
        buildAccount({
          id: 'other-platform',
          platformId: 'site-2',
          profileId: 'profile-2',
        }),
      ],
      profiles: [
        buildProfile({ id: 'profile-1' }),
        buildProfile({ id: 'profile-2' }),
        buildProfile({ id: 'profile-3' }),
      ],
    });

    expect(result).toEqual({
      profileId: 'profile-2',
      mode: 'select',
      source: 'available-profile',
    });
  });

  it('keeps the preferred profile when it is still reusable for the selected platform', () => {
    const result = getRecommendedProfileBinding({
      platformId: 'site-1',
      accounts: [
        buildAccount({
          id: 'occupied',
          platformId: 'site-1',
          profileId: 'profile-1',
        }),
      ],
      profiles: [
        buildProfile({ id: 'profile-1' }),
        buildProfile({ id: 'profile-2' }),
        buildProfile({ id: 'profile-3' }),
      ],
      preferredProfileId: 'profile-3',
    });

    expect(result).toEqual({
      profileId: 'profile-3',
      mode: 'select',
      source: 'available-profile',
    });
  });

  it('falls back to auto-create when all profiles are already occupied by the selected platform', () => {
    const result = getRecommendedProfileBinding({
      platformId: 'site-2',
      accounts: [
        buildAccount({
          id: 'profile-1-account',
          platformId: 'site-2',
          profileId: 'profile-1',
        }),
        buildAccount({
          id: 'profile-2-account',
          platformId: 'site-2',
          profileId: 'profile-2',
        }),
      ],
      profiles: [buildProfile({ id: 'profile-1' }), buildProfile({ id: 'profile-2' })],
    });

    expect(result).toEqual({
      profileId: '',
      mode: 'auto-create',
      source: 'auto-create',
    });
  });

  it('returns all profiles as reusable before the platform is selected', () => {
    const result = getRecommendedProfileBinding({
      accounts: [
        buildAccount({
          id: 'occupied',
          platformId: 'site-1',
          profileId: 'profile-1',
        }),
      ],
      profiles: [buildProfile({ id: 'profile-2' }), buildProfile({ id: 'profile-1' })],
    });

    expect(result).toEqual({
      profileId: 'profile-2',
      mode: 'select',
      source: 'available-profile',
    });
  });

  it('ignores the current account when checking reusable profiles during edit', () => {
    const reusableProfileIds = getReusableProfileIdsForPlatform({
      platformId: 'site-1',
      accounts: [
        buildAccount({
          id: 'current-account',
          platformId: 'site-1',
          profileId: 'profile-1',
        }),
        buildAccount({
          id: 'other-account',
          platformId: 'site-1',
          profileId: 'profile-2',
        }),
      ],
      profiles: [buildProfile({ id: 'profile-1' }), buildProfile({ id: 'profile-2' })],
      excludeAccountId: 'current-account',
    });

    expect(reusableProfileIds).toEqual(['profile-1']);
  });

  it('builds a readable default auto-created profile name', () => {
    expect(buildSuggestedAutoProfileName('淘宝', '主账号', 'seller@example.com')).toBe(
      '淘宝-主账号-seller@example.com-环境'
    );
    expect(buildSuggestedAutoProfileName('', '', 'seller@example.com')).toBe(
      'seller@example.com-环境'
    );
  });
});
