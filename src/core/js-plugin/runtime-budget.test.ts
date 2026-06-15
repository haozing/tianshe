import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PLUGIN_COMMAND_TIMEOUT_MS,
  getPluginRuntimeBudgetMs,
  withPluginRuntimeBudget,
} from './runtime-budget';
import type { JSPluginManifest } from '../../types/js-plugin';

const createManifest = (runtime?: JSPluginManifest['runtime']): JSPluginManifest => ({
  id: 'plugin-a',
  name: 'Plugin A',
  version: '1.0.0',
  author: 'Test',
  main: 'index.js',
  runtime,
});

describe('plugin runtime budget', () => {
  it('normalizes command timeout from manifest runtime policy', () => {
    expect(
      getPluginRuntimeBudgetMs(createManifest({ commandTimeoutMs: 500 }), 'commandTimeoutMs')
    ).toBe(500);
    expect(getPluginRuntimeBudgetMs(createManifest(), 'commandTimeoutMs')).toBe(
      DEFAULT_PLUGIN_COMMAND_TIMEOUT_MS
    );
  });

  it('rejects when an operation exceeds its budget', async () => {
    vi.useFakeTimers();
    const pending = withPluginRuntimeBudget(
      'plugin plugin-a command:slow',
      25,
      () => new Promise(() => {})
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'TIMEOUT',
    });

    await vi.advanceTimersByTimeAsync(26);

    await assertion;
    vi.useRealTimers();
  });
});
