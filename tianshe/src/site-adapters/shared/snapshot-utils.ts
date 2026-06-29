import type { SiteAdapterVerifier } from '../../core/site-adapter-runtime';
import type { PageSnapshot, SnapshotElement } from '../../types/browser-interface';

export interface SelectorHit {
  field: string;
  selector: string;
  count: number;
  sampleText?: string;
}

export function asSnapshot(value: unknown): PageSnapshot {
  const snapshot = value as Partial<PageSnapshot>;
  return {
    url: String(snapshot.url || ''),
    title: String(snapshot.title || ''),
    elements: Array.isArray(snapshot.elements) ? snapshot.elements : [],
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
    ...(snapshot.network ? { network: snapshot.network } : {}),
    ...(snapshot.networkSummary ? { networkSummary: snapshot.networkSummary } : {}),
    ...(snapshot.console ? { console: snapshot.console } : {}),
  };
}

export function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function elementText(element: SnapshotElement): string {
  return normalizeText(element.text || element.name || element.value || '');
}

export function selectorHaystack(element: SnapshotElement): string {
  return [
    element.preferredSelector,
    ...(element.selectorCandidates || []),
    element.attributes?.id,
    element.attributes?.class,
    element.attributes?.name,
    element.attributes?.type,
    element.attributes?.href,
    element.attributes?.['data-testid'],
    element.attributes?.['aria-label'],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function elementsMatching(
  snapshot: PageSnapshot,
  selectorParts: readonly string[]
): SnapshotElement[] {
  const normalized = selectorParts.map((part) => part.toLowerCase());
  return snapshot.elements.filter((element) => {
    const haystack = selectorHaystack(element);
    return normalized.some((part) => haystack.includes(part));
  });
}

export function firstText(snapshot: PageSnapshot, selectorParts: readonly string[]): string {
  const match = elementsMatching(snapshot, selectorParts).find((element) => elementText(element));
  return match ? elementText(match) : '';
}

export function selectorHit(
  field: string,
  selector: string,
  snapshot: PageSnapshot,
  selectorParts: readonly string[] = [selector]
): SelectorHit {
  const matches = elementsMatching(snapshot, selectorParts);
  const first = matches.find((element) => elementText(element));
  return {
    field,
    selector,
    count: matches.length,
    ...(first ? { sampleText: elementText(first) } : {}),
  };
}

export function pageFingerprint(snapshot: PageSnapshot): Record<string, unknown> {
  return {
    url: snapshot.url,
    title: snapshot.title,
    elementCount: snapshot.elements.length,
  };
}

export function confidenceFromRequired(values: readonly unknown[]): number {
  const present = values.filter(hasValue).length;
  return Number((present / Math.max(1, values.length)).toFixed(2));
}

export function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return Boolean(value);
}

export function createRequiredFieldsVerifier(
  id: string,
  requiredFields: readonly string[],
  minConfidence = 0.75
): SiteAdapterVerifier {
  return {
    id,
    verify(context) {
      const missing = requiredFields.filter((field) => !hasValue(context.result[field]));
      const confidence =
        typeof context.result.confidence === 'number' ? context.result.confidence : 0;

      return {
        ok: missing.length === 0 && confidence >= minConfidence,
        diagnostics: requiredFields.map((field) => ({
          path: field,
          ok: hasValue(context.result[field]),
          expected: 'present',
          actual: context.result[field] ?? '',
        })),
        ...(missing.length
          ? { message: `Missing required field(s): ${missing.join(', ')}` }
          : confidence < minConfidence
            ? { message: `Extractor confidence too low: ${confidence}` }
            : {}),
      };
    },
  };
}
