import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { BrowserInterceptorService } from './interceptor';

type BlockingListener = (details: Record<string, any>, callback: (result?: Record<string, any>) => void) => void;

function createFakeSession(): Session & {
  __listeners: Record<string, BlockingListener | undefined>;
} {
  const listeners: Record<string, BlockingListener | undefined> = {};

  const webRequest = {
    onBeforeRequest: vi.fn((...args: any[]) => {
      listeners.onBeforeRequest = (args[1] ?? args[0]) as BlockingListener;
    }),
    onBeforeSendHeaders: vi.fn((...args: any[]) => {
      listeners.onBeforeSendHeaders = (args[1] ?? args[0]) as BlockingListener;
    }),
    onHeadersReceived: vi.fn((...args: any[]) => {
      listeners.onHeadersReceived = (args[1] ?? args[0]) as BlockingListener;
    }),
    onCompleted: vi.fn(),
    onErrorOccurred: vi.fn(),
  };

  return {
    webRequest,
    __listeners: listeners,
  } as unknown as Session & {
    __listeners: Record<string, BlockingListener | undefined>;
  };
}

describe('BrowserInterceptorService', () => {
  it('filters requests by current webContentsId when multiple views share one Electron session', async () => {
    const session = createFakeSession();
    const interceptor = new BrowserInterceptorService({
      getSession: () => session,
      getWebContentsId: () => 1001,
      ensureNotDisposed: () => undefined,
    });

    await interceptor.install('block-ads', {
      target: 'request',
      urlPattern: '.*ads.*',
      requestAction: { block: true },
    });

    let otherViewResult: Record<string, any> | undefined;
    session.__listeners.onBeforeRequest?.(
      {
        webContentsId: 2002,
        url: 'https://cdn.example.com/ads/banner.js',
        method: 'GET',
      },
      (value) => {
        otherViewResult = value;
      }
    );

    let currentViewResult: Record<string, any> | undefined;
    session.__listeners.onBeforeRequest?.(
      {
        webContentsId: 1001,
        url: 'https://cdn.example.com/ads/banner.js',
        method: 'GET',
      },
      (value) => {
        currentViewResult = value;
      }
    );

    expect(otherViewResult).toEqual({});
    expect(currentViewResult).toEqual({ cancel: true });

    await interceptor.remove('block-ads');

    let removedRuleResult: Record<string, any> | undefined;
    session.__listeners.onBeforeRequest?.(
      {
        webContentsId: 1001,
        url: 'https://cdn.example.com/ads/banner.js',
        method: 'GET',
      },
      (value) => {
        removedRuleResult = value;
      }
    );

    expect(removedRuleResult).toEqual({});
  });
});
