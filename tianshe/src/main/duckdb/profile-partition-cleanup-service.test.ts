import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveUserDataDir } from '../../constants/runtime-config';
import { ProfilePartitionCleanupService } from './profile-partition-cleanup-service';

const electronState = vi.hoisted(() => ({
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataDir),
  },
  session: {
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      flushStorageData: vi.fn(),
      cookies: {
        flushStore: vi.fn(async () => undefined),
      },
      storagePath: '',
    })),
  },
}));

describe('ProfilePartitionCleanupService', () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'airpa-profile-cleanup-'));
    electronState.userDataDir = tempRoot;
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('purges Cloak profile and download data for a deleted profile', async () => {
    const userDataDir = resolveUserDataDir(tempRoot);
    const profileDir = path.join(userDataDir, 'cloak', 'profiles', 'profile-1');
    const downloadDir = path.join(userDataDir, 'cloak', 'downloads', 'profile-1');
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.mkdir(downloadDir, { recursive: true });
    await fsp.writeFile(path.join(profileDir, 'Local State'), '{}', 'utf8');
    await fsp.writeFile(path.join(downloadDir, 'report.csv'), 'id,name', 'utf8');

    await new ProfilePartitionCleanupService().purgeCloakProfileData('profile-1');

    await expect(fsp.access(profileDir)).rejects.toThrow();
    await expect(fsp.access(downloadDir)).rejects.toThrow();
  });
});
