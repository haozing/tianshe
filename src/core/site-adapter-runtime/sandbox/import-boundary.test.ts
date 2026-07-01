import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSiteAdapterImportBoundary } from './import-boundary';

const tempRoots: string[] = [];

function createTempAdapterRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-adapter-boundary-'));
  tempRoots.push(root);
  return root;
}

describe('site adapter import boundary', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows ordinary local adapter imports', () => {
    const root = createTempAdapterRoot();
    fs.writeFileSync(
      path.join(root, 'adapter.ts'),
      [
        "import type { SiteAdapterModule } from '../../src/core/site-adapter-runtime';",
        "import { productExtractor } from './extractors/product';",
        'export const adapter = {} as SiteAdapterModule;',
      ].join('\n')
    );

    expect(checkSiteAdapterImportBoundary({ adapterRoot: root })).toEqual([]);
  });

  it('rejects Node Electron Playwright and DuckDB imports', () => {
    const root = createTempAdapterRoot();
    fs.writeFileSync(
      path.join(root, 'bad.ts'),
      [
        "import fs from 'node:fs';",
        "import { app } from 'electron';",
        "import { chromium } from 'playwright-core';",
        "const duckdb = import('@duckdb/node-api');",
      ].join('\n')
    );

    expect(checkSiteAdapterImportBoundary({ adapterRoot: root })).toEqual([
      expect.objectContaining({
        relativeFilePath: 'bad.ts',
        moduleName: 'node:fs',
        importChain: ['bad.ts', 'node:fs'],
        reason: 'node_builtin',
        recommendation: expect.stringContaining('framework-owned capability'),
      }),
      expect.objectContaining({ moduleName: 'electron', reason: 'electron' }),
      expect.objectContaining({ moduleName: 'playwright-core', reason: 'playwright' }),
      expect.objectContaining({ moduleName: '@duckdb/node-api', reason: 'duckdb' }),
    ]);
  });

  it('rejects CommonJS require calls for denied runtime modules', () => {
    const root = createTempAdapterRoot();
    fs.writeFileSync(
      path.join(root, 'bad.js'),
      [
        "const fs = require('fs');",
        "const electron = require('electron');",
        "const playwright = require('playwright-core');",
      ].join('\n')
    );
    fs.writeFileSync(path.join(root, 'bad.cjs'), "const duckdb = require('@duckdb/node-api');");

    const violations = checkSiteAdapterImportBoundary({ adapterRoot: root });
    expect(violations).toHaveLength(4);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ moduleName: 'fs', reason: 'node_builtin' }),
        expect.objectContaining({ moduleName: 'electron', reason: 'electron' }),
        expect.objectContaining({ moduleName: 'playwright-core', reason: 'playwright' }),
        expect.objectContaining({ moduleName: '@duckdb/node-api', reason: 'duckdb' }),
      ])
    );
  });

  it('rejects framework core and external sensitive imports without blocking local filenames', () => {
    const root = createTempAdapterRoot();
    fs.writeFileSync(
      path.join(root, 'bad.ts'),
      [
        "import { getSecret } from '../../src/core/secrets';",
        "import { createOrchestrationExecutor } from '../../src/core/ai-dev/orchestration';",
        "import { loadSecrets } from '@vendor/secrets-client';",
        "import { openDataset } from '@vendor/dataset-client';",
        "import { writeArtifact } from '@vendor/artifact-store';",
        "import { queryDataset } from './dataset-access';",
        "import { createArtifact } from './runtime-artifact';",
      ].join('\n')
    );

    const violations = checkSiteAdapterImportBoundary({ adapterRoot: root });
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ moduleName: '../../src/core/secrets', reason: 'framework_core' }),
        expect.objectContaining({
          moduleName: '../../src/core/ai-dev/orchestration',
          reason: 'framework_core',
        }),
        expect.objectContaining({ moduleName: '@vendor/secrets-client', reason: 'secrets' }),
        expect.objectContaining({ moduleName: '@vendor/dataset-client', reason: 'dataset' }),
        expect.objectContaining({ moduleName: '@vendor/artifact-store', reason: 'artifact' }),
      ])
    );
    expect(violations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ moduleName: './dataset-access' }),
        expect.objectContaining({ moduleName: './runtime-artifact' }),
      ])
    );
  });
});
