import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRootTraceContext, withTraceContext } from './observation-context';
import { observationService, setObservationSink } from './observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from './types';

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

describe('ObservationService', () => {
  afterEach(() => {
    setObservationSink(null);
    vi.useRealTimers();
  });

  it('records events against the active trace context', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    await withTraceContext(
      createRootTraceContext({
        traceId: 'trace-obs-1',
        source: 'test',
      }),
      async () => {
        await observationService.event({
          component: 'test',
          event: 'capability.invoke.started',
          outcome: 'started',
          attrs: {
            capability: 'browser_snapshot',
          },
        });
      }
    );

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      traceId: 'trace-obs-1',
      source: 'test',
      component: 'test',
      event: 'capability.invoke.started',
      outcome: 'started',
      attrs: {
        capability: 'browser_snapshot',
      },
    });
  });

  it('startSpan emits started and succeeded events and keeps artifacts on the same trace', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    await withTraceContext(
      createRootTraceContext({
        traceId: 'trace-obs-2',
        source: 'test',
      }),
      async () => {
        const span = await observationService.startSpan({
          component: 'browser',
          event: 'browser.action.click',
          attrs: {
            selector: '#submit',
          },
        });

        await span.attachArtifact({
          component: 'browser',
          type: 'snapshot',
          label: 'click failure snapshot',
          data: {
            url: 'https://example.com',
          },
        });

        await span.succeed({
          attrs: {
            selector: '#submit',
          },
        });
      }
    );

    expect(sink.events.map((event) => event.event)).toEqual([
      'browser.action.click.started',
      'browser.action.click.succeeded',
    ]);
    expect(sink.events.every((event) => event.traceId === 'trace-obs-2')).toBe(true);
    expect(sink.artifacts).toHaveLength(1);
    expect(sink.artifacts[0]).toMatchObject({
      traceId: 'trace-obs-2',
      type: 'snapshot',
      label: 'click failure snapshot',
    });
  });

  it('returns events after a bounded wait when the sink is stuck', async () => {
    vi.useFakeTimers();
    setObservationSink({
      recordEvent: vi.fn(() => new Promise<void>(() => undefined)),
      recordArtifact: vi.fn(),
    });

    const eventPromise = observationService.event({
      component: 'test',
      event: 'slow.sink',
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(eventPromise).resolves.toMatchObject({
      component: 'test',
      event: 'slow.sink',
    });
  });

  it('redacts sensitive values in observation events and artifacts', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);
    const error = new Error('Authorization: Bearer error-secret');
    error.stack = 'Error: failed\nSet-Cookie: sid=stack-secret; Path=/';

    await withTraceContext(
      createRootTraceContext({
        traceId: 'trace-redaction',
        source: 'test',
      }),
      async () => {
        await observationService.event({
          component: 'test',
          event: 'redaction.event',
          message: 'Failed with token=message-secret',
          error,
          attrs: {
            authorization: 'Bearer event-secret',
            consoleLine: 'Set-Cookie: sid=console-secret; Path=/',
            harmless: {
              value: 'visible-value',
            },
          },
        });
        await observationService.attachArtifact({
          component: 'test',
          type: 'network_summary',
          data: {
            requestHeaders: {
              Authorization: 'Bearer request-secret',
              accept: 'application/json',
            },
            responseHeaders: {
              'set-cookie': 'sid=response-secret; Path=/',
            },
            cookies: [
              {
                name: 'sid',
                value: 'cookie-secret',
                domain: 'example.com',
                path: '/',
                httpOnly: true,
              },
            ],
            nested: {
              accessToken: 'nested-token-secret',
            },
            harmless: {
              value: 'visible-value',
            },
          },
        });
      }
    );

    const serialized = JSON.stringify({
      events: sink.events,
      artifacts: sink.artifacts,
    });
    expect(serialized).not.toContain('event-secret');
    expect(serialized).not.toContain('message-secret');
    expect(serialized).not.toContain('error-secret');
    expect(serialized).not.toContain('stack-secret');
    expect(serialized).not.toContain('console-secret');
    expect(serialized).not.toContain('request-secret');
    expect(serialized).not.toContain('response-secret');
    expect(serialized).not.toContain('cookie-secret');
    expect(serialized).not.toContain('nested-token-secret');
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('visible-value');
  });
});
