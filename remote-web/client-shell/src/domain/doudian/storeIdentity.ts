interface StoreIdentity {
  shopId: string;
  shopName: string;
  shopInfoSummary?: Record<string, unknown>;
}

interface ConfirmedStoreIdentity {
  currentShopId?: string;
  currentShopName?: string;
}

export function confirmedStoreIdentityPatch(store: StoreIdentity, confirmed: ConfirmedStoreIdentity) {
  const shopId = String(store.shopId || "").trim();
  const currentShopId = String(confirmed.currentShopId || "").trim();
  const currentShopName = String(confirmed.currentShopName || "").trim();
  if (!shopId || currentShopId !== shopId || !currentShopName || currentShopName === store.shopName) return {};
  return {
    shopName: currentShopName,
    shopInfoSummary: {
      ...(store.shopInfoSummary || {}),
      id: shopId,
      shop_name: currentShopName
    }
  };
}
