import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserCapabilityName } from '../../../types/browser-interface';
import {
  browserRuntimeSupports,
  getStaticEngineRuntimeDescriptor,
} from '../../browser-pool/engine-capability-registry';

const mockPoolManager = {
  getStats: vi.fn(),
  getWaitQueueStats: vi.fn(),
  acquire: vi.fn(),
  adoptSamePluginLockedBrowser: vi.fn(),
  listBrowsers: vi.fn(),
};

vi.mock('../../browser-pool', () => ({
  getBrowserPoolManager: () => mockPoolManager,
  showBrowserView: vi.fn(),
  hideBrowserView: vi.fn(),
  showBrowserViewInPopup: vi.fn(),
  closeBrowserPopup: vi.fn(),
}));

import { buildProfileResourceKey, resourceCoordinator } from '../../resource-coordinator';
import { ProfileNamespace } from './profile';

function createNamespace(profileOverrides: Record<string, unknown> = {}) {
  const profileService = {
    list: vi.fn(),
    get: vi.fn().mockResolvedValue({
      id: 'p1',
      lockTimeoutMs: 40000,
      ...profileOverrides,
    }),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    isAvailable: vi.fn(),
    getStats: vi.fn(),
    updateStatus: vi.fn(),
  } as any;

  const groupService = {
    listTree: vi.fn(),
  } as any;

  return {
    namespace: new ProfileNamespace(
      'test-plugin',
      profileService,
      groupService,
      {} as any,
      {} as any,
      vi.fn().mockResolvedValue(undefined)
    ),
    profileService,
  };
}

function createBrowserMock(engine: 'electron' | 'extension' = 'electron') {
  const runtime = getStaticEngineRuntimeDescriptor(engine);
  return {
    goto: vi.fn(),
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    describeRuntime: vi.fn().mockReturnValue(runtime),
    hasCapability: vi.fn((name: BrowserCapabilityName) => browserRuntimeSupports(runtime, name)),
    getCookies: vi.fn().mockResolvedValue([]),
    setCookie: vi.fn().mockResolvedValue(undefined),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    getUserAgent: vi.fn().mockResolvedValue('ua'),
  };
}

describe('ProfileNamespace.withLease', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    await resourceCoordinator.clear();
    mockPoolManager.adoptSamePluginLockedBrowser.mockResolvedValue(null);
    mockPoolManager.getStats.mockResolvedValue({
      totalBrowsers: 1,
      idleBrowsers: 1,
      lockedBrowsers: 0,
    });
    mockPoolManager.getWaitQueueStats.mockReturnValue({ totalWaiting: 0 });
    mockPoolManager.listBrowsers.mockReturnValue([]);
  });

  afterEach(async () => {
    await resourceCoordinator.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('auto-renews the handle and releases to about:blank by default', async () => {
    const renew = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const browser = createBrowserMock('electron');
    mockPoolManager.acquire.mockResolvedValue({
      browser,
      browserId: 'browser-1',
      sessionId: 'p1',
      engine: 'electron',
      release,
      renew,
    });

    const { namespace } = createNamespace();
    const resultPromise = namespace.withLease('p1', undefined, async (ctx) => {
      expect(ctx.browserId).toBe('browser-1');
      expect(ctx.browser.describeRuntime()).toMatchObject({ engine: 'electron' });
      expect(() => (ctx.browser as any).session).toThrowError(/browser\.session is not available/i);
      await vi.advanceTimersByTimeAsync(20000);
      return 'ok';
    });

    await expect(resultPromise).resolves.toBe('ok');
    expect(renew).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ navigateTo: 'about:blank' });
  });

  it('does not reacquire the resource when the current context already holds the profile key', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    mockPoolManager.acquire.mockResolvedValue({
      browser: {},
      browserId: 'browser-2',
      sessionId: 'p1',
      engine: 'electron',
      release,
      renew: vi.fn(),
    });

    const { namespace } = createNamespace();
    const runExclusiveSpy = vi.spyOn(resourceCoordinator, 'runExclusive');
    const context = {
      ownerToken: 'scheduler-owner',
      heldKeys: new Set([buildProfileResourceKey('p1')]),
      profileLeases: new Map(),
    };

    const result = await resourceCoordinator.runWithContext(context, async () => {
      return await namespace.withLease(
        'p1',
        {
          autoRenew: false,
        },
        async (ctx) => ctx.browserId
      );
    });

    expect(result).toBe('browser-2');
    expect(runExclusiveSpy).not.toHaveBeenCalled();
    expect(mockPoolManager.acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ navigateTo: 'about:blank' });
  });

  it('reuses an existing in-context profile lease without launching again', async () => {
    const existingRelease = vi.fn().mockResolvedValue(undefined);
    const existingLease = {
      handle: {
        browser: { goto: vi.fn() },
        browserId: 'existing-browser',
        sessionId: 'p1',
        engine: 'electron',
        release: existingRelease,
        renew: vi.fn(),
      },
      refCount: 0,
      renewTimer: null,
    };

    const { namespace } = createNamespace();
    const context = {
      ownerToken: 'owner-1',
      heldKeys: new Set([buildProfileResourceKey('p1')]),
      profileLeases: new Map([['p1', existingLease]]),
    };

    const result = await resourceCoordinator.runWithContext(context, async () => {
      return await namespace.withLease(
        'p1',
        {
          autoRenew: false,
        },
        async (ctx) => ctx.browserId
      );
    });

    expect(result).toBe('existing-browser');
    expect(existingLease.refCount).toBe(0);
    expect(mockPoolManager.acquire).not.toHaveBeenCalled();
    expect(existingRelease).not.toHaveBeenCalled();
  });

  it('passes the abort signal through to pool acquire', async () => {
    const controller = new AbortController();
    const release = vi.fn().mockResolvedValue(undefined);
    mockPoolManager.acquire.mockResolvedValue({
      browser: {},
      browserId: 'browser-3',
      sessionId: 'p1',
      engine: 'electron',
      release,
      renew: vi.fn(),
    });

    const { namespace } = createNamespace();
    await namespace.withLease(
      'p1',
      {
        autoRenew: false,
        signal: controller.signal,
      },
      async () => 'ok'
    );

    expect(mockPoolManager.acquire).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        signal: controller.signal,
      }),
      'internal',
      'test-plugin'
    );
  });

  it('preserves extension engine context for non-Electron leases', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const browser = createBrowserMock('extension');
    const show = browser.show;
    const hide = browser.hide;
    mockPoolManager.acquire.mockResolvedValue({
      browser,
      browserId: 'browser-ext',
      sessionId: 'p1',
      engine: 'extension',
      release,
      renew: vi.fn(),
    });

    const { namespace } = createNamespace({ engine: 'extension' });
    const result = await namespace.withLease(
      'p1',
      {
        autoRenew: false,
        visible: true,
      },
      async (ctx) => {
        expect(ctx.browserId).toBe('browser-ext');
        expect(ctx.engine).toBe('extension');
        expect(ctx.viewId).toBeUndefined();
        expect(ctx.browser.describeRuntime()).toMatchObject({ engine: 'extension' });
        expect(ctx.browser.hasCapability('network.responseBody')).toBe(true);
        return 'ok';
      }
    );

    expect(result).toBe('ok');
    expect(show).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ navigateTo: 'about:blank' });
  });

  it('launch holds the profile lease until the returned handle is released', async () => {
    const firstRelease = vi.fn().mockResolvedValue(undefined);
    const secondRelease = vi.fn().mockResolvedValue(undefined);
    mockPoolManager.acquire
      .mockResolvedValueOnce({
        browser: createBrowserMock('electron'),
        browserId: 'browser-lease-1',
        sessionId: 'p1',
        engine: 'electron',
        viewId: 'view-1',
        release: firstRelease,
        renew: vi.fn(),
      })
      .mockResolvedValueOnce({
        browser: createBrowserMock('electron'),
        browserId: 'browser-lease-2',
        sessionId: 'p1',
        engine: 'electron',
        viewId: 'view-2',
        release: secondRelease,
        renew: vi.fn(),
      });

    const { namespace } = createNamespace();
    const firstHandle = await namespace.launch('p1');
    const secondHandlePromise = namespace.launch('p1');

    await Promise.resolve();
    await Promise.resolve();
    expect(mockPoolManager.acquire).toHaveBeenCalledTimes(1);

    await firstHandle.release();

    const secondHandle = await secondHandlePromise;
    expect(secondHandle.browserId).toBe('browser-lease-2');
    expect(mockPoolManager.acquire).toHaveBeenCalledTimes(2);

    await secondHandle.release();
  });
});
