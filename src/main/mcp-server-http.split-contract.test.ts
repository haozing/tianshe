import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MAX_FOCUSED_TEST_LINES = 1500;

function countLines(filePath: string): number {
  return readFileSync(filePath, 'utf8').split(/\r?\n/).length;
}

describe('large test file split contract', () => {
  it('keeps MCP HTTP and dataset store focused test files under the maintenance limit', () => {
    const mainDir = resolve(process.cwd(), 'src/main');
    const mcpHttpTests = readdirSync(mainDir)
      .filter((fileName) => /^mcp-server-http.*\.test\.ts$/.test(fileName))
      .map((fileName) => resolve(mainDir, fileName));
    const datasetStoreTest = resolve(
      process.cwd(),
      'src/renderer/src/stores/__tests__/datasetStore.test.ts'
    );
    const testFiles = [...mcpHttpTests, datasetStoreTest].filter((filePath) =>
      existsSync(filePath)
    );

    const oversized = testFiles
      .map((filePath) => ({
        filePath,
        lines: countLines(filePath),
      }))
      .filter((entry) => entry.lines > MAX_FOCUSED_TEST_LINES);

    expect(oversized).toEqual([]);
  });
});
