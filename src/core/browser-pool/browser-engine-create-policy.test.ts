import { describe, expect, it } from 'vitest';
import { isNonRetryableEngineCreateError } from './browser-engine-create-policy';

describe('browser engine create policy', () => {
  it('treats known extension bootstrap failures as non-retryable', () => {
    expect(
      isNonRetryableEngineCreateError(
        'extension',
        new Error('Extension bundled chrome.exe not found')
      )
    ).toBe(true);
  });

  it('treats known ruyi bootstrap failures as non-retryable', () => {
    expect(
      isNonRetryableEngineCreateError(
        'ruyi',
        new Error('Ruyi Firefox runtime not found: C:\\resources\\firefox\\firefox.exe')
      )
    ).toBe(true);
    expect(
      isNonRetryableEngineCreateError(
        'ruyi',
        new Error('invalid proxy config for ruyi engine')
      )
    ).toBe(true);
  });

  it('does not mark unrelated engine failures as non-retryable', () => {
    expect(
      isNonRetryableEngineCreateError('ruyi', new Error('Extension bundled chrome.exe not found'))
    ).toBe(false);
    expect(
      isNonRetryableEngineCreateError(
        'extension',
        new Error('fingerprint.source.filePath not found for session profile-1')
      )
    ).toBe(false);
    expect(
      isNonRetryableEngineCreateError('electron', new Error('Mock browser creation failed'))
    ).toBe(false);
  });
});
