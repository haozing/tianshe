import { afterEach, describe, expect, it } from 'vitest';
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
});
