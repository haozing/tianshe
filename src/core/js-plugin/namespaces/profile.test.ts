import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPoolManager = {
  getStats: vi.fn(),
  getWaitQueueStats: vi.fn(),
  acquire: vi.fn(),
  adoptSamePluginLockedBrowser: vi.fn(),
  listBrowsers: vi.fn(),
};

const mockShowBrowserView = vi.fn();
const mockHideBrowserView = vi.fn();
const mockShowBrowserViewInPopup = vi.fn();
const mockCloseBrowserPopup = vi.fn();

vi.mock('../../browser-pool', () => ({
  getBrowserPoolManager: () => mockPoolManager,
  showBrowserView: (...args: unknown[]) => mockShowBrowserView(...args),
  hideBrowserView: (...args: unknown[]) => mockHideBrowserView(...args),
  showBrowserViewInPopup: (...args: unknown[]) => mockShowBrowserViewInPopup(...args),
  closeBrowserPopup: (...args: unknown[]) => mockCloseBrowserPopup(...args),
}));

import { ProfileNamespace } from './profile';
import { buildProfileResourceKey, resourceCoordinator } from '../../resource-coordinator';

describe('ProfileNamespace.launch visibility behavior', () => {
  function createNamespace() {
    const profileService = {
      list: vi.fn(),
      get: vi.fn(),
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

    return new ProfileNamespace(
      'test-plugin',
      profileService,
      groupService,
      {} as any,
      {} as any,
      vi.fn().mockResolvedValue(undefined)
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await resourceCoordinator.clear();
    mockPoolManager.adoptSamePluginLockedBrowser.mockResolvedValue(null);
    mockPoolManager.getStats.mockResolvedValue({
      totalBrowsers: 1,
      idleBrowsers: 1,
      lockedBrowsers: 0,
    });
    mockPoolManager.getWaitQueueStats.mockReturnValue({ totalWaiting: 0 });
    mockShowBrowserView.mockReturnValue(true);
  });

  afterEach(async () => {
    await resourceCoordinator.clear();
  });

  it('wraps show/hide/release for electron view handles', async () => {
    const browser = {
      goto: vi.fn(),
      show: vi.fn().mockResolvedValue(undefined),
      hide: vi.fn().mockResolvedValue(undefined),
    };
    const originalRelease = vi.fn().mockResolvedValue({
      sessionId: 'p1',
      remainingBrowserCount: 1,
      destroyed: false,
    });

    mockPoolManager.acquire.mockResolvedValue({
      browser,
      browserId: 'browser-1',
      sessionId: 'p1',
      engine: 'electron',
      viewId: 'pool:p1:1',
      release: originalRelease,
      renew: vi.fn(),
    });

    const ns = createNamespace();
    const handle = await ns.launch('p1', {
      visible: true,
      visibleLayout: 'right-docked',
      rightDockSize: '35%',
      url: 'https://example.com/',
    });

    expect(browser.goto).toHaveBeenCalledWith('https://example.com/');
    expect(mockShowBrowserView).toHaveBeenCalledWith(
      'pool:p1:1',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        layout: 'docked-right',
        rightDockSize: '35%',
      })
    );

    await handle.browser.hide?.();
    expect(mockHideBrowserView).toHaveBeenCalledWith('pool:p1:1', expect.anything());

    await handle.browser.show?.();
    expect(mockShowBrowserView).toHaveBeenCalledTimes(2);

    await handle.release({ destroy: false });
    expect(mockHideBrowserView).toHaveBeenCalledTimes(2);
    expect(originalRelease).toHaveBeenCalledWith({ destroy: false });
  });

  it('hides by default when visible is not set', async () => {
    const browser = {
      goto: vi.fn(),
      show: vi.fn().mockResolvedValue(undefined),
      hide: vi.fn().mockResolvedValue(undefined),
    };

    mockPoolManager.acquire.mockResolvedValue({
      browser,
      browserId: 'browser-2',
      sessionId: 'p2',
      engine: 'electron',
      viewId: 'pool:p2:1',
      release: vi.fn().mockResolvedValue({
        sessionId: 'p2',
        remainingBrowserCount: 1,
        destroyed: false,
      }),
      renew: vi.fn(),
    });

    const ns = createNamespace();
    await ns.launch('p2');

    expect(mockHideBrowserView).toHaveBeenCalledWith('pool:p2:1', expect.anything());
    expect(mockShowBrowserView).not.toHaveBeenCalled();
  });

  it('uses direct browser show/hide for extension handles without a view', async () => {
    const show = vi.fn().mockResolvedValue(undefined);
    const hide = vi.fn().mockResolvedValue(undefined);
    const browser = {
      goto: vi.fn(),
      show,
      hide,
    };
    const originalRelease = vi.fn().mockResolvedValue({
      sessionId: 'p3',
      remainingBrowserCount: 0,
      destroyed: true,
    });

    mockPoolManager.acquire.mockResolvedValue({
      browser,
      browserId: 'browser-3',
      sessionId: 'p3',
      engine: 'extension',
      release: originalRelease,
      renew: vi.fn(),
    });

    const ns = createNamespace();
    const handle = await ns.launch('p3', {
      visible: true,
      visibleLayout: 'fullscreen',
      rightDockSize: '40%',
    });

    expect(show).toHaveBeenCalledTimes(1);
    expect(mockShowBrowserView).not.toHaveBeenCalled();
    expect(mockHideBrowserView).not.toHaveBeenCalled();

    await handle.browser.hide?.();
    expect(hide).toHaveBeenCalledTimes(1);

    await handle.browser.show?.();
    expect(show).toHaveBeenCalledTimes(2);

    await handle.release({ destroy: true });
    expect(hide).toHaveBeenCalledTimes(2);
    expect(originalRelease).toHaveBeenCalledWith({ destroy: true });
    expect(mockShowBrowserView).not.toHaveBeenCalled();
    expect(mockHideBrowserView).not.toHaveBeenCalled();
  });

  it('launchPopup fronts extension windows and hides them on closePopup', async () => {
    const onClose = vi.fn();
    const show = vi.fn().mockResolvedValue(undefined);
    const hide = vi.fn().mockResolvedValue(undefined);
    const browser = {
      goto: vi.fn(),
      show,
      hide,
    };

    mockPoolManager.acquire.mockResolvedValue({
      browser,
      browserId: 'browser-4',
      sessionId: 'p4',
      engine: 'extension',
      release: vi.fn().mockResolvedValue({
        sessionId: 'p4',
        remainingBrowserCount: 0,
        destroyed: false,
      }),
      renew: vi.fn(),
    });

    const ns = createNamespace();
    const handle = await ns.launchPopup('p4', {
      url: 'https://example.com/login',
      title: 'ignored-for-extension',
      width: 640,
      height: 480,
      onClose,
    });

    expect(browser.goto).toHaveBeenCalledWith('https://example.com/login');
    expect(show).toHaveBeenCalledTimes(1);
    expect(handle.popupId).toBe('external:browser-4');
    expect(mockShowBrowserViewInPopup).not.toHaveBeenCalled();

    handle.closePopup();
    await Promise.resolve();
    await Promise.resolve();

    expect(hide).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCloseBrowserPopup).not.toHaveBeenCalled();

    handle.closePopup();
    await Promise.resolve();
    await Promise.resolve();

    expect(hide).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('launchPopup uses the handle viewId for electron popups', async () => {
    const browser = {
      goto: vi.fn(),
      show: vi.fn().mockResolvedValue(undefined),
      hide: vi.fn().mockResolvedValue(undefined),
    };
    mockShowBrowserViewInPopup.mockReturnValue('popup-1');

    mockPoolManager.acquire.mockResolvedValue({
      browser,
      browserId: 'browser-5',
      sessionId: 'p5',
      engine: 'electron',
      viewId: 'pool:p5:1',
      release: vi.fn().mockResolvedValue({
        sessionId: 'p5',
        remainingBrowserCount: 1,
        destroyed: false,
      }),
      renew: vi.fn(),
    });

    const ns = createNamespace();
    const handle = await ns.launchPopup('p5', {
      url: 'https://example.com/login',
      title: 'Login Example',
      width: 900,
      height: 700,
    });

    expect(browser.goto).toHaveBeenCalledWith('https://example.com/login');
    expect(mockShowBrowserViewInPopup).toHaveBeenCalledWith(
      'pool:p5:1',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        title: 'Login Example',
        width: 900,
        height: 700,
      })
    );
    expect(handle.popupId).toBe('popup-1');

    handle.closePopup();
    expect(mockCloseBrowserPopup).toHaveBeenCalledWith('popup-1', expect.anything());
  });

  it('launchPopup adopts an existing same-plugin browser when acquire times out', async () => {
    const browser = {
      goto: vi.fn(),
      show: vi.fn().mockResolvedValue(undefined),
      hide: vi.fn().mockResolvedValue(undefined),
    };
    mockShowBrowserViewInPopup.mockReturnValue('popup-reused');
    mockPoolManager.acquire.mockRejectedValue(new Error('Resource wait timeout after 30000ms'));
    mockPoolManager.adoptSamePluginLockedBrowser.mockResolvedValue({
      browser,
      browserId: 'browser-reused',
      sessionId: 'p7',
      engine: 'electron',
      viewId: 'pool:p7:1',
      release: vi.fn().mockResolvedValue({
        sessionId: 'p7',
        remainingBrowserCount: 1,
        destroyed: false,
      }),
      renew: vi.fn(),
    });

    const ns = createNamespace();
    const handle = await ns.launchPopup('p7', {
      url: 'https://example.com/reuse',
      title: 'Reuse Existing Browser',
    });

    expect(mockPoolManager.acquire).toHaveBeenCalledTimes(1);
    expect(mockPoolManager.adoptSamePluginLockedBrowser).toHaveBeenCalledTimes(1);
    expect(browser.goto).toHaveBeenCalledWith('https://example.com/reuse');
    expect(handle.browserId).toBe('browser-reused');
    expect(handle.popupId).toBe('popup-reused');
  });

  it('launchPopup adopts an existing same-plugin browser when the profile lease is already held', async () => {
    const heldLease = await resourceCoordinator.acquire(buildProfileResourceKey('p8'), {
      ownerToken: 'other-owner',
      timeoutMs: 1000,
    });
    const browser = {
      goto: vi.fn(),
      show: vi.fn().mockResolvedValue(undefined),
      hide: vi.fn().mockResolvedValue(undefined),
    };
    mockShowBrowserViewInPopup.mockReturnValue('popup-busy-reused');
    mockPoolManager.adoptSamePluginLockedBrowser.mockResolvedValue({
      browser,
      browserId: 'browser-busy-reused',
      sessionId: 'p8',
      engine: 'electron',
      viewId: 'pool:p8:1',
      release: vi.fn().mockResolvedValue({
        sessionId: 'p8',
        remainingBrowserCount: 1,
        destroyed: false,
      }),
      renew: vi.fn(),
    });

    try {
      const ns = createNamespace();
      const handle = await ns.launchPopup('p8', {
        url: 'https://example.com/busy',
        timeout: 1,
      });

      expect(mockPoolManager.acquire).not.toHaveBeenCalled();
      expect(mockPoolManager.adoptSamePluginLockedBrowser).toHaveBeenCalledTimes(1);
      expect(handle.browserId).toBe('browser-busy-reused');
      expect(handle.popupId).toBe('popup-busy-reused');
    } finally {
      await heldLease.release();
    }
  });

  it('launchPopup keeps the profile lease until the first popup handle is released', async () => {
    const firstRelease = vi.fn().mockResolvedValue({
      sessionId: 'p6',
      remainingBrowserCount: 1,
      destroyed: false,
    });
    const secondRelease = vi.fn().mockResolvedValue({
      sessionId: 'p6',
      remainingBrowserCount: 1,
      destroyed: false,
    });

    mockPoolManager.acquire
      .mockResolvedValueOnce({
        browser: {
          goto: vi.fn(),
          show: vi.fn().mockResolvedValue(undefined),
          hide: vi.fn().mockResolvedValue(undefined),
        },
        browserId: 'browser-popup-1',
        sessionId: 'p6',
        engine: 'extension',
        release: firstRelease,
        renew: vi.fn(),
      })
      .mockResolvedValueOnce({
        browser: {
          goto: vi.fn(),
          show: vi.fn().mockResolvedValue(undefined),
          hide: vi.fn().mockResolvedValue(undefined),
        },
        browserId: 'browser-popup-2',
        sessionId: 'p6',
        engine: 'extension',
        release: secondRelease,
        renew: vi.fn(),
      });

    const ns = createNamespace();
    const firstHandle = await ns.launchPopup('p6', { visible: true });
    const secondHandlePromise = ns.launchPopup('p6', { visible: true });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockPoolManager.acquire).toHaveBeenCalledTimes(1);

    await firstHandle.release();

    const secondHandle = await secondHandlePromise;
    expect(secondHandle.browserId).toBe('browser-popup-2');
    expect(mockPoolManager.acquire).toHaveBeenCalledTimes(2);

    await secondHandle.release();
  });

  it('generateFingerprint returns canonical Firefox presets without using Chromium-only generators', async () => {
    const ns = createNamespace();

    const fingerprint = await ns.generateFingerprint({
      os: 'windows',
      browser: 'firefox',
      browserMinVersion: 120,
      browserMaxVersion: 130,
      locales: ['ja-JP', 'ja'],
      screenWidth: { min: 1366, max: 1920 },
      screenHeight: { min: 768, max: 1080 },
    });

    expect(fingerprint.identity?.hardware.browserFamily).toBe('firefox');
    expect(fingerprint.identity?.hardware.userAgent).toContain('Firefox/');
    expect(fingerprint.identity?.region.primaryLanguage).toBe('ja-JP');
    expect(fingerprint.identity?.region.languages).toEqual(['ja-JP', 'ja']);
    expect((fingerprint.identity?.display.width || 0) >= 1366).toBe(true);
    expect((fingerprint.identity?.display.height || 0) >= 768).toBe(true);
  });
});
