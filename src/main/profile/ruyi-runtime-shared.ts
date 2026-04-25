import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  resolveFirefoxExecutablePathOverride,
  resolveUserDataDir,
} from '../../constants/runtime-config';
import { mergeFingerprintConfig } from '../../constants/fingerprint-defaults';
import type { SessionConfig } from '../../core/browser-pool/types';
import {
  type FingerprintConfig,
  type ProxyConfig,
} from '../../types/profile';
import { getDefaultFingerprint } from './presets';
import { materializeFirefoxNativeFingerprint } from './native-fingerprint/native-firefox-fpfile';
import {
  type NativeFingerprintPayload,
  toNativeFingerprintText,
} from './native-fingerprint/native-fingerprint-shared';

export interface PreparedRuyiFirefoxLaunch {
  sessionId: string;
  browserPath: string;
  userDataDir: string;
  runtimeDir: string;
  downloadDir: string;
  fpfilePath?: string;
  proxyUrl?: string;
  fingerprint: FingerprintConfig;
  acceptLanguage?: string;
  startHidden?: boolean;
}

export type FirefoxUserPrefValue = string | number | boolean;

function getUserDataBaseDir(): string {
  return resolveUserDataDir(app.getPath('userData'));
}

export function getFirefoxBaseDir(): string {
  return path.join(getUserDataBaseDir(), 'firefox');
}

export function getFirefoxUserDataDir(sessionId: string): string {
  return path.join(getFirefoxBaseDir(), 'profiles', sessionId);
}

export function getFirefoxRuntimeDir(sessionId: string): string {
  return path.join(getFirefoxBaseDir(), 'runtime', sessionId);
}

export function getFirefoxDownloadDir(sessionId: string): string {
  return path.join(getFirefoxRuntimeDir(sessionId), 'downloads');
}

function buildFpfileText(payload: NativeFingerprintPayload): string {
  return toNativeFingerprintText(payload);
}

function buildProxyUrl(proxy: ProxyConfig | null | undefined): string | undefined {
  if (!proxy || proxy.type === 'none') {
    return undefined;
  }
  const host = String(proxy.host || '').trim();
  const port = Number.parseInt(String(proxy.port ?? ''), 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('invalid proxy config for ruyi engine');
  }
  return `${proxy.type}://${host}:${port}`;
}

function buildAcceptLanguageHeader(fingerprint: FingerprintConfig): string | undefined {
  const languages = Array.isArray(fingerprint.identity.region.languages)
    ? fingerprint.identity.region.languages.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (languages.length === 0) {
    return undefined;
  }

  return languages
    .map((language, index) => {
      if (index === 0) {
        return language;
      }
      const quality = Math.max(0.1, 1 - index * 0.1).toFixed(1);
      return `${language};q=${quality}`;
    })
    .join(', ');
}

export function resolveFirefoxExecutablePath(): string {
  const override = resolveFirefoxExecutablePathOverride();
  if (override) {
    return override;
  }

  const candidates: string[] = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'firefox', 'firefox.exe'));
  } else {
    candidates.push(
      path.join(app.getAppPath(), 'firefox', 'firefox.exe'),
      path.join(process.cwd(), 'firefox', 'firefox.exe')
    );
  }

  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Firefox.app/Contents/MacOS/firefox');
  } else {
    candidates.push('/usr/bin/firefox', '/snap/bin/firefox', 'firefox');
  }

  for (const candidate of candidates) {
    if (candidate === 'firefox' || fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] || 'firefox';
}

function assertFirefoxExecutablePath(browserPath: string): string {
  const normalizedPath = String(browserPath || '').trim();
  if (!normalizedPath) {
    throw new Error('Ruyi Firefox runtime path is empty');
  }
  if (!path.isAbsolute(normalizedPath)) {
    return normalizedPath;
  }
  if (!fs.existsSync(normalizedPath)) {
    throw new Error(`Ruyi Firefox runtime not found: ${normalizedPath}`);
  }
  if (!fs.statSync(normalizedPath).isFile()) {
    throw new Error(`Ruyi Firefox runtime path is not a file: ${normalizedPath}`);
  }
  return normalizedPath;
}

export function prepareRuyiFirefoxFpfile(session: SessionConfig): string | undefined {
  if (!session.fingerprint) {
    return undefined;
  }

  const runtimeDir = getFirefoxRuntimeDir(session.id);
  fs.mkdirSync(runtimeDir, { recursive: true });

  const payload: NativeFingerprintPayload = materializeFirefoxNativeFingerprint(
    session.fingerprint.identity
  );

  const proxy = session.proxy;
  if (proxy?.username) {
    payload['httpauth.username'] = proxy.username;
  }
  if (proxy?.password) {
    payload['httpauth.password'] = proxy.password;
  }

  const fpfilePath = path.join(runtimeDir, 'fingerprint.fpfile.txt');
  fs.writeFileSync(fpfilePath, buildFpfileText(payload), 'utf8');
  return fpfilePath;
}

function parseProxyUrl(proxyUrl: string): { scheme: string; host: string; port: number } | null {
  try {
    const url = new URL(proxyUrl);
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    const host = url.hostname;
    const port = Number.parseInt(url.port || '', 10);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    return { scheme, host, port };
  } catch {
    return null;
  }
}

function escapeUserPrefString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildRuyiFirefoxPrefs(options: {
  profilePath: string;
  downloadDir: string;
  proxyUrl?: string;
  extraPrefs?: Record<string, FirefoxUserPrefValue>;
}): Record<string, FirefoxUserPrefValue> {
  const prefs: Record<string, FirefoxUserPrefValue> = {
    'remote.prefs.recommended': true,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.tabs.warnOnClose': false,
    'browser.warnOnQuit': false,
    'marionette.enabled': true,
    'browser.download.dir': options.downloadDir,
    'browser.download.folderList': 2,
    'browser.download.useDownloadDir': true,
    'prompts.modalType.prompt': 3,
  };

  const parsedProxy = options.proxyUrl ? parseProxyUrl(options.proxyUrl) : null;
  if (parsedProxy) {
    if (parsedProxy.scheme.startsWith('socks')) {
      prefs['network.proxy.type'] = 1;
      prefs['network.proxy.socks'] = parsedProxy.host;
      prefs['network.proxy.socks_port'] = parsedProxy.port;
      prefs['network.proxy.socks_version'] = parsedProxy.scheme.includes('5') ? 5 : 4;
    } else {
      prefs['network.proxy.type'] = 1;
      prefs['network.proxy.http'] = parsedProxy.host;
      prefs['network.proxy.http_port'] = parsedProxy.port;
      prefs['network.proxy.ssl'] = parsedProxy.host;
      prefs['network.proxy.ssl_port'] = parsedProxy.port;
      prefs['signon.autologin.proxy'] = true;
      prefs['network.auth.subresource-http-auth-allow'] = 2;
    }
  }

  if (options.extraPrefs) {
    for (const [key, value] of Object.entries(options.extraPrefs)) {
      prefs[key] = value;
    }
  }

  return prefs;
}

export function writeRuyiFirefoxUserPrefs(options: {
  profilePath: string;
  downloadDir: string;
  proxyUrl?: string;
  extraPrefs?: Record<string, FirefoxUserPrefValue>;
}): string {
  const prefs = buildRuyiFirefoxPrefs(options);
  fs.mkdirSync(options.profilePath, { recursive: true });
  fs.mkdirSync(options.downloadDir, { recursive: true });

  const userJsPath = path.join(options.profilePath, 'user.js');
  const content = Object.entries(prefs)
    .map(([key, value]) => {
      if (typeof value === 'boolean') {
        return `user_pref("${key}", ${value ? 'true' : 'false'});`;
      }
      if (typeof value === 'number') {
        return `user_pref("${key}", ${value});`;
      }
      return `user_pref("${key}", "${escapeUserPrefString(value)}");`;
    })
    .join('\n');

  fs.writeFileSync(userJsPath, `${content}\n`, 'utf8');
  return userJsPath;
}

export function buildRuyiFirefoxLaunchArgs(options: {
  prepared: PreparedRuyiFirefoxLaunch;
  remoteDebuggingPort: number;
  headless?: boolean;
  privateMode?: boolean;
}): string[] {
  const { prepared, remoteDebuggingPort } = options;
  const args = [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    '--remote-allow-system-access',
    '--no-remote',
    '--marionette',
    '--profile',
    prepared.userDataDir,
  ];

  if (options.headless === true) {
    args.push('--headless');
  }
  if (options.privateMode === true) {
    args.push('-private');
  }
  if (prepared.fpfilePath) {
    args.push(`--fpfile=${prepared.fpfilePath}`);
  }

  const width = Math.max(0, Math.trunc(prepared.fingerprint.identity.display.width ?? 0));
  const height = Math.max(0, Math.trunc(prepared.fingerprint.identity.display.height ?? 0));
  if (width > 0 && height > 0) {
    args.push(`--width=${width}`);
    args.push(`--height=${height}`);
  }

  return args;
}

export function prepareRuyiFirefoxLaunch(
  session: SessionConfig,
  options?: { startHidden?: boolean }
): PreparedRuyiFirefoxLaunch {
  const fingerprint = mergeFingerprintConfig(getDefaultFingerprint('ruyi'), session.fingerprint || {});
  const normalizedSession: SessionConfig = {
    ...session,
    fingerprint,
  };
  const userDataDir = getFirefoxUserDataDir(session.id);
  const runtimeDir = getFirefoxRuntimeDir(session.id);
  const downloadDir = getFirefoxDownloadDir(session.id);

  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });

  const proxyUrl = buildProxyUrl(session.proxy);
  const acceptLanguage = buildAcceptLanguageHeader(fingerprint);
  writeRuyiFirefoxUserPrefs({
    profilePath: userDataDir,
    downloadDir,
    proxyUrl,
    extraPrefs: acceptLanguage
      ? {
          'intl.accept_languages': acceptLanguage,
        }
      : undefined,
  });

  return {
    sessionId: session.id,
    browserPath: assertFirefoxExecutablePath(resolveFirefoxExecutablePath()),
    userDataDir,
    runtimeDir,
    downloadDir,
    fpfilePath: prepareRuyiFirefoxFpfile(normalizedSession),
    proxyUrl,
    fingerprint,
    acceptLanguage,
    startHidden: options?.startHidden,
  };
}
