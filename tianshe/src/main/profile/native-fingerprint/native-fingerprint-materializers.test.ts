import { describe, expect, it } from 'vitest';
import type { BrowserIdentityProfile } from '../../../types/profile';
import { materializeChromiumNativeFingerprint } from './native-chromium-fingerprint';
import { materializeFirefoxNativeFingerprint } from './native-firefox-fpfile';

function createIdentity(): BrowserIdentityProfile {
  return {
    region: {
      timezone: 'Asia/Tokyo',
      primaryLanguage: 'ja-JP',
      languages: ['ja-JP', 'ja'],
    },
    hardware: {
      osFamily: 'windows',
      browserFamily: 'chromium',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      platform: 'Win32',
      hardwareConcurrency: 16,
      deviceMemory: 8,
      fontSystem: 'windows',
    },
    display: {
      width: 1707,
      height: 906,
      availWidth: 1707,
      availHeight: 866,
      colorDepth: 24,
      pixelRatio: 1,
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
        unmaskedRenderer:
          'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)',
        maxTextureSize: 16384,
        maxCubeMapTextureSize: 16384,
        maxTextureImageUnits: 32,
        maxVertexAttribs: 16,
        aliasedPointSizeMax: 1024,
        maxViewportDim: 16384,
        supportedExt: ['EXT_texture_filter_anisotropic', 'WEBGL_debug_renderer_info'],
        extensionParameters: {
          ALIASED_POINT_SIZE_RANGE: '1,1024',
        },
        contextAttributes: {
          alpha: true,
          antialias: true,
        },
      },
    },
    typography: {
      fonts: ['ZWAdobeF', 'TRAJAN PRO'],
      textMetrics: {
        monospacePreferences: 87.375,
        sansPreferences: 90.66667175292969,
        serifPreferences: 90.66667175292969,
      },
    },
    network: {
      localWebrtcIpv4: '10.0.0.5',
      localWebrtcIpv6: '2001:db8::1',
      publicWebrtcIpv4: '104.251.229.181',
      publicWebrtcIpv6: '2001:db8::5678',
    },
    speech: {
      localNames: ['Microsoft Haruka Desktop - Japanese'],
      remoteNames: ['Google 日本語'],
      localLangs: ['ja-JP'],
      remoteLangs: ['ja-JP'],
      defaultName: 'Microsoft Haruka Desktop - Japanese',
      defaultLang: 'ja-JP',
    },
    input: {
      maxTouchPoints: 0,
    },
    automationSignals: {
      webdriver: 0,
    },
  };
}

describe('native fingerprint materializers', () => {
  it('materializes Chromium native fp.txt fields from the canonical identity', () => {
    const payload = materializeChromiumNativeFingerprint(createIdentity());

    expect(payload.webdriver).toBe(0);
    expect(payload.useragent).toContain('Chrome/142.0.0.0');
    expect(payload.platform).toBe('Win32');
    expect(payload.languages).toBe('ja-JP,ja');
    expect(payload.langugages).toBe('ja-JP,ja');
    expect(payload.timezone).toBe('Asia/Tokyo');
    expect(payload.language).toBe('ja-JP');
    expect(payload.screenWidth).toBe(1707);
    expect(payload.screenHeight).toBe(906);
    expect(payload.avaiScreenHeight).toBe(866);
    expect(payload.hardwareConcurrency).toBe(16);
    expect(payload.deviceMemory).toBe(8);
    expect(payload.unmaskedVendor).toBe('Google Inc. (NVIDIA)');
    expect(payload.gl_vendor).toBe('WebKit');
    expect(payload.gl_renderer).toBe('WebKit WebGL');
    expect(payload.gl_version).toBe('WebGL 1.0');
    expect(payload.gl_shading).toBe('WebGL GLSL ES 1.0 (1.0)');
    expect(payload).not.toHaveProperty('pixelRatio');
    expect(payload).not.toHaveProperty('maxTouchPoints');
    expect(payload).not.toHaveProperty('fonts');
    expect(payload).not.toHaveProperty('canvas');
    expect(payload).not.toHaveProperty('webaudio');
    expect(payload).not.toHaveProperty('monospacePreferences');
    expect(payload).not.toHaveProperty('supportedExt');
    expect(payload).not.toHaveProperty('ALIASED_POINT_SIZE_RANGE');
    expect(payload).not.toHaveProperty('alpha');
    expect(payload).not.toHaveProperty('antialias');
  });

  it('materializes Firefox fpfile fields from the canonical identity', () => {
    const payload = materializeFirefoxNativeFingerprint(createIdentity());

    expect(payload.webdriver).toBe(0);
    expect(payload.local_webrtc_ipv4).toBe('10.0.0.5');
    expect(payload.local_webrtc_ipv6).toBe('2001:db8::1');
    expect(payload.public_webrtc_ipv4).toBe('104.251.229.181');
    expect(payload.public_webrtc_ipv6).toBe('2001:db8::5678');
    expect(payload.timezone).toBe('Asia/Tokyo');
    expect(payload.language).toBe('ja-JP,ja');
    expect(payload['speech.voices.local']).toBe('Microsoft Haruka Desktop - Japanese');
    expect(payload['speech.voices.remote']).toBe('Google 日本語');
    expect(payload['speech.voices.local.langs']).toBe('ja-JP');
    expect(payload['speech.voices.remote.langs']).toBe('ja-JP');
    expect(payload['speech.voices.default.name']).toBe('Microsoft Haruka Desktop - Japanese');
    expect(payload['speech.voices.default.lang']).toBe('ja-JP');
    expect(payload.font_system).toBe('windows');
    expect(payload.useragent).toContain('Chrome/142.0.0.0');
    expect(payload.hardwareConcurrency).toBe(16);
    expect(payload['webgl.vendor']).toBe('WebKit');
    expect(payload['webgl.renderer']).toBe('WebKit WebGL');
    expect(payload['webgl.version']).toBe('WebGL 1.0');
    expect(payload['webgl.glsl_version']).toBe('WebGL GLSL ES 1.0 (1.0)');
    expect(payload['webgl.unmasked_vendor']).toBe('Google Inc. (NVIDIA)');
    expect(payload['webgl.unmasked_renderer']).toContain('ANGLE (NVIDIA');
    expect(payload['webgl.max_texture_size']).toBe(16384);
    expect(payload['webgl.max_cube_map_texture_size']).toBe(16384);
    expect(payload['webgl.max_texture_image_units']).toBe(32);
    expect(payload['webgl.max_vertex_attribs']).toBe(16);
    expect(payload['webgl.aliased_point_size_max']).toBe(1024);
    expect(payload['webgl.max_viewport_dim']).toBe(16384);
    expect(payload.width).toBe(1707);
    expect(payload.height).toBe(906);
    expect(payload.canvas).toBe(39);
  });
});
