import type { DoudianAdapterConfig, DoudianStoreSummary } from "../../types";
import { firstPathValue, getPathValue, type RequestPlanResult } from "./requestPlan";

type ShopFieldName = "id" | "name" | "operateStatus";

const DEFAULT_SHOP_FIELD_PATHS: Record<ShopFieldName, string[]> = {
  id: ["shopId", "shop_id", "mallId", "mall_id", "id", "shopInfo.shopId", "shopInfo.shop_id", "shopInfo.id"],
  name: ["shopName", "shop_name", "mallName", "mall_name", "name", "label", "title", "shopInfo.shopName", "shopInfo.shop_name"],
  operateStatus: ["operateStatus", "operate_status", "operateStatusStr", "operate_status_str", "statusText", "status_text"]
};

export interface CurrentShopMatchState {
  ok: boolean;
  currentShopId: string;
  currentShopName: string;
  confirmedStore?: Partial<DoudianStoreSummary>;
  reason?: string;
  message?: string;
}

export function text(value: unknown) {
  return String(value || "").trim();
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function policy(adapter: DoudianAdapterConfig, path: string, fallback: unknown = undefined): unknown {
  const value = getPathValue(adapter.policies || {}, path);
  return value === undefined ? fallback : value;
}

export function policyNumber(adapter: DoudianAdapterConfig, path: string, fallback: number) {
  const value = Number(policy(adapter, path, fallback));
  return Number.isFinite(value) ? value : fallback;
}

export function policyBool(adapter: DoudianAdapterConfig, path: string, fallback: boolean) {
  const value = policy(adapter, path);
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !["false", "0", "no"].includes(value.toLowerCase());
  return Boolean(value);
}

function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths.map((path) => text(path)).filter(Boolean)));
}

function fieldPaths(adapter: DoudianAdapterConfig | undefined, field: ShopFieldName) {
  return uniquePaths([
    ...(adapter?.responseMappings?.shopFields?.[field] || []),
    ...DEFAULT_SHOP_FIELD_PATHS[field]
  ]);
}

function firstTextByPaths(row: Record<string, unknown>, paths: string[]) {
  return text(firstPathValue(row, paths));
}

export function normalizeShopItem(item: unknown, adapter?: DoudianAdapterConfig): Partial<DoudianStoreSummary> | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const row = item as Record<string, unknown>;
  const shopId = firstTextByPaths(row, fieldPaths(adapter, "id"));
  const shopName = firstTextByPaths(row, fieldPaths(adapter, "name"));
  if (!shopId && !shopName) return null;
  return {
    shopId,
    shopName,
    operateStatus: firstTextByPaths(row, fieldPaths(adapter, "operateStatus")),
    shopInfoSummary: row as DoudianStoreSummary["shopInfoSummary"]
  };
}

export function currentShopFromResponse(response: RequestPlanResult, adapter: DoudianAdapterConfig): Partial<DoudianStoreSummary> | null {
  const currentObject = firstPathValue(response.data, adapter.responseMappings?.currentShopObjectPaths || []);
  const current = normalizeShopItem(currentObject, adapter);
  if (current) return current;
  const shopId = text(firstPathValue(response.data, adapter.responseMappings?.currentShopIdPaths || []));
  if (!shopId) return null;
  return {
    shopId,
    shopInfoSummary: { id: shopId }
  };
}

function policyBoolWithFallback(adapter: DoudianAdapterConfig, primaryPath: string, fallbackPath: string, fallback: boolean) {
  const value = policy(adapter, primaryPath);
  if (value !== undefined) return policyBool(adapter, primaryPath, fallback);
  return policyBool(adapter, fallbackPath, fallback);
}

export function currentShopState(
  response: RequestPlanResult,
  adapter: DoudianAdapterConfig,
  target: Pick<DoudianStoreSummary, "shopId" | "shopName">,
  policyRoot = "activateStore"
): CurrentShopMatchState {
  const confirmedStore = currentShopFromResponse(response, adapter);
  const currentShopId = text(confirmedStore?.shopId || confirmedStore?.shopInfoSummary?.id || firstPathValue(response.data, adapter.responseMappings?.currentShopIdPaths || []));
  const currentShopName = text(confirmedStore?.shopName || confirmedStore?.shopInfoSummary?.shop_name);
  const targetShopId = text(target.shopId);
  const targetShopName = text(target.shopName);
  const matchById = policyBoolWithFallback(adapter, `${policyRoot}.matchById`, "activateStore.matchById", true);
  const matchByName = policyBoolWithFallback(adapter, `${policyRoot}.matchByName`, "activateStore.matchByName", true);
  const idMatched = matchById && targetShopId && currentShopId === targetShopId;
  const nameMatched = matchByName && targetShopName && currentShopName === targetShopName;
  const detectedCurrent = Boolean(currentShopId || currentShopName);
  const ok = Boolean(idMatched || nameMatched);
  return {
    ok,
    currentShopId,
    currentShopName,
    confirmedStore: confirmedStore || undefined,
    reason: ok ? "" : detectedCurrent ? "shop-mismatch" : "current-shop-not-detected",
    message: ok
      ? "target shop active"
      : detectedCurrent
        ? `current shop ${currentShopName || currentShopId} does not match target ${targetShopName || targetShopId}`
        : "current shop not detected; local ledger preserved"
  };
}
