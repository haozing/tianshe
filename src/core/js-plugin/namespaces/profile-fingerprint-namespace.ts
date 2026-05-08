import type { BrowserProfile, FingerprintConfig, UpdateProfileParams } from '../../../types/profile';
import type { AutomationEngine } from '../../browser-pool/types';
import {
  FINGERPRINT_PRESET_OPTIONS,
  applyPreset as applyPresetConfig,
  generateVariant,
  getDefaultFingerprint,
  getPresetById,
  mergeFingerprintConfig,
} from '../../../constants/fingerprint-defaults';
import { validateFingerprintConfig } from '../../fingerprint/fingerprint-validation';
import { createLogger } from '../../logger';

const logger = createLogger('ProfileFingerprintNamespace');

export interface GenerateFingerprintOptions {
  /** 操作系统：windows, macos, linux */
  os?: 'windows' | 'macos' | 'linux';
  /** 浏览器：chrome, firefox, edge */
  browser?: 'chrome' | 'firefox' | 'edge';
  /** 设备类型 */
  device?: 'desktop' | 'mobile';
  /** 浏览器最小主版本 */
  browserMinVersion?: number;
  /** 浏览器最大主版本 */
  browserMaxVersion?: number;
  /** 语言偏好 */
  locales?: string[];
  /** 屏幕宽度范围 */
  screenWidth?: { min?: number; max?: number };
  /** 屏幕高度范围 */
  screenHeight?: { min?: number; max?: number };
}

export interface FingerprintValidationResult {
  valid: boolean;
  warnings: string[];
}

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  os: string;
  browser: string;
}

export interface ProfileFingerprintNamespaceDeps {
  pluginId: string;
  getProfile: (profileId: string) => Promise<BrowserProfile | null>;
  updateProfile: (profileId: string, params: UpdateProfileParams) => Promise<BrowserProfile>;
}

export class ProfileFingerprintNamespace {
  constructor(private readonly deps: ProfileFingerprintNamespaceDeps) {}

  async generateFingerprint(
    options?: GenerateFingerprintOptions
  ): Promise<Partial<FingerprintConfig>> {
    if (options?.device === 'mobile') {
      throw new Error(
        'profile.generateFingerprint currently supports desktop native fingerprint presets only.'
      );
    }

    const matchingPresets = FINGERPRINT_PRESET_OPTIONS.filter((preset) => {
      if (options?.os && preset.os.toLowerCase() !== options.os) {
        return false;
      }
      if (options?.browser && preset.browser.toLowerCase() !== options.browser) {
        return false;
      }

      const major = parseFingerprintVersionMajor(preset.config.identity.hardware.browserVersion);
      if (options?.browserMinVersion !== undefined && (major === null || major < options.browserMinVersion)) {
        return false;
      }
      if (options?.browserMaxVersion !== undefined && (major === null || major > options.browserMaxVersion)) {
        return false;
      }

      return true;
    });

    if (matchingPresets.length === 0) {
      throw new Error('No canonical fingerprint preset matches the requested constraints.');
    }

    const selectedPreset =
      matchingPresets[Math.floor(Math.random() * Math.max(1, matchingPresets.length))];
    let fingerprint = generateVariant(selectedPreset.config);

    const locales = normalizeLocaleList(options?.locales);
    const nextWidth = resolveDimensionWithinRange(
      fingerprint.identity.display.width,
      options?.screenWidth
    );
    const nextHeight = resolveDimensionWithinRange(
      fingerprint.identity.display.height,
      options?.screenHeight
    );

    fingerprint = mergeFingerprintConfig(fingerprint, {
      identity: {
        region:
          locales.length > 0
            ? {
                primaryLanguage: locales[0],
                languages: locales,
              }
            : undefined,
        display:
          nextWidth || nextHeight
            ? {
                width: nextWidth ?? fingerprint.identity.display.width,
                height: nextHeight ?? fingerprint.identity.display.height,
                availWidth: nextWidth ?? fingerprint.identity.display.availWidth,
                availHeight: nextHeight
                  ? Math.max(0, nextHeight - 40)
                  : fingerprint.identity.display.availHeight,
              }
            : undefined,
      },
    });

    logger.info('Generated canonical fingerprint preset', {
      pluginId: this.deps.pluginId,
      presetId: selectedPreset.id,
    });
    return fingerprint;
  }

  async getPresets(): Promise<PresetInfo[]> {
    return FINGERPRINT_PRESET_OPTIONS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      os: preset.os.toLowerCase(),
      browser: preset.browser.toLowerCase(),
    }));
  }

  async getPresetConfig(presetId: string): Promise<FingerprintConfig | null> {
    const preset = getPresetById(presetId);
    if (!preset) {
      return null;
    }
    return applyPresetConfig(presetId);
  }

  async applyPreset(profileId: string, presetId: string): Promise<BrowserProfile> {
    const preset = getPresetById(presetId);
    if (!preset) {
      throw new Error(`Preset not found: ${presetId}`);
    }

    const fingerprint = applyPresetConfig(presetId);

    logger.info('Applying fingerprint preset to profile', {
      pluginId: this.deps.pluginId,
      presetId,
      profileId,
    });

    return this.deps.updateProfile(profileId, { fingerprint });
  }

  async randomizeFingerprint(profileId: string): Promise<BrowserProfile> {
    const profile = await this.deps.getProfile(profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    const baseFingerprint = profile.fingerprint || getDefaultFingerprint(profile.engine);
    const variant = generateVariant(baseFingerprint);

    logger.info('Randomizing fingerprint for profile', {
      pluginId: this.deps.pluginId,
      profileId,
    });

    return this.deps.updateProfile(profileId, { fingerprint: variant });
  }

  async regenerateFingerprint(
    profileId: string,
    options?: GenerateFingerprintOptions
  ): Promise<BrowserProfile> {
    const fingerprint = await this.generateFingerprint(options);

    logger.info('Regenerating fingerprint for profile', {
      pluginId: this.deps.pluginId,
      profileId,
    });

    return this.deps.updateProfile(profileId, { fingerprint });
  }

  async validateFingerprint(
    config: Partial<FingerprintConfig>
  ): Promise<FingerprintValidationResult> {
    const inferredEngine =
      config.identity?.hardware?.browserFamily === 'firefox'
        ? 'ruyi'
        : config.identity?.hardware?.browserFamily === 'electron'
          ? 'electron'
          : 'extension';
    const result = validateFingerprintConfig(
      mergeFingerprintConfig(getDefaultFingerprint(inferredEngine), config),
      inferredEngine
    );

    return {
      valid: result.valid,
      warnings: result.warnings,
    };
  }

  async getDefaultFingerprint(engine: AutomationEngine = 'electron'): Promise<FingerprintConfig> {
    return getDefaultFingerprint(engine);
  }
}

function normalizeLocaleList(locales?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLocale of Array.isArray(locales) ? locales : []) {
    const locale = String(rawLocale || '').trim();
    if (!locale || seen.has(locale)) {
      continue;
    }
    seen.add(locale);
    out.push(locale);
  }
  return out;
}

function parseFingerprintVersionMajor(version: string | undefined): number | null {
  const major = Number.parseInt(String(version || '').split('.')[0] || '', 10);
  return Number.isFinite(major) && major > 0 ? major : null;
}

function resolveDimensionWithinRange(
  current: number,
  range?: { min?: number; max?: number }
): number | undefined {
  if (!range) {
    return undefined;
  }

  const min =
    typeof range.min === 'number' && Number.isFinite(range.min) && range.min > 0
      ? Math.round(range.min)
      : undefined;
  const max =
    typeof range.max === 'number' && Number.isFinite(range.max) && range.max > 0
      ? Math.round(range.max)
      : undefined;
  const lower = min ?? max ?? Math.max(1, Math.round(current));
  const upper = max ?? min ?? Math.max(lower, Math.round(current));
  if (lower > upper) {
    return lower;
  }

  const safeCurrent = Math.max(lower, Math.min(upper, Math.round(current)));
  if (lower === upper) {
    return lower;
  }
  const span = upper - lower;
  const offset = Math.min(span, Math.abs(safeCurrent - lower));
  return lower + Math.floor(Math.random() * (offset + 1));
}
