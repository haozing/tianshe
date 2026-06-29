import fs from 'node:fs';
import path from 'node:path';

export interface SiteAdapterImportBoundaryViolation {
  filePath: string;
  moduleName: string;
  reason: 'node_builtin' | 'electron' | 'playwright' | 'duckdb';
}

export interface SiteAdapterImportBoundaryOptions {
  adapterRoot: string;
  extensions?: readonly string[];
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'] as const;
const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^'"]*from\s*)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"]*from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
] as const;

function listSourceFiles(root: string, extensions: readonly string[]): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return extensions.includes(path.extname(root)) ? [root] : [];
  }
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const childPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(childPath, extensions);
    }
    return extensions.includes(path.extname(entry.name)) ? [childPath] : [];
  });
}

function classifyDeniedImport(moduleName: string): SiteAdapterImportBoundaryViolation['reason'] | null {
  if (moduleName.startsWith('node:') || ['fs', 'path', 'os', 'child_process', 'crypto'].includes(moduleName)) {
    return 'node_builtin';
  }
  if (moduleName === 'electron') {
    return 'electron';
  }
  if (moduleName === 'playwright' || moduleName === 'playwright-core' || moduleName.startsWith('@playwright/')) {
    return 'playwright';
  }
  if (
    moduleName === '@duckdb/node-api' ||
    moduleName === 'duckdb' ||
    moduleName.toLowerCase().includes('duckdb')
  ) {
    return 'duckdb';
  }
  return null;
}

function collectImports(source: string): string[] {
  const imports: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      imports.push(match[1]);
    }
  }
  return imports;
}

export function checkSiteAdapterImportBoundary(
  options: SiteAdapterImportBoundaryOptions
): SiteAdapterImportBoundaryViolation[] {
  const adapterRoot = path.resolve(options.adapterRoot);
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const violations: SiteAdapterImportBoundaryViolation[] = [];

  for (const filePath of listSourceFiles(adapterRoot, extensions)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const moduleName of collectImports(source)) {
      const reason = classifyDeniedImport(moduleName);
      if (!reason) {
        continue;
      }
      violations.push({
        filePath,
        moduleName,
        reason,
      });
    }
  }

  return violations;
}
