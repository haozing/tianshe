import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfileStore } from '../profileStore';

const mockProfileDelete = vi.fn();
const mockProfileGetStats = vi.fn();

const resetProfileStoreState = () => {
  useProfileStore.setState({
    profiles: [],
    groups: [],
    selectedGroupId: null,
    selectedProfileId: null,
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
    stats: null,
  });
};

describe('profileStore delete profile behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProfileStoreState();

    mockProfileDelete.mockResolvedValue({ success: true });
    mockProfileGetStats.mockResolvedValue({
      success: true,
      data: {
        total: 0,
        idle: 0,
        active: 0,
        error: 0,
      },
    });

    (globalThis as any).window = {
      electronAPI: {
        profile: {
          delete: mockProfileDelete,
          getStats: mockProfileGetStats,
        },
      },
    };
  });

  it('deletes profile without requiring syncEngine API', async () => {
    const result = await useProfileStore.getState().deleteProfile('profile-1');
    expect(result).toBe(true);
    expect(mockProfileDelete).toHaveBeenCalledWith('profile-1');
    expect(mockProfileGetStats).toHaveBeenCalledTimes(1);
  });

  it('keeps delete successful when stats reload fails', async () => {
    mockProfileGetStats.mockResolvedValue({
      success: false,
      error: 'stats unavailable',
    });
    const result = await useProfileStore.getState().deleteProfile('profile-2');
    expect(result).toBe(true);
    expect(mockProfileGetStats).toHaveBeenCalledTimes(1);
  });

  it('returns false when delete profile fails', async () => {
    mockProfileDelete.mockResolvedValue({
      success: false,
      error: 'delete failed',
    });
    const result = await useProfileStore.getState().deleteProfile('profile-3');
    expect(result).toBe(false);
  });
});
