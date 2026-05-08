export function renderDomTaskRuntime(): string {
  return String.raw`function isDomAccessError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    message.includes('Cannot access contents of url') ||
    message.includes('Cannot access a chrome:// URL') ||
    message.includes('The extensions gallery cannot be scripted')
  );
}

const AIRPA_DOM_TASK_HANDLER = async (payload) => {
      function isVisible(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return true;
      }

      function querySelectorExtended(selector) {
        if (!selector) {
          return null;
        }

        const textMatch = selector.match(/^(.+):has-text\("(.+)"\)$/);
        if (textMatch) {
          const baseSelector = textMatch[1];
          const text = textMatch[2];
          const elements = document.querySelectorAll(baseSelector);
          for (const element of elements) {
            if ((element.textContent || '').includes(text)) {
              return element;
            }
          }
          return null;
        }

        const visibleMatch = selector.match(/^(.+):visible$/);
        if (visibleMatch) {
          const baseSelector = visibleMatch[1];
          const elements = document.querySelectorAll(baseSelector);
          for (const element of elements) {
            if (isVisible(element)) {
              return element;
            }
          }
          return null;
        }

        return document.querySelector(selector);
      }

      function getElementState(selector, scrollIntoView) {
        const element = querySelectorExtended(selector);
        if (!element) {
          return {
            found: false,
            visible: false,
          };
        }

        if (scrollIntoView) {
          try {
            element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
          } catch {
            element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        }

        const rect = element.getBoundingClientRect();
        const visible = isVisible(element);
        return {
          found: true,
          visible,
          tagName: element.tagName.toLowerCase(),
          value: typeof element.value === 'string' ? element.value : '',
          checked: !!element.checked,
          viewportCenter: {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          },
          viewportBounds: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
          pageBounds: {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
          },
        };
      }

      function installWindowOpenPolicy(policy) {
        window.__AIRPA_WINDOW_OPEN_POLICY = policy || null;
        if (window.__AIRPA_WINDOW_OPEN_POLICY_INSTALLED) {
          return true;
        }

        window.__AIRPA_WINDOW_OPEN_POLICY_INSTALLED = true;

        function resolveAction(url) {
          const currentPolicy = window.__AIRPA_WINDOW_OPEN_POLICY;
          if (!currentPolicy) {
            return 'allow';
          }

          const rules = Array.isArray(currentPolicy.rules) ? currentPolicy.rules : [];
          for (const rule of rules) {
            if (!rule || !rule.match) continue;
            const pattern = String(rule.match);
            if (!pattern) continue;

            if (pattern.includes('*')) {
              const escaped = pattern
                .replace(/[.+?^$\{\}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
              if (new RegExp('^' + escaped + '$').test(url)) {
                return rule.action || currentPolicy.default || 'allow';
              }
            } else if (url.includes(pattern)) {
              return rule.action || currentPolicy.default || 'allow';
            }
          }

          return currentPolicy.default || 'allow';
        }

        const nativeOpen = window.open.bind(window);
        window.open = function(url, target, features) {
          const targetUrl = String(url || '');
          const action = resolveAction(targetUrl);
          if (action === 'deny') {
            return null;
          }
          if (action === 'same-window' && targetUrl) {
            location.assign(targetUrl);
            return null;
          }
          return nativeOpen(url, target, features);
        };

        document.addEventListener(
          'click',
          (event) => {
            const anchor = event.target && event.target.closest ? event.target.closest('a[target="_blank"]') : null;
            if (!anchor) {
              return;
            }
            const href = anchor.href || '';
            const action = resolveAction(href);
            if (action === 'deny') {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (action === 'same-window' && href) {
              event.preventDefault();
              event.stopPropagation();
              location.assign(href);
            }
          },
          true
        );

        return true;
      }

      switch (payload.task) {
        case 'queryState':
          return getElementState(payload.input.selector, !!payload.input.scrollIntoView);
        case 'clearValue': {
          const element = querySelectorExtended(payload.input.selector);
          if (!element) {
            throw new Error('Element not found: ' + payload.input.selector);
          }
          if ('value' in element) {
            element.value = '';
          }
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        case 'focusElement': {
          const element = querySelectorExtended(payload.input.selector);
          if (!element) {
            throw new Error('Element not found: ' + payload.input.selector);
          }
          try {
            element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
          } catch {
            element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
          element.focus({ preventScroll: true });
          return getElementState(payload.input.selector, false);
        }
        case 'clickElement': {
          const element = querySelectorExtended(payload.input.selector);
          if (!element) {
            throw new Error('Element not found: ' + payload.input.selector);
          }
          try {
            element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
          } catch {
            element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
          if (typeof element.focus === 'function') {
            element.focus({ preventScroll: true });
          }
          if ('disabled' in element && element.disabled) {
            throw new Error('Element is disabled: ' + payload.input.selector);
          }
          if (typeof element.click === 'function') {
            window.setTimeout(() => {
              try {
                element.click();
              } catch {
                // ignore async click failures; command already returned
              }
            }, 0);
            return true;
          }
          return false;
        }
        case 'selectValue': {
          const element = querySelectorExtended(payload.input.selector);
          if (!element) {
            throw new Error('Element not found: ' + payload.input.selector);
          }
          if (element.tagName.toLowerCase() !== 'select') {
            throw new Error('Target is not a <select>: ' + payload.input.selector);
          }
          element.value = String(payload.input.value);
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        case 'getText': {
          const element = querySelectorExtended(payload.input.selector);
          if (!element) {
            throw new Error('Element not found: ' + payload.input.selector);
          }
          return (element.textContent || '').trim();
        }
        case 'getAttribute': {
          const element = querySelectorExtended(payload.input.selector);
          if (!element) {
            throw new Error('Element not found: ' + payload.input.selector);
          }
          return element.getAttribute(String(payload.input.attribute || ''));
        }
        case 'readyState':
          return document.readyState;
        case 'historyBack':
          history.back();
          return true;
        case 'historyForward':
          history.forward();
          return true;
        case 'stopNavigation':
          window.stop();
          return true;
        case 'evaluate':
          return await (0, eval)(String(payload.input.script || ''));
        case 'evaluateWithArgs': {
          const fn = (0, eval)('(' + String(payload.input.functionSource || '') + ')');
          return await fn(...(Array.isArray(payload.input.args) ? payload.input.args : []));
        }
        case 'applyWindowOpenPolicy':
          return installWindowOpenPolicy(payload.input.policy || null);
        default:
          throw new Error('Unsupported DOM task: ' + payload.task);
      }
    };

async function runDomTaskViaDebugger(tabId, task, input) {
  return withDebugger(tabId, async () => {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    } catch {
      // best-effort only
    }

    const evaluation = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression:
        '(' + AIRPA_DOM_TASK_HANDLER.toString() + ')(' + JSON.stringify({ task, input }) + ')',
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });

    if (evaluation && evaluation.exceptionDetails) {
      const details = evaluation.exceptionDetails;
      const message =
        details.exception && details.exception.description
          ? details.exception.description
          : details.text || 'Debugger DOM task evaluation failed';
      throw new Error(String(message));
    }

    return evaluation && evaluation.result ? evaluation.result.value : undefined;
  });
}

async function runDomTask(tabId, task, input) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: AIRPA_DOM_TASK_HANDLER,
      args: [{ task, input }],
    });

    if (!results || !results.length) {
      return runDomTaskViaDebugger(tabId, task, input);
    }

    const firstResult = results[0].result;
    if (
      typeof firstResult === 'undefined' &&
      task !== 'evaluate' &&
      task !== 'evaluateWithArgs'
    ) {
      return runDomTaskViaDebugger(tabId, task, input);
    }

    return firstResult;
  } catch (error) {
    if (!isDomAccessError(error)) {
      throw error;
    }
    return runDomTaskViaDebugger(tabId, task, input);
  }
}

async function waitForReadyState(tabId, waitUntil, timeoutMs) {
  const desiredState =
    waitUntil === 'domcontentloaded'
      ? 'interactive'
      : waitUntil === 'networkidle0' || waitUntil === 'networkidle2'
        ? 'complete'
        : 'complete';
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    let readyState;
    try {
      readyState = await runDomTask(tabId, 'readyState', {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('The tab was closed')) {
        await sleep(120);
        continue;
      }
      throw error;
    }

    if (desiredState === 'interactive') {
      if (readyState === 'interactive' || readyState === 'complete') {
        return;
      }
    } else if (readyState === 'complete') {
      if (waitUntil === 'networkidle0' || waitUntil === 'networkidle2') {
        const remainingTimeout = Math.max(1000, timeoutMs - (Date.now() - startedAt));
        await waitForNetworkIdle(
          tabId,
          waitUntil === 'networkidle0' ? 0 : 2,
          500,
          remainingTimeout
        );
      }
      return;
    }

    await sleep(120);
  }

  throw new Error('Timed out waiting for document ready state: ' + waitUntil);
}

function requiresNetworkIdleTracking(waitUntil) {
  return waitUntil === 'networkidle0' || waitUntil === 'networkidle2';
}

function shouldNavigateInPage(url) {
  return String(url || '').trim().toLowerCase().startsWith('data:');
}

async function queryElementState(tabId, selector, scrollIntoView) {
  return runDomTask(tabId, 'queryState', {
    selector,
    scrollIntoView: !!scrollIntoView,
  });
}

async function clearFocusedEditable(tabId, selector) {
  await sendKeyEvent(tabId, 'a', getSelectAllKeyModifiers());
  await sendKeyEvent(tabId, 'Backspace', []);

  const state = await queryElementState(tabId, selector, false).catch(() => null);
  if (state && typeof state.value === 'string' && state.value.length === 0) {
    return;
  }

  await runDomTask(tabId, 'clearValue', { selector });
}

async function waitForSelectorState(tabId, selector, state, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const elementState = await queryElementState(tabId, selector, false);
    const found = !!(elementState && elementState.found);
    const visible = !!(elementState && elementState.visible);

    if (state === 'hidden') {
      if (!found || !visible) {
        return;
      }
    } else if (state === 'visible') {
      if (found && visible) {
        return;
      }
    } else if (found) {
      return;
    }

    await sleep(120);
  }

  throw new Error('Timed out waiting for selector: ' + selector);
}`;
}
