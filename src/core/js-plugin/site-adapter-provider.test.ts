import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JSPluginManifest, JSPluginModule } from '../../types/js-plugin';
import type { SiteAdapterModule } from '../site-adapter-runtime';
import { createSiteAdapterRegistry, runReadOnlySiteAdapterFixture } from '../site-adapter-runtime';
import { PluginRegistry } from './registry';
import { createPluginSiteAdapterProvider } from './site-adapter-provider';

const tempRoots: string[] = [];

function createTempPluginRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-site-adapter-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'adapter.ts'), 'export const adapter = {};\n');
  return root;
}

function createAdapter(id = 'plugin-example'): SiteAdapterModule {
  return {
    manifest: {
      id,
      name: 'Plugin Example',
      version: '1.0.0',
      site: 'plugin.example.test',
      siteId: 'plugin_example',
      sideEffectLevel: 'read-only',
      capabilities: ['plugin_example.extract'],
      supportedRunners: ['fixture'],
      repairScope: {
        roots: ['src'],
        allowedSubpaths: ['extractors', 'fixtures', 'expected'],
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
          title: 'Plugin adapter',
          sourceUrl: 'https://plugin.example.test',
          confidence: 1,
          missingFields: [],
          selectorHits: {},
          pageFingerprint: 'fingerprint',
        }),
      },
    ],
  };
}

function createManifest(overrides: Partial<JSPluginManifest> = {}): JSPluginManifest {
  return {
    id: 'plugin-a',
    name: 'Plugin A',
    version: '1.0.0',
    author: 'Test',
    main: 'index.js',
    trustModel: 'first_party',
    contributes: {
      siteAdapters: [
        {
          entry: 'src/adapter.ts',
          adapterId: 'plugin-example',
        },
      ],
    },
    ...overrides,
  };
}

function createModule(adapter = createAdapter()): JSPluginModule {
  return {
    siteAdapters: [adapter],
  };
}

describe('createPluginSiteAdapterProvider', () => {
  let pluginRegistry: PluginRegistry;

  beforeEach(() => {
    PluginRegistry.resetInstance();
    pluginRegistry = PluginRegistry.getInstance();
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    PluginRegistry.resetInstance();
  });

  it('registers trusted plugin site adapters through the shared registry view', () => {
    const packageRoot = createTempPluginRoot();
    pluginRegistry.registerPlugin('plugin-a', createManifest(), undefined, {
      packageRoot,
      module: createModule(),
    });

    const registry = createSiteAdapterRegistry([createPluginSiteAdapterProvider(pluginRegistry)]);
    const [entry] = registry.listRegisteredAdapters();

    expect(entry).toMatchObject({
      source: 'plugin',
      pluginId: 'plugin-a',
      trusted: true,
      generation: 1,
    });
    expect(entry.module.manifest.id).toBe('plugin-example');
    expect(entry.packageRoot).toBe(path.resolve(packageRoot));
  });

  it('runs a trusted plugin adapter through the same fixture runner contract', async () => {
    const packageRoot = createTempPluginRoot();
    pluginRegistry.registerPlugin('plugin-a', createManifest(), undefined, {
      packageRoot,
      module: createModule(),
    });
    const registry = createSiteAdapterRegistry([createPluginSiteAdapterProvider(pluginRegistry)]);
    const adapter = registry.getAdapter('plugin-example');

    const result = await runReadOnlySiteAdapterFixture(adapter!, {
      name: 'plugin-fixture',
      snapshot: {
        url: 'https://plugin.example.test',
        title: 'Plugin Example',
        elements: [],
      },
      expected: {
        title: 'Plugin adapter',
        sourceUrl: 'https://plugin.example.test',
        confidence: 1,
        missingFields: [],
        selectorHits: {},
        pageFingerprint: 'fingerprint',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.result.title).toBe('Plugin adapter');
  });

  it('refreshes registry entries when plugin adapters are registered and unregistered', () => {
    const provider = createPluginSiteAdapterProvider(pluginRegistry);
    const registry = createSiteAdapterRegistry([provider]);
    const packageRoot = createTempPluginRoot();

    expect(registry.listAdapters()).toEqual([]);

    pluginRegistry.registerPlugin('plugin-a', createManifest(), undefined, {
      packageRoot,
      module: createModule(),
    });
    expect(registry.listAdapters().map((adapter) => adapter.manifest.id)).toEqual([
      'plugin-example',
    ]);

    pluginRegistry.unregisterPlugin('plugin-a');
    expect(registry.listAdapters()).toEqual([]);
  });

  it('quarantines untrusted plugin site adapter contributions without dropping valid plugins', () => {
    const badPackageRoot = createTempPluginRoot();
    const goodPackageRoot = createTempPluginRoot();
    pluginRegistry.registerPlugin(
      'plugin-bad',
      createManifest({ trustModel: undefined }),
      undefined,
      {
        packageRoot: badPackageRoot,
        module: createModule(),
      }
    );
    pluginRegistry.registerPlugin('plugin-good', createManifest({ id: 'plugin-good' }), undefined, {
      packageRoot: goodPackageRoot,
      module: createModule(),
    });

    const registry = createSiteAdapterRegistry([createPluginSiteAdapterProvider(pluginRegistry)]);

    expect(registry.listAdapters().map((adapter) => adapter.manifest.id)).toEqual([
      'plugin-example',
    ]);
    expect(registry.listProviderErrors()).toEqual([
      expect.objectContaining({
        pluginId: 'plugin-bad',
        message: expect.stringMatching(/trustModel: first_party/),
      }),
    ]);
  });

  it('quarantines plugin adapter entries that escape the package root', () => {
    const packageRoot = createTempPluginRoot();
    pluginRegistry.registerPlugin(
      'plugin-a',
      createManifest({
        contributes: {
          siteAdapters: [{ entry: '../adapter.ts', adapterId: 'plugin-example' }],
        },
      }),
      undefined,
      {
        packageRoot,
        module: createModule(),
      }
    );

    const registry = createSiteAdapterRegistry([createPluginSiteAdapterProvider(pluginRegistry)]);

    expect(registry.listAdapters()).toEqual([]);
    expect(registry.listProviderErrors()).toEqual([
      expect.objectContaining({
        pluginId: 'plugin-a',
        message: expect.stringMatching(/must not escape/),
      }),
    ]);
  });

  it('quarantines plugin adapter entry imports outside the site adapter sandbox', () => {
    const packageRoot = createTempPluginRoot();
    fs.writeFileSync(path.join(packageRoot, 'src', 'adapter.ts'), "import fs from 'node:fs';\n");
    pluginRegistry.registerPlugin('plugin-a', createManifest(), undefined, {
      packageRoot,
      module: createModule(),
    });

    const registry = createSiteAdapterRegistry([createPluginSiteAdapterProvider(pluginRegistry)]);

    expect(registry.listAdapters()).toEqual([]);
    expect(registry.listProviderErrors()).toEqual([
      expect.objectContaining({
        pluginId: 'plugin-a',
        message: expect.stringMatching(/violates import boundary/),
      }),
    ]);
  });

  it('quarantines duplicate adapter ids with built-in providers', () => {
    const packageRoot = createTempPluginRoot();
    const adapter = createAdapter('duplicate');
    pluginRegistry.registerPlugin(
      'plugin-a',
      createManifest({
        contributes: {
          siteAdapters: [{ entry: 'src/adapter.ts', adapterId: 'duplicate' }],
        },
      }),
      undefined,
      {
        packageRoot,
        module: createModule(adapter),
      }
    );

    const registry = createSiteAdapterRegistry([
      {
        id: 'built-in',
        listAdapters: () => [
          {
            module: createAdapter('duplicate'),
            source: 'built-in',
            packageRoot: 'src/site-adapters/duplicate',
            trusted: true,
          },
        ],
      },
      createPluginSiteAdapterProvider(pluginRegistry),
    ]);

    expect(registry.listAdapters().map((module) => module.manifest.id)).toEqual(['duplicate']);
    expect(registry.listProviderErrors()).toEqual([
      expect.objectContaining({
        providerId: 'trusted-plugin-site-adapters',
        pluginId: 'plugin-a',
        message: 'Duplicate site adapter id registered: duplicate',
      }),
    ]);
  });
});
