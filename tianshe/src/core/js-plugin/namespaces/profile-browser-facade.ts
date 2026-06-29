import type { BrowserInterface } from '../../../types/browser-interface';

const PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS = {
  session: 'browser.getCookies(filter?), browser.setCookie(cookie), browser.clearCookies(), browser.getUserAgent()',
  cdp: 'browser.startNetworkCapture(options), browser.getNetworkEntries(filter), browser.waitForResponse(urlPattern, timeout)',
  capture: 'browser.screenshot(options), browser.screenshotDetailed(options), browser.snapshot(options)',
} as const;

type PluginBrowserBlockedProperty = keyof typeof PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS;

function createPrivateBrowserApiError(property: PluginBrowserBlockedProperty): Error {
  const migration = PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS[property];
  const error = new Error(
    `browser.${property} is not available in plugin runtime. Migrate to ${migration}.`
  ) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.name = 'PluginBrowserApiError';
  error.code = 'PLUGIN_BROWSER_PRIVATE_API_BLOCKED';
  error.details = {
    property,
    migration,
  };
  return error;
}

export function createPluginBrowserFacade(browser: BrowserInterface): BrowserInterface {
  const target: Record<string, unknown> = {};
  const hasCapability =
    typeof browser.hasCapability === 'function'
      ? browser.hasCapability.bind(browser)
      : (_name: string) => false;

  const bindMethod = <K extends keyof BrowserInterface>(name: K): void => {
    const value = browser[name];
    if (typeof value === 'function') {
      target[name as string] = (value as Function).bind(browser);
    } else if (value !== undefined) {
      target[name as string] = value;
    }
  };

  bindMethod('describeRuntime');
  target.hasCapability = hasCapability;
  bindMethod('goto');
  bindMethod('back');
  bindMethod('forward');
  bindMethod('reload');
  bindMethod('getCurrentUrl');
  bindMethod('title');
  bindMethod('snapshot');
  bindMethod('click');
  bindMethod('type');
  bindMethod('select');
  bindMethod('waitForSelector');
  bindMethod('getText');
  bindMethod('getAttribute');
  bindMethod('search');
  bindMethod('evaluate');
  bindMethod('evaluateWithArgs');
  bindMethod('screenshot');
  bindMethod('screenshotDetailed');
  bindMethod('getCookies');
  bindMethod('setCookie');
  bindMethod('clearCookies');
  bindMethod('getUserAgent');
  bindMethod('startNetworkCapture');
  bindMethod('stopNetworkCapture');
  bindMethod('getNetworkEntries');
  bindMethod('getNetworkSummary');
  bindMethod('clearNetworkEntries');
  bindMethod('waitForResponse');
  bindMethod('startConsoleCapture');
  bindMethod('stopConsoleCapture');
  bindMethod('getConsoleMessages');
  bindMethod('clearConsoleMessages');
  bindMethod('show');
  bindMethod('hide');
  bindMethod('clickAtNormalized');
  bindMethod('dragNormalized');
  bindMethod('moveToNormalized');
  bindMethod('scrollAtNormalized');
  bindMethod('clickText');
  bindMethod('findTextNormalized');
  bindMethod('findTextNormalizedDetailed');
  bindMethod('findText');
  bindMethod('textExists');
  bindMethod('recognizeText');
  bindMethod('setDownloadBehavior');
  bindMethod('listDownloads');
  bindMethod('waitForDownload');
  bindMethod('cancelDownload');
  bindMethod('waitForDialog');
  bindMethod('handleDialog');
  bindMethod('listTabs');
  bindMethod('createTab');
  bindMethod('activateTab');
  bindMethod('closeTab');
  if (hasCapability('emulation.identity')) {
    bindMethod('setEmulationIdentity');
    bindMethod('clearEmulation');
  }
  if (hasCapability('emulation.viewport')) {
    bindMethod('setViewportEmulation');
  }
  bindMethod('enableRequestInterception');
  bindMethod('disableRequestInterception');
  bindMethod('getInterceptedRequests');
  bindMethod('clearInterceptedRequests');
  bindMethod('waitForInterceptedRequest');
  bindMethod('continueRequest');
  bindMethod('fulfillRequest');
  bindMethod('failRequest');
  bindMethod('setWindowOpenPolicy');
  bindMethod('getWindowOpenPolicy');
  bindMethod('clearWindowOpenPolicy');

  if (browser.native) {
    target.native = browser.native;
  }

  if (typeof browser.withAbortSignal === 'function') {
    target.withAbortSignal = (signal: AbortSignal) =>
      createPluginBrowserFacade(browser.withAbortSignal!(signal));
  }

  return new Proxy(target as unknown as BrowserInterface, {
    get(currentTarget, prop, receiver) {
      if (
        typeof prop === 'string' &&
        Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS, prop)
      ) {
        throw createPrivateBrowserApiError(prop as PluginBrowserBlockedProperty);
      }
      return Reflect.get(currentTarget, prop, receiver);
    },
    has(currentTarget, prop) {
      if (
        typeof prop === 'string' &&
        Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS, prop)
      ) {
        return false;
      }
      return Reflect.has(currentTarget, prop);
    },
    ownKeys(currentTarget) {
      return Reflect.ownKeys(currentTarget).filter(
        (key) =>
          typeof key !== 'string' ||
          !Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS, key)
      );
    },
    getOwnPropertyDescriptor(currentTarget, prop) {
      if (
        typeof prop === 'string' &&
        Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS, prop)
      ) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(currentTarget, prop);
    },
  });
}
