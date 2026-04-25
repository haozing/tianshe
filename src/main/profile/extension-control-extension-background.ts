import { REMOTE_BROWSER_COMMAND } from './remote-browser-command-protocol';

type ExtensionBackgroundRuntimeConfig = {
  browserId: string;
  token: string;
  relayBaseUrl: string;
  proxy?: {
    type?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    bypassList?: string;
  } | null;
};

function getDefaultRuntimeConfig(): ExtensionBackgroundRuntimeConfig {
  return {
    browserId: 'extension-test-browser',
    token: 'extension-test-token',
    relayBaseUrl: 'http://127.0.0.1:0',
    proxy: null,
  };
}

export function renderBackgroundScript(
  runtimeConfig: ExtensionBackgroundRuntimeConfig = getDefaultRuntimeConfig()
): string {
  return [
    renderPrelude(runtimeConfig),
    renderDomTaskRuntime(),
    renderCommandRuntime(),
    renderFooter(),
  ].join('\n\n');
}

function renderPrelude(runtimeConfig: ExtensionBackgroundRuntimeConfig): string {
  return String.raw`const AIRPA_RUNTIME_CONFIG = ${JSON.stringify(runtimeConfig)};
const DEBUGGER_VERSION = '1.3';
const DOCUMENT_RESOURCE_TYPES = new Set(['mainframe', 'subframe', 'document', 'iframe', 'frame']);
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'websocket', 'eventsource']);
const STATIC_RESOURCE_TYPES = new Set(['script', 'stylesheet', 'font', 'manifest', 'other-static']);
const MEDIA_RESOURCE_TYPES = new Set(['image', 'media']);
const API_URL_PATTERN = /(?:^|[/?#])(api|graphql|rpc)(?:[/?#]|$)/i;
const STATIC_URL_PATTERN = /\.(?:css|js|mjs|woff2?|ttf|otf)(?:[?#].*)?$/i;
const MEDIA_URL_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|mp4|webm|mp3|wav|mov)(?:[?#].*)?$/i;
const RELAY_EVENT_FLUSH_INTERVAL_MS = 50;
const RELAY_EVENT_MAX_BATCH_SIZE = 50;
const RELAY_EVENT_QUEUE_LIMIT = 1000;
const MAX_RECENT_DIAGNOSTICS = 20;

let authHandlerInstalled = false;
let offscreenCreatingPromise = null;
let globalWindowOpenPolicy = null;
let relayEventFlushTimer = null;
let relayEventFlushInFlight = null;
let relayDroppedEventCount = 0;
let offscreenRegisterFailureCount = 0;

const relayEventQueue = [];
const backgroundDiagnostics = {
  recentRelayErrors: [],
  recentCommandErrors: [],
};
const tabStates = new Map();

function createEmptyEmulationOverrideState() {
  return {
    userAgent: null,
    locale: null,
    timezoneId: null,
    touch: null,
    geolocation: null,
  };
}

function createEmulationState() {
  return {
    active: false,
    baseline: null,
    current: createEmptyEmulationOverrideState(),
  };
}

function getSelectAllKeyModifiers() {
  const fingerprint = String(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
  ).toLowerCase();
  return fingerprint.includes('mac') ? ['meta'] : ['control'];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rememberDiagnostic(target, message) {
  const text = String(message || '').trim();
  if (!text) {
    return;
  }
  target.push({
    at: Date.now(),
    message: text,
  });
  if (target.length > MAX_RECENT_DIAGNOSTICS) {
    target.splice(0, target.length - MAX_RECENT_DIAGNOSTICS);
  }
}

function rememberRelayError(message) {
  rememberDiagnostic(backgroundDiagnostics.recentRelayErrors, message);
}

function rememberCommandError(message) {
  rememberDiagnostic(backgroundDiagnostics.recentCommandErrors, message);
}

function createBackgroundDiagnosticsSnapshot() {
  return {
    queueLength: relayEventQueue.length,
    droppedEventCount: relayDroppedEventCount,
    offscreenRegisterFailureCount,
    recentRelayErrors: backgroundDiagnostics.recentRelayErrors.slice(),
    recentCommandErrors: backgroundDiagnostics.recentCommandErrors.slice(),
  };
}

function normalizeHeaderRecord(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = String(name || '').trim().toLowerCase();
    if (!normalizedName) {
      continue;
    }
    result[normalizedName] = String(value ?? '');
  }
  return result;
}

function toBase64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function matchesUrlPattern(url, pattern) {
  const normalized = String(pattern || '').trim();
  if (!normalized) {
    return true;
  }
  if (normalized.includes('*')) {
    const escaped = normalized.replace(/[.+?^$()|[\]{}\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$', 'i').test(String(url || ''));
  }
  try {
    if (/[()[\]{}+?^$|\\]/.test(normalized)) {
      return new RegExp(normalized, 'i').test(String(url || ''));
    }
  } catch {
    // ignore invalid regexp-like patterns
  }
  return String(url || '').includes(normalized);
}

function matchesInterceptPatterns(request, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return true;
  }

  return patterns.some((pattern) => {
    if (!pattern || typeof pattern !== 'object') {
      return false;
    }
    if (pattern.urlPattern && !matchesUrlPattern(request.url, pattern.urlPattern)) {
      return false;
    }
    if (
      Array.isArray(pattern.methods) &&
      pattern.methods.length > 0 &&
      !pattern.methods.some((method) => String(method || '').toUpperCase() === request.method.toUpperCase())
    ) {
      return false;
    }
    if (
      Array.isArray(pattern.resourceTypes) &&
      pattern.resourceTypes.length > 0 &&
      !pattern.resourceTypes.some(
        (resourceType) =>
          String(resourceType || '').toLowerCase() === String(request.resourceType || '').toLowerCase()
      )
    ) {
      return false;
    }
    return true;
  });
}

function serializeFetchHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const entries = Object.entries(headers).filter(([name]) => String(name || '').trim().length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map(([name, value]) => ({
    name,
    value: String(value ?? ''),
  }));
}

function normalizeFetchErrorReason(reason) {
  const value = String(reason || '').trim();
  if (!value) {
    return 'Failed';
  }
  const knownReasons = new Set([
    'Failed',
    'Aborted',
    'TimedOut',
    'AccessDenied',
    'ConnectionClosed',
    'ConnectionReset',
    'ConnectionRefused',
    'ConnectionAborted',
    'ConnectionFailed',
    'NameNotResolved',
    'InternetDisconnected',
    'AddressUnreachable',
    'BlockedByClient',
    'BlockedByResponse',
  ]);
  return knownReasons.has(value) ? value : 'Failed';
}

function noteOffscreenRegisterFailure(error) {
  offscreenRegisterFailureCount += 1;
  rememberRelayError('offscreen register failed: ' + String(error || 'register_failed'));
}

async function getRuntimeConfig() {
  return AIRPA_RUNTIME_CONFIG;
}

function getRelayRuntimeConfig() {
  return {
    browserId: AIRPA_RUNTIME_CONFIG.browserId,
    token: AIRPA_RUNTIME_CONFIG.token,
    relayBaseUrl: AIRPA_RUNTIME_CONFIG.relayBaseUrl,
  };
}

async function sendRelayPayload(path, payload) {
  const config = await getRuntimeConfig();
  const response = await fetch(config.relayBaseUrl + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      browserId: config.browserId,
      token: config.token,
      ...payload,
    }),
  });
  if (!response.ok) {
    throw new Error('Relay request failed: ' + path + ' (' + response.status + ')');
  }
}

function scheduleRelayEventFlush() {
  if (relayEventFlushTimer || relayEventFlushInFlight || relayEventQueue.length === 0) {
    return;
  }
  relayEventFlushTimer = setTimeout(() => {
    relayEventFlushTimer = null;
    flushQueuedRelayEvents().catch((error) => {
      rememberRelayError('flushQueuedRelayEvents failed: ' + (error instanceof Error ? error.message : String(error)));
    });
  }, RELAY_EVENT_FLUSH_INTERVAL_MS);
}

function queueRelayEvent(payload) {
  if (relayEventQueue.length >= RELAY_EVENT_QUEUE_LIMIT) {
    relayDroppedEventCount += 1;
    return;
  }
  relayEventQueue.push(payload);
  if (relayEventQueue.length >= RELAY_EVENT_MAX_BATCH_SIZE) {
    if (relayEventFlushTimer) {
      clearTimeout(relayEventFlushTimer);
      relayEventFlushTimer = null;
    }
    void flushQueuedRelayEvents().catch((error) => {
      rememberRelayError('flushQueuedRelayEvents failed: ' + (error instanceof Error ? error.message : String(error)));
    });
    return;
  }
  scheduleRelayEventFlush();
}

async function flushQueuedRelayEvents() {
  if (relayEventFlushInFlight || relayEventQueue.length === 0) {
    return;
  }

  const batch = relayEventQueue.splice(0, RELAY_EVENT_MAX_BATCH_SIZE);
  relayEventFlushInFlight = (async () => {
    try {
      await sendRelayPayload('/event', {
        events: batch,
        diagnostics: createBackgroundDiagnosticsSnapshot(),
      });
    } catch (error) {
      rememberRelayError('event batch delivery failed: ' + (error instanceof Error ? error.message : String(error)));
      while (batch.length > 0) {
        if (relayEventQueue.length >= RELAY_EVENT_QUEUE_LIMIT) {
          relayDroppedEventCount += batch.length;
          break;
        }
        const eventPayload = batch.pop();
        if (eventPayload !== undefined) {
          relayEventQueue.unshift(eventPayload);
        }
      }
      throw error;
    } finally {
      relayEventFlushInFlight = null;
      if (relayEventQueue.length > 0) {
        scheduleRelayEventFlush();
      }
    }
  })();

  return relayEventFlushInFlight;
}

async function postRelayEvent(payload) {
  try {
    await sendRelayPayload('/event', {
      ...payload,
      diagnostics: createBackgroundDiagnosticsSnapshot(),
    });
  } catch (error) {
    rememberRelayError('relay event delivery failed: ' + (error instanceof Error ? error.message : String(error)));
    throw error;
  }
}

function getTabState(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      debuggerAttached: false,
      network: {
        enabled: false,
        captureBody: false,
        urlFilter: '',
        urlFilterRegex: null,
        maxEntries: 1000,
        entries: new Map(),
        trackingUsers: 0,
        cdpEnabled: false,
        inflight: new Set(),
        lastActivityAt: 0,
      },
      console: {
        enabled: false,
        level: 'all',
      },
      intercept: {
        enabled: false,
        patterns: [],
        pendingRequests: new Map(),
      },
      dialog: {
        current: null,
      },
      emulation: createEmulationState(),
    });
  }
  return tabStates.get(tabId);
}

function updateNetworkActivity(state) {
  state.network.lastActivityAt = Date.now();
}

function wantsNetworkTracking(state) {
  return state.network.trackingUsers > 0;
}

function wantsInterceptTracking(state) {
  return !!(state.intercept && state.intercept.enabled);
}

function wantsEmulationTracking(state) {
  return !!(state.emulation && state.emulation.active);
}

function shouldCaptureNetworkUrl(state, url) {
  return !state.network.urlFilterRegex || state.network.urlFilterRegex.test(String(url || ''));
}

function markNetworkRequestStarted(state, requestId) {
  const key = String(requestId || '');
  if (!key) {
    return;
  }
  state.network.inflight.add(key);
  updateNetworkActivity(state);
}

function markNetworkRequestFinished(state, requestId) {
  const key = String(requestId || '');
  if (!key) {
    return;
  }
  state.network.inflight.delete(key);
  updateNetworkActivity(state);
}

function classifyNetworkEntry(entry) {
  const resourceType = String((entry && entry.resourceType) || '').trim().toLowerCase();
  const url = String((entry && entry.url) || '');

  if (DOCUMENT_RESOURCE_TYPES.has(resourceType)) return 'document';
  if (API_RESOURCE_TYPES.has(resourceType) || API_URL_PATTERN.test(url)) return 'api';
  if (MEDIA_RESOURCE_TYPES.has(resourceType) || MEDIA_URL_PATTERN.test(url)) return 'media';
  if (STATIC_RESOURCE_TYPES.has(resourceType) || STATIC_URL_PATTERN.test(url)) return 'static';
  return 'other';
}

async function ensureProxyAuthHandler() {
  if (authHandlerInstalled) {
    return;
  }

  const config = await getRuntimeConfig();
  const proxy = config && config.proxy ? config.proxy : null;
  if (!proxy || !proxy.username || !proxy.password || !proxy.host) {
    authHandlerInstalled = true;
    return;
  }

  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      try {
        const challenger = details && details.challenger ? details.challenger : {};
        const host = String(challenger.host || '').trim().toLowerCase();
        const expectedHost = String(proxy.host || '').trim().toLowerCase();
        const port = Number(challenger.port || 0);
        const expectedPort = Number(proxy.port || 0);

        if (host !== expectedHost) {
          callback({});
          return;
        }
        if (expectedPort > 0 && port > 0 && port !== expectedPort) {
          callback({});
          return;
        }

        callback({
          authCredentials: {
            username: String(proxy.username || ''),
            password: String(proxy.password || ''),
          },
        });
      } catch {
        callback({});
      }
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking']
  );

  authHandlerInstalled = true;
}

async function ensureOffscreenDocument() {
  if (offscreenCreatingPromise) {
    return offscreenCreatingPromise;
  }

  offscreenCreatingPromise = (async () => {
    const contexts = chrome.runtime.getContexts
      ? await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [chrome.runtime.getURL('offscreen.html')],
        })
      : [];

    if (contexts && contexts.length > 0) {
      return;
    }

    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Maintain authenticated relay polling for browser control commands.',
    });
  })()
    .catch((error) => {
      offscreenCreatingPromise = null;
      throw error;
    })
    .finally(() => {
      offscreenCreatingPromise = null;
    });

  return offscreenCreatingPromise;
}

async function getActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs && tabs[0]) {
    return tabs[0];
  }

  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    if (!win || !Array.isArray(win.tabs)) {
      continue;
    }
    const activeTab = win.tabs.find((tab) => tab && tab.active);
    if (activeTab) {
      return activeTab;
    }
  }

  return chrome.tabs.create({ url: 'about:blank', active: true });
}

async function resolveCommandTab(target) {
  if (!target || typeof target.tabId !== 'number') {
    throw new Error('Bound target tabId is required for extension commands');
  }

  try {
    return await chrome.tabs.get(target.tabId);
  } catch {
    throw new Error('Bound tab not available: ' + target.tabId);
  }
}

async function emitClientStateFromTab(tab) {
  if (!tab) {
    return;
  }

  await postRelayEvent({
    type: 'client-state',
    tabId: typeof tab.id === 'number' ? tab.id : null,
    windowId: typeof tab.windowId === 'number' ? tab.windowId : null,
    url: tab.url || null,
    title: tab.title || null,
  });
}

async function emitCurrentClientState() {
  const tab = await getActiveTab();
  await emitClientStateFromTab(tab);
  return {
    tabId: typeof tab.id === 'number' ? tab.id : null,
    windowId: typeof tab.windowId === 'number' ? tab.windowId : null,
    url: tab.url || null,
    title: tab.title || null,
  };
}

function toTabInfo(tab, activeTabId) {
  return {
    id: String(tab && typeof tab.id === 'number' ? tab.id : ''),
    url: String((tab && tab.url) || ''),
    title: typeof (tab && tab.title) === 'string' ? tab.title : undefined,
    active:
      typeof activeTabId === 'number'
        ? tab && tab.id === activeTabId
        : !!(tab && tab.active),
    parentId:
      typeof (tab && tab.openerTabId) === 'number' ? String(tab.openerTabId) : undefined,
  };
}

async function ensurePageDebugger(tabId) {
  await attachDebugger(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
}

async function waitForDialog(tabId, timeoutMs) {
  await ensurePageDebugger(tabId);
  const state = getTabState(tabId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.dialog.current) {
      return { ...state.dialog.current };
    }
    await sleep(100);
  }
  await detachDebuggerIfIdle(tabId);
  throw new Error('Timed out waiting for dialog after ' + timeoutMs + 'ms');
}

async function probePageExecutionResumed(tabId, timeoutMs) {
  return await Promise.race([
    runDomTask(tabId, 'readyState', {})
      .then((readyState) => typeof readyState === 'string' && readyState.length > 0)
      .catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function observeDialogClosed(tabId, timeoutMs) {
  const state = getTabState(tabId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!state.dialog.current) {
      return true;
    }
    const resumed = await probePageExecutionResumed(tabId, 200);
    if (resumed) {
      state.dialog.current = null;
      await postRelayEvent({
        type: 'dialog-closed',
        contextId: String(tabId),
      });
      return true;
    }
    await sleep(80);
  }
  return !state.dialog.current;
}

async function armDialog(tabId) {
  await ensurePageDebugger(tabId);
  const currentDialog = getTabState(tabId).dialog.current;
  return currentDialog ? { ...currentDialog } : null;
}

async function disarmDialog(tabId) {
  await detachDebuggerIfIdle(tabId);
}

async function handleDialog(tabId, options) {
  const accept = options && typeof options.accept === 'boolean' ? options.accept : true;
  const promptText =
    typeof (options && options.promptText) === 'string' ? options.promptText : undefined;
  const nonBlocking = !!(options && options.nonBlocking);
  const performHandleDialog = async () => {
    const currentTab = await chrome.tabs.get(tabId);
    await withWindowReadyForScreenshot(currentTab.windowId, async () => {
      await ensurePageDebugger(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
        accept,
        promptText,
      });
      if (await observeDialogClosed(tabId, 1200)) {
        return;
      }

      if (accept && typeof promptText === 'string' && promptText.length > 0) {
        try {
          await sendKeyEvent(tabId, 'a', getSelectAllKeyModifiers());
          await sendKeyEvent(tabId, 'Backspace', []);
          await insertText(tabId, promptText, 0);
        } catch {
          // continue to final accept key fallback
        }
      }

      try {
        await sendKeyEvent(tabId, accept ? 'Enter' : 'Escape', []);
      } catch {
        // ignore fallback key failures; final closure check below will surface the issue
      }

      if (await observeDialogClosed(tabId, 1500)) {
        return;
      }

      throw new Error('JavaScript dialog did not close after handle request');
    });
  };

  if (nonBlocking) {
    queueMicrotask(() => {
      performHandleDialog().catch((error) => {
        rememberCommandError(
          'Page.handleJavaScriptDialog failed after non-blocking dispatch: ' +
            (error instanceof Error ? error.message : String(error))
        );
      });
    });
    return;
  }

  await performHandleDialog();
}

async function attachDebugger(tabId) {
  const state = getTabState(tabId);
  if (state.debuggerAttached) {
    return;
  }

  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  state.debuggerAttached = true;
}

async function detachDebuggerIfIdle(tabId) {
  const state = getTabState(tabId);
  if (!state.debuggerAttached) {
    return;
  }
  if (
    wantsNetworkTracking(state) ||
    state.console.enabled ||
    wantsInterceptTracking(state) ||
    wantsEmulationTracking(state)
  ) {
    return;
  }

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignore
  }
  state.debuggerAttached = false;
}

async function withDebugger(tabId, work) {
  const state = getTabState(tabId);
  const wasAttached = state.debuggerAttached;
  if (!wasAttached) {
    await attachDebugger(tabId);
  }

  try {
    return await work();
  } finally {
    if (!wasAttached) {
      await detachDebuggerIfIdle(tabId);
    }
  }
}`;
}

function renderDomTaskRuntime(): string {
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

function renderCommandRuntime(): string {
  return String.raw`function buildTouchEmulationPayload(enabled) {
  return enabled ? { enabled: true, maxTouchPoints: 1 } : { enabled: false };
}

function hasEmulationOption(options, name) {
  return Object.prototype.hasOwnProperty.call(options || {}, name);
}

function normalizeOptionalString(value, trim) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = trim ? value.trim() : value;
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalGeolocation(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  const accuracy = Number(value.accuracy);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('geolocation requires finite latitude and longitude');
  }
  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 100,
  };
}

function normalizeViewportSize(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(label + ' must be a finite number');
  }
  return Math.max(1, Math.round(numeric));
}

function normalizeDevicePixelRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 1;
  }
  return numeric;
}

function createEmulationBaselineSnapshot(raw) {
  return {
    userAgent: typeof raw.userAgent === 'string' ? raw.userAgent : '',
    platform: typeof raw.platform === 'string' ? raw.platform : '',
    acceptLanguage:
      typeof raw.acceptLanguage === 'string' && raw.acceptLanguage.trim().length > 0
        ? raw.acceptLanguage
        : typeof raw.locale === 'string'
          ? raw.locale
          : '',
    locale: typeof raw.locale === 'string' ? raw.locale : '',
    timezoneId: typeof raw.timezoneId === 'string' ? raw.timezoneId : '',
    touch: !!raw.touch,
  };
}

async function captureEmulationBaseline(tabId) {
  const raw = await runDomTask(tabId, 'evaluate', {
    script:
      '(() => {' +
      '  const resolved = typeof Intl !== "undefined" && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions() : {};' +
      '  const languages = Array.isArray(navigator.languages)' +
      '    ? navigator.languages.map((value) => String(value || "").trim()).filter(Boolean)' +
      '    : [];' +
      '  const locale = String((resolved && resolved.locale) || navigator.language || "");' +
      '  return {' +
      '    userAgent: String(navigator.userAgent || ""),' +
      '    platform: String(navigator.platform || ""),' +
      '    acceptLanguage: languages.length > 0 ? languages.join(",") : locale,' +
      '    locale,' +
      '    timezoneId: String((resolved && resolved.timeZone) || ""),' +
      '    touch: Number(navigator.maxTouchPoints || 0) > 0,' +
      '  };' +
      '})()',
  });
  return createEmulationBaselineSnapshot(raw || {});
}

async function ensureEmulationBaseline(tabId) {
  const state = getTabState(tabId);
  if (state.emulation && state.emulation.baseline) {
    return state.emulation.baseline;
  }
  const baseline = await captureEmulationBaseline(tabId);
  state.emulation.baseline = baseline;
  return baseline;
}

async function applyIdentityEmulation(tabId, options) {
  const state = getTabState(tabId);
  const baseline = await ensureEmulationBaseline(tabId);
  const current = state.emulation.current;

  const hasUserAgent = hasEmulationOption(options, 'userAgent');
  const hasLocale = hasEmulationOption(options, 'locale');
  const hasTimezoneId = hasEmulationOption(options, 'timezoneId');
  const hasTouch = hasEmulationOption(options, 'touch');
  const hasGeolocation = hasEmulationOption(options, 'geolocation');

  if (hasUserAgent) {
    current.userAgent = normalizeOptionalString(options.userAgent, false);
  }
  if (hasLocale) {
    current.locale = normalizeOptionalString(options.locale, true);
  }
  if (hasTimezoneId) {
    current.timezoneId = normalizeOptionalString(options.timezoneId, true);
  }
  if (hasTouch) {
    current.touch = !!options.touch;
  }
  if (hasGeolocation) {
    current.geolocation = normalizeOptionalGeolocation(options.geolocation);
  }

  await withDebugger(tabId, async () => {
    if (hasUserAgent || hasLocale) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setUserAgentOverride', {
        userAgent: current.userAgent || baseline.userAgent,
        acceptLanguage: current.locale || baseline.acceptLanguage || baseline.locale || undefined,
        platform: baseline.platform || undefined,
      });
    }

    if (hasLocale) {
      const locale = current.locale || baseline.locale;
      if (locale) {
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.setLocaleOverride', {
          locale,
        });
      }
    }

    if (hasTimezoneId) {
      const timezoneId = current.timezoneId || baseline.timezoneId;
      if (timezoneId) {
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTimezoneOverride', {
          timezoneId,
        });
      }
    }

    if (hasTouch) {
      const touchEnabled = current.touch === null ? baseline.touch : current.touch === true;
      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setTouchEmulationEnabled',
        buildTouchEmulationPayload(touchEnabled)
      );
    }

    if (hasGeolocation) {
      if (current.geolocation) {
        await chrome.debugger.sendCommand(
          { tabId },
          'Emulation.setGeolocationOverride',
          current.geolocation
        );
      } else {
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearGeolocationOverride');
      }
    }

    state.emulation.active = true;
  });
}

async function applyViewportEmulation(tabId, options) {
  if (!options || typeof options !== 'object') {
    throw new Error('viewport options are required');
  }

  const state = getTabState(tabId);
  const width = normalizeViewportSize(options.width, 'viewport width');
  const height = normalizeViewportSize(options.height, 'viewport height');
  const deviceScaleFactor = normalizeDevicePixelRatio(options.devicePixelRatio);

  await ensureEmulationBaseline(tabId);
  await withDebugger(tabId, async () => {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: options.isMobile === true,
    });

    if (hasEmulationOption(options, 'hasTouch')) {
      state.emulation.current.touch = !!options.hasTouch;
      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setTouchEmulationEnabled',
        buildTouchEmulationPayload(state.emulation.current.touch)
      );
    }

    state.emulation.active = true;
  });
}

async function clearEmulationOverrides(tabId) {
  const state = getTabState(tabId);
  const baseline = await ensureEmulationBaseline(tabId);

  await withDebugger(tabId, async () => {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearGeolocationOverride');
    await chrome.debugger.sendCommand(
      { tabId },
      'Emulation.setTouchEmulationEnabled',
      buildTouchEmulationPayload(baseline.touch)
    );
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setUserAgentOverride', {
      userAgent: baseline.userAgent,
      acceptLanguage: baseline.acceptLanguage || baseline.locale || undefined,
      platform: baseline.platform || undefined,
    });
    if (baseline.locale) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setLocaleOverride', {
        locale: baseline.locale,
      });
    }
    if (baseline.timezoneId) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTimezoneOverride', {
        timezoneId: baseline.timezoneId,
      });
    }
    state.emulation.active = false;
    state.emulation.current = createEmptyEmulationOverrideState();
  });

  await detachDebuggerIfIdle(tabId);
}

async function nativeClick(tabId, x, y, button, clickCount, delay) {
  await withDebugger(tabId, async () => {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button,
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
    });
    if (delay && delay > 0) {
      await sleep(delay);
    }
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
    });
  });
}

async function sendKeyEvent(tabId, key, modifiers) {
  const modifierMask = Array.isArray(modifiers)
    ? modifiers.reduce((mask, item) => {
        switch (item) {
          case 'alt':
            return mask | 1;
          case 'control':
            return mask | 2;
          case 'meta':
            return mask | 4;
          case 'shift':
            return mask | 8;
          default:
            return mask;
        }
      }, 0)
    : 0;

  const normalizedKey = String(key || '');
  const printable = normalizedKey.length === 1 ? normalizedKey : undefined;
  const code =
    normalizedKey.length === 1
      ? 'Key' + normalizedKey.toUpperCase()
      : ({
          Enter: 'Enter',
          Tab: 'Tab',
          Escape: 'Escape',
          Backspace: 'Backspace',
          Delete: 'Delete',
          ArrowLeft: 'ArrowLeft',
          ArrowRight: 'ArrowRight',
          ArrowUp: 'ArrowUp',
          ArrowDown: 'ArrowDown',
          Space: 'Space',
        }[normalizedKey] || normalizedKey);

  const virtualKeyCode =
    printable && printable.length === 1
      ? printable.toUpperCase().charCodeAt(0)
      : ({
          Enter: 13,
          Tab: 9,
          Escape: 27,
          Backspace: 8,
          Delete: 46,
          ArrowLeft: 37,
          ArrowUp: 38,
          ArrowRight: 39,
          ArrowDown: 40,
          Space: 32,
        }[normalizedKey] || 0);

  await withDebugger(tabId, async () => {
    for (const modifier of Array.isArray(modifiers) ? modifiers : []) {
      const name =
        modifier === 'control'
          ? 'Control'
          : modifier === 'shift'
            ? 'Shift'
            : modifier === 'alt'
              ? 'Alt'
              : modifier === 'meta'
                ? 'Meta'
                : null;
      if (!name) continue;
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: name,
        code: name,
        windowsVirtualKeyCode:
          name === 'Control' ? 17 : name === 'Shift' ? 16 : name === 'Alt' ? 18 : 91,
        nativeVirtualKeyCode:
          name === 'Control' ? 17 : name === 'Shift' ? 16 : name === 'Alt' ? 18 : 91,
        modifiers: modifierMask,
      });
    }

    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: printable ? 'keyDown' : 'rawKeyDown',
      key: normalizedKey,
      code,
      text: printable,
      unmodifiedText: printable,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      modifiers: modifierMask,
    });

    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: normalizedKey,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      modifiers: modifierMask,
    });

    for (const modifier of (Array.isArray(modifiers) ? modifiers : []).slice().reverse()) {
      const name =
        modifier === 'control'
          ? 'Control'
          : modifier === 'shift'
            ? 'Shift'
            : modifier === 'alt'
              ? 'Alt'
              : modifier === 'meta'
                ? 'Meta'
                : null;
      if (!name) continue;
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: name,
        code: name,
        windowsVirtualKeyCode:
          name === 'Control' ? 17 : name === 'Shift' ? 16 : name === 'Alt' ? 18 : 91,
        nativeVirtualKeyCode:
          name === 'Control' ? 17 : name === 'Shift' ? 16 : name === 'Alt' ? 18 : 91,
        modifiers: modifierMask,
      });
    }
  });
}

async function ensureNetworkDomainEnabled(tabId) {
  const state = getTabState(tabId);
  await attachDebugger(tabId);
  if (state.network.cdpEnabled) {
    return;
  }
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  state.network.cdpEnabled = true;
  updateNetworkActivity(state);
}

async function acquireNetworkTracking(tabId) {
  const state = getTabState(tabId);
  state.network.trackingUsers += 1;
  try {
    await ensureNetworkDomainEnabled(tabId);
  } catch (error) {
    state.network.trackingUsers = Math.max(0, state.network.trackingUsers - 1);
    throw error;
  }
}

async function releaseNetworkTracking(tabId) {
  const state = getTabState(tabId);
  state.network.trackingUsers = Math.max(0, state.network.trackingUsers - 1);
  if (state.network.trackingUsers > 0) {
    return;
  }

  state.network.inflight.clear();
  updateNetworkActivity(state);

  if (state.network.cdpEnabled) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Network.disable');
    } catch {
      // ignore
    }
    state.network.cdpEnabled = false;
  }

  await detachDebuggerIfIdle(tabId);
}

async function waitForNetworkIdle(tabId, maxInflight, idleMs, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const state = getTabState(tabId);
    const inflightCount = state.network.inflight.size;
    const idleFor = Date.now() - Math.max(state.network.lastActivityAt || startedAt, startedAt);

    if (inflightCount <= maxInflight && idleFor >= idleMs) {
      return;
    }

    await sleep(100);
  }

  throw new Error('Timed out waiting for network idle: ' + maxInflight);
}

async function insertText(tabId, text, delay) {
  const characters = Array.from(String(text || ''));
  await withDebugger(tabId, async () => {
    if (!delay || delay <= 0) {
      await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', {
        text: characters.join(''),
      });
      return;
    }

    for (let index = 0; index < characters.length; index += 1) {
      const char = characters[index];
      await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', {
        text: char,
      });
      if (index < characters.length - 1) {
        await sleep(delay);
      }
    }
  });
}

async function startNetworkCapture(tabId, options) {
  const state = getTabState(tabId);
  const wasEnabled = state.network.enabled;
  state.network.enabled = true;
  state.network.captureBody = !!(options && options.captureBody);
  state.network.urlFilter = options && options.urlFilter ? String(options.urlFilter) : '';
  state.network.urlFilterRegex = state.network.urlFilter ? new RegExp(state.network.urlFilter) : null;
  state.network.maxEntries =
    options && Number.isFinite(options.maxEntries) ? Math.max(1, Math.trunc(options.maxEntries)) : 1000;

  if (!options || options.clearExisting !== false) {
    state.network.entries.clear();
    await postRelayEvent({ type: 'network-reset' });
  }

  if (!wasEnabled) {
    await acquireNetworkTracking(tabId);
  } else if (!state.network.cdpEnabled) {
    await ensureNetworkDomainEnabled(tabId);
  }
}

async function stopNetworkCapture(tabId) {
  const state = getTabState(tabId);
  if (!state.network.enabled) {
    return;
  }
  state.network.enabled = false;
  state.network.captureBody = false;
  state.network.urlFilter = '';
  state.network.urlFilterRegex = null;
  await releaseNetworkTracking(tabId);
}

function upsertNetworkEntry(tabId, requestId, mutate) {
  const state = getTabState(tabId);
  const key = String(requestId || '');
  const existing =
    state.network.entries.get(key) ||
    {
      id: key,
      url: '',
      method: 'GET',
      resourceType: 'other',
      classification: 'other',
      startTime: Date.now(),
    };
  mutate(existing);
  existing.classification = classifyNetworkEntry(existing);
  state.network.entries.set(key, existing);
  if (state.network.entries.size > state.network.maxEntries) {
    const keys = Array.from(state.network.entries.keys());
    while (state.network.entries.size > state.network.maxEntries) {
      const key = keys.shift();
      if (!key) break;
      state.network.entries.delete(key);
    }
  }
  return existing;
}

async function handleNetworkEvent(tabId, method, params) {
  const state = getTabState(tabId);
  if (!wantsNetworkTracking(state)) {
    return;
  }

  const requestId = String((params && params.requestId) || '');

  if (method === 'Network.requestWillBeSent') {
    markNetworkRequestStarted(state, requestId);
    if (!state.network.enabled) {
      return;
    }

    const requestUrl = params.request && params.request.url ? String(params.request.url) : '';
    if (!shouldCaptureNetworkUrl(state, requestUrl)) {
      state.network.entries.delete(requestId);
      return;
    }

    const entry = upsertNetworkEntry(tabId, params.requestId, (target) => {
      target.url = requestUrl;
      target.method = params.request && params.request.method ? params.request.method : 'GET';
      target.resourceType = params.type ? String(params.type).toLowerCase() : 'other';
      target.requestHeaders =
        params.request && params.request.headers
          ? normalizeHeaderRecord(params.request.headers)
          : {};
      target.requestBody = params.request && params.request.postData ? params.request.postData : undefined;
      target.startTime = Date.now();
    });
    queueRelayEvent({ type: 'network-entry', entry });
    return;
  }

  if (method === 'Network.responseReceived') {
    if (!state.network.enabled || !state.network.entries.has(requestId)) {
      return;
    }
    const entry = upsertNetworkEntry(tabId, params.requestId, (target) => {
      target.status = params.response ? params.response.status : undefined;
      target.statusText = params.response ? params.response.statusText : undefined;
      target.responseHeaders =
        params.response && params.response.headers
          ? normalizeHeaderRecord(params.response.headers)
          : undefined;
    });
    queueRelayEvent({ type: 'network-entry', entry });
    return;
  }

  if (method === 'Network.loadingFinished') {
    markNetworkRequestFinished(state, requestId);
    if (!state.network.enabled || !state.network.entries.has(requestId)) {
      return;
    }
    const entry = upsertNetworkEntry(tabId, params.requestId, (target) => {
      target.endTime = Date.now();
      target.duration = target.endTime - target.startTime;
    });

    if (state.network.captureBody) {
      try {
        const body = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', {
          requestId: params.requestId,
        });
        entry.responseBody = body && body.base64Encoded ? atob(body.body || '') : body.body;
      } catch (error) {
        rememberCommandError(
          'Network.getResponseBody failed: ' +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }

    queueRelayEvent({ type: 'network-entry', entry });
    return;
  }

  if (method === 'Network.loadingFailed') {
    markNetworkRequestFinished(state, requestId);
    if (!state.network.enabled || !state.network.entries.has(requestId)) {
      return;
    }
    const entry = upsertNetworkEntry(tabId, params.requestId, (target) => {
      target.endTime = Date.now();
      target.duration = target.endTime - target.startTime;
      target.error = params.errorText || 'request_failed';
    });
    queueRelayEvent({ type: 'network-entry', entry });
  }
}

async function startConsoleCapture(tabId, level) {
  const state = getTabState(tabId);
  state.console.enabled = true;
  state.console.level = level || 'all';
  await postRelayEvent({ type: 'console-reset' });

  await attachDebugger(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
}

async function stopConsoleCapture(tabId) {
  const state = getTabState(tabId);
  state.console.enabled = false;
  await detachDebuggerIfIdle(tabId);
}

async function handleConsoleEvent(tabId, method, params) {
  const state = getTabState(tabId);
  if (!state.console.enabled) {
    return;
  }

  let message = null;
  if (method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(params.args) ? params.args : [];
    message = {
      level:
        params.type === 'error'
          ? 'error'
          : params.type === 'warning'
            ? 'warning'
            : params.type === 'debug'
              ? 'verbose'
              : 'info',
      message: args
        .map((item) => {
          if (typeof item.value === 'string') return item.value;
          if (item.value !== undefined) return String(item.value);
          if (item.description) return String(item.description);
          return '';
        })
        .filter(Boolean)
        .join(' '),
      source:
        params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0]
          ? params.stackTrace.callFrames[0].url
          : undefined,
      line:
        params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0]
          ? params.stackTrace.callFrames[0].lineNumber
          : undefined,
      timestamp: Date.now(),
    };
  } else if (method === 'Log.entryAdded' && params.entry) {
    message = {
      level:
        params.entry.level === 'error'
          ? 'error'
          : params.entry.level === 'warning'
            ? 'warning'
            : 'info',
      message: params.entry.text || '',
      source: params.entry.url || undefined,
      line: params.entry.lineNumber || undefined,
      timestamp: Date.now(),
    };
  }

  if (message) {
    queueRelayEvent({
      type: 'console-message',
      message,
    });
  }
}

async function startRequestInterception(tabId, options) {
  const state = getTabState(tabId);
  const wasEnabled = state.intercept.enabled;
  state.intercept.enabled = true;
  state.intercept.patterns =
    options && Array.isArray(options.patterns) ? options.patterns.slice() : [];
  state.intercept.pendingRequests.clear();

  await attachDebugger(tabId);
  if (wasEnabled) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable');
    } catch (error) {
      rememberCommandError(
        'Fetch.disable before re-enable failed: ' +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
    patterns: [
      {
        urlPattern: '*',
        requestStage: 'Request',
      },
    ],
  });
}

async function stopRequestInterception(tabId) {
  const state = getTabState(tabId);
  if (!state.intercept.enabled) {
    return;
  }

  state.intercept.enabled = false;
  state.intercept.patterns = [];
  state.intercept.pendingRequests.clear();

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable');
  } catch (error) {
    rememberCommandError(
      'Fetch.disable failed: ' + (error instanceof Error ? error.message : String(error))
    );
  }

  await detachDebuggerIfIdle(tabId);
}

function getInterceptedRequest(state, requestId) {
  const key = String(requestId || '').trim();
  if (!key) {
    throw new Error('requestId is required');
  }

  const request = state.intercept.pendingRequests.get(key);
  if (!request) {
    throw new Error('Intercepted request not found: ' + key);
  }
  return request;
}

function createInterceptedRequest(tabId, params) {
  const request =
    params && params.request && typeof params.request === 'object' ? params.request : {};
  const requestId = String((params && params.requestId) || '').trim();
  return {
    id: requestId,
    url: String(request.url || ''),
    method: String(request.method || 'GET').toUpperCase(),
    headers: normalizeHeaderRecord(request.headers),
    resourceType: params && params.resourceType ? String(params.resourceType).toLowerCase() : 'other',
    contextId: String(tabId),
    postData: typeof request.postData === 'string' ? request.postData : undefined,
    isBlocked: true,
  };
}

async function continueInterceptedRequest(tabId, requestId, overrides) {
  const state = getTabState(tabId);
  getInterceptedRequest(state, requestId);
  const headers = serializeFetchHeaders(overrides && overrides.headers);
  await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', {
    requestId,
    ...(overrides && overrides.url ? { url: String(overrides.url) } : {}),
    ...(overrides && overrides.method ? { method: String(overrides.method) } : {}),
    ...(headers ? { headers } : {}),
    ...(overrides && typeof overrides.postData === 'string'
      ? { postData: toBase64Utf8(overrides.postData) }
      : {}),
  });
  state.intercept.pendingRequests.delete(String(requestId));
}

async function fulfillInterceptedRequest(tabId, requestId, response) {
  const state = getTabState(tabId);
  getInterceptedRequest(state, requestId);
  const headers = serializeFetchHeaders(response && response.headers);
  await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
    requestId,
    responseCode:
      response && Number.isFinite(response.status) ? Math.max(100, Math.trunc(response.status)) : 200,
    ...(headers ? { responseHeaders: headers } : {}),
    ...(response && typeof response.body === 'string'
      ? { body: toBase64Utf8(response.body) }
      : {}),
  });
  state.intercept.pendingRequests.delete(String(requestId));
}

async function failInterceptedRequest(tabId, requestId, errorReason) {
  const state = getTabState(tabId);
  getInterceptedRequest(state, requestId);
  await chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', {
    requestId,
    errorReason: normalizeFetchErrorReason(errorReason),
  });
  state.intercept.pendingRequests.delete(String(requestId));
}

async function handleInterceptEvent(tabId, method, params) {
  if (method !== 'Fetch.requestPaused') {
    return;
  }

  const state = getTabState(tabId);
  const requestId = String((params && params.requestId) || '').trim();
  if (!requestId) {
    return;
  }

  if (!state.intercept.enabled) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId });
    } catch (error) {
      rememberCommandError(
        'Fetch.continueRequest for disabled intercept failed: ' +
          (error instanceof Error ? error.message : String(error))
      );
    }
    return;
  }

  const request = createInterceptedRequest(tabId, params);
  if (!matchesInterceptPatterns(request, state.intercept.patterns)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId });
    } catch (error) {
      rememberCommandError(
        'Fetch.continueRequest for filtered intercept failed: ' +
          (error instanceof Error ? error.message : String(error))
      );
    }
    return;
  }

  state.intercept.pendingRequests.set(requestId, request);
  await postRelayEvent({
    type: 'intercepted-request',
    request,
  });
}

async function handleDialogEvent(tabId, method, params) {
  const state = getTabState(tabId);

  if (method === 'Page.javascriptDialogOpening') {
    state.dialog.current = {
      type:
        params && typeof params.type === 'string'
          ? params.type
          : 'alert',
      message: params && typeof params.message === 'string' ? params.message : '',
      defaultValue:
        params && typeof params.defaultPrompt === 'string' ? params.defaultPrompt : undefined,
      contextId: String(tabId),
    };
    await postRelayEvent({
      type: 'dialog-opened',
      dialog: { ...state.dialog.current },
    });
    return;
  }

  if (method === 'Page.javascriptDialogClosed') {
    state.dialog.current = null;
    await postRelayEvent({
      type: 'dialog-closed',
      contextId: String(tabId),
    });
    await detachDebuggerIfIdle(tabId);
  }
}

async function captureScreenshot(tabId, params) {
  const format = params && params.format === 'jpeg' ? 'jpeg' : 'png';
  const captureMode = params && params.captureMode === 'full_page' ? 'full_page' : 'viewport';
  let selectorState = null;
  const currentTab = await chrome.tabs.get(tabId);
  if (params && params.selector) {
    selectorState = await queryElementState(tabId, String(params.selector), true);
    if (!selectorState || !selectorState.found || !selectorState.pageBounds) {
      throw new Error('Element not found for screenshot: ' + params.selector);
    }
  }

  return withWindowReadyForScreenshot(currentTab.windowId, async () =>
    withDebugger(tabId, async () => {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      const layoutMetrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
      const contentSize = layoutMetrics.cssContentSize || layoutMetrics.contentSize;
      const layoutViewport = layoutMetrics.cssLayoutViewport || layoutMetrics.layoutViewport;

      let clip;
      let captureMethod = captureMode === 'full_page' ? 'cdp.full_page_screenshot' : 'cdp.viewport_screenshot';
      if (selectorState && selectorState.pageBounds) {
        clip = {
          x: selectorState.pageBounds.x,
          y: selectorState.pageBounds.y,
          width: Math.max(1, selectorState.pageBounds.width),
          height: Math.max(1, selectorState.pageBounds.height),
          scale: 1,
        };
        captureMethod = 'cdp.viewport_screenshot';
      } else if (captureMode === 'full_page' && contentSize) {
        clip = {
          x: 0,
          y: 0,
          width: Math.max(1, contentSize.width),
          height: Math.max(1, contentSize.height),
          scale: 1,
        };
      } else if (layoutViewport) {
        clip = {
          x: layoutViewport.pageX || 0,
          y: layoutViewport.pageY || 0,
          width: Math.max(1, layoutViewport.clientWidth || 1),
          height: Math.max(1, layoutViewport.clientHeight || 1),
          scale: 1,
        };
      }

      const screenshot = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format,
        quality: format === 'jpeg' && params && params.quality ? params.quality : undefined,
        captureBeyondViewport: captureMode === 'full_page',
        clip,
      });

      return {
        data: screenshot.data,
        mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        format,
        captureMode,
        captureMethod,
        fallbackUsed: false,
        degraded: false,
        degradationReason: null,
      };
    })
  );
}

async function withWindowReadyForScreenshot(windowId, work) {
  const currentWindow = await chrome.windows.get(windowId);
  const wasMinimized = currentWindow && currentWindow.state === 'minimized';

  if (wasMinimized) {
    await chrome.windows.update(windowId, {
      state: 'normal',
      focused: false,
    });
    await sleep(150);
  }

  try {
    return await work();
  } finally {
    if (wasMinimized) {
      try {
        await chrome.windows.update(windowId, {
          state: 'minimized',
        });
      } catch {
        // ignore best-effort restore failures
      }
    }
  }
}

async function removeAllCookies() {
  const cookies = await chrome.cookies.getAll({});
  for (const cookie of cookies) {
    const domain = String(cookie.domain || '').replace(/^\./, '');
    if (!domain) {
      continue;
    }
    const scheme = cookie.secure ? 'https://' : 'http://';
    const url = scheme + domain + (cookie.path || '/');
    try {
      await chrome.cookies.remove({
        url,
        name: cookie.name,
        storeId: cookie.storeId,
      });
    } catch {
      // ignore removal errors
    }
  }
}

async function setCookie(cookie, fallbackUrl) {
  const domain = String((cookie && cookie.domain) || '').replace(/^\./, '');
  const explicitUrl = String((cookie && cookie.url) || '').trim();
  const cookiePath = String((cookie && cookie.path) || '/');
  let url =
    explicitUrl ||
    (domain
      ? (cookie && cookie.secure ? 'https://' : 'http://') + domain + cookiePath
      : '');

  if (!url && fallbackUrl) {
    try {
      const resolved = new URL(String(fallbackUrl));
      resolved.pathname = cookiePath;
      resolved.search = '';
      resolved.hash = '';
      url = resolved.toString();
    } catch {
      // ignore invalid fallback urls and let the validation below fail with a clearer message
    }
  }

  if (!url) {
    throw new Error('Cookie url or domain is required');
  }

  await chrome.cookies.set({
    url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    expirationDate: cookie.expirationDate,
  });
}

async function executeCommand(command) {
  const params = command && command.params ? command.params : {};
  const tab = await resolveCommandTab(params.target);
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('No target tab available');
  }
  const tabId = tab.id;

  switch (command.name) {
    case '${REMOTE_BROWSER_COMMAND.goto}': {
      const url = String(params.url || '').trim();
      if (!url) {
        throw new Error('goto requires url');
      }
      const timeoutMs = Number.isFinite(params.timeout) ? Math.max(1000, Math.trunc(params.timeout)) : 30000;
      const waitUntil = params.waitUntil || 'load';
      const shouldTrackNetwork = requiresNetworkIdleTracking(waitUntil);
      let activeTabId = tabId;
      if (shouldTrackNetwork) {
        await acquireNetworkTracking(activeTabId);
      }
      try {
        if (shouldNavigateInPage(url)) {
          const createdTab = await chrome.tabs.create({
            url,
            active: true,
            windowId: tab.windowId,
          });
          if (!createdTab || typeof createdTab.id !== 'number') {
            throw new Error('Failed to create data URL tab');
          }
          activeTabId = createdTab.id;
          if (shouldTrackNetwork) {
            await releaseNetworkTracking(tabId);
            await acquireNetworkTracking(activeTabId);
          }
        } else {
          const updatedTab = await chrome.tabs.update(activeTabId, { url });
          if (updatedTab && typeof updatedTab.id === 'number') {
            activeTabId = updatedTab.id;
          }
        }
        await waitForReadyState(activeTabId, waitUntil, timeoutMs);
        if (globalWindowOpenPolicy) {
          await runDomTask(activeTabId, 'applyWindowOpenPolicy', { policy: globalWindowOpenPolicy });
        }
        if (shouldNavigateInPage(url) && activeTabId !== tabId) {
          try {
            await chrome.tabs.remove(tabId);
          } catch {
            // ignore old tab cleanup failures
          }
        }
        const currentTab = await chrome.tabs.get(activeTabId);
        await emitClientStateFromTab(currentTab);
        return {
          tabId: typeof currentTab.id === 'number' ? currentTab.id : null,
          windowId: typeof currentTab.windowId === 'number' ? currentTab.windowId : null,
          url: currentTab.url || null,
          title: currentTab.title || null,
        };
      } finally {
        if (shouldTrackNetwork) {
          await releaseNetworkTracking(activeTabId);
          if (activeTabId !== tabId) {
            await releaseNetworkTracking(tabId);
          }
        }
      }
    }
    case '${REMOTE_BROWSER_COMMAND.back}':
      await runDomTask(tabId, 'historyBack', {});
      await sleep(400);
      return true;
    case '${REMOTE_BROWSER_COMMAND.forward}':
      await runDomTask(tabId, 'historyForward', {});
      await sleep(400);
      return true;
    case '${REMOTE_BROWSER_COMMAND.reload}':
      {
        const waitUntil = params.waitUntil || 'load';
        const timeoutMs =
          Number.isFinite(params.timeout) ? Math.max(1000, Math.trunc(params.timeout)) : 30000;
        const shouldTrackNetwork = requiresNetworkIdleTracking(waitUntil);
        if (shouldTrackNetwork) {
          await acquireNetworkTracking(tabId);
        }
        try {
          await chrome.tabs.reload(tabId);
          await waitForReadyState(tabId, waitUntil, timeoutMs);
          if (globalWindowOpenPolicy) {
            await runDomTask(tabId, 'applyWindowOpenPolicy', { policy: globalWindowOpenPolicy });
          }
        } finally {
          if (shouldTrackNetwork) {
            await releaseNetworkTracking(tabId);
          }
        }
      }
      return true;
    case '${REMOTE_BROWSER_COMMAND.navigationStop}':
      await runDomTask(tabId, 'stopNavigation', {});
      return true;
    case '${REMOTE_BROWSER_COMMAND.getCurrentUrl}':
      return (await chrome.tabs.get(tabId)).url || '';
    case '${REMOTE_BROWSER_COMMAND.title}':
      return (await chrome.tabs.get(tabId)).title || '';
    case '${REMOTE_BROWSER_COMMAND.waitForSelector}':
      await waitForSelectorState(
        tabId,
        String(params.selector || ''),
        params.state || 'attached',
        Number.isFinite(params.timeout) ? Math.max(1000, Math.trunc(params.timeout)) : 30000
      );
      return true;
    case '${REMOTE_BROWSER_COMMAND.click}': {
      const selector = String(params.selector || '');
      const nonBlocking = !!params.nonBlocking;
      const state = await queryElementState(tabId, selector, true);
      if (state && state.found && state.visible && state.viewportCenter) {
        const performNativeClick = async () => {
          await nativeClick(
            tabId,
            state.viewportCenter.x,
            state.viewportCenter.y,
            'left',
            1,
            undefined
          );
        };
        if (nonBlocking) {
          queueMicrotask(() => {
            performNativeClick().catch((error) => {
              rememberCommandError(
                'native click failed after non-blocking dispatch: ' +
                  (error instanceof Error ? error.message : String(error))
              );
            });
          });
          return true;
        }
        await performNativeClick();
        return true;
      }
      try {
        const domClicked = await runDomTask(tabId, 'clickElement', { selector });
        if (domClicked) {
          return true;
        }
      } catch {
        // surface the original visibility failure below
      }
      throw new Error('Element not found or not visible: ' + selector);
    }
    case '${REMOTE_BROWSER_COMMAND.type}': {
        const selector = String(params.selector || '');
        const state = await runDomTask(tabId, 'focusElement', { selector });
        if (!state || !state.found || !state.visible || !state.viewportCenter) {
          throw new Error('Element not found for type: ' + params.selector);
        }
        await nativeClick(tabId, state.viewportCenter.x, state.viewportCenter.y, 'left', 1, 10);
        if (params.clear) {
          await clearFocusedEditable(tabId, selector);
        }
        await insertText(tabId, String(params.text || ''), 0);
        return true;
      }
    case '${REMOTE_BROWSER_COMMAND.select}':
      await runDomTask(tabId, 'selectValue', {
        selector: String(params.selector || ''),
        value: String(params.value || ''),
      });
      return true;
    case '${REMOTE_BROWSER_COMMAND.getText}':
      return runDomTask(tabId, 'getText', {
        selector: String(params.selector || ''),
      });
    case '${REMOTE_BROWSER_COMMAND.getAttribute}':
      return runDomTask(tabId, 'getAttribute', {
        selector: String(params.selector || ''),
        attribute: String(params.attribute || ''),
      });
    case '${REMOTE_BROWSER_COMMAND.evaluate}':
      return runDomTask(tabId, 'evaluate', {
        script: String(params.script || ''),
      });
    case '${REMOTE_BROWSER_COMMAND.evaluateWithArgs}':
      return runDomTask(tabId, 'evaluateWithArgs', {
        functionSource: String(params.functionSource || ''),
        args: Array.isArray(params.args) ? params.args : [],
      });
    case '${REMOTE_BROWSER_COMMAND.screenshot}':
      return captureScreenshot(tabId, params);
    case '${REMOTE_BROWSER_COMMAND.cookiesGetAll}': {
      const cookies = await chrome.cookies.getAll({});
      return cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate,
      }));
    }
    case '${REMOTE_BROWSER_COMMAND.cookiesSet}':
      await setCookie(params.cookie || {}, tab.url || '');
      return true;
    case '${REMOTE_BROWSER_COMMAND.cookiesClear}':
      await removeAllCookies();
      return true;
    case '${REMOTE_BROWSER_COMMAND.networkStart}':
      await startNetworkCapture(tabId, params.options || {});
      return true;
    case '${REMOTE_BROWSER_COMMAND.networkStop}':
      await stopNetworkCapture(tabId);
      return true;
    case '${REMOTE_BROWSER_COMMAND.networkClear}': {
      const state = getTabState(tabId);
      state.network.entries.clear();
      await postRelayEvent({ type: 'network-reset' });
      return true;
    }
    case '${REMOTE_BROWSER_COMMAND.consoleStart}':
      await startConsoleCapture(tabId, params.level || 'all');
      return true;
    case '${REMOTE_BROWSER_COMMAND.consoleStop}':
      await stopConsoleCapture(tabId);
      return true;
    case '${REMOTE_BROWSER_COMMAND.consoleClear}':
      await postRelayEvent({ type: 'console-reset' });
      return true;
    case '${REMOTE_BROWSER_COMMAND.networkInterceptEnable}':
      await startRequestInterception(tabId, params.options || {});
      return true;
    case '${REMOTE_BROWSER_COMMAND.networkInterceptDisable}':
      await stopRequestInterception(tabId);
      return true;
    case '${REMOTE_BROWSER_COMMAND.networkInterceptContinue}':
      await continueInterceptedRequest(tabId, params.requestId, params.overrides || {});
      return true;
    case '${REMOTE_BROWSER_COMMAND.networkInterceptFulfill}':
      await fulfillInterceptedRequest(tabId, params.requestId, params.response || {});
      return true;
    case '${REMOTE_BROWSER_COMMAND.networkInterceptFail}':
      await failInterceptedRequest(tabId, params.requestId, params.errorReason);
      return true;
    case '${REMOTE_BROWSER_COMMAND.show}': {
      const currentTab = await chrome.tabs.get(tabId);
      await chrome.windows.update(currentTab.windowId, {
        focused: true,
        state: 'normal',
      });
      return true;
    }
    case '${REMOTE_BROWSER_COMMAND.hide}': {
      const currentTab = await chrome.tabs.get(tabId);
      await chrome.windows.update(currentTab.windowId, {
        state: 'minimized',
      });
      return true;
    }
    case '${REMOTE_BROWSER_COMMAND.clientStateGet}':
      return emitCurrentClientState();
    case '${REMOTE_BROWSER_COMMAND.dialogArm}':
      return armDialog(tabId);
    case '${REMOTE_BROWSER_COMMAND.dialogDisarm}':
      await disarmDialog(tabId);
      return true;
    case '${REMOTE_BROWSER_COMMAND.dialogWait}':
      return waitForDialog(
        tabId,
        Number.isFinite(params.timeoutMs) ? Math.max(1000, Math.trunc(params.timeoutMs)) : 30000
      );
    case '${REMOTE_BROWSER_COMMAND.dialogHandle}':
      await handleDialog(tabId, params);
      return true;
    case '${REMOTE_BROWSER_COMMAND.tabsList}': {
      const currentState = await emitCurrentClientState();
      const tabs = await chrome.tabs.query({});
      return tabs
        .filter((item) => item && typeof item.id === 'number')
        .map((item) => toTabInfo(item, currentState.tabId));
    }
    case '${REMOTE_BROWSER_COMMAND.tabsCreate}': {
      const created = await chrome.tabs.create({
        url: typeof params.url === 'string' && params.url.trim().length > 0 ? params.url : 'about:blank',
        active: params.active !== false,
        windowId: typeof tab.windowId === 'number' ? tab.windowId : undefined,
      });
      if (!created || typeof created.id !== 'number') {
        throw new Error('Failed to create tab');
      }
      if (created.active) {
        await emitClientStateFromTab(created);
      }
      return toTabInfo(created, created.active ? created.id : tabId);
    }
    case '${REMOTE_BROWSER_COMMAND.tabsActivate}': {
      const targetTabId = Number.parseInt(String(params.id || ''), 10);
      if (!Number.isFinite(targetTabId)) {
        throw new Error('tabs.activate requires id');
      }
      const updated = await chrome.tabs.update(targetTabId, { active: true });
      if (!updated || typeof updated.id !== 'number') {
        throw new Error('Failed to activate tab');
      }
      await chrome.windows.update(updated.windowId, { focused: true });
      await emitClientStateFromTab(updated);
      return true;
    }
    case '${REMOTE_BROWSER_COMMAND.tabsClose}': {
      const targetTabId = Number.parseInt(String(params.id || ''), 10);
      if (!Number.isFinite(targetTabId)) {
        throw new Error('tabs.close requires id');
      }
      await chrome.tabs.remove(targetTabId);
      return await emitCurrentClientState().catch(() => null);
    }
    case '${REMOTE_BROWSER_COMMAND.emulationIdentitySet}':
      await applyIdentityEmulation(tabId, params.options || {});
      return true;
    case '${REMOTE_BROWSER_COMMAND.emulationViewportSet}':
      await applyViewportEmulation(tabId, params.options || {});
      return true;
    case '${REMOTE_BROWSER_COMMAND.emulationClear}':
      await clearEmulationOverrides(tabId);
      return true;
    case '${REMOTE_BROWSER_COMMAND.nativeClick}':
      await nativeClick(
        tabId,
        Number(params.x || 0),
        Number(params.y || 0),
        params.button || 'left',
        Number(params.clickCount || 1),
        Number(params.delay || 0) || undefined
      );
      return true;
    case '${REMOTE_BROWSER_COMMAND.nativeMove}':
      await withDebugger(tabId, async () => {
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Number(params.x || 0),
          y: Number(params.y || 0),
          button: 'left',
        });
      });
      return true;
    case '${REMOTE_BROWSER_COMMAND.nativeDrag}':
      await withDebugger(tabId, async () => {
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Number(params.fromX || 0),
          y: Number(params.fromY || 0),
          button: 'left',
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: Number(params.fromX || 0),
          y: Number(params.fromY || 0),
          button: 'left',
          clickCount: 1,
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Number(params.toX || 0),
          y: Number(params.toY || 0),
          button: 'left',
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: Number(params.toX || 0),
          y: Number(params.toY || 0),
          button: 'left',
          clickCount: 1,
        });
      });
      return true;
    case '${REMOTE_BROWSER_COMMAND.nativeType}':
      await insertText(tabId, String(params.text || ''), Number(params.delay || 0));
      return true;
    case '${REMOTE_BROWSER_COMMAND.nativeKeyPress}':
      await sendKeyEvent(
        tabId,
        String(params.key || ''),
        Array.isArray(params.modifiers) ? params.modifiers : []
      );
      return true;
    case '${REMOTE_BROWSER_COMMAND.nativeScroll}':
      await withDebugger(tabId, async () => {
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Number(params.x || 0),
          y: Number(params.y || 0),
          button: 'left',
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Number(params.x || 0),
          y: Number(params.y || 0),
          deltaX: Number(params.deltaX || 0),
          deltaY: Number(params.deltaY || 0),
        });
      });
      return true;
    case '${REMOTE_BROWSER_COMMAND.windowOpenSetPolicy}':
      globalWindowOpenPolicy = params.policy || null;
      await runDomTask(tabId, 'applyWindowOpenPolicy', { policy: globalWindowOpenPolicy });
      return true;
    case '${REMOTE_BROWSER_COMMAND.windowOpenClearPolicy}':
      globalWindowOpenPolicy = null;
      await runDomTask(tabId, 'applyWindowOpenPolicy', { policy: null });
      return true;
    default:
      throw new Error('Unsupported extension control command: ' + command.name);
  }
}`;
}

function renderFooter(): string {
  return String.raw`chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || typeof source.tabId !== 'number') {
    return;
  }

  const tabId = source.tabId;
  handleNetworkEvent(tabId, method, params).catch((error) => {
    rememberCommandError('handleNetworkEvent failed: ' + (error instanceof Error ? error.message : String(error)));
  });
  handleConsoleEvent(tabId, method, params).catch((error) => {
    rememberCommandError('handleConsoleEvent failed: ' + (error instanceof Error ? error.message : String(error)));
  });
  handleInterceptEvent(tabId, method, params).catch((error) => {
    rememberCommandError('handleInterceptEvent failed: ' + (error instanceof Error ? error.message : String(error)));
  });
  handleDialogEvent(tabId, method, params).catch((error) => {
    rememberCommandError('handleDialogEvent failed: ' + (error instanceof Error ? error.message : String(error)));
  });
});

chrome.debugger.onDetach.addListener((source) => {
  if (!source || typeof source.tabId !== 'number') {
    return;
  }
  const state = getTabState(source.tabId);
  state.debuggerAttached = false;
  state.network.cdpEnabled = false;
  state.network.inflight.clear();
  state.intercept.enabled = false;
  state.intercept.pendingRequests.clear();
  state.emulation = createEmulationState();
  updateNetworkActivity(state);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await emitClientStateFromTab(tab);
  } catch {
    // ignore
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab || !tab.active) {
    return;
  }
  if ('status' in changeInfo || 'url' in changeInfo || 'title' in changeInfo) {
    postRelayEvent({
      type: 'client-state',
      tabId,
      windowId: typeof tab.windowId === 'number' ? tab.windowId : null,
      url: tab.url || null,
      title: tab.title || null,
    }).catch(() => undefined);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
});

chrome.runtime.onStartup.addListener(() => {
  ensureProxyAuthHandler().catch((error) => {
    rememberRelayError('ensureProxyAuthHandler failed on startup: ' + (error instanceof Error ? error.message : String(error)));
  });
  ensureOffscreenDocument().catch((error) => {
    rememberRelayError('ensureOffscreenDocument failed on startup: ' + (error instanceof Error ? error.message : String(error)));
  });
});

chrome.runtime.onInstalled.addListener(() => {
  ensureProxyAuthHandler().catch((error) => {
    rememberRelayError('ensureProxyAuthHandler failed on install: ' + (error instanceof Error ? error.message : String(error)));
  });
  ensureOffscreenDocument().catch((error) => {
    rememberRelayError('ensureOffscreenDocument failed on install: ' + (error instanceof Error ? error.message : String(error)));
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'airpa-get-relay-config') {
    Promise.resolve(getRelayRuntimeConfig())
      .then((config) => sendResponse(config))
      .catch((error) =>
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        })
      );
    return true;
  }

  if (message && message.type === 'airpa-get-diagnostics') {
    sendResponse(createBackgroundDiagnosticsSnapshot());
    return false;
  }

  if (message && message.type === 'airpa-register-failure') {
    noteOffscreenRegisterFailure(message.error);
    sendResponse({ ok: true });
    return false;
  }

  if (message && message.type === 'airpa-get-state') {
    emitCurrentClientState()
      .then((state) => sendResponse(state))
      .catch((error) =>
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        })
      );
    return true;
  }

  if (message && message.type === 'airpa-exec') {
    executeCommand(message.command || {})
      .then((result) => {
        sendResponse({
          ok: true,
          result,
        });
      })
      .catch((error) => {
        rememberCommandError(
          'executeCommand failed for ' +
            String(message && message.command && message.command.name ? message.command.name : 'unknown') +
            ': ' +
            (error instanceof Error ? error.message : String(error))
        );
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          diagnostics: createBackgroundDiagnosticsSnapshot(),
        });
      });
    return true;
  }

  return false;
});

ensureProxyAuthHandler().catch((error) => {
  rememberRelayError('ensureProxyAuthHandler failed: ' + (error instanceof Error ? error.message : String(error)));
});
ensureOffscreenDocument().catch((error) => {
  rememberRelayError('ensureOffscreenDocument failed: ' + (error instanceof Error ? error.message : String(error)));
});`;
}
