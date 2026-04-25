/**
 * 文件 IPC 处理器单元测试
 *
 * 测试 FileIPCHandler 类的所有文件操作功能：
 * - 文件上传
 * - 文件删除
 * - 文件打开
 * - 获取文件 URL
 * - 获取图片 Base64 数据
 * - 删除数据集文件
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, shell } from 'electron';
import { FileIPCHandler } from './file-handler';
import { fileStorage } from '../file-storage';

// Mock electron 模块
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
  },
}));

// Mock fileStorage 模块
vi.mock('../file-storage', () => ({
  fileStorage: {
    saveFile: vi.fn(),
    deleteFile: vi.fn(),
    getFilePath: vi.fn(),
    fileExists: vi.fn(),
    getFileUrl: vi.fn(),
    getFileAsBase64: vi.fn(),
    deleteDatasetFiles: vi.fn(),
  },
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

describe('FileIPCHandler', () => {
  let handler: FileIPCHandler;

  // Mock console 方法避免测试输出污染
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  beforeEach(() => {
    console.log = vi.fn();
    console.error = vi.fn();
    vi.clearAllMocks();
    handler = new FileIPCHandler();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('register', () => {
    it('应该注册所有文件相关的 IPC handlers', () => {
      // Act
      handler.register();

      // Assert: 验证所有 handler 都被注册
      expect(ipcMain.handle).toHaveBeenCalledTimes(6);
      expect(ipcMain.handle).toHaveBeenCalledWith('file:upload', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('file:delete', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('file:open', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('file:getUrl', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('file:getImageData', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('file:deleteDatasetFiles', expect.any(Function));

      // 验证日志输出
      expect(console.log).toHaveBeenCalledWith('✅ File IPC handlers registered');
    });
  });

  describe('file:upload', () => {
    it('应该成功上传文件并返回元数据', async () => {
      // Arrange
      const datasetId = 'dataset-123';
      const fileData = {
        buffer: Buffer.from('test file content'),
        filename: 'test.txt',
      };
      const mockMetadata = {
        id: 'file-456',
        filename: 'test.txt',
        size: 1024,
        createdAt: new Date().toISOString(),
      };

      vi.mocked(fileStorage.saveFile).mockResolvedValue(mockMetadata);

      handler.register();
      const uploadHandler = (ipcMain.handle as any).mock.calls[0][1];

      // Act
      const response = await uploadHandler(null, datasetId, fileData);

      // Assert
      expect(fileStorage.saveFile).toHaveBeenCalledWith(
        datasetId,
        expect.any(Buffer),
        fileData.filename
      );
      expect(response).toEqual({
        success: true,
        metadata: mockMetadata,
      });
      expect(console.log).toHaveBeenCalledWith(
        `[FileIPCHandler] Uploading file: ${fileData.filename} for dataset: ${datasetId}`
      );
    });

    it('应该处理文件上传失败的情况', async () => {
      // Arrange
      const datasetId = 'dataset-123';
      const fileData = {
        buffer: Buffer.from('test content'),
        filename: 'test.txt',
      };
      const errorMessage = '磁盘空间不足';

      vi.mocked(fileStorage.saveFile).mockRejectedValue(new Error(errorMessage));

      handler.register();
      const uploadHandler = (ipcMain.handle as any).mock.calls[0][1];

      // Act
      const response = await uploadHandler(null, datasetId, fileData);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
      expect(console.error).toHaveBeenCalledWith(
        '[FileIPCHandler] Upload failed:',
        expect.any(Error)
      );
    });

    it('应该正确转换 buffer 数据', async () => {
      // Arrange
      const datasetId = 'dataset-123';
      const originalBuffer = Buffer.from('original content');
      const fileData = {
        buffer: originalBuffer,
        filename: 'document.pdf',
      };

      vi.mocked(fileStorage.saveFile).mockResolvedValue({
        id: 'file-789',
        filename: fileData.filename,
        size: originalBuffer.length,
        createdAt: new Date().toISOString(),
      });

      handler.register();
      const uploadHandler = (ipcMain.handle as any).mock.calls[0][1];

      // Act
      await uploadHandler(null, datasetId, fileData);

      // Assert: 验证 Buffer.from 被调用
      expect(fileStorage.saveFile).toHaveBeenCalledWith(
        datasetId,
        expect.any(Buffer),
        fileData.filename
      );
    });

    it('应该处理空文件上传', async () => {
      // Arrange
      const datasetId = 'dataset-123';
      const fileData = {
        buffer: Buffer.from(''),
        filename: 'empty.txt',
      };
      const mockMetadata = {
        id: 'file-empty',
        filename: 'empty.txt',
        size: 0,
        createdAt: new Date().toISOString(),
      };

      vi.mocked(fileStorage.saveFile).mockResolvedValue(mockMetadata);

      handler.register();
      const uploadHandler = (ipcMain.handle as any).mock.calls[0][1];

      // Act
      const response = await uploadHandler(null, datasetId, fileData);

      // Assert
      expect(response).toEqual({
        success: true,
        metadata: mockMetadata,
      });
    });
  });

  describe('file:delete', () => {
    it('应该成功删除文件', async () => {
      // Arrange
      const relativePath = 'uploads/dataset-123/file-456.txt';

      vi.mocked(fileStorage.deleteFile).mockResolvedValue(undefined);

      handler.register();
      const deleteHandler = (ipcMain.handle as any).mock.calls[1][1];

      // Act
      const response = await deleteHandler(null, relativePath);

      // Assert
      expect(fileStorage.deleteFile).toHaveBeenCalledWith(relativePath);
      expect(response).toEqual({
        success: true,
      });
      expect(console.log).toHaveBeenCalledWith(`[FileIPCHandler] Deleting file: ${relativePath}`);
    });

    it('应该处理文件删除失败的情况', async () => {
      // Arrange
      const relativePath = 'uploads/dataset-123/file-456.txt';
      const errorMessage = '文件不存在';

      vi.mocked(fileStorage.deleteFile).mockRejectedValue(new Error(errorMessage));

      handler.register();
      const deleteHandler = (ipcMain.handle as any).mock.calls[1][1];

      // Act
      const response = await deleteHandler(null, relativePath);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
      expect(console.error).toHaveBeenCalledWith(
        '[FileIPCHandler] Delete failed:',
        expect.any(Error)
      );
    });

    it('应该处理文件权限错误', async () => {
      // Arrange
      const relativePath = 'uploads/dataset-123/protected.txt';
      const errorMessage = '权限不足';

      vi.mocked(fileStorage.deleteFile).mockRejectedValue(new Error(errorMessage));

      handler.register();
      const deleteHandler = (ipcMain.handle as any).mock.calls[1][1];

      // Act
      const response = await deleteHandler(null, relativePath);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('file:open', () => {
    it('应该成功打开文件', async () => {
      // Arrange
      const relativePath = 'uploads/dataset-123/document.pdf';
      const fullPath = 'D:\\app\\uploads\\dataset-123\\document.pdf';

      vi.mocked(fileStorage.getFilePath).mockReturnValue(fullPath);
      vi.mocked(fileStorage.fileExists).mockReturnValue(true);
      vi.mocked(shell.openPath).mockResolvedValue('');

      handler.register();
      const openHandler = (ipcMain.handle as any).mock.calls[2][1];

      // Act
      const response = await openHandler(null, relativePath);

      // Assert
      expect(fileStorage.getFilePath).toHaveBeenCalledWith(relativePath);
      expect(fileStorage.fileExists).toHaveBeenCalledWith(relativePath);
      expect(shell.openPath).toHaveBeenCalledWith(fullPath);
      expect(response).toEqual({
        success: true,
      });
      expect(console.log).toHaveBeenCalledWith(`[FileIPCHandler] Opening file: ${relativePath}`);
    });

    it('应该处理文件不存在的情况', async () => {
      // Arrange
      const relativePath = 'uploads/dataset-123/missing.txt';
      const fullPath = 'D:\\app\\uploads\\dataset-123\\missing.txt';

      vi.mocked(fileStorage.getFilePath).mockReturnValue(fullPath);
      vi.mocked(fileStorage.fileExists).mockReturnValue(false);

      handler.register();
      const openHandler = (ipcMain.handle as any).mock.calls[2][1];

      // Act
      const response = await openHandler(null, relativePath);

      // Assert
      expect(fileStorage.fileExists).toHaveBeenCalledWith(relativePath);
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(response).toEqual({
        success: false,
        error: '文件不存在',
      });
      expect(console.error).toHaveBeenCalledWith(
        '[FileIPCHandler] Open failed:',
        expect.any(Error)
      );
    });

    it('应该处理系统打开文件失败的情况', async () => {
      // Arrange
      const relativePath = 'uploads/dataset-123/corrupt.txt';
      const fullPath = 'D:\\app\\uploads\\dataset-123\\corrupt.txt';
      const errorMessage = '无法打开文件';

      vi.mocked(fileStorage.getFilePath).mockReturnValue(fullPath);
      vi.mocked(fileStorage.fileExists).mockReturnValue(true);
      vi.mocked(shell.openPath).mockRejectedValue(new Error(errorMessage));

      handler.register();
      const openHandler = (ipcMain.handle as any).mock.calls[2][1];

      // Act
      const response = await openHandler(null, relativePath);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
      expect(console.error).toHaveBeenCalledWith(
        '[FileIPCHandler] Open failed:',
        expect.any(Error)
      );
    });

    it('应该在打开前先检查文件是否存在', async () => {
      // Arrange
      const relativePath = 'uploads/test.txt';
      const fullPath = 'D:\\app\\uploads\\test.txt';

      vi.mocked(fileStorage.getFilePath).mockReturnValue(fullPath);
      vi.mocked(fileStorage.fileExists).mockReturnValue(false);

      handler.register();
      const openHandler = (ipcMain.handle as any).mock.calls[2][1];

      // Act
      await openHandler(null, relativePath);

      // Assert: 验证调用顺序
      const fileExistsCall = vi.mocked(fileStorage.fileExists).mock.invocationCallOrder[0];
      const openPathCalls = vi.mocked(shell.openPath).mock.invocationCallOrder;

      expect(fileExistsCall).toBeDefined();
      expect(openPathCalls).toHaveLength(0); // shell.openPath 不应该被调用
    });
  });

  describe('file:getUrl', () => {
    it('应该成功获取文件 URL', async () => {
      // Arrange
      const relativePath = 'uploads/dataset-123/image.png';
      const expectedUrl = 'app://local/uploads/dataset-123/image.png';

      vi.mocked(fileStorage.getFileUrl).mockReturnValue(expectedUrl);

      handler.register();
      const getUrlHandler = (ipcMain.handle as any).mock.calls[3][1];

      // Act
      const response = await getUrlHandler(null, relativePath);

      // Assert
      expect(fileStorage.getFileUrl).toHaveBeenCalledWith(relativePath);
      expect(response).toEqual({
        success: true,
        url: expectedUrl,
      });
    });

    it('应该处理获取 URL 失败的情况', async () => {
      // Arrange
      const relativePath = 'invalid/path/file.txt';
      const errorMessage = '无效的文件路径';

      vi.mocked(fileStorage.getFileUrl).mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const getUrlHandler = (ipcMain.handle as any).mock.calls[3][1];

      // Act
      const response = await getUrlHandler(null, relativePath);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
      expect(console.error).toHaveBeenCalledWith(
        '[FileIPCHandler] Get URL failed:',
        expect.any(Error)
      );
    });

    it('应该处理空路径', async () => {
      // Arrange
      const relativePath = '';
      const errorMessage = '路径不能为空';

      vi.mocked(fileStorage.getFileUrl).mockImplementation(() => {
        throw new Error(errorMessage);
      });

      handler.register();
      const getUrlHandler = (ipcMain.handle as any).mock.calls[3][1];

      // Act
      const response = await getUrlHandler(null, relativePath);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('file:getImageData', () => {
    it('应该成功获取图片的 Base64 数据', async () => {
      // Arrange
      const relativePath = 'uploads/dataset-123/photo.jpg';
      const expectedBase64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRg...';

      vi.mocked(fileStorage.getFileAsBase64).mockResolvedValue(expectedBase64);

      handler.register();
      const getImageDataHandler = (ipcMain.handle as any).mock.calls[4][1];

      // Act
      const response = await getImageDataHandler(null, relativePath);

      // Assert
      expect(fileStorage.getFileAsBase64).toHaveBeenCalledWith(relativePath);
      expect(response).toEqual({
        success: true,
        data: expectedBase64,
      });
    });

    it('应该处理图片文件不存在的情况', async () => {
      // Arrange
      const relativePath = 'uploads/missing-image.png';
      const errorMessage = '图片文件不存在';

      vi.mocked(fileStorage.getFileAsBase64).mockRejectedValue(new Error(errorMessage));

      handler.register();
      const getImageDataHandler = (ipcMain.handle as any).mock.calls[4][1];

      // Act
      const response = await getImageDataHandler(null, relativePath);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
      expect(console.error).toHaveBeenCalledWith(
        '[FileIPCHandler] Get image data failed:',
        expect.any(Error)
      );
    });

    it('应该处理非图片文件的情况', async () => {
      // Arrange
      const relativePath = 'uploads/document.pdf';
      const errorMessage = '不是有效的图片文件';

      vi.mocked(fileStorage.getFileAsBase64).mockRejectedValue(new Error(errorMessage));

      handler.register();
      const getImageDataHandler = (ipcMain.handle as any).mock.calls[4][1];

      // Act
      const response = await getImageDataHandler(null, relativePath);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('应该处理图片读取错误', async () => {
      // Arrange
      const relativePath = 'uploads/corrupt-image.jpg';
      const errorMessage = '文件已损坏';

      vi.mocked(fileStorage.getFileAsBase64).mockRejectedValue(new Error(errorMessage));

      handler.register();
      const getImageDataHandler = (ipcMain.handle as any).mock.calls[4][1];

      // Act
      const response = await getImageDataHandler(null, relativePath);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });
  });

  describe('file:deleteDatasetFiles', () => {
    it('应该成功删除数据集的所有文件', async () => {
      // Arrange
      const datasetId = 'dataset-123';

      vi.mocked(fileStorage.deleteDatasetFiles).mockResolvedValue(undefined);

      handler.register();
      const deleteDatasetHandler = (ipcMain.handle as any).mock.calls[5][1];

      // Act
      const response = await deleteDatasetHandler(null, datasetId);

      // Assert
      expect(fileStorage.deleteDatasetFiles).toHaveBeenCalledWith(datasetId);
      expect(response).toEqual({
        success: true,
      });
      expect(console.log).toHaveBeenCalledWith(
        `[FileIPCHandler] Deleting all files for dataset: ${datasetId}`
      );
    });

    it('应该处理删除数据集文件失败的情况', async () => {
      // Arrange
      const datasetId = 'dataset-456';
      const errorMessage = '部分文件无法删除';

      vi.mocked(fileStorage.deleteDatasetFiles).mockRejectedValue(new Error(errorMessage));

      handler.register();
      const deleteDatasetHandler = (ipcMain.handle as any).mock.calls[5][1];

      // Act
      const response = await deleteDatasetHandler(null, datasetId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
      expect(console.error).toHaveBeenCalledWith(
        '[FileIPCHandler] Delete dataset files failed:',
        expect.any(Error)
      );
    });

    it('应该处理数据集不存在的情况', async () => {
      // Arrange
      const datasetId = 'non-existent-dataset';
      const errorMessage = '数据集不存在';

      vi.mocked(fileStorage.deleteDatasetFiles).mockRejectedValue(new Error(errorMessage));

      handler.register();
      const deleteDatasetHandler = (ipcMain.handle as any).mock.calls[5][1];

      // Act
      const response = await deleteDatasetHandler(null, datasetId);

      // Assert
      expect(response).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('应该处理空数据集 ID', async () => {
      // Arrange
      const datasetId = '';
      const errorMessage = '数据集 ID 不能为空';

      vi.mocked(fileStorage.deleteDatasetFiles).mockRejectedValue(new Error(errorMessage));

      handler.register();
      const deleteDatasetHandler = (ipcMain.handle as any).mock.calls[5][1];

      // Act
      const response = await deleteDatasetHandler(null, datasetId);

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
      const relativePath = 'test.txt';
      vi.mocked(fileStorage.deleteFile).mockRejectedValue('字符串错误');

      handler.register();
      const deleteHandler = (ipcMain.handle as any).mock.calls[1][1];

      // Act
      const response = await deleteHandler(null, relativePath);

      // Assert
      expect(response).toEqual({
        success: false,
        error: '字符串错误',
      });
    });

    it('应该处理未知类型的错误', async () => {
      // Arrange
      const relativePath = 'test.txt';
      vi.mocked(fileStorage.deleteFile).mockRejectedValue({ unknown: 'error' });

      handler.register();
      const deleteHandler = (ipcMain.handle as any).mock.calls[1][1];

      // Act
      const response = await deleteHandler(null, relativePath);

      // Assert
      expect(response).toEqual({
        success: false,
        error: 'Unknown error occurred',
      });
    });

    it('应该在所有错误情况下记录错误日志', async () => {
      // Arrange
      const datasetId = 'dataset-123';
      const fileData = {
        buffer: Buffer.from('test'),
        filename: 'test.txt',
      };

      vi.mocked(fileStorage.saveFile).mockRejectedValue(new Error('测试错误'));

      handler.register();
      const uploadHandler = (ipcMain.handle as any).mock.calls[0][1];

      // Act
      await uploadHandler(null, datasetId, fileData);

      // Assert: 验证错误被记录
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('边缘情况测试', () => {
    it('应该处理包含特殊字符的文件名', async () => {
      // Arrange
      const datasetId = 'dataset-123';
      const fileData = {
        buffer: Buffer.from('test'),
        filename: '测试文件 (副本) [2024].txt',
      };
      const mockMetadata = {
        id: 'file-special',
        filename: fileData.filename,
        size: 100,
        createdAt: new Date().toISOString(),
      };

      vi.mocked(fileStorage.saveFile).mockResolvedValue(mockMetadata);

      handler.register();
      const uploadHandler = (ipcMain.handle as any).mock.calls[0][1];

      // Act
      const response = await uploadHandler(null, datasetId, fileData);

      // Assert
      expect(response.success).toBe(true);
      expect(response.metadata.filename).toBe(fileData.filename);
    });

    it('应该处理非常长的文件路径', async () => {
      // Arrange
      const longPath = 'uploads/' + 'a'.repeat(200) + '/file.txt';
      const fullPath = 'D:\\app\\' + longPath;

      vi.mocked(fileStorage.getFilePath).mockReturnValue(fullPath);
      vi.mocked(fileStorage.fileExists).mockReturnValue(true);
      vi.mocked(shell.openPath).mockResolvedValue('');

      handler.register();
      const openHandler = (ipcMain.handle as any).mock.calls[2][1];

      // Act
      const response = await openHandler(null, longPath);

      // Assert
      expect(response.success).toBe(true);
    });

    it('应该处理大文件上传', async () => {
      // Arrange
      const datasetId = 'dataset-123';
      const largeBuffer = Buffer.alloc(10 * 1024 * 1024); // 10MB
      const fileData = {
        buffer: largeBuffer,
        filename: 'large-file.zip',
      };
      const mockMetadata = {
        id: 'file-large',
        filename: fileData.filename,
        size: largeBuffer.length,
        createdAt: new Date().toISOString(),
      };

      vi.mocked(fileStorage.saveFile).mockResolvedValue(mockMetadata);

      handler.register();
      const uploadHandler = (ipcMain.handle as any).mock.calls[0][1];

      // Act
      const response = await uploadHandler(null, datasetId, fileData);

      // Assert
      expect(response.success).toBe(true);
      expect(response.metadata.size).toBe(largeBuffer.length);
    });

    it('应该处理并发请求', async () => {
      // Arrange
      const datasetId = 'dataset-123';
      const file1 = { buffer: Buffer.from('file1'), filename: 'file1.txt' };
      const file2 = { buffer: Buffer.from('file2'), filename: 'file2.txt' };

      vi.mocked(fileStorage.saveFile)
        .mockResolvedValueOnce({ id: '1', filename: 'file1.txt', size: 5, createdAt: '' })
        .mockResolvedValueOnce({ id: '2', filename: 'file2.txt', size: 5, createdAt: '' });

      handler.register();
      const uploadHandler = (ipcMain.handle as any).mock.calls[0][1];

      // Act: 并发上传两个文件
      const [response1, response2] = await Promise.all([
        uploadHandler(null, datasetId, file1),
        uploadHandler(null, datasetId, file2),
      ]);

      // Assert
      expect(response1.success).toBe(true);
      expect(response2.success).toBe(true);
      expect(fileStorage.saveFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('集成流程测试', () => {
    it('应该完整测试文件的生命周期：上传 -> 打开 -> 删除', async () => {
      // Arrange
      const datasetId = 'dataset-lifecycle';
      const fileData = {
        buffer: Buffer.from('lifecycle test'),
        filename: 'lifecycle.txt',
      };
      const relativePath = 'uploads/dataset-lifecycle/lifecycle.txt';
      const fullPath = 'D:\\app\\uploads\\dataset-lifecycle\\lifecycle.txt';

      // 配置 mock
      vi.mocked(fileStorage.saveFile).mockResolvedValue({
        id: 'file-lifecycle',
        filename: fileData.filename,
        size: 14,
        createdAt: new Date().toISOString(),
      });
      vi.mocked(fileStorage.getFilePath).mockReturnValue(fullPath);
      vi.mocked(fileStorage.fileExists).mockReturnValue(true);
      vi.mocked(shell.openPath).mockResolvedValue('');
      vi.mocked(fileStorage.deleteFile).mockResolvedValue(undefined);

      handler.register();
      const uploadHandler = (ipcMain.handle as any).mock.calls[0][1];
      const openHandler = (ipcMain.handle as any).mock.calls[2][1];
      const deleteHandler = (ipcMain.handle as any).mock.calls[1][1];

      // Act & Assert: 上传文件
      const uploadResponse = await uploadHandler(null, datasetId, fileData);
      expect(uploadResponse.success).toBe(true);

      // Act & Assert: 打开文件
      const openResponse = await openHandler(null, relativePath);
      expect(openResponse.success).toBe(true);

      // Act & Assert: 删除文件
      const deleteResponse = await deleteHandler(null, relativePath);
      expect(deleteResponse.success).toBe(true);

      // 验证所有操作都被调用
      expect(fileStorage.saveFile).toHaveBeenCalledTimes(1);
      expect(shell.openPath).toHaveBeenCalledTimes(1);
      expect(fileStorage.deleteFile).toHaveBeenCalledTimes(1);
    });

    it('应该完整测试图片文件：上传 -> 获取URL -> 获取Base64 -> 删除', async () => {
      // Arrange
      const datasetId = 'dataset-image';
      const fileData = {
        buffer: Buffer.from('fake-image-data'),
        filename: 'photo.jpg',
      };
      const relativePath = 'uploads/dataset-image/photo.jpg';
      const imageUrl = 'app://local/uploads/dataset-image/photo.jpg';
      const base64Data = 'data:image/jpeg;base64,fake-data';

      // 配置 mock
      vi.mocked(fileStorage.saveFile).mockResolvedValue({
        id: 'file-image',
        filename: fileData.filename,
        size: 15,
        createdAt: new Date().toISOString(),
      });
      vi.mocked(fileStorage.getFileUrl).mockReturnValue(imageUrl);
      vi.mocked(fileStorage.getFileAsBase64).mockResolvedValue(base64Data);
      vi.mocked(fileStorage.deleteFile).mockResolvedValue(undefined);

      handler.register();
      const uploadHandler = (ipcMain.handle as any).mock.calls[0][1];
      const getUrlHandler = (ipcMain.handle as any).mock.calls[3][1];
      const getImageDataHandler = (ipcMain.handle as any).mock.calls[4][1];
      const deleteHandler = (ipcMain.handle as any).mock.calls[1][1];

      // Act & Assert: 完整流程
      const uploadResponse = await uploadHandler(null, datasetId, fileData);
      expect(uploadResponse.success).toBe(true);

      const urlResponse = await getUrlHandler(null, relativePath);
      expect(urlResponse.success).toBe(true);
      expect(urlResponse.url).toBe(imageUrl);

      const imageDataResponse = await getImageDataHandler(null, relativePath);
      expect(imageDataResponse.success).toBe(true);
      expect(imageDataResponse.data).toBe(base64Data);

      const deleteResponse = await deleteHandler(null, relativePath);
      expect(deleteResponse.success).toBe(true);
    });
  });
});
