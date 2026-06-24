import { REMOTE_BROWSER_COMMAND } from './remote-browser-command-protocol';

export function renderCommandDispatcher(): string {
  return String.raw`async function executeCommand(command) {
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
      const nativeClickElement = async () => {
        const state = await queryElementState(tabId, selector, true);
        if (state && state.found && state.visible && state.viewportCenter) {
          await nativeClick(
            tabId,
            state.viewportCenter.x,
            state.viewportCenter.y,
            'left',
            1,
            undefined
          );
          return true;
        }
        return false;
      };
      const performClick = async () => {
        if (nonBlocking && (await nativeClickElement())) {
          return;
        }

        try {
          const domClicked = await runDomTask(tabId, 'clickElement', { selector });
          if (domClicked) {
            return;
          }
        } catch {
          // fall back to native click below
        }

        if (await nativeClickElement()) {
          return;
        }
        throw new Error('Element not found or not visible: ' + selector);
      };
      if (nonBlocking) {
        queueMicrotask(() => {
          performClick().catch((error) => {
            rememberCommandError(
              'click failed after non-blocking dispatch: ' +
                (error instanceof Error ? error.message : String(error))
            );
          });
        });
        return true;
      }
      await performClick();
      return true;
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
    case '${REMOTE_BROWSER_COMMAND.cookiesSet}': {
      const cookie = params.cookie || {};
      await setCookie(tabId, cookie, tab.url || '');
      if (!cookie.httpOnly) {
        await runDomTask(tabId, 'setDocumentCookie', {
          name: cookie.name,
          value: cookie.value,
          path: cookie.path || '/',
          expirationDate: cookie.expirationDate,
          secure: !!cookie.secure,
          sameSite: cookie.sameSite,
        }).catch(() => undefined);
      }
      await flushCookiesToDisk(tabId);
      return true;
    }
    case '${REMOTE_BROWSER_COMMAND.cookiesClear}':
      await removeAllCookies();
      return true;
    case '${REMOTE_BROWSER_COMMAND.storageGetItem}':
      return runDomTask(tabId, 'storage.getItem', {
        area: params.area === 'session' ? 'session' : 'local',
        key: String(params.key || ''),
      });
    case '${REMOTE_BROWSER_COMMAND.storageSetItem}':
      await runDomTask(tabId, 'storage.setItem', {
        area: params.area === 'session' ? 'session' : 'local',
        key: String(params.key || ''),
        value: String(params.value || ''),
      });
      return true;
    case '${REMOTE_BROWSER_COMMAND.storageRemoveItem}':
      await runDomTask(tabId, 'storage.removeItem', {
        area: params.area === 'session' ? 'session' : 'local',
        key: String(params.key || ''),
      });
      return true;
    case '${REMOTE_BROWSER_COMMAND.storageClearArea}':
      await runDomTask(tabId, 'storage.clearArea', {
        area: params.area === 'session' ? 'session' : 'local',
      });
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
    case '${REMOTE_BROWSER_COMMAND.networkSnapshot}': {
      const state = getTabState(tabId);
      return Array.from(state.network.entries.values()).map((entry) => ({
        ...entry,
        requestHeaders: entry.requestHeaders ? { ...entry.requestHeaders } : undefined,
        responseHeaders: entry.responseHeaders ? { ...entry.responseHeaders } : undefined,
      }));
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
    case '${REMOTE_BROWSER_COMMAND.browserClose}': {
      await flushCookiesToDisk(tabId);
      try {
        await withDebugger(tabId, async () => {
          await chrome.debugger.sendCommand({ tabId }, 'Browser.close');
        });
      } catch {
        const windows = await chrome.windows.getAll({});
        await Promise.all(
          windows
            .filter((item) => item && typeof item.id === 'number')
            .map((item) => chrome.windows.remove(item.id).catch(() => undefined))
        );
      }
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
    case '${REMOTE_BROWSER_COMMAND.touchTap}':
      await dispatchTouchTap(tabId, Number(params.x || 0), Number(params.y || 0), 50);
      return true;
    case '${REMOTE_BROWSER_COMMAND.touchLongPress}':
      await dispatchTouchTap(
        tabId,
        Number(params.x || 0),
        Number(params.y || 0),
        Number(params.durationMs || 600)
      );
      return true;
    case '${REMOTE_BROWSER_COMMAND.touchDrag}':
      await dispatchTouchDrag(
        tabId,
        Number(params.fromX || 0),
        Number(params.fromY || 0),
        Number(params.toX || 0),
        Number(params.toY || 0)
      );
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
