export const APP_SHELL_CONFIG_FILE_NAME = 'tianshe-shell.config.json';

export const APP_SHELL_CONTROLLED_PAGE_KEYS = [
  'datasets',
  'marketplace',
  'accountCenter',
  'settings',
] as const;

export type AppShellControlledPageKey = (typeof APP_SHELL_CONTROLLED_PAGE_KEYS)[number];
export type AppShellActiveView = AppShellControlledPageKey | 'workbench' | 'plugin';

export type AppShellPageVisibility = Record<AppShellControlledPageKey, boolean>;

export interface AppShellConfig {
  pages: AppShellPageVisibility;
  source?: string;
}

export const DEFAULT_APP_SHELL_CONFIG: AppShellConfig = {
  pages: {
    datasets: true,
    marketplace: true,
    accountCenter: true,
    settings: true,
  },
};

const PAGE_KEY_ALIASES: Record<string, AppShellControlledPageKey | undefined> = {
  datasets: 'datasets',
  data: 'datasets',
  tables: 'datasets',
  marketplace: 'marketplace',
  pluginMarket: 'marketplace',
  plugin_market: 'marketplace',
  plugins: 'marketplace',
  accountCenter: 'accountCenter',
  account_center: 'accountCenter',
  accounts: 'accountCenter',
  settings: 'settings',
};

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'show', 'visible', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'hide', 'hidden', 'disabled'].includes(normalized)) {
    return false;
  }
  return null;
}

function normalizePageKey(value: unknown): AppShellControlledPageKey | null {
  if (typeof value !== 'string') return null;
  return PAGE_KEY_ALIASES[value.trim()] ?? null;
}

function applyPageVisibility(
  pages: AppShellPageVisibility,
  rawPages: unknown
): AppShellPageVisibility {
  if (!rawPages || typeof rawPages !== 'object' || Array.isArray(rawPages)) {
    return pages;
  }

  for (const [rawKey, rawValue] of Object.entries(rawPages)) {
    const pageKey = normalizePageKey(rawKey);
    const visible = toBoolean(rawValue);
    if (!pageKey || visible === null) {
      continue;
    }
    pages[pageKey] = visible;
  }

  return pages;
}

function applyHiddenPages(
  pages: AppShellPageVisibility,
  hiddenPages: unknown
): AppShellPageVisibility {
  if (!Array.isArray(hiddenPages)) {
    return pages;
  }

  for (const item of hiddenPages) {
    const pageKey = normalizePageKey(item);
    if (pageKey) {
      pages[pageKey] = false;
    }
  }

  return pages;
}

export function normalizeAppShellConfig(rawConfig: unknown): AppShellConfig {
  const pages: AppShellPageVisibility = { ...DEFAULT_APP_SHELL_CONFIG.pages };
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return { pages };
  }

  const raw = rawConfig as Record<string, unknown>;
  applyPageVisibility(pages, raw.pages);
  applyPageVisibility(pages, raw.pageVisibility);
  applyHiddenPages(pages, raw.hiddenPages);

  return { pages };
}

export function areControlledAppShellPagesHidden(config: AppShellConfig): boolean {
  return APP_SHELL_CONTROLLED_PAGE_KEYS.every((key) => config.pages[key] === false);
}

export function isAppShellViewVisible(
  view: AppShellActiveView,
  config: AppShellConfig,
  options?: { workbenchAvailable?: boolean }
): boolean {
  if (view === 'plugin') return true;
  if (view === 'workbench') return options?.workbenchAvailable === true;
  return config.pages[view] !== false;
}

export function resolveAppShellActiveView(
  view: AppShellActiveView,
  config: AppShellConfig,
  options?: { workbenchAvailable?: boolean }
): AppShellActiveView {
  if (view === 'plugin') {
    return 'plugin';
  }

  if (areControlledAppShellPagesHidden(config)) {
    return 'plugin';
  }

  if (isAppShellViewVisible(view, config, options)) {
    return view;
  }

  const fallbackOrder: AppShellActiveView[] = [
    'workbench',
    'datasets',
    'marketplace',
    'accountCenter',
    'settings',
  ];
  return (
    fallbackOrder.find((candidate) => isAppShellViewVisible(candidate, config, options)) ??
    'plugin'
  );
}
