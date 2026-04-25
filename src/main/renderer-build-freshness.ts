import fs from 'node:fs';
import path from 'node:path';

const SOURCE_DIRS = ['src/renderer'];
const DIST_DIRS = ['dist/renderer'];
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.json',
]);
const DIST_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.svg',
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.woff',
  '.woff2',
]);
const SOURCE_IGNORE_FILE_MARKERS = ['.test.', '.spec.'];
const SOURCE_IGNORE_SEGMENTS = new Set(['__tests__']);

export interface BuildFreshnessFileInfo {
  path: string;
  relativePath: string;
  mtimeMs: number;
  updatedAt: string;
}

export interface RendererBuildFreshnessStatus {
  ok: boolean;
  reason:
    | 'fresh'
    | 'dist_older_than_source'
    | 'missing_dist_artifacts'
    | 'missing_source_tree';
  source: BuildFreshnessFileInfo | null;
  dist: BuildFreshnessFileInfo | null;
  lagMs: number | null;
}

function normalizePathForMatch(entryPath: string): string {
  return entryPath.replace(/\\/g, '/').toLowerCase();
}

export function shouldIgnoreRendererSourceFile(entryPath: string, rootDir: string): boolean {
  const normalizedPath = normalizePathForMatch(path.relative(rootDir, entryPath));
  const fileName = path.basename(normalizedPath);
  if (SOURCE_IGNORE_FILE_MARKERS.some((marker) => fileName.includes(marker))) {
    return true;
  }

  return normalizedPath
    .split('/')
    .filter(Boolean)
    .some((segment) => SOURCE_IGNORE_SEGMENTS.has(segment));
}

export function latestFile(
  paths: string[],
  extensions: ReadonlySet<string>,
  options: {
    rootDir?: string;
    ignoreFile?: (entryPath: string, rootDir: string) => boolean;
  } = {}
): BuildFreshnessFileInfo | null {
  const rootDir = options.rootDir ?? path.resolve(__dirname, '../..');
  const ignoreFile = options.ignoreFile ?? (() => false);
  let latest: BuildFreshnessFileInfo | null = null;

  const visit = (entryPath: string): void => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entryPath);
    } catch {
      return;
    }

    if (stat.isDirectory()) {
      let children: string[] = [];
      try {
        children = fs.readdirSync(entryPath);
      } catch {
        return;
      }

      for (const child of children) {
        visit(path.join(entryPath, child));
      }
      return;
    }

    const ext = path.extname(entryPath);
    if (!extensions.has(ext)) {
      return;
    }
    if (ignoreFile(entryPath, rootDir)) {
      return;
    }

    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = {
        path: entryPath,
        relativePath: path.relative(rootDir, entryPath),
        mtimeMs: stat.mtimeMs,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      };
    }
  };

  for (const relativePath of paths) {
    const absolutePath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(rootDir, relativePath);
    if (fs.existsSync(absolutePath)) {
      visit(absolutePath);
    }
  }

  return latest;
}

export function getRendererBuildFreshness(
  rootDir: string = path.resolve(__dirname, '../..')
): RendererBuildFreshnessStatus {
  const source = latestFile(SOURCE_DIRS, SOURCE_EXTENSIONS, {
    rootDir,
    ignoreFile: shouldIgnoreRendererSourceFile,
  });
  const dist = latestFile(DIST_DIRS, DIST_EXTENSIONS, { rootDir });

  if (!source) {
    return {
      ok: true,
      reason: 'missing_source_tree',
      source: null,
      dist,
      lagMs: 0,
    };
  }

  if (!dist) {
    return {
      ok: false,
      reason: 'missing_dist_artifacts',
      source,
      dist: null,
      lagMs: null,
    };
  }

  const lagMs = Math.max(0, source.mtimeMs - dist.mtimeMs);
  return {
    ok: lagMs <= 1000,
    reason: lagMs <= 1000 ? 'fresh' : 'dist_older_than_source',
    source,
    dist,
    lagMs,
  };
}

export function formatRendererBuildWarning(status: RendererBuildFreshnessStatus | null): string {
  if (!status || status.ok) {
    return '';
  }

  if (status.reason === 'missing_dist_artifacts') {
    return 'Renderer dist artifacts are missing. Run `npm run build:renderer` or start the Vite dev server with `npm run dev`.';
  }

  if (status.reason === 'dist_older_than_source') {
    const lagSeconds =
      typeof status.lagMs === 'number' ? Math.ceil(status.lagMs / 1000) : '?';
    return `Renderer dist artifacts are older than source by about ${lagSeconds}s. Run \`npm run build:renderer\` or start the Vite dev server with \`npm run dev\` before launching Electron directly.`;
  }

  return '';
}
