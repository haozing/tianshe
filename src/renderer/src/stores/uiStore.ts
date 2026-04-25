/**
 * UI 状态管理 Store
 * 管理应用级别的 UI 状态，如当前激活的视图
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ActiveView =
  | 'workbench'
  | 'datasets'
  | 'accountCenter'
  | 'marketplace'
  | 'plugin'
  | 'settings';

export type AccountCenterTab = 'accounts' | 'profiles' | 'extensions' | 'running';

interface UIStore {
  // 当前激活的主视图
  activeView: ActiveView;

  // 设置激活的视图
  setActiveView: (view: ActiveView) => void;

  // 账号中心当前子标签
  accountCenterTab: AccountCenterTab;

  // 设置账号中心子标签
  setAccountCenterTab: (tab: AccountCenterTab) => void;

  // 打开账号中心指定标签
  openAccountCenterTab: (tab: AccountCenterTab) => void;

  // Activity Bar 是否折叠（预留，未来实现）
  isActivityBarCollapsed: boolean;

  // 切换 Activity Bar 折叠状态
  toggleActivityBar: () => void;

  // ✅ 当前激活的插件视图ID（插件ID）
  activePluginView: string | null;

  // ✅ 设置激活的插件视图
  setActivePluginView: (pluginId: string | null) => void;

  // 云端登录弹窗状态
  isCloudAuthDialogOpen: boolean;
  setCloudAuthDialogOpen: (open: boolean) => void;
}

interface PersistedUIState {
  activeView?: ActiveView;
  accountCenterTab?: AccountCenterTab;
  isActivityBarCollapsed?: boolean;
  activePluginView?: string | null;
}

interface LegacyPersistedUIState {
  activeView?: ActiveView | 'browsers' | 'runningBrowsers';
  accountCenterTab?: AccountCenterTab;
  browserCenterTab?: AccountCenterTab;
  isActivityBarCollapsed?: boolean;
  activePluginView?: string | null;
}

function normalizeActiveView(activeView?: LegacyPersistedUIState['activeView']): ActiveView {
  switch (activeView) {
    case 'browsers':
    case 'runningBrowsers':
      return 'accountCenter';
    case 'workbench':
    case 'datasets':
    case 'accountCenter':
    case 'marketplace':
    case 'plugin':
    case 'settings':
      return activeView;
    default:
      return 'accountCenter';
  }
}

function normalizeAccountCenterTab(
  state: Pick<LegacyPersistedUIState, 'accountCenterTab' | 'browserCenterTab'>
): AccountCenterTab {
  return state.accountCenterTab ?? state.browserCenterTab ?? 'accounts';
}

function toPersistedUIState(state: PersistedUIState | LegacyPersistedUIState): {
  activeView: ActiveView;
  accountCenterTab: AccountCenterTab;
  isActivityBarCollapsed: boolean;
  activePluginView: string | null;
} {
  return {
    activeView: normalizeActiveView(state.activeView),
    accountCenterTab: normalizeAccountCenterTab(state),
    isActivityBarCollapsed: state.isActivityBarCollapsed ?? false,
    activePluginView: state.activePluginView ?? null,
  };
}

export function migratePersistedUIState(
  persistedState: unknown,
  version: number
): ReturnType<typeof toPersistedUIState> {
  const legacyState = (persistedState as LegacyPersistedUIState | undefined) || {};

  if (version < 2) {
    return toPersistedUIState({
      ...legacyState,
      activeView: 'accountCenter',
      accountCenterTab: 'accounts' as AccountCenterTab,
      activePluginView: null,
    });
  }

  if (version < 3) {
    const legacyActiveView = legacyState.activeView;
    return toPersistedUIState({
      ...legacyState,
      activeView:
        legacyActiveView === 'runningBrowsers'
          ? 'accountCenter'
          : (legacyActiveView ?? 'accountCenter'),
      accountCenterTab:
        legacyActiveView === 'runningBrowsers'
          ? ('running' as AccountCenterTab)
          : normalizeAccountCenterTab(legacyState),
    });
  }

  if (version < 4) {
    return toPersistedUIState({
      ...legacyState,
      accountCenterTab: normalizeAccountCenterTab(legacyState),
    });
  }

  if (version < 5) {
    return toPersistedUIState({
      ...legacyState,
      accountCenterTab: normalizeAccountCenterTab(legacyState),
    });
  }

  return toPersistedUIState(legacyState);
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      // 默认显示账号中心
      activeView: 'accountCenter',

      setActiveView: (view) => set({ activeView: view }),

      accountCenterTab: 'accounts',

      setAccountCenterTab: (tab) => set({ accountCenterTab: tab }),

      openAccountCenterTab: (tab) =>
        set({
          activeView: 'accountCenter',
          accountCenterTab: tab,
        }),

      // 默认不折叠
      isActivityBarCollapsed: false,

      toggleActivityBar: () =>
        set((state) => ({ isActivityBarCollapsed: !state.isActivityBarCollapsed })),

      // ✅ 插件视图状态
      activePluginView: null,

      setActivePluginView: (pluginId) =>
        set({
          activePluginView: pluginId,
          // 当设置插件视图时，自动切换主视图为 plugin
          activeView: pluginId ? 'plugin' : 'accountCenter',
        }),

      isCloudAuthDialogOpen: false,

      setCloudAuthDialogOpen: (open) =>
        set({
          isCloudAuthDialogOpen: open,
        }),
    }),
    {
      name: 'ui-storage', // localStorage key
      version: 5,
      migrate: migratePersistedUIState,
      partialize: (state) => ({
        activeView: state.activeView,
        accountCenterTab: state.accountCenterTab,
        isActivityBarCollapsed: state.isActivityBarCollapsed,
        activePluginView: state.activePluginView,
      }),
    }
  )
);
