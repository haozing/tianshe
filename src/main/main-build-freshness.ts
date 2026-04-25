import fs from 'node:fs';
import path from 'node:path';
import {
  getBuildArtifactInfo,
  isMainBuildStampAligned,
  MAIN_ENTRY_RELATIVE_PATH,
  readMainBuildStamp,
  type MainBuildStamp,
} from './main-build-stamp';

const SOURCE_DIRS = ['src/main', 'src/core', 'src/types', 'src/preload'];
const DIST_DIRS = ['dist/main', 'dist/core', 'dist/types', 'dist/preload'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json']);
const DIST_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.d.ts']);
const SOURCE_IGNORE_FILE_MARKERS = ['.test.', '.spec.'];
const SOURCE_IGNORE_SEGMENTS = new Set(['__tests__']);

export interface BuildFreshnessFileInfo {
  path: string;
  relativePath: string;
  mtimeMs: number;
  updatedAt: string;
}

export interface MainBuildFreshnessStatus {
  ok: boolean;
  reason:
    | 'fresh'
    | 'dist_older_than_source'
    | 'missing_dist_artifacts'
    | 'missing_source_tree'
    | 'missing_build_stamp'
    | 'build_stamp_out_of_sync';
  source: BuildFreshnessFileInfo | null;
  dist: BuildFreshnessFileInfo | null;
  buildStamp: MainBuildStamp | null;
  lagMs: number | null;
}

function normalizePathForMatch(entryPath: string): string {
  return entryPath.replace(/\\/g, '/').toLowerCase();
}

export function shouldIgnoreMainSourceFile(entryPath: string, rootDir: string): boolean {
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

export function getMainBuildFreshness(
  rootDir: string = path.resolve(__dirname, '../..')
): MainBuildFreshnessStatus {
  const source = latestFile(SOURCE_DIRS, SOURCE_EXTENSIONS, {
    rootDir,
    ignoreFile: shouldIgnoreMainSourceFile,
  });
  const dist = latestFile(DIST_DIRS, DIST_EXTENSIONS, { rootDir });

  if (!source) {
    return {
      ok: true,
      reason: 'missing_source_tree',
      source: null,
      dist,
      buildStamp: readMainBuildStamp(rootDir),
      lagMs: 0,
    };
  }

  const buildStamp = readMainBuildStamp(rootDir);
  const entryPoint = getBuildArtifactInfo(path.join(rootDir, MAIN_ENTRY_RELATIVE_PATH), rootDir);

  if (!dist) {
    return {
      ok: false,
      reason: 'missing_dist_artifacts',
      source,
      dist: null,
      buildStamp,
      lagMs: null,
    };
  }

  if (!buildStamp) {
    return {
      ok: false,
      reason: 'missing_build_stamp',
      source,
      dist,
      buildStamp: null,
      lagMs: null,
    };
  }

  if (!isMainBuildStampAligned(buildStamp, entryPoint)) {
    return {
      ok: false,
      reason: 'build_stamp_out_of_sync',
      source,
      dist,
      buildStamp,
      lagMs: null,
    };
  }

  const lagMs = Math.max(0, source.mtimeMs - dist.mtimeMs);
  return {
    ok: lagMs <= 1000,
    reason: lagMs <= 1000 ? 'fresh' : 'dist_older_than_source',
    source,
    dist,
    buildStamp,
    lagMs,
  };
}

export function formatMainBuildWarning(status: MainBuildFreshnessStatus | null): string {
  if (!status || status.ok) {
    return '';
  }

  if (status.reason === 'missing_dist_artifacts') {
    return 'Local dist artifacts are missing. Electron loads dist/main/index.js; run `npm run build:main` before real-run validation.';
  }

  if (status.reason === 'missing_build_stamp') {
    return 'Main build stamp is missing. Re-run `npm run build:main` before real-run validation.';
  }

  if (status.reason === 'build_stamp_out_of_sync') {
    return 'Main build stamp is out of sync with dist/main. Re-run `npm run build:main` before real-run validation.';
  }

  if (status.reason === 'dist_older_than_source') {
    const lagSeconds =
      typeof status.lagMs === 'number' ? Math.ceil(status.lagMs / 1000) : '?';
    return `Local dist artifacts are older than source by about ${lagSeconds}s. Electron loads dist/main/index.js, so run \`npm run build:main\` and restart Electron before trusting real-run results.`;
  }

  return '';
}
