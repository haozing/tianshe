/**
 * 文件 IPC 处理器
 * 负责处理附件文件的上传、删除、打开等操作
 */

import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { fileStorage } from '../file-storage';
import { handleIPCError } from '../ipc-utils';
import { assertMainWindowIpcSender } from '../ipc-authorization';

export class FileIPCHandler {
  constructor(private readonly mainWindow?: BrowserWindow) {}

  private assertSender(event: IpcMainInvokeEvent, channel: string): void {
    if (!this.mainWindow) return;
    assertMainWindowIpcSender(event, this.mainWindow, channel);
  }

  register(): void {
    // 文件上传
    ipcMain.handle(
      'file:upload',
      async (
        event,
        datasetId: string,
        fileData: {
          buffer: Buffer;
          filename: string;
        }
      ) => {
        try {
          this.assertSender(event, 'file:upload');
          console.log(
            `[FileIPCHandler] Uploading file: ${fileData.filename} for dataset: ${datasetId}`
          );

          const buffer = Buffer.from(fileData.buffer);
          const metadata = await fileStorage.saveFile(datasetId, buffer, fileData.filename);

          return {
            success: true,
            metadata,
          };
        } catch (error: unknown) {
          console.error('[FileIPCHandler] Upload failed:', error);
          return handleIPCError(error);
        }
      }
    );

    // 文件删除
    ipcMain.handle('file:delete', async (event, relativePath: string) => {
      try {
        this.assertSender(event, 'file:delete');
        console.log(`[FileIPCHandler] Deleting file: ${relativePath}`);

        await fileStorage.deleteFile(relativePath);

        return {
          success: true,
        };
      } catch (error: unknown) {
        console.error('[FileIPCHandler] Delete failed:', error);
        return handleIPCError(error);
      }
    });

    // 打开文件（使用系统默认程序）
    ipcMain.handle('file:open', async (event, relativePath: string) => {
      try {
        this.assertSender(event, 'file:open');
        console.log(`[FileIPCHandler] Opening file: ${relativePath}`);

        const fullPath = fileStorage.getFilePath(relativePath);

        if (!fileStorage.fileExists(relativePath)) {
          throw new Error('文件不存在');
        }

        // 使用系统默认程序打开文件
        await shell.openPath(fullPath);

        return {
          success: true,
        };
      } catch (error: unknown) {
        console.error('[FileIPCHandler] Open failed:', error);
        return handleIPCError(error);
      }
    });

    // 获取文件URL
    ipcMain.handle('file:getUrl', async (event, relativePath: string) => {
      try {
        this.assertSender(event, 'file:getUrl');
        const url = fileStorage.getFileUrl(relativePath);

        return {
          success: true,
          url,
        };
      } catch (error: unknown) {
        console.error('[FileIPCHandler] Get URL failed:', error);
        return handleIPCError(error);
      }
    });

    // 获取图片的 Base64 数据（用于渲染进程显示）
    ipcMain.handle('file:getImageData', async (event, relativePath: string) => {
      try {
        this.assertSender(event, 'file:getImageData');
        const imageData = await fileStorage.getFileAsBase64(relativePath);

        return {
          success: true,
          data: imageData,
        };
      } catch (error: unknown) {
        console.error('[FileIPCHandler] Get image data failed:', error);
        return handleIPCError(error);
      }
    });

    // 删除数据集的所有文件
    ipcMain.handle('file:deleteDatasetFiles', async (event, datasetId: string) => {
      try {
        this.assertSender(event, 'file:deleteDatasetFiles');
        console.log(`[FileIPCHandler] Deleting all files for dataset: ${datasetId}`);

        await fileStorage.deleteDatasetFiles(datasetId);

        return {
          success: true,
        };
      } catch (error: unknown) {
        console.error('[FileIPCHandler] Delete dataset files failed:', error);
        return handleIPCError(error);
      }
    });

    console.log('✅ File IPC handlers registered');
  }
}
