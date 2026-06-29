import type { Session } from 'electron';

export interface WebRequestFilter {
  urls?: string[];
}

type WebRequestDetails = Record<string, any>;
type BlockingResult = Record<string, any>;
type BlockingCallback = (result?: BlockingResult) => void;
type BlockingHandler = (details: WebRequestDetails, callback: BlockingCallback) => void;
type ObserverHandler = (details: WebRequestDetails) => void;

type BlockingEventName = 'onBeforeRequest' | 'onBeforeSendHeaders' | 'onHeadersReceived';
type ObserverEventName = 'onCompleted' | 'onErrorOccurred';

interface BlockingSubscription {
  filter?: WebRequestFilter;
  handler: BlockingHandler;
}

interface ObserverSubscription {
  filter?: WebRequestFilter;
  handler: ObserverHandler;
}

const ALL_URLS_FILTER: WebRequestFilter = { urls: ['<all_urls>'] };
const sessionHubs = new WeakMap<Session, SessionWebRequestHub>();

function cloneShallow<T>(value: T): T {
  if (Array.isArray(value)) {
    return [...value] as T;
  }

  if (value && typeof value === 'object') {
    return { ...(value as Record<string, unknown>) } as T;
  }

  return value;
}

function isRegexLikePattern(pattern: string): boolean {
  return pattern.includes('.*') || /[\[\](){}+?^$|\\]/.test(pattern);
}

function wildcardPatternToRegExp(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed === '<all_urls>') {
    return null;
  }

  if (isRegexLikePattern(trimmed)) {
    return null;
  }

  const escaped = trimmed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesWebRequestFilter(url: string | undefined, filter?: WebRequestFilter): boolean {
  if (!url || !filter?.urls || filter.urls.length === 0) {
    return true;
  }

  return filter.urls.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed || trimmed === '<all_urls>') {
      return true;
    }

    const wildcardRegExp = wildcardPatternToRegExp(trimmed);
    if (wildcardRegExp) {
      return wildcardRegExp.test(url);
    }

    if (isRegexLikePattern(trimmed)) {
      return true;
    }

    return url === trimmed || url.includes(trimmed);
  });
}

export class SessionWebRequestHub {
  private nextSubscriptionId = 1;
  private registeredBlocking = new Set<BlockingEventName>();
  private registeredObservers = new Set<ObserverEventName>();

  private blockingSubscriptions: Record<BlockingEventName, Map<number, BlockingSubscription>> = {
    onBeforeRequest: new Map(),
    onBeforeSendHeaders: new Map(),
    onHeadersReceived: new Map(),
  };

  private observerSubscriptions: Record<ObserverEventName, Map<number, ObserverSubscription>> = {
    onCompleted: new Map(),
    onErrorOccurred: new Map(),
  };

  constructor(private readonly session: Session) {}

  subscribeBeforeRequest(handler: BlockingHandler, filter?: WebRequestFilter): () => void {
    return this.addBlockingSubscription('onBeforeRequest', handler, filter);
  }

  subscribeBeforeSendHeaders(handler: BlockingHandler, filter?: WebRequestFilter): () => void {
    return this.addBlockingSubscription('onBeforeSendHeaders', handler, filter);
  }

  subscribeHeadersReceived(handler: BlockingHandler, filter?: WebRequestFilter): () => void {
    return this.addBlockingSubscription('onHeadersReceived', handler, filter);
  }

  subscribeCompleted(handler: ObserverHandler, filter?: WebRequestFilter): () => void {
    return this.addObserverSubscription('onCompleted', handler, filter);
  }

  subscribeErrorOccurred(handler: ObserverHandler, filter?: WebRequestFilter): () => void {
    return this.addObserverSubscription('onErrorOccurred', handler, filter);
  }

  private addBlockingSubscription(
    eventName: BlockingEventName,
    handler: BlockingHandler,
    filter?: WebRequestFilter
  ): () => void {
    this.ensureBlockingEventRegistered(eventName);
    const id = this.nextSubscriptionId++;
    this.blockingSubscriptions[eventName].set(id, { filter, handler });
    return () => {
      this.blockingSubscriptions[eventName].delete(id);
    };
  }

  private addObserverSubscription(
    eventName: ObserverEventName,
    handler: ObserverHandler,
    filter?: WebRequestFilter
  ): () => void {
    this.ensureObserverEventRegistered(eventName);
    const id = this.nextSubscriptionId++;
    this.observerSubscriptions[eventName].set(id, { filter, handler });
    return () => {
      this.observerSubscriptions[eventName].delete(id);
    };
  }

  private ensureBlockingEventRegistered(eventName: BlockingEventName): void {
    if (this.registeredBlocking.has(eventName)) {
      return;
    }

    const listener = (details: WebRequestDetails, callback: BlockingCallback) => {
      this.dispatchBlocking(eventName, details, callback);
    };

    (this.session.webRequest as any)[eventName](ALL_URLS_FILTER, listener);
    this.registeredBlocking.add(eventName);
  }

  private ensureObserverEventRegistered(eventName: ObserverEventName): void {
    if (this.registeredObservers.has(eventName)) {
      return;
    }

    const listener = (details: WebRequestDetails) => {
      this.dispatchObserver(eventName, details);
    };

    (this.session.webRequest as any)[eventName](ALL_URLS_FILTER, listener);
    this.registeredObservers.add(eventName);
  }

  private dispatchBlocking(
    eventName: BlockingEventName,
    details: WebRequestDetails,
    callback: BlockingCallback
  ): void {
    const subscriptions = Array.from(this.blockingSubscriptions[eventName].values());
    const initialState = this.getInitialBlockingState(eventName, details);

    const run = (index: number, state: BlockingResult) => {
      if (index >= subscriptions.length) {
        callback(this.cleanBlockingResult(state));
        return;
      }

      const subscription = subscriptions[index];
      if (!matchesWebRequestFilter(details.url, subscription.filter)) {
        run(index + 1, state);
        return;
      }

      let settled = false;
      const finish = (result?: BlockingResult) => {
        if (settled) {
          return;
        }
        settled = true;

        const nextState = this.mergeBlockingResult(state, result);
        if (nextState.cancel === true) {
          callback(this.cleanBlockingResult(nextState));
          return;
        }

        run(index + 1, nextState);
      };

      try {
        subscription.handler(this.buildDerivedDetails(details, state), finish);
        queueMicrotask(() => {
          if (!settled) {
            finish();
          }
        });
      } catch {
        finish();
      }
    };

    run(0, initialState);
  }

  private dispatchObserver(eventName: ObserverEventName, details: WebRequestDetails): void {
    const subscriptions = Array.from(this.observerSubscriptions[eventName].values());
    for (const subscription of subscriptions) {
      if (!matchesWebRequestFilter(details.url, subscription.filter)) {
        continue;
      }

      try {
        subscription.handler(details);
      } catch {
        // Ignore individual subscriber errors to keep the shared hub stable.
      }
    }
  }

  private getInitialBlockingState(
    eventName: BlockingEventName,
    details: WebRequestDetails
  ): BlockingResult {
    switch (eventName) {
      case 'onBeforeSendHeaders':
        return {
          requestHeaders: cloneShallow(details.requestHeaders || {}),
        };
      case 'onHeadersReceived':
        return {
          responseHeaders: cloneShallow(details.responseHeaders || {}),
        };
      default:
        return {};
    }
  }

  private buildDerivedDetails(details: WebRequestDetails, state: BlockingResult): WebRequestDetails {
    const nextDetails = { ...details };
    if ('requestHeaders' in state) {
      nextDetails.requestHeaders = cloneShallow(state.requestHeaders || {});
    }
    if ('responseHeaders' in state) {
      nextDetails.responseHeaders = cloneShallow(state.responseHeaders || {});
    }
    if ('statusLine' in state) {
      nextDetails.statusLine = state.statusLine;
    }
    return nextDetails;
  }

  private mergeBlockingResult(state: BlockingResult, result?: BlockingResult): BlockingResult {
    if (!result) {
      return state;
    }

    const nextState = { ...state };
    for (const [key, value] of Object.entries(result)) {
      nextState[key] =
        key === 'requestHeaders' || key === 'responseHeaders' ? cloneShallow(value) : value;
    }
    return nextState;
  }

  private cleanBlockingResult(state: BlockingResult): BlockingResult {
    const result: BlockingResult = {};
    for (const [key, value] of Object.entries(state)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }
}

export function getSessionWebRequestHub(session: Session): SessionWebRequestHub {
  let hub = sessionHubs.get(session);
  if (!hub) {
    hub = new SessionWebRequestHub(session);
    sessionHubs.set(session, hub);
  }
  return hub;
}
