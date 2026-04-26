/**
 * SystemIPCHandler - 系统功能处理器
 * 负责：日志、下载、系统信息等功能
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow, app, shell } from 'electron';
import Store from 'electron-store';
import { LogStorageService } from '../log-storage-service';
import { DownloadManager } from '../download';
import { handleIPCError } from '../ipc-utils';
import { DEFAULT_HTTP_API_CONFIG, type HttpApiConfig } from '../../constants/http-api';
import { isDevelopmentMode } from '../../constants/runtime-config';
import { getDeviceFingerprint } from '../system/device-fingerprint';
import {
  getInternalBrowserDevToolsConfig,
  setInternalBrowserDevToolsConfig,
} from '../internal-browser-devtools';
import { getAppShellConfig } from '../app-shell-config';

// 全局 store 实例（用于读取配置）
const store = new Store();

export class SystemIPCHandler {
  constructor(
    private logger: LogStorageService,
    private downloadManager: DownloadManager,
    private mainWindow: BrowserWindow
  ) {}

  /**
   * 注册所有系统相关的 IPC 处理器
   */
  register(): void {
    // 日志相关
    this.registerGetTaskLogs();
    this.registerGetRecentLogs();
    this.registerGetLogStats();
    this.registerCleanupLogs();

    // 下载相关
    this.registerGetDownload();
    this.registerGetPartitionDownloads();
    this.registerGetAllDownloads();
    this.registerDeleteDownloadFile();
    this.registerGetDownloadStats();

    // 图片下载
    this.registerDownloadImage();

    // 系统信息
    this.registerGetAppInfo();
    this.registerGetWindowBounds();
    this.registerGetDeviceFingerprint();
    this.registerInternalBrowserDevToolsConfig();

    // Shell 操作
    this.registerShellOpenPath();
  }

  // ========== 日志相关 ==========

  private registerGetTaskLogs(): void {
    ipcMain.handle(
      'get-task-logs',
      async (_event: IpcMainInvokeEvent, taskId: string, level?: string) => {
        try {
          const logs = this.logger.getTaskLogs(taskId, level);
          return { success: true, logs };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerGetRecentLogs(): void {
    ipcMain.handle(
      'get-recent-logs',
      async (_event: IpcMainInvokeEvent, limit?: number, level?: string) => {
        try {
          const logs = this.logger.getRecentLogs(limit, level);
          return { success: true, logs };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerGetLogStats(): void {
    ipcMain.handle('get-log-stats', async (_event: IpcMainInvokeEvent, taskId?: string) => {
      try {
        const stats = this.logger.getStats(taskId);
        return { success: true, stats };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerCleanupLogs(): void {
    ipcMain.handle('cleanup-logs', async (_event: IpcMainInvokeEvent, daysToKeep?: number) => {
      try {
        const deleted = this.logger.cleanup(daysToKeep);
        return { success: true, deleted };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  // ========== 下载相关 ==========

  private registerGetDownload(): void {
    ipcMain.handle('get-download', async (_event: IpcMainInvokeEvent, downloadId: string) => {
      try {
        const download = this.downloadManager.getDownload(downloadId);
        return { success: true, download };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerGetPartitionDownloads(): void {
    ipcMain.handle(
      'get-partition-downloads',
      async (_event: IpcMainInvokeEvent, partition: string) => {
        try {
          const downloads = this.downloadManager.getPartitionDownloads(partition);
          return { success: true, downloads };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerGetAllDownloads(): void {
    ipcMain.handle('get-all-downloads', async (_event: IpcMainInvokeEvent) => {
      try {
        const downloads = this.downloadManager.getAllDownloads();
        return { success: true, downloads };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerDeleteDownloadFile(): void {
    ipcMain.handle(
      'delete-download-file',
      async (_event: IpcMainInvokeEvent, downloadId: string) => {
        try {
          await this.downloadManager.deleteDownloadFile(downloadId);
          return { success: true };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  private registerGetDownloadStats(): void {
    ipcMain.handle('get-download-stats', async (_event: IpcMainInvokeEvent) => {
      try {
        const stats = this.downloadManager.getStats();
        return { success: true, stats };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  // ========== 系统信息 ==========

  private registerGetAppInfo(): void {
    ipcMain.handle('get-app-info', async (_event: IpcMainInvokeEvent) => {
      try {
        // 🔍 更可靠的打包检测：结合多个标志
        // 1. app.isPackaged - Electron 官方标志
        // 2. 运行模式检查 - runtime 配置
        // 3. app.getAppPath() 检查 - 路径中是否包含 app.asar
        // 4. 🆕 配置中的 enableDevMode - 打包后仍可手动启用开发模式
        const isDevelopment = isDevelopmentMode();
        const isFromAsar = app.getAppPath().includes('app.asar');

        // 🆕 读取配置中的开发模式开关
        const httpApiConfig = store.get('httpApiConfig', DEFAULT_HTTP_API_CONFIG) as HttpApiConfig;
        const enableDevModeFromConfig = httpApiConfig.enableDevMode ?? false;

        // 🆕 开发选项显示条件：主进程开发模式 OR 配置中启用了开发模式
        const shouldShowDevOptions = (!app.isPackaged && isDevelopment) || enableDevModeFromConfig;
        const info = {
          version: app.getVersion(),
          name: app.getName(),
          path: app.getAppPath(),
          isPackaged: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.versions.node,
          chromeVersion: process.versions.chrome,
          electronVersion: process.versions.electron,
          // 🆕 新增：明确指示是否应该显示开发者选项
          isDevelopment,
          isFromAsar,
          shouldShowDevOptions,
          enableDevModeFromConfig, // 🆕 配置中的开发模式状态
          appShell: getAppShellConfig(),
        };
        console.log('[DEBUG][Main] app.isPackaged:', app.isPackaged);
        console.log('[DEBUG][Main] isDevelopment:', isDevelopment);
        console.log('[DEBUG][Main] isFromAsar:', isFromAsar);
        console.log('[DEBUG][Main] enableDevModeFromConfig:', enableDevModeFromConfig);
        console.log('[DEBUG][Main] shouldShowDevOptions:', shouldShowDevOptions);
        console.log('[DEBUG][Main] app.getAppPath():', app.getAppPath());
        return { success: true, info };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerGetWindowBounds(): void {
    ipcMain.handle('window:get-bounds', async (_event: IpcMainInvokeEvent) => {
      try {
        const bounds = this.mainWindow.getBounds();
        return { success: true, bounds };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerGetDeviceFingerprint(): void {
    ipcMain.handle('get-device-fingerprint', async (_event: IpcMainInvokeEvent) => {
      try {
        console.log('[DeviceFingerprint] Fetching device fingerprint...');
        const result = await getDeviceFingerprint();
        return { success: true, ...result };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[DeviceFingerprint] ❌ Failed to get device fingerprint:', errorMessage);
        console.error('[DeviceFingerprint] Stack:', error instanceof Error ? error.stack : 'N/A');

        return {
          success: false,
          error: errorMessage,
          fingerprint: undefined,
        };
      }
    });
  }

  private registerInternalBrowserDevToolsConfig(): void {
    ipcMain.handle('internal-browser:get-devtools-config', async () => {
      try {
        return {
          success: true,
          config: getInternalBrowserDevToolsConfig(),
        };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });

    ipcMain.handle(
      'internal-browser:set-devtools-config',
      async (_event: IpcMainInvokeEvent, config: { autoOpenDevTools?: boolean }) => {
        try {
          if (typeof config?.autoOpenDevTools !== 'boolean') {
            throw new Error('autoOpenDevTools must be boolean');
          }

          return {
            success: true,
            config: setInternalBrowserDevToolsConfig({
              autoOpenDevTools: config.autoOpenDevTools,
            }),
          };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }

  // ========== 图片下载相关 ==========

  /**
   * 下载图片并转换为 Base64
   * 使用 Node.js 环境，绕过浏览器的 CORS 限制
   */
  private registerDownloadImage(): void {
    ipcMain.handle('download-image', async (_event: IpcMainInvokeEvent, url: string) => {
      const startTime = Date.now();

      try {
        console.log('[DownloadImage] ========================================');
        console.log('[DownloadImage] 开始下载图片:', url);

        // 验证 URL 格式
        if (!url || typeof url !== 'string' || url.trim() === '') {
          const error = 'URL 为空或无效';
          console.error('[DownloadImage] ❌ 验证失败:', error);
          return {
            success: false,
            error: error,
            errorType: 'INVALID_URL',
            retryable: false,
            url: url,
          };
        }

        url = url.trim();

        // 验证 URL 协议
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          const error = 'URL 必须以 http:// 或 https:// 开头';
          console.error('[DownloadImage] ❌ 协议验证失败:', error);
          return {
            success: false,
            error: error,
            errorType: 'INVALID_PROTOCOL',
            retryable: false,
            url: url,
          };
        }

        console.log('[DownloadImage] ✓ URL 验证通过');
        console.log('[DownloadImage] 请求头: User-Agent: Mozilla/5.0...');

        // 使用 fetch 下载图片（Node.js 18+ 原生支持 fetch）
        const fetchStartTime = Date.now();
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            Accept: 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          // 设置超时
          signal: AbortSignal.timeout(30000), // 30秒超时
        });

        const fetchDuration = Date.now() - fetchStartTime;
        console.log(`[DownloadImage] Fetch 完成，耗时: ${fetchDuration}ms`);
        console.log(`[DownloadImage] 响应状态: ${response.status} ${response.statusText}`);

        // 检查响应状态
        if (!response.ok) {
          const error = `HTTP ${response.status}: ${response.statusText}`;
          console.error('[DownloadImage] ❌ HTTP 错误:', error);

          // 判断是否可重试（5xx 服务器错误通常可重试）
          const retryable = response.status >= 500 && response.status < 600;

          return {
            success: false,
            error: error,
            errorType: response.status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR',
            retryable: retryable,
            url: url,
            statusCode: response.status,
          };
        }

        // 获取并验证 Content-Type
        const contentType = response.headers.get('content-type') || '';
        console.log('[DownloadImage] Content-Type:', contentType);

        // 获取 Content-Length
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
          const sizeMB = parseInt(contentLength) / (1024 * 1024);
          console.log(
            `[DownloadImage] Content-Length: ${contentLength} bytes (${sizeMB.toFixed(2)} MB)`
          );

          // 检查文件大小（限制 10MB）
          if (parseInt(contentLength) > 10 * 1024 * 1024) {
            const error = `文件过大: ${sizeMB.toFixed(2)} MB（限制 10MB）`;
            console.error('[DownloadImage] ❌', error);
            return {
              success: false,
              error: error,
              errorType: 'FILE_TOO_LARGE',
              retryable: false,
              url: url,
            };
          }
        }

        // 下载图片数据
        console.log('[DownloadImage] 开始下载图片数据...');
        const downloadStartTime = Date.now();
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const downloadDuration = Date.now() - downloadStartTime;

        console.log(`[DownloadImage] ✅ 图片下载成功`);
        console.log(
          `[DownloadImage]    大小: ${buffer.length} bytes (${(buffer.length / 1024).toFixed(2)} KB)`
        );
        console.log(`[DownloadImage]    下载耗时: ${downloadDuration}ms`);

        // 验证文件大小
        if (buffer.length > 10 * 1024 * 1024) {
          const error = `文件过大: ${(buffer.length / (1024 * 1024)).toFixed(2)} MB（限制 10MB）`;
          console.error('[DownloadImage] ❌', error);
          return {
            success: false,
            error: error,
            errorType: 'FILE_TOO_LARGE',
            retryable: false,
            url: url,
          };
        }

        // 简单验证是否为图片（检查文件头）
        const isValidImage = this.validateImageBuffer(buffer);
        if (!isValidImage) {
          const error = '下载的文件不是有效的图片格式';
          console.warn('[DownloadImage] ⚠️', error);
          console.warn('[DownloadImage] 文件头:', buffer.slice(0, 16).toString('hex'));
          // 不阻止，只警告，因为某些图片格式可能无法识别
        }

        // 检测图片类型（从 Content-Type 或 URL）
        let mimeType = contentType || 'image/png';
        if (!mimeType.startsWith('image/')) {
          // 如果 Content-Type 不是图片类型，尝试从 URL 推断
          if (url.endsWith('.jpg') || url.endsWith('.jpeg')) {
            mimeType = 'image/jpeg';
          } else if (url.endsWith('.png')) {
            mimeType = 'image/png';
          } else if (url.endsWith('.gif')) {
            mimeType = 'image/gif';
          } else if (url.endsWith('.webp')) {
            mimeType = 'image/webp';
          } else {
            mimeType = 'image/png'; // 默认
          }
          console.log(`[DownloadImage] Content-Type 不是图片类型，从 URL 推断: ${mimeType}`);
        }

        // 转换为 Base64
        console.log('[DownloadImage] 转换为 Base64...');
        const base64StartTime = Date.now();
        const base64 = buffer.toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64}`;
        const base64Duration = Date.now() - base64StartTime;

        console.log(`[DownloadImage] ✅ Base64 转换成功`);
        console.log(`[DownloadImage]    Base64 长度: ${dataUrl.length} 字符`);
        console.log(`[DownloadImage]    转换耗时: ${base64Duration}ms`);

        const totalDuration = Date.now() - startTime;
        console.log(`[DownloadImage] ✅ 总耗时: ${totalDuration}ms`);
        console.log('[DownloadImage] ========================================');

        return {
          success: true,
          data: dataUrl,
          size: buffer.length,
          mimeType: mimeType,
        };
      } catch (error: unknown) {
        const totalDuration = Date.now() - startTime;
        console.error('[DownloadImage] ❌ 下载图片失败 (耗时: ' + totalDuration + 'ms):', error);

        // 解析错误类型
        let errorType = 'UNKNOWN_ERROR';
        let retryable = false;
        let errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes('aborted') || errorMessage.includes('timeout')) {
          errorType = 'TIMEOUT';
          retryable = true;
        } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED')) {
          errorType = 'NETWORK_ERROR';
          retryable = true;
        } else if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('ECONNRESET')) {
          errorType = 'NETWORK_ERROR';
          retryable = true;
        }

        console.error('[DownloadImage] 错误类型:', errorType);
        console.error('[DownloadImage] 可重试:', retryable);
        console.error('[DownloadImage] ========================================');

        return {
          success: false,
          error: errorMessage,
          errorType: errorType,
          retryable: retryable,
          url: url,
        };
      }
    });
  }

  /**
   * 验证 Buffer 是否为有效的图片格式
   * 通过检查文件头（Magic Number）
   */
  private validateImageBuffer(buffer: Buffer): boolean {
    if (buffer.length < 8) {
      return false;
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return true;
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return true;
    }

    // GIF: 47 49 46 38 (GIF8)
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return true;
    }

    // WebP: 52 49 46 46 ... 57 45 42 50
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return true;
    }

    // BMP: 42 4D
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return true;
    }

    return false;
  }

  // ========== Shell 操作相关 ==========

  /**
   * 在文件管理器中打开指定路径
   */
  private registerShellOpenPath(): void {
    ipcMain.handle('shell:openPath', async (_event: IpcMainInvokeEvent, filePath: string) => {
      try {
        console.log(`[Shell] Opening path: ${filePath}`);

        // shell.openPath 返回空字符串表示成功，否则返回错误信息
        const result = await shell.openPath(filePath);

        if (result) {
          console.error(`[Shell] Failed to open path: ${result}`);
        } else {
          console.log(`[Shell] ✅ Path opened successfully`);
        }

        return result;
      } catch (error: unknown) {
        console.error(`[Shell] Error opening path:`, error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return errorMessage;
      }
    });
  }
}
