export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(Number(concurrency) || 1)));
  let cursor = 0;
  const runWorker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

export function createConcurrencyLimiter(concurrency: number) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = () => active < limit
    ? (active += 1, Promise.resolve())
    : new Promise<void>((resolve) => queue.push(() => { active += 1; resolve(); }));
  const release = () => {
    active = Math.max(0, active - 1);
    queue.shift()?.();
  };
  return async <T>(work: () => Promise<T>) => {
    await acquire();
    try {
      return await work();
    } finally {
      release();
    }
  };
}
