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
}

export class DownloadManager extends EventEmitter {
  private downloads = new Map<string, DownloadInfo>();
  private downloadDirs = new Map<string, string>();

  constructor() {
    super();
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

    console.log(`✅ Download path set for ${partition}: ${finalPath}`);
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
    item.once('done', (event, state) => {
      info.endTime = Date.now();

      if (state === 'completed') {
        info.state = 'completed';
        console.log(`✅ Download completed: ${filename}`);
        this.emit('download:completed', info);
      } else if (state === 'cancelled') {
        info.state = 'cancelled';
        console.log(`⚠️ Download cancelled: ${filename}`);
        this.emit('download:cancelled', info);
      } else if (state === 'interrupted') {
        info.state = 'interrupted';
        console.error(`❌ Download interrupted: ${filename}`);
        this.emit('download:interrupted', info);
      }
    });

    this.emit('download:started', info);
    console.log(`📥 Download started: ${filename}`);
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

    console.log(`✅ Cleared ${toDelete.length} download records for ${partition}`);
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
        console.log(`✅ Deleted download file: ${info.filename}`);
        return true;
      }
    } catch (err) {
      console.error(`Failed to delete download file: ${info.filename}`, err);
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
      console.log(`✅ Cleared download directory for ${partition}`);
    } catch (err) {
      console.error(`Failed to clear download directory for ${partition}`, err);
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
