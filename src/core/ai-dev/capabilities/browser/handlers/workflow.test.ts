import { describe, expect, it, vi } from 'vitest';
import { handleBrowserAct, handleBrowserDebugState } from './workflow';

function createFingerprint(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    url: 'https://example.test/',
    title: 'Example',
    readyState: 'complete',
    bodyTextSample: 'Example body',
    bodyTextLength: 12,
    activeTag: 'INPUT',
    activeType: 'text',
    historyLength: 1,
    ...overrides,
  };
}

function createSnapshot() {
  return {
    url: 'https://example.test/',
    title: 'Example',
    summary: 'Example page',
    elements: [
      {
        tag: 'button',
        text: 'Go',
        role: 'button',
        preferredSelector: '#go',
        elementRef: 'element-1',
        inViewport: true,
        bounds: {
          x: 16,
          y: 24,
          width: 80,
          height: 24,
        },
      },
    ],
  };
}

describe('browser workflow handlers', () => {
  it('browser_act wraps click actions with the delegated tool name', async () => {
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
          return Promise.resolve(createFingerprint({ url: 'https://example.test/after' }));
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserAct(
      {
        action: 'click',
        target: { kind: 'element', selector: '#go' },
        verify: { kind: 'element', selector: '#done' },
        timeoutMs: 1200,
      },
      { browser } as never
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        action: 'click',
        delegatedTool: 'browser_act.click',
        verified: true,
        verificationMethod: 'waitFor',
        primaryEffect: 'waitFor',
        effectSignals: ['waitFor'],
        target: {
          kind: 'element',
          selector: '#go',
        },
        resolvedTarget: {
          selector: '#go',
          source: 'selector',
        },
        waitTarget: {
          type: 'selector',
          value: '#done',
        },
        clickMethod: 'native-click',
        fallbackUsed: false,
      },
    });
    expect((result.structuredContent as any)?.data?.attempts).toBeUndefined();
    expect((result.structuredContent as any)?.data?.verificationEvidence).toBeUndefined();
  });

  it('browser_act wraps type actions and preserves submit metadata', async () => {
    const browser = {
      type: vi.fn().mockResolvedValue(undefined),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
      native: {
        keyPress: vi.fn().mockResolvedValue(undefined),
      },
      evaluate: vi.fn().mockImplementation((script: string) => {
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

    const result = await handleBrowserAct(
      {
        action: 'type',
        target: { kind: 'element', selector: '#search' },
        text: 'airpa',
        submit: true,
      },
      { browser } as never
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        action: 'type',
        delegatedTool: 'browser_act.type',
        verified: true,
        primaryEffect: 'none',
        effectSignals: [],
        submitRequested: true,
        submitted: true,
      },
    });
    expect((result.structuredContent as any)?.data?.attempts).toBeUndefined();
    expect((result.structuredContent as any)?.data?.verificationEvidence).toBeUndefined();
  });

  it('browser_act wraps text-target click actions with the delegated tool name', async () => {
    const browser = {
      hasCapability: vi.fn((name: string) => name === 'text.dom'),
      getViewport: vi.fn().mockResolvedValue({
        width: 100,
        height: 100,
        aspectRatio: 1,
        devicePixelRatio: 1,
      }),
      clickAtNormalized: vi.fn(),
      clickText: vi.fn().mockResolvedValue({
        matchSource: 'dom',
        clickMethod: 'dom-click',
        matchedTag: 'BUTTON',
        clickTargetTag: 'BUTTON',
        href: null,
      }),
      textExists: vi.fn().mockResolvedValue(true),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(createFingerprint({ bodyTextSample: 'text-clicked' }));
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserAct(
      {
        action: 'click',
        target: { kind: 'text', text: 'Text Action', exactMatch: true },
        verify: { kind: 'text', text: 'text-clicked' },
        timeoutMs: 1200,
      },
      { browser } as never
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        action: 'click',
        delegatedTool: 'browser_act.click_text',
        verified: true,
        primaryEffect: 'waitFor',
        effectSignals: ['waitFor'],
        target: {
          kind: 'text',
          text: 'Text Action',
          strategy: 'auto',
        },
        resolvedTarget: null,
        clickMethod: 'dom-click',
      },
    });
    expect((result.structuredContent as any)?.data?.attempts).toBeUndefined();
    expect((result.structuredContent as any)?.data?.verificationEvidence).toBeUndefined();
  });

  it('browser_act supports press actions directly', async () => {
    const browser = {
      native: {
        keyPress: vi.fn().mockResolvedValue(undefined),
      },
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(createFingerprint({ bodyTextSample: 'before' }))
        .mockResolvedValueOnce(createFingerprint({ bodyTextSample: 'after', bodyTextLength: 5 })),
    };

    const result = await handleBrowserAct(
      {
        action: 'press',
        target: { kind: 'key', key: 'Enter', modifiers: ['shift'] },
      },
      { browser } as never
    );

    expect(browser.native.keyPress).toHaveBeenCalledWith('Enter', ['shift']);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        action: 'press',
        delegatedTool: 'browser_act.press',
        verified: true,
        primaryEffect: 'dom-changed',
        effectSignals: ['dom-changed'],
        target: {
          kind: 'key',
          key: 'Enter',
          modifiers: ['shift'],
        },
      },
    });
    expect((result.structuredContent as any)?.data?.attempts).toBeUndefined();
    expect((result.structuredContent as any)?.data?.verificationEvidence).toBeUndefined();
  });

  it('browser_act compacts delegated action errors and routes diagnostics through browser_debug_state', async () => {
    const browser = {
      click: vi.fn().mockResolvedValue(undefined),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/start'),
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
          return Promise.resolve({
            clicked: false,
            href: null,
            anchorTag: null,
            dispatchAllowed: null,
          });
        }
        if (script.includes('clickTarget.click()')) {
          return Promise.resolve({
            clicked: false,
            clickTargetTag: null,
            href: null,
          });
        }
        if (script.includes("closest('a[href]')")) {
          return Promise.resolve(null);
        }
        if (script.includes('document.body?.innerText')) {
          return Promise.resolve(createFingerprint({ url: 'https://example.test/start' }));
        }
        return Promise.resolve(undefined);
      }),
    };

    const result = await handleBrowserAct(
      {
        action: 'click',
        target: { kind: 'element', selector: '#go' },
        timeoutMs: 50,
      },
      { browser } as never
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'ACTION_UNVERIFIED',
        context: {
          tool: 'browser_act',
          action: 'click',
          delegatedTool: 'browser_act.click',
          target: {
            kind: 'element',
            selector: '#go',
          },
          resolvedTarget: {
            selector: '#go',
            source: 'selector',
          },
          primaryEffect: 'none',
          effectSignals: [],
          debug: {
            attempts: expect.arrayContaining([
              expect.objectContaining({ method: 'native-click', verified: false }),
              expect.objectContaining({ method: 'dom-click', verified: false }),
              expect.objectContaining({ method: 'dom-anchor-assign', verified: false }),
            ]),
          },
        },
        recommendedNextTools: expect.arrayContaining([
          'browser_debug_state',
          'browser_snapshot',
          'browser_search',
        ]),
        nextActionHints: expect.arrayContaining([
          expect.stringContaining('browser_debug_state'),
        ]),
      },
      recommendedNextTools: expect.arrayContaining([
        'browser_debug_state',
        'browser_snapshot',
        'browser_search',
      ]),
    });
    expect((result.structuredContent as any)?.error?.context?.attempts).toBeUndefined();
    expect((result.structuredContent as any)?.error?.context?.verificationEvidence).toBeUndefined();
  });

  it('browser_act keeps press errors compact while preserving debug routing hints', async () => {
    const browser = {
      native: {
        keyPress: vi.fn().mockResolvedValue(undefined),
      },
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(createFingerprint({ bodyTextSample: 'before' }))
        .mockResolvedValueOnce(createFingerprint({ bodyTextSample: 'before' })),
    };

    const result = await handleBrowserAct(
      {
        action: 'press',
        target: { kind: 'key', key: 'Enter', modifiers: ['shift'] },
      },
      { browser } as never
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'ACTION_UNVERIFIED',
        context: {
          tool: 'browser_act',
          action: 'press',
          delegatedTool: 'browser_act.press',
          target: {
            kind: 'key',
            key: 'Enter',
            modifiers: ['shift'],
          },
          primaryEffect: 'none',
          effectSignals: [],
          debug: {
            verification: expect.objectContaining({
              pageChanged: false,
            }),
          },
        },
        recommendedNextTools: expect.arrayContaining([
          'browser_debug_state',
          'browser_snapshot',
          'browser_wait_for',
        ]),
      },
    });
    expect((result.structuredContent as any)?.error?.context?.verificationEvidence).toBeUndefined();
  });

  it('browser_debug_state returns combined snapshot, screenshot, console, and network data', async () => {
    const browser = {
      snapshot: vi.fn().mockResolvedValue(createSnapshot()),
      evaluate: vi.fn().mockResolvedValue({ width: 1280, height: 720 }),
      screenshotDetailed: vi.fn().mockResolvedValue({
        data: 'base64-image',
        mimeType: 'image/png',
        format: 'png',
        captureMode: 'viewport',
        captureMethod: 'electron.capture_page',
        fallbackUsed: false,
        degraded: false,
        degradationReason: null,
      }),
      getConsoleMessages: vi.fn().mockReturnValue([
        { level: 'info', message: 'ready', source: 'console' },
      ]),
      getNetworkSummary: vi.fn().mockReturnValue({
        total: 2,
        byType: { document: 1, api: 1 },
        byMethod: { GET: 2 },
        failed: [],
        slow: [],
        apiCalls: [],
      }),
    };

    const result = await handleBrowserDebugState(
      {
        includeConsole: true,
        includeNetwork: true,
        includeScreenshot: true,
        captureMode: 'viewport',
      },
      {
        browser,
        mcpSessionContext: {
          visible: false,
          hostWindowId: 'host-1',
          viewportHealth: 'ready',
          viewportHealthReason: 'healthy',
          interactionReady: true,
          offscreenDetected: false,
        },
      } as never
    );

    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
    expect(result.structuredContent).toMatchObject({
      data: {
        interactionReady: true,
        viewportHealth: 'ready',
        hostWindowId: 'host-1',
        snapshot: {
          url: 'https://example.test/',
        },
        screenshot: {
          captureMethod: 'electron.capture_page',
          degraded: false,
          fallbackUsed: false,
          format: 'png',
          mimeType: 'image/png',
        },
        console: {
          enabled: true,
          count: 1,
        },
        network: {
          enabled: true,
          summary: {
            total: 2,
          },
        },
      },
    });
  });
});
