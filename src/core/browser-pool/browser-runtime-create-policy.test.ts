import { describe, expect, it } from 'vitest';
import { isNonRetryableRuntimeCreateError } from './browser-runtime-create-policy';

describe('browser runtime create policy', () => {
  it('treats known extension bootstrap failures as non-retryable', () => {
    expect(
      isNonRetryableRuntimeCreateError(
        'chromium-extension-relay',
        new Error('Extension bundled chrome.exe not found')
      )
    ).toBe(true);
  });

  it('treats known ruyi bootstrap failures as non-retryable', () => {
    expect(
      isNonRetryableRuntimeCreateError(
        'firefox-bidi',
        new Error('Ruyi Firefox runtime not found: C:\\resources\\firefox\\firefox.exe')
      )
    ).toBe(true);
    expect(
      isNonRetryableRuntimeCreateError(
        'firefox-bidi',
        new Error('invalid proxy config for firefox-bidi runtime')
      )
    ).toBe(true);
  });

  it('does not mark unrelated runtime failures as non-retryable', () => {
    expect(
      isNonRetryableRuntimeCreateError(
        'firefox-bidi',
        new Error('Extension bundled chrome.exe not found')
      )
    ).toBe(false);
    expect(
      isNonRetryableRuntimeCreateError(
        'chromium-extension-relay',
        new Error('fingerprint.source.filePath not found for session profile-1')
      )
    ).toBe(false);
    expect(
      isNonRetryableRuntimeCreateError(
        'electron-webcontents',
        new Error('Mock browser creation failed')
      )
    ).toBe(false);
  });
});
