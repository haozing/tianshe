import type { IpcRenderer } from 'electron';
import type {
  Account,
  BrowserProfile,
  CreateAccountParams,
  CreateAccountWithAutoProfileParams,
  UpdateAccountParams,
} from '../../types/profile';

export function createAccountAPI(ipcRenderer: IpcRenderer) {
  return {
    create: (
      params: CreateAccountParams
    ): Promise<{
      success: boolean;
      data?: Account;
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:create', params);
    },

    createWithAutoProfile: (
      params: CreateAccountWithAutoProfileParams
    ): Promise<{
      success: boolean;
      data?: { profile: BrowserProfile; account: Account };
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:create-with-auto-profile', params);
    },

    get: (
      id: string
    ): Promise<{
      success: boolean;
      data?: Account | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:get', id);
    },

    listByProfile: (
      profileId: string
    ): Promise<{
      success: boolean;
      data?: Account[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:list-by-profile', profileId);
    },

    listByPlatform: (
      platformId: string
    ): Promise<{
      success: boolean;
      data?: Account[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:list-by-platform', platformId);
    },

    listAll: (): Promise<{
      success: boolean;
      data?: Account[];
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:list-all');
    },

    revealSecret: (
      id: string
    ): Promise<{
      success: boolean;
      data?: string | null;
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:reveal-secret', id);
    },

    update: (
      id: string,
      params: UpdateAccountParams
    ): Promise<{
      success: boolean;
      data?: Account;
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:update', id, params);
    },

    delete: (
      id: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:delete', id);
    },

    login: (
      accountId: string,
      options?: {
        showPopup?: boolean;
        popupWidth?: number;
        popupHeight?: number;
      }
    ): Promise<{
      success: boolean;
      data?: {
        viewId: string;
        browserId: string;
        sessionId: string;
        accountId: string;
        accountName: string;
        profileId: string;
        profileName: string;
        loginUrl: string;
        platformId?: string | null;
        platformName?: string | null;
        popupId: string | null;
      };
      error?: string;
    }> => {
      return ipcRenderer.invoke('account:login', accountId, options);
    },

    closePopup: (
      popupId: string
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke('popup:close', popupId);
    },
  };
}
