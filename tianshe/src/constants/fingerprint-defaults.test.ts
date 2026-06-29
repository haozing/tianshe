import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FINGERPRINT_CONFIG,
  extractFingerprintCoreConfig,
  getDefaultFingerprint,
  materializeFingerprintConfigFromCore,
  materializeFingerprintConfigForEngine,
  mergeFingerprintCoreConfig,
  mergeFingerprintConfig,
  normalizeFingerprintConfigForEngine,
} from './fingerprint-defaults';

describe('mergeFingerprintConfig', () => {
  it('keeps primaryLanguage aligned with the merged language bundle', () => {
    const merged = mergeFingerprintConfig(DEFAULT_FINGERPRINT_CONFIG, {
      identity: {
        region: {
          primaryLanguage: 'fr-FR',
          languages: ['fr-FR', 'fr', 'en-US'],
        },
      },
    });
    expect(merged.identity.region.primaryLanguage).toBe('fr-FR');
    expect(merged.identity.region.languages).toEqual(['fr-FR', 'fr', 'en-US']);
  });

  it('deep-merges nested native fingerprint fields', () => {
    const merged = mergeFingerprintConfig(DEFAULT_FINGERPRINT_CONFIG, {
      identity: {
        graphics: {
          webgl: {
            maskedVendor: 'Google Inc. (AMD)',
            maxTextureSize: 16384,
          },
        },
      },
    });

    expect(merged.identity.graphics?.webgl?.maskedVendor).toBe('Google Inc. (AMD)');
    expect(merged.identity.graphics?.webgl?.maskedRenderer).toBe(
      DEFAULT_FINGERPRINT_CONFIG.identity.graphics?.webgl?.maskedRenderer
    );
    expect(merged.identity.graphics?.webgl?.maxTextureSize).toBe(16384);
  });

  it('deep-merges nested display fields', () => {
    const merged = mergeFingerprintConfig(DEFAULT_FINGERPRINT_CONFIG, {
      identity: {
        display: { width: 1234 },
      },
    });
    expect(merged.identity.display.width).toBe(1234);
    expect(merged.identity.display.height).toBe(DEFAULT_FINGERPRINT_CONFIG.identity.display.height);
  });

  it('updates source mode and keeps native fingerprint files pinned to txt', () => {
    const merged = mergeFingerprintConfig(DEFAULT_FINGERPRINT_CONFIG, {
      source: {
        mode: 'generated',
        fileFormat: 'txt',
      },
    });
    expect(merged.source.mode).toBe('generated');
    expect(merged.source.fileFormat).toBe('txt');
    expect(merged.source.filePath).toBeUndefined();
  });

  it('returns engine-specific default fingerprints', () => {
    const extensionDefault = getDefaultFingerprint('extension');
    expect(extensionDefault.identity.hardware.browserFamily).toBe('chromium');
    expect(extensionDefault.identity.hardware.userAgent).toContain('Chrome/141.0.0.0');
    expect(extensionDefault.identity.graphics?.webgl).toMatchObject({
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      glslVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      unmaskedVendor: expect.any(String),
      unmaskedRenderer: expect.any(String),
    });
    expect(getDefaultFingerprint('electron').identity.hardware.browserFamily).toBe('electron');
    expect(getDefaultFingerprint('ruyi').identity.hardware.browserFamily).toBe('firefox');
    expect(getDefaultFingerprint('ruyi').identity.hardware.userAgent).toContain('Firefox/151.0');
  });

  it('normalizes legacy native fingerprint file formats back to txt', () => {
    const normalized = normalizeFingerprintConfigForEngine(
      {
        ...mergeFingerprintConfig(DEFAULT_FINGERPRINT_CONFIG, {
          source: {
            mode: 'generated',
            fileFormat: 'txt',
          },
        }),
        source: {
          mode: 'generated',
          fileFormat: 'json' as never,
        },
      },
      'extension'
    );

    expect(normalized.source).toEqual({
      mode: 'generated',
      fileFormat: 'txt',
    });
  });

  it('pins browserFamily to the selected engine and normalizes legacy native file mode', () => {
    const withFileSource = mergeFingerprintConfig(getDefaultFingerprint('extension'), {
      source: {
        mode: 'file',
        filePath: 'profiles/example.fp.txt',
        fileFormat: 'txt',
      },
    });

    const normalizedExtension = normalizeFingerprintConfigForEngine(
      {
        ...withFileSource,
        identity: {
          ...withFileSource.identity,
          hardware: {
            ...withFileSource.identity.hardware,
            browserFamily: 'electron',
          },
        },
      },
      'extension'
    );
    expect(normalizedExtension.identity.hardware.browserFamily).toBe('chromium');
    expect(normalizedExtension.source).toEqual({
      mode: 'generated',
      fileFormat: 'txt',
    });

    const normalizedRuyi = normalizeFingerprintConfigForEngine(
      {
        ...withFileSource,
        identity: {
          ...withFileSource.identity,
          hardware: {
            ...withFileSource.identity.hardware,
            browserFamily: 'chromium',
          },
        },
      },
      'ruyi'
    );
    expect(normalizedRuyi.identity.hardware.browserFamily).toBe('firefox');
    expect(normalizedRuyi.source).toEqual({
      mode: 'generated',
      fileFormat: 'txt',
    });

    const normalizedElectron = normalizeFingerprintConfigForEngine(withFileSource, 'electron');
    expect(normalizedElectron.identity.hardware.browserFamily).toBe('electron');
    expect(normalizedElectron.source).toEqual({
      mode: 'generated',
      fileFormat: 'txt',
    });
  });

  it('strips extension profiles down to stable-only startup fields', () => {
    const normalized = normalizeFingerprintConfigForEngine(
      mergeFingerprintConfig(getDefaultFingerprint('extension'), {
        identity: {
          hardware: {
            platformVersion: '15.0.0',
            fontSystem: 'windows',
          },
          display: {
            pixelRatio: 1.5,
          },
          graphics: {
            canvasSeed: 39,
            webaudio: 0.0001,
            webgl: {
              maskedVendor: 'WebKit',
              maskedRenderer: 'WebKit WebGL',
              version: 'WebGL 1.0',
              glslVersion: 'WebGL GLSL ES 1.0 (1.0)',
              unmaskedVendor: 'Google Inc. (NVIDIA)',
              unmaskedRenderer: 'ANGLE (NVIDIA, D3D11)',
              maxTextureSize: 16384,
              supportedExt: ['WEBGL_debug_renderer_info'],
              extensionParameters: {
                ALIASED_POINT_SIZE_RANGE: '1,1024',
              },
              contextAttributes: {
                alpha: true,
              },
            },
          },
          typography: {
            fonts: ['Arial'],
          },
          network: {
            localWebrtcIpv4: '10.0.0.5',
          },
          speech: {
            localNames: ['Microsoft Haruka Desktop - Japanese'],
          },
          input: {
            touchSupport: true,
            maxTouchPoints: 5,
          },
        },
      }),
      'extension'
    );

    expect(normalized.identity.hardware.platformVersion).toBeUndefined();
    expect(normalized.identity.hardware.fontSystem).toBeUndefined();
    expect(normalized.identity.display.pixelRatio).toBeUndefined();
    expect(normalized.identity.graphics).toEqual({
      webgl: {
        maskedVendor: 'WebKit',
        maskedRenderer: 'WebKit WebGL',
        version: 'WebGL 1.0',
        glslVersion: 'WebGL GLSL ES 1.0 (1.0)',
        unmaskedVendor: 'Google Inc. (NVIDIA)',
        unmaskedRenderer: 'ANGLE (NVIDIA, D3D11)',
      },
    });
    expect(normalized.identity.typography).toBeUndefined();
    expect(normalized.identity.network).toBeUndefined();
    expect(normalized.identity.speech).toBeUndefined();
    expect(normalized.identity.input).toEqual({
      touchSupport: false,
      maxTouchPoints: 0,
    });
  });

  it('backfills missing extension WebGL stable fields during normalization', () => {
    const base = getDefaultFingerprint('extension');
    const legacyWebgl = base.identity.graphics?.webgl;
    const normalized = normalizeFingerprintConfigForEngine(
      {
        ...base,
        identity: {
          ...base.identity,
          graphics: legacyWebgl
            ? {
                webgl: {
                  maskedVendor: legacyWebgl.maskedVendor,
                  maskedRenderer: legacyWebgl.maskedRenderer,
                },
              }
            : undefined,
        },
      },
      'extension'
    );

    expect(normalized.identity.graphics?.webgl).toMatchObject({
      maskedVendor: legacyWebgl?.maskedVendor,
      maskedRenderer: legacyWebgl?.maskedRenderer,
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      glslVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      unmaskedVendor: legacyWebgl?.maskedVendor,
      unmaskedRenderer: legacyWebgl?.maskedRenderer,
    });
  });

  it('materializes shared derived fields before engine-specific normalization', () => {
    const base = getDefaultFingerprint('extension');
    const materialized = materializeFingerprintConfigForEngine(
      mergeFingerprintConfig(base, {
        identity: {
          region: {
            primaryLanguage: 'zh-CN',
            languages: ['ja-JP', 'ja'],
          },
          hardware: {
            platform: 'Linux',
          },
          display: {
            availWidth: 100,
            availHeight: 100,
          },
          graphics: {
            webgl: {
              maskedVendor: 'Google Inc. (Intel)',
              maskedRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
              version: undefined,
              glslVersion: undefined,
              unmaskedVendor: undefined,
              unmaskedRenderer: undefined,
            },
          },
          automationSignals: {
            webdriver: 1,
          },
        },
      }),
      'extension'
    );

    expect(materialized.identity.region.primaryLanguage).toBe('ja-JP');
    expect(materialized.identity.region.languages).toEqual(['ja-JP', 'ja']);
    expect(materialized.identity.hardware.platform).toBe('Win32');
    expect(materialized.identity.display.availWidth).toBe(materialized.identity.display.width);
    expect(materialized.identity.display.availHeight).toBe(
      Math.max(0, materialized.identity.display.height - 40)
    );
    expect(materialized.identity.graphics?.webgl).toMatchObject({
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      glslVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      unmaskedVendor: 'Google Inc. (Intel)',
    });
    expect(materialized.identity.automationSignals).toEqual({
      webdriver: 0,
    });
  });

  it('extracts and rematerializes fingerprint core config through preset-aware main path', () => {
    const extensionFingerprint = mergeFingerprintConfig(getDefaultFingerprint('extension'), {
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
      },
      source: {
        mode: 'file',
        fileFormat: 'txt',
        filePath: 'D:\\fp\\custom.txt',
      },
    });

    const core = extractFingerprintCoreConfig(extensionFingerprint);
    const mergedCore = mergeFingerprintCoreConfig(core, {
      browserProfile: {
        browser: 'firefox',
      },
    });
    const rematerialized = materializeFingerprintConfigFromCore(
      mergedCore,
      extensionFingerprint.source,
      'ruyi'
    );

    expect(rematerialized.identity.hardware.browserFamily).toBe('firefox');
    expect(rematerialized.identity.hardware.userAgent).toContain('Firefox/151.0');
    expect(rematerialized.identity.region).toMatchObject({
      timezone: 'Asia/Tokyo',
      primaryLanguage: 'ja-JP',
      languages: ['ja-JP', 'ja'],
    });
    expect(rematerialized.identity.display).toMatchObject({
      width: 2560,
      height: 1440,
      availWidth: 2560,
      availHeight: 1400,
    });
    expect(rematerialized.source).toEqual({
      mode: 'generated',
      fileFormat: 'txt',
    });
  });

  it('strips non-contract startup fields from ruyi profiles', () => {
    const normalized = normalizeFingerprintConfigForEngine(
      mergeFingerprintConfig(getDefaultFingerprint('ruyi'), {
        identity: {
          display: {
            pixelRatio: 1.5,
          },
          input: {
            touchSupport: true,
            maxTouchPoints: 5,
          },
        },
      }),
      'ruyi'
    );

    expect(normalized.identity.display.pixelRatio).toBeUndefined();
    expect(normalized.identity.input).toBeUndefined();
  });
});
