/**
 * IPC Handler 工具函数单元测试
 *
 * 测试 IPC 处理器创建、错误处理和批量注册功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  createIpcHandler,
  createIpcVoidHandler,
  registerIpcHandlers,
  handleIPCError,
  IpcError,
} from './utils';

// Mock electron 模块
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

describe('IPC Handler 工具函数', () => {
  // Mock console.error 避免测试输出污染
  const originalConsoleError = console.error;

  beforeEach(() => {
    console.error = vi.fn();
    vi.clearAllMocks();
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  describe('createIpcHandler', () => {
    it('应该成功创建 IPC Handler 并处理成功的调用', async () => {
      // Arrange: 准备测试数据
      const channel = 'test:channel';
      const expectedResult = { id: '123', name: 'Test' };
      const handler = vi.fn().mockResolvedValue(expectedResult);

      // Act: 创建 handler
      createIpcHandler(channel, handler);

      // Assert: 验证 ipcMain.handle 被调用
      expect(ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function));

      // 获取注册的 handler 函数
      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const args = ['arg1', 'arg2'];

      // 调用注册的 handler
      const response = await registeredHandler(mockEvent, ...args);

      // 验证结果
      expect(handler).toHaveBeenCalledWith('arg1', 'arg2');
      expect(response).toEqual({
        success: true,
        data: expectedResult,
      });
    });

    it('应该处理普通 Error 错误', async () => {
      // Arrange
      const channel = 'test:error';
      const errorMessage = 'Something went wrong';
      const handler = vi.fn().mockRejectedValue(new Error(errorMessage));

      // Act
      createIpcHandler(channel, handler, '操作失败');

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
      expect(console.error).toHaveBeenCalledWith(`[IPC] ${channel} error:`, expect.any(Error));
    });

    it('应该处理 IpcError 错误并包含错误码', async () => {
      // Arrange
      const channel = 'test:ipc-error';
      const ipcError = new IpcError('NOT_FOUND', 'Resource not found', {
        resource: 'profile',
        id: '123',
      });
      const handler = vi.fn().mockRejectedValue(ipcError);

      // Act
      createIpcHandler(channel, handler);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response).toEqual({
        success: false,
        error: 'Resource not found',
        code: 'NOT_FOUND',
      });
      expect(console.error).toHaveBeenCalled();
    });

    it('应该处理非 Error 对象的错误，使用默认错误消息', async () => {
      // Arrange
      const channel = 'test:unknown-error';
      const defaultMessage = '自定义默认错误';
      const handler = vi.fn().mockRejectedValue('string error'); // 抛出字符串

      // Act
      createIpcHandler(channel, handler, defaultMessage);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response).toEqual({
        success: false,
        error: defaultMessage,
      });
    });

    it('应该正确传递多个参数给 handler', async () => {
      // Arrange
      const channel = 'test:multiple-args';
      const handler = vi.fn().mockResolvedValue('success');

      // Act
      createIpcHandler(channel, handler);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      await registeredHandler(mockEvent, 'arg1', 123, { key: 'value' }, ['arr']);

      // Assert
      expect(handler).toHaveBeenCalledWith('arg1', 123, { key: 'value' }, ['arr']);
    });

    it('应该使用默认错误消息 "操作失败"', async () => {
      // Arrange
      const channel = 'test:default-error';
      const handler = vi.fn().mockRejectedValue(null); // 抛出 null

      // Act: 不传递 errorMessage 参数
      createIpcHandler(channel, handler);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response).toEqual({
        success: false,
        error: '操作失败',
      });
    });
  });

  describe('createIpcVoidHandler', () => {
    it('应该成功创建 Void IPC Handler 并返回成功响应', async () => {
      // Arrange
      const channel = 'test:void-channel';
      const handler = vi.fn().mockResolvedValue(undefined);

      // Act
      createIpcVoidHandler(channel, handler);

      // Assert
      expect(ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function));

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent, 'arg1');

      expect(handler).toHaveBeenCalledWith('arg1');
      expect(response).toEqual({
        success: true,
      });
    });

    it('应该处理普通 Error 错误', async () => {
      // Arrange
      const channel = 'test:void-error';
      const errorMessage = 'Void operation failed';
      const handler = vi.fn().mockRejectedValue(new Error(errorMessage));

      // Act
      createIpcVoidHandler(channel, handler, '删除失败');

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
      expect(console.error).toHaveBeenCalledWith(`[IPC] ${channel} error:`, expect.any(Error));
    });

    it('应该处理 IpcError 错误', async () => {
      // Arrange
      const channel = 'test:void-ipc-error';
      const ipcError = IpcError.resourceBusy('Browser', 'Already in use');
      const handler = vi.fn().mockRejectedValue(ipcError);

      // Act
      createIpcVoidHandler(channel, handler);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response).toEqual({
        success: false,
        error: 'Browser is busy: Already in use',
        code: 'RESOURCE_BUSY',
      });
    });

    it('应该处理非 Error 对象的错误', async () => {
      // Arrange
      const channel = 'test:void-unknown';
      const defaultMessage = 'Void 操作失败';
      const handler = vi.fn().mockRejectedValue(12345); // 抛出数字

      // Act
      createIpcVoidHandler(channel, handler, defaultMessage);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response).toEqual({
        success: false,
        error: defaultMessage,
      });
    });
  });

  describe('registerIpcHandlers', () => {
    it('应该批量注册多个 IPC Handlers', () => {
      // Arrange
      const handler1 = vi.fn().mockResolvedValue('result1');
      const handler2 = vi.fn().mockResolvedValue(undefined);
      const handler3 = vi.fn().mockResolvedValue({ data: 'test' });

      const handlers = [
        {
          channel: 'test:channel1',
          handler: handler1,
          errorMsg: '操作1失败',
        },
        {
          channel: 'test:channel2',
          handler: handler2,
          errorMsg: '操作2失败',
          isVoid: true,
        },
        {
          channel: 'test:channel3',
          handler: handler3,
        },
      ];

      // Act
      registerIpcHandlers(handlers);

      // Assert: 验证所有 handler 都被注册
      expect(ipcMain.handle).toHaveBeenCalledTimes(3);
      expect(ipcMain.handle).toHaveBeenCalledWith('test:channel1', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('test:channel2', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('test:channel3', expect.any(Function));
    });

    it('应该正确区分 void 和非 void handlers', async () => {
      // Arrange
      const normalHandler = vi.fn().mockResolvedValue('data');
      const voidHandler = vi.fn().mockResolvedValue(undefined);

      const handlers = [
        { channel: 'test:normal', handler: normalHandler },
        { channel: 'test:void', handler: voidHandler, isVoid: true },
      ];

      // Act
      registerIpcHandlers(handlers);

      const mockEvent = {} as IpcMainInvokeEvent;

      // 获取 normal handler
      const normalRegistered = (ipcMain.handle as any).mock.calls[0][1];
      const normalResponse = await normalRegistered(mockEvent);

      // 获取 void handler
      const voidRegistered = (ipcMain.handle as any).mock.calls[1][1];
      const voidResponse = await voidRegistered(mockEvent);

      // Assert
      expect(normalResponse).toEqual({
        success: true,
        data: 'data',
      });

      expect(voidResponse).toEqual({
        success: true,
      });
    });

    it('应该处理空数组', () => {
      // Arrange
      const handlers: Array<{
        channel: string;
        handler: (...args: any[]) => Promise<any>;
        errorMsg?: string;
        isVoid?: boolean;
      }> = [];

      // Act
      registerIpcHandlers(handlers);

      // Assert
      expect(ipcMain.handle).not.toHaveBeenCalled();
    });

    it('应该传递自定义错误消息', async () => {
      // Arrange
      const customErrorMsg = '自定义错误消息';
      const handler = vi.fn().mockRejectedValue({ unknown: 'error' });

      const handlers = [
        {
          channel: 'test:custom-error',
          handler,
          errorMsg: customErrorMsg,
        },
      ];

      // Act
      registerIpcHandlers(handlers);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response).toEqual({
        success: false,
        error: customErrorMsg,
      });
    });
  });

  describe('handleIPCError', () => {
    it('应该处理 IpcError 并返回包含错误码的响应', () => {
      // Arrange
      const ipcError = new IpcError('INVALID_INPUT', '输入参数无效', {
        field: 'name',
      });

      // Act
      const response = handleIPCError(ipcError);

      // Assert
      expect(response).toEqual({
        success: false,
        error: '输入参数无效',
        code: 'INVALID_INPUT',
      });
    });

    it('应该处理使用静态方法创建的 IpcError', () => {
      // Arrange
      const notFoundError = IpcError.notFound('Profile', 'abc123');

      // Act
      const response = handleIPCError(notFoundError);

      // Assert
      expect(response).toEqual({
        success: false,
        error: 'Profile not found: abc123',
        code: 'NOT_FOUND',
      });
    });

    it('应该处理普通 Error', () => {
      // Arrange
      const error = new Error('普通错误消息');

      // Act
      const response = handleIPCError(error);

      // Assert
      expect(response).toEqual({
        success: false,
        error: '普通错误消息',
      });
    });

    it('应该处理非 Error 对象并使用默认消息', () => {
      // Arrange
      const unknownError = { message: 'not an error object' };

      // Act
      const response = handleIPCError(unknownError, '默认错误');

      // Assert
      expect(response).toEqual({
        success: false,
        error: '默认错误',
      });
    });

    it('应该处理 null 或 undefined', () => {
      // Act & Assert
      expect(handleIPCError(null)).toEqual({
        success: false,
        error: '操作失败',
      });

      expect(handleIPCError(undefined)).toEqual({
        success: false,
        error: '操作失败',
      });
    });

    it('应该使用自定义默认消息', () => {
      // Arrange
      const customDefault = '这是一个自定义默认错误';

      // Act
      const response = handleIPCError('some error', customDefault);

      // Assert
      expect(response).toEqual({
        success: false,
        error: customDefault,
      });
    });

    it('应该处理所有 IpcError 静态方法', () => {
      // Test notFound
      const notFound = IpcError.notFound('User');
      expect(handleIPCError(notFound)).toMatchObject({
        success: false,
        code: 'NOT_FOUND',
      });

      // Test resourceBusy
      const resourceBusy = IpcError.resourceBusy('Database', 'locked');
      expect(handleIPCError(resourceBusy)).toMatchObject({
        success: false,
        code: 'RESOURCE_BUSY',
      });

      // Test permissionDenied
      const permissionDenied = IpcError.permissionDenied('delete profile');
      expect(handleIPCError(permissionDenied)).toMatchObject({
        success: false,
        code: 'PERMISSION_DENIED',
      });

      // Test invalidInput
      const invalidInput = IpcError.invalidInput('email', 'invalid format');
      expect(handleIPCError(invalidInput)).toMatchObject({
        success: false,
        code: 'INVALID_INPUT',
      });
    });
  });

  describe('边缘情况和集成测试', () => {
    it('应该在 handler 内部正确处理异步操作', async () => {
      // Arrange
      const channel = 'test:async';
      let counter = 0;
      const handler = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        counter++;
        return counter;
      });

      // Act
      createIpcHandler(channel, handler);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;

      const response1 = await registeredHandler(mockEvent);
      const response2 = await registeredHandler(mockEvent);

      // Assert
      expect(response1).toEqual({ success: true, data: 1 });
      expect(response2).toEqual({ success: true, data: 2 });
    });

    it('应该处理 handler 返回 null 的情况', async () => {
      // Arrange
      const channel = 'test:null-return';
      const handler = vi.fn().mockResolvedValue(null);

      // Act
      createIpcHandler(channel, handler);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response).toEqual({
        success: true,
        data: null,
      });
    });

    it('应该处理 handler 返回 undefined 的情况', async () => {
      // Arrange
      const channel = 'test:undefined-return';
      const handler = vi.fn().mockResolvedValue(undefined);

      // Act
      createIpcHandler(channel, handler);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response).toEqual({
        success: true,
        data: undefined,
      });
    });

    it('应该处理复杂的嵌套数据结构', async () => {
      // Arrange
      const channel = 'test:complex-data';
      const complexData = {
        id: '123',
        nested: {
          array: [1, 2, { deep: 'value' }],
          map: new Map([['key', 'value']]),
        },
      };
      const handler = vi.fn().mockResolvedValue(complexData);

      // Act
      createIpcHandler(channel, handler);

      const registeredHandler = (ipcMain.handle as any).mock.calls[0][1];
      const mockEvent = {} as IpcMainInvokeEvent;
      const response = await registeredHandler(mockEvent);

      // Assert
      expect(response.success).toBe(true);
      expect(response.data).toEqual(complexData);
    });

    it('应该在多次调用时保持独立性', async () => {
      // Arrange
      const handler1 = vi.fn().mockResolvedValue('result1');
      const handler2 = vi.fn().mockResolvedValue('result2');

      // Act
      createIpcHandler('channel1', handler1);
      createIpcHandler('channel2', handler2);

      const handler1Registered = (ipcMain.handle as any).mock.calls[0][1];
      const handler2Registered = (ipcMain.handle as any).mock.calls[1][1];
      const mockEvent = {} as IpcMainInvokeEvent;

      const response1 = await handler1Registered(mockEvent);
      const response2 = await handler2Registered(mockEvent);

      // Assert
      expect(response1).toEqual({ success: true, data: 'result1' });
      expect(response2).toEqual({ success: true, data: 'result2' });
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });
});
