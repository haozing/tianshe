import type { DoudianStoreIdentityRef, DoudianStoreSummary } from "../../types";

const DEFAULT_TENANT_ID = "local-user";

export function storeIdentityRef(store: { tenantId?: string; shopId: string; storeGeneration?: number }): DoudianStoreIdentityRef {
  return {
    tenantId: String(store.tenantId || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID,
    shopId: String(store.shopId || "").trim(),
    storeGeneration: Math.max(1, Math.trunc(Number(store.storeGeneration || 1)))
  };
}

export function storeIdentityKey(store: { tenantId?: string; shopId: string; storeGeneration?: number }) {
  const ref = storeIdentityRef(store);
  return `${ref.tenantId}::${ref.shopId}::${ref.storeGeneration}`;
}

export function activeStoreSelection(
  stores: DoudianStoreSummary[],
  selectedShopIds: Iterable<string>
) {
  const selected = new Set(Array.from(selectedShopIds, (shopId) => String(shopId || "").trim()).filter(Boolean));
  return stores.filter((store) => selected.has(store.shopId));
}

export function reconcileSelectedShopIds(
  stores: DoudianStoreSummary[],
  selectedShopIds: Iterable<string>,
  options: { selectAllWhenEmpty?: boolean } = {}
) {
  const activeIds = new Set(stores.map((store) => store.shopId));
  const next = new Set(Array.from(selectedShopIds).filter((shopId) => activeIds.has(shopId)));
  if (!next.size && options.selectAllWhenEmpty) return activeIds;
  return next;
}

export function restoredActiveShopIds(
  stores: DoudianStoreSummary[],
  restoredRefs: DoudianStoreIdentityRef[] = []
) {
  const restoredKeys = new Set(restoredRefs.map(storeIdentityKey));
  return new Set(stores.filter((store) => restoredKeys.has(storeIdentityKey(storeIdentityRef(store)))).map((store) => store.shopId));
}

export function activeStoreRefs(stores: DoudianStoreSummary[], selectedShopIds?: Iterable<string>) {
  const selectedStores = selectedShopIds ? activeStoreSelection(stores, selectedShopIds) : stores;
  return selectedStores.map(storeIdentityRef);
}
