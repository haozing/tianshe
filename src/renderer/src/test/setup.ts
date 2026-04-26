/**
 * Test setup for React component tests
 */
import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { vi } from 'vitest';

// Ensure tests have a writable userData dir even outside Electron main process.
// Use a repo-local, gitignored folder to avoid mutating tracked fixtures.
if (!process.env.TIANSHEAI_USER_DATA_DIR) {
  const userDataDir = path.resolve(process.cwd(), '.tmp-test-userdata-run');
  fs.mkdirSync(userDataDir, { recursive: true });
  process.env.TIANSHEAI_USER_DATA_DIR = userDataDir;
  const userDataArgPrefix = '--airpa-user-data-dir=';
  if (!process.argv.some((arg) => arg === '--airpa-user-data-dir' || arg.startsWith(userDataArgPrefix))) {
    process.argv.push(`${userDataArgPrefix}${userDataDir}`);
  }
}

// Mock Electron API for all React component tests
if (typeof window !== 'undefined') {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (typeof window.requestAnimationFrame === 'undefined') {
    window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      window.setTimeout(() => callback(Date.now()), 0);
  }
  if (typeof window.cancelAnimationFrame === 'undefined') {
    window.cancelAnimationFrame = (handle: number): void => window.clearTimeout(handle);
  }

  (window as any).electronAPI = {
    edition: {
      name: 'open',
      capabilities: {
        cloudAuth: false,
        cloudSnapshot: false,
        cloudCatalog: false,
      },
    },
    getAppInfo: vi.fn().mockResolvedValue({
      success: true,
      info: {
        isPackaged: false,
        platform: 'test',
      },
    }),
    jsPlugin: {
      onPluginStateChanged: vi.fn(() => vi.fn()),
      onPluginRuntimeStatusChanged: vi.fn(() => vi.fn()),
      onPluginNotification: vi.fn(() => vi.fn()),
      list: vi.fn().mockResolvedValue({ success: true, plugins: [] }),
      getPluginList: vi.fn().mockResolvedValue([]),
      getPluginViewInfo: vi.fn().mockResolvedValue({ success: false }),
      showPluginView: vi.fn().mockResolvedValue({ success: true }),
      hidePluginView: vi.fn().mockResolvedValue({ success: true }),
      listRuntimeStatuses: vi.fn().mockResolvedValue({ success: true, statuses: [] }),
      cancelPluginTasks: vi.fn().mockResolvedValue({ success: true, cancelled: 0 }),
    },
    view: {
      detachAll: vi.fn().mockResolvedValue({ success: true }),
      setActivityBarWidth: vi.fn().mockResolvedValue({ success: true }),
      setActivityBarCollapsed: vi.fn().mockResolvedValue({ success: true }),
    },
    datasets: {
      getAll: vi.fn().mockResolvedValue([]),
      onDatasetUpdated: vi.fn(() => vi.fn()),
    },
    automations: {
      getAll: vi.fn().mockResolvedValue([]),
    },
    account: {
      listAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      create: vi.fn().mockResolvedValue({ success: true, data: null }),
      createWithAutoProfile: vi.fn().mockResolvedValue({ success: true, data: null }),
      update: vi.fn().mockResolvedValue({ success: true, data: null }),
      delete: vi.fn().mockResolvedValue({ success: true }),
      revealSecret: vi.fn().mockResolvedValue({ success: true, data: '' }),
      login: vi.fn().mockResolvedValue({ success: true }),
    },
    savedSite: {
      list: vi.fn().mockResolvedValue({ success: true, data: [] }),
      create: vi.fn().mockResolvedValue({ success: true, data: null }),
      update: vi.fn().mockResolvedValue({ success: true, data: null }),
      delete: vi.fn().mockResolvedValue({ success: true }),
      incrementUsage: vi.fn().mockResolvedValue({ success: true }),
    },
    tag: {
      list: vi.fn().mockResolvedValue({ success: true, data: [] }),
      create: vi.fn().mockResolvedValue({ success: true, data: null }),
      update: vi.fn().mockResolvedValue({ success: true, data: null }),
      delete: vi.fn().mockResolvedValue({ success: true }),
      exists: vi.fn().mockResolvedValue({ success: true, data: false }),
    },
    profile: {
      poolListBrowsers: vi.fn().mockResolvedValue({ success: true, data: [] }),
      poolLaunch: vi.fn().mockResolvedValue({ success: true }),
      poolShowBrowser: vi.fn().mockResolvedValue({ success: true }),
      poolRelease: vi.fn().mockResolvedValue({ success: true }),
      poolDestroyProfileBrowsers: vi.fn().mockResolvedValue({ success: true }),
    },
    extensionPackages: {
      listPackages: vi.fn().mockResolvedValue({ success: true, data: [] }),
      listProfileBindings: vi.fn().mockResolvedValue({ success: true, data: [] }),
      selectLocalDirectories: vi.fn().mockResolvedValue({ success: true, paths: [] }),
      selectLocalArchives: vi.fn().mockResolvedValue({ success: true, paths: [] }),
      importLocalPackages: vi.fn().mockResolvedValue({ success: true, data: [] }),
      batchBind: vi.fn().mockResolvedValue({ success: true, data: { restartFailures: [] } }),
      batchUnbind: vi.fn().mockResolvedValue({ success: true, data: { restartFailures: [] } }),
    },
    system: {
      onNavigate: vi.fn(() => vi.fn()),
    },
    internalBrowser: {
      getDevToolsConfig: vi.fn().mockResolvedValue({
        success: true,
        config: { autoOpenDevTools: false },
      }),
      setDevToolsConfig: vi.fn().mockResolvedValue({
        success: true,
        config: { autoOpenDevTools: false },
      }),
    },
  };
}
