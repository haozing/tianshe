import type { WorkspaceState } from "../types";

export const STORAGE_KEY_META = "chihu20_meta";
export const STORAGE_KEY_PREFERENCES = "chihu20_preferences";
export const STORAGE_KEY_CONFIG_CACHE = "chihu20_config_cache";
export const STORAGE_KEY_DIAGNOSTICS = "chihu20_diagnostics";
export const STORAGE_KEY_DOUDIAN_ADAPTER_LKG = "chihu20_doudian_adapter_lkg";
export const STORAGE_KEY_DOUDIAN_ADAPTER_STATUS = "chihu20_doudian_adapter_status";
export const STORAGE_KEY_BUSINESS_DATA_COLUMNS = "chihu20_business_data_columns";
export const STORAGE_KEY_BUSINESS_DATA_COLUMN_ORDER = "chihu20_business_data_column_order";
export const STORAGE_KEY_BUSINESS_DATA_COLUMN_WIDTHS = "chihu20_business_data_column_widths";
export const STORAGE_KEY_FUNDS_DATA_COLUMNS = "chihu20_funds_data_columns";
export const STORAGE_KEY_FUNDS_DATA_COLUMN_ORDER = "chihu20_funds_data_column_order";
export const STORAGE_KEY_FUNDS_DATA_COLUMN_WIDTHS = "chihu20_funds_data_column_widths";
export const STORAGE_KEY_VIOLATIONS_COLUMNS = "chihu20_violations_columns";
export const STORAGE_KEY_STALE_GOODS_COLUMNS = "chihu20_stale_goods_columns";
export const STORAGE_KEY_RELEASE_REDIRECTS = "chihu20_release_redirects";
export const STORAGE_KEY_WORKSPACE = "chihu20_workspace";

export const STORAGE_KEYS = [
  STORAGE_KEY_META,
  STORAGE_KEY_PREFERENCES,
  STORAGE_KEY_CONFIG_CACHE,
  STORAGE_KEY_DIAGNOSTICS,
  STORAGE_KEY_DOUDIAN_ADAPTER_LKG,
  STORAGE_KEY_DOUDIAN_ADAPTER_STATUS,
  STORAGE_KEY_BUSINESS_DATA_COLUMNS,
  STORAGE_KEY_BUSINESS_DATA_COLUMN_ORDER,
  STORAGE_KEY_BUSINESS_DATA_COLUMN_WIDTHS,
  STORAGE_KEY_FUNDS_DATA_COLUMNS,
  STORAGE_KEY_FUNDS_DATA_COLUMN_ORDER,
  STORAGE_KEY_FUNDS_DATA_COLUMN_WIDTHS,
  STORAGE_KEY_VIOLATIONS_COLUMNS,
  STORAGE_KEY_STALE_GOODS_COLUMNS,
  STORAGE_KEY_RELEASE_REDIRECTS,
  STORAGE_KEY_WORKSPACE
] as const;

export const STORAGE_HEALTH_KEYS = [
  STORAGE_KEY_META,
  STORAGE_KEY_PREFERENCES,
  STORAGE_KEY_CONFIG_CACHE,
  STORAGE_KEY_DIAGNOSTICS,
  STORAGE_KEY_DOUDIAN_ADAPTER_LKG,
  STORAGE_KEY_DOUDIAN_ADAPTER_STATUS,
  STORAGE_KEY_WORKSPACE
] as const;

export const defaultWorkspace: WorkspaceState = {
  selectedStoreId: "all",
  operator: "hhhhh123",
  balance: "200.00",
  phone: "18906311658",
  points: "0.1"
};

export type ReleaseChannel = "stable" | "beta";

export interface ChihuPreferences {
  density: "comfortable" | "compact";
  routeOpenMode: "same-window" | "new-window";
  navPlacement: "bottom" | "top";
  releaseChannel: ReleaseChannel;
  betaInviteVerifiedAt: string;
  betaInviteCodeHint: string;
  autoOperationLog: boolean;
}

export const PREFERENCES_CHANGED_EVENT = "chihu:preferences-changed";

export const defaultPreferences: ChihuPreferences = {
  density: "comfortable",
  routeOpenMode: "same-window",
  navPlacement: "bottom",
  releaseChannel: "stable",
  betaInviteVerifiedAt: "",
  betaInviteCodeHint: "",
  autoOperationLog: false
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

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function preferenceString<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

export function normalizePreferences(value: unknown): ChihuPreferences {
  const record = objectRecord(value);
  return {
    density: preferenceString(record.density, ["comfortable", "compact"], defaultPreferences.density),
    routeOpenMode: preferenceString(record.routeOpenMode, ["same-window", "new-window"], defaultPreferences.routeOpenMode),
    navPlacement: preferenceString(record.navPlacement, ["bottom", "top"], defaultPreferences.navPlacement),
    releaseChannel: preferenceString(record.releaseChannel, ["stable", "beta"], defaultPreferences.releaseChannel),
    betaInviteVerifiedAt: typeof record.betaInviteVerifiedAt === "string" ? record.betaInviteVerifiedAt : "",
    betaInviteCodeHint: typeof record.betaInviteCodeHint === "string" ? record.betaInviteCodeHint : "",
    autoOperationLog: record.autoOperationLog === true
  };
}

export function getPreferences(): ChihuPreferences {
  return normalizePreferences(storageGet(STORAGE_KEY_PREFERENCES, defaultPreferences));
}

export function savePreferences(patch: Partial<ChihuPreferences>): ChihuPreferences {
  const next = normalizePreferences({
    ...getPreferences(),
    ...patch
  });
  storageSet(STORAGE_KEY_PREFERENCES, next);
  window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGED_EVENT, { detail: next }));
  return next;
}

export function addPreferencesListener(listener: (preferences: ChihuPreferences) => void) {
  const onChange = (event: Event) => {
    listener(normalizePreferences((event as CustomEvent<ChihuPreferences>).detail));
  };
  window.addEventListener(PREFERENCES_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, onChange);
}

export function releaseChannelLabel(channel: ReleaseChannel) {
  return channel === "beta" ? "内测功能版本" : "正式功能版本";
}

export function releaseChannelToUpdateChannel(channel: ReleaseChannel) {
  return channel === "beta" ? "beta" : "latest";
}

const RELEASE_REDIRECT_TTL_MS = 5 * 60 * 1000;

function activeReleaseRedirects(now = Date.now()) {
  const redirects = objectRecord(storageGet<unknown>(STORAGE_KEY_RELEASE_REDIRECTS, {}));
  return Object.fromEntries(Object.entries(redirects).filter(([, timestamp]) => (
    typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 && now - timestamp < RELEASE_REDIRECT_TTL_MS
  )));
}

function releaseRedirectId(channel: ReleaseChannel, targetUrl: string) {
  return `${channel}:${targetUrl}`;
}

export function hasRecentReleaseRedirect(channel: ReleaseChannel, targetUrl: string) {
  return releaseRedirectId(channel, targetUrl) in activeReleaseRedirects();
}

export function markReleaseRedirect(channel: ReleaseChannel, targetUrl: string) {
  const now = Date.now();
  storageSet(STORAGE_KEY_RELEASE_REDIRECTS, {
    ...activeReleaseRedirects(now),
    [releaseRedirectId(channel, targetUrl)]: now
  });
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
  storageSet(STORAGE_KEY_PREFERENCES, getPreferences());
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
  return STORAGE_HEALTH_KEYS.every((key) => storageGet(key, null) !== null) ? "ok" : "missing";
}
