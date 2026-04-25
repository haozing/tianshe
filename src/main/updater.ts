/**
 * 软件更新管理器
 * 功能：
 * - 检查更新（自动 + 手动）
 * - 自动下载更新
 * - 强制更新检测
 * - 更新进度通知
 */

import { autoUpdater } from 'electron-updater';
import { BrowserWindow } from 'electron';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import { LogStorageService } from './log-storage-service';
import path from 'path';
import { AIRPA_RUNTIME_CONFIG, isDevelopmentMode } from '../constants/runtime-config';

// 强制更新的最低版本（低于此版本必须更新）
const MINIMUM_VERSION = '1.0.0';

export class UpdateManager {
  private logger: LogStorageService;
  private mainWindow: BrowserWindow;
  private updateCheckInterval: NodeJS.Timeout | null = null;
  private isForceUpdate: boolean = false;

  constructor(logger: LogStorageService, mainWindow: BrowserWindow) {
    this.logger = logger;
    this.mainWindow = mainWindow;
    this.setupAutoUpdater();
  }

  /**
   * 配置 autoUpdater
   */
  private setupAutoUpdater(): void {
    // 开发环境：使用本地配置文件（用于测试）
    if (isDevelopmentMode()) {
      const devConfigPath = path.join(__dirname, '../../dev-app-update.yml');
      autoUpdater.updateConfigPath = devConfigPath;
      this.logger.info('updater', `Using dev config: ${devConfigPath}`);
    }

    // 生产环境：自动下载更新
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    // 允许降级（用于测试）
    autoUpdater.allowDowngrade = isDevelopmentMode();

    // 事件监听
    this.registerEvents();

    this.logger.info('updater', 'AutoUpdater configured', {
      autoDownload: autoUpdater.autoDownload,
      autoInstall: autoUpdater.autoInstallOnAppQuit,
      env: AIRPA_RUNTIME_CONFIG.app.mode,
    });
  }

  /**
   * 注册更新事件
   */
  private registerEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.logger.info('updater', 'Checking for updates...');
      this.sendToRenderer('checking');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.logger.info('updater', 'Update available', {
        version: info.version,
        releaseDate: info.releaseDate,
      });

      // 检查是否需要强制更新
      this.isForceUpdate = this.checkForceUpdate(info.version);

      this.sendToRenderer('available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
        isForceUpdate: this.isForceUpdate,
      });

      // 如果是强制更新，记录日志（UI 由渲染进程的 ForceUpdateModal 处理）
      if (this.isForceUpdate) {
        this.logger.warn('updater', 'Force update required!');
      }
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.logger.info('updater', 'Update not available', { version: info.version });
      this.sendToRenderer('not-available', { version: info.version });
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      const percent = Math.round(progress.percent);
      this.logger.info('updater', `Downloading: ${percent}%`, {
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });

      this.sendToRenderer('download-progress', {
        percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.logger.info('updater', 'Update downloaded', { version: info.version });
      this.sendToRenderer('downloaded', {
        version: info.version,
        isForceUpdate: this.isForceUpdate,
      });

      // 强制更新：3秒后自动安装（UI 由渲染进程的 ForceUpdateModal 处理）
      // 非强制更新：由渲染进程的 UpdateNotification 提供安装选项
      if (this.isForceUpdate) {
        setTimeout(() => {
          this.quitAndInstall();
        }, 3000);
      }
    });

    autoUpdater.on('error', (error: Error) => {
      this.logger.error('updater', 'Update error', {
        message: error.message,
        stack: error.stack,
      });

      this.sendToRenderer('error', {
        message: error.message,
        isForceUpdate: this.isForceUpdate,
      });

      // 强制更新失败时，由渲染进程的 ForceUpdateModal 提供重试选项
    });
  }

  /**
   * 检查是否需要强制更新
   */
  private checkForceUpdate(_latestVersion: string): boolean {
    const currentVersion = this.getCurrentVersion();
    return this.compareVersion(currentVersion, MINIMUM_VERSION) < 0;
  }

  /**
   * 获取当前版本
   */
  private getCurrentVersion(): string {
    const { app } = require('electron');
    return app.getVersion();
  }

  /**
   * 版本号比较（SemVer）
   * @returns -1: v1 < v2, 0: v1 === v2, 1: v1 > v2
   */
  private compareVersion(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      if (parts1[i] > parts2[i]) return 1;
      if (parts1[i] < parts2[i]) return -1;
    }
    return 0;
  }

  /**
   * 检查更新
   */
  async checkForUpdates(): Promise<void> {
    try {
      this.logger.info('updater', 'Manually checking for updates');
      await autoUpdater.checkForUpdates();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('updater', 'Failed to check for updates', {
        message,
      });
      throw error;
    }
  }

  /**
   * 下载更新（手动触发，通常自动下载已启用）
   */
  async downloadUpdate(): Promise<void> {
    try {
      this.logger.info('updater', 'Manually downloading update');
      await autoUpdater.downloadUpdate();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('updater', 'Failed to download update', {
        message,
      });
      throw error;
    }
  }

  /**
   * 安装更新并重启
   */
  quitAndInstall(): void {
    this.logger.info('updater', 'Quitting and installing update');
    // false: 不立即退出，等待渲染进程清理
    // true: 强制关闭所有窗口
    autoUpdater.quitAndInstall(false, true);
  }

  /**
   * 启动定时检查（每4小时）
   */
  startPeriodicCheck(intervalMs: number = 4 * 60 * 60 * 1000): void {
    if (this.updateCheckInterval) {
      this.logger.warn('updater', 'Periodic check already started');
      return;
    }

    this.updateCheckInterval = setInterval(() => {
      this.logger.info('updater', 'Periodic update check triggered');
      this.checkForUpdates();
    }, intervalMs);

    this.logger.info('updater', `Periodic check started (interval: ${intervalMs / 1000}s)`);
  }

  /**
   * 停止定时检查
   */
  stopPeriodicCheck(): void {
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
      this.updateCheckInterval = null;
      this.logger.info('updater', 'Periodic check stopped');
    }
  }

  /**
   * 发送消息到渲染进程
   */
  private sendToRenderer<T>(channel: string, data?: T): void {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(`updater:${channel}`, data);
    }
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.stopPeriodicCheck();
    this.logger.info('updater', 'UpdateManager cleaned up');
  }
}
