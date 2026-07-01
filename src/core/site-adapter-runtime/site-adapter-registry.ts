import path from 'node:path';
import type {
  RegisteredSiteAdapter,
  SiteAdapterModule,
  SiteAdapterRegistrationSource,
} from './types';
import { validateSiteAdapterModule } from './manifest';

export interface SiteAdapterProviderEntry {
  module: SiteAdapterModule;
  source: SiteAdapterRegistrationSource;
  pluginId?: string;
  packageRoot: string;
  trusted: boolean;
}

export interface SiteAdapterProvider {
  id: string;
  listAdapters(): readonly SiteAdapterProviderEntry[];
  subscribe?(listener: () => void): () => void;
  listErrors?(): readonly SiteAdapterProviderError[];
}

export interface SiteAdapterProviderError {
  providerId: string;
  pluginId?: string;
  message: string;
}

export class SiteAdapterRegistry {
  private generation = 0;
  private entries = new Map<string, RegisteredSiteAdapter>();
  private providerErrors: SiteAdapterProviderError[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly providers: readonly SiteAdapterProvider[] = []) {
    this.refresh();
    for (const provider of providers) {
      const unsubscribe = provider.subscribe?.(() => this.refresh());
      if (unsubscribe) {
        this.unsubscribers.push(unsubscribe);
      }
    }
  }

  getGeneration(): number {
    return this.generation;
  }

  listRegisteredAdapters(): RegisteredSiteAdapter[] {
    return [...this.entries.values()].sort((left, right) =>
      left.module.manifest.id.localeCompare(right.module.manifest.id)
    );
  }

  listAdapters(): SiteAdapterModule[] {
    return this.listRegisteredAdapters().map((entry) => entry.module);
  }

  listProviderErrors(): SiteAdapterProviderError[] {
    return [...this.providerErrors];
  }

  getRegisteredAdapter(adapterId: string): RegisteredSiteAdapter | null {
    return this.entries.get(String(adapterId || '').trim()) ?? null;
  }

  getAdapter(adapterId: string): SiteAdapterModule | null {
    return this.getRegisteredAdapter(adapterId)?.module ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): void {
    const nextEntries = new Map<string, RegisteredSiteAdapter>();
    const nextProviderErrors: SiteAdapterProviderError[] = [];
    const nextGeneration = this.generation + 1;

    for (const provider of this.providers) {
      let providerEntries: readonly SiteAdapterProviderEntry[];
      try {
        providerEntries = provider.listAdapters();
      } catch (error) {
        nextProviderErrors.push({
          providerId: provider.id,
          message: getErrorMessage(error),
        });
        continue;
      }
      nextProviderErrors.push(...(provider.listErrors?.() || []));
      for (const entry of providerEntries) {
        try {
          validateSiteAdapterModule(entry.module);
          const adapterId = entry.module.manifest.id;
          if (nextEntries.has(adapterId)) {
            throw new Error(`Duplicate site adapter id registered: ${adapterId}`);
          }
          nextEntries.set(adapterId, {
            module: entry.module,
            source: entry.source,
            ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
            packageRoot: path.resolve(entry.packageRoot),
            trusted: entry.trusted,
            generation: nextGeneration,
          });
        } catch (error) {
          nextProviderErrors.push({
            providerId: provider.id,
            ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
            message: getErrorMessage(error),
          });
        }
      }
    }

    this.entries = nextEntries;
    this.providerErrors = nextProviderErrors;
    this.generation = nextGeneration;
    for (const listener of this.listeners) {
      listener();
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.listeners.clear();
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSiteAdapterRegistry(
  providers: readonly SiteAdapterProvider[]
): SiteAdapterRegistry {
  return new SiteAdapterRegistry(providers);
}
