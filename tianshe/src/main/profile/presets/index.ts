/**
 * 指纹预设管理（主进程侧辅助）
 *
 * 注意：预设数据单一来源为 `src/constants/fingerprint-defaults.ts`
 */

import type {
  BrowserRuntimeId,
  FingerprintPreset,
  FingerprintConfig,
} from '../../../types/profile';
import {
  FINGERPRINT_PRESETS,
  getDefaultFingerprint as getDefaultFingerprintFromConstants,
  generateVariant,
  applyPreset,
} from '../../../constants/fingerprint-defaults';

export { generateVariant, applyPreset };

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

export function getDefaultFingerprint(
  runtimeId: BrowserRuntimeId = 'chromium-extension-relay'
): FingerprintConfig {
  return getDefaultFingerprintFromConstants(runtimeId);
}

export function getPresetsByOS(os: 'windows' | 'macos' | 'linux'): FingerprintPreset[] {
  return presets.filter((p) => p.os === os);
}

export function getPresetsByBrowser(browser: 'chrome' | 'firefox' | 'edge'): FingerprintPreset[] {
  return presets.filter((p) => p.browser === browser);
}
