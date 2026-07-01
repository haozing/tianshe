/**
 * 下载管理器
 * 负责：
 * - 按 Partition 隔离下载路径
 * - 监听下载事件
 * - 管理下载任务
 */

import { session, DownloadItem, app } from 'electron';
import path from 'path';
import fs from 'fs-extra';
import { EventEmitter } from 'events';
import { createLogger } from '../core/logger';
import type { BrowserDownloadArtifactRef } from '../types/browser-interface';
import type { BrowserDownloadArtifactSink } from '../core/browser-automation/download-artifact-sink';

const logger = createLogger('DownloadManager');

export interface DownloadInfo {
  id: string;
  partition: string;
  filename: string;
  savePath: string;
  url: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  totalBytes: number;
  receivedBytes: number;
  startTime: number;
  endTime?: number;
  artifactRef?: BrowserDownloadArtifactRef;
  artifactError?: string;
}

export class DownloadManager extends EventEmitter {
  private downloads = new Map<string, DownloadInfo>();
  private downloadDirs = new Map<string, string>();
  private artifactSink: BrowserDownloadArtifactSink | null = null;

  constructor() {
    super();
  }

  setArtifactSink(artifactSink: BrowserDownloadArtifactSink | null): void {
    this.artifactSink = artifactSink;
  }

  /**
   * 为 Partition 设置下载路径
   */
  setupPartition(partition: string, downloadPath?: string): void {
    const finalPath =
      downloadPath ||
      path.join(app.getPath('userData'), 'data', 'downloads', partition.replace('persist:', ''));

    // 确保目录存在
    fs.ensureDirSync(finalPath);

    this.downloadDirs.set(partition, finalPath);

    // 监听下载事件
    const ses = session.fromPartition(partition);

    ses.on('will-download', (event, item: DownloadItem, _webContents) => {
      this.handleDownload(partition, item);
    });

    logger.info('Download path configured for partition', {
      partition,
      downloadPath: finalPath,
    });
  }

  /**
   * 处理下载
   */
  private handleDownload(partition: string, item: DownloadItem): void {
    const downloadId = `download_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const downloadDir =
      this.downloadDirs.get(partition) || path.join(app.getPath('downloads'), partition);
    const filename = item.getFilename();
    const savePath = path.join(downloadDir, filename);

    // 确保目录存在
    fs.ensureDirSync(downloadDir);

    // 设置保存路径
    item.setSavePath(savePath);

    const info: DownloadInfo = {
      id: downloadId,
      partition,
      filename,
      savePath,
      url: item.getURL(),
      state: 'progressing',
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      startTime: Date.now(),
    };

    this.downloads.set(downloadId, info);

    // 监听下载进度
    item.on('updated', (event, state) => {
      if (state === 'progressing') {
        info.receivedBytes = item.getReceivedBytes();
        info.state = 'progressing';
        this.emit('download:progress', info);
      }
    });

    // 监听下载完成
    item.once('done', (_event, state) => {
      info.endTime = Date.now();

      if (state === 'completed') {
        void this.finalizeCompletedDownload(info, item).catch((error) => {
          info.state = 'interrupted';
          info.artifactError = error instanceof Error ? error.message : String(error);
          logger.error('Download artifact finalization failed', {
            partition,
            downloadId,
            filename,
            errorMessage: info.artifactError,
          });
          this.emit('download:interrupted', info);
        });
      } else if (state === 'cancelled') {
        info.state = 'cancelled';
        logger.warn('Download cancelled', { partition, downloadId, filename });
        this.emit('download:cancelled', info);
      } else if (state === 'interrupted') {
        info.state = 'interrupted';
        logger.error('Download interrupted', { partition, downloadId, filename });
        this.emit('download:interrupted', info);
      }
    });

    this.emit('download:started', info);
    logger.info('Download started', { partition, downloadId, filename });
  }

  private async finalizeCompletedDownload(info: DownloadInfo, item: DownloadItem): Promise<void> {
    info.receivedBytes = item.getReceivedBytes();
    info.totalBytes = item.getTotalBytes();
    if (this.artifactSink) {
      info.artifactRef = await this.artifactSink.createDownloadArtifact({
        sourcePath: info.savePath,
        filename: info.filename,
        url: info.url,
        downloadId: info.id,
      });
    }
    info.state = 'completed';
    logger.info('Download completed', {
      partition: info.partition,
      downloadId: info.id,
      filename: info.filename,
      artifactId: info.artifactRef?.artifactId,
    });
    this.emit('download:completed', info);
  }

  /**
   * 获取下载信息
   */
  getDownload(id: string): DownloadInfo | undefined {
    return this.downloads.get(id);
  }

  /**
   * 获取 Partition 的所有下载
   */
  getPartitionDownloads(partition: string): DownloadInfo[] {
    return Array.from(this.downloads.values()).filter((d) => d.partition === partition);
  }

  /**
   * 获取所有下载
   */
  getAllDownloads(): DownloadInfo[] {
    return Array.from(this.downloads.values());
  }

  /**
   * 获取下载目录
   */
  getDownloadDir(partition: string): string {
    return this.downloadDirs.get(partition) || path.join(app.getPath('downloads'), partition);
  }

  /**
   * 清理 Partition 的下载记录
   */
  clearPartitionDownloads(partition: string): void {
    const toDelete: string[] = [];

    for (const [id, info] of this.downloads) {
      if (info.partition === partition) {
        toDelete.push(id);
      }
    }

    toDelete.forEach((id) => this.downloads.delete(id));

    logger.info('Cleared download records for partition', {
      partition,
      count: toDelete.length,
    });
  }

  /**
   * 删除下载文件（物理删除）
   */
  async deleteDownloadFile(id: string): Promise<boolean> {
    const info = this.downloads.get(id);
    if (!info) return false;

    try {
      if (fs.existsSync(info.savePath)) {
        await fs.remove(info.savePath);
        this.downloads.delete(id);
        logger.info('Deleted download file', {
          partition: info.partition,
          downloadId: id,
          filename: info.filename,
        });
        return true;
      }
    } catch (err) {
      logger.error('Failed to delete download file', {
        partition: info.partition,
        downloadId: id,
        filename: info.filename,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }

    return false;
  }

  /**
   * 清空 Partition 的下载目录
   */
  async clearPartitionDir(partition: string): Promise<void> {
    const downloadDir = this.downloadDirs.get(partition);
    if (!downloadDir) return;

    try {
      await fs.emptyDir(downloadDir);
      logger.info('Cleared download directory for partition', { partition });
    } catch (err) {
      logger.error('Failed to clear download directory for partition', {
        partition,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 获取下载统计
   */
  getStats(partition?: string): {
    total: number;
    completed: number;
    progressing: number;
    cancelled: number;
    interrupted: number;
  } {
    const downloads = partition ? this.getPartitionDownloads(partition) : this.getAllDownloads();

    return {
      total: downloads.length,
      completed: downloads.filter((d) => d.state === 'completed').length,
      progressing: downloads.filter((d) => d.state === 'progressing').length,
      cancelled: downloads.filter((d) => d.state === 'cancelled').length,
      interrupted: downloads.filter((d) => d.state === 'interrupted').length,
    };
  }
}
