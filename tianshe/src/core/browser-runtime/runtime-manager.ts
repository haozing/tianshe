import fs from 'node:fs';
import type { BrowserRuntimeDescriptor } from '../../types/browser-interface';
import type { BrowserRuntimeId, BrowserRuntimeSource } from '../../types/browser-runtime';
import { getDefaultRuntimeSource } from '../../types/browser-runtime';
import type {
  BrowserRuntimeProbeResult,
  BrowserRuntimeProvider,
  ResolvedBrowserRuntime,
} from './types';
import { BrowserRuntimeRegistry } from './provider-registry';

export type BrowserRuntimeInstallState =
  | 'bundled'
  | 'custom-path'
  | 'managed-installed'
  | 'missing'
  | 'unknown';

export interface BrowserRuntimeStatus {
  runtimeId: BrowserRuntimeId;
  descriptor: BrowserRuntimeDescriptor;
  source: BrowserRuntimeSource;
  configuredSourceOverride: BrowserRuntimeSource | null;
  lastProbeAt?: number;
  resolvedRuntime: ResolvedBrowserRuntime | null;
  installed: boolean;
  healthy: boolean;
  installState: BrowserRuntimeInstallState;
  version?: string | null;
  executablePath?: string;
  errors: string[];
  warnings: string[];
  capabilities?: BrowserRuntimeProbeResult['capabilities'];
}

export interface BrowserRuntimeStoreSnapshot {
  sources: Partial<Record<BrowserRuntimeId, BrowserRuntimeSource | null>>;
  probes: Partial<
    Record<
      BrowserRuntimeId,
      {
        at: number;
        status: Pick<
          BrowserRuntimeStatus,
          | 'runtimeId'
          | 'source'
          | 'installed'
          | 'healthy'
          | 'installState'
          | 'version'
          | 'executablePath'
          | 'errors'
          | 'warnings'
          | 'capabilities'
        >;
      }
    >
  >;
}

export interface BrowserRuntimeStore {
  getSnapshot(): BrowserRuntimeStoreSnapshot;
  setSourceOverride(runtimeId: BrowserRuntimeId, source: BrowserRuntimeSource | null): void;
  setProbeStatus(runtimeId: BrowserRuntimeId, status: BrowserRuntimeStatus): void;
}

export class InMemoryBrowserRuntimeStore implements BrowserRuntimeStore {
  private snapshot: BrowserRuntimeStoreSnapshot = {
    sources: {},
    probes: {},
  };

  getSnapshot(): BrowserRuntimeStoreSnapshot {
    return {
      sources: { ...this.snapshot.sources },
      probes: { ...this.snapshot.probes },
    };
  }

  setSourceOverride(runtimeId: BrowserRuntimeId, source: BrowserRuntimeSource | null): void {
    this.snapshot.sources = {
      ...this.snapshot.sources,
      [runtimeId]: source,
    };
  }

  setProbeStatus(runtimeId: BrowserRuntimeId, status: BrowserRuntimeStatus): void {
    this.snapshot.probes = {
      ...this.snapshot.probes,
      [runtimeId]: {
        at: Date.now(),
        status: {
          runtimeId: status.runtimeId,
          source: status.source,
          installed: status.installed,
          healthy: status.healthy,
          installState: status.installState,
          version: status.version,
          executablePath: status.executablePath,
          errors: [...status.errors],
          warnings: [...status.warnings],
          capabilities: status.capabilities ? { ...status.capabilities } : undefined,
        },
      },
    };
  }
}

function sourceInstallState(
  source: BrowserRuntimeSource,
  probe: BrowserRuntimeProbeResult | null
): BrowserRuntimeInstallState {
  const installed = probe?.installed ?? probe?.healthy;
  if (source.type === 'bundled') return installed === false ? 'missing' : 'bundled';
  if (source.type === 'custom-path') return installed === false ? 'missing' : 'custom-path';
  if (source.type === 'system-detected') {
    return installed === false ? 'missing' : 'managed-installed';
  }
  if (source.type === 'managed-download') {
    return installed ? 'managed-installed' : 'missing';
  }
  return 'unknown';
}

function sourcePathExists(source: BrowserRuntimeSource): boolean | null {
  const path =
    source.type === 'custom-path'
      ? source.executablePath
      : source.type === 'system-detected'
        ? source.detectedPath
        : null;
  if (!path) return null;
  try {
    return fs.existsSync(path) && fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

function inferInstalled(
  source: BrowserRuntimeSource,
  resolvedRuntime: ResolvedBrowserRuntime | null,
  probe: BrowserRuntimeProbeResult
): boolean {
  if (typeof probe.installed === 'boolean') {
    return probe.installed;
  }
  const executablePath = probe.executablePath ?? resolvedRuntime?.executablePath;
  if (executablePath) {
    try {
      return fs.existsSync(executablePath) && fs.statSync(executablePath).isFile();
    } catch {
      return false;
    }
  }
  if (source.type === 'bundled') {
    return probe.healthy;
  }
  return probe.healthy;
}

async function resolveAndProbe(
  provider: BrowserRuntimeProvider,
  sourceOverride?: BrowserRuntimeSource | null
): Promise<{
  resolvedRuntime: ResolvedBrowserRuntime | null;
  probe: BrowserRuntimeProbeResult;
  source: BrowserRuntimeSource;
}> {
  const source = sourceOverride ?? getDefaultRuntimeSource(provider.id);
  const explicitPathExists = sourcePathExists(source);
  if (explicitPathExists === false) {
    return {
      resolvedRuntime: null,
      source,
      probe: {
        healthy: false,
        errors: [`Runtime executable path does not exist or is not a file.`],
        warnings: [],
        executablePath:
          source.type === 'custom-path'
            ? source.executablePath
            : source.type === 'system-detected'
              ? source.detectedPath
              : undefined,
      },
    };
  }

  try {
    const resolvedRuntime = await provider.resolveRuntime({
      runtimeId: provider.id,
      sourceOverride: sourceOverride ?? null,
    });
    const probe = await provider.probeRuntime(resolvedRuntime);
    return {
      resolvedRuntime,
      source: resolvedRuntime.source,
      probe,
    };
  } catch (error) {
    return {
      resolvedRuntime: null,
      source,
      probe: {
        healthy: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
      },
    };
  }
}

export class BrowserRuntimeManager {
  constructor(
    private readonly registry: BrowserRuntimeRegistry,
    private readonly store: BrowserRuntimeStore = new InMemoryBrowserRuntimeStore()
  ) {}

  getSourceOverride(runtimeId: BrowserRuntimeId): BrowserRuntimeSource | null {
    return this.store.getSnapshot().sources[runtimeId] ?? null;
  }

  setSourceOverride(runtimeId: BrowserRuntimeId, source: BrowserRuntimeSource | null): void {
    this.registry.get(runtimeId);
    this.store.setSourceOverride(runtimeId, source);
  }

  clearSourceOverride(runtimeId: BrowserRuntimeId): void {
    this.setSourceOverride(runtimeId, null);
  }

  async getRuntimeStatus(
    runtimeId: BrowserRuntimeId,
    sourceOverride?: BrowserRuntimeSource | null
  ): Promise<BrowserRuntimeStatus> {
    const provider = this.registry.get(runtimeId);
    const configuredSourceOverride =
      sourceOverride === undefined ? this.getSourceOverride(runtimeId) : sourceOverride;
    const { resolvedRuntime, probe, source } = await resolveAndProbe(
      provider,
      configuredSourceOverride
    );
    const executablePath = probe.executablePath ?? resolvedRuntime?.executablePath;
    const installed = inferInstalled(source, resolvedRuntime, probe);
    const status: BrowserRuntimeStatus = {
      runtimeId,
      descriptor: provider.descriptor,
      source,
      configuredSourceOverride,
      lastProbeAt: Date.now(),
      resolvedRuntime,
      installed,
      healthy: probe.healthy,
      installState: sourceInstallState(source, probe),
      version: probe.version ?? resolvedRuntime?.version ?? null,
      executablePath,
      errors: probe.errors,
      warnings: probe.warnings,
      capabilities: probe.capabilities,
    };
    this.store.setProbeStatus(runtimeId, status);
    return status;
  }

  async listRuntimeStatuses(): Promise<BrowserRuntimeStatus[]> {
    return Promise.all(this.registry.list().map((provider) => this.getRuntimeStatus(provider.id)));
  }

  async installRuntime(runtimeId: BrowserRuntimeId): Promise<BrowserRuntimeStatus> {
    const provider = this.registry.get(runtimeId);
    if (!provider.installRuntime) {
      throw new Error(`Browser runtime does not support managed install: ${runtimeId}`);
    }
    const sourceOverride = this.getSourceOverride(runtimeId);
    await provider.installRuntime({
      runtimeId,
      sourceOverride,
    });
    return this.getRuntimeStatus(runtimeId, sourceOverride);
  }
}

export function createBrowserRuntimeManager(
  registry: BrowserRuntimeRegistry,
  store?: BrowserRuntimeStore
): BrowserRuntimeManager {
  return new BrowserRuntimeManager(registry, store);
}
