/**
 * FFI Callback
 *
 * 回调函数包装器，用于将 JavaScript 函数传递给原生代码
 */

import { FFIError } from './errors';

/**
 * FFI 回调函数包装器
 *
 * 将 JavaScript 函数包装为可传递给 DLL 的回调指针
 *
 * @example
 * const callback = ffiService.createCallback(
 *   { args: ['string'], returns: 'void' },
 *   (message) => console.log('DLL says:', message)
 * );
 *
 * // 将回调指针传递给 DLL
 * await lib.call('setCallback', [callback.getPointer()]);
 *
 * // 使用完毕后释放
 * callback.dispose();
 */
export class FFICallback {
  private callback: any;
  private _disposed = false;

  constructor(callback: any) {
    this.callback = callback;
  }

  /**
   * 获取回调函数指针
   *
   * 返回可传递给 DLL 函数的指针
   *
   * @throws {FFIError} 如果回调已被释放
   */
  getPointer(): any {
    if (this._disposed) {
      throw new FFIError('Callback has been disposed');
    }
    return this.callback;
  }

  /**
   * 释放回调资源
   *
   * 应在不再需要回调时调用
   * 释放后回调指针不可再使用
   */
  dispose(): void {
    if (!this._disposed) {
      this._disposed = true;
      this.callback = null;
      console.log('[FFI] Callback disposed');
    }
  }

  /**
   * 回调是否已释放
   */
  get disposed(): boolean {
    return this._disposed;
  }
}
