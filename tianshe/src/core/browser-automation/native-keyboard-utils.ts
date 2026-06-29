export type NativeKeyModifier = 'shift' | 'control' | 'alt' | 'meta';

export function resolveNativeKeyboardPlatform(options?: {
  processPlatform?: string | null;
  navigatorPlatform?: string | null;
  navigatorUserAgent?: string | null;
}): string {
  const processPlatform = String(
    options?.processPlatform ??
      (typeof process !== 'undefined' && typeof process.platform === 'string'
        ? process.platform
        : '')
  )
    .trim()
    .toLowerCase();
  if (processPlatform) {
    return processPlatform;
  }

  const navigatorPlatform = String(
    options?.navigatorPlatform ??
      (typeof navigator !== 'undefined' && typeof navigator.platform === 'string'
        ? navigator.platform
        : '')
  )
    .trim()
    .toLowerCase();
  const navigatorUserAgent = String(
    options?.navigatorUserAgent ??
      (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : '')
  )
    .trim()
    .toLowerCase();
  const navigatorFingerprint = `${navigatorPlatform} ${navigatorUserAgent}`;

  if (navigatorFingerprint.includes('mac')) {
    return 'darwin';
  }
  if (navigatorFingerprint.includes('win')) {
    return 'win32';
  }

  return 'linux';
}

export function getSelectAllKeyModifiers(
  platform: string = resolveNativeKeyboardPlatform()
): NativeKeyModifier[] {
  return platform === 'darwin' ? ['meta'] : ['control'];
}
