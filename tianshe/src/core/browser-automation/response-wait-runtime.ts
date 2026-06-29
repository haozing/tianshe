import type { NetworkEntry } from '../browser-core/types';

type WaitForCapturedResponseOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  getEntries: () => NetworkEntry[] | Promise<NetworkEntry[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function findMatchingCapturedResponse(
  entries: NetworkEntry[],
  urlPattern: string | RegExp
): NetworkEntry | null {
  const matcher = typeof urlPattern === 'string' ? new RegExp(urlPattern) : urlPattern;
  return entries.find((entry) => matcher.test(entry.url) && !!entry.status) || null;
}

export async function waitForCapturedResponse(
  urlPattern: string,
  options: WaitForCapturedResponseOptions
): Promise<NetworkEntry> {
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30000));
  const pollIntervalMs = Math.max(25, Math.trunc(options.pollIntervalMs ?? 150));
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  const startedAt = now();
  const matcher = new RegExp(urlPattern);

  while (now() - startedAt <= timeoutMs) {
    const matched = findMatchingCapturedResponse(await options.getEntries(), matcher);
    if (matched) {
      return matched;
    }

    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  throw new Error(`Timed out waiting for network response matching ${urlPattern}`);
}
