import { describe, expect, it, vi } from 'vitest';
import { executeBrowserObserveSearchActFastPath } from './internal-fast-path';

function createFingerprint(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    url: 'https://example.test/',
    title: 'Example',
    readyState: 'complete',
    bodyTextSample: 'Save changes',
    bodyTextLength: 12,
    activeTag: 'BUTTON',
    activeType: '',
    historyLength: 1,
    ...overrides,
  };
}

function createFastPathBrowser() {
  return {
    snapshot: vi.fn().mockResolvedValue({
      url: 'https://example.test/',
      title: 'Example',
      elements: [
        {
          tag: 'button',
          role: 'button',
          name: 'Save',
          text: 'Save',
          preferredSelector: '#save',
          inViewport: true,
          bounds: { x: 12, y: 20, width: 80, height: 24 },
        },
      ],
    }),
    search: vi.fn().mockResolvedValue([
      {
        element: {
          tag: 'button',
          role: 'button',
          name: 'Save',
          text: 'Save',
          preferredSelector: '#save',
          inViewport: true,
          bounds: { x: 12, y: 20, width: 80, height: 24 },
        },
        score: 0.99,
        matchedFields: ['text'],
      },
    ]),
    click: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/after'),
    evaluate: vi.fn().mockImplementation((script: string) => {
      if (script.includes('window.innerWidth')) {
        return Promise.resolve({ width: 1280, height: 720 });
      }
      if (script.includes('engine?.querySelector')) {
        return Promise.resolve(true);
      }
      if (script.includes('window.__airpaClickProbes = window.__airpaClickProbes || {}')) {
        return Promise.resolve('probe-1');
      }
      if (script.includes('window.__airpaClickProbes?.[')) {
        return Promise.resolve({ events: 1, lastTrusted: true, lastTag: 'BUTTON' });
      }
      if (script.includes('delete window.__airpaClickProbes[probeId]')) {
        return Promise.resolve(undefined);
      }
      if (script.includes('document.body?.innerText')) {
        return Promise.resolve(createFingerprint({ url: 'https://example.test/after' }));
      }
      return Promise.resolve(undefined);
    }),
  };
}

describe('internal browser observe-search-act fast path', () => {
  it('chains observe, search, act, and waitFor while resolving the act target from a single search result', async () => {
    const browser = createFastPathBrowser();

    const result = await executeBrowserObserveSearchActFastPath(
      {
        observe: {
          maxElements: 10,
        },
        search: {
          query: 'save',
          limit: 5,
        },
        act: {
          action: 'click',
          targetFromSearch: 'single',
          verify: {
            kind: 'element',
            selector: '#done',
          },
          timeoutMs: 800,
        },
        waitFor: {
          condition: {
            kind: 'element',
            selector: '#done',
          },
          timeoutMs: 800,
        },
      },
      { browser } as never
    );

    expect(result.ok).toBe(true);
    expect(result.stoppedAt).toBe('completed');
    expect(result.resolvedActTarget).toMatchObject({
      source: 'search-single',
      searchTotal: 1,
      target: {
        kind: 'element',
        ref: expect.stringMatching(/^airpa_el:/),
      },
    });
    expect(browser.search).toHaveBeenCalledWith('save', {
      query: 'save',
      limit: 5,
    });
    expect(browser.click).toHaveBeenCalledWith('#save');
    expect(result.act?.structuredContent).toMatchObject({
      data: {
        action: 'click',
        verified: true,
        primaryEffect: 'waitFor',
      },
    });
    expect(result.waitFor?.structuredContent).toMatchObject({
      data: {
        matched: true,
        condition: 'selector #done',
        selector: '#done',
      },
    });
  });

  it('stops before act when targetFromSearch requires a single result but search is ambiguous', async () => {
    const browser = createFastPathBrowser();
    browser.search.mockResolvedValue([
      {
        element: {
          tag: 'button',
          role: 'button',
          name: 'Save',
          text: 'Save',
          preferredSelector: '#save',
        },
        score: 0.99,
        matchedFields: ['text'],
      },
      {
        element: {
          tag: 'button',
          role: 'button',
          name: 'Save As',
          text: 'Save As',
          preferredSelector: '#save-as',
        },
        score: 0.74,
        matchedFields: ['text'],
      },
    ]);

    const result = await executeBrowserObserveSearchActFastPath(
      {
        search: {
          query: 'save',
          limit: 5,
        },
        act: {
          action: 'click',
          targetFromSearch: 'single',
        },
      },
      { browser } as never
    );

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('act');
    expect(browser.click).not.toHaveBeenCalled();
    expect(result.act?.isError).toBe(true);
    expect((result.act?.structuredContent as any)?.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      context: {
        targetFromSearch: 'single',
        searchTotal: 2,
      },
    });
  });

  it('keeps explicit act targets authoritative even when search also runs', async () => {
    const browser = createFastPathBrowser();

    const result = await executeBrowserObserveSearchActFastPath(
      {
        search: {
          query: 'save',
          limit: 5,
        },
        act: {
          action: 'click',
          target: {
            kind: 'element',
            selector: '#explicit-save',
          },
        },
      },
      { browser } as never
    );

    expect(result.ok).toBe(true);
    expect(result.resolvedActTarget).toEqual({
      source: 'explicit',
      searchTotal: null,
      target: {
        kind: 'element',
        selector: '#explicit-save',
      },
    });
    expect(browser.click).toHaveBeenCalledWith('#explicit-save');
  });
});
