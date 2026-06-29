/**
 * 文件存储服务
 * 负责附件的保存、删除和访问
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { app } from 'electron';
import { createLogger } from '../core/logger';
import type { AttachmentMetadata } from './duckdb/types';
import { getUnknownErrorMessage } from './ipc-utils';

const logger = createLogger('FileStorage');

export const MAX_ATTACHMENT_BASE64_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_UPLOAD_BYTES = 500 * 1024 * 1024;
const DATASET_CLEANUP_BACKLOG_FILE = 'dataset-cleanup-backlog.json';

interface DatasetCleanupBacklogEntry {
  datasetId: string;
  kind: 'attachment-dir' | 'dataset-file';
  targetPath?: string;
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

export class FileStorage {
  private basePath: string;

  constructor() {
    // 存储到用户数据目录/attachments
    this.basePath = path.join(app.getPath('userData'), 'attachments');
    this.ensureBaseDir();
  }

  /**
   * 确保基础目录存在
   */
  private ensureBaseDir(): void {
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  private sanitizeDatasetId(datasetId: string): string {
    const value = String(datasetId || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
      throw new Error(
        `Invalid dataset ID format: ${datasetId}. Only alphanumeric characters, underscores, and hyphens are allowed.`
      );
    }
    return value;
  }

  private resolveSafePath(relativePath: string): string {
    const raw = String(relativePath || '').trim();
    if (!raw) {
      throw new Error('文件路径不能为空');
    }
    if (raw.includes('\0')) {
      throw new Error('文件路径包含非法字符');
    }
    if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
      throw new Error(`非法文件路径: ${relativePath}`);
    }

    const resolvedBase = path.resolve(this.basePath);
    const resolvedTarget = path.resolve(resolvedBase, raw);
    const relativeToBase = path.relative(resolvedBase, resolvedTarget);

    if (
      relativeToBase === '' ||
      relativeToBase.startsWith('..') ||
      path.isAbsolute(relativeToBase)
    ) {
      throw new Error(`非法文件路径: ${relativePath}`);
    }

    return resolvedTarget;
  }

  /**
   * 获取数据集专属目录
   */
  private getDatasetDir(datasetId: string): string {
    return path.join(this.basePath, this.sanitizeDatasetId(datasetId));
  }

  private getCleanupBacklogPath(): string {
    return path.join(path.dirname(this.basePath), DATASET_CLEANUP_BACKLOG_FILE);
  }

  private resolveSafeUserDataPath(targetPath: string): string {
    const resolvedUserData = path.resolve(path.dirname(this.basePath));
    const resolvedTarget = path.resolve(String(targetPath || '').trim());
    const relativeToUserData = path.relative(resolvedUserData, resolvedTarget);

    if (
      !resolvedTarget ||
      relativeToUserData === '' ||
      relativeToUserData.startsWith('..') ||
      path.isAbsolute(relativeToUserData)
    ) {
      throw new Error(`Unsafe dataset cleanup target path: ${targetPath}`);
    }

    return resolvedTarget;
  }

  /**
   * 确保数据集目录存在
   */
  private ensureDatasetDir(datasetId: string): void {
    const datasetDir = this.getDatasetDir(datasetId);
    if (!fs.existsSync(datasetDir)) {
      fs.mkdirSync(datasetDir, { recursive: true });
    }
  }

  /**
   * 生成唯一文件名
   */
  private generateUniqueFilename(originalFilename: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(originalFilename);
    const basename = path.basename(originalFilename, ext);
    return `${basename}_${timestamp}_${random}${ext}`;
  }

  /**
   * 获取文件MIME类型
   */
  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.zip': 'application/zip',
      '.rar': 'application/x-rar-compressed',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * 保存文件
   * @param datasetId 数据集ID
   * @param fileBuffer 文件数据
   * @param originalFilename 原始文件名
   * @returns 文件元数据
   */
  async saveFile(
    datasetId: string,
    fileBuffer: Buffer,
    originalFilename: string,
    maxBytes = MAX_ATTACHMENT_UPLOAD_BYTES
  ): Promise<AttachmentMetadata> {
    try {
      if (fileBuffer.length > maxBytes) {
        throw new Error(
          `File is too large to upload: ${fileBuffer.length} bytes (max ${maxBytes} bytes)`
        );
      }

      const safeDatasetId = this.sanitizeDatasetId(datasetId);

      // 确保目录存在
      this.ensureDatasetDir(safeDatasetId);

      // 生成唯一文件名
      const uniqueFilename = this.generateUniqueFilename(originalFilename);
      const datasetDir = this.getDatasetDir(safeDatasetId);
      const fullPath = path.join(datasetDir, uniqueFilename);

      // 保存文件
      await fs.writeFile(fullPath, fileBuffer);

      // 构建相对路径（相对于basePath）
      const relativePath = path.join(safeDatasetId, uniqueFilename);

      // 生成元数据
      const metadata: AttachmentMetadata = {
        id: `${safeDatasetId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        filename: originalFilename,
        size: fileBuffer.length,
        uploadTime: Date.now(),
        path: relativePath,
        mimeType: this.getMimeType(originalFilename),
      };

      return metadata;
    } catch (error: unknown) {
      logger.error('Failed to save file', { datasetId, originalFilename, error });
      throw new Error(`保存文件失败: ${getUnknownErrorMessage(error)}`);
    }
  }

  async saveFileFromPath(
    datasetId: string,
    sourcePath: string,
    originalFilename = path.basename(sourcePath),
    maxBytes = MAX_ATTACHMENT_UPLOAD_BYTES
  ): Promise<AttachmentMetadata> {
    try {
      const stats = await fs.stat(sourcePath);
      if (!stats.isFile()) {
        throw new Error('Path is not a file');
      }
      if (stats.size > maxBytes) {
        throw new Error(`File is too large to upload: ${stats.size} bytes (max ${maxBytes} bytes)`);
      }

      const safeDatasetId = this.sanitizeDatasetId(datasetId);
      this.ensureDatasetDir(safeDatasetId);

      const uniqueFilename = this.generateUniqueFilename(originalFilename);
      const datasetDir = this.getDatasetDir(safeDatasetId);
      const fullPath = path.join(datasetDir, uniqueFilename);

      await fs.copy(sourcePath, fullPath, { overwrite: false, errorOnExist: true });

      const relativePath = path.join(safeDatasetId, uniqueFilename);
      return {
        id: `${safeDatasetId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        filename: originalFilename,
        size: stats.size,
        uploadTime: Date.now(),
        path: relativePath,
        mimeType: this.getMimeType(originalFilename),
      };
    } catch (error: unknown) {
      logger.error('Failed to save file from path', {
        datasetId,
        sourcePath,
        originalFilename,
        error,
      });
      throw new Error(`保存文件失败: ${getUnknownErrorMessage(error)}`);
    }
  }

  /**
   * 删除文件
   * @param relativePath 相对路径
   */
  async deleteFile(relativePath: string): Promise<void> {
    try {
      const fullPath = this.resolveSafePath(relativePath);

      if (fs.existsSync(fullPath)) {
        await fs.unlink(fullPath);
        logger.info('File deleted', { relativePath });
      } else {
        logger.warn('File not found while deleting', { relativePath });
      }
    } catch (error: unknown) {
      logger.error('Failed to delete file', { relativePath, error });
      throw new Error(`删除文件失败: ${getUnknownErrorMessage(error)}`);
    }
  }

  /**
   * 获取文件的绝对路径
   * @param relativePath 相对路径
   * @returns 绝对路径
   */
  getFilePath(relativePath: string): string {
    return this.resolveSafePath(relativePath);
  }

  /**
   * 获取文件访问URL（file://协议）
   * @param relativePath 相对路径
   * @returns 文件URL
   */
  getFileUrl(relativePath: string): string {
    const fullPath = this.getFilePath(relativePath);
    // Windows路径需要特殊处理
    const normalizedPath = fullPath.replace(/\\/g, '/');
    return `file:///${normalizedPath}`;
  }

  /**
   * 检查文件是否存在
   * @param relativePath 相对路径
   * @returns 是否存在
   */
  fileExists(relativePath: string): boolean {
    const fullPath = this.getFilePath(relativePath);
    return fs.existsSync(fullPath);
  }

  /**
   * 获取文件作为 Base64 字符串（用于在渲染进程中显示图片）
   * @param relativePath 相对路径
   * @returns Base64 data URL
   */
  async getFileAsBase64(
    relativePath: string,
    maxBytes = MAX_ATTACHMENT_BASE64_PREVIEW_BYTES
  ): Promise<string> {
    try {
      const fullPath = this.getFilePath(relativePath);

      if (!fs.existsSync(fullPath)) {
        throw new Error('文件不存在');
      }

      const stats = await fs.stat(fullPath);
      if (!stats.isFile()) {
        throw new Error('Path is not a file');
      }
      if (stats.size > maxBytes) {
        throw new Error(
          `File is too large to preview as Base64: ${stats.size} bytes (max ${maxBytes} bytes)`
        );
      }

      // 读取文件
      const fileBuffer = await fs.readFile(fullPath);

      // 获取 MIME 类型
      const filename = path.basename(relativePath);
      const mimeType = this.getMimeType(filename);

      // 转换为 Base64 data URL
      const base64 = fileBuffer.toString('base64');
      return `data:${mimeType};base64,${base64}`;
    } catch (error: unknown) {
      logger.error('Failed to read file as Base64', { relativePath, maxBytes, error });
      throw new Error(`读取文件失败: ${getUnknownErrorMessage(error)}`);
    }
  }

  /**
   * 删除整个数据集的附件
   * @param datasetId 数据集ID
   */
  async deleteDatasetFiles(datasetId: string): Promise<void> {
    try {
      const datasetDir = this.getDatasetDir(datasetId);

      if (fs.existsSync(datasetDir)) {
        await fs.remove(datasetDir);
        logger.info('Dataset files deleted', { datasetId });
      }
    } catch (error: unknown) {
      logger.error('Failed to delete dataset files', { datasetId, error });
      throw new Error(`删除数据集文件失败: ${getUnknownErrorMessage(error)}`);
    }
  }

  async enqueueDeferredDatasetFilesCleanup(
    datasetId: string,
    error?: unknown
  ): Promise<void> {
    const safeDatasetId = this.sanitizeDatasetId(datasetId);
    const entries = await this.readCleanupBacklog();
    const existing = entries.find(
      (entry) => entry.kind === 'attachment-dir' && entry.datasetId === safeDatasetId
    );

    if (existing) {
      existing.lastError = error === undefined ? existing.lastError : getUnknownErrorMessage(error);
      return await this.writeCleanupBacklog(entries);
    }

    entries.push({
      datasetId: safeDatasetId,
      kind: 'attachment-dir',
      queuedAt: Date.now(),
      attempts: 0,
      ...(error === undefined ? {} : { lastError: getUnknownErrorMessage(error) }),
    });
    await this.writeCleanupBacklog(entries);
  }

  async enqueueDeferredDatasetFileCleanup(
    datasetId: string,
    targetPath: string,
    error?: unknown
  ): Promise<void> {
    const safeDatasetId = this.sanitizeDatasetId(datasetId);
    const safeTargetPath = this.resolveSafeUserDataPath(targetPath);
    const entries = await this.readCleanupBacklog();
    const existing = entries.find(
      (entry) =>
        entry.kind === 'dataset-file' &&
        entry.datasetId === safeDatasetId &&
        entry.targetPath === safeTargetPath
    );

    if (existing) {
      existing.lastError = error === undefined ? existing.lastError : getUnknownErrorMessage(error);
      return await this.writeCleanupBacklog(entries);
    }

    entries.push({
      datasetId: safeDatasetId,
      kind: 'dataset-file',
      targetPath: safeTargetPath,
      queuedAt: Date.now(),
      attempts: 0,
      ...(error === undefined ? {} : { lastError: getUnknownErrorMessage(error) }),
    });
    await this.writeCleanupBacklog(entries);
  }

  async sweepDeferredDatasetFilesCleanup(): Promise<{
    removed: number;
    remaining: number;
  }> {
    const entries = await this.readCleanupBacklog();
    let removed = 0;
    const remaining: DatasetCleanupBacklogEntry[] = [];

    for (const entry of entries) {
      try {
        if (entry.kind === 'attachment-dir') {
          const datasetDir = this.getDatasetDir(entry.datasetId);
          if (await fs.pathExists(datasetDir)) {
            await fs.remove(datasetDir);
          }
        } else if (entry.kind === 'dataset-file' && entry.targetPath) {
          const targetPath = this.resolveSafeUserDataPath(entry.targetPath);
          if (await fs.pathExists(targetPath)) {
            await fs.remove(targetPath);
          }
          const walPath = `${targetPath}.wal`;
          if (await fs.pathExists(walPath)) {
            await fs.remove(walPath);
          }
        }
        removed += 1;
      } catch (error) {
        remaining.push({
          ...entry,
          attempts: entry.attempts + 1,
          lastError: getUnknownErrorMessage(error),
        });
      }
    }

    await this.writeCleanupBacklog(remaining);
    return { removed, remaining: remaining.length };
  }

  private async readCleanupBacklog(): Promise<DatasetCleanupBacklogEntry[]> {
    try {
      const backlogPath = this.getCleanupBacklogPath();
      if (!(await fs.pathExists(backlogPath))) {
        return [];
      }

      const raw = await fs.readFile(backlogPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .map((entry): DatasetCleanupBacklogEntry | null => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }
          const datasetId = String((entry as any).datasetId || '').trim();
          if (!datasetId || !/^[a-zA-Z0-9_-]+$/.test(datasetId)) {
            return null;
          }
          return {
            datasetId,
            kind: (entry as any).kind === 'dataset-file' ? 'dataset-file' : 'attachment-dir',
            targetPath:
              typeof (entry as any).targetPath === 'string' ? (entry as any).targetPath : undefined,
            queuedAt: Number((entry as any).queuedAt) || Date.now(),
            attempts: Math.max(0, Math.trunc(Number((entry as any).attempts) || 0)),
            lastError:
              typeof (entry as any).lastError === 'string' ? (entry as any).lastError : undefined,
          };
        })
        .filter((entry): entry is DatasetCleanupBacklogEntry => Boolean(entry));
    } catch {
      return [];
    }
  }

  private async writeCleanupBacklog(entries: DatasetCleanupBacklogEntry[]): Promise<void> {
    const backlogPath = this.getCleanupBacklogPath();
    const deduped = new Map<string, DatasetCleanupBacklogEntry>();

    for (const entry of entries) {
      const safeDatasetId = this.sanitizeDatasetId(entry.datasetId);
      const key =
        entry.kind === 'dataset-file'
          ? `${entry.kind}:${safeDatasetId}:${entry.targetPath || ''}`
          : `${entry.kind}:${safeDatasetId}`;
      deduped.set(key, {
        ...entry,
        datasetId: safeDatasetId,
      });
    }

    const normalized = Array.from(deduped.values());
    if (normalized.length === 0) {
      await fs.remove(backlogPath);
      return;
    }

    await fs.ensureDir(path.dirname(backlogPath));
    await fs.writeFile(backlogPath, JSON.stringify(normalized, null, 2), 'utf8');
  }

  /**
   * 获取数据集附件总大小
   * @param datasetId 数据集ID
   * @returns 总大小（字节）
   */
  async getDatasetFilesSize(datasetId: string): Promise<number> {
    try {
      const datasetDir = this.getDatasetDir(datasetId);

      if (!fs.existsSync(datasetDir)) {
        return 0;
      }

      let totalSize = 0;
      const files = await fs.readdir(datasetDir);

      for (const file of files) {
        const filePath = path.join(datasetDir, file);
        const stats = await fs.stat(filePath);
        if (stats.isFile()) {
          totalSize += stats.size;
        }
      }

      return totalSize;
    } catch (error: unknown) {
      logger.error('Failed to get dataset files size', { datasetId, error });
      return 0;
    }
  }
}

// 延迟创建单例
let _fileStorage: FileStorage | null = null;

function ensureFileStorage(): FileStorage {
  if (!_fileStorage) {
    _fileStorage = new FileStorage();
  }
  return _fileStorage;
}

// 导出包装对象，延迟创建实例
export const fileStorage = {
  saveFile(...args: Parameters<FileStorage['saveFile']>) {
    return ensureFileStorage().saveFile(...args);
  },
  saveFileFromPath(...args: Parameters<FileStorage['saveFileFromPath']>) {
    return ensureFileStorage().saveFileFromPath(...args);
  },
  deleteFile(...args: Parameters<FileStorage['deleteFile']>) {
    return ensureFileStorage().deleteFile(...args);
  },
  getFilePath(...args: Parameters<FileStorage['getFilePath']>) {
    return ensureFileStorage().getFilePath(...args);
  },
  fileExists(...args: Parameters<FileStorage['fileExists']>) {
    return ensureFileStorage().fileExists(...args);
  },
  getFileUrl(...args: Parameters<FileStorage['getFileUrl']>) {
    return ensureFileStorage().getFileUrl(...args);
  },
  getFileAsBase64(...args: Parameters<FileStorage['getFileAsBase64']>) {
    return ensureFileStorage().getFileAsBase64(...args);
  },
  deleteDatasetFiles(...args: Parameters<FileStorage['deleteDatasetFiles']>) {
    return ensureFileStorage().deleteDatasetFiles(...args);
  },
  enqueueDeferredDatasetFilesCleanup(
    ...args: Parameters<FileStorage['enqueueDeferredDatasetFilesCleanup']>
  ) {
    return ensureFileStorage().enqueueDeferredDatasetFilesCleanup(...args);
  },
  enqueueDeferredDatasetFileCleanup(
    ...args: Parameters<FileStorage['enqueueDeferredDatasetFileCleanup']>
  ) {
    return ensureFileStorage().enqueueDeferredDatasetFileCleanup(...args);
  },
  sweepDeferredDatasetFilesCleanup(
    ...args: Parameters<FileStorage['sweepDeferredDatasetFilesCleanup']>
  ) {
    return ensureFileStorage().sweepDeferredDatasetFilesCleanup(...args);
  },
  getDatasetFilesSize(...args: Parameters<FileStorage['getDatasetFilesSize']>) {
    return ensureFileStorage().getDatasetFilesSize(...args);
  },
};
