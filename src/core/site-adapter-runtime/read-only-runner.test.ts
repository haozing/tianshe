import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRootTraceContext } from '../observability/observation-context';
import { setObservationSink } from '../observability/observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../observability/types';
import {
  runReadOnlySiteAdapterFixture,
  runReadOnlySiteAdapterRuntimeCanary,
} from './read-only-runner';
import type { BrowserInterface } from '../../types/browser-interface';
import { staticProductAdapter } from '../../../examples/web-site-adapter-static-product/adapter';
import fixture from '../../../examples/web-site-adapter-static-product/fixtures/product-page.json';
import expected from '../../../examples/web-site-adapter-static-product/expected/product-page.json';

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

describe('read-only site adapter runner', () => {
  afterEach(() => {
    setObservationSink(null);
  });

  it('runs the example adapter against a fixture and expected output', async () => {
    const result = await runReadOnlySiteAdapterFixture(staticProductAdapter, {
      name: fixture.name,
      snapshot: fixture.snapshot,
      expected,
    });

    expect(result).toMatchObject({
      adapterId: 'static-product.example',
      fixtureName: 'product-page',
      ok: true,
      result: expected,
      artifactRefs: [],
      diagnostics: [
        { path: 'productName', ok: true },
        { path: 'price', ok: true },
        { path: 'seller', ok: true },
      ],
    });
  });

  it('runs the example adapter through the BrowserInterface snapshot canary path', async () => {
    const browser = {
      snapshot: vi.fn().mockResolvedValue(fixture.snapshot),
    } as Pick<BrowserInterface, 'snapshot'>;

    const result = await runReadOnlySiteAdapterRuntimeCanary(staticProductAdapter, {
      browser,
      fixtureName: fixture.name,
      expected,
    });

    expect(browser.snapshot).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      adapterId: 'static-product.example',
      fixtureName: 'product-page',
      ok: true,
      result: expected,
    });
  });

  it('records Site Adapter failure and repair evidence artifacts', async () => {
    const sink = new MemoryObservationSink();
    setObservationSink(sink);

    const result = await runReadOnlySiteAdapterFixture(
      staticProductAdapter,
      {
        name: fixture.name,
        snapshot: fixture.snapshot,
        expected: {
          ...expected,
          price: '99.99',
        },
      },
      {
        context: createRootTraceContext({
          traceId: 'trace-site-adapter-failure',
          source: 'test',
        }),
      }
    );

    expect(result.ok).toBe(false);
    expect(result.artifactRefs).toHaveLength(6);
    expect(sink.artifacts.map((artifact) => artifact.type)).toEqual([
      'site_adapter_result',
      'procedure_state_transition',
      'interactor_action_trace',
      'site_adapter_failure',
      'site_adapter_repair_evidence',
      'site_adapter_repair_bundle',
    ]);
    expect(sink.artifacts[4]).toMatchObject({
      type: 'site_adapter_repair_evidence',
      data: {
        adapterId: 'static-product.example',
        fixtureName: 'product-page',
        expected: {
          price: '99.99',
        },
        before: {
          price: '12.50',
        },
        after: null,
      },
    });
  });

  it('aborts fixture execution through AbortSignal before side-effect-free extraction continues', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop fixture run'));

    await expect(
      runReadOnlySiteAdapterFixture(
        staticProductAdapter,
        {
          name: fixture.name,
          snapshot: fixture.snapshot,
          expected,
        },
        { signal: controller.signal }
      )
    ).rejects.toThrow('stop fixture run');
  });
});
