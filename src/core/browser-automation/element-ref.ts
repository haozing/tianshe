import type { SnapshotElement } from '../browser-core/types';

const ELEMENT_REF_PREFIX = 'airpa_el:';
const ELEMENT_REF_VERSION = 1;
const MAX_SELECTOR_HINTS = 6;
const MAX_TEXT_HINT_LENGTH = 80;

type SnapshotAttributes = NonNullable<SnapshotElement['attributes']>;

export interface ElementRefPayload {
  v: number;
  kind: 'snapshot-element';
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  placeholder?: string;
  preferredSelector?: string;
  selectorCandidates?: string[];
  attributes?: Partial<SnapshotAttributes>;
}

export class ElementRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElementRefError';
  }
}

function normalizeText(value: unknown, maxLength = MAX_TEXT_HINT_LENGTH): string | undefined {
  const normalized = String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, ' ');
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, maxLength);
}

function normalizeSelectorList(values: Array<unknown>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalizeText(value, 240);
    if (!normalized) {
      continue;
    }
    unique.add(normalized);
    if (unique.size >= MAX_SELECTOR_HINTS) {
      break;
    }
  }
  return Array.from(unique);
}

function pickSerializableAttributes(
  attributes: SnapshotElement['attributes']
): Partial<SnapshotAttributes> | undefined {
  if (!attributes) {
    return undefined;
  }

  const next: Partial<SnapshotAttributes> = {};
  const allowedKeys: Array<keyof SnapshotAttributes> = [
    'id',
    'name',
    'type',
    'href',
    'data-testid',
    'aria-label',
  ];

  for (const key of allowedKeys) {
    const normalized = normalizeText(attributes[key], 160);
    if (normalized) {
      next[key] = normalized;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function escapeSelectorValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildFallbackSelectors(payload: ElementRefPayload): string[] {
  const tag = normalizeText(payload.tag, 40);
  const attrs = payload.attributes || {};
  const baseSelector = tag || '*';
  const selectors: string[] = [];

  if (attrs.id) {
    selectors.push(`[id="${escapeSelectorValue(attrs.id)}"]`);
  }
  if (attrs['data-testid']) {
    selectors.push(`[data-testid="${escapeSelectorValue(attrs['data-testid'])}"]`);
    selectors.push(`${baseSelector}[data-testid="${escapeSelectorValue(attrs['data-testid'])}"]`);
  }
  if (attrs['aria-label']) {
    selectors.push(`[aria-label="${escapeSelectorValue(attrs['aria-label'])}"]`);
    selectors.push(`${baseSelector}[aria-label="${escapeSelectorValue(attrs['aria-label'])}"]`);
  }
  if (attrs.name) {
    selectors.push(`${baseSelector}[name="${escapeSelectorValue(attrs.name)}"]`);
  }
  if (payload.placeholder) {
    selectors.push(`${baseSelector}[placeholder="${escapeSelectorValue(payload.placeholder)}"]`);
  }
  if (attrs.href) {
    selectors.push(`${baseSelector}[href="${escapeSelectorValue(attrs.href)}"]`);
  }

  const textHints = [payload.name, payload.text]
    .map((value) => normalizeText(value, 60))
    .filter((value): value is string => Boolean(value));
  for (const textHint of textHints) {
    selectors.push(`${baseSelector}:has-text("${escapeSelectorValue(textHint)}")`);
  }

  return normalizeSelectorList(selectors);
}

function sanitizeElementForRef(element: SnapshotElement): ElementRefPayload {
  const selectorCandidates = normalizeSelectorList([
    element.preferredSelector,
    ...(Array.isArray(element.selectorCandidates) ? element.selectorCandidates : []),
  ]);

  return {
    v: ELEMENT_REF_VERSION,
    kind: 'snapshot-element',
    tag: normalizeText(element.tag, 40),
    role: normalizeText(element.role, 40),
    name: normalizeText(element.name),
    text: normalizeText(element.text),
    placeholder: normalizeText(element.placeholder),
    preferredSelector: selectorCandidates[0],
    selectorCandidates,
    attributes: pickSerializableAttributes(element.attributes),
  };
}

export function createElementRef(element: SnapshotElement): string {
  const payload = sanitizeElementForRef(element);
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${ELEMENT_REF_PREFIX}${encoded}`;
}

export function decorateSnapshotElementWithRef(element: SnapshotElement): SnapshotElement {
  if (normalizeText(element.elementRef, 512)) {
    return element;
  }
  return {
    ...element,
    elementRef: createElementRef(element),
  };
}

export function decorateSnapshotElementsWithRefs(elements: SnapshotElement[]): SnapshotElement[] {
  return elements.map((element) => decorateSnapshotElementWithRef(element));
}

export function decorateSearchResultsWithRefs<
  TResult extends { element: SnapshotElement }
>(results: TResult[]): TResult[] {
  return results.map((result) => ({
    ...result,
    element: decorateSnapshotElementWithRef(result.element),
  }));
}

export function decodeElementRef(ref: string): ElementRefPayload {
  const normalized = normalizeText(ref, 2048);
  if (!normalized || !normalized.startsWith(ELEMENT_REF_PREFIX)) {
    throw new ElementRefError('Invalid elementRef prefix');
  }

  let parsed: unknown;
  try {
    const encoded = normalized.slice(ELEMENT_REF_PREFIX.length);
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new ElementRefError('elementRef is not valid base64url JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ElementRefError('elementRef payload must be an object');
  }

  const payload = parsed as Partial<ElementRefPayload>;
  if (payload.v !== ELEMENT_REF_VERSION) {
    throw new ElementRefError(`Unsupported elementRef version: ${String(payload.v ?? '')}`);
  }
  if (payload.kind !== 'snapshot-element') {
    throw new ElementRefError(`Unsupported elementRef kind: ${String(payload.kind ?? '')}`);
  }

  return {
    ...payload,
    selectorCandidates: normalizeSelectorList(payload.selectorCandidates || []),
    preferredSelector: normalizeText(payload.preferredSelector, 240),
    tag: normalizeText(payload.tag, 40),
    role: normalizeText(payload.role, 40),
    name: normalizeText(payload.name),
    text: normalizeText(payload.text),
    placeholder: normalizeText(payload.placeholder),
    attributes: pickSerializableAttributes(payload.attributes as SnapshotElement['attributes']),
    v: ELEMENT_REF_VERSION,
    kind: 'snapshot-element',
  };
}

export function getElementRefSelectors(ref: string): string[] {
  const payload = decodeElementRef(ref);
  return normalizeSelectorList([
    payload.preferredSelector,
    ...(payload.selectorCandidates || []),
    ...buildFallbackSelectors(payload),
  ]);
}

export function summarizeElementRef(ref: string): string {
  const payload = decodeElementRef(ref);
  const label = payload.name || payload.text || payload.placeholder || payload.preferredSelector || payload.tag;
  return label ? `elementRef(${label})` : 'elementRef';
}
