import type { MarketingTaskStore } from "./types";

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function marketingStoreContext(context: Record<string, unknown>, store: MarketingTaskStore, operationId: string, action: string) {
  const byShop = recordValue(context.productIdsByShop);
  const overrides = recordValue(context.storeOverrides);
  const override = recordValue(overrides[store.shopId]);
  const selected = byShop[store.shopId];
  const hasProductIdsByShop = context.productIdsByShop !== undefined;
  const productIds = Array.isArray(selected)
    ? selected.map(String).filter(Boolean)
    : action === "remove_products" && Array.isArray(context.productIds)
      ? context.productIds.map(String).filter(Boolean)
      : hasProductIdsByShop
        ? []
        : undefined;
  const entityByShop = recordValue(context.entityIdsByShop);
  const selectedEntityIds = entityByShop[store.shopId];
  const entityIds = Array.isArray(selectedEntityIds) ? selectedEntityIds.map(String).filter(Boolean) : undefined;
  const productsByShop = recordValue(context.selectedProductsByShop);
  const hasSelectedProductsByShop = context.selectedProductsByShop !== undefined;
  const selectedProducts = Array.isArray(productsByShop[store.shopId]) ? productsByShop[store.shopId] : hasSelectedProductsByShop ? [] : undefined;
  const entitiesByShop = recordValue(context.selectedEntitiesByShop);
  const selectedEntities = Array.isArray(entitiesByShop[store.shopId]) ? entitiesByShop[store.shopId] : undefined;
  const priceTiers = override.discountValue !== undefined && Array.isArray(context.priceTiers)
    ? context.priceTiers.map((tier) => ({ ...recordValue(tier), value: override.discountValue }))
    : context.priceTiers;
  return {
    ...context,
    ...override,
    ...(productIds !== undefined ? { productIds } : {}),
    ...(entityIds ? { entityIds } : {}),
    ...(selectedProducts !== undefined ? { selectedProducts } : {}),
    ...(selectedEntities !== undefined ? { selectedEntities } : {}),
    ...(priceTiers !== undefined ? { priceTiers } : {}),
    shopId: store.shopId,
    operationId
  };
}
