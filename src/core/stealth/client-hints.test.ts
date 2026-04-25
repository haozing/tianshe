import { describe, it, expect } from 'vitest';
import { buildUserAgentMetadata, buildHighEntropyClientHintsHeaders } from './client-hints';
import type { BrowserFingerprint } from './types';

describe('client-hints', () => {
  it('derives macOS platformVersion from UA when available', () => {
    const fingerprint: BrowserFingerprint = {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      languages: ['en-US'],
      timezone: 'America/New_York',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screenResolution: { width: 1920, height: 1080 },
      colorDepth: 24,
      webgl: {
        vendor: 'Google Inc.',
        renderer: 'ANGLE',
        version: 'WebGL 1.0',
      },
      plugins: [],
    };

    const metadata = buildUserAgentMetadata(fingerprint);
    expect(metadata.platform).toBe('macOS');
    expect(metadata.platformVersion).toBe('10.15.7');
  });

  it('derives Windows platformVersion from UA when available', () => {
    const fingerprint: BrowserFingerprint = {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Win32',
      languages: ['en-US'],
      timezone: 'America/New_York',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screenResolution: { width: 1920, height: 1080 },
      colorDepth: 24,
      webgl: {
        vendor: 'Google Inc.',
        renderer: 'ANGLE',
        version: 'WebGL 1.0',
      },
      plugins: [],
    };

    const metadata = buildUserAgentMetadata(fingerprint);
    expect(metadata.platform).toBe('Windows');
    expect(metadata.platformVersion).toBe('10.0.0');
  });

  it('prefers fingerprint platformVersion when provided', () => {
    const fingerprint: BrowserFingerprint = {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      platformVersion: '14.0.0',
      languages: ['en-US'],
      timezone: 'America/New_York',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screenResolution: { width: 1920, height: 1080 },
      colorDepth: 24,
      webgl: {
        vendor: 'Google Inc.',
        renderer: 'ANGLE',
        version: 'WebGL 1.0',
      },
      plugins: [],
    };

    const metadata = buildUserAgentMetadata(fingerprint);
    expect(metadata.platform).toBe('macOS');
    expect(metadata.platformVersion).toBe('14.0.0');
  });

  it('builds high entropy client hints headers for requested tokens', () => {
    const fingerprint: BrowserFingerprint = {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Win32',
      languages: ['en-US'],
      timezone: 'America/New_York',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screenResolution: { width: 1920, height: 1080 },
      colorDepth: 24,
      webgl: {
        vendor: 'Google Inc.',
        renderer: 'ANGLE',
        version: 'WebGL 1.0',
      },
      plugins: [],
    };

    const headers = buildHighEntropyClientHintsHeaders(fingerprint, [
      'Sec-CH-UA-Full-Version',
      'Sec-CH-UA-Platform-Version',
    ]);

    expect(headers['Sec-CH-UA-Full-Version']).toBe('"120.0.0.0"');
    expect(headers['Sec-CH-UA-Platform-Version']).toBe('"10.0.0"');
    expect(headers['Sec-CH-UA-Arch']).toBeUndefined();
  });
});
