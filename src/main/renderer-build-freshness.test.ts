import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getRendererBuildFreshness,
  latestFile,
  shouldIgnoreRendererSourceFile,
} from './renderer-build-freshness';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airpa-renderer-freshness-'));
  tempDirs.push(dir);
  return dir;
}

function writeFileWithMtime(filePath: string, content: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  const timestamp = new Date(mtimeMs);
  fs.utimesSync(filePath, timestamp, timestamp);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('renderer build freshness', () => {
  it('ignores renderer test files when selecting the latest source file', () => {
    const tempDir = createTempDir();
    const runtimeFile = path.join(tempDir, 'src', 'renderer', 'src', 'App.tsx');
    const testFile = path.join(tempDir, 'src', 'renderer', 'src', 'App.test.tsx');
    const nestedTestFile = path.join(tempDir, 'src', 'renderer', 'src', '__tests__', 'helper.ts');

    writeFileWithMtime(runtimeFile, 'export const App = null;\n', 1_700_000_000_000);
    writeFileWithMtime(testFile, 'export const testOnly = true;\n', 1_700_000_010_000);
    writeFileWithMtime(nestedTestFile, 'export const nestedTestOnly = true;\n', 1_700_000_020_000);

    const latest = latestFile([path.join(tempDir, 'src', 'renderer')], new Set(['.ts', '.tsx']), {
      rootDir: tempDir,
      ignoreFile: shouldIgnoreRendererSourceFile,
    });

    expect(latest?.path).toBe(runtimeFile);
  });

  it('detects stale renderer dist compared with runtime source', () => {
    const tempDir = createTempDir();
    const sourceFile = path.join(tempDir, 'src', 'renderer', 'src', 'App.tsx');
    const distHtml = path.join(tempDir, 'dist', 'renderer', 'index.html');
    const distJs = path.join(tempDir, 'dist', 'renderer', 'assets', 'index.js');

    writeFileWithMtime(sourceFile, 'export const App = null;\n', 1_700_000_020_000);
    writeFileWithMtime(distHtml, '<html></html>\n', 1_700_000_000_000);
    writeFileWithMtime(distJs, 'console.log("renderer");\n', 1_700_000_010_000);

    const status = getRendererBuildFreshness(tempDir);

    expect(status.ok).toBe(false);
    expect(status.reason).toBe('dist_older_than_source');
    expect(status.source?.path).toBe(sourceFile);
    expect(status.dist?.path).toBe(distJs);
    expect(status.lagMs).toBeGreaterThan(0);
  });
});
