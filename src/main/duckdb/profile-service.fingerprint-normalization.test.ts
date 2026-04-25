import { describe, expect, it, vi } from 'vitest';
import { getDefaultFingerprint, mergeFingerprintConfig } from '../../constants/fingerprint-defaults';
import { ProfileService } from './profile-service';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => process.cwd()),
  },
  session: {
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      storagePath: '',
      flushStorageData: vi.fn(),
      cookies: {
        flushStore: vi.fn().mockResolvedValue(undefined),
      },
    })),
  },
}));

describe('ProfileService fingerprint defaults', () => {
  it('builds the system default fingerprint in canonical identity/source shape', () => {
    const service = new ProfileService({} as never);
    const fingerprint = (service as never).buildSystemDefaultFingerprint() as {
      identity: {
        hardware: {
          userAgent: string;
          browserFamily: string;
        };
        region: {
          languages: string[];
        };
      };
      source: {
        mode: string;
        fileFormat: string;
      };
    };

    expect(fingerprint.source).toEqual({
      mode: 'generated',
      fileFormat: 'txt',
    });
    expect(fingerprint.identity.hardware.userAgent).toContain('Mozilla/5.0');
    expect(fingerprint.identity.hardware.browserFamily).toBe('electron');
    expect(fingerprint.identity.region.languages.length).toBeGreaterThan(0);
  });

  it('rejects invalid engine/fingerprint combinations before persistence', () => {
    const service = new ProfileService({} as never);
    const invalidRuyiFingerprint = getDefaultFingerprint('extension');

    expect(() =>
      (service as any).assertValidFingerprintConfig(
        invalidRuyiFingerprint,
        'ruyi',
        'Profile "invalid-ruyi"'
      )
    ).toThrow(/hardware\.userAgent-browser-mismatch:firefox/);
  });

  it('rebuilds fingerprint from target engine defaults while keeping shared fields during engine switches', () => {
    const service = new ProfileService({} as never);
    const existingExtensionFingerprint = mergeFingerprintConfig(getDefaultFingerprint('extension'), {
      identity: {
        region: {
          timezone: 'Asia/Tokyo',
          languages: ['ja-JP', 'ja'],
        },
        hardware: {
          hardwareConcurrency: 12,
          deviceMemory: 16,
        },
        display: {
          width: 2560,
          height: 1440,
        },
        graphics: {
          webgl: {
            maskedVendor: 'Google Inc. (NVIDIA)',
            maskedRenderer:
              'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
          },
        },
      },
    });

    const fingerprint = (service as any).buildFingerprintForPersistence('ruyi', {
      fallbackSharedFingerprint: existingExtensionFingerprint,
    }) as ReturnType<typeof getDefaultFingerprint>;

    expect(fingerprint.identity.hardware.browserFamily).toBe('firefox');
    expect(fingerprint.identity.hardware.userAgent).toContain('Firefox/151.0');
    expect(fingerprint.identity.region).toMatchObject({
      timezone: 'Asia/Tokyo',
      primaryLanguage: 'ja-JP',
      languages: ['ja-JP', 'ja'],
    });
    expect(fingerprint.identity.hardware).toMatchObject({
      osFamily: existingExtensionFingerprint.identity.hardware.osFamily,
      hardwareConcurrency: 12,
      deviceMemory: 16,
      platform: 'Win32',
    });
    expect(fingerprint.identity.display).toMatchObject({
      width: 2560,
      height: 1440,
      availWidth: 2560,
      availHeight: 1400,
      pixelRatio: undefined,
    });
    expect(fingerprint.identity.graphics?.webgl).toMatchObject({
      maskedVendor: 'Google Inc. (NVIDIA)',
      maskedRenderer:
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
    });
    expect(fingerprint.identity.automationSignals).toEqual({
      webdriver: 0,
    });
  });

  it('prefers fingerprintCore when rebuilding persistence payloads and normalizes source', () => {
    const service = new ProfileService({} as never);
    const fingerprint = (service as any).buildFingerprintForPersistence('extension', {
      fingerprintCore: {
        osFamily: 'windows',
        browserProfile: {
          browser: 'edge',
          presetId: 'windows-edge-121',
        },
        locale: {
          languages: ['en-US', 'en'],
          timezone: 'America/New_York',
        },
        hardware: {
          hardwareConcurrency: 16,
          deviceMemory: 8,
        },
        display: {
          width: 1920,
          height: 1080,
        },
        graphics: {
          maskedVendor: 'Google Inc. (Intel)',
          maskedRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
        },
      },
      fingerprintSource: {
        mode: 'file',
        filePath: 'D:\\fp\\edge.txt',
      },
    }) as ReturnType<typeof getDefaultFingerprint>;

    expect(fingerprint.identity.region).toMatchObject({
      primaryLanguage: 'en-US',
      languages: ['en-US', 'en'],
      timezone: 'America/New_York',
    });
    expect(fingerprint.identity.hardware).toMatchObject({
      browserFamily: 'chromium',
      hardwareConcurrency: 16,
      deviceMemory: 8,
    });
    expect(fingerprint.identity.hardware.userAgent).toContain('Edg/');
    expect(fingerprint.source).toEqual({
      mode: 'generated',
      fileFormat: 'txt',
    });
  });
});
