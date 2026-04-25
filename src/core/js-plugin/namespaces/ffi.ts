/**
 * FFI (Foreign Function Interface) Namespace
 *
 * 提供动态链接库（DLL/.so/.dylib）的加载和调用能力
 * 基于 koffi 库实现
 *
 * 此模块是 core/ffi 的插件层封装
 *
 * @example
 * // 加载 Windows DLL
 * const lib = await helpers.ffi.loadLibrary('kernel32.dll');
 *
 * @example
 * // 加载自定义 DLL
 * const myLib = await helpers.ffi.loadLibrary('C:/path/to/mylib.dll');
 */

import { FFIService, Library, FFICallback } from '../../ffi';
import type {
  CallbackSignature,
  StructDefinition,
  LoadLibraryOptions,
  LibraryInfo,
} from '../../ffi';
import type { JSPluginManifest } from '../../../types/js-plugin';

// Re-export types and classes
export { Library, FFICallback } from '../../ffi';
export type {
  FunctionSignature,
  CallbackSignature,
  StructDefinition,
  LoadLibraryOptions,
  LibraryInfo,
} from '../../ffi';

/**
 * FFI 命名空间
 *
 * 提供动态链接库加载和调用能力
 *
 * @example
 * const lib = await helpers.ffi.loadLibrary('kernel32.dll');
 * lib.defineFunction('GetTickCount', { args: [], returns: 'uint' });
 * const ticks = await lib.call('GetTickCount', []);
 */
export class FFINamespace {
  private readonly ffiService: FFIService;

  constructor(
    private pluginId: string,
    _manifest: JSPluginManifest
  ) {
    this.ffiService = new FFIService({ callerId: pluginId });
    console.log(`[FFI] Initialized for plugin: ${pluginId}`);
  }

  /**
   * 加载动态链接库
   *
   * @param libPath - 库文件路径（绝对路径或系统库名）
   * @param options - 加载选项
   * @returns Library 实例
   *
   * @example
   * const kernel32 = await helpers.ffi.loadLibrary('kernel32.dll');
   */
  async loadLibrary(libPath: string, options?: LoadLibraryOptions): Promise<Library> {
    return this.ffiService.loadLibrary(libPath, options);
  }

  /**
   * 创建 FFI 回调函数
   *
   * @param signature - 函数签名
   * @param fn - JavaScript 回调函数
   * @returns Callback 对象
   *
   * @example
   * const callback = helpers.ffi.createCallback(
   *   { args: ['string'], returns: 'void' },
   *   (message) => console.log('DLL says:', message)
   * );
   */
  createCallback(signature: CallbackSignature, fn: (...args: any[]) => any): FFICallback {
    return this.ffiService.createCallback(signature, fn);
  }

  /**
   * 定义结构体类型
   *
   * @param definition - 结构体定义
   * @returns 结构体类型
   *
   * @example
   * const Point = helpers.ffi.defineStruct({ x: 'int', y: 'int' });
   */
  defineStruct(definition: StructDefinition): any {
    return this.ffiService.defineStruct('CustomStruct', definition);
  }

  /**
   * 列出插件加载的所有库
   */
  async listLibraries(): Promise<LibraryInfo[]> {
    return this.ffiService.listLibraries();
  }

  /**
   * 释放所有资源（插件停止时自动调用）
   */
  dispose(): void {
    this.ffiService.dispose();
  }
}
