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
}

// Mock Electron API for all React component tests
if (typeof window !== 'undefined') {
  (window as any).electronAPI = {
    jsPlugin: {
      onPluginStateChanged: vi.fn(() => vi.fn()),
      onPluginRuntimeStatusChanged: vi.fn(() => vi.fn()),
      getPluginList: vi.fn().mockResolvedValue([]),
      listRuntimeStatuses: vi.fn().mockResolvedValue({ success: true, statuses: [] }),
      cancelPluginTasks: vi.fn().mockResolvedValue({ success: true, cancelled: 0 }),
    },
    datasets: {
      getAll: vi.fn().mockResolvedValue([]),
      onDatasetUpdated: vi.fn(() => vi.fn()),
    },
    automations: {
      getAll: vi.fn().mockResolvedValue([]),
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
