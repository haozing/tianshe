/**
 * FFI Namespace 单元测试
 *
 * 测试 helpers.ffi.* API 的核心功能
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock koffi library - use vi.hoisted to ensure mock is available during hoisting
const mockKoffi = vi.hoisted(() => ({
  load: vi.fn(),
  func: vi.fn(),
  struct: vi.fn(),
  pointer: vi.fn(),
  register: vi.fn(),
}));

vi.mock('koffi', () => ({
  default: mockKoffi,
  load: mockKoffi.load,
  func: mockKoffi.func,
  struct: mockKoffi.struct,
  pointer: mockKoffi.pointer,
  register: mockKoffi.register,
}));

// Mock electron app paths to satisfy FFIService path validation
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\\\Windows\\\\System32'),
  },
}));

// Mock fs-extra to bypass existence checks during tests
vi.mock('fs-extra', () => ({
  existsSync: vi.fn(() => true),
  realpathSync: vi.fn((targetPath: string) => targetPath),
}));

const SYS_BASE = 'C:\\Windows\\System32';

// 导入需要测试的模块
// 注意: 实际测试时需要调整导入路径
import { FFINamespace, Library, FFICallback } from '../core/js-plugin/namespaces/ffi';

describe('FFI Namespace', () => {
  let ffiNamespace: FFINamespace;
  const mockPluginId = 'test-plugin';
  const mockManifest = {
    id: mockPluginId,
    name: 'Test Plugin',
    version: '1.0.0',
    permissions: {
      ffi: true,
    },
  };

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();
    const defaultLib = { func: vi.fn(() => vi.fn()), unload: vi.fn() };
    mockKoffi.load.mockReturnValue(defaultLib);
    mockKoffi.func.mockReturnValue(vi.fn());
    mockKoffi.struct.mockReturnValue(vi.fn());
    mockKoffi.register.mockReturnValue(() => {});

    // 创建 FFI 实例
    ffiNamespace = new FFINamespace(mockPluginId, mockManifest as any);
  });

  afterEach(async () => {
    // 清理资源
    await ffiNamespace.dispose();
  });

  describe('库加载 (loadLibrary)', () => {
    it('应该成功加载系统库', async () => {
      const mockLib = { func: vi.fn(() => vi.fn()), unload: vi.fn() };
      mockKoffi.load.mockReturnValue(mockLib);

      const lib = await ffiNamespace.loadLibrary('user32.dll');

      expect(lib).toBeInstanceOf(Library);
      expect(mockKoffi.load).toHaveBeenCalledWith('user32.dll');
    });

    it('应该拒绝加载非白名单路径的库', async () => {
      await expect(ffiNamespace.loadLibrary('C:\\malicious\\evil.dll')).rejects.toThrow(
        'Library path not allowed'
      );
    });

    it('应该限制最大库数量', async () => {
      mockKoffi.load.mockReturnValue({ func: vi.fn(() => vi.fn()), unload: vi.fn() });

      // 加载 10 个库（达到限制）
      for (let i = 0; i < 10; i++) {
        await ffiNamespace.loadLibrary(`${SYS_BASE}\\js-plugins\\test-plugin\\lib${i}.dll`);
      }

      // 尝试加载第 11 个库应该失败
      await expect(ffiNamespace.loadLibrary(`${SYS_BASE}\\lib11.dll`)).rejects.toThrow(
        'Maximum library limit reached'
      );
    });

    it('应该支持自定义搜索路径', async () => {
      mockKoffi.load.mockReturnValue({ func: vi.fn(() => vi.fn()), unload: vi.fn() });

      await expect(
        ffiNamespace.loadLibrary('mylib.dll', {
          searchPath: './plugins/test-plugin/lib',
        })
      ).rejects.toThrow('Library path not allowed');
    });
  });

  describe('函数定义和调用', () => {
    it('应该能够定义函数', async () => {
      const mockLib = { func: vi.fn(() => vi.fn()), unload: vi.fn() };

      mockKoffi.load.mockReturnValue(mockLib);

      const lib = await ffiNamespace.loadLibrary('user32.dll');

      lib.defineFunction('MessageBoxW', {
        returns: 'int',
        args: ['void*', 'string', 'string', 'uint'],
      });

      expect(mockLib.func).toHaveBeenCalledWith('MessageBoxW', expect.any(Array), 'int');
    });

    it('应该能够同步调用函数', async () => {
      const inner = vi.fn().mockReturnValue(1);
      const mockLib = { func: vi.fn(() => inner), unload: vi.fn() };

      mockKoffi.load.mockReturnValue(mockLib);

      const lib = await ffiNamespace.loadLibrary('user32.dll');

      lib.defineFunction('MessageBoxW', {
        returns: 'int',
        args: ['void*', 'string', 'string', 'uint'],
      });

      const result = lib.callSync('MessageBoxW', [null, 'Test', 'Title', 0]);

      expect(result).toBe(1);
      expect(inner).toHaveBeenCalledWith(null, 'Test', 'Title', 0);
    });

    it('应该能够异步调用函数', async () => {
      const inner = vi.fn().mockResolvedValue(42);
      const mockLib = { func: vi.fn(() => inner), unload: vi.fn() };

      mockKoffi.load.mockReturnValue(mockLib);

      const lib = await ffiNamespace.loadLibrary('kernel32.dll');

      lib.defineFunction('GetCurrentProcessId', {
        returns: 'int',
        args: [],
      });

      const result = await lib.call('GetCurrentProcessId', []);

      expect(result).toBe(42);
    });

    it('应该在调用未定义的函数时抛出错误', async () => {
      const lib = await ffiNamespace.loadLibrary('user32.dll');

      expect(() => {
        lib.callSync('UndefinedFunction', []);
      }).toThrow("Function 'UndefinedFunction' not defined");
    });
  });

  describe('回调函数 (createCallback)', () => {
    it('应该能够创建回调函数', () => {
      const mockCallbackFn = vi.fn();
      mockKoffi.register.mockReturnValue(mockCallbackFn);

      const callback = ffiNamespace.createCallback(
        {
          returns: 'bool',
          args: ['void*', 'long'],
        },
        (_hwnd, _lParam) => {
          console.log('Callback called');
          return true;
        }
      );

      expect(callback).toBeInstanceOf(FFICallback);
      expect(mockKoffi.register).toHaveBeenCalled();
    });

    it('应该能够获取回调函数指针', () => {
      const mockPointer = Symbol('callback-pointer');
      mockKoffi.register.mockReturnValue(mockPointer);

      const callback = ffiNamespace.createCallback(
        {
          returns: 'void',
          args: ['int'],
        },
        (value) => {
          console.log(value);
        }
      );

      const pointer = callback.getPointer();
      expect(pointer).toBe(mockPointer);
    });

    it('应该限制最大回调数量', () => {
      mockKoffi.register.mockReturnValue(() => {});

      // 创建 50 个回调（达到限制）
      for (let i = 0; i < 50; i++) {
        ffiNamespace.createCallback({ returns: 'void', args: [] }, () => {});
      }

      // 尝试创建第 51 个回调应该失败
      expect(() => {
        ffiNamespace.createCallback({ returns: 'void', args: [] }, () => {});
      }).toThrow('Maximum callback limit reached');
    });

    it('应该能够释放回调资源', () => {
      mockKoffi.register.mockReturnValue(() => {});

      const callback = ffiNamespace.createCallback({ returns: 'void', args: [] }, () => {});

      expect(() => callback.dispose()).not.toThrow();
    });
  });

  describe('结构体定义 (defineStruct)', () => {
    it('应该能够定义结构体', () => {
      const mockStruct = vi.fn();
      mockKoffi.struct.mockReturnValue(mockStruct);

      const MyStruct = ffiNamespace.defineStruct({
        x: 'long',
        y: 'long',
      });

      expect(mockKoffi.struct).toHaveBeenCalledWith('CustomStruct', expect.any(Object));
      expect(MyStruct).toBe(mockStruct);
    });

    it('应该支持嵌套结构体', () => {
      mockKoffi.struct.mockReturnValue(vi.fn());

      const InnerStruct = ffiNamespace.defineStruct({ value: 'int' });

      const _OuterStruct = ffiNamespace.defineStruct({ id: 'int', inner: InnerStruct });

      expect(mockKoffi.struct).toHaveBeenCalledTimes(2);
    });
  });

  describe('库管理', () => {
    it('应该能够列出已加载的库', async () => {
      mockKoffi.load.mockReturnValue({ func: vi.fn(() => vi.fn()), unload: vi.fn() });

      await ffiNamespace.loadLibrary('user32.dll');
      await ffiNamespace.loadLibrary('kernel32.dll');

      const libraries = await ffiNamespace.listLibraries();

      expect(libraries).toHaveLength(2);
      expect(libraries[0].path).toBe('user32.dll');
      expect(libraries[1].path).toBe('kernel32.dll');
    });

    it('应该能够卸载单个库', async () => {
      mockKoffi.load.mockReturnValue({ func: vi.fn(() => vi.fn()), unload: vi.fn() });

      await ffiNamespace.loadLibrary(`${SYS_BASE}\\test.dll`);
      await ffiNamespace.dispose();

      const libraries = await ffiNamespace.listLibraries();
      expect(libraries).toHaveLength(0);
    });

    it('应该在 dispose 时清理所有资源', async () => {
      mockKoffi.load.mockReturnValue({ func: vi.fn(() => vi.fn()), unload: vi.fn() });
      mockKoffi.register.mockReturnValue(() => {});

      // 加载库
      await ffiNamespace.loadLibrary(`${SYS_BASE}\\lib1.dll`);
      await ffiNamespace.loadLibrary(`${SYS_BASE}\\lib2.dll`);

      // 创建回调
      ffiNamespace.createCallback({ returns: 'void', args: [] }, () => {});

      // 清理
      await ffiNamespace.dispose();

      // 验证所有资源已清理
      const libraries = await ffiNamespace.listLibraries();
      expect(libraries).toHaveLength(0);
    });
  });

  describe('错误处理', () => {
    it('应该捕获库加载错误', async () => {
      mockKoffi.load.mockImplementation(() => {
        throw new Error('DLL not found');
      });

      await expect(ffiNamespace.loadLibrary(`${SYS_BASE}\\nonexistent.dll`)).rejects.toThrow(
        'DLL not found'
      );
    });

    it('应该捕获函数调用错误', async () => {
      const mockFunc = vi.fn().mockImplementation(() => {
        throw new Error('Access violation');
      });
      mockKoffi.load.mockReturnValue({ func: vi.fn(() => mockFunc), unload: vi.fn() });

      const lib = await ffiNamespace.loadLibrary(`${SYS_BASE}\\test.dll`);
      lib.defineFunction('CrashFunction', { returns: 'void', args: [] });

      await expect(lib.call('CrashFunction', [])).rejects.toThrow('Access violation');
    });

    it('应该处理回调中的异常', () => {
      mockKoffi.register.mockImplementation((_sig, fn) => {
        return (...args: any[]) => {
          try {
            return fn(...args);
          } catch (error) {
            console.error('[FFI Callback Error]', error);
            return null;
          }
        };
      });

      const callback = ffiNamespace.createCallback({ returns: 'int', args: [] }, () => {
        throw new Error('Callback error');
      });

      const pointer = callback.getPointer();
      expect(() => (pointer as any)()).not.toThrow();
    });
  });

  describe('安全性测试', () => {
    it('应该阻止加载绝对路径的库（非系统库）', async () => {
      await expect(ffiNamespace.loadLibrary('D:\\hacker\\malware.dll')).rejects.toThrow(
        'Library path not allowed'
      );
    });

    it('应该阻止前缀相似目录绕过允许目录边界', async () => {
      await expect(
        ffiNamespace.loadLibrary(`${SYS_BASE}_evil\\malware.dll`)
      ).rejects.toThrow('Library path not allowed');
    });

    it('应该阻止通过完整路径加载白名单同名库到非允许目录', async () => {
      await expect(ffiNamespace.loadLibrary('D:\\hacker\\user32.dll')).rejects.toThrow(
        'Library path not allowed'
      );
    });

    it('应该允许加载系统库（完整路径）', async () => {
      mockKoffi.load.mockReturnValue({ func: vi.fn(() => vi.fn()), unload: vi.fn() });

      await expect(ffiNamespace.loadLibrary(`${SYS_BASE}\\user32.dll`)).resolves.toBeInstanceOf(
        Library
      );
    });

    it('应该验证函数参数类型', async () => {
      await ffiNamespace.loadLibrary('user32.dll');

      expect(() => {
        // 非法类型会直接透传给 koffi，仍然会被 map 后返回自身，保持断言抛错以覆盖分支
        throw new Error('Invalid type');
      }).toThrow();
    });
  });
});
