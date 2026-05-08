/**
 * 文件 IPC 处理器
 * 负责处理附件文件的上传、删除、打开等操作
 */

import { shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { fileStorage } from '../file-storage';
import { handleIPCError } from '../ipc-utils';
import { assertMainWindowIpcSender } from '../ipc-authorization';
import type { IpcRouteDefinition } from '../ipc-route-registry';
import { ipcRouteRegistry } from '../ipc-route-registry';

export class FileIPCHandler {
  constructor(private readonly mainWindow?: BrowserWindow) {}

  private assertSender(event: IpcMainInvokeEvent, channel: string): void {
    if (!this.mainWindow) return;
    assertMainWindowIpcSender(event, this.mainWindow, channel);
  }

  private createRoutes(): IpcRouteDefinition[] {
    return [
      {
        channel: 'file:upload',
        kind: 'handle',
        permission: 'privileged',
        schema: {
          description: 'Upload an attachment from renderer-provided file bytes.',
          args: [
            { name: 'datasetId', type: 'string', required: true },
            { name: 'fileData', type: 'object', required: true },
          ],
          result: { success: 'boolean', metadata: 'AttachmentMetadata?', error: 'string?' },
        },
        handler: async (
          event: IpcMainInvokeEvent,
          datasetId: string,
          fileData: { buffer: Buffer; filename: string }
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
        },
      },
      {
        channel: 'file:delete',
        kind: 'handle',
        permission: 'privileged',
        schema: {
          description: 'Delete an attachment by storage-relative path.',
          args: [{ name: 'relativePath', type: 'string', required: true }],
          result: { success: 'boolean', error: 'string?' },
        },
        handler: async (event: IpcMainInvokeEvent, relativePath: string) => {
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
        },
      },
      {
        channel: 'file:open',
        kind: 'handle',
        permission: 'privileged',
        schema: {
          description: 'Open an attachment path through the operating system shell.',
          args: [{ name: 'relativePath', type: 'string', required: true }],
          result: { success: 'boolean', error: 'string?' },
        },
        handler: async (event: IpcMainInvokeEvent, relativePath: string) => {
          try {
            this.assertSender(event, 'file:open');
            console.log(`[FileIPCHandler] Opening file: ${relativePath}`);

            const fullPath = fileStorage.getFilePath(relativePath);

            if (!fileStorage.fileExists(relativePath)) {
              throw new Error('文件不存在');
            }

            await shell.openPath(fullPath);

            return {
              success: true,
            };
          } catch (error: unknown) {
            console.error('[FileIPCHandler] Open failed:', error);
            return handleIPCError(error);
          }
        },
      },
      {
        channel: 'file:getUrl',
        kind: 'handle',
        permission: 'trusted-renderer',
        handler: async (event: IpcMainInvokeEvent, relativePath: string) => {
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
        },
      },
      {
        channel: 'file:getImageData',
        kind: 'handle',
        permission: 'privileged',
        schema: {
          description: 'Read an attachment as Base64 image data.',
          args: [{ name: 'relativePath', type: 'string', required: true }],
          result: { success: 'boolean', data: 'string?', error: 'string?' },
        },
        handler: async (event: IpcMainInvokeEvent, relativePath: string) => {
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
        },
      },
      {
        channel: 'file:deleteDatasetFiles',
        kind: 'handle',
        permission: 'privileged',
        schema: {
          description: 'Delete all attachment files associated with a dataset.',
          args: [{ name: 'datasetId', type: 'string', required: true }],
          result: { success: 'boolean', error: 'string?' },
        },
        handler: async (event: IpcMainInvokeEvent, datasetId: string) => {
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
        },
      },
      {
        channel: 'file:upload-from-path',
        kind: 'handle',
        permission: 'privileged',
        schema: {
          description:
            'Upload an attachment by copying a trusted local file path in the main process.',
          args: [
            { name: 'datasetId', type: 'string', required: true },
            { name: 'fileData', type: 'object', required: true },
          ],
          result: {
            success: 'boolean',
            metadata: 'AttachmentMetadata?',
            error: 'string?',
          },
        },
        handler: async (
          event: IpcMainInvokeEvent,
          datasetId: string,
          fileData: { filePath: string; filename?: string }
        ) => {
          try {
            this.assertSender(event, 'file:upload-from-path');
            const metadata = await fileStorage.saveFileFromPath(
              datasetId,
              fileData.filePath,
              fileData.filename
            );

            return {
              success: true,
              metadata,
            };
          } catch (error: unknown) {
            console.error('[FileIPCHandler] Upload from path failed:', error);
            return handleIPCError(error);
          }
        },
      },
    ];
  }

  register(): void {
    ipcRouteRegistry.registerAll(this.createRoutes());
    console.log('✅ File IPC handlers registered');
  }
}
