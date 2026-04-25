import type { NetworkEntry } from '../browser-core/types';
import type { ExtensionRelayClientState, ExtensionRelayEvent } from '../../main/profile/extension-control-relay';
import { ExtensionBrowser } from '../browser-extension/extension-browser';
import { RuyiBrowser } from '../browser-ruyi';
import { IntegratedBrowser } from './integrated-browser';
import type { RuyiFirefoxEvent } from '../../main/profile/ruyi-firefox-client';
import { getStaticEngineRuntimeDescriptor } from '../browser-pool/engine-capability-registry';

function createIntegratedBrowserFixture() {
  const rawSession = {
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const webContents = {
    id: 1,
    stop: vi.fn(),
    executeJavaScript: vi.fn(),
    printToPDF: vi.fn().mockResolvedValue(Buffer.from('electron-pdf')),
  };

  const browser = {
    getSession: vi.fn(() => rawSession),
    getWebContents: vi.fn(() => webContents),
    ensureNotDisposed: vi.fn(),
    getViewId: vi.fn(() => 'view-1'),
    url: vi.fn(() => 'https://example.test'),
    getCurrentUrl: vi.fn().mockResolvedValue('https://example.test'),
    title: vi.fn().mockResolvedValue('Example'),
    goto: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    isClosed: vi.fn(() => false),
    session: {
      getUserAgent: vi.fn(() => 'test-agent'),
      setUserAgent: vi.fn(),
    },
    cdp: {
      sendCommand: vi.fn().mockResolvedValue(undefined),
      emulateGeolocation: vi.fn().mockResolvedValue(undefined),
      emulateDevice: vi.fn().mockResolvedValue(undefined),
      clearDeviceEmulation: vi.fn().mockResolvedValue(undefined),
      clearGeolocationEmulation: vi.fn().mockResolvedValue(undefined),
    },
  };

  return {
    browser: new IntegratedBrowser(browser as never, {} as never),
    webContents,
  };
}

function createIntegratedBrowser(): IntegratedBrowser {
  return createIntegratedBrowserFixture().browser;
}

function createExtensionBrowserFixture() {
  let relayListener: ((event: ExtensionRelayEvent) => void) | null = null;
  const initialClientState: ExtensionRelayClientState = {
    registeredAt: Date.now(),
    tabId: 11,
    windowId: 5,
    url: 'https://example.test',
    title: 'Example',
  };

  const relay = {
    onEvent: vi.fn((listener: (event: ExtensionRelayEvent) => void) => {
      relayListener = listener;
      return () => undefined;
    }),
    dispatchCommand: vi.fn().mockResolvedValue(undefined),
    getClientState: vi.fn(() => initialClientState),
    isStopped: vi.fn(() => false),
  } as any;

  return {
    browser: new ExtensionBrowser({
      relay,
      closeInternal: vi.fn(async () => undefined),
      initialClientState,
    }),
    relay,
    emit(event: ExtensionRelayEvent) {
      relayListener?.(event);
    },
  };
}

function createRuyiBrowserFixture() {
  let eventListener: ((event: RuyiFirefoxEvent) => void) | null = null;
  const client = {
    onEvent: vi.fn((listener: (event: RuyiFirefoxEvent) => void) => {
      eventListener = listener;
      return () => undefined;
    }),
    dispatch: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn(() => false),
  } as any;

  return {
    browser: new RuyiBrowser({
      client,
      closeInternal: vi.fn(async () => undefined),
    }),
    client,
    emit(event: RuyiFirefoxEvent) {
      eventListener?.(event);
    },
  };
}

function createNetworkEntry(overrides?: Partial<NetworkEntry>): NetworkEntry {
  return {
    id: 'req-1',
    url: 'https://example.test/api/orders',
    method: 'GET',
    resourceType: 'xhr',
    classification: 'api',
    status: 200,
    statusText: 'OK',
    requestHeaders: { accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    startTime: Date.now(),
    endTime: Date.now() + 12,
    duration: 12,
    ...overrides,
  };
}

describe('browser capability truth', () => {
  it('IntegratedBrowser truthfully reports response-body capture as unsupported', () => {
    const browser = createIntegratedBrowser();

    expect(browser.describeRuntime()).toMatchObject({
      engine: 'electron',
    });
    expect(browser.hasCapability('network.capture')).toBe(true);
    expect(browser.hasCapability('network.responseBody')).toBe(false);
    expect(browser.hasCapability('console.capture')).toBe(true);
    expect(browser.hasCapability('download.manage')).toBe(true);
    expect(browser.hasCapability('pdf.print')).toBe(true);
    expect(browser.hasCapability('dialog.basic')).toBe(false);
    expect(browser.hasCapability('dialog.promptText')).toBe(false);
    expect(browser.hasCapability('intercept.observe')).toBe(false);
    expect(browser.hasCapability('intercept.control')).toBe(false);
    expect(browser.hasCapability('input.touch')).toBe(false);
    expect(browser.hasCapability('events.runtime')).toBe(false);
    expect(browser.hasCapability('storage.dom')).toBe(false);
    expect(browser.hasCapability('emulation.identity')).toBe(true);
    expect(browser.hasCapability('emulation.viewport')).toBe(true);
    expect(typeof browser.setEmulationIdentity).toBe('function');
    expect(typeof browser.setViewportEmulation).toBe('function');
    expect(typeof browser.clearEmulation).toBe('function');
  });

  it('IntegratedBrowser exposes PDF export through Electron printToPDF', async () => {
    const { browser, webContents } = createIntegratedBrowserFixture();

    await expect(
      browser.savePdf({
        landscape: true,
        printBackground: true,
        pageRanges: '1-2',
      })
    ).resolves.toEqual({
      data: Buffer.from('electron-pdf').toString('base64'),
    });

    expect(webContents.printToPDF).toHaveBeenCalledWith({
      landscape: true,
      printBackground: true,
      pageRanges: '1-2',
    });
  });

  it('IntegratedBrowser preserves the legacy Electron emulation path', async () => {
    const { browser } = createIntegratedBrowserFixture();
    const simpleBrowser = (browser as any).browser;

    await browser.setEmulationIdentity({
      userAgent: 'custom-agent',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      touch: true,
      geolocation: {
        latitude: 35.68,
        longitude: 139.76,
        accuracy: 12,
      },
    });
    await browser.setViewportEmulation({
      width: 1280,
      height: 720,
      devicePixelRatio: 1.5,
      isMobile: false,
      hasTouch: true,
    });
    await browser.clearEmulation();

    expect(simpleBrowser.session.setUserAgent).toHaveBeenCalledWith('custom-agent');
    expect(simpleBrowser.cdp.sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
      userAgent: 'custom-agent',
      acceptLanguage: 'ja-JP',
      platform: undefined,
    });
    expect(simpleBrowser.cdp.sendCommand).toHaveBeenCalledWith('Emulation.setLocaleOverride', {
      locale: 'ja-JP',
    });
    expect(simpleBrowser.cdp.sendCommand).toHaveBeenCalledWith('Emulation.setTimezoneOverride', {
      timezoneId: 'Asia/Tokyo',
    });
    expect(simpleBrowser.cdp.emulateGeolocation).toHaveBeenCalledWith(35.68, 139.76, 12);
    expect(simpleBrowser.cdp.emulateDevice).toHaveBeenCalledWith(1280, 720, 1.5, false);
    expect(simpleBrowser.cdp.clearDeviceEmulation).toHaveBeenCalled();
    expect(simpleBrowser.cdp.clearGeolocationEmulation).toHaveBeenCalled();
  });

  it('ExtensionBrowser truthfully reports response-body capture and preserves captured response bodies', async () => {
    const { browser, relay, emit } = createExtensionBrowserFixture();

    expect(browser.describeRuntime()).toEqual(getStaticEngineRuntimeDescriptor('extension'));
    expect(browser.hasCapability('network.capture')).toBe(true);
    expect(browser.hasCapability('network.responseBody')).toBe(true);
    expect(browser.hasCapability('dialog.basic')).toBe(true);
    expect(browser.hasCapability('dialog.promptText')).toBe(false);
    expect(browser.hasCapability('intercept.observe')).toBe(true);
    expect(browser.hasCapability('intercept.control')).toBe(true);
    expect(browser.hasCapability('pdf.print')).toBe(false);
    expect(browser.hasCapability('input.touch')).toBe(false);
    expect(browser.hasCapability('events.runtime')).toBe(false);
    expect(browser.hasCapability('storage.dom')).toBe(false);

    await browser.startNetworkCapture({
      clearExisting: true,
      captureBody: true,
      maxEntries: 32,
    });

    emit({
      type: 'network-entry',
      entry: createNetworkEntry({
        responseBody: '{"ok":true}',
      }),
    });

    expect(relay.dispatchCommand).toHaveBeenCalledWith(
      'network.start',
      {
        options: {
          clearExisting: true,
          captureBody: true,
          maxEntries: 32,
        },
        target: { tabId: 11, windowId: 5 },
      },
      undefined
    );
    expect(browser.getNetworkEntries()).toEqual([
      expect.objectContaining({
        url: 'https://example.test/api/orders',
        responseBody: '{"ok":true}',
      }),
    ]);
  });

  it('ExtensionBrowser exposes tabs, interception, and runtime emulation through the relay', async () => {
    const { browser, relay, emit } = createExtensionBrowserFixture();
    relay.dispatchCommand.mockImplementation(async (name: string) => {
      if (name === 'tabs.list') {
        return [
          {
            id: '11',
            url: 'https://example.test',
            title: 'Example',
            active: true,
          },
        ];
      }
      return undefined;
    });

    expect(browser.hasCapability('tabs.manage')).toBe(true);
    expect(browser.hasCapability('dialog.basic')).toBe(true);
    expect(browser.hasCapability('dialog.promptText')).toBe(false);
    expect(browser.hasCapability('emulation.viewport')).toBe(true);
    expect(browser.hasCapability('emulation.identity')).toBe(true);
    expect(browser.hasCapability('intercept.observe')).toBe(true);
    expect(browser.hasCapability('intercept.control')).toBe(true);
    expect(await browser.listTabs()).toEqual([
      expect.objectContaining({
        id: '11',
        active: true,
      }),
    ]);

    await browser.setEmulationIdentity({
      userAgent: 'AirpaSharedRealContract/1.0',
      locale: 'zh-CN',
    });
    await browser.setViewportEmulation({
      width: 1280,
      height: 720,
      devicePixelRatio: 1.5,
      hasTouch: true,
    });
    await browser.clearEmulation();
    await browser.enableRequestInterception({
      patterns: [{ urlPattern: '/api/orders', methods: ['POST'] }],
    });

    emit({
      type: 'intercepted-request',
      request: {
        id: 'req-ext-1',
        url: 'https://example.test/api/orders',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        resourceType: 'xhr',
        isBlocked: true,
      },
    });

    expect(await browser.waitForInterceptedRequest({ timeoutMs: 1500 })).toEqual(
      expect.objectContaining({
        id: 'req-ext-1',
        method: 'POST',
      })
    );
    await browser.continueRequest('req-ext-1', {
      method: 'PUT',
      headers: { 'x-airpa': '1' },
    });

    expect(relay.dispatchCommand).toHaveBeenCalledWith(
      'emulation.identity.set',
      {
        options: {
          userAgent: 'AirpaSharedRealContract/1.0',
          locale: 'zh-CN',
        },
        target: { tabId: 11, windowId: 5 },
      },
      undefined
    );
    expect(relay.dispatchCommand).toHaveBeenCalledWith(
      'emulation.viewport.set',
      {
        options: {
          width: 1280,
          height: 720,
          devicePixelRatio: 1.5,
          hasTouch: true,
        },
        target: { tabId: 11, windowId: 5 },
      },
      undefined
    );
    expect(relay.dispatchCommand).toHaveBeenCalledWith(
      'emulation.clear',
      {
        target: { tabId: 11, windowId: 5 },
      },
      undefined
    );
    expect(relay.dispatchCommand).toHaveBeenCalledWith(
      'network.intercept.enable',
      {
        options: {
          patterns: [{ urlPattern: '/api/orders', methods: ['POST'] }],
        },
        target: { tabId: 11, windowId: 5 },
      },
      undefined
    );
    expect(relay.dispatchCommand).toHaveBeenCalledWith(
      'network.intercept.continue',
      {
        requestId: 'req-ext-1',
        overrides: {
          method: 'PUT',
          headers: { 'x-airpa': '1' },
        },
        target: { tabId: 11, windowId: 5 },
      },
      undefined
    );
  });

  it('RuyiBrowser exposes tab, dialog, interception, touch, download, and runtime event capabilities truthfully', async () => {
    const { browser, client, emit } = createRuyiBrowserFixture();
    client.dispatch.mockImplementation(async (name: string) => {
      if (name === 'tabs.list') {
        return [
          {
            id: 'ctx-1',
            url: 'https://example.test',
            title: 'Example',
            active: true,
          },
        ];
      }
      if (name === 'dialog.wait') {
        return {
          type: 'confirm',
          message: 'Delete item?',
          contextId: 'ctx-1',
        };
      }
      if (name === 'storage.getItem') {
        return 'value-1';
      }
      if (name === 'download.list') {
        return [
          {
            id: 'download-1',
            suggestedFilename: 'orders.csv',
            path: 'D:/airpa/downloads/orders.csv',
            state: 'completed',
          },
        ];
      }
      if (name === 'pdf.save') {
        return {
          data: 'cGRmLWRhdGE=',
          path: 'D:/airpa/output/report.pdf',
        };
      }
      return undefined;
    });

    expect(browser.describeRuntime()).toEqual(getStaticEngineRuntimeDescriptor('ruyi'));
    expect(browser.hasCapability('tabs.manage')).toBe(true);
    expect(browser.hasCapability('dialog.basic')).toBe(true);
    expect(browser.hasCapability('dialog.promptText')).toBe(true);
    expect(browser.hasCapability('intercept.observe')).toBe(true);
    expect(browser.hasCapability('intercept.control')).toBe(true);
    expect(browser.hasCapability('input.touch')).toBe(true);
    expect(browser.hasCapability('events.runtime')).toBe(true);
    expect(browser.hasCapability('download.manage')).toBe(true);
    expect(browser.hasCapability('pdf.print')).toBe(true);
    expect(browser.hasCapability('storage.dom')).toBe(true);
    expect(browser.hasCapability('emulation.identity')).toBe(true);
    expect(browser.hasCapability('emulation.viewport')).toBe(true);
    expect(await browser.listTabs()).toEqual([
      expect.objectContaining({
        id: 'ctx-1',
        active: true,
      }),
    ]);
    expect(await browser.waitForDialog({ timeoutMs: 1500 })).toEqual(
      expect.objectContaining({
        type: 'confirm',
        message: 'Delete item?',
      })
    );

    emit({
      type: 'intercepted-request',
      request: {
        id: 'req-7',
        url: 'https://example.test/api/orders',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        resourceType: 'xhr',
        isBlocked: true,
      },
    });

    expect(await browser.waitForInterceptedRequest({ timeoutMs: 1500 })).toEqual(
      expect.objectContaining({
        id: 'req-7',
        method: 'POST',
      })
    );

    await browser.setEmulationIdentity({
      userAgent: 'AirpaSharedRealContract/1.0',
    });
    await browser.setViewportEmulation({
      width: 913,
      height: 677,
      devicePixelRatio: 1.25,
      hasTouch: true,
    });
    await browser.clearEmulation();

    await browser.continueRequest('req-7', {
      method: 'PUT',
      headers: { 'x-airpa': '1' },
    });
    await browser.touchTap(10, 20);
    await browser.touchLongPress(11, 21, 700);
    await browser.touchDrag(12, 22, 13, 23);
    expect(await browser.getStorageItem('local', 'token')).toBe('value-1');
    await browser.setStorageItem('local', 'token', 'value-1');
    await browser.removeStorageItem('session', 'flash');
    await browser.clearStorageArea('session');
    await browser.setDownloadBehavior({
      policy: 'allow',
      downloadPath: 'D:/airpa/downloads',
    });
    expect(await browser.listDownloads()).toEqual([
      expect.objectContaining({
        id: 'download-1',
        state: 'completed',
      }),
    ]);
    await browser.waitForDownload({ timeoutMs: 1200 });
    await browser.cancelDownload('download-1');
    await expect(
      browser.savePdf({
        path: 'D:/airpa/output/report.pdf',
        landscape: true,
        printBackground: true,
        pageRanges: '1-2',
      })
    ).resolves.toEqual({
      data: 'cGRmLWRhdGE=',
      path: 'D:/airpa/output/report.pdf',
    });

    const runtimeEvents: any[] = [];
    const unsubscribe = browser.onRuntimeEvent((event) => {
      runtimeEvents.push(event);
    });
    emit({
      type: 'runtime-event',
      event: {
        type: 'navigation.completed',
        contextId: 'ctx-1',
        timestamp: 1700000000000,
        payload: {
          url: 'https://example.test',
        },
      },
    });
    unsubscribe();
    expect(runtimeEvents).toEqual([
      {
        type: 'navigation.completed',
        contextId: 'ctx-1',
        timestamp: 1700000000000,
        payload: {
          url: 'https://example.test',
        },
      },
    ]);

    expect(client.dispatch).toHaveBeenCalledWith(
      'emulation.identity.set',
      {
        options: {
          userAgent: 'AirpaSharedRealContract/1.0',
        },
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'emulation.viewport.set',
      {
        options: {
          width: 913,
          height: 677,
          devicePixelRatio: 1.25,
          hasTouch: true,
        },
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith('emulation.clear', undefined, undefined);
    expect(client.dispatch).toHaveBeenCalledWith(
      'network.intercept.continue',
      {
        requestId: 'req-7',
        overrides: {
          method: 'PUT',
          headers: { 'x-airpa': '1' },
        },
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'touch.tap',
      {
        x: 10,
        y: 20,
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'touch.longPress',
      {
        x: 11,
        y: 21,
        durationMs: 700,
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'touch.drag',
      {
        fromX: 12,
        fromY: 22,
        toX: 13,
        toY: 23,
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'storage.getItem',
      {
        area: 'local',
        key: 'token',
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'storage.setItem',
      {
        area: 'local',
        key: 'token',
        value: 'value-1',
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'storage.removeItem',
      {
        area: 'session',
        key: 'flash',
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'storage.clearArea',
      {
        area: 'session',
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'download.setBehavior',
      {
        options: {
          policy: 'allow',
          downloadPath: 'D:/airpa/downloads',
        },
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith('download.list', undefined, undefined);
    expect(client.dispatch).toHaveBeenCalledWith(
      'download.wait',
      {
        timeoutMs: 1200,
      },
      1200
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'download.cancel',
      {
        id: 'download-1',
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenCalledWith(
      'pdf.save',
      {
        options: {
          path: 'D:/airpa/output/report.pdf',
          landscape: true,
          printBackground: true,
          pageRanges: '1-2',
        },
      },
      undefined
    );
  });
});
