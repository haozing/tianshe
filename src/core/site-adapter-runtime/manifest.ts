import type { SiteAdapterManifest, SiteAdapterModule } from './types';

const NON_EMPTY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

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
  if (manifest.sideEffectLevel !== 'read-only') {
    throw new Error(`Site adapter ${manifest.id} must be read-only in the P0 runtime`);
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
}
