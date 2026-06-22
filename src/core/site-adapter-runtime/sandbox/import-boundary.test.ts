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
      expect.objectContaining({ moduleName: 'node:fs', reason: 'node_builtin' }),
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
});
