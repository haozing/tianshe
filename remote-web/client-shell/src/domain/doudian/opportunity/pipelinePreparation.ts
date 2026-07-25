export async function mapConcurrentOrdered<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { shouldStop?: () => boolean } = {}
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const slotCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: slotCount }, async () => {
    while (true) {
      if (options.shouldStop?.()) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results.filter((_, index) => Object.prototype.hasOwnProperty.call(results, index));
}

export interface CategoryDemandInput {
  tenantId: string;
  shopId: string;
  categoryKeys: string[];
  requestedPages: number;
  fullCoverage: boolean;
}

export interface CategoryDemand {
  requestedPages: number;
  fullCoverage: boolean;
  consumerShopIds: string[];
}

export function aggregateCategoryDemands(inputs: CategoryDemandInput[]) {
  const demands = new Map<string, CategoryDemand>();
  for (const input of inputs) {
    for (const categoryKey of Array.from(new Set(input.categoryKeys.filter(Boolean)))) {
      const demandKey = `${input.tenantId}::${categoryKey}`;
      const current = demands.get(demandKey);
      demands.set(demandKey, {
        requestedPages: Math.max(current?.requestedPages || 0, input.requestedPages),
        fullCoverage: current?.fullCoverage === true || input.fullCoverage,
        consumerShopIds: Array.from(new Set([...(current?.consumerShopIds || []), input.shopId]))
      });
    }
  }
  return demands;
}
