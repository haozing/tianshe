export function renderFooter(): string {
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
