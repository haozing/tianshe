import { describe, expect, it, vi } from 'vitest';
import { handleBrowserWaitFor } from './browser-handlers';

describe('handleBrowserWaitFor', () => {
  it('uses attached selector semantics by default for browser_wait_for', async () => {
    const browser = {
      waitForSelector: vi.fn().mockResolvedValue(undefined),
    };

    const result = await handleBrowserWaitFor(
      {
        condition: {
          kind: 'element',
          selector: 'h1:has-text("Example Domain")',
        },
        timeoutMs: 500,
        pollIntervalMs: 100,
      },
      { browser }
    );

    expect(browser.waitForSelector).toHaveBeenCalledWith('h1:has-text("Example Domain")', {
      timeout: 100,
      state: 'attached',
    });
    expect(result.structuredContent?.ok).toBe(true);
  });
});
