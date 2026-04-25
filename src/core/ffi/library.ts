/**
 * Library Class
 *
 * 动态链接库实例，提供函数定义和调用能力
 */

import * as koffi from 'koffi';
import { FFIError } from './errors';
import { FFI_TYPE_MAP } from './types';
import type { FunctionSignature } from './types';

/**
 * 动态链接库实例
 *
 * 表示一个已加载的 DLL/SO/DYLIB 文件
 * 提供函数定义、调用、函数指针获取等功能
 *
 * @example
 * const lib = await ffiService.loadLibrary('user32.dll');
 *
 * // 定义函数
 * lib.defineFunction('MessageBoxA', {
 *   args: ['pointer', 'string', 'string', 'uint'],
 *   returns: 'int'
 * });
 *
 * // 调用函数
 * await lib.call('MessageBoxA', [null, 'Hello', 'Title', 0]);
 */
export class Library {
  /** 已定义的函数 */
  private functions = new Map<string, { func: any; signature: FunctionSignature }>();

  /** koffi 库实例 */
  private koffiLib: any;

  constructor(
    /** 库文件路径 */
    public readonly libPath: string,
    koffiLib: any,
    private callerId: string
  ) {
    this.koffiLib = koffiLib;
  }

  /**
   * 定义库中的函数
   *
   * @param name - 函数名（需与 DLL 导出名称一致）
   * @param signature - 函数签名
   *
   * @example
   * lib.defineFunction('MessageBoxA', {
   *   args: ['pointer', 'string', 'string', 'uint'],
   *   returns: 'int'
   * });
   */
  defineFunction(name: string, signature: FunctionSignature): void {
    try {
      // 转换类型签名为 koffi 格式
      const koffiSignature = this.buildKoffiSignature(signature);

      // 定义函数
      const func = this.koffiLib.func(name, koffiSignature, signature.returns);

      this.functions.set(name, {
        func,
        signature,
      });

      console.log(`[FFI] Defined function: ${this.libPath}::${name}`);
    } catch (error: any) {
      throw new FFIError(
        `Failed to define function '${name}': ${error.message}`,
        'DEFINE_FAILED',
        error
      );
    }
  }

  /**
   * 批量定义多个函数
   *
   * @param definitions - 函数定义映射
   *
   * @example
   * lib.defineFunctions({
   *   'MessageBoxA': { args: ['pointer', 'string', 'string', 'uint'], returns: 'int' },
   *   'GetTickCount': { args: [], returns: 'uint' }
   * });
   */
  defineFunctions(definitions: Record<string, FunctionSignature>): void {
    for (const [name, signature] of Object.entries(definitions)) {
      this.defineFunction(name, signature);
    }
  }

  /**
   * 异步调用库函数
   *
   * @param name - 函数名
   * @param args - 参数列表
   * @returns 函数返回值
   *
   * @example
   * const result = await lib.call('MessageBoxA', [null, 'Hello', 'Title', 0]);
   */
  async call(name: string, args: any[]): Promise<any> {
    const startTime = Date.now();

    try {
      if (!this.functions.has(name)) {
        throw new FFIError(`Function '${name}' not defined`, 'NOT_DEFINED');
      }

      const { func, signature } = this.functions.get(name)!;

      if (args.length !== signature.args.length) {
        throw new FFIError(
          `Argument count mismatch: expected ${signature.args.length}, got ${args.length}`,
          'ARG_MISMATCH'
        );
      }

      console.log(`[FFI] Calling ${this.libPath}::${name}`);

      // 调用函数
      const result = func(...args);

      const duration = Date.now() - startTime;
      console.log(`[FFI] ${name} completed in ${duration}ms`);

      return result;
    } catch (error: any) {
      console.error(`[FFI] Error calling ${this.libPath}::${name}:`, error);
      if (error instanceof FFIError) throw error;
      throw new FFIError(`FFI call failed: ${error.message}`, 'CALL_FAILED', error);
    }
  }

  /**
   * 同步调用库函数
   *
   * @param name - 函数名
   * @param args - 参数列表
   * @returns 函数返回值
   *
   * @example
   * const ticks = lib.callSync('GetTickCount', []);
   */
  callSync(name: string, args: any[]): any {
    if (!this.functions.has(name)) {
      throw new FFIError(`Function '${name}' not defined`, 'NOT_DEFINED');
    }

    const { func, signature } = this.functions.get(name)!;

    if (args.length !== signature.args.length) {
      throw new FFIError(
        `Argument count mismatch: expected ${signature.args.length}, got ${args.length}`,
        'ARG_MISMATCH'
      );
    }

    return func(...args);
  }

  /**
   * 获取函数指针
   *
   * @param name - 函数名
   * @returns 函数指针地址
   */
  getFunctionPointer(name: string): any {
    if (!this.functions.has(name)) {
      throw new FFIError(`Function '${name}' not defined`, 'NOT_DEFINED');
    }

    const { func } = this.functions.get(name)!;
    return koffi.address(func);
  }

  /**
   * 获取已定义的函数名列表
   */
  getDefinedFunctions(): string[] {
    return Array.from(this.functions.keys());
  }

  /**
   * 检查函数是否已定义
   */
  hasFunction(name: string): boolean {
    return this.functions.has(name);
  }

  /**
   * 卸载库
   *
   * 清理已定义的函数，释放资源
   */
  unload(): void {
    console.log(`[FFI] Unloading library: ${this.libPath}`);
    this.functions.clear();
    // koffi 会自动处理库的卸载
  }

  /**
   * 构建 koffi 函数签名
   */
  private buildKoffiSignature(signature: FunctionSignature): string[] {
    return signature.args.map((type) => this.mapFFIType(type));
  }

  /**
   * 映射 FFI 类型到 koffi 类型
   */
  private mapFFIType(type: string): string {
    return FFI_TYPE_MAP[type] || type;
  }
}
