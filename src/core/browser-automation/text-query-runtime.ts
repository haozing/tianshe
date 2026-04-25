import type {
  Bounds,
  BrowserTextClickResult,
  BrowserTextMatchNormalizedResult,
  BrowserTextQueryOptions,
  ViewportConfig,
} from '../../types/browser-interface';
import { TextNotFoundError } from '../system-automation/types';

type DomTextQueryOptions = Pick<BrowserTextQueryOptions, 'exactMatch' | 'region'>;

export type TextLookupMatchSource = 'dom' | 'ocr' | 'none';

export interface TextLookupResult {
  bounds: Bounds | null;
  strategy: TextLookupMatchSource;
}

export interface TextWaitResult extends TextLookupResult {
  timedOut: boolean;
}

export type DomTextClickResult = Omit<BrowserTextClickResult, 'matchSource'> & {
  clicked: boolean;
  clickMethod: 'dom-click' | 'dom-anchor-assign' | 'none';
};

export interface TextFindStrategyCallbacks {
  findTextInDom(text: string, options?: DomTextQueryOptions): Promise<Bounds | null>;
  findTextInOcr(
    text: string,
    options: {
      exactMatch?: boolean;
      region?: BrowserTextQueryOptions['region'];
      timeoutMs: number;
      signal?: AbortSignal;
    }
  ): Promise<Bounds | null>;
}

export interface TextWaitStrategyCallbacks extends TextFindStrategyCallbacks {
  waitForTextInOcr(
    text: string,
    options: {
      exactMatch?: boolean;
      region?: BrowserTextQueryOptions['region'];
      timeoutMs: number;
      signal?: AbortSignal;
    }
  ): Promise<Bounds>;
  sleep?(ms: number): Promise<void>;
}

export function isRecoverableTextLookupError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || '')
    .trim()
    .toLowerCase();
  if (!message) {
    return false;
  }

  return [
    'input buffer is empty',
    'empty input buffer',
    'capturepage',
    'capturescreenshot',
    'viewportscreenshot',
    'screenshot',
    'display surface',
    'surface',
    'cdp',
  ].some((token) => message.includes(token));
}

function buildTextFindInDomScript(text: string, options?: DomTextQueryOptions): string {
  return `
    (function() {
      const target = ${JSON.stringify(text)}.trim();
      const exactMatch = ${options?.exactMatch === true ? 'true' : 'false'};
      const region = ${JSON.stringify(options?.region || null)};
      if (!target) return null;

      function normalize(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }

      function isVisible(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function matches(value) {
        const normalized = normalize(value).toLowerCase();
        const normalizedTarget = target.toLowerCase();
        if (!normalized) return false;
        return exactMatch ? normalized === normalizedTarget : normalized.includes(normalizedTarget);
      }

      function inRegion(rect) {
        if (!region) return true;
        const left = region.x;
        const top = region.y;
        const right = region.x + region.width;
        const bottom = region.y + region.height;
        return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
      }

      function intersectsViewport(rect) {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        return (
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < viewportWidth &&
          rect.top < viewportHeight
        );
      }

      function clipToViewport(rect) {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(viewportWidth, rect.right);
        const bottom = Math.min(viewportHeight, rect.bottom);
        return {
          x: Math.round(left),
          y: Math.round(top),
          width: Math.max(0, Math.round(right - left)),
          height: Math.max(0, Math.round(bottom - top)),
        };
      }

      const candidates = Array.from(document.querySelectorAll('body *')).reverse();
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (!intersectsViewport(rect)) continue;
        if (!inRegion(rect)) continue;

        const values = [
          el.innerText,
          el.textContent,
          el.getAttribute && el.getAttribute('aria-label'),
          el.getAttribute && el.getAttribute('title'),
          el.getAttribute && el.getAttribute('placeholder'),
          typeof el.value === 'string' ? el.value : '',
        ];

        if (!values.some((value) => matches(value))) {
          continue;
        }

        return clipToViewport(rect);
      }

      return null;
    })()
  `;
}

function buildTextClickInDomScript(text: string, options?: DomTextQueryOptions): string {
  return `
    (function() {
      const target = ${JSON.stringify(text)}.trim();
      const exactMatch = ${options?.exactMatch === true ? 'true' : 'false'};
      const region = ${JSON.stringify(options?.region || null)};
      if (!target) {
        return {
          clicked: false,
          clickMethod: 'none',
          matchedTag: null,
          clickTargetTag: null,
          href: null,
        };
      }

      function normalize(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }

      function isVisible(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function matches(value) {
        const normalized = normalize(value).toLowerCase();
        const normalizedTarget = target.toLowerCase();
        if (!normalized) return false;
        return exactMatch ? normalized === normalizedTarget : normalized.includes(normalizedTarget);
      }

      function inRegion(rect) {
        if (!region) return true;
        const left = region.x;
        const top = region.y;
        const right = region.x + region.width;
        const bottom = region.y + region.height;
        return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
      }

      function isClickable(el) {
        if (!el || typeof el.closest !== 'function') return null;
        return el.closest('a,button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"],label,summary');
      }

      const candidates = Array.from(document.querySelectorAll('body *')).reverse();
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (!inRegion(rect)) continue;

        const values = [
          el.innerText,
          el.textContent,
          el.getAttribute && el.getAttribute('aria-label'),
          el.getAttribute && el.getAttribute('title'),
          el.getAttribute && el.getAttribute('placeholder'),
          typeof el.value === 'string' ? el.value : '',
        ];

        if (!values.some((value) => matches(value))) {
          continue;
        }

        const clickTarget = isClickable(el) || el;
        if (typeof clickTarget.scrollIntoView === 'function') {
          clickTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        }
        if (
          clickTarget &&
          clickTarget.tagName === 'A' &&
          typeof clickTarget.href === 'string' &&
          clickTarget.href.length > 0
        ) {
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
          });
          const notCanceled = clickTarget.dispatchEvent(clickEvent);
          if (notCanceled) {
            window.location.assign(clickTarget.href);
          }
          return {
            clicked: true,
            clickMethod: 'dom-anchor-assign',
            matchedTag: String(el.tagName || ''),
            clickTargetTag: String(clickTarget.tagName || ''),
            href: String(clickTarget.href || ''),
          };
        }
        if (typeof clickTarget.click === 'function') {
          clickTarget.click();
          return {
            clicked: true,
            clickMethod: 'dom-click',
            matchedTag: String(el.tagName || ''),
            clickTargetTag: String(clickTarget.tagName || ''),
            href:
              typeof clickTarget.href === 'string' && clickTarget.href.length > 0
                ? String(clickTarget.href)
                : null,
          };
        }
      }

      return {
        clicked: false,
        clickMethod: 'none',
        matchedTag: null,
        clickTargetTag: null,
        href: null,
      };
    })()
  `;
}

function buildTextExistsInDomScript(text: string, options?: DomTextQueryOptions): string {
  return `
    (function() {
      const target = ${JSON.stringify(text)}.trim();
      const exactMatch = ${options?.exactMatch === true ? 'true' : 'false'};
      const region = ${JSON.stringify(options?.region || null)};
      if (!target) return false;

      function normalize(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }

      function isPotentiallyVisible(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      function matches(value) {
        const normalized = normalize(value).toLowerCase();
        const normalizedTarget = target.toLowerCase();
        if (!normalized) return false;
        return exactMatch ? normalized === normalizedTarget : normalized.includes(normalizedTarget);
      }

      function inRegion(rect) {
        if (!region) return true;
        const left = region.x;
        const top = region.y;
        const right = region.x + region.width;
        const bottom = region.y + region.height;
        return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
      }

      const candidates = Array.from(document.querySelectorAll('body *'));
      for (const el of candidates) {
        if (!isPotentiallyVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (!inRegion(rect)) continue;

        const values = [
          el.innerText,
          el.textContent,
          el.getAttribute && el.getAttribute('aria-label'),
          el.getAttribute && el.getAttribute('title'),
          el.getAttribute && el.getAttribute('placeholder'),
          typeof el.value === 'string' ? el.value : '',
        ];

        if (values.some((value) => matches(value))) {
          return true;
        }
      }

      return false;
    })()
  `;
}

export async function findTextInDom(
  evaluate: <T>(script: string) => Promise<T>,
  text: string,
  options?: DomTextQueryOptions
): Promise<Bounds | null> {
  return evaluate<Bounds | null>(buildTextFindInDomScript(text, options));
}

export async function clickTextInDom(
  evaluate: <T>(script: string) => Promise<T>,
  text: string,
  options?: DomTextQueryOptions
): Promise<DomTextClickResult> {
  return evaluate<DomTextClickResult>(buildTextClickInDomScript(text, options));
}

export async function textExistsInDom(
  evaluate: <T>(script: string) => Promise<T>,
  text: string,
  options?: DomTextQueryOptions
): Promise<boolean> {
  return evaluate<boolean>(buildTextExistsInDomScript(text, options));
}

export async function findTextUsingStrategy(
  text: string,
  options: BrowserTextQueryOptions | undefined,
  callbacks: TextFindStrategyCallbacks
): Promise<TextLookupResult> {
  const strategy = options?.strategy ?? 'auto';
  const timeoutMs = options?.timeoutMs ?? options?.timeout ?? 0;
  const enableOcrFallback =
    strategy === 'ocr' || (strategy === 'auto' && (timeoutMs <= 0 || timeoutMs > 300));
  const ocrTimeoutMs = options?.timeoutMs ?? options?.timeout ?? 5000;

  if (strategy === 'dom' || strategy === 'auto') {
    const domBounds = await callbacks.findTextInDom(text, options);
    if (domBounds) {
      return { bounds: domBounds, strategy: 'dom' };
    }
    if (strategy === 'dom') {
      return { bounds: null, strategy: 'dom' };
    }
  }

  if (!enableOcrFallback) {
    return { bounds: null, strategy: 'none' };
  }

  try {
    const bounds = await callbacks.findTextInOcr(text, {
      exactMatch: options?.exactMatch,
      region: options?.region,
      timeoutMs: ocrTimeoutMs,
      signal: options?.signal,
    });
    return { bounds, strategy: bounds ? 'ocr' : 'none' };
  } catch (error) {
    if (strategy === 'auto' && isRecoverableTextLookupError(error)) {
      return { bounds: null, strategy: 'none' };
    }
    throw error;
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForTextUsingStrategy(
  text: string,
  options: BrowserTextQueryOptions | undefined,
  callbacks: TextWaitStrategyCallbacks
): Promise<TextWaitResult> {
  const timeoutMs = options?.timeoutMs ?? options?.timeout ?? 0;
  const startedAt = Date.now();
  const strategy = options?.strategy ?? 'auto';
  const enableOcrFallback =
    strategy === 'ocr' || (strategy === 'auto' && (timeoutMs <= 0 || timeoutMs > 300));
  const ocrReserveMs =
    strategy === 'auto' && timeoutMs > 300
      ? Math.min(1000, Math.max(250, Math.floor(timeoutMs * 0.4)))
      : 0;
  const domBudgetMs =
    strategy === 'auto' && timeoutMs > 0 ? Math.max(0, timeoutMs - ocrReserveMs) : timeoutMs;
  const sleep = callbacks.sleep ?? defaultSleep;

  if (strategy === 'dom' || strategy === 'auto') {
    const domDeadline = Date.now() + domBudgetMs;
    do {
      const domBounds = await callbacks.findTextInDom(text, options);
      if (domBounds) {
        return { bounds: domBounds, strategy: 'dom', timedOut: false };
      }
      if (domBudgetMs <= 0) break;
      await sleep(150);
    } while (Date.now() < domDeadline);

    if (strategy === 'dom') {
      return { bounds: null, strategy: 'dom', timedOut: timeoutMs > 0 };
    }
  }

  if (!enableOcrFallback) {
    return { bounds: null, strategy: 'none', timedOut: timeoutMs > 0 };
  }

  const remaining = timeoutMs > 0 ? Math.max(0, timeoutMs - (Date.now() - startedAt)) : 0;
  try {
    if (remaining > 0) {
      const bounds = await callbacks.waitForTextInOcr(text, {
        exactMatch: options?.exactMatch,
        region: options?.region,
        timeoutMs: remaining,
        signal: options?.signal,
      });
      return { bounds, strategy: 'ocr', timedOut: false };
    }

    if (timeoutMs > 0) {
      return { bounds: null, strategy: 'none', timedOut: true };
    }

    const bounds = await callbacks.findTextInOcr(text, {
      exactMatch: options?.exactMatch,
      region: options?.region,
      timeoutMs: 5000,
      signal: options?.signal,
    });
    return { bounds, strategy: bounds ? 'ocr' : 'none', timedOut: false };
  } catch (error) {
    if (error instanceof TextNotFoundError) {
      return { bounds: null, strategy: 'ocr', timedOut: remaining > 0 };
    }
    if (strategy === 'auto' && isRecoverableTextLookupError(error)) {
      return { bounds: null, strategy: 'none', timedOut: false };
    }
    throw error;
  }
}

export function toTextMatchNormalizedResult(
  viewport: ViewportConfig,
  result: TextLookupResult
): BrowserTextMatchNormalizedResult {
  if (!result.bounds) {
    return {
      normalizedBounds: null,
      matchSource: result.strategy,
    };
  }

  return {
    normalizedBounds: {
      x: (result.bounds.x / viewport.width) * 100,
      y: (result.bounds.y / viewport.height) * 100,
      width: (result.bounds.width / viewport.width) * 100,
      height: (result.bounds.height / viewport.height) * 100,
      space: 'normalized',
    },
    matchSource: result.strategy,
  };
}
