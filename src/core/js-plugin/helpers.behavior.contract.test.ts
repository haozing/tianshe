import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseNamespace } from './namespaces/database';
import { ProfileNamespace } from './namespaces/profile';
import type { BrowserCapabilityName } from '../../types/browser-interface';
import {
  browserRuntimeSupports,
  getStaticEngineRuntimeDescriptor,
} from '../browser-pool/engine-capability-registry';

const mockPoolManager = {
  getStats: vi.fn(),
  getWaitQueueStats: vi.fn(),
  acquire: vi.fn(),
  listBrowsers: vi.fn(),
};

const mockShowBrowserView = vi.fn();
const mockHideBrowserView = vi.fn();
const mockShowBrowserViewInPopup = vi.fn();
const mockCloseBrowserPopup = vi.fn();

vi.mock('../browser-pool', () => ({
  getBrowserPoolManager: () => mockPoolManager,
  showBrowserView: (...args: unknown[]) => mockShowBrowserView(...args),
  hideBrowserView: (...args: unknown[]) => mockHideBrowserView(...args),
  showBrowserViewInPopup: (...args: unknown[]) => mockShowBrowserViewInPopup(...args),
  closeBrowserPopup: (...args: unknown[]) => mockCloseBrowserPopup(...args),
}));

describe('helpers behavior contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('helpers.profile.launch/release 保持池化释放语义稳定', async () => {
    mockPoolManager.getStats.mockResolvedValue({
      totalBrowsers: 1,
      idleBrowsers: 1,
      lockedBrowsers: 0,
    });
    mockPoolManager.getWaitQueueStats.mockReturnValue({ totalWaiting: 0 });
    mockShowBrowserView.mockReturnValue(true);

    const runtime = getStaticEngineRuntimeDescriptor('electron');
    const browser = {
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
    const originalRelease = vi.fn().mockResolvedValue({
      sessionId: 'profile-1',
      remainingBrowserCount: 1,
      destroyed: false,
    });

    mockPoolManager.acquire.mockResolvedValue({
      browser,
      browserId: 'browser-1',
      sessionId: 'profile-1',
      engine: 'electron',
      viewId: 'pool:profile-1:1',
      release: originalRelease,
      renew: vi.fn(),
    });

    const ns = new ProfileNamespace(
      'contract-plugin',
      {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        isAvailable: vi.fn(),
        getStats: vi.fn(),
        updateStatus: vi.fn(),
      } as any,
      { listTree: vi.fn() } as any,
      {} as any,
      {} as any,
      vi.fn().mockResolvedValue(undefined)
    );

    const handle = await ns.launch('profile-1', {
      visible: true,
      visibleLayout: 'right-docked',
    });
    await handle.release({ destroy: false });

    expect(handle.browser.describeRuntime()).toMatchObject({
      engine: 'electron',
    });
    expect(handle.browser.hasCapability('cookies.filter')).toBe(true);
    expect(() => (handle.browser as any).session).toThrowError(/browser\.session is not available/i);
    expect(() => (handle.browser as any).cdp).toThrowError(/browser\.cdp is not available/i);
    expect(() => (handle.browser as any).capture).toThrowError(/browser\.capture is not available/i);

    expect(mockPoolManager.acquire).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ strategy: 'any', timeout: 30000 }),
      'internal',
      'contract-plugin'
    );
    expect(mockShowBrowserView).toHaveBeenCalledTimes(1);
    expect(originalRelease).toHaveBeenCalledTimes(1);

    const hideOrder = mockHideBrowserView.mock.invocationCallOrder.at(-1) || 0;
    const releaseOrder = originalRelease.mock.invocationCallOrder[0] || 0;
    expect(hideOrder).toBeGreaterThan(0);
    expect(releaseOrder).toBeGreaterThan(0);
    expect(hideOrder).toBeLessThan(releaseOrder);
  });

  it('helpers.profile.launchPopup 保持 extension 外部窗口语义稳定', async () => {
    mockPoolManager.getStats.mockResolvedValue({
      totalBrowsers: 1,
      idleBrowsers: 1,
      lockedBrowsers: 0,
    });
    mockPoolManager.getWaitQueueStats.mockReturnValue({ totalWaiting: 0 });

    const onClose = vi.fn();
    const runtime = getStaticEngineRuntimeDescriptor('extension');
    const browser = {
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

    mockPoolManager.acquire.mockResolvedValue({
      browser,
      browserId: 'browser-extension',
      sessionId: 'profile-extension',
      engine: 'extension',
      release: vi.fn().mockResolvedValue({
        sessionId: 'profile-extension',
        remainingBrowserCount: 0,
        destroyed: false,
      }),
      renew: vi.fn(),
    });

    const ns = new ProfileNamespace(
      'contract-plugin',
      {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        isAvailable: vi.fn(),
        getStats: vi.fn(),
        updateStatus: vi.fn(),
      } as any,
      { listTree: vi.fn() } as any,
      {} as any,
      {} as any,
      vi.fn().mockResolvedValue(undefined)
    );

    const handle = await ns.launchPopup('profile-extension', {
      url: 'https://example.com/login',
      title: 'ignored-for-extension',
      onClose,
    });

    expect(handle.popupId).toBe('external:browser-extension');
    expect(handle.browser.describeRuntime()).toMatchObject({ engine: 'extension' });
    expect(handle.browser.hasCapability('network.responseBody')).toBe(true);
    expect(browser.show).toHaveBeenCalledTimes(1);
    expect(mockShowBrowserViewInPopup).not.toHaveBeenCalled();

    handle.closePopup();
    await Promise.resolve();
    await Promise.resolve();

    expect(browser.hide).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCloseBrowserPopup).not.toHaveBeenCalled();
  });

  it('helpers.database.executeSQL 保持参数校验与错误包装语义稳定', async () => {
    const executeSQLWithParams = vi.fn().mockRejectedValue(new Error('duckdb failure'));
    const db = new DatabaseNamespace(
      {
        executeSQLWithParams,
      } as any,
      'contract-plugin'
    );

    await expect(db.executeSQL(123 as unknown as string)).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'VALIDATION_ERROR',
    });

    await expect(db.executeSQL('SELECT 1')).rejects.toMatchObject({
      name: 'DatabaseError',
      code: 'DATABASE_ERROR',
      details: expect.objectContaining({
        operation: 'executeSQL',
      }),
    });
  });
});
