import { create } from 'zustand';
import { normalizeCloudScope, normalizeCloudScopeList } from '../../../utils/cloud-sync-scope';
import type {
  CloudAuthPublicSession,
  CloudSyncCapabilityAction,
  CloudSyncCapabilityDomain,
  CloudSyncCapabilities,
  CloudSyncDomainCapability,
} from '../../../types/cloud-sync';

export interface CloudSyncScope {
  scopeType: string;
  scopeId: number;
}

export type CloudAuthState = 'logged_out' | 'restoring' | 'ready';

interface CloudAuthStore {
  authState: CloudAuthState;
  session: CloudAuthPublicSession;
  isLoading: boolean;
  isCapabilitiesLoading: boolean;
  isScopeLoading: boolean;
  error: string | null;
  capabilities: CloudSyncCapabilities | null;
  activeScope: CloudSyncScope | null;
  availableScopes: CloudSyncScope[];
  loadSession: () => Promise<void>;
  loadCapabilities: (options?: { forceRefresh?: boolean }) => Promise<CloudSyncCapabilities | null>;
  loadActiveScope: (options?: {
    forceRefreshCapabilities?: boolean;
  }) => Promise<{ activeScope: CloudSyncScope; availableScopes: CloudSyncScope[] } | null>;
  setActiveScope: (
    scope?: { scopeType?: string; scopeId?: number } | null
  ) => Promise<{ success: boolean; error?: string }>;
  hasCapability: (domain: CloudSyncCapabilityDomain, action: CloudSyncCapabilityAction) => boolean;
  login: (params: {
    username: string;
    password: string;
    captchaCode?: string;
    captchaUuid?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<{ success: boolean; error?: string }>;
  clearError: () => void;
}

const DEFAULT_SESSION: CloudAuthPublicSession = {
  loggedIn: false,
  authRevision: 0,
};

const DEFAULT_CAPABILITIES: CloudSyncCapabilities = {
  profile: {
    view: false,
    cache: false,
    edit: false,
    delete: false,
  },
  account: {
    view: false,
    cache: false,
    edit: false,
    delete: false,
  },
  scopes: [],
};

function normalizeCapabilities(raw: unknown): CloudSyncCapabilities {
  if (!raw || typeof raw !== 'object') return DEFAULT_CAPABILITIES;
  const value = raw as Record<string, unknown>;
  const snapshot =
    value.snapshot && typeof value.snapshot === 'object'
      ? (value.snapshot as Record<string, unknown>)
      : null;

  const normalizeDomain = (domainRaw: unknown): CloudSyncDomainCapability => {
    if (!domainRaw || typeof domainRaw !== 'object') return DEFAULT_CAPABILITIES.profile;
    const domain = domainRaw as Record<string, unknown>;
    return {
      view: domain.view === true,
      cache: domain.cache === true,
      edit: domain.edit === true,
      delete: domain.delete === true,
    };
  };

  const scopes = Array.isArray(value.scopes)
    ? value.scopes
        .map((item) => {
          const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
          const scopeType = typeof row.scopeType === 'string' ? row.scopeType.trim() : undefined;
          const scopeIDRaw = Number(row.scopeId);
          return {
            scopeType,
            scopeId: Number.isFinite(scopeIDRaw) ? Math.trunc(scopeIDRaw) : undefined,
          };
        })
        .filter((item) => item.scopeType || typeof item.scopeId === 'number')
    : [];

  return {
    profile:
      snapshot?.profiles === true
        ? { view: true, cache: true, edit: true, delete: true }
        : normalizeDomain(value.profile),
    account:
      snapshot?.accountBundle === true
        ? { view: true, cache: true, edit: true, delete: true }
        : normalizeDomain(value.account),
    scopes,
  };
}

function normalizeScope(raw: unknown): CloudSyncScope | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const normalized = normalizeCloudScope(row.scopeType, row.scopeId);
  const numericScopeId = Number(normalized.scopeId);
  if (!Number.isFinite(numericScopeId)) return null;
  return {
    scopeType: normalized.scopeType,
    scopeId: Math.trunc(numericScopeId),
  };
}

function normalizeScopeList(raw: unknown): CloudSyncScope[] {
  return normalizeCloudScopeList(raw)
    .map((scope) => {
      const numericScopeId = Number(scope.scopeId);
      if (!Number.isFinite(numericScopeId)) return null;
      return {
        scopeType: scope.scopeType,
        scopeId: Math.trunc(numericScopeId),
      };
    })
    .filter((scope): scope is CloudSyncScope => !!scope);
}

function clearDerivedState(partial?: Partial<CloudAuthStore>): Partial<CloudAuthStore> {
  return {
    capabilities: null,
    activeScope: null,
    availableScopes: [],
    isCapabilitiesLoading: false,
    isScopeLoading: false,
    ...partial,
  };
}

function applyLoggedOutState(
  session: CloudAuthPublicSession = DEFAULT_SESSION,
  partial?: Partial<CloudAuthStore>
): Partial<CloudAuthStore> {
  return clearDerivedState({
    session,
    authState: 'logged_out',
    isLoading: false,
    error: null,
    ...partial,
  });
}

function applyRecoveryErrorState(
  session: CloudAuthPublicSession,
  error: string
): Partial<CloudAuthStore> {
  if (!session.loggedIn) {
    return applyLoggedOutState(session, { error });
  }

  return clearDerivedState({
    session,
    authState: 'restoring',
    isLoading: false,
    error,
  });
}

export const useCloudAuthStore = create<CloudAuthStore>((set, get) => ({
  authState: 'logged_out',
  session: DEFAULT_SESSION,
  isLoading: false,
  isCapabilitiesLoading: false,
  isScopeLoading: false,
  error: null,
  capabilities: null,
  activeScope: null,
  availableScopes: [],

  loadSession: async () => {
    const cloudAuthAPI = window.electronAPI?.cloudAuth;
    if (!cloudAuthAPI) {
      set(applyLoggedOutState(DEFAULT_SESSION));
      return;
    }

    let resolvedSession: CloudAuthPublicSession = DEFAULT_SESSION;
    set(
      clearDerivedState({
        session: get().session.loggedIn ? get().session : DEFAULT_SESSION,
        isLoading: true,
        authState: 'restoring',
        error: null,
      })
    );
    try {
      const result = await cloudAuthAPI.getSession();
      if (!result.success || !result.data) {
        const message = result.error || '加载云端登录状态失败';
        set(applyLoggedOutState(DEFAULT_SESSION, { error: message }));
        return;
      }

      resolvedSession = result.data;
      if (!result.data.loggedIn) {
        set(applyLoggedOutState(result.data));
        return;
      }

      set({ session: result.data, error: null });
      const capabilities = await get().loadCapabilities({ forceRefresh: true });
      if (!capabilities) {
        throw new Error('加载云端权限失败');
      }

      const scopeState = await get().loadActiveScope();
      if (!scopeState) {
        throw new Error('加载云端作用域失败');
      }

      set({
        session: result.data,
        authState: 'ready',
        isLoading: false,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载云端登录状态失败';
      set(applyRecoveryErrorState(resolvedSession, message));
    }
  },

  loadCapabilities: async (options) => {
    const cloudSnapshotAPI = window.electronAPI?.cloudSnapshot;
    if (!cloudSnapshotAPI) return null;

    const session = get().session;
    if (!session.loggedIn) {
      set(clearDerivedState());
      return null;
    }

    set({ isCapabilitiesLoading: true });
    try {
      const result = await cloudSnapshotAPI.getCapabilities({
        forceRefresh: options?.forceRefresh === true,
      });
      if (!result.success || !result.data) {
        set(clearDerivedState({ isCapabilitiesLoading: false }));
        return null;
      }

      const normalized = normalizeCapabilities(result.data);
      set({
        capabilities: normalized,
        availableScopes: normalizeScopeList(normalized.scopes),
        isCapabilitiesLoading: false,
      });
      return normalized;
    } catch (error) {
      console.warn('[CloudAuthStore] Failed to load cloud sync capabilities:', error);
      set(clearDerivedState({ isCapabilitiesLoading: false }));
      return null;
    }
  },

  loadActiveScope: async (options) => {
    const cloudSnapshotAPI = window.electronAPI?.cloudSnapshot;
    if (!cloudSnapshotAPI) return null;

    const session = get().session;
    if (!session.loggedIn) {
      set(clearDerivedState());
      return null;
    }

    set({ isScopeLoading: true });
    try {
      const result = await cloudSnapshotAPI.getActiveScope({
        forceRefreshCapabilities: options?.forceRefreshCapabilities === true,
      });
      if (!result.success || !result.data) {
        set(clearDerivedState({ isScopeLoading: false }));
        return null;
      }

      const activeScope = normalizeScope(result.data.activeScope);
      const availableScopes = normalizeScopeList(result.data.availableScopes);
      if (!activeScope) {
        set(clearDerivedState({ isScopeLoading: false }));
        return null;
      }

      set({
        activeScope,
        availableScopes,
        isScopeLoading: false,
      });
      return {
        activeScope,
        availableScopes,
      };
    } catch (error) {
      console.warn('[CloudAuthStore] Failed to load active cloud scope:', error);
      set(clearDerivedState({ isScopeLoading: false }));
      return null;
    }
  },

  setActiveScope: async (scope) => {
    const cloudSnapshotAPI = window.electronAPI?.cloudSnapshot;
    if (!cloudSnapshotAPI) {
      return { success: false, error: 'cloud-snapshot API unavailable' };
    }

    if (get().authState !== 'ready') {
      return { success: false, error: '请先完成云端登录恢复' };
    }

    const previousState = {
      capabilities: get().capabilities,
      activeScope: get().activeScope,
      availableScopes: get().availableScopes,
    };

    set({ isScopeLoading: true, error: null });
    try {
      const result = await cloudSnapshotAPI.setActiveScope(scope ?? null);
      if (!result.success || !result.data) {
        const message = result.error || '切换同步作用域失败';
        set({
          ...previousState,
          isScopeLoading: false,
          error: message,
        });
        return { success: false, error: message };
      }

      const activeScope = normalizeScope(result.data.activeScope);
      const availableScopes = normalizeScopeList(result.data.availableScopes);
      const capabilities = normalizeCapabilities(result.data.capabilities);
      if (!activeScope) {
        const message = '切换同步作用域失败：返回值不完整';
        set({
          ...previousState,
          isScopeLoading: false,
          error: message,
        });
        return { success: false, error: message };
      }

      set({
        capabilities,
        activeScope,
        availableScopes,
        isScopeLoading: false,
        error: null,
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '切换同步作用域失败';
      set({
        ...previousState,
        isScopeLoading: false,
        error: message,
      });
      return { success: false, error: message };
    }
  },

  hasCapability: (domain, action) => {
    const capabilities = get().capabilities;
    if (!capabilities) return false;
    return capabilities[domain][action] === true;
  },

  login: async (params) => {
    const cloudAuthAPI = window.electronAPI?.cloudAuth;
    if (!cloudAuthAPI) {
      set(applyLoggedOutState(DEFAULT_SESSION, { error: 'cloud-auth API unavailable' }));
      return { success: false, error: 'cloud-auth API unavailable' };
    }

    set({ isLoading: true, authState: 'restoring', error: null });
    try {
      const result = await cloudAuthAPI.login(params);
      if (!result.success || !result.data) {
        const message = result.error || '登录失败';
        set(applyLoggedOutState(DEFAULT_SESSION, { error: message }));
        return { success: false, error: message };
      }

      await get().loadSession();
      if (get().authState !== 'ready') {
        const message = get().error || '登录状态恢复失败';
        return { success: false, error: message };
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '登录失败';
      set(applyLoggedOutState(DEFAULT_SESSION, { error: message }));
      return { success: false, error: message };
    }
  },

  logout: async () => {
    const cloudAuthAPI = window.electronAPI?.cloudAuth;
    if (!cloudAuthAPI) {
      set(applyLoggedOutState());
      return { success: true };
    }

    set({ isLoading: true, error: null });
    try {
      const result = await cloudAuthAPI.logout();
      if (!result.success) {
        const message = result.error || '退出登录失败';
        set({ isLoading: false, error: message });
        return { success: false, error: message };
      }

      set(applyLoggedOutState());
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '退出登录失败';
      set({ isLoading: false, error: message });
      return { success: false, error: message };
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));

let cloudAuthSessionSubscriptionInstalled = false;

function ensureCloudAuthSessionSubscription(): void {
  if (cloudAuthSessionSubscriptionInstalled) {
    return;
  }
  if (
    typeof window === 'undefined' ||
    typeof window.electronAPI?.cloudAuth?.onSessionChanged !== 'function'
  ) {
    return;
  }

  cloudAuthSessionSubscriptionInstalled = true;
  window.electronAPI.cloudAuth.onSessionChanged((event) => {
    if (!event?.session?.loggedIn) {
      useCloudAuthStore.setState(applyLoggedOutState(event?.session || DEFAULT_SESSION));
      return;
    }

    useCloudAuthStore.setState({
      ...clearDerivedState({
        session: event.session,
        authState: 'restoring',
        isLoading: true,
        error: null,
      }),
    });
    void useCloudAuthStore.getState().loadSession();
  });
}

ensureCloudAuthSessionSubscription();
