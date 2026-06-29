import type { BrowserRuntimeId } from '../../types/browser-runtime';
import type { BrowserRuntimeProvider } from './types';

export class BrowserRuntimeRegistry {
  private readonly providers = new Map<BrowserRuntimeId, BrowserRuntimeProvider>();

  register(provider: BrowserRuntimeProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Browser runtime provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(runtimeId: BrowserRuntimeId): BrowserRuntimeProvider {
    const provider = this.providers.get(runtimeId);
    if (!provider) {
      throw new Error(`Browser runtime provider is not registered: ${runtimeId}`);
    }
    return provider;
  }

  list(): BrowserRuntimeProvider[] {
    return Array.from(this.providers.values());
  }
}

export function createBrowserRuntimeRegistry(): BrowserRuntimeRegistry {
  return new BrowserRuntimeRegistry();
}

