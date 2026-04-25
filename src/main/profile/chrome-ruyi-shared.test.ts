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
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataDir),
    getAppPath: vi.fn(() => electronState.appPath),
  },
}));

import { prepareRuyiLaunch } from './ruyi-launch-config-shared';

function createSession(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    id: 'ruyi-session',
    partition: 'persist:ruyi-session',
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

describe('prepareRuyiLaunch', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-ruyi-test-'));
    electronState.userDataDir = tempRoot;
    electronState.appPath = tempRoot;
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('generates txt native fingerprint payloads in generated mode', () => {
    const prepared = prepareRuyiLaunch(
      createSession({
        fingerprint: mergeFingerprintConfig(getDefaultFingerprint(), {
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

    expect(prepared.source).toBe('generated-txt');
    expect(prepared.filePath.endsWith('fingerprint.ruyi.txt')).toBe(true);
    expect(fs.existsSync(prepared.filePath)).toBe(true);

    const argument = JSON.parse(prepared.arg.slice('--ruyi='.length)) as Record<string, unknown>;
    expect(argument).toEqual({
      ruyiFile: prepared.filePath,
    });

    const content = fs.readFileSync(prepared.filePath, 'utf8');
    expect(content).toContain('useragent:');
    expect(content).toContain('timezone:Asia/Hong_Kong');
  });

  it('normalizes legacy generated native fingerprint payloads back to txt', () => {
    const prepared = prepareRuyiLaunch(
      createSession({
        fingerprint: {
          ...mergeFingerprintConfig(getDefaultFingerprint(), {
            identity: {
              region: {
                timezone: 'Asia/Hong_Kong',
              },
              hardware: {
                hardwareConcurrency: 16,
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

    expect(prepared.source).toBe('generated-txt');
    expect(prepared.filePath.endsWith('fingerprint.ruyi.txt')).toBe(true);
    const content = fs.readFileSync(prepared.filePath, 'utf8');
    expect(content).toContain('timezone:Asia/Hong_Kong');
    expect(content).toContain('hardwareConcurrency:16');
  });

  it('normalizes legacy file-backed source configs back to generated output', async () => {
    const prepared = prepareRuyiLaunch(
      createSession({
        fingerprint: mergeFingerprintConfig(getDefaultFingerprint(), {
          source: {
            mode: 'file',
            filePath: path.join(tempRoot, 'fixtures', 'profile.ruyi.txt'),
            fileFormat: 'txt',
          },
        }),
      })
    );

    expect(prepared.source).toBe('generated-txt');
    expect(prepared.filePath.endsWith('fingerprint.ruyi.txt')).toBe(true);
    expect(fs.existsSync(prepared.filePath)).toBe(true);

    const argument = JSON.parse(prepared.arg.slice('--ruyi='.length)) as Record<string, unknown>;
    expect(argument).toEqual({
      ruyiFile: prepared.filePath,
    });
    const content = fs.readFileSync(prepared.filePath, 'utf8');
    expect(content).toContain('useragent:');
  });
});
