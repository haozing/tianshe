/**
 * 文件 IPC 处理器
 * 负责处理附件文件的上传、删除、打开等操作
 */

import { ipcMain, shell } from 'electron';
import { fileStorage } from '../file-storage';
import { handleIPCError } from '../ipc-utils';

export class FileIPCHandler {
  register(): void {
    // 文件上传
    ipcMain.handle(
      'file:upload',
      async (
        _event,
        datasetId: string,
        fileData: {
          buffer: Buffer;
          filename: string;
        }
      ) => {
        try {
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
    ipcMain.handle('file:delete', async (_event, relativePath: string) => {
      try {
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
    ipcMain.handle('file:open', async (_event, relativePath: string) => {
      try {
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
    ipcMain.handle('file:getUrl', async (_event, relativePath: string) => {
      try {
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
    ipcMain.handle('file:getImageData', async (_event, relativePath: string) => {
      try {
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
    ipcMain.handle('file:deleteDatasetFiles', async (_event, datasetId: string) => {
      try {
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
