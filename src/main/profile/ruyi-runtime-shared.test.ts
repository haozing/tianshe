import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '../../core/browser-pool/types';
import {
  getDefaultFingerprint,
  mergeFingerprintConfig,
} from '../../constants/fingerprint-defaults';

const electronState = vi.hoisted(() => ({
  userDataDir: '',
  appPath: process.cwd(),
  isPackaged: false,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataDir),
    getAppPath: vi.fn(() => electronState.appPath),
    get isPackaged() {
      return electronState.isPackaged;
    },
  },
}));

import {
  buildRuyiFirefoxLaunchArgs,
  prepareRuyiFirefoxLaunch,
  resolveFirefoxExecutablePath,
} from './ruyi-runtime-shared';

function createSession(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    id: 'ruyi-firefox-session',
    partition: 'persist:ruyi-firefox-session',
    engine: 'ruyi',
    fingerprint: getDefaultFingerprint('ruyi'),
    proxy: null,
    quota: 1,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 60_000,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    ...overrides,
  };
}

describe('prepareRuyiFirefoxLaunch', () => {
  let tempRoot: string;
  let previousArgv: string[];
  let previousResourcesPathDescriptor: PropertyDescriptor | undefined;
  let firefoxExecutablePath: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-ruyi-firefox-test-'));
    electronState.userDataDir = tempRoot;
    electronState.appPath = tempRoot;
    electronState.isPackaged = false;

    previousResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: path.join(tempRoot, 'resources'),
    });

    previousArgv = [...process.argv];
    firefoxExecutablePath = path.join(tempRoot, 'firefox.exe');
    const baseArgv = previousArgv.filter(
      (arg) => arg !== '--airpa-user-data-dir' && !arg.startsWith('--airpa-user-data-dir=')
    );
    Object.defineProperty(process, 'argv', {
      configurable: true,
      value: [
        ...baseArgv,
        `--airpa-user-data-dir=${tempRoot}`,
        `--airpa-firefox-path=${firefoxExecutablePath}`,
      ],
    });
    await fsp.writeFile(firefoxExecutablePath, '', 'utf8');
  });

  afterEach(async () => {
    Object.defineProperty(process, 'argv', {
      configurable: true,
      value: previousArgv,
    });
    if (previousResourcesPathDescriptor) {
      Object.defineProperty(process, 'resourcesPath', previousResourcesPathDescriptor);
    } else {
      delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    }

    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('prepares native firefox launch assets for generated mode', () => {
    const prepared = prepareRuyiFirefoxLaunch(
      createSession({
        proxy: {
          type: 'http',
          host: '127.0.0.1',
          port: 8080,
          username: 'alice',
          password: 'secret',
        },
        fingerprint: mergeFingerprintConfig(getDefaultFingerprint('ruyi'), {
          identity: {
            region: {
              timezone: 'Asia/Hong_Kong',
            },
          },
          source: {
            mode: 'generated',
            fileFormat: 'txt',
          },
        }),
      })
    );

    expect(prepared.browserPath).toBe(firefoxExecutablePath);
    expect(prepared.proxyUrl).toBe('http://127.0.0.1:8080');
    expect(Object.prototype.hasOwnProperty.call(prepared, 'pythonExecutable')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(prepared, 'bridgeScriptPath')).toBe(false);
    expect(prepared.userDataDir).toBe(path.join(tempRoot, 'firefox', 'profiles', 'ruyi-firefox-session'));
    expect(prepared.runtimeDir).toBe(path.join(tempRoot, 'firefox', 'runtime', 'ruyi-firefox-session'));
    expect(prepared.downloadDir).toBe(
      path.join(tempRoot, 'firefox', 'runtime', 'ruyi-firefox-session', 'downloads')
    );

    expect(fs.existsSync(prepared.userDataDir)).toBe(true);
    expect(fs.existsSync(prepared.downloadDir)).toBe(true);
    expect(prepared.fpfilePath).toBeTruthy();
    expect(fs.existsSync(prepared.fpfilePath!)).toBe(true);

    const fpfileContent = fs.readFileSync(prepared.fpfilePath!, 'utf8');
    expect(fpfileContent).toContain('useragent:');
    expect(fpfileContent).toContain('timezone:Asia/Hong_Kong');
    expect(fpfileContent).toContain('httpauth.username:alice');
    expect(fpfileContent).toContain('httpauth.password:secret');

    const userJsPath = path.join(prepared.userDataDir, 'user.js');
    expect(fs.existsSync(userJsPath)).toBe(true);
    const userJs = fs.readFileSync(userJsPath, 'utf8');
    expect(userJs).toContain('user_pref("marionette.enabled", true);');
    expect(userJs).toContain('user_pref("network.proxy.http", "127.0.0.1");');
    expect(userJs).toContain('user_pref("network.proxy.http_port", 8080);');
    expect(userJs).toContain('user_pref("browser.download.dir"');
    expect(userJs).toContain('user_pref("intl.accept_languages"');
    expect(userJs).toContain('user_pref("prompts.modalType.prompt", 3);');
  });

  it('normalizes legacy file-backed source configs back to generated fpfile output', async () => {
    const prepared = prepareRuyiFirefoxLaunch(
      createSession({
        fingerprint: mergeFingerprintConfig(getDefaultFingerprint('ruyi'), {
          source: {
            mode: 'file',
            filePath: path.join(tempRoot, 'fixtures', 'profile.fpfile.txt'),
            fileFormat: 'txt',
          },
        }),
      })
    );

    expect(prepared.fpfilePath).toBeTruthy();
    expect(prepared.fpfilePath?.endsWith('.txt')).toBe(true);
    expect(fs.existsSync(prepared.fpfilePath!)).toBe(true);
  });

  it('normalizes legacy generated fpfile output back to txt', () => {
    const prepared = prepareRuyiFirefoxLaunch(
      createSession({
        fingerprint: {
          ...mergeFingerprintConfig(getDefaultFingerprint('ruyi'), {
            identity: {
              region: {
                timezone: 'Asia/Tokyo',
              },
            },
            source: {
              mode: 'generated',
              fileFormat: 'txt',
            },
          }),
          source: {
            mode: 'generated',
            fileFormat: 'json' as never,
          },
        },
      })
    );

    expect(prepared.fpfilePath?.endsWith('.txt')).toBe(true);
    const fpfileContent = fs.readFileSync(prepared.fpfilePath!, 'utf8');
    expect(fpfileContent).toContain('timezone:Asia/Tokyo');
  });

  it('builds firefox launch args for remote debugging and fpfile injection', () => {
    const prepared = prepareRuyiFirefoxLaunch(
      createSession({
        fingerprint: mergeFingerprintConfig(getDefaultFingerprint('ruyi'), {
          identity: {
            display: {
              width: 1440,
              height: 900,
              availWidth: 1440,
              availHeight: 860,
              colorDepth: 24,
            },
          },
        }),
      })
    );

    const args = buildRuyiFirefoxLaunchArgs({
      prepared,
      remoteDebuggingPort: 9333,
      headless: true,
    });

    expect(args).toContain('--remote-debugging-port=9333');
    expect(args).toContain('--remote-allow-system-access');
    expect(args).toContain('--no-remote');
    expect(args).toContain('--marionette');
    expect(args).toContain('--profile');
    expect(args).toContain(prepared.userDataDir);
    expect(args).toContain('--headless');
    expect(args).toContain('--width=1440');
    expect(args).toContain('--height=900');
    if (prepared.fpfilePath) {
      expect(args).toContain(`--fpfile=${prepared.fpfilePath}`);
    }
  });

  it('prefers the bundled repo firefox executable when no override is provided', async () => {
    const bundledFirefoxPath = path.join(tempRoot, 'firefox', 'firefox.exe');
    await fsp.mkdir(path.dirname(bundledFirefoxPath), { recursive: true });
    await fsp.writeFile(bundledFirefoxPath, '', 'utf8');
    Object.defineProperty(process, 'argv', {
      configurable: true,
      value: previousArgv,
    });

    expect(resolveFirefoxExecutablePath()).toBe(bundledFirefoxPath);

    const prepared = prepareRuyiFirefoxLaunch(createSession());
    expect(prepared.browserPath).toBe(bundledFirefoxPath);
  });

  it('prefers the packaged firefox runtime when the app is packaged', async () => {
    const packagedFirefoxPath = path.join(tempRoot, 'resources', 'firefox', 'firefox.exe');
    await fsp.mkdir(path.dirname(packagedFirefoxPath), { recursive: true });
    await fsp.writeFile(packagedFirefoxPath, '', 'utf8');
    electronState.isPackaged = true;
    Object.defineProperty(process, 'argv', {
      configurable: true,
      value: previousArgv,
    });

    expect(resolveFirefoxExecutablePath()).toBe(packagedFirefoxPath);

    const prepared = prepareRuyiFirefoxLaunch(createSession());
    expect(prepared.browserPath).toBe(packagedFirefoxPath);
  });

  it('fails fast when the resolved firefox runtime path is missing', () => {
    const missingFirefoxPath = path.join(tempRoot, 'missing', 'firefox.exe');
    Object.defineProperty(process, 'argv', {
      configurable: true,
      value: [...previousArgv, `--airpa-firefox-path=${missingFirefoxPath}`],
    });

    expect(() => prepareRuyiFirefoxLaunch(createSession())).toThrow(
      `Ruyi Firefox runtime not found: ${missingFirefoxPath}`
    );
  });
});
