import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { normalizeExtensionPackageId } from '../../core/extension-packages/policy';
import { assertSafeZipEntryPath, assertSafeZipMetadata } from '../../utils/zip-safety';

export function resolveExtensionId(manifest: Record<string, unknown>, extensionIdHint?: string): string {
  const key = typeof manifest.key === 'string' ? manifest.key.trim() : '';
  if (key) {
    const decoded = Buffer.from(key, 'base64');
    if (decoded.length > 0) {
      const digest = crypto.createHash('sha256').update(decoded).digest();
      const id = hashToExtensionId(digest);
      return normalizeExtensionPackageId(id);
    }
  }

  const hint = String(extensionIdHint || '').trim();
  if (hint) {
    return normalizeExtensionPackageId(hint);
  }

  const fallbackId = deriveFallbackExtensionId(manifest);
  if (fallbackId) {
    return fallbackId;
  }

  throw new Error('Cannot resolve extensionId: key/hint/fallback are all unavailable.');
}

export function hashToExtensionId(hash: Buffer): string {
  const first16Bytes = hash.subarray(0, 16);
  let out = '';
  for (const byte of first16Bytes) {
    out += String.fromCharCode(97 + ((byte >> 4) & 0x0f));
    out += String.fromCharCode(97 + (byte & 0x0f));
  }
  return out;
}

export function deriveFallbackExtensionId(manifest: Record<string, unknown>): string | null {
  const sanitized = sanitizeManifestForId(manifest);
  const serialized = JSON.stringify(sanitized);
  if (!serialized || serialized === '{}') {
    return null;
  }
  const digest = crypto.createHash('sha256').update(serialized).digest();
  return normalizeExtensionPackageId(hashToExtensionId(digest));
}

export function sanitizeManifestForId(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeManifestForId(item));
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
    out[key] = sanitizeManifestForId(src[key]);
  }
  return out;
}

export async function findManifestRootDir(rootDir: string): Promise<string | null> {
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

export async function safeExtractZip(zip: AdmZip, targetDir: string): Promise<void> {
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

export async function packExtractDirToBase64(
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

export function decodeBase64Archive(value: string, extensionId: string): Buffer {
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
