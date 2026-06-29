import type { SiteAdapterManifest, SiteAdapterModule } from './types';

const NON_EMPTY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const SITE_ADAPTER_SIDE_EFFECT_LEVELS = ['read-only', 'low', 'high'] as const;
const SITE_ADAPTER_SUPPORTED_RUNNERS = [
  'fixture',
  'browser-snapshot',
  'browser-evaluate',
  'procedure',
  'playwright-lab',
] as const;
export const SITE_ADAPTER_REQUIRED_QUALITY_FIELDS = [
  'sourceUrl',
  'confidence',
  'missingFields',
  'selectorHits',
  'pageFingerprint',
] as const;

export function validateSiteAdapterManifest(manifest: SiteAdapterManifest): void {
  if (!NON_EMPTY_ID_PATTERN.test(manifest.id)) {
    throw new Error(`Invalid site adapter manifest id: ${manifest.id}`);
  }
  if (!manifest.name.trim()) {
    throw new Error(`Site adapter ${manifest.id} must declare a name`);
  }
  if (!SEMVER_PATTERN.test(manifest.version)) {
    throw new Error(`Site adapter ${manifest.id} version must be semver`);
  }
  if (!manifest.site.trim()) {
    throw new Error(`Site adapter ${manifest.id} must declare a site`);
  }
  if (manifest.siteId !== undefined && !NON_EMPTY_ID_PATTERN.test(manifest.siteId)) {
    throw new Error(`Invalid site adapter siteId in ${manifest.id}: ${manifest.siteId}`);
  }
  if (!SITE_ADAPTER_SIDE_EFFECT_LEVELS.includes(manifest.sideEffectLevel)) {
    throw new Error(`Site adapter ${manifest.id} sideEffectLevel is invalid`);
  }
  if (
    manifest.capabilities !== undefined &&
    (!Array.isArray(manifest.capabilities) ||
      manifest.capabilities.some((capability) => !capability || !capability.trim()))
  ) {
    throw new Error(`Site adapter ${manifest.id} capabilities must be non-empty strings`);
  }
  if (
    manifest.requiredScopes !== undefined &&
    (!Array.isArray(manifest.requiredScopes) ||
      manifest.requiredScopes.some((scope) => !scope || !scope.trim()))
  ) {
    throw new Error(`Site adapter ${manifest.id} requiredScopes must be non-empty strings`);
  }
  if (
    manifest.supportedRunners !== undefined &&
    (!Array.isArray(manifest.supportedRunners) || manifest.supportedRunners.length === 0)
  ) {
    throw new Error(`Site adapter ${manifest.id} supportedRunners must not be empty when declared`);
  }
  if (
    manifest.supportedRunners !== undefined &&
    manifest.supportedRunners.some((runner) => !SITE_ADAPTER_SUPPORTED_RUNNERS.includes(runner))
  ) {
    throw new Error(`Site adapter ${manifest.id} supportedRunners contains an invalid runner`);
  }
  if (
    manifest.riskLevel !== undefined &&
    !['low', 'medium', 'high'].includes(manifest.riskLevel)
  ) {
    throw new Error(`Site adapter ${manifest.id} riskLevel is invalid`);
  }
  if (!Array.isArray(manifest.extractors) || manifest.extractors.length === 0) {
    throw new Error(`Site adapter ${manifest.id} must declare at least one extractor`);
  }
  for (const extractor of manifest.extractors) {
    if (!NON_EMPTY_ID_PATTERN.test(extractor.id)) {
      throw new Error(`Invalid extractor id in ${manifest.id}: ${extractor.id}`);
    }
    if (!Array.isArray(extractor.outputFields) || extractor.outputFields.length === 0) {
      throw new Error(`Extractor ${extractor.id} must declare outputFields`);
    }
    const missingQualityFields = SITE_ADAPTER_REQUIRED_QUALITY_FIELDS.filter(
      (field) => !extractor.outputFields.includes(field)
    );
    if (missingQualityFields.length) {
      throw new Error(
        `Extractor ${extractor.id} in ${manifest.id} must declare quality outputFields: ${missingQualityFields.join(', ')}`
      );
    }
  }
  if (manifest.procedures !== undefined) {
    if (!Array.isArray(manifest.procedures)) {
      throw new Error(`Site adapter ${manifest.id} procedures must be an array when declared`);
    }
    for (const procedure of manifest.procedures) {
      if (!NON_EMPTY_ID_PATTERN.test(procedure.id)) {
        throw new Error(`Invalid procedure id in ${manifest.id}: ${procedure.id}`);
      }
      if (!['low', 'high'].includes(procedure.sideEffectLevel)) {
        throw new Error(`Procedure ${procedure.id} in ${manifest.id} sideEffectLevel is invalid`);
      }
      if (
        procedure.requiredScopes !== undefined &&
        (!Array.isArray(procedure.requiredScopes) ||
          procedure.requiredScopes.some((scope) => !scope || !scope.trim()))
      ) {
        throw new Error(`Procedure ${procedure.id} in ${manifest.id} requiredScopes must be non-empty strings`);
      }
    }
  }
}

export function validateSiteAdapterModule(adapter: SiteAdapterModule): void {
  validateSiteAdapterManifest(adapter.manifest);
  const manifestExtractorIds = new Set(adapter.manifest.extractors.map((extractor) => extractor.id));
  const runtimeExtractorIds = new Set(adapter.extractors.map((extractor) => extractor.id));
  for (const extractorId of manifestExtractorIds) {
    if (!runtimeExtractorIds.has(extractorId)) {
      throw new Error(`Site adapter ${adapter.manifest.id} is missing extractor ${extractorId}`);
    }
  }
  const manifestProcedureIds = new Set(
    (adapter.manifest.procedures || []).map((procedure) => procedure.id)
  );
  const runtimeProcedureIds = new Set((adapter.procedures || []).map((procedure) => procedure.id));
  for (const procedureId of manifestProcedureIds) {
    if (!runtimeProcedureIds.has(procedureId)) {
      throw new Error(`Site adapter ${adapter.manifest.id} is missing procedure ${procedureId}`);
    }
  }
}
