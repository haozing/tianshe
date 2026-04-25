import type { AutomationEngine } from '../../types/automation-engine';

const NON_RETRYABLE_ENGINE_CREATE_PATTERNS: Partial<Record<AutomationEngine, string[]>> = {
  extension: [
    'Extension bundled chrome.exe not found',
    'Extension runtime path is not a file',
    'chrome.exe version mismatch',
    'chrome.exe version prefix mismatch',
    'chrome.exe sha256 mismatch',
    'missing required extensions for session',
  ],
  ruyi: [
    'Ruyi Firefox runtime path is empty',
    'Ruyi Firefox runtime not found',
    'Ruyi Firefox runtime path is not a file',
    'invalid proxy config for ruyi engine',
  ],
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isNonRetryableEngineCreateError(
  engine: AutomationEngine | null | undefined,
  error: unknown
): boolean {
  if (!engine) {
    return false;
  }

  const patterns = NON_RETRYABLE_ENGINE_CREATE_PATTERNS[engine];
  if (!patterns || patterns.length === 0) {
    return false;
  }

  const message = getErrorMessage(error);
  return patterns.some((pattern) => message.includes(pattern));
}
