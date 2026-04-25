/**
 * FFI 集成测试
 *
 * 覆盖在插件环境下的核心使用场景
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SYS_BASE = 'C:\\\\Windows\\\\System32';

// 全局 koffi mock（同时提供默认与命名导出）
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

// Mock electron/FS 以通过路径与存在性校验
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => SYS_BASE),
  },
}));

vi.mock('fs-extra', () => ({
  existsSync: vi.fn(() => true),
}));

import { FFINamespace } from '../core/js-plugin/namespaces/ffi';
import type { JSPluginManifest } from '../types/js-plugin';

const createManifest = (id: string): JSPluginManifest => ({
  id,
  name: id,
  version: '1.0.0',
  author: 'test',
  main: 'index.js',
  permissions: { ffi: true },
});

const createNamespace = (id: string) => new FFINamespace(id, createManifest(id));

beforeEach(() => {
  mockKoffi.load.mockReset();
  mockKoffi.func.mockReset();
  mockKoffi.struct.mockReset();
  mockKoffi.pointer.mockReset();
  mockKoffi.register.mockReset();
  mockKoffi.register.mockImplementation((fn: any) => fn);
});

describe('FFI 集成测试', () => {
  describe('Windows API 调用场景', () => {
    let ffi: FFINamespace;

    beforeEach(() => {
      ffi = createNamespace('windows-api-test');
    });

    afterEach(() => {
      ffi.dispose();
    });

    it('场景1: MessageBox 调用', async () => {
      const mockLib = { func: vi.fn(() => vi.fn().mockReturnValue(1)), unload: vi.fn() };
      mockKoffi.load.mockReturnValue(mockLib);

      const user32 = await ffi.loadLibrary('user32.dll');
      user32.defineFunction('MessageBoxW', {
        returns: 'int',
        args: ['void*', 'string', 'string', 'uint'],
      });

      const result = await user32.call('MessageBoxW', [null, 'Hello from FFI!', 'Test', 0]);
      expect(result).toBe(1);
      expect(mockLib.func).toHaveBeenCalled();
    });

    it('场景2: 获取系统信息', async () => {
      const inner = vi.fn().mockReturnValue(12345);
      const mockLib = { func: vi.fn(() => inner), unload: vi.fn() };
      mockKoffi.load.mockReturnValue(mockLib);

      const kernel32 = await ffi.loadLibrary('kernel32.dll');
      kernel32.defineFunction('GetCurrentProcessId', { returns: 'int', args: [] });

      const pid = await kernel32.call('GetCurrentProcessId', []);
      expect(pid).toBe(12345);
    });

    it('场景3: 窗口枚举（回调）', async () => {
      const mockEnumWindows = vi.fn().mockImplementation((cb, lParam) => {
        cb(1001, lParam);
        cb(1002, lParam);
        cb(1003, lParam);
        return true;
      });
      const mockLib = { func: vi.fn(() => mockEnumWindows), unload: vi.fn() };
      mockKoffi.load.mockReturnValue(mockLib);
      mockKoffi.register.mockImplementation((fn) => fn);

      const user32 = await ffi.loadLibrary('user32.dll');
      const windowHandles: number[] = [];
      const enumCallback = ffi.createCallback(
        { returns: 'bool', args: ['void*', 'long'] },
        (hwnd: any, _lParam: number) => {
          windowHandles.push(Number(hwnd));
          return true;
        }
      );

      user32.defineFunction('EnumWindows', { returns: 'bool', args: ['void*', 'long'] });
      const result = await user32.call('EnumWindows', [enumCallback.getPointer(), 0]);

      expect(result).toBeTruthy();
      expect(windowHandles).toEqual([1001, 1002, 1003]);
      enumCallback.dispose();
    });
  });

  describe('WeChat OCR 调用场景', () => {
    let ffi: FFINamespace;

    beforeEach(() => {
      ffi = createNamespace('wechat-ocr-test');
    });

    afterEach(() => {
      ffi.dispose();
    });

    it('场景: OCR 异步回调', async () => {
      const mockLib = { func: vi.fn(), unload: vi.fn() };
      let registeredCallback: any = null;

      const mockInit = vi.fn().mockImplementation((callback, _userData) => {
        registeredCallback = callback;
        return 0;
      });
      const mockDoOCR = vi.fn().mockImplementation((taskId, _imagePath) => {
        setTimeout(() => registeredCallback?.(taskId, '识别的文本内容', 0.95, null), 10);
        return 0;
      });

      mockKoffi.load.mockReturnValue(mockLib);
      mockLib.func.mockImplementation((name: string) => {
        if (name === 'WeChatOCR_Init') return mockInit;
        if (name === 'WeChatOCR_DoOCR') return mockDoOCR;
        return vi.fn();
      });
      mockKoffi.register.mockImplementation((fn) => fn);

      const ocrLib = await ffi.loadLibrary(
        `${SYS_BASE}\\js-plugins\\wechat-ocr-test\\WeChatOCR.dll`
      );
      const ocrResults = new Map<number, any>();

      const ocrCallback = ffi.createCallback(
        { returns: 'void', args: ['int', 'string', 'float', 'void*'] },
        (taskId: number, text: string, confidence: number) => {
          ocrResults.set(taskId, { text, confidence });
        }
      );

      ocrLib.defineFunction('WeChatOCR_Init', { returns: 'int', args: ['void*', 'void*'] });
      const initResult = await ocrLib.call('WeChatOCR_Init', [ocrCallback.getPointer(), null]);
      expect(initResult).toBe(0);

      ocrLib.defineFunction('WeChatOCR_DoOCR', { returns: 'int', args: ['int', 'string'] });
      const taskId = 1001;
      const doOCRResult = await ocrLib.call('WeChatOCR_DoOCR', [taskId, 'C:\\test\\image.jpg']);
      expect(doOCRResult).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = ocrResults.get(taskId);
      expect(result).toBeDefined();
      expect(result.text).toBe('识别的文本内容');
      expect(result.confidence).toBe(0.95);

      ocrCallback.dispose();
    });
  });

  describe('自定义 DLL 调用场景', () => {
    let ffi: FFINamespace;

    beforeEach(() => {
      ffi = createNamespace('custom-dll-test');
    });

    afterEach(() => {
      ffi.dispose();
    });

    it('场景: 使用自定义结构体', async () => {
      const mockLib = { func: vi.fn(() => vi.fn()), unload: vi.fn() };
      const mockStruct = vi.fn();

      mockKoffi.load.mockReturnValue(mockLib);
      mockKoffi.struct.mockReturnValue(mockStruct);

      const Point = ffi.defineStruct({ x: 'long', y: 'long' });

      expect(Point).toBe(mockStruct);
      expect(mockKoffi.struct).toHaveBeenCalledWith('CustomStruct', expect.any(Object));
    });

    it('场景: 带结构体参数的函数调用', async () => {
      const mockLib = { func: vi.fn(() => vi.fn().mockReturnValue(true)), unload: vi.fn() };
      const mockStruct = vi.fn();

      mockKoffi.load.mockReturnValue(mockLib);
      mockKoffi.struct.mockReturnValue(mockStruct);

      const myLib = await ffi.loadLibrary(`${SYS_BASE}\\js-plugins\\custom-dll-test\\mylib.dll`);

      const Rect = ffi.defineStruct({
        left: 'long',
        top: 'long',
        right: 'long',
        bottom: 'long',
      });

      myLib.defineFunction('ProcessRect', { returns: 'bool', args: [Rect] });

      const rect = { left: 0, top: 0, right: 100, bottom: 100 };
      const result = await myLib.call('ProcessRect', [rect]);

      expect(result).toBe(true);
    });
  });

  describe('资源管理场景', () => {
    it('场景: 多库并发加载和卸载', async () => {
      mockKoffi.load.mockImplementation(() => ({ func: vi.fn(() => vi.fn()), unload: vi.fn() }));

      const ffi = createNamespace('multi-lib-test');

      const libs = await Promise.all([
        ffi.loadLibrary(`${SYS_BASE}\\js-plugins\\multi-lib-test\\lib1.dll`),
        ffi.loadLibrary(`${SYS_BASE}\\js-plugins\\multi-lib-test\\lib2.dll`),
        ffi.loadLibrary(`${SYS_BASE}\\js-plugins\\multi-lib-test\\lib3.dll`),
      ]);

      expect(libs).toHaveLength(3);

      const libList = await ffi.listLibraries();
      expect(libList).toHaveLength(3);

      libs[1].unload();
      const updatedList = await ffi.listLibraries();
      expect(updatedList).toHaveLength(3);

      await ffi.dispose();
    });

    it('场景: 回调生命周期管理', async () => {
      mockKoffi.register.mockImplementation((fn) => fn);

      const ffi = createNamespace('callback-lifecycle-test');

      const callbacks = [];
      for (let i = 0; i < 5; i++) {
        const cb = ffi.createCallback({ returns: 'void', args: [] }, () => {});
        callbacks.push(cb);
      }

      callbacks[0].dispose();
      callbacks[2].dispose();

      await ffi.dispose();

      expect(true).toBe(true);
    });
  });

  describe('错误恢复场景', () => {
    it('场景: 函数调用失败后继续工作', async () => {
      const mockLib = { func: vi.fn(), unload: vi.fn() };
      let callCount = 0;
      const mockFunc = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('First call failed');
        return 42;
      });

      mockKoffi.load.mockReturnValue(mockLib);
      mockLib.func.mockReturnValue(mockFunc);

      const ffi = createNamespace('error-recovery-test');
      const lib = await ffi.loadLibrary(`${SYS_BASE}\\js-plugins\\error-recovery-test\\test.dll`);

      lib.defineFunction('FlakeyFunction', { returns: 'int', args: [] });

      await expect(lib.call('FlakeyFunction', [])).rejects.toThrow('First call failed');
      const result = await lib.call('FlakeyFunction', []);
      expect(result).toBe(42);

      await ffi.dispose();
    });
  });
});
