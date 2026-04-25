import { describe, expect, it, vi } from 'vitest';
import { IntegratedBrowser } from './integrated-browser';

function createIntegratedBrowserForTest(): IntegratedBrowser {
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
    native: {},
    capture: {},
    cdp: {},
    session: {
      getUserAgent: vi.fn(() => 'test-agent'),
      setUserAgent: vi.fn(),
    },
  } as any;

  return new IntegratedBrowser(fakeBrowser, {} as any);
}

describe('IntegratedBrowser text strategy', () => {
  it('auto strategy with short timeout budget should skip OCR fallback during polling', async () => {
    const browser = createIntegratedBrowserForTest() as any;
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

  it('findTextUsingStrategy should pass timeoutMs through to OCR fallback', async () => {
    const browser = createIntegratedBrowserForTest() as any;
    browser.findTextInDom = vi.fn().mockResolvedValue(null);

    const ocr = {
      findText: vi.fn().mockResolvedValue(null),
    };
    browser.getViewportOCR = vi.fn().mockResolvedValue(ocr);

    await browser.findTextUsingStrategy('Example Domain', {
      strategy: 'auto',
      timeoutMs: 1200,
    });

    expect(ocr.findText).toHaveBeenCalledWith(
      'Example Domain',
      expect.objectContaining({
        timeoutMs: 1200,
      })
    );
  });

  it('findTextUsingStrategy should skip OCR fallback for short auto polling budgets', async () => {
    const browser = createIntegratedBrowserForTest() as any;
    browser.findTextInDom = vi.fn().mockResolvedValue(null);

    const ocr = {
      findText: vi.fn(),
    };
    browser.getViewportOCR = vi.fn().mockResolvedValue(ocr);

    const result = await browser.findTextUsingStrategy('Example Domain', {
      strategy: 'auto',
      timeoutMs: 150,
    });

    expect(result).toEqual({
      bounds: null,
      strategy: 'none',
    });
    expect(ocr.findText).not.toHaveBeenCalled();
  });

  it('findTextUsingStrategy should suppress recoverable OCR infrastructure errors in auto mode', async () => {
    const browser = createIntegratedBrowserForTest() as any;
    browser.findTextInDom = vi.fn().mockResolvedValue(null);

    const ocr = {
      findText: vi.fn().mockRejectedValue(new Error('Input Buffer is empty')),
    };
    browser.getViewportOCR = vi.fn().mockResolvedValue(ocr);

    const result = await browser.findTextUsingStrategy('Example Domain', {
      strategy: 'auto',
      timeoutMs: 1200,
    });

    expect(result).toEqual({
      bounds: null,
      strategy: 'none',
    });
  });

  it('textExists should return true from DOM existence check without invoking OCR', async () => {
    const browser = createIntegratedBrowserForTest() as any;
    browser.textExistsInDom = vi.fn().mockResolvedValue(true);
    browser.findTextUsingStrategy = vi.fn();

    const exists = await browser.textExists('Example Domain', {
      strategy: 'auto',
      timeoutMs: 5000,
    });

    expect(exists).toBe(true);
    expect(browser.findTextUsingStrategy).not.toHaveBeenCalled();
  });

  it('textExists should skip OCR fallback for short auto polling budgets after a DOM miss', async () => {
    const browser = createIntegratedBrowserForTest() as any;
    browser.textExistsInDom = vi.fn().mockResolvedValue(false);
    browser.findTextUsingStrategy = vi.fn();

    const exists = await browser.textExists('Example Domain', {
      strategy: 'auto',
      timeoutMs: 150,
    });

    expect(exists).toBe(false);
    expect(browser.findTextUsingStrategy).not.toHaveBeenCalled();
  });

  it('textExists should return false when auto OCR fallback hits recoverable infrastructure errors', async () => {
    const browser = createIntegratedBrowserForTest() as any;
    browser.textExistsInDom = vi.fn().mockResolvedValue(false);
    browser.findTextInDom = vi.fn().mockResolvedValue(null);

    const ocr = {
      findText: vi.fn().mockRejectedValue(new Error('Input Buffer is empty')),
    };
    browser.getViewportOCR = vi.fn().mockResolvedValue(ocr);

    const exists = await browser.textExists('Example Domain', {
      strategy: 'auto',
      timeoutMs: 1200,
    });

    expect(exists).toBe(false);
  });

  it('clickText should prefer DOM click when the text match came from DOM strategy', async () => {
    const browser = createIntegratedBrowserForTest() as any;
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
    browser.browser.native.click = vi.fn();

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
    expect(browser.browser.native.click).not.toHaveBeenCalled();
  });

  it('evaluateWithSelectorEngine should separate injected IIFEs safely', async () => {
    const browser = createIntegratedBrowserForTest() as any;
    browser.browser.evaluate = vi.fn().mockResolvedValue({ ok: true });

    await browser.evaluateWithSelectorEngine('(function() { return { ok: true }; })()');

    expect(browser.browser.evaluate).toHaveBeenCalledTimes(1);
    const [script] = browser.browser.evaluate.mock.calls[0];
    expect(script).toContain(';\n(function() { return { ok: true }; })()');
  });
});
