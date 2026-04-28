import path from 'node:path';

export interface ZipEntryLike {
  entryName: string;
  isDirectory: boolean;
  header?: {
    size?: number;
    compressedSize?: number;
  };
}

export interface ZipSafetyLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ZIP_SAFETY_LIMITS: ZipSafetyLimits = {
  maxEntries: 2000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 250 * 1024 * 1024,
  maxCompressionRatio: 100,
};

function readNonNegativeNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

export function assertSafeZipMetadata(
  entries: ZipEntryLike[],
  archiveLabel: string,
  limits: ZipSafetyLimits = DEFAULT_ZIP_SAFETY_LIMITS
): void {
  if (entries.length > limits.maxEntries) {
    throw new Error(
      `Archive ${archiveLabel} has too many entries: ${entries.length} > ${limits.maxEntries}`
    );
  }

  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }

    const entryBytes = readNonNegativeNumber(entry.header?.size);
    const compressedBytes = readNonNegativeNumber(entry.header?.compressedSize);

    if (entryBytes > limits.maxEntryBytes) {
      throw new Error(
        `Archive ${archiveLabel} entry "${entry.entryName}" is too large: ${entryBytes} bytes`
      );
    }

    totalUncompressedBytes += entryBytes;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      throw new Error(
        `Archive ${archiveLabel} expands to too much data: ${totalUncompressedBytes} bytes`
      );
    }

    if (compressedBytes > 0 && entryBytes / compressedBytes > limits.maxCompressionRatio) {
      throw new Error(
        `Archive ${archiveLabel} entry "${entry.entryName}" has an unsafe compression ratio`
      );
    }
  }
}

export function assertSafeZipEntryPath(entryPath: string, targetDir: string): string {
  if (entryPath.includes('..') || path.isAbsolute(entryPath)) {
    throw new Error(`Unsafe zip entry path detected: ${entryPath}`);
  }

  const targetPath = path.join(targetDir, entryPath);
  const resolvedTargetDir = path.resolve(targetDir);
  const resolvedPath = path.resolve(targetPath);

  if (
    !resolvedPath.startsWith(resolvedTargetDir + path.sep) &&
    resolvedPath !== resolvedTargetDir
  ) {
    throw new Error(`Unsafe zip extraction path detected: ${entryPath}`);
  }

  return targetPath;
}
