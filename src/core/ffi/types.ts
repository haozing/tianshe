/**
 * FFI 类型定义
 *
 * 提供 FFI 模块的所有类型定义
 */

/**
 * 函数签名定义
 */
export interface FunctionSignature {
  /** 参数类型列表 */
  args: string[];
  /** 返回值类型 */
  returns: string;
  /** 是否异步调用 */
  async?: boolean;
  /** 调用约定 */
  abi?: 'default' | 'stdcall' | 'cdecl' | 'fastcall';
}

/**
 * 回调函数签名定义
 */
export interface CallbackSignature {
  /** 参数类型列表 */
  args: string[];
  /** 返回值类型 */
  returns: string;
  /** 调用约定 */
  abi?: 'default' | 'stdcall' | 'cdecl';
}

/**
 * 结构体定义
 */
export interface StructDefinition {
  [fieldName: string]: string;
}

/**
 * 加载库选项
 */
export interface LoadLibraryOptions {
  /** 是否允许未定义的符号 */
  allowUndefined?: boolean;
}

/**
 * 库信息
 */
export interface LibraryInfo {
  /** 库文件路径 */
  path: string;
  /** 已定义的函数名列表 */
  functions: string[];
  /** 加载时间戳 */
  loadedAt: number;
  /** 是否已卸载 */
  unloaded: boolean;
}

/**
 * FFI 服务配置
 */
export interface FFIServiceConfig {
  /** 调用者/插件标识 */
  callerId: string;
  /** 允许的库路径列表（可选） */
  allowedPaths?: string[];
  /** 最大库数量限制（默认：10） */
  maxLibraries?: number;
  /** 最大回调数量限制（默认：50） */
  maxCallbacks?: number;
}

/**
 * FFI 类型映射
 *
 * 从用户友好类型到 koffi 类型的映射
 */
export const FFI_TYPE_MAP: Record<string, string> = {
  void: 'void',
  bool: 'bool',
  int8: 'int8',
  uint8: 'uint8',
  int16: 'int16',
  uint16: 'uint16',
  int32: 'int',
  uint32: 'uint',
  int64: 'int64',
  uint64: 'uint64',
  float: 'float',
  double: 'double',
  pointer: 'void*',
  string: 'string',
  wstring: 'string16',
  size_t: 'size_t',
};

/**
 * 系统库白名单
 *
 * 这些库可以直接通过名称加载，无需路径验证
 */
export const SYSTEM_LIBS_WHITELIST: string[] = [
  // Windows
  'kernel32.dll',
  'user32.dll',
  'gdi32.dll',
  'shell32.dll',
  'ole32.dll',
  'advapi32.dll',
  'ws2_32.dll',
  'ntdll.dll',
  'msvcrt.dll',
  // macOS
  'libSystem.dylib',
  // Linux
  'libc.so',
  'libc.so.6',
  'libpthread.so',
  'libm.so',
];
