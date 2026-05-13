import type { BrowserRuntimeId } from '../../types/browser-runtime';

const NON_RETRYABLE_RUNTIME_CREATE_PATTERNS: Partial<Record<BrowserRuntimeId, string[]>> = {
  'chromium-extension-relay': [
    'Extension bundled chrome.exe not found',
    'Extension runtime path is not a file',
    'chrome.exe version mismatch',
    'chrome.exe version prefix mismatch',
    'chrome.exe sha256 mismatch',
    'missing required extensions for session',
  ],
  'firefox-bidi': [
    'Ruyi Firefox runtime path is empty',
    'Ruyi Firefox runtime not found',
    'Ruyi Firefox runtime path is not a file',
    'invalid proxy config for firefox-bidi runtime',
  ],
  'chromium-cloak-playwright': [
    'CloakBrowser runtime is not installed',
    'CloakBrowser executable not found',
    'cloakbrowser package is not installed',
  ],
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isNonRetryableRuntimeCreateError(
  runtimeId: BrowserRuntimeId | null | undefined,
  error: unknown
): boolean {
  if (!runtimeId) {
    return false;
  }

  const patterns = NON_RETRYABLE_RUNTIME_CREATE_PATTERNS[runtimeId];
  if (!patterns || patterns.length === 0) {
    return false;
  }

  const message = getErrorMessage(error);
  return patterns.some((pattern) => message.includes(pattern));
}
