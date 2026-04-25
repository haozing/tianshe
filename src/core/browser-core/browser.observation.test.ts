import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimpleBrowser } from './browser';
import { setObservationSink } from '../observability/observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../observability/types';

class MockWebContents extends EventEmitter {
  session = {} as never;
  loadURL = vi.fn<(...args: [string]) => Promise<void>>(async () => undefined);
  setWindowOpenHandler = vi.fn();
  isDestroyed = vi.fn(() => false);
  getURL = vi.fn(() => 'about:blank');
  getTitle = vi.fn(() => 'about:blank');
  stop = vi.fn();
  removeListener = super.removeListener.bind(this);
  once = super.once.bind(this);
}

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

describe('SimpleBrowser observation', () => {
  afterEach(() => {
    setObservationSink(null);
  });

  it('records a structured event when blocking custom protocol navigation', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    const browser = new SimpleBrowser(
      'view-1',
      new MockWebContents() as never,
      { closeView: vi.fn(async () => undefined) }
    );

    await expect(browser.goto('bytedance://open')).rejects.toThrow('unsupported protocol');

    expect(sink.events).toEqual([
      expect.objectContaining({
        event: 'browser.action.custom_protocol.blocked',
        outcome: 'blocked',
        browserEngine: 'electron',
        browserId: 'view-1',
        attrs: expect.objectContaining({
          url: 'bytedance://open',
          trigger: 'goto',
        }),
      }),
    ]);
  });
});
