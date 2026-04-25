import { describe, expect, it, vi } from 'vitest';
import { handleBrowserFindText } from './browser-handlers';

function createIntegratedBrowserStub() {
  return {
    getViewport: vi.fn().mockResolvedValue({
      width: 100,
      height: 100,
      aspectRatio: 1,
      devicePixelRatio: 1,
    }),
    findTextNormalized: vi.fn(),
    findTextNormalizedDetailed: vi.fn(),
    clickText: vi.fn(),
  };
}

describe('browser handlers text lookup ergonomics', () => {
  it('browser_find_text reports safe click metadata when bounds overflow the viewport', async () => {
    const browser = createIntegratedBrowserStub();
    browser.findTextNormalizedDetailed.mockResolvedValue({
      normalizedBounds: {
        x: -10,
        y: 10,
        width: 20,
        height: 10,
        space: 'normalized',
      },
      matchSource: 'dom',
    });

    const result = await handleBrowserFindText(
      {
        text: 'Example Domain',
        strategy: 'auto',
      },
      { browser } as never
    );

    expect(result.structuredContent?.data).toMatchObject({
      found: true,
      strategy: 'auto',
      matchSource: 'dom',
      clippedToViewport: true,
      inViewport: false,
      safeCenterX: 0,
      safeCenterY: 15,
      overflow: {
        left: 10,
        top: 0,
        right: 0,
        bottom: 0,
      },
    });
  });
});
