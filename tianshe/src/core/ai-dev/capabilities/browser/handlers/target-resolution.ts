import {
  getElementRefSelectors,
  summarizeElementRef,
} from '../../../../browser-automation/element-ref';
import { getSelectorEngineScript } from '../../../../browser-automation/selector-generator';
import { ErrorCode, createStructuredError, type StructuredError } from '../../../../../types/error-codes';
import type { BrowserInterface } from './types';

export type ElementTargetInput = {
  selector?: string;
  ref?: string;
};

export type ResolvedElementTarget = {
  selector: string;
  source: 'selector' | 'ref';
  ref?: string;
  selectorCandidates?: string[];
};

export function asNonEmptyString(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

export function asStructuredError(error: unknown): StructuredError | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as Partial<StructuredError>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') {
    return null;
  }

  return {
    code: candidate.code,
    message: candidate.message,
    ...(typeof candidate.details === 'string' ? { details: candidate.details } : {}),
    ...(typeof candidate.suggestion === 'string' ? { suggestion: candidate.suggestion } : {}),
    ...(candidate.context && typeof candidate.context === 'object'
      ? { context: candidate.context as Record<string, unknown> }
      : {}),
  };
}

async function selectorExists(browser: BrowserInterface, selector: string): Promise<boolean> {
  try {
    return await browser.evaluate<boolean>(`
      ${getSelectorEngineScript().trim()};
      (function() {
        try {
          const engine = window.__selectorEngine;
          return !!(engine?.querySelector
            ? engine.querySelector(${JSON.stringify(selector)})
            : document.querySelector(${JSON.stringify(selector)}));
        } catch (_error) {
          return false;
        }
      })()
    `);
  } catch {
    return false;
  }
}

export function getTargetLabel(
  target: ElementTargetInput,
  resolved?: ResolvedElementTarget
): string {
  if (resolved?.source === 'ref' && resolved.ref) {
    return summarizeElementRef(resolved.ref);
  }
  if (target.ref) {
    try {
      return summarizeElementRef(target.ref);
    } catch {
      return 'elementRef';
    }
  }
  return target.selector ? `selector ${target.selector}` : 'element';
}

export function buildTargetContext(
  target: ElementTargetInput,
  resolved?: ResolvedElementTarget | null
): Record<string, unknown> {
  return {
    selector: resolved?.selector ?? target.selector ?? null,
    source: resolved?.source ?? (target.selector ? 'selector' : target.ref ? 'ref' : null),
    ref: resolved?.ref ?? target.ref ?? null,
    selectorCandidates: resolved?.selectorCandidates ?? null,
  };
}

export async function resolveElementTarget(
  browser: BrowserInterface,
  target: ElementTargetInput,
  options: { requireCurrentMatch?: boolean } = {}
): Promise<ResolvedElementTarget> {
  const selector = asNonEmptyString(target.selector);
  if (selector) {
    return {
      selector,
      source: 'selector',
    };
  }

  const ref = asNonEmptyString(target.ref);
  if (!ref) {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, 'selector or ref is required');
  }

  let selectorCandidates: string[];
  try {
    selectorCandidates = getElementRefSelectors(ref);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, `Invalid elementRef: ${message}`, {
      suggestion: 'Use the latest elementRef returned by browser_snapshot or browser_search.',
      context: {
        ref,
      },
    });
  }

  for (const candidate of selectorCandidates) {
    if (await selectorExists(browser, candidate)) {
      return {
        selector: candidate,
        source: 'ref',
        ref,
        selectorCandidates,
      };
    }
  }

  if (!options.requireCurrentMatch && selectorCandidates.length > 0) {
    return {
      selector: selectorCandidates[0],
      source: 'ref',
      ref,
      selectorCandidates,
    };
  }

  throw createStructuredError(ErrorCode.ELEMENT_NOT_FOUND, 'elementRef did not resolve on the current page', {
    suggestion: 'Capture a fresh browser_snapshot and use the latest elementRef from that response.',
    context: {
      ref,
      selectorCandidates,
    },
  });
}
