import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const {
  getMainBuildFreshness,
  latestFile,
  shouldIgnoreSourceFile,
  SOURCE_EXTENSIONS,
} = require('../../scripts/main-build-freshness');

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airpa-build-freshness-'));
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

describe('main build freshness', () => {
  it('ignores source test files when selecting the latest source file', () => {
    const tempDir = createTempDir();
    const runtimeFile = path.join(tempDir, 'src', 'main', 'runtime.ts');
    const testFile = path.join(tempDir, 'src', 'main', 'runtime.test.ts');
    const nestedTestFile = path.join(tempDir, 'src', 'main', '__tests__', 'helper.ts');

    writeFileWithMtime(runtimeFile, 'export const runtime = true;\n', 1_700_000_000_000);
    writeFileWithMtime(testFile, 'export const testOnly = true;\n', 1_700_000_010_000);
    writeFileWithMtime(nestedTestFile, 'export const nestedTestOnly = true;\n', 1_700_000_020_000);

    const latest = latestFile([path.join(tempDir, 'src')], SOURCE_EXTENSIONS, {
      ignoreFile: shouldIgnoreSourceFile,
    });

    expect(latest?.path).toBe(runtimeFile);
    expect(latest?.relativePath.endsWith(path.join('src', 'main', 'runtime.ts'))).toBe(true);
  });

  it('matches test-like source paths consistently', () => {
    expect(shouldIgnoreSourceFile(path.join('src', 'main', 'feature.test.ts'))).toBe(true);
    expect(shouldIgnoreSourceFile(path.join('src', 'core', 'feature.spec.tsx'))).toBe(true);
    expect(shouldIgnoreSourceFile(path.join('src', 'preload', '__tests__', 'helper.ts'))).toBe(
      true
    );
    expect(shouldIgnoreSourceFile(path.join('src', 'main', 'runtime.ts'))).toBe(false);
  });

  it('requires a successful main build stamp before reporting a fresh build', () => {
    const tempDir = createTempDir();
    const sourceFile = path.join(tempDir, 'src', 'main', 'runtime.ts');
    const distFile = path.join(tempDir, 'dist', 'main', 'index.js');
    const distMtime = 1_700_000_020_000;

    writeFileWithMtime(sourceFile, 'export const runtime = true;\n', 1_700_000_000_000);
    writeFileWithMtime(distFile, 'exports.runtime = true;\n', distMtime);

    expect(getMainBuildFreshness(tempDir)).toMatchObject({
      ok: false,
      reason: 'missing_build_stamp',
    });

    writeFileWithMtime(
      path.join(tempDir, 'dist', 'main', 'airpa-main-build-stamp.json'),
      JSON.stringify(
        {
          schema: 'airpa.main.build-stamp.v1',
          success: true,
          builtAt: new Date(distMtime + 500).toISOString(),
          gitCommit: 'deadbeef',
          entryPoint: 'dist/main/index.js',
          entryPointUpdatedAt: new Date(distMtime).toISOString(),
          generatedBy: 'test',
        },
        null,
        2
      ),
      distMtime + 500
    );

    expect(getMainBuildFreshness(tempDir)).toMatchObject({
      ok: true,
      reason: 'fresh',
      buildStamp: expect.objectContaining({
        entryPoint: 'dist/main/index.js',
      }),
    });
  });
});
