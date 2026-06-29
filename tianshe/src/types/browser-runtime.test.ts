import { describe, expect, it } from 'vitest';
import {
  BROWSER_RUNTIME_IDS,
  isBrowserRuntimeId,
  isPersistentBrowserRuntimeId,
  normalizeProfileBrowserQuota,
  normalizeBrowserRuntimeId,
  PERSISTENT_BROWSER_RUNTIME_IDS,
  PROFILE_BROWSER_INSTANCE_LIMIT,
} from './browser-runtime';

describe('browser runtime helpers', () => {
  it('exposes the supported runtime ids from one place', () => {
    expect(BROWSER_RUNTIME_IDS).toEqual([
      'electron-webcontents',
      'chromium-extension-relay',
      'firefox-bidi',
      'chromium-cloak-playwright',
    ]);
    expect(PERSISTENT_BROWSER_RUNTIME_IDS).toEqual([
      'electron-webcontents',
      'chromium-extension-relay',
      'firefox-bidi',
      'chromium-cloak-playwright',
    ]);
  });

  it('recognizes valid browser runtimes', () => {
    expect(isBrowserRuntimeId('electron-webcontents')).toBe(true);
    expect(isBrowserRuntimeId('chromium-extension-relay')).toBe(true);
    expect(isBrowserRuntimeId('firefox-bidi')).toBe(true);
    expect(isBrowserRuntimeId('chromium-cloak-playwright')).toBe(true);
    expect(isBrowserRuntimeId('firefox')).toBe(false);
    expect(isBrowserRuntimeId(null)).toBe(false);
  });

  it('normalizes unknown runtime values to electron-webcontents by default', () => {
    expect(normalizeBrowserRuntimeId('electron-webcontents')).toBe('electron-webcontents');
    expect(normalizeBrowserRuntimeId('chromium-extension-relay')).toBe('chromium-extension-relay');
    expect(normalizeBrowserRuntimeId('firefox-bidi')).toBe('firefox-bidi');
    expect(normalizeBrowserRuntimeId('chromium-cloak-playwright')).toBe(
      'chromium-cloak-playwright'
    );
    expect(normalizeBrowserRuntimeId('firefox')).toBe('electron-webcontents');
    expect(normalizeBrowserRuntimeId(undefined)).toBe('electron-webcontents');
    expect(normalizeBrowserRuntimeId('firefox', 'firefox-bidi')).toBe('firefox-bidi');
  });

  it('marks profile-backed runtimes as persistent', () => {
    expect(isPersistentBrowserRuntimeId('electron-webcontents')).toBe(true);
    expect(isPersistentBrowserRuntimeId('chromium-extension-relay')).toBe(true);
    expect(isPersistentBrowserRuntimeId('firefox-bidi')).toBe(true);
    expect(isPersistentBrowserRuntimeId('chromium-cloak-playwright')).toBe(true);
    expect(isPersistentBrowserRuntimeId(undefined)).toBe(false);
  });

  it('exposes the per-profile single-instance limit from one place', () => {
    expect(PROFILE_BROWSER_INSTANCE_LIMIT).toBe(1);
  });

  it('normalizes every profile quota to a single live browser instance', () => {
    expect(normalizeProfileBrowserQuota(4)).toEqual({
      quota: 1,
      forced: true,
      reason: 'single-profile-browser-instance',
    });
    expect(normalizeProfileBrowserQuota(1)).toEqual({
      quota: 1,
      forced: false,
      reason: null,
    });
  });
});
