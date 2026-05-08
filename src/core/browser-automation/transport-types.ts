/**
 * Browser automation transport layer types
 *
 * Extracted from main/profile to eliminate core→main C-class imports.
 * These are the minimal interfaces needed by core/browser-automation,
 * core/browser-extension, and core/browser-ruyi.
 */

import type {
  BrowserInterceptedRequest,
  BrowserDialogState,
  BrowserRuntimeEvent,
} from '../../types/browser-interface';
import type { ConsoleMessage, NetworkEntry } from '../browser-core/types';

// =====================================================
// Extension Control Relay types
// =====================================================

export type ExtensionRelayClientState = {
  registeredAt: number;
  tabId?: number | null;
  windowId?: number | null;
  url?: string | null;
  title?: string | null;
};

export type ExtensionRelayEvent =
  | { type: 'network-reset' }
  | { type: 'network-entry'; entry: NetworkEntry }
  | { type: 'console-reset' }
  | { type: 'console-message'; message: ConsoleMessage }
  | { type: 'client-state'; state: ExtensionRelayClientState }
  | { type: 'intercepted-request'; request: BrowserInterceptedRequest }
  | { type: 'dialog-opened'; dialog: BrowserDialogState }
  | { type: 'dialog-closed'; contextId?: string };

export interface IExtensionControlRelay {
  dispatchCommand<TResult>(name: string, params?: unknown, timeoutMs?: number): Promise<TResult>;
  onEvent(listener: (event: ExtensionRelayEvent) => void): () => void;
  isStopped(): boolean;
  getClientState(): ExtensionRelayClientState | null;
}

// =====================================================
// Ruyi Firefox Client types
// =====================================================

export type RuyiFirefoxEvent =
  | { type: 'network-entry'; entry: NetworkEntry }
  | { type: 'console-message'; message: ConsoleMessage }
  | { type: 'intercepted-request'; request: BrowserInterceptedRequest }
  | { type: 'runtime-event'; event: BrowserRuntimeEvent };

export interface IRuyiFirefoxClient {
  dispatch<TResult>(method: string, params?: unknown, timeoutMs?: number): Promise<TResult>;
  onEvent(listener: (event: RuyiFirefoxEvent) => void): () => void;
  isClosed(): boolean;
  getObservationBrowserId(): string;
}
