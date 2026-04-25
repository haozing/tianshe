/**
 * 插件文件监听服务
 * 用于开发模式下监听插件源代码变化，实现热重载
 */

import * as chokidar from 'chokidar';
import * as path from 'path';
import { createLogger } from '../logger';

const logger = createLogger('FileWatcher');

/**
 * 文件变化事件类型
 */
export type FileChangeEvent = {
  type: 'change' | 'add' | 'unlink';
  path: string;
  timestamp: number;
};

/**
 * 文件监听配置
 */
export interface WatcherConfig {
  /** 监听路径 */
  path: string;
  /** 忽略的文件模式 */
  ignored?: string | RegExp | ((path: string) => boolean);
  /** 防抖延迟（毫秒）*/
  debounceDelay?: number;
  /** 是否启用持久化监听 */
  persistent?: boolean;
}

/**
 * 插件文件监听器
 */
export class PluginFileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private config: WatcherConfig;
  private onChange: (event: FileChangeEvent) => void;
  private isWatching = false;

  /**
   * 创建文件监听器
   * @param config - 监听配置
   * @param onChange - 文件变化回调
   */
  constructor(config: WatcherConfig, onChange: (event: FileChangeEvent) => void) {
    this.config = {
      debounceDelay: 1000, // 默认1秒防抖
      persistent: true,
      ...config,
    };
    this.onChange = onChange;
  }

  /**
   * 启动文件监听
   */
  async start(): Promise<void> {
    if (this.isWatching) {
      logger.warn(`[FileWatcher] Already watching: ${this.config.path}`);
      return;
    }

    logger.info(`[FileWatcher] Starting watcher for: ${this.config.path}`);

    // 创建 chokidar 监听器
    this.watcher = chokidar.watch(this.config.path, {
      ignored: this.config.ignored || [
        // 依赖和包管理
        '**/node_modules/**',
        '**/package-lock.json',
        '**/yarn.lock',
        '**/pnpm-lock.yaml',
        // 版本控制
        '**/.git/**',
        '**/.svn/**',
        '**/.hg/**',
        // IDE 和编辑器
        '**/.vscode/**',
        '**/.idea/**',
        '**/.vs/**',
        '**/*.swp',
        '**/*.swo',
        '**/*~',
        '**/.DS_Store',
        '**/Thumbs.db',
        // 构建输出
        '**/dist/**',
        '**/build/**',
        '**/out/**',
        '**/.next/**',
        '**/.nuxt/**',
        // 测试和覆盖率
        '**/coverage/**',
        '**/.nyc_output/**',
        // 日志和数据库
        '**/*.log',
        '**/*.db',
        '**/*.db-wal',
        '**/*.db-shm',
        // 缓存和临时文件
        '**/.cache/**',
        '**/tmp/**',
        '**/temp/**',
        '**/*.tmp',
      ],
      persistent: this.config.persistent,
      ignoreInitial: true, // 忽略初始扫描事件
      awaitWriteFinish: {
        // 等待文件写入完成
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    // 监听文件变化事件
    this.watcher
      .on('change', (filePath: string) => this.handleFileChange('change', filePath))
      .on('add', (filePath: string) => this.handleFileChange('add', filePath))
      .on('unlink', (filePath: string) => this.handleFileChange('unlink', filePath))
      .on('error', (error: Error) => this.handleError(error))
      .on('ready', () => {
        logger.info(`[FileWatcher] Ready and watching: ${this.config.path}`);
        this.isWatching = true;
      });

    // 等待监听器准备就绪
    await new Promise<void>((resolve) => {
      this.watcher!.on('ready', () => resolve());
    });
  }

  /**
   * 停止文件监听
   */
  async stop(): Promise<void> {
    if (!this.isWatching || !this.watcher) {
      return;
    }

    logger.info(`[FileWatcher] Stopping watcher for: ${this.config.path}`);

    // 清除防抖定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // 关闭监听器
    await this.watcher.close();
    this.watcher = null;
    this.isWatching = false;

    logger.info(`[FileWatcher] Watcher stopped: ${this.config.path}`);
  }

  /**
   * 检查是否正在监听
   */
  isActive(): boolean {
    return this.isWatching;
  }

  /**
   * 获取监听路径
   */
  getWatchPath(): string {
    return this.config.path;
  }

  /**
   * 处理文件变化事件（带防抖）
   */
  private handleFileChange(type: 'change' | 'add' | 'unlink', filePath: string): void {
    // 清除之前的定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // 设置新的防抖定时器
    this.debounceTimer = setTimeout(() => {
      const event: FileChangeEvent = {
        type,
        path: filePath,
        timestamp: Date.now(),
      };

      const relativePath = path.relative(this.config.path, filePath);
      logger.info(`[FileWatcher] File ${type}: ${relativePath}`);

      // 调用回调函数
      this.onChange(event);
    }, this.config.debounceDelay);
  }

  /**
   * 处理监听错误
   */
  private handleError(error: Error): void {
    logger.error(`[FileWatcher] Watch error for ${this.config.path}:`, error);
  }
}

/**
 * 插件文件监听管理器
 * 管理多个插件的文件监听器
 */
export class PluginFileWatcherManager {
  private watchers = new Map<string, PluginFileWatcher>();

  /** 每个插件的 reload 锁，防止并发 reload */
  private reloadLocks = new Map<string, boolean>();

  /**
   * 启动插件监听
   * @param pluginId - 插件ID
   * @param sourcePath - 插件源代码路径
   * @param onReload - 重载回调函数
   */
  async startWatching(
    pluginId: string,
    sourcePath: string,
    onReload: () => Promise<void>
  ): Promise<void> {
    // 如果已经在监听，先停止
    if (this.watchers.has(pluginId)) {
      await this.stopWatching(pluginId);
    }

    logger.info(`[WatcherManager] Starting file watcher for plugin: ${pluginId}`);

    // 创建监听器（带 reload 锁防止并发）
    const watcher = new PluginFileWatcher(
      {
        path: sourcePath,
        debounceDelay: 1000, // 1秒防抖
      },
      async (event) => {
        // 检查 reload 锁，防止并发 reload
        if (this.reloadLocks.get(pluginId)) {
          logger.info(
            `[WatcherManager] Skipping reload for ${pluginId}: another reload is in progress`
          );
          return;
        }

        logger.info(`[WatcherManager] Plugin ${pluginId} file changed: ${event.path}`);
        logger.info(`[WatcherManager] Triggering hot reload...`);

        // 获取锁
        this.reloadLocks.set(pluginId, true);

        try {
          await onReload();
          logger.info(`[WatcherManager] Hot reload completed for: ${pluginId}`);
        } catch (error: any) {
          logger.error(`[WatcherManager] Hot reload failed for ${pluginId}:`, error.message);
        } finally {
          // 释放锁
          this.reloadLocks.set(pluginId, false);
        }
      }
    );

    // 启动监听
    await watcher.start();

    // 保存监听器
    this.watchers.set(pluginId, watcher);

    logger.info(`[WatcherManager] File watcher started for: ${pluginId}`);
  }

  /**
   * 停止插件监听
   * @param pluginId - 插件ID
   */
  async stopWatching(pluginId: string): Promise<void> {
    const watcher = this.watchers.get(pluginId);
    if (!watcher) {
      return;
    }

    logger.info(`[WatcherManager] Stopping file watcher for plugin: ${pluginId}`);

    await watcher.stop();
    this.watchers.delete(pluginId);
    this.reloadLocks.delete(pluginId); // 清理锁

    logger.info(`[WatcherManager] File watcher stopped for: ${pluginId}`);
  }

  /**
   * 检查插件是否正在监听
   * @param pluginId - 插件ID
   */
  isWatching(pluginId: string): boolean {
    const watcher = this.watchers.get(pluginId);
    return watcher?.isActive() ?? false;
  }

  /**
   * 获取所有正在监听的插件ID列表
   */
  getWatchingPlugins(): string[] {
    return Array.from(this.watchers.keys()).filter((pluginId) => this.isWatching(pluginId));
  }

  /**
   * 停止所有监听
   */
  async stopAll(): Promise<void> {
    logger.info(`[WatcherManager] Stopping all file watchers...`);

    const promises = Array.from(this.watchers.keys()).map((pluginId) =>
      this.stopWatching(pluginId)
    );

    await Promise.all(promises);

    logger.info(`[WatcherManager] All file watchers stopped`);
  }
}
