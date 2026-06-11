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
import fs from 'node:fs';
import path from 'path';
import { AIRPA_RUNTIME_CONFIG, isDevelopmentMode } from '../constants/runtime-config';
import { getUnknownErrorMessage } from '../utils/error-message';
import { redactSensitiveText } from '../utils/redaction';

// 强制更新的最低版本（低于此版本必须更新）
const MINIMUM_VERSION = '1.0.0';
type UpdateErrorOperation = 'check' | 'download' | 'update';
type AutoUpdaterEventName = Parameters<typeof autoUpdater.on>[0];
type AutoUpdaterListener = (...args: any[]) => void;

const UPDATE_CONFIG_MISSING_PATTERN = /update config not found/i;
const AUTH_FAILURE_PATTERN =
  /authentication token|unauthori[sz]ed|forbidden|permission denied|access denied|bad credentials/i;
const NETWORK_FAILURE_PATTERN =
  /\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|timeout|timed out)\b/i;

function readStatusCode(error: unknown): number | null {
  const fromValue = (value: unknown): number | null => {
    const status = typeof value === 'string' ? Number.parseInt(value, 10) : value;
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : null;
  };

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const directStatus =
      fromValue(record.statusCode) ?? fromValue(record.status) ?? fromValue(record.code);
    if (directStatus !== null) {
      return directStatus;
    }

    const response = record.response;
    if (response && typeof response === 'object') {
      const responseRecord = response as Record<string, unknown>;
      const responseStatus = fromValue(responseRecord.statusCode) ?? fromValue(responseRecord.status);
      if (responseStatus !== null) {
        return responseStatus;
      }
    }
  }

  const message = getUnknownErrorMessage(error, '');
  const statusMatch =
    /^\s*(\d{3})\b/.exec(message) ?? /["']?statusCode["']?\s*:\s*(\d{3})/.exec(message);
  return statusMatch ? fromValue(statusMatch[1]) : null;
}

export function getUserFacingUpdateErrorMessage(
  error: unknown,
  operation: UpdateErrorOperation = 'update'
): string {
  const rawMessage = getUnknownErrorMessage(error, '');
  const statusCode = readStatusCode(error);

  if (UPDATE_CONFIG_MISSING_PATTERN.test(rawMessage)) {
    return '当前版本未配置自动更新渠道，请到发布页手动下载安装包。';
  }

  if (statusCode === 404 || /\b404\b/.test(rawMessage)) {
    return '未找到可用的更新发布源，请检查更新地址或到发布页手动下载最新版。';
  }

  if (statusCode === 401 || statusCode === 403 || AUTH_FAILURE_PATTERN.test(rawMessage)) {
    return '更新发布源需要授权或当前无权访问，请检查更新源配置。';
  }

  if (statusCode !== null && statusCode >= 500) {
    return '更新服务器暂时不可用，请稍后重试。';
  }

  if (NETWORK_FAILURE_PATTERN.test(rawMessage)) {
    return '无法连接更新服务器，请检查网络后重试。';
  }

  if (operation === 'download') {
    return '下载更新失败，请稍后重试或手动下载最新版。';
  }

  if (operation === 'check') {
    return '检查更新失败，请稍后重试或手动下载最新版。';
  }

  return '更新失败，请稍后重试或手动下载最新版。';
}

function sanitizeUpdaterDiagnosticText(value: string, maxLength = 500): string {
  return redactSensitiveText(String(value || '').split(/\bHeaders:\s*/i)[0].trim()).slice(
    0,
    maxLength
  );
}

function buildUpdateErrorLogContext(error: unknown): Record<string, unknown> {
  return {
    message: sanitizeUpdaterDiagnosticText(getUnknownErrorMessage(error, '')),
    statusCode: readStatusCode(error),
    ...(error instanceof Error && error.stack
      ? { stack: sanitizeUpdaterDiagnosticText(error.stack, 1200) }
      : {}),
  };
}

export class UpdateManager {
  private logger: LogStorageService;
  private mainWindow: BrowserWindow;
  private updateCheckInterval: NodeJS.Timeout | null = null;
  private isForceUpdate: boolean = false;
  private updateConfigAvailable: boolean = false;
  private autoUpdaterListeners: Array<{
    eventName: AutoUpdaterEventName;
    listener: AutoUpdaterListener;
  }> = [];

  constructor(logger: LogStorageService, mainWindow: BrowserWindow) {
    this.logger = logger;
    this.mainWindow = mainWindow;
    this.setupAutoUpdater();
  }

  /**
   * 配置 autoUpdater
   */
  private setupAutoUpdater(): void {
    const updateConfigPath = this.resolveUpdateConfigPath();
    // 开发环境：使用本地配置文件（用于测试）
    if (isDevelopmentMode()) {
      autoUpdater.updateConfigPath = updateConfigPath;
      this.logger.info('updater', `Using dev config: ${updateConfigPath}`);
    }
    this.updateConfigAvailable = fs.existsSync(updateConfigPath);

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
      updateConfigAvailable: this.updateConfigAvailable,
      updateConfigPath,
    });

    if (!this.updateConfigAvailable) {
      this.logger.warn('updater', 'Update config not found; update checks disabled', {
        updateConfigPath,
        env: AIRPA_RUNTIME_CONFIG.app.mode,
      });
    }
  }

  private resolveUpdateConfigPath(): string {
    if (isDevelopmentMode()) {
      return path.join(__dirname, '../../dev-app-update.yml');
    }

    const resourcesPath = (process as typeof process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      return path.join(resourcesPath, 'app-update.yml');
    }

    return path.join(process.cwd(), 'app-update.yml');
  }

  isUpdateConfigured(): boolean {
    return this.updateConfigAvailable;
  }

  /**
   * 注册更新事件
   */
  private registerEvents(): void {
    this.removeRegisteredAutoUpdaterListeners();

    this.registerAutoUpdaterListener('checking-for-update', () => {
      this.logger.info('updater', 'Checking for updates...');
      this.sendToRenderer('checking');
    });

    this.registerAutoUpdaterListener('update-available', (info: UpdateInfo) => {
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

    this.registerAutoUpdaterListener('update-not-available', (info: UpdateInfo) => {
      this.logger.info('updater', 'Update not available', { version: info.version });
      this.sendToRenderer('not-available', { version: info.version });
    });

    this.registerAutoUpdaterListener('download-progress', (progress: ProgressInfo) => {
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

    this.registerAutoUpdaterListener('update-downloaded', (info: UpdateInfo) => {
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

    this.registerAutoUpdaterListener('error', (error: Error) => {
      const userMessage = getUserFacingUpdateErrorMessage(error, 'update');
      this.logger.error('updater', 'Update error', {
        ...buildUpdateErrorLogContext(error),
        userMessage,
      });

      this.sendToRenderer('error', {
        message: userMessage,
        isForceUpdate: this.isForceUpdate,
      });

      // 强制更新失败时，由渲染进程的 ForceUpdateModal 提供重试选项
    });
  }

  private registerAutoUpdaterListener(
    eventName: AutoUpdaterEventName,
    listener: AutoUpdaterListener
  ): void {
    autoUpdater.on(eventName, listener);
    this.autoUpdaterListeners.push({ eventName, listener });
  }

  private removeRegisteredAutoUpdaterListeners(): void {
    const updater = autoUpdater as typeof autoUpdater & {
      off?: (eventName: AutoUpdaterEventName, listener: AutoUpdaterListener) => void;
      removeListener?: (eventName: AutoUpdaterEventName, listener: AutoUpdaterListener) => void;
    };

    for (const { eventName, listener } of this.autoUpdaterListeners) {
      if (typeof updater.off === 'function') {
        updater.off(eventName, listener);
      } else if (typeof updater.removeListener === 'function') {
        updater.removeListener(eventName, listener);
      }
    }

    this.autoUpdaterListeners = [];
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
      if (!this.updateConfigAvailable) {
        throw new Error('Update config not found; update checks are disabled for this build');
      }

      this.logger.info('updater', 'Manually checking for updates');
      await autoUpdater.checkForUpdates();
    } catch (error: unknown) {
      const message = getUserFacingUpdateErrorMessage(error, 'check');
      this.logger.error('updater', 'Failed to check for updates', {
        ...buildUpdateErrorLogContext(error),
        userMessage: message,
      });
      throw new Error(message);
    }
  }

  /**
   * 下载更新（手动触发，通常自动下载已启用）
   */
  async downloadUpdate(): Promise<void> {
    try {
      if (!this.updateConfigAvailable) {
        throw new Error('Update config not found; update downloads are disabled for this build');
      }

      this.logger.info('updater', 'Manually downloading update');
      await autoUpdater.downloadUpdate();
    } catch (error: unknown) {
      const message = getUserFacingUpdateErrorMessage(error, 'download');
      this.logger.error('updater', 'Failed to download update', {
        ...buildUpdateErrorLogContext(error),
        userMessage: message,
      });
      throw new Error(message);
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
      void this.checkForUpdates().catch((error: unknown) => {
        this.logger.warn('updater', 'Periodic update check failed', buildUpdateErrorLogContext(error));
      });
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
    this.removeRegisteredAutoUpdaterListeners();
    this.logger.info('updater', 'UpdateManager cleaned up');
  }
}
