import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTiansheEditionPublicInfo, normalizeTiansheEditionName } from './selection';

const IMPORT_PATTERN = /^\s*import(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
const RUNTIME_IMPORT_PATTERN = /^\s*import\s+(?!type\b)(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

function extractImports(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  return Array.from(source.matchAll(IMPORT_PATTERN)).map((match) => match[1].replace(/\\/g, '/'));
}

function extractRuntimeImports(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  return Array.from(source.matchAll(RUNTIME_IMPORT_PATTERN)).map((match) =>
    match[1].replace(/\\/g, '/'),
  );
}

function source(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

describe('open/cloud edition boundary', () => {
  it('always resolves public edition input to the open edition', () => {
    expect(normalizeTiansheEditionName(undefined)).toBe('open');
    expect(normalizeTiansheEditionName('')).toBe('open');
    expect(normalizeTiansheEditionName('unexpected')).toBe('open');
    expect(normalizeTiansheEditionName('cloud')).toBe('open');
    expect(getTiansheEditionPublicInfo('cloud')).toEqual({
      name: 'open',
      capabilities: {
        cloudAuth: false,
        cloudSnapshot: false,
        cloudCatalog: false,
      },
    });
    expect(getTiansheEditionPublicInfo('open')).toEqual({
      name: 'open',
      capabilities: {
        cloudAuth: false,
        cloudSnapshot: false,
        cloudCatalog: false,
      },
    });
  });

  it('open edition provider does not import cloud, private, or server implementation modules', () => {
    const files = collectTsFiles('src/edition/open');
    const violations: string[] = [];

    for (const file of files) {
      for (const specifier of extractImports(file)) {
        if (
          specifier.includes('/cloud') ||
          specifier.includes('cloud-') ||
          specifier.includes('/plugin-market') ||
          specifier.includes('/browser-extension-cloud') ||
          specifier.includes('/server') ||
          specifier.includes('/private')
        ) {
          violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('main entry registers cloud capabilities only through edition providers', () => {
    const imports = extractImports('src/main/index.ts');
    const forbidden = new Set([
      './ipc-handlers/cloud-auth-handler',
      './ipc-handlers/cloud-sync-handler',
      './ipc-handlers/browser-extension-cloud-handler',
      './ipc-handlers/plugin-market-handler',
      './cloud-sync/context',
      './plugin-market/service',
      './browser-extension-cloud/service',
    ]);

    expect(imports.filter((specifier) => forbidden.has(specifier))).toEqual([]);
    expect(source('src/main/index.ts')).toContain('resolveTiansheEdition');
    expect(source('src/main/index.ts')).toContain('tiansheEdition.cloudSnapshot.registerMainHandlers');
    expect(source('src/main/index.ts')).toContain('tiansheEdition.cloudCatalog.registerMainHandlers');
  });

  it('preload always exposes edition info and strips cloud APIs for open edition', () => {
    const preload = source('src/preload/index.ts');

    expect(preload).toContain("import type { TiansheEditionName, TiansheEditionPublicInfo } from '../edition/types';");
    expect(preload).toContain('const resolveTiansheEditionPublicInfo = (): TiansheEditionPublicInfo => {');
    expect(preload).toContain("const name: TiansheEditionName = 'open';");
    expect(preload).not.toContain('process.env');
    expect(preload).toContain('edition: tiansheEdition');
    expect(preload).toContain("if (tiansheEdition.name === 'open')");
    expect(preload).toContain('delete exposed.cloudAuth');
    expect(preload).toContain('delete exposed.cloudSnapshot');
    expect(preload).toContain('delete exposed.cloudPlugin');
    expect(preload).toContain('delete exposed.cloudBrowserExtension');
    expect(preload).toContain('delete extensionPackages.downloadCloudCatalogPackages');
  });

  it('preload runtime imports stay sandbox-compatible', () => {
    expect(extractRuntimeImports('src/preload/index.ts')).toEqual(['electron']);
  });
});
