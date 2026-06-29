import { TimeoutError } from './errors';
import type { JSPluginManifest } from '../../types/js-plugin';

export const DEFAULT_PLUGIN_LIFECYCLE_HOOK_TIMEOUT_MS = 30_000;
export const DEFAULT_PLUGIN_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_PLUGIN_API_TIMEOUT_MS = 120_000;

const MAX_PLUGIN_RUNTIME_BUDGET_MS = 30 * 60 * 1000;

type RuntimeBudgetKind = 'lifecycleHookTimeoutMs' | 'commandTimeoutMs' | 'apiTimeoutMs';

function normalizeBudgetMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), MAX_PLUGIN_RUNTIME_BUDGET_MS);
}

export function getPluginRuntimeBudgetMs(
  manifest: Pick<JSPluginManifest, 'runtime'> | undefined,
  kind: RuntimeBudgetKind
): number {
  const fallback =
    kind === 'lifecycleHookTimeoutMs'
      ? DEFAULT_PLUGIN_LIFECYCLE_HOOK_TIMEOUT_MS
      : kind === 'apiTimeoutMs'
        ? DEFAULT_PLUGIN_API_TIMEOUT_MS
        : DEFAULT_PLUGIN_COMMAND_TIMEOUT_MS;
  return normalizeBudgetMs(manifest?.runtime?.[kind], fallback);
}

export async function withPluginRuntimeBudget<T>(
  operation: string,
  timeoutMs: number,
  run: () => Promise<T> | T
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await run();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve(run()),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new TimeoutError(operation, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
