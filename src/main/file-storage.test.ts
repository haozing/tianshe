import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileStorage,
  MAX_ATTACHMENT_BASE64_PREVIEW_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
} from './file-storage';

let userDataRoot = '';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataRoot),
  },
}));

describe('FileStorage path boundaries', () => {
  beforeEach(async () => {
    userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tianshe-file-storage-'));
  });

  afterEach(async () => {
    if (userDataRoot) {
      await fs.remove(userDataRoot);
    }
  });

  it('keeps saved files inside the attachments root', async () => {
    const storage = new FileStorage();

    const metadata = await storage.saveFile('dataset-123', Buffer.from('hello'), 'notes.txt');
    const fullPath = storage.getFilePath(metadata.path);

    expect(path.resolve(fullPath).startsWith(path.resolve(userDataRoot, 'attachments'))).toBe(true);
    await expect(fs.readFile(fullPath, 'utf8')).resolves.toBe('hello');
  });

  it('copies attachment uploads from an existing local path without buffering in the caller', async () => {
    const storage = new FileStorage();
    const sourcePath = path.join(userDataRoot, 'source.csv');
    await fs.writeFile(sourcePath, 'name\nAlice\n');

    const metadata = await storage.saveFileFromPath('dataset-123', sourcePath, 'source.csv');

    await expect(fs.readFile(storage.getFilePath(metadata.path), 'utf8')).resolves.toBe(
      'name\nAlice\n'
    );
  });

  it('rejects oversized attachment uploads before copying them', async () => {
    const storage = new FileStorage();
    const sourcePath = path.join(userDataRoot, 'large.bin');
    await fs.writeFile(sourcePath, Buffer.from('hello'));

    await expect(
      storage.saveFileFromPath('dataset-123', sourcePath, 'large.bin', 1)
    ).rejects.toThrow(/too large to upload/);
  });

  it('rejects files that exceed the Base64 preview limit before reading them', async () => {
    const storage = new FileStorage();
    const metadata = await storage.saveFile('dataset-123', Buffer.from('hello'), 'notes.txt');

    await expect(storage.getFileAsBase64(metadata.path, 1)).rejects.toThrow(
      /too large to preview as Base64/
    );
  });

  it('keeps the default Base64 preview limit bounded', () => {
    expect(MAX_ATTACHMENT_BASE64_PREVIEW_BYTES).toBe(10 * 1024 * 1024);
  });

  it('keeps the default attachment upload limit bounded', () => {
    expect(MAX_ATTACHMENT_UPLOAD_BYTES).toBe(500 * 1024 * 1024);
  });

  it('rejects traversal reads and deletes outside the attachments root', async () => {
    const storage = new FileStorage();

    expect(() => storage.getFilePath('../../../outside.txt')).toThrow(/非法文件路径/);
    await expect(storage.getFileAsBase64('../../../outside.txt')).rejects.toThrow(/非法文件路径/);
    await expect(storage.deleteFile('../../../outside.txt')).rejects.toThrow(/非法文件路径/);
  });

  it('rejects absolute paths and Windows drive paths', () => {
    const storage = new FileStorage();

    expect(() => storage.getFilePath(path.resolve(userDataRoot, 'secret.txt'))).toThrow(
      /非法文件路径/
    );
    expect(() => storage.getFilePath('C:\\Windows\\win.ini')).toThrow(/非法文件路径/);
    expect(() => storage.getFilePath('\\\\server\\share\\secret.txt')).toThrow(/非法文件路径/);
  });

  it('rejects dataset ids that contain path syntax', async () => {
    const storage = new FileStorage();

    await expect(storage.saveFile('../escape', Buffer.from('x'), 'x.txt')).rejects.toThrow(
      /Invalid dataset ID format/
    );
    await expect(storage.deleteDatasetFiles('../escape')).rejects.toThrow(
      /Invalid dataset ID format/
    );
  });
});
