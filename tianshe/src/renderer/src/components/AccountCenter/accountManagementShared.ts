import type { Account, BrowserProfile } from '../../../../types/profile';
import { UNBOUND_PROFILE_ID } from '../../../../types/profile';

export type ProfileBindingMode = 'select' | 'auto-create';

export interface AccountFormState {
  platformId: string;
  profileId: string;
  profileBindingMode: ProfileBindingMode;
  autoProfileName: string;
  displayName: string;
  accountName: string;
  password: string;
  tabUrl: string;
  tagsText: string;
  notes: string;
}

export const INITIAL_FORM_STATE: AccountFormState = {
  platformId: '',
  profileId: '',
  profileBindingMode: 'auto-create',
  autoProfileName: '',
  displayName: '',
  accountName: '',
  password: '',
  tabUrl: '',
  tagsText: '',
  notes: '',
};

export function normalizeTags(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeBoundProfileId(raw: string | null | undefined): string {
  const normalized = String(raw || '').trim();
  if (!normalized || normalized === UNBOUND_PROFILE_ID) return '';
  return normalized;
}

export function isCloudSyncManagedByAnotherUser(params: {
  syncManaged?: boolean;
  syncOwnerUserId?: number | null;
  currentUserId?: number | null;
}): boolean {
  if (params.syncManaged !== true) return false;
  const ownerUserId = Number(params.syncOwnerUserId);
  const currentUserId = Number(params.currentUserId);
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) return false;
  if (!Number.isFinite(currentUserId) || currentUserId <= 0) return false;
  return Math.trunc(ownerUserId) !== Math.trunc(currentUserId);
}

export function isAccountReadOnlyForCloudUser(
  account: Pick<Account, 'syncPermission' | 'syncManaged' | 'syncOwnerUserId'>,
  currentUserId?: number | null
): boolean {
  return (
    account.syncPermission === 'shared/view_use' ||
    isCloudSyncManagedByAnotherUser({
      syncManaged: account.syncManaged,
      syncOwnerUserId: account.syncOwnerUserId,
      currentUserId,
    })
  );
}

export type RecommendedProfileSource = 'available-profile' | 'auto-create';

export interface RecommendedProfileBinding {
  profileId: string;
  mode: ProfileBindingMode;
  source: RecommendedProfileSource;
}

export function getRecommendedProfileBinding(params: {
  platformId?: string | null;
  accounts: Pick<Account, 'id' | 'platformId' | 'profileId'>[];
  profiles: Pick<BrowserProfile, 'id'>[];
  preferredProfileId?: string | null;
  excludeAccountId?: string | null;
}): RecommendedProfileBinding {
  const orderedProfileIds = Array.from(
    new Set(params.profiles.map((profile) => String(profile.id || '').trim()).filter(Boolean))
  );
  const preferredProfileId = normalizeBoundProfileId(params.preferredProfileId);
  const platformId = String(params.platformId || '').trim();
  if (orderedProfileIds.length === 0) {
    return {
      profileId: '',
      mode: 'auto-create',
      source: 'auto-create',
    };
  }

  if (!platformId) {
    return {
      profileId:
        (preferredProfileId && orderedProfileIds.includes(preferredProfileId)
          ? preferredProfileId
          : orderedProfileIds[0]) || '',
      mode: 'select',
      source: 'available-profile',
    };
  }

  const reusableProfileIds = getReusableProfileIdsForPlatform({
    platformId,
    accounts: params.accounts,
    profiles: params.profiles,
    excludeAccountId: params.excludeAccountId,
  });

  if (reusableProfileIds.length > 0) {
    return {
      profileId:
        (preferredProfileId && reusableProfileIds.includes(preferredProfileId)
          ? preferredProfileId
          : reusableProfileIds[0]) || '',
      mode: 'select',
      source: 'available-profile',
    };
  }

  return {
    profileId: '',
    mode: 'auto-create',
    source: 'auto-create',
  };
}

export function getReusableProfileIdsForPlatform(params: {
  platformId?: string | null;
  accounts: Pick<Account, 'id' | 'platformId' | 'profileId'>[];
  profiles: Pick<BrowserProfile, 'id'>[];
  excludeAccountId?: string | null;
}): string[] {
  const platformId = String(params.platformId || '').trim();
  const excludeAccountId = String(params.excludeAccountId || '').trim();
  const orderedProfileIds = Array.from(
    new Set(params.profiles.map((profile) => String(profile.id || '').trim()).filter(Boolean))
  );

  if (orderedProfileIds.length === 0) {
    return [];
  }

  if (!platformId) {
    return orderedProfileIds;
  }

  const validProfileIds = new Set(orderedProfileIds);
  const occupiedProfileIds = new Set(
    params.accounts
      .filter((account) => {
        const accountId = String(account.id || '').trim();
        return !excludeAccountId || accountId !== excludeAccountId;
      })
      .filter((account) => String(account.platformId || '').trim() === platformId)
      .map((account) => normalizeBoundProfileId(account.profileId))
      .filter((profileId) => profileId.length > 0 && validProfileIds.has(profileId))
  );

  return orderedProfileIds.filter((profileId) => !occupiedProfileIds.has(profileId));
}

export function buildSuggestedAutoProfileName(
  platformName?: string | null,
  displayName?: string,
  accountName?: string
) {
  const normalizedPlatformName = String(platformName || '').trim();
  const normalizedDisplayName = String(displayName || '').trim();
  const normalizedAccountName = String(accountName || '').trim();
  const baseName =
    [normalizedPlatformName, normalizedDisplayName, normalizedAccountName].filter(Boolean).join('-') ||
    normalizedDisplayName ||
    normalizedAccountName ||
    normalizedPlatformName ||
    '账号';
  return `${baseName}-环境`;
}
