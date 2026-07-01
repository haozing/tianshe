import type {
  BrowserDownloadEntry,
  BrowserInterface,
  BrowserNativeInputCapability,
  BrowserSessionRequestOptions,
  BrowserSessionRequestResponse,
} from '../../../types/browser-interface';
import { observationService } from '../../observability/observation-service';
import {
  createProfileSessionGateway,
  type ProfileSessionGatewayExecutionContext,
  type ProfileSessionGatewayIntent,
} from '../../browser-runtime/profile-session-gateway';

const PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS = {
  session: 'browser.sessionRequest(options), browser.getUserAgent()',
  cdp: 'browser.startNetworkCapture(options), browser.getNetworkEntries(filter), browser.waitForResponse(urlPattern, timeout)',
  capture: 'browser.screenshot(options), browser.screenshotDetailed(options), browser.snapshot(options)',
} as const;

type PluginBrowserBlockedProperty = keyof typeof PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS;

const PLUGIN_BROWSER_BLOCKED_METHOD_MIGRATIONS = {
  evaluate: 'Use browser.snapshot(), browser.search(), browser.getText(), browser.getAttribute(), or a trusted Site Adapter Procedure.',
  evaluateWithArgs:
    'Use browser.snapshot(), browser.search(), browser.getText(), browser.getAttribute(), or profileSessionGateway/network.sessionRequest for authenticated HTTP.',
  getCookies: 'Use profileSessionGateway/network.sessionRequest; raw cookies are not exposed to plugins.',
  setCookie: 'Use a framework-owned profile/session gateway or trusted login flow; plugins cannot write raw cookies.',
  clearCookies: 'Use a framework-owned profile/session gateway or trusted login flow; plugins cannot clear raw cookies.',
  enableRequestInterception:
    'Use browser.startNetworkCapture() for observation or a trusted Site Adapter Procedure for controlled interaction.',
  disableRequestInterception:
    'Request interception control is not available in the default plugin browser facade.',
  continueRequest:
    'Request rewrite/continue is not available in the default plugin browser facade.',
  fulfillRequest:
    'Request fulfillment is not available in the default plugin browser facade.',
  failRequest: 'Request failure injection is not available in the default plugin browser facade.',
  sessionRequest:
    'Use a host-owned ProfileSessionGateway or trusted capability handler for authenticated HTTP. The default plugin browser facade never forwards raw sessionRequest().',
} as const;

type PluginBrowserBlockedMethod = keyof typeof PLUGIN_BROWSER_BLOCKED_METHOD_MIGRATIONS;
type PluginBrowserConditionallyAvailableMethod = 'sessionRequest';
type PluginBrowserBlockedKey =
  | PluginBrowserBlockedProperty
  | Exclude<PluginBrowserBlockedMethod, PluginBrowserConditionallyAvailableMethod>;

export type PluginBrowserDownloadEntry = Omit<BrowserDownloadEntry, 'path'>;

export type PluginBrowserFacade =
  Omit<
    BrowserInterface,
    | PluginBrowserBlockedKey
    | 'withAbortSignal'
    | 'setDownloadBehavior'
    | 'listDownloads'
    | 'waitForDownload'
  > & {
    withAbortSignal?(signal: AbortSignal): PluginBrowserFacade;
    setDownloadBehavior?(options: {
      policy: 'allow' | 'deny';
    }): Promise<void>;
    listDownloads?(): Promise<PluginBrowserDownloadEntry[]>;
    waitForDownload(options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<PluginBrowserDownloadEntry>;
    sessionRequest?(
      options: PluginBrowserSessionRequestInput
    ): Promise<BrowserSessionRequestResponse>;
  };

export interface PluginBrowserSessionRequestInput extends BrowserSessionRequestOptions {
  allowedOrigins?: readonly string[];
}

export interface PluginBrowserSessionRequestOptions {
  profileId: string;
  pluginId: string;
  intent?: ProfileSessionGatewayIntent;
  resolveSite?: () => Promise<string>;
  allowedOrigins?: readonly string[];
  executionContext?: ProfileSessionGatewayExecutionContext;
}

export interface PluginBrowserFacadeOptions {
  sessionRequest?: PluginBrowserSessionRequestOptions;
  nativeInput?: PluginBrowserNativeInputOptions;
}

export interface PluginBrowserNativeInputAuditEvent {
  capability: 'input.native';
  method: keyof BrowserNativeInputCapability['native'];
  args: unknown[];
  trustModel?: string | null;
}

export interface PluginBrowserNativeInputOptions {
  pluginId?: string;
  trustModel?: string | null;
  audit?: (event: PluginBrowserNativeInputAuditEvent) => void | Promise<void>;
}

type AssertNever<T extends never> = T;
type _PluginBrowserFacadeBlockedTypeRegression =
  AssertNever<Extract<keyof PluginBrowserFacade, PluginBrowserBlockedKey>>;

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

function createBlockedBrowserMethodError(method: PluginBrowserBlockedMethod): Error {
  const migration = PLUGIN_BROWSER_BLOCKED_METHOD_MIGRATIONS[method];
  const error = new Error(
    `browser.${method} is not available in the default plugin browser facade. ${migration}`
  ) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.name = 'PluginBrowserApiError';
  error.code = 'PLUGIN_BROWSER_METHOD_BLOCKED';
  error.details = {
    method,
    migration,
  };
  return error;
}

function isBlockedBrowserMethod(prop: unknown): prop is PluginBrowserBlockedMethod {
  return (
    typeof prop === 'string' &&
    Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_BLOCKED_METHOD_MIGRATIONS, prop)
  );
}

function sanitizePluginDownloadEntry(entry: BrowserDownloadEntry): PluginBrowserDownloadEntry {
  const { path: _path, ...publicEntry } = entry;
  return {
    ...publicEntry,
    ...(entry.artifactRef ? { artifactRef: { ...entry.artifactRef } } : {}),
  };
}

function summarizeNativeInputArgs(
  method: keyof BrowserNativeInputCapability['native'],
  args: unknown[]
): Record<string, unknown> {
  switch (method) {
    case 'click':
      return { x: args[0], y: args[1], hasOptions: args[2] !== undefined };
    case 'move':
      return { x: args[0], y: args[1] };
    case 'drag':
      return { fromX: args[0], fromY: args[1], toX: args[2], toY: args[3] };
    case 'type':
      return {
        textLength: typeof args[0] === 'string' ? args[0].length : 0,
        hasOptions: args[1] !== undefined,
      };
    case 'keyPress':
      return { key: args[0], modifiers: Array.isArray(args[1]) ? args[1] : [] };
    case 'scroll':
      return { x: args[0], y: args[1], deltaX: args[2], deltaY: args[3] };
    default:
      return { argumentCount: args.length };
  }
}

function createNativeInputAudit(
  options?: PluginBrowserNativeInputOptions
): NonNullable<PluginBrowserNativeInputOptions['audit']> {
  if (options?.audit) {
    return options.audit;
  }
  return async (event) => {
    await observationService.event({
      event: 'plugin.browser.native_input',
      component: 'js-plugin.browser',
      level: 'info',
      outcome: 'succeeded',
      message: `Plugin browser native input: ${event.method}`,
      attrs: {
        capability: event.capability,
        method: event.method,
        allowlist: 'input.native',
        pluginTrustModel: event.trustModel || null,
        ...summarizeNativeInputArgs(event.method, event.args),
      },
    });
  };
}

function createAuditedNativeInput(
  nativeInput: BrowserNativeInputCapability['native'],
  options?: PluginBrowserNativeInputOptions
): BrowserNativeInputCapability['native'] {
  const audit = createNativeInputAudit(options);
  const call = async <T>(
    method: keyof BrowserNativeInputCapability['native'],
    args: unknown[],
    invoke: () => Promise<T>
  ): Promise<T> => {
    await audit({
      capability: 'input.native',
      method,
      args,
      trustModel: options?.trustModel ?? null,
    });
    return await invoke();
  };
  return {
    click: (x, y, clickOptions) =>
      call('click', [x, y, clickOptions], () => nativeInput.click(x, y, clickOptions)),
    move: (x, y) => call('move', [x, y], () => nativeInput.move(x, y)),
    drag: (fromX, fromY, toX, toY) =>
      call('drag', [fromX, fromY, toX, toY], () => nativeInput.drag(fromX, fromY, toX, toY)),
    type: (text, typeOptions) =>
      call('type', [text, typeOptions], () => nativeInput.type(text, typeOptions)),
    keyPress: (key, modifiers) =>
      call('keyPress', [key, modifiers], () => nativeInput.keyPress(key, modifiers)),
    scroll: (x, y, deltaX, deltaY) =>
      call('scroll', [x, y, deltaX, deltaY], () =>
        nativeInput.scroll(x, y, deltaX, deltaY)
      ),
  };
}

function createGatewayBackedSessionRequest(
  browser: BrowserInterface,
  options: PluginBrowserSessionRequestOptions
): (requestOptions: PluginBrowserSessionRequestInput) => Promise<BrowserSessionRequestResponse> {
  const gateway = createProfileSessionGateway({
    acquire: async () => ({
      browser,
      release: async () => undefined,
    }),
  });

  return async (requestOptions: PluginBrowserSessionRequestInput) => {
    const site = (await options.resolveSite?.()) || (await browser.getCurrentUrl());
    const { allowedOrigins: requestAllowedOrigins, ...gatewayRequestOptions } = requestOptions;
    const declaredAllowedOrigins = new Set(
      (options.allowedOrigins || []).map((origin) => origin.trim()).filter(Boolean)
    );
    const forwardedAllowedOrigins = requestAllowedOrigins?.filter((origin) =>
      declaredAllowedOrigins.has(origin.trim())
    );

    return gateway.withSession(
      {
        profileId: options.profileId,
        pluginId: options.pluginId,
        site,
        intent: options.intent ?? 'read',
        allowedOrigins: options.allowedOrigins,
        executionContext: options.executionContext,
        signal: requestOptions.signal,
      },
      (session) => session.request({
        ...gatewayRequestOptions,
        ...(forwardedAllowedOrigins?.length ? { allowedOrigins: forwardedAllowedOrigins } : {}),
      })
    );
  };
}

export function createPluginBrowserFacade(
  browser: BrowserInterface,
  options: PluginBrowserFacadeOptions = {}
): PluginBrowserFacade {
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
  bindMethod('screenshot');
  bindMethod('screenshotDetailed');
  bindMethod('getUserAgent');
  if (options.sessionRequest) {
    target.sessionRequest = createGatewayBackedSessionRequest(browser, options.sessionRequest);
  }
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
  if (typeof browser.setDownloadBehavior === 'function') {
    target.setDownloadBehavior = async (downloadOptions: {
      policy: 'allow' | 'deny';
      downloadPath?: string;
    }) => {
      if (downloadOptions && Object.prototype.hasOwnProperty.call(downloadOptions, 'downloadPath')) {
        throw new Error('browser.setDownloadBehavior does not accept downloadPath in plugin runtime.');
      }
      return await browser.setDownloadBehavior!({
        policy: downloadOptions?.policy === 'deny' ? 'deny' : 'allow',
      });
    };
  }
  if (typeof browser.listDownloads === 'function') {
    target.listDownloads = async () => {
      const downloads = await browser.listDownloads!();
      return downloads.map((entry) => sanitizePluginDownloadEntry(entry));
    };
  }
  if (typeof browser.waitForDownload === 'function') {
    target.waitForDownload = async (waitOptions?: {
      timeoutMs?: number;
      signal?: AbortSignal;
    }) => sanitizePluginDownloadEntry(await browser.waitForDownload!(waitOptions));
  }
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
  bindMethod('getInterceptedRequests');
  bindMethod('clearInterceptedRequests');
  bindMethod('waitForInterceptedRequest');
  bindMethod('setWindowOpenPolicy');
  bindMethod('getWindowOpenPolicy');
  bindMethod('clearWindowOpenPolicy');

  if (browser.native && hasCapability('input.native')) {
    target.native = createAuditedNativeInput(browser.native, options.nativeInput);
  }

  if (typeof browser.withAbortSignal === 'function') {
    target.withAbortSignal = (signal: AbortSignal) =>
      createPluginBrowserFacade(browser.withAbortSignal!(signal), options);
  }

  return new Proxy(target as unknown as PluginBrowserFacade, {
    get(currentTarget, prop, receiver) {
      if (
        isBlockedBrowserMethod(prop) &&
        !(prop === 'sessionRequest' && Reflect.has(currentTarget, prop))
      ) {
        throw createBlockedBrowserMethodError(prop);
      }
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
        isBlockedBrowserMethod(prop) &&
        !(prop === 'sessionRequest' && Reflect.has(currentTarget, prop))
      ) {
        return false;
      }
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
          (!Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_PRIVATE_API_MIGRATIONS, key) &&
            (!Object.prototype.hasOwnProperty.call(PLUGIN_BROWSER_BLOCKED_METHOD_MIGRATIONS, key) ||
              (key === 'sessionRequest' && Reflect.has(currentTarget, key))))
      );
    },
    getOwnPropertyDescriptor(currentTarget, prop) {
      if (
        isBlockedBrowserMethod(prop) &&
        !(prop === 'sessionRequest' && Reflect.has(currentTarget, prop))
      ) {
        return undefined;
      }
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
