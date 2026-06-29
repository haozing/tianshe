import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountCenterCoordinator } from '../useAccountCenterCoordinator';

const ACCOUNT_BUNDLE_CONFLICT_MESSAGE =
  '账号云端数据已被其他设备更新，已停止自动覆盖。请刷新后确认是否使用本地改动覆盖云端。';

const profileStoreState = {
  loadGroups: vi.fn().mockResolvedValue(undefined),
  loadProfiles: vi.fn().mockResolvedValue(undefined),
  loadStats: vi.fn().mockResolvedValue(undefined),
  clearError: vi.fn(),
  loading: {
    profiles: false,
    groups: false,
    stats: false,
    mutation: false,
  },
  error: null,
};

const accountStoreState = {
  loadAllAccounts: vi.fn().mockResolvedValue(undefined),
  loadSavedSites: vi.fn().mockResolvedValue(undefined),
  loadTags: vi.fn().mockResolvedValue(undefined),
  clearError: vi.fn(),
  loading: {
    accounts: false,
    savedSites: false,
    tags: false,
    mutation: false,
    login: false,
  },
  error: null,
};

const cloudAuthStoreState = {
  authState: 'ready',
  capabilities: {
    profile: { view: true, cache: true, edit: true, delete: true },
    account: { view: true, cache: true, edit: true, delete: true },
    scopes: [],
  },
  activeScope: { scopeType: 'company', scopeId: 0 },
};

vi.mock('../../../stores/profileStore', () => {
  const useProfileStore = Object.assign(
    vi.fn((selector?: (state: typeof profileStoreState) => unknown) =>
      selector ? selector(profileStoreState) : profileStoreState
    ),
    {
      getState: () => profileStoreState,
    }
  );
  return {
    useProfileStore,
  };
});

vi.mock('../../../stores/accountStore', () => {
  const useAccountStore = Object.assign(
    vi.fn((selector?: (state: typeof accountStoreState) => unknown) =>
      selector ? selector(accountStoreState) : accountStoreState
    ),
    {
      getState: () => accountStoreState,
    }
  );
  return {
    useAccountStore,
  };
});

vi.mock('../../../stores/cloudAuthStore', () => {
  const useCloudAuthStore = Object.assign(
    vi.fn((selector?: (state: typeof cloudAuthStoreState) => unknown) =>
      selector ? selector(cloudAuthStoreState) : cloudAuthStoreState
    ),
    {
      getState: () => cloudAuthStoreState,
    }
  );
  return {
    useCloudAuthStore,
  };
});

vi.mock('../../../lib/edition', () => ({
  isCloudSnapshotAvailable: () => true,
}));

describe('useAccountCenterCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    profileStoreState.error = null;
    accountStoreState.error = null;
    cloudAuthStoreState.authState = 'ready';
    cloudAuthStoreState.capabilities = {
      profile: { view: true, cache: true, edit: true, delete: true },
      account: { view: true, cache: true, edit: true, delete: true },
      scopes: [],
    };
    cloudAuthStoreState.activeScope = { scopeType: 'company', scopeId: 0 };
    (window as any).electronAPI = {
      cloudSnapshot: {
        pushAccountBundle: vi.fn().mockResolvedValue({
          success: true,
          data: {
            snapshotUid: 'snapshot-1',
            schemaVersion: 5,
            version: 2,
            created: false,
            accountCount: 1,
            siteCount: 1,
            tagCount: 1,
          },
        }),
        pullAccountBundle: vi.fn().mockResolvedValue({
          success: true,
          data: {
            snapshotUid: 'snapshot-1',
            schemaVersion: 5,
            version: 2,
            accountCount: 1,
            siteCount: 1,
            tagCount: 1,
            unresolvedProfileRefs: [],
            applied: true,
          },
        }),
        listMine: vi.fn(),
        listPublic: vi.fn(),
        pullProfile: vi.fn(),
        pushProfile: vi.fn(),
        deleteCloudProfile: vi.fn(),
      },
    };
    (window as any).confirm = vi.fn(() => true);
  });

  it('pushes then pulls after owned account mutations and clears dirty state', async () => {
    const cloudSyncAPI = (window as any).electronAPI.cloudSnapshot;
    const { result } = renderHook(() => useAccountCenterCoordinator({ activeTab: 'accounts' }));

    await waitFor(() => expect(accountStoreState.loadAllAccounts).toHaveBeenCalled());
    accountStoreState.loadAllAccounts.mockClear();
    accountStoreState.loadSavedSites.mockClear();
    accountStoreState.loadTags.mockClear();
    cloudSyncAPI.pushAccountBundle.mockClear();
    cloudSyncAPI.pullAccountBundle.mockClear();

    await act(async () => {
      await result.current.notifyAccountBundleDirty();
    });

    expect(cloudSyncAPI.pushAccountBundle).toHaveBeenCalledTimes(1);
    expect(cloudSyncAPI.pullAccountBundle).toHaveBeenCalledTimes(1);
    expect(cloudSyncAPI.pushAccountBundle.mock.invocationCallOrder[0]).toBeLessThan(
      cloudSyncAPI.pullAccountBundle.mock.invocationCallOrder[0]
    );
    expect(accountStoreState.loadAllAccounts).toHaveBeenCalledTimes(1);
    expect(accountStoreState.loadSavedSites).toHaveBeenCalledTimes(1);
    expect(accountStoreState.loadTags).toHaveBeenCalledTimes(1);
    expect(result.current.accountBundleDirty).toBe(false);
  });

  it('falls back to local refresh when account sync capability is unavailable', async () => {
    const cloudSyncAPI = (window as any).electronAPI.cloudSnapshot;
    cloudAuthStoreState.capabilities = {
      profile: { view: true, cache: true, edit: true, delete: true },
      account: { view: true, cache: false, edit: false, delete: false },
      scopes: [],
    };

    const { result } = renderHook(() => useAccountCenterCoordinator({ activeTab: 'accounts' }));

    await waitFor(() => expect(accountStoreState.loadAllAccounts).toHaveBeenCalled());
    accountStoreState.loadAllAccounts.mockClear();
    accountStoreState.loadSavedSites.mockClear();
    accountStoreState.loadTags.mockClear();
    cloudSyncAPI.pushAccountBundle.mockClear();
    cloudSyncAPI.pullAccountBundle.mockClear();

    await act(async () => {
      await result.current.notifyAccountBundleDirty();
    });

    expect(cloudSyncAPI.pushAccountBundle).not.toHaveBeenCalled();
    expect(cloudSyncAPI.pullAccountBundle).not.toHaveBeenCalled();
    expect(accountStoreState.loadAllAccounts).toHaveBeenCalledTimes(1);
    expect(accountStoreState.loadSavedSites).toHaveBeenCalledTimes(1);
    expect(accountStoreState.loadTags).toHaveBeenCalledTimes(1);
    expect(result.current.accountBundleDirty).toBe(true);
  });

  it('stops automatic account overwrite when cloud bundle conflicts', async () => {
    const cloudSyncAPI = (window as any).electronAPI.cloudSnapshot;
    cloudSyncAPI.pushAccountBundle.mockResolvedValue({
      success: false,
      error: ACCOUNT_BUNDLE_CONFLICT_MESSAGE,
    });

    const { result } = renderHook(() => useAccountCenterCoordinator({ activeTab: 'accounts' }));

    await waitFor(() => expect(accountStoreState.loadAllAccounts).toHaveBeenCalled());
    accountStoreState.loadAllAccounts.mockClear();
    accountStoreState.loadSavedSites.mockClear();
    accountStoreState.loadTags.mockClear();
    cloudSyncAPI.pushAccountBundle.mockClear();
    cloudSyncAPI.pullAccountBundle.mockClear();

    await act(async () => {
      await result.current.notifyAccountBundleDirty();
    });

    expect(cloudSyncAPI.pushAccountBundle).toHaveBeenCalledTimes(1);
    expect(cloudSyncAPI.pushAccountBundle).toHaveBeenCalledWith({
      onConflict: 'error',
    });
    expect(cloudSyncAPI.pullAccountBundle).not.toHaveBeenCalled();
    expect((window as any).confirm).not.toHaveBeenCalled();
    expect(result.current.accountBundleDirty).toBe(true);
    expect(result.current.accountCenterError).toContain('已停止自动覆盖');
  });

  it('allows manual refresh to overwrite only after explicit confirmation', async () => {
    const cloudSyncAPI = (window as any).electronAPI.cloudSnapshot;
    cloudSyncAPI.pushAccountBundle.mockImplementation(
      async (options?: { onConflict?: 'error' | 'overwrite' }) => {
        if (options?.onConflict === 'overwrite') {
          return {
            success: true,
            data: {
              snapshotUid: 'snapshot-overwrite',
              schemaVersion: 5,
              version: 3,
              created: false,
              accountCount: 1,
              siteCount: 1,
              tagCount: 1,
              conflictResolved: true,
            },
          };
        }
        return {
          success: false,
          error: ACCOUNT_BUNDLE_CONFLICT_MESSAGE,
        };
      }
    );

    const { result } = renderHook(() => useAccountCenterCoordinator({ activeTab: 'accounts' }));

    await waitFor(() => expect(accountStoreState.loadAllAccounts).toHaveBeenCalled());
    accountStoreState.loadAllAccounts.mockClear();
    accountStoreState.loadSavedSites.mockClear();
    accountStoreState.loadTags.mockClear();
    cloudSyncAPI.pushAccountBundle.mockClear();
    cloudSyncAPI.pullAccountBundle.mockClear();

    await act(async () => {
      await result.current.notifyAccountBundleDirty();
    });

    expect(result.current.accountBundleDirty).toBe(true);

    await act(async () => {
      result.current.handleRefresh();
    });

    await waitFor(() => expect((window as any).confirm).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(cloudSyncAPI.pushAccountBundle.mock.calls.map((call: unknown[]) => call[0])).toEqual([
        { onConflict: 'error' },
        { onConflict: 'error' },
        { onConflict: 'overwrite' },
      ])
    );
    expect(cloudSyncAPI.pullAccountBundle).toHaveBeenCalledTimes(1);
    expect(result.current.accountBundleDirty).toBe(false);
  });

  it('does not start periodic account sync in the snapshot-only flow', async () => {
    vi.useFakeTimers();
    cloudAuthStoreState.authState = 'logged_out';

    try {
      renderHook(
        ({ activeTab }: { activeTab: 'accounts' | 'profiles' }) =>
          useAccountCenterCoordinator({ activeTab }),
        {
          initialProps: { activeTab: 'profiles' as const },
        }
      );

      accountStoreState.loadAllAccounts.mockClear();
      accountStoreState.loadSavedSites.mockClear();
      accountStoreState.loadTags.mockClear();

      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(accountStoreState.loadAllAccounts).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
