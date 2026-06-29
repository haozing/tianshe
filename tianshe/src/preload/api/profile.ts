import type { IpcRenderer } from 'electron';
import type {
  BrowserRuntimeId,
  BrowserProfile,
  CreateGroupParams,
  CreateProfileParams,
  PoolBrowserInfo,
  ProfileGroup,
  ProfileListParams,
  UpdateGroupParams,
  UpdateProfileParams,
} from '../../types/profile';

export type BrowserPoolMode = 'light' | 'standard' | 'performance' | 'custom';

export interface BrowserPoolConfig {
  mode: BrowserPoolMode;
  maxTotalBrowsers: number;
  maxConcurrentCreation: number;
  defaultIdleTimeoutMs: number;
  defaultLockTimeoutMs: number;
  healthCheckIntervalMs: number;
}

export function createProfileAPI(ipcRenderer: IpcRenderer) {
  return {
    profile: {
      create: (
        params: CreateProfileParams
      ): Promise<{
        success: boolean;
        data?: BrowserProfile;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:create', params);
      },

      get: (
        id: string
      ): Promise<{
        success: boolean;
        data?: BrowserProfile;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:get', id);
      },

      list: (
        params?: ProfileListParams
      ): Promise<{
        success: boolean;
        data?: BrowserProfile[];
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:list', params);
      },

      update: (
        id: string,
        params: UpdateProfileParams
      ): Promise<{
        success: boolean;
        data?: BrowserProfile;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:update', id, params);
      },

      delete: (
        id: string
      ): Promise<{
        success: boolean;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:delete', id);
      },

      updateStatus: (
        id: string,
        status: 'idle' | 'active' | 'error',
        error?: string
      ): Promise<{
        success: boolean;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:update-status', id, status, error);
      },

      isAvailable: (
        id: string
      ): Promise<{
        success: boolean;
        data?: boolean;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:is-available', id);
      },

      getStats: (): Promise<{
        success: boolean;
        data?: {
          total: number;
          idle: number;
          active: number;
          error: number;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:get-stats');
      },

      close: (
        id: string,
        viewId: string
      ): Promise<{
        success: boolean;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:close', id, viewId);
      },

      poolLaunch: (
        profileId: string,
        options?: {
          pluginId?: string;
          timeout?: number;
          strategy?: 'any' | 'fresh' | 'reuse' | 'specific';
          browserId?: string;
          runtimeId?: BrowserRuntimeId;
        }
      ): Promise<{
        success: boolean;
        data?: {
          browserId: string;
          sessionId: string;
          profileId: string;
          runtimeId?: BrowserRuntimeId;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:pool-launch', profileId, options);
      },

      poolRelease: (
        browserId: string,
        options?: {
          destroy?: boolean;
          navigateTo?: string;
          clearStorage?: boolean;
        }
      ): Promise<{
        success: boolean;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:pool-release', browserId, options);
      },

      poolStats: (): Promise<{
        success: boolean;
        data?: {
          totalBrowsers: number;
          idleBrowsers: number;
          lockedBrowsers: number;
          sessionsCount: number;
          waitingRequests: number;
          browsersBySession: Record<string, { total: number; idle: number; locked: number }>;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:pool-stats');
      },

      poolListBrowsers: (): Promise<{
        success: boolean;
        data?: PoolBrowserInfo[];
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:pool-list-browsers');
      },

      poolShowBrowser: (
        browserId: string,
        options?: { title?: string; width?: number; height?: number }
      ): Promise<{
        success: boolean;
        data?: {
          popupId?: string;
          viewId?: string;
          popupWindowId?: string;
          runtimeId?: BrowserRuntimeId;
          activated?: boolean;
          browserId?: string;
          relaunched?: boolean;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:pool-show-browser', browserId, options);
      },

      poolProfileStats: (
        profileId: string
      ): Promise<{
        success: boolean;
        data?: {
          sessionId: string;
          quota: number;
          browserCount: number;
          idleCount: number;
          lockedCount: number;
          waitingCount: number;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:pool-profile-stats', profileId);
      },

      poolDestroyProfileBrowsers: (
        profileId: string
      ): Promise<{
        success: boolean;
        data?: { destroyed: number };
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:pool-destroy-profile-browsers', profileId);
      },

      poolReleaseByPlugin: (
        pluginId: string
      ): Promise<{
        success: boolean;
        data?: {
          browsers: number;
          requests: number;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile:pool-release-by-plugin', pluginId);
      },
    },

    profileGroup: {
      create: (
        params: CreateGroupParams
      ): Promise<{
        success: boolean;
        data?: ProfileGroup;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile-group:create', params);
      },

      get: (
        id: string
      ): Promise<{
        success: boolean;
        data?: ProfileGroup;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile-group:get', id);
      },

      list: (): Promise<{
        success: boolean;
        data?: ProfileGroup[];
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile-group:list');
      },

      listTree: (): Promise<{
        success: boolean;
        data?: ProfileGroup[];
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile-group:list-tree');
      },

      update: (
        id: string,
        params: UpdateGroupParams
      ): Promise<{
        success: boolean;
        data?: ProfileGroup;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile-group:update', id, params);
      },

      delete: (
        id: string,
        recursive?: boolean
      ): Promise<{
        success: boolean;
        error?: string;
      }> => {
        return ipcRenderer.invoke('profile-group:delete', id, recursive);
      },
    },

    browserPool: {
      getConfig: (): Promise<{
        success: boolean;
        data?: BrowserPoolConfig;
        error?: string;
      }> => {
        return ipcRenderer.invoke('browser-pool:get-config');
      },

      setConfig: (
        config: Partial<BrowserPoolConfig>
      ): Promise<{
        success: boolean;
        data?: BrowserPoolConfig;
        error?: string;
      }> => {
        return ipcRenderer.invoke('browser-pool:set-config', config);
      },

      applyPreset: (
        preset: 'light' | 'standard' | 'performance'
      ): Promise<{
        success: boolean;
        data?: BrowserPoolConfig;
        error?: string;
      }> => {
        return ipcRenderer.invoke('browser-pool:apply-preset', preset);
      },

      getPresets: (): Promise<{
        success: boolean;
        data?: {
          presets: Record<
            'light' | 'standard' | 'performance',
            {
              maxTotalBrowsers: number;
              maxConcurrentCreation: number;
              defaultIdleTimeoutMs: number;
              defaultLockTimeoutMs: number;
              healthCheckIntervalMs: number;
            }
          >;
          limits: Record<
            string,
            {
              min: number;
              max: number;
            }
          >;
        };
        error?: string;
      }> => {
        return ipcRenderer.invoke('browser-pool:get-presets');
      },

      resetConfig: (): Promise<{
        success: boolean;
        data?: BrowserPoolConfig;
        error?: string;
      }> => {
        return ipcRenderer.invoke('browser-pool:reset-config');
      },
    },
  };
}
