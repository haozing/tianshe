import { afterEach, describe, expect, it } from 'vitest';
import type { JSPluginManifest } from '../../types/js-plugin';
import { assertTrustedFirstPartyPluginImport } from './trust-policy';
import { AIRPA_RUNTIME_CONFIG, type RuntimeMode } from '../../constants/runtime-config';

const manifest: JSPluginManifest = {
  id: 'trusted_plugin',
  name: 'Trusted Plugin',
  version: '1.0.0',
  author: 'tiansheai',
  main: 'index.js',
};
const originalRuntimeMode = AIRPA_RUNTIME_CONFIG.app.mode;

function withRuntimeMode(mode: RuntimeMode): void {
  AIRPA_RUNTIME_CONFIG.app.mode = mode;
}

describe('plugin trust policy', () => {
  afterEach(() => {
    AIRPA_RUNTIME_CONFIG.app.mode = originalRuntimeMode;
  });

  it('accepts explicit first-party trust confirmation', () => {
    withRuntimeMode('production');

    expect(() =>
      assertTrustedFirstPartyPluginImport(
        {
          ...manifest,
          trustModel: 'first_party',
        },
        { trustedFirstParty: true }
      )
    ).not.toThrow();
  });

  it('rejects non-first-party trust declarations', () => {
    withRuntimeMode('production');

    expect(() =>
      assertTrustedFirstPartyPluginImport(
        {
          ...manifest,
          trustModel: 'third_party' as 'first_party',
        },
        { trustedFirstParty: true }
      )
    ).toThrow(/unsupported trust model/);
  });

  it('rejects missing first-party trust declarations outside tests', () => {
    withRuntimeMode('production');

    expect(() =>
      assertTrustedFirstPartyPluginImport(manifest, { trustedFirstParty: true })
    ).toThrow(/missing trustModel="first_party"/);
  });

  it('rejects imports without an explicit trusted first-party confirmation', () => {
    withRuntimeMode('production');

    expect(() =>
      assertTrustedFirstPartyPluginImport({
        ...manifest,
        trustModel: 'first_party',
      })
    ).toThrow(/not explicitly marked as trusted first-party/);
  });
});
