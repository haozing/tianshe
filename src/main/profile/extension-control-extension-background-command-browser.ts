export function renderCommandBrowserRuntime(): string {
  return String.raw`async function captureScreenshot(tabId, params) {
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
}`;
}
