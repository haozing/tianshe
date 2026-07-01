import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
  RuntimeArtifactFileStore,
  RuntimeArtifactFileStoreError,
} from './runtime-artifact-file-store';

describe('RuntimeArtifactFileStore', () => {
  let tempDir: string;
  let store: RuntimeArtifactFileStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-artifacts-'));
    store = new RuntimeArtifactFileStore({
      rootDir: tempDir,
      getAvailableBytes: () => 1024 * 1024 * 1024,
    });
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('writes a file-backed payload that survives a store restart without exposing a real path', async () => {
    const bytes = Buffer.from('hello runtime artifact');
    const payload = await store.writeFilePayload({
      artifactId: 'artifact-1',
      filename: 'evidence.txt',
      mimeType: 'text/plain',
      bytes,
      retentionPolicy: '7d',
    });

    expect(payload).toMatchObject({
      kind: 'file',
      filename: 'evidence.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.length,
      retentionPolicy: '7d',
    });
    expect(payload.storageKey).not.toContain(tempDir);
    expect(payload.sha256).toHaveLength(64);

    const restartedStore = new RuntimeArtifactFileStore({
      rootDir: tempDir,
      getAvailableBytes: () => 1024 * 1024 * 1024,
    });
    await expect(restartedStore.readFilePayload(payload)).resolves.toEqual(
      bytes
    );
  });

  it('rejects storage keys that escape the managed directory', async () => {
    const payload = await store.writeFilePayload({
      artifactId: 'artifact-2',
      filename: 'safe.txt',
      bytes: 'safe',
    });

    await expect(
      store.readFilePayload({ ...payload, storageKey: '../outside.txt' })
    ).rejects.toMatchObject({
      code: 'invalid_storage_key',
    });
    await expect(
      store.copyFilePayloadToPath({ ...payload, storageKey: 'C:/outside.txt' }, path.join(tempDir, 'x'))
    ).rejects.toMatchObject({
      code: 'invalid_storage_key',
    });
    await expect(
      store.readFilePayload({ ...payload, storageKey: 'aa/artifact:b/file.txt' })
    ).rejects.toMatchObject({
      code: 'invalid_storage_key',
    });
  });

  it('rejects symlink escapes when the platform permits symlink creation', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-artifacts-outside-'));
    const linkPath = path.join(tempDir, 'aa');
    try {
      await fs.ensureDir(path.join(outsideDir, 'artifact'));
      await fs.symlink(outsideDir, linkPath, 'dir');
    } catch {
      await fs.remove(outsideDir);
      return;
    }

    try {
      await expect(store.resolveStorageKey('aa/artifact/file.txt')).rejects.toMatchObject({
        code: 'symlink_escape',
      });
    } finally {
      await fs.remove(outsideDir);
    }
  });

  it('fails before creating a payload when quotas or disk checks reject the file', async () => {
    const quotaStore = new RuntimeArtifactFileStore({
      rootDir: tempDir,
      perArtifactQuotaBytes: 3,
      getAvailableBytes: () => 1024,
    });
    await expect(
      quotaStore.writeFilePayload({
        artifactId: 'artifact-3',
        filename: 'too-large.txt',
        bytes: 'abcd',
      })
    ).rejects.toMatchObject({
      code: 'quota_exceeded',
    });

    const diskStore = new RuntimeArtifactFileStore({
      rootDir: tempDir,
      getAvailableBytes: () => 1,
    });
    await expect(
      diskStore.writeFilePayload({
        artifactId: 'artifact-4',
        filename: 'disk-full.txt',
        bytes: 'abcd',
      })
    ).rejects.toMatchObject({
      code: 'insufficient_space',
    });
  });

  it('deletes only files addressed by file payloads', async () => {
    const payload = await store.writeFilePayload({
      artifactId: 'artifact-5',
      filename: 'delete.txt',
      bytes: 'delete me',
    });
    await expect(store.deleteFilePayload(payload)).resolves.toBe(true);
    await expect(store.deleteFilePayload(payload)).resolves.toBe(false);
  });

  it('uses structured error codes for invalid filenames', async () => {
    await expect(
      store.writeFilePayload({
        artifactId: 'artifact-6',
        filename: 'CON',
        bytes: 'bad',
      })
    ).rejects.toBeInstanceOf(RuntimeArtifactFileStoreError);
  });

  it('requires an explicit trusted host dialog source for saveAs exports', async () => {
    const payload = await store.writeFilePayload({
      artifactId: 'artifact-7',
      filename: 'export.txt',
      bytes: 'export me',
    });
    const outputPath = path.join(tempDir, 'exports', 'export.txt');

    await expect(
      store.saveFilePayloadAsFromTrustedDialog(payload, {
        path: outputPath,
        source: 'electron-save-dialog',
      })
    ).resolves.toEqual({
      bytesWritten: payload.sizeBytes,
      sha256: payload.sha256,
    });
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('export me');
    await expect(
      store.saveFilePayloadAsFromTrustedDialog(payload, {
        path: outputPath,
        source: 'renderer' as never,
      })
    ).rejects.toMatchObject({
      code: 'invalid_storage_key',
    });
  });
});
