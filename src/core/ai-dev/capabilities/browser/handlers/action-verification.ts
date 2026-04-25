import { getSelectorEngineScript } from '../../../../browser-automation/selector-generator';
import {
  ErrorCode,
  createStructuredError,
  type StructuredError,
} from '../../../../../types/error-codes';
import { getBrowserTextExistenceFeatures } from './shared';
import {
  createFeatureUnavailableError,
  createTimedOutError,
} from './mcp-surface-errors';
import { getTextQueryOptions } from './text-query';
import {
  asNonEmptyString,
  asStructuredError,
  buildTargetContext,
  getTargetLabel,
  resolveElementTarget,
  type ElementTargetInput,
  type ResolvedElementTarget,
} from './target-resolution';
import type { BrowserInterface } from './types';
import type { TextRegionV3 } from '../tool-v3-shapes';
import type {
  ActionWaitTargetGroupInput as WaitConditionGroup,
  ActionWaitTargetInput,
  ElementActionWaitTargetInput as ElementWaitCondition,
  TextAbsentActionWaitTargetInput,
  TextActionWaitTargetInput,
  UrlActionWaitTargetInput as UrlWaitCondition,
} from '../wait-target-normalization';
export type { ActionWaitTargetInput } from '../wait-target-normalization';

type WaitConditionState = 'attached' | 'visible';
type TextWaitCondition = TextActionWaitTargetInput | TextAbsentActionWaitTargetInput;

export type ActionWaitTargetDescriptor =
  | {
      type: 'selector' | 'ref' | 'text' | 'textGone' | 'urlIncludes';
      value: string;
      selector?: string | null;
      ref?: string | null;
      source?: string | null;
      state?: WaitConditionState | null;
      conditions?: undefined;
    }
  | {
      type: 'allOf' | 'anyOf';
      value: 'allOf' | 'anyOf';
      selector?: null;
      ref?: null;
      source?: null;
      conditions: ActionWaitTargetDescriptor[];
    };

export type PageFingerprint = {
  url: string;
  title: string;
  readyState: string;
  bodyTextSample: string;
  bodyTextLength: number;
  activeTag: string;
  activeType: string;
  historyLength: number;
};

export type ActionVerificationSummary = {
  beforeUrl: string;
  afterUrl: string;
  navigationOccurred: boolean;
  waitApplied: boolean;
  waitTarget: ActionWaitTargetDescriptor | null;
  verified: boolean;
  verificationMethod: string | null;
  primaryEffect: ActionEffectType;
  effectSignals: ActionEffectSignal[];
  verificationEvidence: Record<string, unknown>;
};

export type SubmitMethod = 'none' | 'native-enter' | 'requestSubmit' | 'submit' | 'dispatch';
export type ActionEffectSignal = 'waitFor' | 'target-click-event' | 'url-changed' | 'dom-changed';
export type ActionEffectType = ActionEffectSignal | 'none';

export type SubmitFallbackResult = {
  submitted: boolean;
  method: 'requestSubmit' | 'submit' | 'dispatch' | 'none';
  formPresent: boolean;
  targetTag: string | null;
  formTag: string | null;
  dispatchResult: boolean | null;
};

export type DomClickResult = {
  clicked: boolean;
  clickTargetTag: string | null;
  href: string | null;
};

export type DomAnchorAssignResult = {
  clicked: boolean;
  href: string | null;
  anchorTag: string | null;
  dispatchAllowed: boolean | null;
};

const wait = async (ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

function isLegacyWaitConditionGroup(
  value: ActionWaitTargetInput
): value is WaitConditionGroup {
  return value.kind === 'all' || value.kind === 'any';
}

function isElementWaitCondition(
  value: ActionWaitTargetInput
): value is ElementWaitCondition {
  return value.kind === 'element';
}

function isTextWaitCondition(
  value: ActionWaitTargetInput
): value is TextWaitCondition {
  return value.kind === 'text' || value.kind === 'text_absent';
}

function isUrlWaitCondition(
  value: ActionWaitTargetInput
): value is UrlWaitCondition {
  return value.kind === 'url';
}

function getWaitConditionState(value: ActionWaitTargetInput): WaitConditionState | undefined {
  return value.kind === 'element' &&
    (value.state === 'visible' || value.state === 'attached')
    ? value.state
    : undefined;
}

function getElementTargetInput(value: ElementWaitCondition): ElementTargetInput {
  return {
    selector: value.selector,
    ref: value.ref,
  };
}

function getTextWaitPayload(
  value: TextWaitCondition
): {
  targetText: string;
  absent: boolean;
  strategy?: 'auto' | 'dom' | 'ocr';
  exactMatch?: boolean;
  region?: TextRegionV3;
} {
  return {
    targetText: value.text,
    absent: value.kind === 'text_absent',
    strategy: value.strategy,
    exactMatch: value.exactMatch,
    region: value.region,
  };
}

function toActionWaitDescriptor(
  input: Exclude<ActionWaitTargetInput, WaitConditionGroup>,
  resolved?: ResolvedElementTarget | null
): ActionWaitTargetDescriptor {
  if (isElementWaitCondition(input)) {
    const fallbackSelector = input.selector || null;
    const fallbackRef = input.ref || null;
    const source = resolved?.source || (fallbackSelector ? 'selector' : 'ref');
    return {
      type: source === 'ref' ? 'ref' : 'selector',
      value: resolved?.ref || resolved?.selector || fallbackRef || fallbackSelector || '',
      selector: resolved?.selector || fallbackSelector,
      ref: resolved?.ref || fallbackRef,
      source,
      state: getWaitConditionState(input) || null,
    };
  }

  if (isTextWaitCondition(input)) {
    const textPayload = getTextWaitPayload(input);
    return {
      type: textPayload.absent ? 'textGone' : 'text',
      value: textPayload.targetText,
      selector: null,
      ref: null,
      source: null,
      state: null,
    };
  }

  return {
    type: 'urlIncludes',
    value: input.urlIncludes,
    selector: null,
    ref: null,
    source: null,
    state: null,
  };
}

export function describeWaitCondition(waitFor: ActionWaitTargetInput): string {
  if (isLegacyWaitConditionGroup(waitFor)) {
    if (waitFor.kind === 'all') {
      return `all(${waitFor.conditions.map((item) => describeWaitCondition(item)).join(', ')})`;
    }
    return `any(${waitFor.conditions.map((item) => describeWaitCondition(item)).join(', ')})`;
  }
  if (isElementWaitCondition(waitFor)) {
    const label = waitFor.ref ? `elementRef ${waitFor.ref}` : `selector ${waitFor.selector}`;
    return getWaitConditionState(waitFor) === 'visible' ? `${label} visible` : label;
  }
  if (isTextWaitCondition(waitFor)) {
    const textPayload = getTextWaitPayload(waitFor);
    return textPayload.absent ? `text absent "${textPayload.targetText}"` : `text "${textPayload.targetText}"`;
  }
  if (isUrlWaitCondition(waitFor)) {
    return `url includes "${waitFor.urlIncludes}"`;
  }
  return 'unknown wait condition';
}

export async function getCurrentUrlSafe(browser: BrowserInterface): Promise<string> {
  try {
    return (await browser.getCurrentUrl()) || '';
  } catch {
    return '';
  }
}

export async function capturePageFingerprint(browser: BrowserInterface): Promise<PageFingerprint> {
  const currentUrl = await getCurrentUrlSafe(browser);
  try {
    return await browser.evaluate<PageFingerprint>(`
      (function() {
        const bodyText = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        const active = document.activeElement;
        return {
          url: window.location.href || ${JSON.stringify(currentUrl)},
          title: document.title || '',
          readyState: document.readyState || 'unknown',
          bodyTextSample: bodyText.slice(0, 300),
          bodyTextLength: bodyText.length,
          activeTag: active?.tagName || '',
          activeType: active && 'type' in active ? String(active.type || '') : '',
          historyLength: Number(window.history?.length || 0),
        };
      })()
    `);
  } catch {
    return {
      url: currentUrl,
      title: '',
      readyState: 'unknown',
      bodyTextSample: '',
      bodyTextLength: 0,
      activeTag: '',
      activeType: '',
      historyLength: 0,
    };
  }
}

function didFingerprintChange(before: PageFingerprint, after: PageFingerprint): boolean {
  return (
    before.url !== after.url ||
    before.title !== after.title ||
    before.readyState !== after.readyState ||
    before.bodyTextSample !== after.bodyTextSample ||
    before.bodyTextLength !== after.bodyTextLength ||
    before.activeTag !== after.activeTag ||
    before.activeType !== after.activeType ||
    before.historyLength !== after.historyLength
  );
}

async function checkWaitConditionOnce(
  browser: BrowserInterface,
  waitFor: ActionWaitTargetInput,
  perCheckTimeoutMs: number
): Promise<ActionWaitTargetDescriptor | null> {
  if (isLegacyWaitConditionGroup(waitFor)) {
    if (waitFor.kind === 'all') {
      const conditions: ActionWaitTargetDescriptor[] = [];
      for (const condition of waitFor.conditions) {
        const descriptor = await checkWaitConditionOnce(browser, condition, perCheckTimeoutMs);
        if (!descriptor) {
          return null;
        }
        conditions.push(descriptor);
      }
      return {
        type: 'allOf',
        value: 'allOf',
        selector: null,
        ref: null,
        source: null,
        conditions,
      };
    }

    for (const condition of waitFor.conditions) {
      const descriptor = await checkWaitConditionOnce(browser, condition, perCheckTimeoutMs);
      if (descriptor) {
        return {
          type: 'anyOf',
          value: 'anyOf',
          selector: null,
          ref: null,
          source: null,
          conditions: [descriptor],
        };
      }
    }
    return null;
  }

  if (isElementWaitCondition(waitFor)) {
    const elementTargetInput = getElementTargetInput(waitFor);
    const resolvedTarget = await resolveElementTarget(browser, elementTargetInput, {
      requireCurrentMatch: false,
    });
    const selectorsToTry = resolvedTarget.selectorCandidates?.length
      ? resolvedTarget.selectorCandidates
      : [resolvedTarget.selector];

    for (const selector of selectorsToTry) {
      try {
        await browser.waitForSelector(selector, {
          timeout: Math.max(1, perCheckTimeoutMs),
          state: getWaitConditionState(waitFor) || 'attached',
        });
        return toActionWaitDescriptor(waitFor, {
          ...resolvedTarget,
          selector,
        });
      } catch {
        // Try the next selector candidate.
      }
    }
    return null;
  }

  if (isTextWaitCondition(waitFor)) {
    const textBrowser = getBrowserTextExistenceFeatures(browser);
    if (!textBrowser) {
      throw createFeatureUnavailableError('text-based action verification');
    }
    const textPayload = getTextWaitPayload(waitFor);
    const queryOptions = await getTextQueryOptions(
      {
        strategy: textPayload.strategy || 'auto',
        exactMatch: textPayload.exactMatch === true,
        timeoutMs: perCheckTimeoutMs,
        region: textPayload.region,
      },
      textBrowser
    );
    const exists = await textBrowser.textExists(textPayload.targetText, queryOptions);
    if ((!textPayload.absent && exists) || (textPayload.absent && !exists)) {
      return toActionWaitDescriptor(waitFor);
    }
    return null;
  }

  if (!isUrlWaitCondition(waitFor)) {
    return null;
  }

  const currentUrl = await getCurrentUrlSafe(browser);
  if (currentUrl.includes(waitFor.urlIncludes)) {
    return toActionWaitDescriptor(waitFor);
  }
  return null;
}

export async function waitForActionVerificationTarget(
  browser: BrowserInterface,
  waitFor: ActionWaitTargetInput | undefined,
  timeoutMs: number,
  options: { pollIntervalMs?: number } = {}
): Promise<ActionWaitTargetDescriptor | null> {
  if (!waitFor) {
    return null;
  }

  const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 150);
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let lastResolvedTarget: ResolvedElementTarget | null = null;

  while (Date.now() <= deadline) {
    try {
      const descriptor = await checkWaitConditionOnce(
        browser,
        waitFor,
        Math.max(1, Math.min(pollIntervalMs, deadline - Date.now()))
      );
      if (descriptor) {
        return descriptor;
      }
    } catch (error) {
      const structured = asStructuredError(error);
      if (structured?.code === ErrorCode.INVALID_PARAMETER) {
        throw structured;
      }
      if (structured && structured.code !== ErrorCode.ELEMENT_NOT_FOUND) {
        throw structured;
      }
      if (
        structured?.context &&
        typeof structured.context === 'object' &&
        'selectorCandidates' in structured.context
      ) {
        lastResolvedTarget = {
          selector: asNonEmptyString((structured.context as Record<string, unknown>).selector),
          source:
            asNonEmptyString((structured.context as Record<string, unknown>).source) === 'ref'
              ? 'ref'
              : 'selector',
          ref: asNonEmptyString((structured.context as Record<string, unknown>).ref) || undefined,
          selectorCandidates: Array.isArray(
            (structured.context as Record<string, unknown>).selectorCandidates
          )
            ? ((structured.context as Record<string, unknown>).selectorCandidates as string[])
            : undefined,
        };
      }
    }

    await wait(pollIntervalMs);
  }

  const targetInput = isElementWaitCondition(waitFor) ? getElementTargetInput(waitFor) : undefined;

  throw createTimedOutError(`Wait for ${describeWaitCondition(waitFor)}`, {
    suggestion:
      'Verify the wait condition or increase timeoutMs. Use browser_snapshot to capture fresh refs when needed.',
    context: {
      ...(targetInput ? buildTargetContext(targetInput, lastResolvedTarget || undefined) : {}),
      waitFor,
      timeoutMs,
    },
  });
}

export async function armClickVerificationProbe(
  browser: BrowserInterface,
  selector: string
): Promise<string | null> {
  try {
    const result = await browser.evaluate<string | null>(`
      ${getSelectorEngineScript().trim()};
      (function() {
        const selector = ${JSON.stringify(selector)};
        const engine = window.__selectorEngine;
        const el = engine?.querySelector(selector);
        if (!el) return null;
        const probeId = 'airpa-click-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const store = (window.__airpaClickProbes = window.__airpaClickProbes || {});
        const state = {
          events: 0,
          lastTrusted: false,
          lastTag: '',
        };
        const handler = function(event) {
          state.events += 1;
          state.lastTrusted = event.isTrusted === true;
          state.lastTag = event.currentTarget && event.currentTarget.tagName
            ? String(event.currentTarget.tagName)
            : '';
        };
        el.addEventListener('click', handler, { capture: true });
        store[probeId] = { el, handler, state };
        return probeId;
      })()
    `);
    return asNonEmptyString(result) || null;
  } catch {
    return null;
  }
}

async function readClickVerificationProbe(
  browser: BrowserInterface,
  probeId: string | null
): Promise<{ events: number; lastTrusted: boolean; lastTag: string } | null> {
  if (!probeId) {
    return null;
  }
  try {
    return await browser.evaluate<{ events: number; lastTrusted: boolean; lastTag: string } | null>(`
      (function() {
        const entry = window.__airpaClickProbes?.[${JSON.stringify(probeId)}];
        if (!entry) return null;
        return {
          events: Number(entry.state?.events || 0),
          lastTrusted: entry.state?.lastTrusted === true,
          lastTag: String(entry.state?.lastTag || ''),
        };
      })()
    `);
  } catch {
    return null;
  }
}

export async function clearClickVerificationProbe(
  browser: BrowserInterface,
  probeId: string | null
): Promise<void> {
  if (!probeId) {
    return;
  }
  try {
    await browser.evaluate<void>(`
      (function() {
        const probeId = ${JSON.stringify(probeId)};
        const entry = window.__airpaClickProbes?.[probeId];
        if (!entry) return;
        try {
          entry.el?.removeEventListener?.('click', entry.handler, { capture: true });
        } catch (_error) {
          // ignore
        }
        delete window.__airpaClickProbes[probeId];
      })()
    `);
  } catch {
    // ignore
  }
}

type InputProbeSnapshot = {
  events: Record<'keydown' | 'keypress' | 'beforeinput' | 'input' | 'change' | 'keyup', number>;
  trustedEvents: Record<'keydown' | 'keypress' | 'beforeinput' | 'input' | 'change' | 'keyup', number>;
  lastInputType: string;
  lastData: string;
  lastKey: string;
  active: boolean;
};

export async function armInputVerificationProbe(
  browser: BrowserInterface,
  selector: string
): Promise<string | null> {
  try {
    const result = await browser.evaluate<string | null>(`
      ${getSelectorEngineScript().trim()};
      (function() {
        const selector = ${JSON.stringify(selector)};
        const engine = window.__selectorEngine;
        const targetEl = engine ? engine.querySelector(selector) : null;
        if (!targetEl) return null;
        const probeId = 'airpa-input-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const store = (window.__airpaInputProbes = window.__airpaInputProbes || {});
        const eventNames = ['keydown', 'keypress', 'beforeinput', 'input', 'change', 'keyup'];
        const state = {
          events: {
            keydown: 0,
            keypress: 0,
            beforeinput: 0,
            input: 0,
            change: 0,
            keyup: 0,
          },
          trustedEvents: {
            keydown: 0,
            keypress: 0,
            beforeinput: 0,
            input: 0,
            change: 0,
            keyup: 0,
          },
          lastInputType: '',
          lastData: '',
          lastKey: '',
        };
        const handlers = {};
        for (const name of eventNames) {
          handlers[name] = function(event) {
            state.events[name] += 1;
            if (event.isTrusted === true) {
              state.trustedEvents[name] += 1;
            }
            if ((name === 'beforeinput' || name === 'input') && 'inputType' in event) {
              state.lastInputType = String(event.inputType || '');
            }
            if ((name === 'beforeinput' || name === 'input') && 'data' in event) {
              state.lastData = event.data == null ? '' : String(event.data);
            }
            if ((name === 'keydown' || name === 'keypress' || name === 'keyup') && 'key' in event) {
              state.lastKey = String(event.key || '');
            }
          };
          targetEl.addEventListener(name, handlers[name], { capture: true });
        }
        store[probeId] = { el: targetEl, handlers, state };
        return probeId;
      })()
    `);
    return asNonEmptyString(result) || null;
  } catch {
    return null;
  }
}

export async function readInputVerificationProbe(
  browser: BrowserInterface,
  probeId: string | null
): Promise<InputProbeSnapshot | null> {
  if (!probeId) {
    return null;
  }
  try {
    return await browser.evaluate<InputProbeSnapshot | null>(`
      (function() {
        const entry = window.__airpaInputProbes?.[${JSON.stringify(probeId)}];
        if (!entry) return null;
        return {
          events: {
            keydown: Number(entry.state?.events?.keydown || 0),
            keypress: Number(entry.state?.events?.keypress || 0),
            beforeinput: Number(entry.state?.events?.beforeinput || 0),
            input: Number(entry.state?.events?.input || 0),
            change: Number(entry.state?.events?.change || 0),
            keyup: Number(entry.state?.events?.keyup || 0),
          },
          trustedEvents: {
            keydown: Number(entry.state?.trustedEvents?.keydown || 0),
            keypress: Number(entry.state?.trustedEvents?.keypress || 0),
            beforeinput: Number(entry.state?.trustedEvents?.beforeinput || 0),
            input: Number(entry.state?.trustedEvents?.input || 0),
            change: Number(entry.state?.trustedEvents?.change || 0),
            keyup: Number(entry.state?.trustedEvents?.keyup || 0),
          },
          lastInputType: String(entry.state?.lastInputType || ''),
          lastData: String(entry.state?.lastData || ''),
          lastKey: String(entry.state?.lastKey || ''),
          active: document.activeElement === entry.el,
        };
      })()
    `);
  } catch {
    return null;
  }
}

export async function clearInputVerificationProbe(
  browser: BrowserInterface,
  probeId: string | null
): Promise<void> {
  if (!probeId) {
    return;
  }
  try {
    await browser.evaluate<void>(`
      (function() {
        const probeId = ${JSON.stringify(probeId)};
        const entry = window.__airpaInputProbes?.[probeId];
        if (!entry) return;
        const eventNames = ['keydown', 'keypress', 'beforeinput', 'input', 'change', 'keyup'];
        for (const name of eventNames) {
          try {
            entry.el?.removeEventListener?.(name, entry.handlers?.[name], { capture: true });
          } catch (_error) {
            // ignore
          }
        }
        delete window.__airpaInputProbes[probeId];
      })()
    `);
  } catch {
    // ignore
  }
}

export async function readTypedElementState(
  browser: BrowserInterface,
  selector: string
): Promise<{ value: string | null; textContent: string; active: boolean } | null> {
  try {
    return await browser.evaluate<{
      value: string | null;
      textContent: string;
      active: boolean;
    } | null>(`
      ${getSelectorEngineScript().trim()};
      (function() {
        const selector = ${JSON.stringify(selector)};
        const engine = window.__selectorEngine;
        const el = engine?.querySelector(selector);
        if (!el) return null;
        const hasValue = 'value' in el;
        return {
          value: hasValue ? String(el.value ?? '') : null,
          textContent: String(el.textContent || '').trim(),
          active: document.activeElement === el,
        };
      })()
    `);
  } catch {
    return null;
  }
}

export async function submitElementOrAncestorForm(
  browser: BrowserInterface,
  selector: string
): Promise<SubmitFallbackResult> {
  try {
    const result = await browser.evaluate<SubmitFallbackResult>(`
      ${getSelectorEngineScript().trim()};
      (function() {
        const selector = ${JSON.stringify(selector)};
        const engine = window.__selectorEngine;
        const el = engine?.querySelector(selector);
        const targetTag = el && el.tagName ? String(el.tagName || '') : null;
        if (!el) {
          return {
            submitted: false,
            method: 'none',
            formPresent: false,
            targetTag,
            formTag: null,
            dispatchResult: null,
          };
        }

        const form = typeof el.closest === 'function' ? el.closest('form') : null;
        const formTag = form && form.tagName ? String(form.tagName || '') : null;
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          return {
            submitted: true,
            method: 'requestSubmit',
            formPresent: true,
            targetTag,
            formTag,
            dispatchResult: null,
          };
        }

        if (form && typeof form.submit === 'function') {
          form.submit();
          return {
            submitted: true,
            method: 'submit',
            formPresent: true,
            targetTag,
            formTag,
            dispatchResult: null,
          };
        }

        if (typeof el.dispatchEvent === 'function') {
          const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
          });
          const dispatchResult = el.dispatchEvent(event);
          return {
            submitted: true,
            method: 'dispatch',
            formPresent: false,
            targetTag,
            formTag,
            dispatchResult,
          };
        }

        return {
          submitted: false,
          method: 'none',
          formPresent: Boolean(form),
          targetTag,
          formTag,
          dispatchResult: null,
        };
      })()
    `);
    return result;
  } catch {
    return {
      submitted: false,
      method: 'none',
      formPresent: false,
      targetTag: null,
      formTag: null,
      dispatchResult: null,
    };
  }
}

export async function performDomClick(
  browser: BrowserInterface,
  selector: string
): Promise<DomClickResult> {
  try {
    return await browser.evaluate<DomClickResult>(`
      ${getSelectorEngineScript().trim()};
      (function() {
        const selector = ${JSON.stringify(selector)};
        const engine = window.__selectorEngine;
        const el = engine?.querySelector(selector);
        const clickTarget =
          typeof el?.closest === 'function'
            ? (el.closest('a[href],button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"],label,summary') || el)
            : el;
        const href =
          clickTarget && typeof clickTarget.href === 'string' && clickTarget.href
            ? String(clickTarget.href)
            : null;
        if (!clickTarget) {
          return { clicked: false, clickTargetTag: null, href: null };
        }
        if (typeof clickTarget.scrollIntoView === 'function') {
          clickTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        }
        if (typeof clickTarget.click === 'function') {
          clickTarget.click();
          return {
            clicked: true,
            clickTargetTag: clickTarget.tagName ? String(clickTarget.tagName || '') : null,
            href,
          };
        }
        return {
          clicked: false,
          clickTargetTag: clickTarget.tagName ? String(clickTarget.tagName || '') : null,
          href,
        };
      })()
    `);
  } catch {
    return {
      clicked: false,
      clickTargetTag: null,
      href: null,
    };
  }
}

export async function performDomAnchorAssign(
  browser: BrowserInterface,
  selector: string
): Promise<DomAnchorAssignResult> {
  try {
    return await browser.evaluate<DomAnchorAssignResult>(`
      ${getSelectorEngineScript().trim()};
      (function() {
        const selector = ${JSON.stringify(selector)};
        const engine = window.__selectorEngine;
        const el = engine?.querySelector(selector);
        const anchor =
          el && typeof el.closest === 'function'
            ? el.closest('a[href]')
            : null;
        if (!anchor || typeof anchor.href !== 'string' || !anchor.href) {
          return { clicked: false, href: null, anchorTag: null, dispatchAllowed: null };
        }
        if (typeof anchor.scrollIntoView === 'function') {
          anchor.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        }
        const clickEvent = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
        });
        const notCanceled = anchor.dispatchEvent(clickEvent);
        if (notCanceled) {
          window.location.assign(anchor.href);
        }
        return {
          clicked: true,
          href: String(anchor.href || '') || null,
          anchorTag: anchor.tagName ? String(anchor.tagName || '') : null,
          dispatchAllowed: notCanceled,
        };
      })()
    `);
  } catch {
    return { clicked: false, href: null, anchorTag: null, dispatchAllowed: null };
  }
}

export async function readAnchorHref(
  browser: BrowserInterface,
  selector: string
): Promise<string | null> {
  try {
    return await browser.evaluate<string | null>(`
      ${getSelectorEngineScript().trim()};
      (function() {
        const selector = ${JSON.stringify(selector)};
        const engine = window.__selectorEngine;
        const el = engine?.querySelector(selector);
        const anchor =
          el && typeof el.closest === 'function'
            ? el.closest('a[href]')
            : null;
        return anchor && typeof anchor.href === 'string' && anchor.href
          ? String(anchor.href)
          : null;
      })()
    `);
  } catch {
    return null;
  }
}

export async function buildDefaultActionVerification(
  browser: BrowserInterface,
  beforeFingerprint: PageFingerprint,
  options: {
    waitFor?: ActionWaitTargetInput;
    timeoutMs?: number;
    clickProbeId?: string | null;
    pollIntervalMs?: number;
    suppressWaitTimeout?: boolean;
  } = {}
): Promise<ActionVerificationSummary> {
  const beforeUrl = beforeFingerprint.url;
  let waitTarget: ActionWaitTargetDescriptor | null = null;
  let waitTimedOut = false;

  try {
    waitTarget = await waitForActionVerificationTarget(
      browser,
      options.waitFor,
      options.timeoutMs ?? 5000,
      {
        pollIntervalMs: options.pollIntervalMs,
      }
    );
  } catch (error) {
    const structured = asStructuredError(error);
    if (structured?.code === ErrorCode.WAIT_TIMEOUT && options.suppressWaitTimeout === true) {
      waitTimedOut = true;
    } else if (structured) {
      throw structured;
    } else {
      throw error;
    }
  }

  if (!waitTarget && !waitTimedOut) {
    await wait(250);
  }

  const afterFingerprint = await capturePageFingerprint(browser);
  const afterUrl = afterFingerprint.url;
  const navigationOccurred = Boolean(beforeUrl && afterUrl && beforeUrl !== afterUrl);
  const pageChanged = didFingerprintChange(beforeFingerprint, afterFingerprint);
  const clickProbe = await readClickVerificationProbe(browser, options.clickProbeId || null);
  const clickEventMatched = Boolean(clickProbe && clickProbe.events > 0);
  const effectSignals: ActionEffectSignal[] = [];

  if (waitTarget) {
    effectSignals.push('waitFor');
  }
  if (clickEventMatched) {
    effectSignals.push('target-click-event');
  }
  if (navigationOccurred) {
    effectSignals.push('url-changed');
  }
  if (pageChanged) {
    effectSignals.push('dom-changed');
  }

  const verified = waitTarget !== null || clickEventMatched || navigationOccurred || pageChanged;
  const primaryEffect: ActionEffectType = waitTarget
    ? 'waitFor'
    : clickEventMatched
      ? 'target-click-event'
      : navigationOccurred
        ? 'url-changed'
        : pageChanged
          ? 'dom-changed'
          : 'none';
  const verificationMethod = primaryEffect === 'none' ? null : primaryEffect;

  return {
    beforeUrl,
    afterUrl,
    navigationOccurred,
    waitApplied: waitTarget !== null,
    waitTarget,
    verified,
    verificationMethod,
    primaryEffect,
    effectSignals,
    verificationEvidence: {
      clickEventMatched,
      clickProbe,
      pageChanged,
      waitTimedOut,
      beforeFingerprint,
      afterFingerprint,
    },
  };
}

export function createUnverifiedActionError(
  tool: string,
  message: string,
  context: Record<string, unknown>
): StructuredError {
  return createStructuredError(ErrorCode.ACTION_UNVERIFIED, message, {
    details:
      'The action was issued but no verified post-condition, target event, or observable page-state change was detected.',
    suggestion:
      'Provide an explicit verification condition, or inspect browser_snapshot/browser_observe before retrying.',
    context: {
      tool,
      ...context,
    },
  });
}

export function createInteractionNotReadyError(
  context: Record<string, unknown>
): StructuredError {
  return createStructuredError(
    ErrorCode.INTERACTION_NOT_READY,
    'The current MCP browser session is not ready for interaction',
    {
      details:
        'The browser host or viewport could not be restored to a stable interactive state before executing the action.',
      suggestion:
        'Inspect browser_snapshot or session_get_current for host and viewport health before retrying.',
      context,
    }
  );
}

export function buildResolvedTargetPayload(
  targetInput: ElementTargetInput,
  resolvedTarget: ResolvedElementTarget | null | undefined
): Record<string, unknown> {
  return {
    selector: resolvedTarget?.selector ?? targetInput.selector ?? null,
    source: resolvedTarget?.source ?? (targetInput.selector ? 'selector' : targetInput.ref ? 'ref' : null),
    ref: resolvedTarget?.ref ?? targetInput.ref ?? null,
    selectorCandidates: resolvedTarget?.selectorCandidates ?? null,
  };
}

export function buildUnverifiedActionMessage(
  targetInput: ElementTargetInput,
  resolvedTarget: ResolvedElementTarget | undefined
): string {
  return `Action completed but produced no verified effect: ${getTargetLabel(targetInput, resolvedTarget)}`;
}
