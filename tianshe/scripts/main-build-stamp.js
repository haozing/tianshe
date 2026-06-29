const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAIN_BUILD_STAMP_RELATIVE_PATH = path.join('dist', 'main', 'airpa-main-build-stamp.json');
const MAIN_BUILD_STAMP_PATH = path.join(ROOT, MAIN_BUILD_STAMP_RELATIVE_PATH);
const MAIN_ENTRY_RELATIVE_PATH = path.join('dist', 'main', 'index.js');
const MAIN_ENTRY_PATH = path.join(ROOT, MAIN_ENTRY_RELATIVE_PATH);
const MAIN_BUILD_STAMP_SCHEMA = 'airpa.main.build-stamp.v1';
const FILE_MTIME_TOLERANCE_MS = 1000;

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function getFileInfo(filePath, rootDir = ROOT) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return {
      path: filePath,
      relativePath: normalizeRelativePath(path.relative(rootDir, filePath)),
      mtimeMs: stat.mtimeMs,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

function resolveGitDir(rootDir = ROOT) {
  const gitEntry = path.join(rootDir, '.git');
  try {
    const stat = fs.statSync(gitEntry);
    if (stat.isDirectory()) {
      return gitEntry;
    }
    const pointer = fs.readFileSync(gitEntry, 'utf8').trim();
    if (!pointer.toLowerCase().startsWith('gitdir:')) {
      return null;
    }
    return path.resolve(rootDir, pointer.slice('gitdir:'.length).trim());
  } catch {
    return null;
  }
}

function readPackedRef(gitDir, refName) {
  try {
    const packedRefs = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const match = packedRefs
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(
        (line) =>
          line &&
          !line.startsWith('#') &&
          !line.startsWith('^') &&
          line.endsWith(` ${refName}`)
      );
    if (!match) {
      return null;
    }
    const [commit] = match.split(' ');
    return /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

function readGitCommit(rootDir = ROOT) {
  const gitDir = resolveGitDir(rootDir);
  if (!gitDir) {
    return null;
  }

  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{7,40}$/i.test(head)) {
      return head;
    }
    if (!head.toLowerCase().startsWith('ref:')) {
      return null;
    }
    const refName = head.slice('ref:'.length).trim();
    const looseRefPath = path.join(gitDir, ...refName.split('/'));
    if (fs.existsSync(looseRefPath)) {
      const commit = fs.readFileSync(looseRefPath, 'utf8').trim();
      return /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null;
    }
    return readPackedRef(gitDir, refName);
  } catch {
    return null;
  }
}

function readMainBuildStamp(rootDir = ROOT) {
  const stampPath = path.join(rootDir, MAIN_BUILD_STAMP_RELATIVE_PATH);
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (
      !parsed ||
      parsed.schema !== MAIN_BUILD_STAMP_SCHEMA ||
      parsed.success !== true ||
      typeof parsed.builtAt !== 'string' ||
      typeof parsed.entryPoint !== 'string' ||
      typeof parsed.entryPointUpdatedAt !== 'string'
    ) {
      return null;
    }

    return {
      schema: parsed.schema,
      success: true,
      builtAt: parsed.builtAt,
      gitCommit: typeof parsed.gitCommit === 'string' ? parsed.gitCommit : null,
      entryPoint: normalizeRelativePath(parsed.entryPoint),
      entryPointUpdatedAt: parsed.entryPointUpdatedAt,
      generatedBy: typeof parsed.generatedBy === 'string' ? parsed.generatedBy : null,
    };
  } catch {
    return null;
  }
}

function isMainBuildStampAligned(
  stamp,
  entryPoint = getFileInfo(MAIN_ENTRY_PATH, ROOT)
) {
  if (!stamp || !entryPoint) {
    return false;
  }
  const stampedMs = Date.parse(String(stamp.entryPointUpdatedAt || ''));
  if (!Number.isFinite(stampedMs)) {
    return false;
  }
  return Math.abs(entryPoint.mtimeMs - stampedMs) <= FILE_MTIME_TOLERANCE_MS;
}

function writeMainBuildStamp(rootDir = ROOT) {
  const entryPoint = getFileInfo(path.join(rootDir, MAIN_ENTRY_RELATIVE_PATH), rootDir);
  if (!entryPoint) {
    throw new Error(
      `Main build entry point is missing: ${normalizeRelativePath(MAIN_ENTRY_RELATIVE_PATH)}`
    );
  }

  const stamp = {
    schema: MAIN_BUILD_STAMP_SCHEMA,
    success: true,
    builtAt: new Date().toISOString(),
    gitCommit: readGitCommit(rootDir),
    entryPoint: entryPoint.relativePath,
    entryPointUpdatedAt: entryPoint.updatedAt,
    generatedBy: 'scripts/build-main-with-stamp.js',
  };

  const stampPath = path.join(rootDir, MAIN_BUILD_STAMP_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
  return stamp;
}

module.exports = {
  MAIN_BUILD_STAMP_PATH,
  MAIN_BUILD_STAMP_RELATIVE_PATH,
  MAIN_BUILD_STAMP_SCHEMA,
  MAIN_ENTRY_PATH,
  MAIN_ENTRY_RELATIVE_PATH,
  getFileInfo,
  isMainBuildStampAligned,
  readGitCommit,
  readMainBuildStamp,
  writeMainBuildStamp,
};
