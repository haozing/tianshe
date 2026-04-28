/**
 * Plugin Loader
 *
 * 负责插件的导入、加载、文件管理等功能
 * 从 manager.ts 拆分出来，专注于插件加载职责
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { app } from 'electron';
import type { DuckDBService } from '../../main/duckdb/service';
import type { JSPluginManifest, JSPluginInfo, JSPluginImportResult } from '../../types/js-plugin';
import { readManifest, loadPluginModule, extractPlugin } from './loader';
import { createLogger } from '../logger';
import {
  assertTrustedFirstPartyPluginImport,
  type TrustedFirstPartyImportOptions,
} from './trust-policy';

/**
 * 插件导入时的回调函数接口
 */
export interface PluginImportCallbacks {
  /** 获取插件信息（用于检查是否已安装） */
  getPluginInfo: (pluginId: string) => Promise<JSPluginInfo | null>;
  /** 创建插件文件夹和数据表 */
  createFolderAndTables: (
    manifest: JSPluginManifest
  ) => Promise<{ folderId: string; tableNameToDatasetId: Map<string, string> | null }>;
  /** 保存 UI 扩展配置 */
  saveUIContributions: (
    manifest: JSPluginManifest,
    tableNameToDatasetId: Map<string, string> | null
  ) => Promise<void>;
  /** 注销 UI 扩展配置 */
  unregisterUIContributions: (pluginId: string) => Promise<void>;
  /** 加载插件模块 */
  loadPlugin: (pluginId: string) => Promise<void>;
}

/**
 * 插件导入选项
 */
export interface PluginImportOptions extends TrustedFirstPartyImportOptions {
  /** 是否为开发模式（使用符号链接） */
  devMode?: boolean;
  /** 插件来源类型（本地私有 / 云端托管） */
  sourceType?: 'local_private' | 'cloud_managed';
  /** 安装渠道（手动导入 / 云端下载） */
  installChannel?: 'manual_import' | 'cloud_download';
  /** 云端插件编码（仅 cloud_managed 有值） */
  cloudPluginCode?: string;
  /** 云端发布版本（仅 cloud_managed 有值） */
  cloudReleaseVersion?: string;
  /** 是否受策略托管 */
  managedByPolicy?: boolean;
  /** 策略版本快照 */
  policyVersion?: string;
  /** 最近策略同步时间戳（毫秒） */
  lastPolicySyncAt?: number;
}

/** 模块级 logger */
const logger = createLogger('PluginLoader');

/**
 * 插件加载器
 * 处理插件的导入、加载、文件管理
 */
export class PluginLoader {
  /** 插件存储目录 */
  private readonly pluginsDir: string;

  constructor(private duckdb: DuckDBService) {
    this.pluginsDir = path.join(app.getPath('userData'), 'js-plugins');
  }

  /**
   * 获取插件存储目录
   */
  getPluginsDir(): string {
    return this.pluginsDir;
  }

  /**
   * 确保插件目录存在
   */
  async ensurePluginsDir(): Promise<void> {
    await fs.ensureDir(this.pluginsDir);
  }

  /**
   * Discover plugin packages placed beside the app executable.
   *
   * Supported layouts:
   * - <exe-dir>/plugins/<plugin>/manifest.json
   * - <exe-dir>/plugins/<plugin>.tsai
   * - <exe-dir>/js-plugins/<plugin>/manifest.json
   *
   * In development the project root is also checked, so the same layout works
   * before packaging.
   */
  async discoverExternalPluginSources(): Promise<string[]> {
    const rootDirs = this.getExternalPluginRootDirs();
    const discovered: string[] = [];
    const seen = new Set<string>();

    const addSource = (sourcePath: string) => {
      const resolved = path.resolve(sourcePath);
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      discovered.push(resolved);
    };

    for (const rootDir of rootDirs) {
      if (path.resolve(rootDir) === path.resolve(this.pluginsDir)) {
        continue;
      }
      if (!(await fs.pathExists(rootDir))) {
        continue;
      }

      const stats = await fs.stat(rootDir).catch(() => null);
      if (!stats?.isDirectory()) {
        continue;
      }

      if (await fs.pathExists(path.join(rootDir, 'manifest.json'))) {
        addSource(rootDir);
        continue;
      }

      const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith('_temp_')) {
          continue;
        }

        const entryPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
          if (await fs.pathExists(path.join(entryPath, 'manifest.json'))) {
            addSource(entryPath);
          }
          continue;
        }

        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.tsai' || ext === '.zip') {
            addSource(entryPath);
          }
        }
      }
    }

    return discovered.sort((left, right) => left.localeCompare(right));
  }

  /**
   * 导入插件
   *
   * @param sourcePath - .tsai 文件或目录路径
   * @param options - 导入选项（开发模式等）
   * @param callbacks - 回调函数（用于创建表、UI等）
   * @returns 导入结果
   */
  async import(
    sourcePath: string,
    options?: PluginImportOptions,
    callbacks?: PluginImportCallbacks
  ): Promise<JSPluginImportResult> {
    try {
      logger.info('Importing JS plugin', { sourcePath, exists: await fs.pathExists(sourcePath) });

      // Show import mode
      if (options?.devMode) {
        logger.info('Development mode enabled');
      } else {
        logger.info('Production mode (file copy)');
      }

      // 1. 判断源路径类型，如果是压缩文件则先解压以读取 manifest
      let manifestSourceDir = sourcePath;
      let tempExtractDir: string | null = null;

      const stats = await fs.stat(sourcePath);
      if (stats.isFile()) {
        const ext = path.extname(sourcePath).toLowerCase();
        if (ext === '.zip' || ext === '.tsai') {
          logger.info('Detected archive file, extracting to read manifest', { ext });
          tempExtractDir = path.join(this.pluginsDir, `_temp_import_${Date.now()}`);
          await fs.ensureDir(tempExtractDir);
          try {
            const { unpackPlugin } = await import('./loader');
            manifestSourceDir = await unpackPlugin(sourcePath, tempExtractDir);
            logger.info('Archive extracted to temporary directory', { manifestSourceDir });
          } catch (extractError: any) {
            if (tempExtractDir) {
              await fs.remove(tempExtractDir).catch(() => {});
            }
            throw new Error(`解压插件文件失败：${extractError.message}`);
          }
        } else {
          throw new Error(`不支持的文件格式: ${ext}。请使用 .zip 或 .tsai 文件，或选择插件目录。`);
        }
      }

      // 2. Read manifest
      logger.info('Reading manifest', { manifestSourceDir });
      let manifest;
      try {
        manifest = await readManifest(manifestSourceDir);
        assertTrustedFirstPartyPluginImport(manifest, options);
        logger.info('Manifest read successfully');
      } catch (manifestError: any) {
        if (tempExtractDir) {
          await fs.remove(tempExtractDir).catch(() => {});
        }
        logger.error('Failed to read manifest', manifestError);
        throw new Error(`无法读取插件配置文件：${manifestError.message}`);
      }

      logger.info('Plugin info parsed', {
        pluginId: manifest.id,
        name: manifest.name,
        version: manifest.version,
      });

      // 3. Check if already installed
      logger.info('Checking if plugin already exists');
      let existing;
      try {
        existing = callbacks ? await callbacks.getPluginInfo(manifest.id) : null;
        logger.info('Plugin existence check completed');
      } catch (checkError: any) {
        logger.error('Failed to check plugin existence', checkError);
        throw new Error(`Database query failed: ${checkError.message}`);
      }
      if (existing) {
        throw new Error(`Plugin ${manifest.id} is already installed. Please uninstall it first.`);
      }

      // 4. 确定安装路径
      const installPath = path.join(this.pluginsDir, manifest.id);

      // 5. 处理开发模式和符号链接
      let actualDevMode = options?.devMode ?? false;
      let linkCreated = false;
      const warnings: string[] = [];

      if (options?.devMode) {
        if (tempExtractDir) {
          // 压缩文件不支持开发模式
          logger.warn(
            'Archive files do not support development mode, falling back to production mode'
          );
          actualDevMode = false;
          warnings.push('压缩文件不支持开发模式（无法创建符号链接），已自动切换为生产模式。');
          await this.moveExtractedFiles(manifestSourceDir, installPath, tempExtractDir);
          tempExtractDir = null;
        } else {
          // 源是目录，可以创建符号链接
          const result = await this.setupDevMode(sourcePath, installPath);
          linkCreated = result.linkCreated;
          if (!result.linkCreated) {
            actualDevMode = false;
            if (result.warning) {
              warnings.push(result.warning);
            }
          }
        }
      } else {
        // Production mode
        if (tempExtractDir) {
          await this.moveExtractedFiles(manifestSourceDir, installPath, tempExtractDir);
          tempExtractDir = null;
        } else {
          try {
            logger.info('Installing in production mode (file copy)');
            await extractPlugin(sourcePath, this.pluginsDir);
            logger.info('Production mode installation completed');
          } catch (extractError: any) {
            logger.error('Extract plugin failed', extractError);
            throw new Error(`插件文件复制失败：${extractError.message}`);
          }
        }
      }

      // 6. Save plugin metadata to database
      logger.info('Saving plugin metadata to database');
      try {
        await this.savePluginMetadata(manifest, installPath, {
          devMode: actualDevMode,
          sourcePath: options?.devMode ? sourcePath : null,
          isSymlink: linkCreated,
          sourceType: options?.sourceType,
          installChannel: options?.installChannel,
          cloudPluginCode: options?.cloudPluginCode,
          cloudReleaseVersion: options?.cloudReleaseVersion,
          managedByPolicy: options?.managedByPolicy,
          policyVersion: options?.policyVersion,
          lastPolicySyncAt: options?.lastPolicySyncAt,
        });
        logger.info('Plugin metadata saved successfully');
      } catch (saveError: any) {
        logger.error('Failed to save plugin metadata', saveError);
        throw new Error(`Failed to save plugin to database: ${saveError.message}`);
      }

      // 7-9. Create folder, tables, and UI contributions (via callbacks)
      if (callbacks) {
        const { tableNameToDatasetId } = await callbacks.createFolderAndTables(manifest);

        if (manifest.contributes) {
          await callbacks.unregisterUIContributions(manifest.id);
          await callbacks.saveUIContributions(manifest, tableNameToDatasetId);
        }

        // 10. Load plugin module
        await callbacks.loadPlugin(manifest.id);
      }

      logger.info('Plugin imported successfully', { pluginId: manifest.id });

      return {
        success: true,
        pluginId: manifest.id,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error: any) {
      logger.error('Plugin import failed', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 加载插件模块
   *
   * @param pluginPath - 插件路径
   * @param manifest - 插件清单
   * @returns 加载的模块
   */
  loadModule(pluginPath: string, manifest: JSPluginManifest): any {
    return loadPluginModule(pluginPath, manifest.main);
  }

  /**
   * 从内存卸载插件模块
   */
  unloadModule(pluginPath: string, pluginId: string): void {
    const pluginDirNormalized = path.resolve(pluginPath);

    // 获取真实路径（解析 Junction/符号链接）
    let realPluginDir: string;
    try {
      realPluginDir = fs.realpathSync(pluginDirNormalized);
    } catch {
      realPluginDir = pluginDirNormalized;
    }

    logger.debug('Clearing cache for plugin', {
      pluginId,
      junctionPath: pluginDirNormalized,
      realPath: realPluginDir !== pluginDirNormalized ? realPluginDir : undefined,
    });

    const cacheKeysToDelete: string[] = [];

    // 遍历所有缓存，找出属于插件目录的模块
    for (const cachedPath in require.cache) {
      try {
        const realCachedPath = fs.realpathSync(cachedPath);
        const normalizedCachedPath = path.resolve(realCachedPath);

        if (
          normalizedCachedPath.startsWith(realPluginDir + path.sep) ||
          normalizedCachedPath === realPluginDir
        ) {
          cacheKeysToDelete.push(cachedPath);
        }
      } catch {
        // 忽略无法解析的路径
      }
    }

    // 清除所有找到的缓存
    for (const key of cacheKeysToDelete) {
      delete require.cache[key];
    }

    logger.debug('Cleared cached modules', {
      pluginId,
      count: cacheKeysToDelete.length,
      keys: cacheKeysToDelete,
    });
  }

  /**
   * 保存插件元数据到数据库
   */
  async savePluginMetadata(
    manifest: JSPluginManifest,
    pluginPath: string,
    options?: {
      devMode?: boolean;
      sourcePath?: string | null;
      isSymlink?: boolean;
      sourceType?: 'local_private' | 'cloud_managed';
      installChannel?: 'manual_import' | 'cloud_download';
      cloudPluginCode?: string;
      cloudReleaseVersion?: string;
      managedByPolicy?: boolean;
      policyVersion?: string;
      lastPolicySyncAt?: number;
    }
  ): Promise<void> {
    logger.debug('Starting metadata save', { pluginId: manifest.id });

    const sql = `
      INSERT INTO js_plugins (
        id, name, version, author, description, icon, category, main, path, installed_at, enabled,
        dev_mode, source_path, is_symlink, hot_reload_enabled,
        source_type, install_channel, cloud_plugin_code, cloud_release_version, managed_by_policy, policy_version, last_policy_sync_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const sourceType = options?.sourceType === 'cloud_managed' ? 'cloud_managed' : 'local_private';
    const installChannel =
      options?.installChannel === 'cloud_download' ? 'cloud_download' : 'manual_import';
    const cloudPluginCode = String(options?.cloudPluginCode || '').trim() || null;
    const cloudReleaseVersion = String(options?.cloudReleaseVersion || '').trim() || null;
    const managedByPolicy = options?.managedByPolicy === true;
    const policyVersion = String(options?.policyVersion || '').trim() || null;
    const lastPolicySyncAt =
      typeof options?.lastPolicySyncAt === 'number' && Number.isFinite(options.lastPolicySyncAt)
        ? Math.trunc(options.lastPolicySyncAt)
        : null;

    const params = [
      manifest.id,
      manifest.name,
      manifest.version,
      manifest.author,
      manifest.description || null,
      manifest.icon || null,
      manifest.category || null,
      manifest.main,
      pluginPath,
      Date.now(),
      true,
      options?.devMode ?? false,
      options?.sourcePath ?? null,
      options?.isSymlink ?? false,
      options?.devMode ?? false,
      sourceType,
      installChannel,
      cloudPluginCode,
      cloudReleaseVersion,
      managedByPolicy,
      policyVersion,
      lastPolicySyncAt,
    ];

    try {
      await this.duckdb.executeWithParams(sql, params);
      logger.debug('Successfully saved metadata', { pluginId: manifest.id });
    } catch (dbError: any) {
      logger.error('DuckDB error while saving metadata', dbError);
      throw dbError;
    }
  }

  /**
   * 尝试创建符号链接
   */
  async createSymbolicLink(sourcePath: string, targetPath: string): Promise<boolean> {
    logger.info('Creating symbolic link', { targetPath, sourcePath });

    try {
      // 1. 验证源路径存在且是目录
      if (!(await fs.pathExists(sourcePath))) {
        logger.error('Source path does not exist', { sourcePath });
        return false;
      }

      const sourceStats = await fs.stat(sourcePath);
      if (!sourceStats.isDirectory()) {
        logger.error('Source path is not a directory', { sourcePath });
        return false;
      }

      // 2. 确保目标路径不存在
      if (await fs.pathExists(targetPath)) {
        logger.info('Target path exists, removing', { targetPath });
        try {
          await fs.remove(targetPath);
          if (process.platform === 'win32') {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (removeError: any) {
          logger.error('Failed to remove existing target', { error: removeError.message });
          return false;
        }
      }

      // 3. 确保目标路径的父目录存在
      const targetDir = path.dirname(targetPath);
      await fs.ensureDir(targetDir);

      // 4. 创建符号链接
      if (process.platform === 'win32') {
        const sourceDrive = path.parse(path.resolve(sourcePath)).root;
        const targetDrive = path.parse(path.resolve(targetPath)).root;

        logger.debug('Drive info', { sourceDrive, targetDrive });

        if (sourceDrive.toLowerCase() !== targetDrive.toLowerCase()) {
          logger.warn('Cross-drive detected, using symlink instead of junction');
          await fs.ensureSymlink(sourcePath, targetPath, 'dir');
          logger.info('Cross-drive symlink created successfully');
        } else {
          logger.info('Creating junction (same drive)');
          await fs.ensureSymlink(sourcePath, targetPath, 'junction');
          logger.info('Junction created successfully');
        }
      } else {
        logger.info('Creating directory symlink');
        await fs.ensureSymlink(sourcePath, targetPath, 'dir');
        logger.info('Symlink created successfully');
      }

      // 5. 验证链接创建成功
      try {
        const linkStats = await fs.lstat(targetPath);
        const isValidLink =
          linkStats.isSymbolicLink() || (process.platform === 'win32' && linkStats.isDirectory());
        if (isValidLink) {
          const linkType = linkStats.isSymbolicLink() ? 'symbolic link' : 'junction';
          logger.debug('Link verification passed', { linkType });
        }
      } catch (verifyError) {
        logger.warn('Could not verify link creation', verifyError);
      }

      return true;
    } catch (error: any) {
      logger.error('Failed to create symbolic link', error);
      logger.warn('Will fallback to copy mode');
      return false;
    }
  }

  /**
   * 复制插件文件到安装目录
   */
  async copyPlugin(sourcePath: string): Promise<void> {
    logger.info('Copying plugin files', { sourcePath, targetDir: this.pluginsDir });
    await extractPlugin(sourcePath, this.pluginsDir);
    logger.info('Plugin files copied successfully');
  }

  /**
   * 安全删除插件路径
   */
  async safeRemovePluginPath(pluginPath: string, isSymlink: boolean): Promise<void> {
    if (!(await fs.pathExists(pluginPath))) {
      logger.warn('Path does not exist', { pluginPath });
      return;
    }

    const stats = await fs.lstat(pluginPath);
    const isActualSymlink = stats.isSymbolicLink();

    if (isActualSymlink || isSymlink) {
      logger.info('Removing symbolic link (source directory will be preserved)', { pluginPath });
      await fs.unlink(pluginPath);
      logger.info('Symbolic link removed');
    } else {
      logger.info('Removing directory', { pluginPath });
      await fs.remove(pluginPath);
      logger.info('Directory removed');
    }
  }

  /**
   * 移动解压后的文件到安装路径
   */
  private async moveExtractedFiles(
    manifestSourceDir: string,
    installPath: string,
    tempExtractDir: string
  ): Promise<void> {
    logger.info('Moving extracted files to final location');
    try {
      if (manifestSourceDir !== installPath && (await fs.pathExists(manifestSourceDir))) {
        if (await fs.pathExists(installPath)) {
          await fs.remove(installPath);
        }
        await fs.move(manifestSourceDir, installPath);
      }
      if (tempExtractDir && (await fs.pathExists(tempExtractDir))) {
        const remaining = await fs.readdir(tempExtractDir);
        if (remaining.length === 0) {
          await fs.remove(tempExtractDir);
        }
      }
      logger.info('Production mode files moved from temp');
    } catch (moveError: any) {
      logger.error('Move plugin failed', moveError);
      throw new Error(`移动插件文件失败：${moveError.message}`);
    }
  }

  /**
   * 设置开发模式
   */
  private async setupDevMode(
    sourcePath: string,
    installPath: string
  ): Promise<{ linkCreated: boolean; warning?: string }> {
    try {
      logger.info('Attempting to create symbolic link in development mode');
      const linkCreated = await this.createSymbolicLink(sourcePath, installPath);

      if (linkCreated) {
        logger.info('Development mode activated (symbolic link)');
        return { linkCreated: true };
      } else {
        logger.warn('Symbolic link not created, falling back to copy mode');
        try {
          await this.copyPlugin(sourcePath);
          return {
            linkCreated: false,
            warning:
              '无法创建符号链接（可能是源目录和安装目录在不同驱动器），已自动降级为复制模式。\n' +
              '在此模式下，修改源代码后需要重新导入插件才能生效。',
          };
        } catch (copyError: any) {
          throw new Error(
            `开发模式安装失败：无法创建符号链接，且复制文件也失败。错误：${copyError.message}`
          );
        }
      }
    } catch (error: any) {
      logger.error('Symbolic link creation failed with exception', error);
      try {
        await this.copyPlugin(sourcePath);
        return {
          linkCreated: false,
          warning: `创建符号链接失败: ${error.message}，已降级为复制模式`,
        };
      } catch (copyError: any) {
        throw new Error(
          `插件安装失败：开发模式下符号链接创建失败，降级复制也失败。\n` +
            `符号链接错误：${error.message}\n` +
            `复制错误：${copyError.message}`
        );
      }
    }
  }

  private getExternalPluginRootDirs(): string[] {
    const baseDirs: string[] = [];

    const addBaseDir = (baseDir: string | undefined) => {
      const normalized = String(baseDir || '').trim();
      if (normalized) {
        baseDirs.push(normalized);
      }
    };

    addBaseDir(path.dirname(process.execPath));
    addBaseDir(app.getAppPath());
    addBaseDir(process.cwd());

    const resourcesPath = (process as typeof process & { resourcesPath?: string }).resourcesPath;
    addBaseDir(resourcesPath);

    const roots: string[] = [];
    const seen = new Set<string>();
    for (const baseDir of baseDirs) {
      for (const folderName of ['plugins', 'js-plugins']) {
        const rootDir = path.resolve(baseDir, folderName);
        const key = process.platform === 'win32' ? rootDir.toLowerCase() : rootDir;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        roots.push(rootDir);
      }
    }

    return roots;
  }
}
