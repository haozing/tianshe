import { describe, expect, it, vi } from 'vitest';
import { createChildTraceContext } from './observation-context';
import { attachBrowserFailureBundle } from './browser-failure-bundle';

describe('attachBrowserFailureBundle', () => {
  it('captures viewport screenshot even when snapshot succeeds', async () => {
    const screenshotDetailed = vi.fn().mockResolvedValue({
      mimeType: 'image/jpeg',
      format: 'jpeg',
      captureMode: 'viewport',
      captureMethod: 'native',
      fallbackUsed: false,
      degraded: false,
      data: 'base64-screenshot',
    });
    const browser = {
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.com'),
      title: vi.fn().mockResolvedValue('Example'),
      snapshot: vi.fn().mockResolvedValue({ elements: [{ text: 'Submit' }] }),
      getConsoleMessages: vi.fn().mockReturnValue([]),
      getNetworkSummary: vi.fn().mockReturnValue(undefined),
      screenshotDetailed,
    };

    const artifacts = await attachBrowserFailureBundle(browser as any, {
      context: createChildTraceContext({ source: 'test' }),
      component: 'browser-test',
      labelPrefix: 'failure',
    });

    expect(artifacts.map((artifact) => artifact.type)).toEqual(['snapshot', 'screenshot']);
    expect(screenshotDetailed).toHaveBeenCalledWith({
      captureMode: 'viewport',
      format: 'jpeg',
      quality: 60,
    });
  });

  it('does not wait indefinitely for a hung snapshot capture', async () => {
    vi.useFakeTimers();
    try {
      const browser = {
        getCurrentUrl: vi.fn().mockResolvedValue('https://example.com'),
        title: vi.fn().mockResolvedValue('Example'),
        snapshot: vi.fn(() => new Promise(() => undefined)),
        getConsoleMessages: vi.fn().mockReturnValue([{ level: 'error', text: 'boom' }]),
        getNetworkSummary: vi.fn().mockReturnValue(undefined),
        screenshotDetailed: vi.fn(() => new Promise(() => undefined)),
      };

      const bundlePromise = attachBrowserFailureBundle(browser as any, {
        context: createChildTraceContext({ source: 'test' }),
        component: 'browser-test',
        labelPrefix: 'failure',
        timeoutMs: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      const artifacts = await bundlePromise;

      expect(artifacts.map((artifact) => artifact.type)).toEqual(['console_tail']);
      expect(browser.snapshot).toHaveBeenCalled();
      expect(browser.screenshotDetailed).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
