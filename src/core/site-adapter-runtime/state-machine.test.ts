import { describe, expect, it } from 'vitest';
import {
  appendInteractorActionTrace,
  appendProcedureTransition,
  createSiteAdapterRunState,
  replaySiteAdapterTransitions,
} from './state-machine';

describe('site adapter state machine', () => {
  it('records and replays a multi-step flow without browser handles or secrets', () => {
    const state = createSiteAdapterRunState({
      adapterId: 'example.adapter',
      fixtureName: 'product.fixture.html',
      values: {
        browser: { unsafe: true },
        page: { unsafe: true },
        token: 'secret-token',
        productId: 'sku-1',
      },
    });

    appendProcedureTransition(state, {
      stepId: 'extract',
      to: 'extracting',
      action: 'extract product fields',
      data: {
        selector: '.product-title',
        context: { fixture: 'product.fixture.html' },
        cookie: 'sid=secret',
      },
    });
    appendInteractorActionTrace(state, {
      stepId: 'extract',
      action: 'snapshot',
      outcome: 'succeeded',
      input: {
        page: { unsafe: true },
        selector: '.product-title',
      },
      output: {
        title: 'Demo Product',
        authorization: 'Bearer secret',
      },
    });
    appendProcedureTransition(state, {
      stepId: 'verify',
      to: 'verifying',
      action: 'verify required fields',
    });
    appendProcedureTransition(state, {
      stepId: 'complete',
      to: 'completed',
      action: 'finish fixture flow',
    });

    expect(state.status).toBe('completed');
    expect(state.transitions.map((transition) => transition.to)).toEqual([
      'extracting',
      'verifying',
      'completed',
    ]);
    expect(JSON.stringify(state)).not.toMatch(/secret-token|sid=secret|Bearer secret/);

    const replayed = replaySiteAdapterTransitions(
      createSiteAdapterRunState({ adapterId: 'example.adapter' }),
      state.transitions
    );
    expect(replayed.status).toBe('completed');
    expect(replayed.transitions.map((transition) => transition.action)).toEqual([
      'extract product fields',
      'verify required fields',
      'finish fixture flow',
    ]);
  });
});
