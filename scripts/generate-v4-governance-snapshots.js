#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'docs', 'generated', 'v4-governance-snapshot.json');

const entrySource = `
  import { createUnifiedCapabilityCatalog } from './src/core/ai-dev/capabilities/unified-catalog';
  import { createBrowserRuntimeCapabilityMatrix } from './src/core/browser-runtime/capability-contract';
  import { buildEffectiveRuntimeDescriptorMap } from './src/core/browser-runtime/effective-descriptor';
  import { officialSiteAdapters } from './src/site-adapters';
  import { BROWSER_CAPABILITY_NAMES } from './src/types/browser-interface';
  import {
    DEFAULT_SITE_ADAPTER_REPAIR_DENIED_ROOTS,
    DEFAULT_SITE_ADAPTER_REPAIR_ROOT_PATTERN,
    DEFAULT_SITE_ADAPTER_REPAIR_SUBPATHS,
    createSiteAdapterRepairScopeMatrix,
    evaluateSiteAdapterRepairPath,
  } from './src/core/site-adapter-runtime/repair/repair-scope';

  function sorted(value) {
    return [...value].sort((left, right) => left.localeCompare(right));
  }

  function inputFields(capability) {
    const properties = capability.inputSchema?.properties;
    return properties && typeof properties === 'object'
      ? sorted(Object.keys(properties))
      : [];
  }

  function countRowsBy(rows, selector) {
    return rows.reduce((acc, row) => {
      const key = selector(row);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }

  function summarizeRuntimeMaturity(rows) {
    const supportedRows = rows.filter((row) => row.supported === true);
    return {
      stabilityCounts: countRowsBy(rows, (row) => row.stability || 'missing'),
      supportedStabilityCounts: countRowsBy(
        supportedRows,
        (row) => row.stability || 'missing'
      ),
      supportedExperimental: supportedRows
        .filter((row) => row.stability === 'experimental')
        .map((row) => row.runtimeId + ':' + row.capabilityName)
        .sort(),
      supportedPlanned: supportedRows
        .filter((row) => row.stability === 'planned')
        .map((row) => row.runtimeId + ':' + row.capabilityName)
        .sort(),
    };
  }

  export function createSnapshot(root) {
    const catalog = createUnifiedCapabilityCatalog();
    const capabilities = Object.values(catalog).map((capability) => capability.definition);
    const officialAdapters = officialSiteAdapters;
    const publicCapabilities = capabilities.filter(
      (capability) => capability.assistantSurface?.publicMcp === true
    );
    const publicCapabilityRecords = publicCapabilities
      .map((capability) => ({
        name: capability.name,
        sideEffectLevel: capability.sideEffectLevel || null,
        requiredScopes: sorted(capability.requiredScopes || []),
        inputFields: inputFields(capability),
        surfaceTier: capability.assistantSurface?.surfaceTier || null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const capabilityNames = sorted(capabilities.map((capability) => capability.name));
    const publicCapabilityNames = sorted(publicCapabilities.map((capability) => capability.name));
    const runtimeDescriptors = buildEffectiveRuntimeDescriptorMap();
    const runtimeCapabilityMatrix = createBrowserRuntimeCapabilityMatrix(
      Object.values(runtimeDescriptors)
    );
    const rawPlaywrightSurfaceNames = publicCapabilityNames.filter((name) =>
      /playwright|evaluate|repair_apply_patch|site_adapter_debug|extractor_debug|interactor_debug/i.test(name)
    );
    const repairScopeSamples = [
      'examples/web-site-adapter-demo/extractors/product.ts',
      'site-adapters/books-to-scrape/extractors/product.ts',
      'src/site-adapters/books-to-scrape/expected/product-page.json',
      'site-adapters/books-to-scrape/README.md',
      'src/core/site-adapter-runtime/read-only-runner.ts',
      '../outside-repo/extractors/product.ts',
    ];

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      capabilityCatalog: {
        total: capabilityNames.length,
        names: capabilityNames,
        siteCapabilityNames: capabilityNames.filter((name) => name.includes('.')),
        publicCapabilities: publicCapabilityRecords,
      },
      mcpPublicSurface: {
        total: publicCapabilityNames.length,
        names: publicCapabilityNames,
        rawPlaywrightSurfaceNames,
        defaultSurfaceRejectsRawPlaywright: rawPlaywrightSurfaceNames.length === 0,
      },
      runtimeDescriptor: {
        browserCapabilityNames: sorted(BROWSER_CAPABILITY_NAMES),
        descriptors: runtimeDescriptors,
        capabilityMatrix: runtimeCapabilityMatrix,
        maturitySummary: summarizeRuntimeMaturity(runtimeCapabilityMatrix),
      },
      officialSiteAdapters: {
        total: officialAdapters.length,
        adapters: officialAdapters.map((adapter) => ({
          id: adapter.manifest.id,
          siteId: adapter.manifest.siteId || null,
          capabilities: sorted(adapter.manifest.capabilities || []),
          procedures: (adapter.manifest.procedures || []).map((procedure) => ({
            id: procedure.id,
            sideEffectLevel: procedure.sideEffectLevel,
            requiredScopes: [...(procedure.requiredScopes || [])],
            verification: procedure.verification || null,
            implemented: Boolean(
              (adapter.procedures || []).some((runtimeProcedure) => runtimeProcedure.id === procedure.id)
            ),
          })),
        })),
      },
      repairScope: {
        rootPattern: DEFAULT_SITE_ADAPTER_REPAIR_ROOT_PATTERN.source,
        allowedRepairSubpaths: [...DEFAULT_SITE_ADAPTER_REPAIR_SUBPATHS],
        deniedRoots: [...DEFAULT_SITE_ADAPTER_REPAIR_DENIED_ROOTS],
        sampleDecisions: repairScopeSamples.map((candidatePath) => ({
          candidatePath,
          decision: evaluateSiteAdapterRepairPath(candidatePath, { workspaceRoot: root }),
        })),
        officialAdapterMatrix: createSiteAdapterRepairScopeMatrix(officialAdapters, {
          workspaceRoot: root,
        }),
      },
    };
  }
`;

function loadSnapshotFactory() {
  const result = esbuild.buildSync({
    absWorkingDir: ROOT,
    stdin: {
      contents: entrySource,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    external: ['electron', '@duckdb/node-api'],
  });
  const code = result.outputFiles[0].text;
  const compiled = { exports: {} };
  const execute = new Function('require', 'module', 'exports', code);
  execute(require, compiled, compiled.exports);
  return compiled.exports.createSnapshot;
}

function main() {
  const createSnapshot = loadSnapshotFactory();
  const snapshot = createSnapshot(ROOT);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `[v4-governance-snapshot] wrote ${path.relative(ROOT, OUTPUT_PATH).replace(/\\/g, '/')}\n`
  );
}

module.exports = {
  OUTPUT_PATH,
  loadSnapshotFactory,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `[v4-governance-snapshot] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
