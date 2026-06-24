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
          '--airpa-chrome-path=/tmp/chrome-bin',
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
    expect(runtimeConfig.resolveChromeExecutablePathOverride()).toBe('/tmp/chrome-bin');
  });

  it('builds runtime config from explicit argv without reloading the module', async () => {
    const runtimeConfig = await import('./runtime-config');

    const first = runtimeConfig.createRuntimeConfig([
      'node',
      'runtime-config.test.ts',
      '--airpa-enable-http=false',
      '--airpa-http-port=49124',
      '--airpa-firefox-path=/tmp/firefox-one',
    ]);
    const second = runtimeConfig.createRuntimeConfig([
      'node',
      'runtime-config.test.ts',
      '--airpa-enable-http=true',
      '--airpa-http-port=49125',
      '--airpa-firefox-path=/tmp/firefox-two',
    ]);

    expect(first.http.enableHttpOverride).toBe(false);
    expect(first.http.port).toBe(49124);
    expect(runtimeConfig.resolveFirefoxExecutablePathOverride(first)).toBe('/tmp/firefox-one');
    expect(second.http.enableHttpOverride).toBe(true);
    expect(second.http.port).toBe(49125);
    expect(runtimeConfig.resolveFirefoxExecutablePathOverride(second)).toBe('/tmp/firefox-two');
    expect(runtimeConfig.AIRPA_RUNTIME_CONFIG.http.port).not.toBe(49125);
  });

  it('reads Repair Studio model provider config from env and argv', async () => {
    const runtimeConfig = await import('./runtime-config');

    const fromEnv = runtimeConfig.createRuntimeConfig(
      ['node', 'runtime-config.test.ts'],
      {
        TIANSHE_REPAIR_MODEL_PROVIDER: 'openai',
        TIANSHE_REPAIR_MODEL_API_KEY: 'test-key',
        TIANSHE_REPAIR_MODEL: 'repair-model',
      },
      {
        argv: ['node', 'runtime-config.test.ts'],
        versions: { node: '20.0.0' },
      }
    );
    const fromArgv = runtimeConfig.createRuntimeConfig(
      [
        'node',
        'runtime-config.test.ts',
        '--tianshe-repair-model-provider=openai-compatible',
        '--tianshe-repair-model-base-url=https://models.example.test/v1',
        '--tianshe-repair-model-api-key=argv-key',
        '--tianshe-repair-model=argv-model',
        '--tianshe-repair-model-timeout-ms=12345',
      ],
      {},
      {
        argv: ['node', 'runtime-config.test.ts'],
        versions: { node: '20.0.0' },
      }
    );

    expect(fromEnv.repairStudio.modelProvider).toEqual({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'repair-model',
      timeoutMs: 60000,
    });
    expect(fromArgv.repairStudio.modelProvider).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.test/v1',
      apiKey: 'argv-key',
      model: 'argv-model',
      timeoutMs: 12345,
    });
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
