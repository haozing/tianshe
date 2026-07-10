import type { WorkspaceState } from "../types";

export const STORAGE_KEY_META = "chihu20_meta";
export const STORAGE_KEY_PREFERENCES = "chihu20_preferences";
export const STORAGE_KEY_CONFIG_CACHE = "chihu20_config_cache";
export const STORAGE_KEY_DIAGNOSTICS = "chihu20_diagnostics";
export const STORAGE_KEY_DOUDIAN_ADAPTER_LKG = "chihu20_doudian_adapter_lkg";
export const STORAGE_KEY_DOUDIAN_ADAPTER_STATUS = "chihu20_doudian_adapter_status";
export const STORAGE_KEY_BUSINESS_DATA_COLUMNS = "chihu20_business_data_columns";
export const STORAGE_KEY_FUNDS_DATA_COLUMNS = "chihu20_funds_data_columns";
export const STORAGE_KEY_VIOLATIONS_COLUMNS = "chihu20_violations_columns";
export const STORAGE_KEY_STALE_GOODS_COLUMNS = "chihu20_stale_goods_columns";
export const STORAGE_KEY_WORKSPACE = "chihu20_workspace";

export const STORAGE_KEYS = [
  STORAGE_KEY_META,
  STORAGE_KEY_PREFERENCES,
  STORAGE_KEY_CONFIG_CACHE,
  STORAGE_KEY_DIAGNOSTICS,
  STORAGE_KEY_DOUDIAN_ADAPTER_LKG,
  STORAGE_KEY_DOUDIAN_ADAPTER_STATUS,
  STORAGE_KEY_BUSINESS_DATA_COLUMNS,
  STORAGE_KEY_FUNDS_DATA_COLUMNS,
  STORAGE_KEY_VIOLATIONS_COLUMNS,
  STORAGE_KEY_STALE_GOODS_COLUMNS,
  STORAGE_KEY_WORKSPACE
] as const;

export const defaultWorkspace: WorkspaceState = {
  selectedStoreId: "all",
  operator: "hhhhh123",
  balance: "200.00",
  phone: "18906311658",
  points: "0.1"
};

export function isChihuStorageKey(key: string) {
  return key.startsWith("chihu20_") && /^chihu20_[a-z0-9_]+$/.test(key);
}

export function storageGet<T>(key: string, defaultValue: T): T {
  if (!isChihuStorageKey(key)) throw new Error("invalid storage key: " + key);
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function storageSet<T>(key: string, value: T) {
  if (!isChihuStorageKey(key)) throw new Error("invalid storage key: " + key);
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function initStorage() {
  const now = new Date().toISOString();
  const meta = storageGet<{ initializedAt?: string }>(STORAGE_KEY_META, {});
  storageSet(STORAGE_KEY_META, {
    schemaVersion: 1,
    initializedAt: meta.initializedAt || now,
    updatedAt: now,
    foundation: "client-shell"
  });
  storageSet(STORAGE_KEY_PREFERENCES, storageGet(STORAGE_KEY_PREFERENCES, {
    density: "comfortable",
    routeOpenMode: "same-window",
    navPlacement: "bottom"
  }));
  storageSet(STORAGE_KEY_DIAGNOSTICS, storageGet(STORAGE_KEY_DIAGNOSTICS, []));
  storageSet(STORAGE_KEY_DOUDIAN_ADAPTER_LKG, storageGet(STORAGE_KEY_DOUDIAN_ADAPTER_LKG, {
    schemaVersion: 1,
    savedAt: "",
    adapter: null,
    scriptsVersion: ""
  }));
  storageSet(STORAGE_KEY_DOUDIAN_ADAPTER_STATUS, storageGet(STORAGE_KEY_DOUDIAN_ADAPTER_STATUS, {
    ok: false,
    source: "none",
    adapterVersion: "",
    scriptsVersion: "",
    loadedAt: "",
    lastGoodAt: "",
    lastFailureReason: ""
  }));
  const workspace = storageGet(STORAGE_KEY_WORKSPACE, defaultWorkspace);
  storageSet(STORAGE_KEY_WORKSPACE, workspace);
  return workspace;
}

export function refreshStorageHealth() {
  return STORAGE_KEYS.every((key) => storageGet(key, null) !== null) ? "ok" : "missing";
}
