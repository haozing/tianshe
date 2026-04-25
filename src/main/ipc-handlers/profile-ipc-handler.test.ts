import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerProfileHandlers } from './profile-ipc-handler';
import { getBrowserPoolManager } from '../../core/browser-pool';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
} from '../../core/browser-pool/profile-live-session-lease';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('electron-store', () => ({
  default: class ElectronStoreMock {
    get = vi.fn();
    set = vi.fn();
    delete = vi.fn();
  },
}));

vi.mock('../../core/browser-pool', () => ({
  getBrowserPoolManager: vi.fn(),
  hasBrowserInstance: vi.fn(() => true),
  showBrowserViewInPopup: vi.fn(),
}));

vi.mock('../../core/browser-pool/profile-live-session-lease', () => ({
  acquireProfileLiveSessionLease: vi.fn(),
  attachProfileLiveSessionLease: vi.fn((handle) => handle),
}));

vi.mock('../../core/stealth', () => ({
  fingerprintManager: {
    listTemplates: vi.fn().mockResolvedValue([]),
  },
}));

describe('registerProfileHandlers - pool IPC lease behavior', () => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  const profileService = {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getStats: vi.fn(),
    getByName: vi.fn(),
  };

  const groupService = {
    create: vi.fn(),
    get: vi.fn(),
    listTree: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const accountService = {
    listByProfile: vi.fn(),
  };

  const viewManager = {
    getView: vi.fn(),
  };

  const windowManager = {
    findPopupIdByViewId: vi.fn(),
    getWindowById: vi.fn(),
  };

  const poolManager = {
    acquire: vi.fn(),
    release: vi.fn(),
    getStats: vi.fn(),
    listBrowsers: vi.fn().mockReturnValue([]),
    getProfileStats: vi.fn(),
    destroyBrowser: vi.fn(),
    updateConfig: vi.fn(),
    getConfig: vi.fn().mockReturnValue({}),
  };

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

    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      registeredHandlers.set(channel, handler);
    });
    (getBrowserPoolManager as Mock).mockReturnValue(poolManager);
    (attachProfileLiveSessionLease as Mock).mockImplementation((handle) => handle);
    (acquireProfileLiveSessionLease as Mock).mockResolvedValue({
      release: vi.fn().mockResolvedValue(undefined),
    });

    registerProfileHandlers(
      profileService as never,
      groupService as never,
      accountService as never,
      viewManager as never,
      windowManager as never
    );
  });

  it('wraps profile:pool-launch handles with a lease and reuses handle.release on profile:pool-release', async () => {
    const handle = {
      browserId: 'browser-1',
      sessionId: 'profile-1',
      engine: 'extension',
      browser: {},
      release: vi.fn().mockResolvedValue({
        browserId: 'browser-1',
        sessionId: 'profile-1',
        remainingBrowserCount: 0,
        state: 'idle',
      }),
    };
    poolManager.acquire.mockResolvedValue(handle);

    const launchHandler = getHandler('profile:pool-launch');
    const releaseHandler = getHandler('profile:pool-release');

    const launchResult = (await launchHandler(null, 'profile-1', {
      strategy: 'any',
      timeout: 15000,
      engine: 'extension',
    })) as { success: boolean };

    expect(launchResult.success).toBe(true);
    expect(acquireProfileLiveSessionLease).toHaveBeenCalledWith('profile-1', {
      timeoutMs: 15000,
    });
    expect(attachProfileLiveSessionLease).toHaveBeenCalledWith(
      expect.objectContaining({ browserId: 'browser-1' }),
      expect.objectContaining({ release: expect.any(Function) })
    );

    const releaseResult = (await releaseHandler(null, 'browser-1')) as { success: boolean };

    expect(releaseResult.success).toBe(true);
    expect(handle.release).toHaveBeenCalledTimes(1);
    expect(poolManager.release).not.toHaveBeenCalled();
  });

  it('releases the profile lease when profile:pool-launch fails before returning a handle', async () => {
    const lease = {
      release: vi.fn().mockResolvedValue(undefined),
    };
    (acquireProfileLiveSessionLease as Mock).mockResolvedValue(lease);
    poolManager.acquire.mockRejectedValue(new Error('acquire failed'));

    const launchHandler = getHandler('profile:pool-launch');
    const result = (await launchHandler(null, 'profile-1', {
      strategy: 'any',
      timeout: 15000,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
});
