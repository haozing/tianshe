import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserCapabilityCatalog } from '../browser-catalog';
import { handleBrowserSearch } from './handlers/navigation';
import { handleBrowserSnapshot, handleBrowserObserve } from './handlers/observation';
import { handleBrowserAct, handleBrowserDebugState } from './handlers/workflow';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

const browserCatalog = createBrowserCapabilityCatalog();

function createSnapshot() {
  return {
    url: 'https://example.test/',
    title: 'Example',
    summary: {
      pageType: 'detail',
      confidence: 0.9,
      intent: 'Inspect an example page',
      structure: {
        hasHeader: true,
        hasNavigation: true,
        hasMainContent: true,
        hasSidebar: false,
        hasFooter: true,
        mainHeading: 'Example Domain',
        sections: [{ heading: 'Main', elementCount: 2 }],
      },
      keyElements: {
        forms: 0,
        textInputs: 0,
        passwordInputs: 0,
        checkboxes: 0,
        radioButtons: 0,
        selectBoxes: 0,
        buttons: 1,
        links: 1,
        images: 0,
      },
      primaryActions: [
        {
          type: 'button',
          text: 'Continue',
          attributes: { id: 'continue' },
        },
      ],
      primaryInputs: [],
      secondaryLinks: [{ text: 'More information', href: 'https://www.iana.org/' }],
    },
    elements: [
      {
        tag: 'button',
        role: 'button',
        name: 'Continue',
        text: 'Continue',
        preferredSelector: '#continue',
        selectorCandidates: ['#continue', 'button.primary'],
        elementRef: 'airpa_el:example',
        inViewport: true,
        bounds: {
          x: 16,
          y: 24,
          width: 100,
          height: 32,
        },
        attributes: {
          id: 'continue',
          class: 'primary',
        },
      },
    ],
  };
}

function createFingerprint(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    url: 'https://example.test/',
    title: 'Example',
    readyState: 'complete',
    bodyTextSample: 'Example body',
    bodyTextLength: 12,
    activeTag: 'BUTTON',
    activeType: '',
    historyLength: 1,
    ...overrides,
  };
}

function expectSchemaMatch(toolName: string, result: { structuredContent?: unknown; isError?: boolean }) {
  expect(result.isError).not.toBe(true);
  const validator = ajv.compile(browserCatalog[toolName].definition.outputSchema);
  const valid = validator(result.structuredContent);
  expect(valid, JSON.stringify(validator.errors, null, 2)).toBe(true);
}

describe('browser output schema contract', () => {
  it('validates browser_snapshot structured content against its output schema', async () => {
    const result = await handleBrowserSnapshot(
      {
        elementsFilter: 'all',
        maxElements: 10,
      },
      {
        browser: {
          snapshot: vi.fn().mockResolvedValue(createSnapshot()),
          evaluate: vi.fn().mockResolvedValue({ width: 1280, height: 720 }),
        },
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

    expectSchemaMatch('browser_snapshot', result);
  });

  it('validates browser_observe structured content against its output schema', async () => {
    const result = await handleBrowserObserve(
      {
        url: 'https://example.test/',
        wait: { kind: 'element', selector: '#continue' },
        maxElements: 10,
      },
      {
        browser: {
          goto: vi.fn().mockResolvedValue(undefined),
          waitForSelector: vi.fn().mockResolvedValue(undefined),
          snapshot: vi.fn().mockResolvedValue(createSnapshot()),
          evaluate: vi.fn().mockResolvedValue({ width: 1280, height: 720 }),
          getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
        },
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

    expectSchemaMatch('browser_observe', result);
  });

  it('validates browser_search structured content against its output schema', async () => {
    const result = await handleBrowserSearch(
      {
        query: 'Continue',
        limit: 5,
      },
      {
        browser: {
          search: vi.fn().mockResolvedValue([
            {
              element: createSnapshot().elements[0],
              score: 0.98,
              matchedFields: ['name', 'text'],
            },
          ]),
        },
      } as never
    );

    expectSchemaMatch('browser_search', result);
  });

  it('validates browser_act output for all canonical action variants', async () => {
    const clickResult = await handleBrowserAct(
      {
        action: 'click',
        target: { kind: 'element', selector: '#continue' },
        verify: { kind: 'element', selector: '#done' },
        timeoutMs: 1200,
      },
      {
        browser: {
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
        },
      } as never
    );
    expectSchemaMatch('browser_act', clickResult);

    const typeResult = await handleBrowserAct(
      {
        action: 'type',
        target: { kind: 'element', selector: '#search' },
        text: 'airpa',
        submit: true,
      },
      {
        browser: {
          type: vi.fn().mockResolvedValue(undefined),
          getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
          native: {
            keyPress: vi.fn().mockResolvedValue(undefined),
          },
          evaluate: vi.fn().mockImplementation((script: string) => {
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
        },
      } as never
    );
    expectSchemaMatch('browser_act', typeResult);

    const pressResult = await handleBrowserAct(
      {
        action: 'press',
        target: { kind: 'key', key: 'Enter', modifiers: ['shift'] },
      },
      {
        browser: {
          native: {
            keyPress: vi.fn().mockResolvedValue(undefined),
          },
          getCurrentUrl: vi.fn().mockResolvedValue('https://example.test/'),
          evaluate: vi
            .fn()
            .mockResolvedValueOnce(createFingerprint({ bodyTextSample: 'before' }))
            .mockResolvedValueOnce(createFingerprint({ bodyTextSample: 'after', bodyTextLength: 5 })),
        },
      } as never
    );
    expectSchemaMatch('browser_act', pressResult);

    const clickTextResult = await handleBrowserAct(
      {
        action: 'click',
        target: { kind: 'text', text: 'Continue', exactMatch: true },
        verify: { kind: 'text', text: 'clicked' },
        timeoutMs: 1200,
      },
      {
        browser: {
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
              return Promise.resolve(createFingerprint({ bodyTextSample: 'clicked' }));
            }
            return Promise.resolve(undefined);
          }),
        },
      } as never
    );
    expectSchemaMatch('browser_act', clickTextResult);
  });

  it('validates browser_debug_state structured content against its output schema', async () => {
    const result = await handleBrowserDebugState(
      {
        includeConsole: true,
        includeNetwork: true,
        includeScreenshot: true,
        captureMode: 'viewport',
      },
      {
        browser: {
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
            {
              level: 'info',
              message: 'ready',
              source: 'console',
              timestamp: Date.now(),
            },
          ]),
          getNetworkSummary: vi.fn().mockReturnValue({
            total: 2,
            byType: { document: 1, api: 1 },
            byMethod: { GET: 2 },
            failed: [],
            slow: [],
            apiCalls: [],
          }),
        },
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

    expectSchemaMatch('browser_debug_state', result);
  });
});
