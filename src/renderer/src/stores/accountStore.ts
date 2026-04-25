/**
 * Account Store - 账号状态管理
 * v2 架构：账号管理功能
 */

import { create } from 'zustand';
import type {
  Account,
  SavedSite,
  Tag,
  CreateAccountParams,
  CreateAccountWithAutoProfileParams,
  UpdateAccountParams,
  CreateSavedSiteParams,
  UpdateSavedSiteParams,
  CreateTagParams,
  UpdateTagParams,
} from '../../../types/profile';

// === 分类类型定义 ===
export type CategoryMode = 'site' | 'tag';

export interface CategoryItem {
  id: string;
  name: string;
  icon?: string;
  count: number;
  // 按标签时存储 tag
  tag?: string;
}

type AccountLoadingState = {
  accounts: boolean;
  savedSites: boolean;
  tags: boolean;
  mutation: boolean;
  login: boolean;
};

type AccountErrorState = {
  accounts: string | null;
  savedSites: string | null;
  tags: string | null;
  mutation: string | null;
  login: string | null;
};

interface AccountStore {
  // === 状态 ===
  accounts: Account[];
  savedSites: SavedSite[];
  tags: Tag[];
  loading: AccountLoadingState;
  errors: AccountErrorState;
  isLoading: boolean;
  error: string | null;

  // === 分类状态 ===
  categoryMode: CategoryMode;
  selectedCategoryId: string | null;

  // === Account 操作 ===
  loadAllAccounts: () => Promise<void>;
  createAccount: (params: CreateAccountParams) => Promise<Account | null>;
  createAccountWithAutoProfile: (
    params: CreateAccountWithAutoProfileParams
  ) => Promise<{ profileId: string; account: Account } | null>;
  updateAccount: (id: string, params: UpdateAccountParams) => Promise<Account | null>;
  deleteAccount: (id: string) => Promise<boolean>;
  revealAccountSecret: (id: string) => Promise<string | null>;
  loginAccount: (
    accountId: string
  ) => Promise<{ success: boolean; viewId?: string; error?: string }>;

  // === SavedSite 操作 ===
  loadSavedSites: () => Promise<void>;
  createSavedSite: (params: CreateSavedSiteParams) => Promise<SavedSite | null>;
  updateSavedSite: (id: string, params: UpdateSavedSiteParams) => Promise<SavedSite | null>;
  deleteSavedSite: (id: string) => Promise<boolean>;
  incrementSiteUsage: (id: string) => Promise<void>;

  // === Tag 操作 ===
  loadTags: () => Promise<void>;
  createTag: (params: CreateTagParams) => Promise<Tag | null>;
  updateTag: (id: string, params: UpdateTagParams) => Promise<Tag | null>;
  deleteTag: (id: string) => Promise<boolean>;

  // === 分类操作 ===
  setCategoryMode: (mode: CategoryMode) => void;
  selectCategory: (id: string | null) => void;
  getCategoriesBySite: () => CategoryItem[];
  getCategoriesByTag: () => CategoryItem[];
  getFilteredAccounts: () => Account[];

  // === 辅助 ===
  clearError: () => void;
  getAccountsForProfile: (profileId: string) => Account[];
}

const defaultLoadingState = (): AccountLoadingState => ({
  accounts: false,
  savedSites: false,
  tags: false,
  mutation: false,
  login: false,
});

const defaultErrorState = (): AccountErrorState => ({
  accounts: null,
  savedSites: null,
  tags: null,
  mutation: null,
  login: null,
});

function deriveAccountMeta(loading: AccountLoadingState, errors: AccountErrorState) {
  return {
    isLoading: Object.values(loading).some(Boolean),
    error:
      errors.mutation ||
      errors.login ||
      errors.accounts ||
      errors.savedSites ||
      errors.tags ||
      null,
  };
}

function toAccountTimestamp(value: Date | undefined): number {
  if (!(value instanceof Date)) return 0;
  const time = value.getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortAccountsNewestFirst(accounts: Account[]): Account[] {
  return [...accounts].sort((left, right) => {
    const createdDiff = toAccountTimestamp(right.createdAt) - toAccountTimestamp(left.createdAt);
    if (createdDiff !== 0) {
      return createdDiff;
    }

    const updatedDiff = toAccountTimestamp(right.updatedAt) - toAccountTimestamp(left.updatedAt);
    if (updatedDiff !== 0) {
      return updatedDiff;
    }

    return String(left.id || '').localeCompare(String(right.id || ''));
  });
}

type AccountStorePatch = {
  loading?: Partial<AccountLoadingState>;
  errors?: Partial<AccountErrorState>;
  accounts?: Account[];
  savedSites?: SavedSite[];
  tags?: Tag[];
  categoryMode?: CategoryMode;
  selectedCategoryId?: string | null;
};

type AccountStoreSetter = (
  partial: Partial<AccountStore> | ((state: AccountStore) => Partial<AccountStore>)
) => void;

function applyAccountPatch(
  set: AccountStoreSetter,
  patch: AccountStorePatch
) {
  set((state) => {
    const loading = patch.loading ? { ...state.loading, ...patch.loading } : state.loading;
    const errors = patch.errors ? { ...state.errors, ...patch.errors } : state.errors;
    const { loading: _loading, errors: _errors, ...rest } = patch;
    return {
      ...rest,
      loading,
      errors,
      ...deriveAccountMeta(loading, errors),
    };
  });
}

export const useAccountStore = create<AccountStore>((set, get) => ({
  // === 初始状态 ===
  accounts: [],
  savedSites: [],
  tags: [],
  loading: defaultLoadingState(),
  errors: defaultErrorState(),
  ...deriveAccountMeta(defaultLoadingState(), defaultErrorState()),

  // === 分类初始状态 ===
  categoryMode: 'site' as CategoryMode,
  selectedCategoryId: null,

  // === Account 操作 ===

  loadAllAccounts: async () => {
    applyAccountPatch(set, { loading: { accounts: true }, errors: { accounts: null } });
    try {
      const result = await window.electronAPI.account.listAll();
      if (result.success && result.data) {
        applyAccountPatch(set, {
          accounts: sortAccountsNewestFirst(result.data),
          loading: { accounts: false },
        });
      } else {
        applyAccountPatch(set, {
          loading: { accounts: false },
          errors: { accounts: result.error || '加载账号列表失败' },
        });
      }
    } catch (err) {
      applyAccountPatch(set, {
        loading: { accounts: false },
        errors: { accounts: err instanceof Error ? err.message : '加载失败' },
      });
    }
  },

  createAccount: async (params) => {
    applyAccountPatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.account.create(params);
      if (result.success && result.data) {
        applyAccountPatch(set, {
          accounts: sortAccountsNewestFirst([...get().accounts, result.data]),
          loading: { mutation: false },
        });
        return result.data;
      }

      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '创建账号失败' },
      });
      return null;
    } catch (err) {
      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '创建失败' },
      });
      return null;
    }
  },

  createAccountWithAutoProfile: async (params) => {
    applyAccountPatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.account.createWithAutoProfile(params);
      if (result.success && result.data) {
        applyAccountPatch(set, {
          accounts: sortAccountsNewestFirst([...get().accounts, result.data.account]),
          loading: { mutation: false },
        });
        return {
          profileId: result.data.profile.id,
          account: result.data.account,
        };
      }

      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '自动创建环境并创建账号失败' },
      });
      return null;
    } catch (err) {
      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '创建失败' },
      });
      return null;
    }
  },

  updateAccount: async (id, params) => {
    applyAccountPatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.account.update(id, params);
      if (result.success && result.data) {
        applyAccountPatch(set, {
          accounts: sortAccountsNewestFirst(
            get().accounts.map((account) => (account.id === id ? result.data! : account))
          ),
          loading: { mutation: false },
        });
        return result.data;
      }

      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '更新账号失败' },
      });
      return null;
    } catch (err) {
      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '更新失败' },
      });
      return null;
    }
  },

  deleteAccount: async (id) => {
    applyAccountPatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.account.delete(id);
      if (result.success) {
        applyAccountPatch(set, {
          accounts: get().accounts.filter((account) => account.id !== id),
          loading: { mutation: false },
        });
        return true;
      }

      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '删除账号失败' },
      });
      return false;
    } catch (err) {
      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '删除失败' },
      });
      return false;
    }
  },

  revealAccountSecret: async (id) => {
    try {
      const result = await window.electronAPI.account.revealSecret(id);
      if (result.success) {
        return result.data ?? null;
      }
      applyAccountPatch(set, {
        errors: { mutation: result.error || '查看账号密码失败' },
      });
      return null;
    } catch (err) {
      applyAccountPatch(set, {
        errors: { mutation: err instanceof Error ? err.message : '查看账号密码失败' },
      });
      return null;
    }
  },

  loginAccount: async (accountId) => {
    applyAccountPatch(set, { loading: { login: true }, errors: { login: null } });
    try {
      const result = await window.electronAPI.account.login(accountId);
      applyAccountPatch(set, { loading: { login: false } });
      if (result.success && result.data) {
        return { success: true, viewId: result.data.viewId };
      }

      const error = result.error || '登录失败';
      applyAccountPatch(set, { errors: { login: error } });
      return { success: false, error };
    } catch (err) {
      const error = err instanceof Error ? err.message : '登录失败';
      applyAccountPatch(set, {
        loading: { login: false },
        errors: { login: error },
      });
      return { success: false, error };
    }
  },

  // === SavedSite 操作 ===

  loadSavedSites: async () => {
    applyAccountPatch(set, { loading: { savedSites: true }, errors: { savedSites: null } });
    try {
      const result = await window.electronAPI.savedSite.list();
      if (result.success && result.data) {
        applyAccountPatch(set, {
          savedSites: result.data,
          loading: { savedSites: false },
        });
        return;
      }

      applyAccountPatch(set, {
        loading: { savedSites: false },
        errors: { savedSites: result.error || '加载平台列表失败' },
      });
    } catch (err) {
      console.error('[AccountStore] Failed to load saved sites:', err);
      applyAccountPatch(set, {
        loading: { savedSites: false },
        errors: { savedSites: err instanceof Error ? err.message : '加载平台列表失败' },
      });
    }
  },

  createSavedSite: async (params) => {
    applyAccountPatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.savedSite.create(params);
      if (result.success && result.data) {
        applyAccountPatch(set, {
          savedSites: [...get().savedSites, result.data],
          loading: { mutation: false },
        });
        return result.data;
      }

      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '创建平台失败' },
      });
      return null;
    } catch (err) {
      console.error('[AccountStore] Failed to create saved site:', err);
      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '创建平台失败' },
      });
      return null;
    }
  },

  updateSavedSite: async (id, params) => {
    applyAccountPatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.savedSite.update(id, params);
      if (result.success && result.data) {
        applyAccountPatch(set, {
          savedSites: get().savedSites.map((site) => (site.id === id ? result.data! : site)),
          loading: { mutation: false },
        });
        return result.data;
      }

      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '更新平台失败' },
      });
      return null;
    } catch (err) {
      console.error('[AccountStore] Failed to update saved site:', err);
      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '更新平台失败' },
      });
      return null;
    }
  },

  deleteSavedSite: async (id) => {
    applyAccountPatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.savedSite.delete(id);
      if (result.success) {
        applyAccountPatch(set, {
          savedSites: get().savedSites.filter((site) => site.id !== id),
          loading: { mutation: false },
        });
        return true;
      }

      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '删除平台失败' },
      });
      return false;
    } catch (err) {
      console.error('[AccountStore] Failed to delete saved site:', err);
      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '删除平台失败' },
      });
      return false;
    }
  },

  incrementSiteUsage: async (id) => {
    try {
      await window.electronAPI.savedSite.incrementUsage(id);
      applyAccountPatch(set, {
        savedSites: get().savedSites.map((site) =>
          site.id === id ? { ...site, usageCount: site.usageCount + 1 } : site
        ),
      });
    } catch (err) {
      console.error('[AccountStore] Failed to increment site usage:', err);
    }
  },

  // === Tag 操作 ===

  loadTags: async () => {
    applyAccountPatch(set, { loading: { tags: true }, errors: { tags: null } });
    try {
      const result = await window.electronAPI.tag.list();
      if (result.success && result.data) {
        applyAccountPatch(set, {
          tags: result.data,
          loading: { tags: false },
        });
        return;
      }

      applyAccountPatch(set, {
        loading: { tags: false },
        errors: { tags: result.error || '加载标签失败' },
      });
    } catch (err) {
      console.error('[AccountStore] Failed to load tags:', err);
      applyAccountPatch(set, {
        loading: { tags: false },
        errors: { tags: err instanceof Error ? err.message : '加载标签失败' },
      });
    }
  },

  createTag: async (params) => {
    applyAccountPatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.tag.create(params);
      if (result.success && result.data) {
        applyAccountPatch(set, {
          tags: [...get().tags, result.data],
          loading: { mutation: false },
        });
        return result.data;
      }

      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '创建标签失败' },
      });
      return null;
    } catch (err) {
      console.error('[AccountStore] Failed to create tag:', err);
      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '创建标签失败' },
      });
      return null;
    }
  },

  updateTag: async (id, params) => {
    applyAccountPatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.tag.update(id, params);
      if (result.success && result.data) {
        applyAccountPatch(set, {
          tags: get().tags.map((tag) => (tag.id === id ? result.data! : tag)),
          loading: { mutation: false },
        });
        return result.data;
      }

      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '更新标签失败' },
      });
      return null;
    } catch (err) {
      console.error('[AccountStore] Failed to update tag:', err);
      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '更新标签失败' },
      });
      return null;
    }
  },

  deleteTag: async (id) => {
    applyAccountPatch(set, { loading: { mutation: true }, errors: { mutation: null } });
    try {
      const result = await window.electronAPI.tag.delete(id);
      if (result.success) {
        applyAccountPatch(set, {
          tags: get().tags.filter((tag) => tag.id !== id),
          loading: { mutation: false },
        });
        return true;
      }

      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: result.error || '删除标签失败' },
      });
      return false;
    } catch (err) {
      console.error('[AccountStore] Failed to delete tag:', err);
      applyAccountPatch(set, {
        loading: { mutation: false },
        errors: { mutation: err instanceof Error ? err.message : '删除标签失败' },
      });
      return false;
    }
  },

  // === 分类操作 ===

  setCategoryMode: (mode) => {
    applyAccountPatch(set, { categoryMode: mode, selectedCategoryId: null });
  },

  selectCategory: (id) => {
    applyAccountPatch(set, { selectedCategoryId: id });
  },

  // 按网站分类：使用 savedSites 列表，统计每个网站的账号数量
  getCategoriesBySite: () => {
    const { accounts, savedSites } = get();

    // 统计每个平台 ID 的账号数量（仅使用 platformId）
    const siteAccountCount: Record<string, number> = {};
    const siteIdSet = new Set(savedSites.map((site) => site.id));
    let unboundCount = 0;
    const missingPlatformCount: Record<string, number> = {};

    for (const account of accounts) {
      if (account.platformId && siteIdSet.has(account.platformId)) {
        siteAccountCount[account.platformId] = (siteAccountCount[account.platformId] || 0) + 1;
      } else if (account.platformId) {
        missingPlatformCount[account.platformId] = (missingPlatformCount[account.platformId] || 0) + 1;
      } else {
        unboundCount++;
      }
    }

    // 从 savedSites 创建分类列表（仅保留有账号的平台）
    const categories: CategoryItem[] = savedSites
      .map((site) => ({
        id: `site:${site.id}`,
        name: site.name,
        icon: site.icon,
        count: siteAccountCount[site.id] || 0,
      }))
      .filter((item) => item.count > 0);

    if (unboundCount > 0) {
      categories.push({
        id: 'site:__unbound__',
        name: '未绑定平台',
        count: unboundCount,
      });
    }

    for (const [platformId, count] of Object.entries(missingPlatformCount)) {
      categories.push({
        id: `site:__missing__:${platformId}`,
        name: `失效平台 (${platformId})`,
        count,
      });
    }

    // 按账号数量降序排序
    return categories.sort((a, b) => b.count - a.count);
  },

  // 按标签分类：使用独立的 tags 表，统计每个标签的账号数量
  getCategoriesByTag: () => {
    const { accounts, tags } = get();

    // 统计每个标签的账号数量
    const tagAccountCount: Record<string, number> = {};
    let untaggedCount = 0;

    for (const account of accounts) {
      const accountTags = account.tags || [];
      if (accountTags.length === 0) {
        untaggedCount++;
      } else {
        for (const tag of accountTags) {
          tagAccountCount[tag] = (tagAccountCount[tag] || 0) + 1;
        }
      }
    }

    // 分类来源 = tags 表 + 账号中实际出现的标签（防止“账号标签存在但 tags 表无记录”时丢失分类）
    const tagMeta = new Map<string, { color?: string }>();
    for (const tag of tags) {
      const normalizedName = String(tag.name || '').trim();
      if (!normalizedName) continue;
      tagMeta.set(normalizedName, { color: tag.color });
    }

    for (const name of Object.keys(tagAccountCount)) {
      if (!tagMeta.has(name)) {
        tagMeta.set(name, {});
      }
    }

    const categories: CategoryItem[] = Array.from(tagMeta.entries()).map(([name, meta]) => ({
      id: `tag:${name}`,
      name,
      icon: meta.color,
      count: tagAccountCount[name] || 0,
      tag: name,
    }));

    // 添加"未标记"项（没有设置 tags 的账号）
    if (untaggedCount > 0) {
      categories.push({
        id: 'tag:未标记',
        name: '未标记',
        count: untaggedCount,
        tag: '未标记',
      });
    }

    // 按账号数量降序排序
    return categories.sort((a, b) => b.count - a.count);
  },

  // 根据当前分类模式和选中项过滤账号
  getFilteredAccounts: () => {
    const { accounts, categoryMode, selectedCategoryId } = get();

    // 未选中任何分类，返回所有账号
    if (!selectedCategoryId) {
      return accounts;
    }

    switch (categoryMode) {
      case 'site': {
        // 按平台：严格匹配 platformId
        const siteId = selectedCategoryId.replace('site:', '');
        const savedSites = get().savedSites;
        const siteIdSet = new Set(savedSites.map((site) => site.id));

        if (siteId === '__unbound__') {
          return accounts.filter((account) => !account.platformId);
        }

        if (siteId.startsWith('__missing__:')) {
          const missingPlatformId = siteId.slice('__missing__:'.length);
          return accounts.filter(
            (account) =>
              account.platformId === missingPlatformId && !siteIdSet.has(String(account.platformId || ''))
          );
        }

        return accounts.filter((account) => account.platformId === siteId);
      }
      case 'tag': {
        // 按标签：过滤包含指定标签的账号
        const tag = selectedCategoryId.replace('tag:', '');
        if (tag === '未标记') {
          // 无标签的账号
          return accounts.filter((account) => {
            const accountTags = account.tags || [];
            return accountTags.length === 0;
          });
        }
        return accounts.filter((account) => {
          const accountTags = account.tags || [];
          return accountTags.includes(tag);
        });
      }
      default:
        return accounts;
    }
  },

  // === 辅助 ===

  clearError: () => {
    applyAccountPatch(set, { errors: defaultErrorState() });
  },

  getAccountsForProfile: (profileId) => {
    return get().accounts.filter((account) => account.profileId === profileId);
  },
}));
