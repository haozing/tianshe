import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import type { RuntimeArtifactFilePayload } from '../core/observability/types';

export type RuntimeArtifactFileStoreErrorCode =
  | 'invalid_artifact_id'
  | 'invalid_filename'
  | 'invalid_storage_key'
  | 'path_escape'
  | 'symlink_escape'
  | 'hardlink_rejected'
  | 'quota_exceeded'
  | 'insufficient_space'
  | 'not_found'
  | 'open_failed';

export class RuntimeArtifactFileStoreError extends Error {
  constructor(readonly code: RuntimeArtifactFileStoreErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeArtifactFileStoreError';
  }
}

export interface RuntimeArtifactFileWriteInput {
  artifactId: string;
  filename: string;
  mimeType?: string;
  retentionPolicy?: string;
  bytes?: Buffer | Uint8Array | string;
  sourcePath?: string;
}

export interface RuntimeArtifactFileStoreOptions {
  rootDir: string;
  perArtifactQuotaBytes?: number;
  totalQuotaBytes?: number;
  getAvailableBytes?: () => Promise<number> | number;
}

export interface RuntimeArtifactTrustedSaveTarget {
  path: string;
  source: 'electron-save-dialog';
}

const RESERVED_WINDOWS_BASENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DEFAULT_PER_ARTIFACT_QUOTA_BYTES = 512 * 1024 * 1024;
const DEFAULT_TOTAL_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.from(String(chunk));
}

function assertInsideRoot(rootDir: string, targetPath: string, raw: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RuntimeArtifactFileStoreError(
      'path_escape',
      `Runtime artifact path escapes managed directory: ${raw}`
    );
  }
}

function isReservedSegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return true;
  }
  const withoutExtension = trimmed.split('.')[0];
  return RESERVED_WINDOWS_BASENAMES.test(withoutExtension);
}

function hasInvalidStorageKeyChars(segment: string): boolean {
  return Array.from(segment).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint < 32 || '<>:"\\|?*'.includes(char);
  });
}

function replaceInvalidPathChars(value: string, includeSlash: boolean): string {
  const forbiddenChars = includeSlash ? '<>:"/\\|?*' : '<>:"\\|?*';
  return Array.from(value)
    .map((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint < 32 || forbiddenChars.includes(char) ? '_' : char;
    })
    .join('');
}

function sanitizePathSegment(value: string, code: RuntimeArtifactFileStoreErrorCode): string {
  const segment = replaceInvalidPathChars(String(value || '').trim(), true)
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/g, '')
    .slice(0, 96);
  if (!segment || isReservedSegment(segment)) {
    throw new RuntimeArtifactFileStoreError(code, `Invalid runtime artifact path segment: ${value}`);
  }
  return segment;
}

function sanitizeFilename(filename: string): string {
  const basename = replaceInvalidPathChars(path.basename(String(filename || '').trim()), true)
    .replace(/[.\s]+$/g, '')
    .slice(0, 160);
  if (!basename || isReservedSegment(basename)) {
    throw new RuntimeArtifactFileStoreError(
      'invalid_filename',
      `Invalid runtime artifact filename: ${filename}`
    );
  }
  return basename;
}

export class RuntimeArtifactFileStore {
  private readonly rootDir: string;
  private readonly tempDir: string;
  private readonly perArtifactQuotaBytes: number;
  private readonly totalQuotaBytes: number;

  constructor(private readonly options: RuntimeArtifactFileStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.tempDir = path.join(this.rootDir, '.tmp');
    this.perArtifactQuotaBytes =
      options.perArtifactQuotaBytes ?? DEFAULT_PER_ARTIFACT_QUOTA_BYTES;
    this.totalQuotaBytes = options.totalQuotaBytes ?? DEFAULT_TOTAL_QUOTA_BYTES;
  }

  getRootDir(): string {
    return this.rootDir;
  }

  async writeFilePayload(input: RuntimeArtifactFileWriteInput): Promise<RuntimeArtifactFilePayload> {
    const artifactSegment = sanitizePathSegment(input.artifactId, 'invalid_artifact_id');
    const filename = sanitizeFilename(input.filename);
    await this.ensureManagedDirectories();

    const expectedSize = await this.getExpectedWriteSize(input);
    if (expectedSize !== null) {
      await this.assertQuotaAvailable(expectedSize);
    }

    const tempPath = path.join(this.tempDir, `${crypto.randomUUID()}.tmp`);
    const source = this.createSourceIterator(input);
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;

    try {
      await this.writeTempFile(tempPath, source, hash, (nextSizeBytes) => {
        sizeBytes = nextSizeBytes;
        if (sizeBytes > this.perArtifactQuotaBytes) {
          throw new RuntimeArtifactFileStoreError(
            'quota_exceeded',
            `Runtime artifact exceeds per-file quota: ${sizeBytes} bytes`
          );
        }
      });

      await this.assertQuotaAvailable(sizeBytes);
      const sha256 = hash.digest('hex');
      const storageKey = [
        sha256.slice(0, 2),
        artifactSegment,
        `${sha256.slice(0, 12)}-${filename}`,
      ].join('/');
      const finalPath = await this.resolveStorageKeyForCreate(storageKey);
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      await fsp.rename(tempPath, finalPath);
      await this.assertExistingFileSafe(storageKey);

      return {
        kind: 'file',
        storageKey,
        contentAddress: `sha256:${sha256}`,
        filename,
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        sizeBytes,
        sha256,
        ...(input.retentionPolicy ? { retentionPolicy: input.retentionPolicy } : {}),
      };
    } catch (error) {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readFilePayload(payload: RuntimeArtifactFilePayload): Promise<Buffer> {
    const filePath = await this.resolveExistingFile(payload.storageKey);
    return await fsp.readFile(filePath);
  }

  async copyFilePayloadToPath(
    payload: RuntimeArtifactFilePayload,
    targetPath: string
  ): Promise<{ bytesWritten: number; sha256: string }> {
    const sourcePath = await this.resolveExistingFile(payload.storageKey);
    const rawTargetPath = String(targetPath || '').trim();
    if (!rawTargetPath) {
      throw new RuntimeArtifactFileStoreError('invalid_storage_key', 'Target path is required');
    }
    const safeTargetPath = path.resolve(rawTargetPath);
    await fsp.mkdir(path.dirname(safeTargetPath), { recursive: true });
    await fsp.copyFile(sourcePath, safeTargetPath);
    return {
      bytesWritten: payload.sizeBytes,
      sha256: payload.sha256,
    };
  }

  async saveFilePayloadAsFromTrustedDialog(
    payload: RuntimeArtifactFilePayload,
    target: RuntimeArtifactTrustedSaveTarget
  ): Promise<{ bytesWritten: number; sha256: string }> {
    if (!target || target.source !== 'electron-save-dialog') {
      throw new RuntimeArtifactFileStoreError(
        'invalid_storage_key',
        'Runtime artifact save target must come from a trusted host save dialog'
      );
    }
    return await this.copyFilePayloadToPath(payload, target.path);
  }

  async deleteFilePayload(payload: RuntimeArtifactFilePayload): Promise<boolean> {
    const targetPath = await this.resolveStorageKey(payload.storageKey);
    try {
      await this.assertExistingFileSafe(payload.storageKey);
    } catch (error) {
      if (error instanceof RuntimeArtifactFileStoreError && error.code === 'not_found') {
        return false;
      }
      throw error;
    }
    await fsp.rm(targetPath, { force: true });
    return true;
  }

  async openFilePayload(payload: RuntimeArtifactFilePayload): Promise<void> {
    const filePath = await this.resolveExistingFile(payload.storageKey);
    const { shell } = await import('electron');
    const errorMessage = await shell.openPath(filePath);
    if (errorMessage) {
      throw new RuntimeArtifactFileStoreError('open_failed', errorMessage);
    }
  }

  async revealFilePayload(payload: RuntimeArtifactFilePayload): Promise<void> {
    const filePath = await this.resolveExistingFile(payload.storageKey);
    const { shell } = await import('electron');
    shell.showItemInFolder(filePath);
  }

  async cleanupOrphanTempFiles(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    await this.ensureManagedDirectories();
    const cutoff = Date.now() - maxAgeMs;
    let deleted = 0;
    for (const entry of await fsp.readdir(this.tempDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const targetPath = path.join(this.tempDir, entry.name);
      const stats = await fsp.stat(targetPath);
      if (stats.mtimeMs < cutoff) {
        await fsp.rm(targetPath, { force: true });
        deleted += 1;
      }
    }
    return deleted;
  }

  async resolveStorageKey(storageKey: string): Promise<string> {
    await this.ensureManagedDirectories();
    const normalized = this.normalizeStorageKey(storageKey);
    const targetPath = path.resolve(this.rootDir, ...normalized.split('/'));
    assertInsideRoot(this.rootDir, targetPath, storageKey);
    await this.assertNoSymlinkEscape(targetPath, false);
    return targetPath;
  }

  private async resolveStorageKeyForCreate(storageKey: string): Promise<string> {
    const targetPath = await this.resolveStorageKey(storageKey);
    try {
      await fsp.lstat(targetPath);
      throw new RuntimeArtifactFileStoreError(
        'invalid_storage_key',
        `Runtime artifact file already exists: ${storageKey}`
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return targetPath;
      }
      throw error;
    }
  }

  private async resolveExistingFile(storageKey: string): Promise<string> {
    const filePath = await this.resolveStorageKey(storageKey);
    await this.assertExistingFileSafe(storageKey);
    return filePath;
  }

  private normalizeStorageKey(storageKey: string): string {
    const raw = String(storageKey || '').trim().replace(/\\/g, '/');
    if (
      !raw ||
      raw.includes('\0') ||
      path.isAbsolute(raw) ||
      /^[a-zA-Z]:\//.test(raw) ||
      raw.startsWith('//')
    ) {
      throw new RuntimeArtifactFileStoreError(
        'invalid_storage_key',
        `Invalid runtime artifact storage key: ${storageKey}`
      );
    }
    const segments = raw.split('/');
    if (segments.some((segment) => isReservedSegment(segment) || hasInvalidStorageKeyChars(segment))) {
      throw new RuntimeArtifactFileStoreError(
        'invalid_storage_key',
        `Invalid runtime artifact storage key: ${storageKey}`
      );
    }
    return segments.join('/');
  }

  private async ensureManagedDirectories(): Promise<void> {
    await fsp.mkdir(this.tempDir, { recursive: true });
  }

  private async getExpectedWriteSize(input: RuntimeArtifactFileWriteInput): Promise<number | null> {
    if (input.bytes !== undefined) {
      return Buffer.byteLength(asBuffer(input.bytes));
    }
    if (input.sourcePath) {
      const stats = await fsp.stat(input.sourcePath);
      if (!stats.isFile()) {
        throw new RuntimeArtifactFileStoreError('not_found', `Source path is not a file`);
      }
      return stats.size;
    }
    return null;
  }

  private async assertQuotaAvailable(incomingBytes: number): Promise<void> {
    if (incomingBytes > this.perArtifactQuotaBytes) {
      throw new RuntimeArtifactFileStoreError(
        'quota_exceeded',
        `Runtime artifact exceeds per-file quota: ${incomingBytes} bytes`
      );
    }

    const availableBytes = this.options.getAvailableBytes
      ? await this.options.getAvailableBytes()
      : await this.getAvailableDiskBytes();
    if (Number.isFinite(availableBytes) && availableBytes < incomingBytes) {
      throw new RuntimeArtifactFileStoreError(
        'insufficient_space',
        `Insufficient space for runtime artifact: ${incomingBytes} bytes requested`
      );
    }

    const managedBytes = await this.getManagedBytes(this.rootDir);
    if (managedBytes + incomingBytes > this.totalQuotaBytes) {
      throw new RuntimeArtifactFileStoreError(
        'quota_exceeded',
        `Runtime artifact store quota exceeded: ${managedBytes + incomingBytes} bytes`
      );
    }
  }

  private createSourceIterator(
    input: RuntimeArtifactFileWriteInput
  ): AsyncIterable<Buffer | Uint8Array | string> {
    if (input.bytes !== undefined) {
      return (async function* () {
        yield input.bytes as Buffer | Uint8Array | string;
      })();
    }
    if (input.sourcePath) {
      return fs.createReadStream(input.sourcePath);
    }
    throw new RuntimeArtifactFileStoreError('not_found', 'Runtime artifact source is required');
  }

  private async getAvailableDiskBytes(): Promise<number> {
    const maybeStatfs = (fsp as unknown as {
      statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
    }).statfs;
    if (!maybeStatfs) {
      return Number.POSITIVE_INFINITY;
    }
    const stats = await maybeStatfs(this.rootDir);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  private async writeTempFile(
    tempPath: string,
    source: AsyncIterable<Buffer | Uint8Array | string>,
    hash: crypto.Hash,
    onSize: (sizeBytes: number) => void
  ): Promise<void> {
    const output = fs.createWriteStream(tempPath, { flags: 'wx' });
    let sizeBytes = 0;
    try {
      for await (const chunk of source) {
        const buffer = asBuffer(chunk);
        sizeBytes += buffer.length;
        onSize(sizeBytes);
        hash.update(buffer);
        if (!output.write(buffer)) {
          await once(output, 'drain');
        }
      }
      output.end();
      await once(output, 'finish');
    } catch (error) {
      output.destroy();
      throw error;
    }
  }

  private async getManagedBytes(dir: string): Promise<number> {
    let total = 0;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.name === '.tmp') {
        continue;
      }
      const targetPath = path.join(dir, entry.name);
      const stats = await fsp.lstat(targetPath);
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        total += await this.getManagedBytes(targetPath);
      } else if (stats.isFile()) {
        total += stats.size;
      }
    }
    return total;
  }

  private async assertNoSymlinkEscape(targetPath: string, mustExist: boolean): Promise<void> {
    const rootRealPath = await fsp.realpath(this.rootDir);
    const relative = path.relative(this.rootDir, targetPath);
    const segments = relative.split(path.sep).filter(Boolean);
    let current = this.rootDir;

    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      try {
        const stats = await fsp.lstat(current);
        if (stats.isSymbolicLink()) {
          throw new RuntimeArtifactFileStoreError(
            'symlink_escape',
            `Runtime artifact path contains symlink: ${segments[index]}`
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !mustExist) {
          break;
        }
        throw error;
      }
    }

    const existingPath = await this.findExistingAncestor(targetPath);
    const existingRealPath = await fsp.realpath(existingPath);
    assertInsideRoot(rootRealPath, existingRealPath, targetPath);
  }

  private async findExistingAncestor(targetPath: string): Promise<string> {
    let current = targetPath;
    while (current && current !== path.dirname(current)) {
      try {
        await fsp.lstat(current);
        return current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        current = path.dirname(current);
      }
    }
    return this.rootDir;
  }

  private async assertExistingFileSafe(storageKey: string): Promise<void> {
    const targetPath = await this.resolveStorageKey(storageKey);
    let stats: fs.Stats;
    try {
      stats = await fsp.lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RuntimeArtifactFileStoreError(
          'not_found',
          `Runtime artifact file not found: ${storageKey}`
        );
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new RuntimeArtifactFileStoreError(
        'symlink_escape',
        `Runtime artifact file is a symlink: ${storageKey}`
      );
    }
    if (!stats.isFile()) {
      throw new RuntimeArtifactFileStoreError(
        'not_found',
        `Runtime artifact payload is not a file: ${storageKey}`
      );
    }
    if (stats.nlink > 1) {
      throw new RuntimeArtifactFileStoreError(
        'hardlink_rejected',
        `Runtime artifact file has multiple hardlinks: ${storageKey}`
      );
    }
  }
}
