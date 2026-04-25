import Store from 'electron-store';
import type { WebContents } from 'electron';
import { AIRPA_RUNTIME_CONFIG, isDevelopmentMode } from '../constants/runtime-config';
import type { InternalBrowserDevToolsConfig } from '../types/internal-browser';

type InternalBrowserDevToolsStore = {
  internalBrowserDevTools?: Partial<InternalBrowserDevToolsConfig>;
};

type DevToolsOptions = Parameters<WebContents['openDevTools']>[0];
type DevToolsMode = NonNullable<DevToolsOptions>['mode'];

type DevToolsTarget = Pick<WebContents, 'isDestroyed' | 'openDevTools'> &
  Partial<Pick<WebContents, 'isDevToolsOpened'>>;

const store = new Store<InternalBrowserDevToolsStore>({
  name: 'internal-browser-devtools',
});

export const DEFAULT_INTERNAL_BROWSER_DEVTOOLS_CONFIG: InternalBrowserDevToolsConfig = {
  autoOpenDevTools: isDevelopmentMode() || AIRPA_RUNTIME_CONFIG.webview.debugDevtools,
};

export function normalizeInternalBrowserDevToolsConfig(
  value?: Partial<InternalBrowserDevToolsConfig> | null
): InternalBrowserDevToolsConfig {
  return {
    autoOpenDevTools:
      typeof value?.autoOpenDevTools === 'boolean'
        ? value.autoOpenDevTools
        : DEFAULT_INTERNAL_BROWSER_DEVTOOLS_CONFIG.autoOpenDevTools,
  };
}

export function getInternalBrowserDevToolsConfig(): InternalBrowserDevToolsConfig {
  return normalizeInternalBrowserDevToolsConfig(store.get('internalBrowserDevTools'));
}

export function setInternalBrowserDevToolsConfig(
  value: Partial<InternalBrowserDevToolsConfig>
): InternalBrowserDevToolsConfig {
  const current = getInternalBrowserDevToolsConfig();
  const next = normalizeInternalBrowserDevToolsConfig({
    ...current,
    ...value,
  });
  store.set('internalBrowserDevTools', next);
  return next;
}

export function shouldAutoOpenInternalBrowserDevTools(override?: boolean): boolean {
  if (typeof override === 'boolean') {
    return override;
  }
  return getInternalBrowserDevToolsConfig().autoOpenDevTools;
}

export function maybeOpenInternalBrowserDevTools(
  target: DevToolsTarget | null | undefined,
  options?: {
    override?: boolean;
    mode?: DevToolsMode;
  }
): boolean {
  if (!target || target.isDestroyed()) {
    return false;
  }

  if (!shouldAutoOpenInternalBrowserDevTools(options?.override)) {
    return false;
  }

  if (typeof target.isDevToolsOpened === 'function' && target.isDevToolsOpened()) {
    return true;
  }

  try {
    if (options?.mode) {
      target.openDevTools({ mode: options.mode });
    } else {
      target.openDevTools();
    }
    return true;
  } catch (error) {
    console.warn('[InternalBrowserDevTools] Failed to open DevTools:', error);
    return false;
  }
}
