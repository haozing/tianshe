/**
 * Preload 安全桥接
 * 负责：
 * - 使用 contextBridge 暴露安全的 API
 * - 连接主进程和渲染进程
 * - 类型安全的 IPC 通信
 */

import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron';
import { resolveTiansheEditionPreloadInfo } from '../edition/preload';
import type { DownloadInfo } from '../main/download';
import { createAccountAPI } from './api/account';
import { createBrowserRuntimeAPI } from './api/browser-runtime';
import { createCloudAPI } from './api/cloud';
import { createDuckDBAPI } from './api/duckdb';
import { createExtensionPackagesAPI } from './api/extension-packages';
import { createFileAPI } from './api/file';
import { createFolderAPI } from './api/folder';
import { createPluginAPI } from './api/js-plugin';
import { createProfileAPI } from './api/profile';
import { createQueryTemplateAPI } from './api/query-template';
import { createRuntimeAPI } from './api/runtime';
import { createSavedSiteAPI } from './api/saved-site';
import { createSiteAdapterLabAPI } from './api/site-adapter-lab';
import { createSiteAdapterRepairStudioAPI } from './api/site-adapter-repair-studio';
import { createSystemAPI } from './api/system';
import { createTagAPI } from './api/tag';
import { createViewAPI } from './api/view';

const tiansheEdition = resolveTiansheEditionPreloadInfo();

const allowedPreloadEventChannels = [
  'cloud-auth:session-changed',
  'dataset:schema-updated',
  'download:started',
  'download:progress',
  'download:completed',
  'download:cancelled',
  'download:interrupted',
  'duckdb:export-progress',
  'duckdb:import-progress',
  'duckdb:import-records-progress',
  'js-plugin:notification',
  'js-plugin:reloaded',
  'js-plugin:runtime-status-changed',
  'js-plugin:state-changed',
  'plugin:view-created',
  'plugin:view-closed',
  'updater:available',
  'updater:checking',
  'updater:download-progress',
  'updater:downloaded',
  'updater:error',
  'updater:not-available',
] as const;

type PreloadEventChannel = (typeof allowedPreloadEventChannels)[number];

const allowedPreloadEventChannelSet = new Set<string>(allowedPreloadEventChannels);

function assertAllowedPreloadEventChannel(channel: string): asserts channel is PreloadEventChannel {
  if (!allowedPreloadEventChannelSet.has(channel)) {
    throw new Error(`Unsupported preload event channel: ${channel}`);
  }
}

/**
 * 暴露给渲染进程的 API
 */
const electronAPI = {
  edition: tiansheEdition,

  files: {
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  },

  ...createSystemAPI(ipcRenderer),

  duckdb: createDuckDBAPI(ipcRenderer),

  queryTemplate: createQueryTemplateAPI(ipcRenderer),
  file: createFileAPI(ipcRenderer),
  folder: createFolderAPI(ipcRenderer),

  ...createViewAPI(ipcRenderer),

  ...createPluginAPI(ipcRenderer),

  // ========== 事件监听 ==========

  /**
   * 监听下载事件
   */
  onDownloadEvent: (
    channel:
      | 'download:started'
      | 'download:progress'
      | 'download:completed'
      | 'download:cancelled'
      | 'download:interrupted',
    callback: (info: DownloadInfo) => void
  ) => {
    const subscription = (_event: IpcRendererEvent, info: DownloadInfo) => callback(info);
    ipcRenderer.on(channel, subscription);

    // 返回取消订阅函数
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },

  /**
   * 通用事件监听
   */
  on: (channel: PreloadEventChannel, callback: (...args: any[]) => void) => {
    assertAllowedPreloadEventChannel(channel);
    const subscription = (_event: IpcRendererEvent, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, subscription);

    // 返回取消订阅函数
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },

  /**
   * 移除事件监听
   */
  removeListener: (channel: PreloadEventChannel, callback: (...args: any[]) => void) => {
    assertAllowedPreloadEventChannel(channel);
    ipcRenderer.removeListener(channel, callback);
  },

  ...createRuntimeAPI(ipcRenderer),

  browserRuntime: createBrowserRuntimeAPI(ipcRenderer),

  ...createCloudAPI(ipcRenderer),

  ...createProfileAPI(ipcRenderer),

  extensionPackages: createExtensionPackagesAPI(ipcRenderer),

  account: createAccountAPI(ipcRenderer),

  savedSite: createSavedSiteAPI(ipcRenderer),

  siteAdapterLab: createSiteAdapterLabAPI(ipcRenderer),
  siteAdapterRepairStudio: createSiteAdapterRepairStudioAPI(ipcRenderer),

  tag: createTagAPI(ipcRenderer),
};

type PreloadElectronAPI = typeof electronAPI;

function buildExposedElectronAPI(): PreloadElectronAPI {
  const exposed = electronAPI as unknown as Omit<
    PreloadElectronAPI,
    'cloudAuth' | 'cloudSnapshot' | 'cloudPlugin' | 'cloudBrowserExtension'
  > & {
    cloudAuth?: unknown;
    cloudSnapshot?: unknown;
    cloudPlugin?: unknown;
    cloudBrowserExtension?: unknown;
    extensionPackages: Omit<
      PreloadElectronAPI['extensionPackages'],
      'downloadCloudCatalogPackages'
    > & {
      downloadCloudCatalogPackages?: unknown;
    };
  };

  if (tiansheEdition.name === 'open') {
    delete exposed.cloudAuth;
    delete exposed.cloudSnapshot;
    delete exposed.cloudPlugin;
    delete exposed.cloudBrowserExtension;
    const extensionPackages = exposed.extensionPackages as {
      downloadCloudCatalogPackages?: unknown;
    };
    delete extensionPackages.downloadCloudCatalogPackages;
  }

  return exposed as PreloadElectronAPI;
}

// 暴露 API 到渲染进程
contextBridge.exposeInMainWorld('electronAPI', buildExposedElectronAPI());

// 类型声明（供 TypeScript 使用）
export type ElectronAPI = PreloadElectronAPI;

// 注意：Window.electronAPI 的类型声明在 src/types/electron.d.ts 中
// 这里不需要重复声明，避免类型冲突
