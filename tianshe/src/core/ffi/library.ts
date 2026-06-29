/**
 * Library Class
 *
 * 动态链接库实例，提供函数定义和调用能力
 */

import * as koffi from 'koffi';
import { ChildProcessFFIIsolatedCallRunner } from './isolated-runner';
import { FFIError } from './errors';
import { FFI_TYPE_MAP } from './types';
import type { FFICallOptions, FFIIsolatedCallRunner, FunctionSignature } from './types';
import { getUnknownErrorMessage, toError } from '../../utils/error-message';
import { createLogger } from '../logger';

const logger = createLogger('FFILibrary');
const DEFAULT_FFI_CALL_TIMEOUT_MS = 5000;
const defaultIsolatedCallRunner = new ChildProcessFFIIsolatedCallRunner();

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

  private readonly options: {
    isolateCalls: boolean;
    defaultCallTimeoutMs: number;
    isolatedCallRunner: FFIIsolatedCallRunner;
  };

  constructor(
    /** 库文件路径 */
    public readonly libPath: string,
    koffiLib: any,
    private callerId: string,
    options: Partial<{
      isolateCalls: boolean;
      defaultCallTimeoutMs: number;
      isolatedCallRunner: FFIIsolatedCallRunner;
    }> = {}
  ) {
    this.koffiLib = koffiLib;
    this.options = {
      isolateCalls: options.isolateCalls ?? true,
      defaultCallTimeoutMs: options.defaultCallTimeoutMs ?? DEFAULT_FFI_CALL_TIMEOUT_MS,
      isolatedCallRunner: options.isolatedCallRunner ?? defaultIsolatedCallRunner,
    };
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

      logger.info('FFI function defined', {
        callerId: this.callerId,
        libraryPath: this.libPath,
        functionName: name,
      });
    } catch (error: unknown) {
      throw new FFIError(
        `Failed to define function '${name}': ${getUnknownErrorMessage(error)}`,
        'DEFINE_FAILED',
        toError(error)
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
  async call(name: string, args: any[], options: FFICallOptions = {}): Promise<any> {
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

      logger.info('Calling FFI function', {
        callerId: this.callerId,
        libraryPath: this.libPath,
        functionName: name,
        isolated: this.shouldUseIsolatedCall(signature, options),
      });

      const result = this.shouldUseIsolatedCall(signature, options)
        ? await this.callIsolated(name, signature, args, options)
        : await this.callInProcess(func, args, this.resolveTimeoutMs(signature, options));

      const duration = Date.now() - startTime;
      logger.info('FFI function completed', {
        callerId: this.callerId,
        libraryPath: this.libPath,
        functionName: name,
        durationMs: duration,
      });

      return result;
    } catch (error: unknown) {
      logger.error('Failed to call FFI function', {
        callerId: this.callerId,
        libraryPath: this.libPath,
        functionName: name,
        errorMessage: getUnknownErrorMessage(error),
      });
      if (error instanceof FFIError) throw error;
      throw new FFIError(
        `FFI call failed: ${getUnknownErrorMessage(error)}`,
        'CALL_FAILED',
        toError(error)
      );
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
   * 显式非隔离异步调用。仅用于回调、指针或结构体参数等无法跨子进程序列化的 FFI 场景。
   */
  async callUnsafeInProcess(
    name: string,
    args: any[],
    options: Omit<FFICallOptions, 'isolated'> = {}
  ): Promise<any> {
    return this.call(name, args, { ...options, isolated: false });
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
    logger.info('Unloading FFI library', {
      callerId: this.callerId,
      libraryPath: this.libPath,
    });
    this.functions.clear();
    // koffi 会自动处理库的卸载
  }

  private shouldUseIsolatedCall(
    signature: FunctionSignature,
    options: FFICallOptions
  ): boolean {
    return options.isolated ?? signature.isolated ?? this.options.isolateCalls;
  }

  private async callIsolated(
    functionName: string,
    signature: FunctionSignature,
    args: any[],
    options: FFICallOptions
  ): Promise<any> {
    this.assertIsolatedCallSupported(signature, args);
    const timeoutMs = this.resolveTimeoutMs(signature, options);
    return await this.options.isolatedCallRunner.run(
      {
        libPath: this.libPath,
        functionName,
        signature,
        args,
        callerId: this.callerId,
      },
      { timeoutMs }
    );
  }

  private async callInProcess(func: any, args: any[], timeoutMs: number): Promise<any> {
    let timeout: NodeJS.Timeout | null = null;
    try {
      const callPromise = Promise.resolve().then(() => func(...args));
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new FFIError(`FFI call timed out after ${timeoutMs}ms`, 'CALL_TIMEOUT'));
        }, timeoutMs);
      });
      return await Promise.race([callPromise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private resolveTimeoutMs(signature: FunctionSignature, options: FFICallOptions): number {
    const value = options.timeoutMs ?? signature.timeoutMs ?? this.options.defaultCallTimeoutMs;
    if (!Number.isFinite(value) || value <= 0) {
      return DEFAULT_FFI_CALL_TIMEOUT_MS;
    }
    return Math.max(1, Math.trunc(value));
  }

  private assertIsolatedCallSupported(signature: FunctionSignature, args: any[]): void {
    const unsupportedTypeIndex = signature.args.findIndex((type) =>
      this.isNonSerializableFFIType(type)
    );
    if (unsupportedTypeIndex >= 0) {
      throw new FFIError(
        `FFI isolated call does not support argument type '${signature.args[unsupportedTypeIndex]}' at index ${unsupportedTypeIndex}; use callUnsafeInProcess() only for trusted callbacks/pointers`,
        'ISOLATED_CALL_UNSUPPORTED'
      );
    }

    if (!this.isSerializableValue(args)) {
      throw new FFIError(
        'FFI isolated call arguments must be structured-clone serializable; use callUnsafeInProcess() only for trusted callbacks/pointers',
        'ISOLATED_CALL_UNSUPPORTED'
      );
    }
  }

  private isNonSerializableFFIType(type: string): boolean {
    const normalized = String(type).trim().toLowerCase();
    return (
      normalized === 'pointer' ||
      normalized === 'void*' ||
      normalized.endsWith('*') ||
      normalized.includes('callback') ||
      normalized === 'function'
    );
  }

  private isSerializableValue(value: unknown, seen = new Set<object>()): boolean {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return true;
    }

    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
      return false;
    }

    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      return true;
    }

    if (value instanceof Date) {
      return true;
    }

    if (Array.isArray(value)) {
      return value.every((item) => this.isSerializableValue(item, seen));
    }

    if (typeof value === 'object') {
      const objectValue = value as Record<string, unknown>;
      if (seen.has(objectValue)) return false;
      seen.add(objectValue);
      return Object.values(objectValue).every((item) => this.isSerializableValue(item, seen));
    }

    return false;
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
