import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserRuntimeProvider } from './types';
import { BrowserRuntimeRegistry } from './provider-registry';
import {
  BrowserRuntimeManager,
  InMemoryBrowserRuntimeStore,
} from './runtime-manager';
import { getStaticRuntimeDescriptor } from '../browser-pool/runtime-capability-registry';

function createProvider(): BrowserRuntimeProvider {
  return {
    id: 'chromium-cloak-playwright',
    descriptor: getStaticRuntimeDescriptor('chromium-cloak-playwright'),
    resolveRuntime: vi.fn(async (input) => ({
      runtimeId: 'chromium-cloak-playwright',
      source: input.sourceOverride ?? { type: 'managed-download', channel: 'cloakbrowser' },
      executablePath:
        input.sourceOverride?.type === 'custom-path'
          ? input.sourceOverride.executablePath
          : 'C:\\cloak\\chrome.exe',
      version: '146.0.0',
    })),
    probeRuntime: vi.fn(async (runtime) => ({
      healthy: true,
      executablePath: runtime.executablePath,
      version: runtime.version,
      errors: [],
      warnings: [],
      capabilities: {
        'download.manage': true,
      },
    })),
    installRuntime: vi.fn(async (input) => ({
      runtimeId: 'chromium-cloak-playwright',
      source: input.sourceOverride ?? { type: 'managed-download', channel: 'cloakbrowser' },
      executablePath: 'C:\\cloak\\chrome.exe',
      version: '146.0.0',
    })),
    create: vi.fn(),
  };
}

describe('BrowserRuntimeManager', () => {
  let provider: BrowserRuntimeProvider;
  let store: InMemoryBrowserRuntimeStore;
  let manager: BrowserRuntimeManager;
  let tempDirs: string[];

  beforeEach(() => {
    tempDirs = [];
    provider = createProvider();
    const registry = new BrowserRuntimeRegistry();
    registry.register(provider);
    store = new InMemoryBrowserRuntimeStore();
    manager = new BrowserRuntimeManager(registry, store);
  });

  afterEach(() => {
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses persisted source overrides when probing status', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-runtime-manager-'));
    tempDirs.push(tempDir);
    const executablePath = path.join(tempDir, 'cloak.exe');
    fs.writeFileSync(executablePath, '');

    manager.setSourceOverride('chromium-cloak-playwright', {
      type: 'custom-path',
      executablePath,
    });

    const status = await manager.getRuntimeStatus('chromium-cloak-playwright');

    expect(provider.resolveRuntime).toHaveBeenCalledWith({
      runtimeId: 'chromium-cloak-playwright',
      sourceOverride: {
        type: 'custom-path',
        executablePath,
      },
    });
    expect(status.configuredSourceOverride).toEqual({
      type: 'custom-path',
      executablePath,
    });
    expect(store.getSnapshot().probes['chromium-cloak-playwright']?.status.healthy).toBe(true);
  });

  it('installs managed runtime through the provider and returns fresh status', async () => {
    const status = await manager.installRuntime('chromium-cloak-playwright');

    expect(provider.installRuntime).toHaveBeenCalledWith({
      runtimeId: 'chromium-cloak-playwright',
      sourceOverride: null,
    });
    expect(status.healthy).toBe(true);
    expect(status.installState).toBe('managed-installed');
  });
});
