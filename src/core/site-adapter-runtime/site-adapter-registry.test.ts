import { describe, expect, it, vi } from 'vitest';
import type { SiteAdapterModule } from './types';
import { createSiteAdapterRegistry, type SiteAdapterProvider } from './site-adapter-registry';

function createAdapter(id: string): SiteAdapterModule {
  return {
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      site: `${id}.example.test`,
      sideEffectLevel: 'read-only',
      capabilities: [`${id}.extract`],
      supportedRunners: ['fixture'],
      repairScope: {
        roots: ['adapters/plugin'],
        allowedSubpaths: ['extractors'],
      },
      extractors: [
        {
          id: 'main',
          outputFields: [
            'title',
            'sourceUrl',
            'confidence',
            'missingFields',
            'selectorHits',
            'pageFingerprint',
          ],
        },
      ],
    },
    extractors: [
      {
        id: 'main',
        extract: () => ({
          title: 'Hello',
          sourceUrl: 'https://example.test',
          confidence: 1,
          missingFields: [],
          selectorHits: {},
          pageFingerprint: 'fingerprint',
        }),
      },
    ],
  };
}

describe('SiteAdapterRegistry', () => {
  it('normalizes provider entries into sorted registered adapters', () => {
    const provider: SiteAdapterProvider = {
      id: 'test-provider',
      listAdapters: () => [
        {
          module: createAdapter('z-adapter'),
          source: 'plugin',
          pluginId: 'plugin-a',
          packageRoot: 'plugins/plugin-a',
          trusted: true,
        },
        {
          module: createAdapter('a-adapter'),
          source: 'built-in',
          packageRoot: 'src/site-adapters/a-adapter',
          trusted: true,
        },
      ],
    };

    const registry = createSiteAdapterRegistry([provider]);

    expect(registry.listRegisteredAdapters().map((entry) => entry.module.manifest.id)).toEqual([
      'a-adapter',
      'z-adapter',
    ]);
    expect(registry.getRegisteredAdapter('z-adapter')).toMatchObject({
      source: 'plugin',
      pluginId: 'plugin-a',
      trusted: true,
      generation: 1,
    });
    expect(registry.getAdapter('a-adapter')?.manifest.id).toBe('a-adapter');
  });

  it('quarantines duplicate adapter ids across providers', () => {
    const providerA: SiteAdapterProvider = {
      id: 'provider-a',
      listAdapters: () => [
        {
          module: createAdapter('duplicate'),
          source: 'built-in',
          packageRoot: 'src/site-adapters/duplicate',
          trusted: true,
        },
      ],
    };
    const providerB: SiteAdapterProvider = {
      id: 'provider-b',
      listAdapters: () => [
        {
          module: createAdapter('duplicate'),
          source: 'plugin',
          pluginId: 'plugin-a',
          packageRoot: 'plugins/plugin-a',
          trusted: true,
        },
      ],
    };

    const registry = createSiteAdapterRegistry([providerA, providerB]);

    expect(registry.listAdapters().map((adapter) => adapter.manifest.id)).toEqual(['duplicate']);
    expect(registry.listProviderErrors()).toEqual([
      {
        providerId: 'provider-b',
        pluginId: 'plugin-a',
        message: 'Duplicate site adapter id registered: duplicate',
      },
    ]);
  });

  it('quarantines invalid adapter entries while keeping healthy entries', () => {
    const provider: SiteAdapterProvider = {
      id: 'mixed-provider',
      listAdapters: () => [
        {
          module: createAdapter('healthy'),
          source: 'built-in',
          packageRoot: 'src/site-adapters/healthy',
          trusted: true,
        },
        {
          module: {
            manifest: {
              id: 'broken',
            },
          } as unknown as SiteAdapterModule,
          source: 'plugin',
          pluginId: 'plugin-b',
          packageRoot: 'plugins/plugin-b',
          trusted: true,
        },
      ],
    };

    const registry = createSiteAdapterRegistry([provider]);

    expect(registry.listAdapters().map((adapter) => adapter.manifest.id)).toEqual(['healthy']);
    expect(registry.listProviderErrors()).toEqual([
      expect.objectContaining({
        providerId: 'mixed-provider',
        pluginId: 'plugin-b',
        message: expect.any(String),
      }),
    ]);
  });

  it('keeps healthy providers available when one provider fails to list adapters', () => {
    const healthyProvider: SiteAdapterProvider = {
      id: 'healthy-provider',
      listAdapters: () => [
        {
          module: createAdapter('healthy'),
          source: 'built-in',
          packageRoot: 'src/site-adapters/healthy',
          trusted: true,
        },
      ],
    };
    const failingProvider: SiteAdapterProvider = {
      id: 'failing-provider',
      listAdapters: () => {
        throw new Error('adapter contribution is invalid');
      },
    };

    const registry = createSiteAdapterRegistry([healthyProvider, failingProvider]);

    expect(registry.listAdapters().map((adapter) => adapter.manifest.id)).toEqual(['healthy']);
    expect(registry.listProviderErrors()).toEqual([
      {
        providerId: 'failing-provider',
        message: 'adapter contribution is invalid',
      },
    ]);
  });

  it('refreshes when a provider publishes changes and unsubscribes on dispose', () => {
    const listeners = new Set<() => void>();
    let adapters = [createAdapter('initial')];
    const provider: SiteAdapterProvider = {
      id: 'dynamic-provider',
      listAdapters: () =>
        adapters.map((module) => ({
          module,
          source: 'plugin' as const,
          pluginId: 'plugin-a',
          packageRoot: 'plugins/plugin-a',
          trusted: true,
        })),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const registry = createSiteAdapterRegistry([provider]);
    expect(registry.getGeneration()).toBe(1);

    adapters = [createAdapter('updated')];
    for (const listener of listeners) {
      listener();
    }

    expect(registry.getGeneration()).toBe(2);
    expect(registry.listAdapters().map((adapter) => adapter.manifest.id)).toEqual(['updated']);

    const refreshSpy = vi.spyOn(registry, 'refresh');
    registry.dispose();
    for (const listener of listeners) {
      listener();
    }
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
