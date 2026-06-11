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
});
