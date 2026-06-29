export function renderCommandNetworkRuntime(): string {
  return String.raw`async function ensureNetworkDomainEnabled(tabId) {
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
}`;
}
