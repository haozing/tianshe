import type {
  IExtensionControlRelay,
  ExtensionRelayClientState,
  ExtensionRelayEvent,
  IRuyiFirefoxClient,
  RuyiFirefoxEvent,
} from './transport-types';

export interface BrowserCommandTransport<TEvent> {
  dispatch<TResult>(command: string, params?: unknown, timeoutMs?: number): Promise<TResult>;
  onEvent(listener: (event: TEvent) => void): () => void;
  isClosed(): boolean;
}

export interface BrowserStateCommandTransport<TEvent, TState>
  extends BrowserCommandTransport<TEvent> {
  getState(): TState | null;
}

export function createExtensionRelayTransport(
  relay: IExtensionControlRelay
): BrowserStateCommandTransport<ExtensionRelayEvent, ExtensionRelayClientState> {
  return {
    dispatch: (command, params, timeoutMs) => relay.dispatchCommand(command, params, timeoutMs),
    onEvent: (listener) => relay.onEvent(listener),
    isClosed: () => relay.isStopped(),
    getState: () => relay.getClientState(),
  };
}

export function createRuyiFirefoxTransport(
  client: IRuyiFirefoxClient
): BrowserCommandTransport<RuyiFirefoxEvent> {
  return {
    dispatch: (command, params, timeoutMs) => client.dispatch(command, params, timeoutMs),
    onEvent: (listener) => client.onEvent(listener),
    isClosed: () => client.isClosed(),
  };
}
