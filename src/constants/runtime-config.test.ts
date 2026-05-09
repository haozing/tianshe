import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalProcess = globalThis.process;

afterEach(() => {
  vi.resetModules();
  Object.defineProperty(globalThis, 'process', {
    configurable: true,
    value: originalProcess,
  });
});

describe('runtime-config', () => {
  it('imports safely without a process global', async () => {
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: undefined,
    });

    const runtimeConfig = await import('./runtime-config');

    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.app.mode).toBe('production');
    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.paths.userDataDirOverride).toBe('');
    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.paths.firefoxExecutablePathOverride).toBe('');
    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.http.port).toBe(39090);
    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.http.enableHttpOverride).toBeNull();
    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.http.enableMcpOverride).toBeNull();
    expect(runtimeConfig.isDevelopmentMode()).toBe(false);
    expect(runtimeConfig.isProductionMode()).toBe(true);
  });

  it('reads explicit MCP startup overrides from process argv', async () => {
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: {
        ...originalProcess,
        argv: [
          'node',
          'runtime-config.test.ts',
          '--airpa-enable-http',
          '--airpa-enable-mcp=false',
          '--airpa-http-port=49123',
        ],
        versions: {
          node: '20.0.0',
        },
      },
    });

    const runtimeConfig = await import('./runtime-config');

    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.http.enableHttpOverride).toBe(true);
    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.http.enableMcpOverride).toBe(false);
    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.http.port).toBe(49123);
  });

  it('reads the explicit E2E CDP port override from process argv', async () => {
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: {
        ...originalProcess,
        argv: ['node', 'runtime-config.test.ts', '--airpa-e2e-cdp-port=49333'],
        versions: {
          node: '20.0.0',
        },
      },
    });

    const runtimeConfig = await import('./runtime-config');

    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.e2e.cdpPort).toBe(49333);
  });

  it('reads the explicit no-sandbox override from process argv', async () => {
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: {
        ...originalProcess,
        argv: ['node', 'runtime-config.test.ts', '--tianshe-allow-no-sandbox'],
        versions: {
          node: '20.0.0',
        },
      },
    });

    const runtimeConfig = await import('./runtime-config');

    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.extension.allowNoSandbox).toBe(true);
  });

  it('reads path overrides from process argv', async () => {
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: {
        ...originalProcess,
        argv: [
          'node',
          'runtime-config.test.ts',
          '--airpa-user-data-dir=/tmp/airpa-user-data',
          '--airpa-asar-extract-base-dir=/tmp/airpa-asar',
          '--airpa-firefox-path=/tmp/firefox-bin',
        ],
        versions: {
          node: '20.0.0',
        },
      },
    });

    const runtimeConfig = await import('./runtime-config');

    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.paths.userDataDirOverride).toBe(
      '/tmp/airpa-user-data'
    );
    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.paths.asarExtractBaseDirOverride).toBe(
      '/tmp/airpa-asar'
    );
    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.paths.firefoxExecutablePathOverride).toBe(
      '/tmp/firefox-bin'
    );
    expect(runtimeConfig.resolveFirefoxExecutablePathOverride()).toBe('/tmp/firefox-bin');
  });

  it('detects packaged worker mode from resourcesPath app.asar', async () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-config-resources-'));
    fs.writeFileSync(path.join(resourcesPath, 'app.asar'), '');

    try {
      Object.defineProperty(globalThis, 'process', {
        configurable: true,
        value: {
          ...originalProcess,
          argv: ['node', 'runtime-config.test.ts'],
          versions: {
            ...originalProcess.versions,
            electron: '35.7.5',
            node: '20.0.0',
          },
          resourcesPath,
          type: 'worker',
        },
      });

      const runtimeConfig = await import('./runtime-config');

      expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.app.mode).toBe('production');
      expect(runtimeConfig.isProductionMode()).toBe(true);
      expect(runtimeConfig.isDevelopmentMode()).toBe(false);
    } finally {
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    }
  });
});
