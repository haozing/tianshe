import type { ConsoleMessage, NetworkEntry } from '../../core/browser-core/types';
import { classifyNetworkEntry } from '../../core/browser-automation/network-utils';
import type {
  BrowserDialogState,
  BrowserInterceptPattern,
  BrowserInterceptedRequest,
  BrowserRuntimeEvent,
  BrowserRuntimeEventPayloadMap,
} from '../../types/browser-interface';
import {
  matchesInterceptPatterns,
  normalizeConsoleLevel,
  normalizeHeaders,
  normalizeTimestamp,
  parseScriptResult,
} from './ruyi-firefox-client-utils';
import type {
  BidiEventMessage,
  DispatchInterceptContinueParams,
  RuyiFirefoxEvent,
} from './ruyi-firefox-client.types';

type EmitRuntimeEvent = <TType extends BrowserRuntimeEvent['type']>(
  type: TType,
  payload: BrowserRuntimeEventPayloadMap[TType],
  options?: {
    contextId?: string | null;
    timestamp?: number;
  }
) => void;

type RuyiFirefoxBiDiEventRouterOptions = {
  activeContextTrackerChannel: string;
  emitEvent: (event: RuyiFirefoxEvent) => void;
  emitRuntimeEvent: EmitRuntimeEvent;
  getActiveContextId: () => string | null;
  setActiveContextId: (contextId: string, timeoutMs: number) => Promise<void>;
  clearActiveContextId: () => void;
  recoverActiveContextId: (timeoutMs: number) => Promise<void>;
  getCurrentDialog: () => BrowserDialogState | null;
  setCurrentDialog: (dialog: BrowserDialogState | null) => void;
  getLastDialogContextId: () => string | null;
  setLastDialogContextId: (contextId: string | null) => void;
  resolveDialogWaiters: (dialog: BrowserDialogState) => void;
  continueInterceptedRequest: (
    params: DispatchInterceptContinueParams | undefined,
    timeoutMs: number
  ) => Promise<void>;
  getInterceptPatterns: () => BrowserInterceptPattern[];
  handleDownloadWillBegin: (params: Record<string, unknown>) => Promise<void>;
  handleDownloadEnd: (params: Record<string, unknown>) => Promise<void>;
  networkRequests: Map<string, Partial<NetworkEntry>>;
};

function normalizeResourceType(request: Record<string, unknown>): string {
  const raw = String(
    request.destination ??
      request.initiatorType ??
      request.resourceType ??
      request.type ??
      ''
  )
    .trim()
    .toLowerCase();

  if (!raw) {
    return 'other';
  }

  switch (raw) {
    case 'document':
    case 'iframe':
    case 'frame':
      return raw;
    case 'script':
    case 'stylesheet':
    case 'font':
    case 'image':
    case 'media':
    case 'fetch':
    case 'xhr':
    case 'websocket':
    case 'eventsource':
      return raw;
    case 'worker':
      return 'script';
    default:
      return raw;
  }
}

export class RuyiFirefoxBiDiEventRouter {
  private readonly options: RuyiFirefoxBiDiEventRouterOptions;

  constructor(options: RuyiFirefoxBiDiEventRouterOptions) {
    this.options = options;
  }

  handleBiDiEvent(event: BidiEventMessage): void {
    const method = String(event.method || '').trim();
    const params =
      event.params && typeof event.params === 'object'
        ? event.params
        : ({} as Record<string, unknown>);
    if (!method) {
      return;
    }

    switch (method) {
      case 'script.message':
        this.handleScriptMessage(params);
        return;
      case 'browsingContext.contextCreated':
        this.handleContextCreated(params);
        return;
      case 'browsingContext.contextDestroyed':
        this.handleContextDestroyed(params);
        return;
      case 'browsingContext.navigationStarted':
        this.handleNavigationStarted(params);
        return;
      case 'browsingContext.navigationCommitted':
        this.handleNavigationCommitted(params);
        return;
      case 'browsingContext.domContentLoaded':
        this.handleNavigationDomContentLoaded(params);
        return;
      case 'browsingContext.load':
        this.handleNavigationCompleted(params);
        return;
      case 'browsingContext.fragmentNavigated':
        this.handleNavigationFragmentNavigated(params);
        return;
      case 'browsingContext.historyUpdated':
        this.handleHistoryUpdated(params);
        return;
      case 'browsingContext.navigationFailed':
        this.handleNavigationFailed(params);
        return;
      case 'browsingContext.navigationAborted':
        this.handleNavigationAborted(params);
        return;
      case 'browsingContext.downloadWillBegin':
        void this.options.handleDownloadWillBegin(params).catch(() => undefined);
        return;
      case 'browsingContext.downloadEnd':
        void this.options.handleDownloadEnd(params).catch(() => undefined);
        return;
      case 'network.beforeRequestSent':
        this.handleNetworkBeforeRequest(params);
        return;
      case 'network.responseCompleted':
        this.handleNetworkResponseCompleted(params);
        return;
      case 'network.fetchError':
        this.handleNetworkFetchError(params);
        return;
      case 'log.entryAdded':
        this.handleLogEntry(params);
        return;
      case 'browsingContext.userPromptOpened':
        this.handleUserPromptOpened(params);
        return;
      case 'browsingContext.userPromptClosed':
        this.handleUserPromptClosed(params);
        return;
      default:
        return;
    }
  }

  private resolveEventContextId(params: Record<string, unknown>): string | null {
    const contextId = String(
      params.context ??
        (params.source && typeof params.source === 'object'
          ? (params.source as Record<string, unknown>).context
          : '') ??
        (params.request && typeof params.request === 'object'
          ? (params.request as Record<string, unknown>).context
          : '') ??
        ''
    ).trim();

    return contextId || null;
  }

  private isActiveEventContext(params: Record<string, unknown>): boolean {
    const contextId = this.resolveEventContextId(params);
    const activeContextId = this.options.getActiveContextId();

    if (!contextId || !activeContextId) {
      return true;
    }
    return contextId === activeContextId;
  }

  private handleContextCreated(params: Record<string, unknown>): void {
    if (typeof params.parent === 'string' && params.parent.trim().length > 0) {
      return;
    }
    const contextId = this.resolveEventContextId(params);
    if (!contextId) {
      return;
    }

    this.options.emitRuntimeEvent(
      'tab.created',
      {
        id: contextId,
        url: typeof params.url === 'string' ? params.url : '',
        parentId: typeof params.parent === 'string' ? params.parent : undefined,
      },
      {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );
  }

  private handleNavigationStarted(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const contextId = this.resolveEventContextId(params);
    this.options.emitRuntimeEvent(
      'navigation.started',
      {
        url: typeof params.url === 'string' ? params.url : '',
        navigationId: typeof params.navigation === 'string' ? params.navigation : undefined,
      },
      {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );
  }

  private handleNavigationCommitted(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const contextId = this.resolveEventContextId(params);
    this.options.emitRuntimeEvent(
      'navigation.committed',
      {
        url: typeof params.url === 'string' ? params.url : '',
        navigationId: typeof params.navigation === 'string' ? params.navigation : undefined,
      },
      {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );
  }

  private handleNavigationDomContentLoaded(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const contextId = this.resolveEventContextId(params);
    this.options.emitRuntimeEvent(
      'navigation.domContentLoaded',
      {
        url: typeof params.url === 'string' ? params.url : '',
        navigationId: typeof params.navigation === 'string' ? params.navigation : undefined,
      },
      {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );
  }

  private handleNavigationCompleted(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const contextId = this.resolveEventContextId(params);
    this.options.emitRuntimeEvent(
      'navigation.completed',
      {
        url: typeof params.url === 'string' ? params.url : '',
        navigationId: typeof params.navigation === 'string' ? params.navigation : undefined,
      },
      {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );
  }

  private handleNavigationFragmentNavigated(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const contextId = this.resolveEventContextId(params);
    this.options.emitRuntimeEvent(
      'navigation.fragmentNavigated',
      {
        url: typeof params.url === 'string' ? params.url : '',
        navigationId: typeof params.navigation === 'string' ? params.navigation : undefined,
      },
      {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );
  }

  private handleHistoryUpdated(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const contextId = this.resolveEventContextId(params);
    this.options.emitRuntimeEvent(
      'navigation.historyUpdated',
      {
        url: typeof params.url === 'string' ? params.url : '',
      },
      {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );
  }

  private handleNavigationFailed(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const contextId = this.resolveEventContextId(params);
    this.options.emitRuntimeEvent(
      'navigation.failed',
      {
        url: typeof params.url === 'string' ? params.url : '',
        navigationId: typeof params.navigation === 'string' ? params.navigation : undefined,
        message:
          typeof params.message === 'string'
            ? params.message
            : typeof params.errorText === 'string'
              ? params.errorText
              : undefined,
      },
      {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );
  }

  private handleNavigationAborted(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const contextId = this.resolveEventContextId(params);
    this.options.emitRuntimeEvent(
      'navigation.aborted',
      {
        url: typeof params.url === 'string' ? params.url : '',
        navigationId: typeof params.navigation === 'string' ? params.navigation : undefined,
        message:
          typeof params.message === 'string'
            ? params.message
            : typeof params.errorText === 'string'
              ? params.errorText
              : undefined,
      },
      {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );
  }

  private handleNetworkBeforeRequest(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const request =
      params.request && typeof params.request === 'object'
        ? (params.request as Record<string, unknown>)
        : {};
    const requestId = String(
      request.request ??
        request.requestId ??
        request.id ??
        params.requestId ??
        `${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const url = String(request.url ?? '');
    const method = String(request.method ?? 'GET').toUpperCase();
    const resourceType = normalizeResourceType(request);
    this.options.networkRequests.set(requestId, {
      id: requestId,
      url,
      method,
      resourceType,
      classification: classifyNetworkEntry({ resourceType, url }),
      requestHeaders: normalizeHeaders(request.headers),
      startTime: normalizeTimestamp(params.timestamp),
    });

    const isBlocked = params.isBlocked === true;
    if (!isBlocked) {
      return;
    }

    const interceptedRequest: BrowserInterceptedRequest = {
      id: requestId,
      url,
      method,
      headers: normalizeHeaders(request.headers),
      resourceType,
      contextId: typeof params.context === 'string' ? params.context : undefined,
      navigationId: typeof params.navigation === 'string' ? params.navigation : undefined,
      postData:
        request.body && typeof request.body === 'object'
          ? String((request.body as Record<string, unknown>).value ?? '')
          : undefined,
      isBlocked: true,
      interceptIds: Array.isArray(params.intercepts)
        ? params.intercepts
            .map((value) => String(value ?? '').trim())
            .filter((value) => value.length > 0)
        : undefined,
    };

    if (!matchesInterceptPatterns(interceptedRequest, this.options.getInterceptPatterns())) {
      void this.options
        .continueInterceptedRequest({ requestId }, 5000)
        .catch(() => undefined);
      return;
    }

    this.options.emitEvent({
      type: 'intercepted-request',
      request: interceptedRequest,
    });
  }

  private handleNetworkResponseCompleted(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const request =
      params.request && typeof params.request === 'object'
        ? (params.request as Record<string, unknown>)
        : {};
    const response =
      params.response && typeof params.response === 'object'
        ? (params.response as Record<string, unknown>)
        : {};
    const requestId = String(
      request.request ?? request.requestId ?? request.id ?? params.requestId ?? ''
    ).trim();
    const previous = requestId ? this.options.networkRequests.get(requestId) ?? {} : {};
    const url = String(request.url ?? previous.url ?? '');
    const method = String(request.method ?? previous.method ?? 'GET').toUpperCase();
    const resourceType = String(
      request.resourceType ?? previous.resourceType ?? normalizeResourceType(request)
    );
    const startTime =
      typeof previous.startTime === 'number'
        ? previous.startTime
        : normalizeTimestamp(params.timestamp);
    const endTime = normalizeTimestamp(params.timestamp);
    const entry: NetworkEntry = {
      id: requestId || String(previous.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      url,
      method,
      resourceType,
      classification: classifyNetworkEntry({ resourceType, url }),
      status:
        typeof response.status === 'number'
          ? response.status
          : typeof previous.status === 'number'
            ? previous.status
            : undefined,
      statusText: typeof response.statusText === 'string' ? response.statusText : undefined,
      requestHeaders:
        Object.keys(previous.requestHeaders || {}).length > 0
          ? (previous.requestHeaders as Record<string, string>)
          : normalizeHeaders(request.headers),
      responseHeaders: normalizeHeaders(response.headers),
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
    };

    if (requestId) {
      this.options.networkRequests.delete(requestId);
    }
    this.options.emitEvent({ type: 'network-entry', entry });
    this.options.emitRuntimeEvent('network.entry', entry, {
      contextId: this.resolveEventContextId(params),
      timestamp: entry.endTime,
    });
  }

  private handleNetworkFetchError(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const request =
      params.request && typeof params.request === 'object'
        ? (params.request as Record<string, unknown>)
        : {};
    const requestId = String(
      request.request ?? request.requestId ?? request.id ?? params.requestId ?? ''
    ).trim();
    const previous = requestId ? this.options.networkRequests.get(requestId) ?? {} : {};
    const url = String(request.url ?? previous.url ?? '');
    const method = String(request.method ?? previous.method ?? 'GET').toUpperCase();
    const resourceType = String(
      request.resourceType ?? previous.resourceType ?? normalizeResourceType(request)
    );
    const startTime =
      typeof previous.startTime === 'number'
        ? previous.startTime
        : normalizeTimestamp(params.timestamp);
    const endTime = normalizeTimestamp(params.timestamp);
    const entry: NetworkEntry = {
      id: requestId || String(previous.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      url,
      method,
      resourceType,
      classification: classifyNetworkEntry({ resourceType, url }),
      requestHeaders:
        Object.keys(previous.requestHeaders || {}).length > 0
          ? (previous.requestHeaders as Record<string, string>)
          : normalizeHeaders(request.headers),
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
      error: String(params.errorText ?? params.error ?? 'network fetch error'),
    };

    if (requestId) {
      this.options.networkRequests.delete(requestId);
    }
    this.options.emitEvent({ type: 'network-entry', entry });
    this.options.emitRuntimeEvent('network.entry', entry, {
      contextId: this.resolveEventContextId(params),
      timestamp: entry.endTime,
    });
  }

  private handleLogEntry(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const text = String(params.text ?? params.message ?? '').trim();
    const source =
      params.source && typeof params.source === 'object'
        ? (params.source as Record<string, unknown>)
        : {};
    const stack =
      params.stackTrace && typeof params.stackTrace === 'object'
        ? (params.stackTrace as Record<string, unknown>)
        : {};
    const callFrames = Array.isArray(stack.callFrames) ? stack.callFrames : [];
    const firstFrame =
      callFrames[0] && typeof callFrames[0] === 'object'
        ? (callFrames[0] as Record<string, unknown>)
        : {};
    const message: ConsoleMessage = {
      level: normalizeConsoleLevel(params.level ?? params.type),
      message: text || String(params.method ?? 'console'),
      source:
        typeof source.url === 'string'
          ? source.url
          : typeof firstFrame.url === 'string'
            ? firstFrame.url
            : undefined,
      line:
        typeof firstFrame.lineNumber === 'number'
          ? firstFrame.lineNumber
          : typeof source.lineNumber === 'number'
            ? source.lineNumber
            : undefined,
      timestamp: normalizeTimestamp(params.timestamp),
    };
    this.options.emitEvent({ type: 'console-message', message });
    this.options.emitRuntimeEvent('console.message', message, {
      contextId: this.resolveEventContextId(params),
      timestamp: message.timestamp,
    });
  }

  private handleUserPromptOpened(params: Record<string, unknown>): void {
    if (!this.isActiveEventContext(params)) {
      return;
    }

    const contextId =
      this.resolveEventContextId(params) ?? this.options.getActiveContextId() ?? undefined;
    const dialog: BrowserDialogState = {
      type: String(params.type ?? 'alert') as BrowserDialogState['type'],
      message: String(params.message ?? ''),
      defaultValue: typeof params.defaultValue === 'string' ? params.defaultValue : undefined,
      contextId,
    };
    this.options.setCurrentDialog(dialog);
    this.options.setLastDialogContextId(contextId ?? null);
    this.options.resolveDialogWaiters(dialog);
    this.options.emitRuntimeEvent('dialog.opened', dialog, {
      contextId,
      timestamp: normalizeTimestamp(params.timestamp),
    });
  }

  private handleUserPromptClosed(params: Record<string, unknown>): void {
    const contextId = this.resolveEventContextId(params);
    const currentDialog = this.options.getCurrentDialog();
    if (contextId && currentDialog?.contextId && contextId !== currentDialog.contextId) {
      return;
    }

    const resolvedContextId =
      contextId ?? currentDialog?.contextId ?? this.options.getLastDialogContextId();
    this.options.setLastDialogContextId(
      contextId ?? currentDialog?.contextId ?? this.options.getLastDialogContextId()
    );
    this.options.emitRuntimeEvent(
      'dialog.closed',
      {
        accepted: params.accepted === true,
        userText: typeof params.userText === 'string' ? params.userText : undefined,
      },
      {
        contextId: resolvedContextId ?? null,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );
    this.options.setCurrentDialog(null);
  }

  private handleScriptMessage(params: Record<string, unknown>): void {
    const channel = String(params.channel ?? '').trim();
    if (channel !== this.options.activeContextTrackerChannel) {
      return;
    }

    const contextId = this.resolveEventContextId(params);
    if (!contextId) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = parseScriptResult<Record<string, unknown>>({
        type: 'success',
        result: params.data,
      });
    } catch {
      return;
    }
    if (payload.active !== true) {
      return;
    }

    void this.options.setActiveContextId(contextId, 5000).catch(() => undefined);
  }

  private handleContextDestroyed(params: Record<string, unknown>): void {
    if (typeof params.parent === 'string' && params.parent.trim().length > 0) {
      return;
    }
    const contextId = this.resolveEventContextId(params);
    if (!contextId) {
      return;
    }

    this.options.emitRuntimeEvent(
      'tab.closed',
      {
        id: contextId,
      },
      {
        contextId,
        timestamp: normalizeTimestamp(params.timestamp),
      }
    );

    const currentDialog = this.options.getCurrentDialog();
    const lastDialogContextId = this.options.getLastDialogContextId();
    if (currentDialog?.contextId === contextId) {
      this.options.setLastDialogContextId(contextId);
      this.options.setCurrentDialog(null);
    } else if (lastDialogContextId === contextId) {
      this.options.setLastDialogContextId(null);
    }

    if (this.options.getActiveContextId() !== contextId) {
      return;
    }

    this.options.clearActiveContextId();
    void this.options.recoverActiveContextId(5000).catch(() => undefined);
  }
}
