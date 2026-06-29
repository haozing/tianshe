import type { FingerprintConfig } from '../../types/profile';
import type { StealthConfig } from '../stealth';

const LEGACY_ELECTRON_STEALTH_NOISE_DEFAULTS = Object.freeze({
  canvasNoise: true,
  canvasNoiseLevel: 0.1,
  audioNoise: false,
  audioNoiseLevel: 0.01,
  webglNoise: false,
});

export function buildStealthConfigFromFingerprint(fingerprint: FingerprintConfig): StealthConfig {
  const identity = fingerprint.identity;
  const webgl = identity.graphics?.webgl;

  return {
    enabled: true,
    userAgent: identity.hardware.userAgent,
    platform: identity.hardware.platform,
    platformVersion: identity.hardware.platformVersion,
    languages: [...identity.region.languages],
    timezone: identity.region.timezone,
    hardwareConcurrency: identity.hardware.hardwareConcurrency,
    deviceMemory: identity.hardware.deviceMemory,
    screen: {
      width: identity.display.width,
      height: identity.display.height,
      availWidth: identity.display.availWidth,
      availHeight: identity.display.availHeight,
      colorDepth: identity.display.colorDepth,
      pixelRatio: identity.display.pixelRatio,
    },
    webgl:
      webgl?.maskedVendor || webgl?.maskedRenderer
        ? {
            vendor: webgl.maskedVendor ?? '',
            renderer: webgl.maskedRenderer ?? '',
            version: webgl.version,
          }
        : undefined,
    canvasNoise: LEGACY_ELECTRON_STEALTH_NOISE_DEFAULTS.canvasNoise,
    canvasNoiseLevel: LEGACY_ELECTRON_STEALTH_NOISE_DEFAULTS.canvasNoiseLevel,
    audioNoise: LEGACY_ELECTRON_STEALTH_NOISE_DEFAULTS.audioNoise,
    audioNoiseLevel: LEGACY_ELECTRON_STEALTH_NOISE_DEFAULTS.audioNoiseLevel,
    webglNoise: LEGACY_ELECTRON_STEALTH_NOISE_DEFAULTS.webglNoise,
    fonts: identity.typography?.fonts ? [...identity.typography.fonts] : undefined,
    touchSupport: identity.input?.touchSupport ?? false,
    maxTouchPoints: identity.input?.maxTouchPoints ?? 0,
  };
}
