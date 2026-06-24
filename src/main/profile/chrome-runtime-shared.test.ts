import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  appPath: process.cwd(),
  isPackaged: false,
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => electronState.appPath),
    getPath: vi.fn(() => electronState.appPath),
    get isPackaged() {
      return electronState.isPackaged;
    },
  },
}));

import { resolveChromeExecutablePath } from './chrome-runtime-shared';

describe('chrome runtime shared path resolution', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-chrome-runtime-'));
    electronState.appPath = tempRoot;
    electronState.isPackaged = false;
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('prefers AIRPA_CHROME_PATH when provided', () => {
    const override = path.join(tempRoot, 'custom', 'chrome.exe');
    vi.stubEnv('AIRPA_CHROME_PATH', override);

    expect(resolveChromeExecutablePath()).toBe(override);
  });

  it('prefers the repo chrome runtime before system candidates', async () => {
    const bundledChromePath = path.join(tempRoot, 'chrome', 'chrome.exe');
    await fsp.mkdir(path.dirname(bundledChromePath), { recursive: true });
    await fsp.writeFile(bundledChromePath, '', 'utf8');

    expect(resolveChromeExecutablePath()).toBe(bundledChromePath);
  });

  it('prefers the client chrome runtime before the legacy repo runtime', async () => {
    const clientChromePath = path.join(tempRoot, 'client', 'chrome', 'chrome.exe');
    const legacyChromePath = path.join(tempRoot, 'chrome', 'chrome.exe');
    await fsp.mkdir(path.dirname(clientChromePath), { recursive: true });
    await fsp.mkdir(path.dirname(legacyChromePath), { recursive: true });
    await fsp.writeFile(clientChromePath, '', 'utf8');
    await fsp.writeFile(legacyChromePath, '', 'utf8');

    expect(resolveChromeExecutablePath()).toBe(clientChromePath);
  });
});
