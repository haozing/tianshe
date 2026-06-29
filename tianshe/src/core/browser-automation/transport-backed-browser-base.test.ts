import { describe, expect, it, vi } from 'vitest';
import { TransportBackedBrowserBase } from './transport-backed-browser-base';
import type {
  BrowserInterceptWaitOptions,
  BrowserInterceptedRequest,
  BrowserRuntimeEvent,
} from '../../types/browser-interface';

class TestTransportBackedBrowser extends TransportBackedBrowserBase {
  readonly dispatchMock = vi.fn(async () => undefined);

  protected async dispatch<TResult>(
    command: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<TResult> {
    return (await this.dispatchMock(command, params, timeoutMs)) as TResult;
  }

  protected invalidateCoordinateState(): void {}

  pushInterceptedRequest(request: BrowserInterceptedRequest): void {
    this.appendInterceptedRequest(request);
  }

  getInterceptedRequestsSnapshot(): BrowserInterceptedRequest[] {
    return this.cloneInterceptedRequests();
  }

  async waitForInterceptedRequestForTest(
    options?: BrowserInterceptWaitOptions
  ): Promise<BrowserInterceptedRequest> {
    return await this.waitForInterceptedRequestEntry(options);
  }

  emitRuntimeEventForTest(event: BrowserRuntimeEvent): void {
    this.emitRuntimeEvent(event);
  }
}

function createInterceptedRequest(
  overrides?: Partial<BrowserInterceptedRequest>
): BrowserInterceptedRequest {
  return {
    id: 'req-1',
    url: 'https://example.test/api/orders',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    resourceType: 'xhr',
    postData: '{"ok":true}',
    isBlocked: true,
    interceptIds: ['rule-1'],
    ...overrides,
  };
}

describe('TransportBackedBrowserBase interception helpers', () => {
  it('returns cloned intercepted requests', () => {
    const browser = new TestTransportBackedBrowser();
    browser.pushInterceptedRequest(createInterceptedRequest());

    const requests = browser.getInterceptedRequestsSnapshot();
    requests[0]!.headers['x-airpa'] = '1';
    requests[0]!.interceptIds?.push('rule-2');

    expect(browser.getInterceptedRequestsSnapshot()).toEqual([
      expect.objectContaining({
        headers: {
          'content-type': 'application/json',
        },
        interceptIds: ['rule-1'],
      }),
    ]);
  });

  it('matches intercepted requests by method and url pattern', async () => {
    const browser = new TestTransportBackedBrowser();
    browser.pushInterceptedRequest(
      createInterceptedRequest({
        id: 'req-1',
        url: 'https://example.test/assets/app.js',
        method: 'GET',
        resourceType: 'script',
      })
    );
    browser.pushInterceptedRequest(
      createInterceptedRequest({
        id: 'req-2',
        url: 'https://example.test/api/orders/42',
        method: 'POST',
      })
    );

    await expect(
      browser.waitForInterceptedRequestForTest({
        timeoutMs: 200,
        method: 'POST',
        urlPattern: '/api/orders',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'req-2',
      })
    );
  });

  it('does not replay previously observed intercepted requests across repeated waits', async () => {
    const browser = new TestTransportBackedBrowser();
    browser.pushInterceptedRequest(
      createInterceptedRequest({
        id: 'req-1',
        url: 'https://example.test/api/orders/first',
      })
    );

    await expect(browser.waitForInterceptedRequestForTest({ timeoutMs: 300 })).resolves.toEqual(
      expect.objectContaining({
        id: 'req-1',
      })
    );

    const nextWait = browser.waitForInterceptedRequestForTest({ timeoutMs: 1200 });
    setTimeout(() => {
      browser.pushInterceptedRequest(
        createInterceptedRequest({
          id: 'req-2',
          url: 'https://example.test/api/orders/second',
        })
      );
    }, 150);

    await expect(nextWait).resolves.toEqual(
      expect.objectContaining({
        id: 'req-2',
      })
    );
  });

  it('lets concurrent intercepted-request waits resolve from the same newly arrived request', async () => {
    const browser = new TestTransportBackedBrowser();

    const firstWait = browser.waitForInterceptedRequestForTest({ timeoutMs: 1200 });
    const secondWait = browser.waitForInterceptedRequestForTest({ timeoutMs: 1200 });

    setTimeout(() => {
      browser.pushInterceptedRequest(
        createInterceptedRequest({
          id: 'req-concurrent',
          url: 'https://example.test/api/orders/concurrent',
        })
      );
    }, 150);

    await expect(Promise.all([firstWait, secondWait])).resolves.toEqual([
      expect.objectContaining({
        id: 'req-concurrent',
      }),
      expect.objectContaining({
        id: 'req-concurrent',
      }),
    ]);
  });

  it('rejects aborted intercepted-request waits', async () => {
    const browser = new TestTransportBackedBrowser();
    const controller = new AbortController();
    controller.abort();

    await expect(
      browser.waitForInterceptedRequestForTest({
        timeoutMs: 200,
        signal: controller.signal,
      })
    ).rejects.toThrow('Intercept wait aborted');
  });

  it('routes interception facade commands through the shared transport layer', async () => {
    const browser = new TestTransportBackedBrowser();

    await browser.enableRequestInterception({
      patterns: [{ urlPattern: '/api/orders', methods: ['POST'] }],
    });
    await browser.continueRequest('req-1', {
      method: 'PUT',
      headers: { 'x-airpa': '1' },
    });
    await browser.fulfillRequest('req-1', {
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    await browser.failRequest('req-1', 'aborted');
    await browser.disableRequestInterception();

    expect(browser.dispatchMock).toHaveBeenNthCalledWith(
      1,
      'network.intercept.enable',
      {
        options: {
          patterns: [{ urlPattern: '/api/orders', methods: ['POST'] }],
        },
      },
      undefined
    );
    expect(browser.dispatchMock).toHaveBeenNthCalledWith(
      2,
      'network.intercept.continue',
      {
        requestId: 'req-1',
        overrides: {
          method: 'PUT',
          headers: { 'x-airpa': '1' },
        },
      },
      undefined
    );
    expect(browser.dispatchMock).toHaveBeenNthCalledWith(
      3,
      'network.intercept.fulfill',
      {
        requestId: 'req-1',
        response: {
          status: 201,
          headers: { 'content-type': 'application/json' },
          body: '{"ok":true}',
        },
      },
      undefined
    );
    expect(browser.dispatchMock).toHaveBeenNthCalledWith(
      4,
      'network.intercept.fail',
      {
        requestId: 'req-1',
        errorReason: 'aborted',
      },
      undefined
    );
    expect(browser.dispatchMock).toHaveBeenNthCalledWith(
      5,
      'network.intercept.disable',
      undefined,
      undefined
    );
  });

  it('broadcasts cloned runtime events through the shared event hub', () => {
    const browser = new TestTransportBackedBrowser();
    const firstListener = vi.fn((event: BrowserRuntimeEvent) => {
      const payload = event.payload as {
        meta: { tags: string[] };
      } & Record<string, unknown>;
      payload.listener = 'first';
      payload.meta.tags.push('mutated');
    });
    const secondListener = vi.fn();

    const unsubscribe = browser.onRuntimeEvent(firstListener);
    browser.onRuntimeEvent(secondListener);

    browser.emitRuntimeEventForTest({
      type: 'navigation.completed',
      contextId: 'ctx-1',
      timestamp: 1700000000000,
      payload: {
        url: 'https://example.test/orders',
        meta: {
          tags: ['original'],
        },
      },
    });

    unsubscribe();
    browser.emitRuntimeEventForTest({
      type: 'tab.activated',
      contextId: 'ctx-2',
      payload: {
        id: 'ctx-2',
      },
    });

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'navigation.completed',
        payload: {
          url: 'https://example.test/orders',
          meta: {
            tags: ['original'],
          },
        },
      })
    );
    expect(secondListener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'tab.activated',
        payload: {
          id: 'ctx-2',
        },
      })
    );
  });
});
