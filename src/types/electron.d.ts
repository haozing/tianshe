/**
 * Electron API 类型声明
 * 供渲染进程和主进程共享使用。
 *
 * ElectronAPI 直接引用 preload 的真实导出类型，避免声明与实现双份维护。
 */

export type ElectronAPI = import('../preload').ElectronAPI;

export type {
  DataTableExportOptions,
  DataTableExportOutput,
  DataTableExportResult,
  ExportFormat,
  ExportMode,
  ExportOptions,
  ExportPathParams,
  ExportPathResult,
  ExportProgress,
  ExportQueryTemplate,
  ExportResult,
  PostExportAction,
} from './dataset-export';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
