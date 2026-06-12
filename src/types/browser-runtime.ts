export const BROWSER_RUNTIME_IDS = [
  'electron-webcontents',
  'chromium-extension-relay',
  'firefox-bidi',
  'chromium-cloak-playwright',
] as const;

export type BrowserRuntimeId = (typeof BROWSER_RUNTIME_IDS)[number];

export const DEFAULT_BROWSER_RUNTIME_ID: BrowserRuntimeId = 'electron-webcontents';

export const PERSISTENT_BROWSER_RUNTIME_IDS = [
  'chromium-extension-relay',
  'firefox-bidi',
  'chromium-cloak-playwright',
] as const satisfies readonly BrowserRuntimeId[];

export const LEGACY_BROWSER_RUNTIME_ALIASES = {
  electron: 'electron-webcontents',
  extension: 'chromium-extension-relay',
  ruyi: 'firefox-bidi',
} as const satisfies Record<string, BrowserRuntimeId>;

export const PROFILE_BROWSER_INSTANCE_LIMIT = 1;

export type BrowserFamily = 'electron' | 'chromium' | 'firefox';

export type BrowserControlProtocol =
  | 'webcontents'
  | 'extension-relay'
  | 'playwright'
  | 'bidi'
  | 'cdp';

export type BrowserProfileMode = 'ephemeral' | 'persistent';

export type BrowserVisibilityMode =
  | 'embedded-view'
  | 'external-window'
  | 'direct-window'
  | 'headless';

export type BrowserFingerprintBackend =
  | 'electron-stealth'
  | 'chromium-ruyi-file'
  | 'firefox-fpfile'
  | 'cloak-flags'
  | 'none';

export type BrowserBrand =
  | 'electron'
  | 'chrome'
  | 'chromium'
  | 'edge'
  | 'brave'
  | 'firefox'
  | 'cloak';

export type BrowserRuntimeSource =
  | { type: 'bundled' }
  | { type: 'managed-download'; channel: string; version?: string }
  | { type: 'custom-path'; executablePath: string }
  | { type: 'system-detected'; detectedPath: string };

const BROWSER_RUNTIME_ID_SET = new Set<string>(BROWSER_RUNTIME_IDS);
const PERSISTENT_BROWSER_RUNTIME_ID_SET = new Set<string>(PERSISTENT_BROWSER_RUNTIME_IDS);

export function isBrowserRuntimeId(value: unknown): value is BrowserRuntimeId {
  return typeof value === 'string' && BROWSER_RUNTIME_ID_SET.has(value);
}

export function normalizeBrowserRuntimeId(
  value: unknown,
  fallback: BrowserRuntimeId = DEFAULT_BROWSER_RUNTIME_ID
): BrowserRuntimeId {
  if (isBrowserRuntimeId(value)) return value;
  if (typeof value === 'string') {
    const alias = (LEGACY_BROWSER_RUNTIME_ALIASES as Record<string, BrowserRuntimeId>)[
      value.trim().toLowerCase()
    ];
    if (alias) return alias;
  }
  return fallback;
}

export function isPersistentBrowserRuntimeId(
  runtimeId: BrowserRuntimeId | null | undefined
): runtimeId is (typeof PERSISTENT_BROWSER_RUNTIME_IDS)[number] {
  return typeof runtimeId === 'string' && PERSISTENT_BROWSER_RUNTIME_ID_SET.has(runtimeId);
}

export function normalizeProfileBrowserQuota(
  requestedQuota: number
): {
  quota: number;
  forced: boolean;
  reason: 'single-profile-browser-instance' | null;
} {
  return {
    quota: PROFILE_BROWSER_INSTANCE_LIMIT,
    forced: requestedQuota !== PROFILE_BROWSER_INSTANCE_LIMIT,
    reason:
      requestedQuota !== PROFILE_BROWSER_INSTANCE_LIMIT
        ? 'single-profile-browser-instance'
        : null,
  };
}

export function getBrowserFamilyForRuntime(runtimeId: BrowserRuntimeId): BrowserFamily {
  switch (runtimeId) {
    case 'firefox-bidi':
      return 'firefox';
    case 'electron-webcontents':
      return 'electron';
    case 'chromium-extension-relay':
    case 'chromium-cloak-playwright':
      return 'chromium';
  }
}

export function getDefaultRuntimeSource(runtimeId: BrowserRuntimeId): BrowserRuntimeSource {
  switch (runtimeId) {
    case 'electron-webcontents':
    case 'chromium-extension-relay':
      return { type: 'bundled' };
    case 'firefox-bidi':
      return { type: 'managed-download', channel: 'firefox' };
    case 'chromium-cloak-playwright':
      return { type: 'managed-download', channel: 'cloakbrowser' };
  }
}
