import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountCenterPage } from '../index';
import { useUIStore } from '../../../stores/uiStore';

const profileStoreState = {
  profiles: [
    {
      id: 'profile-1',
      name: '环境-1',
      status: 'idle',
      isSystem: false,
      color: '#3b82f6',
      totalUses: 0,
      createdAt: new Date('2026-02-17T00:00:00.000Z'),
      updatedAt: new Date('2026-02-17T00:00:00.000Z'),
      partition: 'persist:profile-1',
      fingerprint: {},
      quota: 1,
      idleTimeoutMs: 60000,
      lockTimeoutMs: 30000,
      engine: 'electron',
    },
  ],
  groups: [],
  selectedGroupId: null,
  loading: {
    profiles: false,
    groups: false,
    stats: false,
    mutation: false,
  },
  errors: {
    profiles: null,
    groups: null,
    stats: null,
    mutation: null,
  },
  isLoading: false,
  error: null,
  loadProfiles: vi.fn(),
  loadGroups: vi.fn(),
  loadStats: vi.fn(),
  clearError: vi.fn(),
};

const accountStoreState = {
  accounts: [{ id: 'acc-1' }],
  loading: {
    accounts: false,
    savedSites: false,
    tags: false,
    mutation: false,
    login: false,
  },
  errors: {
    accounts: null,
    savedSites: null,
    tags: null,
    mutation: null,
    login: null,
  },
  error: null,
  loadAllAccounts: vi.fn().mockResolvedValue(undefined),
  loadSavedSites: vi.fn().mockResolvedValue(undefined),
  loadTags: vi.fn().mockResolvedValue(undefined),
  clearError: vi.fn(),
};

const cloudAuthStoreState = {
  authState: 'logged_out',
  capabilities: null,
  activeScope: null,
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
    UNGROUPED_GROUP_ID: 'ungrouped',
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

vi.mock('../ProfileGroupTree', () => ({
  ProfileGroupTree: () => <div data-testid="profile-group-tree">ProfileGroupTree</div>,
}));

vi.mock('../ProfileList', () => ({
  ProfileList: (props: {
    onProfileDataChanged?: (options?: { refreshRunning?: boolean }) => void;
    onProfileMutationApplied?: () => void;
  }) => (
    <div data-testid="profile-list">
      ProfileList
      <button type="button" onClick={() => props.onProfileDataChanged?.({ refreshRunning: true })}>
        Trigger Profile Refresh
      </button>
      <button type="button" onClick={() => props.onProfileMutationApplied?.()}>
        Trigger Mutation
      </button>
    </div>
  ),
}));

vi.mock('../RunningBrowsersPanel', () => ({
  RunningBrowsersPanel: (props: { onChanged?: () => void }) => (
    <div data-testid="running-panel">
      RunningBrowsersPanel
      <button type="button" onClick={() => props.onChanged?.()}>
        Trigger Running Refresh
      </button>
    </div>
  ),
}));

vi.mock('../AccountManagementPanel', () => ({
  AccountManagementPanel: () => <div data-testid="account-panel">AccountManagementPanel</div>,
}));

vi.mock('../ProfileFormDialog', () => ({
  ProfileFormDialog: () => null,
}));

vi.mock('../ExtensionPackagesPanel', () => ({
  ExtensionPackagesPanel: (props: {
    onProfileDataChanged?: (options?: { refreshRunning?: boolean }) => void;
  }) => (
    <div data-testid="extensions-panel">
      ExtensionPackagesPanel
      <button type="button" onClick={() => props.onProfileDataChanged?.({ refreshRunning: true })}>
        Trigger Extension Refresh
      </button>
    </div>
  ),
}));

function openMoreMenu() {
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
}

function chooseMoreMenuItem(label: string) {
  openMoreMenu();
  fireEvent.click(screen.getByText(label));
}

describe('AccountCenterPage tab smoke test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileStoreState.error = null;
    profileStoreState.errors.profiles = null;
    profileStoreState.errors.groups = null;
    profileStoreState.errors.stats = null;
    accountStoreState.error = null;
    accountStoreState.errors.accounts = null;
    accountStoreState.errors.savedSites = null;
    accountStoreState.errors.tags = null;
    profileStoreState.loadProfiles.mockResolvedValue(undefined);
    profileStoreState.loadGroups.mockResolvedValue(undefined);
    profileStoreState.loadStats.mockResolvedValue(undefined);
    accountStoreState.loadAllAccounts.mockResolvedValue(undefined);
    accountStoreState.loadSavedSites.mockResolvedValue(undefined);
    accountStoreState.loadTags.mockResolvedValue(undefined);
    useUIStore.setState({
      activeView: 'accountCenter',
      accountCenterTab: 'accounts',
      activePluginView: null,
    });
  });

  it('keeps account as the primary module and exposes other views in 更多菜单', async () => {
    render(<AccountCenterPage />);

    expect(screen.getByRole('heading', { name: '账号中心' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更多' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增账号' })).toBeInTheDocument();

    openMoreMenu();
    expect(screen.getByText('账号视图')).toBeInTheDocument();
    expect(screen.getByText('环境配置')).toBeInTheDocument();
    expect(screen.getByText('扩展中心')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('account-panel')).toBeInTheDocument();
      expect(accountStoreState.loadAllAccounts).toHaveBeenCalledTimes(1);
      expect(accountStoreState.loadSavedSites).toHaveBeenCalledTimes(1);
      expect(accountStoreState.loadTags).toHaveBeenCalledTimes(1);
      expect(profileStoreState.loadProfiles).not.toHaveBeenCalled();
    });
  });

  it('switches between extensions, running, and profile views', async () => {
    render(<AccountCenterPage />);
    await waitFor(() => expect(accountStoreState.loadAllAccounts).toHaveBeenCalledTimes(1));

    chooseMoreMenuItem('扩展中心');
    await waitFor(() => {
      expect(screen.getByTestId('extensions-panel')).toBeInTheDocument();
      expect(profileStoreState.loadProfiles).toHaveBeenCalledTimes(1);
    });

    chooseMoreMenuItem('运行中');
    await waitFor(() => {
      expect(screen.getByTestId('running-panel')).toBeInTheDocument();
      expect(profileStoreState.loadGroups).toHaveBeenCalledTimes(1);
      expect(profileStoreState.loadStats).toHaveBeenCalledTimes(1);
    });

    chooseMoreMenuItem('环境配置');
    await waitFor(() => {
      expect(screen.getByTestId('profile-list')).toBeInTheDocument();
    });
  });

  it('persists tab selection in the ui store', async () => {
    render(<AccountCenterPage />);
    await waitFor(() => expect(accountStoreState.loadAllAccounts).toHaveBeenCalledTimes(1));

    chooseMoreMenuItem('运行中');
    await waitFor(() => expect(useUIStore.getState().accountCenterTab).toBe('running'));

    chooseMoreMenuItem('扩展中心');
    await waitFor(() => expect(useUIStore.getState().accountCenterTab).toBe('extensions'));
  });

  it('routes child refresh requests through the page-level coordinator', async () => {
    render(<AccountCenterPage />);
    await waitFor(() => expect(accountStoreState.loadAllAccounts).toHaveBeenCalledTimes(1));

    chooseMoreMenuItem('环境配置');
    await waitFor(() => expect(profileStoreState.loadProfiles).toHaveBeenCalledTimes(1));

    profileStoreState.loadProfiles.mockClear();
    profileStoreState.loadStats.mockClear();
    profileStoreState.loadGroups.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Trigger Profile Refresh' }));
    await waitFor(() => {
      expect(profileStoreState.loadProfiles).toHaveBeenCalledTimes(1);
      expect(profileStoreState.loadStats).toHaveBeenCalledTimes(1);
      expect(profileStoreState.loadGroups).not.toHaveBeenCalled();
    });

    chooseMoreMenuItem('扩展中心');
    await waitFor(() => expect(screen.getByTestId('extensions-panel')).toBeInTheDocument());

    profileStoreState.loadProfiles.mockClear();
    profileStoreState.loadStats.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Trigger Extension Refresh' }));
    await waitFor(() => {
      expect(profileStoreState.loadProfiles).toHaveBeenCalledTimes(1);
      expect(profileStoreState.loadStats).toHaveBeenCalledTimes(1);
    });

    chooseMoreMenuItem('运行中');
    await waitFor(() => expect(screen.getByTestId('running-panel')).toBeInTheDocument());

    profileStoreState.loadProfiles.mockClear();
    profileStoreState.loadStats.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Trigger Running Refresh' }));
    await waitFor(() => {
      expect(profileStoreState.loadProfiles).toHaveBeenCalledTimes(1);
      expect(profileStoreState.loadStats).toHaveBeenCalledTimes(1);
    });
  });

  it('revisiting a tab refetches fresh data instead of relying on a one-time cache', async () => {
    render(<AccountCenterPage />);
    await waitFor(() => expect(accountStoreState.loadAllAccounts).toHaveBeenCalledTimes(1));

    chooseMoreMenuItem('环境配置');
    await waitFor(() => expect(profileStoreState.loadProfiles).toHaveBeenCalledTimes(1));

    accountStoreState.loadAllAccounts.mockClear();
    accountStoreState.loadSavedSites.mockClear();
    accountStoreState.loadTags.mockClear();

    chooseMoreMenuItem('账号视图');
    await waitFor(() => {
      expect(accountStoreState.loadAllAccounts).toHaveBeenCalledTimes(1);
      expect(accountStoreState.loadSavedSites).toHaveBeenCalledTimes(1);
      expect(accountStoreState.loadTags).toHaveBeenCalledTimes(1);
    });
  });

  it('profile mutations refresh both profile and account domains', async () => {
    render(<AccountCenterPage />);
    await waitFor(() => expect(accountStoreState.loadAllAccounts).toHaveBeenCalledTimes(1));

    chooseMoreMenuItem('环境配置');
    await waitFor(() => expect(profileStoreState.loadProfiles).toHaveBeenCalledTimes(1));

    profileStoreState.loadProfiles.mockClear();
    profileStoreState.loadGroups.mockClear();
    profileStoreState.loadStats.mockClear();
    accountStoreState.loadAllAccounts.mockClear();
    accountStoreState.loadSavedSites.mockClear();
    accountStoreState.loadTags.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Trigger Mutation' }));
    await waitFor(() => {
      expect(profileStoreState.loadProfiles).toHaveBeenCalledTimes(1);
      expect(profileStoreState.loadGroups).toHaveBeenCalledTimes(1);
      expect(profileStoreState.loadStats).toHaveBeenCalledTimes(1);
      expect(accountStoreState.loadAllAccounts).toHaveBeenCalledTimes(1);
      expect(accountStoreState.loadSavedSites).toHaveBeenCalledTimes(1);
      expect(accountStoreState.loadTags).toHaveBeenCalledTimes(1);
    });
  });
});
