import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { ExtensionBrowser } from './extension-browser';

function createExtensionBrowserForTest(): ExtensionBrowser {
  const relay = {
    onEvent: vi.fn(() => () => undefined),
    dispatchCommand: vi.fn(),
    getClientState: vi.fn(() => null),
  } as any;

  return new ExtensionBrowser({
    relay,
    closeInternal: vi.fn(async () => undefined),
  });
}

describe('ExtensionBrowser text strategy', () => {
  it('auto strategy with short timeout budget should skip OCR fallback during polling', async () => {
    const browser = createExtensionBrowserForTest() as any;
    browser.findTextInDom = vi.fn().mockResolvedValue(null);

    const ocr = {
      waitForText: vi.fn(),
      findText: vi.fn(),
    };
    browser.getViewportOCR = vi.fn().mockResolvedValue(ocr);

    const result = await browser.waitForTextUsingStrategy('Example Domain', {
      strategy: 'auto',
      timeoutMs: 150,
    });

    expect(result).toEqual({
      bounds: null,
      strategy: 'none',
      timedOut: true,
    });
    expect(ocr.waitForText).not.toHaveBeenCalled();
    expect(ocr.findText).not.toHaveBeenCalled();
  });

  it('textExists should return true from DOM existence check without invoking OCR', async () => {
    const browser = createExtensionBrowserForTest() as any;
    browser.textExistsInDom = vi.fn().mockResolvedValue(true);
    browser.findTextUsingStrategy = vi.fn();

    const exists = await browser.textExists('Example Domain', {
      strategy: 'auto',
      timeoutMs: 5000,
    });

    expect(exists).toBe(true);
    expect(browser.findTextUsingStrategy).not.toHaveBeenCalled();
  });

  it('clickText should prefer DOM click when the text match came from DOM strategy', async () => {
    const browser = createExtensionBrowserForTest() as any;
    browser.waitForTextUsingStrategy = vi.fn().mockResolvedValue({
      bounds: { x: 8, y: 12, width: 80, height: 20 },
      strategy: 'dom',
      timedOut: false,
    });
    browser.clickTextInDom = vi.fn().mockResolvedValue({
      clicked: true,
      clickMethod: 'dom-click',
      matchedTag: 'A',
      clickTargetTag: 'A',
      href: 'https://example.test/help',
    });
    browser.native.click = vi.fn();

    const result = await browser.clickText('Learn more', {
      strategy: 'auto',
      timeoutMs: 1200,
    });

    expect(result).toEqual({
      matchSource: 'dom',
      clickMethod: 'dom-click',
      matchedTag: 'A',
      clickTargetTag: 'A',
      href: 'https://example.test/help',
    });
    expect(browser.clickTextInDom).toHaveBeenCalledWith('Learn more', {
      strategy: 'auto',
      timeoutMs: 1200,
    });
    expect(browser.native.click).not.toHaveBeenCalled();
  });

  it('findTextNormalizedDetailed should convert viewport bounds into normalized bounds', async () => {
    const browser = createExtensionBrowserForTest() as any;
    browser.getViewport = vi.fn().mockResolvedValue({
      width: 200,
      height: 100,
      aspectRatio: 2,
      devicePixelRatio: 1,
    });
    browser.findTextUsingStrategy = vi.fn().mockResolvedValue({
      bounds: { x: 50, y: 25, width: 40, height: 20 },
      strategy: 'ocr',
    });

    const result = await browser.findTextNormalizedDetailed('Submit');

    expect(result).toEqual({
      normalizedBounds: {
        x: 25,
        y: 25,
        width: 20,
        height: 20,
        space: 'normalized',
      },
      matchSource: 'ocr',
    });
  });

  it('captureViewportScreenshot should normalize high-DPR screenshots back to viewport size', async () => {
    const browser = createExtensionBrowserForTest() as any;
    const source = await sharp({
      create: {
        width: 400,
        height: 200,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    browser.getViewport = vi.fn().mockResolvedValue({
      width: 200,
      height: 100,
      aspectRatio: 2,
      devicePixelRatio: 2,
    });
    browser.screenshotDetailed = vi.fn().mockResolvedValue({
      data: source.toString('base64'),
      mimeType: 'image/png',
      format: 'png',
      captureMode: 'viewport',
      captureMethod: 'cdp.viewport_screenshot',
      fallbackUsed: false,
      degraded: false,
      degradationReason: null,
    });

    const normalized = await browser.captureViewportScreenshot();
    const metadata = await sharp(normalized).metadata();

    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(100);
  });

  it('captureViewportScreenshot should crop against normalized viewport coordinates', async () => {
    const browser = createExtensionBrowserForTest() as any;
    const source = await sharp({
      create: {
        width: 400,
        height: 200,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    browser.getViewport = vi.fn().mockResolvedValue({
      width: 200,
      height: 100,
      aspectRatio: 2,
      devicePixelRatio: 2,
    });
    browser.screenshotDetailed = vi.fn().mockResolvedValue({
      data: source.toString('base64'),
      mimeType: 'image/png',
      format: 'png',
      captureMode: 'viewport',
      captureMethod: 'cdp.viewport_screenshot',
      fallbackUsed: false,
      degraded: false,
      degradationReason: null,
    });

    const cropped = await browser.captureViewportScreenshot({
      rect: { x: 50, y: 20, width: 80, height: 40 },
    });
    const metadata = await sharp(cropped).metadata();

    expect(metadata.width).toBe(80);
    expect(metadata.height).toBe(40);
  });
});
