import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuyiBrowser } from './ruyi-browser';
import { createRootTraceContext, withTraceContext } from '../observability/observation-context';
import { setObservationSink } from '../observability/observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../observability/types';

class MemoryObservationSink implements ObservationSink {
  events: RuntimeEvent[] = [];
  artifacts: RuntimeArtifact[] = [];

  recordEvent(event: RuntimeEvent): void {
    this.events.push(event);
  }

  recordArtifact(artifact: RuntimeArtifact): void {
    this.artifacts.push(artifact);
  }
}

function createBrowserWithDispatch(
  dispatch: (command: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
) {
  const client = {
    onEvent: vi.fn(() => () => undefined),
    dispatch: vi.fn(dispatch),
    isClosed: vi.fn(() => false),
  } as any;

  const browser = new RuyiBrowser({
    client,
    closeInternal: vi.fn(async () => undefined),
  });

  return { browser, client };
}

describe('RuyiBrowser observation and screenshot metadata', () => {
  afterEach(() => {
    setObservationSink(null);
  });

  it('records synthetic pointer fallback attrs on click success', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);
    const { browser } = createBrowserWithDispatch(async () => undefined);
    const testBrowser = browser as any;

    testBrowser.waitForSelectorInternal = vi.fn(async () => undefined);
    testBrowser.queryElement = vi.fn(async () => ({
      found: true,
      visible: true,
      bounds: { x: 10, y: 20, width: 80, height: 30 },
    }));
    testBrowser.domClickElement = vi.fn(async () => false);
    testBrowser.clickViewportPoint = vi.fn(async () => ({
      succeeded: true,
      dispatchStrategy: 'synthetic_pointer',
      fallbackUsed: true,
      fallbackFrom: 'native_pointer',
      selectorResolution: 'viewport_center',
    }));

    await withTraceContext(
      createRootTraceContext({
        traceId: 'trace-ruyi-click',
        source: 'test',
      }),
      async () => {
        await browser.click('#submit');
      }
    );

    const successEvent = sink.events.find((event) => event.event === 'browser.action.click.succeeded');
    expect(successEvent?.attrs).toMatchObject({
      selector: '#submit',
      dispatchStrategy: 'synthetic_pointer',
      fallbackUsed: true,
      fallbackFrom: 'native_pointer',
      selectorResolution: 'viewport_center',
    });
  });

  it('records native keyboard fallback attrs on type success', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);
    const { browser } = createBrowserWithDispatch(async () => undefined);
    const testBrowser = browser as any;

    testBrowser.waitForSelectorInternal = vi.fn(async () => undefined);
    testBrowser.queryElement = vi.fn(async () => ({
      found: true,
      visible: true,
      bounds: { x: 10, y: 20, width: 100, height: 30 },
    }));
    testBrowser.typeIntoElement = vi.fn(async () => false);
    testBrowser.native.click = vi.fn(async () => undefined);
    testBrowser.native.keyPress = vi.fn(async () => undefined);
    testBrowser.native.type = vi.fn(async () => undefined);

    await withTraceContext(
      createRootTraceContext({
        traceId: 'trace-ruyi-type',
        source: 'test',
      }),
      async () => {
        await browser.type('#field', 'hello', { clear: true });
      }
    );

    const successEvent = sink.events.find((event) => event.event === 'browser.action.type.succeeded');
    expect(successEvent?.attrs).toMatchObject({
      selector: '#field',
      clear: true,
      dispatchStrategy: 'native_keyboard',
      fallbackUsed: true,
      fallbackFrom: 'synthetic_input',
      selectorResolution: 'selector_dom',
    });
  });

  it('reports full-page screenshots as BiDi captures', async () => {
    const payload = Buffer.from('ruyi-full-page').toString('base64');
    const { browser } = createBrowserWithDispatch(async (command) => {
      if (command === 'screenshot') {
        return {
          data: payload,
          captureMode: 'full_page',
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await browser.screenshotDetailed({ captureMode: 'full_page' });

    expect(result.captureMethod).toBe('bidi.full_page_screenshot');
    expect(result.captureMode).toBe('full_page');
  });

  it('reports selector screenshots as BiDi viewport captures', async () => {
    const { browser } = createBrowserWithDispatch(async () => undefined);
    const testBrowser = browser as any;
    testBrowser.waitForSelectorInternal = vi.fn(async () => undefined);
    testBrowser.queryElement = vi.fn(async () => ({
      found: true,
      visible: true,
      bounds: { x: 5, y: 6, width: 7, height: 8 },
    }));
    testBrowser.captureViewportScreenshot = vi.fn(async () => Buffer.from('selector-shot'));

    const result = await browser.screenshotDetailed({ selector: '#target' });

    expect(result.captureMethod).toBe('bidi.viewport_screenshot');
    expect(result.captureMode).toBe('viewport');
  });

  it('keeps userAgent reads on the page runtime and routes runtime emulation overrides through transport commands', async () => {
    const { browser, client } = createBrowserWithDispatch(async (command, params) => {
      if (command === 'evaluate') {
        return 'Mozilla/5.0 (Baseline UA)';
      }
      return undefined;
    });

    await expect(browser.getUserAgent()).resolves.toBe('Mozilla/5.0 (Baseline UA)');
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

    expect(client.dispatch).toHaveBeenCalledTimes(4);
    expect(client.dispatch).toHaveBeenNthCalledWith(1, 'evaluate', { script: 'navigator.userAgent' }, undefined);
    expect(client.dispatch).toHaveBeenNthCalledWith(
      2,
      'emulation.identity.set',
      {
        options: {
          userAgent: 'AirpaSharedRealContract/1.0',
        },
      },
      undefined
    );
    expect(client.dispatch).toHaveBeenNthCalledWith(
      3,
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
    expect(client.dispatch).toHaveBeenNthCalledWith(4, 'emulation.clear', undefined, undefined);
  });
});
