import type { PageSnapshot, SnapshotElement } from '../../../../types/browser-interface';

const SNAPSHOT_TAG_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'label',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'span',
  'div',
  'td',
  'th',
  'li',
].join(',');

function normalizeText(value: string | null | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function roleFor(element: Element): string {
  const explicitRole = element.getAttribute('role');
  if (explicitRole) return explicitRole;
  const tag = element.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'textbox';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return 'generic';
}

function cssEscapeFallback(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/(["\\])/g, '\\$1');
}

function collectAttributes(element: Element): SnapshotElement['attributes'] {
  const attrs: SnapshotElement['attributes'] = {};
  for (const key of ['id', 'class', 'name', 'type', 'href', 'src', 'data-testid', 'aria-label'] as const) {
    const value = element.getAttribute(key);
    if (value) {
      attrs[key] = value;
    }
  }
  return attrs;
}

function selectorCandidatesFor(element: Element, attrs: SnapshotElement['attributes']): string[] {
  const tag = element.tagName.toLowerCase();
  const candidates = [
    attrs?.id ? `#${cssEscapeFallback(attrs.id)}` : undefined,
    attrs?.['data-testid'] ? `[data-testid="${cssEscapeFallback(attrs['data-testid'])}"]` : undefined,
    attrs?.name ? `[name="${cssEscapeFallback(attrs.name)}"]` : undefined,
    attrs?.class
      ? `.${attrs.class
          .split(/\s+/)
          .filter(Boolean)
          .map(cssEscapeFallback)
          .join('.')}`
      : undefined,
    tag,
  ];
  return Array.from(new Set(candidates.filter((item): item is string => Boolean(item))));
}

function elementName(element: Element): string {
  return normalizeText(
    element.getAttribute('aria-label') ||
      element.getAttribute('placeholder') ||
      element.getAttribute('value') ||
      element.getAttribute('title') ||
      element.textContent ||
      element.getAttribute('class')
  );
}

function toSnapshotElement(element: Element, index: number): SnapshotElement | null {
  const attrs = collectAttributes(element);
  const text = normalizeText(element.textContent);
  const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? element.value
    : element.getAttribute('value') || undefined;
  const name = elementName(element);
  const candidates = selectorCandidatesFor(element, attrs);
  const hasUsefulContent =
    Boolean(text) ||
    Boolean(value) ||
    Boolean(attrs?.id || attrs?.class || attrs?.name || attrs?.['data-testid'] || attrs?.['aria-label']);

  if (!hasUsefulContent) {
    return null;
  }

  return {
    tag: element.tagName.toLowerCase(),
    role: roleFor(element),
    name,
    ...(text ? { text } : {}),
    ...(value ? { value } : {}),
    ...(element instanceof HTMLInputElement && element.placeholder
      ? { placeholder: element.placeholder }
      : {}),
    ...(element instanceof HTMLInputElement && element.type === 'checkbox'
      ? { checked: element.checked }
      : {}),
    ...((element as HTMLInputElement).disabled ? { disabled: true } : {}),
    ...(Object.keys(attrs || {}).length ? { attributes: attrs } : {}),
    preferredSelector: candidates[0] || `${element.tagName.toLowerCase()}:nth-of-type(${index + 1})`,
    selectorCandidates: candidates,
    inViewport: true,
  };
}

export function createPageSnapshotFromHtml(
  html: string,
  url = 'file://imported-site-adapter-fixture.html',
  options: { maxElements?: number } = {}
): PageSnapshot {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, 'text/html');
  const elements = Array.from(document.querySelectorAll(SNAPSHOT_TAG_SELECTOR))
    .map((element, index) => toSnapshotElement(element, index))
    .filter((element): element is SnapshotElement => Boolean(element))
    .slice(0, Math.max(1, options.maxElements ?? 500));

  return {
    url,
    title: normalizeText(document.title) || url,
    elements,
  };
}
