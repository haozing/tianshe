import type Store from 'electron-store';
import type {
  BrowserRuntimeStore,
  BrowserRuntimeStoreSnapshot,
  BrowserRuntimeStatus,
} from '../../core/browser-runtime';
import {
  BROWSER_RUNTIME_IDS,
  isBrowserRuntimeId,
  type BrowserRuntimeId,
  type BrowserRuntimeSource,
} from '../../types/browser-runtime';

const STORE_KEY = 'browserRuntime';

type StoredBrowserRuntimeConfig = Partial<BrowserRuntimeStoreSnapshot>;

function isRuntimeSource(value: unknown): value is BrowserRuntimeSource {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const source = value as Partial<BrowserRuntimeSource>;
  switch (source.type) {
    case 'bundled':
      return true;
    case 'managed-download':
      return typeof source.channel === 'string' && source.channel.trim().length > 0;
    case 'custom-path':
      return typeof source.executablePath === 'string' && source.executablePath.trim().length > 0;
    case 'system-detected':
      return typeof source.detectedPath === 'string' && source.detectedPath.trim().length > 0;
    default:
      return false;
  }
}

function cloneSource(source: BrowserRuntimeSource | null | undefined): BrowserRuntimeSource | null {
  return source ? ({ ...source } as BrowserRuntimeSource) : null;
}

function normalizeSnapshot(input: unknown): BrowserRuntimeStoreSnapshot {
  const raw = (input && typeof input === 'object' ? input : {}) as StoredBrowserRuntimeConfig;
  const sources: BrowserRuntimeStoreSnapshot['sources'] = {};
  const probes: BrowserRuntimeStoreSnapshot['probes'] = {};

  const rawSources =
    raw.sources && typeof raw.sources === 'object'
      ? (raw.sources as Record<string, unknown>)
      : {};
  for (const [runtimeId, source] of Object.entries(rawSources)) {
    if (!isBrowserRuntimeId(runtimeId)) continue;
    sources[runtimeId] = isRuntimeSource(source) ? cloneSource(source) : null;
  }

  const rawProbes =
    raw.probes && typeof raw.probes === 'object' ? (raw.probes as Record<string, unknown>) : {};
  for (const [runtimeId, probe] of Object.entries(rawProbes)) {
    if (!isBrowserRuntimeId(runtimeId) || !probe || typeof probe !== 'object') continue;
    const candidate = probe as BrowserRuntimeStoreSnapshot['probes'][BrowserRuntimeId];
    if (!candidate?.status || typeof candidate.at !== 'number') continue;
    probes[runtimeId] = candidate;
  }

  for (const runtimeId of BROWSER_RUNTIME_IDS) {
    if (!(runtimeId in sources)) {
      sources[runtimeId] = null;
    }
  }

  return { sources, probes };
}

export class ElectronStoreBrowserRuntimeStore implements BrowserRuntimeStore {
  constructor(private readonly store: Store) {}

  getSnapshot(): BrowserRuntimeStoreSnapshot {
    return normalizeSnapshot(this.store.get(STORE_KEY));
  }

  setSourceOverride(runtimeId: BrowserRuntimeId, source: BrowserRuntimeSource | null): void {
    const snapshot = this.getSnapshot();
    snapshot.sources[runtimeId] = cloneSource(source);
    this.store.set(STORE_KEY, snapshot);
  }

  setProbeStatus(runtimeId: BrowserRuntimeId, status: BrowserRuntimeStatus): void {
    const snapshot = this.getSnapshot();
    snapshot.probes[runtimeId] = {
      at: Date.now(),
      status: {
        runtimeId: status.runtimeId,
        source: cloneSource(status.source) ?? status.source,
        installed: status.installed,
        healthy: status.healthy,
        installState: status.installState,
        version: status.version,
        executablePath: status.executablePath,
        errors: [...status.errors],
        warnings: [...status.warnings],
        capabilities: status.capabilities ? { ...status.capabilities } : undefined,
      },
    };
    this.store.set(STORE_KEY, snapshot);
  }
}
