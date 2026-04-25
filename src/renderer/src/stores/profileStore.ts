/**
 * Profile Store
 * v2 architecture: Profile-first state management.
 */

import { create } from 'zustand';
import type {
  BrowserProfile,
  ProfileGroup,
  CreateProfileParams,
  UpdateProfileParams,
  CreateGroupParams,
  UpdateGroupParams,
} from '../../../types/profile';

export const UNGROUPED_GROUP_ID = '__ungrouped__';

type ProfileLoadingState = {
  profiles: boolean;
  groups: boolean;
  stats: boolean;
  mutation: boolean;
};

type ProfileErrorState = {
  profiles: string | null;
  groups: string | null;
  stats: string | null;
  mutation: string | null;
};

interface ProfileStore {
  // === State ===
  profiles: BrowserProfile[];
  groups: ProfileGroup[];
  selectedGroupId: string | null;
  selectedProfileId: string | null;
  loading: ProfileLoadingState;
  errors: ProfileErrorState;
  isLoading: boolean;
  error: string | null;

  // 统计
  stats: {
    total: number;
    idle: number;
    active: number;
    error: number;
  } | null;

  // === Profile 操作 ===
  loadProfiles: () => Promise<void>;
  createProfile: (params: CreateProfileParams) => Promise<BrowserProfile | null>;
  updateProfile: (id: string, params: UpdateProfileParams) => Promise<BrowserProfile | null>;
  deleteProfile: (id: string) => Promise<boolean>;
  selectProfile: (id: string | null) => void;

  // === Group 操作 ===
  loadGroups: () => Promise<void>;
  createGroup: (params: CreateGroupParams) => Promise<ProfileGroup | null>;
  updateGroup: (id: string, params: UpdateGroupParams) => Promise<ProfileGroup | null>;
  deleteGroup: (id: string, recursive?: boolean) => Promise<boolean>;
  selectGroup: (id: string | null) => void;

  // === 统计 ===
  loadStats: () => Promise<void>;

  // === 辅助 ===
  clearError: () => void;
}

const defaultLoadingState = (): ProfileLoadingState => ({
  profiles: false,
  groups: false,
  stats: false,
  mutation: false,
});

const defaultErrorState = (): ProfileErrorState => ({
  profiles: null,
  groups: null,
  stats: null,
  mutation: null,
});

function deriveProfileMeta(loading: ProfileLoadingState, errors: ProfileErrorState) {
  return {
    isLoading: Object.values(loading).some(Boolean),
    error: errors.mutation || errors.profiles || errors.groups || errors.stats || null,
  };
}

type ProfileStorePatch = {
  loading?: Partial<ProfileLoadingState>;
  errors?: Partial<ProfileErrorState>;
  profiles?: BrowserProfile[];
  groups?: ProfileGroup[];
  selectedGroupId?: string | null;
  selectedProfileId?: string | null;
  stats?: ProfileStore['stats'];
};

type ProfileStoreSetter = (
  partial: Partial<ProfileStore> | ((state: ProfileStore) => Partial<ProfileStore>)
) => void;

function applyProfilePatch(
  set: ProfileStoreSetter,
  patch: ProfileStorePatch
) {
  set((state) => {
    const loading = patch.loading ? { ...state.loading, ...patch.loading } : state.loading;
    const errors = patch.errors ? { ...state.errors, ...patch.errors } : state.errors;
    const { loading: _loading, errors: _errors, ...rest } = patch;
    return {
      ...rest,
      loading,
      errors,
      ...deriveProfileMeta(loading, errors),
    };
  });
}

export const useProfileStore = create<ProfileStore>((set, get) => ({
  // === Initial State ===
  profiles: [],
  groups: [],
  selectedGroupId: null,
  selectedProfileId: null,
  loading: defaultLoadingState(),
  errors: defaultErrorState(),
  ...deriveProfileMeta(defaultLoadingState(), defaultErrorState()),
  stats: null,

  // === Profile 操作 ===

  loadProfiles: async () => {
    applyProfilePatch(set, { loading: { profiles: true }, errors: { profiles: null } });
    try {
      const result = await window.electronAPI.profile.list();
      if (result.success && result.data) {
        applyProfilePatch(set, {
          profiles: result.data,
          loading: { profiles: false },
        });
      } else {
        applyProfilePatch(set, {
          loading: { profiles: false },
          errors: { profiles: result.error || '加载配置列表失败' },
        });
      }
    } catch (err) {
      applyProfilePatch(set, {
        loading: { profiles: false },
        errors: { profiles: err instanceof Error ? err.message : '加载失败' },
      });
    }
  },

  createProfile: async (params) => {
    applyProfilePatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.profile.create(params);
      if (result.success && result.data) {
        await Promise.allSettled([get().loadProfiles(), get().loadStats()]);
        applyProfilePatch(set, { loading: { mutation: false } });
        return result.data;
      }

      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '创建配置失败' },
      });
      return null;
    } catch (err) {
      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '创建失败' },
      });
      return null;
    }
  },

  updateProfile: async (id, params) => {
    applyProfilePatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.profile.update(id, params);
      if (result.success && result.data) {
        const updatedProfile = result.data;
        applyProfilePatch(set, {
          profiles: get().profiles.map((profile) => (profile.id === id ? updatedProfile : profile)),
          loading: { mutation: false },
        });
        return updatedProfile;
      }

      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '更新配置失败' },
      });
      return null;
    } catch (err) {
      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '更新失败' },
      });
      return null;
    }
  },

  deleteProfile: async (id) => {
    applyProfilePatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.profile.delete(id);
      if (result.success) {
        applyProfilePatch(set, {
          profiles: get().profiles.filter((profile) => profile.id !== id),
          selectedProfileId: get().selectedProfileId === id ? null : get().selectedProfileId,
        });
        await get().loadStats();
        applyProfilePatch(set, { loading: { mutation: false } });
        return true;
      }

      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || 'Failed to delete profile' },
      });
      return false;
    } catch (err) {
      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : 'Delete profile failed' },
      });
      return false;
    }
  },

  selectProfile: (id) => {
    applyProfilePatch(set, { selectedProfileId: id });
  },

  // === Group 操作 ===

  loadGroups: async () => {
    applyProfilePatch(set, { loading: { groups: true }, errors: { groups: null } });
    try {
      const result = await window.electronAPI.profileGroup.listTree();
      if (result.success && result.data) {
        applyProfilePatch(set, {
          groups: result.data,
          loading: { groups: false },
        });
      } else {
        applyProfilePatch(set, {
          loading: { groups: false },
          errors: { groups: result.error || '加载分组失败' },
        });
      }
    } catch (err) {
      applyProfilePatch(set, {
        loading: { groups: false },
        errors: { groups: err instanceof Error ? err.message : '加载失败' },
      });
    }
  },

  createGroup: async (params) => {
    applyProfilePatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.profileGroup.create(params);
      if (result.success && result.data) {
        await get().loadGroups();
        applyProfilePatch(set, { loading: { mutation: false } });
        return result.data;
      }

      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '创建分组失败' },
      });
      return null;
    } catch (err) {
      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '创建失败' },
      });
      return null;
    }
  },

  updateGroup: async (id, params) => {
    applyProfilePatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.profileGroup.update(id, params);
      if (result.success && result.data) {
        await get().loadGroups();
        applyProfilePatch(set, { loading: { mutation: false } });
        return result.data;
      }

      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '更新分组失败' },
      });
      return null;
    } catch (err) {
      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '更新失败' },
      });
      return null;
    }
  },

  deleteGroup: async (id, recursive) => {
    applyProfilePatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.profileGroup.delete(id, recursive);
      if (result.success) {
        applyProfilePatch(set, {
          selectedGroupId: get().selectedGroupId === id ? null : get().selectedGroupId,
        });
        await get().loadGroups();
        applyProfilePatch(set, { loading: { mutation: false } });
        return true;
      }

      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || 'Failed to delete group' },
      });
      return false;
    } catch (err) {
      applyProfilePatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : 'Delete group failed' },
      });
      return false;
    }
  },

  selectGroup: (id) => {
    applyProfilePatch(set, { selectedGroupId: id, selectedProfileId: null });
  },

  // === 统计 ===

  loadStats: async () => {
    applyProfilePatch(set, { loading: { stats: true }, errors: { stats: null } });
    try {
      const result = await window.electronAPI.profile.getStats();
      if (result.success && result.data) {
        applyProfilePatch(set, {
          stats: result.data,
          loading: { stats: false },
        });
      } else {
        applyProfilePatch(set, {
          loading: { stats: false },
          errors: { stats: result.error || '加载环境统计失败' },
        });
      }
    } catch (err) {
      console.error('[ProfileStore] Failed to load profile stats:', err);
      applyProfilePatch(set, {
        loading: { stats: false },
        errors: { stats: err instanceof Error ? err.message : '加载环境统计失败' },
      });
    }
  },

  // === 辅助 ===

  clearError: () => {
    applyProfilePatch(set, { errors: defaultErrorState() });
  },
}));
