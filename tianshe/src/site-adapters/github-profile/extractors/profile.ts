import type {
  SiteAdapterExtractor,
  SiteAdapterExtractorContext,
} from '../../../core/site-adapter-runtime';
import type { PageSnapshot, SnapshotElement } from '../../../types/browser-interface';

function asSnapshot(value: unknown): PageSnapshot {
  const snapshot = value as Partial<PageSnapshot>;
  return {
    url: String(snapshot.url || ''),
    title: String(snapshot.title || ''),
    elements: Array.isArray(snapshot.elements) ? snapshot.elements : [],
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function elementValue(element: SnapshotElement): string {
  return normalizeText(element.value || element.text || element.name || '');
}

function findByNameOrId(snapshot: PageSnapshot, candidates: string[]): string {
  const normalizedCandidates = candidates.map((candidate) => candidate.toLowerCase());
  const match = snapshot.elements.find((element) => {
    const attrs = element.attributes || {};
    return [attrs.name, attrs.id, element.preferredSelector, ...(element.selectorCandidates || [])]
      .filter(Boolean)
      .some((value) =>
        normalizedCandidates.some((candidate) => String(value).toLowerCase().includes(candidate))
      );
  });
  return match ? elementValue(match) : '';
}

export const githubProfileExtractor: SiteAdapterExtractor = {
  id: 'profile-summary',
  extract(context: SiteAdapterExtractorContext) {
    const snapshot = asSnapshot(context.snapshot);
    const displayName = findByNameOrId(snapshot, ['profile_name', 'user[profile_name]']);
    const bio = findByNameOrId(snapshot, ['profile_bio', 'user[profile_bio]']);
    const company = findByNameOrId(snapshot, ['profile_company', 'user[profile_company]']);
    const blog = findByNameOrId(snapshot, ['profile_blog', 'user[profile_blog]']);
    const missingFields = ['displayName'].filter((field) => field === 'displayName' && !displayName);

    return {
      displayName,
      bio,
      company,
      blog,
      sourceUrl: snapshot.url,
      confidence: displayName ? 1 : 0.4,
      missingFields,
      selectorHits: [
        { field: 'displayName', selector: '[name="user[profile_name]"]', count: displayName ? 1 : 0 },
        { field: 'bio', selector: '[name="user[profile_bio]"]', count: bio ? 1 : 0 },
      ],
      extractorVersion: '1.0.0',
      runner: String(context.input.runner || 'fixture'),
      pageFingerprint: {
        url: snapshot.url,
        title: snapshot.title,
        elementCount: snapshot.elements.length,
      },
      warnings: [],
    };
  },
};
