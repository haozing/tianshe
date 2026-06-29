import type {
  SiteAdapterExtractor,
  SiteAdapterExtractorContext,
} from '../../../core/site-adapter-runtime';
import type { PageSnapshot, SnapshotElement } from '../../../types/browser-interface';

const RATING_WORDS: Record<string, number> = {
  One: 1,
  Two: 2,
  Three: 3,
  Four: 4,
  Five: 5,
};

const REQUIRED_FIELDS = ['productName', 'price', 'availability', 'rating'] as const;

type ProductField = (typeof REQUIRED_FIELDS)[number];

interface SelectorHit {
  field: string;
  selector: string;
  count: number;
  sampleText?: string;
}

function asSnapshot(value: unknown): PageSnapshot {
  const candidate = value as Partial<PageSnapshot>;
  return {
    url: String(candidate.url || ''),
    title: String(candidate.title || ''),
    elements: Array.isArray(candidate.elements) ? candidate.elements : [],
    ...(candidate.summary ? { summary: candidate.summary } : {}),
    ...(candidate.network ? { network: candidate.network } : {}),
    ...(candidate.networkSummary ? { networkSummary: candidate.networkSummary } : {}),
    ...(candidate.console ? { console: candidate.console } : {}),
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function elementText(element: SnapshotElement): string {
  return normalizeText(element.text || element.name || element.value || '');
}

function selectorHaystack(element: SnapshotElement): string {
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

function firstElement(
  elements: SnapshotElement[],
  predicate: (element: SnapshotElement, index: number) => boolean
): SnapshotElement | undefined {
  return elements.find((element, index) => elementText(element) && predicate(element, index));
}

function hit(field: string, selector: string, elements: SnapshotElement[]): SelectorHit {
  const matched = elements.filter((element) => selectorHaystack(element).includes(selector));
  return {
    field,
    selector,
    count: matched.length,
    ...(matched[0] ? { sampleText: elementText(matched[0]) } : {}),
  };
}

function extractProductName(snapshot: PageSnapshot): string {
  const heading = firstElement(snapshot.elements, (element) => element.tag.toLowerCase() === 'h1');
  if (heading) {
    return elementText(heading);
  }
  return normalizeText(snapshot.title.split('|')[0]);
}

function extractPrice(snapshot: PageSnapshot): string {
  const price = firstElement(
    snapshot.elements,
    (element) =>
      selectorHaystack(element).includes('price_color') ||
      /^[£$€]\s*\d+(?:[.,]\d{2})?/.test(elementText(element))
  );
  return price ? elementText(price) : '';
}

function extractAvailability(snapshot: PageSnapshot): string {
  const availability = firstElement(
    snapshot.elements,
    (element) =>
      selectorHaystack(element).includes('availability') ||
      /\b(in stock|out of stock|available)\b/i.test(elementText(element))
  );
  return availability ? elementText(availability) : '';
}

function extractRating(snapshot: PageSnapshot): string {
  const ratingElement = firstElement(
    snapshot.elements,
    (element) =>
      selectorHaystack(element).includes('star-rating') ||
      /\bstar rating\b/i.test(elementText(element))
  );
  const source = ratingElement
    ? `${selectorHaystack(ratingElement)} ${elementText(ratingElement)}`
    : '';
  const ratingWord = Object.keys(RATING_WORDS).find((word) =>
    new RegExp(`\\b${word}\\b`, 'i').test(source)
  );
  return ratingWord ? String(RATING_WORDS[ratingWord]) : '';
}

function extractLabeledValue(snapshot: PageSnapshot, label: string): string {
  const elements = snapshot.elements;
  const inline = elements
    .map(elementText)
    .find((text) => new RegExp(`^${label}\\s+\\S+`, 'i').test(text));
  if (inline) {
    return normalizeText(inline.replace(new RegExp(`^${label}\\s+`, 'i'), ''));
  }

  const labelIndex = elements.findIndex(
    (element) => elementText(element).toLowerCase() === label.toLowerCase()
  );
  if (labelIndex >= 0) {
    for (const next of elements.slice(labelIndex + 1, labelIndex + 4)) {
      const value = elementText(next);
      if (value && value.toLowerCase() !== label.toLowerCase()) {
        return value;
      }
    }
  }
  return '';
}

function buildSelectorHits(snapshot: PageSnapshot): SelectorHit[] {
  return [
    hit('productName', 'h1', snapshot.elements),
    hit('price', 'price_color', snapshot.elements),
    hit('availability', 'availability', snapshot.elements),
    hit('rating', 'star-rating', snapshot.elements),
  ];
}

function missingFields(fields: Record<ProductField, string>): ProductField[] {
  return REQUIRED_FIELDS.filter((field) => !fields[field]);
}

function confidenceFor(fields: Record<ProductField, string>): number {
  const present = REQUIRED_FIELDS.filter((field) => Boolean(fields[field])).length;
  return Number((present / REQUIRED_FIELDS.length).toFixed(2));
}

export const productExtractor: SiteAdapterExtractor = {
  id: 'product',
  extract(context: SiteAdapterExtractorContext) {
    const snapshot = asSnapshot(context.snapshot);
    const fields: Record<ProductField, string> = {
      productName: extractProductName(snapshot),
      price: extractPrice(snapshot),
      availability: extractAvailability(snapshot),
      rating: extractRating(snapshot),
    };

    return {
      ...fields,
      upc: extractLabeledValue(snapshot, 'UPC'),
      productType: extractLabeledValue(snapshot, 'Product Type'),
      sourceUrl: snapshot.url,
      pageTitle: snapshot.title,
      missingFields: missingFields(fields),
      selectorHits: buildSelectorHits(snapshot),
      confidence: confidenceFor(fields),
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
