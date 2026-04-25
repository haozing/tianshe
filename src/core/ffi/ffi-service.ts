/**
 * FFI Service
 *
 * 提供动态链接库（DLL/.so/.dylib）的加载和调用能力
 * 基于 koffi 库实现
 */

import * as koffi from 'koffi';
import * as path from 'path';
import * as fs from 'fs-extra';
import { app } from 'electron';
import { Library } from './library';
import { FFICallback } from './callback';
import { FFIError } from './errors';
import { FFI_TYPE_MAP, SYSTEM_LIBS_WHITELIST } from './types';
import type {
  FFIServiceConfig,
  CallbackSignature,
  StructDefinition,
  LoadLibraryOptions,
  LibraryInfo,
} from './types';

/**
 * FFI 服务
 *
 * 提供动态链接库加载、函数调用、回调创建等能力
 *
 * @example
 * const ffiService = new FFIService({ callerId: 'my-app' });
 *
 * // 加载系统库
 * const kernel32 = await ffiService.loadLibrary('kernel32.dll');
 *
 * // 定义并调用函数
 * kernel32.defineFunction('GetTickCount', {
 *   args: [],
 *   returns: 'uint'
 * });
 * const ticks = await kernel32.call('GetTickCount', []);
 */
export class FFIService {
  /** 已加载的库 */
  private libraries = new Map<string, Library>();

  /** 已创建的回调 */
  private callbacks = new Set<FFICallback>();

  /** 最大库数量限制 */
  private readonly maxLibraries: number;

  /** 最大回调数量限制 */
  private readonly maxCallbacks: number;

  /** 调用者标识 */
  private readonly callerId: string;

  /** 额外允许的路径 */
  private readonly allowedPaths: string[];

  constructor(config: FFIServiceConfig) {
    this.callerId = config.callerId;
    this.maxLibraries = config.maxLibraries ?? 10;
    this.maxCallbacks = config.maxCallbacks ?? 50;
    this.allowedPaths = config.allowedPaths ?? [];

    console.log(`[FFI] Initialized for caller: ${this.callerId}`);
  }

  /**
   * 加载动态链接库
   *
   * @param libPath - 库文件路径（绝对路径或系统库名）
   * @param options - 加载选项
   * @returns Library 实例
   *
   * @example
   * // 加载系统库
   * const kernel32 = await ffiService.loadLibrary('kernel32.dll');
   *
   * @example
   * // 加载自定义库
   * const myLib = await ffiService.loadLibrary('C:/path/to/mylib.dll');
   */
  async loadLibrary(libPath: string, _options?: LoadLibraryOptions): Promise<Library> {
    // 路径验证
    const safePath = this.validateLibraryPath(libPath);

    // 限制检查
    if (this.libraries.size >= this.maxLibraries) {
      throw new FFIError(`Maximum library limit reached (${this.maxLibraries})`, 'LIMIT_EXCEEDED');
    }

    // 检查是否已加载
    if (this.libraries.has(safePath)) {
      console.log(`[FFI] Library already loaded: ${safePath}`);
      return this.libraries.get(safePath)!;
    }

    try {
      console.log(`[FFI] Loading library: ${safePath}`);

      // 使用 koffi 加载库
      const koffiLib = koffi.load(safePath);

      // 创建 Library 实例
      const library = new Library(safePath, koffiLib, this.callerId);

      // 缓存
      this.libraries.set(safePath, library);

      console.log(`[FFI] Library loaded successfully: ${safePath}`);

      return library;
    } catch (error: any) {
      console.error(`[FFI] Failed to load library ${safePath}:`, error);
      throw new FFIError(`Failed to load library: ${error.message}`, 'LOAD_FAILED', error);
    }
  }

  /**
   * 创建 FFI 回调函数
   *
   * @param signature - 函数签名
   * @param fn - JavaScript 回调函数
   * @returns Callback 对象
   *
   * @example
   * const callback = ffiService.createCallback(
   *   { args: ['string'], returns: 'void' },
   *   (message) => console.log('DLL says:', message)
   * );
   */
  createCallback(signature: CallbackSignature, fn: (...args: any[]) => any): FFICallback {
    // 限制检查
    if (this.callbacks.size >= this.maxCallbacks) {
      throw new FFIError(`Maximum callback limit reached (${this.maxCallbacks})`, 'LIMIT_EXCEEDED');
    }

    try {
      // 构建 koffi 回调签名
      const argsSignature = signature.args.map((type) => this.mapFFIType(type)).join(', ');
      const returnType = this.mapFFIType(signature.returns);
      const koffiSignature = `${returnType} callback(${argsSignature})`;

      // 注册回调
      const callback = koffi.register(fn, koffiSignature);

      // 创建包装器
      const wrapper = new FFICallback(callback);
      this.callbacks.add(wrapper);

      console.log(`[FFI] Callback created for caller: ${this.callerId}`);

      return wrapper;
    } catch (error: any) {
      console.error(`[FFI] Failed to create callback:`, error);
      throw new FFIError(`Failed to create callback: ${error.message}`, 'CALLBACK_FAILED', error);
    }
  }

  /**
   * 定义结构体类型
   *
   * @param name - 结构体名称
   * @param definition - 结构体定义
   * @returns 结构体类型
   *
   * @example
   * const Point = ffiService.defineStruct('Point', {
   *   x: 'int',
   *   y: 'int'
   * });
   */
  defineStruct(name: string, definition: StructDefinition): any {
    try {
      const fields: Record<string, any> = {};

      for (const [fieldName, fieldType] of Object.entries(definition)) {
        const koffiType = this.mapFFIType(fieldType);
        fields[fieldName] = koffiType;
      }

      // 使用 koffi 定义结构体
      const struct = koffi.struct(name, fields);

      console.log(`[FFI] Struct '${name}' defined for caller: ${this.callerId}`);

      return struct;
    } catch (error: any) {
      console.error(`[FFI] Failed to define struct:`, error);
      throw new FFIError(`Failed to define struct: ${error.message}`, 'STRUCT_FAILED', error);
    }
  }

  /**
   * 获取已加载的库
   *
   * @param libPath - 库路径
   * @returns Library 实例或 undefined
   */
  getLibrary(libPath: string): Library | undefined {
    const normalizedPath = path.normalize(libPath);
    return this.libraries.get(normalizedPath);
  }

  /**
   * 列出所有已加载的库
   */
  async listLibraries(): Promise<LibraryInfo[]> {
    const result: LibraryInfo[] = [];

    for (const [libPath, lib] of this.libraries) {
      result.push({
        path: libPath,
        functions: lib.getDefinedFunctions(),
        loadedAt: Date.now(), // 简化：实际应该记录真实时间
        unloaded: false,
      });
    }

    return result;
  }

  /**
   * 卸载指定库
   *
   * @param libPath - 库路径
   */
  unloadLibrary(libPath: string): void {
    const normalizedPath = path.normalize(libPath);
    const lib = this.libraries.get(normalizedPath);

    if (lib) {
      lib.unload();
      this.libraries.delete(normalizedPath);
      console.log(`[FFI] Library unloaded: ${normalizedPath}`);
    }
  }

  /**
   * 释放所有资源
   *
   * 卸载所有库，释放所有回调
   */
  dispose(): void {
    console.log(`[FFI] Disposing resources for caller: ${this.callerId}`);

    // 释放所有回调
    for (const callback of this.callbacks) {
      try {
        callback.dispose();
      } catch (error) {
        console.error(`[FFI] Error disposing callback:`, error);
      }
    }
    this.callbacks.clear();

    // 卸载所有库
    for (const [libPath, lib] of this.libraries) {
      try {
        lib.unload();
      } catch (error) {
        console.error(`[FFI] Error unloading library ${libPath}:`, error);
      }
    }
    this.libraries.clear();

    console.log(`[FFI] Resources disposed for caller: ${this.callerId}`);
  }

  /**
   * 获取统计信息
   */
  getStats(): { libraryCount: number; callbackCount: number } {
    return {
      libraryCount: this.libraries.size,
      callbackCount: this.callbacks.size,
    };
  }

  /**
   * 验证库路径安全性
   */
  private validateLibraryPath(libPath: string): string {
    const normalizedPath = path.normalize(libPath);

    // 检查系统库白名单
    const libName = path.basename(normalizedPath).toLowerCase();
    if (SYSTEM_LIBS_WHITELIST.includes(libName)) {
      return normalizedPath;
    }

    // 构建允许的路径列表
    const allowedPaths = [
      // 用户配置的额外路径
      ...this.allowedPaths,

      // 插件目录
      path.join(app.getPath('userData'), 'js-plugins', this.callerId),

      // 共享库目录
      path.join(app.getPath('userData'), 'lib'),
    ];

    // Windows 系统目录
    if (process.platform === 'win32') {
      allowedPaths.push('C:\\Windows\\System32');
      allowedPaths.push('C:\\Windows\\SysWOW64');
    }

    // 检查路径是否在白名单内
    const isAllowed = allowedPaths.some((allowed) => normalizedPath.startsWith(allowed));

    if (!isAllowed) {
      throw new FFIError(
        `Library path not allowed: ${normalizedPath}\n` +
          `Allowed paths:\n${allowedPaths.map((p) => `  - ${p}`).join('\n')}`,
        'PATH_NOT_ALLOWED'
      );
    }

    // 检查文件是否存在
    if (!fs.existsSync(normalizedPath)) {
      throw new FFIError(`Library file not found: ${normalizedPath}`, 'NOT_FOUND');
    }

    return normalizedPath;
  }

  /**
   * 映射 FFI 类型到 koffi 类型
   */
  private mapFFIType(type: string): string {
    return FFI_TYPE_MAP[type] || type;
  }
}
