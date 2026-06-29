import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertModelInfoHasSha256,
  safeExtractModelZip,
  verifyFileSha256,
} from './model-download-safety';
import type { ModelInfo } from './types';

const tmpRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-download-safety-'));
  tmpRoots.push(dir);
  return dir;
}

function makeModelInfo(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    name: 'test-model',
    version: '1.0.0',
    size: 4,
    url: 'https://example.test/model.onnx',
    sha256: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7',
    featureDim: 1,
    inputSize: [1, 1],
    ...overrides,
  };
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('model-download-safety', () => {
  it('requires a valid SHA256 checksum in model metadata', () => {
    expect(assertModelInfoHasSha256(makeModelInfo({}))).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertModelInfoHasSha256(makeModelInfo({ sha256: '' }))).toThrow(/valid SHA256/);
    expect(() => assertModelInfoHasSha256(makeModelInfo({ sha256: 'not-a-hash' }))).toThrow(
      /valid SHA256/
    );
  });

  it('verifies downloaded file checksums', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'model.onnx');
    fs.writeFileSync(filePath, 'data');

    await expect(
      verifyFileSha256(filePath, '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7')
    ).resolves.toBeUndefined();
    await expect(
      verifyFileSha256(filePath, '0000000000000000000000000000000000000000000000000000000000000000')
    ).rejects.toThrow(/checksum mismatch/i);
  });

  it('extracts only safe model zip entries', () => {
    const dir = makeTempDir();
    safeExtractModelZip(
      {
        getEntries: () => [
          {
            entryName: 'bundle/model.onnx',
            isDirectory: false,
            header: { size: 4, compressedSize: 4 },
            getData: () => Buffer.from('data'),
          },
        ],
      },
      dir
    );

    expect(fs.readFileSync(path.join(dir, 'bundle', 'model.onnx'), 'utf8')).toBe('data');
  });

  it('rejects unsafe zip entry paths before extraction', () => {
    const dir = makeTempDir();
    expect(() =>
      safeExtractModelZip(
        {
          getEntries: () => [
            {
              entryName: '../evil.onnx',
              isDirectory: false,
              header: { size: 4, compressedSize: 4 },
              getData: () => Buffer.from('evil'),
            },
          ],
        },
        dir
      )
    ).toThrow(/unsafe zip entry path/i);
    expect(fs.existsSync(path.join(path.dirname(dir), 'evil.onnx'))).toBe(false);
  });
});
