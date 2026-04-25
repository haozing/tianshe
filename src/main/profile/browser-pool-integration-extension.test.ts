import { describe, expect, it, vi } from 'vitest';
import { getDefaultFingerprint } from '../../constants/fingerprint-defaults';
import type { SessionConfig } from '../../core/browser-pool/types';
import {
  buildExtensionLaunchArgs,
  buildExtensionStartupErrorMessage,
} from './browser-pool-integration-extension';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\airpa-test'),
    getAppPath: vi.fn(() => process.cwd()),
    isPackaged: false,
  },
}));

function createSession(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    id: 'extension-test-session',
    partition: 'persist:extension-test-session',
    engine: 'extension',
    fingerprint: getDefaultFingerprint(),
    proxy: null,
    quota: 1,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 60_000,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    ...overrides,
  };
}

describe('buildExtensionLaunchArgs', () => {
  it('includes ruyi and avoids remote-debugging-port or enable-automation', () => {
    const launchArgs = buildExtensionLaunchArgs({
      session: createSession(),
      userDataDir: 'C:\\airpa\\profiles\\extension-test',
      managedExtensionArgs: ['--load-extension=C:\\airpa\\extensions'],
      ruyiArg: '--ruyi={"ruyiFile":"C:\\\\airpa\\\\fingerprint.ruyi.txt"}',
    });

    expect(launchArgs).toContain('--disable-blink-features=AutomationControlled');
    expect(launchArgs).toContain('--enable-webgl');
    expect(launchArgs).toContain('--ignore-gpu-blocklist');
    expect(launchArgs).toContain('--enable-unsafe-webgl');
    expect(launchArgs).toContain('--no-sandbox');
    expect(
      launchArgs.some((argument) => argument.startsWith('--remote-debugging-port='))
    ).toBe(false);
    expect(launchArgs).toContain('--load-extension=C:\\airpa\\extensions');
    expect(launchArgs).toContain('--ruyi={"ruyiFile":"C:\\\\airpa\\\\fingerprint.ruyi.txt"}');
    expect(launchArgs).not.toContain('--enable-automation');
  });
});

describe('buildExtensionStartupErrorMessage', () => {
  it('adds a ruyi-specific hint when stderr shows an unsupported switch', () => {
    const message = buildExtensionStartupErrorMessage({
      sessionId: 'extension-test-session',
      preparedRuyi: {
        arg: '--ruyi={"ruyiFile":"C:\\\\airpa\\\\fingerprint.ruyi.txt"}',
        filePath: 'C:\\airpa\\fingerprint.ruyi.txt',
        source: 'generated-txt',
      },
      exit: {
        code: 1,
        signal: null,
      },
      stderr: 'Unknown command line flag --ruyi',
    });

    expect(message).toContain('session extension-test-session');
    expect(message).toContain('Likely cause: bundled Chrome rejected --ruyi');
  });
});
