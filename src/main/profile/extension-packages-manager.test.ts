import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionPackagesManager } from './extension-packages-manager';
import type { ExtensionPackagesService } from '../duckdb/extension-packages-service';
import type { ExtensionPackage } from '../../types/profile';

const userDataRoot = path.join(os.tmpdir(), `tianshe-extension-packages-${process.pid}`);

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataRoot),
  },
}));

vi.mock('../../constants/runtime-config', () => ({
  resolveUserDataDir: vi.fn((value: string) => value),
}));

vi.mock('../../core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createExtensionServiceMock(overrides: Partial<ExtensionPackagesService> = {}) {
  const upsertPackage = vi.fn(async (params) => {
    const now = new Date();
    return {
      id: 'pkg-1',
      extensionId: params.extensionId,
      name: params.name,
      version: params.version,
      sourceType: params.sourceType,
      sourceUrl: params.sourceUrl ?? null,
      archiveSha256: params.archiveSha256 ?? null,
      manifest: params.manifest ?? undefined,
      extractDir: params.extractDir,
      enabled: params.enabled !== false,
      createdAt: now,
      updatedAt: now,
    } satisfies ExtensionPackage;
  });

  return {
    listPackages: vi.fn(),
    upsertPackage,
    ...overrides,
  } as unknown as ExtensionPackagesService & {
    upsertPackage: typeof upsertPackage;
  };
}

async function writeExtensionDir(root: string, manifest: Record<string, unknown>, marker: string) {
  await fs.ensureDir(root);
  await fs.writeJson(path.join(root, 'manifest.json'), manifest);
  await fs.writeFile(path.join(root, 'marker.txt'), marker, 'utf-8');
}

function packageTargetDir(extensionId: string, version: string): string {
  return path.join(userDataRoot, 'extension', 'packages', 'packages', extensionId, version);
}

function packageExtensionDir(extensionId: string): string {
  return path.join(userDataRoot, 'extension', 'packages', 'packages', extensionId);
}

function packageTmpDir(): string {
  return path.join(userDataRoot, 'extension', 'packages', 'tmp');
}

function createPackage(extensionId: string, version = '1.0.0'): ExtensionPackage {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: `pkg-${extensionId}`,
    extensionId,
    name: 'Demo',
    version,
    sourceType: 'local',
    sourceUrl: null,
    archiveSha256: null,
    extractDir: packageTargetDir(extensionId, version),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

describe('ExtensionPackagesManager install consistency', () => {
  let sourceRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    await fs.remove(userDataRoot);
    sourceRoot = path.join(userDataRoot, 'sources');
    await fs.ensureDir(sourceRoot);
  });

  afterEach(async () => {
    await fs.remove(userDataRoot);
    vi.restoreAllMocks();
  });

  it('keeps the old package directory when copying a replacement fails', async () => {
    const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const version = '1.0.0';
    const targetDir = packageTargetDir(extensionId, version);
    const sourceDir = path.join(sourceRoot, 'replacement');

    await writeExtensionDir(targetDir, { manifest_version: 3, name: 'Old', version }, 'old');
    await writeExtensionDir(sourceDir, { manifest_version: 3, name: 'New', version }, 'new');

    const service = createExtensionServiceMock();
    const manager = new ExtensionPackagesManager(service);
    const copySpy = vi.spyOn(fs, 'copy').mockRejectedValueOnce(new Error('copy failed'));

    await expect(
      manager.importLocalPackages([{ path: sourceDir, extensionIdHint: extensionId }])
    ).rejects.toThrow('copy failed');

    expect(await fs.readFile(path.join(targetDir, 'marker.txt'), 'utf-8')).toBe('old');
    expect(service.upsertPackage).not.toHaveBeenCalled();
    expect(copySpy).toHaveBeenCalled();
  });

  it('restores the old package directory when metadata upsert fails', async () => {
    const extensionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const version = '1.0.0';
    const targetDir = packageTargetDir(extensionId, version);
    const sourceDir = path.join(sourceRoot, 'replacement');

    await writeExtensionDir(targetDir, { manifest_version: 3, name: 'Old', version }, 'old');
    await writeExtensionDir(sourceDir, { manifest_version: 3, name: 'New', version }, 'new');

    const service = createExtensionServiceMock({
      upsertPackage: vi.fn().mockRejectedValue(new Error('upsert failed')),
    } as Partial<ExtensionPackagesService>);
    const manager = new ExtensionPackagesManager(service);

    await expect(
      manager.importLocalPackages([{ path: sourceDir, extensionIdHint: extensionId }])
    ).rejects.toThrow('upsert failed');

    expect(await fs.readFile(path.join(targetDir, 'marker.txt'), 'utf-8')).toBe('old');
    expect(await fs.pathExists(packageTmpDir())).toBe(true);
    expect(await fs.readdir(packageTmpDir())).toEqual([]);
  });

  it('commits the new package directory after metadata upsert succeeds', async () => {
    const extensionId = 'cccccccccccccccccccccccccccccccc';
    const version = '2.0.0';
    const targetDir = packageTargetDir(extensionId, version);
    const sourceDir = path.join(sourceRoot, 'replacement');

    await writeExtensionDir(targetDir, { manifest_version: 3, name: 'Old', version }, 'old');
    await writeExtensionDir(sourceDir, { manifest_version: 3, name: 'New', version }, 'new');

    const service = createExtensionServiceMock();
    const manager = new ExtensionPackagesManager(service);

    const [pkg] = await manager.importLocalPackages([{ path: sourceDir, extensionIdHint: extensionId }]);

    expect(pkg.extractDir).toBe(targetDir);
    expect(await fs.readFile(path.join(targetDir, 'marker.txt'), 'utf-8')).toBe('new');
    expect(service.upsertPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId,
        version,
        extractDir: targetDir,
      })
    );
    expect(await fs.readdir(packageTmpDir())).toEqual([]);
  });

  it('removes package files before metadata when pruning unused packages', async () => {
    const extensionId = 'dddddddddddddddddddddddddddddddd';
    const version = '1.0.0';
    const targetDir = packageTargetDir(extensionId, version);
    const removedPackage = createPackage(extensionId, version);

    await writeExtensionDir(targetDir, { manifest_version: 3, name: 'Demo', version }, 'old');

    const service = createExtensionServiceMock({
      countBindingsByExtensionId: vi.fn().mockResolvedValue(0),
      removePackagesByExtensionIds: vi.fn().mockResolvedValue([removedPackage]),
    } as Partial<ExtensionPackagesService>);
    const manager = new ExtensionPackagesManager(service);

    const removed = await manager.pruneUnusedPackagesByExtensionIds([extensionId]);

    expect(removed).toEqual([removedPackage]);
    expect(service.removePackagesByExtensionIds).toHaveBeenCalledWith([extensionId]);
    expect(await fs.pathExists(packageExtensionDir(extensionId))).toBe(false);
    expect(await fs.readdir(packageTmpDir())).toEqual([]);
  });

  it('does not delete metadata when pruning cannot move package files aside', async () => {
    const extensionId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const version = '1.0.0';
    const targetDir = packageTargetDir(extensionId, version);

    await writeExtensionDir(targetDir, { manifest_version: 3, name: 'Demo', version }, 'old');

    const service = createExtensionServiceMock({
      countBindingsByExtensionId: vi.fn().mockResolvedValue(0),
      removePackagesByExtensionIds: vi.fn().mockResolvedValue([createPackage(extensionId, version)]),
    } as Partial<ExtensionPackagesService>);
    const manager = new ExtensionPackagesManager(service);
    vi.spyOn(fs, 'move').mockRejectedValueOnce(new Error('move failed'));

    await expect(manager.pruneUnusedPackagesByExtensionIds([extensionId])).rejects.toThrow(
      'move failed'
    );

    expect(service.removePackagesByExtensionIds).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(targetDir, 'marker.txt'), 'utf-8')).toBe('old');
  });

  it('restores package files when metadata deletion fails during unbind cleanup', async () => {
    const extensionId = 'ffffffffffffffffffffffffffffffff';
    const version = '1.0.0';
    const targetDir = packageTargetDir(extensionId, version);

    await writeExtensionDir(targetDir, { manifest_version: 3, name: 'Demo', version }, 'old');

    const service = createExtensionServiceMock({
      unbindExtensionsFromProfiles: vi.fn().mockResolvedValue(1),
      countBindingsByExtensionId: vi.fn().mockResolvedValue(0),
      removePackagesByExtensionIds: vi.fn().mockRejectedValue(new Error('metadata failed')),
    } as Partial<ExtensionPackagesService>);
    const manager = new ExtensionPackagesManager(service);

    await expect(
      manager.unbindExtensionsFromProfiles({
        profileIds: ['profile-1'],
        extensionIds: [extensionId],
        removePackageWhenUnused: true,
      })
    ).rejects.toThrow('metadata failed');

    expect(service.unbindExtensionsFromProfiles).toHaveBeenCalledWith(
      ['profile-1'],
      [extensionId]
    );
    expect(await fs.readFile(path.join(targetDir, 'marker.txt'), 'utf-8')).toBe('old');
    expect(await fs.readdir(packageTmpDir())).toEqual([]);
  });
});
