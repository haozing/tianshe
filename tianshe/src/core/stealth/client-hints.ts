import type { BrowserFingerprint } from './types';

export interface UserAgentMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
}

export interface LowEntropyClientHintsHeaders {
  'Sec-CH-UA': string;
  'Sec-CH-UA-Mobile': string;
  'Sec-CH-UA-Platform': string;
}

export interface HighEntropyClientHintsHeaders {
  'Sec-CH-UA-Full-Version'?: string;
  'Sec-CH-UA-Full-Version-List'?: string;
  'Sec-CH-UA-Platform-Version'?: string;
  'Sec-CH-UA-Arch'?: string;
  'Sec-CH-UA-Bitness'?: string;
  'Sec-CH-UA-Model'?: string;
  'Sec-CH-UA-WoW64'?: string;
}

interface ClientHintsData {
  brandsMajor: Array<{ brand: string; version: string }>;
  brandsFull: Array<{ brand: string; version: string }>;
  fullVersion: string;
  platform: 'Windows' | 'macOS' | 'Linux';
  platformVersion: string;
  mobile: boolean;
  architecture: string;
  model: string;
  bitness: string;
  wow64: boolean;
}

function detectPlatform(ua: string): ClientHintsData['platform'] {
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac')) return 'macOS';
  return 'Linux';
}

function normalizeArchSource(ua: string, platformHint?: string): string {
  return `${ua} ${platformHint || ''}`.toLowerCase();
}

function detectArchitecture(ua: string, platformHint?: string): string {
  const source = normalizeArchSource(ua, platformHint);
  if (source.includes('arm64') || source.includes('aarch64')) return 'arm';
  if (source.includes('arm')) return 'arm';
  if (
    source.includes('x86_64') ||
    source.includes('x64') ||
    source.includes('amd64') ||
    source.includes('win64')
  ) {
    return 'x86';
  }
  if (source.includes('i686') || source.includes('x86')) return 'x86';
  return 'x86';
}

function detectWow64(ua: string): boolean {
  return /\bWOW64\b/i.test(ua);
}

function detectBitness(ua: string, platformHint?: string, wow64?: boolean): string {
  if (wow64) return '32';
  const source = normalizeArchSource(ua, platformHint);
  if (source.includes('arm64') || source.includes('aarch64')) return '64';
  if (
    source.includes('x86_64') ||
    source.includes('x64') ||
    source.includes('amd64') ||
    source.includes('win64')
  ) {
    return '64';
  }
  if (source.includes('i686') || source.includes('x86')) return '32';
  return '64';
}

function parseWindowsPlatformVersion(ua: string): string | null {
  const match = ua.match(/Windows NT (\d+)\.(\d+)/);
  if (!match) return null;
  const major = match[1];
  const minor = match[2];
  return `${major}.${minor}.0`;
}

function parseMacPlatformVersion(ua: string): string | null {
  const match = ua.match(/Mac OS X (\d+)[_.](\d+)(?:[_.](\d+))?/);
  if (!match) return null;
  const major = match[1];
  const minor = match[2];
  const patch = match[3] || '0';
  return `${major}.${minor}.${patch}`;
}

function platformVersionFromUA(platform: ClientHintsData['platform'], ua: string): string {
  if (platform === 'Windows') {
    return parseWindowsPlatformVersion(ua) || '10.0.0';
  }
  if (platform === 'macOS') {
    return parseMacPlatformVersion(ua) || '14.0.0';
  }
  return '6.5.0';
}

function getChromeFullVersion(ua: string): string {
  const match = ua.match(/Chrome\/(\d+(?:\.\d+){0,3})/);
  return match?.[1] || '120.0.0.0';
}

function getEdgeFullVersion(ua: string): string | null {
  const match = ua.match(/Edg\/(\d+(?:\.\d+){0,3})/);
  return match?.[1] || null;
}

function majorFromFullVersion(fullVersion: string): string {
  const match = fullVersion.match(/^(\d+)/);
  return match?.[1] || '120';
}

function buildClientHintsData(fingerprint: BrowserFingerprint): ClientHintsData {
  const ua = fingerprint.userAgent;
  const platform = detectPlatform(ua);
  const overridePlatformVersion =
    typeof fingerprint.platformVersion === 'string' && fingerprint.platformVersion.trim()
      ? fingerprint.platformVersion.trim()
      : '';
  const platformVersion = overridePlatformVersion || platformVersionFromUA(platform, ua);
  const wow64 = detectWow64(ua);
  const architecture = detectArchitecture(ua, fingerprint.platform);
  const bitness = detectBitness(ua, fingerprint.platform, wow64);

  const isEdge = ua.includes('Edg/');
  const chromeFullVersion = getChromeFullVersion(ua);
  const edgeFullVersion = getEdgeFullVersion(ua);

  const chosenFullVersion = (isEdge ? edgeFullVersion : null) || chromeFullVersion;
  const chosenMajorVersion = majorFromFullVersion(chosenFullVersion);

  const brandsMajor: Array<{ brand: string; version: string }> = [
    { brand: 'Not_A Brand', version: '8' },
    { brand: 'Chromium', version: majorFromFullVersion(chromeFullVersion) },
    {
      brand: isEdge ? 'Microsoft Edge' : 'Google Chrome',
      version: chosenMajorVersion,
    },
  ];

  const brandsFull: Array<{ brand: string; version: string }> = [
    { brand: 'Not_A Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: chromeFullVersion },
    {
      brand: isEdge ? 'Microsoft Edge' : 'Google Chrome',
      version: chosenFullVersion,
    },
  ];

  return {
    brandsMajor,
    brandsFull,
    fullVersion: chosenFullVersion,
    platform,
    platformVersion,
    mobile: /\bMobile\b/i.test(ua),
    architecture,
    model: '',
    bitness,
    wow64,
  };
}

function serializeSecChUa(brands: Array<{ brand: string; version: string }>): string {
  return brands
    .map((b) => {
      const escapedBrand = b.brand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const escapedVersion = b.version.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${escapedBrand}";v="${escapedVersion}"`;
    })
    .join(', ');
}

function normalizeClientHintToken(token: string): string {
  return token
    .trim()
    .replace(/^"+|"+$/g, '')
    .toLowerCase();
}

export function buildUserAgentMetadata(fingerprint: BrowserFingerprint): UserAgentMetadata {
  const data = buildClientHintsData(fingerprint);
  return {
    brands: data.brandsMajor,
    fullVersionList: data.brandsFull,
    fullVersion: data.fullVersion,
    platform: data.platform,
    platformVersion: data.platformVersion,
    architecture: data.architecture,
    model: data.model,
    mobile: data.mobile,
    bitness: data.bitness,
    wow64: data.wow64,
  };
}

export function buildLowEntropyClientHintsHeaders(
  fingerprint: BrowserFingerprint
): LowEntropyClientHintsHeaders {
  const data = buildClientHintsData(fingerprint);

  return {
    'Sec-CH-UA': serializeSecChUa(data.brandsMajor),
    'Sec-CH-UA-Mobile': data.mobile ? '?1' : '?0',
    'Sec-CH-UA-Platform': `"${data.platform}"`,
  };
}

export function buildHighEntropyClientHintsHeaders(
  fingerprint: BrowserFingerprint,
  requested?: string[]
): HighEntropyClientHintsHeaders {
  const data = buildClientHintsData(fingerprint);
  const headers: HighEntropyClientHintsHeaders = {
    'Sec-CH-UA-Full-Version': `"${data.fullVersion}"`,
    'Sec-CH-UA-Full-Version-List': serializeSecChUa(data.brandsFull),
    'Sec-CH-UA-Platform-Version': `"${data.platformVersion}"`,
    'Sec-CH-UA-Arch': `"${data.architecture}"`,
    'Sec-CH-UA-Bitness': `"${data.bitness}"`,
    'Sec-CH-UA-Model': `"${data.model}"`,
    'Sec-CH-UA-WoW64': data.wow64 ? '?1' : '?0',
  };

  if (!requested || requested.length === 0) {
    return headers;
  }

  const requestedSet = new Set(requested.map(normalizeClientHintToken));
  const filtered: HighEntropyClientHintsHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (requestedSet.has(key.toLowerCase())) {
      filtered[key as keyof HighEntropyClientHintsHeaders] = value;
    }
  }

  return filtered;
}
