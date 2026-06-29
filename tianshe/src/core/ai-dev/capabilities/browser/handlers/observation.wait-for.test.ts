import { describe, expect, it, vi } from 'vitest';
import { handleBrowserWaitFor } from './observation';

describe('browser_wait_for canonical wait conditions', () => {
  it('supports allOf with text, textGone, and urlIncludes', async () => {
    const browser = {
      hasCapability: vi.fn((name: string) => name === 'text.dom'),
      getViewport: vi.fn().mockResolvedValue({
        width: 100,
        height: 100,
        aspectRatio: 1,
        devicePixelRatio: 1,
      }),
      textExists: vi.fn().mockImplementation((text: string) => Promise.resolve(text === 'Ready')),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/done'),
      waitForSelector: vi.fn(),
    };

    const result = await handleBrowserWaitFor(
      {
        condition: {
          kind: 'all',
          conditions: [
            { kind: 'text', text: 'Ready' },
            { kind: 'text_absent', text: 'Loading' },
            { kind: 'url', urlIncludes: '/done' },
          ],
        },
        timeoutMs: 500,
      },
      { browser } as never
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        matched: true,
        waitTarget: {
          type: 'allOf',
          conditions: [
            { type: 'text', value: 'Ready' },
            { type: 'textGone', value: 'Loading' },
            { type: 'urlIncludes', value: '/done' },
          ],
        },
      },
    });
  });

  it('supports anyOf when one nested condition succeeds', async () => {
    const browser = {
      clickAtNormalized: vi.fn(),
      waitForSelector: vi.fn().mockRejectedValue(new Error('not found')),
      textExists: vi.fn().mockResolvedValue(false),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/done'),
    };

    const result = await handleBrowserWaitFor(
      {
        condition: {
          kind: 'any',
          conditions: [
            { kind: 'element', selector: '#done' },
            { kind: 'url', urlIncludes: '/done' },
          ],
        },
        timeoutMs: 500,
      },
      { browser } as never
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        matched: true,
        waitTarget: {
          type: 'anyOf',
          conditions: [{ type: 'urlIncludes', value: '/done' }],
        },
      },
    });
  });
});
