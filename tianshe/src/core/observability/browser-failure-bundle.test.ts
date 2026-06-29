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

  it('redacts sensitive headers in captured failure artifacts', async () => {
    const browser = {
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.com'),
      title: vi.fn().mockResolvedValue('Example'),
      snapshot: vi.fn().mockResolvedValue({ elements: [] }),
      getConsoleMessages: vi.fn().mockReturnValue([]),
      getNetworkSummary: vi.fn().mockReturnValue({
        total: 1,
        byType: { api: 1 },
        byMethod: { GET: 1 },
        failed: [],
        slow: [],
        apiCalls: [
          {
            url: 'https://example.com/api',
            method: 'GET',
            requestHeaders: {
              authorization: 'Bearer request-secret',
            },
            responseHeaders: {
              'set-cookie': 'sid=response-secret',
            },
          },
        ],
      }),
      screenshotDetailed: vi.fn().mockResolvedValue(null),
    };

    const artifacts = await attachBrowserFailureBundle(browser as any, {
      context: createChildTraceContext({ source: 'test' }),
      component: 'browser-test',
      labelPrefix: 'failure',
      maxArtifacts: 4,
    });

    const serialized = JSON.stringify(artifacts);
    expect(artifacts.map((artifact) => artifact.type)).toContain('network_summary');
    expect(serialized).not.toContain('request-secret');
    expect(serialized).not.toContain('response-secret');
  });

  it('redacts sensitive text from current URLs and console messages', async () => {
    const browser = {
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.com/page?token=url-secret'),
      title: vi.fn().mockResolvedValue('Example'),
      snapshot: vi.fn().mockResolvedValue(null),
      getConsoleMessages: vi.fn().mockReturnValue([
        { level: 'error', text: 'Authorization: Bearer console-auth-secret' },
        { level: 'warn', text: 'Set-Cookie: sid=console-cookie-secret; Path=/' },
      ]),
      getNetworkSummary: vi.fn().mockReturnValue(undefined),
      screenshotDetailed: vi.fn().mockResolvedValue(null),
    };

    const artifacts = await attachBrowserFailureBundle(browser as any, {
      context: createChildTraceContext({ source: 'test' }),
      component: 'browser-test',
      labelPrefix: 'failure',
      maxArtifacts: 4,
    });

    const serialized = JSON.stringify(artifacts);
    expect(artifacts.map((artifact) => artifact.type)).toContain('console_tail');
    expect(serialized).not.toContain('url-secret');
    expect(serialized).not.toContain('console-auth-secret');
    expect(serialized).not.toContain('console-cookie-secret');
    expect(serialized).toContain('[redacted]');
  });
});
