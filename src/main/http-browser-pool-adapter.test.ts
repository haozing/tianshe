import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserHandle, BrowserPoolManager } from '../core/browser-pool';
import { buildProfileResourceKey, resourceCoordinator } from '../core/resource-coordinator';
import type { RuntimeMetricsSnapshot } from './http-session-manager';
import {
  acquireBrowserFromPool,
  BrowserAcquireTimeoutDiagnosticsError,
} from './http-browser-pool-adapter';

const createRuntimeMetrics = (): RuntimeMetricsSnapshot => ({
  queueOverflowCount: 0,
  invokeTimeoutCount: 0,
  browserAcquireFailureCount: 0,
  browserAcquireTimeoutCount: 0,
});

const createLogger = () => ({
  debug: vi.fn(),
});

describe('http-browser-pool-adapter', () => {
  beforeEach(async () => {
    await resourceCoordinator.clear();
  });

  afterEach(async () => {
    await resourceCoordinator.clear();
  });

  it('serializes same-profile acquires until the previous handle is released', async () => {
    const firstRelease = vi.fn().mockResolvedValue(undefined);
    const secondRelease = vi.fn().mockResolvedValue(undefined);
    const firstHandle = {
      browserId: 'browser-1',
      release: firstRelease,
    } as unknown as BrowserHandle;
    const secondHandle = {
      browserId: 'browser-2',
      release: secondRelease,
    } as unknown as BrowserHandle;
    const poolManager = {
      acquire: vi.fn().mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle),
    } as unknown as BrowserPoolManager;
    const runtimeMetrics = createRuntimeMetrics();

    const acquiredFirst = await acquireBrowserFromPool({
      getBrowserPoolManager: () => poolManager,
      runtimeMetrics,
      logger: createLogger(),
      profileId: 'profile-1',
      engine: 'extension',
      source: 'mcp',
    });

    const secondAcquirePromise = acquireBrowserFromPool({
      getBrowserPoolManager: () => poolManager,
      runtimeMetrics,
      logger: createLogger(),
      profileId: 'profile-1',
      engine: 'extension',
      source: 'mcp',
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(poolManager.acquire).toHaveBeenCalledTimes(1);

    await acquiredFirst.release();

    const acquiredSecond = await secondAcquirePromise;
    expect(acquiredSecond.browserId).toBe('browser-2');
    expect(poolManager.acquire).toHaveBeenCalledTimes(2);

    await acquiredSecond.release();
  });

  it('does not serialize acquires across different profiles', async () => {
    let releaseFirstAcquire: (() => void) | null = null;
    const firstHandle = {
      browserId: 'browser-1',
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserHandle;
    const secondHandle = {
      browserId: 'browser-2',
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserHandle;
    const poolManager = {
      acquire: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<BrowserHandle>((resolve) => {
              releaseFirstAcquire = () => resolve(firstHandle);
            })
        )
        .mockResolvedValueOnce(secondHandle),
    } as unknown as BrowserPoolManager;
    const runtimeMetrics = createRuntimeMetrics();

    const firstAcquirePromise = acquireBrowserFromPool({
      getBrowserPoolManager: () => poolManager,
      runtimeMetrics,
      logger: createLogger(),
      profileId: 'profile-1',
      engine: 'extension',
      source: 'mcp',
    });

    const secondAcquirePromise = acquireBrowserFromPool({
      getBrowserPoolManager: () => poolManager,
      runtimeMetrics,
      logger: createLogger(),
      profileId: 'profile-2',
      engine: 'extension',
      source: 'mcp',
    });

    const secondAcquireOutcome = await Promise.race([
      secondAcquirePromise.then((handle) => ({ kind: 'resolved' as const, handle })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 25);
      }),
    ]);

    expect(secondAcquireOutcome).toMatchObject({
      kind: 'resolved',
      handle: expect.objectContaining({ browserId: 'browser-2' }),
    });
    expect(poolManager.acquire).toHaveBeenCalledTimes(2);

    releaseFirstAcquire?.();
    const [acquiredFirst, acquiredSecond] = await Promise.all([
      firstAcquirePromise,
      secondAcquirePromise,
    ]);

    expect(acquiredFirst.browserId).toBe('browser-1');
    expect(acquiredSecond.browserId).toBe('browser-2');

    await acquiredFirst.release();
    await acquiredSecond.release();
  });

  it('获取浏览器成功时返回 handle 并保持失败计数不变', async () => {
    const handle = {
      browserId: 'browser-1',
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserHandle;
    const poolManager = {
      acquire: vi.fn().mockResolvedValue(handle),
    } as unknown as BrowserPoolManager;
    const runtimeMetrics = createRuntimeMetrics();

    const result = await acquireBrowserFromPool({
      getBrowserPoolManager: () => poolManager,
      runtimeMetrics,
      logger: createLogger(),
      profileId: 'profile-1',
      engine: 'extension',
      source: 'http',
    });

    expect(result).toBe(handle);
    expect(poolManager.acquire).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ strategy: 'any', timeout: 30000, engine: 'extension' }),
      'http'
    );
    expect(runtimeMetrics.browserAcquireFailureCount).toBe(0);
    expect(runtimeMetrics.browserAcquireTimeoutCount).toBe(0);
  });

  it('发生 timeout 失败时增加 failure/timeout 计数', async () => {
    const poolManager = {
      acquire: vi.fn().mockRejectedValue(new Error('Acquire timeout after 30s')),
    } as unknown as BrowserPoolManager;
    const runtimeMetrics = createRuntimeMetrics();

    await acquireBrowserFromPool({
      getBrowserPoolManager: () => poolManager,
      runtimeMetrics,
      logger: createLogger(),
    }).catch((error) => {
      expect(error).toBeInstanceOf(BrowserAcquireTimeoutDiagnosticsError);
      expect(String((error as Error).message).toLowerCase()).toContain('timed out');
    });

    expect(runtimeMetrics.browserAcquireFailureCount).toBe(1);
    expect(runtimeMetrics.browserAcquireTimeoutCount).toBe(1);
  });

  it('未提供 BrowserPoolManager 时抛出明确错误', async () => {
    const runtimeMetrics = createRuntimeMetrics();

    await expect(
      acquireBrowserFromPool({
        runtimeMetrics,
        logger: createLogger(),
      })
    ).rejects.toThrow('BrowserPoolManager not available. MCP requires browser pool.');
  });

  it('surfaces profile lease contention diagnostics when the profile resource is already held', async () => {
    const heldLease = await resourceCoordinator.acquire(buildProfileResourceKey('profile-1'), {
      ownerToken: 'holder-1',
    });
    const poolManager = {
      acquire: vi.fn(),
      listBrowsers: vi.fn().mockReturnValue([
        {
          id: 'browser-held',
          sessionId: 'profile-1',
          engine: 'electron',
          status: 'locked',
          viewId: 'view-1',
          lockedBy: {
            source: 'plugin',
            pluginId: 'doudian-business-center-clue-sync',
            requestId: 'req-1',
          },
        },
      ]),
    } as unknown as BrowserPoolManager;
    const runtimeMetrics = createRuntimeMetrics();

    try {
      await acquireBrowserFromPool({
        getBrowserPoolManager: () => poolManager,
        runtimeMetrics,
        logger: createLogger(),
        profileId: 'profile-1',
        engine: 'electron',
        source: 'mcp',
        timeoutMs: 25,
      }).catch((error) => {
        expect(error).toBeInstanceOf(BrowserAcquireTimeoutDiagnosticsError);
        expect((error as BrowserAcquireTimeoutDiagnosticsError).stage).toBe('profile_lease');
        expect((error as BrowserAcquireTimeoutDiagnosticsError).diagnostics).toMatchObject({
          profileId: 'profile-1',
          browserCount: 1,
          lockedBrowserCount: 1,
          busy: true,
          browsers: [
            expect.objectContaining({
              browserId: 'browser-held',
              status: 'locked',
              source: 'plugin',
              pluginId: 'doudian-business-center-clue-sync',
            }),
          ],
        });
      });

      expect(poolManager.acquire).not.toHaveBeenCalled();
      expect(runtimeMetrics.browserAcquireFailureCount).toBe(1);
      expect(runtimeMetrics.browserAcquireTimeoutCount).toBe(1);
    } finally {
      await heldLease.release();
    }
  });

  it('allows mcp to take over a plugin-held browser and profile lease', async () => {
    const heldLease = await resourceCoordinator.acquire(buildProfileResourceKey('profile-1'), {
      ownerToken: 'holder-1',
    });
    const takeoverRelease = vi.fn().mockResolvedValue(undefined);
    const takenOverHandle = {
      browserId: 'browser-held',
      release: takeoverRelease,
    } as unknown as BrowserHandle;
    const poolManager = {
      acquire: vi.fn(),
      takeoverLockedBrowser: vi.fn().mockResolvedValue(takenOverHandle),
      listBrowsers: vi.fn().mockReturnValue([
        {
          id: 'browser-held',
          sessionId: 'profile-1',
          engine: 'electron',
          status: 'locked',
          viewId: 'view-1',
          lockedBy: {
            source: 'plugin',
            pluginId: 'doudian-business-center-clue-sync',
            requestId: 'req-1',
          },
        },
      ]),
    } as unknown as BrowserPoolManager;
    const runtimeMetrics = createRuntimeMetrics();

    const handle = await acquireBrowserFromPool({
      getBrowserPoolManager: () => poolManager,
      runtimeMetrics,
      logger: createLogger(),
      profileId: 'profile-1',
      engine: 'electron',
      source: 'mcp',
      timeoutMs: 25,
    });

    expect(handle.browserId).toBe('browser-held');
    expect((poolManager as any).takeoverLockedBrowser).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ strategy: 'any', timeout: 25, engine: 'electron' }),
      'mcp'
    );
    expect(poolManager.acquire).not.toHaveBeenCalled();

    let contenderResolved = false;
    const contenderPromise = resourceCoordinator
      .acquire(buildProfileResourceKey('profile-1'), { ownerToken: 'owner-2' })
      .then((lease) => {
        contenderResolved = true;
        return lease;
      });

    await heldLease.release();
    await Promise.resolve();
    expect(contenderResolved).toBe(false);

    await handle.release();
    expect(takeoverRelease).toHaveBeenCalledTimes(1);

    const contenderLease = await contenderPromise;
    expect(contenderResolved).toBe(true);
    await contenderLease.release();
  });

  it('allows mcp to take over a held profile lease even when no pooled browser is visible yet', async () => {
    const heldLease = await resourceCoordinator.acquire(buildProfileResourceKey('profile-1'), {
      ownerToken: 'holder-1',
    });
    const acquiredHandle = {
      browserId: 'browser-fresh',
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserHandle;
    const poolManager = {
      acquire: vi.fn().mockResolvedValue(acquiredHandle),
      listBrowsers: vi.fn().mockReturnValue([]),
    } as unknown as BrowserPoolManager;
    const runtimeMetrics = createRuntimeMetrics();

    const handle = await acquireBrowserFromPool({
      getBrowserPoolManager: () => poolManager,
      runtimeMetrics,
      logger: createLogger(),
      profileId: 'profile-1',
      engine: 'electron',
      source: 'mcp',
      timeoutMs: 25,
    });

    expect(handle.browserId).toBe('browser-fresh');
    expect(poolManager.acquire).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ strategy: 'any', timeout: 25, engine: 'electron' }),
      'mcp'
    );

    let contenderResolved = false;
    const contenderPromise = resourceCoordinator
      .acquire(buildProfileResourceKey('profile-1'), { ownerToken: 'owner-2' })
      .then((lease) => {
        contenderResolved = true;
        return lease;
      });

    await heldLease.release();
    await Promise.resolve();
    expect(contenderResolved).toBe(false);

    await handle.release();
    const contenderLease = await contenderPromise;
    expect(contenderResolved).toBe(true);
    await contenderLease.release();
  });
});
