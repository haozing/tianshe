import { describe, expect, it, vi } from 'vitest';
import {
  handleBrowserAct,
  handleBrowserDebugState,
  handleBrowserObserve,
  handleBrowserSearch,
  handleBrowserSnapshot,
  handleBrowserWaitFor,
} from './browser-handlers';
import type { SearchOptions } from '../../../../../types/browser-interface';
import { decorateSnapshotElementsWithRefs } from '../../../../browser-automation/element-ref';
import { searchSnapshotElements } from '../../../../browser-automation/search-runtime';

function createFingerprint(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    url: 'https://example.test/',
    title: 'Example',
    readyState: 'complete',
    bodyTextSample: 'Search catalog',
    bodyTextLength: 14,
    activeTag: 'INPUT',
    activeType: 'text',
    historyLength: 1,
    ...overrides,
  };
}

function createSnapshot(url: string = 'https://example.test/') {
  return {
    url,
    title: 'Example',
    elements: decorateSnapshotElementsWithRefs([
      {
        tag: 'input',
        role: 'textbox',
        name: 'Search catalog',
        text: '',
        value: '',
        preferredSelector: '#search',
        selectorCandidates: ['#search', 'input[name="q"]'],
        inViewport: true,
        bounds: {
          x: 24,
          y: 16,
          width: 180,
          height: 28,
        },
      },
      {
        tag: 'button',
        role: 'button',
        name: 'Search',
        text: 'Search',
        preferredSelector: '#submit',
        selectorCandidates: ['#submit', 'button[type="submit"]'],
        inViewport: true,
        bounds: {
          x: 220,
          y: 16,
          width: 90,
          height: 28,
        },
      },
    ]),
  };
}

function createEngineBrowser(engine: 'electron' | 'extension' | 'ruyi') {
  let currentUrl = 'https://example.test/';
  return {
    goto: vi.fn().mockImplementation(async (url: string) => {
      currentUrl = url;
    }),
    snapshot: vi.fn().mockImplementation(async () => createSnapshot(currentUrl)),
    search: vi
      .fn()
      .mockImplementation((query: string, options?: SearchOptions) =>
        Promise.resolve(searchSnapshotElements(query, createSnapshot(currentUrl).elements, options))
      ),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    getCurrentUrl: vi.fn().mockImplementation(async () => currentUrl),
    getViewport: vi.fn().mockResolvedValue({
      width: 1280,
      height: 720,
      aspectRatio: 16 / 9,
      devicePixelRatio: 1,
    }),
    textExists: vi.fn().mockResolvedValue(true),
    getConsoleMessages: vi.fn().mockReturnValue([
      {
        level: 'error',
        message: 'shared-console',
        source: 'console',
        timestamp: 123,
      },
    ]),
    getNetworkSummary: vi.fn().mockReturnValue({
      total: 1,
      byType: { api: 1 },
      byMethod: { GET: 1 },
      failed: [],
      slow: [],
      apiCalls: [
        {
          id: 'shared-req-1',
          url: 'https://example.test/api/search',
          method: 'GET',
          resourceType: 'xhr',
          classification: 'api',
          startTime: 1,
        },
      ],
    }),
    evaluate: vi.fn().mockImplementation((script: string) => {
      if (script.includes('window.innerWidth')) {
        return Promise.resolve({ width: 1280, height: 720 });
      }
      if (script.includes('window.__airpaClickProbes = window.__airpaClickProbes || {}')) {
        return Promise.resolve(`${engine}-click-probe`);
      }
      if (script.includes('window.__airpaClickProbes?.[')) {
        return Promise.resolve({
          events: 1,
          lastTrusted: engine === 'electron',
          lastTag: 'BUTTON',
        });
      }
      if (script.includes('delete window.__airpaClickProbes[probeId]')) {
        return Promise.resolve(undefined);
      }
      if (script.includes('window.__airpaInputProbes = window.__airpaInputProbes || {}')) {
        return Promise.resolve(`${engine}-input-probe`);
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
      if (script.includes('const el = engine?.querySelector')) {
        return Promise.resolve({
          value: 'airpa',
          textContent: '',
          active: true,
        });
      }
      if (script.includes('document.body?.innerText')) {
        return Promise.resolve(createFingerprint());
      }
      return Promise.resolve(undefined);
    }),
  };
}

function getData(result: Awaited<ReturnType<typeof handleBrowserObserve>>) {
  return (result.structuredContent as { data?: Record<string, unknown> } | undefined)?.data || {};
}

function pickObserveContract(data: Record<string, unknown>) {
  return {
    currentUrl: data.currentUrl,
    navigationPerformed: data.navigationPerformed,
    waitApplied: data.waitApplied,
    elementsFilter: data.elementsFilter,
    returnedElementCount: data.returnedElementCount,
    interactionReady: data.interactionReady,
    viewportHealth: data.viewportHealth,
    snapshotElements: (data.snapshot as { elements?: Array<Record<string, unknown>> } | undefined)?.elements?.map(
      (element) => ({
        selector: element.preferredSelector,
        ref: element.elementRef,
        role: element.role,
      })
    ),
  };
}

function pickObserveNavigationContract(data: Record<string, unknown>) {
  return {
    currentUrl: data.currentUrl,
    navigationPerformed: data.navigationPerformed,
    waitApplied: data.waitApplied,
    waitTarget: data.waitTarget,
    interactionReady: data.interactionReady,
    viewportHealth: data.viewportHealth,
    returnedElementCount: data.returnedElementCount,
  };
}

function pickSnapshotContract(data: Record<string, unknown>) {
  return {
    url: data.url,
    title: data.title,
    elementsFilter: data.elementsFilter,
    returnedElementCount: data.returnedElementCount,
    interactionReady: data.interactionReady,
    viewportHealth: data.viewportHealth,
    snapshotElements: (data.snapshot as { elements?: Array<Record<string, unknown>> } | undefined)?.elements?.map(
      (element) => ({
        selector: element.preferredSelector,
        ref: element.elementRef,
        role: element.role,
      })
    ),
  };
}

function pickSearchContract(data: Record<string, unknown>) {
  return {
    query: data.query,
    total: data.total,
    results: (data.results as Array<Record<string, unknown>> | undefined)?.map((result) => ({
      selector: (result.element as Record<string, unknown> | undefined)?.preferredSelector,
      ref: (result.element as Record<string, unknown> | undefined)?.elementRef,
      role: (result.element as Record<string, unknown> | undefined)?.role,
      score: result.score,
      matchedFields: result.matchedFields,
    })),
  };
}

function pickActTypeContract(data: Record<string, unknown>) {
  return {
    action: data.action,
    delegatedTool: data.delegatedTool,
    verified: data.verified,
    primaryEffect: data.primaryEffect,
    effectSignals: data.effectSignals,
    submitRequested: data.submitRequested,
    submitted: data.submitted,
    target: data.target,
    resolvedTarget: data.resolvedTarget,
  };
}

function pickClickEffectContract(data: Record<string, unknown>) {
  return {
    action: data.action,
    delegatedTool: data.delegatedTool,
    verified: data.verified,
    primaryEffect: data.primaryEffect,
    effectSignals: data.effectSignals,
    target: data.target,
    resolvedTarget: data.resolvedTarget,
  };
}

function pickDebugContract(data: Record<string, unknown>) {
  return {
    interactionReady: data.interactionReady,
    viewportHealth: data.viewportHealth,
    console: data.console,
    network: data.network,
  };
}

function pickWaitForContract(data: Record<string, unknown>) {
  return {
    matched: data.matched,
    condition: data.condition,
    selector: data.selector,
    source: data.source,
    ref: data.ref,
    waitTarget: data.waitTarget,
    url: data.url,
  };
}

describe('browser handler cross-engine contracts', () => {
  it('keeps browser_observe output aligned across electron, extension, and ruyi stubs', async () => {
    const electronBrowser = createEngineBrowser('electron');
    const extensionBrowser = createEngineBrowser('extension');
    const ruyiBrowser = createEngineBrowser('ruyi');

    const [electronResult, extensionResult, ruyiResult] = await Promise.all([
      handleBrowserObserve({}, { browser: electronBrowser } as never),
      handleBrowserObserve({}, { browser: extensionBrowser } as never),
      handleBrowserObserve({}, { browser: ruyiBrowser } as never),
    ]);

    expect(pickObserveContract(getData(electronResult))).toEqual(
      pickObserveContract(getData(extensionResult))
    );
    expect(pickObserveContract(getData(electronResult))).toEqual(
      pickObserveContract(getData(ruyiResult))
    );
  });

  it('keeps browser_observe navigation and wait semantics aligned across engines', async () => {
    const electronBrowser = createEngineBrowser('electron');
    const extensionBrowser = createEngineBrowser('extension');
    const ruyiBrowser = createEngineBrowser('ruyi');

    const [electronResult, extensionResult, ruyiResult] = await Promise.all([
      handleBrowserObserve(
        {
          url: 'https://example.test/search',
          wait: { kind: 'element', selector: '#submit', state: 'visible' },
          waitTimeoutMs: 500,
        },
        { browser: electronBrowser } as never
      ),
      handleBrowserObserve(
        {
          url: 'https://example.test/search',
          wait: { kind: 'element', selector: '#submit', state: 'visible' },
          waitTimeoutMs: 500,
        },
        { browser: extensionBrowser } as never
      ),
      handleBrowserObserve(
        {
          url: 'https://example.test/search',
          wait: { kind: 'element', selector: '#submit', state: 'visible' },
          waitTimeoutMs: 500,
        },
        { browser: ruyiBrowser } as never
      ),
    ]);

    expect(pickObserveNavigationContract(getData(electronResult))).toEqual(
      pickObserveNavigationContract(getData(extensionResult))
    );
    expect(pickObserveNavigationContract(getData(electronResult))).toEqual(
      pickObserveNavigationContract(getData(ruyiResult))
    );
    expect(getData(electronResult)).toMatchObject({
      currentUrl: 'https://example.test/search',
      navigationPerformed: true,
      waitApplied: true,
      waitTarget: {
        type: 'selector',
        selector: '#submit',
        source: 'selector',
        state: 'visible',
      },
    });
  });

  it('keeps browser_snapshot output aligned across electron, extension, and ruyi stubs', async () => {
    const electronBrowser = createEngineBrowser('electron');
    const extensionBrowser = createEngineBrowser('extension');
    const ruyiBrowser = createEngineBrowser('ruyi');

    const [electronResult, extensionResult, ruyiResult] = await Promise.all([
      handleBrowserSnapshot(
        { elementsFilter: 'all', maxElements: 10 },
        { browser: electronBrowser } as never
      ),
      handleBrowserSnapshot(
        { elementsFilter: 'all', maxElements: 10 },
        { browser: extensionBrowser } as never
      ),
      handleBrowserSnapshot(
        { elementsFilter: 'all', maxElements: 10 },
        { browser: ruyiBrowser } as never
      ),
    ]);

    expect(pickSnapshotContract(getData(electronResult))).toEqual(
      pickSnapshotContract(getData(extensionResult))
    );
    expect(pickSnapshotContract(getData(electronResult))).toEqual(
      pickSnapshotContract(getData(ruyiResult))
    );
    expect(getData(electronResult)).toMatchObject({
      elementsFilter: 'all',
      returnedElementCount: 2,
      snapshot: {
        elements: [
          { elementRef: expect.stringMatching(/^airpa_el:/) },
          { elementRef: expect.stringMatching(/^airpa_el:/) },
        ],
      },
    });
  });

  it('keeps browser_search output aligned across electron, extension, and ruyi stubs', async () => {
    const electronBrowser = createEngineBrowser('electron');
    const extensionBrowser = createEngineBrowser('extension');
    const ruyiBrowser = createEngineBrowser('ruyi');

    const [electronResult, extensionResult, ruyiResult] = await Promise.all([
      handleBrowserSearch({ query: 'search', limit: 5 }, { browser: electronBrowser } as never),
      handleBrowserSearch({ query: 'search', limit: 5 }, { browser: extensionBrowser } as never),
      handleBrowserSearch({ query: 'search', limit: 5 }, { browser: ruyiBrowser } as never),
    ]);

    expect(pickSearchContract(getData(electronResult))).toEqual(
      pickSearchContract(getData(extensionResult))
    );
    expect(pickSearchContract(getData(electronResult))).toEqual(
      pickSearchContract(getData(ruyiResult))
    );
  });

  it('keeps browser_search exactMatch and roleFilter semantics aligned across engines', async () => {
    const electronBrowser = createEngineBrowser('electron');
    const extensionBrowser = createEngineBrowser('extension');
    const ruyiBrowser = createEngineBrowser('ruyi');

    const [electronResult, extensionResult, ruyiResult] = await Promise.all([
      handleBrowserSearch(
        { query: 'Search', exactMatch: true, roleFilter: 'button', limit: 5 },
        { browser: electronBrowser } as never
      ),
      handleBrowserSearch(
        { query: 'Search', exactMatch: true, roleFilter: 'button', limit: 5 },
        { browser: extensionBrowser } as never
      ),
      handleBrowserSearch(
        { query: 'Search', exactMatch: true, roleFilter: 'button', limit: 5 },
        { browser: ruyiBrowser } as never
      ),
    ]);

    const electronData = getData(electronResult);
    const extensionData = getData(extensionResult);
    const ruyiData = getData(ruyiResult);

    expect(pickSearchContract(electronData)).toEqual(pickSearchContract(extensionData));
    expect(pickSearchContract(electronData)).toEqual(pickSearchContract(ruyiData));
    expect(electronData).toMatchObject({
      total: 1,
      query: 'Search',
      results: [
        {
          element: {
            preferredSelector: '#submit',
            role: 'button',
            elementRef: expect.stringMatching(/^airpa_el:/),
          },
          matchedFields: ['name', 'text'],
        },
      ],
    });
  });

  it('keeps browser_act type semantics aligned across electron, extension, and ruyi stubs', async () => {
    const electronBrowser = createEngineBrowser('electron');
    const extensionBrowser = createEngineBrowser('extension');
    const ruyiBrowser = createEngineBrowser('ruyi');

    const [electronResult, extensionResult, ruyiResult] = await Promise.all([
      handleBrowserAct(
        {
          action: 'type',
          target: { kind: 'element', selector: '#search' },
          text: 'airpa',
        },
        { browser: electronBrowser } as never
      ),
      handleBrowserAct(
        {
          action: 'type',
          target: { kind: 'element', selector: '#search' },
          text: 'airpa',
        },
        { browser: extensionBrowser } as never
      ),
      handleBrowserAct(
        {
          action: 'type',
          target: { kind: 'element', selector: '#search' },
          text: 'airpa',
        },
        { browser: ruyiBrowser } as never
      ),
    ]);

    expect(pickActTypeContract(getData(electronResult))).toEqual(
      pickActTypeContract(getData(extensionResult))
    );
    expect(pickActTypeContract(getData(electronResult))).toEqual(
      pickActTypeContract(getData(ruyiResult))
    );
  });

  it('keeps browser_act click effect semantics aligned even when click transport differs', async () => {
    const electronBrowser = createEngineBrowser('electron');
    const extensionBrowser = createEngineBrowser('extension');
    const ruyiBrowser = createEngineBrowser('ruyi');

    const [electronResult, extensionResult, ruyiResult] = await Promise.all([
      handleBrowserAct(
        {
          action: 'click',
          target: { kind: 'element', selector: '#submit' },
        },
        { browser: electronBrowser } as never
      ),
      handleBrowserAct(
        {
          action: 'click',
          target: { kind: 'element', selector: '#submit' },
        },
        { browser: extensionBrowser } as never
      ),
      handleBrowserAct(
        {
          action: 'click',
          target: { kind: 'element', selector: '#submit' },
        },
        { browser: ruyiBrowser } as never
      ),
    ]);

    expect(pickClickEffectContract(getData(electronResult))).toEqual(
      pickClickEffectContract(getData(extensionResult))
    );
    expect(pickClickEffectContract(getData(extensionResult))).toEqual(
      pickClickEffectContract(getData(ruyiResult))
    );
    expect(getData(electronResult)).toMatchObject({ clickMethod: 'native-click' });
    expect(getData(extensionResult)).toMatchObject({ clickMethod: 'dom-click' });
    expect(getData(ruyiResult)).toMatchObject({ clickMethod: 'dom-click' });
  });

  it('keeps browser_wait_for selector semantics aligned across engines', async () => {
    const electronBrowser = createEngineBrowser('electron');
    const extensionBrowser = createEngineBrowser('extension');
    const ruyiBrowser = createEngineBrowser('ruyi');

    const [electronResult, extensionResult, ruyiResult] = await Promise.all([
      handleBrowserWaitFor(
        {
          condition: { kind: 'element', selector: '#submit', state: 'visible' },
          timeoutMs: 500,
        },
        { browser: electronBrowser } as never
      ),
      handleBrowserWaitFor(
        {
          condition: { kind: 'element', selector: '#submit', state: 'visible' },
          timeoutMs: 500,
        },
        { browser: extensionBrowser } as never
      ),
      handleBrowserWaitFor(
        {
          condition: { kind: 'element', selector: '#submit', state: 'visible' },
          timeoutMs: 500,
        },
        { browser: ruyiBrowser } as never
      ),
    ]);

    expect(pickWaitForContract(getData(electronResult))).toEqual(
      pickWaitForContract(getData(extensionResult))
    );
    expect(pickWaitForContract(getData(electronResult))).toEqual(
      pickWaitForContract(getData(ruyiResult))
    );
    expect(getData(electronResult)).toMatchObject({
      matched: true,
      selector: '#submit',
      source: 'selector',
      waitTarget: {
        type: 'selector',
        selector: '#submit',
        source: 'selector',
        state: 'visible',
      },
    });
  });

  it('keeps browser_debug_state console and network structure aligned across engines', async () => {
    const electronBrowser = createEngineBrowser('electron');
    const extensionBrowser = createEngineBrowser('extension');
    const ruyiBrowser = createEngineBrowser('ruyi');

    const [electronResult, extensionResult, ruyiResult] = await Promise.all([
      handleBrowserDebugState(
        {
          includeScreenshot: false,
          includeConsole: true,
          includeNetwork: true,
        },
        { browser: electronBrowser } as never
      ),
      handleBrowserDebugState(
        {
          includeScreenshot: false,
          includeConsole: true,
          includeNetwork: true,
        },
        { browser: extensionBrowser } as never
      ),
      handleBrowserDebugState(
        {
          includeScreenshot: false,
          includeConsole: true,
          includeNetwork: true,
        },
        { browser: ruyiBrowser } as never
      ),
    ]);

    expect(pickDebugContract(getData(electronResult))).toEqual(
      pickDebugContract(getData(extensionResult))
    );
    expect(pickDebugContract(getData(electronResult))).toEqual(
      pickDebugContract(getData(ruyiResult))
    );
  });

});
