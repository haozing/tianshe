import type { ExtensionBackgroundRuntimeConfig } from './extension-control-extension-background-runtime';

export function renderPrelude(runtimeConfig: ExtensionBackgroundRuntimeConfig): string {
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
