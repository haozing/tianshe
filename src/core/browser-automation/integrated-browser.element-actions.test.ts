import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegratedBrowser } from './integrated-browser';
import { getSelectAllKeyModifiers } from './native-keyboard-utils';

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
    native: {
      click: vi.fn(),
      type: vi.fn(),
      keyPress: vi.fn(),
    },
    capture: {},
    cdp: {},
    session: {
      getUserAgent: vi.fn(() => 'test-agent'),
      setUserAgent: vi.fn(),
    },
  } as any;

  return new IntegratedBrowser(fakeBrowser, {} as any);
}

describe('IntegratedBrowser element action scripts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('queryElement uses viewport-safe nearest scrolling instead of centering', async () => {
    const browser = createIntegratedBrowserForTest() as any;
    browser.browser.evaluate = vi.fn().mockResolvedValue({
      found: true,
      visible: true,
      interactable: true,
      bounds: { x: 10, y: 10, width: 20, height: 20 },
    });

    await browser.queryElement('#btn');

    expect(browser.browser.evaluate).toHaveBeenCalledTimes(1);
    const [script] = browser.browser.evaluate.mock.calls[0];
    expect(script).toContain("block: 'nearest'");
    expect(script).toContain("inline: 'nearest'");
    expect(script).toContain('const viewportWidth = window.innerWidth');
    expect(script).toContain('const intersectsViewport =');
    expect(script).not.toContain("block: 'center'");
    expect(script).not.toContain("inline: 'center'");
  });

  it('focusElement only scrolls off-screen targets with nearest alignment', async () => {
    const browser = createIntegratedBrowserForTest() as any;
    browser.browser.evaluate = vi.fn().mockResolvedValue(true);

    await browser.focusElement('#btn');

    expect(browser.browser.evaluate).toHaveBeenCalledTimes(1);
    const [script] = browser.browser.evaluate.mock.calls[0];
    expect(script).toContain("block: 'nearest'");
    expect(script).toContain("inline: 'nearest'");
    expect(script).toContain('const viewportWidth = window.innerWidth');
    expect(script).toContain('const intersectsViewport =');
    expect(script).not.toContain("block: 'center'");
    expect(script).not.toContain("inline: 'center'");
  });

  it('type establishes native focus before typing and clear hotkeys', async () => {
    const browser = createIntegratedBrowserForTest() as any;
    browser.waitForSelector = vi.fn().mockResolvedValue(undefined);
    browser.queryElement = vi.fn().mockResolvedValue({
      found: true,
      visible: true,
      interactable: true,
      bounds: { x: 10, y: 20, width: 100, height: 30 },
    });
    browser.focusElement = vi.fn().mockResolvedValue(true);

    const promise = browser.type('#field', 'hello', { clear: true });
    await vi.runAllTimersAsync();
    await promise;

    expect(browser.browser.native.click).toHaveBeenCalledWith(60, 35);
    expect(browser.focusElement).toHaveBeenCalledWith('#field');
    expect(browser.browser.native.keyPress).toHaveBeenNthCalledWith(
      1,
      'a',
      getSelectAllKeyModifiers()
    );
    expect(browser.browser.native.keyPress).toHaveBeenNthCalledWith(2, 'Backspace');
    expect(browser.browser.native.type).toHaveBeenCalledWith('hello');
  });
});
