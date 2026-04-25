import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { SessionConfig } from '../../core/browser-pool/types';
import { getFingerprintPreflightIssues as getCanonicalFingerprintPreflightIssues } from '../../core/fingerprint/fingerprint-validation';
import { AIRPA_RUNTIME_CONFIG, resolveUserDataDir } from '../../constants/runtime-config';

export type ChromeLaunchProxy = {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
};

export type ManagedLaunchExtension = {
  extensionId: string;
  extractDir: string;
  installMode: 'required' | 'optional';
};

const SEMVER_4_PARTS_REGEX = /^\d+\.\d+\.\d+\.\d+$/;
const DISABLE_BLINK_FEATURES_PREFIX = '--disable-blink-features=';
const AUTOMATION_CONTROLLED_FEATURE = 'AutomationControlled';

const chromeValidationCache = new Map<
  string,
  {
    detectedVersion: string | null;
    sha256: string | null;
  }
>();
const warnedUnpinnedChromeRuntimePaths = new Set<string>();

export function getUserDataBaseDir(): string {
  return resolveUserDataDir(app.getPath('userData'));
}

export function getExtensionUserDataDir(sessionId: string): string {
  return path.join(getUserDataBaseDir(), 'extension', 'chrome', 'profiles', sessionId);
}

export function getExtensionRuyiDir(sessionId: string): string {
  return path.join(getUserDataBaseDir(), 'extension', 'chrome', 'ruyi', sessionId);
}

export function getExtensionControlRuntimeDir(sessionId: string, browserId: string): string {
  return path.join(getUserDataBaseDir(), 'extension', 'chrome', 'control-runtime', sessionId, browserId);
}

export function resolveChromeExecutablePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'chrome', 'chrome.exe');
  }

  const candidates = [
    path.join(app.getAppPath(), 'chrome', 'chrome.exe'),
    path.join(process.cwd(), 'chrome', 'chrome.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export function parseExtraChromeLaunchArgs(): string[] {
  return Array.from(
    new Set(
      AIRPA_RUNTIME_CONFIG.extension.extraLaunchArgs
        .map((arg) => String(arg).trim())
        .filter((arg) => arg.length > 0 && !arg.toLowerCase().startsWith('--ruyi='))
    )
  );
}

export function buildManagedExtensionLaunchArgs(extensions: ManagedLaunchExtension[]): string[] {
  if (extensions.length === 0) return [];

  const paths = Array.from(
    new Set(
      extensions
        .map((item) => String(item.extractDir || '').trim())
        .filter((item) => item.length > 0 && fs.existsSync(item))
    )
  );
  if (paths.length === 0) return [];

  const joined = paths.join(',');
  return [`--disable-extensions-except=${joined}`, `--load-extension=${joined}`];
}

export function buildChromeLaunchArgs(
  extraLaunchArgs: string[],
  managedExtensionArgs: string[],
  additionalArgs: string[] = []
): string[] {
  const dedupedArgs = Array.from(
    new Set([...extraLaunchArgs, ...managedExtensionArgs, ...additionalArgs])
  );
  const launchArgs: string[] = [];
  let mergedDisableBlinkFeatures = false;

  for (const arg of dedupedArgs) {
    if (arg.toLowerCase().startsWith(DISABLE_BLINK_FEATURES_PREFIX)) {
      const features = Array.from(
        new Set(
          arg
            .slice(DISABLE_BLINK_FEATURES_PREFIX.length)
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        )
      );
      if (!features.includes(AUTOMATION_CONTROLLED_FEATURE)) {
        features.push(AUTOMATION_CONTROLLED_FEATURE);
      }
      launchArgs.push(`${DISABLE_BLINK_FEATURES_PREFIX}${features.join(',')}`);
      mergedDisableBlinkFeatures = true;
      continue;
    }
    launchArgs.push(arg);
  }

  if (!mergedDisableBlinkFeatures) {
    launchArgs.unshift(`${DISABLE_BLINK_FEATURES_PREFIX}${AUTOMATION_CONTROLLED_FEATURE}`);
  }

  return launchArgs;
}

export function buildExtensionIgnoreDefaultArgs(managedExtensionsCount: number): string[] {
  const ignoreDefaultArgs = new Set<string>(['--enable-automation']);
  if (managedExtensionsCount > 0) {
    ignoreDefaultArgs.add('--disable-extensions');
  }
  return Array.from(ignoreDefaultArgs);
}

export function resolveExtensionProxy(session: SessionConfig): ChromeLaunchProxy | undefined {
  const proxy = session.proxy;
  if (!proxy || proxy.type === 'none') return undefined;

  const host = String(proxy.host || '').trim();
  const port = Number.parseInt(String(proxy.port ?? ''), 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid proxy config for session ${session.id}`);
  }

  const result: ChromeLaunchProxy = {
    server: `${proxy.type}://${host}:${port}`,
  };
  const username = typeof proxy.username === 'string' ? proxy.username.trim() : '';
  const password = typeof proxy.password === 'string' ? proxy.password.trim() : '';
  const bypass = typeof proxy.bypassList === 'string' ? proxy.bypassList.trim() : '';

  if (username) result.username = username;
  if (password) result.password = password;
  if (bypass) result.bypass = bypass;

  return result;
}

export function buildNativeChromeProxyArgs(session: SessionConfig): string[] {
  const proxy = session.proxy;
  if (!proxy || proxy.type === 'none') {
    return [];
  }

  const host = String(proxy.host || '').trim();
  const port = Number.parseInt(String(proxy.port ?? ''), 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid proxy config for session ${session.id}`);
  }

  const args = [`--proxy-server=${proxy.type}://${host}:${port}`];
  const bypassList = typeof proxy.bypassList === 'string' ? proxy.bypassList.trim() : '';
  if (bypassList) {
    args.push(`--proxy-bypass-list=${bypassList}`);
  }
  return args;
}

function getChromeValidationCacheKey(chromePath: string): string {
  const stat = fs.statSync(chromePath);
  return `${chromePath}:${stat.size}:${stat.mtimeMs}`;
}

function compareVersionParts(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10));
  const right = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 4; index += 1) {
    const leftValue = Number.isFinite(left[index]) ? left[index] : 0;
    const rightValue = Number.isFinite(right[index]) ? right[index] : 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function detectChromeVersionByDirectory(chromePath: string): string | null {
  try {
    const parent = path.dirname(chromePath);
    const versions = fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SEMVER_4_PARTS_REGEX.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersionParts);

    return versions.length > 0 ? versions[versions.length - 1] : null;
  } catch {
    return null;
  }
}

async function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function validateChromeRuntime(chromePath: string): Promise<void> {
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Extension bundled chrome.exe not found: ${chromePath}.`);
  }

  const stat = fs.statSync(chromePath);
  if (!stat.isFile()) {
    throw new Error(`Extension runtime path is not a file: ${chromePath}`);
  }

  const cacheKey = getChromeValidationCacheKey(chromePath);
  if (chromeValidationCache.has(cacheKey)) {
    return;
  }

  const detectedVersion = detectChromeVersionByDirectory(chromePath);
  const expectedVersion = AIRPA_RUNTIME_CONFIG.extension.expectedChromeVersion.trim();
  const expectedVersionPrefix = AIRPA_RUNTIME_CONFIG.extension.expectedChromeVersionPrefix.trim();
  const expectedHash = AIRPA_RUNTIME_CONFIG.extension.expectedChromeSha256.trim().toLowerCase();
  const runtimePinned =
    expectedVersion.length > 0 || expectedVersionPrefix.length > 0 || expectedHash.length > 0;

  if (!runtimePinned && !warnedUnpinnedChromeRuntimePaths.has(chromePath)) {
    warnedUnpinnedChromeRuntimePaths.add(chromePath);
    const detectedLabel = detectedVersion ? ` version=${detectedVersion}` : '';
    console.warn(
      `[ExtensionFactory] Chrome runtime compatibility is unpinned for ${chromePath}${detectedLabel}. The current local Chromium build has passed real-page --ruyi startup verification, but future runtime swaps must be revalidated.`
    );
  }

  if (expectedVersion) {
    if (!detectedVersion) {
      throw new Error(
        `Unable to detect chrome.exe version for ${chromePath} while runtime-config extension.expectedChromeVersion is set.`
      );
    }
    if (detectedVersion !== expectedVersion) {
      throw new Error(
        `chrome.exe version mismatch: expected ${expectedVersion}, actual ${detectedVersion}`
      );
    }
  }

  if (expectedVersionPrefix) {
    if (!detectedVersion) {
      throw new Error(
        `Unable to detect chrome.exe version for ${chromePath} while runtime-config extension.expectedChromeVersionPrefix is set.`
      );
    }
    if (!detectedVersion.startsWith(expectedVersionPrefix)) {
      throw new Error(
        `chrome.exe version prefix mismatch: expected prefix ${expectedVersionPrefix}, actual ${detectedVersion}`
      );
    }
  }

  let computedHash: string | null = null;
  if (expectedHash) {
    computedHash = (await computeSha256(chromePath)).toLowerCase();
    if (computedHash !== expectedHash) {
      throw new Error(
        `chrome.exe sha256 mismatch: expected ${expectedHash}, actual ${computedHash}`
      );
    }
  }

  chromeValidationCache.set(cacheKey, {
    detectedVersion,
    sha256: computedHash,
  });
}

export function getFingerprintPreflightIssues(session: SessionConfig): string[] {
  return getCanonicalFingerprintPreflightIssues(session.fingerprint, session.engine);
}

