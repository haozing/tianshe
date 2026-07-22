export interface MarketingEntityListItem {
  shopId: string;
  shopName?: string;
  entityId: string;
}

export interface MarketingStoreListItem {
  id: string;
  name: string;
}

export function buildMarketingEntityShopOptions(
  entities: readonly MarketingEntityListItem[],
  stores: readonly MarketingStoreListItem[]
) {
  const counts = new Map<string, { name: string; count: number }>();
  stores.forEach((store) => counts.set(store.id, { name: store.name, count: 0 }));
  for (const entity of entities) {
    const current = counts.get(entity.shopId) || { name: entity.shopName || entity.shopId, count: 0 };
    current.count += 1;
    if (entity.shopName) current.name = entity.shopName;
    counts.set(entity.shopId, current);
  }
  return [...counts.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

export function marketingEntityKeys(entities: readonly MarketingEntityListItem[]) {
  return entities.map((entity) => `${entity.shopId}:${entity.entityId}`);
}

export function toggleMarketingEntitySelection(current: ReadonlySet<string>, visibleKeys: readonly string[]) {
  const next = new Set(current);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((key) => current.has(key));
  if (allVisibleSelected) visibleKeys.forEach((key) => next.delete(key));
  else visibleKeys.forEach((key) => next.add(key));
  return next;
}
