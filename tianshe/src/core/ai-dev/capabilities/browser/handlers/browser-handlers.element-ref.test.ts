import { describe, expect, it, vi } from 'vitest';
import { createElementRef } from '../../../../browser-automation/element-ref';
import {
  handleBrowserClick,
  handleBrowserSnapshot,
  handleBrowserValidateSelector,
  handleBrowserWaitFor,
} from './browser-handlers';

const snapshotElement = {
  tag: 'input',
  role: 'textbox',
  name: 'Search catalog',
  placeholder: 'Search products',
  attributes: {
    id: 'search',
    name: 'q',
    'aria-label': 'Search catalog',
  },
  preferredSelector: '#search',
  selectorCandidates: ['#search', 'input[name="q"]'],
};

function createFingerprint(url = 'https://example.test/'): Record<string, unknown> {
  return {
    url,
    title: 'Example',
    readyState: 'complete',
    bodyTextSample: 'Search catalog',
    bodyTextLength: 14,
    activeTag: 'INPUT',
    activeType: 'text',
    historyLength: 1,
  };
}

function createActionEvaluateMock() {
  return vi.fn().mockImplementation((script: string) => {
    if (script.includes('window.__airpaClickProbes = window.__airpaClickProbes || {}')) {
      return Promise.resolve('probe-1');
    }
    if (script.includes('window.__airpaClickProbes?.[')) {
      return Promise.resolve({ events: 1, lastTrusted: true, lastTag: 'INPUT' });
    }
    if (script.includes('delete window.__airpaClickProbes[probeId]')) {
      return Promise.resolve(undefined);
    }
    if (script.includes('document.body?.innerText')) {
      return Promise.resolve(createFingerprint());
    }
    return Promise.resolve(true);
  });
}

describe('browser handlers elementRef support', () => {
  it('adds elementRef to snapshot results', async () => {
    const browser = {
      snapshot: vi.fn().mockResolvedValue({
        url: 'https://example.test/',
        title: 'Example',
        elements: [snapshotElement],
      }),
    };

    const result = await handleBrowserSnapshot({}, { browser } as never);
    const firstElement = result.structuredContent?.data?.snapshot?.elements?.[0];

    expect(firstElement?.preferredSelector).toBe('#search');
    expect(firstElement?.elementRef).toMatch(/^airpa_el:/);
  });

  it('waits on elementRef using attached selector semantics', async () => {
    const ref = createElementRef(snapshotElement);
    const browser = {
      evaluate: vi.fn().mockResolvedValue(true),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
    };

    const result = await handleBrowserWaitFor(
      {
        condition: {
          kind: 'element',
          ref,
        },
        timeoutMs: 500,
        pollIntervalMs: 100,
      },
      { browser } as never
    );

    expect(browser.waitForSelector).toHaveBeenCalledWith('#search', {
      timeout: 100,
      state: 'attached',
    });
    expect(result.structuredContent?.data?.ref).toBe(ref);
    expect(result.structuredContent?.data?.source).toBe('ref');
  });

  it('clicks using elementRef', async () => {
    const ref = createElementRef(snapshotElement);
    const browser = {
      evaluate: createActionEvaluateMock(),
      click: vi.fn().mockResolvedValue(undefined),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
    };

    const result = await handleBrowserClick(
      {
        target: {
          kind: 'element',
          ref,
        },
      },
      { browser } as never
    );

    expect(browser.click).toHaveBeenCalledWith('#search');
    expect(result.structuredContent?.data?.target?.ref).toBe(ref);
    expect(result.structuredContent?.data?.target?.source).toBe('ref');
    expect(result.structuredContent?.data?.verified).toBe(true);
  });

  it('preserves resolved ref context when click fails after elementRef resolution', async () => {
    const ref = createElementRef(snapshotElement);
    const browser = {
      evaluate: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockRejectedValue(new Error('Element is not interactable: #search')),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
    };

    const result = await handleBrowserClick(
      {
        target: {
          kind: 'element',
          ref,
        },
      },
      { browser } as never
    );

    expect(result.structuredContent?.error?.context).toMatchObject({
      selector: '#search',
      source: 'ref',
      ref,
    });
  });

  it('validates selectors using elementRef', async () => {
    const ref = createElementRef(snapshotElement);
    const browser = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          valid: true,
          matchCount: 1,
          isUnique: true,
          elements: [{ tag: 'input', id: 'search' }],
        }),
    };

    const result = await handleBrowserValidateSelector({ ref }, { browser } as never);

    expect(browser.evaluate).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({
      valid: true,
      selector: '#search',
      source: 'ref',
      ref,
      matchCount: 1,
      isUnique: true,
    });
  });
});
