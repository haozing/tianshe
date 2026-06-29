import { BrowserWindow, dialog, shell } from 'electron';
import type { BrowserRuntimeManager, BrowserRuntimeStatus } from '../../core/browser-runtime';
import {
  getDefaultRuntimeSource,
  isBrowserRuntimeId,
  type BrowserRuntimeId,
  type BrowserRuntimeSource,
} from '../../types/browser-runtime';
import { createIpcHandler, IpcError, type IpcSenderGuard } from './utils';

export interface RegisterBrowserRuntimeHandlersOptions {
  senderGuard?: IpcSenderGuard;
}

function assertRuntimeId(runtimeId: BrowserRuntimeId): BrowserRuntimeId {
  if (!isBrowserRuntimeId(runtimeId)) {
    throw IpcError.invalidInput('runtimeId', 'Unsupported browser runtime');
  }
  return runtimeId;
}

function canUseCustomPath(runtimeId: BrowserRuntimeId): boolean {
  return runtimeId !== 'electron-webcontents';
}

function canInstallManaged(runtimeId: BrowserRuntimeId): boolean {
  return runtimeId === 'chromium-cloak-playwright';
}

function getRuntimeDownloadUrl(runtimeId: BrowserRuntimeId): string {
  switch (runtimeId) {
    case 'firefox-bidi':
      return 'https://www.mozilla.org/firefox/new/';
    case 'chromium-cloak-playwright':
      return 'https://github.com/CloakHQ/CloakBrowser';
    case 'chromium-extension-relay':
      return 'https://www.google.com/chrome/';
    case 'electron-webcontents':
      return 'https://www.electronjs.org/';
  }
}

function buildCustomPathSource(
  runtimeId: BrowserRuntimeId,
  executablePath: string
): BrowserRuntimeSource {
  if (!canUseCustomPath(runtimeId)) {
    throw IpcError.invalidInput('runtimeId', 'Electron WebContents does not support custom binary');
  }
  const normalizedPath = String(executablePath || '').trim();
  if (!normalizedPath) {
    throw IpcError.invalidInput('executablePath', 'Executable path is required');
  }
  return { type: 'custom-path', executablePath: normalizedPath };
}

async function selectExecutablePath(runtimeId: BrowserRuntimeId): Promise<{
  canceled: boolean;
  path?: string;
}> {
  const owner = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const isWindows = process.platform === 'win32';
  const filters = [
    runtimeId === 'firefox-bidi'
      ? { name: 'Firefox', extensions: isWindows ? ['exe'] : ['*'] }
      : runtimeId === 'chromium-cloak-playwright'
        ? { name: 'Cloak / Chromium', extensions: isWindows ? ['exe'] : ['*'] }
        : { name: 'Chromium Browser', extensions: isWindows ? ['exe'] : ['*'] },
    { name: 'All Files', extensions: ['*'] },
  ];
  const options = {
    title: '选择浏览器可执行文件',
    properties: ['openFile'] as Electron.OpenDialogOptions['properties'],
    filters,
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  return {
    canceled: result.canceled,
    path: result.canceled ? undefined : result.filePaths[0],
  };
}

export function registerBrowserRuntimeHandlers(
  getRuntimeManager: () => BrowserRuntimeManager,
  options: RegisterBrowserRuntimeHandlersOptions = {}
): void {
  createIpcHandler(
    'browser-runtime:list-statuses',
    async (): Promise<BrowserRuntimeStatus[]> => getRuntimeManager().listRuntimeStatuses(),
    {
      errorMessage: '获取浏览器运行时状态失败',
      senderGuard: options.senderGuard,
    }
  );

  createIpcHandler(
    'browser-runtime:get-status',
    async (runtimeId: BrowserRuntimeId): Promise<BrowserRuntimeStatus> => {
      return getRuntimeManager().getRuntimeStatus(assertRuntimeId(runtimeId));
    },
    {
      errorMessage: '获取浏览器运行时详情失败',
      senderGuard: options.senderGuard,
    }
  );

  createIpcHandler(
    'browser-runtime:select-executable',
    async (runtimeId: BrowserRuntimeId): Promise<{ canceled: boolean; path?: string }> => {
      return selectExecutablePath(assertRuntimeId(runtimeId));
    },
    {
      errorMessage: '选择浏览器可执行文件失败',
      senderGuard: options.senderGuard,
    }
  );

  createIpcHandler(
    'browser-runtime:set-custom-path',
    async (
      runtimeId: BrowserRuntimeId,
      executablePath: string
    ): Promise<BrowserRuntimeStatus> => {
      const id = assertRuntimeId(runtimeId);
      const manager = getRuntimeManager();
      const source = buildCustomPathSource(id, executablePath);
      const probeStatus = await manager.getRuntimeStatus(id, source);
      if (!probeStatus.installed || !probeStatus.healthy) {
        return probeStatus;
      }
      manager.setSourceOverride(id, source);
      return manager.getRuntimeStatus(id);
    },
    {
      errorMessage: '保存浏览器运行时路径失败',
      senderGuard: options.senderGuard,
    }
  );

  createIpcHandler(
    'browser-runtime:set-default-source',
    async (runtimeId: BrowserRuntimeId): Promise<BrowserRuntimeStatus> => {
      const id = assertRuntimeId(runtimeId);
      const manager = getRuntimeManager();
      manager.clearSourceOverride(id);
      return manager.getRuntimeStatus(id);
    },
    {
      errorMessage: '恢复默认浏览器运行时来源失败',
      senderGuard: options.senderGuard,
    }
  );

  createIpcHandler(
    'browser-runtime:install-managed',
    async (runtimeId: BrowserRuntimeId): Promise<BrowserRuntimeStatus> => {
      const id = assertRuntimeId(runtimeId);
      if (!canInstallManaged(id)) {
        throw IpcError.invalidInput(
          'runtimeId',
          `Managed install is not available for ${runtimeId}`
        );
      }
      return getRuntimeManager().installRuntime(id);
    },
    {
      errorMessage: '安装浏览器运行时失败',
      senderGuard: options.senderGuard,
    }
  );

  createIpcHandler(
    'browser-runtime:open-download-page',
    async (runtimeId: BrowserRuntimeId): Promise<{ url: string }> => {
      const id = assertRuntimeId(runtimeId);
      const url = getRuntimeDownloadUrl(id);
      await shell.openExternal(url);
      return { url };
    },
    {
      errorMessage: '打开浏览器下载页面失败',
      senderGuard: options.senderGuard,
    }
  );

  createIpcHandler(
    'browser-runtime:get-default-source',
    async (runtimeId: BrowserRuntimeId): Promise<BrowserRuntimeSource> => {
      return getDefaultRuntimeSource(assertRuntimeId(runtimeId));
    },
    {
      errorMessage: '获取默认浏览器运行时来源失败',
      senderGuard: options.senderGuard,
    }
  );
}
