import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { getSessionWebRequestHub } from './web-request-hub';

type BlockingListener = (details: Record<string, any>, callback: (result?: Record<string, any>) => void) => void;
type ObserverListener = (details: Record<string, any>) => void;

function createFakeSession(): Session & {
  __listeners: Record<string, BlockingListener | ObserverListener | undefined>;
  __registrations: Record<string, number>;
} {
  const listeners: Record<string, BlockingListener | ObserverListener | undefined> = {};
  const registrations = {
    onBeforeRequest: 0,
    onBeforeSendHeaders: 0,
    onHeadersReceived: 0,
    onCompleted: 0,
    onErrorOccurred: 0,
  };

  const webRequest = {
    onBeforeRequest: vi.fn((...args: any[]) => {
      registrations.onBeforeRequest += 1;
      listeners.onBeforeRequest = (args[1] ?? args[0]) as BlockingListener;
    }),
    onBeforeSendHeaders: vi.fn((...args: any[]) => {
      registrations.onBeforeSendHeaders += 1;
      listeners.onBeforeSendHeaders = (args[1] ?? args[0]) as BlockingListener;
    }),
    onHeadersReceived: vi.fn((...args: any[]) => {
      registrations.onHeadersReceived += 1;
      listeners.onHeadersReceived = (args[1] ?? args[0]) as BlockingListener;
    }),
    onCompleted: vi.fn((...args: any[]) => {
      registrations.onCompleted += 1;
      listeners.onCompleted = (args[1] ?? args[0]) as ObserverListener;
    }),
    onErrorOccurred: vi.fn((...args: any[]) => {
      registrations.onErrorOccurred += 1;
      listeners.onErrorOccurred = (args[1] ?? args[0]) as ObserverListener;
    }),
  };

  return {
    webRequest,
    __listeners: listeners,
    __registrations: registrations,
  } as unknown as Session & {
    __listeners: Record<string, BlockingListener | ObserverListener | undefined>;
    __registrations: Record<string, number>;
  };
}

describe('session web request hub', () => {
  it('composes multiple beforeSendHeaders subscribers without overwriting the Electron slot', () => {
    const session = createFakeSession();
    const hub = getSessionWebRequestHub(session);
    const sameHub = getSessionWebRequestHub(session);

    expect(sameHub).toBe(hub);

    const unsubscribeStripReferer = hub.subscribeBeforeSendHeaders((details, callback) => {
      const {
        referer: _referer,
        Referer: _Referer,
        ...requestHeaders
      } = details.requestHeaders || {};
      callback({ requestHeaders });
    });

    hub.subscribeBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    });

    expect(session.__registrations.onBeforeSendHeaders).toBe(1);

    let result: Record<string, any> | undefined;
    (session.__listeners.onBeforeSendHeaders as BlockingListener)(
      {
        url: 'https://example.com/image.png',
        requestHeaders: {
          Referer: 'https://origin.example.com',
          'User-Agent': 'UA',
        },
      },
      (value) => {
        result = value;
      }
    );

    expect(result?.requestHeaders).toEqual({
      'User-Agent': 'UA',
      'Accept-Language': 'en-US,en;q=0.9',
    });

    unsubscribeStripReferer();

    (session.__listeners.onBeforeSendHeaders as BlockingListener)(
      {
        url: 'https://example.com/image.png',
        requestHeaders: {
          Referer: 'https://origin.example.com',
          'User-Agent': 'UA',
        },
      },
      (value) => {
        result = value;
      }
    );

    expect(result?.requestHeaders).toEqual({
      Referer: 'https://origin.example.com',
      'User-Agent': 'UA',
      'Accept-Language': 'en-US,en;q=0.9',
    });
  });

  it('supports filtering and observer fanout without clearing sibling subscribers', () => {
    const session = createFakeSession();
    const hub = getSessionWebRequestHub(session);
    const completedA = vi.fn();
    const completedB = vi.fn();
    const lateObserver = vi.fn();

    hub.subscribeCompleted(completedA);
    hub.subscribeCompleted(completedB);

    expect(session.__registrations.onCompleted).toBe(1);

    (session.__listeners.onCompleted as ObserverListener)({
      url: 'https://example.com/api/data',
      statusCode: 200,
    });

    expect(completedA).toHaveBeenCalledTimes(1);
    expect(completedB).toHaveBeenCalledTimes(1);

    const unsubscribe = hub.subscribeCompleted(lateObserver, {
      urls: ['https://static.example.com/*'],
    });

    (session.__listeners.onCompleted as ObserverListener)({
      url: 'https://example.com/api/data',
      statusCode: 200,
    });

    expect(lateObserver).not.toHaveBeenCalled();

    unsubscribe();

    (session.__listeners.onCompleted as ObserverListener)({
      url: 'https://example.com/api/other',
      statusCode: 200,
    });

    expect(completedA).toHaveBeenCalledTimes(3);
    expect(completedB).toHaveBeenCalledTimes(3);
    expect(lateObserver).not.toHaveBeenCalled();
  });

  it('treats regex-like URL patterns as permissive so interceptor rules are not dropped early', () => {
    const session = createFakeSession();
    const hub = getSessionWebRequestHub(session);
    const matched = vi.fn();

    hub.subscribeBeforeRequest(
      (details, callback) => {
        if (/ads/.test(details.url)) {
          matched();
          callback({ cancel: true });
          return;
        }
        callback({});
      },
      { urls: ['.*ads.*'] }
    );

    let result: Record<string, any> | undefined;
    (session.__listeners.onBeforeRequest as BlockingListener)(
      { url: 'https://cdn.example.com/ads/banner.js' },
      (value) => {
        result = value;
      }
    );

    expect(matched).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ cancel: true });
  });
});
