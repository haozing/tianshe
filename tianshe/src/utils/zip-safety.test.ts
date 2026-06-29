import { describe, expect, it } from 'vitest';
import { assertSafeZipEntryPath, assertSafeZipMetadata, type ZipEntryLike } from './zip-safety';

const fileEntry = (entryName: string, size: number, compressedSize: number): ZipEntryLike => ({
  entryName,
  isDirectory: false,
  header: {
    size,
    compressedSize,
  },
});

describe('zip safety utilities', () => {
  it('accepts normal zip metadata and safe paths', () => {
    expect(() =>
      assertSafeZipMetadata([fileEntry('manifest.json', 100, 80)], 'test.zip')
    ).not.toThrow();
    expect(assertSafeZipEntryPath('nested/file.txt', '/tmp/out')).toContain('nested');
  });

  it('rejects too many entries and unsafe compression ratios', () => {
    expect(() =>
      assertSafeZipMetadata(new Array(2001).fill(fileEntry('x.txt', 1, 1)), 'test.zip')
    ).toThrow(/too many entries/);

    expect(() =>
      assertSafeZipMetadata([fileEntry('huge.txt', 101, 1)], 'test.zip', {
        maxEntries: 10,
        maxEntryBytes: 1000,
        maxTotalUncompressedBytes: 1000,
        maxCompressionRatio: 100,
      })
    ).toThrow(/unsafe compression ratio/);
  });

  it('rejects path traversal entries', () => {
    expect(() => assertSafeZipEntryPath('../evil.txt', '/tmp/out')).toThrow(
      /Unsafe zip entry path/
    );
  });
});
