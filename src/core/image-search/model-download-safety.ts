import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertSafeZipEntryPath,
  assertSafeZipMetadata,
  type ZipEntryLike,
  type ZipSafetyLimits,
} from '../../utils/zip-safety';
import type { ModelInfo } from './types';

export const MAX_MODEL_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export const MODEL_ZIP_SAFETY_LIMITS: ZipSafetyLimits = {
  maxEntries: 128,
  maxEntryBytes: MAX_MODEL_DOWNLOAD_BYTES,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 100,
};

interface ModelZipEntryLike extends ZipEntryLike {
  getData(): Buffer;
}

interface ModelZipLike {
  getEntries(): ModelZipEntryLike[];
}

export function assertModelInfoHasSha256(modelInfo: ModelInfo): string {
  const sha256 = String(modelInfo.sha256 || '')
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Model ${modelInfo.name} is missing a valid SHA256 checksum`);
  }
  return sha256;
}

export async function verifyFileSha256(filePath: string, expectedSha256: string): Promise<void> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  const actualSha256 = hash.digest('hex');
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`Model checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
}

export function safeExtractModelZip(zip: ModelZipLike, targetDir: string): void {
  const entries = zip.getEntries();
  assertSafeZipMetadata(entries, 'image-search model', MODEL_ZIP_SAFETY_LIMITS);

  for (const entry of entries) {
    const targetPath = assertSafeZipEntryPath(entry.entryName, targetDir);
    if (entry.isDirectory) {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, entry.getData());
  }
}
