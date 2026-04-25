/**
 * 指纹预设管理（主进程侧辅助）
 *
 * 注意：预设数据单一来源为 `src/constants/fingerprint-defaults.ts`
 */

import type {
  AutomationEngine,
  FingerprintPreset,
  FingerprintConfig,
} from '../../../types/profile';
import {
  FINGERPRINT_PRESETS,
  cloneFingerprintConfig,
  mergeFingerprintConfig,
  getDefaultFingerprint as getDefaultFingerprintFromConstants,
} from '../../../constants/fingerprint-defaults';

export const presets: FingerprintPreset[] = FINGERPRINT_PRESETS;

export const presetMap: Map<string, FingerprintPreset> = new Map(presets.map((p) => [p.id, p]));

export function getPreset(id: string): FingerprintPreset | undefined {
  return presetMap.get(id);
}

export function getPresetIds(): string[] {
  return presets.map((p) => p.id);
}

export function getDefaultPreset(): FingerprintPreset {
  return presets.find((p) => p.id === 'windows-chrome-141') || presets[0];
}

export function getDefaultFingerprint(engine: AutomationEngine = 'extension'): FingerprintConfig {
  return getDefaultFingerprintFromConstants(engine);
}

export function getPresetsByOS(os: 'windows' | 'macos' | 'linux'): FingerprintPreset[] {
  return presets.filter((p) => p.os === os);
}

export function getPresetsByBrowser(browser: 'chrome' | 'firefox' | 'edge'): FingerprintPreset[] {
  return presets.filter((p) => p.browser === browser);
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateVariant(baseConfig: FingerprintConfig): FingerprintConfig {
  const resolution = randomChoice([
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 2560, height: 1440 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
  ]);

  return mergeFingerprintConfig(baseConfig, {
    identity: {
      hardware: {
        hardwareConcurrency: randomChoice([4, 6, 8, 12, 16]),
        deviceMemory: randomChoice([4, 8, 16, 32]),
      },
      display: {
        ...resolution,
        availWidth: resolution.width,
        availHeight: Math.max(0, resolution.height - 40),
        colorDepth: baseConfig.identity.display.colorDepth,
        pixelRatio: baseConfig.identity.display.pixelRatio,
      },
    },
  });
}

export function applyPreset(presetId: string): FingerprintConfig {
  const preset = getPreset(presetId);
  if (!preset) {
    return getDefaultFingerprint();
  }
  return cloneFingerprintConfig(preset.config);
}
