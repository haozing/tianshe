import { describe, expect, it, vi } from 'vitest';
import { IntegratedBrowser } from './integrated-browser';

function createIntegratedBrowserFixture() {
  const rawSession = {
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const fakeBrowser = {
    getSession: vi.fn(() => rawSession),
    ensureNotDisposed: vi.fn(),
    getWebContents: vi.fn(() => ({ id: 1 })),
    getViewId: vi.fn(() => 'test-view'),
    url: vi.fn(() => 'about:blank'),
    title: vi.fn(async () => 'Test'),
    getCurrentUrl: vi.fn(async () => 'about:blank'),
    evaluate: vi.fn(),
    native: {
      click: vi.fn(),
      type: vi.fn(),
      keyPress: vi.fn(),
    },
    capture: {
      screenshotAsBase64: vi.fn(),
      screenshot: vi.fn(),
    },
    cdp: {
      viewportScreenshot: vi.fn(),
      fullPageScreenshot: vi.fn(),
    },
    session: {
      getUserAgent: vi.fn(() => 'test-agent'),
      setUserAgent: vi.fn(),
    },
  } as any;

  return {
    browser: new IntegratedBrowser(fakeBrowser, {} as never),
    fakeBrowser,
  };
}

describe('IntegratedBrowser screenshot fallback', () => {
  it('falls back to CDP viewport screenshot when Electron capture returns empty data', async () => {
    const { browser, fakeBrowser } = createIntegratedBrowserFixture();
    fakeBrowser.capture.screenshotAsBase64.mockResolvedValue('');
    fakeBrowser.cdp.viewportScreenshot.mockResolvedValue('Y2RwLXZpZXdwb3J0');

    await expect(browser.screenshotDetailed({ captureMode: 'viewport' })).resolves.toEqual(
      expect.objectContaining({
        data: 'Y2RwLXZpZXdwb3J0',
        mimeType: 'image/png',
        captureMode: 'viewport',
        captureMethod: 'cdp.viewport_screenshot',
        fallbackUsed: true,
        degraded: false,
      })
    );

    expect(fakeBrowser.capture.screenshotAsBase64).toHaveBeenCalledWith({
      format: 'png',
      quality: undefined,
    });
    expect(fakeBrowser.cdp.viewportScreenshot).toHaveBeenCalledWith('png', undefined, {
      signal: undefined,
      timeoutMs: 8000,
    });
  });
});
