/**
 * OCRPoolIPCHandler - OCR pool settings handler
 * Responsible for reading and updating global OCR pool configuration.
 */

import { IpcMainInvokeEvent } from 'electron';
import type Store from 'electron-store';
import { handleIPCError } from '../ipc-utils';
import type { IpcRouteDefinition } from '../ipc-route-registry';
import { ipcRouteRegistry } from '../ipc-route-registry';
import {
  DEFAULT_OCR_POOL_CONFIG,
  normalizeOcrPoolConfig,
  type OCRPoolConfig,
} from '../../constants/ocr-pool';
import { setOcrPoolConfig } from '../../core/system-automation/ocr';

export function createOcrPoolRoutes(store: Store): IpcRouteDefinition[] {
  return [
    {
      channel: 'ocr-pool:get-config',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent) => {
        try {
          const saved = store.get('ocrPoolConfig', DEFAULT_OCR_POOL_CONFIG) as OCRPoolConfig;
          const config = normalizeOcrPoolConfig(saved);
          return { success: true, config };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'ocr-pool:set-config',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, config: OCRPoolConfig) => {
        try {
          const normalized = normalizeOcrPoolConfig(config);
          const current = store.get('ocrPoolConfig', DEFAULT_OCR_POOL_CONFIG) as OCRPoolConfig;

          store.set('ocrPoolConfig', normalized);

          const changed =
            normalized.size !== current.size ||
            normalized.maxQueue !== current.maxQueue ||
            normalized.queueMode !== current.queueMode;

          await setOcrPoolConfig(normalized, { reset: changed });

          return { success: true, config: normalized };
        } catch (error: unknown) {
          return handleIPCError(error);
        }
      },
    },
  ];
}

/** @deprecated 使用 createOcrPoolRoutes + ipcRouteRegistry.registerAll */
export class OCRPoolIPCHandler {
  constructor(private store: Store) {}

  register(): void {
    ipcRouteRegistry.registerAll(createOcrPoolRoutes(this.store));
    console.log('  [OK] OCRPoolIPCHandler registered');
  }
}
