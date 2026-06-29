import type { PageSnapshot, SnapshotElement } from '../../types/browser-interface';

export interface SiteAdapterSelectorHit {
  index: number;
  tag: string;
  role: string;
  selector: string | null;
  textPreview: string;
}

export interface SiteAdapterSelectorWorkbenchResult {
  selector: string;
  count: number;
  hits: SiteAdapterSelectorHit[];
  fallbackSelectors: string[];
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function elementText(element: SnapshotElement): string {
  return normalizeText(element.text || element.name || element.value || '');
}

function selectorCandidates(element: SnapshotElement): string[] {
  return [
    element.preferredSelector,
    ...(element.selectorCandidates || []),
    element.attributes?.id ? `#${element.attributes.id}` : undefined,
    element.attributes?.class
      ? `.${element.attributes.class.split(/\s+/).filter(Boolean).join('.')}`
      : undefined,
    element.attributes?.['data-testid']
      ? `[data-testid="${element.attributes['data-testid']}"]`
      : undefined,
    element.attributes?.name ? `[name="${element.attributes.name}"]` : undefined,
  ].filter((item): item is string => Boolean(item));
}

function matchesSelector(element: SnapshotElement, selector: string): boolean {
  const normalizedSelector = selector.trim().toLowerCase();
  if (!normalizedSelector) {
    return false;
  }
  if (selectorCandidates(element).some((candidate) => candidate.toLowerCase() === normalizedSelector)) {
    return true;
  }
  if (normalizedSelector.startsWith('.')) {
    const classes = normalizedSelector
      .slice(1)
      .split('.')
      .filter(Boolean);
    const elementClasses = String(element.attributes?.class || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return classes.every((className) => elementClasses.includes(className));
  }
  if (normalizedSelector.startsWith('#')) {
    return String(element.attributes?.id || '').toLowerCase() === normalizedSelector.slice(1);
  }
  if (/^[a-z][a-z0-9-]*$/.test(normalizedSelector)) {
    return element.tag.toLowerCase() === normalizedSelector;
  }
  return selectorCandidates(element).some((candidate) =>
    candidate.toLowerCase().includes(normalizedSelector)
  );
}

export function runSelectorWorkbench(
  snapshot: PageSnapshot,
  selector: string,
  options: { limit?: number } = {}
): SiteAdapterSelectorWorkbenchResult {
  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  const matches = snapshot.elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => matchesSelector(element, selector));
  const fallbackSelectors = Array.from(
    new Set(matches.flatMap(({ element }) => selectorCandidates(element)))
  ).slice(0, 10);

  return {
    selector,
    count: matches.length,
    hits: matches.slice(0, limit).map(({ element, index }) => ({
      index,
      tag: element.tag,
      role: element.role,
      selector: element.preferredSelector || selectorCandidates(element)[0] || null,
      textPreview: elementText(element).slice(0, 120),
    })),
    fallbackSelectors,
  };
}
