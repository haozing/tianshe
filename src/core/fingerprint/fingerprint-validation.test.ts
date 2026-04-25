import { describe, expect, it } from 'vitest';
import {
  getDefaultFingerprint,
  mergeFingerprintConfig,
} from '../../constants/fingerprint-defaults';
import {
  getFingerprintPreflightIssues,
  validateFingerprintConfig,
} from './fingerprint-validation';

describe('fingerprint validation', () => {
  it('ignores legacy file-backed source path requirements during preflight validation', () => {
    const fingerprint = mergeFingerprintConfig(getDefaultFingerprint(), {
      source: {
        mode: 'file',
        fileFormat: 'txt',
        filePath: '',
      },
    });

    expect(getFingerprintPreflightIssues(fingerprint, 'extension')).not.toContain(
      'missing:source.filePath'
    );
  });

  it('warns when speech bundles are not self-consistent', () => {
    const fingerprint = mergeFingerprintConfig(getDefaultFingerprint(), {
      identity: {
        speech: {
          localNames: ['Voice A', 'Voice B'],
          localLangs: ['en-US'],
          defaultName: 'Missing Voice',
          defaultLang: 'ja-JP',
        },
      },
    });

    const result = validateFingerprintConfig(fingerprint, 'ruyi');
    expect(result.warnings).toContain('speech.local-names-langs-mismatch');
    expect(result.warnings).toContain('speech.default-name-missing');
    expect(result.warnings).toContain('speech.default-lang-missing');
  });

  it('warns when electron/chromium identity fields contradict each other', () => {
    const fingerprint = mergeFingerprintConfig(getDefaultFingerprint(), {
      identity: {
        hardware: {
          osFamily: 'windows',
          platform: 'MacIntel',
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        },
      },
    });

    const result = validateFingerprintConfig(fingerprint, 'electron');
    expect(result.warnings).toContain('hardware.platform-os-mismatch:windows');
    expect(result.warnings).toContain('hardware.userAgent-os-mismatch:windows');
  });

  it('requires extension WebGL stable-only contract fields before save', () => {
    const base = getDefaultFingerprint('extension');
    const webgl = base.identity.graphics?.webgl;
    const fingerprint = {
      ...base,
      identity: {
        ...base.identity,
        graphics: webgl
          ? {
              webgl: {
                maskedVendor: webgl.maskedVendor,
                maskedRenderer: webgl.maskedRenderer,
              },
            }
          : undefined,
      },
    };

    expect(getFingerprintPreflightIssues(fingerprint, 'extension')).toContain(
      'missing:identity.graphics.webgl.version'
    );
    expect(getFingerprintPreflightIssues(fingerprint, 'extension')).toContain(
      'missing:identity.graphics.webgl.glslVersion'
    );
    expect(getFingerprintPreflightIssues(fingerprint, 'extension')).toContain(
      'missing:identity.graphics.webgl.unmaskedVendor'
    );
    expect(getFingerprintPreflightIssues(fingerprint, 'extension')).toContain(
      'missing:identity.graphics.webgl.unmaskedRenderer'
    );
  });
});
