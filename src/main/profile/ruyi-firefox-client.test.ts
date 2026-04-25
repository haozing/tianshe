import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getDefaultFingerprint } from '../../constants/fingerprint-defaults';

vi.mock('./ruyi-firefox-launch-helpers', async () => {
  const actual = await vi.importActual<typeof import('./ruyi-firefox-launch-helpers')>(
    './ruyi-firefox-launch-helpers'
  );
  return {
    ...actual,
    sendWindowsDialogKeys: vi.fn(async () => false),
  };
});

import { RuyiFirefoxClient } from './ruyi-firefox-client';

function createPreparedLaunch() {
  return {
    sessionId: 'ruyi-client-test',
    browserPath: 'C:\\firefox\\firefox.exe',
    userDataDir: 'C:\\airpa\\profiles\\ruyi-client-test',
    runtimeDir: 'C:\\airpa\\runtime\\ruyi-client-test',
    downloadDir: 'C:\\airpa\\runtime\\ruyi-client-test\\downloads',
    fingerprint: getDefaultFingerprint('ruyi'),
  };
}

function createClient() {
  return new (RuyiFirefoxClient as any)(createPreparedLaunch()) as any;
}

function createRemoteObject(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    value: Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === 'boolean'
        ? { type: 'boolean', value: entry }
        : { type: 'string', value: String(entry ?? '') },
    ]),
  };
}

describe('RuyiFirefoxClient', () => {
  it('dispatches storage commands through the evaluateWithArgs runtime helper', async () => {
    const client = createClient();
    client.evaluateWithArgs = vi
      .fn()
      .mockResolvedValueOnce('value-1')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(
      client.dispatch('storage.getItem', {
        area: 'local',
        key: 'token',
      })
    ).resolves.toBe('value-1');
    await expect(
      client.dispatch('storage.setItem', {
        area: 'local',
        key: 'token',
        value: 'value-2',
      })
    ).resolves.toBeUndefined();
    await expect(
      client.dispatch('storage.removeItem', {
        area: 'session',
        key: 'flash',
      })
    ).resolves.toBeUndefined();
    await expect(
      client.dispatch('storage.clearArea', {
        area: 'session',
      })
    ).resolves.toBeUndefined();

    expect(client.evaluateWithArgs).toHaveBeenNthCalledWith(
      1,
      {
        functionSource: expect.any(String),
        args: ['get', 'local', 'token', null],
      },
      30000
    );
    expect(client.evaluateWithArgs).toHaveBeenNthCalledWith(
      2,
      {
        functionSource: expect.any(String),
        args: ['set', 'local', 'token', 'value-2'],
      },
      30000
    );
    expect(client.evaluateWithArgs).toHaveBeenNthCalledWith(
      3,
      {
        functionSource: expect.any(String),
        args: ['remove', 'session', 'flash', null],
      },
      30000
    );
    expect(client.evaluateWithArgs).toHaveBeenNthCalledWith(
      4,
      {
        functionSource: expect.any(String),
        args: ['clear', 'session', '', null],
      },
      30000
    );
  });

  it('rejects unsupported storage areas before evaluating page storage helpers', async () => {
    const client = createClient();
    client.evaluateWithArgs = vi.fn(async () => null);

    await expect(
      client.dispatch('storage.getItem', {
        area: 'cookie',
        key: 'token',
      })
    ).rejects.toThrow('Unsupported storage area: cookie');
    expect(client.evaluateWithArgs).not.toHaveBeenCalled();
  });

  it('derives the cookie domain from the active page URL when the caller omits it', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-cookie';
    client.bidi.sendCommand = vi.fn(async (command: string) => {
      if (command === 'script.evaluate') {
        return {
          result: {
            type: 'string',
            value: 'https://example.test/account/settings?tab=profile',
          },
        };
      }
      if (command === 'storage.setCookie') {
        return {};
      }
      return undefined;
    });

    await expect(
      client.dispatch('cookies.set', {
        cookie: {
          name: 'airpa_contract',
          value: 'shared-cookie',
          path: '/',
        },
      })
    ).resolves.toBeUndefined();

    expect(client.bidi.sendCommand).toHaveBeenNthCalledWith(
      1,
      'script.evaluate',
      {
        expression: 'window.location.href',
        target: {
          context: 'ctx-cookie',
        },
        awaitPromise: true,
        resultOwnership: 'root',
      },
      30000
    );
    expect(client.bidi.sendCommand).toHaveBeenNthCalledWith(
      2,
      'storage.setCookie',
      {
        cookie: {
          name: 'airpa_contract',
          value: {
            type: 'string',
            value: 'shared-cookie',
          },
          domain: 'example.test',
          path: '/',
        },
        partition: {
          type: 'context',
          context: 'ctx-cookie',
        },
      },
      30000
    );
  });

  it('fails cookie writes when neither the cookie nor the active page can provide a domain', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-cookie';
    client.bidi.sendCommand = vi.fn(async (command: string) => {
      if (command === 'script.evaluate') {
        return {
          result: {
            type: 'string',
            value: 'about:blank',
          },
        };
      }
      return undefined;
    });

    await expect(
      client.dispatch('cookies.set', {
        cookie: {
          name: 'airpa_contract',
          value: 'shared-cookie',
        },
      })
    ).rejects.toThrow('cookie.domain is required when current page URL is unavailable');
    expect(client.bidi.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('pushes literal pathname intercept filters into BiDi network.addIntercept', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-active';
    client.bidi.sendCommand = vi.fn(async (command: string) => {
      if (command === 'network.addIntercept') {
        return { intercept: 'intercept-1' };
      }
      return undefined;
    });

    await client.enableRequestInterception(
      {
        options: {
          patterns: [
            {
              urlPattern: '/api/ping',
              methods: ['GET'],
            },
          ],
        },
      },
      1000
    );

    expect(client.bidi.sendCommand).toHaveBeenCalledWith(
      'network.addIntercept',
      {
        phases: ['beforeRequestSent'],
        contexts: ['ctx-active'],
        urlPatterns: [
          {
            type: 'pattern',
            pathname: '/api/ping',
          },
        ],
      },
      1000
    );
  });

  it('gracefully skips unsupported BiDi touch override during viewport emulation', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-emulation';
    client.evaluateExpression = vi
      .fn()
      .mockResolvedValueOnce({
        innerWidth: 1366,
        innerHeight: 627,
        outerWidth: 1366,
        outerHeight: 718,
      });
    client.bidi.sendCommand = vi.fn(async (command: string) => {
      if (command === 'browsingContext.setViewport') {
        return {};
      }
      if (command === 'emulation.setTouchOverride') {
        throw new Error('unknown command\nemulation.setTouchOverride');
      }
      return {};
    });

    await expect(
      client.dispatch('emulation.viewport.set', {
        options: {
          width: 913,
          height: 677,
          devicePixelRatio: 1.25,
          hasTouch: true,
        },
      })
    ).resolves.toBeUndefined();

    expect(client.bidi.sendCommand).toHaveBeenCalledWith(
      'browsingContext.setViewport',
      {
        context: 'ctx-emulation',
        viewport: {
          width: 913,
          height: 677,
        },
        devicePixelRatio: 1.25,
      },
      30000
    );
    expect(client.bidi.sendCommand).toHaveBeenCalledWith(
      'emulation.setTouchOverride',
      {
        maxTouchPoints: 1,
        contexts: ['ctx-emulation'],
      },
      30000
    );
  });

  it('falls back to client-window resize when BiDi viewport emulation times out', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-emulation';
    client.evaluateWithArgs = vi.fn();
    client.evaluateExpression = vi
      .fn()
      .mockResolvedValueOnce({
        innerWidth: 1366,
        innerHeight: 627,
        outerWidth: 1366,
        outerHeight: 718,
      })
      .mockResolvedValueOnce({
        innerWidth: 1366,
        innerHeight: 627,
        outerWidth: 1366,
        outerHeight: 718,
      })
      .mockResolvedValueOnce({
        innerWidth: 913,
        innerHeight: 677,
        outerWidth: 913,
        outerHeight: 768,
      });
    client.bidi.sendCommand = vi.fn(async (command: string) => {
      if (command === 'browsingContext.setViewport') {
        throw new Error('BiDi command timed out: browsingContext.setViewport');
      }
      if (command === 'browser.getClientWindows') {
        return {
          clientWindows: [
            {
              active: true,
              clientWindow: 'window-1',
              width: 1366,
              height: 718,
            },
          ],
        };
      }
      if (command === 'browser.setClientWindowState') {
        return {
          width: 960,
          height: 768,
        };
      }
      return {};
    });

    await expect(
      client.dispatch('emulation.viewport.set', {
        options: {
          width: 913,
          height: 677,
        },
      })
    ).resolves.toBeUndefined();

    expect(client.bidi.sendCommand).toHaveBeenCalledWith(
      'browser.getClientWindows',
      {},
      30000
    );
    expect(client.bidi.sendCommand).toHaveBeenCalledWith(
      'browser.setClientWindowState',
      {
        clientWindow: 'window-1',
        state: 'normal',
        width: 913,
        height: 768,
      },
      30000
    );
    expect(client.evaluateWithArgs).not.toHaveBeenCalled();
  });

  it('falls back to script-driven resize when client-window viewport fallback is unavailable', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-emulation';
    client.evaluateExpression = vi
      .fn()
      .mockResolvedValueOnce({
        innerWidth: 1366,
        innerHeight: 627,
        outerWidth: 1366,
        outerHeight: 718,
      })
      .mockResolvedValueOnce({
        innerWidth: 913,
        innerHeight: 677,
        outerWidth: 913,
        outerHeight: 768,
      });
    client.evaluateWithArgs = vi.fn(async () => ({
      innerWidth: 913,
      innerHeight: 677,
      outerWidth: 913,
      outerHeight: 768,
    }));
    client.bidi.sendCommand = vi.fn(async (command: string) => {
      if (command === 'browsingContext.setViewport') {
        throw new Error('BiDi command timed out: browsingContext.setViewport');
      }
      if (command === 'browser.getClientWindows') {
        throw new Error('No Firefox client window available for viewport fallback');
      }
      return {};
    });

    await expect(
      client.dispatch('emulation.viewport.set', {
        options: {
          width: 913,
          height: 677,
        },
      })
    ).resolves.toBeUndefined();

    expect(client.evaluateWithArgs).toHaveBeenCalledWith(
      {
        functionSource: expect.any(String),
        args: [913, 677],
      },
      30000
    );
  });

  it('restores the viewport baseline through client-window resize fallback when clear emulation times out', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-emulation';
    client.evaluateWithArgs = vi.fn();
    client.viewportEmulationBaseline = {
      contextId: 'ctx-emulation',
      innerWidth: 1366,
      innerHeight: 627,
    };
    client.evaluateExpression = vi
      .fn()
      .mockResolvedValueOnce({
        innerWidth: 913,
        innerHeight: 677,
        outerWidth: 960,
        outerHeight: 768,
      })
      .mockResolvedValueOnce({
        innerWidth: 1366,
        innerHeight: 627,
        outerWidth: 1366,
        outerHeight: 718,
      });
    client.bidi.sendCommand = vi.fn(async (command: string) => {
      if (command === 'browsingContext.setViewport') {
        throw new Error('BiDi command timed out: browsingContext.setViewport');
      }
      if (command === 'browser.getClientWindows') {
        return {
          clientWindows: [
            {
              active: true,
              clientWindow: 'window-1',
              width: 960,
              height: 768,
            },
          ],
        };
      }
      if (command === 'browser.setClientWindowState') {
        return {
          width: 1413,
          height: 718,
        };
      }
      return {};
    });

    await expect(client.dispatch('emulation.clear')).resolves.toBeUndefined();

    expect(client.bidi.sendCommand).toHaveBeenCalledWith(
      'browser.setClientWindowState',
      {
        clientWindow: 'window-1',
        state: 'normal',
        width: 1413,
        height: 718,
      },
      30000
    );
    expect(client.evaluateWithArgs).not.toHaveBeenCalled();
  });

  it('keeps browser-side interception broad when a local-only pattern is present', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-active';
    client.bidi.sendCommand = vi.fn(async (command: string) => {
      if (command === 'network.addIntercept') {
        return { intercept: 'intercept-1' };
      }
      return undefined;
    });

    await client.enableRequestInterception(
      {
        options: {
          patterns: [
            {
              urlPattern: '/api/ping',
            },
            {
              urlPattern: 'https://example.test/api/ping',
            },
          ],
        },
      },
      1000
    );

    expect(client.bidi.sendCommand).toHaveBeenCalledWith(
      'network.addIntercept',
      {
        phases: ['beforeRequestSent'],
        contexts: ['ctx-active'],
      },
      1000
    );
  });

  it('updates activeContextId from script.message activity sync events', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-old';
    client.activeInterceptIds.add('intercept-1');
    client.interceptPatterns = [{ urlPattern: '/api/' }];
    client.enableRequestInterception = vi.fn(async () => undefined);

    client.handleBiDiEvent({
      method: 'script.message',
      params: {
        channel: '__airpa_ruyi_active_context__',
        data: createRemoteObject({ active: true, reason: 'focus' }),
        source: {
          context: 'ctx-new',
        },
      },
    });

    await Promise.resolve();

    expect(client.activeContextId).toBe('ctx-new');
    expect(client.enableRequestInterception).toHaveBeenCalledWith(
      { options: { patterns: [{ urlPattern: '/api/' }] } },
      5000
    );
  });

  it('recovers activeContextId when the active tab context is destroyed', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-gone';
    client.ensureActiveContextId = vi.fn(async () => 'ctx-recovered');

    client.handleBiDiEvent({
      method: 'browsingContext.contextDestroyed',
      params: {
        context: 'ctx-gone',
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(client.activeContextId).toBe('ctx-recovered');
  });

  it('retries active-context script commands after a transient no such frame error', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-stale';
    client.recoverActiveContextId = vi.fn(async () => {
      client.activeContextId = 'ctx-fresh';
    });
    client.bidi.sendCommand = vi.fn(async (command: string, params: Record<string, unknown>) => {
      if (command !== 'script.evaluate') {
        return undefined;
      }
      const target = params.target as { context?: string } | undefined;
      if (target?.context === 'ctx-stale') {
        throw new Error('no such frame\nBrowsing Context ctx-stale not found');
      }
      return {
        result: {
          type: 'string',
          value: 'recovered-title',
        },
      };
    });

    await expect(client.dispatch('evaluate', { script: 'document.title' })).resolves.toBe(
      'recovered-title'
    );

    expect(client.recoverActiveContextId).toHaveBeenCalledWith(30000);
    expect(client.bidi.sendCommand).toHaveBeenNthCalledWith(
      1,
      'script.evaluate',
      {
        expression: 'document.title',
        target: {
          context: 'ctx-stale',
        },
        awaitPromise: true,
        resultOwnership: 'root',
      },
      30000
    );
    expect(client.bidi.sendCommand).toHaveBeenNthCalledWith(
      2,
      'script.evaluate',
      {
        expression: 'document.title',
        target: {
          context: 'ctx-fresh',
        },
        awaitPromise: true,
        resultOwnership: 'root',
      },
      30000
    );
  });

  it('dispatches touch commands through BiDi input.performActions with touch pointers', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-touch';
    client.bidi.sendCommand = vi.fn(async () => undefined);

    await expect(
      client.dispatch('touch.tap', {
        x: 10,
        y: 20,
      })
    ).resolves.toBeUndefined();
    await expect(
      client.dispatch('touch.longPress', {
        x: 30,
        y: 40,
        durationMs: 900,
      })
    ).resolves.toBeUndefined();
    await expect(
      client.dispatch('touch.drag', {
        fromX: 50,
        fromY: 60,
        toX: 70,
        toY: 80,
      })
    ).resolves.toBeUndefined();

    expect(client.bidi.sendCommand).toHaveBeenNthCalledWith(
      1,
      'input.performActions',
      {
        context: 'ctx-touch',
        actions: [
          {
            type: 'pointer',
            id: 'touch0',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', x: 10, y: 20, duration: 0 },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 40 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
      30000
    );
    expect(client.bidi.sendCommand).toHaveBeenNthCalledWith(
      2,
      'input.performActions',
      {
        context: 'ctx-touch',
        actions: [
          {
            type: 'pointer',
            id: 'touch0',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', x: 30, y: 40, duration: 0 },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 900 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
      30000
    );
    expect(client.bidi.sendCommand).toHaveBeenNthCalledWith(
      3,
      'input.performActions',
      {
        context: 'ctx-touch',
        actions: [
          {
            type: 'pointer',
            id: 'touch0',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', x: 50, y: 60, duration: 0 },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 60 },
              { type: 'pointerMove', x: 70, y: 80, duration: 180 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
      30000
    );
  });

  it('emits normalized runtime events for navigation, tab lifecycle, dialog, network, and console activity', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-active';
    const listener = vi.fn();
    client.onEvent(listener);
    client.downloadController.handleDownloadWillBegin = vi.fn(async (params: Record<string, unknown>) => {
      client.emitEvent({
        type: 'runtime-event',
        event: {
          type: 'download.started',
          contextId: 'ctx-active',
          timestamp: Number(params.timestamp ?? 0) || undefined,
          payload: {
            id: 'nav-download-1',
            url: String(params.url ?? ''),
            suggestedFilename: String(params.suggestedFilename ?? ''),
            navigationId: String(params.navigation ?? ''),
            state: 'in_progress',
            source: 'native',
          },
        },
      });
    });
    client.downloadController.handleDownloadEnd = vi.fn(async (params: Record<string, unknown>) => {
      client.emitEvent({
        type: 'runtime-event',
        event: {
          type: 'download.completed',
          contextId: 'ctx-active',
          timestamp: Number(params.timestamp ?? 0) || undefined,
          payload: {
            id: 'nav-download-1',
            url: String(params.url ?? ''),
            suggestedFilename: 'report.csv',
            navigationId: String(params.navigation ?? ''),
            state: 'completed',
            path: String(params.filepath ?? ''),
            source: 'native',
          },
        },
      });
    });

    client.handleBiDiEvent({
      method: 'browsingContext.contextCreated',
      params: {
        context: 'ctx-new',
        url: 'https://example.test/new',
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.navigationStarted',
      params: {
        context: 'ctx-active',
        url: 'https://example.test/start',
        navigation: 'nav-1',
        timestamp: 1700000000100,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.navigationCommitted',
      params: {
        context: 'ctx-active',
        url: 'https://example.test/committed',
        navigation: 'nav-1',
        timestamp: 1700000000150,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.domContentLoaded',
      params: {
        context: 'ctx-active',
        url: 'https://example.test/dom',
        navigation: 'nav-1',
        timestamp: 1700000000175,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.load',
      params: {
        context: 'ctx-active',
        url: 'https://example.test/done',
        navigation: 'nav-1',
        timestamp: 1700000000200,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.fragmentNavigated',
      params: {
        context: 'ctx-active',
        url: 'https://example.test/done#frag',
        navigation: 'nav-1',
        timestamp: 1700000000250,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.historyUpdated',
      params: {
        context: 'ctx-active',
        url: 'https://example.test/history',
        timestamp: 1700000000300,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.downloadWillBegin',
      params: {
        context: 'ctx-active',
        url: 'https://example.test/download/report.csv',
        navigation: 'nav-download-1',
        suggestedFilename: 'report.csv',
        timestamp: 1700000000310,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.downloadEnd',
      params: {
        context: 'ctx-active',
        url: 'https://example.test/download/report.csv',
        navigation: 'nav-download-1',
        status: 'complete',
        filepath: 'D:/airpa/downloads/report.csv',
        timestamp: 1700000000315,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.navigationFailed',
      params: {
        context: 'ctx-active',
        url: 'https://example.test/failed',
        navigation: 'nav-2',
        message: 'request failed',
        timestamp: 1700000000325,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.navigationAborted',
      params: {
        context: 'ctx-active',
        url: 'https://example.test/aborted',
        navigation: 'nav-3',
        message: 'user stopped navigation',
        timestamp: 1700000000350,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.userPromptOpened',
      params: {
        context: 'ctx-active',
        type: 'prompt',
        message: 'Enter value',
        defaultValue: 'airpa',
        timestamp: 1700000000400,
      },
    });
    client.handleBiDiEvent({
      method: 'network.responseCompleted',
      params: {
        context: 'ctx-active',
        request: {
          request: 'req-1',
          url: 'https://example.test/api/ping',
          method: 'GET',
          destination: 'fetch',
          headers: [],
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: [],
        },
        timestamp: 1700000000500,
      },
    });
    client.handleBiDiEvent({
      method: 'log.entryAdded',
      params: {
        context: 'ctx-active',
        level: 'info',
        text: 'console-ready',
        timestamp: 1700000000600,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.userPromptClosed',
      params: {
        context: 'ctx-active',
        accepted: true,
        userText: 'done',
        timestamp: 1700000000700,
      },
    });
    client.handleBiDiEvent({
      method: 'browsingContext.contextDestroyed',
      params: {
        context: 'ctx-new',
        timestamp: 1700000000800,
      },
    });

    expect(
      listener.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'runtime-event')
        .map((event) => event.event)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tab.created',
          contextId: 'ctx-new',
          payload: expect.objectContaining({
            id: 'ctx-new',
            url: 'https://example.test/new',
          }),
        }),
        expect.objectContaining({
          type: 'navigation.started',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            url: 'https://example.test/start',
            navigationId: 'nav-1',
          }),
        }),
        expect.objectContaining({
          type: 'navigation.committed',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            url: 'https://example.test/committed',
          }),
        }),
        expect.objectContaining({
          type: 'navigation.domContentLoaded',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            url: 'https://example.test/dom',
          }),
        }),
        expect.objectContaining({
          type: 'navigation.completed',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            url: 'https://example.test/done',
          }),
        }),
        expect.objectContaining({
          type: 'navigation.fragmentNavigated',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            url: 'https://example.test/done#frag',
          }),
        }),
        expect.objectContaining({
          type: 'navigation.historyUpdated',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            url: 'https://example.test/history',
          }),
        }),
        expect.objectContaining({
          type: 'download.started',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            id: 'nav-download-1',
            suggestedFilename: 'report.csv',
            state: 'in_progress',
          }),
        }),
        expect.objectContaining({
          type: 'download.completed',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            id: 'nav-download-1',
            path: 'D:/airpa/downloads/report.csv',
            state: 'completed',
          }),
        }),
        expect.objectContaining({
          type: 'navigation.failed',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            url: 'https://example.test/failed',
            message: 'request failed',
          }),
        }),
        expect.objectContaining({
          type: 'navigation.aborted',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            url: 'https://example.test/aborted',
            message: 'user stopped navigation',
          }),
        }),
        expect.objectContaining({
          type: 'dialog.opened',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            type: 'prompt',
            message: 'Enter value',
          }),
        }),
        expect.objectContaining({
          type: 'network.entry',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            id: 'req-1',
            status: 200,
          }),
        }),
        expect.objectContaining({
          type: 'console.message',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            message: 'console-ready',
          }),
        }),
        expect.objectContaining({
          type: 'dialog.closed',
          contextId: 'ctx-active',
          payload: expect.objectContaining({
            accepted: true,
            userText: 'done',
          }),
        }),
        expect.objectContaining({
          type: 'tab.closed',
          contextId: 'ctx-new',
          payload: expect.objectContaining({
            id: 'ctx-new',
          }),
        }),
      ])
    );
  });

  it('dispatches download commands through the download controller', async () => {
    const client = createClient();
    client.downloadController.setDownloadBehavior = vi.fn(async () => undefined);
    client.downloadController.listDownloads = vi.fn(async () => [
      {
        id: 'download-1',
        suggestedFilename: 'orders.csv',
        path: 'D:/airpa/downloads/orders.csv',
        state: 'completed',
      },
    ]);
    client.downloadController.waitForDownload = vi.fn(async () => ({
      id: 'download-2',
      suggestedFilename: 'report.csv',
      path: 'D:/airpa/downloads/report.csv',
      state: 'completed',
    }));
    client.downloadController.cancelDownload = vi.fn(async () => undefined);

    await expect(
      client.dispatch('download.setBehavior', {
        options: {
          policy: 'allow',
          downloadPath: 'D:/airpa/downloads',
        },
      })
    ).resolves.toBeUndefined();
    await expect(client.dispatch('download.list')).resolves.toEqual([
      expect.objectContaining({
        id: 'download-1',
        state: 'completed',
      }),
    ]);
    await expect(
      client.dispatch('download.wait', {
        timeoutMs: 1200,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'download-2',
      })
    );
    await expect(
      client.dispatch('download.cancel', {
        id: 'download-2',
      })
    ).resolves.toBeUndefined();

    expect(client.downloadController.setDownloadBehavior).toHaveBeenCalledWith(
      {
        options: {
          policy: 'allow',
          downloadPath: 'D:/airpa/downloads',
        },
      },
      30000
    );
    expect(client.downloadController.listDownloads).toHaveBeenCalledTimes(1);
    expect(client.downloadController.waitForDownload).toHaveBeenCalledWith({
      timeoutMs: 1200,
      signal: undefined,
    });
    expect(client.downloadController.cancelDownload).toHaveBeenCalledWith({
      id: 'download-2',
    });
  });

  it('falls back gracefully when browser.setDownloadBehavior is not supported', async () => {
    const client = createClient();
    const trackerSetBehavior = vi.fn(async () => undefined);
    client.downloadController.downloadTracker.setBehavior = trackerSetBehavior;
    client.bidi.sendCommand = vi.fn(async (command: string) => {
      if (command === 'browser.setDownloadBehavior') {
        throw new Error('unknown command\nbrowser.setDownloadBehavior');
      }
      return undefined;
    });

    await expect(
      client.dispatch('download.setBehavior', {
        options: {
          policy: 'allow',
          downloadPath: 'D:/airpa/downloads',
        },
      })
    ).resolves.toBeUndefined();

    expect(trackerSetBehavior).toHaveBeenCalledWith({
      policy: 'allow',
      downloadPath: 'D:/airpa/downloads',
    });
  });

  it('prints PDF through browsingContext.print and optionally writes the file to disk', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-print';
    client.bidi.sendCommand = vi.fn(async (command: string) => {
      if (command === 'browsingContext.print') {
        return {
          data: Buffer.from('ruyi pdf payload').toString('base64'),
        };
      }
      return undefined;
    });

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'airpa-ruyi-pdf-'));
    const targetPath = path.join(tempRoot, 'exports', 'report.pdf');

    try {
      await expect(
        client.dispatch('pdf.save', {
          options: {
            path: targetPath,
            landscape: true,
            printBackground: true,
            pageRanges: '1-2,4',
          },
        })
      ).resolves.toEqual({
        data: Buffer.from('ruyi pdf payload').toString('base64'),
        path: targetPath,
      });

      expect(client.bidi.sendCommand).toHaveBeenCalledWith(
        'browsingContext.print',
        {
          context: 'ctx-print',
          background: true,
          orientation: 'landscape',
          pageRanges: ['1-2', '4'],
        },
        30000
      );
      await expect(fs.readFile(targetPath)).resolves.toEqual(Buffer.from('ruyi pdf payload'));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('continues blocked requests that fail local method filtering after browser-side URL narrowing', async () => {
    const client = createClient();
    client.activeContextId = 'ctx-active';
    client.interceptPatterns = [
      {
        urlPattern: '/api/ping',
        methods: ['GET'],
      },
    ];
    client.continueInterceptedRequest = vi.fn(async () => undefined);
    const listener = vi.fn();
    client.onEvent(listener);

    client.handleBiDiEvent({
      method: 'network.beforeRequestSent',
      params: {
        context: 'ctx-active',
        isBlocked: true,
        request: {
          request: 'req-9',
          url: 'https://example.test/api/ping',
          method: 'POST',
          destination: 'fetch',
          headers: [],
        },
      },
    });

    await Promise.resolve();

    expect(client.continueInterceptedRequest).toHaveBeenCalledWith(
      { requestId: 'req-9' },
      5000
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not clear dialog state when the final fallback fails to close the prompt', async () => {
    const client = createClient();
    client.currentDialog = {
      type: 'prompt',
      message: 'Enter value',
      defaultValue: '',
      contextId: 'ctx-dialog',
    };
    client.bidi.sendCommand = vi.fn(async () => undefined);
    client.waitForCurrentDialogToClose = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    client.nativeKeyPress = vi.fn(async () => undefined);

    await expect(client.handleDialog({ accept: true }, 1000)).rejects.toThrow(
      'Failed to close Firefox dialog for context ctx-dialog'
    );
    expect(client.currentDialog).toEqual({
      type: 'prompt',
      message: 'Enter value',
      defaultValue: '',
      contextId: 'ctx-dialog',
    });
    expect(client.lastDialogContextId).toBeNull();
  });

  it('rejects pending dialog waits when the client closes during teardown', async () => {
    const client = createClient();
    client.bidi.sendCommand = vi.fn(async () => undefined);
    client.bidi.close = vi.fn(async () => undefined);

    const waitPromise = client.dispatch('dialog.wait', { timeoutMs: 5000 });
    await Promise.resolve();

    const waitAssertion = expect(waitPromise).rejects.toThrow('Ruyi Firefox runtime is closing');
    await client.close();
    await waitAssertion;
  });

  it('resolves concurrent dialog waits from a single prompt-open event without leaking waiters', async () => {
    const client = createClient();

    const firstWait = client.dispatch('dialog.wait', { timeoutMs: 1200 });
    const secondWait = client.dispatch('dialog.wait', { timeoutMs: 1200 });

    await Promise.resolve();

    client.handleBiDiEvent({
      method: 'browsingContext.userPromptOpened',
      params: {
        context: 'ctx-dialog',
        type: 'confirm',
        message: 'Proceed?',
      },
    });

    await expect(Promise.all([firstWait, secondWait])).resolves.toEqual([
      {
        type: 'confirm',
        message: 'Proceed?',
        defaultValue: undefined,
        contextId: 'ctx-dialog',
      },
      {
        type: 'confirm',
        message: 'Proceed?',
        defaultValue: undefined,
        contextId: 'ctx-dialog',
      },
    ]);
    expect(client.dialogWaiters.size).toBe(0);
  });
});
