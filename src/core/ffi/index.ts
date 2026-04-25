/**
 * FFI (Foreign Function Interface) Module
 *
 * 提供动态链接库（DLL/.so/.dylib）的加载和调用能力
 * 基于 koffi 库实现
 *
 * 从 js-plugin/namespaces/ffi.ts 提取
 */

// 主要类
export { FFIService } from './ffi-service';
export { Library } from './library';
export { FFICallback } from './callback';

// 类型定义
export type {
  FunctionSignature,
  CallbackSignature,
  StructDefinition,
  LoadLibraryOptions,
  LibraryInfo,
  FFIServiceConfig,
} from './types';

// 错误类型
export { FFIError } from './errors';
