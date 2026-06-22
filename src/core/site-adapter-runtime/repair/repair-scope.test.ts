import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSiteAdapterRepairPath,
  evaluateSiteAdapterRepairPath,
} from './repair-scope';

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

  it('throws with a stable reason when callers require an allowed path', () => {
    expect(() =>
      assertSiteAdapterRepairPath('src/main/mcp-http-adapter.ts', { workspaceRoot })
    ).toThrow('denied_framework_path');
  });
});
