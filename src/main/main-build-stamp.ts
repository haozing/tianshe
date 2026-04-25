import fs from 'node:fs';
import path from 'node:path';

export interface MainBuildArtifactInfo {
  path: string;
  relativePath: string;
  mtimeMs: number;
  updatedAt: string;
}

export interface MainBuildStamp {
  schema: 'airpa.main.build-stamp.v1';
  success: true;
  builtAt: string;
  gitCommit: string | null;
  entryPoint: string;
  entryPointUpdatedAt: string;
  generatedBy: string | null;
}

export const MAIN_BUILD_STAMP_SCHEMA = 'airpa.main.build-stamp.v1' as const;
export const MAIN_BUILD_STAMP_RELATIVE_PATH = path.join(
  'dist',
  'main',
  'airpa-main-build-stamp.json'
);
export const MAIN_ENTRY_RELATIVE_PATH = path.join('dist', 'main', 'index.js');
const FILE_MTIME_TOLERANCE_MS = 1000;

const normalizeRelativePath = (value: string): string => value.replace(/\\/g, '/');

export const getBuildArtifactInfo = (
  filePath: string,
  rootDir: string = path.resolve(__dirname, '../..')
): MainBuildArtifactInfo | null => {
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
};

function resolveGitDir(rootDir: string): string | null {
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

function readPackedRef(gitDir: string, refName: string): string | null {
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

export function readGitCommit(
  rootDir: string = path.resolve(__dirname, '../..')
): string | null {
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

export function readMainBuildStamp(
  rootDir: string = path.resolve(__dirname, '../..')
): MainBuildStamp | null {
  const stampPath = path.join(rootDir, MAIN_BUILD_STAMP_RELATIVE_PATH);
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath, 'utf8')) as Partial<MainBuildStamp>;
    if (
      parsed.schema !== MAIN_BUILD_STAMP_SCHEMA ||
      parsed.success !== true ||
      typeof parsed.builtAt !== 'string' ||
      typeof parsed.entryPoint !== 'string' ||
      typeof parsed.entryPointUpdatedAt !== 'string'
    ) {
      return null;
    }

    return {
      schema: MAIN_BUILD_STAMP_SCHEMA,
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

export function isMainBuildStampAligned(
  stamp: MainBuildStamp | null,
  entryPoint:
    | MainBuildArtifactInfo
    | null = getBuildArtifactInfo(path.join(path.resolve(__dirname, '../..'), MAIN_ENTRY_RELATIVE_PATH))
): boolean {
  if (!stamp || !entryPoint) {
    return false;
  }
  const stampedMs = Date.parse(stamp.entryPointUpdatedAt);
  if (!Number.isFinite(stampedMs)) {
    return false;
  }
  return Math.abs(entryPoint.mtimeMs - stampedMs) <= FILE_MTIME_TOLERANCE_MS;
}
