interface StoreIdentity {
  shopId: string;
  shopName: string;
  shopInfoSummary?: Record<string, unknown>;
}

interface ConfirmedStoreIdentity {
  currentShopId?: string;
  currentShopName?: string;
}

interface StoreIdentityInput {
  shopId?: unknown;
  shopName?: unknown;
}

function normalizedText(value: unknown) {
  return String(value || "").trim();
}

export function confirmedStoreIdentityPatch(store: StoreIdentity, confirmed: ConfirmedStoreIdentity) {
  const shopId = normalizedText(store.shopId);
  const currentShopId = normalizedText(confirmed.currentShopId);
  const currentShopName = normalizedText(confirmed.currentShopName);
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

export function partitionToken(value: string) {
  const input = normalizedText(value);
  const readable = input
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "value";
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${readable}_${hash.toString(16).padStart(16, "0")}`;
}

export function candidateKey(store: StoreIdentityInput) {
  const shopId = normalizedText(store.shopId);
  if (shopId) return shopId;
  const shopName = normalizedText(store.shopName);
  return shopName ? `pending:${partitionToken(shopName)}` : "";
}
