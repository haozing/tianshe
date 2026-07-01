import fs from 'node:fs';
import path from 'node:path';

export interface SiteAdapterImportBoundaryViolation {
  filePath: string;
  relativeFilePath: string;
  moduleName: string;
  importChain: string[];
  reason:
    | 'node_builtin'
    | 'electron'
    | 'playwright'
    | 'duckdb'
    | 'framework_core'
    | 'secrets'
    | 'dataset'
    | 'artifact';
  recommendation: string;
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

const RECOMMENDATIONS: Record<SiteAdapterImportBoundaryViolation['reason'], string> = {
  node_builtin: 'Move filesystem/process work into a framework-owned capability or fixture loader.',
  electron: 'Use BrowserInterface or a capability boundary; Site Adapters must not import Electron.',
  playwright: 'Use the Lab runner or BrowserInterface instead of importing Playwright from adapter code.',
  duckdb: 'Use capability/database services outside the adapter sandbox; adapters should not access DuckDB directly.',
  framework_core: 'Depend only on core/site-adapter-runtime contracts or local adapter files.',
  secrets: 'Read credentials through approved profile/login flows; adapters must not import secret stores.',
  dataset: 'Return extracted data to the caller; dataset writes belong in capabilities.',
  artifact: 'Return evidence/artifact refs through framework APIs; adapters must not manage artifact storage.',
};

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
  const normalizedModuleName = moduleName.replace(/\\/g, '/').toLowerCase();
  const isRelativeImport =
    normalizedModuleName.startsWith('./') || normalizedModuleName.startsWith('../');
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
  const coreSegmentIndex = normalizedModuleName.indexOf('core/');
  if (
    coreSegmentIndex >= 0 &&
    !normalizedModuleName.slice(coreSegmentIndex).startsWith('core/site-adapter-runtime')
  ) {
    return 'framework_core';
  }
  if (isRelativeImport) {
    return null;
  }
  if (/(^|[/@_.-])secrets?([/@_.-]|$)|(^|[/@_.-])credentials?([/@_.-]|$)/.test(normalizedModuleName)) {
    return 'secrets';
  }
  if (/(^|[/@_.-])datasets?([/@_.-]|$)/.test(normalizedModuleName)) {
    return 'dataset';
  }
  if (/(^|[/@_.-])artifacts?([/@_.-]|$)/.test(normalizedModuleName)) {
    return 'artifact';
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
        relativeFilePath: path.relative(adapterRoot, filePath).replace(/\\/g, '/'),
        moduleName,
        importChain: [
          path.relative(adapterRoot, filePath).replace(/\\/g, '/'),
          moduleName,
        ],
        reason,
        recommendation: RECOMMENDATIONS[reason],
      });
    }
  }

  return violations;
}
