import { describe, expect, it, vi } from 'vitest';
import { BrowserSnapshotService } from './snapshot';
import { ExtensionBrowser } from '../browser-extension/extension-browser';
import { RuyiBrowser } from '../browser-ruyi';

function createSnapshotElements() {
  return [
    {
      tag: 'input',
      role: 'textbox',
      name: 'Search catalog',
      text: '',
      value: '',
      preferredSelector: '#search',
      selectorCandidates: ['#search', 'input[name="q"]'],
      inViewport: true,
      bounds: { x: 24, y: 16, width: 180, height: 28 },
    },
    {
      tag: 'button',
      role: 'button',
      name: 'Search',
      text: 'Search',
      preferredSelector: '#submit',
      selectorCandidates: ['#submit', 'button[type="submit"]'],
      inViewport: true,
      bounds: { x: 220, y: 16, width: 90, height: 28 },
    },
  ];
}

function createSnapshotServiceFixture() {
  const elements = createSnapshotElements();
  const webContents = {
    executeJavaScript: vi.fn().mockResolvedValue({ elements }),
  };
  const service = new BrowserSnapshotService({
    getWebContents: () => webContents as never,
    getUrl: () => 'https://example.test/search',
    getTitle: async () => 'Example',
  });

  return { service, webContents };
}

function createExtensionBrowserFixture() {
  const elements = createSnapshotElements();
  const relay = {
    onEvent: vi.fn(() => () => undefined),
    dispatchCommand: vi.fn(async (name: string) => {
      switch (name) {
        case 'evaluate':
          return { elements };
        case 'getCurrentUrl':
          return 'https://example.test/search';
        case 'title':
          return 'Example';
        default:
          return true;
      }
    }),
    getClientState: vi.fn(() => ({
      registeredAt: Date.now(),
      tabId: 11,
      windowId: 5,
      url: 'https://example.test/search',
      title: 'Example',
    })),
    isStopped: vi.fn(() => false),
  } as any;

  return {
    browser: new ExtensionBrowser({
      relay,
      closeInternal: vi.fn(async () => undefined),
      initialClientState: {
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.test/search',
        title: 'Example',
      },
    }),
    relay,
  };
}

function createRuyiBrowserFixture() {
  const elements = createSnapshotElements();
  const client = {
    onEvent: vi.fn(() => () => undefined),
    dispatch: vi.fn(async (name: string) => {
      switch (name) {
        case 'evaluate':
          return { elements };
        case 'getCurrentUrl':
          return 'https://example.test/search';
        case 'title':
          return 'Example';
        default:
          return true;
      }
    }),
    isClosed: vi.fn(() => false),
  } as any;

  return {
    browser: new RuyiBrowser({
      client,
      closeInternal: vi.fn(async () => undefined),
    }),
    client,
  };
}

function pickSnapshotContract(snapshot: Awaited<ReturnType<BrowserSnapshotService['snapshot']>>) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    elements: snapshot.elements.map((element) => ({
      selector: element.preferredSelector,
      ref: element.elementRef,
      role: element.role,
    })),
    network: snapshot.network ?? null,
    console: snapshot.console ?? null,
  };
}

function pickSearchContract(results: Awaited<ReturnType<BrowserSnapshotService['search']>>) {
  return results.map((result) => ({
    selector: result.element.preferredSelector,
    ref: result.element.elementRef,
    role: result.element.role,
    matchedFields: result.matchedFields,
    score: result.score,
  }));
}

describe('browser runtime cross-engine contracts', () => {
  it('keeps snapshot contracts aligned between BrowserSnapshotService, ExtensionBrowser, and RuyiBrowser', async () => {
    const { service } = createSnapshotServiceFixture();
    const { browser: extensionBrowser } = createExtensionBrowserFixture();
    const { browser: ruyiBrowser } = createRuyiBrowserFixture();

    const [serviceSnapshot, extensionSnapshot, ruyiSnapshot] = await Promise.all([
      service.snapshot({
        elementsFilter: 'all',
        includeSummary: false,
        includeNetwork: true,
        includeConsole: true,
      }),
      extensionBrowser.snapshot({
        elementsFilter: 'all',
        includeSummary: false,
        includeNetwork: true,
        includeConsole: true,
      }),
      ruyiBrowser.snapshot({
        elementsFilter: 'all',
        includeSummary: false,
        includeNetwork: true,
        includeConsole: true,
      }),
    ]);

    expect(pickSnapshotContract(serviceSnapshot)).toEqual(pickSnapshotContract(extensionSnapshot));
    expect(pickSnapshotContract(serviceSnapshot)).toEqual(pickSnapshotContract(ruyiSnapshot));
  });

  it('keeps search contracts aligned between BrowserSnapshotService, ExtensionBrowser, and RuyiBrowser', async () => {
    const { service } = createSnapshotServiceFixture();
    const { browser: extensionBrowser } = createExtensionBrowserFixture();
    const { browser: ruyiBrowser } = createRuyiBrowserFixture();

    const [serviceResults, extensionResults, ruyiResults] = await Promise.all([
      service.search('Search', {
        exactMatch: true,
        roleFilter: 'button',
        limit: 5,
      }),
      extensionBrowser.search('Search', {
        exactMatch: true,
        roleFilter: 'button',
        limit: 5,
      }),
      ruyiBrowser.search('Search', {
        exactMatch: true,
        roleFilter: 'button',
        limit: 5,
      }),
    ]);

    expect(pickSearchContract(serviceResults)).toEqual(pickSearchContract(extensionResults));
    expect(pickSearchContract(serviceResults)).toEqual(pickSearchContract(ruyiResults));
    expect(serviceResults).toHaveLength(1);
    expect(serviceResults[0]).toMatchObject({
      element: {
        preferredSelector: '#submit',
        role: 'button',
        elementRef: expect.stringMatching(/^airpa_el:/),
      },
      matchedFields: ['name', 'text'],
    });
  });
});
