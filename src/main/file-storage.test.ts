import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileStorage } from './file-storage';

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
