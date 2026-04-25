import { describe, expect, it, vi } from 'vitest';
import type { BrowserHandle } from '../core/browser-pool';
import { ErrorCode } from '../types/error-codes';
import {
  createMcpSessionGateway,
  ensureSessionBrowserHandle,
  shouldRecycleSessionBrowser,
} from './mcp-http-session-runtime';
import { BrowserAcquireTimeoutDiagnosticsError } from './http-browser-pool-adapter';
import type { McpSessionInfo, McpSessionRuntimeOptions } from './mcp-http-types';

function createBrowserHandle(options?: {
  browserId?: string;
  isClosed?: boolean;
}): BrowserHandle {
  const isClosed = options?.isClosed === true;
  return {
    browserId: options?.browserId || 'browser-1',
    browser: {
      isClosed: vi.fn().mockReturnValue(isClosed),
      hide: vi.fn().mockResolvedValue(undefined),
    },
    release: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserHandle;
}

function createSession(overrides: Partial<McpSessionInfo> = {}): McpSessionInfo {
  return {
    sessionId: 'session-1',
    transport: {} as never,
    lastActivity: Date.now(),
    invokeQueue: Promise.resolve(),
    pendingInvocations: 0,
    activeInvocations: 0,
    maxQueueSize: 64,
    visible: false,
    ...overrides,
  };
}

function createOptions(
  transports: Map<string, McpSessionInfo>,
  acquireBrowserFromPool: McpSessionRuntimeOptions['acquireBrowserFromPool'],
  getBrowserPoolManager?: McpSessionRuntimeOptions['getBrowserPoolManager']
): McpSessionRuntimeOptions {
  return {
    transports,
    dependencies: undefined,
    parseRequestedEngine: vi.fn(),
    acquireBrowserFromPool,
    getBrowserPoolManager,
    cleanupSession: vi.fn().mockResolvedValue(undefined),
  };
}

describe('mcp session runtime', () => {
  it('recycles session browsers for generic closed-browser errors', () => {
    expect(
      shouldRecycleSessionBrowser({
        code: 'OPERATION_FAILED',
        message: 'Browser has been closed',
      })
    ).toBe(true);
  });

  it('listSessions reports stale browser handles as unavailable', async () => {
    const staleHandle = createBrowserHandle({ browserId: 'stale-handle', isClosed: true });
    const session = createSession({ browserHandle: staleHandle });
    const transports = new Map<string, McpSessionInfo>([['session-1', session]]);
    const gateway = createMcpSessionGateway(
      createOptions(transports, vi.fn()),
      session
    );

    const sessions = await gateway.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.browserAcquired).toBe(false);
    expect(sessions[0]?.browserAcquireInProgress).toBe(false);
    expect(sessions[0]?.hasBrowserHandle).toBe(false);
  });

  it('listSessions includes acquire readiness for bound profiles', async () => {
    const session = createSession({ partition: 'profile-1', engine: 'electron' as never });
    const transports = new Map<string, McpSessionInfo>([['session-1', session]]);
    const gateway = createMcpSessionGateway(
      createOptions(transports, vi.fn(), vi.fn().mockReturnValue({
        listBrowsers: vi.fn().mockReturnValue([
          {
            id: 'browser-held',
            sessionId: 'profile-1',
            engine: 'electron',
            status: 'locked',
            viewId: 'view-1',
            lockedBy: {
              source: 'plugin',
              pluginId: 'plugin-1',
              requestId: 'req-1',
            },
          },
        ]),
      })),
      session
    );

    const sessions = await gateway.listSessions();

    expect(sessions[0]).toMatchObject({
      sessionId: 'session-1',
      acquireReadiness: {
        profileId: 'profile-1',
        browserCount: 1,
        lockedBrowserCount: 1,
        busy: true,
      },
    });
  });

  it('ensureSessionBrowserHandle discards stale handles and reacquires a fresh browser', async () => {
    const staleHandle = createBrowserHandle({ browserId: 'stale-handle', isClosed: true });
    const freshHandle = createBrowserHandle({ browserId: 'fresh-handle', isClosed: false });
    const acquireBrowserFromPool = vi.fn().mockResolvedValue(freshHandle);
    const session = createSession({ browserHandle: staleHandle });
    const transports = new Map<string, McpSessionInfo>([['session-1', session]]);

    const handle = await ensureSessionBrowserHandle(
      createOptions(transports, acquireBrowserFromPool),
      session
    );

    expect((staleHandle.release as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ destroy: true });
    expect(acquireBrowserFromPool).toHaveBeenCalledTimes(1);
    expect(handle).toBe(freshHandle);
    expect(session.browserHandle).toBe(freshHandle);
  });

  it('ensureSessionBrowserHandle attaches hidden MCP sessions to a dedicated automation host', async () => {
    const hiddenWindowId = 'hidden-host-session-1';
    const freshHandle = {
      ...createBrowserHandle({ browserId: 'fresh-handle', isClosed: false }),
      viewId: 'view-1',
    } as BrowserHandle;
    const acquireBrowserFromPool = vi.fn().mockResolvedValue(freshHandle);
    const session = createSession();
    const transports = new Map<string, McpSessionInfo>([['session-1', session]]);
    const hiddenWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      getContentBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1440, height: 960 }),
    };
    const viewInfo = {
      attachedTo: undefined,
      bounds: undefined as { x: number; y: number; width: number; height: number } | undefined,
      metadata: { displayMode: 'offscreen' },
    };
    const attachView = vi.fn().mockImplementation(
      (_viewId: string, windowId: string, bounds: { x: number; y: number; width: number; height: number }) => {
        viewInfo.attachedTo = windowId;
        viewInfo.bounds = bounds;
      }
    );
    const options: McpSessionRuntimeOptions = {
      transports,
      parseRequestedEngine: vi.fn(),
      acquireBrowserFromPool,
      cleanupSession: vi.fn().mockResolvedValue(undefined),
      dependencies: {
        windowManager: {
          createHiddenAutomationHost: vi.fn().mockReturnValue(hiddenWindow),
          getHiddenAutomationHost: vi.fn().mockReturnValue(undefined),
          getWindowById: vi.fn().mockImplementation((windowId: string) => {
            if (windowId === hiddenWindowId) {
              return hiddenWindow;
            }
            return undefined;
          }),
        },
        viewManager: {
          getActivityBarWidth: vi.fn().mockReturnValue(0),
          getView: vi.fn().mockReturnValue(viewInfo),
          attachView,
          detachView: vi.fn(),
          updateBounds: vi.fn(),
          setViewDisplayMode: vi.fn().mockImplementation(
            (_viewId: string, displayMode: string) => {
              viewInfo.metadata.displayMode = displayMode;
            }
          ),
          setViewSource: vi.fn(),
          setRightDockedPoolView: vi.fn(),
        },
      },
    };

    const handle = await ensureSessionBrowserHandle(options, session);

    expect(acquireBrowserFromPool).toHaveBeenCalledTimes(1);
    expect(options.dependencies?.windowManager.createHiddenAutomationHost).toHaveBeenCalledWith(
      'session-1'
    );
    expect(options.dependencies?.viewManager.attachView).toHaveBeenCalledWith(
      'view-1',
      hiddenWindowId,
      expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) })
    );
    expect(handle).toBe(freshHandle);
    expect(session.hostWindowId).toBe(hiddenWindowId);
    expect(session.viewportHealth).toBe('ready');
    expect(session.interactionReady).toBe(true);
    expect(session.offscreenDetected).toBe(false);

    const gateway = createMcpSessionGateway(options, session);
    const sessions = await gateway.listSessions();
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-1',
      browserAcquired: true,
      browserAcquireInProgress: false,
      hasBrowserHandle: true,
      hostWindowId: hiddenWindowId,
      viewportHealth: 'ready',
      interactionReady: true,
      offscreenDetected: false,
    });
  });

  it('treats browser handles without managed views as interaction-ready after acquisition', async () => {
    const handle = createBrowserHandle({ browserId: 'extension-handle', isClosed: false });
    const acquireBrowserFromPool = vi.fn().mockResolvedValue(handle);
    const session = createSession();
    const transports = new Map<string, McpSessionInfo>([['session-1', session]]);
    const options = createOptions(transports, acquireBrowserFromPool);

    await ensureSessionBrowserHandle(options, session);

    expect(session.browserHandle).toBe(handle);
    expect(session.viewportHealth).toBe('unknown');
    expect(session.viewportHealthReason).toBe('browser implementation manages visibility directly');
    expect(session.interactionReady).toBe(true);

    const gateway = createMcpSessionGateway(options, session);
    const interaction = await gateway.ensureCurrentSessionInteractionReady?.();

    expect(interaction).toMatchObject({
      sessionId: 'session-1',
      visible: false,
      viewportHealth: 'unknown',
      viewportHealthReason: 'browser implementation manages visibility directly',
      interactionReady: true,
      offscreenDetected: false,
      repaired: false,
      browserAcquired: true,
    });

    const sessions = await gateway.listSessions();
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-1',
      browserAcquired: true,
      browserAcquireInProgress: false,
      hasBrowserHandle: true,
      viewportHealth: 'unknown',
      interactionReady: true,
      offscreenDetected: false,
    });
  });

  it('prepareCurrentSession applies profile, engine, visibility, and scopes before browser acquisition', async () => {
    const session = createSession({ authScopes: ['browser.read'] });
    const transports = new Map<string, McpSessionInfo>([['session-1', session]]);
    const options: McpSessionRuntimeOptions = {
      transports,
      dependencies: undefined,
      parseRequestedEngine: vi.fn((value?: string) => value as never),
      acquireBrowserFromPool: vi.fn(),
      getBrowserPoolManager: vi.fn().mockReturnValue({
        listBrowsers: vi.fn().mockReturnValue([
          {
            id: 'browser-held',
            sessionId: 'profile-1',
            engine: 'extension',
            status: 'locked',
            viewId: 'view-1',
            lockedBy: {
              source: 'plugin',
              pluginId: 'plugin-1',
              requestId: 'req-1',
            },
          },
        ]),
      }),
      cleanupSession: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = createMcpSessionGateway(options, session);

    const prepared = await gateway.prepareCurrentSession?.({
      profileId: 'profile-1',
      engine: 'extension',
      visible: true,
      scopes: ['browser.read', 'browser.write'],
    });

    expect(prepared).toMatchObject({
      sessionId: 'session-1',
      prepared: true,
      idempotent: false,
      profileId: 'profile-1',
      engine: 'extension',
      visible: true,
      effectiveScopes: ['browser.read', 'browser.write'],
      browserAcquired: false,
      acquireReadiness: {
        profileId: 'profile-1',
        browserCount: 1,
        lockedBrowserCount: 1,
        busy: true,
      },
      phase: 'prepared_unacquired',
      bindingLocked: false,
      changed: ['profile', 'engine', 'visible', 'scopes'],
    });

    const replay = await gateway.prepareCurrentSession?.({
      profileId: 'profile-1',
      engine: 'extension',
      visible: true,
      scopes: ['browser.read', 'browser.write'],
    });

    expect(replay).toMatchObject({
      prepared: true,
      idempotent: true,
      acquireReadiness: expect.objectContaining({
        profileId: 'profile-1',
        busy: true,
      }),
      phase: 'prepared_unacquired',
      bindingLocked: false,
      changed: [],
    });
  });

  it('prepareCurrentSession allows scope updates after browser acquisition but rejects conflicting profile changes', async () => {
    const session = createSession({
      partition: 'profile-1',
      engine: 'electron' as never,
      visible: false,
      authScopes: ['browser.read'],
      browserHandle: createBrowserHandle({ isClosed: false }),
    });
    const transports = new Map<string, McpSessionInfo>([['session-1', session]]);
    const options: McpSessionRuntimeOptions = {
      transports,
      dependencies: undefined,
      parseRequestedEngine: vi.fn((value?: string) => value as never),
      acquireBrowserFromPool: vi.fn(),
      cleanupSession: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = createMcpSessionGateway(options, session);

    const scopeUpdate = await gateway.prepareCurrentSession?.({
      profileId: 'profile-1',
      engine: 'electron',
      visible: false,
      scopes: ['browser.read', 'browser.write'],
    });

    expect(scopeUpdate).toMatchObject({
      prepared: true,
      idempotent: false,
      browserAcquired: true,
      phase: 'bound_browser',
      bindingLocked: true,
      effectiveScopes: ['browser.read', 'browser.write'],
      changed: ['scopes'],
    });

    const conflict = await gateway.prepareCurrentSession?.({
      profileId: 'profile-2',
    });

    expect(conflict).toMatchObject({
      prepared: false,
      reason: 'binding_locked',
      currentProfileId: 'profile-1',
      browserAcquired: true,
      phase: 'bound_browser',
      bindingLocked: true,
    });
  });

  it('closeSession marks the current session as closing before response-flush cleanup', async () => {
    const session = createSession();
    const transports = new Map<string, McpSessionInfo>([['session-1', session]]);
    const gateway = createMcpSessionGateway(createOptions(transports, vi.fn()), session);

    const result = await gateway.closeSession('session-1', { allowCurrent: true });

    expect(result).toMatchObject({
      closed: true,
      closedCurrentSession: true,
      transportInvalidated: true,
      allowFurtherCallsOnSameTransport: false,
      terminationTiming: 'after_response_flush',
    });
    expect(session.closing).toBe(true);
    expect(session.terminateAfterResponse).toBe(true);
    expect(session.closeReason).toMatchObject({
      code: 'OPERATION_FAILED',
      context: expect.objectContaining({ reason: 'session_closing' }),
    });
  });

  it('ensureSessionBrowserHandle translates acquire contention into a structured MCP error', async () => {
    const session = createSession({
      partition: 'profile-1',
      engine: 'electron' as never,
    });
    const transports = new Map<string, McpSessionInfo>([['session-1', session]]);
    const options = createOptions(
      transports,
      vi.fn().mockRejectedValue(
        new BrowserAcquireTimeoutDiagnosticsError('Acquire timeout after 30s', {
          stage: 'profile_lease',
          diagnostics: {
            profileId: 'profile-1',
            browserCount: 1,
            lockedBrowserCount: 1,
            creatingBrowserCount: 0,
            idleBrowserCount: 0,
            destroyingBrowserCount: 0,
            busy: true,
            browsers: [
              {
                browserId: 'browser-held',
                status: 'locked',
                engine: 'electron',
                source: 'plugin',
                pluginId: 'plugin-1',
                requestId: 'req-1',
                viewId: 'view-1',
              },
            ],
          },
        })
      )
    );

    await expect(ensureSessionBrowserHandle(options, session)).rejects.toMatchObject({
      code: ErrorCode.ACQUIRE_TIMEOUT,
      reasonCode: 'profile_resource_busy',
      context: expect.objectContaining({
        profileId: 'profile-1',
        acquireReadiness: expect.objectContaining({
          busy: true,
          lockedBrowserCount: 1,
        }),
      }),
    });
  });
});
