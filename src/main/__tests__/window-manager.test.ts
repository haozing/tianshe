/**
 * WindowManager 单元测试
 *
 * 测试覆盖：
 * - 创建主窗口
 * - 创建后台窗口
 * - 创建弹窗
 * - 窗口查询
 * - 窗口关闭
 * - resize 回调
 * - 生命周期管理
 */
import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';
import { BrowserWindow } from 'electron';
import { WindowManager } from '../window-manager';

const { mockMaybeOpenInternalBrowserDevTools } = vi.hoisted(() => ({
  mockMaybeOpenInternalBrowserDevTools: vi.fn(),
}));

vi.mock('../internal-browser-devtools', () => ({
  maybeOpenInternalBrowserDevTools: mockMaybeOpenInternalBrowserDevTools,
}));

// Mock Electron modules
vi.mock('electron', () => {
  const mockBrowserWindow = vi.fn().mockImplementation(function (this: any, options: any) {
    this.id = Math.floor(Math.random() * 10000);
    this.webContents = {
      session: {
        webRequest: {
          onHeadersReceived: vi.fn(),
          onBeforeSendHeaders: vi.fn(),
        },
      },
      openDevTools: vi.fn(),
      getURL: vi.fn().mockReturnValue('about:blank'),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    this.show = vi.fn();
    this.close = vi.fn();
    this.isDestroyed = vi.fn().mockReturnValue(false);
    this.getBounds = vi.fn().mockReturnValue({ x: 0, y: 0, width: 1400, height: 900 });
    this.getContentBounds = vi.fn().mockReturnValue({ x: 0, y: 0, width: 1400, height: 900 });
    this.on = vi.fn();
    this.once = vi.fn();
    this.loadURL = vi.fn().mockResolvedValue(undefined);
    this.loadFile = vi.fn().mockResolvedValue(undefined);
    this.contentView = {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    };
    this._options = options;
    return this;
  });

  return {
    app: {
      getPath: vi.fn().mockReturnValue('C:\\temp\\tiansheai-test'),
    },
    BrowserWindow: mockBrowserWindow,
    screen: {
      getPrimaryDisplay: vi.fn(() => ({
        workAreaSize: { width: 1920, height: 1080 },
      })),
    },
  };
});

describe('WindowManager', () => {
  let windowManager: WindowManager;
  let mockBrowserWindowConstructor: MockedFunction<typeof BrowserWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    windowManager = new WindowManager();
    mockBrowserWindowConstructor = BrowserWindow as MockedFunction<typeof BrowserWindow>;
  });

  afterEach(() => {
    // 清理所有窗口
    try {
      windowManager.cleanup();
    } catch (_error) {
      // 忽略清理错误
    }
  });

  describe('createMainWindow', () => {
    it('应该成功创建主窗口', () => {
      const window = windowManager.createMainWindow();

      expect(window).toBeDefined();
      expect(mockBrowserWindowConstructor).toHaveBeenCalledTimes(1);
      expect(windowManager.hasWindowById('main')).toBe(true);
    });

    it('应该创建具有正确配置的主窗口', () => {
      const window = windowManager.createMainWindow();

      const callArgs = mockBrowserWindowConstructor.mock.calls[0][0];
      expect(callArgs.width).toBe(1400);
      expect(callArgs.height).toBe(900);
      expect(callArgs.title).toBe('TiansheAI');
      expect(callArgs.webPreferences).toBeDefined();
      expect(callArgs.webPreferences.contextIsolation).toBe(true);
      expect(callArgs.webPreferences.nodeIntegration).toBe(false);
      expect(callArgs.webPreferences.sandbox).toBe(true);
      expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    });

    it('应该拒绝创建重复的主窗口', () => {
      windowManager.createMainWindow();

      expect(() => windowManager.createMainWindow()).toThrow('Main window already exists');
    });

    it('应该返回创建的主窗口', () => {
      const window = windowManager.createMainWindow();
      const retrievedWindow = windowManager.getMainWindowV3();

      expect(retrievedWindow).toBe(window);
    });
  });

  describe('createPopupWindow', () => {
    it('应该成功创建弹窗', () => {
      const popup = windowManager.createPopupWindow('popup-1', {
        title: 'Test Popup',
        width: 800,
        height: 600,
      });

      expect(popup).toBeDefined();
      expect(mockBrowserWindowConstructor).toHaveBeenCalledTimes(1);
      expect(windowManager.hasWindowById('popup-popup-1')).toBe(true);
    });

    it('应该创建具有正确配置的弹窗', () => {
      const popup = windowManager.createPopupWindow('popup-1', {
        title: 'Test Popup',
        width: 800,
        height: 600,
        modal: true,
      });

      const callArgs = mockBrowserWindowConstructor.mock.calls[0][0];
      expect(callArgs.width).toBe(800);
      expect(callArgs.height).toBe(600);
      expect(callArgs.title).toBe('Test Popup');
      expect(callArgs.modal).toBe(true);
      expect(popup.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
      expect(mockMaybeOpenInternalBrowserDevTools).toHaveBeenCalledWith(popup.webContents, {
        override: undefined,
      });
    });

    it('应该支持创建多个弹窗', () => {
      windowManager.createPopupWindow('popup-1');
      windowManager.createPopupWindow('popup-2');
      windowManager.createPopupWindow('popup-3');

      const allWindows = windowManager.listAllWindows();
      const popups = allWindows.filter((w) => w.windowId.startsWith('popup-'));
      expect(popups).toHaveLength(3);
    });

    it('应该替换同ID的已存在弹窗', () => {
      const popup1 = windowManager.createPopupWindow('popup-1', { title: 'First' });
      const _popup2 = windowManager.createPopupWindow('popup-1', { title: 'Second' });

      const allWindows = windowManager.listAllWindows();
      const popups = allWindows.filter((w) => w.windowId.startsWith('popup-'));
      expect(popups).toHaveLength(1);
      expect(popup1.close).toHaveBeenCalledTimes(1);
    });

    it('应该使用默认配置创建弹窗', () => {
      windowManager.createPopupWindow('popup-default');

      const callArgs = mockBrowserWindowConstructor.mock.calls[0][0];
      expect(callArgs.width).toBe(1200);
      expect(callArgs.height).toBe(800);
      expect(callArgs.title).toBe('Browser');
    });

    it('应该返回创建的弹窗', () => {
      const popup = windowManager.createPopupWindow('popup-1');
      const retrievedPopup = windowManager.getWindowById('popup-popup-1');

      expect(retrievedPopup).toBe(popup);
    });
  });

  describe('createHiddenAutomationHost', () => {
    it('creates one hidden automation host per session', () => {
      const host = windowManager.createHiddenAutomationHost('session-1');

      expect(host).toBeDefined();
      expect(windowManager.hasWindowById('hidden-host-session-1')).toBe(true);

      const callArgs = mockBrowserWindowConstructor.mock.calls[0][0];
      expect(callArgs.show).toBe(false);
      expect(callArgs.frame).toBe(false);
      expect(callArgs.skipTaskbar).toBe(true);
      expect(callArgs.focusable).toBe(false);
      expect(callArgs.paintWhenInitiallyHidden).toBe(true);
      expect(callArgs.webPreferences.backgroundThrottling).toBe(false);
      expect(host.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
      expect(mockMaybeOpenInternalBrowserDevTools).toHaveBeenCalledWith(host.webContents, {
        override: undefined,
      });
    });

    it('reuses an existing hidden automation host for the same session', () => {
      const first = windowManager.createHiddenAutomationHost('session-1');
      const second = windowManager.createHiddenAutomationHost('session-1');

      expect(first).toBe(second);
      expect(mockBrowserWindowConstructor).toHaveBeenCalledTimes(1);
    });

    it('closes all hidden automation hosts during cleanup', () => {
      const host1 = windowManager.createHiddenAutomationHost('session-1');
      const host2 = windowManager.createHiddenAutomationHost('session-2');

      windowManager.cleanup();

      expect(host1.close).toHaveBeenCalledTimes(1);
      expect(host2.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('getWindowById', () => {
    it('应该返回存在的主窗口', () => {
      const window = windowManager.createMainWindow();
      const retrieved = windowManager.getWindowById('main');

      expect(retrieved).toBe(window);
    });

    it('应该返回存在的弹窗', () => {
      const popup = windowManager.createPopupWindow('popup-1');
      const retrieved = windowManager.getWindowById('popup-popup-1');

      expect(retrieved).toBe(popup);
    });

    it('应该在窗口不存在时返回undefined', () => {
      const retrieved = windowManager.getWindowById('main');

      expect(retrieved).toBeUndefined();
    });

    it('应该在弹窗不存在时返回undefined', () => {
      const retrieved = windowManager.getWindowById('popup-non-existent');

      expect(retrieved).toBeUndefined();
    });
  });

  describe('closeWindowById', () => {
    it('应该关闭主窗口', () => {
      const window = windowManager.createMainWindow();
      windowManager.closeWindowById('main');

      expect(window.close).toHaveBeenCalledTimes(1);
    });

    it('应该关闭弹窗', () => {
      const popup = windowManager.createPopupWindow('popup-1');
      windowManager.closeWindowById('popup-popup-1');

      expect(popup.close).toHaveBeenCalledTimes(1);
    });

    it('应该在窗口不存在时不抛出错误', () => {
      expect(() => windowManager.closeWindowById('main')).not.toThrow();
    });

    it('应该在弹窗不存在时不抛出错误', () => {
      expect(() => windowManager.closeWindowById('popup-non-existent')).not.toThrow();
    });

    it('应该在窗口已销毁时不尝试关闭', () => {
      const window = windowManager.createMainWindow();
      window.isDestroyed = vi.fn().mockReturnValue(true);

      windowManager.closeWindowById('main');

      expect(window.close).not.toHaveBeenCalled();
    });
  });

  describe('closeAllPopups', () => {
    it('应该关闭所有弹窗', () => {
      const popup1 = windowManager.createPopupWindow('popup-1');
      const popup2 = windowManager.createPopupWindow('popup-2');
      const popup3 = windowManager.createPopupWindow('popup-3');

      windowManager.closeAllPopups();

      expect(popup1.close).toHaveBeenCalledTimes(1);
      expect(popup2.close).toHaveBeenCalledTimes(1);
      expect(popup3.close).toHaveBeenCalledTimes(1);
    });

    it('应该在没有弹窗时不抛出错误', () => {
      expect(() => windowManager.closeAllPopups()).not.toThrow();
    });
  });

  describe('hasWindowById', () => {
    it('应该在主窗口存在时返回true', () => {
      windowManager.createMainWindow();

      expect(windowManager.hasWindowById('main')).toBe(true);
    });

    it('应该在弹窗存在时返回true', () => {
      windowManager.createPopupWindow('popup-1');

      expect(windowManager.hasWindowById('popup-popup-1')).toBe(true);
    });

    it('应该在窗口不存在时返回false', () => {
      expect(windowManager.hasWindowById('main')).toBe(false);
    });

    it('应该在弹窗不存在时返回false', () => {
      expect(windowManager.hasWindowById('popup-non-existent')).toBe(false);
    });
  });

  describe('listAllWindows', () => {
    it('应该列出所有窗口（主窗口和弹窗）', () => {
      windowManager.createMainWindow();
      windowManager.createPopupWindow('popup-1');
      windowManager.createPopupWindow('popup-2');

      const windows = windowManager.listAllWindows();

      expect(windows).toHaveLength(3);
      expect(windows.some((w) => w.windowId === 'main')).toBe(true);
      expect(windows.some((w) => w.windowId.startsWith('popup-'))).toBe(true);
    });

    it('应该在没有窗口时返回空数组', () => {
      const windows = windowManager.listAllWindows();

      expect(windows).toHaveLength(0);
    });

    it('应该包含窗口信息', () => {
      windowManager.createMainWindow();

      const windows = windowManager.listAllWindows();
      const mainWindow = windows.find((w) => w.windowId === 'main');

      expect(mainWindow).toBeDefined();
      expect(mainWindow!.createdAt).toBeGreaterThan(0);
    });

    it('应该列出所有弹窗', () => {
      windowManager.createPopupWindow('popup-1');
      windowManager.createPopupWindow('popup-2');
      windowManager.createPopupWindow('popup-3');

      const windows = windowManager.listAllWindows();
      const popups = windows.filter((w) => w.windowId.startsWith('popup-'));

      expect(popups).toHaveLength(3);
    });

    it('应该包含弹窗信息', () => {
      windowManager.createPopupWindow('popup-1');

      const windows = windowManager.listAllWindows();
      const popup = windows.find((w) => w.windowId === 'popup-popup-1');

      expect(popup).toBeDefined();
      expect(popup!.createdAt).toBeGreaterThan(0);
    });
  });

  describe('registerMainWindowResizeCallback', () => {
    it('应该注册resize回调', () => {
      const callback = vi.fn();
      const cleanup = windowManager.registerMainWindowResizeCallback(callback);

      expect(cleanup).toBeInstanceOf(Function);
    });

    it('应该返回清理函数', () => {
      const callback = vi.fn();
      const cleanup = windowManager.registerMainWindowResizeCallback(callback);

      expect(() => cleanup()).not.toThrow();
    });

    it('应该支持注册多个回调', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      windowManager.registerMainWindowResizeCallback(callback1);
      windowManager.registerMainWindowResizeCallback(callback2);

      // 不应该抛出错误
    });
  });

  describe('cleanup', () => {
    it('应该关闭所有窗口', () => {
      const mainWindow = windowManager.createMainWindow();
      const popup1 = windowManager.createPopupWindow('popup-1');
      const popup2 = windowManager.createPopupWindow('popup-2');

      windowManager.cleanup();

      expect(mainWindow.close).toHaveBeenCalledTimes(1);
      expect(popup1.close).toHaveBeenCalledTimes(1);
      expect(popup2.close).toHaveBeenCalledTimes(1);
    });

    it('应该在没有窗口时不抛出错误', () => {
      expect(() => windowManager.cleanup()).not.toThrow();
    });
  });

  describe('弹窗居中功能', () => {
    beforeEach(() => {
      // 创建主窗口作为父窗口
      const mainWindow = windowManager.createMainWindow();
      mainWindow.getBounds = vi.fn().mockReturnValue({
        x: 100,
        y: 100,
        width: 1400,
        height: 900,
      });
    });

    it('应该将弹窗居中于父窗口', () => {
      const mainWindow = windowManager.getMainWindowV3();
      windowManager.createPopupWindow('popup-centered', {
        width: 800,
        height: 600,
        center: true,
        parent: mainWindow,
      });

      const callArgs = mockBrowserWindowConstructor.mock.calls[1][0];
      // 居中计算: parentX + (parentWidth - popupWidth) / 2
      // 100 + (1400 - 800) / 2 = 100 + 300 = 400
      expect(callArgs.x).toBe(400);
      // 居中计算: parentY + (parentHeight - popupHeight) / 2
      // 100 + (900 - 600) / 2 = 100 + 150 = 250
      expect(callArgs.y).toBe(250);
    });

    it('应该在没有父窗口时居中于屏幕', () => {
      windowManager.createPopupWindow('popup-screen-centered', {
        width: 800,
        height: 600,
        center: true,
      });

      // 第二次调用 (第一次是主窗口)
      const callArgs = mockBrowserWindowConstructor.mock.calls[1][0];
      expect(callArgs.x).toBeDefined();
      expect(callArgs.y).toBeDefined();
    });
  });

  describe('边缘情况', () => {
    it('应该处理window.on回调中的错误', () => {
      const window = windowManager.createMainWindow();

      // 模拟closed事件
      const closedHandler = window.on.mock.calls.find((call: any[]) => call[0] === 'closed')?.[1];

      expect(() => closedHandler?.()).not.toThrow();
    });

    it('应该处理极大的窗口尺寸', () => {
      expect(() => {
        windowManager.createPopupWindow('large-popup', {
          width: 10000,
          height: 10000,
        });
      }).not.toThrow();
    });

    it('应该处理极小的窗口尺寸', () => {
      expect(() => {
        windowManager.createPopupWindow('small-popup', {
          width: 100,
          height: 100,
        });
      }).not.toThrow();
    });

    it('应该处理特殊字符的popupId', () => {
      const popupId = 'popup-测试-#@$%';

      expect(() => {
        windowManager.createPopupWindow(popupId);
      }).not.toThrow();

      expect(windowManager.hasWindowById(`popup-${popupId}`)).toBe(true);
    });
  });

  describe('生命周期管理', () => {
    it('应该正确追踪窗口创建时间', () => {
      const beforeCreate = Date.now();
      windowManager.createMainWindow();
      const afterCreate = Date.now();

      const windows = windowManager.listAllWindows();
      const mainWindow = windows.find((w) => w.windowId === 'main');

      expect(mainWindow!.createdAt).toBeGreaterThanOrEqual(beforeCreate);
      expect(mainWindow!.createdAt).toBeLessThanOrEqual(afterCreate);
    });

    it('应该在关闭后从列表中移除窗口', () => {
      windowManager.createMainWindow();

      const window = windowManager.getMainWindowV3();
      const closedHandler = window!.on.mock.calls.find((call: any[]) => call[0] === 'closed')?.[1];

      // 触发closed事件
      closedHandler?.();

      expect(windowManager.hasWindowById('main')).toBe(false);
    });
  });
});
