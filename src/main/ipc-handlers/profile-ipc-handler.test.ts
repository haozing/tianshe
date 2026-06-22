import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import { ipcMain } from 'electron';
import { registerProfileHandlers } from './profile-ipc-handler';
import { ipcRouteRegistry } from '../ipc-route-registry';
import { getBrowserPoolManager } from '../../core/browser-pool';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
  takeoverProfileLiveSessionLease,
} from '../../core/browser-pool/profile-live-session-lease';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
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
  takeoverProfileLiveSessionLease: vi.fn(),
  attachProfileLiveSessionLease: vi.fn((handle) => handle),
}));

vi.mock('../../core/stealth', () => ({
  fingerprintManager: {
    listTemplates: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('registerProfileHandlers - pool IPC lease behavior', () => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const poolEvents = new EventEmitter();

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
    takeoverLockedBrowser: vi.fn(),
    getProfileStats: vi.fn(),
    destroyBrowser: vi.fn(),
    updateConfig: vi.fn(),
    getConfig: vi.fn().mockReturnValue({}),
    getEventEmitter: vi.fn(() => poolEvents),
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
    ipcRouteRegistry.unregisterAll();
    registeredHandlers.clear();
    poolEvents.removeAllListeners();

    (ipcMain.handle as Mock).mockImplementation(
      (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        registeredHandlers.set(channel, handler);
      }
    );
    (getBrowserPoolManager as Mock).mockReturnValue(poolManager);
    poolManager.getEventEmitter.mockReturnValue(poolEvents);
    (attachProfileLiveSessionLease as Mock).mockImplementation((handle) => handle);
    (acquireProfileLiveSessionLease as Mock).mockResolvedValue({
      release: vi.fn().mockResolvedValue(undefined),
    });
    (takeoverProfileLiveSessionLease as Mock).mockResolvedValue({
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
      runtimeId: 'chromium-extension-relay',
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
      runtimeId: 'chromium-extension-relay',
    })) as { success: boolean };

    expect(launchResult.success).toBe(true);
    expect(acquireProfileLiveSessionLease).toHaveBeenCalledWith('profile-1', {
      source: 'ipc',
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

  it('lets human IPC launch take over an agent-held profile instead of waiting behind MCP', async () => {
    const handle = {
      browserId: 'browser-agent-held',
      sessionId: 'profile-1',
      runtimeId: 'electron-webcontents',
      browser: {},
      release: vi.fn().mockResolvedValue({
        browserId: 'browser-agent-held',
        sessionId: 'profile-1',
        remainingBrowserCount: 0,
        state: 'idle',
      }),
    };
    poolManager.listBrowsers.mockReturnValue([
      {
        id: 'browser-agent-held',
        sessionId: 'profile-1',
        runtimeId: 'electron-webcontents',
        status: 'locked',
        lockedBy: {
          source: 'mcp',
          requestId: 'agent-request',
        },
      },
    ]);
    poolManager.takeoverLockedBrowser.mockResolvedValue(handle);

    const launchHandler = getHandler('profile:pool-launch');
    const launchResult = (await launchHandler(null, 'profile-1', {
      strategy: 'any',
      timeout: 15000,
      runtimeId: 'electron-webcontents',
    })) as { success: boolean; data?: { browserId?: string } };

    expect(launchResult).toMatchObject({
      success: true,
      data: {
        browserId: 'browser-agent-held',
      },
    });
    expect(acquireProfileLiveSessionLease).not.toHaveBeenCalled();
    expect(takeoverProfileLiveSessionLease).toHaveBeenCalledWith('profile-1', { source: 'ipc' });
    expect(poolManager.acquire).not.toHaveBeenCalled();
    expect(poolManager.takeoverLockedBrowser).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({
        strategy: 'any',
        timeout: 15000,
        runtimeId: 'electron-webcontents',
        browserId: 'browser-agent-held',
      }),
      'ipc',
      undefined
    );
    expect(attachProfileLiveSessionLease).toHaveBeenCalledWith(
      expect.objectContaining({ browserId: 'browser-agent-held' }),
      expect.objectContaining({ release: expect.any(Function) })
    );
  });
});
