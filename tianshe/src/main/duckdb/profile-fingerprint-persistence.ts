import type {
  BrowserRuntimeId,
  DeepPartial,
  FingerprintConfig,
  FingerprintCoreConfig,
  FingerprintSourceConfig,
} from '../../types/profile';
import {
  extractFingerprintCoreConfig,
  getDefaultFingerprintForRuntime,
  materializeFingerprintConfigForRuntime,
  materializeFingerprintConfigFromCore,
  mergeFingerprintConfig,
  mergeFingerprintCoreConfig,
} from '../../constants/fingerprint-defaults';
import { validateFingerprintConfig } from '../../core/fingerprint/fingerprint-validation';

export function isCanonicalFingerprintConfig(value: unknown): value is FingerprintConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const fingerprint = value as Partial<FingerprintConfig>;
  return (
    typeof fingerprint.identity === 'object' &&
    fingerprint.identity !== null &&
    typeof fingerprint.source === 'object' &&
    fingerprint.source !== null &&
    typeof fingerprint.identity.region?.timezone === 'string' &&
    typeof fingerprint.identity.hardware?.userAgent === 'string' &&
    typeof fingerprint.source.mode === 'string' &&
    fingerprint.source.fileFormat === 'txt'
  );
}

export interface BuildFingerprintForPersistenceOptions {
  fingerprintCore?: DeepPartial<FingerprintCoreConfig>;
  fingerprintSource?: Partial<FingerprintSourceConfig>;
  baseFingerprint?: FingerprintConfig;
  fallbackSharedFingerprint?: FingerprintConfig;
  overrides?: DeepPartial<FingerprintConfig>;
}

export class ProfileFingerprintPersistence {
  buildSystemDefaultFingerprint(): FingerprintConfig {
    const major = this.getChromiumMajorVersion();
    const fullVersion = `${major}.0.0.0`;

    if (process.platform === 'win32') {
      return mergeFingerprintConfig(getDefaultFingerprintForRuntime('electron-webcontents'), {
        identity: {
          hardware: {
            browserFamily: 'electron',
            browserVersion: fullVersion,
            userAgent:
              `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
              `Chrome/${fullVersion} Safari/537.36 Edg/${fullVersion}`,
          },
        },
      });
    }

    return mergeFingerprintConfig(getDefaultFingerprintForRuntime('electron-webcontents'), {
      identity: {
        hardware: {
          browserFamily: 'electron',
          browserVersion: fullVersion,
        },
      },
    });
  }

  buildFingerprintForPersistence(
    runtimeId: BrowserRuntimeId,
    options: BuildFingerprintForPersistenceOptions = {}
  ): FingerprintConfig {
    if (options.fingerprintCore || options.fingerprintSource) {
      const baseFingerprint =
        options.baseFingerprint ??
        options.fallbackSharedFingerprint ??
        getDefaultFingerprintForRuntime(runtimeId);
      const mergedCore = mergeFingerprintCoreConfig(
        extractFingerprintCoreConfig(baseFingerprint),
        options.fingerprintCore ?? {}
      );
      const mergedSource = this.mergeFingerprintSourceConfig(
        baseFingerprint.source,
        options.fingerprintSource
      );
      return materializeFingerprintConfigFromCore(mergedCore, mergedSource, runtimeId);
    }

    const seed =
      options.baseFingerprint ??
      (options.fallbackSharedFingerprint
        ? mergeFingerprintConfig(getDefaultFingerprintForRuntime(runtimeId), {
            identity: {
              region: {
                timezone: options.fallbackSharedFingerprint.identity.region.timezone,
                languages: [...options.fallbackSharedFingerprint.identity.region.languages],
              },
              hardware: {
                osFamily: options.fallbackSharedFingerprint.identity.hardware.osFamily,
                hardwareConcurrency:
                  options.fallbackSharedFingerprint.identity.hardware.hardwareConcurrency,
                deviceMemory: options.fallbackSharedFingerprint.identity.hardware.deviceMemory,
              },
              display: {
                width: options.fallbackSharedFingerprint.identity.display.width,
                height: options.fallbackSharedFingerprint.identity.display.height,
              },
              graphics: {
                webgl: {
                  maskedVendor:
                    options.fallbackSharedFingerprint.identity.graphics?.webgl?.maskedVendor,
                  maskedRenderer:
                    options.fallbackSharedFingerprint.identity.graphics?.webgl?.maskedRenderer,
                },
              },
            },
            source: {
              mode: 'generated',
              fileFormat: 'txt',
            },
          })
        : getDefaultFingerprintForRuntime(runtimeId));

    const merged = options.overrides ? mergeFingerprintConfig(seed, options.overrides) : seed;
    return materializeFingerprintConfigForRuntime(merged, runtimeId);
  }

  assertValidFingerprintConfig(
    fingerprint: FingerprintConfig,
    runtimeId: BrowserRuntimeId,
    label: string
  ): void {
    const validation = validateFingerprintConfig(fingerprint, runtimeId);
    if (!validation.valid) {
      throw new Error(`${label} fingerprint is invalid: ${validation.warnings.join(', ')}`);
    }
  }

  private getChromiumMajorVersion(): number {
    const chrome = (process.versions && (process.versions as any).chrome) || '';
    const major = Number.parseInt(String(chrome).split('.')[0] || '', 10);
    return Number.isFinite(major) && major > 0 ? major : 120;
  }

  private mergeFingerprintSourceConfig(
    _base: FingerprintSourceConfig,
    _overrides: Partial<FingerprintSourceConfig> | undefined
  ): FingerprintSourceConfig {
    return {
      mode: 'generated',
      fileFormat: 'txt',
    };
  }
}
