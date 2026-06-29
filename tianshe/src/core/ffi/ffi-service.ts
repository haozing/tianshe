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
  FFIIsolatedCallRunner,
} from './types';
import { getUnknownErrorMessage, toError } from '../../utils/error-message';
import { createLogger } from '../logger';

const SYSTEM_LIBS_ALLOWLIST = new Set(SYSTEM_LIBS_WHITELIST.map((lib) => lib.toLowerCase()));
const logger = createLogger('FFIService');
const DEFAULT_FFI_CALL_TIMEOUT_MS = 5000;

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

  /** 库首次加载时间 */
  private libraryLoadedAt = new Map<string, number>();

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

  /** 是否默认隔离异步调用 */
  private readonly isolateCalls: boolean;

  /** 默认调用超时 */
  private readonly defaultCallTimeoutMs: number;

  /** 隔离调用执行器 */
  private readonly isolatedCallRunner?: FFIIsolatedCallRunner;

  constructor(config: FFIServiceConfig) {
    this.callerId = config.callerId;
    this.maxLibraries = config.maxLibraries ?? 10;
    this.maxCallbacks = config.maxCallbacks ?? 50;
    this.allowedPaths = config.allowedPaths ?? [];
    this.isolateCalls = config.isolateCalls ?? true;
    this.defaultCallTimeoutMs = normalizeCallTimeoutMs(config.defaultCallTimeoutMs);
    this.isolatedCallRunner = config.isolatedCallRunner;

    logger.info('FFI service initialized', { callerId: this.callerId });
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
      logger.info('FFI library already loaded', {
        callerId: this.callerId,
        libraryPath: safePath,
      });
      return this.libraries.get(safePath)!;
    }

    try {
      logger.info('Loading FFI library', {
        callerId: this.callerId,
        libraryPath: safePath,
      });

      // 使用 koffi 加载库
      const koffiLib = koffi.load(safePath);

      // 创建 Library 实例
      const library = new Library(safePath, koffiLib, this.callerId, {
        isolateCalls: this.isolateCalls,
        defaultCallTimeoutMs: this.defaultCallTimeoutMs,
        ...(this.isolatedCallRunner ? { isolatedCallRunner: this.isolatedCallRunner } : {}),
      });

      // 缓存
      this.libraries.set(safePath, library);
      this.libraryLoadedAt.set(safePath, Date.now());

      logger.info('FFI library loaded successfully', {
        callerId: this.callerId,
        libraryPath: safePath,
      });

      return library;
    } catch (error: unknown) {
      logger.error('Failed to load FFI library', {
        callerId: this.callerId,
        libraryPath: safePath,
        errorMessage: getUnknownErrorMessage(error),
      });
      throw new FFIError(
        `Failed to load library: ${getUnknownErrorMessage(error)}`,
        'LOAD_FAILED',
        toError(error)
      );
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

      logger.info('FFI callback created', { callerId: this.callerId });

      return wrapper;
    } catch (error: unknown) {
      logger.error('Failed to create FFI callback', {
        callerId: this.callerId,
        errorMessage: getUnknownErrorMessage(error),
      });
      throw new FFIError(
        `Failed to create callback: ${getUnknownErrorMessage(error)}`,
        'CALLBACK_FAILED',
        toError(error)
      );
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

      logger.info('FFI struct defined', {
        callerId: this.callerId,
        structName: name,
      });

      return struct;
    } catch (error: unknown) {
      logger.error('Failed to define FFI struct', {
        callerId: this.callerId,
        structName: name,
        errorMessage: getUnknownErrorMessage(error),
      });
      throw new FFIError(
        `Failed to define struct: ${getUnknownErrorMessage(error)}`,
        'STRUCT_FAILED',
        toError(error)
      );
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
        loadedAt: this.libraryLoadedAt.get(libPath) ?? Date.now(),
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
      this.libraryLoadedAt.delete(normalizedPath);
      logger.info('FFI library unloaded', {
        callerId: this.callerId,
        libraryPath: normalizedPath,
      });
    }
  }

  /**
   * 释放所有资源
   *
   * 卸载所有库，释放所有回调
   */
  dispose(): void {
    logger.info('Disposing FFI resources', { callerId: this.callerId });

    // 释放所有回调
    for (const callback of this.callbacks) {
      try {
        callback.dispose();
      } catch (error) {
        logger.error('Failed to dispose FFI callback', {
          callerId: this.callerId,
          errorMessage: getUnknownErrorMessage(error),
        });
      }
    }
    this.callbacks.clear();

    // 卸载所有库
    for (const [libPath, lib] of this.libraries) {
      try {
        lib.unload();
      } catch (error) {
        logger.error('Failed to unload FFI library during dispose', {
          callerId: this.callerId,
          libraryPath: libPath,
          errorMessage: getUnknownErrorMessage(error),
        });
      }
    }
    this.libraries.clear();
    this.libraryLoadedAt.clear();

    logger.info('FFI resources disposed', { callerId: this.callerId });
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
    const requestedPath = path.resolve(libPath);
    const normalizedPath = path.normalize(requestedPath);

    // Bare system library names are allowed. Full paths still go through the
    // directory boundary check below.
    const libName = path.basename(libPath).toLowerCase();
    const isBareLibraryName = libName === libPath.toLowerCase();
    if (isBareLibraryName && SYSTEM_LIBS_ALLOWLIST.has(libName)) {
      return libPath;
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

    if (!fs.existsSync(normalizedPath)) {
      throw new FFIError(`Library file not found: ${normalizedPath}`, 'NOT_FOUND');
    }

    const realLibraryPath = this.resolveRealPath(normalizedPath, 'library');
    const allowedRealPaths = allowedPaths
      .filter((allowed) => fs.existsSync(allowed))
      .map((allowed) => this.resolveRealPath(allowed, 'allowed path'));

    // 检查路径是否在白名单内
    const isAllowed = allowedRealPaths.some((allowed) =>
      this.isPathWithinDirectory(realLibraryPath, allowed)
    );

    if (!isAllowed) {
      throw new FFIError(
        `Library path not allowed: ${realLibraryPath}\n` +
          `Allowed paths:\n${allowedRealPaths.map((p) => `  - ${p}`).join('\n')}`,
        'PATH_NOT_ALLOWED'
      );
    }

    return realLibraryPath;
  }

  private resolveRealPath(targetPath: string, label: string): string {
    try {
      return path.normalize(fs.realpathSync(path.resolve(targetPath)));
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new FFIError(`Failed to resolve ${label}: ${targetPath}`, 'PATH_NOT_ALLOWED', cause);
    }
  }

  private normalizePathForComparison(targetPath: string): string {
    const normalized = path.normalize(path.resolve(targetPath));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  private isPathWithinDirectory(targetPath: string, directory: string): boolean {
    const target = this.normalizePathForComparison(targetPath);
    const base = this.normalizePathForComparison(directory);
    return target === base || target.startsWith(base + path.sep);
  }

  /**
   * 映射 FFI 类型到 koffi 类型
   */
  private mapFFIType(type: string): string {
    return FFI_TYPE_MAP[type] || type;
  }
}

function normalizeCallTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value) || Number(value) <= 0) {
    return DEFAULT_FFI_CALL_TIMEOUT_MS;
  }
  return Math.max(1, Math.trunc(Number(value)));
}
