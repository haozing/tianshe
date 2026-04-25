import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerAccountHandlers } from './account-ipc-handler';
import { UNBOUND_PROFILE_ID, type Account, type SavedSite } from '../../types/profile';
import { getBrowserPoolManager, showBrowserViewInPopup } from '../../core/browser-pool';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
} from '../../core/browser-pool/profile-live-session-lease';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../../core/browser-pool', () => ({
  getBrowserPoolManager: vi.fn(),
  showBrowserViewInPopup: vi.fn(),
}));

vi.mock('../../core/browser-pool/profile-live-session-lease', () => ({
  acquireProfileLiveSessionLease: vi.fn(),
  attachProfileLiveSessionLease: vi.fn((handle) => handle),
}));

interface BrowserHandle {
  browserId: string;
  sessionId: string;
  engine: 'electron' | 'extension';
  browser: {
    goto: Mock;
    show?: Mock;
  };
  release: Mock;
}

describe('registerAccountHandlers - account:login', () => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  const accountService = {
    create: vi.fn(),
    get: vi.fn(),
    listByProfile: vi.fn(),
    listAll: vi.fn(),
    revealSecret: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    updateLastLogin: vi.fn(),
  };

  const savedSiteService = {
    create: vi.fn(),
    get: vi.fn(),
    listAll: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    incrementUsage: vi.fn(),
  };

  const profileService = {
    get: vi.fn(),
    updateStatus: vi.fn(),
  };

  const viewManager = {
    getView: vi.fn(),
  };

  const windowManager = {
    createPopupWindow: vi.fn(),
    closeWindowById: vi.fn(),
  };
  const onOwnedBundleChanged = vi.fn().mockResolvedValue(undefined);

  const poolManager = {
    acquire: vi.fn(),
    listBrowsers: vi.fn(),
    getProfileStats: vi.fn(),
  };

  const buildAccount = (patch: Partial<Account> = {}): Account => ({
    id: 'acc-1',
    profileId: UNBOUND_PROFILE_ID,
    platformId: 'platform-1',
    name: 'demo-account',
    loginUrl: 'https://account.example/login',
    tags: [],
    createdAt: new Date('2026-02-17T00:00:00.000Z'),
    updatedAt: new Date('2026-02-17T00:00:00.000Z'),
    ...patch,
  });

  const buildPlatform = (patch: Partial<SavedSite> = {}): SavedSite => ({
    id: 'platform-1',
    name: 'Demo Platform',
    url: 'https://platform.example/login',
    usageCount: 0,
    createdAt: new Date('2026-02-17T00:00:00.000Z'),
    ...patch,
  });

  const buildBrowserHandle = (patch: Partial<BrowserHandle> = {}): BrowserHandle => ({
    browserId: 'browser-1',
    sessionId: 'session-1',
    engine: 'electron',
    browser: {
      goto: vi.fn().mockResolvedValue(undefined),
    },
    release: vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      remainingBrowserCount: 0,
      destroyed: false,
    }),
    ...patch,
  });

  const getHandler = (channel: string) => {
    const handler = registeredHandlers.get(channel);
    if (!handler) {
      throw new Error(`Handler not found: ${channel}`);
    }
    return handler;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    (ipcMain.handle as Mock).mockImplementation((channel: string, fn: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, fn as (...args: unknown[]) => Promise<unknown>);
    });

    (getBrowserPoolManager as Mock).mockReturnValue(poolManager);
    (acquireProfileLiveSessionLease as Mock).mockResolvedValue({
      release: vi.fn().mockResolvedValue(undefined),
    });
    (attachProfileLiveSessionLease as Mock).mockImplementation((handle) => handle);
    (showBrowserViewInPopup as Mock).mockReturnValue(null);

    poolManager.acquire.mockResolvedValue(buildBrowserHandle());
    poolManager.listBrowsers.mockReturnValue([{ id: 'browser-1', viewId: 'view-1' }]);
    poolManager.getProfileStats.mockResolvedValue({ browserCount: 0 });
    profileService.updateStatus.mockResolvedValue(undefined);
    accountService.updateLastLogin.mockResolvedValue(undefined);

    registerAccountHandlers(
      accountService as never,
      savedSiteService as never,
      profileService as never,
      viewManager as never,
      windowManager as never,
      {
        onOwnedBundleChanged,
      }
    );
  });

  it('should return invalid-platform error when account has no platformId', async () => {
    accountService.get.mockResolvedValue(
      buildAccount({
        platformId: undefined,
      })
    );

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('未关联平台');
    expect(savedSiteService.get).not.toHaveBeenCalled();
    expect(profileService.get).not.toHaveBeenCalled();
    expect(poolManager.acquire).not.toHaveBeenCalled();
  });

  it('should return invalid-platform error when platform does not exist', async () => {
    accountService.get.mockResolvedValue(buildAccount());
    savedSiteService.get.mockResolvedValue(null);

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('平台不存在');
    expect(profileService.get).not.toHaveBeenCalled();
    expect(poolManager.acquire).not.toHaveBeenCalled();
  });

  it('should return unbound-profile error when account profile is not set', async () => {
    accountService.get.mockResolvedValue(buildAccount({ profileId: UNBOUND_PROFILE_ID }));
    savedSiteService.get.mockResolvedValue(buildPlatform());

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('未绑定浏览器环境');
    expect(profileService.get).not.toHaveBeenCalled();
    expect(poolManager.acquire).not.toHaveBeenCalled();
  });

  it('should return missing-profile error when bound profile no longer exists', async () => {
    accountService.get.mockResolvedValue(buildAccount({ profileId: 'legacy-profile' }));
    savedSiteService.get.mockResolvedValue(buildPlatform());
    profileService.get.mockResolvedValue(null);

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('已不存在');
    expect(poolManager.acquire).not.toHaveBeenCalled();
  });

  it('should not fallback to platform profile even if platform carries legacy profileId field', async () => {
    accountService.get.mockResolvedValue(buildAccount({ profileId: 'account-missing' }));
    savedSiteService.get.mockResolvedValue({
      ...buildPlatform(),
      profileId: 'platform-profile',
    } as unknown as SavedSite);
    profileService.get.mockImplementation(async (id: string) => {
      if (id === 'platform-profile') return { id: 'platform-profile', name: 'Platform Env' };
      return null;
    });

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('已不存在');
    expect(profileService.get).toHaveBeenCalledTimes(1);
    expect(profileService.get).toHaveBeenCalledWith('account-missing');
    expect(poolManager.acquire).not.toHaveBeenCalled();
  });

  it('should use account profile binding and fallback url when account loginUrl is empty', async () => {
    const handle = buildBrowserHandle();
    poolManager.acquire.mockResolvedValue(handle);

    accountService.get.mockResolvedValue(buildAccount({ profileId: 'account-profile', loginUrl: '' }));
    savedSiteService.get.mockResolvedValue(
      buildPlatform({
        url: 'https://platform.example/fallback-login',
      })
    );
    profileService.get.mockResolvedValue({ id: 'account-profile', name: 'Account Env' });

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1', { showPopup: false })) as {
      success: boolean;
      data?: {
        profileId: string;
        loginUrl: string;
        platformId?: string | null;
      };
    };

    expect(poolManager.acquire).toHaveBeenCalledWith(
      'account-profile',
      { strategy: 'any', timeout: 30000, priority: 'normal' },
      'ipc'
    );
    expect(handle.browser.goto).toHaveBeenCalledWith('https://platform.example/fallback-login');
    expect(handle.release).toHaveBeenCalledTimes(1);
    expect(profileService.updateStatus).not.toHaveBeenCalled();
    expect(accountService.updateLastLogin).toHaveBeenCalledWith('acc-1');
    expect(result.success).toBe(true);
    expect(result.data?.profileId).toBe('account-profile');
    expect(result.data?.loginUrl).toBe('https://platform.example/fallback-login');
    expect(result.data?.platformId).toBe('platform-1');
  });

  it('should rollback status to idle when post-acquire step throws before popup ownership', async () => {
    const handle = buildBrowserHandle();
    poolManager.acquire.mockResolvedValue(handle);

    accountService.get.mockResolvedValue(
      buildAccount({
        profileId: 'legacy-profile',
        loginUrl: 'https://account.example/direct-login',
      })
    );
    savedSiteService.get.mockResolvedValue(buildPlatform());
    profileService.get.mockResolvedValue({ id: 'legacy-profile', name: 'Legacy Env' });
    accountService.updateLastLogin.mockRejectedValue(new Error('update login stamp failed'));

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1', { showPopup: false })) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('update login stamp failed');
    expect(handle.release).toHaveBeenCalledTimes(1);
    expect(profileService.updateStatus).not.toHaveBeenCalled();
  });

  it('should keep profile active when released browser is not the last instance', async () => {
    const handle = buildBrowserHandle({
      release: vi.fn().mockResolvedValue({
        sessionId: 'legacy-profile',
        remainingBrowserCount: 2,
        destroyed: false,
      }),
    });
    poolManager.acquire.mockResolvedValue(handle);

    accountService.get.mockResolvedValue(
      buildAccount({
        profileId: 'legacy-profile',
        loginUrl: 'https://account.example/direct-login',
      })
    );
    savedSiteService.get.mockResolvedValue(buildPlatform());
    profileService.get.mockResolvedValue({ id: 'legacy-profile', name: 'Legacy Env' });

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1', { showPopup: false })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(profileService.updateStatus).not.toHaveBeenCalled();
  });

  it('should release browser handle and return error when popup creation fails', async () => {
    const handle = buildBrowserHandle();
    poolManager.acquire.mockResolvedValue(handle);

    accountService.get.mockResolvedValue(
      buildAccount({
        profileId: 'legacy-profile',
        loginUrl: 'https://account.example/direct-login',
      })
    );
    savedSiteService.get.mockResolvedValue(buildPlatform());
    profileService.get.mockResolvedValue({ id: 'legacy-profile', name: 'Legacy Env' });
    (showBrowserViewInPopup as Mock).mockReturnValue(null);

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1')) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('登录窗口打开失败');
    expect(handle.release).toHaveBeenCalledTimes(1);
    expect(profileService.updateStatus).not.toHaveBeenCalled();
  });

  it('should sync profile status to idle when popup closes and browser is fully released', async () => {
    const handle = buildBrowserHandle({
      release: vi.fn().mockResolvedValue({
        sessionId: 'legacy-profile',
        remainingBrowserCount: 0,
        destroyed: false,
      }),
    });
    poolManager.acquire.mockResolvedValue(handle);

    accountService.get.mockResolvedValue(
      buildAccount({
        profileId: 'legacy-profile',
        loginUrl: 'https://account.example/direct-login',
      })
    );
    savedSiteService.get.mockResolvedValue(buildPlatform());
    profileService.get.mockResolvedValue({ id: 'legacy-profile', name: 'Legacy Env' });

    let popupConfig: { onClose?: () => void } | null = null;
    (showBrowserViewInPopup as Mock).mockImplementation((_viewId, _viewManager, _windowManager, config) => {
      popupConfig = config as { onClose?: () => void };
      return 'popup-1';
    });

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(profileService.updateStatus).not.toHaveBeenCalled();
    expect(handle.release).not.toHaveBeenCalled();

    popupConfig?.onClose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handle.release).toHaveBeenCalledTimes(1);
    expect(profileService.updateStatus).not.toHaveBeenCalled();
  });

  it('should bring extension browser to front and skip popup mounting', async () => {
    const show = vi.fn().mockResolvedValue(undefined);
    const handle = buildBrowserHandle({
      engine: 'extension',
      browser: {
        goto: vi.fn().mockResolvedValue(undefined),
        show,
      },
    });
    poolManager.acquire.mockResolvedValue(handle);

    accountService.get.mockResolvedValue(
      buildAccount({
        profileId: 'legacy-profile',
        loginUrl: 'https://account.example/direct-login',
      })
    );
    savedSiteService.get.mockResolvedValue(buildPlatform());
    profileService.get.mockResolvedValue({ id: 'legacy-profile', name: 'Legacy Env' });

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1')) as {
      success: boolean;
      data?: {
        popupId: string | null;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data?.popupId).toBeNull();
    expect(show).toHaveBeenCalledTimes(1);
    expect(showBrowserViewInPopup).not.toHaveBeenCalled();
    expect(handle.release).toHaveBeenCalledTimes(1);
    expect(profileService.updateStatus).not.toHaveBeenCalled();
  });

  it('should acquire and attach a profile live-session lease before using the pooled browser', async () => {
    const handle = buildBrowserHandle();
    poolManager.acquire.mockResolvedValue(handle);

    accountService.get.mockResolvedValue(
      buildAccount({
        profileId: 'legacy-profile',
        loginUrl: 'https://account.example/direct-login',
      })
    );
    savedSiteService.get.mockResolvedValue(buildPlatform());
    profileService.get.mockResolvedValue({ id: 'legacy-profile', name: 'Legacy Env' });

    const loginHandler = getHandler('account:login');
    const result = (await loginHandler(null, 'acc-1', { showPopup: false })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(acquireProfileLiveSessionLease).toHaveBeenCalledWith('legacy-profile', {
      timeoutMs: 30000,
    });
    expect(attachProfileLiveSessionLease).toHaveBeenCalledWith(
      expect.objectContaining({ browserId: 'browser-1' }),
      expect.objectContaining({ release: expect.any(Function) })
    );
  });

  it('should reveal secret for local editable account rows', async () => {
    accountService.revealSecret.mockResolvedValue('super-secret');

    const revealHandler = getHandler('account:reveal-secret');
    const result = (await revealHandler(null, 'acc-1')) as {
      success: boolean;
      data?: string | null;
      error?: string;
    };

    expect(accountService.revealSecret).toHaveBeenCalledWith('acc-1');
    expect(result.success).toBe(true);
    expect(result.data).toBe('super-secret');
  });

  it('should surface permission errors when revealing shared account secrets', async () => {
    accountService.revealSecret.mockRejectedValue(new Error('共享账号不允许查看密码'));

    const revealHandler = getHandler('account:reveal-secret');
    const result = (await revealHandler(null, 'acc-shared')) as {
      success: boolean;
      data?: string | null;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('共享账号不允许查看密码');
  });

  it('should propagate saved-site delete constraint failures', async () => {
    savedSiteService.delete.mockRejectedValue(
      new Error('平台仍被 2 个账号引用，请先处理相关账号')
    );

    const deleteHandler = getHandler('saved-site:delete');
    const result = (await deleteHandler(null, 'platform-1')) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('平台仍被 2 个账号引用');
    expect(onOwnedBundleChanged).not.toHaveBeenCalled();
  });

  it('should mark owned bundle dirty after account create succeeds', async () => {
    accountService.create.mockResolvedValue(buildAccount());

    const createHandler = getHandler('account:create');
    const result = (await createHandler(null, {
      profileId: UNBOUND_PROFILE_ID,
      platformId: 'platform-1',
      name: 'demo-account',
      loginUrl: 'https://account.example/login',
      tags: [],
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(accountService.create).toHaveBeenCalledTimes(1);
    expect(onOwnedBundleChanged).toHaveBeenCalledTimes(1);
  });

  it('should mark owned bundle dirty after saved-site delete succeeds', async () => {
    savedSiteService.delete.mockResolvedValue(undefined);

    const deleteHandler = getHandler('saved-site:delete');
    const result = (await deleteHandler(null, 'platform-1')) as { success: boolean };

    expect(result.success).toBe(true);
    expect(savedSiteService.delete).toHaveBeenCalledWith('platform-1');
    expect(onOwnedBundleChanged).toHaveBeenCalledTimes(1);
  });
});
