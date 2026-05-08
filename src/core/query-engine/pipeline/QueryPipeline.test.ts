import { describe, it, expect } from 'vitest';
import { QueryPipeline } from './QueryPipeline';
import { createSoftDeleteStep } from './createSoftDeleteStep';
import type { QueryPipelineStep } from './QueryPipelineStep';
import type { SQLContext, QueryConfig } from '../types';

describe('QueryPipeline', () => {
  function createMockContext(): SQLContext {
    return {
      datasetId: 'test',
      currentTable: 'source',
      ctes: [],
      availableColumns: new Set(['a', 'b']),
    };
  }

  const mockStep = (key: string, phase: QueryPipelineStep['phase']): QueryPipelineStep => ({
    key,
    phase,
    applies: () => true,
    apply: (ctx) => {
      ctx.ctes.push({ name: key, sql: `SELECT * FROM ${ctx.currentTable}` });
      ctx.currentTable = key;
    },
  });

  const conditionalStep = (
    key: string,
    phase: QueryPipelineStep['phase'],
    condition: (config: QueryConfig) => boolean
  ): QueryPipelineStep => ({
    key,
    phase,
    applies: condition,
    apply: (ctx) => {
      ctx.ctes.push({ name: key, sql: `SELECT * FROM ${ctx.currentTable}` });
      ctx.currentTable = key;
    },
  });

  it('registers and executes steps in order', async () => {
    const pipeline = new QueryPipeline()
      .register(mockStep('filter', 'pre-dedupe'))
      .register(mockStep('clean', 'pre-dedupe'));

    const ctx = createMockContext();
    await pipeline.executePhase('pre-dedupe', ctx, {});

    expect(ctx.ctes.map((c) => c.name)).toEqual(['filter', 'clean']);
    expect(ctx.currentTable).toBe('clean');
  });

  it('skips steps that do not apply', async () => {
    const pipeline = new QueryPipeline()
      .register(conditionalStep('filter', 'pre-dedupe', (c) => !!c.filter))
      .register(mockStep('clean', 'pre-dedupe'));

    const ctx = createMockContext();
    await pipeline.executePhase('pre-dedupe', ctx, {});

    expect(ctx.ctes.map((c) => c.name)).toEqual(['clean']);
  });

  it('only executes steps matching the requested phase', async () => {
    const pipeline = new QueryPipeline()
      .register(mockStep('pre', 'pre-dedupe'))
      .register(mockStep('dedupe', 'dedupe'))
      .register(mockStep('post', 'post-dedupe'));

    const ctx = createMockContext();
    await pipeline.executePhase('dedupe', ctx, {});

    expect(ctx.ctes.map((c) => c.name)).toEqual(['dedupe']);
  });

  it('runs validate before apply when provided', async () => {
    const validate = vi.fn();
    const step: QueryPipelineStep = {
      key: 'validated-step',
      phase: 'pre-dedupe',
      applies: () => true,
      validate,
      apply: (ctx) => {
        ctx.ctes.push({ name: 'validated', sql: '' });
      },
    };

    const pipeline = new QueryPipeline().register(step);
    const ctx = createMockContext();
    await pipeline.executePhase('pre-dedupe', ctx, {});

    expect(validate).toHaveBeenCalledOnce();
    expect(ctx.ctes).toHaveLength(1);
  });

  it('supports steps that return nextContext instead of mutating in place', async () => {
    const pipeline = new QueryPipeline().register({
      key: 'immutable-step',
      phase: 'pre-dedupe',
      applies: () => true,
      apply: (ctx) => ({
        nextContext: {
          ...ctx,
          currentTable: 'immutable-step',
          ctes: [...ctx.ctes, { name: 'immutable-step', sql: `SELECT * FROM ${ctx.currentTable}` }],
          availableColumns: new Set(['a', 'c']),
        },
      }),
    });

    const ctx = createMockContext();
    const result = await pipeline.executePhase('pre-dedupe', ctx, {});

    expect(result).toBe(ctx);
    expect(ctx.currentTable).toBe('immutable-step');
    expect(ctx.ctes.map((c) => c.name)).toEqual(['immutable-step']);
    expect(Array.from(ctx.availableColumns)).toEqual(['a', 'c']);
  });

  it('applies soft delete as a nextContext pipeline step', async () => {
    const pipeline = new QueryPipeline().register(createSoftDeleteStep());
    const ctx = createMockContext();
    ctx.availableColumns.add('deleted_at');

    await pipeline.executePhase('pre-dedupe', ctx, {
      softDelete: { field: 'deleted_at', show: 'active' },
    });

    expect(ctx.currentTable).toBe('cte_soft_delete');
    expect(ctx.ctes).toEqual([
      {
        name: 'cte_soft_delete',
        sql: 'SELECT * FROM source WHERE deleted_at IS NULL',
      },
    ]);
  });

  it('skips soft delete when the configured field is missing', async () => {
    const pipeline = new QueryPipeline().register(createSoftDeleteStep());
    const ctx = createMockContext();

    await pipeline.executePhase('pre-dedupe', ctx, {
      softDelete: { field: 'deleted_at', show: 'active' },
    });

    expect(ctx.currentTable).toBe('source');
    expect(ctx.ctes).toEqual([]);
  });

  it('returns registered keys', () => {
    const pipeline = new QueryPipeline()
      .register(mockStep('a', 'pre-dedupe'))
      .register(mockStep('b', 'pre-dedupe'));

    expect(pipeline.registeredKeys).toEqual(['a', 'b']);
  });
});
