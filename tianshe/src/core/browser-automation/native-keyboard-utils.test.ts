import { describe, expect, it } from 'vitest';
import {
  getSelectAllKeyModifiers,
  resolveNativeKeyboardPlatform,
} from './native-keyboard-utils';

describe('native-keyboard-utils', () => {
  it('uses meta for select-all shortcuts on macOS', () => {
    expect(getSelectAllKeyModifiers('darwin')).toEqual(['meta']);
  });

  it('uses control for select-all shortcuts on non-mac platforms', () => {
    expect(getSelectAllKeyModifiers('win32')).toEqual(['control']);
    expect(getSelectAllKeyModifiers('linux')).toEqual(['control']);
  });

  it('falls back to navigator fingerprint when process.platform is unavailable', () => {
    expect(
      resolveNativeKeyboardPlatform({
        processPlatform: '',
        navigatorPlatform: 'MacIntel',
        navigatorUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      })
    ).toBe('darwin');
    expect(
      resolveNativeKeyboardPlatform({
        processPlatform: '',
        navigatorPlatform: 'Win32',
        navigatorUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      })
    ).toBe('win32');
  });
});
