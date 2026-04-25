/**
 * @deprecated This file is outdated. Type declarations are now in src/renderer/src/global.d.ts
 * The correct API is exposed as window.electronAPI, not window.electron
 */
import type { ElectronAPI } from '../preload/index';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
