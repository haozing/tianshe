import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import AdmZip from 'adm-zip';
import axios from 'axios';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { resolveUserDataDir } from '../../constants/runtime-config';
import { normalizeExtensionPackageId } from '../../core/extension-packages/policy';
import { assertSafeZipEntryPath, assertSafeZipMetadata } from '../../utils/zip-safety';
import type {
  ExtensionPackage,
  ExtensionPackagesMeta,
  ProfileExtensionBinding,
  ProfileExtensionInstallMode,
} from '../../types/profile';
import {
  ExtensionPackagesService,
  type UpsertExtensionPackageParams,
  type UpsertProfileExtensionBindingParams,
} from '../duckdb/extension-packages-service';

export interface ImportLocalExtensionInput {
  path: string;
  extensionIdHint?: string;
}

export interface DownloadCloudExtensionInput {
  extensionId: string;
  version?: string;
  downloadUrl: string;
  archiveSha256?: string;
  name?: string;
}

export interface ImportLocalExtensionFailure {
  path: string;
  extensionIdHint?: string;
  error: string;
}

export interface DownloadCloudExtensionFailure extends DownloadCloudExtensionInput {
  error: string;
}

export interface ExtensionMutationResult<TFailure> {
  succeeded: ExtensionPackage[];
  failed: TFailure[];
}

export interface ManagedLaunchExtension {
  extensionId: string;
  extractDir: string;
  installMode: ProfileExtensionInstallMode;
}

type ImportSourceType = 'local' | 'cloud';
type PendingInlineArchive = {
  extensionId: string;
  version?: string;
  archiveBase64: string;
  archiveSha256?: string;
  name?: string;
};

export class ExtensionPackagesManager {
  constructor(private extensionService: ExtensionPackagesService) {}

  async listPackages(): Promise<ExtensionPackage[]> {
    return this.extensionService.listPackages();
  }

  async exportPackageArchiveForSync(packageId: string): Promise<{
    packageId: string;
    extensionId: string;
    version: string;
    fileName: string;
    archiveBase64: string;
    archiveSha256: string;
  }> {
    const normalizedPackageId = String(packageId || '').trim();
    if (!normalizedPackageId) {
      throw new Error('packageId is required');
    }

    const packages = await this.extensionService.listPackages();
    const pkg = packages.find((item) => String(item.id || '').trim() === normalizedPackageId);
    if (!pkg) {
      throw new Error(`Extension package not found: ${normalizedPackageId}`);
    }

    const archived = await this.packExtractDirToBase64(pkg.extractDir);
    const extensionId = normalizeExtensionPackageId(String(pkg.extensionId || '').trim());
    const version = String(pkg.version || '').trim() || 'latest';
    const safeExtensionId = extensionId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'extension';
    const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, '_') || 'latest';

    return {
      packageId: normalizedPackageId,
      extensionId,
      version,
      fileName: `${safeExtensionId}_${safeVersion}.zip`,
      archiveBase64: archived.archiveBase64,
      archiveSha256: archived.archiveSha256,
    };
  }

  async listProfileBindings(profileId: string): Promise<ProfileExtensionBinding[]> {
    return this.extensionService.listProfileBindings(profileId);
  }

  async importLocalPackages(inputs: ImportLocalExtensionInput[]): Promise<ExtensionPackage[]> {
    const normalizedInputs = Array.isArray(inputs) ? inputs : [];
    if (normalizedInputs.length === 0) return [];

    await this.ensureRepositoryDirs();
    const expandedInputs = await this.expandLocalImportInputs(normalizedInputs);
    const out: ExtensionPackage[] = [];
    for (const input of expandedInputs) {
      out.push(await this.importFromLocalPath(input));
    }
    return out;
  }

  async importLocalPackagesDetailed(
    inputs: ImportLocalExtensionInput[]
  ): Promise<ExtensionMutationResult<ImportLocalExtensionFailure>> {
    const normalizedInputs = Array.isArray(inputs) ? inputs : [];
    if (normalizedInputs.length === 0) {
      return {
        succeeded: [],
        failed: [],
      };
    }

    await this.ensureRepositoryDirs();
    const expandedInputs = await this.expandLocalImportInputs(normalizedInputs);
    const succeeded: ExtensionPackage[] = [];
    const failed: ImportLocalExtensionFailure[] = [];

    for (const input of expandedInputs) {
      try {
        succeeded.push(await this.importFromLocalPath(input));
      } catch (error) {
        failed.push({
          path: String(input.path || '').trim(),
          extensionIdHint: String(input.extensionIdHint || '').trim() || undefined,
          error: error instanceof Error ? error.message : '未知错误',
        });
      }
    }

    return { succeeded, failed };
  }

  async downloadCloudPackages(inputs: DownloadCloudExtensionInput[]): Promise<ExtensionPackage[]> {
    const normalizedInputs = Array.isArray(inputs) ? inputs : [];
    if (normalizedInputs.length === 0) return [];

    await this.ensureRepositoryDirs();
    const out: ExtensionPackage[] = [];
    for (const input of normalizedInputs) {
      const normalizedExtensionId = normalizeExtensionPackageId(input.extensionId);
      const downloadURL = String(input.downloadUrl || '').trim();
      if (!downloadURL) {
        throw new Error(`downloadUrl is required for extension: ${normalizedExtensionId}`);
      }

      const response = await axios.get<ArrayBuffer>(downloadURL, {
        responseType: 'arraybuffer',
        timeout: 120000,
      });
      const bytes = Buffer.from(response.data);
      if (bytes.length === 0) {
        throw new Error(`Downloaded archive is empty for extension: ${normalizedExtensionId}`);
      }

      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const expectedHash = String(input.archiveSha256 || '')
        .trim()
        .toLowerCase();
      if (expectedHash && sha256 !== expectedHash) {
        throw new Error(
          `Archive hash mismatch for extension ${normalizedExtensionId}: expected ${expectedHash}, got ${sha256}`
        );
      }
      out.push(
        await this.installCloudArchiveBuffer({
          extensionId: normalizedExtensionId,
          version: input.version,
          bytes,
          archiveSha256: sha256,
          name: input.name,
          sourceUrl: downloadURL,
        })
      );
    }
    return out;
  }

  async downloadCloudPackagesDetailed(
    inputs: DownloadCloudExtensionInput[]
  ): Promise<ExtensionMutationResult<DownloadCloudExtensionFailure>> {
    const normalizedInputs = Array.isArray(inputs) ? inputs : [];
    if (normalizedInputs.length === 0) {
      return {
        succeeded: [],
        failed: [],
      };
    }

    await this.ensureRepositoryDirs();
    const succeeded: ExtensionPackage[] = [];
    const failed: DownloadCloudExtensionFailure[] = [];
    for (const input of normalizedInputs) {
      try {
        const packages = await this.downloadCloudPackages([input]);
        succeeded.push(...packages);
      } catch (error) {
        failed.push({
          ...input,
          error: error instanceof Error ? error.message : '未知错误',
        });
      }
    }
    return { succeeded, failed };
  }

  async installCloudPackageFromInlineArchive(input: {
    extensionId: string;
    version?: string;
    archiveBase64: string;
    archiveSha256?: string;
    name?: string;
    sourceUrl?: string | null;
  }): Promise<ExtensionPackage> {
    await this.ensureRepositoryDirs();

    const normalizedExtensionId = normalizeExtensionPackageId(
      String(input.extensionId || '').trim()
    );
    const bytes = this.decodeBase64Archive(input.archiveBase64, normalizedExtensionId);

    return this.installCloudArchiveBuffer({
      extensionId: normalizedExtensionId,
      version: input.version,
      bytes,
      archiveSha256: input.archiveSha256,
      name: input.name,
      sourceUrl: input.sourceUrl ?? null,
    });
  }

  async importCloudArchiveFromPath(input: {
    archivePath: string;
    version?: string;
    name?: string;
    sourceUrl?: string | null;
    archiveSha256?: string;
  }): Promise<ExtensionPackage> {
    const archivePath = path.resolve(String(input.archivePath || '').trim());
    if (!archivePath) {
      throw new Error('archivePath is required');
    }
    if (!(await fs.pathExists(archivePath))) {
      throw new Error(`Cloud archive not found: ${archivePath}`);
    }

    const stats = await fs.stat(archivePath);
    if (!stats.isFile()) {
      throw new Error(`Cloud archive path is not a file: ${archivePath}`);
    }
    if (path.extname(archivePath).toLowerCase() !== '.zip') {
      throw new Error(`Unsupported cloud archive format: ${archivePath}`);
    }

    const bytes = await fs.readFile(archivePath);
    if (bytes.length === 0) {
      throw new Error(`Cloud archive is empty: ${archivePath}`);
    }

    const archiveSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const expectedHash = String(input.archiveSha256 || '')
      .trim()
      .toLowerCase();
    if (expectedHash && expectedHash !== archiveSha256) {
      throw new Error(`Archive hash mismatch: expected ${expectedHash}, got ${archiveSha256}`);
    }

    const installed = await this.importFromArchivePath({
      archivePath,
      expectedVersion: String(input.version || '').trim() || undefined,
      sourceType: 'cloud',
      sourceUrl: String(input.sourceUrl || '').trim() || undefined,
      archiveSha256,
    });

    return this.extensionService.upsertPackage({
      extensionId: installed.extensionId,
      name: String(input.name || '').trim() || installed.name,
      version: installed.version,
      sourceType: 'cloud',
      sourceUrl: String(input.sourceUrl || '').trim() || null,
      archiveSha256,
      manifest: installed.manifest,
      extractDir: installed.extractDir,
      enabled: true,
    });
  }

  async bindPackagesToProfiles(input: {
    profileIds: string[];
    packages: Array<{
      extensionId: string;
      version?: string | null;
      installMode?: ProfileExtensionInstallMode;
      sortOrder?: number;
      enabled?: boolean;
    }>;
  }): Promise<void> {
    const packages = Array.isArray(input.packages) ? input.packages : [];
    const profileInput = Array.isArray(input.profileIds) ? input.profileIds : [];
    const profileIds = Array.from(
      new Set(
        profileInput.map((item) => String(item || '').trim()).filter((item) => item.length > 0)
      )
    );
    if (profileIds.length === 0 || packages.length === 0) return;

    const bindings: UpsertProfileExtensionBindingParams[] = packages.map((pkg) => ({
      extensionId: normalizeExtensionPackageId(pkg.extensionId),
      version: pkg.version ? String(pkg.version).trim() : null,
      installMode: pkg.installMode === 'optional' ? 'optional' : 'required',
      sortOrder: Number.isFinite(pkg.sortOrder) ? Math.trunc(pkg.sortOrder as number) : 0,
      enabled: pkg.enabled !== false,
    }));

    await this.extensionService.bindPackagesToProfiles(profileIds, bindings);
  }

  async unbindExtensionsFromProfiles(input: {
    profileIds: string[];
    extensionIds: string[];
    removePackageWhenUnused?: boolean;
  }): Promise<{
    removedBindings: number;
    removedPackages: ExtensionPackage[];
    removedExtensionIds: string[];
  }> {
    const profileInput = Array.isArray(input.profileIds) ? input.profileIds : [];
    const extensionInput = Array.isArray(input.extensionIds) ? input.extensionIds : [];
    const profileIds = Array.from(
      new Set(
        profileInput.map((item) => String(item || '').trim()).filter((item) => item.length > 0)
      )
    );
    const extensionIds = Array.from(
      new Set(
        extensionInput
          .map((item) => String(item || '').trim())
          .filter((item) => item.length > 0)
          .map((item) => normalizeExtensionPackageId(item))
      )
    );
    if (profileIds.length === 0 || extensionIds.length === 0) {
      return { removedBindings: 0, removedPackages: [], removedExtensionIds: [] };
    }

    const removedBindings = await this.extensionService.unbindExtensionsFromProfiles(
      profileIds,
      extensionIds
    );

    const removedPackages: ExtensionPackage[] = [];
    const removedExtensionIds: string[] = [];
    if (input.removePackageWhenUnused) {
      for (const extensionId of extensionIds) {
        const refCount = await this.extensionService.countBindingsByExtensionId(extensionId);
        if (refCount > 0) continue;

        const removed = await this.extensionService.removePackagesByExtensionIds([extensionId]);
        await fs.remove(path.join(this.getPackagesDir(), extensionId));
        if (removed.length > 0) {
          removedPackages.push(...removed);
        }
        removedExtensionIds.push(extensionId);
      }
    }

    return { removedBindings, removedPackages, removedExtensionIds };
  }

  async pruneUnusedPackagesByExtensionIds(extensionIds: string[]): Promise<ExtensionPackage[]> {
    const normalizedIds = Array.from(
      new Set(
        (Array.isArray(extensionIds) ? extensionIds : [])
          .map((item) => String(item || '').trim())
          .filter((item) => item.length > 0)
          .map((item) => normalizeExtensionPackageId(item))
      )
    );
    if (normalizedIds.length === 0) return [];

    const removed: ExtensionPackage[] = [];
    for (const extensionId of normalizedIds) {
      const refCount = await this.extensionService.countBindingsByExtensionId(extensionId);
      if (refCount > 0) continue;

      const deletedPackages = await this.extensionService.removePackagesByExtensionIds([
        extensionId,
      ]);
      await fs.remove(path.join(this.getPackagesDir(), extensionId));
      removed.push(...deletedPackages);
    }

    return removed;
  }

  async resolveLaunchExtensions(profileId: string): Promise<ManagedLaunchExtension[]> {
    const descriptors = await this.extensionService.resolveLaunchExtensions(profileId);
    const out: ManagedLaunchExtension[] = [];
    for (const descriptor of descriptors) {
      const exists = await fs.pathExists(descriptor.extractDir);
      if (!exists) {
        continue;
      }
      out.push({
        extensionId: descriptor.extensionId,
        extractDir: descriptor.extractDir,
        installMode: descriptor.installMode,
      });
    }
    return out;
  }

  async buildCloudMetaForProfile(profileId: string): Promise<ExtensionPackagesMeta> {
    const base = await this.extensionService.buildCloudMetaForProfile(profileId);
    const packages: ExtensionPackagesMeta['packages'] = [];

    for (const item of base.packages) {
      const extensionId = normalizeExtensionPackageId(String(item.extensionId || '').trim());
      const version = String(item.version || '').trim();
      if (!version) {
        throw new Error(
          `Invalid cloud extension metadata (missing version) for profile=${profileId}: ${extensionId}`
        );
      }

      const pkg = await this.extensionService.getPackageByExtensionVersion(extensionId, version);
      if (!pkg) {
        throw new Error(
          `Extension package not found while building cloud metadata for profile=${profileId}: ${extensionId}@${version}`
        );
      }

      const next: (typeof packages)[number] = {
        extensionId,
        name: item.name || pkg.name,
        version,
        downloadUrl: item.downloadUrl,
        archiveSha256: item.archiveSha256 || pkg.archiveSha256 || undefined,
        enabled: item.enabled !== false,
        sortOrder: this.toSortOrder(item.sortOrder),
      };

      if (!next.downloadUrl) {
        const archived = await this.packExtractDirToBase64(pkg.extractDir);
        next.archiveBase64 = archived.archiveBase64;
        next.archiveSha256 = archived.archiveSha256;
      }

      packages.push(next);
    }

    return {
      packages,
      policy: base.policy,
    };
  }

  async applyCloudMetaToProfile(input: {
    profileId: string;
    meta: ExtensionPackagesMeta;
  }): Promise<{
    downloadedCount: number;
    boundCount: number;
  }> {
    const profileId = String(input.profileId || '').trim();
    if (!profileId) {
      throw new Error('profileId is required');
    }
    const meta = input.meta && Array.isArray(input.meta.packages) ? input.meta : { packages: [] };

    const toDownload: DownloadCloudExtensionInput[] = [];
    const toImportInline: PendingInlineArchive[] = [];
    const missingRestorablePackages: string[] = [];
    for (const pkg of meta.packages) {
      const extensionId = normalizeExtensionPackageId(String(pkg.extensionId || '').trim());
      const version = String(pkg.version || '').trim();
      const existing = version
        ? await this.extensionService.getPackageByExtensionVersion(extensionId, version)
        : await this.extensionService.getLatestEnabledPackageByExtensionId(extensionId);
      if (existing) continue;
      const downloadUrl = String(pkg.downloadUrl || '').trim();
      if (downloadUrl) {
        toDownload.push({
          extensionId,
          version: version || undefined,
          downloadUrl,
          archiveSha256: String(pkg.archiveSha256 || '').trim() || undefined,
          name: String(pkg.name || '').trim() || undefined,
        });
        continue;
      }

      const archiveBase64 = String(pkg.archiveBase64 || '').trim();
      if (archiveBase64) {
        toImportInline.push({
          extensionId,
          version: version || undefined,
          archiveBase64,
          archiveSha256: String(pkg.archiveSha256 || '').trim() || undefined,
          name: String(pkg.name || '').trim() || undefined,
        });
        continue;
      }

      missingRestorablePackages.push(`${extensionId}@${version || 'latest'}`);
    }

    if (missingRestorablePackages.length > 0) {
      throw new Error(
        `Cloud profile extensions are not restorable locally (missing downloadUrl/archiveBase64): ${missingRestorablePackages.join(', ')}`
      );
    }

    let downloadedCount = 0;
    if (toDownload.length > 0) {
      const downloaded = await this.downloadCloudPackages(toDownload);
      downloadedCount = downloaded.length;
    }
    if (toImportInline.length > 0) {
      for (const inlinePkg of toImportInline) {
        const bytes = this.decodeBase64Archive(inlinePkg.archiveBase64, inlinePkg.extensionId);
        await this.installCloudArchiveBuffer({
          extensionId: inlinePkg.extensionId,
          version: inlinePkg.version,
          bytes,
          archiveSha256: inlinePkg.archiveSha256,
          name: inlinePkg.name,
          sourceUrl: null,
        });
      }
      downloadedCount += toImportInline.length;
    }

    const bindings: UpsertProfileExtensionBindingParams[] = [];
    for (const pkg of meta.packages) {
      const extensionId = normalizeExtensionPackageId(String(pkg.extensionId || '').trim());
      const version = String(pkg.version || '').trim() || null;

      const resolved = version
        ? await this.extensionService.getPackageByExtensionVersion(extensionId, version)
        : await this.extensionService.getLatestEnabledPackageByExtensionId(extensionId);
      if (!resolved) {
        throw new Error(
          `Extension package not available after cloud restore: ${extensionId}@${version || 'latest'}`
        );
      }

      bindings.push({
        extensionId,
        version,
        installMode: 'required',
        sortOrder: this.toSortOrder(pkg.sortOrder),
        enabled: pkg.enabled !== false,
      });
    }
    await this.extensionService.setProfileBindings(profileId, bindings);

    return {
      downloadedCount,
      boundCount: bindings.length,
    };
  }

  private async importFromLocalPath(input: ImportLocalExtensionInput): Promise<ExtensionPackage> {
    const sourcePath = path.resolve(String(input.path || '').trim());
    if (!sourcePath) {
      throw new Error('Local extension path is required');
    }
    if (!(await fs.pathExists(sourcePath))) {
      throw new Error(`Local extension path not found: ${sourcePath}`);
    }

    const stats = await fs.stat(sourcePath);
    if (stats.isDirectory()) {
      const installed = await this.importFromDirectory({
        sourceDir: sourcePath,
        extensionIdHint: input.extensionIdHint,
        sourceType: 'local',
      });
      return this.extensionService.upsertPackage(installed);
    }

    const ext = path.extname(sourcePath).toLowerCase();
    if (ext !== '.zip') {
      throw new Error(`Unsupported extension archive format: ${ext}. Only .zip is supported.`);
    }

    const installed = await this.importFromArchivePath({
      archivePath: sourcePath,
      extensionIdHint: input.extensionIdHint,
      sourceType: 'local',
    });
    return this.extensionService.upsertPackage(installed);
  }

  private async expandLocalImportInputs(
    inputs: ImportLocalExtensionInput[]
  ): Promise<ImportLocalExtensionInput[]> {
    const out: ImportLocalExtensionInput[] = [];
    const seenPaths = new Set<string>();

    for (const input of inputs) {
      const sourcePath = path.resolve(String(input.path || '').trim());
      if (!sourcePath || seenPaths.has(sourcePath)) continue;
      seenPaths.add(sourcePath);

      if (!(await fs.pathExists(sourcePath))) {
        out.push({ ...input, path: sourcePath });
        continue;
      }

      const stats = await fs.stat(sourcePath);
      if (!stats.isDirectory()) {
        out.push({ ...input, path: sourcePath });
        continue;
      }

      const directManifest = path.join(sourcePath, 'manifest.json');
      if (await fs.pathExists(directManifest)) {
        out.push({ ...input, path: sourcePath });
        continue;
      }

      const entries = await fs.readdir(sourcePath, { withFileTypes: true });
      const candidates: ImportLocalExtensionInput[] = [];

      for (const entry of entries) {
        const candidatePath = path.join(sourcePath, entry.name);
        if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.zip') {
          candidates.push({ path: candidatePath });
          continue;
        }
        if (!entry.isDirectory()) continue;

        const nestedManifest = await this.findManifestRootDir(candidatePath);
        if (nestedManifest) {
          candidates.push({ path: candidatePath });
        }
      }

      if (candidates.length === 0) {
        out.push({ ...input, path: sourcePath });
        continue;
      }

      for (const candidate of candidates) {
        const resolved = path.resolve(candidate.path);
        if (seenPaths.has(resolved)) continue;
        seenPaths.add(resolved);
        out.push(candidate);
      }
    }

    return out;
  }

  private async importFromArchivePath(params: {
    archivePath: string;
    extensionIdHint?: string;
    expectedVersion?: string;
    sourceType: ImportSourceType;
    sourceUrl?: string;
    archiveSha256?: string;
  }): Promise<UpsertExtensionPackageParams> {
    const tempDir = path.join(this.getTmpDir(), `extract_${Date.now()}_${uuidv4()}`);
    await fs.ensureDir(tempDir);
    try {
      const zip = new AdmZip(params.archivePath);
      await this.safeExtractZip(zip, tempDir);
      const payload = await this.readExtensionPayloadFromDirectory(tempDir, params.extensionIdHint);
      if (params.expectedVersion && payload.version !== params.expectedVersion) {
        throw new Error(
          `Extension version mismatch: expected ${params.expectedVersion}, got ${payload.version}`
        );
      }
      const targetDir = this.getVersionedPackageDir(payload.extensionId, payload.version);
      await fs.remove(targetDir);
      await fs.ensureDir(path.dirname(targetDir));
      await fs.copy(payload.manifestRootDir, targetDir, { overwrite: true });

      return {
        extensionId: payload.extensionId,
        name: payload.name,
        version: payload.version,
        sourceType: params.sourceType,
        sourceUrl: params.sourceUrl ?? null,
        archiveSha256: params.archiveSha256 ?? null,
        manifest: payload.manifest,
        extractDir: targetDir,
        enabled: true,
      };
    } finally {
      await fs.remove(tempDir);
    }
  }

  private async importFromDirectory(params: {
    sourceDir: string;
    extensionIdHint?: string;
    sourceType: ImportSourceType;
  }): Promise<UpsertExtensionPackageParams> {
    const payload = await this.readExtensionPayloadFromDirectory(
      params.sourceDir,
      params.extensionIdHint
    );
    const targetDir = this.getVersionedPackageDir(payload.extensionId, payload.version);
    await fs.remove(targetDir);
    await fs.ensureDir(path.dirname(targetDir));
    await fs.copy(payload.manifestRootDir, targetDir, { overwrite: true });

    return {
      extensionId: payload.extensionId,
      name: payload.name,
      version: payload.version,
      sourceType: params.sourceType,
      sourceUrl: null,
      archiveSha256: null,
      manifest: payload.manifest,
      extractDir: targetDir,
      enabled: true,
    };
  }

  private async readExtensionPayloadFromDirectory(
    sourceDir: string,
    extensionIdHint?: string
  ): Promise<{
    extensionId: string;
    name: string;
    version: string;
    manifest: Record<string, unknown>;
    manifestRootDir: string;
  }> {
    const manifestRootDir = await this.findManifestRootDir(sourceDir);
    if (!manifestRootDir) {
      throw new Error(`manifest.json not found in extension directory: ${sourceDir}`);
    }

    const manifestPath = path.join(manifestRootDir, 'manifest.json');
    const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Invalid manifest.json in extension directory: ${manifestPath}; ${(error as Error).message}`
      );
    }

    const extensionId = this.resolveExtensionId(manifest, extensionIdHint);
    const name = String(manifest.name || extensionId).trim() || extensionId;
    const version = String(manifest.version || '0.0.0').trim() || '0.0.0';

    return {
      extensionId,
      name,
      version,
      manifest,
      manifestRootDir,
    };
  }

  private resolveExtensionId(manifest: Record<string, unknown>, extensionIdHint?: string): string {
    const key = typeof manifest.key === 'string' ? manifest.key.trim() : '';
    if (key) {
      const decoded = Buffer.from(key, 'base64');
      if (decoded.length > 0) {
        const digest = crypto.createHash('sha256').update(decoded).digest();
        const id = this.hashToExtensionId(digest);
        return normalizeExtensionPackageId(id);
      }
    }

    const hint = String(extensionIdHint || '').trim();
    if (hint) {
      return normalizeExtensionPackageId(hint);
    }

    const fallbackId = this.deriveFallbackExtensionId(manifest);
    if (fallbackId) {
      return fallbackId;
    }

    throw new Error('Cannot resolve extensionId: key/hint/fallback are all unavailable.');
  }

  private hashToExtensionId(hash: Buffer): string {
    const first16Bytes = hash.subarray(0, 16);
    let out = '';
    for (const byte of first16Bytes) {
      out += String.fromCharCode(97 + ((byte >> 4) & 0x0f));
      out += String.fromCharCode(97 + (byte & 0x0f));
    }
    return out;
  }

  private deriveFallbackExtensionId(manifest: Record<string, unknown>): string | null {
    const sanitized = this.sanitizeManifestForId(manifest);
    const serialized = JSON.stringify(sanitized);
    if (!serialized || serialized === '{}') {
      return null;
    }
    const digest = crypto.createHash('sha256').update(serialized).digest();
    return normalizeExtensionPackageId(this.hashToExtensionId(digest));
  }

  private sanitizeManifestForId(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeManifestForId(item));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(src).sort();
    for (const key of keys) {
      if (key === 'key' || key === 'version' || key === 'version_name') {
        continue;
      }
      out[key] = this.sanitizeManifestForId(src[key]);
    }
    return out;
  }

  private async findManifestRootDir(rootDir: string): Promise<string | null> {
    const directManifest = path.join(rootDir, 'manifest.json');
    if (await fs.pathExists(directManifest)) return rootDir;

    const level1 = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of level1) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(rootDir, entry.name);
      const manifestPath = path.join(candidate, 'manifest.json');
      if (await fs.pathExists(manifestPath)) {
        return candidate;
      }
    }
    return null;
  }

  private async safeExtractZip(zip: AdmZip, targetDir: string): Promise<void> {
    const entries = zip.getEntries();
    assertSafeZipMetadata(entries, 'extension package');

    for (const entry of entries) {
      const entryPath = entry.entryName;
      const targetPath = assertSafeZipEntryPath(entryPath, targetDir);

      if (entry.isDirectory) {
        await fs.ensureDir(targetPath);
      } else {
        await fs.ensureDir(path.dirname(targetPath));
        await fs.writeFile(targetPath, entry.getData());
      }
    }
  }

  private async installCloudArchiveBuffer(input: {
    extensionId: string;
    version?: string;
    bytes: Buffer;
    archiveSha256?: string;
    name?: string;
    sourceUrl?: string | null;
  }): Promise<ExtensionPackage> {
    await this.ensureRepositoryDirs();

    const normalizedExtensionId = normalizeExtensionPackageId(
      String(input.extensionId || '').trim()
    );
    const bytes = Buffer.from(input.bytes);
    if (bytes.length === 0) {
      throw new Error(`Archive is empty for extension: ${normalizedExtensionId}`);
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const expectedHash = String(input.archiveSha256 || '')
      .trim()
      .toLowerCase();
    if (expectedHash && sha256 !== expectedHash) {
      throw new Error(
        `Archive hash mismatch for extension ${normalizedExtensionId}: expected ${expectedHash}, got ${sha256}`
      );
    }

    const archiveName = `${Date.now()}_${uuidv4()}_${normalizedExtensionId}.zip`;
    const archivePath = path.join(this.getTmpDir(), archiveName);
    await fs.writeFile(archivePath, bytes);

    try {
      const installed = await this.importFromArchivePath({
        archivePath,
        extensionIdHint: normalizedExtensionId,
        expectedVersion: input.version,
        sourceType: 'cloud',
        sourceUrl: input.sourceUrl ?? undefined,
        archiveSha256: sha256,
      });
      return this.extensionService.upsertPackage({
        extensionId: installed.extensionId,
        name: input.name || installed.name,
        version: installed.version,
        sourceType: 'cloud',
        sourceUrl: input.sourceUrl ?? null,
        archiveSha256: sha256,
        manifest: installed.manifest,
        extractDir: installed.extractDir,
        enabled: true,
      });
    } finally {
      await fs.remove(archivePath);
    }
  }

  private async packExtractDirToBase64(
    extractDir: string
  ): Promise<{ archiveBase64: string; archiveSha256: string }> {
    const normalizedDir = path.resolve(String(extractDir || '').trim());
    if (!normalizedDir || !(await fs.pathExists(normalizedDir))) {
      throw new Error(`Extension package directory not found: ${extractDir}`);
    }

    const zip = new AdmZip();
    zip.addLocalFolder(normalizedDir);
    const bytes = zip.toBuffer();
    if (bytes.length === 0) {
      throw new Error(`Packed extension archive is empty: ${normalizedDir}`);
    }
    const archiveSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return {
      archiveBase64: bytes.toString('base64'),
      archiveSha256,
    };
  }

  private decodeBase64Archive(value: string, extensionId: string): Buffer {
    const normalized = String(value || '').replace(/\s+/g, '');
    if (!normalized) {
      throw new Error(`archiveBase64 is empty for extension: ${extensionId}`);
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
      throw new Error(`archiveBase64 is invalid for extension: ${extensionId}`);
    }
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.length === 0) {
      throw new Error(`archiveBase64 decoded bytes are empty for extension: ${extensionId}`);
    }
    return bytes;
  }

  private toSortOrder(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async ensureRepositoryDirs(): Promise<void> {
    await fs.ensureDir(this.getPackagesDir());
    await fs.ensureDir(this.getTmpDir());
  }

  private getRepositoryBaseDir(): string {
    const userDataDir = this.resolveUserDataDir();
    return path.join(userDataDir, 'extension', 'packages');
  }

  private getPackagesDir(): string {
    return path.join(this.getRepositoryBaseDir(), 'packages');
  }

  private getTmpDir(): string {
    return path.join(this.getRepositoryBaseDir(), 'tmp');
  }

  private getVersionedPackageDir(extensionId: string, version: string): string {
    return path.join(this.getPackagesDir(), extensionId, version);
  }

  private resolveUserDataDir(): string {
    try {
      return resolveUserDataDir(app.getPath('userData'));
    } catch {
      return resolveUserDataDir(process.cwd());
    }
  }
}
