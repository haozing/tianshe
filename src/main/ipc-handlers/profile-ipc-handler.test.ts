import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import { ipcMain } from 'electron';
import { registerProfileHandlers } from './profile-ipc-handler';
import { ipcRouteRegistry } from '../ipc-route-registry';
import { getBrowserPoolManager } from '../../core/browser-pool';
import {
  acquireProfileLiveSessionLease,
  attachProfileLiveSessionLease,
  requestProfileLiveSessionHandoff,
  completeProfileLiveSessionHandoff,
  approveProfileLiveSessionHandoff,
  getProfileLiveSessionHandoff,
  listProfileLiveSessionHandoffs,
} from '../../core/browser-pool/profile-live-session-lease';
import { buildProfileResourceKey, resourceCoordinator } from '../../core/resource-coordinator';

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
  requestProfileLiveSessionHandoff: vi.fn(),
  completeProfileLiveSessionHandoff: vi.fn(),
  approveProfileLiveSessionHandoff: vi.fn(),
  pauseProfileLiveSessionHandoff: vi.fn(),
  cancelProfileLiveSessionHandoff: vi.fn(),
  getProfileLiveSessionHandoff: vi.fn(),
  listProfileLiveSessionHandoffs: vi.fn(),
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

  const mainWindowWebContents = {
    send: vi.fn(),
  };

  const windowManager = {
    getMainWindowV3: vi.fn(() => ({ webContents: mainWindowWebContents })),
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
    mainWindowWebContents.send.mockClear();

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
    (requestProfileLiveSessionHandoff as Mock).mockResolvedValue({
      id: 'handoff-1',
      status: 'paused',
    });
    (completeProfileLiveSessionHandoff as Mock).mockResolvedValue({
      release: vi.fn().mockResolvedValue(undefined),
    });
    (getProfileLiveSessionHandoff as Mock).mockResolvedValue(null);
    (listProfileLiveSessionHandoffs as Mock).mockResolvedValue([]);
    (approveProfileLiveSessionHandoff as Mock).mockImplementation(
      async (_id: string, _options: unknown) => ({
        id: 'handoff-1',
        keys: ['profile:profile-1'],
        status: 'approved',
        requesterToken: 'agent-owner',
        requesterSource: 'mcp',
        requesterMetadata: { controllerKind: 'agent' },
        ownerToken: 'human-owner',
        ownerSource: 'ipc',
        ownerMetadata: { controllerKind: 'human' },
        ownerAcquiredAt: 100,
        reason: 'agent needs profile',
        message: null,
        createdAt: 101,
        updatedAt: 102,
        expiresAt: null,
        approvedAt: 102,
        pausedAt: null,
        completedAt: null,
        canceledAt: null,
        expiredAt: null,
        completedByToken: null,
        canceledByToken: null,
        statusReason: 'approved_by_trusted_renderer',
      })
    );

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
    expect(acquireProfileLiveSessionLease).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({
        source: 'ipc',
        timeoutMs: 15000,
        ownerMetadata: expect.objectContaining({
          controllerKind: 'human',
          interruptibility: 'non_interruptible',
        }),
      })
    );
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
    expect(requestProfileLiveSessionHandoff).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({
        source: 'ipc',
        reason: 'human_requested_agent_profile_handoff',
        autoApproveIfCurrentOwnerInterruptible: true,
      })
    );
    expect(completeProfileLiveSessionHandoff).toHaveBeenCalledWith(
      'handoff-1',
      expect.objectContaining({
        source: 'ipc',
      })
    );
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

  it('exposes trusted profile handoff controls without returning owner tokens', async () => {
    const handoffRequest = {
      id: 'handoff-1',
      keys: ['profile:profile-1'],
      status: 'requested',
      requesterToken: 'agent-owner',
      requesterSource: 'mcp',
      requesterMetadata: { controllerKind: 'agent', requestId: 'req-1' },
      ownerToken: 'human-owner',
      ownerSource: 'ipc',
      ownerMetadata: { controllerKind: 'human', traceId: 'trace-1' },
      ownerAcquiredAt: 100,
      reason: 'agent needs profile',
      message: 'Please approve takeover.',
      createdAt: 101,
      updatedAt: 101,
      expiresAt: 201,
      approvedAt: null,
      pausedAt: null,
      completedAt: null,
      canceledAt: null,
      expiredAt: null,
      completedByToken: null,
      canceledByToken: null,
      statusReason: null,
    };
    const senderGuard = vi.fn();
    ipcRouteRegistry.unregisterAll();
    registeredHandlers.clear();
    registerProfileHandlers(
      profileService as never,
      groupService as never,
      accountService as never,
      viewManager as never,
      windowManager as never,
      { senderGuard }
    );
    (listProfileLiveSessionHandoffs as Mock).mockResolvedValue([handoffRequest]);
    (getProfileLiveSessionHandoff as Mock).mockResolvedValue(handoffRequest);

    const event = { sender: {} };
    const listResult = (await getHandler('profile:handoff-list')(event, 'profile-1')) as {
      success: boolean;
      data?: Array<Record<string, unknown>>;
    };
    const approveResult = (await getHandler('profile:handoff-approve')(event, 'handoff-1', {
      reason: 'ok',
    })) as { success: boolean; data?: Record<string, unknown> };

    expect(listResult.success).toBe(true);
    expect(listResult.data?.[0]).toMatchObject({
      id: 'handoff-1',
      profileId: 'profile-1',
      status: 'requested',
      requester: {
        source: 'mcp',
        metadata: { controllerKind: 'agent', requestId: 'req-1' },
      },
      currentOwner: {
        source: 'ipc',
        metadata: { controllerKind: 'human', traceId: 'trace-1' },
      },
    });
    expect(JSON.stringify(listResult.data)).not.toContain('human-owner');
    expect(JSON.stringify(listResult.data)).not.toContain('agent-owner');
    expect(approveResult.success).toBe(true);
    expect(approveProfileLiveSessionHandoff).toHaveBeenCalledWith('handoff-1', {
      hostAuthorized: true,
      reason: 'ok',
    });
    expect(senderGuard).toHaveBeenCalledWith(event, 'profile:handoff-list');
    expect(senderGuard).toHaveBeenCalledWith(event, 'profile:handoff-approve');
  });

  it('forwards resource handoff events to the trusted renderer event channels', async () => {
    await resourceCoordinator.clear();
    const lease = await resourceCoordinator.acquire(buildProfileResourceKey('profile-1'), {
      ownerToken: 'human-owner',
      ownerSource: 'ipc',
      ownerMetadata: { controllerKind: 'human' },
    });

    const request = await resourceCoordinator.requestHandoff(buildProfileResourceKey('profile-1'), {
      requesterToken: 'agent-owner',
      requesterSource: 'mcp',
      requesterMetadata: { controllerKind: 'agent' },
      reason: 'agent needs profile',
    });

    expect(mainWindowWebContents.send).toHaveBeenCalledWith(
      'profile:handoff-changed',
      expect.objectContaining({
        type: 'handoff:requested',
        handoff: expect.objectContaining({
          id: request.id,
          profileId: 'profile-1',
          status: 'requested',
        }),
      })
    );
    expect(mainWindowWebContents.send).toHaveBeenCalledWith(
      'profile:handoff-requested',
      expect.objectContaining({
        type: 'handoff:requested',
        handoff: expect.objectContaining({ id: request.id }),
      })
    );
    expect(JSON.stringify(mainWindowWebContents.send.mock.calls)).not.toContain('human-owner');
    expect(JSON.stringify(mainWindowWebContents.send.mock.calls)).not.toContain('agent-owner');

    await lease.release();
    await resourceCoordinator.clear();
  });

  it('does not duplicate handoff forwarding when profile handlers are registered repeatedly', async () => {
    ipcRouteRegistry.unregisterAll();
    registeredHandlers.clear();
    registerProfileHandlers(
      profileService as never,
      groupService as never,
      accountService as never,
      viewManager as never,
      windowManager as never
    );
    ipcRouteRegistry.unregisterAll();
    registeredHandlers.clear();
    registerProfileHandlers(
      profileService as never,
      groupService as never,
      accountService as never,
      viewManager as never,
      windowManager as never
    );
    mainWindowWebContents.send.mockClear();

    const lease = await resourceCoordinator.acquire(buildProfileResourceKey('profile-1'), {
      ownerToken: 'human-owner',
      ownerSource: 'ipc',
      ownerMetadata: { controllerKind: 'human' },
    });

    const request = await resourceCoordinator.requestHandoff(buildProfileResourceKey('profile-1'), {
      requesterToken: 'agent-owner',
      requesterSource: 'mcp',
      requesterMetadata: { controllerKind: 'agent' },
      reason: 'agent needs profile',
    });

    expect(
      mainWindowWebContents.send.mock.calls.filter(
        ([channel]) => channel === 'profile:handoff-changed'
      )
    ).toHaveLength(1);
    expect(
      mainWindowWebContents.send.mock.calls.filter(
        ([channel]) => channel === 'profile:handoff-requested'
      )
    ).toHaveLength(1);
    expect(mainWindowWebContents.send).toHaveBeenCalledWith(
      'profile:handoff-changed',
      expect.objectContaining({
        handoff: expect.objectContaining({ id: request.id }),
      })
    );

    await lease.release();
    await resourceCoordinator.clear();
  });
});
