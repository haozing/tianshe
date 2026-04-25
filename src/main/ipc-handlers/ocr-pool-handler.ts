/**
 * OCRPoolIPCHandler - OCR pool settings handler
 * Responsible for reading and updating global OCR pool configuration.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import type Store from 'electron-store';
import { handleIPCError } from '../ipc-utils';
import {
  DEFAULT_OCR_POOL_CONFIG,
  normalizeOcrPoolConfig,
  type OCRPoolConfig,
} from '../../constants/ocr-pool';
import { setOcrPoolConfig } from '../../core/system-automation/ocr';

export class OCRPoolIPCHandler {
  constructor(private store: Store) {}

  register(): void {
    this.registerGetConfig();
    this.registerSetConfig();

    console.log('  [OK] OCRPoolIPCHandler registered');
  }

  private registerGetConfig(): void {
    ipcMain.handle('ocr-pool:get-config', async (_event: IpcMainInvokeEvent) => {
      try {
        const saved = this.store.get('ocrPoolConfig', DEFAULT_OCR_POOL_CONFIG) as OCRPoolConfig;
        const config = normalizeOcrPoolConfig(saved);
        return { success: true, config };
      } catch (error: unknown) {
        return handleIPCError(error);
      }
    });
  }

  private registerSetConfig(): void {
    ipcMain.handle(
      'ocr-pool:set-config',
      async (_event: IpcMainInvokeEvent, config: OCRPoolConfig) => {
        try {
          const normalized = normalizeOcrPoolConfig(config);
          const current = this.store.get('ocrPoolConfig', DEFAULT_OCR_POOL_CONFIG) as OCRPoolConfig;

          this.store.set('ocrPoolConfig', normalized);

          const changed =
            normalized.size !== current.size ||
            normalized.maxQueue !== current.maxQueue ||
            normalized.queueMode !== current.queueMode;

          await setOcrPoolConfig(normalized, { reset: changed });

          return { success: true, config: normalized };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      }
    );
  }
}
