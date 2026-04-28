import type { JSPluginManifest } from '../../types/js-plugin';
import { AIRPA_RUNTIME_CONFIG } from '../../constants/runtime-config';

export type PluginTrustModel = 'first_party';

export interface TrustedFirstPartyImportOptions {
  trustedFirstParty?: boolean;
}

const ACCEPTED_FIRST_PARTY_TRUST_VALUES = new Set([
  'first_party',
  'first-party',
  'trusted_first_party',
]);

function readDeclaredTrustModel(manifest: JSPluginManifest): string {
  const manifestRecord = manifest as JSPluginManifest & {
    trustModel?: unknown;
    tianshe?: {
      trustModel?: unknown;
      trust?: unknown;
    };
  };

  const value =
    manifestRecord.trustModel ??
    manifestRecord.tianshe?.trustModel ??
    manifestRecord.tianshe?.trust;

  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function assertTrustedFirstPartyPluginImport(
  manifest: JSPluginManifest,
  options?: TrustedFirstPartyImportOptions
): void {
  const declaredTrustModel = readDeclaredTrustModel(manifest);
  if (declaredTrustModel && !ACCEPTED_FIRST_PARTY_TRUST_VALUES.has(declaredTrustModel)) {
    throw new Error(
      `Plugin ${manifest.id} declares unsupported trust model "${declaredTrustModel}". ` +
        'This client only runs fully trusted first-party plugins.'
    );
  }

  if (!declaredTrustModel && AIRPA_RUNTIME_CONFIG.app.mode !== 'test') {
    throw new Error(
      `Plugin ${manifest.id} is missing trustModel="first_party". ` +
        'This client only runs fully trusted first-party plugins.'
    );
  }

  if (options?.trustedFirstParty === true || AIRPA_RUNTIME_CONFIG.app.mode === 'test') {
    return;
  }

  throw new Error(
    `Plugin ${manifest.id} import was not explicitly marked as trusted first-party. ` +
      'Set trustedFirstParty=true only after the package has been reviewed as first-party code.'
  );
}
