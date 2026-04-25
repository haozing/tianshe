import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileList } from '../ProfileList';
import type { BrowserProfile } from '../../../../../types/profile';
import { getDefaultFingerprint } from '../../../../../constants/fingerprint-defaults';

const deleteProfile = vi.fn();
const loadProfiles = vi.fn();
const loadStats = vi.fn();

vi.mock('../../../stores/profileStore', () => ({
  useProfileStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      deleteProfile,
      loadProfiles,
      loadStats,
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

function buildProfile(patch: Partial<BrowserProfile> = {}): BrowserProfile {
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
    createdAt: new Date('2026-02-17T00:00:00.000Z'),
    updatedAt: new Date('2026-02-17T00:00:00.000Z'),
    ...patch,
  };
}

describe('ProfileList runtime refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).electronAPI = {
      profile: {
        poolLaunch: vi.fn().mockResolvedValue({ success: true, data: {} }),
        poolListBrowsers: vi.fn().mockResolvedValue({ success: true, data: [] }),
        poolShowBrowser: vi.fn().mockResolvedValue({ success: true, data: {} }),
      },
    };
  });

  it('calls parent refresh callback after launching a browser without directly reloading the store', async () => {
    const onProfileDataChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <ProfileList
        profiles={[buildProfile()]}
        viewMode="grid"
        isLoading={false}
        cloudEnabled={true}
        cloudActionProfileId={null}
        onPushCloud={vi.fn()}
        onDeleteCloud={vi.fn()}
        onEdit={vi.fn()}
        onProfileDataChanged={onProfileDataChanged}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '启动浏览器' }));

    await waitFor(() => {
      expect((window as any).electronAPI.profile.poolLaunch).toHaveBeenCalledTimes(1);
      expect(onProfileDataChanged).toHaveBeenCalledWith({ refreshRunning: true });
    });
    expect(loadProfiles).not.toHaveBeenCalled();
    expect(loadStats).not.toHaveBeenCalled();
  });

  it('calls parent refresh callback when fronting an existing extension browser', async () => {
    const onProfileDataChanged = vi.fn().mockResolvedValue(undefined);
    (window as any).electronAPI.profile.poolListBrowsers.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'browser-1',
          sessionId: 'profile-1',
          engine: 'extension',
          status: 'idle',
          lastAccessedAt: 1,
        },
      ],
    });

    render(
      <ProfileList
        profiles={[
          buildProfile({
            engine: 'extension',
            status: 'active',
          }),
        ]}
        viewMode="grid"
        isLoading={false}
        cloudEnabled={true}
        cloudActionProfileId={null}
        onPushCloud={vi.fn()}
        onDeleteCloud={vi.fn()}
        onEdit={vi.fn()}
        onProfileDataChanged={onProfileDataChanged}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '前置窗口' }));

    await waitFor(() => {
      expect((window as any).electronAPI.profile.poolShowBrowser).toHaveBeenCalledTimes(1);
      expect((window as any).electronAPI.profile.poolLaunch).not.toHaveBeenCalled();
      expect(onProfileDataChanged).toHaveBeenCalledWith({ refreshRunning: true });
    });
  });

  it('shows runtime-derived status labels instead of the legacy active label', async () => {
    (window as any).electronAPI.profile.poolListBrowsers.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'browser-1',
          sessionId: 'profile-1',
          engine: 'electron',
          status: 'idle',
          lastAccessedAt: 1,
        },
      ],
    });

    render(
      <ProfileList
        profiles={[
          buildProfile({
            status: 'active',
          }),
        ]}
        viewMode="grid"
        isLoading={false}
        cloudEnabled={true}
        cloudActionProfileId={null}
        onPushCloud={vi.fn()}
        onDeleteCloud={vi.fn()}
        onEdit={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('空闲实例')).toBeInTheDocument();
      expect(screen.queryByText('运行中')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '前置窗口' })).toBeInTheDocument();
    });
  });
});
