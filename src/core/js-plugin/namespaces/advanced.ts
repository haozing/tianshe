/**
 * Advanced Namespace - 高级 Electron API
 *
 * 提供需要特殊权限的高级能力：
 * - 剪贴板操作
 * - 桌面截图/录制
 * - 文件系统访问（沙箱限制）
 *
 * 安全说明：
 * 这些 API 具有较高的权限，建议在 manifest.json 中声明：
 * {
 *   "capabilities": ["advanced.clipboard", "advanced.desktopCapturer"]
 * }
 *
 * @example
 * // 剪贴板操作
 * helpers.advanced.clipboard.writeText('Hello');
 * const text = helpers.advanced.clipboard.readText();
 *
 * @example
 * // 桌面截图（需要权限）
 * const sources = await helpers.advanced.desktopCapturer.getSources({ types: ['screen'] });
 *
 * 注意：插件侧不再暴露 browser.cdp；网络能力请使用 browser.startNetworkCapture()/getNetworkEntries()/waitForResponse()
 */

import type { NativeImage } from 'electron';
import { clipboard, desktopCapturer, nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/**
 * 桌面捕获源类型
 */
export type DesktopCapturerSourceType = 'window' | 'screen';

/**
 * 桌面捕获选项
 */
export interface DesktopCapturerOptions {
  /** 要捕获的类型 */
  types: DesktopCapturerSourceType[];
  /** 缩略图大小 */
  thumbnailSize?: { width: number; height: number };
  /** 是否获取 fetch 窗口图标 */
  fetchWindowIcons?: boolean;
}

/**
 * 桌面捕获源信息
 */
export interface DesktopSource {
  /** 源 ID */
  id: string;
  /** 名称 */
  name: string;
  /** 缩略图（Base64） */
  thumbnail: string;
  /** 显示 ID（仅屏幕） */
  display_id?: string;
  /** 应用图标（Base64，仅窗口） */
  appIcon?: string;
}

/**
 * AdvancedNamespace - 高级 API 命名空间
 *
 * 包含非浏览器相关的高级 API：
 * - clipboard: 剪贴板操作
 * - desktopCapturer: 桌面截图
 * - fs: 沙箱文件系统
 *
 * 注意：插件侧不再暴露 browser.cdp；请改用 browser.startNetworkCapture()/getNetworkEntries()/waitForResponse()
 */
export class AdvancedNamespace {
  /** 剪贴板 API */
  public readonly clipboard: ClipboardAPI;
  /** 桌面截图 API */
  public readonly desktopCapturer: DesktopCapturerAPI;
  /** 文件系统 API（沙箱） */
  public readonly fs: FileSystemAPI;

  constructor(private pluginId: string) {
    this.clipboard = new ClipboardAPI(pluginId);
    this.desktopCapturer = new DesktopCapturerAPI(pluginId);
    this.fs = new FileSystemAPI(pluginId);
  }
}

/**
 * 剪贴板 API
 *
 * 警告：可以访问系统剪贴板，可能包含敏感信息
 */
export class ClipboardAPI {
  constructor(private pluginId: string) {}

  /**
   * 读取文本
   */
  readText(): string {
    return clipboard.readText();
  }

  /**
   * 写入文本
   */
  writeText(text: string): void {
    clipboard.writeText(text);
  }

  /**
   * 读取 HTML
   */
  readHTML(): string {
    return clipboard.readHTML();
  }

  /**
   * 写入 HTML
   */
  writeHTML(markup: string): void {
    clipboard.writeHTML(markup);
  }

  /**
   * 读取 RTF
   */
  readRTF(): string {
    return clipboard.readRTF();
  }

  /**
   * 写入 RTF
   */
  writeRTF(text: string): void {
    clipboard.writeRTF(text);
  }

  /**
   * 读取图片
   */
  readImage(): NativeImage {
    return clipboard.readImage();
  }

  /**
   * 读取图片为 Base64
   */
  readImageAsBase64(): string {
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return '';
    }
    return image.toPNG().toString('base64');
  }

  /**
   * 写入图片
   */
  writeImage(image: NativeImage): void {
    clipboard.writeImage(image);
  }

  /**
   * 从 Base64 写入图片
   */
  writeImageFromBase64(base64: string): void {
    const buffer = Buffer.from(base64, 'base64');
    const image = nativeImage.createFromBuffer(buffer);
    clipboard.writeImage(image);
  }

  /**
   * 读取书签
   */
  readBookmark(): { title: string; url: string } {
    return clipboard.readBookmark();
  }

  /**
   * 写入书签
   */
  writeBookmark(title: string, url: string): void {
    clipboard.writeBookmark(title, url);
  }

  /**
   * 清空剪贴板
   */
  clear(): void {
    clipboard.clear();
  }

  /**
   * 获取可用格式
   */
  availableFormats(): string[] {
    return clipboard.availableFormats();
  }

  /**
   * 是否有指定格式
   */
  has(format: string): boolean {
    return clipboard.has(format);
  }
}

/**
 * 桌面截图 API
 *
 * 警告：可以截取整个桌面和其他应用窗口
 * 这是高权限 API，请谨慎使用
 */
export class DesktopCapturerAPI {
  constructor(private pluginId: string) {}

  /**
   * 获取可用的捕获源
   *
   * @example
   * // 获取所有屏幕
   * const screens = await helpers.advanced.desktopCapturer.getSources({ types: ['screen'] });
   *
   * @example
   * // 获取所有窗口
   * const windows = await helpers.advanced.desktopCapturer.getSources({ types: ['window'] });
   *
   * @example
   * // 获取所有源（带缩略图）
   * const sources = await helpers.advanced.desktopCapturer.getSources({
   *   types: ['screen', 'window'],
   *   thumbnailSize: { width: 320, height: 180 }
   * });
   */
  async getSources(options: DesktopCapturerOptions): Promise<DesktopSource[]> {
    console.log(`[DesktopCapturer] Getting sources for plugin: ${this.pluginId}`, options);

    const sources = await desktopCapturer.getSources({
      types: options.types,
      thumbnailSize: options.thumbnailSize || { width: 150, height: 150 },
      fetchWindowIcons: options.fetchWindowIcons || false,
    });

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toPNG().toString('base64'),
      display_id: source.display_id,
      appIcon: source.appIcon ? source.appIcon.toPNG().toString('base64') : undefined,
    }));
  }

  /**
   * 获取所有屏幕
   */
  async getScreens(thumbnailSize?: { width: number; height: number }): Promise<DesktopSource[]> {
    return this.getSources({
      types: ['screen'],
      thumbnailSize,
    });
  }

  /**
   * 获取所有窗口
   */
  async getWindows(options?: {
    thumbnailSize?: { width: number; height: number };
    fetchWindowIcons?: boolean;
  }): Promise<DesktopSource[]> {
    return this.getSources({
      types: ['window'],
      thumbnailSize: options?.thumbnailSize,
      fetchWindowIcons: options?.fetchWindowIcons,
    });
  }

  /**
   * 获取主屏幕
   */
  async getPrimaryScreen(thumbnailSize?: {
    width: number;
    height: number;
  }): Promise<DesktopSource | null> {
    const screens = await this.getScreens(thumbnailSize);
    // 主屏幕通常是第一个
    return screens[0] || null;
  }

  /**
   * 根据窗口名称查找
   */
  async findWindowByName(
    name: string | RegExp,
    thumbnailSize?: { width: number; height: number }
  ): Promise<DesktopSource | null> {
    const windows = await this.getWindows({ thumbnailSize });
    return (
      windows.find((w) => {
        if (typeof name === 'string') {
          return w.name.includes(name);
        }
        return name.test(w.name);
      }) || null
    );
  }
}

/**
 * 文件系统 API（沙箱限制）
 *
 * 所有路径都相对于插件数据目录，无法访问系统其他位置
 */
export class FileSystemAPI {
  private baseDir: string;

  constructor(private pluginId: string) {
    // 插件数据目录：userData/plugin-data/{pluginId}
    this.baseDir = path.join(app.getPath('userData'), 'plugin-data', pluginId);
  }

  /**
   * 获取绝对路径（内部使用）
   *
   * 安全措施：
   * 1. 拒绝绝对路径输入
   * 2. 解析最终路径后验证是否在沙箱内
   * 3. 使用 path.resolve 确保正确处理 ".." 等相对路径
   */
  private getAbsolutePath(relativePath: string): string {
    // 1. 拒绝绝对路径
    if (path.isAbsolute(relativePath)) {
      throw new Error('Absolute paths are not allowed');
    }

    // 2. 解析最终路径
    const resolvedPath = path.resolve(this.baseDir, relativePath);

    // 3. 验证解析后的路径仍在沙箱内
    // 使用 path.normalize 确保路径格式一致（处理 Windows/Unix 差异）
    const normalizedBase = path.normalize(this.baseDir + path.sep);
    const normalizedResolved = path.normalize(resolvedPath);

    if (!normalizedResolved.startsWith(normalizedBase)) {
      throw new Error(`Path traversal detected: "${relativePath}" resolves outside sandbox`);
    }

    return resolvedPath;
  }

  /**
   * 确保目录存在
   */
  private async ensureDir(dirPath: string): Promise<void> {
    try {
      await fs.promises.mkdir(dirPath, { recursive: true });
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * 读取文件
   *
   * @example
   * const content = await helpers.advanced.fs.readFile('config.json');
   * const json = JSON.parse(content.toString());
   */
  async readFile(relativePath: string): Promise<Buffer> {
    const absPath = this.getAbsolutePath(relativePath);
    return fs.promises.readFile(absPath);
  }

  /**
   * 读取文件为文本
   */
  async readTextFile(relativePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    const buffer = await this.readFile(relativePath);
    return buffer.toString(encoding);
  }

  /**
   * 读取 JSON 文件
   */
  async readJSON<T = any>(relativePath: string): Promise<T> {
    const text = await this.readTextFile(relativePath);
    return JSON.parse(text);
  }

  /**
   * 写入文件
   *
   * @example
   * await helpers.advanced.fs.writeFile('config.json', JSON.stringify(config));
   */
  async writeFile(relativePath: string, data: Buffer | string): Promise<void> {
    const absPath = this.getAbsolutePath(relativePath);
    await this.ensureDir(path.dirname(absPath));
    await fs.promises.writeFile(absPath, data);
  }

  /**
   * 写入 JSON 文件
   */
  async writeJSON(relativePath: string, data: any, pretty: boolean = true): Promise<void> {
    const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    await this.writeFile(relativePath, text);
  }

  /**
   * 检查文件是否存在
   */
  async exists(relativePath: string): Promise<boolean> {
    const absPath = this.getAbsolutePath(relativePath);
    try {
      await fs.promises.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 创建目录
   */
  async mkdir(relativePath: string): Promise<void> {
    const absPath = this.getAbsolutePath(relativePath);
    await fs.promises.mkdir(absPath, { recursive: true });
  }

  /**
   * 列出目录内容
   */
  async readdir(relativePath: string = ''): Promise<string[]> {
    const absPath = this.getAbsolutePath(relativePath);
    return fs.promises.readdir(absPath);
  }

  /**
   * 删除文件
   */
  async unlink(relativePath: string): Promise<void> {
    const absPath = this.getAbsolutePath(relativePath);
    await fs.promises.unlink(absPath);
  }

  /**
   * 删除目录（递归）
   */
  async rmdir(relativePath: string): Promise<void> {
    const absPath = this.getAbsolutePath(relativePath);
    await fs.promises.rm(absPath, { recursive: true, force: true });
  }

  /**
   * 获取文件信息
   */
  async stat(relativePath: string): Promise<fs.Stats> {
    const absPath = this.getAbsolutePath(relativePath);
    return fs.promises.stat(absPath);
  }

  /**
   * 复制文件
   */
  async copyFile(src: string, dest: string): Promise<void> {
    const srcPath = this.getAbsolutePath(src);
    const destPath = this.getAbsolutePath(dest);
    await this.ensureDir(path.dirname(destPath));
    await fs.promises.copyFile(srcPath, destPath);
  }

  /**
   * 重命名/移动文件
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const srcPath = this.getAbsolutePath(oldPath);
    const destPath = this.getAbsolutePath(newPath);
    await this.ensureDir(path.dirname(destPath));
    await fs.promises.rename(srcPath, destPath);
  }

  /**
   * 获取插件数据目录路径
   */
  getDataDir(): string {
    return this.baseDir;
  }
}
