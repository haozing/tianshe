/**
 * ViewIPCHandler 单元测试
 *
 * 测试 ViewIPCHandler 类的所有 IPC 处理器：
 * - view:create - 创建视图
 * - view:activate - 激活视图
 * - view:attach - 附加视图到窗口
 * - view:switch - 切换视图
 * - view:detach - 分离视图
 * - view:detach-all - 分离所有视图
 * - view:detach-scoped - 按作用域分离视图
 * - view:close - 关闭视图
 * - view:list - 列出所有视图
 * - view:pool-status - 获取池状态
 * - view:set-activity-bar-collapsed - 同步 Activity Bar 折叠状态
 * - view:set-activity-bar-width - 同步 Activity Bar 宽度
 * - view:resource-stats - 获取资源统计
 * - view:force-gc - 强制垃圾回收
 * - view:close-multiple - 批量关闭视图
 * - view:close-oldest - 关闭最旧的视图
 * - view:memory-usage - 获取内存使用
 * - view:detailed-pool-status - 获取详细池状态
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

const { mockGetPersistedCloudAuthSession, mockInvalidateCloudAuthSession, mockIsCloudAuthSessionExpired } =
  vi.hoisted(() => ({
    mockGetPersistedCloudAuthSession: vi.fn(),
    mockInvalidateCloudAuthSession: vi.fn(),
    mockIsCloudAuthSessionExpired: vi.fn(),
  }));

// Mock electron 模块
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    set: vi.fn(),
  })),
}));

vi.mock('../cloud-auth/service', () => ({
  getPersistedCloudAuthSession: mockGetPersistedCloudAuthSession,
  invalidateCloudAuthSession: mockInvalidateCloudAuthSession,
  isCloudAuthSessionExpired: mockIsCloudAuthSessionExpired,
}));

vi.mock('../../constants/cloud', () => ({
  CLOUD_WORKBENCH_URL: 'http://localhost:8080',
  CLOUD_WORKBENCH_VIEW_ID: 'pool:workbench:tianshe-cloud',
  CLOUD_AUTH_COOKIE_NAME: 'Admin-Token',
}));

// Mock ipc-utils 模块
vi.mock('../ipc-utils', () => ({
  handleIPCError: vi.fn((error: unknown) => {
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    if (typeof error === 'string') {
      return { success: false, error };
    }
    return { success: false, error: 'Unknown error occurred' };
  }),
}));

import { ViewIPCHandler } from './view-handler';

/**
 * 创建 Mock ViewManager
 */
const createMockViewManager = () => ({
  registerView: vi.fn(),
  activateView: vi.fn(),
  attachView: vi.fn(),
  updateBounds: vi.fn(),
  navigateView: vi.fn(),
  getView: vi.fn(),
  switchView: vi.fn(),
  detachView: vi.fn(),
  detachAllViews: vi.fn(),
  detachScopedViews: vi.fn(),
  setActivityBarCollapsed: vi.fn(),
  setActivityBarWidth: vi.fn(),
  closeView: vi.fn(),
  listRegisteredViews: vi.fn(),
  getPoolStatus: vi.fn(),
  getResourceStats: vi.fn(),
  forceGarbageCollection: vi.fn(),
  closeMultipleViews: vi.fn(),
  closeOldestViews: vi.fn(),
  getMemoryUsage: vi.fn(),
  getDetailedPoolStatus: vi.fn(),
});

/**
 * 创建 Mock WindowManager
 */
const createMockWindowManager = () => ({
  createMainWindow: vi.fn(),
  createBackgroundWindow: vi.fn(),
  getWindow: vi.fn(),
  closeWindow: vi.fn(),
  closeAllWindows: vi.fn(),
  onWindowResize: vi.fn(),
});

const getIpcHandler = (channel: string) => {
  const call = (ipcMain.handle as any).mock.calls.find((c: any[]) => c[0] === channel);
  if (!call) {
    throw new Error(`IPC handler not registered: ${channel}`);
  }
  return call[1];
};

describe('ViewIPCHandler', () => {
  let handler: ViewIPCHandler;
  let mockViewManager: ReturnType<typeof createMockViewManager>;
  let mockWindowManager: ReturnType<typeof createMockWindowManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPersistedCloudAuthSession.mockReset();
    mockInvalidateCloudAuthSession.mockReset();
    mockIsCloudAuthSessionExpired.mockReset();
    mockInvalidateCloudAuthSession.mockResolvedValue(undefined);
    mockIsCloudAuthSessionExpired.mockReturnValue(false);
    mockViewManager = createMockViewManager();
    mockWindowManager = createMockWindowManager();
    handler = new ViewIPCHandler(mockViewManager as any, mockWindowManager as any);
  });

  describe('register', () => {
    it('应该注册所有视图相关的 IPC handlers', () => {
      // Act
      handler.register();

      // Assert: 验证所有 handler 都被注册
      expect(ipcMain.handle).toHaveBeenCalledTimes(21);
      expect(ipcMain.handle).toHaveBeenCalledWith('view:create', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:activate', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:attach', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:update-bounds', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:navigate', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(
        'view:sync-cloud-auth',
        expect.any(Function)
      );
      expect(ipcMain.handle).toHaveBeenCalledWith('view:switch', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:detach', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:detach-all', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:detach-scoped', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:close', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:list', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:pool-status', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(
        'view:set-activity-bar-collapsed',
        expect.any(Function)
      );
      expect(ipcMain.handle).toHaveBeenCalledWith(
        'view:set-activity-bar-width',
        expect.any(Function)
      );
      expect(ipcMain.handle).toHaveBeenCalledWith('view:resource-stats', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:force-gc', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:close-multiple', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:close-oldest', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('view:memory-usage', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith(
        'view:detailed-pool-status',
        expect.any(Function)
      );
    });
  });

  describe('view:create', () => {
    it('应该成功创建视图并返回 viewId', async () => {
      // Arrange
      const options = {
        viewId: 'view-123',
        partition: 'persist:main',
        url: 'https://example.com',
      };

      mockViewManager.registerView.mockReturnValue(undefined);

      handler.register();
      const createHandler = getIpcHandler('view:create');

      // Act
      const response = await createHandler(null, options);

      // Assert
      expect(mockViewManager.registerView).toHaveBeenCalledWith({
        id: options.viewId,
        partition: options.partition,
        url: options.url,
      });
      expect(response).toEqual({
        success: true,
        viewId: options.viewId,
      });
    });

    it('应该成功创建没有 URL 的视图', async () => {
      // Arrange
      const options = {
        viewId: 'view-456',
        partition: 'persist:test',
      };

      mockViewManager.registerView.mockReturnValue(undefined);

      handler.register();
      const createHandler = getIpcHandler('view:create');

      // Act
      const response = await createHandler(null, options);

      // Assert
      expect(mockViewManager.registerView).toHaveBeenCalledWith({
        id: options.viewId,
        partition: options.partition,
        url: undefined,
      });
      expect(response).toEqual({
        success: true,
        viewId: options.viewId,
      });
    });

    it('应该使用主进程工作台地址注册云工作台视图', async () => {
      const options = {
        viewId: 'pool:workbench:tianshe-cloud',
        partition: 'persist:workbench:tianshe-cloud',
        url: 'http://example.com',
      };

      mockViewManager.registerView.mockReturnValue(undefined);

      handler.register();
      const createHandler = getIpcHandler('view:create');

      const response = await createHandler(null, options);

      expect(mockViewManager.registerView).toHaveBeenCalledWith({
        id: options.viewId,
        partition: options.partition,
        url: 'http://localhost:8080',
      });
      expect(response).toEqual({
        success: true,
        viewId: options.viewId,
      });
    });

    it('应该处理创建视图失败的情况', async () => {
      // Arrange
      const options = {
        viewId: 'view-789',
        partition: 'persist:main',
      };
      const errorMessage = '视图 ID 已存在';

      mockViewManager.registerView.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const createHandler = getIpcHandler('view:create');

      // Act
      const response = await createHandler(null, options);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:activate', () => {
    it('应该成功激活视图', async () => {
      // Arrange
      const viewId = 'view-123';
      const mockViewInfo = {
        id: viewId,
        partition: 'persist:main',
        url: 'https://example.com',
      };

      mockViewManager.activateView.mockResolvedValue(mockViewInfo);

      handler.register();
      const activateHandler = getIpcHandler('view:activate');

      // Act
      const response = await activateHandler(null, viewId);

      // Assert
      expect(mockViewManager.activateView).toHaveBeenCalledWith(viewId);
      expect(response).toEqual({
        success: true,
        viewId: mockViewInfo.id,
      });
    });

    it('应该处理激活不存在的视图', async () => {
      // Arrange
      const viewId = 'non-existent-view';
      const errorMessage = '视图不存在';

      mockViewManager.activateView.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const activateHandler = getIpcHandler('view:activate');

      // Act
      const response = await activateHandler(null, viewId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('应该处理激活视图时的其他错误', async () => {
      // Arrange
      const viewId = 'view-error';
      const errorMessage = '视图池已满';

      mockViewManager.activateView.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const activateHandler = getIpcHandler('view:activate');

      // Act
      const response = await activateHandler(null, viewId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:attach', () => {
    it('应该成功将视图附加到主窗口', async () => {
      // Arrange
      const options = {
        viewId: 'view-123',
        windowId: 'main',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      };

      mockViewManager.attachView.mockReturnValue(undefined);

      handler.register();
      const attachHandler = getIpcHandler('view:attach');

      // Act
      const response = await attachHandler(null, options);

      // Assert
      expect(mockViewManager.attachView).toHaveBeenCalledWith(
        options.viewId,
        'main',
        options.bounds
      );
      expect(response).toEqual({ success: true });
    });

    it('应该默认将视图附加到主窗口（不指定 windowId）', async () => {
      // Arrange
      const options = {
        viewId: 'view-456',
        bounds: { x: 0, y: 0, width: 1024, height: 768 },
      };

      mockViewManager.attachView.mockReturnValue(undefined);

      handler.register();
      const attachHandler = getIpcHandler('view:attach');

      // Act
      const response = await attachHandler(null, options);

      // Assert
      expect(mockViewManager.attachView).toHaveBeenCalledWith(
        options.viewId,
        'main',
        options.bounds
      );
      expect(response).toEqual({ success: true });
    });

    it('应该处理附加视图失败的情况', async () => {
      // Arrange
      const options = {
        viewId: 'view-789',
        windowId: 'main',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      };
      const errorMessage = '窗口不存在';

      mockViewManager.attachView.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const attachHandler = getIpcHandler('view:attach');

      // Act
      const response = await attachHandler(null, options);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('应该处理无效的边界参数', async () => {
      // Arrange
      const options = {
        viewId: 'view-bounds',
        windowId: 'main',
        bounds: null,
      };
      const errorMessage = '无效的边界参数';

      mockViewManager.attachView.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const attachHandler = getIpcHandler('view:attach');

      // Act
      const response = await attachHandler(null, options);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:update-bounds', () => {
    it('应该成功更新视图边界', async () => {
      const options = {
        viewId: 'view-123',
        bounds: { x: 16, y: 24, width: 960, height: 640 },
      };

      mockViewManager.updateBounds.mockReturnValue(undefined);

      handler.register();
      const updateBoundsHandler = getIpcHandler('view:update-bounds');

      const response = await updateBoundsHandler(null, options);

      expect(mockViewManager.updateBounds).toHaveBeenCalledWith(options.viewId, options.bounds);
      expect(response).toEqual({ success: true });
    });

    it('应该处理更新视图边界失败', async () => {
      const options = {
        viewId: 'view-123',
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      };
      const errorMessage = '无效的视图边界';

      mockViewManager.updateBounds.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const updateBoundsHandler = getIpcHandler('view:update-bounds');

      const response = await updateBoundsHandler(null, options);

      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:navigate', () => {
    it('应该成功导航到目标地址', async () => {
      const options = {
        viewId: 'view-123',
        url: 'http://localhost:8080',
      };

      mockViewManager.navigateView.mockResolvedValue(undefined);

      handler.register();
      const navigateHandler = getIpcHandler('view:navigate');

      const response = await navigateHandler(null, options);

      expect(mockViewManager.navigateView).toHaveBeenCalledWith(options.viewId, options.url);
      expect(response).toEqual({ success: true });
    });

    it('应该使用主进程工作台地址导航云工作台视图', async () => {
      const options = {
        viewId: 'pool:workbench:tianshe-cloud',
        url: 'http://example.com',
      };

      mockViewManager.navigateView.mockResolvedValue(undefined);

      handler.register();
      const navigateHandler = getIpcHandler('view:navigate');

      const response = await navigateHandler(null, options);

      expect(mockViewManager.navigateView).toHaveBeenCalledWith(
        options.viewId,
        'http://localhost:8080'
      );
      expect(response).toEqual({ success: true });
    });

    it('应该处理导航失败', async () => {
      const options = {
        viewId: 'view-123',
        url: 'http://localhost:8080/login',
      };
      const errorMessage = '导航失败';

      mockViewManager.navigateView.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const navigateHandler = getIpcHandler('view:navigate');

      const response = await navigateHandler(null, options);

      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:sync-cloud-auth', () => {
    it('应该在没有保存登录态时跳过同步', async () => {
      const setCookie = vi.fn();
      mockViewManager.getView.mockReturnValue({
        view: {
          webContents: {
            session: {
              cookies: {
                set: setCookie,
              },
            },
          },
        },
      });
      mockGetPersistedCloudAuthSession.mockReturnValue(undefined);

      handler.register();
      const syncCloudAuthHandler = getIpcHandler('view:sync-cloud-auth');

      const response = await syncCloudAuthHandler(null, {
        viewId: 'view-123',
        url: 'http://localhost:8080',
      });

      expect(setCookie).not.toHaveBeenCalled();
      expect(response).toEqual({
        success: false,
        reason: 'cloud-auth-not-ready',
        targetOrigin: 'http://localhost:8080',
      });
    });

    it('应该在登录源和目标源不一致时跳过同步', async () => {
      const setCookie = vi.fn();
      mockViewManager.getView.mockReturnValue({
        view: {
          webContents: {
            session: {
              cookies: {
                set: setCookie,
              },
            },
          },
        },
      });
      mockGetPersistedCloudAuthSession.mockReturnValue({
        authSessionId: 'session-1',
        authRevision: 1,
        token: 'token-123',
        user: {
          userId: 1,
          userName: 'tester',
        },
      });

      handler.register();
      const syncCloudAuthHandler = getIpcHandler('view:sync-cloud-auth');

      const response = await syncCloudAuthHandler(null, {
        viewId: 'view-123',
        url: 'http://example.com',
      });

      expect(setCookie).not.toHaveBeenCalled();
      expect(response).toEqual({
        success: false,
        reason: 'invalid-workbench-origin',
        cookieName: 'Admin-Token',
        targetOrigin: 'http://example.com',
        expectedOrigin: 'http://localhost:8080',
      });
    });

    it('应该为云工作台视图使用主进程工作台地址同步 Cookie', async () => {
      const expire = '2030-01-01T00:00:00.000Z';
      const setCookie = vi.fn().mockResolvedValue(undefined);
      mockViewManager.getView.mockReturnValue({
        view: {
          webContents: {
            session: {
              cookies: {
                set: setCookie,
              },
            },
          },
        },
      });
      mockGetPersistedCloudAuthSession.mockReturnValue({
        authSessionId: 'session-1',
        authRevision: 1,
        token: 'token-123',
        expire,
        user: {
          userId: 1,
          userName: 'tester',
        },
      });

      handler.register();
      const syncCloudAuthHandler = getIpcHandler('view:sync-cloud-auth');

      const response = await syncCloudAuthHandler(null, {
        viewId: 'pool:workbench:tianshe-cloud',
        url: 'http://example.com',
      });

      expect(setCookie).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:8080/',
          name: 'Admin-Token',
          value: 'token-123',
          path: '/',
          secure: false,
          expirationDate: Math.floor(Date.parse(expire) / 1000),
        })
      );
      expect(response).toEqual({
        success: true,
        cookieName: 'Admin-Token',
        targetOrigin: 'http://localhost:8080',
      });
    });

    it('应该把已保存的 GoAdmin token 写入目标视图 Cookie', async () => {
      const expire = '2030-01-01T00:00:00.000Z';
      const setCookie = vi.fn().mockResolvedValue(undefined);
      mockViewManager.getView.mockReturnValue({
        view: {
          webContents: {
            session: {
              cookies: {
                set: setCookie,
              },
            },
          },
        },
      });
      mockGetPersistedCloudAuthSession.mockReturnValue({
        authSessionId: 'session-1',
        authRevision: 1,
        token: 'token-123',
        expire,
        user: {
          userId: 1,
          userName: 'tester',
        },
      });

      handler.register();
      const syncCloudAuthHandler = getIpcHandler('view:sync-cloud-auth');

      const response = await syncCloudAuthHandler(null, {
        viewId: 'view-123',
        url: 'http://localhost:8080',
      });

      expect(setCookie).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:8080/',
          name: 'Admin-Token',
          value: 'token-123',
          path: '/',
          secure: false,
          expirationDate: Math.floor(Date.parse(expire) / 1000),
        })
      );
      expect(response).toEqual({
        success: true,
        cookieName: 'Admin-Token',
        targetOrigin: 'http://localhost:8080',
      });
    });
  });

  describe('view:switch', () => {
    it('应该成功切换到指定视图（主窗口）', async () => {
      // Arrange
      const options = {
        viewId: 'view-123',
        windowId: 'main',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      };

      mockViewManager.switchView.mockReturnValue(undefined);

      handler.register();
      const switchHandler = getIpcHandler('view:switch');

      // Act
      const response = await switchHandler(null, options);

      // Assert
      expect(mockViewManager.switchView).toHaveBeenCalledWith(
        options.viewId,
        'main',
        options.bounds
      );
      expect(response).toEqual({ success: true });
    });

    it('应该默认切换到主窗口（不指定 windowId）', async () => {
      // Arrange
      const options = {
        viewId: 'view-456',
        bounds: { x: 0, y: 0, width: 1024, height: 768 },
      };

      mockViewManager.switchView.mockReturnValue(undefined);

      handler.register();
      const switchHandler = getIpcHandler('view:switch');

      // Act
      const response = await switchHandler(null, options);

      // Assert
      expect(mockViewManager.switchView).toHaveBeenCalledWith(
        options.viewId,
        'main',
        options.bounds
      );
      expect(response).toEqual({ success: true });
    });

    it('应该处理切换不存在的视图', async () => {
      // Arrange
      const options = {
        viewId: 'non-existent',
        windowId: 'main',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      };
      const errorMessage = '视图不存在';

      mockViewManager.switchView.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const switchHandler = getIpcHandler('view:switch');

      // Act
      const response = await switchHandler(null, options);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:detach', () => {
    it('应该成功分离视图', async () => {
      // Arrange
      const viewId = 'view-123';

      mockViewManager.detachView.mockReturnValue(undefined);

      handler.register();
      const detachHandler = getIpcHandler('view:detach');

      // Act
      const response = await detachHandler(null, viewId);

      // Assert
      expect(mockViewManager.detachView).toHaveBeenCalledWith(viewId);
      expect(response).toEqual({ success: true });
    });

    it('应该处理分离不存在的视图', async () => {
      // Arrange
      const viewId = 'non-existent-view';
      const errorMessage = '视图不存在';

      mockViewManager.detachView.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const detachHandler = getIpcHandler('view:detach');

      // Act
      const response = await detachHandler(null, viewId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('应该处理分离未附加的视图', async () => {
      // Arrange
      const viewId = 'view-not-attached';
      const errorMessage = '视图未附加到窗口';

      mockViewManager.detachView.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const detachHandler = getIpcHandler('view:detach');

      // Act
      const response = await detachHandler(null, viewId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:detach-all', () => {
    it('应该成功分离所有视图（不指定窗口 ID）', async () => {
      // Arrange
      mockViewManager.detachAllViews.mockReturnValue(undefined);

      handler.register();
      const detachAllHandler = getIpcHandler('view:detach-all');

      // Act
      const response = await detachAllHandler(null, undefined);

      // Assert
      expect(mockViewManager.detachAllViews).toHaveBeenCalledWith(undefined, {
        preserveDockedRight: false,
      });
      expect(response).toEqual({ success: true });
    });

    it('应该成功分离主窗口的所有视图', async () => {
      // Arrange
      const options = { windowId: 'main' };

      mockViewManager.detachAllViews.mockReturnValue(undefined);

      handler.register();
      const detachAllHandler = getIpcHandler('view:detach-all');

      // Act
      const response = await detachAllHandler(null, options);

      // Assert
      expect(mockViewManager.detachAllViews).toHaveBeenCalledWith('main', {
        preserveDockedRight: false,
      });
      expect(response).toEqual({ success: true });
    });

    it('应该成功分离指定窗口的所有视图', async () => {
      // Arrange
      const options = { windowId: 'custom-window' };

      mockViewManager.detachAllViews.mockReturnValue(undefined);

      handler.register();
      const detachAllHandler = getIpcHandler('view:detach-all');

      // Act
      const response = await detachAllHandler(null, options);

      // Assert
      expect(mockViewManager.detachAllViews).toHaveBeenCalledWith('custom-window', {
        preserveDockedRight: false,
      });
      expect(response).toEqual({ success: true });
    });

    it('应该支持保留右侧停靠视图', async () => {
      // Arrange
      const options = { windowId: 'main', preserveDockedRight: true };

      mockViewManager.detachAllViews.mockReturnValue(undefined);

      handler.register();
      const detachAllHandler = getIpcHandler('view:detach-all');

      // Act
      const response = await detachAllHandler(null, options);

      // Assert
      expect(mockViewManager.detachAllViews).toHaveBeenCalledWith('main', {
        preserveDockedRight: true,
      });
      expect(response).toEqual({ success: true });
    });

    it('应该处理分离所有视图失败的情况', async () => {
      // Arrange
      const errorMessage = '没有附加的视图';

      mockViewManager.detachAllViews.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const detachAllHandler = getIpcHandler('view:detach-all');

      // Act
      const response = await detachAllHandler(null, undefined);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:detach-scoped', () => {
    it('应该默认按 automation 作用域分离视图', async () => {
      // Arrange
      mockViewManager.detachScopedViews.mockReturnValue(undefined);

      handler.register();
      const detachScopedHandler = getIpcHandler('view:detach-scoped');

      // Act
      const response = await detachScopedHandler(null, undefined);

      // Assert
      expect(mockViewManager.detachScopedViews).toHaveBeenCalledWith({
        windowId: undefined,
        scope: 'automation',
        preserveDockedRight: false,
      });
      expect(response).toEqual({ success: true });
    });

    it('应该支持按 plugin 作用域分离指定窗口视图', async () => {
      // Arrange
      const options = { windowId: 'main', scope: 'plugin' as const, preserveDockedRight: true };
      mockViewManager.detachScopedViews.mockReturnValue(undefined);

      handler.register();
      const detachScopedHandler = getIpcHandler('view:detach-scoped');

      // Act
      const response = await detachScopedHandler(null, options);

      // Assert
      expect(mockViewManager.detachScopedViews).toHaveBeenCalledWith({
        windowId: 'main',
        scope: 'plugin',
        preserveDockedRight: true,
      });
      expect(response).toEqual({ success: true });
    });

    it('应该处理按作用域分离失败的情况', async () => {
      // Arrange
      const errorMessage = '作用域分离失败';
      mockViewManager.detachScopedViews.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const detachScopedHandler = getIpcHandler('view:detach-scoped');

      // Act
      const response = await detachScopedHandler(null, { scope: 'all' });

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:close', () => {
    it('应该成功关闭视图', async () => {
      // Arrange
      const viewId = 'view-123';

      mockViewManager.closeView.mockResolvedValue(undefined);

      handler.register();
      const closeHandler = getIpcHandler('view:close');

      // Act
      const response = await closeHandler(null, viewId);

      // Assert
      expect(mockViewManager.closeView).toHaveBeenCalledWith(viewId);
      expect(response).toEqual({ success: true });
    });

    it('应该处理关闭不存在的视图', async () => {
      // Arrange
      const viewId = 'non-existent-view';
      const errorMessage = '视图不存在';

      mockViewManager.closeView.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const closeHandler = getIpcHandler('view:close');

      // Act
      const response = await closeHandler(null, viewId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('应该处理关闭视图时的异步错误', async () => {
      // Arrange
      const viewId = 'view-error';
      const errorMessage = '关闭视图时发生错误';

      mockViewManager.closeView.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const closeHandler = getIpcHandler('view:close');

      // Act
      const response = await closeHandler(null, viewId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:list', () => {
    it('应该成功列出所有视图', async () => {
      // Arrange
      const mockViews = [
        { id: 'view-1', partition: 'persist:main', url: 'https://example1.com' },
        { id: 'view-2', partition: 'persist:main', url: 'https://example2.com' },
        { id: 'view-3', partition: 'persist:test', url: undefined },
      ];

      mockViewManager.listRegisteredViews.mockReturnValue(mockViews);

      handler.register();
      const listHandler = getIpcHandler('view:list');

      // Act
      const response = await listHandler();

      // Assert
      expect(mockViewManager.listRegisteredViews).toHaveBeenCalled();
      expect(response).toEqual({
        success: true,
        views: mockViews,
      });
    });

    it('应该处理空视图列表', async () => {
      // Arrange
      mockViewManager.listRegisteredViews.mockReturnValue([]);

      handler.register();
      const listHandler = getIpcHandler('view:list');

      // Act
      const response = await listHandler();

      // Assert
      expect(response).toEqual({
        success: true,
        views: [],
      });
    });

    it('应该处理获取视图列表失败的情况', async () => {
      // Arrange
      const errorMessage = '无法访问视图管理器';

      mockViewManager.listRegisteredViews.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const listHandler = getIpcHandler('view:list');

      // Act
      const response = await listHandler();

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:pool-status', () => {
    it('应该成功获取池状态', async () => {
      // Arrange
      const mockStatus = {
        total: 10,
        active: 3,
        idle: 7,
        maxSize: 20,
      };

      mockViewManager.getPoolStatus.mockReturnValue(mockStatus);

      handler.register();
      const poolStatusHandler = getIpcHandler('view:pool-status');

      // Act
      const response = await poolStatusHandler();

      // Assert
      expect(mockViewManager.getPoolStatus).toHaveBeenCalled();
      expect(response).toEqual({
        success: true,
        status: mockStatus,
      });
    });

    it('应该处理池为空的情况', async () => {
      // Arrange
      const mockStatus = {
        total: 0,
        active: 0,
        idle: 0,
        maxSize: 20,
      };

      mockViewManager.getPoolStatus.mockReturnValue(mockStatus);

      handler.register();
      const poolStatusHandler = getIpcHandler('view:pool-status');

      // Act
      const response = await poolStatusHandler();

      // Assert
      expect(response).toEqual({
        success: true,
        status: mockStatus,
      });
    });

    it('应该处理获取池状态失败的情况', async () => {
      // Arrange
      const errorMessage = '池管理器未初始化';

      mockViewManager.getPoolStatus.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const poolStatusHandler = getIpcHandler('view:pool-status');

      // Act
      const response = await poolStatusHandler();

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:resource-stats', () => {
    it('应该成功获取资源统计', async () => {
      // Arrange
      const mockStats = {
        viewCount: 5,
        memoryUsage: 1024000,
        cpuUsage: 15.5,
        createdCount: 10,
        destroyedCount: 5,
      };

      mockViewManager.getResourceStats.mockReturnValue(mockStats);

      handler.register();
      const resourceStatsHandler = getIpcHandler('view:resource-stats');

      // Act
      const response = await resourceStatsHandler();

      // Assert
      expect(mockViewManager.getResourceStats).toHaveBeenCalled();
      expect(response).toEqual({
        success: true,
        stats: mockStats,
      });
    });

    it('应该处理零资源使用的情况', async () => {
      // Arrange
      const mockStats = {
        viewCount: 0,
        memoryUsage: 0,
        cpuUsage: 0,
        createdCount: 0,
        destroyedCount: 0,
      };

      mockViewManager.getResourceStats.mockReturnValue(mockStats);

      handler.register();
      const resourceStatsHandler = getIpcHandler('view:resource-stats');

      // Act
      const response = await resourceStatsHandler();

      // Assert
      expect(response).toEqual({
        success: true,
        stats: mockStats,
      });
    });

    it('应该处理获取资源统计失败的情况', async () => {
      // Arrange
      const errorMessage = '无法获取资源统计';

      mockViewManager.getResourceStats.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const resourceStatsHandler = getIpcHandler('view:resource-stats');

      // Act
      const response = await resourceStatsHandler();

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:force-gc', () => {
    it('应该成功强制垃圾回收', async () => {
      // Arrange
      mockViewManager.forceGarbageCollection.mockResolvedValue(undefined);

      handler.register();
      const forceGCHandler = getIpcHandler('view:force-gc');

      // Act
      const response = await forceGCHandler();

      // Assert
      expect(mockViewManager.forceGarbageCollection).toHaveBeenCalled();
      expect(response).toEqual({ success: true });
    });

    it('应该处理垃圾回收失败的情况', async () => {
      // Arrange
      const errorMessage = 'GC 不可用';

      mockViewManager.forceGarbageCollection.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const forceGCHandler = getIpcHandler('view:force-gc');

      // Act
      const response = await forceGCHandler();

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('应该处理 GC 超时的情况', async () => {
      // Arrange
      const errorMessage = '垃圾回收超时';

      mockViewManager.forceGarbageCollection.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const forceGCHandler = getIpcHandler('view:force-gc');

      // Act
      const response = await forceGCHandler();

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:close-multiple', () => {
    it('应该成功批量关闭多个视图', async () => {
      // Arrange
      const viewIds = ['view-1', 'view-2', 'view-3'];
      const mockResult = {
        closed: ['view-1', 'view-2', 'view-3'],
        failed: [],
      };

      mockViewManager.closeMultipleViews.mockResolvedValue(mockResult);

      handler.register();
      const closeMultipleHandler = getIpcHandler('view:close-multiple');

      // Act
      const response = await closeMultipleHandler(null, viewIds);

      // Assert
      expect(mockViewManager.closeMultipleViews).toHaveBeenCalledWith(viewIds);
      expect(response).toEqual({
        success: true,
        result: mockResult,
      });
    });

    it('应该处理部分视图关闭失败的情况', async () => {
      // Arrange
      const viewIds = ['view-1', 'view-2', 'view-3'];
      const mockResult = {
        closed: ['view-1', 'view-3'],
        failed: ['view-2'],
      };

      mockViewManager.closeMultipleViews.mockResolvedValue(mockResult);

      handler.register();
      const closeMultipleHandler = getIpcHandler('view:close-multiple');

      // Act
      const response = await closeMultipleHandler(null, viewIds);

      // Assert
      expect(response).toEqual({
        success: true,
        result: mockResult,
      });
    });

    it('应该处理空视图 ID 列表', async () => {
      // Arrange
      const viewIds: string[] = [];
      const mockResult = {
        closed: [],
        failed: [],
      };

      mockViewManager.closeMultipleViews.mockResolvedValue(mockResult);

      handler.register();
      const closeMultipleHandler = getIpcHandler('view:close-multiple');

      // Act
      const response = await closeMultipleHandler(null, viewIds);

      // Assert
      expect(response).toEqual({
        success: true,
        result: mockResult,
      });
    });

    it('应该处理批量关闭失败的情况', async () => {
      // Arrange
      const viewIds = ['view-1', 'view-2'];
      const errorMessage = '批量关闭操作失败';

      mockViewManager.closeMultipleViews.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const closeMultipleHandler = getIpcHandler('view:close-multiple');

      // Act
      const response = await closeMultipleHandler(null, viewIds);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:close-oldest', () => {
    it('应该成功关闭最旧的 N 个视图', async () => {
      // Arrange
      const count = 3;
      const mockClosedViews = ['view-1', 'view-2', 'view-3'];

      mockViewManager.closeOldestViews.mockResolvedValue(mockClosedViews);

      handler.register();
      const closeOldestHandler = getIpcHandler('view:close-oldest');

      // Act
      const response = await closeOldestHandler(null, count);

      // Assert
      expect(mockViewManager.closeOldestViews).toHaveBeenCalledWith(count);
      expect(response).toEqual({
        success: true,
        closed: mockClosedViews,
      });
    });

    it('应该处理关闭 0 个视图的情况', async () => {
      // Arrange
      const count = 0;
      const mockClosedViews: string[] = [];

      mockViewManager.closeOldestViews.mockResolvedValue(mockClosedViews);

      handler.register();
      const closeOldestHandler = getIpcHandler('view:close-oldest');

      // Act
      const response = await closeOldestHandler(null, count);

      // Assert
      expect(response).toEqual({
        success: true,
        closed: mockClosedViews,
      });
    });

    it('应该处理视图数量少于请求数量的情况', async () => {
      // Arrange
      const count = 10;
      const mockClosedViews = ['view-1', 'view-2']; // 只有 2 个视图

      mockViewManager.closeOldestViews.mockResolvedValue(mockClosedViews);

      handler.register();
      const closeOldestHandler = getIpcHandler('view:close-oldest');

      // Act
      const response = await closeOldestHandler(null, count);

      // Assert
      expect(response).toEqual({
        success: true,
        closed: mockClosedViews,
      });
    });

    it('应该处理关闭最旧视图失败的情况', async () => {
      // Arrange
      const count = 5;
      const errorMessage = '无法确定视图创建时间';

      mockViewManager.closeOldestViews.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const closeOldestHandler = getIpcHandler('view:close-oldest');

      // Act
      const response = await closeOldestHandler(null, count);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('应该处理负数的情况', async () => {
      // Arrange
      const count = -1;
      const errorMessage = '数量必须大于等于 0';

      mockViewManager.closeOldestViews.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const closeOldestHandler = getIpcHandler('view:close-oldest');

      // Act
      const response = await closeOldestHandler(null, count);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:memory-usage', () => {
    it('应该成功获取内存使用估算', async () => {
      // Arrange
      const mockUsage = {
        total: 2048000,
        perView: 204800,
        viewCount: 10,
      };

      mockViewManager.getMemoryUsage.mockReturnValue(mockUsage);

      handler.register();
      const memoryUsageHandler = getIpcHandler('view:memory-usage');

      // Act
      const response = await memoryUsageHandler();

      // Assert
      expect(mockViewManager.getMemoryUsage).toHaveBeenCalled();
      expect(response).toEqual({
        success: true,
        usage: mockUsage,
      });
    });

    it('应该处理零内存使用的情况', async () => {
      // Arrange
      const mockUsage = {
        total: 0,
        perView: 0,
        viewCount: 0,
      };

      mockViewManager.getMemoryUsage.mockReturnValue(mockUsage);

      handler.register();
      const memoryUsageHandler = getIpcHandler('view:memory-usage');

      // Act
      const response = await memoryUsageHandler();

      // Assert
      expect(response).toEqual({
        success: true,
        usage: mockUsage,
      });
    });

    it('应该处理获取内存使用失败的情况', async () => {
      // Arrange
      const errorMessage = '无法获取内存统计信息';

      mockViewManager.getMemoryUsage.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const memoryUsageHandler = getIpcHandler('view:memory-usage');

      // Act
      const response = await memoryUsageHandler();

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('view:detailed-pool-status', () => {
    it('应该成功获取池的详细状态', async () => {
      // Arrange
      const mockStatus = {
        total: 10,
        active: 5,
        idle: 3,
        waiting: 2,
        maxSize: 20,
        views: [
          { id: 'view-1', state: 'active', uptime: 1000 },
          { id: 'view-2', state: 'idle', uptime: 2000 },
          { id: 'view-3', state: 'waiting', uptime: 500 },
        ],
      };

      mockViewManager.getDetailedPoolStatus.mockReturnValue(mockStatus);

      handler.register();
      const detailedPoolStatusHandler = getIpcHandler('view:detailed-pool-status');

      // Act
      const response = await detailedPoolStatusHandler();

      // Assert
      expect(mockViewManager.getDetailedPoolStatus).toHaveBeenCalled();
      expect(response).toEqual({
        success: true,
        status: mockStatus,
      });
    });

    it('应该处理空池的详细状态', async () => {
      // Arrange
      const mockStatus = {
        total: 0,
        active: 0,
        idle: 0,
        waiting: 0,
        maxSize: 20,
        views: [],
      };

      mockViewManager.getDetailedPoolStatus.mockReturnValue(mockStatus);

      handler.register();
      const detailedPoolStatusHandler = getIpcHandler('view:detailed-pool-status');

      // Act
      const response = await detailedPoolStatusHandler();

      // Assert
      expect(response).toEqual({
        success: true,
        status: mockStatus,
      });
    });

    it('应该处理获取详细池状态失败的情况', async () => {
      // Arrange
      const errorMessage = '池状态不可用';

      mockViewManager.getDetailedPoolStatus.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const detailedPoolStatusHandler = getIpcHandler('view:detailed-pool-status');

      // Act
      const response = await detailedPoolStatusHandler();

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('错误处理集成测试', () => {
    it('应该处理字符串类型的错误', async () => {
      // Arrange
      const viewId = 'view-string-error';
      mockViewManager.closeView.mockRejectedValue('字符串类型的错误');

      handler.register();
      const closeHandler = getIpcHandler('view:close');

      // Act
      const response = await closeHandler(null, viewId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: '字符串类型的错误',
      });
    });

    it('应该处理未知类型的错误', async () => {
      // Arrange
      const viewId = 'view-unknown-error';
      mockViewManager.closeView.mockRejectedValue({ unknown: 'error object' });

      handler.register();
      const closeHandler = getIpcHandler('view:close');

      // Act
      const response = await closeHandler(null, viewId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: 'Unknown error occurred',
      });
    });

    it('应该处理 null 错误', async () => {
      // Arrange
      const viewId = 'view-null-error';
      mockViewManager.closeView.mockRejectedValue(null);

      handler.register();
      const closeHandler = getIpcHandler('view:close');

      // Act
      const response = await closeHandler(null, viewId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: 'Unknown error occurred',
      });
    });
  });

  describe('边缘情况测试', () => {
    it('应该处理包含特殊字符的 viewId', async () => {
      // Arrange
      const viewId = 'view-测试-#@$%^&*()';
      mockViewManager.closeView.mockResolvedValue(undefined);

      handler.register();
      const closeHandler = getIpcHandler('view:close');

      // Act
      const response = await closeHandler(null, viewId);

      // Assert
      expect(mockViewManager.closeView).toHaveBeenCalledWith(viewId);
      expect(response.success).toBe(true);
    });

    it('应该处理非常长的 viewId', async () => {
      // Arrange
      const viewId = 'view-' + 'a'.repeat(1000);
      mockViewManager.closeView.mockResolvedValue(undefined);

      handler.register();
      const closeHandler = getIpcHandler('view:close');

      // Act
      const response = await closeHandler(null, viewId);

      // Assert
      expect(response.success).toBe(true);
    });

    it('应该处理空字符串 viewId', async () => {
      // Arrange
      const viewId = '';
      const errorMessage = 'viewId 不能为空';
      mockViewManager.closeView.mockRejectedValue(new Error(errorMessage));

      handler.register();
      const closeHandler = getIpcHandler('view:close');

      // Act
      const response = await closeHandler(null, viewId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('应该处理包含 Unicode 字符的 URL', async () => {
      // Arrange
      const options = {
        viewId: 'view-unicode',
        partition: 'persist:main',
        url: 'https://例え.jp/パス',
      };

      mockViewManager.registerView.mockReturnValue(undefined);

      handler.register();
      const createHandler = getIpcHandler('view:create');

      // Act
      const response = await createHandler(null, options);

      // Assert
      expect(response.success).toBe(true);
      expect(mockViewManager.registerView).toHaveBeenCalledWith({
        id: options.viewId,
        partition: options.partition,
        url: options.url,
      });
    });

    it('应该处理极大的边界值', async () => {
      // Arrange
      const options = {
        viewId: 'view-large-bounds',
        windowId: 'main',
        bounds: { x: 100000, y: 100000, width: 99999, height: 99999 },
      };

      mockViewManager.attachView.mockReturnValue(undefined);

      handler.register();
      const attachHandler = getIpcHandler('view:attach');

      // Act
      const response = await attachHandler(null, options);

      // Assert
      expect(response.success).toBe(true);
    });

    it('应该处理负数边界值', async () => {
      // Arrange
      const options = {
        viewId: 'view-negative-bounds',
        windowId: 'main',
        bounds: { x: -100, y: -100, width: 800, height: 600 },
      };

      mockViewManager.attachView.mockReturnValue(undefined);

      handler.register();
      const attachHandler = getIpcHandler('view:attach');

      // Act
      const response = await attachHandler(null, options);

      // Assert
      expect(response.success).toBe(true);
    });
  });

  describe('并发操作测试', () => {
    it('应该处理并发创建多个视图', async () => {
      // Arrange
      const options1 = { viewId: 'view-1', partition: 'persist:main' };
      const options2 = { viewId: 'view-2', partition: 'persist:main' };
      const options3 = { viewId: 'view-3', partition: 'persist:test' };

      mockViewManager.registerView.mockReturnValue(undefined);

      handler.register();
      const createHandler = getIpcHandler('view:create');

      // Act: 并发创建三个视图
      const [response1, response2, response3] = await Promise.all([
        createHandler(null, options1),
        createHandler(null, options2),
        createHandler(null, options3),
      ]);

      // Assert
      expect(response1.success).toBe(true);
      expect(response2.success).toBe(true);
      expect(response3.success).toBe(true);
      expect(mockViewManager.registerView).toHaveBeenCalledTimes(3);
    });

    it('应该处理并发关闭多个视图', async () => {
      // Arrange
      const viewIds = ['view-1', 'view-2', 'view-3'];

      mockViewManager.closeView.mockResolvedValue(undefined);

      handler.register();
      const closeHandler = getIpcHandler('view:close');

      // Act: 并发关闭三个视图
      const responses = await Promise.all(viewIds.map((viewId) => closeHandler(null, viewId)));

      // Assert
      responses.forEach((response) => {
        expect(response.success).toBe(true);
      });
      expect(mockViewManager.closeView).toHaveBeenCalledTimes(3);
    });

    it('应该处理并发获取各种状态信息', async () => {
      // Arrange
      mockViewManager.getPoolStatus.mockReturnValue({ total: 5 });
      mockViewManager.getResourceStats.mockReturnValue({ viewCount: 5 });
      mockViewManager.getMemoryUsage.mockReturnValue({ total: 1024000 });
      mockViewManager.getDetailedPoolStatus.mockReturnValue({ total: 5, views: [] });

      handler.register();
      const poolStatusHandler = getIpcHandler('view:pool-status');
      const resourceStatsHandler = getIpcHandler('view:resource-stats');
      const memoryUsageHandler = getIpcHandler('view:memory-usage');
      const detailedPoolStatusHandler = getIpcHandler('view:detailed-pool-status');

      // Act: 并发获取所有状态信息
      const [response1, response2, response3, response4] = await Promise.all([
        poolStatusHandler(),
        resourceStatsHandler(),
        memoryUsageHandler(),
        detailedPoolStatusHandler(),
      ]);

      // Assert
      expect(response1.success).toBe(true);
      expect(response2.success).toBe(true);
      expect(response3.success).toBe(true);
      expect(response4.success).toBe(true);
    });
  });

  describe('集成流程测试', () => {
    it('应该完整测试视图生命周期：创建 -> 激活 -> 附加 -> 分离 -> 关闭', async () => {
      // Arrange
      const viewId = 'view-lifecycle';
      const createOptions = {
        viewId,
        partition: 'persist:main',
        url: 'https://example.com',
      };
      const attachOptions = {
        viewId,
        windowId: 'main',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      };

      mockViewManager.registerView.mockReturnValue(undefined);
      mockViewManager.activateView.mockResolvedValue({
        id: viewId,
        partition: 'persist:main',
        url: 'https://example.com',
      });
      mockViewManager.attachView.mockReturnValue(undefined);
      mockViewManager.detachView.mockReturnValue(undefined);
      mockViewManager.closeView.mockResolvedValue(undefined);

      handler.register();
      const createHandler = getIpcHandler('view:create');
      const activateHandler = getIpcHandler('view:activate');
      const attachHandler = getIpcHandler('view:attach');
      const detachHandler = getIpcHandler('view:detach');
      const closeHandler = getIpcHandler('view:close');

      // Act & Assert: 完整生命周期
      const createResponse = await createHandler(null, createOptions);
      expect(createResponse.success).toBe(true);

      const activateResponse = await activateHandler(null, viewId);
      expect(activateResponse.success).toBe(true);

      const attachResponse = await attachHandler(null, attachOptions);
      expect(attachResponse.success).toBe(true);

      const detachResponse = await detachHandler(null, viewId);
      expect(detachResponse.success).toBe(true);

      const closeResponse = await closeHandler(null, viewId);
      expect(closeResponse.success).toBe(true);

      // 验证所有操作都被调用
      expect(mockViewManager.registerView).toHaveBeenCalledTimes(1);
      expect(mockViewManager.activateView).toHaveBeenCalledTimes(1);
      expect(mockViewManager.attachView).toHaveBeenCalledTimes(1);
      expect(mockViewManager.detachView).toHaveBeenCalledTimes(1);
      expect(mockViewManager.closeView).toHaveBeenCalledTimes(1);
    });

    it('应该完整测试批量操作流程：创建多个 -> 列表 -> 批量关闭', async () => {
      // Arrange
      const viewIds = ['view-1', 'view-2', 'view-3'];
      const mockViews = viewIds.map((id) => ({ id, partition: 'persist:main' }));

      mockViewManager.registerView.mockReturnValue(undefined);
      mockViewManager.listRegisteredViews.mockReturnValue(mockViews);
      mockViewManager.closeMultipleViews.mockResolvedValue({
        closed: viewIds,
        failed: [],
      });

      handler.register();
      const createHandler = getIpcHandler('view:create');
      const listHandler = getIpcHandler('view:list');
      const closeMultipleHandler = getIpcHandler('view:close-multiple');

      // Act & Assert: 批量操作流程
      // 创建多个视图
      for (const viewId of viewIds) {
        const response = await createHandler(null, { viewId, partition: 'persist:main' });
        expect(response.success).toBe(true);
      }

      // 列出所有视图
      const listResponse = await listHandler();
      expect(listResponse.success).toBe(true);
      expect(listResponse.views).toHaveLength(3);

      // 批量关闭
      const closeResponse = await closeMultipleHandler(null, viewIds);
      expect(closeResponse.success).toBe(true);
      expect(closeResponse.result.closed).toHaveLength(3);
    });
  });
});
