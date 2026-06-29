import type { Bounds } from '../../types/browser-interface';
import type { SelectorQueryResult } from './browser-facade-shared';
import { getSelectorEngineScript } from './selector-generator';

export interface SelectorEngineElementQueryResult extends SelectorQueryResult {
  focused?: boolean;
  interactable?: boolean;
}

type SelectorEngineEvaluate = <T = unknown>(script: string) => Promise<T>;

export async function evaluateWithSelectorEngine<T>(
  evaluate: SelectorEngineEvaluate,
  body: string
): Promise<T> {
  const selectorEngineScript = getSelectorEngineScript().trim();
  const scriptBody = body.trim();

  // Adjacent IIFEs must be separated explicitly, otherwise the page executes
  // `(...)()(...)()` and throws a runtime TypeError.
  return evaluate<T>(`${selectorEngineScript};\n${scriptBody}`);
}

export async function querySelectorElement(
  evaluate: SelectorEngineEvaluate,
  selector: string
): Promise<SelectorEngineElementQueryResult> {
  return evaluateWithSelectorEngine(evaluate, `
    (function() {
      const selector = ${JSON.stringify(selector)};
      const engine = window.__selectorEngine;
      const el = engine?.querySelector(selector);
      if (!el) {
        return { found: false, visible: false };
      }

      let rect = el.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const intersectsViewport = (candidateRect) =>
        candidateRect.right > 0 &&
        candidateRect.bottom > 0 &&
        candidateRect.left < viewportWidth &&
        candidateRect.top < viewportHeight;

      if (!intersectsViewport(rect) && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        rect = el.getBoundingClientRect();
      }

      const rawCenterX = rect.left + rect.width / 2;
      const rawCenterY = rect.top + rect.height / 2;
      const centerX =
        viewportWidth > 1 ? Math.min(Math.max(rawCenterX, 1), viewportWidth - 1) : rawCenterX;
      const centerY =
        viewportHeight > 1 ? Math.min(Math.max(rawCenterY, 1), viewportHeight - 1) : rawCenterY;
      const topElement =
        rect.width > 0 &&
        rect.height > 0 &&
        centerX >= 0 &&
        centerY >= 0 &&
        centerX <= viewportWidth &&
        centerY <= viewportHeight
          ? document.elementFromPoint(centerX, centerY)
          : null;
      const interactable =
        !!topElement && (topElement === el || el.contains(topElement) || topElement.contains(el));

      return {
        found: true,
        visible: engine?.isVisible ? engine.isVisible(el) : true,
        focused: document.activeElement === el,
        interactable,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    })()
  `);
}

export async function focusSelectorElement(
  evaluate: SelectorEngineEvaluate,
  selector: string
): Promise<boolean> {
  return evaluateWithSelectorEngine(evaluate, `
    (function() {
      const el = window.__selectorEngine?.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const intersectsViewport =
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < viewportWidth &&
        rect.top < viewportHeight;
      if (!intersectsViewport && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }
      if (typeof el.focus === 'function') {
        el.focus();
      }
      return document.activeElement === el;
    })()
  `);
}

export async function clickSelectorElementInDom(
  evaluate: SelectorEngineEvaluate,
  selector: string
): Promise<boolean> {
  return evaluateWithSelectorEngine(evaluate, `
    (function() {
      const el = window.__selectorEngine?.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }
      if (typeof el.click === 'function') {
        el.click();
        return true;
      }
      return false;
    })()
  `);
}

export async function readSelectorElementValue<T>(
  evaluate: SelectorEngineEvaluate,
  selector: string,
  expression: string
): Promise<T | null> {
  return evaluateWithSelectorEngine(evaluate, `
    (function() {
      const el = window.__selectorEngine?.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      return (${expression});
    })()
  `);
}

export async function readEditableSelectorValue(
  evaluate: SelectorEngineEvaluate,
  selector: string
): Promise<string | null> {
  return readSelectorElementValue<string | null>(
    evaluate,
    selector,
    `(() => {
      if ('value' in el) {
        return String(el.value ?? '');
      }
      if (el.isContentEditable) {
        return String(el.innerText || el.textContent || '');
      }
      return null;
    })()`
  );
}

export async function writeEditableSelectorValue(
  evaluate: SelectorEngineEvaluate,
  selector: string,
  value: string
): Promise<boolean> {
  return evaluateWithSelectorEngine(evaluate, `
    (function() {
      const el = window.__selectorEngine?.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const nextValue = ${JSON.stringify(value)};
      if ('value' in el) {
        if (typeof el.focus === 'function') {
          el.focus();
        }
        el.value = nextValue;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        if (typeof el.focus === 'function') {
          el.focus();
        }
        el.textContent = nextValue;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);
}

export async function typeIntoEditableSelectorValue(
  evaluate: SelectorEngineEvaluate,
  selector: string,
  text: string,
  clear: boolean
): Promise<boolean> {
  return evaluateWithSelectorEngine(evaluate, `
    (function() {
      const el = window.__selectorEngine?.querySelector(${JSON.stringify(selector)});
      if (!el) return false;

      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }
      if (typeof el.focus === 'function') {
        el.focus();
      }

      const nextValue = ${JSON.stringify(text)};
      const clearFirst = ${clear ? 'true' : 'false'};
      const fireInput = () => {
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            composed: true,
            data: nextValue,
            inputType: clearFirst ? 'insertReplacementText' : 'insertText',
            ruyi: true,
          }));
        } catch {
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
      };

      if (el.isContentEditable) {
        const prefix = clearFirst ? '' : String(el.textContent || '');
        el.textContent = prefix + nextValue;
        fireInput();
        return true;
      }

      if ('value' in el) {
        const prefix = clearFirst ? '' : String(el.value || '');
        el.value = prefix + nextValue;
        fireInput();
        return true;
      }

      return false;
    })()
  `);
}

export async function selectSelectorElementValue(
  evaluate: SelectorEngineEvaluate,
  selector: string,
  value: string
): Promise<boolean> {
  return evaluateWithSelectorEngine(evaluate, `
    (function() {
      const el = window.__selectorEngine?.querySelector(${JSON.stringify(selector)});
      if (!el || !(el instanceof HTMLSelectElement)) {
        return false;
      }
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }
      const option = Array.from(el.options).find((candidate) => candidate.value === ${JSON.stringify(
        value
      )});
      if (!option) {
        return false;
      }
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
      return true;
    })()
  `);
}

export async function getSelectorElementText(
  evaluate: SelectorEngineEvaluate,
  selector: string
): Promise<{ found: boolean; value: string }> {
  return evaluateWithSelectorEngine(evaluate, `
    (function() {
      const el = window.__selectorEngine?.querySelector(${JSON.stringify(selector)});
      if (!el) {
        return { found: false, value: '' };
      }
      const value =
        typeof el.innerText === 'string'
          ? el.innerText
          : typeof el.textContent === 'string'
            ? el.textContent
            : '';
      return { found: true, value: String(value || '') };
    })()
  `);
}

export async function getSelectorElementAttribute(
  evaluate: SelectorEngineEvaluate,
  selector: string,
  attribute: string
): Promise<{ found: boolean; value: string | null }> {
  return evaluateWithSelectorEngine(evaluate, `
    (function() {
      const el = window.__selectorEngine?.querySelector(${JSON.stringify(selector)});
      if (!el) {
        return { found: false, value: null };
      }
      return {
        found: true,
        value: el.getAttribute(${JSON.stringify(attribute)})
      };
    })()
  `);
}

export async function getSelectorElementCaptureRect(
  queryElement: (selector: string) => Promise<SelectorEngineElementQueryResult>,
  selector: string
): Promise<Bounds> {
  const element = await queryElement(selector);
  if (!element.found || !element.bounds) {
    throw new Error(`Element not found for selector: ${selector}`);
  }
  return element.bounds;
}
