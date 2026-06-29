import { describe, expect, it, vi } from 'vitest';
import { ErrorCode, createStructuredError } from '../../../../../types/error-codes';
import {
  handleBrowserClick,
  handleBrowserClickText,
  handleBrowserType,
} from './browser-handlers';

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

describe('browser handler action verification', () => {
  it('element click helper returns a verified structured envelope when verify succeeds', async () => {
    const browser = {
      click: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/after'),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('window.__airpaClickProbes = window.__airpaClickProbes || {}')) {
          return Promise.resolve('probe-1');
        }
        if (script.includes('delete window.__airpaClickProbes[probeId]')) {
          return Promise.resolve(undefined);
        }
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(createFingerprint('https://example.test/after'));
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserClick(
      {
        target: { selector: '#submit' },
        verify: { kind: 'element', selector: '#done' },
        timeoutMs: 1200,
      },
      { browser } as never
    );

    expect(browser.click).toHaveBeenCalledWith('#submit');
    expect(browser.waitForSelector).toHaveBeenCalledWith('#done', {
      timeout: 150,
      state: 'attached',
    });
    expect(result.structuredContent).toMatchObject({
      data: {
        target: {
          selector: '#submit',
          source: 'selector',
        },
        waitApplied: true,
        waitTarget: {
          type: 'selector',
          value: '#done',
          selector: '#done',
        },
        verified: true,
        verificationMethod: 'waitFor',
        primaryEffect: 'waitFor',
        effectSignals: ['waitFor'],
      },
    });
  });

  it('element click helper falls back to dom-anchor-assign when earlier click methods are unverified', async () => {
    let assigned = false;
    const browser = {
      click: vi.fn().mockResolvedValue(undefined),
      getCurrentUrl: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(assigned ? 'https://example.test/after' : 'https://example.test/start')
        ),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('window.__airpaClickProbes = window.__airpaClickProbes || {}')) {
          return Promise.resolve('probe-1');
        }
        if (script.includes('entry.state?.events')) {
          return Promise.resolve({
            events: 0,
            lastTrusted: false,
            lastTag: '',
          });
        }
        if (script.includes('delete window.__airpaClickProbes[probeId]')) {
          return Promise.resolve(undefined);
        }
        if (script.includes('window.location.assign(anchor.href)')) {
          assigned = true;
          return Promise.resolve({
            clicked: true,
            href: 'https://example.test/after',
            anchorTag: 'A',
            dispatchAllowed: true,
          });
        }
        if (script.includes('clickTarget.click()')) {
          return Promise.resolve({
            clicked: true,
            clickTargetTag: 'A',
            href: 'https://example.test/after',
          });
        }
        if (script.includes("closest('a[href]')")) {
          return Promise.resolve('https://example.test/after');
        }
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(
            createFingerprint(assigned ? 'https://example.test/after' : 'https://example.test/start')
          );
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserClick(
      {
        target: { selector: '#link' },
        verify: { kind: 'url', urlIncludes: '/after' },
        timeoutMs: 30,
      },
      { browser } as never
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        clickMethod: 'dom-anchor-assign',
        fallbackUsed: true,
        resolvedTarget: {
          selector: '#link',
          source: 'selector',
        },
        waitTarget: {
          type: 'urlIncludes',
          value: '/after',
        },
      },
    });
    expect((result.structuredContent as any)?.data?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'native-click', verified: false }),
        expect.objectContaining({
          method: 'dom-click',
          verified: false,
          target: expect.objectContaining({
            href: 'https://example.test/after',
            clickTargetTag: 'A',
          }),
        }),
        expect.objectContaining({
          method: 'dom-anchor-assign',
          verified: true,
          target: expect.objectContaining({
            href: 'https://example.test/after',
            anchorTag: 'A',
            dispatchAllowed: true,
          }),
        }),
      ])
    );
  });

  it('element click helper reports dom-click when browser.click internally falls back from native input', async () => {
    const browser = {
      click: vi.fn().mockResolvedValue(undefined),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/start'),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('window.__airpaClickProbes = window.__airpaClickProbes || {}')) {
          return Promise.resolve('probe-1');
        }
        if (script.includes('entry.state?.events')) {
          return Promise.resolve({
            events: 1,
            lastTrusted: false,
            lastTag: 'BUTTON',
          });
        }
        if (script.includes('delete window.__airpaClickProbes[probeId]')) {
          return Promise.resolve(undefined);
        }
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(createFingerprint('https://example.test/start'));
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserClick(
      {
        target: { selector: '#submit' },
        timeoutMs: 1200,
      },
      { browser } as never
    );

    expect(result.isError).not.toBe(true);
    expect(browser.click).toHaveBeenCalledWith('#submit');
    expect(result.structuredContent).toMatchObject({
      data: {
        clickMethod: 'dom-click',
        fallbackUsed: true,
        verified: true,
        verificationMethod: 'target-click-event',
        primaryEffect: 'target-click-event',
        effectSignals: ['target-click-event'],
      },
    });
    expect((result.structuredContent as any)?.data?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'dom-click',
          verified: true,
          target: expect.objectContaining({
            clickTargetTag: 'BUTTON',
          }),
        }),
      ])
    );
  });

  it('element type helper verifies the typed field state and submit flag', async () => {
    const browser = {
      type: vi.fn().mockResolvedValue(undefined),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
      native: {
        keyPress: vi.fn().mockResolvedValue(undefined),
      },
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('window.__airpaInputProbes = window.__airpaInputProbes || {}')) {
          return Promise.resolve('input-probe-1');
        }
        if (script.includes('window.__airpaInputProbes?.[')) {
          return Promise.resolve({
            events: {
              keydown: 1,
              keypress: 0,
              beforeinput: 1,
              input: 1,
              change: 0,
              keyup: 1,
            },
            trustedEvents: {
              keydown: 1,
              keypress: 0,
              beforeinput: 1,
              input: 1,
              change: 0,
              keyup: 1,
            },
            lastInputType: 'insertText',
            lastData: 'airpa',
            lastKey: 'a',
            active: true,
          });
        }
        if (script.includes('delete window.__airpaInputProbes[probeId]')) {
          return Promise.resolve(undefined);
        }
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(createFingerprint());
        }
        if (script.includes('const el = engine?.querySelector')) {
          return Promise.resolve({
            value: 'airpa',
            textContent: '',
            active: true,
          });
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserType(
      {
        target: { selector: '#search' },
        text: 'airpa',
        submit: true,
      },
      { browser } as never
    );

    expect(browser.type).toHaveBeenCalledWith('#search', 'airpa', { clear: true });
    expect(browser.native.keyPress).toHaveBeenCalledWith('Enter');
    expect(result.structuredContent).toMatchObject({
      data: {
        target: {
          selector: '#search',
          source: 'selector',
        },
        submitted: true,
        submitRequested: true,
        submitAttempted: true,
        submitMethod: 'native-enter',
        submitFallbackUsed: false,
        submitEffectVerified: false,
        verified: true,
        verificationMethod: 'input-value',
        primaryEffect: 'none',
        effectSignals: [],
        verificationEvidence: {
          valueMatched: true,
          submitRequested: true,
          submitAttempted: true,
          submitMethod: 'native-enter',
          submitFallbackUsed: false,
          submitEffectVerified: false,
          inputProbe: {
            events: {
              keydown: 1,
              beforeinput: 1,
              input: 1,
            },
            trustedEvents: {
              keydown: 1,
              beforeinput: 1,
              input: 1,
            },
            lastInputType: 'insertText',
            active: true,
          },
        },
      },
    });
  });

  it('text click helper rejects unverified no-op clicks', async () => {
    const browser = {
      hasCapability: vi.fn((name: string) => name === 'text.dom'),
      getViewport: vi.fn().mockResolvedValue({
        width: 100,
        height: 100,
        aspectRatio: 1,
        devicePixelRatio: 1,
      }),
      clickText: vi.fn().mockResolvedValue({
        matchSource: 'dom',
        clickMethod: 'dom-click',
        matchedTag: 'A',
        clickTargetTag: 'A',
        href: 'https://example.test/help',
      }),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(createFingerprint());
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserClickText(
      {
        target: { text: 'Learn more' },
      },
      { browser } as never
    );

    expect(result.isError).toBe(true);
    expect((result.structuredContent as any)?.error?.code).toBe('ACTION_UNVERIFIED');
  });

  it('text click helper reports the actual match source and click method', async () => {
    const browser = {
      hasCapability: vi.fn((name: string) => name === 'text.dom'),
      getViewport: vi.fn().mockResolvedValue({
        width: 100,
        height: 100,
        aspectRatio: 1,
        devicePixelRatio: 1,
      }),
      clickText: vi.fn().mockResolvedValue({
        matchSource: 'dom',
        clickMethod: 'dom-anchor-assign',
        matchedTag: 'DIV',
        clickTargetTag: 'A',
        href: 'https://example.test/help',
      }),
      getCurrentUrl: vi
        .fn()
        .mockResolvedValueOnce('https://example.test/')
        .mockResolvedValueOnce('https://example.test/help'),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(
            createFingerprint(
              browser.getCurrentUrl.mock.calls.length > 1
                ? 'https://example.test/help'
                : 'https://example.test/'
            )
          );
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserClickText(
      {
        target: { text: 'Learn more' },
      },
      { browser } as never
    );

    expect(result.structuredContent).toMatchObject({
      data: {
        target: {
          text: 'Learn more',
          strategy: 'auto',
        },
        matchSource: 'dom',
        clickMethod: 'dom-anchor-assign',
        matchedTag: 'DIV',
        clickTargetTag: 'A',
        href: 'https://example.test/help',
        verified: true,
      },
    });
  });

  it('text click helper preserves structured errors from the integrated browser', async () => {
    const browser = {
      hasCapability: vi.fn((name: string) => name === 'text.dom'),
      getViewport: vi.fn().mockResolvedValue({
        width: 100,
        height: 100,
        aspectRatio: 1,
        devicePixelRatio: 1,
      }),
      clickText: vi
        .fn()
        .mockRejectedValue(createStructuredError(ErrorCode.ELEMENT_NOT_INTERACTABLE, 'text target not clickable')),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(createFingerprint());
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserClickText(
      {
        target: { text: 'Learn more' },
      },
      { browser } as never
    );

    expect(result.isError).toBe(true);
    expect((result.structuredContent as any)?.error).toMatchObject({
      code: 'ELEMENT_NOT_INTERACTABLE',
      message: 'text target not clickable',
    });
  });

  it('element type helper retries submit via DOM form submission after Enter wait timeout', async () => {
    const browser = {
      type: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi
        .fn()
        .mockRejectedValueOnce(new Error('first miss'))
        .mockResolvedValueOnce(undefined),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
      native: {
        keyPress: vi.fn().mockResolvedValue(undefined),
      },
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(createFingerprint());
        }
        if (script.includes('const el = engine?.querySelector') && script.includes('form.requestSubmit')) {
          return Promise.resolve({
            submitted: true,
            method: 'requestSubmit',
            formPresent: true,
            targetTag: 'INPUT',
            formTag: 'FORM',
            dispatchResult: null,
          });
        }
        if (script.includes('const el = engine?.querySelector')) {
          return Promise.resolve({
            value: 'airpa',
            textContent: '',
            active: true,
          });
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserType(
      {
        target: { selector: '#search' },
        text: 'airpa',
        submit: true,
        verify: { kind: 'element', selector: '#done' },
        timeoutMs: 1,
      },
      { browser } as never
    );

    expect(browser.native.keyPress).toHaveBeenCalledWith('Enter');
    expect(result.structuredContent).toMatchObject({
      data: {
        submitted: true,
        submitRequested: true,
        submitAttempted: true,
        submitMethod: 'requestSubmit',
        submitFallbackUsed: true,
        submitEffectVerified: true,
        verified: true,
        waitApplied: true,
        primaryEffect: 'waitFor',
        effectSignals: ['waitFor'],
        waitTarget: {
          type: 'selector',
          value: '#done',
          selector: '#done',
        },
        verificationEvidence: {
          submitFallback: {
            submitted: true,
            method: 'requestSubmit',
            formPresent: true,
            targetTag: 'INPUT',
            formTag: 'FORM',
            dispatchResult: null,
          },
          submitRequested: true,
          submitAttempted: true,
          submitMethod: 'requestSubmit',
          submitFallbackUsed: true,
          submitEffectVerified: true,
        },
      },
    });
  });

  it('element type helper retries submit via DOM form submission when Enter produces no verified effect', async () => {
    let fallbackSubmitted = false;
    const browser = {
      type: vi.fn().mockResolvedValue(undefined),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
      native: {
        keyPress: vi.fn().mockResolvedValue(undefined),
      },
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(
            createFingerprint(
              fallbackSubmitted ? 'https://example.test/after-submit' : 'https://example.test/'
            )
          );
        }
        if (script.includes('const el = engine?.querySelector') && script.includes('form.requestSubmit')) {
          fallbackSubmitted = true;
          return Promise.resolve({
            submitted: true,
            method: 'requestSubmit',
            formPresent: true,
            targetTag: 'INPUT',
            formTag: 'FORM',
            dispatchResult: null,
          });
        }
        if (script.includes('const el = engine?.querySelector')) {
          return Promise.resolve({
            value: 'airpa',
            textContent: '',
            active: true,
          });
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserType(
      {
        target: { selector: '#search' },
        text: 'airpa',
        submit: true,
      },
      { browser } as never
    );

    expect(result.isError).not.toBe(true);
    expect(browser.native.keyPress).toHaveBeenCalledWith('Enter');
    expect(result.structuredContent).toMatchObject({
      data: {
        submitted: true,
        submitRequested: true,
        submitAttempted: true,
        submitMethod: 'requestSubmit',
        submitFallbackUsed: true,
        submitEffectVerified: true,
        verified: true,
        navigationOccurred: true,
        primaryEffect: 'url-changed',
        effectSignals: ['url-changed', 'dom-changed'],
        verificationEvidence: {
          submitFallback: {
            submitted: true,
            method: 'requestSubmit',
            formPresent: true,
            targetTag: 'INPUT',
            formTag: 'FORM',
            dispatchResult: null,
          },
        },
      },
    });
  });
});
