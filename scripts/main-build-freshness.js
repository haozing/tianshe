const fs = require('fs');
const path = require('path');
const {
  MAIN_ENTRY_PATH,
  getFileInfo,
  isMainBuildStampAligned,
  readMainBuildStamp,
} = require('./main-build-stamp');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['src/main', 'src/core', 'src/types', 'src/preload'];
const DIST_DIRS = ['dist/main', 'dist/core', 'dist/types', 'dist/preload'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json']);
const DIST_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.d.ts']);
const SOURCE_IGNORE_FILE_MARKERS = ['.test.', '.spec.'];
const SOURCE_IGNORE_SEGMENTS = new Set(['__tests__']);

function normalizePathForMatch(entryPath) {
  return entryPath.replace(/\\/g, '/').toLowerCase();
}

function shouldIgnoreSourceFile(entryPath, rootDir = ROOT) {
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

function latestFile(paths, extensions, options = {}) {
  const rootDir = options.rootDir || ROOT;
  let latest = null;
  const ignoreFile = typeof options.ignoreFile === 'function' ? options.ignoreFile : () => false;

  function visit(entryPath) {
    let stat;
    try {
      stat = fs.statSync(entryPath);
    } catch (_) {
      return;
    }

    if (stat.isDirectory()) {
      let children = [];
      try {
        children = fs.readdirSync(entryPath);
      } catch (_) {
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
    if (ignoreFile(entryPath)) {
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
  }

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

function getMainBuildFreshness(rootDir = ROOT) {
  const source = latestFile(SOURCE_DIRS, SOURCE_EXTENSIONS, {
    rootDir,
    ignoreFile: shouldIgnoreSourceFile,
  });
  const dist = latestFile(DIST_DIRS, DIST_EXTENSIONS, { rootDir });
  const buildStamp = readMainBuildStamp(rootDir);
  const entryPoint = getFileInfo(path.join(rootDir, path.relative(ROOT, MAIN_ENTRY_PATH)), rootDir);

  if (!source) {
    return {
      ok: true,
      reason: 'missing_source_tree',
      source: null,
      dist,
      buildStamp,
      lagMs: 0,
    };
  }

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

function formatMainBuildFreshnessWarning(status) {
  if (!status || status.ok) {
    return '';
  }

  if (status.reason === 'missing_dist_artifacts') {
    return 'Local dist artifacts are missing. Electron loads dist/main/index.js; run `npm run build:main` before real-run validation.';
  }

  if (status.reason === 'missing_build_stamp') {
    return 'Main build stamp is missing. Re-run `npm run build:main` before trusting real-run validation.';
  }

  if (status.reason === 'build_stamp_out_of_sync') {
    return 'Main build stamp is out of sync with dist/main. Re-run `npm run build:main` before trusting real-run validation.';
  }

  if (status.reason === 'dist_older_than_source') {
    const lagSeconds =
      typeof status.lagMs === 'number' ? Math.ceil(status.lagMs / 1000) : '?';
    return `Local dist artifacts are older than source by about ${lagSeconds}s. Electron loads dist/main/index.js, so run \`npm run build:main\` and restart Electron before trusting real-run results.`;
  }

  return '';
}

module.exports = {
  getMainBuildFreshness,
  formatMainBuildFreshnessWarning,
  latestFile,
  shouldIgnoreSourceFile,
  DIST_EXTENSIONS,
  SOURCE_EXTENSIONS,
};
