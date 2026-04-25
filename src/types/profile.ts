/**
 * Profile / Browser Pool shared types
 *
 * Used across:
 * - main (DuckDB services, IPC handlers, browser pool integration)
 * - preload (electronAPI typings)
 * - renderer (UI stores/components)
 * - js-plugin namespaces (type re-exports)
 *
 * Keep these types runtime-agnostic and stable.
 */

import type { AutomationEngine } from './automation-engine';

// ============================================
// Common
// ============================================

export type ProfileIPCResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

export type ProfileStatus = 'idle' | 'active' | 'error';

export type { AutomationEngine } from './automation-engine';
export {
  AUTOMATION_ENGINES,
  PERSISTENT_AUTOMATION_ENGINES,
  isAutomationEngine,
  isPersistentAutomationEngine,
  normalizeProfileBrowserQuota,
  normalizeAutomationEngine,
  PROFILE_BROWSER_INSTANCE_LIMIT,
} from './automation-engine';

// ============================================
// Fingerprint
// ============================================

export type OSType = 'windows' | 'macos' | 'linux';
export type BrowserType = 'chrome' | 'firefox' | 'edge';
export type BrowserIdentityOsFamily = OSType;
export type BrowserIdentityBrowserFamily = 'chromium' | 'firefox' | 'electron';
export type BrowserIdentityFontSystem = 'windows' | 'linux' | 'mac';
export type FingerprintFileFormat = 'txt';
export type FingerprintSourceMode = 'generated' | 'file';
export type RuyiPrimitive = string | number | boolean;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly (infer U)[]
    ? U[]
    : T[K] extends (infer U)[]
      ? U[]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

export interface BrowserIdentityProfile {
  region: {
    timezone: string;
    primaryLanguage: string;
    languages: string[];
  };
  hardware: {
    osFamily: BrowserIdentityOsFamily;
    browserFamily: BrowserIdentityBrowserFamily;
    browserVersion?: string;
    userAgent: string;
    platform: string;
    platformVersion?: string;
    hardwareConcurrency: number;
    deviceMemory?: number;
    fontSystem?: BrowserIdentityFontSystem;
  };
  display: {
    width: number;
    height: number;
    availWidth?: number;
    availHeight?: number;
    colorDepth?: number;
    pixelRatio?: number;
  };
  graphics?: {
    webgl?: {
      maskedVendor?: string;
      maskedRenderer?: string;
      version?: string;
      glslVersion?: string;
      unmaskedVendor?: string;
      unmaskedRenderer?: string;
      maxTextureSize?: number;
      maxCubeMapTextureSize?: number;
      maxTextureImageUnits?: number;
      maxVertexAttribs?: number;
      aliasedPointSizeMax?: number;
      maxViewportDim?: number;
      supportedExt?: string[];
      extensionParameters?: Record<string, RuyiPrimitive>;
      contextAttributes?: Record<string, RuyiPrimitive>;
    };
    canvasSeed?: number;
    webaudio?: number;
  };
  typography?: {
    fonts?: string[];
    textMetrics?: {
      monospacePreferences?: number;
      sansPreferences?: number;
      serifPreferences?: number;
    };
  };
  network?: {
    localWebrtcIpv4?: string;
    localWebrtcIpv6?: string;
    publicWebrtcIpv4?: string;
    publicWebrtcIpv6?: string;
    proxyAuth?: {
      username?: string;
      password?: string;
    };
  };
  speech?: {
    localNames?: string[];
    remoteNames?: string[];
    localLangs?: string[];
    remoteLangs?: string[];
    defaultName?: string;
    defaultLang?: string;
  };
  input?: {
    touchSupport?: boolean;
    maxTouchPoints?: number;
  };
  automationSignals?: {
    webdriver?: 0 | 1;
  };
}

export interface FingerprintSourceConfig {
  mode: FingerprintSourceMode;
  filePath?: string;
  fileFormat: FingerprintFileFormat;
}

export interface FingerprintConfig {
  identity: BrowserIdentityProfile;
  source: FingerprintSourceConfig;
}

export interface FingerprintCoreBrowserProfile {
  browser: BrowserType;
  version?: string;
  presetId?: string;
}

export interface FingerprintCoreConfig {
  osFamily: OSType;
  browserProfile: FingerprintCoreBrowserProfile;
  locale: {
    languages: string[];
    timezone: string;
  };
  hardware: {
    hardwareConcurrency: number;
    deviceMemory?: number;
  };
  display: {
    width: number;
    height: number;
    screenPresetId?: string;
  };
  graphics: {
    gpuProfileId?: string;
    maskedVendor?: string;
    maskedRenderer?: string;
  };
}

export interface FingerprintPreset {
  id: string;
  name: string;
  description: string;
  os: OSType;
  browser: BrowserType;
  config: FingerprintConfig;
}

// ============================================
// Proxy
// ============================================

export type ProxyType = 'none' | 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyConfig {
  type: ProxyType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  bypassList?: string;
}

// ============================================
// Extension Packages
// ============================================

export type ExtensionPackageMissingAction = 'warn' | 'error';
export type ExtensionPackagesMergeMode = 'inherit' | 'replace';

/**
 * 全局扩展包策略（应用级）
 */
export interface ExtensionPackagesGlobalConfig {
  /** 是否启用扩展校验策略 */
  enabled: boolean;
  /** 全局必需扩展 ID 列表 */
  requiredExtensionIds: string[];
  /** 缺失扩展时的处理策略 */
  onMissing: ExtensionPackageMissingAction;
}

/**
 * Profile 级扩展包覆盖（仅影响当前 Profile）
 */
export interface ProfileExtensionPackagesConfig {
  /**
   * inherit: 继承全局并追加 profile 的 requiredExtensionIds
   * replace: 只使用 profile 的 requiredExtensionIds
   */
  mode?: ExtensionPackagesMergeMode;
  /** Profile 追加/替换的必需扩展 ID */
  requiredExtensionIds?: string[];
  /** 从最终必需列表中排除的扩展 ID */
  excludeExtensionIds?: string[];
  /**
   * inherit: 跟随全局
   * warn/error: 覆盖全局缺失处理策略
   */
  onMissing?: 'inherit' | ExtensionPackageMissingAction;
}

/**
 * 启动时的有效策略（全局 + Profile 合并后）
 */
export interface EffectiveExtensionPackagesPolicy {
  enabled: boolean;
  mode: ExtensionPackagesMergeMode;
  requiredExtensionIds: string[];
  onMissing: ExtensionPackageMissingAction;
}

export type ExtensionPackageSourceType = 'local' | 'cloud';
export type ProfileExtensionInstallMode = 'required' | 'optional';

export interface ExtensionPackage {
  id: string;
  extensionId: string;
  name: string;
  version: string;
  sourceType: ExtensionPackageSourceType;
  sourceUrl?: string | null;
  archiveSha256?: string | null;
  manifest?: Record<string, unknown>;
  extractDir: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfileExtensionBinding {
  id: string;
  profileId: string;
  extensionId: string;
  version?: string | null;
  installMode: ProfileExtensionInstallMode;
  sortOrder: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExtensionPackagesMetaPackage {
  extensionId: string;
  name?: string;
  version?: string;
  downloadUrl?: string;
  archiveSha256?: string;
  archiveBase64?: string;
  enabled?: boolean;
  sortOrder?: number;
}

export interface ExtensionPackagesMeta {
  packages: ExtensionPackagesMetaPackage[];
  policy?: {
    onMissing?: ExtensionPackageMissingAction;
    installMode?: 'strict' | 'best_effort';
  };
}

// ============================================
// Profile & Groups
// ============================================

export interface BrowserProfile {
  id: string;
  name: string;
  engine: AutomationEngine;

  groupId: string | null;
  partition: string;

  proxy: ProxyConfig | null;
  fingerprint: FingerprintConfig;
  fingerprintCore?: FingerprintCoreConfig;
  fingerprintSource?: FingerprintSourceConfig;

  notes: string | null;
  tags: string[];
  color: string | null;

  status: ProfileStatus;
  lastError: string | null;
  lastActiveAt: Date | null;
  totalUses: number;

  quota: number; // Fixed to 1 in the single-instance runtime model.
  idleTimeoutMs: number;
  lockTimeoutMs: number;

  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;

  // ---- Optional legacy/extra fields (used by some older mocks/tools) ----
  description?: string | null;
  proxyId?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
}

export interface ProfileGroup {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  icon: string | null;
  description: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;

  // Tree/list helpers
  children?: ProfileGroup[];
  profileCount?: number;
}

export interface CreateProfileParams {
  name: string;
  engine?: AutomationEngine;
  groupId?: string | null;
  proxy?: ProxyConfig | null;
  fingerprint?: DeepPartial<FingerprintConfig>;
  fingerprintCore?: FingerprintCoreConfig;
  fingerprintSource?: Partial<FingerprintSourceConfig>;
  notes?: string | null;
  tags?: string[];
  color?: string | null;
  quota?: number; // Deprecated input; normalized to 1 when provided.
  idleTimeoutMs?: number;
  lockTimeoutMs?: number;
}

export interface UpdateProfileParams {
  name?: string;
  engine?: AutomationEngine;
  groupId?: string | null;
  proxy?: ProxyConfig | null;
  fingerprint?: DeepPartial<FingerprintConfig>;
  fingerprintCore?: DeepPartial<FingerprintCoreConfig>;
  fingerprintSource?: Partial<FingerprintSourceConfig>;
  notes?: string | null;
  tags?: string[];
  color?: string | null;
  quota?: number; // Deprecated input; normalized to 1 when provided.
  idleTimeoutMs?: number;
  lockTimeoutMs?: number;
}

export interface ProfileListParams {
  filter?: {
    groupId?: string | null;
    groupIds?: string[];
    status?: ProfileStatus;
    tags?: string[];
    keyword?: string;
  };
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'lastActiveAt' | 'totalUses';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CreateGroupParams {
  name: string;
  parentId?: string | null;
  color?: string | null;
  icon?: string | null;
  description?: string | null;
}

export interface UpdateGroupParams {
  name?: string;
  parentId?: string | null;
  color?: string | null;
  icon?: string | null;
  description?: string | null;
  sortOrder?: number;
}

// ============================================
// Account / Saved Sites / Tags
// ============================================

/**
 * 账号尚未绑定可用浏览器环境时使用的占位 Profile ID。
 * 说明：
 * - 该值不会被当作真实 Profile 读取。
 * - 登录流程会要求先为账号绑定浏览器环境。
 */
export const UNBOUND_PROFILE_ID = '__unbound__';

export interface SyncScopeFields {
  syncScopeType?: string | null;
  syncScopeId?: number | null;
  syncManaged?: boolean;
  syncUpdatedAt?: Date | null;
}

export type AccountSyncPermission = 'mine/edit' | 'shared/view_use';

export interface Account {
  id: string;
  profileId: string;
  /**
   * 平台 ID（对应 saved_sites.id）。
   * 运行时只使用该字段关联平台元信息。
   */
  platformId?: string;
  displayName?: string;
  name: string;
  shopId?: string | null;
  shopName?: string | null;
  hasPassword?: boolean;
  loginUrl: string;
  tags: string[];
  notes?: string;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  syncSourceId?: string | null;
  syncOwnerUserId?: number | null;
  syncOwnerUserName?: string | null;
  syncPermission?: AccountSyncPermission;
  syncScopeType?: string | null;
  syncScopeId?: number | null;
  syncManaged?: boolean;
  syncUpdatedAt?: Date | null;
}

export interface AccountWithSecret extends Account {
  password?: string;
}

export interface CreateAccountParams {
  profileId: string;
  platformId?: string | null;
  displayName?: string | null;
  name: string;
  shopId?: string | null;
  shopName?: string | null;
  password?: string | null;
  loginUrl: string;
  tags?: string[];
  notes?: string | null;
  syncSourceId?: string | null;
  syncOwnerUserId?: number | null;
  syncOwnerUserName?: string | null;
  syncPermission?: AccountSyncPermission | null;
  syncScopeType?: string | null;
  syncScopeId?: number | null;
  syncManaged?: boolean;
  syncUpdatedAt?: Date | null;
}

export interface CreateAccountWithAutoProfileParams {
  profile: CreateProfileParams;
  account: Omit<CreateAccountParams, 'profileId'>;
}

export interface UpdateAccountParams {
  profileId?: string;
  platformId?: string | null;
  displayName?: string | null;
  name?: string;
  shopId?: string | null;
  shopName?: string | null;
  password?: string | null;
  loginUrl?: string;
  tags?: string[];
  notes?: string | null;
  syncSourceId?: string | null;
  syncOwnerUserId?: number | null;
  syncOwnerUserName?: string | null;
  syncPermission?: AccountSyncPermission | null;
  syncScopeType?: string | null;
  syncScopeId?: number | null;
  syncManaged?: boolean;
  syncUpdatedAt?: Date | null;
}

export interface SavedSite {
  id: string;
  name: string;
  url: string;
  icon?: string;
  usageCount: number;
  createdAt: Date;
  syncSourceId?: string | null;
  syncCanonicalName?: string | null;
  syncOwnerUserId?: number | null;
  syncOwnerUserName?: string | null;
  syncScopeType?: string | null;
  syncScopeId?: number | null;
  syncManaged?: boolean;
  syncUpdatedAt?: Date | null;
}

export interface CreateSavedSiteParams {
  name: string;
  url: string;
  icon?: string | null;
  syncSourceId?: string | null;
  syncCanonicalName?: string | null;
  syncOwnerUserId?: number | null;
  syncOwnerUserName?: string | null;
  syncScopeType?: string | null;
  syncScopeId?: number | null;
  syncManaged?: boolean;
  syncUpdatedAt?: Date | null;
}

export interface UpdateSavedSiteParams {
  name?: string;
  url?: string;
  icon?: string | null;
  syncSourceId?: string | null;
  syncCanonicalName?: string | null;
  syncOwnerUserId?: number | null;
  syncOwnerUserName?: string | null;
  syncScopeType?: string | null;
  syncScopeId?: number | null;
  syncManaged?: boolean;
  syncUpdatedAt?: Date | null;
}

export interface Tag {
  id: string;
  name: string;
  color?: string;
  createdAt: Date;
  syncOwnerUserId?: number | null;
  syncOwnerUserName?: string | null;
  syncScopeType?: string | null;
  syncScopeId?: number | null;
  syncManaged?: boolean;
  syncUpdatedAt?: Date | null;
}

export interface CreateTagParams {
  name: string;
  color?: string | null;
  syncOwnerUserId?: number | null;
  syncOwnerUserName?: string | null;
  syncScopeType?: string | null;
  syncScopeId?: number | null;
  syncManaged?: boolean;
  syncUpdatedAt?: Date | null;
}

export interface UpdateTagParams {
  name?: string;
  color?: string | null;
  syncOwnerUserId?: number | null;
  syncOwnerUserName?: string | null;
  syncScopeType?: string | null;
  syncScopeId?: number | null;
  syncManaged?: boolean;
  syncUpdatedAt?: Date | null;
}

// ============================================
// Browser Pool (UI-facing)
// ============================================

export type PoolBrowserStatus = 'creating' | 'idle' | 'locked' | 'destroying';
export type AcquireSource = 'http' | 'mcp' | 'ipc' | 'internal' | 'plugin';

export interface PoolLockInfo {
  requestId: string;
  pluginId?: string;
  source: AcquireSource;
  timeoutMs: number;
}

export interface PoolBrowserInfo {
  id: string;
  sessionId: string;
  engine: AutomationEngine;
  status: PoolBrowserStatus;
  viewId?: string;

  createdAt: number;
  lastAccessedAt: number;
  useCount: number;
  idleTimeoutMs: number;

  lockedAt?: number;
  lockedBy?: PoolLockInfo;
}

// ============================================
// Misc / Legacy
// ============================================

/**
 * Legacy profile stats used by some older tests/mocks.
 * Not the same as `ProfileService.getStats()` output.
 */
export interface ProfileStats {
  total: number;
  active: number;
  byGroup: Record<string, number>;
  recentlyUsed: BrowserProfile[];
}
