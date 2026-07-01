import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSiteAdapterRepairPath,
  createSiteAdapterRepairScopeMatrix,
  createSiteAdapterRepairScopeOptionsFromManifest,
  evaluateSiteAdapterRepairPath,
} from './repair-scope';
import { siteAdapterRegistry } from '../../../site-adapters';
import type { SiteAdapterManifest } from '../types';

const workspaceRoot = path.resolve('D:/workspace/tianshe-client-open');

describe('site adapter repair scope', () => {
  it('allows read-only adapter repair files under approved example subpaths', () => {
    const decision = evaluateSiteAdapterRepairPath(
      'examples/web-site-adapter-demo/extractors/product.ts',
      { workspaceRoot }
    );

    expect(decision).toMatchObject({
      allowed: true,
      reason: 'allowed',
      relativePath: 'examples/web-site-adapter-demo/extractors/product.ts',
    });
  });

  it('allows canonical site-adapters repair files under approved subpaths', () => {
    const decision = evaluateSiteAdapterRepairPath(
      'site-adapters/books-to-scrape/extractors/product.ts',
      { workspaceRoot }
    );

    expect(decision).toMatchObject({
      allowed: true,
      reason: 'allowed',
      relativePath: 'site-adapters/books-to-scrape/extractors/product.ts',
    });
  });

  it('allows compiled src/site-adapters repair files without opening framework core', () => {
    const decision = evaluateSiteAdapterRepairPath(
      'src/site-adapters/books-to-scrape/expected/product-page.json',
      { workspaceRoot }
    );

    expect(decision).toMatchObject({
      allowed: true,
      reason: 'allowed',
      relativePath: 'src/site-adapters/books-to-scrape/expected/product-page.json',
    });
  });

  it('blocks path traversal outside the workspace', () => {
    const outside = path.resolve(workspaceRoot, '..', 'other-repo', 'extractors', 'x.ts');
    const decision = evaluateSiteAdapterRepairPath(outside, { workspaceRoot });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('outside_workspace');
  });

  it('blocks framework code even when a repair asks for an absolute path', () => {
    const frameworkPath = path.resolve(
      workspaceRoot,
      'src/core/site-adapter-runtime/repair/repair-scope.ts'
    );
    const decision = evaluateSiteAdapterRepairPath(frameworkPath, { workspaceRoot });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('denied_framework_path');
  });

  it('blocks non-adapter example paths', () => {
    const decision = evaluateSiteAdapterRepairPath('examples/minimal-plugin/manifest.json', {
      workspaceRoot,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('outside_site_adapter_root');
  });

  it('blocks adapter files outside extractor verifier fixture and expected folders', () => {
    const decision = evaluateSiteAdapterRepairPath(
      'examples/web-site-adapter-demo/README.md',
      { workspaceRoot }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('outside_repair_subpath');
  });

  it('blocks root site adapter README files outside approved repair subpaths', () => {
    const decision = evaluateSiteAdapterRepairPath('site-adapters/books-to-scrape/README.md', {
      workspaceRoot,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('outside_repair_subpath');
  });

  it('throws with a stable reason when callers require an allowed path', () => {
    expect(() =>
      assertSiteAdapterRepairPath('src/main/mcp-http-adapter.ts', { workspaceRoot })
    ).toThrow('denied_framework_path');
  });

  it('uses adapter manifest roots, allowed subpaths, and forbidden files in the evaluator', () => {
    const manifest = {
      id: 'demo-shop',
      name: 'Demo Shop',
      version: '1.0.0',
      site: 'example.test',
      sideEffectLevel: 'read-only',
      repairScope: {
        roots: ['src/site-adapters/demo-shop'],
        allowedSubpaths: ['extractors'],
        forbiddenFiles: ['src/site-adapters/demo-shop/extractors/secret.ts'],
      },
      extractors: [],
    } satisfies SiteAdapterManifest;
    const options = createSiteAdapterRepairScopeOptionsFromManifest(manifest, workspaceRoot);

    expect(
      evaluateSiteAdapterRepairPath(
        'src/site-adapters/demo-shop/extractors/product.ts',
        options
      )
    ).toMatchObject({
      allowed: true,
      reason: 'allowed',
    });
    expect(
      evaluateSiteAdapterRepairPath(
        'src/site-adapters/demo-shop/expected/product-page.json',
        options
      )
    ).toMatchObject({
      allowed: false,
      reason: 'outside_repair_subpath',
    });
    expect(
      evaluateSiteAdapterRepairPath(
        'src/site-adapters/other-shop/extractors/product.ts',
        options
      )
    ).toMatchObject({
      allowed: false,
      reason: 'outside_site_adapter_root',
    });
    expect(
      evaluateSiteAdapterRepairPath(
        'src/site-adapters/demo-shop/extractors/secret.ts',
        options
      )
    ).toMatchObject({
      allowed: false,
      reason: 'forbidden_file',
    });
  });

  it('generates an allow and deny repair scope matrix for every official adapter', () => {
    const adapters = siteAdapterRegistry.listAdapters();
    const matrix = createSiteAdapterRepairScopeMatrix(adapters, { workspaceRoot });

    expect(matrix.ok).toBe(true);
    expect(matrix.rows.map((row) => row.adapterId).sort()).toEqual(
      adapters.map((adapter) => adapter.manifest.id).sort()
    );
    expect(matrix.rows.length).toBeGreaterThanOrEqual(6);
    for (const row of matrix.rows) {
      expect(row.candidates.some((candidate) => candidate.expectedAllowed)).toBe(true);
      expect(
        row.candidates.some(
          (candidate) => candidate.expectedReason === 'denied_framework_path'
        )
      ).toBe(true);
      expect(row.candidates.every((candidate) => candidate.ok)).toBe(true);
    }
  });
});
